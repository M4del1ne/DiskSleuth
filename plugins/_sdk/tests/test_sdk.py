"""SDK / runner / protocol tests. Run from the project root:

    .venv\\Scripts\\python -m unittest discover -s plugins/_sdk/tests -v
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))

from devrun import run_plugin  # noqa: E402
from disksleuth import dt_to_text, filetime_to_text, unix_to_text  # noqa: E402


def make_plugin(base: Path, code: str, outputs=None, **manifest) -> Path:
    d = base / "plugin"
    d.mkdir(parents=True, exist_ok=True)
    m = {"id": "test.plugin", "name": "Test", "version": "1.0.0",
         "outputs": outputs or [{"id": "rows", "name": "Rows", "group": "Test",
                                 "columns": [{"key": "a", "title": "A"}, {"key": "b", "title": "B"}]}]}
    m.update(manifest)
    (d / "plugin.json").write_text(json.dumps(m), encoding="utf-8")
    (d / "main.py").write_text(textwrap.dedent(code), encoding="utf-8")
    return d


class SdkTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ds_sdk_test_"))
        root = self.tmp / "evidence"
        for p, data in {
            "Users/alice/NTUSER.DAT": b"regf" + b"\0" * 60,
            "Users/alice/Desktop/note.txt": "hello 世界".encode("utf-8"),
            "Users/alice/Desktop/a.lnk": b"L\0\0\0",
            "Users/bob/NTUSER.DAT": b"regf",
            "Users/Public/Desktop/b.lnk": b"L\0\0\0",
            "Windows/System32/config/SYSTEM": b"regf",
            "big.bin": bytes(range(256)) * 20000,  # ~5 MB, crosses the 4 MB read chunk
        }.items():
            f = root / p
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(data)
        self.root = root

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_code(self, code: str, **manifest):
        return run_plugin(make_plugin(self.tmp, code, **manifest), self.root, workdir=str(self.tmp / "work"))

    def test_file_access_and_emit(self):
        r = self.run_code("""
            import datetime
            def run(ctx):
                print("stdout must not break the protocol")
                assert ctx.exists("/windows/system32/CONFIG/system")       # case-insensitive
                assert ctx.stat("/nope") is None
                users = sorted(p["name"] for p in ctx.user_profiles())
                ctx.emit("rows", {"a": "profiles", "b": users})
                hives = ctx.glob("/Users/*/ntuser.dat")
                ctx.emit("rows", {"a": "hives", "b": len(hives)})
                ctx.emit("rows", {"a": "file", "b": 1}, file=hives[0])
                ctx.emit("rows", {"a": "file2", "b": 1}, file="/Windows/System32/config/SYSTEM")
                ctx.emit("rows", {"a": "text", "b": ctx.read("/Users/alice/Desktop/note.txt").decode("utf-8")})
                big = ctx.read("/big.bin")
                ctx.emit("rows", {"a": "big", "b": len(big) == 256 * 20000 and big[-1] == 255})
                with ctx.open("/big.bin") as f:
                    f.seek(256 * 10000 + 3)
                    ctx.emit("rows", {"a": "seek", "b": f.read(2)})
                names = sorted(e["name"] for e in ctx.walk("/Users/alice"))
                ctx.emit("rows", {"a": "walk", "b": names})
                lnks = list(ctx.iter_find(ext="lnk", page=1))
                ctx.emit("rows", {"a": "find", "b": len(lnks)})
                ctx.emit("rows", {"a": "dt", "b": datetime.datetime(2021, 5, 3, 10, 44, 28)})
                exported = ctx.export("/Users/alice/Desktop/note.txt", dest_dir=ctx.temp_dir("x"))
                ctx.emit("rows", {"a": "export", "b": exported.endswith("note.txt")})
                for i in range(1000):
                    ctx.progress(i / 1000, "loop")
                ctx.summary("hostname", "HOST")
        """)
        self.assertEqual(r.state, "done", r.error + r.stderr)
        got = {row["a"]: row["b"] for row in r.tables["rows"]}
        self.assertEqual(got["profiles"], "alice, bob")              # Public is skipped
        self.assertEqual(got["hives"], 2)
        files = {row["a"]: row.get("_file") for row in r.tables["rows"]}
        self.assertEqual(files["file"].lower(), "p1:/users/alice/ntuser.dat")  # fixed segments keep the typed case
        self.assertEqual(files["file2"], "/Windows/System32/config/SYSTEM")
        self.assertIsNone(files["text"])
        self.assertEqual(got["text"], "hello 世界")
        self.assertEqual(got["big"], "Yes")
        self.assertEqual(got["seek"], "0304")                       # bytes -> hex
        self.assertEqual(got["walk"], "Desktop, NTUSER.DAT, a.lnk, note.txt")
        self.assertEqual(got["find"], 2)
        self.assertEqual(got["dt"], "2021-05-03 10:44:28")
        self.assertEqual(got["export"], "Yes")
        self.assertEqual(r.summary, {"hostname": "HOST"})
        self.assertLess(len(r.progress), 50, "progress must be throttled")
        self.assertIn("stdout must not break the protocol", r.stderr)

    def test_exception_reports_traceback(self):
        r = self.run_code("""
            def run(ctx):
                ctx.emit("rows", {"a": 1})
                raise ValueError("boom")
        """)
        self.assertEqual(r.state, "error")
        self.assertEqual(r.error, "ValueError: boom")
        self.assertIn("Traceback", r.stderr)

    def test_backend_error_is_plugin_error(self):
        r = self.run_code("""
            def run(ctx):
                ctx.read("/missing.bin")
        """)
        self.assertEqual(r.state, "error")
        self.assertIn("PluginError: file not found", r.error)

    def test_missing_dependency(self):
        r = self.run_code("def run(ctx):\n    pass\n", dependencies=["surely_not_installed_xyz"])
        self.assertEqual(r.state, "error")
        self.assertIn("surely_not_installed_xyz", r.error)

    def test_no_run_function(self):
        r = self.run_code("x = 1\n")
        self.assertEqual(r.state, "error")
        self.assertIn("no run(ctx)", r.error)

    def test_sys_exit_is_a_failure(self):
        r = self.run_code("import sys\ndef run(ctx):\n    sys.exit(0)\n")
        self.assertEqual(r.state, "error")

    def test_undeclared_table_warns(self):
        r = self.run_code("def run(ctx):\n    ctx.emit('other', {'a': 1})\n")
        self.assertEqual(r.state, "done")
        self.assertTrue(any("not declared" in x for x in r.logs))

    def test_time_helpers(self):
        self.assertEqual(filetime_to_text(132645122680000000), "2021-05-03 10:44:28")
        self.assertEqual(filetime_to_text(0), "")
        self.assertEqual(unix_to_text(1620038668), "2021-05-03 10:44:28")
        self.assertEqual(unix_to_text(None), "")
        self.assertEqual(dt_to_text(None), "")


if __name__ == "__main__":
    unittest.main()
