package server

import (
	"bytes"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"forensics/internal/casedb"
)

// ContentHit is one content search hit.
type ContentHit struct {
	FileID     int64  `json:"fileId"`
	EvidenceID string `json:"evidenceId"`
	Part       int    `json:"part"`
	Inode      uint64 `json:"inode"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	Deleted    bool   `json:"deleted"`
	Offset     int64  `json:"offset"`
	Encoding   string `json:"encoding"` // UTF-8 | UTF-16LE
	Context    string `json:"context"`
}

type ContentStatus struct {
	State     string       `json:"state"` // idle | running | done | cancelled | error
	Query     string       `json:"query"`
	Scanned   int64        `json:"scanned"`
	Total     int64        `json:"total"`
	Bytes     int64        `json:"bytes"`
	Seconds   float64      `json:"seconds"`
	Truncated bool         `json:"truncated"`
	Error     string       `json:"error,omitempty"`
	Hits      []ContentHit `json:"hits"`
}

const (
	maxContentHits = 2000
	hitsPerFile    = 3
	chunkSize      = 1 << 20
)

type contentJob struct {
	mu      sync.Mutex
	status  ContentStatus
	scanned atomic.Int64
	bytes   atomic.Int64
	cancel  atomic.Bool
	started time.Time
}

func (j *contentJob) snapshot() ContentStatus {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.status
	if s.State == "" {
		s.State = "idle"
	}
	if s.State == "running" {
		s.Scanned, s.Bytes = j.scanned.Load(), j.bytes.Load()
		s.Seconds = time.Since(j.started).Seconds()
	}
	// copy; an empty result must be [] not null (the front end expects an array)
	s.Hits = append(make([]ContentHit, 0, len(s.Hits)), s.Hits...)
	return s
}

func (j *contentJob) addHit(h ContentHit) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.status.Hits) >= maxContentHits {
		j.status.Truncated = true
		return false
	}
	j.status.Hits = append(j.status.Hits, h)
	return true
}

// asciiLower lowercases ASCII letters only and keeps the length (bytes.ToLower changes length on invalid UTF-8, which breaks offsets).
func asciiLower(dst, src []byte) []byte {
	dst = dst[:0]
	for _, b := range src {
		if b >= 'A' && b <= 'Z' {
			b += 'a' - 'A'
		}
		dst = append(dst, b)
	}
	return dst
}

func utf16le(s string) []byte {
	u := utf16.Encode([]rune(s))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	return b
}

// contextAround takes some bytes around a hit and decodes them into readable text.
func contextAround(buf []byte, at, n int, enc string) string {
	from, to := at-48, at+n+48
	if enc == "UTF-16LE" {
		from, to = at-80, at+n+80
		if (at-from)%2 != 0 {
			from++
		}
	}
	if from < 0 {
		from = 0
		if enc == "UTF-16LE" && at%2 != 0 {
			from = 1
		}
	}
	if to > len(buf) {
		to = len(buf)
	}
	seg := buf[from:to]
	var s string
	if enc == "UTF-16LE" {
		u := make([]uint16, len(seg)/2)
		for i := range u {
			u[i] = uint16(seg[2*i]) | uint16(seg[2*i+1])<<8
		}
		s = string(utf16.Decode(u))
	} else {
		s = strings.ToValidUTF8(string(seg), "·")
	}
	s = strings.Map(func(r rune) rune {
		switch {
		case r < 0x20 || r == 0x7f || r == utf8.RuneError:
			return '·'
		case enc == "UTF-16LE" && r&0xff == 0 && r>>8 >= 0x20 && r>>8 < 0x7f:
			// low byte 0 and high byte printable ASCII: misaligned English decoded as CJK (e.g. U+6F00 U+6D00 is really "om"); hide it
			return '·'
		case r >= 0x3400 && r <= 0x4dbf, r >= 0xe000 && r <= 0xf8ff, r >= 0xfff0:
			// CJK Ext. A, private use and specials: almost always misdecoded binary
			return '·'
		}
		return r
	}, s)
	// collapse runs of "·" into one for readability
	var b strings.Builder
	prevDot := false
	for _, r := range s {
		if r == '·' {
			if prevDot {
				continue
			}
			prevDot = true
		} else {
			prevDot = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// runContentSearch reads indexed files one by one and looks for both UTF-8 and UTF-16LE encodings (ASCII case-insensitive).
func (s *Server) runContentSearch(c *openCase, evs []*Evidence, q string, maxSize int64, deleted bool) {
	j := c.content
	defer c.wg.Done()
	type pattern struct {
		b   []byte
		enc string
	}
	lq := strings.ToLower(q) // only used to build patterns; the data side uses asciiLower
	pats := []pattern{{[]byte(lq), "UTF-8"}}
	if w := utf16le(lq); !bytes.Equal(w, []byte(lq)) {
		pats = append(pats, pattern{w, "UTF-16LE"})
	}
	maxLen := 0
	for _, p := range pats {
		if len(p.b) > maxLen {
			maxLen = len(p.b)
		}
	}

	var files []struct {
		ev *Evidence
		f  casedb.FileRow
	}
	for _, ev := range evs {
		list, err := c.db.FilesForContent(ev.Info.ID, maxSize, deleted)
		if err != nil {
			j.finish("error", err)
			return
		}
		for _, f := range list {
			files = append(files, struct {
				ev *Evidence
				f  casedb.FileRow
			}{ev, f})
		}
	}
	j.mu.Lock()
	j.status.Total = int64(len(files))
	j.mu.Unlock()

	buf := make([]byte, chunkSize+maxLen)
	low := make([]byte, 0, chunkSize+maxLen)
	for _, it := range files {
		if j.cancel.Load() {
			j.finish("cancelled", nil)
			return
		}
		hits := 0
		var carry int // bytes kept from the end of the previous chunk so hits spanning chunks are not missed
		for off := int64(0); off < it.f.Size && hits < hitsPerFile; {
			prevCarry := carry
			it.ev.mu.Lock()
			fs, ok := it.ev.fs[it.f.Part]
			var n int
			var err error
			if ok {
				n, _, err = fs.ReadInode(it.f.Inode, off, buf[carry:carry+chunkSize])
			}
			it.ev.mu.Unlock()
			if !ok || err != nil || n == 0 {
				break
			}
			j.bytes.Add(int64(n))
			data := buf[:carry+n]
			low = asciiLower(low, data)
			base := off - int64(carry)
			for _, p := range pats {
				for start := 0; hits < hitsPerFile; {
					i := bytes.Index(low[start:], p.b)
					if i < 0 {
						break
					}
					at := start + i
					if at+len(p.b) <= prevCarry { // lies entirely in the part already checked with the previous chunk
						start = at + 1
						continue
					}
					hits++
					if !j.addHit(ContentHit{
						FileID: it.f.ID, EvidenceID: it.ev.Info.ID, Part: it.f.Part, Inode: it.f.Inode, Name: it.f.Name, Path: it.f.Path,
						Deleted: it.f.Deleted, Offset: base + int64(at), Encoding: p.enc, Context: contextAround(data, at, len(p.b), p.enc),
					}) {
						j.finish("done", nil)
						return
					}
					start = at + len(p.b)
				}
			}
			off += int64(n)
			// keep the last maxLen-1 bytes and prepend them to the next chunk
			carry = maxLen - 1
			if carry > len(data) {
				carry = len(data)
			}
			copy(buf, data[len(data)-carry:])
		}
		j.scanned.Add(1)
	}
	j.finish("done", nil)
}

func (j *contentJob) finish(state string, err error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.status.State = state
	j.status.Scanned, j.status.Bytes = j.scanned.Load(), j.bytes.Load()
	j.status.Seconds = time.Since(j.started).Seconds()
	if err != nil {
		j.status.Error = err.Error()
	}
}

func (j *contentJob) start(q string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.State == "running" {
		return fmt.Errorf("a content search is already running")
	}
	j.status = ContentStatus{State: "running", Query: q, Hits: []ContentHit{}}
	j.scanned.Store(0)
	j.bytes.Store(0)
	j.cancel.Store(false)
	j.started = time.Now()
	return nil
}
