package server

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"forensics/internal/casedb"
	"forensics/internal/ewf"
	"forensics/internal/tsk"
)

// PartitionInfo is a partition and its file system. A volume image without a partition table uses Index=0, Start=0 for the whole image.
type PartitionInfo struct {
	Index       int    `json:"index"`
	Start       int64  `json:"start"`
	Length      int64  `json:"length"`
	Description string `json:"description"`
	Allocated   bool   `json:"allocated"`
	FsType      string `json:"fsType,omitempty"`
	BlockSize   int    `json:"blockSize,omitempty"`
	RootInode   uint64 `json:"rootInode,omitempty"`
}

// EvidenceInfo is the evidence info returned to the front end.
type EvidenceInfo struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Path       string          `json:"path"`
	Format     string          `json:"format"`
	FileSize   int64           `json:"fileSize"`
	MediaSize  int64           `json:"mediaSize"`
	SectorSize int             `json:"sectorSize"`
	Segments   int             `json:"segments"`
	Ewf        *ewf.Info       `json:"ewf,omitempty"`
	Partitions []PartitionInfo `json:"partitions"`
}

// Evidence is an opened evidence item. Access to the TSK handles is serialized by mu; hashing uses its own handle so browsing is not blocked.
type Evidence struct {
	Info EvidenceInfo

	mu  sync.Mutex
	img *tsk.Image
	fs  map[int]*tsk.FS

	hash  hashJob
	index indexJob
	plug  pluginJob

	db *casedb.DB // owning case database: hashes, results and the index go here
}

// loadSaved restores previously computed hashes from the case database.
func (ev *Evidence) loadSaved() {
	if h, err := ev.db.LoadHash(ev.Info.ID); err == nil && h != nil {
		ev.hash.status = HashStatus{State: "done", Progress: 1, Done: ev.Info.MediaSize, Total: ev.Info.MediaSize,
			MD5: h.MD5, SHA1: h.SHA1, SHA256: h.SHA256, Seconds: h.Seconds, StartedAt: h.ComputedAt}
	}
}

func openEvidence(id, path string) (*Evidence, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	img, err := tsk.Open(path)
	if err != nil {
		return nil, err
	}
	ev := &Evidence{img: img, fs: map[int]*tsk.FS{}}
	ev.Info = EvidenceInfo{
		ID:         id,
		Name:       filepath.Base(path),
		Path:       path,
		Format:     string(img.Format),
		FileSize:   st.Size(),
		MediaSize:  img.Size(),
		SectorSize: img.SectorSize(),
		Segments:   img.Segments(),
	}
	if img.Format == tsk.FormatEWF {
		if info, err := ewf.ReadInfo(path); err == nil {
			ev.Info.Ewf = info
			ev.Info.Segments = info.Segments
			// total size of the segment files
			var total int64
			for _, seg := range segmentFiles(path, info.Segments) {
				if s, err := os.Stat(seg); err == nil {
					total += s.Size()
				}
			}
			if total > 0 {
				ev.Info.FileSize = total
			}
		}
	}

	parts, err := img.Partitions()
	if err != nil {
		img.Close()
		return nil, err
	}
	if len(parts) == 0 { // volume image: the whole image is one file system
		parts = []tsk.Partition{{Index: 0, Start: 0, Length: img.Size() / int64(img.SectorSize()), Description: "Whole image", Allocated: true}}
	}
	ss := int64(img.SectorSize())
	for _, p := range parts {
		if p.Description == "Primary Table (#0)" || (p.Length == 1 && !p.Allocated && p.Start == 0) {
			continue // skip the partition table metadata itself
		}
		pi := PartitionInfo{Index: p.Index, Start: p.Start, Length: p.Length, Description: p.Description, Allocated: p.Allocated}
		if p.Allocated {
			if fs, err := img.OpenFS(p.Start * ss); err == nil {
				ev.fs[p.Index] = fs
				pi.FsType = fs.TypeName()
				pi.BlockSize = fs.BlockSize()
				pi.RootInode = fs.RootInode()
			}
		}
		ev.Info.Partitions = append(ev.Info.Partitions, pi)
	}
	return ev, nil
}

// segmentFiles derives the E01 segment file names (.E01, .E02 … .E99, .EAA …); used only to sum their sizes.
func segmentFiles(first string, n int) []string {
	ext := filepath.Ext(first)
	base := first[:len(first)-len(ext)]
	if len(ext) != 4 || n <= 1 {
		return []string{first}
	}
	out := []string{}
	for i := 1; i <= n && i <= 99; i++ {
		out = append(out, fmt.Sprintf("%s%c%02d", base, ext[1], i))
	}
	return out
}

func (ev *Evidence) close() {
	ev.mu.Lock()
	defer ev.mu.Unlock()
	for _, fs := range ev.fs {
		fs.Close()
	}
	if ev.img != nil {
		ev.img.Close()
	}
}

func (ev *Evidence) fsFor(part int) (*tsk.FS, error) {
	fs, ok := ev.fs[part]
	if !ok {
		return nil, fmt.Errorf("partition %d has no recognized file system", part)
	}
	return fs, nil
}

// ---------------- Whole-disk hashing ----------------

type HashStatus struct {
	State     string  `json:"state"` // idle | running | done | error
	Progress  float64 `json:"progress"`
	Done      int64   `json:"done"`
	Total     int64   `json:"total"`
	MD5       string  `json:"md5,omitempty"`
	SHA1      string  `json:"sha1,omitempty"`
	SHA256    string  `json:"sha256,omitempty"`
	Error     string  `json:"error,omitempty"`
	StartedAt string  `json:"startedAt,omitempty"`
	Seconds   float64 `json:"seconds,omitempty"`
}

type hashJob struct {
	mu     sync.Mutex
	status HashStatus
	done   atomic.Int64
}

func (ev *Evidence) hashStatus() HashStatus {
	ev.hash.mu.Lock()
	defer ev.hash.mu.Unlock()
	s := ev.hash.status
	if s.State == "" {
		s.State = "idle"
	}
	if s.State == "running" {
		s.Done = ev.hash.done.Load()
		if s.Total > 0 {
			s.Progress = float64(s.Done) / float64(s.Total)
		}
	}
	return s
}

func (ev *Evidence) startHash() HashStatus {
	ev.hash.mu.Lock()
	if ev.hash.status.State == "running" {
		ev.hash.mu.Unlock()
		return ev.hashStatus()
	}
	ev.hash.status = HashStatus{State: "running", Total: ev.Info.MediaSize, StartedAt: time.Now().Format(time.RFC3339)}
	ev.hash.done.Store(0)
	ev.hash.mu.Unlock()

	go func() {
		res, err := ev.computeHash()
		ev.hash.mu.Lock()
		defer ev.hash.mu.Unlock()
		if err != nil {
			ev.hash.status.State = "error"
			ev.hash.status.Error = err.Error()
			return
		}
		res.StartedAt = ev.hash.status.StartedAt
		ev.hash.status = res
		if ev.db != nil {
			ev.db.SaveHash(ev.Info.ID, casedb.Hash{MD5: res.MD5, SHA1: res.SHA1, SHA256: res.SHA256, Seconds: res.Seconds})
		}
	}()
	return ev.hashStatus()
}

func (ev *Evidence) computeHash() (HashStatus, error) {
	// open a separate image handle so hashing does not block file browsing
	img, err := tsk.Open(ev.Info.Path)
	if err != nil {
		return HashStatus{}, err
	}
	defer img.Close()
	start := time.Now()
	m, s1, s256 := md5.New(), sha1.New(), sha256.New()
	w := io.MultiWriter(m, s1, s256)
	buf := make([]byte, 8<<20)
	size := img.Size()
	for off := int64(0); off < size; {
		n, err := img.ReadAt(buf, off)
		if n > 0 {
			w.Write(buf[:n])
			off += int64(n)
			ev.hash.done.Store(off)
		}
		if err != nil && err != io.EOF {
			return HashStatus{}, err
		}
		if n == 0 {
			break
		}
	}
	return HashStatus{
		State: "done", Progress: 1, Done: size, Total: size,
		MD5: hex.EncodeToString(m.Sum(nil)), SHA1: hex.EncodeToString(s1.Sum(nil)), SHA256: hex.EncodeToString(s256.Sum(nil)),
		Seconds: time.Since(start).Seconds(),
	}, nil
}
