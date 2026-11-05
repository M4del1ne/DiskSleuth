package server

import "testing"

func TestNormalizePathRef(t *testing.T) {
	cases := []struct{ in, prefix, path string }{
		{`p2:/Users/a/x.lnk`, "p2:", "/Users/a/x.lnk"},
		{`p2:\Users\a\x.lnk`, "p2:", "/Users/a/x.lnk"},
		{`/Windows/Prefetch/CMD.EXE-1.pf`, "", "/Windows/Prefetch/CMD.EXE-1.pf"},
		{`C:\Users\poiuy\Desktop\新建文本文档.txt`, "", "/Users/poiuy/Desktop/新建文本文档.txt"},
		{`\??\C:\Windows\system32\csrss.exe`, "", "/Windows/system32/csrss.exe"},
		{`\SystemRoot\System32\drivers\ACPI.sys`, "", "/Windows/System32/drivers/ACPI.sys"},
		{`system32\DRIVERS\disk.sys`, "", "/Windows/system32/DRIVERS/disk.sys"},
		{`%SystemRoot%\System32\calc.exe`, "", "/Windows/System32/calc.exe"},
		{`%ProgramFiles(x86)%\Google\Chrome\chrome.exe`, "", "/Program Files (x86)/Google/Chrome/chrome.exe"},
		{`"C:\Program Files\VMware\VMware Tools\vmtoolsd.exe" -n vmusr`, "", "/Program Files/VMware/VMware Tools/vmtoolsd.exe"},
		{`C:\Windows\system32\userinit.exe,`, "", "/Windows/system32/userinit.exe"},
		{`C:\Windows\system32\svchost.exe -k netsvcs`, "", "/Windows/system32/svchost.exe"},
		{`/$Recycle.Bin/S-1-5-21-1-1000/$RK4OF7E.exe`, "", "/$Recycle.Bin/S-1-5-21-1-1000/$RK4OF7E.exe"},
	}
	for _, c := range cases {
		prefix, path, err := normalizePathRef(c.in)
		if err != nil || prefix != c.prefix || path != c.path {
			t.Errorf("%q -> (%q, %q, %v), want (%q, %q)", c.in, prefix, path, err, c.prefix, c.path)
		}
	}
	for _, bad := range []string{"", "  ", `%APPDATA%\x.exe`} {
		if _, _, err := normalizePathRef(bad); err == nil {
			t.Errorf("%q should fail", bad)
		}
	}
}
