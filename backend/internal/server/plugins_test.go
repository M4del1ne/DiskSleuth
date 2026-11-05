package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writePlugin(t *testing.T, root, rel, manifest string) {
	t.Helper()
	dir := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o644)
	os.WriteFile(filepath.Join(dir, "main.py"), []byte("def run(ctx):\n    pass\n"), 0o644)
}

// Manifest validation: a valid plugin loads with defaults filled in; broken manifests are rejected with a reason; a duplicate table id disables the later plugin.
func TestLoadPluginsValidation(t *testing.T) {
	root := t.TempDir()
	ok := `{"id":"a.ok","name":"A","version":"1","outputs":[{"id":"tbl_a","name":"Table","group":"Group","columns":[{"key":"x","title":"X"}]}]}`
	writePlugin(t, root, "g/ok", ok)
	writePlugin(t, root, "g/zz_dup_table", `{"id":"b.dup","name":"B","version":"1","outputs":[{"id":"tbl_a","name":"Table","group":"Group","columns":[{"key":"x","title":"X"}]}]}`)
	writePlugin(t, root, "g/bad_json", `{"id":`)
	writePlugin(t, root, "g/bad_col", `{"id":"c.bad","name":"C","version":"1","outputs":[{"id":"t_c","name":"Table","group":"Group","columns":[{"key":"x","title":"X","kind":"weird"},{"key":"x","title":"Y"}]}]}`)
	writePlugin(t, root, "g/future", `{"id":"d.future","name":"D","version":"1","api":99,"outputs":[{"id":"t_d","name":"Table","group":"Group","columns":[{"key":"x","title":"X"}]}]}`)
	writePlugin(t, root, "g/no_entry", `{"id":"e.noentry","name":"E","version":"1","entry":"missing.py","outputs":[{"id":"t_e","name":"Table","group":"Group","columns":[{"key":"x","title":"X"}]}]}`)
	writePlugin(t, root, "g/bad_dep", `{"id":"f.dep","name":"F","version":"1","dependencies":["os; rm"],"outputs":[{"id":"t_f","name":"Table","group":"Group","columns":[{"key":"x","title":"X"}]}]}`)
	writePlugin(t, root, "_skip/x", `{"id":"skip"}`)

	s := &Server{cfg: Config{PluginsDir: root}}
	ms, problems := s.loadPlugins()
	if len(ms) != 1 || ms[0].ID != "a.ok" {
		t.Fatalf("only a.ok should load, got %+v", ms)
	}
	if ms[0].Entry != "main.py" || ms[0].Timeout != defaultPluginTimeout || ms[0].API != 1 {
		t.Fatalf("defaults were not filled in: %+v", ms[0])
	}
	all := strings.Join(problems, "\n")
	for _, want := range []string{"already used by g/ok", "not valid JSON", "kind \"weird\"", "duplicated", "API v99", "missing.py", "valid module name"} {
		if !strings.Contains(all, want) {
			t.Errorf("problems are missing %q:\n%s", want, all)
		}
	}
	if strings.Contains(all, "skip") {
		t.Errorf("directories starting with _ must be skipped")
	}
}
