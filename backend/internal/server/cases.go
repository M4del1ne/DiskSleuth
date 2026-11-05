package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"forensics/internal/casedb"
)

// Cases live in <cases root>\<number> by default, or in any folder the examiner chooses. Cases outside the
// root are remembered in <cases root>\registry.json so the start page can list them.

var registryMu sync.Mutex

func (s *Server) registryPath() string { return filepath.Join(s.cfg.CasesDir, "registry.json") }

func (s *Server) loadRegistry() []string {
	var r struct{ Cases []string }
	if b, err := os.ReadFile(s.registryPath()); err == nil {
		json.Unmarshal(b, &r)
	}
	return r.Cases
}

func (s *Server) saveRegistry(dirs []string) {
	if dirs == nil {
		dirs = []string{}
	}
	os.MkdirAll(s.cfg.CasesDir, 0o755)
	b, _ := json.MarshalIndent(map[string][]string{"cases": dirs}, "", "  ")
	if err := os.WriteFile(s.registryPath(), b, 0o644); err != nil {
		log.Printf("cannot save case registry: %v", err)
	}
}

func samePath(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }

// inRoot reports whether dir is a direct subfolder of the cases root.
func (s *Server) inRoot(dir string) bool { return samePath(filepath.Dir(dir), s.cfg.CasesDir) }

// remember adds a case folder outside the root to the registry.
func (s *Server) remember(dir string) {
	if s.inRoot(dir) {
		return
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	dirs := s.loadRegistry()
	for _, d := range dirs {
		if samePath(d, dir) {
			return
		}
	}
	s.saveRegistry(append(dirs, filepath.Clean(dir)))
}

func (s *Server) forget(dir string) {
	registryMu.Lock()
	defer registryMu.Unlock()
	var keep []string
	for _, d := range s.loadRegistry() {
		if !samePath(d, dir) {
			keep = append(keep, d)
		}
	}
	s.saveRegistry(keep)
}

// knownCase reports whether dir is a case this backend lists (root subfolder or registered) and has a case.db.
func (s *Server) knownCase(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "case.db")); err != nil {
		return false
	}
	if s.inRoot(dir) {
		return true
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	for _, d := range s.loadRegistry() {
		if samePath(d, dir) {
			return true
		}
	}
	return false
}

func (s *Server) listCases(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	curDir := ""
	if s.cur != nil {
		curDir = s.cur.db.Dir
	}
	s.mu.Unlock()

	var dirs []string
	entries, _ := os.ReadDir(s.cfg.CasesDir)
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, filepath.Join(s.cfg.CasesDir, e.Name()))
		}
	}
	registryMu.Lock()
	dirs = append(dirs, s.loadRegistry()...)
	registryMu.Unlock()

	out := []CaseSummary{}
	for _, dir := range dirs {
		info, n, err := casedb.ReadInfo(dir)
		if err != nil {
			continue // not a case folder, or a registered case that was moved away
		}
		out = append(out, CaseSummary{Info: info, EvidenceCount: n, Open: samePath(dir, curDir)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Info.CreatedAt > out[j].Info.CreatedAt })
	writeJSON(w, out)
}

func (s *Server) createCase(w http.ResponseWriter, r *http.Request) {
	var req struct{ Name, Number, Examiner, Notes, Location string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		req.Name = "Untitled case"
	}
	number := strings.TrimSpace(req.Number)
	if number == "" {
		number = "DS-" + time.Now().Format("20060102-150405")
	}
	if safeName(number) != number {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("the case number %q cannot be used as a folder name (avoid \\ / : * ? \" < > |)", number))
		return
	}
	location := strings.TrimSpace(req.Location)
	if location == "" {
		location = s.cfg.CasesDir
	}
	if !filepath.IsAbs(location) {
		writeErr(w, http.StatusBadRequest, errors.New("the save location must be an absolute folder path"))
		return
	}
	dir := filepath.Join(filepath.Clean(location), number)
	if _, err := os.Stat(dir); err == nil {
		writeErr(w, http.StatusConflict, fmt.Errorf("a folder named %s already exists in %s; choose another case number", number, location))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeCurrent()
	db, err := casedb.Create(dir, casedb.Info{Number: number, Name: req.Name, Examiner: strings.TrimSpace(req.Examiner), Notes: req.Notes})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	c, err := s.activate(db)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	s.remember(dir)
	log.Printf("created case %s", dir)
	writeJSON(w, s.view(c))
}

// deleteCase removes a case: its database and work folder (exported hives, plugin scratch files).
// Evidence images and files exported elsewhere are never touched. Only files the case itself created are removed;
// anything else in the folder is left in place and reported.
func (s *Server) deleteCase(w http.ResponseWriter, r *http.Request) {
	var req struct{ Dir string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Dir) == "" {
		writeErr(w, http.StatusBadRequest, errors.New("missing case directory"))
		return
	}
	dir := filepath.Clean(req.Dir)
	if !s.knownCase(dir) {
		writeErr(w, http.StatusNotFound, fmt.Errorf("not a known case folder: %s", dir))
		return
	}
	s.mu.Lock()
	if s.cur != nil && samePath(s.cur.db.Dir, dir) {
		s.closeCurrent()
	}
	s.mu.Unlock()

	var problems []string
	for _, name := range []string{"case.db", "case.db-wal", "case.db-shm", "case.db-journal", "work"} {
		p := filepath.Join(dir, name)
		if _, err := os.Lstat(p); err != nil {
			continue
		}
		if err := os.RemoveAll(p); err != nil {
			problems = append(problems, err.Error())
		}
	}
	left := []string{}
	if rest, _ := os.ReadDir(dir); len(rest) == 0 {
		if err := os.Remove(dir); err != nil {
			problems = append(problems, err.Error())
		}
	} else {
		for _, e := range rest {
			left = append(left, e.Name())
		}
	}
	if len(problems) > 0 {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("the case could only be partly deleted: %s", strings.Join(problems, "; ")))
		return
	}
	s.forget(dir)
	log.Printf("deleted case %s (left in folder: %v)", dir, left)
	writeJSON(w, map[string]any{"deleted": dir, "left": left})
}
