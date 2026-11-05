// Data source: pages depend only on this interface. live = real data from the Go backend; demo = built-in demo data.
import type {
  ArtifactTable, Evidence, EvidenceSummary, FileTarget, FsEntry, HashStatus, PluginCatalog, PluginLocale, PluginManifest, PluginStatus, SysinfoResult,
} from './types'
import { backend } from './client'
import { demoHash, demoListDir, demoReadFile, demoSysinfo } from './mock'

export interface DataSource {
  kind: 'live' | 'demo'
  listDir(ev: Evidence, part: number, inode?: number): Promise<{ inode: number; entries: FsEntry[] }>
  readFile(ev: Evidence, part: number, inode: number, offset: number, length: number): Promise<{ size: number; data: Uint8Array }>
  hashStatus(ev: Evidence): Promise<HashStatus>
  startHash(ev: Evidence): Promise<HashStatus>
  // plugins
  /** installed plugins, manifest problems and the Python environment (refresh re-checks dependencies) */
  plugins(refresh?: boolean): Promise<PluginCatalog>
  pluginStatus(ev: Evidence): Promise<PluginStatus>
  runPlugins(ev: Evidence, ids?: string[]): Promise<PluginStatus>
  stopPlugins(ev: Evidence): Promise<PluginStatus>
  artifacts(ev: Evidence, table: string): Promise<ArtifactTable>
  /** Evidence summary (reported by plugins through ctx.summary); null when there is none yet */
  summary(ev: Evidence): Promise<EvidenceSummary | null>
  /** find a file by path for "Show in Files" */
  locate(ev: Evidence, path: string): Promise<FileTarget>
}

function toSummary(m: Record<string, string>): EvidenceSummary | null {
  if (!m || Object.keys(m).length === 0) return null
  return {
    hostname: m.hostname || '—', os: m.os || '—', installDate: m.installDate || '—',
    lastUser: m.lastUser || '—', timezone: m.timezone || '—',
  }
}

export const liveSource: DataSource = {
  kind: 'live',
  listDir: (ev, part, inode) => backend.listDir(ev.id, part, inode),
  readFile: (ev, part, inode, offset, length) => backend.readFile(ev.id, part, inode, offset, length),
  hashStatus: (ev) => backend.hashStatus(ev.id),
  startHash: (ev) => backend.startHash(ev.id),
  plugins: (refresh) => backend.plugins(refresh),
  pluginStatus: (ev) => backend.pluginStatus(ev.id),
  runPlugins: (ev, ids) => backend.runPlugins(ev.id, ids),
  stopPlugins: (ev) => backend.stopPlugins(ev.id),
  artifacts: (ev, table) => backend.artifacts(ev.id, table),
  summary: async (ev) => toSummary(await backend.summary(ev.id)),
  locate: async (ev, path) => {
    const r = await backend.locate(ev.id, path)
    return { evidenceId: ev.id, part: r.part, trail: r.trail, inode: r.inode }
  },
}

// ---------------- demo source ----------------

const DEMO_ZH: PluginLocale = {
  name: 'Windows 系统信息',
  description: '从 SYSTEM / SOFTWARE / SAM 注册表提取主机名、系统版本、安装时间、时区、最后登录用户和本地账户。',
  outputs: {
    sysinfo: { name: '系统信息', group: '基本信息', columns: { item: '项目', value: '值', source: '来源' } },
    users: { name: '用户账户', group: '基本信息', columns: { name: '用户名', logons: '登录次数', lastLogin: '最后登录 (UTC)', source: '来源' } },
    timezone: { name: '时区设置', group: '基本信息', columns: { item: '项目', value: '值', source: '来源' } },
  },
  values: {
    'Computer name': '主机名', 'Host name (TCP/IP)': '主机名 (TCP/IP)', 'Operating system': '操作系统', 'Service pack': '补丁级别',
    Build: '内部版本', 'Registered owner': '注册所有者', 'Install date': '安装时间', 'Last logged-on user': '最后登录用户',
    'Last logged-on user (SAM)': '最后登录用户 (SAM)', 'UTC offset': 'UTC 偏移',
  },
}
const SRC: PluginManifest['outputs'][number]['columns'][number] = { key: 'source', title: 'Source', kind: 'source' }
const demoManifest: PluginManifest = {
  id: 'windows.sysinfo', name: 'Windows System Info', version: '1.1.0', locales: { 'zh-CN': DEMO_ZH },
  description: 'Host name, OS version, install date, time zone, last logged-on user and local accounts from the SYSTEM, SOFTWARE and SAM hives.',
  outputs: [
    { id: 'sysinfo', name: 'System Information', group: 'System', columns: [{ key: 'item', title: 'Item', width: 180 }, { key: 'value', title: 'Value', width: 320 }, SRC] },
    { id: 'users', name: 'User Accounts', group: 'System', columns: [
      { key: 'name', title: 'User Name', width: 150 }, { key: 'rid', title: 'RID', width: 70 }, { key: 'logons', title: 'Logons', width: 90 },
      { key: 'lastLogin', title: 'Last Logon (UTC)', width: 170, kind: 'time' }, SRC] },
    { id: 'timezone', name: 'Time Zone', group: 'System', columns: [{ key: 'item', title: 'Item', width: 180 }, { key: 'value', title: 'Value', width: 260 }, SRC] },
  ],
}
const demoTables = sysinfoTables(demoSysinfo)

export const demoSource: DataSource = {
  kind: 'demo',
  listDir: async (_ev, _part, inode) => demoListDir(inode),
  readFile: async (_ev, _part, inode, offset, length) => demoReadFile(inode, offset, length),
  hashStatus: async () => demoHash,
  startHash: async () => demoHash,
  plugins: async () => ({ plugins: [demoManifest], problems: [] }),
  pluginStatus: async () => ({
    running: false, progress: 1, queue: [],
    runs: [{ pluginId: demoManifest.id, state: 'done', startedAt: '2026-11-04 19:43:01', finishedAt: '2026-11-04 19:43:02', rows: 15 }],
    counts: Object.fromEntries(Object.entries(demoTables).map(([k, t]) => [k, t.rows.length])),
  }),
  runPlugins: async (ev) => demoSource.pluginStatus(ev),
  stopPlugins: async (ev) => demoSource.pluginStatus(ev),
  artifacts: async (_ev, table) => demoTables[table] ?? { columns: [], rows: [] },
  summary: async () => summarize(demoSysinfo),
  locate: async () => { throw new Error('not available in the demo case') },
}

/** Planned categories without a plugin yet (shown as "Planned" on the Analysis page) */
export const PLANNED: { id: string; name: string; group: string }[] = [
  { id: 'jumplist', name: 'Jump Lists', group: 'User Activity' },
  { id: 'shellbags', name: 'Shellbags', group: 'User Activity' },
]

// ---------------- time ----------------

/** "2021-05-03T10:44:28+00:00" → "2021-05-03 10:44:28" */
export function isoToText(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : unixToText(d.getTime() / 1000)
}

/** Unix seconds -> "YYYY-MM-DD HH:MM:SS" (UTC) */
export function unixToText(sec: number): string {
  if (!sec) return '—'
  return new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

function offsetText(min: number) {
  const s = min < 0 ? '-' : '+'
  const a = Math.abs(min)
  return `UTC${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

// ---------------- demo data shaping (old sysinfo output format -> result tables) ----------------

function summarize(s: SysinfoResult): EvidenceSummary {
  const sw = s.software
  const os = [sw.product_name, sw.csd_version].filter(Boolean).join(' ') + (sw.current_build ? ` (${sw.current_build})` : '')
  return {
    hostname: s.system.computer_name ?? s.system.tcpip_hostname ?? '—',
    os: os || '—',
    installDate: sw.install_date_utc ? `${isoToText(sw.install_date_utc)} UTC` : '—',
    lastUser: (sw.last_logged_on_user ?? '').split('\\').pop() || '—',
    timezone: `${s.system.timezone ?? 'unknown'} (${offsetText(s.system.utc_offset_minutes)})`,
  }
}

function sysinfoTables(s: SysinfoResult): Record<string, ArtifactTable> {
  const cs = s.system.control_set || 'ControlSet001'
  const CV = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
  const LOGON = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI'
  const TZ = `SYSTEM\\${cs}\\Control\\TimeZoneInformation`
  const sw = s.software
  const cols = Object.fromEntries(demoManifest.outputs.map((o) => [o.id, o.columns]))
  const row = (item: string, value: string | undefined, source: string) => (value ? [{ item, value, source }] : [])
  return {
    sysinfo: {
      columns: cols.sysinfo,
      rows: [
        ...row('Computer name', s.system.computer_name, `SYSTEM\\${cs}\\Control\\ComputerName\\ComputerName > ComputerName`),
        ...row('Host name (TCP/IP)', s.system.tcpip_hostname, `SYSTEM\\${cs}\\Services\\Tcpip\\Parameters > Hostname`),
        ...row('Operating system', sw.product_name, `${CV} > ProductName`),
        ...row('Service pack', sw.csd_version, `${CV} > CSDVersion`),
        ...row('Build', sw.current_build, `${CV} > CurrentBuildNumber`),
        ...row('Registered owner', sw.registered_owner, `${CV} > RegisteredOwner`),
        ...row('Install date', sw.install_date_utc && `${isoToText(sw.install_date_utc)} UTC`, `${CV} > InstallDate`),
        ...row('Last logged-on user', sw.last_logged_on_user, `${LOGON} > LastLoggedOnUser`),
        ...row('Last logged-on user (SAM)', sw.last_logged_on_sam_user, `${LOGON} > LastLoggedOnSAMUser`),
      ],
    },
    users: {
      columns: cols.users,
      rows: s.sam_users.map((u) => ({
        name: u.name ?? '?', rid: u.rid, logons: u.logon_count, lastLogin: isoToText(u.last_login_utc),
        source: `SAM\\Domains\\Account\\Users\\${u.rid.toString(16).toUpperCase().padStart(8, '0')} → F`,
      })),
    },
    timezone: {
      columns: cols.timezone,
      rows: [
        ...row('TimeZoneKeyName', s.system.timezone, `${TZ} → TimeZoneKeyName`),
        { item: 'UTC offset', value: offsetText(s.system.utc_offset_minutes), source: `${TZ} > ActiveTimeBias` },
      ],
    },
  }
}
