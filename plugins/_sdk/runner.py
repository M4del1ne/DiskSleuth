"""Plugin runner, started by the backend as ``python -I -B -X utf8 runner.py <plugin dir>``.

1. Keeps stdin/stdout for the protocol and redirects print() in plugins to stderr.
2. Sends hello to get the evidence and plugin info.
3. Checks the manifest's Python dependencies, loads the entry file and calls run(ctx).
4. On success sends "done" and exits 0; on error sends "fail" (with the traceback on stderr) and exits 1.
"""
import importlib.util
import json
import sys
import traceback
from pathlib import Path

SDK_DIR = Path(__file__).resolve().parent


def missing_modules(names):
    out = []
    for name in names or []:
        try:
            if importlib.util.find_spec(name) is None:
                out.append(name)
        except Exception:
            out.append(name)
    return out


def main() -> int:
    plugin_dir = Path(sys.argv[1]).resolve()
    # -I leaves the script directory off sys.path: add the SDK and the plugin directory explicitly
    sys.path[:0] = [str(SDK_DIR), str(plugin_dir)]
    from disksleuth import Context, _Rpc  # noqa: E402

    proto_in, proto_out = sys.stdin.buffer, sys.stdout.buffer
    sys.stdout = sys.stderr  # print() goes to the log, never into the protocol stream
    rpc = _Rpc(proto_in, proto_out)

    manifest = json.loads((plugin_dir / "plugin.json").read_text(encoding="utf-8"))
    info = rpc.call("hello", plugin=manifest.get("id"))
    ctx = Context(rpc, info)
    try:
        missing = missing_modules(manifest.get("dependencies"))
        if missing:
            raise RuntimeError("missing Python dependencies: " + ", ".join(missing)
                               + " (pip install -r plugins/requirements.txt)")
        spec = importlib.util.spec_from_file_location("ds_plugin", plugin_dir / manifest.get("entry", "main.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not callable(getattr(mod, "run", None)):
            raise RuntimeError("the entry file has no run(ctx) function")
        mod.run(ctx)
        ctx.flush()
        rpc.notify("done")
        return 0
    except BaseException as e:  # report everything, including SystemExit / KeyboardInterrupt
        try:
            ctx.flush()
        except Exception:
            pass
        traceback.print_exc()
        try:
            rpc.notify("fail", error=f"{type(e).__name__}: {e}")
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
