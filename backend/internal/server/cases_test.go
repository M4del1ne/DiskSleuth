package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func call(t *testing.T, s *Server, method, path, body string) (int, map[string]any, []any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	var obj map[string]any
	var arr []any
	if json.Unmarshal(rec.Body.Bytes(), &obj) != nil {
		json.Unmarshal(rec.Body.Bytes(), &arr)
	}
	return rec.Code, obj, arr
}

// Create with a custom number and location, list it through the registry, refuse a duplicate number,
// delete it while open, and keep files in the case folder that the case did not create.
func TestCaseCreateListDelete(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cases")
	elsewhere := filepath.Join(t.TempDir(), "外部位置")
	s := New(Config{Token: "tok", CasesDir: root})
	defer s.Close()

	body, _ := json.Marshal(map[string]string{"name": "Laptop", "number": "2026-017", "examiner": "E1", "location": elsewhere})
	code, obj, _ := call(t, s, "POST", "/api/cases", string(body))
	if code != 200 {
		t.Fatalf("create: %d %v", code, obj)
	}
	dir := filepath.Join(elsewhere, "2026-017")
	if _, err := os.Stat(filepath.Join(dir, "case.db")); err != nil {
		t.Fatalf("case.db not created in the chosen location: %v", err)
	}
	if code, _, _ = call(t, s, "POST", "/api/cases", string(body)); code != http.StatusConflict {
		t.Fatalf("duplicate number should be refused, got %d", code)
	}
	bad, _ := json.Marshal(map[string]string{"name": "x", "number": "a/b"})
	if code, _, _ = call(t, s, "POST", "/api/cases", string(bad)); code != http.StatusBadRequest {
		t.Fatalf("number with a slash should be refused, got %d", code)
	}
	call(t, s, "POST", "/api/cases", `{"name":"In root"}`) // default number and location

	_, _, list := call(t, s, "GET", "/api/cases", "")
	if len(list) != 2 {
		t.Fatalf("want 2 cases (root + registered), got %d: %v", len(list), list)
	}

	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("examiner notes"), 0o644)
	del, _ := json.Marshal(map[string]string{"dir": dir})
	code, obj, _ = call(t, s, "DELETE", "/api/cases", string(del))
	if code != 200 {
		t.Fatalf("delete: %d %v", code, obj)
	}
	if _, err := os.Stat(filepath.Join(dir, "case.db")); !os.IsNotExist(err) {
		t.Fatalf("case.db should be gone")
	}
	if _, err := os.Stat(filepath.Join(dir, "notes.txt")); err != nil {
		t.Fatalf("unrelated files must be kept: %v", err)
	}
	_, _, list = call(t, s, "GET", "/api/cases", "")
	if len(list) != 1 {
		t.Fatalf("want 1 case after delete, got %d", len(list))
	}
	unknown, _ := json.Marshal(map[string]string{"dir": t.TempDir()})
	if code, _, _ = call(t, s, "DELETE", "/api/cases", string(unknown)); code != http.StatusNotFound {
		t.Fatalf("deleting an unknown folder must be refused, got %d", code)
	}
}
