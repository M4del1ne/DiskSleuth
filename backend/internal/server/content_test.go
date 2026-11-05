package server

import (
	"strings"
	"testing"
)

func TestAsciiLowerKeepsLength(t *testing.T) {
	src := []byte{'A', 0xff, 'b', 0xc3, 'Z'} // invalid UTF-8
	got := asciiLower(nil, src)
	if len(got) != len(src) || got[0] != 'a' || got[4] != 'z' || got[1] != 0xff {
		t.Fatalf("asciiLower = %v", got)
	}
}

func TestContextUTF16(t *testing.T) {
	// misaligned "Computer" (one extra byte in front) + an aligned host name
	buf := append([]byte{0x00}, utf16le("Computer")...)
	buf = append(buf, 0x00) // realign what follows
	at := len(buf)
	buf = append(buf, utf16le("WIN-49I0SNRJAMF")...)
	ctx := contextAround(buf, at, len(utf16le("win-49i0snrjamf")), "UTF-16LE")
	if !strings.Contains(ctx, "WIN-49I0SNRJAMF") {
		t.Fatalf("context is missing the hit text: %q", ctx)
	}
	if strings.ContainsAny(ctx, "漀洀瀀甀琀攀爀") {
		t.Fatalf("misaligned characters were not filtered: %q", ctx)
	}
}

func TestUTF16Pattern(t *testing.T) {
	if got := utf16le("密码"); len(got) != 4 || got[0] != 0xc6 || got[1] != 0x5b {
		t.Fatalf("utf16le(密码) = % x", got)
	}
}
