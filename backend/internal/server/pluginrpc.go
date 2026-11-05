package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"forensics/internal/casedb"
	"forensics/internal/tsk"
)

// ---------------- RPC methods (backend capabilities available to plugins; all read-only) ----------------

type rpcTarget struct {
	Path  string  `json:"path"`
	Part  *int    `json:"part"`
	Inode *uint64 `json:"inode"`
}

type rpcEntry struct {
	tsk.Entry
	Part int `json:"part"`
}

const maxReadChunk = 4 << 20

var partPrefix = regexp.MustCompile(`^p(\d+):(.*)$`)

// systemPart returns the partition containing the Windows directory, else the first recognized one. Caller holds ev.mu.
func (ev *Evidence) systemPart() (int, bool) {
	first := -1
	for _, p := range ev.Info.Partitions {
		fs, ok := ev.fs[p.Index]
		if !ok {
			continue
		}
		if first < 0 {
			first = p.Index
		}
		if _, ok := fs.Lookup("/Windows/System32/config/SYSTEM"); ok {
			return p.Index, true
		}
	}
	return first, first >= 0
}

// resolve turns a path or partition+inode into a file. Caller holds ev.mu.
func (ev *Evidence) resolve(t rpcTarget) (*tsk.FS, int, tsk.Entry, error) {
	if t.Part != nil && t.Inode != nil {
		fs, err := ev.fsFor(*t.Part)
		if err != nil {
			return nil, 0, tsk.Entry{}, err
		}
		e, ok := fs.StatInode(*t.Inode)
		if !ok {
			return nil, 0, tsk.Entry{}, fmt.Errorf("inode %d does not exist", *t.Inode)
		}
		return fs, *t.Part, e, nil
	}
	if t.Path == "" {
		return nil, 0, tsk.Entry{}, errors.New("missing path or part+inode")
	}
	p := strings.ReplaceAll(t.Path, `\`, "/")
	part := -1
	if m := partPrefix.FindStringSubmatch(p); m != nil {
		part, _ = strconv.Atoi(m[1])
		p = m[2]
	} else if sp, ok := ev.systemPart(); ok {
		part = sp
	}
	fs, err := ev.fsFor(part)
	if err != nil {
		return nil, 0, tsk.Entry{}, err
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	e, ok := fs.Lookup(p)
	if !ok {
		return nil, 0, tsk.Entry{}, fmt.Errorf("file not found: %s", t.Path)
	}
	return fs, part, e, nil
}

func (s *Server) handleRPC(c *openCase, ev *Evidence, m Manifest, workdir, method string, raw json.RawMessage) (any, error) {
	switch method {
	case "hello":
		return map[string]any{
			"api":      PluginAPI,
			"evidence": map[string]any{"id": ev.Info.ID, "name": ev.Info.Name, "path": ev.Info.Path},
			"plugin":   m,
			"workdir":  workdir,
		}, nil

	case "partitions":
		ev.mu.Lock()
		defer ev.mu.Unlock()
		sys, _ := ev.systemPart()
		out := []map[string]any{}
		for _, p := range ev.Info.Partitions {
			if _, ok := ev.fs[p.Index]; ok {
				out = append(out, map[string]any{"index": p.Index, "fsType": p.FsType, "system": p.Index == sys})
			}
		}
		return out, nil

	case "stat", "list", "read", "export":
		var t struct {
			rpcTarget
			Offset int64 `json:"offset"`
			Length int   `json:"length"`
		}
		if err := json.Unmarshal(raw, &t); err != nil {
			return nil, err
		}
		ev.mu.Lock()
		defer ev.mu.Unlock()
		fs, part, e, err := ev.resolve(t.rpcTarget)
		if method == "stat" {
			if err != nil {
				return nil, nil // null when it does not exist
			}
			return rpcEntry{e, part}, nil
		}
		if err != nil {
			return nil, err
		}
		switch method {
		case "list":
			if !e.IsDir {
				return nil, fmt.Errorf("not a directory: %s", t.Path)
			}
			entries, err := fs.ListDir(e.Inode)
			if err != nil {
				return nil, err
			}
			out := make([]rpcEntry, len(entries))
			for i, x := range entries {
				out[i] = rpcEntry{x, part}
			}
			return out, nil
		case "read":
			if t.Offset < 0 {
				return nil, errors.New("offset must not be negative")
			}
			if t.Length <= 0 || t.Length > maxReadChunk {
				t.Length = maxReadChunk
			}
			if rest := e.Size - t.Offset; rest < int64(t.Length) {
				t.Length = int(max(rest, 0))
			}
			buf := make([]byte, t.Length)
			n := 0
			if t.Length > 0 {
				n, _, err = fs.ReadInode(e.Inode, t.Offset, buf)
				if err != nil {
					return nil, err
				}
			}
			return map[string]string{"data": base64.StdEncoding.EncodeToString(buf[:n])}, nil
		default: // export
			return s.exportFile(c, ev, fs, part, e, t.Path)
		}

	case "find":
		var q struct {
			Ext, Name, Path string
			Deleted         bool
			Limit, Offset   int
		}
		if err := json.Unmarshal(raw, &q); err != nil {
			return nil, err
		}
		if st := ev.indexStatus().State; st != "done" && st != "partial" {
			return nil, errors.New("build the file index for this evidence first")
		}
		return c.db.Find(ev.Info.ID, casedb.FindQuery{Ext: q.Ext, Name: q.Name, Path: q.Path, Deleted: q.Deleted,
			Limit: q.Limit, Offset: q.Offset, FilesOnly: true})
	}
	return nil, fmt.Errorf("unknown method: %s", method)
}

var unsafeName = regexp.MustCompile(`[^\p{L}\p{N}._-]+`)

// exportFile copies a file to case/work/<evidence>/export/p<partition>/<inode>_<name>; an existing export is reused. Caller holds ev.mu.
// It writes a temporary file and renames it, so a failure never leaves a truncated file that looks complete.
func (s *Server) exportFile(c *openCase, ev *Evidence, fs *tsk.FS, part int, e tsk.Entry, path string) (any, error) {
	if e.IsDir {
		return nil, errors.New("cannot export a directory")
	}
	name := e.Name
	if name == "" {
		name = filepath.Base(strings.ReplaceAll(path, `\`, "/"))
	}
	if name == "" || name == "." || name == "/" {
		name = "file"
	}
	dir := filepath.Join(c.db.WorkDir(), ev.Info.ID, "export", fmt.Sprintf("p%d", part))
	dst := filepath.Join(dir, fmt.Sprintf("%d_%s", e.Inode, unsafeName.ReplaceAllString(name, "_")))
	if st, err := os.Stat(dst); err == nil && st.Size() == e.Size {
		return map[string]string{"path": dst}, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 1<<20)
	for off := int64(0); off < e.Size; {
		n, _, err := fs.ReadInode(e.Inode, off, buf)
		if err != nil {
			f.Close()
			os.Remove(tmp)
			return nil, err
		}
		if n == 0 {
			break
		}
		if _, err := f.Write(buf[:n]); err != nil {
			f.Close()
			os.Remove(tmp)
			return nil, err
		}
		off += int64(n)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return nil, err
	}
	os.Remove(dst)
	if err := os.Rename(tmp, dst); err != nil {
		return nil, err
	}
	return map[string]string{"path": dst}, nil
}
