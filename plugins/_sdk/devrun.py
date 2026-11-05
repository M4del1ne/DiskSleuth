"""Run a plugin against a local folder, without the DiskSleuth backend.

The folder stands in for one partition of the evidence (partition 1, the system partition), e.g. files
exported with ``tskcheck -export`` or a mounted image. The plugin runs through the real runner.py and the
same JSON protocol as in the backend, so what works here works in the app.

    python plugins/_sdk/devrun.py plugins/windows/usb --root D:/exported
    python plugins/_sdk/devrun.py plugins/windows/lnk --root E:/ --rows 5 --out lnk.json

Limitations: the folder has no deleted files; times come from the local file system.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

SDK_DIR = Path(__file__).resolve().parent
PART = 1


@dataclass
class RunResult:
    state: str = "error"  # done | error
    error: str = ""
    tables: dict[str, list[dict]] = field(default_factory=dict)
    summary: dict[str, str] = field(default_factory=dict)
    logs: list[str] = field(default_factory=list)
    progress: list[tuple[float, str]] = field(default_factory=list)
    stderr: str = ""


class LocalBackend:
    """Serves the plugin RPC methods from a local folder."""

    def __init__(self, root: str, plugin_dir: Path, workdir: str):
        self.root = Path(root).resolve()
        self.plugin_dir = plugin_dir
        self.workdir = workdir
        self.inodes: dict[str, int] = {}  # relative path (lowercase) -> fake inode
        self.paths: dict[int, Path] = {}

    # ---- helpers ----
    def _inode(self, p: Path) -> int:
        key = str(p.relative_to(self.root)).lower()
        if key not in self.inodes:
            n = len(self.inodes) + 16
            self.inodes[key] = n
            self.paths[n] = p
        return self.inodes[key]

    def _lookup(self, rel: str) -> Path | None:
        """Case-insensitive path lookup, like NTFS."""
        cur = self.root
        for seg in [s for s in rel.replace("\\", "/").split("/") if s]:
            direct = cur / seg
            if direct.exists():
                cur = direct
                continue
            try:
                match = next((c for c in cur.iterdir() if c.name.lower() == seg.lower()), None)
            except OSError:
                match = None
            if match is None:
                return None
            cur = match
        return cur

    def _entry(self, p: Path) -> dict:
        st = p.stat()
        return {"name": p.name if p != self.root else "", "inode": self._inode(p), "isDir": p.is_dir(),
                "size": 0 if p.is_dir() else st.st_size, "deleted": False, "created": int(st.st_ctime),
                "modified": int(st.st_mtime), "accessed": int(st.st_atime), "changed": int(st.st_mtime), "part": PART}

    def _resolve(self, params: dict) -> Path:
        if params.get("inode") is not None:
            p = self.paths.get(int(params["inode"]))
            if p is None:
                raise ValueError(f"inode {params['inode']} does not exist")
            return p
        path = str(params.get("path") or "")
        m = re.match(r"^p(\d+):(.*)$", path)
        if m:
            if int(m.group(1)) != PART:
                raise ValueError(f"partition {m.group(1)} does not exist (devrun has only p{PART})")
            path = m.group(2)
        p = self._lookup(path)
        if p is None:
            raise ValueError(f"file not found: {params.get('path')}")
        return p

    # ---- RPC ----
    def handle(self, method: str, params: dict, manifest: dict):
        if method == "hello":
            return {"api": 1, "plugin": manifest, "workdir": self.workdir,
                    "evidence": {"id": "devrun", "name": self.root.name or str(self.root), "path": str(self.root)}}
        if method == "partitions":
            return [{"index": PART, "fsType": "local", "system": True}]
        if method == "stat":
            try:
                return self._entry(self._resolve(params))
            except ValueError:
                return None
        p = self._resolve(params)
        if method == "list":
            if not p.is_dir():
                raise ValueError(f"not a directory: {params.get('path')}")
            return [self._entry(c) for c in sorted(p.iterdir(), key=lambda c: c.name.lower())]
        if method == "read":
            with open(p, "rb") as f:
                f.seek(int(params.get("offset") or 0))
                data = f.read(min(int(params.get("length") or 4 << 20), 4 << 20))
            return {"data": base64.b64encode(data).decode()}
        if method == "export":
            dst = Path(self.workdir) / "export" / f"{self._inode(p)}_{p.name}"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dst)
            return {"path": str(dst)}
        if method == "find":
            return self._find(params)
        raise ValueError(f"unknown method: {method}")

    def _find(self, q: dict) -> list[dict]:
        def like(pat):
            return re.compile("^" + re.escape(pat).replace("%", ".*").replace("_", ".") + "$", re.I) if pat else None
        ext = (q.get("ext") or "").lower().lstrip(".")
        name_re, path_re = like(q.get("name")), like(q.get("path"))
        if not (ext or name_re or path_re):
            raise ValueError("specify at least one of ext, name, path")
        out = []
        for dirpath, dirs, files in os.walk(self.root):
            dirs.sort()
            for fn in sorted(files):
                p = Path(dirpath) / fn
                rel = "\\" + str(p.relative_to(self.root)).replace("/", "\\")
                if ext and not fn.lower().endswith("." + ext):
                    continue
                if name_re and not name_re.match(fn):
                    continue
                if path_re and not path_re.match(rel):
                    continue
                e = self._entry(p)
                e["path"] = rel
                out.append(e)
        off, lim = int(q.get("offset") or 0), int(q.get("limit") or 20000)
        return out[off:off + lim]


def run_plugin(plugin_dir: str | Path, root: str | Path, python: str | None = None, workdir: str | None = None) -> RunResult:
    """Run a plugin against a local folder and collect everything it reports."""
    plugin_dir = Path(plugin_dir).resolve()
    manifest = json.loads((plugin_dir / "plugin.json").read_text(encoding="utf-8"))
    declared = {o["id"] for o in manifest.get("outputs", [])}
    workdir = workdir or tempfile.mkdtemp(prefix="dsdev_")
    os.makedirs(workdir, exist_ok=True)
    backend = LocalBackend(str(root), plugin_dir, workdir)
    res = RunResult()
    proc = subprocess.Popen([python or sys.executable, "-I", "-B", "-X", "utf8", str(SDK_DIR / "runner.py"), str(plugin_dir)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=workdir)
    import threading
    err_chunks: list[bytes] = []
    t = threading.Thread(target=lambda: err_chunks.append(proc.stderr.read()), daemon=True)
    t.start()
    done, fail = False, ""
    for line in proc.stdout:
        if not line.strip():
            continue
        msg = json.loads(line)
        if "id" in msg:
            try:
                reply = {"id": msg["id"], "result": backend.handle(msg["method"], msg.get("params") or {}, manifest)}
            except Exception as e:
                reply = {"id": msg["id"], "error": str(e)}
            proc.stdin.write(json.dumps(reply, ensure_ascii=False).encode("utf-8") + b"\n")
            proc.stdin.flush()
            continue
        method, p = msg.get("method"), msg.get("params") or {}
        if method == "emit":
            if p["table"] not in declared:
                res.logs.append(f"warning: ignored table {p['table']!r}, it is not declared in plugin.json")
            else:
                res.tables.setdefault(p["table"], []).extend(p["rows"])
        elif method == "summary":
            res.summary[p["key"]] = p["value"]
        elif method == "progress":
            res.progress.append((p.get("value", 0), p.get("message", "")))
        elif method == "log":
            res.logs.append(p.get("message", ""))
        elif method == "fail":
            fail = p.get("error", "")
        elif method == "done":
            done = True
    proc.stdin.close()
    code = proc.wait()
    t.join(5)
    proc.stdout.close()
    proc.stderr.close()
    res.stderr = b"".join(err_chunks).decode("utf-8", "replace").strip()
    if fail:
        res.error = fail
    elif code != 0:
        res.error = f"plugin process exited with code {code}"
    elif not done:
        res.error = "plugin did not finish normally (no done notification)"
    else:
        res.state = "done"
    return res


def _print_table(name: str, cols: list[dict], rows: list[dict], limit: int) -> None:
    keys = [c["key"] for c in cols] if cols else sorted({k for r in rows for k in r})
    print(f"\n== {name}: {len(rows)} rows ==")
    if not rows:
        return
    shown = rows[:limit]
    widths = {k: min(40, max(len(k), *(len(str(r.get(k, ""))) for r in shown))) for k in keys}
    print("  ".join(k.ljust(widths[k]) for k in keys))
    for r in shown:
        print("  ".join(str(r.get(k, ""))[:40].ljust(widths[k]) for k in keys))
    if len(rows) > limit:
        print(f"... {len(rows) - limit} more")


def main() -> int:
    ap = argparse.ArgumentParser(description="Run a DiskSleuth plugin against a local folder.")
    ap.add_argument("plugin", help="plugin directory, e.g. plugins/windows/usb")
    ap.add_argument("--root", required=True, help="folder that stands in for the evidence's system partition")
    ap.add_argument("--rows", type=int, default=10, help="rows to print per table")
    ap.add_argument("--out", help="write all results to this JSON file")
    ap.add_argument("--workdir", help="plugin work directory (default: a new temp folder)")
    a = ap.parse_args()

    res = run_plugin(a.plugin, a.root, workdir=a.workdir)
    manifest = json.loads((Path(a.plugin) / "plugin.json").read_text(encoding="utf-8"))
    for o in manifest.get("outputs", []):
        _print_table(f"{o['id']} ({o['name']})", o.get("columns", []), res.tables.get(o["id"], []), a.rows)
    if res.summary:
        print("\n== summary ==")
        for k, v in res.summary.items():
            print(f"  {k}: {v}")
    if res.logs:
        print("\n== log ==")
        print("\n".join("  " + x for x in res.logs))
    if res.stderr:
        print("\n== stderr ==")
        print(res.stderr)
    if a.out:
        Path(a.out).write_text(json.dumps(res.__dict__, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nresult: {res.state}" + (f" - {res.error}" if res.error else ""))
    return 0 if res.state == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
