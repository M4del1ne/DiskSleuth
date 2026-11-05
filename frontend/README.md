# DiskSleuth front end

Electron + Vite + React + TypeScript.

## Install

```bash
npm install
# npm 11 does not run electron's install script by default; download the Electron runtime manually:
node node_modules/electron/install.js
```

Behind a slow connection you can point npm and Electron at a mirror for one command (not saved in the project):

```bash
npm_config_registry=https://registry.npmmirror.com ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

## Run

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server + Electron window (hot reload) |
| `npm run dev:web` | Page only, open http://localhost:5199 in a browser (window buttons do nothing) |
| `npm run build` | Build into `dist/` |
| `npm start` | Open the build in `dist/` with Electron |
| `npm run typecheck` | TypeScript type check |

## Layout

- `electron/main.cjs`: main process. Frameless window with a title bar drawn by the page; the renderer runs with sandbox and contextIsolation. Starts the Go backend and passes its URL and token to the page.
- `electron/preload.cjs`: exposes only window controls, backend info, the open-file dialog and clipboard writing as `window.ds`.
- `src/api/`: data layer. `types.ts` mirrors the Go backend's JSON; `source.ts` is the `DataSource` used by pages (live backend or built-in demo); `plugins.ts` applies plugin translations; `mock.ts` is demo data (evidence, hashes, partitions and system info are real results from `windows7disk.E01`, the directory tree and search hits are illustrative).
- `src/i18n/`: translations. English strings in the code are the keys (`t('Refresh')`); `zh-CN.ts` maps them to Chinese. The language is chosen in Settings (default English).
- `src/pages/`: Case, Files, Analysis, Search and Settings pages.
- `src/styles/global.css`: design rules and base components (colors, type, panels, tables, tree, tabs).
- `src/brand.ts`: product name; the logo is in `src/components/Logo.tsx` and `public/logo.svg`.

## Right-click menus

`src/components/ContextMenu.tsx` (`useContextMenu`) renders the app's own menu; `src/util/clipboard.ts` copies text
(through the Electron main process when available) and shows a toast. The Files and Analysis pages use it for copying
cells, rows, columns and paths, for jumping from an analysis record to its source file, and for exporting files.

`src/components/ExportCenter.tsx` owns the export dialog (`requestExport(evidence, items)`) and the progress card in
the lower right corner; the Electron main process provides the folder picker and "open folder".

## Adding UI text

Wrap it in `t()` (import from `src/i18n`) and add the Chinese translation to `src/i18n/zh-CN.ts`.
Use `{name}` placeholders instead of concatenating: `t('{n} rows', { n })`.
