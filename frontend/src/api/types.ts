// Data shapes shared with the Go backend (same JSON as internal/server returns)

export interface CaseInfo {
  id: string
  name: string
  number: string
  examiner: string
  createdAt: string
  location: string
}

export interface Partition {
  index: number
  start: number // sectors
  length: number // sectors
  description: string
  allocated: boolean
  fsType?: string
  blockSize?: number
  rootInode?: number
}

export interface Evidence {
  id: string
  name: string
  path: string
  format: 'ewf' | 'raw'
  fileSize: number
  mediaSize: number
  sectorSize: number
  segments: number
  acquiredAt?: string // acquisition time recorded in the E01 (acquisition machine local time)
  acquiredWith?: string
  storedHashes: { md5?: string; sha1?: string }
  partitions: Partition[]
  index?: IndexStatus // live source only
}

export interface HashStatus {
  state: 'idle' | 'running' | 'done' | 'error'
  progress: number
  done: number
  total: number
  md5?: string
  sha1?: string
  sha256?: string
  error?: string
  seconds?: number
}

/** Directory entry. Times are Unix seconds (UTC); 0 means unknown */
export interface FsEntry {
  name: string
  inode: number
  isDir: boolean
  size: number
  deleted: boolean
  created: number
  modified: number
  accessed: number
  changed: number
}

/** Output of the legacy sysinfo script (demo data) */
export interface SysinfoResult {
  system: { control_set: string; computer_name?: string; tcpip_hostname?: string; timezone?: string; utc_offset_minutes: number }
  software: {
    product_name?: string; csd_version?: string; current_build?: string; registered_owner?: string
    install_date_utc?: string; last_logged_on_user?: string; last_logged_on_sam_user?: string
  }
  sam_users: { rid: number; name?: string; last_login_utc?: string | null; logon_count: number }[]
  partition?: number
}

export interface EvidenceSummary {
  hostname: string
  os: string
  installDate: string
  lastUser: string
  timezone: string
}

// ---------------- plugins ----------------

export interface PluginColumn {
  key: string
  title: string
  width?: number
  /** text (default) | time | size | mono | source (provenance, shown small and dim) */
  kind?: 'text' | 'time' | 'size' | 'mono' | 'source'
}

/** One result table of a plugin (outputs[] in plugin.json) */
export interface PluginOutput { id: string; name: string; group: string; columns: PluginColumn[] }

/** plugins/<group>/<name>/locales/<lang>.json: optional translations of a manifest */
export interface PluginLocale {
  name?: string
  description?: string
  outputs?: Record<string, { name?: string; group?: string; columns?: Record<string, string> }>
  /** translations of cell values, e.g. {"Yes": "是"} */
  values?: Record<string, string>
}

/** plugins/<group>/<name>/plugin.json */
export interface PluginManifest {
  id: string
  name: string
  version: string
  api?: number
  description: string
  author?: string
  timeout?: number
  requires?: string[]
  dependencies?: string[]
  outputs: PluginOutput[]
  locales?: Record<string, PluginLocale>
  /** Python modules missing from the current environment */
  missing?: string[]
}

/** Python interpreter used for plugins */
export interface PythonEnv { ok: boolean; path: string; version?: string; error?: string; missing: string[] }

export interface PluginCatalog {
  plugins: PluginManifest[]
  /** manifests that could not be loaded, with the reason */
  problems: string[]
  python?: PythonEnv
}

export interface PluginRun {
  pluginId: string
  version?: string
  state: 'running' | 'done' | 'error' | 'skipped' | 'cancelled'
  startedAt: string
  finishedAt: string
  error?: string
  log?: string
  rows: number
}

export interface PluginStatus {
  running: boolean
  stopping?: boolean
  current?: string
  progress: number
  message?: string
  queue: string[]
  runs: PluginRun[]
  counts: Record<string, number>
}

export interface ArtifactTable { columns: PluginColumn[]; rows: Record<string, unknown>[] }

export type SearchMode = 'keyword' | 'regex' | 'hash'

export interface SearchHit {
  id: string
  kind: 'filename' | 'content' | 'registry'
  path: string
  partition: string
  offset?: number
  context: string
  deleted?: boolean
}

// ---------------- case database / index / search ----------------

export interface IndexStatus {
  state: 'none' | 'running' | 'done' | 'partial' | 'error'
  dirs: number
  files: number
  errors: number
  indexedAt?: string
  seconds?: number
  error?: string
}

/** Case info from the case database (backend casedb.Info) */
export interface CaseRecord {
  number: string
  name: string
  examiner: string
  notes: string
  createdAt: string
  dir: string
}

export interface CaseSummary { info: CaseRecord; evidenceCount: number; open: boolean }

/** An indexed file (backend casedb.FileRow) */
export interface IndexedFile {
  id: number
  evidenceId: string
  part: number
  inode: number
  parentInode: number
  name: string
  path: string
  ext: string
  isDir: boolean
  size: number
  deleted: boolean
  created: number
  modified: number
  accessed: number
  changed: number
}

export interface TrailStep { name: string; inode: number }

export interface ContentHit {
  fileId: number
  evidenceId: string
  part: number
  inode: number
  name: string
  path: string
  deleted: boolean
  offset: number
  encoding: string
  context: string
}

export interface ContentStatus {
  state: 'idle' | 'running' | 'done' | 'cancelled' | 'error'
  query: string
  scanned: number
  total: number
  bytes: number
  seconds: number
  truncated: boolean
  error?: string
  hits: ContentHit[]
}

/** Show a file in the Files page: open its directory and select it */
export interface FileTarget { evidenceId: string; part: number; trail: TrailStep[]; inode: number }

// ---------------- export ----------------

/** One file or folder to export (path inside the partition is used for the report) */
export interface ExportItem { part: number; inode: number; name: string; path: string; isDir?: boolean }

export interface ExportRequest { items: ExportItem[]; dest: string; hash: boolean; includeDeleted: boolean }

export interface ExportStatus {
  state: 'idle' | 'running' | 'done' | 'cancelled' | 'error'
  evidence?: string
  dest?: string
  files: number
  done: number
  bytes: number
  totalBytes: number
  current?: string
  failed: number
  partial: number
  problems: string[]
  report?: string
  error?: string
  seconds: number
}

// ---------------- background tasks ----------------

/** A background job of the open case (GET /api/tasks) */
export interface Task {
  id: string
  kind: 'plugins' | 'index' | 'hash' | 'content' | 'export'
  evidenceId?: string
  evidenceName?: string
  state: 'running' | 'stopping' | 'done' | 'cancelled' | 'error'
  /** 0..1, -1 when unknown */
  progress: number
  current?: string
  message?: string
  done: number
  total: number
  queue: number
  error?: string
  started?: string
  canStop: boolean
}
