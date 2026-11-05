// HTTP client for the Go backend.
// - In Electron: the main process starts the backend and passes URL and token through preload
// - In a plain browser (npm run dev:web): connects to a manually started dev backend
//   disksleuth-server -addr 127.0.0.1:7701 -token dev-token
import type {
  ArtifactTable, CaseRecord, CaseSummary, ContentStatus, Evidence, FsEntry, HashStatus, IndexStatus, IndexedFile, Partition,
  ExportRequest, ExportStatus, PluginCatalog, Task, PluginStatus, TrailStep,
} from './types'

interface Conn { url: string; token: string }
let conn: Conn | null = null

export interface BackendHealth { name: string; version: string; tsk: string }

export async function connectBackend(): Promise<{ health: BackendHealth } | { error: string }> {
  try {
    if (window.ds?.backend) {
      const info = await window.ds.backend.info()
      if (!info.url || !info.token) return { error: info.error ?? 'backend not started' }
      conn = { url: info.url, token: info.token }
    } else if (import.meta.env.DEV) {
      conn = { url: import.meta.env.VITE_DS_BACKEND ?? 'http://127.0.0.1:7701', token: import.meta.env.VITE_DS_TOKEN ?? 'dev-token' }
    } else {
      return { error: 'no backend in this environment' }
    }
    return { health: await call<BackendHealth>('/api/health') }
  } catch (e) {
    conn = null
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!conn) throw new Error('backend not connected')
  const res = await fetch(conn.url + path, {
    ...init,
    headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body as T
}

// ---------------- API ----------------

interface RawEvidence {
  id: string; name: string; path: string; format: string; fileSize: number; mediaSize: number
  sectorSize: number; segments: number; partitions: Partition[]
  index?: IndexStatus
  ewf?: { acquiredAt?: string; acquirySoftware?: string; acquiryOs?: string; storedMd5?: string; storedSha1?: string }
}

function toEvidence(r: RawEvidence): Evidence {
  const sw = [r.ewf?.acquirySoftware, r.ewf?.acquiryOs && `(acquired on ${r.ewf.acquiryOs})`].filter(Boolean).join(' ')
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    format: r.format === 'ewf' ? 'ewf' : 'raw',
    fileSize: r.fileSize,
    mediaSize: r.mediaSize,
    sectorSize: r.sectorSize,
    segments: r.segments,
    acquiredAt: r.ewf?.acquiredAt?.replace('T', ' '),
    acquiredWith: sw || undefined,
    storedHashes: { md5: r.ewf?.storedMd5 || undefined, sha1: r.ewf?.storedSha1 || undefined },
    partitions: r.partitions.map((p) => ({ ...p, fsType: p.fsType?.toUpperCase() })),
    index: r.index,
  }
}

interface RawCase { info: CaseRecord; evidence: RawEvidence[] }
export interface LiveCase { info: CaseRecord; evidence: Evidence[] }
const toCase = (c: RawCase): LiveCase => ({ info: c.info, evidence: c.evidence.map(toEvidence) })

export interface SearchParams { q: string; regex: boolean; inPath: boolean; deleted: boolean; kind: 'all' | 'file' | 'dir'; evidence?: string }

/** Older backends may return null when there are no hits */
const fixHits = (s: ContentStatus): ContentStatus => ({ ...s, hits: s.hits ?? [] })

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const backend = {
  // cases
  listCases: () => call<CaseSummary[]>('/api/cases'),
  createCase: async (req: { name: string; examiner: string; number?: string; location?: string }) => toCase(await call<RawCase>('/api/cases', post(req))),
  /** delete a case's database and work folder (evidence images are never touched) */
  deleteCase: (dir: string) => call<{ deleted: string; left: string[] }>('/api/cases', { method: 'DELETE', body: JSON.stringify({ dir }) }),
  openCase: async (dir: string) => toCase(await call<RawCase>('/api/cases/open', post({ dir }))),
  /** The case the backend currently has open (restored after a reload); null when none */
  currentCase: async () => {
    try { return toCase(await call<RawCase>('/api/case')) } catch { return null }
  },
  closeCase: () => call<{ ok: boolean }>('/api/case/close', { method: 'POST' }),
  audit: () => call<{ time: string; action: string; detail: string }[]>('/api/case/audit'),
  addEvidence: async (path: string) => toEvidence(await call<RawEvidence>('/api/case/evidence', post({ path }))),
  // evidence
  listDir: (ev: string, part: number, inode?: number) =>
    call<{ inode: number; entries: FsEntry[] }>(`/api/evidence/${ev}/partitions/${part}/dir${inode !== undefined ? `?inode=${inode}` : ''}`),
  readFile: async (ev: string, part: number, inode: number, offset: number, length: number) => {
    const r = await call<{ size: number; data: string }>(`/api/evidence/${ev}/partitions/${part}/file?inode=${inode}&offset=${offset}&length=${length}`)
    const bin = atob(r.data)
    const data = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
    return { size: r.size, data }
  },
  hashStatus: (ev: string) => call<HashStatus>(`/api/evidence/${ev}/hash`),
  startHash: (ev: string) => call<HashStatus>(`/api/evidence/${ev}/hash`, { method: 'POST' }),
  // plugins
  plugins: async (refresh = false) => {
    const c = await call<PluginCatalog>(`/api/plugins${refresh ? '?refresh=1' : ''}`)
    return { ...c, plugins: c.plugins ?? [], problems: c.problems ?? [] }
  },
  pluginStatus: (ev: string) => call<PluginStatus>(`/api/evidence/${ev}/plugins`),
  runPlugins: (ev: string, ids?: string[]) => call<PluginStatus>(`/api/evidence/${ev}/plugins/run`, post({ ids: ids ?? [] })),
  stopPlugins: (ev: string) => call<PluginStatus>(`/api/evidence/${ev}/plugins/stop`, { method: 'POST' }),
  artifacts: async (ev: string, table: string) => {
    const t = await call<ArtifactTable>(`/api/evidence/${ev}/artifacts/${encodeURIComponent(table)}`)
    return { columns: t.columns ?? [], rows: t.rows ?? [] }
  },
  summary: (ev: string) => call<Record<string, string>>(`/api/evidence/${ev}/summary`),
  /** resolve a path in the evidence (C:\..., %SystemRoot%\..., p2:/...) to its partition, directory trail and inode */
  locate: (ev: string, path: string) =>
    call<{ part: number; inode: number; isDir: boolean; path: string; trail: TrailStep[] }>(`/api/evidence/${ev}/locate?path=${encodeURIComponent(path)}`),
  indexStatus: (ev: string) => call<IndexStatus>(`/api/evidence/${ev}/index`),
  startIndex: (ev: string) => call<IndexStatus>(`/api/evidence/${ev}/index`, { method: 'POST' }),
  // search
  search: (p: SearchParams) => {
    const q = new URLSearchParams({ q: p.q, regex: p.regex ? '1' : '0', path: p.inPath ? '1' : '0', deleted: p.deleted ? '1' : '0', kind: p.kind })
    if (p.evidence) q.set('evidence', p.evidence)
    return call<{ hits: IndexedFile[]; truncated: boolean; ms: number }>(`/api/search?${q}`)
  },
  // background tasks
  tasks: () => call<Task[]>('/api/tasks'),
  cancelIndex: (ev: string) => call<IndexStatus>(`/api/evidence/${ev}/index`, { method: 'DELETE' }),
  // export
  startExport: (ev: string, req: ExportRequest) => call<ExportStatus>(`/api/evidence/${ev}/export`, post(req)),
  exportStatus: () => call<ExportStatus>('/api/export'),
  cancelExport: () => call<ExportStatus>('/api/export', { method: 'DELETE' }),
  fileTrail: (fileId: number) => call<{ file: IndexedFile; trail: TrailStep[] }>(`/api/files/${fileId}`),
  startContent: async (q: string, evidence?: string, deleted = true) => fixHits(await call<ContentStatus>('/api/search/content', post({ q, evidence, deleted }))),
  contentStatus: async () => fixHits(await call<ContentStatus>('/api/search/content')),
  cancelContent: async () => fixHits(await call<ContentStatus>('/api/search/content', { method: 'DELETE' })),
}
