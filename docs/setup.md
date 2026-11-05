# DiskSleuth: layout, setup and internals

## Layout

```
Forensics/
├── backend/          Go backend
│   ├── internal/tsk/    TSK via cgo: open images, partitions, file systems, list directories, read by inode
│   ├── internal/ewf/    libewf directly: E01 acquisition metadata and stored hashes
│   ├── internal/casedb/ case database (SQLite): cases, evidence, hashes, plugin results, file index (FTS5), audit log
│   ├── internal/server/ local HTTP API (below), index and content search jobs, plugin runner
│   ├── cmd/disksleuth-server/ the backend service (started by Electron)
│   └── cmd/tskcheck/    chain check tool: image info, partitions, hive export, whole-disk hash
├── plugins/          Python analysis plugins (see plugins/README.md)
├── scripts/          environment and build scripts (committed, for reproducible builds)
├── docs/             documentation
├── frontend/         Electron front end (Vite + React + TypeScript), see frontend/README.md
├── testdata/images/  test images (not committed)
├── cases/            case root, one cases\<number>\case.db + work\ per case (not committed)
│
├── downloads/        original archives (TSK and libewf sources, MSYS2 installer) - not committed
├── toolchain/msys64/ MSYS2 + MinGW64 GCC - not committed
├── third_party/src/  extracted third-party sources - not committed
├── deps/             third-party build output (include/ lib/ bin/) - not committed
├── tools/            official prebuilt TSK command line tools for cross-checking - not committed
├── build/            build output and scratch results - not committed
└── .venv/            Python virtual environment - not committed
```

## Dependency versions

| Dependency | Version | Source |
|---|---|---|
| The Sleuth Kit | 4.15.0 | https://github.com/sleuthkit/sleuthkit/releases |
| libewf | experimental-20260924 | https://github.com/libyal/libewf/releases |
| MSYS2 / GCC | latest / 16.2 | https://www.msys2.org |
| Go | 1.23 | |
| Python | 3.14; regipy 6.5, LnkParse3 1.5 | |
| Node / Electron | 22+ / 45 | |

## Setup from scratch (Windows, PowerShell)

1. Put `sleuthkit-4.15.0.tar.gz` and `libewf-experimental-20260924.tar.gz` into `downloads/`.
2. `powershell -ExecutionPolicy Bypass -File scripts\setup-msys2.ps1` installs MSYS2 into `toolchain/msys64`, configures mirrors and installs GCC.
3. `powershell -ExecutionPolicy Bypass -File scripts\build-deps.ps1` builds static libewf and TSK into `deps/`.
4. `powershell -ExecutionPolicy Bypass -File scripts\build-backend.ps1` builds the Go backend into `build/bin/`.
5. `python -m venv .venv`, then `.venv\Scripts\pip install -r plugins\requirements.txt`
   (in mainland China add `-i https://pypi.tuna.tsinghua.edu.cn/simple`).
6. `cd frontend; npm install; node node_modules/electron/install.js`, then `npm run dev`
   (Electron starts `build\bin\disksleuth-server.exe` itself).

Checks:

- `build\bin\tskcheck.exe -export build\hives <image.E01>` exports the registry hives; run a plugin on them with
  `plugins\_sdk\devrun.py` (see plugins/README.md).
- `cd backend; go test ./...` (with the MinGW `bin` folder on PATH and `CGO_ENABLED=1`) and
  `.venv\Scripts\python -m unittest discover -s plugins/_sdk/tests`.

To debug the page in a plain browser (`npm run dev:web`), start a dev backend by hand:
`build\bin\disksleuth-server.exe -addr 127.0.0.1:7701 -token dev-token`.

## Backend API

`disksleuth-server` listens on 127.0.0.1 only and prints one line on startup:
`{"event":"ready","url":"http://127.0.0.1:<port>","token":"…"}`. Every request needs `Authorization: Bearer <token>`.
One case is open at a time; evidence, index and searches belong to the current case.

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Versions |
| GET | `/api/cases` | All cases under the case root plus registered cases saved elsewhere |
| POST | `/api/cases` `{"name","examiner","number","location"}` | Create and open a case in `<location>\<number>` (defaults: the cases root and `DS-<date>-<time>`). Cases outside the root are remembered in `casesegistry.json` |
| DELETE | `/api/cases` `{"dir"}` | Delete a listed case: removes `case.db*` and `work\` only (evidence images and other files are kept); closes it first if open |
| POST | `/api/cases/open` `{"dir"}` | Open a case; its evidence is reopened and hashes, results and index are restored |
| GET / POST | `/api/case`, `/api/case/close` | Current case / close it (background jobs are stopped first) |
| GET | `/api/case/audit` | Audit log |
| POST | `/api/case/evidence` `{"path"}` | Add evidence (opened read-only): format, sizes, E01 metadata, partitions and file systems |
| GET | `/api/evidence/{id}` | Evidence info and index state |
| GET | `/api/evidence/{id}/partitions/{part}/dir?inode=` | List a directory incl. deleted entries (no inode = root) |
| GET | `/api/evidence/{id}/partitions/{part}/file?inode=&offset=&length=` | Read file content (base64, up to 1 MB per call) |
| POST / GET | `/api/evidence/{id}/hash` | Start / poll whole-disk MD5, SHA1, SHA256 (separate handle; stored in the case) |
| POST / GET | `/api/evidence/{id}/index` | Start / poll the full file index |
| GET | `/api/plugins[?refresh=1]` | Plugin manifests (rescanned on every call), manifest problems, Python environment and missing modules |
| GET | `/api/evidence/{id}/plugins` | Plugin state: running plugin, progress, queue, run records, row counts |
| POST | `/api/evidence/{id}/plugins/run` `{"ids":[]}` | Queue plugins (empty = all) |
| POST | `/api/evidence/{id}/plugins/stop` | Stop the running plugin and clear the queue (its staged results are dropped) |
| GET | `/api/evidence/{id}/artifacts/{table}` | One result table: columns from plugin.json + committed rows |
| GET | `/api/evidence/{id}/summary` | Evidence summary reported by plugins |
| GET | `/api/evidence/{id}/locate?path=` | Resolve a path to partition, directory trail and inode for "Show in Files". Accepts `p2:/…`, `/…`, `C:\…`, `\??\C:\…`, `\SystemRoot\…`, `system32\…`, `%SystemRoot%`-style variables and quoted command lines; drive letters map to the system partition |
| POST | `/api/evidence/{id}/export` `{"items":[{part,inode,name,path}],"dest","hash","includeDeleted"}` | Export files / folders to a local folder: chunked reads, MD5 + SHA-256, original timestamps restored, never overwrites (`name (2).ext`), CSV report `DiskSleuth-export-<time>.csv`, audit log entries |
| GET / DELETE | `/api/export` | Poll / stop the running export (one at a time per case) |
| GET | `/api/tasks` | Background jobs of the open case for the title bar task list: running plugin batches, index and hash jobs, the last content search and export |
| DELETE | `/api/evidence/{id}/index` | Stop building the file index |
| GET | `/api/search?q=&regex=&path=&deleted=&kind=&evidence=` | File name / path search (3+ characters use the FTS5 trigram index) |
| GET | `/api/files/{id}` | An indexed file and its directory trail (for "Show in Files") |
| POST / GET / DELETE | `/api/search/content` | Start / poll / stop a content search (UTF-8 + UTF-16LE, files over 64 MB skipped) |

## Case database (`internal/casedb`)

| Table | Content |
|---|---|
| `case_info` | Case number, name, examiner, notes, created |
| `evidence` | Evidence path, full info captured when opened (JSON), index state and file count |
| `hashes` | Whole-disk MD5 / SHA1 / SHA256, duration, time |
| `plugin_runs` | One record per evidence + plugin: state, plugin version, start/end, rows, error, log |
| `artifacts` | Plugin results, one row per record (evidence, plugin, table, JSON); `staged = 1` while a run is in progress |
| `summary` | Evidence summary key/values (host name, OS, install date, ...) |
| `files` + `files_fts` | Full file index: partition, inode, parent inode, name, path, extension, size, deleted, four times; FTS5 trigram for CJK substrings |
| `audit` | Audit log: case created/opened/closed, evidence added, hashing, indexing, plugin runs, every search |

Older case databases are upgraded when opened (missing columns are added).

On the Win7 test image (30 GB): indexing 90,202 entries takes about 12 s, a keyword search 1–30 ms,
and the twelve bundled plugins finish in under a minute.

## Known issues and fixes

| Issue | Symptom | Fix |
|---|---|---|
| Other software put old MinGW runtime DLLs into System32 | GCC's cc1.exe and MinGW programs fail with 0xC0000139 | Never touch system folders; copy matching DLLs next to the programs (setup-msys2.ps1 / build-deps.sh do it) and link the Go backend statically |
| libewf uses the ANSI code page for file names by default | E01 files under non-ASCII paths cannot be opened | Build libewf with `-DUNICODE -D_UNICODE` (library only, no ewftools) |
| TSK silently falls back to RAW when detection fails | An E01 is read as a raw disk and looks "high entropy / encrypted" | The Go layer detects the format from the header and forces EWF, failing loudly (`internal/tsk/open.go`) |
| libewf does not accept forward slashes with the `\\?\` prefix | Paths containing `/` fail to open | The Go layer normalizes to absolute backslash paths |
| TSK 4.15 vs newer libewf rename | `libewf_handle_read_random` undeclared | sed patch in build-deps.sh |
| The Go build cache ignores external .a changes | Go keeps linking the old libraries after rebuilding deps | build-backend.ps1 puts a hash of the libraries into CGO_CFLAGS |
| PowerShell 5.1 | UTF-8 scripts without BOM are garbled; multi-line arguments to an exe are cut | Keep scripts ASCII (or UTF-8 with BOM); put complex logic into .sh files |
| Python `-I` ignores `PYTHONIOENCODING` | Plugin output garbled (written as GBK) | Plugins run with `python -I -B -X utf8` |
| regipy trims values to 256 bytes and matches value names case-sensitively | Truncated binary values, missed values | `winreg_util` reads with `trim_values=False` and `case_sensitive=False` |
| Event logs | No Python package for EVTX is installed | The event log plugin queries exported .evtx files with the built-in `wevtutil` (Windows only) |
