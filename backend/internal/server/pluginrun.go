package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"forensics/internal/casedb"
)

var logf = log.Printf

var errPluginTimeout = errors.New("plugin timeout")

const maxLogLines = 2000

// execPlugin starts the plugin process, serves JSON-RPC on its stdin/stdout and returns the outcome.
// Result rows are staged; they replace the old results only when the outcome is done (see FinishPluginRun).
func (s *Server) execPlugin(parent context.Context, c *openCase, ev *Evidence, m Manifest) casedb.RunResult {
	timeout := time.Duration(m.Timeout) * time.Second
	ctx, cancel := context.WithTimeoutCause(parent, timeout, errPluginTimeout)
	defer cancel()

	workdir := pluginWorkDir(c, ev, m)
	if err := os.MkdirAll(workdir, 0o755); err != nil {
		return casedb.RunResult{State: "error", Error: "cannot create the plugin work directory: " + err.Error()}
	}
	runner := filepath.Join(s.cfg.PluginsDir, "_sdk", "runner.py")
	// -I isolates from the user environment, -B writes no __pycache__ into plugin folders, -X utf8 keeps non-ASCII output intact
	cmd := exec.CommandContext(ctx, s.cfg.Python, "-I", "-B", "-X", "utf8", runner, m.Dir)
	cmd.Dir = workdir
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return casedb.RunResult{State: "error", Error: err.Error()}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return casedb.RunResult{State: "error", Error: err.Error()}
	}
	stderr := &tailBuffer{max: 64 << 10}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return casedb.RunResult{State: "error", Error: fmt.Sprintf("cannot start Python (%s): %v", s.cfg.Python, err)}
	}

	declared := map[string]map[string]bool{}
	for _, o := range m.Outputs {
		cols := map[string]bool{}
		for _, col := range o.Columns {
			cols[col.Key] = true
		}
		declared[o.ID] = cols
	}
	var (
		rows     int64
		logs     []string
		failMsg  string
		warned   = map[string]bool{}
		summary  = map[string]string{}
		finished bool // the plugin's run() returned normally
	)
	addLog := func(line string) {
		logs = append(logs, line)
		if len(logs) > maxLogLines {
			logs = logs[len(logs)-maxLogLines:]
		}
	}
	warnOnce := func(key, msg string) {
		if !warned[key] {
			warned[key] = true
			addLog("warning: " + msg)
		}
	}
	abort := func(msg string) {
		if failMsg == "" {
			failMsg = msg
		}
		cancel()
	}

	r := bufio.NewReaderSize(stdout, 1<<20)
	w := bufio.NewWriter(stdin)
	for {
		line, rerr := r.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			var msg struct {
				ID     *int64          `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if json.Unmarshal(line, &msg) != nil {
				warnOnce("badline", "the plugin wrote unparseable protocol data (did it write to stdout without the SDK?)")
				continue
			}
			if msg.ID != nil { // request: handle synchronously and reply
				result, herr := s.handleRPC(c, ev, m, workdir, msg.Method, msg.Params)
				resp := map[string]any{"id": *msg.ID}
				if herr != nil {
					resp["error"] = herr.Error()
				} else {
					resp["result"] = result
				}
				b, _ := json.Marshal(resp)
				w.Write(append(b, '\n'))
				w.Flush() // fails if the process already exited; the loop then reads EOF and ends
				continue
			}
			switch msg.Method { // notifications
			case "emit":
				var p struct {
					Table string            `json:"table"`
					Rows  []json.RawMessage `json:"rows"`
				}
				if err := json.Unmarshal(msg.Params, &p); err != nil {
					abort("invalid emit parameters: " + err.Error())
					continue
				}
				cols, ok := declared[p.Table]
				if !ok {
					warnOnce("table:"+p.Table, fmt.Sprintf("ignored table %q, it is not declared in plugin.json", p.Table))
					continue
				}
				good := p.Rows[:0]
				for _, row := range p.Rows {
					var obj map[string]json.RawMessage
					if json.Unmarshal(row, &obj) != nil {
						warnOnce("notobj:"+p.Table, fmt.Sprintf("table %s: ignored rows that are not JSON objects", p.Table))
						continue
					}
					for k := range obj {
						if !cols[k] && !strings.HasPrefix(k, "_") { // _file etc. are reserved hidden fields
							warnOnce("col:"+p.Table+":"+k, fmt.Sprintf("table %s: field %q is not declared in columns and will not be shown", p.Table, k))
						}
					}
					good = append(good, row)
				}
				if rows+int64(len(good)) > maxRowsPerRun {
					abort(fmt.Sprintf("more than %d result rows in one run", maxRowsPerRun))
					continue
				}
				if err := c.db.AddArtifacts(ev.Info.ID, m.ID, p.Table, good); err != nil {
					abort("cannot write results: " + err.Error())
					continue
				}
				rows += int64(len(good))
			case "summary":
				var p struct{ Key, Value string }
				json.Unmarshal(msg.Params, &p)
				if p.Key != "" && p.Value != "" {
					summary[p.Key] = p.Value
				}
			case "progress":
				var p struct {
					Value   float64 `json:"value"`
					Message string  `json:"message"`
				}
				json.Unmarshal(msg.Params, &p)
				ev.plug.mu.Lock()
				ev.plug.progress, ev.plug.message = min(max(p.Value, 0), 1), p.Message
				ev.plug.mu.Unlock()
			case "log":
				var p struct{ Message string }
				json.Unmarshal(msg.Params, &p)
				addLog(p.Message)
			case "fail":
				var p struct{ Error string }
				json.Unmarshal(msg.Params, &p)
				if failMsg == "" {
					failMsg = p.Error
				}
			case "done":
				finished = true
			default:
				warnOnce("method:"+msg.Method, "unknown notification "+msg.Method)
			}
		}
		if rerr != nil {
			break
		}
	}
	stdin.Close()
	waitErr := cmd.Wait()

	res := casedb.RunResult{Rows: rows}
	if errText := stderr.String(); errText != "" {
		addLog("--- plugin stderr ---\n" + errText)
	}
	res.Log = strings.Join(logs, "\n")
	switch {
	case errors.Is(context.Cause(ctx), errPluginTimeout):
		res.State, res.Error = "error", fmt.Sprintf("timed out after %s (adjust timeout in plugin.json)", timeout)
	case parent.Err() != nil:
		res.State, res.Error = "cancelled", "Stopped"
	case failMsg != "":
		res.State, res.Error = "error", failMsg
	case waitErr != nil:
		res.State, res.Error = "error", fmt.Sprintf("plugin process exited abnormally (%v); see the log", waitErr)
	case !finished:
		res.State, res.Error = "error", "plugin did not finish normally (no done notification); see the log"
	default:
		res.State, res.Summary = "done", summary
	}
	return res
}

// pluginWorkDir is the plugin's work directory: case/work/<evidence>/plugins/<plugin id>.
func pluginWorkDir(c *openCase, ev *Evidence, m Manifest) string {
	return filepath.Join(c.db.WorkDir(), ev.Info.ID, "plugins", m.ID)
}

// tailBuffer keeps only the last max bytes (the plugin's stderr).
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(strings.ToValidUTF8(string(t.buf), "�"))
}
