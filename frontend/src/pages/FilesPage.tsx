import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  AlignLeft, Binary, ChevronRight, ChevronsUpDown, CircleAlert, Copy, CornerDownRight, Download, Eye, EyeOff, File, FileText,
  FolderOpen, FolderTree, HardDrive, Info, ListOrdered, Loader, PanelBottom, RefreshCw, Rows3, TextCursor, Trash2, Type,
} from 'lucide-react'
import { FolderIco, HexView, Panel, Splitter, TreeRow, useResizableWidth } from '../components/common'
import { DataGrid, type GridColumn } from '../components/DataGrid'
import { useContextMenu } from '../components/ContextMenu'
import { copyText } from '../util/clipboard'
import { requestExport } from '../components/ExportCenter'
import { TitleBarTools, ToolButton, ToolDivider } from '../components/TitleBarTools'
import type { Evidence, FileTarget, FsEntry, Partition } from '../api/types'
import { unixToText, type DataSource } from '../api/source'
import { formatBytes, formatInt } from '../util/format'
import { t } from '../i18n'

type DetailTab = 'props' | 'hex' | 'text'

/** Current directory: evidence + partition + path from the partition root */
interface Loc { ev: string; part: number; trail: { name: string; inode: number }[] }

const dirKey = (ev: string, part: number, inode: number) => `${ev}:${part}:${inode}`
const sortEntries = (a: FsEntry, b: FsEntry) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1)
const fsParts = (ev: Evidence) => ev.partitions.filter((p) => p.allocated && p.fsType)
const rootOf = (p: Partition) => p.rootInode ?? 5
const partName = (p: Partition) => t('Partition {n}', { n: p.index })

const LIST_COLUMNS: GridColumn[] = [
  { key: 'name', title: 'Name', width: 300 },
  { key: 'size', title: 'Size', width: 90, align: 'right' },
  { key: 'modified', title: 'Modified (UTC)', width: 170, className: 'num dim' },
  { key: 'created', title: 'Created (UTC)', width: 170, className: 'num dim' },
  { key: 'accessed', title: 'Accessed (UTC)', width: 170, className: 'num dim' },
  { key: 'inode', title: 'MFT #', width: 90, align: 'right', className: 'num dim' },
]

export function FilesPage({ evidence, selectedId, source, target, onTargetDone, onSelectEvidence }: {
  evidence: Evidence[]
  selectedId: string
  source: DataSource
  target?: FileTarget | null
  onTargetDone?: () => void
  onSelectEvidence?: (id: string) => void
}) {
  const evById = useCallback((id: string) => evidence.find((e) => e.id === id), [evidence])
  const [cache, setCache] = useState<Map<string, FsEntry[]>>(() => new Map())
  const [loading, setLoading] = useState<Set<string>>(() => new Set())
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([`ev:${selectedId}`]))
  const [loc, setLoc] = useState<Loc | null>(null)
  const [selInode, setSelInode] = useState<number | null>(null)
  const [showDeleted, setShowDeleted] = useState(true)
  const [showDetail, setShowDetail] = useState(true)
  const [tab, setTab] = useState<DetailTab>('props')
  const treeW = useResizableWidth('ds.files.treeWidth', 280, 200, 560)
  const detailH = useResizableWidth('ds.files.detailHeight', 270, 120, 700, { axis: 'y', invert: true })

  const load = useCallback(async (evId: string, part: number, inode: number, force = false) => {
    const k = dirKey(evId, part, inode)
    const ev = evById(evId)
    if (!ev || (!force && (cache.has(k) || loading.has(k)))) return
    setLoading((s) => new Set(s).add(k))
    try {
      const r = await source.listDir(ev, part, inode)
      setCache((c) => new Map(c).set(k, r.entries))
      setErrors((m) => { const n = new Map(m); n.delete(k); return n })
    } catch (e) {
      setErrors((m) => new Map(m).set(k, e instanceof Error ? e.message : String(e)))
    } finally {
      setLoading((s) => { const n = new Set(s); n.delete(k); return n })
    }
  }, [cache, loading, evById, source])

  const openDir = (evId: string, part: number, trail: Loc['trail']) => {
    setLoc({ ev: evId, part, trail })
    setSelInode(null)
    setExpanded((s) => {
      const n = new Set(s).add(`ev:${evId}`)
      trail.forEach((t) => n.add(dirKey(evId, part, t.inode)))
      return n
    })
    load(evId, part, trail[trail.length - 1].inode)
    if (evId !== selectedId) onSelectEvidence?.(evId)
  }

  // initially open the root of the selected evidence's first partition
  useEffect(() => {
    const ev = evById(selectedId)
    const p = ev && fsParts(ev)[0]
    if (!ev || !p || loc) return
    openDir(ev.id, p.index, [{ name: partName(p), inode: rootOf(p) }])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // "show in Files" from search: expand down to the file's directory and select it
  useEffect(() => {
    if (!target) return
    // the backend names the root step "Partition N"; use the label of the current UI language
    const trail = target.trail.map((s, i) => (i === 0 ? { ...s, name: t('Partition {n}', { n: target.part }) } : s))
    openDir(target.evidenceId, target.part, trail)
    target.trail.forEach((t) => load(target.evidenceId, target.part, t.inode))
    setSelInode(target.inode)
    onTargetDone?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const locEv = loc ? evById(loc.ev) : undefined
  const cur = loc ? loc.trail[loc.trail.length - 1] : null
  const curKey = loc && cur ? dirKey(loc.ev, loc.part, cur.inode) : ''
  const entries = (cache.get(curKey) ?? []).filter((e) => showDeleted || !e.deleted).slice().sort(sortEntries)
  const selIdx = selInode !== null ? entries.findIndex((e) => e.inode === selInode) : -1
  const selected = selIdx >= 0 ? entries[selIdx] : null

  const toggle = (k: string, onOpen?: () => void) => {
    setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
    onOpen?.()
  }

  // ---- tree: evidence > partitions > directories ----
  const renderDir = (evId: string, part: number, name: string, inode: number, trail: Loc['trail'], depth: number, icon?: ReactNode, deleted?: boolean): ReactNode => {
    const k = dirKey(evId, part, inode)
    const children = cache.get(k)
    const subdirs = (children ?? []).filter((e) => e.isDir && (showDeleted || !e.deleted)).sort(sortEntries)
    const isOpen = expanded.has(k)
    return (
      <div key={k + name}>
        <TreeRow
          depth={depth}
          label={<span className={deleted ? 'deleted-text' : undefined}>{name}</span>}
          icon={loading.has(k) ? <Loader size={15} className="spin muted" /> : icon ?? <FolderIco />}
          count={children?.length}
          hasChildren={children ? subdirs.length > 0 : true}
          expanded={isOpen}
          selected={loc?.ev === evId && loc.part === part && cur?.inode === inode}
          onToggle={() => toggle(k, () => load(evId, part, inode))}
          onSelect={() => openDir(evId, part, trail)}
          onContextMenu={(e) => dirMenu(e, evId, part, inode, trail, isOpen)}
        />
        {isOpen && subdirs.map((c) => renderDir(evId, part, c.name, c.inode, [...trail, { name: c.name, inode: c.inode }], depth + 1, undefined, c.deleted))}
      </div>
    )
  }

  const renderEvidence = (ev: Evidence) => {
    const k = `ev:${ev.id}`
    const parts = fsParts(ev)
    const isOpen = expanded.has(k)
    return (
      <div key={k}>
        <TreeRow
          depth={0}
          label={<b className="tree-ev">{ev.name}</b>}
          icon={<HardDrive size={16} className="ico-drive" />}
          count={ev.index?.files ? formatInt(ev.index.files) : undefined}
          hasChildren={parts.length > 0}
          expanded={isOpen}
          selected={false}
          title={ev.path}
          onToggle={() => toggle(k)}
          onSelect={() => toggle(k)}
          onContextMenu={(e) => evidenceMenu(e, ev)}
        />
        {isOpen && parts.map((p) => renderDir(ev.id, p.index, `${partName(p)} · ${p.fsType}`, rootOf(p), [{ name: partName(p), inode: rootOf(p) }], 1,
          <HardDrive size={15} className="ico-part" />))}
        {isOpen && parts.length === 0 && <div className="tree-note">{t('No recognized file system')}</div>}
      </div>
    )
  }

  // ---- preview: a request sequence number drops stale results; content read so far is cached by evidence:partition:inode ----
  const [preview, setPreview] = useState<{ inode: number; data?: Uint8Array; error?: string } | null>(null)
  const reqSeq = useRef(0)
  const contentCache = useRef(new Map<string, Uint8Array>())
  const needContent = !!selected && !selected.isDir && tab !== 'props'
  const selKey = selected?.inode ?? null
  useEffect(() => {
    if (!needContent || selKey === null || !loc || !locEv) return
    const ck = dirKey(loc.ev, loc.part, selKey)
    const cached = contentCache.current.get(ck)
    if (cached) { setPreview({ inode: selKey, data: cached }); return }
    const id = ++reqSeq.current
    setPreview({ inode: selKey })
    source.readFile(locEv, loc.part, selKey, 0, 4096).then(
      (r) => { contentCache.current.set(ck, r.data); if (reqSeq.current === id) setPreview({ inode: selKey, data: r.data }) },
      (e) => reqSeq.current === id && setPreview({ inode: selKey, error: e instanceof Error ? e.message : String(e) }),
    )
  }, [needContent, selKey, loc, locEv, source])

  // scroll the selected row into view (needed after "show in Files")
  useEffect(() => {
    if (selIdx < 0) return
    document.querySelectorAll('.files-list tbody tr')[selIdx]?.scrollIntoView({ block: 'nearest' })
  }, [selIdx])

  const pathText = loc ? loc.trail.map((t) => t.name).join('\\') : ''
  const fullPath = (e: FsEntry) => `${locEv?.name ?? ''}\\${pathText}\\${e.name}`

  // ---- right-click menus ----
  const menu = useContextMenu()
  const cellText = (e: FsEntry, key: string): string => ({
    name: e.name, size: e.isDir ? '' : formatBytes(e.size), modified: unixToText(e.modified), created: unixToText(e.created),
    accessed: unixToText(e.accessed), inode: String(e.inode),
  } as Record<string, string>)[key] ?? ''
  const partPath = (e: FsEntry) => '\\' + [...(loc?.trail.slice(1).map((s) => s.name) ?? []), e.name].join('\\')
  const rowTsv = (e: FsEntry) => LIST_COLUMNS.map((c) => cellText(e, c.key)).join('\t')
  const view = (which: DetailTab) => { setShowDetail(true); setTab(which) }
  const live = source.kind === 'live'
  const exportEntry = (e: FsEntry) => {
    if (locEv && loc) requestExport(locEv, [{ part: loc.part, inode: e.inode, name: e.name, path: partPath(e), isDir: e.isDir }])
  }
  const openEntry = (e: FsEntry) => { if (e.isDir && loc) openDir(loc.ev, loc.part, [...loc.trail, { name: e.name, inode: e.inode }]) }

  const listMenu = (ev: ReactMouseEvent, i: number, col: GridColumn | null) => {
    const e = entries[i]
    const cell = col ? cellText(e, col.key) : ''
    menu.open(ev, [
      { label: t('Copy'), icon: Copy, hint: cell, disabled: !cell, onClick: () => copyText(cell) },
      { label: t('Copy name'), icon: Type, hint: e.name, onClick: () => copyText(e.name) },
      { label: t('Copy full path'), icon: FolderTree, hint: fullPath(e), onClick: () => copyText(fullPath(e)) },
      { label: t('Copy path in partition'), icon: CornerDownRight, hint: partPath(e), onClick: () => copyText(partPath(e)) },
      { label: t('Copy row'), icon: Rows3, shortcut: 'Ctrl+C', onClick: () => copyText(rowTsv(e), t('row')) },
      'sep',
      e.isDir && { label: t('Open'), icon: FolderOpen, shortcut: 'Enter', onClick: () => openEntry(e) },
      !e.isDir && { label: t('Properties'), icon: Info, onClick: () => view('props') },
      !e.isDir && { label: t('View as hex'), icon: Binary, onClick: () => view('hex') },
      !e.isDir && { label: t('View as text'), icon: FileText, onClick: () => view('text') },
      'sep',
      { label: e.isDir ? t('Export folder…') : t('Export file…'), icon: Download, disabled: !live, onClick: () => exportEntry(e) },
      'sep',
      {
        label: t('Copy all names in this folder'), icon: ListOrdered, hint: t('{n} items', { n: formatInt(entries.length) }),
        onClick: () => copyText(entries.map((x) => x.name).join('\n'), t('{n} names', { n: entries.length })),
      },
    ])
  }

  const dirMenu = (ev: ReactMouseEvent, evId: string, part: number, inode: number, trail: Loc['trail'], isOpen: boolean) => {
    const path = [evById(evId)?.name ?? '', ...trail.map((s) => s.name)].join('\\')
    const name = trail[trail.length - 1].name
    menu.open(ev, [
      { label: t('Open'), icon: FolderOpen, onClick: () => openDir(evId, part, trail) },
      { label: isOpen ? t('Collapse') : t('Expand'), icon: ChevronsUpDown, onClick: () => toggle(dirKey(evId, part, inode), () => load(evId, part, inode)) },
      { label: t('Refresh'), icon: RefreshCw, onClick: () => load(evId, part, inode, true) },
      'sep',
      {
        label: t('Export folder…'), icon: Download, disabled: !live,
        onClick: () => {
          const evObj = evById(evId)
          if (evObj) requestExport(evObj, [{ part, inode, name, path: '\\' + trail.slice(1).map((s) => s.name).join('\\'), isDir: true }])
        },
      },
      'sep',
      { label: t('Copy name'), icon: Type, hint: name, onClick: () => copyText(name) },
      { label: t('Copy full path'), icon: FolderTree, hint: path, onClick: () => copyText(path) },
    ])
  }

  const evidenceMenu = (ev: ReactMouseEvent, e: Evidence) => menu.open(ev, [
    { label: expanded.has(`ev:${e.id}`) ? t('Collapse') : t('Expand'), icon: ChevronsUpDown, onClick: () => toggle(`ev:${e.id}`) },
    'sep',
    { label: t('Copy name'), icon: Type, hint: e.name, onClick: () => copyText(e.name) },
    { label: t('Copy image path'), icon: HardDrive, hint: e.path, onClick: () => copyText(e.path) },
  ])

  // details panel: properties (one value / all), hex and text (selection / everything shown)
  const detailMenu = (ev: ReactMouseEvent) => {
    const target = ev.target as HTMLElement
    const sel = window.getSelection()?.toString() ?? ''
    if (tab === 'props') {
      const dl = target.closest('dl')
      if (!dl) return
      const dd = target.closest('dd') ?? (target.closest('dt')?.nextElementSibling as HTMLElement | null)
      const pairs = [...dl.querySelectorAll('dt')].map((dt) => `${dt.textContent}: ${(dt.nextElementSibling as HTMLElement | null)?.innerText ?? ''}`)
      menu.open(ev, [
        !!sel && { label: t('Copy selection'), icon: TextCursor, hint: sel, onClick: () => copyText(sel) },
        !!dd && { label: t('Copy value'), icon: Copy, hint: dd.innerText, onClick: () => copyText(dd.innerText) },
        { label: t('Copy all properties'), icon: AlignLeft, onClick: () => copyText(pairs.join('\n'), t('properties')) },
      ])
      return
    }
    const pane = (ev.currentTarget as HTMLElement).querySelector('.hex, .text-view') as HTMLElement | null
    const bytes = preview?.data
    if (!pane || !bytes) return
    menu.open(ev, [
      !!sel && { label: t('Copy selection'), icon: TextCursor, hint: sel, onClick: () => copyText(sel) },
      { label: tab === 'hex' ? t('Copy hex view') : t('Copy text'), icon: Copy, onClick: () => copyText(pane.innerText) },
      tab === 'hex' && {
        label: t('Copy bytes as hex string'), icon: Binary, hint: t('{n} bytes', { n: formatInt(bytes.length) }),
        onClick: () => copyText([...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''), t('{n} bytes', { n: formatInt(bytes.length) })),
      },
    ])
  }

  return (
    <div className="page">
      <TitleBarTools>
        <ToolButton icon={RefreshCw} label={t('Refresh')} onClick={() => loc && cur && load(loc.ev, loc.part, cur.inode, true)} title={t('Reload the current directory')} />
        <ToolButton icon={showDeleted ? Eye : EyeOff} label={t('Show deleted')} active={showDeleted} onClick={() => setShowDeleted((v) => !v)} title={t('Show deleted files that may still be recoverable')} />
        <ToolButton icon={Download} label={t('Export')} disabled={!selected || source.kind !== 'live'} onClick={() => selected && exportEntry(selected)}
          title={t('Export the selected file or folder to this computer')} />
        <ToolDivider />
        <ToolButton icon={PanelBottom} label={t('Details')} active={showDetail} onClick={() => setShowDetail((v) => !v)} />
      </TitleBarTools>

      <div className="files-layout" style={{ gridTemplateColumns: `${treeW.width}px 10px minmax(0, 1fr)` }}>
        <section className="panel">
          <div className="panel-body flush tree-scroll">
            <div className="tree">{evidence.map(renderEvidence)}</div>
          </div>
        </section>

        <Splitter onPointerDown={treeW.startDrag} onReset={treeW.reset} />

        <div className="files-main">
        <Panel
          className="grow"
          title={
            <nav className="breadcrumb" title={`${locEv?.name ?? ''}\\${pathText}`}>
              {locEv && <span><span className="bc-ev">{locEv.name}</span></span>}
              {loc?.trail.map((t, i) => (
                <span key={`${t.inode}-${i}`}>
                  <ChevronRight size={14} className="bc-sep" />
                  {i === loc.trail.length - 1
                    ? <b>{t.name}</b>
                    : <button onClick={() => openDir(loc.ev, loc.part, loc.trail.slice(0, i + 1))}>{t.name}</button>}
                </span>
              ))}
            </nav>
          }
          count={cache.has(curKey) ? t('{n} items', { n: formatInt(entries.length) }) : undefined}
          bodyClass="flush list-body files-list"
        >
          {errors.get(curKey) && <div className="err-box" style={{ margin: 10 }}><CircleAlert size={15} />{errors.get(curKey)}</div>}
          <DataGrid
            columns={LIST_COLUMNS.map((c) => ({ ...c, title: t(c.title) }))}
            rows={entries}
            storageKey="ds.grid.files"
            rowKey={(e) => `${e.inode}-${e.name}`}
            selected={selIdx >= 0 ? selIdx : null}
            rowClass={(e) => (e.deleted ? 'deleted' : undefined)}
            onSelect={(i) => { setSelInode(entries[i].inode); setPreview(null) }}
            onActivate={(i) => openEntry(entries[i])}
            onCellContextMenu={listMenu}
            onCopy={(i) => copyText(rowTsv(entries[i]), t('row'))}
            render={(e, c) => {
              switch (c.key) {
                case 'name':
                  return (
                    <div className="cell-name">
                      {e.isDir ? <FolderIco /> : e.deleted ? <Trash2 size={16} /> : <File size={16} className="ico-file" />}
                      <span title={e.name}>{e.name}</span>
                      {e.deleted && <span className="badge danger">{t('Deleted')}</span>}
                    </div>
                  )
                case 'size': return e.isDir ? '' : formatBytes(e.size)
                case 'modified': return unixToText(e.modified)
                case 'created': return unixToText(e.created)
                case 'accessed': return unixToText(e.accessed)
                default: return String(e.inode)
              }
            }}
          />
          {loading.has(curKey) && !cache.has(curKey) && <div className="empty-mini"><Loader size={20} className="spin" />{t('Reading directory…')}</div>}
          {cache.has(curKey) && entries.length === 0 && <div className="empty-mini">{t('Empty directory')}</div>}
        </Panel>

        {showDetail && <Splitter orientation="horizontal" onPointerDown={detailH.startDrag} onReset={detailH.reset} />}
        {showDetail && (
          <section className="panel files-detail" style={{ height: detailH.width }}>
            <div className="tabs">
              <button className={tab === 'props' ? 'active' : ''} onClick={() => setTab('props')}>{t('Properties')}</button>
              <button className={tab === 'hex' ? 'active' : ''} onClick={() => setTab('hex')}>{t('Hex')}</button>
              <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>{t('Text')}</button>
            </div>
            <div className="panel-body detail-body" onContextMenu={detailMenu}>
              {!selected ? (
                <div className="empty-mini"><FileText size={28} strokeWidth={1.4} />{t('Select a file to see its details')}</div>
              ) : tab === 'props' ? (
                <dl className="kv kv-wide">
                  <dt>{t('Path')}</dt><dd className="kv-full">{fullPath(selected)}</dd>
                  <dt>{t('Name')}</dt><dd>{selected.name}</dd>
                  <dt>{t('Created')}</dt><dd className="num">{unixToText(selected.created)}</dd>
                  <dt>{t('Type')}</dt><dd>{selected.isDir ? t('Directory') : t('File')}</dd>
                  <dt>{t('Modified')}</dt><dd className="num">{unixToText(selected.modified)}</dd>
                  <dt>{t('State')}</dt><dd>{selected.deleted ? <span className="badge danger">{t('Deleted · may be recoverable')}</span> : <span className="badge ok">{t('Allocated')}</span>}</dd>
                  <dt>{t('Accessed')}</dt><dd className="num">{unixToText(selected.accessed)}</dd>
                  <dt>{t('Size')}</dt><dd>{selected.isDir ? '—' : <>{formatBytes(selected.size)} <span className="muted">({t('{n} bytes', { n: formatInt(selected.size) })})</span></>}</dd>
                  <dt>{t('Metadata changed')}</dt><dd className="num">{unixToText(selected.changed)}</dd>
                  <dt>{t('MFT record')}</dt><dd className="num">{selected.inode}</dd>
                  <dt>{t('Time basis')}</dt><dd className="muted">UTC ($STANDARD_INFORMATION)</dd>
                </dl>
              ) : selected.isDir ? (
                <div className="empty-mini">{t('Directories have no content view')}</div>
              ) : !preview || preview.inode !== selected.inode || (!preview.data && !preview.error) ? (
                <div className="empty-mini"><Loader size={20} className="spin" />{t('Reading…')}</div>
              ) : preview.error ? (
                <div className="err-box"><CircleAlert size={15} />{preview.error}</div>
              ) : preview.data!.length === 0 ? (
                <div className="empty-mini">{t('The file is empty or unreadable (data of deleted files may have been overwritten)')}</div>
              ) : tab === 'hex' ? (
                <>
                  <HexView bytes={preview.data!} />
                  {selected.size > preview.data!.length && <div className="muted hash-note">{t('Showing the first {size} only', { size: formatBytes(preview.data!.length) })}</div>}
                </>
              ) : (
                <pre className="text-view selectable">{new TextDecoder('utf-8', { fatal: false }).decode(preview.data!).replace(/[\x00-\x08\x0e-\x1f]/g, '·')}</pre>
              )}
            </div>
          </section>
        )}
        </div>
      </div>
      {menu.node}
    </div>
  )
}
