package casedb

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Plugin runs and results. Tables use IF NOT EXISTS so older cases gain them when opened.
const pluginSchema = `
CREATE TABLE IF NOT EXISTS plugin_runs (
  evidence_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
  state TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT, log TEXT, rows INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (evidence_id, plugin_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY,
  evidence_id TEXT NOT NULL, plugin_id TEXT NOT NULL, table_id TEXT NOT NULL, row_json TEXT NOT NULL,
  staged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS artifacts_t ON artifacts(evidence_id, table_id);
CREATE TABLE IF NOT EXISTS summary (
  evidence_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, plugin_id TEXT,
  PRIMARY KEY (evidence_id, key)
);
`

type PluginRun struct {
	PluginID   string `json:"pluginId"`
	Version    string `json:"version,omitempty"`
	State      string `json:"state"` // running | done | error | skipped | cancelled
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt"`
	Error      string `json:"error,omitempty"`
	Log        string `json:"log,omitempty"`
	Rows       int64  `json:"rows"`
}

// migratePlugins adds missing columns to older case databases and cleans up runs left "running" by a backend crash.
func migratePlugins(db *sql.DB) error {
	for table, cols := range map[string][]string{
		"artifacts":   {"staged INTEGER NOT NULL DEFAULT 0"},
		"plugin_runs": {"version TEXT"},
	} {
		have := map[string]bool{}
		rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
		if err != nil {
			return err
		}
		for rows.Next() {
			var n string
			rows.Scan(&n)
			have[n] = true
		}
		rows.Close()
		for _, c := range cols {
			if !have[strings.Fields(c)[0]] {
				if _, err := db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + c); err != nil {
					return err
				}
			}
		}
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS artifacts_p ON artifacts(evidence_id, plugin_id, staged)`); err != nil {
		return err
	}
	if _, err := db.Exec(`DELETE FROM artifacts WHERE staged = 1`); err != nil {
		return err
	}
	_, err := db.Exec(`UPDATE plugin_runs SET state='error', error='Interrupted (backend exited); previous successful results kept', finished_at=? WHERE state='running'`, now())
	return err
}

// BeginPluginRun records that a plugin started. Results of the last successful run stay until this run commits; new rows are staged (staged=1).
func (d *DB) BeginPluginRun(ev, plugin, version string) error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM artifacts WHERE evidence_id = ? AND plugin_id = ? AND staged = 1`, ev, plugin); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO plugin_runs(evidence_id, plugin_id, version, state, started_at, finished_at, error, log, rows)
		VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL, 0)
		ON CONFLICT(evidence_id, plugin_id) DO UPDATE SET version=excluded.version, state='running', started_at=excluded.started_at,
		finished_at=NULL, error=NULL, log=NULL, rows=0`,
		ev, plugin, nullable(version), now()); err != nil {
		return err
	}
	return tx.Commit()
}

// RunResult is the outcome of one plugin run.
type RunResult struct {
	State   string // done | error | skipped | cancelled
	Error   string
	Log     string
	Rows    int64
	Summary map[string]string // written only when State is done
}

// FinishPluginRun ends a run: on done the staged rows replace the old results and the summary is written; any other outcome drops the staged rows and keeps the old results.
func (d *DB) FinishPluginRun(ev, plugin string, r RunResult) error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var stmts []string
	if r.State == "done" {
		stmts = []string{
			`DELETE FROM artifacts WHERE evidence_id = ? AND plugin_id = ? AND staged = 0`,
			`UPDATE artifacts SET staged = 0 WHERE evidence_id = ? AND plugin_id = ? AND staged = 1`,
			`DELETE FROM summary WHERE evidence_id = ? AND plugin_id = ?`,
		}
	} else {
		stmts = []string{`DELETE FROM artifacts WHERE evidence_id = ? AND plugin_id = ? AND staged = 1`}
	}
	for _, q := range stmts {
		if _, err := tx.Exec(q, ev, plugin); err != nil {
			return err
		}
	}
	if r.State == "done" {
		for k, v := range r.Summary {
			if _, err := tx.Exec(`INSERT INTO summary(evidence_id, key, value, plugin_id) VALUES (?, ?, ?, ?)
				ON CONFLICT(evidence_id, key) DO UPDATE SET value=excluded.value, plugin_id=excluded.plugin_id`, ev, k, v, plugin); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(`UPDATE plugin_runs SET state=?, finished_at=?, error=?, log=?, rows=? WHERE evidence_id=? AND plugin_id=?`,
		r.State, now(), nullable(r.Error), nullable(r.Log), r.Rows, ev, plugin); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	detail := fmt.Sprintf("%s %s: %s, %d rows", ev, plugin, r.State, r.Rows)
	if r.Error != "" {
		detail += "；" + r.Error
	}
	d.Audit("Run plugin", detail)
	return nil
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (d *DB) PluginRuns(ev string) ([]PluginRun, error) {
	rows, err := d.sql.Query(`SELECT plugin_id, COALESCE(version,''), state, COALESCE(started_at,''), COALESCE(finished_at,''), COALESCE(error,''), COALESCE(log,''), rows
		FROM plugin_runs WHERE evidence_id = ?`, ev)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PluginRun{}
	for rows.Next() {
		var r PluginRun
		if err := rows.Scan(&r.PluginID, &r.Version, &r.State, &r.StartedAt, &r.FinishedAt, &r.Error, &r.Log, &r.Rows); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AddArtifacts stages a batch of result rows (one JSON object each); they take effect when FinishPluginRun succeeds.
func (d *DB) AddArtifacts(ev, plugin, table string, rows []json.RawMessage) error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT INTO artifacts(evidence_id, plugin_id, table_id, row_json, staged) VALUES (?, ?, ?, ?, 1)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, r := range rows {
		if _, err := stmt.Exec(ev, plugin, table, string(r)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Artifacts returns all committed rows of a result table, in insertion order.
func (d *DB) Artifacts(ev, table string, limit int) ([]json.RawMessage, error) {
	if limit <= 0 {
		limit = 100000
	}
	rows, err := d.sql.Query(`SELECT row_json FROM artifacts WHERE evidence_id = ? AND table_id = ? AND staged = 0 ORDER BY id LIMIT ?`, ev, table, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var s string
		rows.Scan(&s)
		out = append(out, json.RawMessage(s))
	}
	return out, rows.Err()
}

// ArtifactCounts returns the committed row count per result table.
func (d *DB) ArtifactCounts(ev string) (map[string]int64, error) {
	rows, err := d.sql.Query(`SELECT table_id, COUNT(*) FROM artifacts WHERE evidence_id = ? AND staged = 0 GROUP BY table_id`, ev)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var t string
		var n int64
		rows.Scan(&t, &n)
		out[t] = n
	}
	return out, rows.Err()
}

func (d *DB) SetSummary(ev, plugin, key, value string) error {
	_, err := d.sql.Exec(`INSERT INTO summary(evidence_id, key, value, plugin_id) VALUES (?, ?, ?, ?)
		ON CONFLICT(evidence_id, key) DO UPDATE SET value=excluded.value, plugin_id=excluded.plugin_id`, ev, key, value, plugin)
	return err
}

func (d *DB) Summary(ev string) (map[string]string, error) {
	rows, err := d.sql.Query(`SELECT key, COALESCE(value,'') FROM summary WHERE evidence_id = ?`, ev)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		rows.Scan(&k, &v)
		out[k] = v
	}
	return out, rows.Err()
}

// ---------------- File lookup for plugins ----------------

type FindQuery struct {
	Ext       string // extension without the dot
	Name      string // SQL LIKE pattern
	Path      string // SQL LIKE pattern
	Deleted   bool
	Limit     int
	Offset    int
	FilesOnly bool
}

// Find looks up files in the index by extension / name / path pattern (used by plugins).
func (d *DB) Find(ev string, q FindQuery) ([]FileRow, error) {
	if q.Ext == "" && q.Name == "" && q.Path == "" {
		return nil, errors.New("specify at least one of ext, name, path")
	}
	where := []string{"evidence_id = ?"}
	args := []any{ev}
	if q.Ext != "" {
		where = append(where, "ext = ?")
		args = append(args, strings.ToLower(strings.TrimPrefix(q.Ext, ".")))
	}
	if q.Name != "" {
		where = append(where, "name LIKE ?")
		args = append(args, q.Name)
	}
	if q.Path != "" {
		where = append(where, "path LIKE ?")
		args = append(args, q.Path)
	}
	if !q.Deleted {
		where = append(where, "deleted = 0")
	}
	if q.FilesOnly {
		where = append(where, "is_dir = 0")
	}
	if q.Limit <= 0 || q.Limit > 200000 {
		q.Limit = 20000
	}
	rows, err := d.sql.Query(`SELECT `+fileCols+` FROM files WHERE `+strings.Join(where, " AND ")+` ORDER BY part, path, inode LIMIT ? OFFSET ?`, append(args, q.Limit, max(0, q.Offset))...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FileRow{}
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

var _ = sql.ErrNoRows
