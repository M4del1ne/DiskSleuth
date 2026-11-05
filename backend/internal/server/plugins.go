package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"forensics/internal/casedb"
)

// PluginAPI is the plugin protocol version this backend supports. Manifests asking for a higher api are rejected.
const PluginAPI = 1

const (
	defaultPluginTimeout = 30 * 60 // seconds
	maxRowsPerRun        = 2_000_000
)

// ---------------- Plugin manifests ----------------

type Column struct {
	Key   string `json:"key"`
	Title string `json:"title"`
	Width int    `json:"width,omitempty"`
	Kind  string `json:"kind,omitempty"` // text | time | size | mono | source
}

type Output struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Group   string   `json:"group"`
	Columns []Column `json:"columns"`
}

// Manifest is plugins/<group>/<name>/plugin.json.
type Manifest struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Version      string   `json:"version"`
	API          int      `json:"api"`
	Description  string   `json:"description"`
	Author       string   `json:"author,omitempty"`
	Entry        string   `json:"entry"`
	Timeout      int      `json:"timeout"`      // seconds; 0 means the 30 minute default
	Requires     []string `json:"requires"`     // paths that must exist, or "index" (needs the file index)
	Dependencies []string `json:"dependencies"` // required Python modules (import names)
	Outputs      []Output `json:"outputs"`
	// Locales holds optional translations from locales/<lang>.json, e.g. "zh-CN":
	// {"name": ..., "description": ..., "outputs": {"<table id>": {"name": ..., "group": ..., "columns": {"<key>": "<title>"}}}}
	Locales map[string]json.RawMessage `json:"locales,omitempty"`
	Dir     string                     `json:"-"`
	Missing []string                   `json:"missing,omitempty"` // modules missing from the current Python environment (filled when listing)
}

var (
	pluginIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]*$`)
	tableIDRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9_]*$`)
	moduleRe   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)
	columnKind = map[string]bool{"": true, "text": true, "time": true, "size": true, "mono": true, "source": true}
)

// validateManifest checks a manifest and fills in defaults. It returns the problems found (none means usable).
func validateManifest(m *Manifest, dir string) []string {
	var p []string
	if !pluginIDRe.MatchString(m.ID) {
		p = append(p, fmt.Sprintf("invalid id %q (use lowercase letters, digits and . _ -)", m.ID))
	}
	if strings.TrimSpace(m.Name) == "" {
		p = append(p, "missing name")
	}
	if strings.TrimSpace(m.Version) == "" {
		p = append(p, "missing version")
	}
	if m.API == 0 {
		m.API = 1
	}
	if m.API > PluginAPI {
		p = append(p, fmt.Sprintf("needs plugin API v%d, this backend supports v%d", m.API, PluginAPI))
	}
	if m.Entry == "" {
		m.Entry = "main.py"
	}
	if rel, err := filepath.Rel(dir, filepath.Join(dir, m.Entry)); err != nil || strings.HasPrefix(rel, "..") {
		p = append(p, "entry must be inside the plugin directory")
	} else if _, err := os.Stat(filepath.Join(dir, m.Entry)); err != nil {
		p = append(p, "entry file not found: "+m.Entry)
	}
	if m.Timeout <= 0 {
		m.Timeout = defaultPluginTimeout
	}
	m.Timeout = min(max(m.Timeout, 10), 24*3600)
	for _, d := range m.Dependencies {
		if !moduleRe.MatchString(d) {
			p = append(p, fmt.Sprintf("dependency %q is not a valid module name", d))
		}
	}
	if len(m.Outputs) == 0 {
		p = append(p, "outputs is empty")
	}
	for _, o := range m.Outputs {
		if !tableIDRe.MatchString(o.ID) {
			p = append(p, fmt.Sprintf("invalid table id %q (use lowercase letters, digits and _)", o.ID))
		}
		if o.Name == "" || o.Group == "" {
			p = append(p, fmt.Sprintf("table %s is missing name or group", o.ID))
		}
		if len(o.Columns) == 0 {
			p = append(p, fmt.Sprintf("table %s has no columns", o.ID))
		}
		seen := map[string]bool{}
		for _, c := range o.Columns {
			if c.Key == "" || seen[c.Key] {
				p = append(p, fmt.Sprintf("table %s: column key %q is empty or duplicated", o.ID, c.Key))
			}
			seen[c.Key] = true
			if !columnKind[c.Kind] {
				p = append(p, fmt.Sprintf("table %s: column %s has unknown kind %q", o.ID, c.Key, c.Kind))
			}
		}
	}
	return p
}

// loadPlugins scans the plugin directory (directories starting with _ are skipped). It rescans on every call, so new plugins need no backend restart.
// When a plugin id or table id repeats one already loaded, the later plugin is rejected (tables are stored by id and must be unique).
func (s *Server) loadPlugins() ([]Manifest, []string) {
	var out []Manifest
	var problems []string
	files, _ := filepath.Glob(filepath.Join(s.cfg.PluginsDir, "*", "*", "plugin.json"))
	sort.Strings(files)
	ids := map[string]string{}
	tables := map[string]string{}
	for _, f := range files {
		dir := filepath.Dir(f)
		rel, _ := filepath.Rel(s.cfg.PluginsDir, dir)
		if strings.HasPrefix(rel, "_") || strings.Contains(rel, string(filepath.Separator)+"_") {
			continue
		}
		rel = filepath.ToSlash(rel)
		b, err := os.ReadFile(f)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", rel, err))
			continue
		}
		var m Manifest
		if err := json.Unmarshal(b, &m); err != nil {
			problems = append(problems, fmt.Sprintf("%s/plugin.json is not valid JSON: %v", rel, err))
			continue
		}
		bad := validateManifest(&m, dir)
		if other, ok := ids[m.ID]; ok {
			bad = append(bad, fmt.Sprintf("plugin id %s duplicates %s", m.ID, other))
		}
		for _, o := range m.Outputs {
			if other, ok := tables[o.ID]; ok {
				bad = append(bad, fmt.Sprintf("table id %s is already used by %s", o.ID, other))
			}
		}
		if len(bad) > 0 {
			problems = append(problems, fmt.Sprintf("%s: %s", rel, strings.Join(bad, "；")))
			continue
		}
		m.Locales = loadLocales(dir, &problems, rel)
		ids[m.ID] = rel
		for _, o := range m.Outputs {
			tables[o.ID] = rel
		}
		m.Dir = dir
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, problems
}

// loadLocales reads locales/*.json of a plugin; a broken file is reported and skipped.
func loadLocales(dir string, problems *[]string, rel string) map[string]json.RawMessage {
	files, _ := filepath.Glob(filepath.Join(dir, "locales", "*.json"))
	if len(files) == 0 {
		return nil
	}
	out := map[string]json.RawMessage{}
	for _, f := range files {
		lang := strings.TrimSuffix(filepath.Base(f), ".json")
		b, err := os.ReadFile(f)
		if err == nil && !json.Valid(b) {
			err = errors.New("not valid JSON")
		}
		if err != nil {
			*problems = append(*problems, fmt.Sprintf("%s/locales/%s.json: %v", rel, lang, err))
			continue
		}
		out[lang] = b
	}
	return out
}

func (s *Server) plugin(id string) (Manifest, bool) {
	ms, _ := s.loadPlugins()
	for _, m := range ms {
		if m.ID == id {
			return m, true
		}
	}
	return Manifest{}, false
}

// ---------------- Python environment ----------------

// PythonEnv describes the Python interpreter used for plugins.
type PythonEnv struct {
	OK      bool     `json:"ok"`
	Path    string   `json:"path"`
	Version string   `json:"version,omitempty"`
	Error   string   `json:"error,omitempty"`
	Missing []string `json:"missing"` // modules declared by plugins but not installed
	checked time.Time
	mods    string
}

type pyCache struct {
	mu  sync.Mutex
	env PythonEnv
}

const pyProbe = `import importlib.util, json, sys
miss = []
for m in json.loads(sys.argv[1]):
    try:
        if importlib.util.find_spec(m) is None:
            miss.append(m)
    except Exception:
        miss.append(m)
print(json.dumps({"version": sys.version.split()[0], "missing": miss}))`

// pythonEnv checks the interpreter and dependency modules (cached for 60 s; force re-checks).
func (s *Server) pythonEnv(ms []Manifest, force bool) PythonEnv {
	set := map[string]bool{}
	for _, m := range ms {
		for _, d := range m.Dependencies {
			set[d] = true
		}
	}
	mods := make([]string, 0, len(set))
	for d := range set {
		mods = append(mods, d)
	}
	sort.Strings(mods)
	key := strings.Join(mods, ",")

	s.py.mu.Lock()
	defer s.py.mu.Unlock()
	if !force && s.py.env.mods == key && time.Since(s.py.env.checked) < time.Minute {
		return s.py.env
	}
	env := PythonEnv{Path: s.cfg.Python, Missing: []string{}, checked: time.Now(), mods: key}
	arg, _ := json.Marshal(mods)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.cfg.Python, "-I", "-B", "-X", "utf8", "-c", pyProbe, string(arg))
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		if _, serr := os.Stat(s.cfg.Python); serr != nil {
			env.Error = "Python interpreter not found: " + s.cfg.Python + " (create .venv as described in docs/setup.md)"
		} else {
			env.Error = "Python cannot run: " + err.Error()
		}
	} else {
		var r struct {
			Version string   `json:"version"`
			Missing []string `json:"missing"`
		}
		if err := json.Unmarshal(out, &r); err != nil {
			env.Error = "unexpected output from Python"
		} else {
			env.OK, env.Version = true, r.Version
			if r.Missing != nil {
				env.Missing = r.Missing
			}
		}
	}
	s.py.env = env
	return env
}

func missingFor(m Manifest, env PythonEnv) []string {
	var out []string
	for _, d := range m.Dependencies {
		if contains(env.Missing, d) {
			out = append(out, d)
		}
	}
	return out
}

// ---------------- Run jobs ----------------

type pluginJob struct {
	mu       sync.Mutex
	running  bool
	stopping bool
	current  string
	progress float64
	message  string
	queue    []string
	cancel   context.CancelFunc
}

type PluginStatus struct {
	Running  bool               `json:"running"`
	Stopping bool               `json:"stopping,omitempty"`
	Current  string             `json:"current,omitempty"`
	Progress float64            `json:"progress"`
	Message  string             `json:"message,omitempty"`
	Queue    []string           `json:"queue"`
	Runs     []casedb.PluginRun `json:"runs"`
	Counts   map[string]int64   `json:"counts"`
}

func (ev *Evidence) pluginStatus() PluginStatus {
	ev.plug.mu.Lock()
	st := PluginStatus{Running: ev.plug.running, Stopping: ev.plug.stopping, Current: ev.plug.current, Progress: ev.plug.progress,
		Message: ev.plug.message, Queue: append([]string{}, ev.plug.queue...)}
	ev.plug.mu.Unlock()
	st.Runs, _ = ev.db.PluginRuns(ev.Info.ID)
	st.Counts, _ = ev.db.ArtifactCounts(ev.Info.ID)
	if st.Runs == nil {
		st.Runs = []casedb.PluginRun{}
	}
	return st
}

// startPlugins runs the given plugins one after another (empty ids means all). If a job is running they are appended to its queue.
func (s *Server) startPlugins(c *openCase, ev *Evidence, ids []string) (PluginStatus, error) {
	all, _ := s.loadPlugins()
	var list []Manifest
	for _, m := range all {
		if len(ids) == 0 || contains(ids, m.ID) {
			list = append(list, m)
		}
	}
	if len(list) == 0 {
		return PluginStatus{}, errors.New("no plugins to run")
	}
	ev.plug.mu.Lock()
	if ev.plug.stopping {
		ev.plug.mu.Unlock()
		return PluginStatus{}, errors.New("plugins are stopping, try again shortly")
	}
	for _, m := range list {
		if m.ID != ev.plug.current && !contains(ev.plug.queue, m.ID) {
			ev.plug.queue = append(ev.plug.queue, m.ID)
		}
	}
	if ev.plug.running {
		ev.plug.mu.Unlock()
		return ev.pluginStatus(), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	ev.plug.running, ev.plug.cancel = true, cancel
	ev.plug.mu.Unlock()

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer cancel()
		for {
			ev.plug.mu.Lock()
			if len(ev.plug.queue) == 0 || ctx.Err() != nil {
				ev.plug.running, ev.plug.stopping, ev.plug.current, ev.plug.queue = false, false, "", nil
				ev.plug.mu.Unlock()
				return
			}
			id := ev.plug.queue[0]
			ev.plug.queue = ev.plug.queue[1:]
			ev.plug.current, ev.plug.progress, ev.plug.message = id, 0, ""
			ev.plug.mu.Unlock()
			if m, ok := s.plugin(id); ok {
				s.runOne(ctx, c, ev, m)
			}
		}
	}()
	return ev.pluginStatus(), nil
}

// stopPlugins clears the queue and stops the running plugin (its results are discarded; the last successful results stay).
func (ev *Evidence) stopPlugins() PluginStatus {
	ev.plug.mu.Lock()
	if ev.plug.running {
		ev.plug.queue = nil
		ev.plug.stopping = true
		if ev.plug.cancel != nil {
			ev.plug.cancel()
		}
	}
	ev.plug.mu.Unlock()
	return ev.pluginStatus()
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// runOne runs one plugin and writes its results to the case database.
func (s *Server) runOne(ctx context.Context, c *openCase, ev *Evidence, m Manifest) {
	id := ev.Info.ID
	if err := c.db.BeginPluginRun(id, m.ID, m.Version); err != nil {
		logf("plugin %s: %v", m.ID, err)
		return
	}
	finish := func(r casedb.RunResult) {
		if err := c.db.FinishPluginRun(id, m.ID, r); err != nil {
			logf("plugin %s: cannot write results: %v", m.ID, err)
		}
	}
	// unmet requirements mark the run "skipped" (not applicable), not failed
	if reason := s.unmetRequirement(c, ev, m); reason != "" {
		finish(casedb.RunResult{State: "skipped", Error: reason})
		return
	}
	all, _ := s.loadPlugins()
	env := s.pythonEnv(all, false)
	if !env.OK {
		finish(casedb.RunResult{State: "error", Error: env.Error})
		return
	}
	if miss := missingFor(m, env); len(miss) > 0 {
		env = s.pythonEnv(all, true) // may have just been installed; check again
		if miss = missingFor(m, env); len(miss) > 0 {
			finish(casedb.RunResult{State: "error", Error: "missing Python dependencies: " + strings.Join(miss, ", ") +
				` (run .venv\Scripts\pip install -r plugins\requirements.txt in the project root)`})
			return
		}
	}
	start := time.Now()
	r := s.execPlugin(ctx, c, ev, m)
	finish(r)
	logf("plugin %s @ %s: %s, %d rows, %.1fs %s", m.ID, id, r.State, r.Rows, time.Since(start).Seconds(), r.Error)
}

func (s *Server) unmetRequirement(c *openCase, ev *Evidence, m Manifest) string {
	for _, r := range m.Requires {
		if r == "index" {
			if st := ev.indexStatus().State; st != "done" && st != "partial" {
				return "needs the file index; build it first"
			}
			continue
		}
		ev.mu.Lock()
		_, _, _, err := ev.resolve(rpcTarget{Path: r})
		ev.mu.Unlock()
		if err != nil {
			return "not applicable: evidence has no " + r
		}
	}
	return ""
}
