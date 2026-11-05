"""Recycle Bin: $Recycle.Bin\\<SID>\\$I* records (Vista+) and RECYCLER\\<SID>\\INFO2 (XP).

$I v1 (Vista/7/8): version u64 = 1, size u64, deletion FILETIME, path UTF-16 (520 bytes) @24
$I v2 (Windows 10+): version u64 = 2, size u64, deletion FILETIME, path length u32 (chars) @24, path @28
INFO2 (XP): record size u32 @12, records from @20: ANSI path (260), index u32, drive u32, FILETIME, size u32, UTF-16 path (520)
"""
import struct
import sys

from disksleuth import filetime_to_text
from winreg_util import CONFIG, get_key, get_value_of, subkeys, try_open_hive


def parse_i(b: bytes) -> tuple[str, int, str]:
    version, size, ft = struct.unpack_from("<QQQ", b, 0)
    if version == 1:
        path = b[24:24 + 520].decode("utf-16-le", "replace")
    elif version == 2:
        n = struct.unpack_from("<I", b, 24)[0]
        path = b[28:28 + n * 2].decode("utf-16-le", "replace")
    else:
        raise ValueError(f"unknown $I version {version}")
    return path.split("\x00", 1)[0], size, filetime_to_text(ft)


def sid_names(ctx) -> dict[str, str]:
    software = try_open_hive(ctx, CONFIG + "SOFTWARE")
    out = {}
    for k in subkeys(get_key(software, r"\Microsoft\Windows NT\CurrentVersion\ProfileList")) if software else []:
        p = str(get_value_of(k, "ProfileImagePath") or "")
        out[k.name.upper()] = p.replace("/", "\\").rstrip("\\").split("\\")[-1]
    return out


def run(ctx):
    users = sid_names(ctx)
    total = 0
    for sid_dir in ctx.glob("/$Recycle.Bin/*", deleted=True):
        if not sid_dir["isDir"]:
            continue
        sid = sid_dir["name"]
        entries = ctx.listdir(sid_dir)
        for e in entries:
            e["path"] = f"{sid_dir['path']}/{e['name']}"
        names = {e["name"].upper(): e for e in entries if not e["deleted"]}
        for e in entries:
            if e["isDir"] or not e["name"].upper().startswith("$I"):
                continue
            try:
                path, size, deleted = parse_i(ctx.read(e))
            except Exception as ex:
                ctx.log(f"cannot parse {sid}/{e['name']}: {ex}")
                continue
            r_name = "$R" + e["name"][2:]
            ctx.emit("recyclebin", {
                "deleted": deleted, "user": users.get(sid.upper(), ""), "originalPath": path, "size": size,
                "contentFile": r_name, "contentPresent": r_name.upper() in names, "emptied": e["deleted"],
                "sid": sid, "source": f"{sid_dir['path']}/{e['name']}",
            }, file=names.get(r_name.upper(), e))
            total += 1

    # Windows XP
    for info2 in ctx.glob("/RECYCLER/*/INFO2", deleted=True):
        b = ctx.read(info2)
        if len(b) < 20:
            continue
        rec = struct.unpack_from("<I", b, 12)[0] or 800
        sid = info2["path"].split("/")[-2]
        for off in range(20, len(b) - rec + 1, rec):
            # the ANSI copy uses the system code page; the UTF-16 copy below is preferred when present
            ansi = b[off:off + 260].split(b"\x00", 1)[0].decode("mbcs" if sys.platform == "win32" else "latin1", "replace")
            idx, drive, ft, size = struct.unpack_from("<IIQI", b, off + 260)
            uni = b[off + 280:off + 280 + 520].decode("utf-16-le", "replace").split("\x00", 1)[0] if rec >= 800 else ""
            ctx.emit("recyclebin", {
                "deleted": filetime_to_text(ft), "user": users.get(sid.upper(), ""), "originalPath": uni or ansi,
                "size": size, "contentFile": f"D{chr(ord('a') + drive)}{idx}", "contentPresent": "", "emptied": "",
                "sid": sid, "source": info2["path"],
            }, file=info2)
            total += 1
    ctx.log(f"{total} recycle bin records")
