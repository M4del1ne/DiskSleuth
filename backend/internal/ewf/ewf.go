//go:build windows

// Package ewf calls libewf directly to read the acquisition metadata and hashes stored in an E01 (TSK does not expose these).
package ewf

/*
#cgo CFLAGS: -I${SRCDIR}/../../../deps/include
#cgo LDFLAGS: -L${SRCDIR}/../../../deps/lib -lewf -lz -static
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <libewf.h>

static void ds_err(libewf_error_t **e, char *buf, size_t n) {
	if (e && *e) { libewf_error_sprint(*e, buf, n); libewf_error_free(e); }
}

static libewf_handle_t *ds_open(const wchar_t *path, char *err, size_t errlen, int *segments) {
	wchar_t **names = NULL; int n = 0; libewf_error_t *e = NULL; libewf_handle_t *h = NULL;
	if (libewf_glob_wide(path, wcslen(path), LIBEWF_FORMAT_UNKNOWN, &names, &n, &e) != 1) { ds_err(&e, err, errlen); return NULL; }
	if (libewf_handle_initialize(&h, &e) != 1) { ds_err(&e, err, errlen); libewf_glob_wide_free(names, n, NULL); return NULL; }
	if (libewf_handle_open_wide(h, names, n, LIBEWF_OPEN_READ, &e) != 1) {
		ds_err(&e, err, errlen); libewf_handle_free(&h, NULL); libewf_glob_wide_free(names, n, NULL); return NULL;
	}
	libewf_glob_wide_free(names, n, NULL);
	libewf_handle_set_header_values_date_format(h, LIBEWF_DATE_FORMAT_ISO8601, NULL);
	*segments = n;
	return h;
}

static int ds_header(libewf_handle_t *h, const char *id, char *out, size_t n) {
	return libewf_handle_get_utf8_header_value(h, (const uint8_t *)id, strlen(id), (uint8_t *)out, n, NULL);
}

static int ds_hash(libewf_handle_t *h, const char *id, char *out, size_t n) {
	return libewf_handle_get_utf8_hash_value(h, (const uint8_t *)id, strlen(id), (uint8_t *)out, n, NULL);
}

static void ds_close(libewf_handle_t *h) { libewf_handle_close(h, NULL); libewf_handle_free(&h, NULL); }
*/
import "C"

import (
	"errors"
	"strings"
	"syscall"
	"unsafe"
)

// Info is the acquisition metadata and stored hashes of an E01. Fields may be empty if the imaging tool did not write them.
type Info struct {
	Segments        int    `json:"segments"`
	CaseNumber      string `json:"caseNumber"`
	EvidenceNumber  string `json:"evidenceNumber"`
	Examiner        string `json:"examiner"`
	Description     string `json:"description"`
	Notes           string `json:"notes"`
	AcquiredAt      string `json:"acquiredAt"` // ISO8601, acquisition machine local time (E01 stores no time zone)
	AcquiryOS       string `json:"acquiryOs"`
	AcquirySoftware string `json:"acquirySoftware"`
	StoredMD5       string `json:"storedMd5"`
	StoredSHA1      string `json:"storedSha1"`
}

// ReadInfo opens an E01 (pass the first segment) and reads its metadata.
func ReadInfo(path string) (*Info, error) {
	u16, err := syscall.UTF16FromString(path)
	if err != nil {
		return nil, err
	}
	wpath := C.malloc(C.size_t(len(u16) * 2))
	defer C.free(wpath)
	copy(unsafe.Slice((*uint16)(wpath), len(u16)), u16)

	errbuf := (*C.char)(C.malloc(1024))
	defer C.free(unsafe.Pointer(errbuf))
	*errbuf = 0
	var segs C.int
	h := C.ds_open((*C.wchar_t)(wpath), errbuf, 1024, &segs)
	if h == nil {
		return nil, errors.New("libewf: " + strings.TrimSpace(C.GoString(errbuf)))
	}
	defer C.ds_close(h)

	buf := (*C.char)(C.malloc(512))
	defer C.free(unsafe.Pointer(buf))
	get := func(fn func(*C.libewf_handle_t, *C.char, *C.char, C.size_t) C.int, id string) string {
		cid := C.CString(id)
		defer C.free(unsafe.Pointer(cid))
		if fn(h, cid, buf, 512) != 1 {
			return ""
		}
		return strings.TrimSpace(C.GoString(buf))
	}
	header := func(h *C.libewf_handle_t, id, out *C.char, n C.size_t) C.int { return C.ds_header(h, id, out, n) }
	hash := func(h *C.libewf_handle_t, id, out *C.char, n C.size_t) C.int { return C.ds_hash(h, id, out, n) }

	sw := get(header, "acquiry_software")
	if v := get(header, "acquiry_software_version"); v != "" {
		sw = strings.TrimSpace(sw + " " + v)
	}
	return &Info{
		Segments:        int(segs),
		CaseNumber:      get(header, "case_number"),
		EvidenceNumber:  get(header, "evidence_number"),
		Examiner:        get(header, "examiner_name"),
		Description:     get(header, "description"),
		Notes:           get(header, "notes"),
		AcquiredAt:      get(header, "acquiry_date"),
		AcquiryOS:       get(header, "acquiry_operating_system"),
		AcquirySoftware: sw,
		StoredMD5:       strings.ToLower(get(hash, "MD5")),
		StoredSHA1:      strings.ToLower(get(hash, "SHA1")),
	}, nil
}
