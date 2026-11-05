package server

import (
	"fmt"
	"log"
	"path"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"forensics/internal/casedb"
)

// IndexStatus is the state of the full index job.
type IndexStatus struct {
	State     string  `json:"state"` // none | running | done | partial | error
	Dirs      int64   `json:"dirs"`
	Files     int64   `json:"files"`
	Errors    int64   `json:"errors"` // directories that could not be read (mostly stale entries of deleted directories)
	IndexedAt string  `json:"indexedAt,omitempty"`
	Seconds   float64 `json:"seconds,omitempty"`
	Error     string  `json:"error,omitempty"`
}

type indexJob struct {
	mu      sync.Mutex
	status  IndexStatus
	dirs    atomic.Int64
	files   atomic.Int64
	errs    atomic.Int64
	cancel  atomic.Bool
	started time.Time
}

func (ev *Evidence) indexStatus() IndexStatus {
	ev.index.mu.Lock()
	defer ev.index.mu.Unlock()
	s := ev.index.status
	if s.State == "" {
		state, at, n := ev.db.IndexState(ev.Info.ID)
		s = IndexStatus{State: state, IndexedAt: at, Files: n}
		if s.State == "running" { // the last run stopped half way
			s.State = "partial"
		}
	}
	if s.State == "running" {
		s.Dirs, s.Files, s.Errors = ev.index.dirs.Load(), ev.index.files.Load(), ev.index.errs.Load()
		s.Seconds = time.Since(ev.index.started).Seconds()
	}
	return s
}

// startIndex walks the directory tree of every partition in the background and writes the files table. wg lets closing the case wait for it.
func (ev *Evidence) startIndex(wg *sync.WaitGroup) IndexStatus {
	ev.index.mu.Lock()
	if ev.index.status.State == "running" {
		ev.index.mu.Unlock()
		return ev.indexStatus()
	}
	ev.index.status = IndexStatus{State: "running"}
	ev.index.dirs.Store(0)
	ev.index.files.Store(0)
	ev.index.errs.Store(0)
	ev.index.cancel.Store(false)
	ev.index.started = time.Now()
	ev.index.mu.Unlock()

	wg.Add(1)
	go func() {
		defer wg.Done()
		total, err := ev.walkAll()
		ev.index.mu.Lock()
		defer ev.index.mu.Unlock()
		st := IndexStatus{Dirs: ev.index.dirs.Load(), Files: total, Errors: ev.index.errs.Load(), Seconds: time.Since(ev.index.started).Seconds()}
		switch {
		case err != nil:
			st.State, st.Error = "error", err.Error()
		case ev.index.cancel.Load():
			st.State = "partial"
		default:
			st.State = "done"
		}
		_, st.IndexedAt, _ = ev.db.IndexState(ev.Info.ID)
		ev.index.status = st
		log.Printf("index %s: %s, %d entries, %d directories, %.1fs", ev.Info.ID, st.State, st.Files, st.Dirs, st.Seconds)
	}()
	return ev.indexStatus()
}

func (ev *Evidence) walkAll() (int64, error) {
	w, err := ev.db.BeginIndex(ev.Info.ID)
	if err != nil {
		return 0, err
	}
	var walkErr error
	for _, p := range ev.Info.Partitions {
		if _, ok := ev.fs[p.Index]; !ok {
			continue
		}
		if walkErr = ev.walkPartition(w, p); walkErr != nil || ev.index.cancel.Load() {
			break
		}
	}
	ok := walkErr == nil && !ev.index.cancel.Load()
	if err := w.Finish(ok); err != nil && walkErr == nil {
		walkErr = err
	}
	return w.Total, walkErr
}

// walkPartition walks a partition breadth-first. The TSK lock is held only while one directory is read, so browsing is never blocked for long.
func (ev *Evidence) walkPartition(w *casedb.IndexWriter, p PartitionInfo) error {
	type item struct {
		inode uint64
		path  string
		depth int
	}
	queue := []item{{inode: p.RootInode}}
	visited := map[uint64]bool{p.RootInode: true}
	for len(queue) > 0 {
		if ev.index.cancel.Load() {
			return nil
		}
		it := queue[0]
		queue = queue[1:]

		ev.mu.Lock()
		fs, ok := ev.fs[p.Index]
		if !ok {
			ev.mu.Unlock()
			return fmt.Errorf("partition %d is closed", p.Index)
		}
		entries, err := fs.ListDir(it.inode)
		ev.mu.Unlock()
		ev.index.dirs.Add(1)
		if err != nil {
			ev.index.errs.Add(1)
			continue
		}
		for _, e := range entries {
			fp := it.path + `\` + e.Name
			ext := ""
			if !e.IsDir {
				ext = strings.ToLower(strings.TrimPrefix(path.Ext(e.Name), "."))
			}
			if err := w.Add(casedb.FileRow{
				Part: p.Index, Inode: e.Inode, ParentInode: it.inode, Name: e.Name, Path: fp, Ext: ext,
				IsDir: e.IsDir, Size: e.Size, Deleted: e.Deleted,
				Created: e.Created, Modified: e.Modified, Accessed: e.Accessed, Changed: e.Changed,
			}); err != nil {
				return err
			}
			ev.index.files.Add(1)
			// inode 0 is $MFT itself; visited directories are skipped (hard links and stale entries can form loops)
			if e.IsDir && e.Inode != 0 && !visited[e.Inode] && it.depth < 96 {
				visited[e.Inode] = true
				queue = append(queue, item{inode: e.Inode, path: fp, depth: it.depth + 1})
			}
		}
	}
	return nil
}
