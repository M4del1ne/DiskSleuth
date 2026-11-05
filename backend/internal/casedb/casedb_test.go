package casedb

import (
	"path/filepath"
	"testing"
)

// Covers: creating a case in a non-ASCII directory, writing the index, FTS5 trigram CJK substring search, short keywords, regex, trail back to the root, listing cases read-only.
func TestIndexAndSearch(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "测试案件") // non-ASCII path on purpose
	db, err := Create(dir, Info{Number: "T-1", Name: "Test"})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.AddEvidence("ev1", `D:\x.E01`, "{}"); err != nil {
		t.Fatal(err)
	}
	w, err := db.BeginIndex("ev1")
	if err != nil {
		t.Fatal(err)
	}
	rows := []FileRow{
		{Part: 2, Inode: 512, ParentInode: 5, Name: "Users", Path: `\Users`, IsDir: true},
		{Part: 2, Inode: 549, ParentInode: 512, Name: "poiuy", Path: `\Users\poiuy`, IsDir: true},
		{Part: 2, Inode: 600, ParentInode: 549, Name: "Desktop", Path: `\Users\poiuy\Desktop`, IsDir: true},
		{Part: 2, Inode: 63414, ParentInode: 600, Name: "夜神模拟器.lnk", Path: `\Users\poiuy\Desktop\夜神模拟器.lnk`, Ext: "lnk", Size: 963},
		{Part: 2, Inode: 70000, ParentInode: 600, Name: "密码.txt", Path: `\Users\poiuy\Desktop\密码.txt`, Ext: "txt", Size: 10, Deleted: true},
	}
	for _, r := range rows {
		if err := w.Add(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Finish(true); err != nil {
		t.Fatal(err)
	}
	check := func(name string, q SearchQuery, want int) []FileRow {
		t.Helper()
		q.EvidenceID = "ev1"
		got, _, err := db.Search(q)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(got) != want {
			t.Fatalf("%s: want %d rows, got %d %+v", name, want, len(got), got)
		}
		return got
	}
	check("CJK 3 chars (FTS)", SearchQuery{Q: "模拟器"}, 1)
	check("ASCII case-insensitive (FTS)", SearchQuery{Q: "POIUY"}, 1)
	check("2 chars (LIKE), deleted excluded by default", SearchQuery{Q: "密码"}, 0)
	check("2 chars incl. deleted", SearchQuery{Q: "密码", Deleted: true}, 1)
	check("path + files only", SearchQuery{Q: "poiuy", InPath: true, Kind: "file", Deleted: true}, 2)
	check("regex", SearchQuery{Q: `\.lnk$`, Regex: true}, 1)
	f := check("locate", SearchQuery{Q: "夜神"}, 1)[0]
	trail, err := db.Trail(f, 5, "Partition 2")
	if err != nil {
		t.Fatal(err)
	}
	if len(trail) != 4 || trail[0].Name != "Partition 2" || trail[3].Name != "Desktop" {
		t.Fatalf("trail = %+v", trail)
	}
	if state, _, n := db.IndexState("ev1"); state != "done" || n != 5 {
		t.Fatalf("index state = %s %d", state, n)
	}
	if info, n, err := ReadInfo(dir); err != nil || info.Number != "T-1" || n != 1 {
		t.Fatalf("ReadInfo = %+v %d %v", info, n, err)
	}
}
