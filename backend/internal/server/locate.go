package server

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"forensics/internal/casedb"
)

// Locating a path inside the evidence, for "Show in Files". Plugins and result cells write paths in many
// forms; normalizePathRef turns them into a partition prefix (or none = system partition) and a "/" path:
//
//	p2:/Users/a/x.lnk   p2:\Users\a\x.lnk   /Windows/Prefetch/X.pf   C:\Users\a\x.txt
//	\??\C:\Windows\x.exe   \SystemRoot\System32\drivers\x.sys   system32\drivers\x.sys
//	%SystemRoot%\System32\calc.exe   "C:\Program Files\App\app.exe" -arg   C:\Windows\system32\userinit.exe,

var (
	reQuoted   = regexp.MustCompile(`^"([^"]+)"`)
	reExecArgs = regexp.MustCompile(`(?i)^(.*?\.(?:exe|dll|sys|com|bat|cmd|ps1|vbs|js|scr|cpl|msi|lnk|ocx))(?:[\s,].*)?$`)
	reDrive    = regexp.MustCompile(`^[A-Za-z]:`)
	reEnvVar   = regexp.MustCompile(`%([^%]+)%`)
)

// environment variables that point at fixed folders of the system volume
var envFolders = map[string]string{
	"systemroot": "/Windows", "windir": "/Windows", "systemdrive": "",
	"programfiles": "/Program Files", "programfiles(x86)": "/Program Files (x86)", "programw6432": "/Program Files",
	"programdata": "/ProgramData", "allusersprofile": "/ProgramData", "commonprogramfiles": "/Program Files/Common Files",
	"public": "/Users/Public",
}

// normalizePathRef returns the partition prefix ("p2:" or "" for the system partition) and a "/"-separated path.
func normalizePathRef(s string) (string, string, error) {
	s = strings.TrimSpace(s)
	if m := reQuoted.FindStringSubmatch(s); m != nil {
		s = m[1]
	} else if m := reExecArgs.FindStringSubmatch(s); m != nil {
		s = m[1] // drop command line arguments after an executable path
	}
	prefix := ""
	if m := partPrefix.FindStringSubmatch(strings.ReplaceAll(s, `\`, "/")); m != nil {
		prefix, s = "p"+m[1]+":", m[2]
	}
	s = strings.ReplaceAll(s, `\`, "/")
	s = strings.TrimPrefix(s, "//?/")
	s = strings.TrimPrefix(s, "/??/")
	var bad error
	s = reEnvVar.ReplaceAllStringFunc(s, func(v string) string {
		if p, ok := envFolders[strings.ToLower(strings.Trim(v, "%"))]; ok {
			return p
		}
		bad = fmt.Errorf("cannot resolve %s in this evidence", v)
		return v
	})
	if bad != nil {
		return "", "", bad
	}
	if reDrive.MatchString(s) {
		s = s[2:] // drive letters are taken as the system volume
	}
	lower := strings.ToLower(s)
	switch {
	case strings.HasPrefix(lower, "/systemroot/"):
		s = "/Windows" + s[len("/systemroot"):]
	case strings.HasPrefix(lower, "system32/"), strings.HasPrefix(lower, "syswow64/"):
		s = "/Windows/" + s // service ImagePath relative to the Windows folder
	}
	s = "/" + strings.Trim(s, "/")
	if s == "/" && prefix == "" {
		return "", "", errors.New("empty path")
	}
	return prefix, s, nil
}

// locate resolves a path to the partition, the directory trail from the partition root and the target inode.
func (ev *Evidence) locate(ref string) (map[string]any, error) {
	prefix, p, err := normalizePathRef(ref)
	if err != nil {
		return nil, err
	}
	ev.mu.Lock()
	defer ev.mu.Unlock()
	part := -1
	if prefix != "" {
		part, _ = strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(prefix, "p"), ":"))
	} else if sp, ok := ev.systemPart(); ok {
		part = sp
	}
	fs, err := ev.fsFor(part)
	if err != nil {
		return nil, err
	}
	target, ok := fs.Lookup(p)
	if !ok {
		return nil, fmt.Errorf("not found in the evidence: %s", p)
	}
	root := fs.RootInode()
	trail := []casedb.TrailStep{{Name: fmt.Sprintf("Partition %d", part), Inode: root}}
	segs := strings.Split(strings.Trim(p, "/"), "/")
	cur := ""
	for _, seg := range segs[:len(segs)-1] {
		cur += "/" + seg
		e, ok := fs.Lookup(cur)
		if !ok {
			return nil, fmt.Errorf("not found in the evidence: %s", cur)
		}
		trail = append(trail, casedb.TrailStep{Name: e.Name, Inode: e.Inode})
	}
	return map[string]any{"part": part, "inode": target.Inode, "isDir": target.IsDir, "path": p, "trail": trail}, nil
}

func (s *Server) locatePath(w http.ResponseWriter, r *http.Request) {
	_, ev := s.ev(w, r)
	if ev == nil {
		return
	}
	res, err := ev.locate(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, res)
}
