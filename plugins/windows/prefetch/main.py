"""Windows Prefetch (*.pf) parser.

Layout (uncompressed, "SCCA"): version u32 @0, signature @4, executable name UTF-16 @0x10 (60 bytes), hash u32 @0x4C,
file information @0x54: metrics/trace/filename-strings/volume offsets and sizes, then run times and run count:
  v17 (XP)        last run @0x78,            run count @0x90
  v23 (Vista/7)   last run @0x80,            run count @0x98
  v26 (8.1)       8 run times @0x80,         run count @0xD0
  v30/31 (10/11)  8 run times @0x80,         run count @0xD0 (or @0xC8 in the shorter variant)
Windows 10+ stores files compressed: "MAM\\x04" + uncompressed size, LZXPRESS Huffman data.
"""
import ctypes
import struct
import sys

from disksleuth import filetime_to_text, unix_to_text


def decompress_mam(data: bytes) -> bytes:
    """Decompress a Windows 10 'MAM\\x04' prefetch file with ntdll!RtlDecompressBufferEx (Windows only)."""
    if sys.platform != "win32":
        raise RuntimeError("compressed (Windows 10+) prefetch files can only be decompressed on Windows")
    size = struct.unpack_from("<I", data, 4)[0]
    ntdll = ctypes.windll.ntdll
    fmt = 4  # COMPRESSION_FORMAT_XPRESS_HUFF
    ws_size, frag = ctypes.c_ulong(), ctypes.c_ulong()
    status = ntdll.RtlGetCompressionWorkSpaceSize(ctypes.c_ushort(fmt), ctypes.byref(ws_size), ctypes.byref(frag))
    if status:
        raise RuntimeError(f"RtlGetCompressionWorkSpaceSize failed: 0x{status & 0xFFFFFFFF:08X}")
    workspace = ctypes.create_string_buffer(ws_size.value)
    out = ctypes.create_string_buffer(size)
    src = ctypes.create_string_buffer(data[8:], len(data) - 8)
    final = ctypes.c_ulong()
    status = ntdll.RtlDecompressBufferEx(ctypes.c_ushort(fmt), out, ctypes.c_ulong(size), src, ctypes.c_ulong(len(data) - 8),
                                         ctypes.byref(final), workspace)
    if status:
        raise RuntimeError(f"RtlDecompressBufferEx failed: 0x{status & 0xFFFFFFFF:08X}")
    return out.raw[:final.value]


def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def u64(b, o):
    return struct.unpack_from("<Q", b, o)[0]


def parse(b: bytes) -> dict:
    if b[:3] == b"MAM":
        b = decompress_mam(b)
    version = u32(b, 0)
    if b[4:8] != b"SCCA":
        raise ValueError("not a prefetch file (no SCCA signature)")
    exe = b[0x10:0x10 + 60].decode("utf-16-le", "replace").split("\x00", 1)[0]
    metrics_off = u32(b, 0x54)
    fn_off, fn_size = u32(b, 0x64), u32(b, 0x68)
    vol_off, vol_count = u32(b, 0x6C), u32(b, 0x70)
    if version == 17:
        times, count = [u64(b, 0x78)], u32(b, 0x90)
    elif version == 23:
        times, count = [u64(b, 0x80)], u32(b, 0x98)
    elif version == 26:
        times, count = [u64(b, 0x80 + 8 * i) for i in range(8)], u32(b, 0xD0)
    elif version in (30, 31):
        times = [u64(b, 0x80 + 8 * i) for i in range(8)]
        count = u32(b, 0xD0) if metrics_off >= 0x130 else u32(b, 0xC8)
    else:
        raise ValueError(f"unsupported prefetch version {version}")
    runs = [filetime_to_text(t) for t in times if t]
    runs = [r for r in runs if r]

    files = []
    if fn_off and fn_size and fn_off + fn_size <= len(b):
        files = [f for f in b[fn_off:fn_off + fn_size].decode("utf-16-le", "replace").split("\x00") if f]
    path = next((f for f in files if f.upper().endswith("\\" + exe.upper())), "")

    volumes = []
    vsize = {17: 40, 23: 104, 26: 104}.get(version, 96)  # volume information entry size
    for i in range(min(vol_count, 16)):
        v = vol_off + i * vsize
        if v + 24 > len(b):
            break
        dev_off, dev_len, created, serial = u32(b, v), u32(b, v + 4), u64(b, v + 8), u32(b, v + 16)
        dev = b[vol_off + dev_off:vol_off + dev_off + dev_len * 2].decode("utf-16-le", "replace")
        volumes.append(f"{dev} ({serial:08X} / {filetime_to_text(created)})")
    return {
        "executable": exe, "runCount": count, "lastRun": runs[0] if runs else "", "previousRuns": ", ".join(runs[1:]),
        "path": path, "volume": "; ".join(volumes), "filesReferenced": len(files), "hash": f"{u32(b, 0x4C):08X}",
        "version": version,
    }


def prefetcher_setting(ctx) -> str:
    """Explain an empty Prefetch folder: EnablePrefetcher 0 = disabled (often on SSDs and VMs), 3 = apps and boot."""
    try:
        from winreg_util import CONFIG, current_control_set, get_value, open_hive
        system = open_hive(ctx, CONFIG + "SYSTEM")
        key = rf"\{current_control_set(system)}\Control\Session Manager\Memory Management\PrefetchParameters"
        return f"EnablePrefetcher = {get_value(system, key, 'EnablePrefetcher')} (SYSTEM{key}; 0 means disabled)"
    except Exception as e:  # regipy missing or no SYSTEM hive
        return f"cannot read EnablePrefetcher: {e}"


def run(ctx):
    pfs = [e for e in ctx.glob("/Windows/Prefetch/*.pf", deleted=True) if not e["isDir"]]
    ctx.log(f"{len(pfs)} prefetch files")
    if not pfs:
        ctx.log("the Prefetch folder has no .pf files; " + prefetcher_setting(ctx))
    bad = 0
    for i, e in enumerate(pfs):
        ctx.progress(i / max(len(pfs), 1), e["name"])
        try:
            row = parse(ctx.read(e))
        except Exception as ex:
            bad += 1
            row = {"executable": e["name"].rsplit("-", 1)[0], "path": f"(cannot parse: {ex})"}
        ctx.emit("prefetch", {**row, "pfCreated": unix_to_text(e["created"]), "pfModified": unix_to_text(e["modified"]),
                              "file": e["path"] + (" (deleted)" if e["deleted"] else "")}, file=e)
    if bad:
        ctx.log(f"{bad} prefetch files could not be parsed")
