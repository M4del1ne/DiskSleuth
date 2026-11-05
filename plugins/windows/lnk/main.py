"""Shortcut files (LNK): find every .lnk through the file index, read it and parse it with LnkParse3."""
import io

import LnkParse3

from disksleuth import dt_to_text, unix_to_text


def pick(d: dict, *keys, default=""):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return default


def as_time(v) -> str:
    """LnkParse3 returns datetime or None."""
    try:
        return dt_to_text(v)
    except Exception:
        return str(v or "")


def parse(data: bytes) -> dict:
    j = LnkParse3.lnk_file(io.BytesIO(data)).get_json()
    header = j.get("header", {})
    info = j.get("link_info", {}) or {}
    strings = j.get("data", {}) or {}
    extra = j.get("extra", {}) or {}
    vol = info.get("location_info", {}) or {}
    tracker = extra.get("DISTRIBUTED_LINK_TRACKER_BLOCK", {}) or {}

    target = pick(info, "local_base_path", "common_path_suffix")
    if info.get("common_network_relative_link"):
        net = info["common_network_relative_link"]
        target = target or pick(net, "net_name") + "\\" + pick(info, "common_path_suffix")
    target = target or pick(strings, "relative_path")
    if not target:
        # only shell items (e.g. an item under "Computer"): build a readable path from them
        items = (j.get("target", {}) or {}).get("items", []) or []
        target = "\\".join(str(pick(i, "primary_name", "data", "class")) for i in items if isinstance(i, dict)).strip("\\")

    volume = " / ".join(x for x in (
        str(pick(vol, "drive_type")), str(pick(vol, "drive_serial_number")), str(pick(vol, "volume_label")),
    ) if x)
    return {
        "target": target,
        "args": pick(strings, "command_line_arguments"),
        "targetModified": as_time(header.get("modified_time")),
        "targetCreated": as_time(header.get("creation_time")),
        "targetAccessed": as_time(header.get("accessed_time")),
        "targetSize": header.get("file_size") or 0,
        "volume": volume,
        "machine": pick(tracker, "machine_identifier"),
    }


def run(ctx):
    files = list(ctx.iter_find(ext="lnk", deleted=True))
    total = len(files)
    ctx.log(f"{total} .lnk files in the index")
    bad = 0
    for i, f in enumerate(files):
        ctx.progress(i / max(total, 1), f"{i}/{total}")
        if f["size"] <= 0 or f["size"] > 1 << 20:
            continue
        try:
            row = parse(ctx.read(f))
        except Exception as e:
            bad += 1
            row = {"target": f"(cannot parse: {type(e).__name__})"}
        ctx.emit("lnk", {
            "name": f["name"],
            **row,
            "lnkModified": unix_to_text(f["modified"]),
            "deleted": bool(f["deleted"]),
            "path": f"p{f['part']}:{f['path']}",
        }, file=f)
    if bad:
        ctx.log(f"{bad} files could not be parsed (mostly deleted files whose data was overwritten)")
