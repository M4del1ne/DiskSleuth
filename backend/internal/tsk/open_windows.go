//go:build windows

package tsk

/*
#include <stdlib.h>
#include <tsk/libtsk.h>

// On Windows TSK_TCHAR is a UTF-16 WCHAR; use the wide API directly so non-ASCII paths never go through the ANSI code page.
static TSK_IMG_INFO *go_img_open_w(int n, WCHAR **paths, int itype) {
	return tsk_img_open(n, (const TSK_TCHAR *const *)paths, (TSK_IMG_TYPE_ENUM)itype, 0);
}
*/
import "C"

import (
	"runtime"
	"syscall"
	"unsafe"
)

const (
	imgTypeRaw = int(C.TSK_IMG_TYPE_RAW)
	imgTypeEWF = int(C.TSK_IMG_TYPE_EWF_EWF)
)

func openNative(paths []string, itype int) (*Image, error) {
	// the pointer array and strings live in C memory (cgo forbids passing memory containing Go pointers to C)
	arr := (*[1 << 16]*C.WCHAR)(C.malloc(C.size_t(len(paths)) * C.size_t(unsafe.Sizeof(uintptr(0)))))[:len(paths):len(paths)]
	defer C.free(unsafe.Pointer(&arr[0]))
	for i, p := range paths {
		u16, err := syscall.UTF16FromString(p)
		if err != nil {
			return nil, err
		}
		buf := C.malloc(C.size_t(len(u16) * 2))
		copy((*[1 << 30]uint16)(buf)[:len(u16):len(u16)], u16)
		arr[i] = (*C.WCHAR)(buf)
		defer C.free(buf)
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ptr := C.go_img_open_w(C.int(len(paths)), &arr[0], C.int(itype))
	if ptr == nil {
		return nil, lastError("open image " + paths[0])
	}
	return &Image{ptr: ptr}, nil
}
