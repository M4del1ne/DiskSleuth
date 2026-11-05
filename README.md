# DiskSleuth

DiskSleuth is an open-source desktop workbench for disk image forensics. It opens E01 (EnCase) and DD/RAW
images read-only, lets you browse every partition including deleted files, builds a full file index for
name and content search, and runs Python analysis plugins that extract Windows artifacts.

- **Case management**: one SQLite case database per case with an audit log of every action.
- **Evidence**: E01 (multi-segment) and DD/RAW, opened through The Sleuth Kit and libewf; whole-disk
  MD5/SHA1/SHA256 checked against the hashes stored in the E01.
- **Files**: evidence > partition > directory tree, deleted entries, hex and text preview.
- **Search**: instant file name search (FTS5 trigram, works for CJK too) and content search in UTF-8 and UTF-16LE.
- **Analysis**: plugins for system info, accounts, installed programs, services and autostart, network,
  USB devices, LNK files, recent documents and other MRU lists, UserAssist / ShimCache / BAM, Prefetch,
  Recycle Bin, browser history and downloads, and event logs. Writing a new plugin needs only a
  `plugin.json` and a `main.py` (see [plugins/README.md](plugins/README.md)).
- **Languages**: English by default; Simplified Chinese can be selected in Settings.

Stack: Electron + React front end, Go backend (TSK and libewf via cgo), Python plugins.

- Build and setup: [docs/setup.md](docs/setup.md)
- Front end: [frontend/README.md](frontend/README.md)
- Plugin development: [plugins/README.md](plugins/README.md)

License: Apache-2.0.
