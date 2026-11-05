"""Registry MRU lists per user: RecentDocs, RunMRU, TypedPaths / TypedURLs, WordWheelQuery.

Only the most recent item of an MRU list has a time: the key's last write time is when it was added."""
from winreg_util import as_bytes, get_key, get_value_of, key_last_write, mru_order, subkeys, user_hives, values

EXPLORER = r"\Software\Microsoft\Windows\CurrentVersion\Explorer"


def utf16_name(b: bytes) -> str:
    """RecentDocs / WordWheelQuery values start with a NUL-terminated UTF-16 string (a shell item may follow)."""
    for i in range(0, len(b) - 1, 2):
        if b[i] == 0 and b[i + 1] == 0:
            return b[:i].decode("utf-16-le", "replace")
    return b.decode("utf-16-le", "replace")


def ordered(key):
    """Yield (position, value name, data) in MRUListEx order."""
    vals = {name: data for name, data in values(key)}
    for pos, n in enumerate(mru_order(key), 1):
        if str(n) in vals:
            yield pos, str(n), vals[str(n)]


def run(ctx):
    for user, path, hive in user_hives(ctx):
        label = f"{user}\\NTUSER.DAT"

        rd = get_key(hive, EXPLORER + r"\RecentDocs")
        if rd is not None:
            # the main key lists everything; subkeys (.docx, .txt, Folder...) give the extension of each name
            ext_of = {}
            for sk in subkeys(rd):
                for _pos, _n, data in ordered(sk):
                    ext_of.setdefault(utf16_name(as_bytes(data)), sk.name)
            last = key_last_write(rd)
            for pos, n, data in ordered(rd):
                name = utf16_name(as_bytes(data))
                ctx.emit("recentdocs", {"user": user, "order": pos, "name": name, "extension": ext_of.get(name, ""),
                                        "opened": last if pos == 1 else "", "source": rf"{label}{EXPLORER}\RecentDocs > {n}"}, file=path)

        run_key = get_key(hive, EXPLORER + r"\RunMRU")
        if run_key is not None:
            order = str(get_value_of(run_key, "MRUList") or "")
            vals = {name: data for name, data in values(run_key)}
            last = key_last_write(run_key)
            for pos, letter in enumerate(order, 1):
                cmd = str(vals.get(letter, ""))
                if cmd.endswith("\\1"):
                    cmd = cmd[:-2]
                ctx.emit("runmru", {"user": user, "order": pos, "command": cmd, "lastUsed": last if pos == 1 else "",
                                    "source": rf"{label}{EXPLORER}\RunMRU > {letter}"}, file=path)

        for kind, kp in (("Explorer address bar", EXPLORER + r"\TypedPaths"),
                         ("Internet Explorer URL", r"\Software\Microsoft\Internet Explorer\TypedURLs")):
            key = get_key(hive, kp)
            items = sorted(((name, v) for name, v in values(key) if name.lower().startswith("url")),
                           key=lambda x: int("".join(c for c in x[0] if c.isdigit()) or 0))
            for pos, (name, v) in enumerate(items, 1):
                ctx.emit("typedpaths", {"user": user, "kind": kind, "order": pos, "value": v,
                                        "lastWrite": key_last_write(key), "source": f"{label}{kp} > {name}"}, file=path)

        ww = get_key(hive, EXPLORER + r"\WordWheelQuery")
        if ww is not None:
            last = key_last_write(ww)
            for pos, n, data in ordered(ww):
                ctx.emit("searchterms", {"user": user, "order": pos, "term": utf16_name(as_bytes(data)),
                                         "lastSearched": last if pos == 1 else "",
                                         "source": rf"{label}{EXPLORER}\WordWheelQuery > {n}"}, file=path)
