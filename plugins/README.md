# DiskSleuth plugins

Every analysis in DiskSleuth is a Python plugin. The backend discovers `plugins/<group>/<name>/plugin.json`
on every request, so adding a plugin needs no change to the backend or the front end: the result tables a
plugin declares appear on the Analysis page, with columns taken from the manifest.

```
plugins/
├── _sdk/                    SDK (disksleuth.py), runner (runner.py), registry helpers (winreg_util.py),
│   │                        local dev runner (devrun.py)
│   └── tests/               SDK and protocol tests
├── requirements.txt         Python packages used by the bundled plugins (install into the project's .venv)
├── windows/
│   ├── sysinfo/             host name, OS, install date, time zone, last user, local accounts (+ case summary)
│   ├── software/            installed programs (HKLM + each user's HKCU Uninstall keys)
│   ├── autoruns/            services and drivers, Run keys, Winlogon, Startup folders
│   ├── network/             network interfaces, known networks (Wi-Fi / wired profiles)
│   ├── usb/                 USB storage (USBSTOR), USB devices, MountedDevices (drive letters)
│   ├── lnk/                 shortcut files on the whole disk (needs the file index)
│   ├── mru/                 RecentDocs, RunMRU, typed paths / URLs, Explorer searches
│   ├── execution/           UserAssist, ShimCache (AppCompatCache), BAM
│   ├── prefetch/            Prefetch files (XP to Windows 11)
│   ├── recyclebin/          $I records / INFO2 with original path and deletion time
│   └── eventlogs/           logons, account changes, startups/shutdowns, services (uses wevtutil, Windows only)
└── browsers/
    └── history/             Chromium-family and Firefox history and downloads
```

Directories starting with `_` are ignored.

## A minimal plugin

`plugins/windows/desktop/plugin.json`

```json
{
  "id": "windows.desktop",
  "name": "Desktop Files",
  "version": "0.1.0",
  "api": 1,
  "description": "Lists the files on every user's desktop.",
  "outputs": [
    {
      "id": "desktop_files", "name": "Desktop Files", "group": "User Activity",
      "columns": [
        { "key": "user", "title": "User", "width": 120 },
        { "key": "name", "title": "Name", "width": 260 },
        { "key": "size", "title": "Size", "width": 90, "kind": "size" },
        { "key": "modified", "title": "Modified (UTC)", "width": 160, "kind": "time" },
        { "key": "path", "title": "Location", "kind": "source" }
      ]
    }
  ]
}
```

`plugins/windows/desktop/main.py`

```python
from disksleuth import unix_to_text

def run(ctx):
    for prof in ctx.user_profiles():
        for f in ctx.glob(prof["path"] + "/Desktop/*"):
            if f["isDir"]:
                continue
            ctx.emit("desktop_files", {
                "user": prof["name"], "name": f["name"], "size": f["size"],
                "modified": unix_to_text(f["modified"]), "path": f["path"],
            })
```

Click **Refresh** on the Analysis page and the new category appears; click **Run** to run it.

## plugin.json

| Field | Meaning |
|---|---|
| `id` | Unique id: lowercase letters, digits and `._-`, e.g. `windows.usb` |
| `name`, `version`, `description`, `author` | Shown on the Analysis page and in Settings. `version` is recorded with every run |
| `api` | Plugin protocol version the plugin was written for (currently `1`). A higher value than the backend supports is rejected |
| `entry` | Entry file inside the plugin folder, default `main.py`; it must define `run(ctx)` |
| `requires` | Preconditions: paths that must exist in the evidence, or `"index"` (the file index must be built). When not met the run is marked *Not applicable*, not failed |
| `dependencies` | Python modules (import names) the plugin needs, e.g. `["regipy"]`. Missing modules are reported in the UI with the install command, and the plugin is not started |
| `timeout` | Seconds before the run is stopped (default 1800, range 10–86400) |
| `outputs[]` | Result tables: `id` (unique across all plugins; lowercase letters, digits, `_`), `name`, `group`, `columns[]` |
| `columns[].kind` | `text` (default), `time`, `size` (bytes, formatted), `mono` (monospace, for serials and hashes), `source` (provenance: hidden in the grid, shown in the record details) |

Groups used by the bundled plugins (any other name works too and is listed after these):
`System`, `Network`, `Devices`, `User Activity`, `Program Execution`, `Browsers`, `File System`, `Event Logs`.

The backend validates every manifest. Broken manifests, duplicate plugin ids and duplicate table ids are
listed in **Settings › Plugins** with the reason; the rest keep working.

### Translations

The manifest is written in English. Put translations in `locales/<lang>.json` (currently `zh-CN`):

```json
{
  "name": "桌面文件",
  "description": "列出各用户桌面上的文件。",
  "outputs": {
    "desktop_files": { "name": "桌面文件", "group": "用户痕迹", "columns": { "user": "用户", "name": "名称" } }
  },
  "values": { "Yes": "是" }
}
```

Everything is optional. `values` translates text cells (fixed words such as states or event names); other
values are shown as they are.

## The ctx object (`_sdk/disksleuth.py`)

Paths: `"/Windows/System32/config/SYSTEM"` means the system partition (the one with the Windows directory,
else the first recognized one); `"p3:/data/x"` selects partition 3. Lookups are case-insensitive on NTFS.
Wherever a path is accepted you can also pass an entry returned by `find`, `listdir`, `glob` or `walk`
(located by partition + inode, so deleted files work too).

| Method | Description |
|---|---|
| `ctx.evidence`, `ctx.plugin`, `ctx.workdir` | Evidence info, this plugin's manifest, a work folder for scratch files (`case/work/<evidence>/plugins/<id>`) |
| `ctx.partitions()` | `[{index, fsType, system}]` |
| `ctx.stat(t)`, `ctx.exists(t)` | File info (or `None`) / whether it exists |
| `ctx.listdir(t)` | Directory entries incl. deleted ones: `{name, part, inode, isDir, size, deleted, created, modified, accessed, changed}`; times are Unix seconds (UTC) |
| `ctx.glob(pattern, deleted=False)` | Wildcards per path segment, case-insensitive: `"/Users/*/NTUSER.DAT"`. Entries get a `path` |
| `ctx.walk(t, deleted=False, max_depth=None)` | Every entry below a directory |
| `ctx.user_profiles()` | `[{name, path, entry}]` from `/Users` and `/Documents and Settings` (Public, Default… skipped) |
| `ctx.read(t, offset=0, length=None)` | Read bytes (whole file by default) |
| `ctx.open(t)` | Read-only, seekable file object for parsers that want one |
| `ctx.export(t, dest_dir=None)` | Copy a file out and return the local path. Without `dest_dir` the backend exports it once into the case work folder; with `dest_dir` it keeps the original name (use it for SQLite databases with their `-wal` file) |
| `ctx.temp_dir(name)` | An empty folder under `ctx.workdir` |
| `ctx.find(ext=, name=, path=, deleted=False, limit=, offset=)` / `ctx.iter_find(...)` | Search the file index (`name` / `path` are SQL LIKE patterns, `%` is the wildcard, paths use `\`). Declare `"index"` in `requires` |
| `ctx.emit(table, row, file=None)` / `ctx.emit_many(table, rows)` | Output rows. Values are normalized: `datetime` → UTC text, `bytes` → hex, `bool` → `Yes`/empty, lists → comma separated. `file` is the evidence file the row came from (a path or an entry); it is stored as the hidden field `_file` and powers **Show source file in Files** in the right-click menu |
| `ctx.summary(key, value)` | Evidence summary on the Case page: `hostname`, `os`, `installDate`, `lastUser`, `timezone` |
| `ctx.progress(fraction, message)` | Progress 0–1 (throttled, call it as often as you like) |
| `ctx.log(message)`, `ctx.warn(message)` | Run log. `print()` output and tracebacks also end up in the log |

Helpers: `filetime_to_text`, `unix_to_text`, `dt_to_text`. Registry plugins can use `_sdk/winreg_util.py`:
`open_hive`, `try_open_hive`, `user_hives`, `get_key`, `get_value`, `values`, `subkeys`, `current_control_set`,
`key_last_write`, `as_bytes`, `rot13`, `mru_order`, … (value reads are case-insensitive and never truncated).

## Developing and testing

Run a plugin against a folder without the app; the folder stands in for the system partition
(e.g. files exported with `tskcheck -export`, or a mounted image). It uses the real runner and protocol:

```
.venv\Scripts\python plugins\_sdk\devrun.py plugins\windows\usb --root D:\exported --rows 5
.venv\Scripts\python plugins\_sdk\devrun.py plugins\windows\lnk --root E:\ --out lnk.json
```

SDK and protocol tests:

```
.venv\Scripts\python -m unittest discover -s plugins/_sdk/tests -v
```

## How runs work

- The backend starts `python -I -B -X utf8 plugins/_sdk/runner.py <plugin dir>` with the plugin work folder as
  the current directory, and speaks line-delimited JSON over stdin/stdout (requests with an id, notifications without).
- Plugins can only read the evidence through `ctx` (read-only); they never get the image file.
- Results are **staged** while the plugin runs. Only when it finishes normally do they replace the previous
  results of that plugin (and its summary fields). A failed, stopped or timed-out run keeps the previous results,
  and the UI says so. If the backend dies mid-run, the staged rows are dropped the next time the case is opened.
- Every run is recorded in the case database (`plugin_runs`: state, row count, plugin version, log, error) and in the audit log.
- Rows are checked against the manifest: undeclared tables are ignored and undeclared fields are reported once in the log.
- Plugins run one at a time per evidence item; **Stop** on the Analysis page ends the current one and clears the queue.

## Result conventions

- Times are UTC text `YYYY-MM-DD HH:MM:SS`, and the column title says `(UTC)`. Say `(local)` when a source only has local time.
- Give every row a `source` column naming where the value came from (registry key > value, file path, log record), so it can be verified,
  and pass `file=` to `emit` (the hive, log, database or file that was read) so the examiner can jump to it.
- Field names starting with `_` are reserved for such hidden values and are not shown as columns.
- One unreadable file must not fail the whole plugin: log it and continue.
- Prefer facts over interpretation: "Key Last Write" rather than "Installed", unless the source really means that.
