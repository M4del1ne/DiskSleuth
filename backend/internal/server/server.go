// Package server provides the local HTTP JSON API used by the front end.
//
// Security: listens on 127.0.0.1 only; every request must carry the token generated at startup (Authorization: Bearer <token>).
// One case is open at a time; evidence, index and searches all belong to the current case.
package server

import (
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"forensics/internal/casedb"
	"forensics/internal/tsk"
)

const Version = "0.2.0"

type Config struct {
	Token      string
	PluginsDir string
	Python     string
	CasesDir   string // case root directory, one subdirectory per case
}

type openCase struct {
	db       *casedb.DB
	evidence map[string]*Evidence
	content  *contentJob
	export   *exportJob
	wg       sync.WaitGroup // background jobs (index, content search, plugins)
}

type Server struct {
	cfg Config
	mux *http.ServeMux

	mu  sync.Mutex
	cur *openCase
	py  pyCache
}

func New(cfg Config) *Server {
	s := &Server{cfg: cfg, mux: http.NewServeMux()}
	m := s.mux
	m.HandleFunc("GET /api/health", s.health)
	// cases
	m.HandleFunc("GET /api/cases", s.listCases)
	m.HandleFunc("POST /api/cases", s.createCase)
	m.HandleFunc("DELETE /api/cases", s.deleteCase)
	m.HandleFunc("POST /api/cases/open", s.openCaseHandler)
	m.HandleFunc("GET /api/case", s.getCase)
	m.HandleFunc("POST /api/case/close", s.closeCaseHandler)
	m.HandleFunc("GET /api/case/audit", s.audit)
	m.HandleFunc("POST /api/case/evidence", s.addEvidence)
	// evidence
	m.HandleFunc("GET /api/evidence/{id}", s.getEvidence)
	m.HandleFunc("GET /api/evidence/{id}/partitions/{part}/dir", s.listDir)
	m.HandleFunc("GET /api/evidence/{id}/partitions/{part}/file", s.readFile)
	m.HandleFunc("GET /api/evidence/{id}/hash", s.getHash)
	m.HandleFunc("POST /api/evidence/{id}/hash", s.startHash)
	m.HandleFunc("GET /api/evidence/{id}/index", s.getIndex)
	m.HandleFunc("POST /api/evidence/{id}/index", s.startIndex)
	m.HandleFunc("DELETE /api/evidence/{id}/index", s.cancelIndex)
	m.HandleFunc("GET /api/tasks", s.listTasks)
	// plugins
	m.HandleFunc("GET /api/plugins", s.listPlugins)
	m.HandleFunc("GET /api/evidence/{id}/plugins", s.getPlugins)
	m.HandleFunc("POST /api/evidence/{id}/plugins/run", s.runPlugins)
	m.HandleFunc("POST /api/evidence/{id}/plugins/stop", s.stopPlugins)
	m.HandleFunc("GET /api/evidence/{id}/artifacts/{table}", s.getArtifacts)
	m.HandleFunc("GET /api/evidence/{id}/summary", s.getSummary)
	m.HandleFunc("GET /api/evidence/{id}/locate", s.locatePath)
	m.HandleFunc("POST /api/evidence/{id}/export", s.startExport)
	m.HandleFunc("GET /api/export", s.getExport)
	m.HandleFunc("DELETE /api/export", s.cancelExport)
	// search
	m.HandleFunc("GET /api/search", s.search)
	m.HandleFunc("GET /api/files/{fid}", s.fileTrail)
	m.HandleFunc("POST /api/search/content", s.startContent)
	m.HandleFunc("GET /api/search/content", s.getContent)
	m.HandleFunc("DELETE /api/search/content", s.cancelContent)
	return s
}

// ServeHTTP: CORS (dev page http://localhost:*, packaged file:// sends Origin "null") + token check.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); allowedOrigin(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) != 1 {
		writeErr(w, http.StatusUnauthorized, errors.New("invalid token"))
		return
	}
	s.mux.ServeHTTP(w, r)
}

func allowedOrigin(o string) bool {
	if o == "null" {
		return true
	}
	u, err := url.Parse(o)
	if err != nil {
		return false
	}
	h := u.Hostname()
	return u.Scheme == "http" && (h == "localhost" || h == "127.0.0.1")
}

// Close closes the current case.
func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeCurrent()
}

// ---------------- Cases ----------------

type EvidenceView struct {
	EvidenceInfo
	Index IndexStatus `json:"index"`
}

type CaseView struct {
	Info     casedb.Info    `json:"info"`
	Evidence []EvidenceView `json:"evidence"`
}

type CaseSummary struct {
	Info          casedb.Info `json:"info"`
	EvidenceCount int         `json:"evidenceCount"`
	Open          bool        `json:"open"`
}

func (s *Server) view(c *openCase) CaseView {
	info, _ := c.db.Info()
	v := CaseView{Info: info, Evidence: []EvidenceView{}}
	rows, _ := c.db.ListEvidence()
	for _, r := range rows {
		if ev, ok := c.evidence[r.ID]; ok {
			v.Evidence = append(v.Evidence, EvidenceView{ev.Info, ev.indexStatus()})
		}
	}
	return v
}

// closeCurrent cancels background jobs, waits for them, then closes evidence and the case database. Caller holds s.mu.
func (s *Server) closeCurrent() {
	c := s.cur
	if c == nil {
		return
	}
	c.content.cancel.Store(true)
	c.export.cancel.Store(true)
	for _, ev := range c.evidence {
		ev.index.cancel.Store(true)
		ev.plug.mu.Lock()
		if ev.plug.cancel != nil {
			ev.plug.cancel() // stop the running plugin process
		}
		ev.plug.mu.Unlock()
	}
	c.wg.Wait()
	for _, ev := range c.evidence {
		ev.close()
	}
	c.db.Close()
	s.cur = nil
}

func (s *Server) activate(db *casedb.DB) (*openCase, error) {
	c := &openCase{db: db, evidence: map[string]*Evidence{}, content: &contentJob{}, export: &exportJob{}}
	rows, err := db.ListEvidence()
	if err != nil {
		db.Close()
		return nil, err
	}
	var failed []string
	for _, r := range rows {
		ev, err := openEvidence(r.ID, r.Path)
		if err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", r.Path, err))
			continue
		}
		ev.db = db
		ev.loadSaved()
		c.evidence[r.ID] = ev
	}
	if len(failed) > 0 {
		db.Audit("Evidence could not be opened", strings.Join(failed, "; "))
		log.Printf("some evidence could not be opened: %v", failed)
	}
	s.cur = c
	return c, nil
}

func (s *Server) openCaseHandler(w http.ResponseWriter, r *http.Request) {
	var req struct{ Dir string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Dir == "" {
		writeErr(w, http.StatusBadRequest, errors.New("missing case directory"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != nil && strings.EqualFold(s.cur.db.Dir, req.Dir) {
		writeJSON(w, s.view(s.cur))
		return
	}
	s.closeCurrent()
	db, err := casedb.Open(req.Dir)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, err)
		return
	}
	c, err := s.activate(db)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	s.remember(req.Dir)
	writeJSON(w, s.view(c))
}

func (s *Server) current(w http.ResponseWriter) *openCase {
	s.mu.Lock()
	c := s.cur
	s.mu.Unlock()
	if c == nil {
		writeErr(w, http.StatusConflict, errors.New("no case is open"))
	}
	return c
}

func (s *Server) getCase(w http.ResponseWriter, _ *http.Request) {
	if c := s.current(w); c != nil {
		writeJSON(w, s.view(c))
	}
}

func (s *Server) closeCaseHandler(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	s.closeCurrent()
	s.mu.Unlock()
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) audit(w http.ResponseWriter, _ *http.Request) {
	c := s.current(w)
	if c == nil {
		return
	}
	log, err := c.db.AuditLog(500)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, log)
}

func (s *Server) addEvidence(w http.ResponseWriter, r *http.Request) {
	c := s.current(w)
	if c == nil {
		return
	}
	var req struct{ Path string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Path) == "" {
		writeErr(w, http.StatusBadRequest, errors.New("missing evidence path"))
		return
	}
	path, err := filepath.Abs(strings.TrimSpace(req.Path))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	sum := sha1.Sum([]byte(strings.ToLower(path)))
	id := hex.EncodeToString(sum[:])[:12]

	s.mu.Lock()
	if ev, ok := c.evidence[id]; ok {
		s.mu.Unlock()
		writeJSON(w, EvidenceView{ev.Info, ev.indexStatus()})
		return
	}
	s.mu.Unlock()

	ev, err := openEvidence(id, path)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, err)
		return
	}
	ev.db = c.db
	infoJSON, _ := json.Marshal(ev.Info)
	if err := c.db.AddEvidence(id, path, string(infoJSON)); err != nil {
		ev.close()
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	ev.loadSaved()
	s.mu.Lock()
	c.evidence[id] = ev
	s.mu.Unlock()
	log.Printf("added evidence %s (%s)", path, id)
	writeJSON(w, EvidenceView{ev.Info, ev.indexStatus()})
}

// ---------------- Evidence ----------------

func (s *Server) ev(w http.ResponseWriter, r *http.Request) (*openCase, *Evidence) {
	c := s.current(w)
	if c == nil {
		return nil, nil
	}
	s.mu.Lock()
	ev := c.evidence[r.PathValue("id")]
	s.mu.Unlock()
	if ev == nil {
		writeErr(w, http.StatusNotFound, errors.New("evidence is not open"))
		return nil, nil
	}
	return c, ev
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]string{"name": "DiskSleuth", "version": Version, "tsk": tsk.Version(), "casesDir": s.cfg.CasesDir})
}

func (s *Server) getEvidence(w http.ResponseWriter, r *http.Request) {
	if _, ev := s.ev(w, r); ev != nil {
		writeJSON(w, EvidenceView{ev.Info, ev.indexStatus()})
	}
}

func (s *Server) listDir(w http.ResponseWriter, r *http.Request) {
	_, ev := s.ev(w, r)
	if ev == nil {
		return
	}
	part, _ := strconv.Atoi(r.PathValue("part"))
	ev.mu.Lock()
	defer ev.mu.Unlock()
	fs, err := ev.fsFor(part)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	inode := fs.RootInode()
	if v := r.URL.Query().Get("inode"); v != "" {
		if inode, err = strconv.ParseUint(v, 10, 64); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
	}
	entries, err := fs.ListDir(inode)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, map[string]any{"inode": inode, "entries": entries})
}

func (s *Server) readFile(w http.ResponseWriter, r *http.Request) {
	_, ev := s.ev(w, r)
	if ev == nil {
		return
	}
	q := r.URL.Query()
	part, _ := strconv.Atoi(r.PathValue("part"))
	inode, err := strconv.ParseUint(q.Get("inode"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, errors.New("missing inode"))
		return
	}
	off, _ := strconv.ParseInt(q.Get("offset"), 10, 64)
	length, _ := strconv.Atoi(q.Get("length"))
	if length <= 0 || length > 1<<20 {
		length = 4096
	}
	ev.mu.Lock()
	defer ev.mu.Unlock()
	fs, err := ev.fsFor(part)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	buf := make([]byte, length)
	n, size, err := fs.ReadInode(inode, off, buf)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, map[string]any{"inode": inode, "size": size, "offset": off, "data": base64.StdEncoding.EncodeToString(buf[:n])})
}

func (s *Server) getHash(w http.ResponseWriter, r *http.Request) {
	if _, ev := s.ev(w, r); ev != nil {
		writeJSON(w, ev.hashStatus())
	}
}

func (s *Server) startHash(w http.ResponseWriter, r *http.Request) {
	if _, ev := s.ev(w, r); ev != nil {
		writeJSON(w, ev.startHash())
	}
}

func (s *Server) getIndex(w http.ResponseWriter, r *http.Request) {
	if _, ev := s.ev(w, r); ev != nil {
		writeJSON(w, ev.indexStatus())
	}
}

func (s *Server) startIndex(w http.ResponseWriter, r *http.Request) {
	if c, ev := s.ev(w, r); ev != nil {
		writeJSON(w, ev.startIndex(&c.wg))
	}
}

// listPlugins returns the plugin manifests, manifest problems and the Python environment (?refresh=1 re-checks dependencies).
func (s *Server) listPlugins(w http.ResponseWriter, r *http.Request) {
	ms, problems := s.loadPlugins()
	if ms == nil {
		ms = []Manifest{}
	}
	if problems == nil {
		problems = []string{}
	}
	env := s.pythonEnv(ms, r.URL.Query().Get("refresh") == "1")
	for i := range ms {
		ms[i].Missing = missingFor(ms[i], env)
	}
	writeJSON(w, map[string]any{"plugins": ms, "problems": problems, "python": env, "api": PluginAPI})
}

func (s *Server) stopPlugins(w http.ResponseWriter, r *http.Request) {
	if _, ev := s.ev(w, r); ev != nil {
		writeJSON(w, ev.stopPlugins())
	}
}

func (s *Server) getPlugins(w http.ResponseWriter, r *http.Request) {
	if _, ev := s.ev(w, r); ev != nil {
		writeJSON(w, ev.pluginStatus())
	}
}

func (s *Server) runPlugins(w http.ResponseWriter, r *http.Request) {
	c, ev := s.ev(w, r)
	if ev == nil {
		return
	}
	var req struct {
		IDs []string `json:"ids"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	st, err := s.startPlugins(c, ev, req.IDs)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, st)
}

// getArtifacts returns one result table: columns from the plugin manifest, rows from the case database.
func (s *Server) getArtifacts(w http.ResponseWriter, r *http.Request) {
	c, ev := s.ev(w, r)
	if ev == nil {
		return
	}
	table := r.PathValue("table")
	var cols []Column
	ms, _ := s.loadPlugins()
	for _, m := range ms {
		for _, o := range m.Outputs {
			if o.ID == table {
				cols = o.Columns
			}
		}
	}
	rows, err := c.db.Artifacts(ev.Info.ID, table, 0)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"columns": cols, "rows": rows})
}

func (s *Server) getSummary(w http.ResponseWriter, r *http.Request) {
	c, ev := s.ev(w, r)
	if ev == nil {
		return
	}
	m, err := c.db.Summary(ev.Info.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, m)
}

// ---------------- Search ----------------

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	c := s.current(w)
	if c == nil {
		return
	}
	q := r.URL.Query()
	query := strings.TrimSpace(q.Get("q"))
	if query == "" {
		writeErr(w, http.StatusBadRequest, errors.New("missing search text"))
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	start := time.Now()
	rows, truncated, err := c.db.Search(casedb.SearchQuery{
		Q: query, Regex: q.Get("regex") == "1", InPath: q.Get("path") == "1", Deleted: q.Get("deleted") == "1",
		Kind: q.Get("kind"), EvidenceID: q.Get("evidence"), Limit: limit,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	c.db.Audit("File name search", query)
	writeJSON(w, map[string]any{"hits": rows, "truncated": truncated, "ms": time.Since(start).Milliseconds()})
}

// fileTrail returns an indexed file and the path from the partition root to its directory (for "show in Files").
func (s *Server) fileTrail(w http.ResponseWriter, r *http.Request) {
	c := s.current(w)
	if c == nil {
		return
	}
	fid, err := strconv.ParseInt(r.PathValue("fid"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	f, err := c.db.File(fid)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	s.mu.Lock()
	ev := c.evidence[f.EvidenceID]
	s.mu.Unlock()
	var root uint64 = 5
	if ev != nil {
		for _, p := range ev.Info.Partitions {
			if p.Index == f.Part {
				root = p.RootInode
			}
		}
	}
	trail, err := c.db.Trail(f, root, fmt.Sprintf("Partition %d", f.Part))
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, map[string]any{"file": f, "trail": trail})
}

func (s *Server) startContent(w http.ResponseWriter, r *http.Request) {
	c := s.current(w)
	if c == nil {
		return
	}
	var req struct {
		Q        string `json:"q"`
		Evidence string `json:"evidence"`
		MaxSize  int64  `json:"maxSize"`
		Deleted  bool   `json:"deleted"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len([]rune(strings.TrimSpace(req.Q))) < 2 {
		writeErr(w, http.StatusBadRequest, errors.New("search text must be at least 2 characters"))
		return
	}
	if req.MaxSize <= 0 {
		req.MaxSize = 64 << 20
	}
	s.mu.Lock()
	var evs []*Evidence
	for id, ev := range c.evidence {
		if req.Evidence == "" || req.Evidence == id {
			if st := ev.indexStatus().State; st == "done" || st == "partial" {
				evs = append(evs, ev)
			}
		}
	}
	s.mu.Unlock()
	if len(evs) == 0 {
		writeErr(w, http.StatusConflict, errors.New("build the file index for this evidence first"))
		return
	}
	q := strings.TrimSpace(req.Q)
	if err := c.content.start(q); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	c.db.Audit("Content search", q)
	c.wg.Add(1)
	go s.runContentSearch(c, evs, q, req.MaxSize, req.Deleted)
	writeJSON(w, c.content.snapshot())
}

func (s *Server) getContent(w http.ResponseWriter, _ *http.Request) {
	if c := s.current(w); c != nil {
		writeJSON(w, c.content.snapshot())
	}
}

func (s *Server) cancelContent(w http.ResponseWriter, _ *http.Request) {
	if c := s.current(w); c != nil {
		c.content.cancel.Store(true)
		writeJSON(w, c.content.snapshot())
	}
}

// ---------------- helpers ----------------

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}
