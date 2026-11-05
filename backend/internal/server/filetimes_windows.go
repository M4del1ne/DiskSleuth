package server

import (
	"os"
	"syscall"
	"time"
)

// setFileTimes restores creation, modification and access times on an exported file (Unix seconds, 0 = unknown).
func setFileTimes(f *os.File, created, modified, accessed int64) error {
	ft := func(sec int64) *syscall.Filetime {
		if sec == 0 {
			return nil // leave this time unchanged
		}
		v := syscall.NsecToFiletime(time.Unix(sec, 0).UnixNano())
		return &v
	}
	return syscall.SetFileTime(syscall.Handle(f.Fd()), ft(created), ft(accessed), ft(modified))
}
