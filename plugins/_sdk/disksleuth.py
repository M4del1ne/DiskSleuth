"""DiskSleuth plugin SDK.

A plugin is a Python module with a ``run(ctx)`` function. ``ctx`` is the :class:`Context`
defined here: use it to read files from the evidence, find files and emit results.
Plugins never touch the image directly; every read goes through the backend (read-only).

Protocol (plugin authors do not need it): one JSON object per line on stdin/stdout.
  request       {"id": 1, "method": "read", "params": {...}}  -> {"id": 1, "result": ...} or {"id": 1, "error": "..."}
  notification  {"method": "emit", "params": {...}}           (no id, no reply)
print() inside a plugin is redirected to stderr and ends up in the run log.
"""
from __future__ import annotations

import base64
import datetime as _dt
import fnmatch
import io
import json
import os
import re
import shutil
import time
from typing import Any, BinaryIO, Iterable, Iterator

__all__ = [
    "API_VERSION", "Context", "PluginError",
    "filetime_to_text", "unix_to_text", "dt_to_text",
]

API_VERSION = 1

# profile folders that are not real users
_SYSTEM_PROFILES = {"public", "default", "default user", "all users", "defaultapppool", "desktop.ini"}


class PluginError(Exception):
    """An error reported by the backend (e.g. file not found)."""


# ---------------- transport ----------------

class _Rpc:
    def __init__(self, rin: BinaryIO, rout: BinaryIO):
        self._in, self._out, self._seq = rin, rout, 0

    def _send(self, msg: dict) -> None:
        try:
            self._out.write(json.dumps(msg, ensure_ascii=False, default=str).encode("utf-8") + b"\n")
            self._out.flush()
        except (BrokenPipeError, OSError) as e:
            raise PluginError("backend disconnected") from e

    def call(self, method: str, **params: Any) -> Any:
        self._seq += 1
        self._send({"id": self._seq, "method": method, "params": params})
        line = self._in.readline()
        if not line:
            raise PluginError("backend disconnected")
        resp = json.loads(line)
        if resp.get("error"):
            raise PluginError(resp["error"])
        return resp.get("result")

    def notify(self, method: str, **params: Any) -> None:
        self._send({"method": method, "params": params})


# ---------------- file object ----------------

class RemoteFile(io.RawIOBase):
    """Read-only, seekable file object for a file inside the evidence (read in chunks on demand)."""

    CHUNK = 1 << 20

    def __init__(self, ctx: "Context", ref: dict, size: int):
        self._ctx, self._ref, self._size, self._pos = ctx, ref, size, 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = 0) -> int:
        base = {0: 0, 1: self._pos, 2: self._size}[whence]
        self._pos = max(0, base + offset)
        return self._pos

    def readinto(self, b) -> int:
        if self._pos >= self._size:
            return 0
        n = min(len(b), self._size - self._pos, self.CHUNK)
        data = self._ctx._read_chunk(self._ref, self._pos, n)
        b[: len(data)] = data
        self._pos += len(data)
        return len(data)


# ---------------- context ----------------

class Context:
    """Plugin run context.

    Paths: ``"/Windows/System32/config/SYSTEM"`` refers to the system partition (the one containing
    the Windows directory, else the first recognized one); ``"p3:/data/a.txt"`` selects partition 3.
    Lookups are case-insensitive on NTFS. Anywhere a path is accepted you may also pass an entry dict
    returned by :meth:`find`, :meth:`listdir`, :meth:`glob` or :meth:`walk` (located by partition + inode,
    so deleted files work too).
    """

    def __init__(self, rpc: _Rpc, info: dict):
        self._rpc = rpc
        self.api: int = info.get("api", 1)
        self.evidence: dict = info.get("evidence", {})
        self.plugin: dict = info.get("plugin", {})
        self.workdir: str = info.get("workdir") or os.getcwd()
        self._pending: dict[str, list] = {}
        self._pending_n = 0
        self._last_progress = 0.0

    # ---- file system ----
    def partitions(self) -> list[dict]:
        """Partitions with a recognized file system: [{index, fsType, system}]."""
        return self._rpc.call("partitions")

    @staticmethod
    def _ref(target) -> dict:
        if isinstance(target, dict):
            return {"part": target["part"], "inode": target["inode"]}
        return {"path": str(target)}

    def stat(self, target) -> dict | None:
        """File info, or None when it does not exist."""
        return self._rpc.call("stat", **self._ref(target))

    def exists(self, target) -> bool:
        return self.stat(target) is not None

    def listdir(self, target) -> list[dict]:
        """List a directory (deleted entries included).
        Entry: {name, part, inode, isDir, size, deleted, created, modified, accessed, changed} (times are Unix seconds, UTC)."""
        return self._rpc.call("list", **self._ref(target))

    def _read_chunk(self, ref: dict, offset: int, length: int) -> bytes:
        r = self._rpc.call("read", offset=offset, length=length, **ref)
        return base64.b64decode(r["data"])

    def read(self, target, offset: int = 0, length: int | None = None) -> bytes:
        """Read file content (the whole file by default)."""
        ref = self._ref(target)
        if length is None:
            st = target if isinstance(target, dict) and "size" in target else self.stat(target)
            if st is None:
                raise PluginError(f"file not found: {target}")
            length = max(0, st["size"] - offset)
        out = bytearray()
        while length > 0:
            chunk = self._read_chunk(ref, offset, min(length, 4 << 20))
            if not chunk:
                break
            out += chunk
            offset += len(chunk)
            length -= len(chunk)
        return bytes(out)

    def open(self, target) -> io.BufferedReader:
        """Open as a read-only, seekable file object (for parsers that want a file object)."""
        st = self.stat(target)
        if st is None:
            raise PluginError(f"file not found: {target}")
        return io.BufferedReader(RemoteFile(self, self._ref(target), st["size"]), buffer_size=1 << 16)

    def export(self, target, dest_dir: str | None = None) -> str:
        """Copy a file out of the evidence and return its local path.

        Without ``dest_dir`` the backend exports it to the case work folder (each file once).
        With ``dest_dir`` the file is written there under its original name, which keeps sets of
        files together, e.g. a SQLite database with its ``-wal`` / ``-journal`` file."""
        if dest_dir is None:
            return self._rpc.call("export", **self._ref(target))["path"]
        st = self.stat(target)
        if st is None:
            raise PluginError(f"file not found: {target}")
        name = (target.get("name") if isinstance(target, dict) else None) or st.get("name") \
            or str(target).replace("\\", "/").rsplit("/", 1)[-1] or "file"
        os.makedirs(dest_dir, exist_ok=True)
        dst = os.path.join(dest_dir, re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name))
        with self.open(target) as src, open(dst, "wb") as out:
            shutil.copyfileobj(src, out, 1 << 20)
        return dst

    def temp_dir(self, name: str = "tmp") -> str:
        """A folder under the plugin work directory, emptied first."""
        d = os.path.join(self.workdir, name)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d, exist_ok=True)
        return d

    def find(self, *, ext: str | None = None, name: str | None = None, path: str | None = None,
             deleted: bool = False, limit: int = 20000, offset: int = 0) -> list[dict]:
        """Search the full file index (it must be built first; declare "index" in requires).
        ext: extension without the dot (case-insensitive); name / path: SQL LIKE patterns, % is the wildcard,
        path uses backslashes, e.g. '%\\AppData\\Roaming\\Microsoft\\Windows\\Recent\\%'.
        Entries also contain path (full path inside the partition)."""
        return self._rpc.call("find", ext=ext, name=name, path=path, deleted=deleted, limit=limit, offset=offset)

    def iter_find(self, *, page: int = 5000, **query) -> Iterator[dict]:
        """Like :meth:`find` but yields every match, fetching pages as needed."""
        offset = 0
        while True:
            batch = self.find(limit=page, offset=offset, **query)
            yield from batch
            if len(batch) < page:
                return
            offset += page

    def walk(self, target, *, deleted: bool = False, max_depth: int | None = None) -> Iterator[dict]:
        """Yield every entry below a directory (depth first). Entries get an extra ``path`` key."""
        base = target if isinstance(target, str) else target.get("path", "")
        stack = [(target, base.rstrip("/"), 0)]
        while stack:
            cur, cur_path, depth = stack.pop()
            try:
                entries = self.listdir(cur)
            except PluginError as e:
                self.log(f"cannot list {cur_path or cur}: {e}")
                continue
            for e in entries:
                if e["deleted"] and not deleted:
                    continue
                e["path"] = f"{cur_path}/{e['name']}"
                yield e
                if e["isDir"] and (max_depth is None or depth + 1 < max_depth):
                    stack.append((e, e["path"], depth + 1))

    def glob(self, pattern: str, *, deleted: bool = False) -> list[dict]:
        """Match a path pattern with * ? [..] wildcards per segment (case-insensitive), e.g.
        ``"/Users/*/NTUSER.DAT"`` or ``"p2:/Users/*/AppData/Local/Google/Chrome/User Data/*/History"``.
        Returns entries with an extra ``path`` key."""
        prefix = ""
        m = re.match(r"^(p\d+:)(.*)$", pattern)
        if m:
            prefix, pattern = m.group(1), m.group(2)
        parts = [p for p in pattern.replace("\\", "/").split("/") if p]
        current: list[tuple[str, dict | None]] = [(prefix + "/", None)]
        for i, seg in enumerate(parts):
            nxt = []
            for path, entry in current:
                base = path.rstrip("/")
                if any(c in seg for c in "*?["):
                    try:
                        children = self.listdir(entry if entry else path)
                    except PluginError:
                        continue
                    for c in children:
                        if c["deleted"] and not deleted:
                            continue
                        if fnmatch.fnmatchcase(c["name"].lower(), seg.lower()):
                            nxt.append((f"{base}/{c['name']}", c))
                else:
                    p = f"{base}/{seg}"
                    st = self.stat(p)
                    if st is not None:
                        nxt.append((p, st))
            current = nxt
            if not current:
                break
        out = []
        for path, entry in current:
            if entry is not None:
                entry = dict(entry)
                entry["path"] = path
                out.append(entry)
        return out

    def user_profiles(self) -> list[dict]:
        """User profile folders: [{name, path, entry}] from /Users (Vista+) and /Documents and Settings (XP)."""
        out = []
        for root in ("/Users", "/Documents and Settings"):
            for e in self.glob(root + "/*"):
                if e["isDir"] and e["name"].lower() not in _SYSTEM_PROFILES:
                    out.append({"name": e["name"], "path": e["path"], "entry": e})
        return out

    # ---- output ----
    def emit(self, table: str, row: dict, file=None) -> None:
        """Emit one row to a table declared in plugin.json.
        Values are normalized: datetime -> 'YYYY-MM-DD HH:MM:SS' (UTC), bytes -> hex, None -> '', bool -> 'Yes'/''.
        file: the evidence file the row was read from (a path or an entry dict). It is stored as the hidden
        field ``_file`` and lets the user jump from the row to that file ("Show source file in Files")."""
        if not isinstance(row, dict):
            raise TypeError(f"emit() expects a dict row, got {type(row).__name__}")
        out = {k: _norm(v) for k, v in row.items()}
        ref = file_ref(file)
        if ref:
            out["_file"] = ref
        self._pending.setdefault(table, []).append(out)
        self._pending_n += 1
        if self._pending_n >= 500:
            self.flush()

    def emit_many(self, table: str, rows: Iterable[dict]) -> None:
        for r in rows:
            self.emit(table, r)

    def flush(self) -> None:
        for table, rows in self._pending.items():
            if rows:
                self._rpc.notify("emit", table=table, rows=rows)
        self._pending, self._pending_n = {}, 0

    def summary(self, key: str, value: Any) -> None:
        """Report an evidence summary field (shown on the case page), e.g. hostname, os, installDate, lastUser, timezone."""
        self._rpc.notify("summary", key=key, value="" if value is None else str(value))

    def progress(self, fraction: float, message: str = "") -> None:
        """Report progress 0..1. Calls are throttled, so it is fine to call it in a tight loop."""
        now = time.monotonic()
        if fraction < 1 and now - self._last_progress < 0.25:
            return
        self._last_progress = now
        self._rpc.notify("progress", value=max(0.0, min(1.0, float(fraction))), message=message)

    def log(self, message: str) -> None:
        self._rpc.notify("log", message=str(message))

    def warn(self, message: str) -> None:
        self.log("warning: " + str(message))


def file_ref(f) -> str:
    """A path the backend can locate: 'p2:/Users/x' for entries with a partition, otherwise the path as given."""
    if not f:
        return ""
    if isinstance(f, dict):
        path = str(f.get("path") or "")
        if not path:
            return ""
        if re.match(r"^p\d+:", path) or "part" not in f:
            return path
        return f"p{f['part']}:{path if path.startswith(('/', chr(92))) else '/' + path}"
    return str(f)


def _norm(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "Yes" if v else ""
    if isinstance(v, (int, float, str)):
        return v
    if isinstance(v, _dt.datetime):
        return dt_to_text(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).hex()
    if isinstance(v, (list, tuple, set)):
        return ", ".join(str(_norm(x)) for x in v)
    return str(v)


# ---------------- helpers ----------------

def filetime_to_text(ft: int | None) -> str:
    """Windows FILETIME (100 ns since 1601) -> 'YYYY-MM-DD HH:MM:SS' (UTC); '' for 0 or invalid."""
    if not ft or ft < 0 or ft > 0x7FFFFFFFFFFFFFFF:
        return ""
    try:
        d = _dt.datetime(1601, 1, 1, tzinfo=_dt.timezone.utc) + _dt.timedelta(microseconds=ft // 10)
    except OverflowError:
        return ""
    return d.strftime("%Y-%m-%d %H:%M:%S")


def unix_to_text(sec: int | float | None) -> str:
    """Unix seconds -> 'YYYY-MM-DD HH:MM:SS' (UTC); '' for 0 or invalid."""
    if not sec:
        return ""
    try:
        return _dt.datetime.fromtimestamp(sec, _dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    except (OverflowError, OSError, ValueError):
        return ""


def dt_to_text(d: _dt.datetime | None) -> str:
    """datetime -> 'YYYY-MM-DD HH:MM:SS'; aware values are converted to UTC, naive values are taken as UTC."""
    if d is None:
        return ""
    if d.tzinfo is not None:
        d = d.astimezone(_dt.timezone.utc)
    return d.strftime("%Y-%m-%d %H:%M:%S")
