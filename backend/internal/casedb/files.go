package casedb

import (
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

// FileRow is one file or directory in the index. Path is relative to the partition, e.g. \Users\poiuy\Desktop\a.lnk.
type FileRow struct {
	ID          int64  `json:"id"`
	EvidenceID  string `json:"evidenceId"`
	Part        int    `json:"part"`
	Inode       uint64 `json:"inode"`
	ParentInode uint64 `json:"parentInode"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Ext         string `json:"ext"`
	IsDir       bool   `json:"isDir"`
	Size        int64  `json:"size"`
	Deleted     bool   `json:"deleted"`
	Created     int64  `json:"created"`
	Modified    int64  `json:"modified"`
	Accessed    int64  `json:"accessed"`
	Changed     int64  `json:"changed"`
}

// ---------------- Index writing ----------------

// IndexWriter writes an evidence item's file index in batches (one transaction per 5000 rows).
type IndexWriter struct {
	db    *DB
	ev    string
	tx    *sql.Tx
	stmt  *sql.Stmt
	n     int
	Total int64
}

// BeginIndex clears the evidence item's old index and starts writing.
func (d *DB) BeginIndex(evidenceID string) (*IndexWriter, error) {
	if _, err := d.sql.Exec(`DELETE FROM files WHERE evidence_id = ?`, evidenceID); err != nil {
		return nil, err
	}
	d.sql.Exec(`UPDATE evidence SET index_state = 'running', file_count = 0 WHERE id = ?`, evidenceID)
	w := &IndexWriter{db: d, ev: evidenceID}
	return w, w.begin()
}

func (w *IndexWriter) begin() error {
	tx, err := w.db.sql.Begin()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO files(evidence_id, part, inode, parent_inode, name, path, ext, is_dir, size, deleted, crtime, mtime, atime, ctime)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	w.tx, w.stmt, w.n = tx, stmt, 0
	return nil
}

func (w *IndexWriter) Add(f FileRow) error {
	if _, err := w.stmt.Exec(w.ev, f.Part, int64(f.Inode), int64(f.ParentInode), f.Name, f.Path, f.Ext,
		boolInt(f.IsDir), f.Size, boolInt(f.Deleted), f.Created, f.Modified, f.Accessed, f.Changed); err != nil {
		return err
	}
	w.Total++
	if w.n++; w.n >= 5000 {
		w.stmt.Close()
		if err := w.tx.Commit(); err != nil {
			return err
		}
		return w.begin()
	}
	return nil
}

// Finish commits and rebuilds the full-text index. ok=false means the job failed or was cancelled.
func (w *IndexWriter) Finish(ok bool) error {
	w.stmt.Close()
	if err := w.tx.Commit(); err != nil {
		return err
	}
	if _, err := w.db.sql.Exec(`INSERT INTO files_fts(files_fts) VALUES ('rebuild')`); err != nil {
		return fmt.Errorf("rebuild full-text index: %w", err)
	}
	state := "done"
	if !ok {
		state = "partial"
	}
	_, err := w.db.sql.Exec(`UPDATE evidence SET index_state = ?, indexed_at = ?, file_count = ? WHERE id = ?`, state, now(), w.Total, w.ev)
	w.db.Audit("File index built", fmt.Sprintf("%s: %d entries (%s)", w.ev, w.Total, state))
	return err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ---------------- Search ----------------

type SearchQuery struct {
	Q          string
	Regex      bool
	InPath     bool   // match the full path, not just the name
	Deleted    bool   // include deleted entries
	Kind       string // all | file | dir
	EvidenceID string // empty searches all evidence
	Limit      int
}

const fileCols = `id, evidence_id, part, inode, parent_inode, name, path, ext, is_dir, size, deleted,
	COALESCE(crtime,0), COALESCE(mtime,0), COALESCE(atime,0), COALESCE(ctime,0)`

// fileColsF is fileCols with the table alias f (needed when joining files_fts).
const fileColsF = `f.id, f.evidence_id, f.part, f.inode, f.parent_inode, f.name, f.path, f.ext, f.is_dir, f.size, f.deleted,
	COALESCE(f.crtime,0), COALESCE(f.mtime,0), COALESCE(f.atime,0), COALESCE(f.ctime,0)`

func scanFile(rows interface{ Scan(...any) error }) (FileRow, error) {
	var f FileRow
	var isDir, del int
	var inode, parent int64
	err := rows.Scan(&f.ID, &f.EvidenceID, &f.Part, &inode, &parent, &f.Name, &f.Path, &f.Ext, &isDir, &f.Size, &del,
		&f.Created, &f.Modified, &f.Accessed, &f.Changed)
	f.Inode, f.ParentInode, f.IsDir, f.Deleted = uint64(inode), uint64(parent), isDir == 1, del == 1
	return f, err
}

// Search searches the index by name/path. Keywords of 3+ characters use the FTS5 trigram index; shorter keywords and regexes are matched row by row.
// Returns the hits and whether they were cut off at Limit.
func (d *DB) Search(q SearchQuery) ([]FileRow, bool, error) {
	if q.Limit <= 0 || q.Limit > 5000 {
		q.Limit = 1000
	}
	col := "name"
	if q.InPath {
		col = "path"
	}
	where := []string{"1=1"}
	args := []any{}
	if q.EvidenceID != "" {
		where = append(where, "f.evidence_id = ?")
		args = append(args, q.EvidenceID)
	}
	if !q.Deleted {
		where = append(where, "f.deleted = 0")
	}
	switch q.Kind {
	case "file":
		where = append(where, "f.is_dir = 0")
	case "dir":
		where = append(where, "f.is_dir = 1")
	}

	var re *regexp.Regexp
	from := "files f"
	switch {
	case q.Regex:
		var err error
		if re, err = regexp.Compile("(?i)" + q.Q); err != nil {
			return nil, false, fmt.Errorf("invalid regular expression: %w", err)
		}
	case len([]rune(q.Q)) >= 3:
		from = "files_fts JOIN files f ON f.id = files_fts.rowid"
		where = append(where, "files_fts MATCH ?")
		args = append(args, fmt.Sprintf(`%s : "%s"`, col, strings.ReplaceAll(q.Q, `"`, `""`)))
	default:
		where = append(where, "f."+col+` LIKE ? ESCAPE '\'`)
		args = append(args, "%"+likeEscape(q.Q)+"%")
	}

	sqlText := fmt.Sprintf(`SELECT %s FROM %s WHERE %s ORDER BY f.deleted, f.path`,
		fileColsF, from, strings.Join(where, " AND "))
	if re == nil {
		sqlText += fmt.Sprintf(" LIMIT %d", q.Limit+1)
	}
	rows, err := d.sql.Query(sqlText, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := []FileRow{}
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, false, err
		}
		if re != nil {
			target := f.Name
			if q.InPath {
				target = f.Path
			}
			if !re.MatchString(target) {
				continue
			}
		}
		if len(out) == q.Limit {
			return out, true, nil
		}
		out = append(out, f)
	}
	return out, false, rows.Err()
}

func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// File returns one index row by ID.
func (d *DB) File(id int64) (FileRow, error) {
	return scanFile(d.sql.QueryRow(`SELECT `+fileCols+` FROM files WHERE id = ?`, id))
}

// TrailStep is one level from the partition root down to a file's directory.
type TrailStep struct {
	Name  string `json:"name"`
	Inode uint64 `json:"inode"`
}

// Trail walks up parent_inode and returns the path from the partition root to the file's directory (file itself excluded).
func (d *DB) Trail(f FileRow, rootInode uint64, rootName string) ([]TrailStep, error) {
	steps := []TrailStep{}
	cur := f.ParentInode
	for i := 0; i < 128 && cur != rootInode; i++ {
		var name string
		var parent int64
		err := d.sql.QueryRow(`SELECT name, parent_inode FROM files WHERE evidence_id = ? AND part = ? AND inode = ? AND is_dir = 1 ORDER BY deleted LIMIT 1`,
			f.EvidenceID, f.Part, int64(cur)).Scan(&name, &parent)
		if err != nil {
			return nil, fmt.Errorf("cannot trace parent directory %d: %w", cur, err)
		}
		steps = append([]TrailStep{{Name: name, Inode: cur}}, steps...)
		cur = uint64(parent)
	}
	return append([]TrailStep{{Name: rootName, Inode: rootInode}}, steps...), nil
}

// FilesForContent returns the files to scan in a content search (non-directories within the size range), ordered by partition and inode to reduce seeking.
func (d *DB) FilesForContent(evidenceID string, maxSize int64, includeDeleted bool) ([]FileRow, error) {
	q := `SELECT ` + fileCols + ` FROM files WHERE evidence_id = ? AND is_dir = 0 AND size > 0 AND size <= ?`
	if !includeDeleted {
		q += ` AND deleted = 0`
	}
	rows, err := d.sql.Query(q+` ORDER BY part, inode`, evidenceID, maxSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FileRow
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}
