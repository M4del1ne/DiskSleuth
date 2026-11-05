// Package casedb is the case database: one directory per case containing case.db (SQLite, WAL mode).
//
// Tables:
//
//	case_info  case details (single row)
//	evidence   evidence items (path + full info JSON captured when opened)
//	hashes     whole-disk hash results
//	analysis   legacy analysis cache (raw JSON per evidence + plugin)
//	files      full file index (deleted entries included); files_fts is its FTS5 trigram index
//	audit      audit log: time and details of every significant action in the case
package casedb

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

const schemaVersion = 1

const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS case_info (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  number TEXT NOT NULL, name TEXT NOT NULL, examiner TEXT, notes TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at TEXT NOT NULL, info_json TEXT NOT NULL,
  index_state TEXT NOT NULL DEFAULT 'none', indexed_at TEXT, file_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hashes (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence(id) ON DELETE CASCADE,
  md5 TEXT, sha1 TEXT, sha256 TEXT, seconds REAL, computed_at TEXT
);
CREATE TABLE IF NOT EXISTS analysis (
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  plugin TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (evidence_id, plugin)
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  evidence_id TEXT NOT NULL, part INTEGER NOT NULL,
  inode INTEGER NOT NULL, parent_inode INTEGER NOT NULL,
  name TEXT NOT NULL, path TEXT NOT NULL, ext TEXT NOT NULL DEFAULT '',
  is_dir INTEGER NOT NULL, size INTEGER NOT NULL, deleted INTEGER NOT NULL,
  crtime INTEGER, mtime INTEGER, atime INTEGER, ctime INTEGER
);
CREATE INDEX IF NOT EXISTS files_ev ON files(evidence_id, part, inode);
CREATE INDEX IF NOT EXISTS files_ext ON files(evidence_id, ext);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(name, path, content='files', content_rowid='id', tokenize='trigram');
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
);
`

// Info holds the case details.
type Info struct {
	Number    string `json:"number"`
	Name      string `json:"name"`
	Examiner  string `json:"examiner"`
	Notes     string `json:"notes"`
	CreatedAt string `json:"createdAt"`
	Dir       string `json:"dir"`
}

type DB struct {
	sql *sql.DB
	Dir string
}

const fileName = "case.db"

func now() string { return time.Now().Format("2006-01-02 15:04:05") }

func openSQL(path string) (*sql.DB, error) {
	dsn := path + "?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema + pluginSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize case database: %w", err)
	}
	if err := migratePlugins(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("upgrade case database: %w", err)
	}
	return db, nil
}

// Create makes a new case database under dir. It fails if dir already has a case.db.
func Create(dir string, info Info) (*DB, error) {
	if err := os.MkdirAll(filepath.Join(dir, "work"), 0o755); err != nil {
		return nil, err
	}
	p := filepath.Join(dir, fileName)
	if _, err := os.Stat(p); err == nil {
		return nil, fmt.Errorf("case already exists: %s", dir)
	}
	s, err := openSQL(p)
	if err != nil {
		return nil, err
	}
	if info.CreatedAt == "" {
		info.CreatedAt = now()
	}
	if _, err := s.Exec(`INSERT INTO case_info(id, number, name, examiner, notes, created_at) VALUES (1, ?, ?, ?, ?, ?)`,
		info.Number, info.Name, info.Examiner, info.Notes, info.CreatedAt); err != nil {
		s.Close()
		return nil, err
	}
	s.Exec(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`, schemaVersion)
	d := &DB{sql: s, Dir: dir}
	d.Audit("Case created", fmt.Sprintf("%s %s", info.Number, info.Name))
	return d, nil
}

// Open opens an existing case database.
func Open(dir string) (*DB, error) {
	p := filepath.Join(dir, fileName)
	if _, err := os.Stat(p); err != nil {
		return nil, fmt.Errorf("not a case directory (missing %s): %s", fileName, dir)
	}
	s, err := openSQL(p)
	if err != nil {
		return nil, err
	}
	d := &DB{sql: s, Dir: dir}
	d.Audit("Case opened", "")
	return d, nil
}

func (d *DB) Close() error {
	d.Audit("Case closed", "")
	return d.sql.Close()
}

// WorkDir is the case's scratch directory (exported hives, plugin work files, ...).
func (d *DB) WorkDir() string { return filepath.Join(d.Dir, "work") }

func (d *DB) Info() (Info, error) {
	var i Info
	err := d.sql.QueryRow(`SELECT number, name, COALESCE(examiner,''), COALESCE(notes,''), created_at FROM case_info WHERE id = 1`).
		Scan(&i.Number, &i.Name, &i.Examiner, &i.Notes, &i.CreatedAt)
	i.Dir = d.Dir
	return i, err
}

// ReadInfo reads only the case details (used when listing cases; writes no audit entry).
func ReadInfo(dir string) (Info, int, error) {
	s, err := sql.Open("sqlite", filepath.Join(dir, fileName)+"?mode=ro&_pragma=busy_timeout(3000)")
	if err != nil {
		return Info{}, 0, err
	}
	defer s.Close()
	var i Info
	if err := s.QueryRow(`SELECT number, name, COALESCE(examiner,''), COALESCE(notes,''), created_at FROM case_info WHERE id = 1`).
		Scan(&i.Number, &i.Name, &i.Examiner, &i.Notes, &i.CreatedAt); err != nil {
		return Info{}, 0, err
	}
	i.Dir = dir
	var n int
	s.QueryRow(`SELECT COUNT(*) FROM evidence`).Scan(&n)
	return i, n, nil
}

// ---------------- Audit ----------------

func (d *DB) Audit(action, detail string) {
	d.sql.Exec(`INSERT INTO audit(ts, action, detail) VALUES (?, ?, ?)`, now(), action, detail)
}

type AuditEntry struct {
	Time   string `json:"time"`
	Action string `json:"action"`
	Detail string `json:"detail"`
}

func (d *DB) AuditLog(limit int) ([]AuditEntry, error) {
	rows, err := d.sql.Query(`SELECT ts, action, COALESCE(detail,'') FROM audit ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var a AuditEntry
		rows.Scan(&a.Time, &a.Action, &a.Detail)
		out = append(out, a)
	}
	return out, rows.Err()
}

// ---------------- Evidence ----------------

type EvidenceRow struct {
	ID         string
	Path       string
	AddedAt    string
	InfoJSON   string
	IndexState string
	IndexedAt  string
	FileCount  int64
}

func (d *DB) AddEvidence(id, path, infoJSON string) error {
	_, err := d.sql.Exec(`INSERT INTO evidence(id, path, added_at, info_json) VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET info_json = excluded.info_json`, id, path, now(), infoJSON)
	if err == nil {
		d.Audit("Evidence added", path)
	}
	return err
}

func (d *DB) ListEvidence() ([]EvidenceRow, error) {
	rows, err := d.sql.Query(`SELECT id, path, added_at, info_json, index_state, COALESCE(indexed_at,''), file_count FROM evidence ORDER BY added_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EvidenceRow
	for rows.Next() {
		var r EvidenceRow
		if err := rows.Scan(&r.ID, &r.Path, &r.AddedAt, &r.InfoJSON, &r.IndexState, &r.IndexedAt, &r.FileCount); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (d *DB) IndexState(id string) (state, at string, count int64) {
	d.sql.QueryRow(`SELECT index_state, COALESCE(indexed_at,''), file_count FROM evidence WHERE id = ?`, id).Scan(&state, &at, &count)
	return
}

// ---------------- Hashes / analysis ----------------

type Hash struct {
	MD5, SHA1, SHA256 string
	Seconds           float64
	ComputedAt        string
}

func (d *DB) SaveHash(id string, h Hash) error {
	_, err := d.sql.Exec(`INSERT INTO hashes(evidence_id, md5, sha1, sha256, seconds, computed_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(evidence_id) DO UPDATE SET md5=excluded.md5, sha1=excluded.sha1, sha256=excluded.sha256, seconds=excluded.seconds, computed_at=excluded.computed_at`,
		id, h.MD5, h.SHA1, h.SHA256, h.Seconds, now())
	if err == nil {
		d.Audit("Disk hashed", fmt.Sprintf("%s MD5=%s SHA1=%s SHA256=%s", id, h.MD5, h.SHA1, h.SHA256))
	}
	return err
}

func (d *DB) LoadHash(id string) (*Hash, error) {
	var h Hash
	err := d.sql.QueryRow(`SELECT md5, sha1, sha256, seconds, computed_at FROM hashes WHERE evidence_id = ?`, id).
		Scan(&h.MD5, &h.SHA1, &h.SHA256, &h.Seconds, &h.ComputedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &h, err
}

func (d *DB) SaveAnalysis(id, plugin string, result []byte) error {
	_, err := d.sql.Exec(`INSERT INTO analysis(evidence_id, plugin, result_json, created_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(evidence_id, plugin) DO UPDATE SET result_json=excluded.result_json, created_at=excluded.created_at`,
		id, plugin, string(result), now())
	if err == nil {
		d.Audit("Run plugin", fmt.Sprintf("%s %s", id, plugin))
	}
	return err
}

func (d *DB) LoadAnalysis(id, plugin string) ([]byte, error) {
	var s string
	err := d.sql.QueryRow(`SELECT result_json FROM analysis WHERE evidence_id = ? AND plugin = ?`, id, plugin).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return []byte(s), err
}
