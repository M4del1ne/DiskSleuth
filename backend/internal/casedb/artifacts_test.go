package casedb

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// Plugin results are staged and replace old results only on success; failed/stopped runs keep the old results; an interrupted run is cleaned up when the case is reopened.
func TestPluginRunStaging(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "case")
	db, err := Create(dir, Info{Number: "T-2", Name: "Plugins"})
	if err != nil {
		t.Fatal(err)
	}
	rows := func(vals ...string) []json.RawMessage {
		out := make([]json.RawMessage, len(vals))
		for i, v := range vals {
			out[i] = json.RawMessage(`{"v":"` + v + `"}`)
		}
		return out
	}
	count := func() int {
		t.Helper()
		r, err := db.Artifacts("ev", "tbl", 0)
		if err != nil {
			t.Fatal(err)
		}
		return len(r)
	}
	run := func(state string, vals ...string) {
		t.Helper()
		if err := db.BeginPluginRun("ev", "p", "1.0"); err != nil {
			t.Fatal(err)
		}
		if err := db.AddArtifacts("ev", "p", "tbl", rows(vals...)); err != nil {
			t.Fatal(err)
		}
		if n := count(); state == "first" && n != 0 {
			t.Fatalf("staged rows must not be visible, got %d", n)
		}
		if state == "first" {
			state = "done"
		}
		if err := db.FinishPluginRun("ev", "p", RunResult{State: state, Rows: int64(len(vals)), Summary: map[string]string{"hostname": "H-" + state}}); err != nil {
			t.Fatal(err)
		}
	}

	run("first", "a", "b")
	if n := count(); n != 2 {
		t.Fatalf("want 2 rows after success, got %d", n)
	}
	run("error", "x")
	if n := count(); n != 2 {
		t.Fatalf("a failed run must keep the old 2 rows, got %d", n)
	}
	run("cancelled", "y", "z", "w")
	if n := count(); n != 2 {
		t.Fatalf("a stopped run must keep the old 2 rows, got %d", n)
	}
	if s, _ := db.Summary("ev"); s["hostname"] != "H-done" {
		t.Fatalf("a failed run must not change the summary: %v", s)
	}
	run("done", "c")
	if n := count(); n != 1 {
		t.Fatalf("a second success must replace the rows with 1, got %d", n)
	}
	runs, _ := db.PluginRuns("ev")
	if len(runs) != 1 || runs[0].State != "done" || runs[0].Version != "1.0" {
		t.Fatalf("unexpected run records: %+v", runs)
	}

	// simulate the backend exiting mid-run: after reopening, staged rows are gone, the state is error and the old results remain
	db.BeginPluginRun("ev", "p", "1.1")
	db.AddArtifacts("ev", "p", "tbl", rows("half"))
	db.Close()
	db, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if n := count(); n != 1 {
		t.Fatalf("want 1 row kept after interruption, got %d", n)
	}
	runs, _ = db.PluginRuns("ev")
	if runs[0].State != "error" {
		t.Fatalf("an interrupted run must be marked error: %+v", runs[0])
	}
	if c, _ := db.ArtifactCounts("ev"); c["tbl"] != 1 {
		t.Fatalf("unexpected counts: %v", c)
	}
}
