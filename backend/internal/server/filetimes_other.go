//go:build !windows

package server

import (
	"os"
	"time"
)

// setFileTimes restores modification and access times (other systems have no settable creation time).
func setFileTimes(f *os.File, _, modified, accessed int64) error {
	if modified == 0 {
		return nil
	}
	if accessed == 0 {
		accessed = modified
	}
	return os.Chtimes(f.Name(), time.Unix(accessed, 0), time.Unix(modified, 0))
}
