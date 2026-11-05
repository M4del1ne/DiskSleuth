package tsk

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Format is the image format detected from the file header (not the extension).
type Format string

const (
	FormatEWF  Format = "ewf"  // E01 / L01 / Ex01
	FormatRaw  Format = "raw"  // DD / RAW / .001 split images
	FormatVHD  Format = "vhd"  // libvhdi not enabled yet
	FormatVMDK Format = "vmdk" // libvmdk not enabled yet
)

var ewfSignatures = [][]byte{
	[]byte("EVF\x09\x0d\x0a\xff\x00"), // E01
	[]byte("LVF\x09\x0d\x0a\xff\x00"), // L01
	[]byte("EVF2\x0d\x0a\x81\x00"),    // Ex01
	[]byte("LEF2\x0d\x0a\x81\x00"),    // Lx01
}

// DetectFormat reads the file header to determine the image format.
func DetectFormat(path string) (Format, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := f.Read(head)
	head = head[:n]
	for _, sig := range ewfSignatures {
		if bytes.HasPrefix(head, sig) {
			return FormatEWF, nil
		}
	}
	switch {
	case bytes.HasPrefix(head, []byte("conectix")):
		return FormatVHD, nil
	case bytes.HasPrefix(head, []byte("KDMV")), bytes.Contains(head, []byte("# Disk DescriptorFile")):
		return FormatVMDK, nil
	}
	return FormatRaw, nil
}

// normalizePath makes the path absolute and uses backslashes on Windows.
// libewf prefixes paths with \\?\ (long path), where forward slashes are not accepted and opening fails.
func normalizePath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

// Open opens an image. For E01 pass only the first segment; libewf finds the rest.
// Split RAW images (.001/.002…) must all be passed in order.
//
// Unlike TSK auto-detection: when the header is EWF the image is opened as EWF or the call fails;
// it never silently falls back to RAW (that would treat compressed data as disk content and give wrong results).
func Open(paths ...string) (*Image, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("no image file given")
	}
	norm := make([]string, len(paths))
	for i, p := range paths {
		np, err := normalizePath(p)
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(np); err != nil {
			return nil, err
		}
		norm[i] = np
	}
	format, err := DetectFormat(norm[0])
	if err != nil {
		return nil, err
	}
	var itype int
	switch format {
	case FormatEWF:
		itype = imgTypeEWF
	case FormatRaw:
		itype = imgTypeRaw
	default:
		return nil, fmt.Errorf("unsupported image format: %s", format)
	}
	im, err := openNative(norm, itype)
	if err != nil {
		return nil, err
	}
	im.Format = format
	if want := string(format); !strings.EqualFold(im.TypeName(), want) {
		got := im.TypeName()
		im.Close()
		return nil, fmt.Errorf("image format mismatch: header says %s, TSK opened %s", want, got)
	}
	return im, nil
}
