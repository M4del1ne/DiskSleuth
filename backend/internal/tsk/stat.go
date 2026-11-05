package tsk

/*
#include <stdlib.h>
#include <tsk/libtsk.h>

typedef struct {
	unsigned long long addr;
	int meta_type;
	int meta_flags;
	long long size;
	long long crtime, mtime, atime, ctime;
} ds_meta;

static int ds_fill_meta(TSK_FS_FILE *f, ds_meta *out) {
	if (f == NULL || f->meta == NULL) return 0;
	out->addr = (unsigned long long)f->meta->addr;
	out->meta_type = (int)f->meta->type;
	out->meta_flags = (int)f->meta->flags;
	out->size = (long long)f->meta->size;
	out->crtime = (long long)f->meta->crtime;
	out->mtime = (long long)f->meta->mtime;
	out->atime = (long long)f->meta->atime;
	out->ctime = (long long)f->meta->ctime;
	return 1;
}

static int ds_stat_path(TSK_FS_INFO *fs, const char *path, ds_meta *out) {
	TSK_FS_FILE *f = tsk_fs_file_open(fs, NULL, path);
	int ok = ds_fill_meta(f, out);
	if (f) tsk_fs_file_close(f);
	return ok;
}

static int ds_stat_inode(TSK_FS_INFO *fs, unsigned long long inode, ds_meta *out) {
	TSK_FS_FILE *f = tsk_fs_file_open_meta(fs, NULL, (TSK_INUM_T)inode);
	int ok = ds_fill_meta(f, out);
	if (f) tsk_fs_file_close(f);
	return ok;
}
*/
import "C"

import (
	"path"
	"runtime"
	"unsafe"
)

func metaEntry(m *C.ds_meta, name string) Entry {
	return Entry{
		Name:     name,
		Inode:    uint64(m.addr),
		IsDir:    m.meta_type == C.TSK_FS_META_TYPE_DIR || m.meta_type == C.TSK_FS_META_TYPE_VIRT_DIR,
		Size:     int64(m.size),
		Deleted:  m.meta_flags&C.TSK_FS_META_FLAG_UNALLOC != 0,
		Created:  int64(m.crtime),
		Modified: int64(m.mtime),
		Accessed: int64(m.atime),
		Changed:  int64(m.ctime),
	}
}

// Lookup finds a file by path ("/" separated, case-insensitive on NTFS). Returns ok=false when it does not exist.
func (fs *FS) Lookup(p string) (Entry, bool) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	cp := C.CString(p)
	defer C.free(unsafe.Pointer(cp))
	var m C.ds_meta
	if C.ds_stat_path(fs.ptr, cp, &m) == 0 {
		C.tsk_error_reset()
		return Entry{}, false
	}
	return metaEntry(&m, path.Base(p)), true
}

// StatInode returns the metadata of an inode (the name is unknown, Name is empty).
func (fs *FS) StatInode(inode uint64) (Entry, bool) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var m C.ds_meta
	if C.ds_stat_inode(fs.ptr, C.ulonglong(inode), &m) == 0 {
		C.tsk_error_reset()
		return Entry{}, false
	}
	return metaEntry(&m, ""), true
}
