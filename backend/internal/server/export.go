package server

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"forensics/internal/tsk"
)

// File export: copies files and folders out of the evidence onto the examiner's machine.
// Each file is read in chunks (the TSK lock is held per chunk only, so browsing stays responsive), hashed with
// MD5 and SHA-256, written with its original created/modified/accessed times, and listed in a CSV report.

type ExportItem struct {
	Part  int    `json:"part"`
	Inode uint64 `json:"inode"`
	Name  string `json:"name"`
	Path  string `json:"path"` // path inside the partition, e.g. \Users\a\x.txt (for the report)
}

type ExportRequest struct {
	Items          []ExportItem `json:"items"`
	Dest           string       `json:"dest"`
	Hash           bool         `json:"hash"`           // MD5 + SHA-256 and a CSV report
	IncludeDeleted bool         `json:"includeDeleted"` // also export deleted entries found inside exported folders
}

type ExportStatus struct {
	State      string   `json:"state"` // idle | running | done | cancelled | error
	Evidence   string   `json:"evidence,omitempty"`
	Dest       string   `json:"dest,omitempty"`
	Files      int64    `json:"files"`      // files planned
	Done       int64    `json:"done"`       // files finished (incl. failed)
	Bytes      int64    `json:"bytes"`      // bytes written
	TotalBytes int64    `json:"totalBytes"` // bytes planned
	Current    string   `json:"current,omitempty"`
	Failed     int      `json:"failed"`
	Partial    int      `json:"partial"` // files that could only be read in part (typically deleted files)
	Problems   []string `json:"problems"`
	Report     string   `json:"report,omitempty"`
	Error      string   `json:"error,omitempty"`
	Seconds    float64  `json:"seconds"`
}

type exportJob struct {
	mu      sync.Mutex
	status  ExportStatus
	done    atomic.Int64
	bytes   atomic.Int64
	cancel  atomic.Bool
	started time.Time
}

func (j *exportJob) snapshot() ExportStatus {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.status
	if s.State == "" {
		s.State = "idle"
	}
	if s.State == "running" {
		s.Done, s.Bytes = j.done.Load(), j.bytes.Load()
		s.Seconds = time.Since(j.started).Seconds()
	}
	s.Problems = append(make([]string, 0, len(s.Problems)), s.Problems...)
	return s
}

func (j *exportJob) set(f func(s *ExportStatus)) {
	j.mu.Lock()
	f(&j.status)
	j.mu.Unlock()
}

func (j *exportJob) problem(msg string) {
	j.set(func(s *ExportStatus) {
		if len(s.Problems) < 200 {
			s.Problems = append(s.Problems, msg)
		}
	})
}

// planned export: one file or directory with its destination
type exportEntry struct {
	part     int
	entry    tsk.Entry
	srcPath  string // inside the partition, backslash separated
	destPath string
}

var (
	badNameChars = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)
	reservedName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$`)
)

// safeName turns a name from the evidence into a valid Windows file name.
func safeName(n string) string {
	n = badNameChars.ReplaceAllString(n, "_")
	n = strings.TrimRight(n, " .")
	if n == "" || n == "." || n == ".." {
		n = "_"
	}
	if reservedName.MatchString(n) {
		n = "_" + n
	}
	return n
}

// uniquePath returns dir\name, or dir\name (2).ext etc. when it is already taken (by an earlier export or the plan).
func uniquePath(dir, name string, taken map[string]bool) string {
	p := filepath.Join(dir, name)
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		key := strings.ToLower(p)
		if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) && !taken[key] {
			taken[key] = true
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
	}
}

func (s *Server) startExport(w http.ResponseWriter, r *http.Request) {
	c, ev := s.ev(w, r)
	if ev == nil {
		return
	}
	var req ExportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	dest := filepath.Clean(strings.TrimSpace(req.Dest))
	if len(req.Items) == 0 || !filepath.IsAbs(dest) {
		writeErr(w, http.StatusBadRequest, errors.New("choose what to export and an absolute destination folder"))
		return
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("cannot use the destination folder: %w", err))
		return
	}
	j := c.export
	j.mu.Lock()
	if j.status.State == "running" {
		j.mu.Unlock()
		writeErr(w, http.StatusConflict, errors.New("an export is already running"))
		return
	}
	j.status = ExportStatus{State: "running", Evidence: ev.Info.Name, Dest: dest, Problems: []string{}}
	j.done.Store(0)
	j.bytes.Store(0)
	j.cancel.Store(false)
	j.started = time.Now()
	j.mu.Unlock()

	names := make([]string, 0, len(req.Items))
	for _, it := range req.Items {
		names = append(names, fmt.Sprintf("p%d:%s", it.Part, it.Path))
	}
	c.db.Audit("Export started", fmt.Sprintf("%s: %s -> %s", ev.Info.ID, strings.Join(names, ", "), dest))
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		s.runExport(c, ev, req, dest)
	}()
	writeJSON(w, j.snapshot())
}

func (s *Server) getExport(w http.ResponseWriter, _ *http.Request) {
	if c := s.current(w); c != nil {
		writeJSON(w, c.export.snapshot())
	}
}

func (s *Server) cancelExport(w http.ResponseWriter, _ *http.Request) {
	if c := s.current(w); c != nil {
		c.export.cancel.Store(true)
		writeJSON(w, c.export.snapshot())
	}
}

func (s *Server) runExport(c *openCase, ev *Evidence, req ExportRequest, dest string) {
	j := c.export
	finish := func(state string, err error) {
		j.set(func(st *ExportStatus) {
			st.State, st.Current = state, ""
			st.Done, st.Bytes = j.done.Load(), j.bytes.Load()
			st.Seconds = time.Since(j.started).Seconds()
			if err != nil {
				st.Error = err.Error()
			}
		})
		st := j.snapshot()
		c.db.Audit("Export finished", fmt.Sprintf("%s: %s, %d files, %d bytes, %d failed, %d partial -> %s",
			ev.Info.ID, state, st.Done, st.Bytes, st.Failed, st.Partial, dest))
	}

	// 1. plan: resolve the items and walk folders
	plan, err := s.planExport(ev, req, dest, j)
	if err != nil {
		finish("error", err)
		return
	}
	var files, total int64
	for _, p := range plan {
		if !p.entry.IsDir {
			files++
			total += p.entry.Size
		}
	}
	j.set(func(st *ExportStatus) { st.Files, st.TotalBytes = files, total })

	// 2. report
	var report *csv.Writer
	if req.Hash {
		name := fmt.Sprintf("DiskSleuth-export-%s.csv", time.Now().Format("20060102-150405"))
		rf, err := os.Create(filepath.Join(dest, name))
		if err != nil {
			finish("error", fmt.Errorf("cannot write the report: %w", err))
			return
		}
		defer rf.Close()
		rf.Write([]byte{0xEF, 0xBB, 0xBF}) // BOM so spreadsheet programs read UTF-8 names correctly
		report = csv.NewWriter(rf)
		defer report.Flush()
		report.Write([]string{"Status", "Source", "Partition", "Inode", "Deleted", "Size", "Exported bytes", "MD5", "SHA-256",
			"Created (UTC)", "Modified (UTC)", "Accessed (UTC)", "Destination", "Note"})
		j.set(func(st *ExportStatus) { st.Report = rf.Name() })
	}

	// 3. copy
	buf := make([]byte, 1<<20)
	for _, p := range plan {
		if j.cancel.Load() {
			finish("cancelled", nil)
			return
		}
		if p.entry.IsDir {
			if err := os.MkdirAll(p.destPath, 0o755); err != nil {
				j.problem(fmt.Sprintf("%s: %v", p.srcPath, err))
			}
			continue
		}
		j.set(func(st *ExportStatus) { st.Current = p.srcPath })
		res := exportFile(ev, p, buf, &j.bytes, &j.cancel)
		j.done.Add(1)
		status := "OK"
		switch {
		case res.err != nil:
			status = "FAILED"
			j.set(func(st *ExportStatus) { st.Failed++ })
			j.problem(fmt.Sprintf("%s: %v", p.srcPath, res.err))
		case res.written < p.entry.Size:
			status = "PARTIAL"
			j.set(func(st *ExportStatus) { st.Partial++ })
			j.problem(fmt.Sprintf("%s: only %d of %d bytes could be read", p.srcPath, res.written, p.entry.Size))
		}
		if report != nil {
			report.Write([]string{status, ev.Info.Name + `\Partition ` + strconv.Itoa(p.part) + p.srcPath, strconv.Itoa(p.part),
				strconv.FormatUint(p.entry.Inode, 10), yesNo(p.entry.Deleted), strconv.FormatInt(p.entry.Size, 10),
				strconv.FormatInt(res.written, 10), res.md5, res.sha256, unixText(p.entry.Created), unixText(p.entry.Modified),
				unixText(p.entry.Accessed), p.destPath, res.note})
		}
	}
	if j.cancel.Load() {
		finish("cancelled", nil)
		return
	}
	finish("done", nil)
}

// planExport resolves the requested items and lists everything to export (folders first, then their content).
func (s *Server) planExport(ev *Evidence, req ExportRequest, dest string, j *exportJob) ([]exportEntry, error) {
	taken := map[string]bool{}
	var plan []exportEntry
	for _, it := range req.Items {
		ev.mu.Lock()
		fs, err := ev.fsFor(it.Part)
		var e tsk.Entry
		ok := false
		if err == nil {
			e, ok = fs.StatInode(it.Inode)
		}
		ev.mu.Unlock()
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("inode %d does not exist in partition %d", it.Inode, it.Part)
		}
		e.Name = it.Name
		if e.Name == "" { // e.g. from "Show source file": take the last path segment
			e.Name = it.Path[strings.LastIndexAny(it.Path, `\/`)+1:]
		}
		src := strings.ReplaceAll(it.Path, "/", `\`)
		if !strings.HasPrefix(src, `\`) {
			src = `\` + src
		}
		root := exportEntry{part: it.Part, entry: e, srcPath: src, destPath: uniquePath(dest, safeName(e.Name), taken)}
		plan = append(plan, root)
		if e.IsDir {
			if err := walkExport(ev, fs, root, req.IncludeDeleted, taken, &plan, j); err != nil {
				return nil, err
			}
		}
	}
	return plan, nil
}

func walkExport(ev *Evidence, fs *tsk.FS, dir exportEntry, deleted bool, taken map[string]bool, plan *[]exportEntry, j *exportJob) error {
	seen := map[uint64]bool{dir.entry.Inode: true} // guard against loops through stale directory entries
	queue := []exportEntry{dir}
	for len(queue) > 0 {
		if j.cancel.Load() {
			return errors.New("cancelled")
		}
		d := queue[0]
		queue = queue[1:]
		j.set(func(st *ExportStatus) { st.Current = d.srcPath })
		ev.mu.Lock()
		children, err := fs.ListDir(d.entry.Inode)
		ev.mu.Unlock()
		if err != nil {
			j.problem(fmt.Sprintf("%s: %v", d.srcPath, err))
			continue
		}
		for _, c := range children {
			if c.Deleted && !deleted {
				continue
			}
			if c.IsDir && (seen[c.Inode] || c.Inode == 0) {
				continue
			}
			e := exportEntry{part: d.part, entry: c, srcPath: d.srcPath + `\` + c.Name, destPath: uniquePath(d.destPath, safeName(c.Name), taken)}
			*plan = append(*plan, e)
			if c.IsDir {
				seen[c.Inode] = true
				queue = append(queue, e)
			}
		}
	}
	return nil
}

type exportResult struct {
	written     int64
	md5, sha256 string
	note        string
	err         error
}

// exportFile copies one file and restores its timestamps.
func exportFile(ev *Evidence, p exportEntry, buf []byte, bytes *atomic.Int64, cancel *atomic.Bool) exportResult {
	var res exportResult
	f, err := os.OpenFile(p.destPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		res.err = err
		return res
	}
	hm, hs := md5.New(), sha256.New()
	out := io.MultiWriter(f, hm, hs)
	for res.written < p.entry.Size {
		if cancel.Load() {
			res.note = "export cancelled"
			break
		}
		ev.mu.Lock()
		fs, ferr := ev.fsFor(p.part)
		n := 0
		if ferr == nil {
			n, _, err = fs.ReadInode(p.entry.Inode, res.written, buf)
		} else {
			err = ferr
		}
		ev.mu.Unlock()
		if err != nil || n == 0 {
			if err != nil {
				res.note = "read stopped: " + err.Error()
			} else {
				res.note = "no more data could be read"
			}
			break
		}
		if _, err := out.Write(buf[:n]); err != nil {
			f.Close()
			res.err = err
			return res
		}
		res.written += int64(n)
		bytes.Add(int64(n))
	}
	res.md5 = hex.EncodeToString(hm.Sum(nil))
	res.sha256 = hex.EncodeToString(hs.Sum(nil))
	if err := setFileTimes(f, p.entry.Created, p.entry.Modified, p.entry.Accessed); err != nil && res.note == "" {
		res.note = "timestamps not restored: " + err.Error()
	}
	if err := f.Close(); err != nil {
		res.err = err
	}
	return res
}

func yesNo(b bool) string {
	if b {
		return "Yes"
	}
	return ""
}

func unixText(sec int64) string {
	if sec == 0 {
		return ""
	}
	return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04:05")
}
