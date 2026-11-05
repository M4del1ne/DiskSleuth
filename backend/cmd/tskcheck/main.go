// tskcheck: checks the whole Go + TSK + libewf chain.
//
//	tskcheck [-hash] [-export dir] <image path>
//
// Prints image / partition / file system info; -export extracts the Windows registry hives;
// -hash computes the whole-disk MD5/SHA1/SHA256 through our own read path (to compare with ewfverify and the hashes stored in the E01).
package main

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"forensics/internal/tsk"
)

var hives = []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY"}

func main() {
	doHash := flag.Bool("hash", false, "compute whole-disk MD5/SHA1/SHA256")
	exportDir := flag.String("export", "", "export the Windows registry hives to this directory")
	flag.Parse()
	if flag.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "usage: tskcheck [-hash] [-export dir] <image path>")
		os.Exit(2)
	}

	fmt.Println("TSK version:", tsk.Version())
	im, err := tsk.Open(flag.Args()...)
	if err != nil {
		fail(err)
	}
	defer im.Close()
	fmt.Printf("image: format=%s(TSK:%s) segments=%d media size=%d bytes sector=%d\n",
		im.Format, im.TypeName(), im.Segments(), im.Size(), im.SectorSize())

	parts, err := im.Partitions()
	if err != nil {
		fail(err)
	}
	ss := int64(im.SectorSize())
	exported := false
	for _, p := range parts {
		fmt.Printf("  partition %02d  start=%-10d length=%-10d %s\n", p.Index, p.Start, p.Length, p.Description)
		if !p.Allocated {
			continue
		}
		fs, err := im.OpenFS(p.Start * ss)
		if err != nil {
			fmt.Println("    file system: not recognized -", err)
			continue
		}
		fmt.Printf("    file system: %s, cluster size %d\n", fs.TypeName(), fs.BlockSize())
		if *exportDir != "" && !exported {
			n := exportHives(fs, *exportDir)
			exported = n > 0
		}
		fs.Close()
	}

	if *doHash {
		hashImage(im)
	}
}

func exportHives(fs *tsk.FS, dir string) int {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(err)
	}
	count := 0
	for _, h := range hives {
		src := "/Windows/System32/config/" + h
		dst := filepath.Join(dir, h)
		f, err := os.Create(dst)
		if err != nil {
			fail(err)
		}
		n, err := fs.CopyFile(src, f)
		f.Close()
		if err != nil {
			os.Remove(dst)
			fmt.Printf("    export %s: %v\n", h, err)
			continue
		}
		fmt.Printf("    exported %s -> %s (%d bytes)\n", src, dst, n)
		count++
	}
	return count
}

func hashImage(im *tsk.Image) {
	m, s1, s256 := md5.New(), sha1.New(), sha256.New()
	w := io.MultiWriter(m, s1, s256)
	const chunk = 8 << 20
	buf := make([]byte, chunk)
	size := im.Size()
	start := time.Now()
	last := start
	for off := int64(0); off < size; {
		n, err := im.ReadAt(buf, off)
		if n > 0 {
			w.Write(buf[:n])
			off += int64(n)
		}
		if err != nil && err != io.EOF {
			fail(err)
		}
		if n == 0 {
			break
		}
		if time.Since(last) > 10*time.Second {
			last = time.Now()
			fmt.Printf("  hashing %.1f%%\n", float64(off)*100/float64(size))
		}
	}
	fmt.Printf("hashes (%s):\n  MD5:    %s\n  SHA1:   %s\n  SHA256: %s\n", time.Since(start).Round(time.Second),
		hex.EncodeToString(m.Sum(nil)), hex.EncodeToString(s1.Sum(nil)), hex.EncodeToString(s256.Sum(nil)))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
