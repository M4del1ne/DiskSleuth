// Package tsk wraps The Sleuth Kit through cgo (libtsk + libewf linked statically).
//
// Threads: TSK keeps its error state in thread-local storage, so every "call + read error" pair runs
// under runtime.LockOSThread; otherwise a goroutine could switch threads and read another call's error.
package tsk

/*
#cgo CFLAGS: -I${SRCDIR}/../../../deps/include
#cgo LDFLAGS: -L${SRCDIR}/../../../deps/lib -ltsk -lewf -lz -lstdc++ -static
#include <stdlib.h>
#include <tsk/libtsk.h>

static int go_img_itype(TSK_IMG_INFO *img) { return (int)img->itype; }
static long long go_img_size(TSK_IMG_INFO *img) { return (long long)img->size; }
static unsigned int go_img_sector_size(TSK_IMG_INFO *img) { return img->sector_size; }
static int go_img_num(TSK_IMG_INFO *img) { return img->num_img; }

static long long go_fs_size(TSK_FS_FILE *f) {
	return (f && f->meta) ? (long long)f->meta->size : -1;
}
static int go_fs_type(TSK_FS_INFO *fs) { return (int)fs->ftype; }
static unsigned int go_fs_block_size(TSK_FS_INFO *fs) { return fs->block_size; }
*/
import "C"

import (
	"errors"
	"fmt"
	"io"
	"runtime"
	"unsafe"
)

// Version returns the TSK version.
func Version() string { return C.GoString(C.tsk_version_get_str()) }

// lastError reads and clears the TSK error of the current thread. The caller must hold LockOSThread.
func lastError(op string) error {
	msg := C.GoString(C.tsk_error_get())
	C.tsk_error_reset()
	if msg == "" {
		msg = "unknown error"
	}
	return fmt.Errorf("%s: %s", op, msg)
}

// ---------------- Image ----------------

// Image is an opened disk image (E01, DD/RAW, ...) and implements io.ReaderAt.
type Image struct {
	ptr    *C.TSK_IMG_INFO
	Format Format // format detected from the file header
}

// Size returns the media size in bytes; for E01 this is the uncompressed disk size.
func (im *Image) Size() int64 { return int64(C.go_img_size(im.ptr)) }

// SectorSize returns the sector size.
func (im *Image) SectorSize() int { return int(C.go_img_sector_size(im.ptr)) }

// Segments returns the number of segment files (> 1 for multi-segment E01).
func (im *Image) Segments() int { return int(C.go_img_num(im.ptr)) }

// TypeName returns the image type TSK actually used, e.g. "ewf", "raw".
func (im *Image) TypeName() string {
	return C.GoString(C.tsk_img_type_toname(C.TSK_IMG_TYPE_ENUM(C.go_img_itype(im.ptr))))
}

// ReadAt implements io.ReaderAt.
func (im *Image) ReadAt(p []byte, off int64) (int, error) {
	if off >= im.Size() {
		return 0, io.EOF
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	total := 0
	for total < len(p) {
		want := len(p) - total
		if rem := im.Size() - off - int64(total); int64(want) > rem {
			want = int(rem)
		}
		if want == 0 {
			return total, io.EOF
		}
		n := C.tsk_img_read(im.ptr, C.TSK_OFF_T(off+int64(total)),
			(*C.char)(unsafe.Pointer(&p[total])), C.size_t(want))
		if n < 0 {
			return total, lastError("read image")
		}
		if n == 0 {
			return total, io.EOF
		}
		total += int(n)
	}
	return total, nil
}

// Close closes the image.
func (im *Image) Close() {
	if im.ptr != nil {
		C.tsk_img_close(im.ptr)
		im.ptr = nil
	}
}

// ---------------- Partitions ----------------

// Partition is one entry of the volume system (MBR, GPT, ...).
type Partition struct {
	Index       int
	Start       int64 // first sector
	Length      int64 // sector count
	Description string
	Allocated   bool // a real allocated partition (not unallocated space or partition table metadata)
}

// Partitions reads the partition table. Returns an empty slice when there is none (e.g. a volume image).
func (im *Image) Partitions() ([]Partition, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	vs := C.tsk_vs_open(im.ptr, 0, C.TSK_VS_TYPE_DETECT)
	if vs == nil {
		C.tsk_error_reset()
		return nil, nil
	}
	defer C.tsk_vs_close(vs)
	var parts []Partition
	for i := C.TSK_PNUM_T(0); i < vs.part_count; i++ {
		p := C.tsk_vs_part_get(vs, i)
		if p == nil {
			continue
		}
		parts = append(parts, Partition{
			Index:       int(i),
			Start:       int64(p.start),
			Length:      int64(p.len),
			Description: C.GoString(p.desc),
			Allocated:   p.flags&C.TSK_VS_PART_FLAG_ALLOC != 0,
		})
	}
	return parts, nil
}

// ---------------- File system ----------------

// FS is an opened file system.
type FS struct {
	ptr *C.TSK_FS_INFO
	img *Image
}

// OpenFS detects and opens the file system at offset (bytes) in the image.
func (im *Image) OpenFS(offset int64) (*FS, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	fs := C.tsk_fs_open_img(im.ptr, C.TSK_OFF_T(offset), C.TSK_FS_TYPE_DETECT)
	if fs == nil {
		return nil, lastError(fmt.Sprintf("open file system (offset %d)", offset))
	}
	return &FS{ptr: fs, img: im}, nil
}

// TypeName returns the file system type, e.g. "ntfs", "fat32".
func (fs *FS) TypeName() string {
	return C.GoString(C.tsk_fs_type_toname(C.TSK_FS_TYPE_ENUM(C.go_fs_type(fs.ptr))))
}

// BlockSize returns the cluster/block size.
func (fs *FS) BlockSize() int { return int(C.go_fs_block_size(fs.ptr)) }

// ErrNotFound means the path does not exist in the file system.
var ErrNotFound = errors.New("file not found")

// CopyFile writes the content of path (UTF-8, "/" separated; case sensitivity depends on the file system) to w.
func (fs *FS) CopyFile(path string, w io.Writer) (int64, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))
	f := C.tsk_fs_file_open(fs.ptr, nil, cpath)
	if f == nil {
		C.tsk_error_reset()
		return 0, fmt.Errorf("%s: %w", path, ErrNotFound)
	}
	defer C.tsk_fs_file_close(f)
	size := int64(C.go_fs_size(f))
	if size < 0 {
		return 0, fmt.Errorf("%s: no metadata", path)
	}
	const chunk = 1 << 20
	buf := C.malloc(chunk)
	defer C.free(buf)
	var off int64
	for off < size {
		want := int64(chunk)
		if size-off < want {
			want = size - off
		}
		n := C.tsk_fs_file_read(f, C.TSK_OFF_T(off), (*C.char)(buf), C.size_t(want), C.TSK_FS_FILE_READ_FLAG_NONE)
		if n <= 0 {
			if n < 0 {
				return off, lastError("read " + path)
			}
			break
		}
		if _, err := w.Write(C.GoBytes(buf, C.int(n))); err != nil {
			return off, err
		}
		off += int64(n)
	}
	return off, nil
}

// Close closes the file system.
func (fs *FS) Close() {
	if fs.ptr != nil {
		C.tsk_fs_close(fs.ptr)
		fs.ptr = nil
	}
}
