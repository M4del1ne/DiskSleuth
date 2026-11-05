package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSafeName(t *testing.T) {
	cases := map[string]string{
		"report.docx":              "report.docx",
		"新建文本文档.txt":               "新建文本文档.txt",
		`a:b*c?.txt`:               "a_b_c_.txt",
		"$Extend":                  "$Extend",
		"file.txt:Zone.Identifier": "file.txt_Zone.Identifier",
		"trailing. ":               "trailing",
		"CON":                      "_CON",
		"nul.txt":                  "_nul.txt",
		"..":                       "_",
		"":                         "_",
	}
	for in, want := range cases {
		if got := safeName(in); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUniquePath(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), nil, 0o644)
	taken := map[string]bool{}
	if got := uniquePath(dir, "a.txt", taken); got != filepath.Join(dir, "a (2).txt") {
		t.Fatalf("existing file: got %s", got)
	}
	// the plan reserves names before files exist; names differing only in case collide on Windows
	if got := uniquePath(dir, "A (2).TXT", taken); got != filepath.Join(dir, "A (2) (2).TXT") {
		t.Fatalf("reserved name: got %s", got)
	}
	if got := uniquePath(dir, "b", taken); got != filepath.Join(dir, "b") {
		t.Fatalf("free name: got %s", got)
	}
}
