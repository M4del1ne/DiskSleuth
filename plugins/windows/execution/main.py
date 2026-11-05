"""Program execution evidence from the registry: UserAssist, ShimCache (AppCompatCache) and BAM."""
import struct

from disksleuth import filetime_to_text
from winreg_util import (CONFIG, as_bytes, current_control_set, get_key, get_value, get_value_of, open_hive, rot13,
                         subkeys, try_open_hive, user_hives, values)

USERASSIST = r"\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist"
UA_KINDS = {
    "{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}": "Program",
    "{F4E57C4B-2036-45F0-A9AB-443BCFE33D9F}": "Shortcut",
    "{75048700-EF1F-11D0-9888-006097DEACF9}": "Program",   # Windows XP
    "{5E6AB780-7743-11CF-A12B-00AA004AE837}": "Shortcut",  # Windows XP
}
# known folder GUIDs that UserAssist uses instead of paths
KNOWN_FOLDERS = {
    "{6D809377-6AF0-444B-8957-A3773F02200E}": "%ProgramFiles%",
    "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}": "%ProgramFiles(x86)%",
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}": "%SystemRoot%\\System32",
    "{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}": "%SystemRoot%\\SysWOW64",
    "{F38BF404-1D43-42F2-9305-67DE0B28FC23}": "%SystemRoot%",
    "{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}": "%ProgramData%\\Microsoft\\Windows\\Start Menu\\Programs",
    "{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}": "%AppData%\\Microsoft\\Windows\\Start Menu\\Programs",
    "{9E3995AB-1F9C-4F13-B827-48B24B6C7174}": "%AppData%\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned",
    "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}": "%UserProfile%\\Desktop",
    "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}": "%UserProfile%\\Documents",
    "{374DE290-123F-4565-9164-39C4925E467B}": "%UserProfile%\\Downloads",
}


def expand_known(name: str) -> str:
    for guid, path in KNOWN_FOLDERS.items():
        if name.upper().startswith(guid):
            return path + name[len(guid):]
    return name


def duration(ms: int) -> str:
    s = ms // 1000
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s else ""


def run(ctx):
    ctx.progress(0.05, "UserAssist")
    for user, path, hive in user_hives(ctx):
        for guid_key in subkeys(get_key(hive, USERASSIST)):
            kind = UA_KINDS.get(guid_key.name.upper(), "")
            count_key = next((k for k in subkeys(guid_key) if k.name.lower() == "count"), None)
            for name, data in values(count_key):
                program = expand_known(rot13(name))
                if program.upper().startswith("UEME_"):
                    continue  # session markers, not programs
                b = as_bytes(data)
                if len(b) >= 72:  # Windows 7+
                    runs, focus, focus_ms = struct.unpack_from("<III", b, 4)
                    last = filetime_to_text(struct.unpack_from("<Q", b, 60)[0])
                elif len(b) >= 16:  # Windows XP: count starts at 5
                    runs, focus, focus_ms = max(0, struct.unpack_from("<I", b, 4)[0] - 5), 0, 0
                    last = filetime_to_text(struct.unpack_from("<Q", b, 8)[0])
                else:
                    continue
                ctx.emit("userassist", {
                    "user": user, "program": program, "runCount": runs, "lastRun": last,
                    "focusCount": focus or "", "focusTime": duration(focus_ms), "kind": kind,
                    "source": f"{user}\\NTUSER.DAT{USERASSIST}\\{guid_key.name}\\Count > {name}",
                }, file=path)

    system = open_hive(ctx, CONFIG + "SYSTEM")
    cs = current_control_set(system)
    ctx.progress(0.5, "ShimCache")
    shim_key = rf"\{cs}\Control\Session Manager\AppCompatCache"
    raw = as_bytes(get_value(system, shim_key, "AppCompatCache"))
    if not raw:  # Windows XP keeps it under AppCompatibility
        shim_key = rf"\{cs}\Control\Session Manager\AppCompatibility"
        raw = as_bytes(get_value(system, shim_key, "AppCompatCache"))
    arch = str(get_value(system, rf"\{cs}\Control\Session Manager\Environment", "PROCESSOR_ARCHITECTURE") or "")
    try:
        entries = parse_shimcache(raw, x64="64" in arch)
    except Exception as e:
        entries = []
        ctx.warn(f"cannot parse AppCompatCache ({len(raw)} bytes): {e}")
    for i, (path, modified, executed) in enumerate(entries, 1):
        ctx.emit("shimcache", {"order": i, "path": path, "modified": modified, "executed": executed,
                               "source": f"SYSTEM{shim_key} > AppCompatCache"}, file=CONFIG + "SYSTEM")
    if raw and not entries:
        ctx.log(f"AppCompatCache format not recognized (header {raw[:4].hex()})")

    ctx.progress(0.8, "BAM")
    users = sid_names(ctx)
    for root in (rf"\{cs}\Services\bam\UserSettings", rf"\{cs}\Services\bam\State\UserSettings"):
        for sid_key in subkeys(get_key(system, root)):
            for name, data in values(sid_key):
                b = as_bytes(data)
                if len(b) < 8 or not name.startswith("\\"):
                    continue  # Version / SequenceNumber values
                ctx.emit("bam", {"user": users.get(sid_key.name, ""), "program": name,
                                 "lastRun": filetime_to_text(struct.unpack_from("<Q", b)[0]), "sid": sid_key.name,
                                 "source": rf"SYSTEM{root}\{sid_key.name} > {name}"}, file=CONFIG + "SYSTEM")


def sid_names(ctx) -> dict[str, str]:
    """SID -> profile folder name, from SOFTWARE ProfileList."""
    software = try_open_hive(ctx, CONFIG + "SOFTWARE")
    out = {}
    for k in subkeys(get_key(software, r"\Microsoft\Windows NT\CurrentVersion\ProfileList")) if software else []:
        p = str(get_value_of(k, "ProfileImagePath") or "")
        out[k.name] = p.replace("/", "\\").rstrip("\\").split("\\")[-1]
    return out


def parse_shimcache(b: bytes, x64: bool) -> list[tuple[str, str, str]]:
    """Return (path, last modified, executed flag) in cache order (most recent first)."""
    if len(b) < 8:
        return []
    magic = struct.unpack_from("<I", b, 0)[0]
    if magic in (0xBADC0FEE, 0xBADC0FFE):  # Windows 7 / 2008 R2 (…0FEE), Vista / 2008 (…0FFE)
        win7 = magic == 0xBADC0FEE
        count = struct.unpack_from("<I", b, 4)[0]
        out = []
        off = 0x80 if win7 else 8
        size = (48 if x64 else 32) if win7 else (32 if x64 else 24)
        for _ in range(count):
            if off + size > len(b):
                break
            if win7 and x64:
                ln, _mx, _pad, path_off, mtime, insert_flags, _shim, _dsz, _doff = struct.unpack_from("<HHIQQIIQQ", b, off)
            elif win7:
                ln, _mx, path_off, mtime, insert_flags, _shim, _dsz, _doff = struct.unpack_from("<HHIQIIII", b, off)
            elif x64:
                ln, _mx, _pad, path_off, mtime, insert_flags, _shim = struct.unpack_from("<HHIQQII", b, off)
            else:
                ln, _mx, path_off, mtime, insert_flags, _shim = struct.unpack_from("<HHIQII", b, off)
            path = b[path_off:path_off + ln].decode("utf-16-le", "replace")
            out.append((path.replace("\\??\\", ""), filetime_to_text(mtime), "Yes" if insert_flags & 0x2 else ""))
            off += size
        return out
    if magic in (0x30, 0x34) or b[magic:magic + 4] in (b"10ts", b"00ts"):  # Windows 8.1 / 10 / 11
        off = magic
        out = []
        while off + 12 <= len(b) and b[off:off + 4] in (b"10ts", b"00ts"):
            entry_size = struct.unpack_from("<I", b, off + 8)[0]
            p = off + 12
            ln = struct.unpack_from("<H", b, p)[0]
            path = b[p + 2:p + 2 + ln].decode("utf-16-le", "replace")
            mtime = struct.unpack_from("<Q", b, p + 2 + ln)[0]
            out.append((path.replace("\\??\\", ""), filetime_to_text(mtime), ""))
            off += 12 + entry_size
        return out
    if magic == 0xDEADBEEF:  # Windows XP: 96 fixed entries of 552 bytes
        count = struct.unpack_from("<I", b, 4)[0]
        out = []
        for i in range(min(count, 96)):
            e = 400 + i * 552
            if e + 552 > len(b):
                break
            path = b[e:e + 528].decode("utf-16-le", "replace").split("\x00", 1)[0]
            mtime = struct.unpack_from("<Q", b, e + 528)[0]
            out.append((path, filetime_to_text(mtime), ""))
        return out
    return []
