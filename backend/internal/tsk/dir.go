package tsk

/*
#include <stdlib.h>
#include <tsk/libtsk.h>

// The name / meta fields of TSK_FS_FILE are nested structs; small C helpers read them so Go never handles the C struct layout.
typedef struct {
	const char *name;
	unsigned long long meta_addr;
	int name_type;      // TSK_FS_NAME_TYPE_ENUM
	int name_flags;     // TSK_FS_NAME_FLAG_ENUM
	int has_meta;
	int meta_type;      // TSK_FS_META_TYPE_ENUM
	int meta_flags;     // TSK_FS_META_FLAG_ENUM
	long long size;
	long long crtime, mtime, atime, ctime;
} ds_entry;

static int ds_dir_entry(TSK_FS_DIR *dir, size_t i, ds_entry *out) {
	TSK_FS_FILE *f = tsk_fs_dir_get(dir, i);
	if (f == NULL || f->name == NULL) {
		if (f) tsk_fs_file_close(f);
		return 0;
	}
	out->name = f->name->name;   // points into dir's memory, valid until dir is closed
	out->meta_addr = (unsigned long long)f->name->meta_addr;
	out->name_type = (int)f->name->type;
	out->name_flags = (int)f->name->flags;
	out->has_meta = f->meta != NULL;
	if (f->meta) {
		out->meta_type = (int)f->meta->type;
		out->meta_flags = (int)f->meta->flags;
		out->size = (long long)f->meta->size;
		out->crtime = (long long)f->meta->crtime;
		out->mtime = (long long)f->meta->mtime;
		out->atime = (long long)f->meta->atime;
		out->ctime = (long long)f->meta->ctime;
	}
	tsk_fs_file_close(f);
	return 1;
}

static unsigned long long ds_fs_root(TSK_FS_INFO *fs) { return (unsigned long long)fs->root_inum; }

static long long ds_file_size(TSK_FS_FILE *f) { return (f && f->meta) ? (long long)f->meta->size : -1; }
*/
import "C"

import (
	"fmt"
	"runtime"
	"unsafe"
)

// Entry is one directory entry. Times are Unix seconds (UTC); 0 means unknown.
type Entry struct {
	Name     string `json:"name"`
	Inode    uint64 `json:"inode"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	Deleted  bool   `json:"deleted"`
	Created  int64  `json:"created"`
	Modified int64  `json:"modified"`
	Accessed int64  `json:"accessed"`
	Changed  int64  `json:"changed"`
}

// RootInode returns the metadata address of the root directory.
func (fs *FS) RootInode() uint64 { return uint64(C.ds_fs_root(fs.ptr)) }

// ListDir lists a directory (deleted entries included), skipping "." and "..".
func (fs *FS) ListDir(inode uint64) ([]Entry, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	dir := C.tsk_fs_dir_open_meta(fs.ptr, C.TSK_INUM_T(inode))
	if dir == nil {
		return nil, lastError(fmt.Sprintf("open directory %d", inode))
	}
	defer C.tsk_fs_dir_close(dir)

	n := int(C.tsk_fs_dir_getsize(dir))
	out := make([]Entry, 0, n)
	seen := make(map[string]bool, n)
	for i := 0; i < n; i++ {
		var e C.ds_entry
		if C.ds_dir_entry(dir, C.size_t(i), &e) == 0 {
			continue
		}
		name := C.GoString(e.name)
		if name == "." || name == ".." || name == "" {
			continue
		}
		// the NTFS index may list the same file several times (e.g. stale entries after deletion); dedupe by name+inode
		key := fmt.Sprintf("%s\x00%d", name, uint64(e.meta_addr))
		if seen[key] {
			continue
		}
		seen[key] = true

		isDir := e.name_type == C.TSK_FS_NAME_TYPE_DIR || e.name_type == C.TSK_FS_NAME_TYPE_VIRT_DIR
		if e.has_meta != 0 && (e.meta_type == C.TSK_FS_META_TYPE_DIR || e.meta_type == C.TSK_FS_META_TYPE_VIRT_DIR) {
			isDir = true
		}
		ent := Entry{
			Name:    name,
			Inode:   uint64(e.meta_addr),
			IsDir:   isDir,
			Deleted: e.name_flags&C.TSK_FS_NAME_FLAG_UNALLOC != 0,
		}
		if e.has_meta != 0 {
			ent.Size = int64(e.size)
			ent.Created = int64(e.crtime)
			ent.Modified = int64(e.mtime)
			ent.Accessed = int64(e.atime)
			ent.Changed = int64(e.ctime)
		}
		out = append(out, ent)
	}
	return out, nil
}

// ReadInode reads up to len(p) bytes at off from the file at inode (default data stream). Returns bytes read and the file size.
func (fs *FS) ReadInode(inode uint64, off int64, p []byte) (int, int64, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	f := C.tsk_fs_file_open_meta(fs.ptr, nil, C.TSK_INUM_T(inode))
	if f == nil {
		return 0, 0, lastError(fmt.Sprintf("open inode %d", inode))
	}
	defer C.tsk_fs_file_close(f)
	size := int64(C.ds_file_size(f))
	if off >= size || len(p) == 0 {
		return 0, size, nil
	}
	want := int64(len(p))
	if size-off < want {
		want = size - off
	}
	buf := C.malloc(C.size_t(want))
	defer C.free(buf)
	// data blocks of deleted files may have been overwritten; a read failure here is not fatal
	n := C.tsk_fs_file_read(f, C.TSK_OFF_T(off), (*C.char)(buf), C.size_t(want), C.TSK_FS_FILE_READ_FLAG_NONE)
	if n < 0 {
		return 0, size, lastError(fmt.Sprintf("read inode %d", inode))
	}
	copy(p, unsafe.Slice((*byte)(buf), int(n)))
	return int(n), size, nil
}
