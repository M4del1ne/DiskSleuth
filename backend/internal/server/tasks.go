package server

import (
	"net/http"
	"sort"
	"strconv"
)

// Task is one background job of the open case, for the task list in the title bar.
// Running plugin, index and hash jobs are listed while they run; the last export and content search stay
// listed with their final state (the front end lets the user dismiss them).
type Task struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"` // plugins | index | hash | content | export
	EvidenceID   string  `json:"evidenceId,omitempty"`
	EvidenceName string  `json:"evidenceName,omitempty"`
	State        string  `json:"state"`    // running | stopping | done | cancelled | error
	Progress     float64 `json:"progress"` // 0..1, -1 when unknown
	Current      string  `json:"current,omitempty"`
	Message      string  `json:"message,omitempty"`
	Done         int64   `json:"done"`
	Total        int64   `json:"total"`
	Queue        int     `json:"queue"`
	Error        string  `json:"error,omitempty"`
	Started      string  `json:"started,omitempty"` // distinguishes runs of the same job
	CanStop      bool    `json:"canStop"`
}

func (s *Server) listTasks(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	c := s.cur
	s.mu.Unlock()
	tasks := []Task{}
	if c == nil {
		writeJSON(w, tasks)
		return
	}
	s.mu.Lock()
	evs := make([]*Evidence, 0, len(c.evidence))
	for _, ev := range c.evidence {
		evs = append(evs, ev)
	}
	s.mu.Unlock()
	sort.Slice(evs, func(i, j int) bool { return evs[i].Info.Name < evs[j].Info.Name })

	for _, ev := range evs {
		ev.plug.mu.Lock()
		if ev.plug.running {
			state := "running"
			if ev.plug.stopping {
				state = "stopping"
			}
			tasks = append(tasks, Task{ID: "plugins:" + ev.Info.ID, Kind: "plugins", EvidenceID: ev.Info.ID, EvidenceName: ev.Info.Name,
				State: state, Progress: ev.plug.progress, Current: ev.plug.current, Message: ev.plug.message,
				Queue: len(ev.plug.queue), CanStop: !ev.plug.stopping})
		}
		ev.plug.mu.Unlock()

		if st := ev.indexStatus(); st.State == "running" {
			tasks = append(tasks, Task{ID: "index:" + ev.Info.ID, Kind: "index", EvidenceID: ev.Info.ID, EvidenceName: ev.Info.Name,
				State: "running", Progress: -1, Done: st.Files, Total: st.Dirs, CanStop: true})
		}
		if st := ev.hashStatus(); st.State == "running" {
			tasks = append(tasks, Task{ID: "hash:" + ev.Info.ID, Kind: "hash", EvidenceID: ev.Info.ID, EvidenceName: ev.Info.Name,
				State: "running", Progress: st.Progress, Done: st.Done, Total: st.Total, Started: st.StartedAt})
		}
	}

	if st := c.content.snapshot(); st.State != "idle" {
		c.content.mu.Lock()
		started := c.content.started.Format("2006-01-02T15:04:05.000")
		c.content.mu.Unlock()
		p := -1.0
		if st.Total > 0 {
			p = float64(st.Scanned) / float64(st.Total)
		}
		tasks = append(tasks, Task{ID: "content", Kind: "content", State: st.State, Progress: p, Current: st.Query,
			Done: st.Scanned, Total: st.Total, Message: strconv.Itoa(len(st.Hits)), Error: st.Error, Started: started,
			CanStop: st.State == "running"})
	}
	if st := c.export.snapshot(); st.State != "idle" {
		c.export.mu.Lock()
		started := c.export.started.Format("2006-01-02T15:04:05.000")
		c.export.mu.Unlock()
		p := -1.0
		if st.TotalBytes > 0 {
			p = float64(st.Bytes) / float64(st.TotalBytes)
		} else if st.State != "running" {
			p = 1
		}
		tasks = append(tasks, Task{ID: "export", Kind: "export", EvidenceName: st.Evidence, State: st.State, Progress: p,
			Current: st.Current, Message: st.Dest, Done: st.Done, Total: st.Files, Error: st.Error, Started: started,
			Queue: st.Failed + st.Partial, CanStop: st.State == "running"})
	}
	writeJSON(w, tasks)
}

func (s *Server) cancelIndex(w http.ResponseWriter, r *http.Request) {
	if _, ev := s.ev(w, r); ev != nil {
		ev.index.cancel.Store(true)
		writeJSON(w, ev.indexStatus())
	}
}
