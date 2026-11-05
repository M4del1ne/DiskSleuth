// Demo data (used when the backend is not connected; same shapes as live data, see demoSource in source.ts).
// - evidence info, stored hashes, partitions, sysinfo plugin output: real results from windows7disk.E01
// - directory tree and search hits: illustrative
import type { CaseInfo, Evidence, FsEntry, HashStatus, SearchHit, SearchMode, SysinfoResult } from './types'

/** Internal shape of the demo directory tree (converted to FsEntry by listDir) */
interface FsNode {
  id: string
  name: string
  kind: 'dir' | 'file'
  inode: number
  size?: number
  created?: string
  modified?: string
  accessed?: string
  deleted?: boolean
  children?: FsNode[]
}

export const demoCase: CaseInfo = {
  id: 'case-demo',
  name: 'Win7 host examination (demo)',
  number: 'DS-2026-0001',
  examiner: 'Examiner',
  createdAt: '2026-11-04 19:42',
  location: 'D:\\test\\AI_something\\Forensics\\cases\\DS-2026-0001',
}

export const demoEvidence: Evidence = {
  id: 'ev-demo',
  name: 'windows7disk.E01',
  path: 'D:\\evidence\\windows7disk.E01',
  format: 'ewf',
  fileSize: 6146882452,
  mediaSize: 32212254720,
  sectorSize: 512,
  segments: 1,
  acquiredAt: '2021-05-04 22:41:40',
  acquiredWith: 'ADI3.4.0.1 (acquired on Win 201x)',
  storedHashes: {
    md5: 'e81ebb4413656ba1017f88e4f517e52e',
    sha1: '54c80983adc3a3d1b8bfc89d3db1bc46f726a71f',
  },
  partitions: [
    { index: 1, start: 0, length: 2048, description: 'Unallocated', allocated: false },
    { index: 2, start: 2048, length: 62910464, description: 'NTFS / exFAT (0x07)', allocated: true, fsType: 'NTFS', blockSize: 4096, rootInode: 5 },
    { index: 3, start: 62912512, length: 2048, description: 'Unallocated', allocated: false },
  ],
}

export const demoHash: HashStatus = {
  state: 'done', progress: 1, done: 32212254720, total: 32212254720,
  md5: 'e81ebb4413656ba1017f88e4f517e52e',
  sha1: '54c80983adc3a3d1b8bfc89d3db1bc46f726a71f',
  sha256: '4547a61a11064df47b272a4803788597f9a5e9ac0f11a93abe58c8b8588956cb',
  seconds: 118,
}

// real output of the sysinfo plugin for windows7disk.E01
export const demoSysinfo: SysinfoResult = {
  system: { control_set: 'ControlSet001', computer_name: 'WIN-49I0SNRJAMF', tcpip_hostname: 'WIN-49I0SNRJAMF', timezone: 'UTC', utc_offset_minutes: 0 },
  software: {
    product_name: 'Windows 7 Ultimate', csd_version: 'Service Pack 1', current_build: '7601', registered_owner: 'Windows 用户',
    install_date_utc: '2021-05-03T10:44:28+00:00', last_logged_on_user: '.\\poiuy', last_logged_on_sam_user: 'WIN-49I0SNRJAMF\\poiuy',
  },
  sam_users: [
    { rid: 1000, name: 'poiuy', last_login_utc: '2021-05-05T05:26:40.447259+00:00', logon_count: 18 },
    { rid: 1001, name: 'user', last_login_utc: '2021-05-04T08:18:55.753268+00:00', logon_count: 2 },
    { rid: 500, name: 'Administrator', last_login_utc: '2021-05-04T06:56:36.309251+00:00', logon_count: 8 },
    { rid: 501, name: 'Guest', last_login_utc: null, logon_count: 0 },
  ],
  partition: 2,
}

// ---------------- directory tree (illustrative) ----------------
let seq = 0
const f = (name: string, inode: number, size: number, created: string, modified = created, extra: Partial<FsNode> = {}): FsNode =>
  ({ id: `n${++seq}`, name, kind: 'file', inode, size, created, modified, accessed: modified, ...extra })
const d = (name: string, inode: number, created: string, children: FsNode[] = [], extra: Partial<FsNode> = {}): FsNode =>
  ({ id: `n${++seq}`, name, kind: 'dir', inode, created, modified: created, accessed: created, children, ...extra })

const T0 = '2009-07-14 03:20:08'
const TI = '2021-05-03 10:44:28'

export const demoTree: FsNode = d('C:', 5, T0, [
  f('$MFT', 0, 268435456, T0),
  f('$MFTMirr', 1, 4096, T0),
  f('$LogFile', 2, 67108864, T0),
  f('$Bitmap', 6, 983040, T0),
  f('$Boot', 7, 8192, T0),
  d('$Extend', 11, T0, [f('$UsnJrnl', 61210, 33554432, TI, '2021-05-05 05:30:12'), f('$ObjId', 25, 0, T0)]),
  d('$Recycle.Bin', 61002, TI, [
    d('S-1-5-21-2785011920-1012-1000', 63110, '2021-05-04 08:02:11', [
      f('$IA81KQ2.txt', 63881, 96, '2021-05-04 21:13:40', '2021-05-04 21:13:40'),
      f('$RA81KQ2.txt', 63882, 2310, '2021-05-04 20:55:02', '2021-05-04 21:01:19'),
      f('password-notes.txt', 63901, 1204, '2021-05-04 19:40:05', '2021-05-04 19:52:30', { deleted: true }),
    ]),
  ]),
  d('Program Files', 61021, TI, [
    d('Common Files', 61022, TI), d('Internet Explorer', 61030, TI), d('Windows Defender', 61040, TI),
  ]),
  d('ProgramData', 61050, TI, [d('Microsoft', 61051, TI)]),
  d('Users', 61060, TI, [
    d('Administrator', 62001, '2021-05-04 06:50:11', [d('Desktop', 62010, '2021-05-04 06:50:12'), f('NTUSER.DAT', 62002, 786432, '2021-05-04 06:50:11', '2021-05-04 07:12:40')]),
    d('poiuy', 61100, TI, [
      d('Desktop', 61110, TI, [
        f('schedule.docx', 63501, 18342, '2021-05-04 09:14:22', '2021-05-04 16:05:51'),
        f('accounts.xlsx', 63502, 9731, '2021-05-04 10:02:10', '2021-05-05 05:20:03'),
        f('desktop.ini', 61111, 282, TI),
      ]),
      d('Documents', 61120, TI, [f('backup-readme.txt', 63520, 512, '2021-05-04 11:31:09')]),
      d('Downloads', 61130, TI, [f('setup_tool.exe', 63610, 2938112, '2021-05-04 13:44:51'), f('old_notes.zip', 63611, 51820, '2021-05-04 13:50:02', '2021-05-04 13:50:02', { deleted: true })]),
      d('AppData', 61140, TI, [d('Local', 61141, TI), d('Roaming', 61142, TI)]),
      f('NTUSER.DAT', 61101, 1048576, TI, '2021-05-05 05:26:41'),
      f('ntuser.dat.LOG1', 61102, 262144, TI, '2021-05-05 05:26:41'),
    ]),
    d('user', 62501, '2021-05-04 08:18:55', [d('Desktop', 62510, '2021-05-04 08:18:56'), f('NTUSER.DAT', 62502, 524288, '2021-05-04 08:18:55', '2021-05-04 08:40:02')]),
    d('Public', 61070, T0, [d('Desktop', 61071, T0), d('Documents', 61072, T0)]),
  ]),
  d('Windows', 61200, T0, [
    d('System32', 61250, T0, [
      d('config', 61300, T0, [
        f('SAM', 61318, 262144, T0, '2021-05-05 05:26:40'),
        f('SECURITY', 61320, 262144, T0, '2021-05-05 05:26:40'),
        f('SOFTWARE', 61322, 39059456, T0, '2021-05-05 05:31:02'),
        f('SYSTEM', 61324, 12582912, T0, '2021-05-05 05:31:02'),
        f('DEFAULT', 61316, 262144, T0, '2021-05-05 05:28:17'),
      ]),
      d('winevt', 61400, T0, [d('Logs', 61401, T0, [
        f('Security.evtx', 61410, 1052672, TI, '2021-05-05 05:26:40'),
        f('System.evtx', 61411, 1052672, TI, '2021-05-05 05:31:00'),
        f('Application.evtx', 61412, 1052672, TI, '2021-05-05 05:29:44'),
      ])]),
      d('drivers', 61450, T0),
      f('cmd.exe', 61500, 345088, T0),
      f('notepad.exe', 61501, 193536, T0),
    ]),
    d('Prefetch', 61600, TI, [
      f('CMD.EXE-4A81B364.pf', 61610, 21342, '2021-05-04 09:01:12', '2021-05-05 05:27:09'),
      f('SETUP_TOOL.EXE-91C2D0AA.pf', 61611, 18220, '2021-05-04 13:45:03'),
    ]),
    d('Panther', 61700, TI, [f('setupact.log', 61701, 412233, TI)]),
  ]),
  f('pagefile.sys', 61800, 2147483648, TI, '2021-05-05 05:26:12'),
  f('hiberfil.sys', 61801, 2576646144, TI, '2021-05-05 05:31:40'),
])

// first 512 bytes of the SYSTEM hive (real data, regf header)
const SYSTEM_HEAD_B64 =
  'cmVnZigFAAAoBQAAbkVwnHJB1wEBAAAABQAAAAAAAAABAAAAIAAAAAAwvgABAAAAUwBZAFMAVABFAE0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMyIaAFvbN4RjR0AHgvN4+zMiGgBb2zeEY0dAB4LzePsAAAAAM2IaAFvbN4RjR0AHgvN4+xybXRtAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFkIH3Q='

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Read the first bytes of a file. SYSTEM returns real data, other files return illustrative data derived from the inode. */
function readFileHead(node: FsNode, len = 512): Uint8Array {
  if (node.name === 'SYSTEM' && node.inode === 61324) return b64ToBytes(SYSTEM_HEAD_B64).slice(0, len)
  const size = Math.min(len, node.size ?? 0)
  const out = new Uint8Array(size)
  const text = new TextEncoder().encode(`[demo data] ${node.name} · inode ${node.inode} · connect the backend to see real content.`)
  for (let i = 0; i < size; i++) out[i] = i < text.length ? text[i] : (i * 31 + node.inode) % 7 === 0 ? (i * 13 + node.inode) & 0xff : 0
  return out
}

// ---------------- demo source: directories and files ----------------
const byInode = new Map<number, FsNode>()
;(function index(n: FsNode) { byInode.set(n.inode, n); n.children?.forEach(index) })(demoTree)

const toUnix = (t?: string) => (t ? Date.parse(t.replace(' ', 'T') + 'Z') / 1000 : 0)

export function demoListDir(inode?: number): { inode: number; entries: FsEntry[] } {
  const node = byInode.get(inode ?? demoTree.inode) ?? demoTree
  return {
    inode: node.inode,
    entries: (node.children ?? []).map((c) => ({
      name: c.name, inode: c.inode, isDir: c.kind === 'dir', size: c.size ?? 0, deleted: !!c.deleted,
      created: toUnix(c.created), modified: toUnix(c.modified), accessed: toUnix(c.accessed), changed: toUnix(c.modified),
    })),
  }
}

export function demoReadFile(inode: number, offset: number, length: number): { size: number; data: Uint8Array } {
  const node = byInode.get(inode)
  if (!node) return { size: 0, data: new Uint8Array() }
  return { size: node.size ?? 0, data: readFileHead(node, offset + length).slice(offset) }
}

// ---------------- search (illustrative) ----------------
function flatten(node: FsNode, parent = ''): { node: FsNode; path: string }[] {
  const path = parent ? `${parent}\\${node.name}` : 'C:'
  const self = parent ? [{ node, path }] : []
  return [...self, ...(node.children ?? []).flatMap((c) => flatten(c, path))]
}

const contentCorpus: Omit<SearchHit, 'id'>[] = [
  { kind: 'registry', path: 'C:\\Windows\\System32\\config\\SOFTWARE', partition: 'Partition 2', offset: 0x01a3c410, context: 'LastLoggedOnUser = .\\poiuy' },
  { kind: 'registry', path: 'C:\\Windows\\System32\\config\\SYSTEM', partition: 'Partition 2', offset: 0x0042f188, context: 'ComputerName = WIN-49I0SNRJAMF' },
  { kind: 'content', path: 'C:\\Users\\poiuy\\Documents\\backup-readme.txt', partition: 'Partition 2', offset: 0x40, context: 'Ask poiuy to confirm the account and password before the backup' },
  { kind: 'content', path: 'C:\\$Recycle.Bin\\S-1-5-21-2785011920-1012-1000\\password-notes.txt', partition: 'Partition 2', offset: 0x0, context: 'mail: poiuy@example.com  password: ******', deleted: true },
  { kind: 'content', path: 'C:\\Windows\\System32\\winevt\\Logs\\Security.evtx', partition: 'Partition 2', offset: 0x000c1a20, context: 'TargetUserName: poiuy  LogonType: 2  WIN-49I0SNRJAMF' },
  { kind: 'content', path: 'C:\\Windows\\Panther\\setupact.log', partition: 'Partition 2', offset: 0x0003f2d8, context: 'Computer name set to WIN-49I0SNRJAMF' },
]

export function search(query: string, mode: SearchMode, scopes: Set<string>): SearchHit[] {
  const q = query.trim()
  if (!q) return []
  let match: (s: string) => boolean
  if (mode === 'regex') {
    let re: RegExp
    try { re = new RegExp(q, 'i') } catch { return [] }
    match = (s) => re.test(s)
  } else if (mode === 'hash') {
    const h = q.toLowerCase()
    const known = [demoHash.md5, demoHash.sha1, demoHash.sha256]
    return known.includes(h)
      ? [{ id: 'h1', kind: 'filename', path: demoEvidence.path, partition: 'Image', context: `whole-disk hash match: ${h}` }]
      : []
  } else {
    const ql = q.toLowerCase()
    match = (s) => s.toLowerCase().includes(ql)
  }
  const hits: SearchHit[] = []
  if (scopes.has('filename')) {
    for (const { node, path } of flatten(demoTree)) {
      if (match(node.name)) hits.push({ id: `f-${node.id}`, kind: 'filename', path, partition: 'Partition 2', context: node.kind === 'dir' ? 'Directory' : `File · ${node.size} bytes`, deleted: node.deleted })
    }
  }
  contentCorpus.forEach((c, i) => {
    if (c.kind === 'registry' && !scopes.has('registry')) return
    if (c.kind === 'content' && !scopes.has('content')) return
    if (c.deleted && !scopes.has('deleted')) return
    if (match(c.context)) hits.push({ ...c, id: `c-${i}` })
  })
  return hits
}
