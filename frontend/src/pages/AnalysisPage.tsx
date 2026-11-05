import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  AlignLeft, Columns3, Copy, FileText, FolderSearch, LocateFixed, Quote, Rows3, Table2,
  AppWindow, CircleAlert, CircleCheck, CircleMinus, CircleStop, Clock, Cpu, Download, FileClock, FileSearch, FolderOpen, Globe,
  HardDrive, History, Info, KeyRound, Link2, ListOrdered, Loader, LogIn, MonitorSmartphone, MousePointerClick, Network, Package,
  Play, Plug, Puzzle, Recycle, RefreshCw, Rocket, ScrollText, Search, Server, Terminal, TriangleAlert, UserRoundSearch, Usb, Users,
  Wifi, Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { EmptyState, Panel, Splitter, TreeRow, useResizableWidth } from '../components/common'
import { DataGrid, type GridColumn } from '../components/DataGrid'
import { useContextMenu } from '../components/ContextMenu'
import { toast } from '../components/Toast'
import { copyText, looksLikePath } from '../util/clipboard'
import { requestExport } from '../components/ExportCenter'
import { backend } from '../api/client'
import { TitleBarTools, ToolButton } from '../components/TitleBarTools'
import type { ArtifactTable, Evidence, FileTarget, PluginCatalog, PluginColumn, PluginManifest, PluginOutput, PluginStatus } from '../api/types'
import { PLANNED, type DataSource } from '../api/source'
import { localizeManifest, localizeValue } from '../api/plugins'
import { formatBytes, formatInt } from '../util/format'
import { t } from '../i18n'

// a fixed icon and color per result table
const ICONS: Record<string, [LucideIcon, string]> = {
  sysinfo: [Info, '#3577d4'], users: [Users, '#7c5cd6'], timezone: [Clock, '#d98a1c'], software: [Package, '#e0663d'],
  services: [Server, '#5a7184'], runkeys: [Rocket, '#c2549a'],
  netifaces: [Network, '#2a9bc7'], netprofiles: [Wifi, '#2a9bc7'],
  usbstor: [HardDrive, '#5b6bd6'], usb: [Usb, '#5b6bd6'], mounted: [Plug, '#5b6bd6'],
  lnk: [Link2, '#0f9e90'], recentdocs: [FileClock, '#0f9e90'], runmru: [Terminal, '#0f9e90'], typedpaths: [FolderOpen, '#0f9e90'],
  searchterms: [Search, '#0f9e90'], jumplist: [ListOrdered, '#c2549a'], shellbags: [FolderOpen, '#c2549a'],
  prefetch: [Zap, '#d4a017'], userassist: [MousePointerClick, '#d4a017'], shimcache: [Cpu, '#d4a017'], bam: [AppWindow, '#d4a017'],
  browser_history: [History, '#3a8ee6'], browser_downloads: [Download, '#3a8ee6'],
  recyclebin: [Recycle, '#3c9a5f'],
  evt_logons: [LogIn, '#8a6d4f'], evt_system: [ScrollText, '#8a6d4f'], evt_security: [KeyRound, '#8a6d4f'],
}
// canonical (English) group names, their order and icons
const GROUPS: [string, LucideIcon, string][] = [
  ['System', Info, '#3577d4'],
  ['Network', Network, '#2a9bc7'],
  ['Devices', MonitorSmartphone, '#5b6bd6'],
  ['User Activity', UserRoundSearch, '#0f9e90'],
  ['Program Execution', Zap, '#d4a017'],
  ['Browsers', Globe, '#3a8ee6'],
  ['File System', HardDrive, '#3c9a5f'],
  ['Event Logs', ScrollText, '#8a6d4f'],
]
const groupRank = (g: string) => { const i = GROUPS.findIndex((x) => x[0] === g); return i < 0 ? 99 : i }

interface Cat { id: string; name: string; group: string; groupLabel: string; plugin?: PluginManifest; output?: PluginOutput }

function cellText(v: unknown, col: PluginColumn, plugin?: PluginManifest): string {
  if (v === null || v === undefined || v === '') return ''
  if (col.kind === 'size' && typeof v === 'number') return v ? formatBytes(v) : ''
  const s = String(v)
  return !col.kind || col.kind === 'text' ? localizeValue(plugin, s) : s
}
const cellClass = (col: PluginColumn) =>
  col.kind === 'mono' ? 'mono' : col.kind === 'time' || col.kind === 'size' ? 'num dim' : undefined

const STATE_LABEL: Record<string, string> = { done: 'Done', error: 'Failed', skipped: 'Not applicable', cancelled: 'Stopped', running: 'Running' }

export function AnalysisPage({ evidence, selectedId, source, onSelectEvidence, onLocate }: {
  evidence: Evidence[]; selectedId: string; source: DataSource; onSelectEvidence?: (id: string) => void
  onLocate?: (t: FileTarget) => void
}) {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const [statuses, setStatuses] = useState<Record<string, PluginStatus>>({})
  const [sel, setSel] = useState<{ ev: string; cat: string }>({ ev: selectedId, cat: 'sysinfo' })
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([`ev:${selectedId}`, `${selectedId}:System`]))
  const [table, setTable] = useState<{ key: string; data: ArtifactTable } | null>(null)
  const [rowIdx, setRowIdx] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const treeW = useResizableWidth('ds.analysis.treeWidth', 290, 200, 560)
  const detailH = useResizableWidth('ds.analysis.detailHeight', 230, 100, 700, { axis: 'y', invert: true })

  const evById = useCallback((id: string) => evidence.find((e) => e.id === id), [evidence])
  const ev = evById(sel.ev) ?? evidence[0]

  const refreshStatus = useCallback((id: string) => {
    const e = evById(id)
    if (e) source.pluginStatus(e).then((st) => setStatuses((m) => ({ ...m, [id]: st })), () => {})
  }, [evById, source])
  const loadCatalog = useCallback((refresh = false) => {
    source.plugins(refresh).then(setCatalog, (e) => setErr(String(e)))
  }, [source])

  useEffect(() => {
    loadCatalog()
    evidence.forEach((e) => refreshStatus(e.id))
  }, [evidence, loadCatalog, refreshStatus])

  // poll every second while an evidence item is running plugins
  const runningIds = Object.entries(statuses).filter(([, s]) => s.running).map(([id]) => id).join(',')
  useEffect(() => {
    if (!runningIds) return
    const timer = window.setInterval(() => runningIds.split(',').forEach(refreshStatus), 1000)
    return () => clearInterval(timer)
  }, [runningIds, refreshStatus])

  const plugins = catalog?.plugins
  const cats: Cat[] = useMemo(() => {
    const out: Cat[] = []
    for (const raw of plugins ?? []) {
      const p = localizeManifest(raw)
      for (const o of p.outputs) out.push({ id: o.id, name: o.name, group: o.group, groupLabel: o.groupLabel, plugin: p, output: o })
    }
    for (const p of PLANNED) if (!out.some((c) => c.id === p.id)) out.push({ ...p, name: t(p.name), groupLabel: t(p.group) })
    return out
  }, [plugins])
  const groups = [...new Set(cats.map((c) => c.group))].sort((a, b) => groupRank(a) - groupRank(b))

  const status = statuses[ev?.id ?? '']
  const cat = cats.find((c) => c.id === sel.cat) ?? cats[0]
  const run = cat?.plugin ? status?.runs.find((r) => r.pluginId === cat.plugin!.id) : undefined
  const busy = (st: PluginStatus | undefined, pid?: string) => !!pid && !!st && (st.current === pid || st.queue.includes(pid))

  // (re)load the table when the selection changes or its plugin finishes
  const tableKey = `${ev?.id}|${cat?.id}|${run?.finishedAt ?? ''}|${status?.counts[cat?.id ?? ''] ?? 0}`
  const loadTable = useCallback(() => {
    if (!ev || !cat?.output) return
    const key = `${ev.id}|${cat.id}`
    source.artifacts(ev, cat.id).then((data) => setTable({ key, data }), (e) => setErr(String(e)))
  }, [ev, cat, source])
  useEffect(() => { setRowIdx(null); loadTable() }, [tableKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const runPlugins = async (ids?: string[]) => {
    if (!ev) return
    try {
      setErr(null)
      const st = await source.runPlugins(ev, ids)
      setStatuses((m) => ({ ...m, [ev.id]: st }))
    } catch (e) { setErr(String(e)) }
  }
  const stopPlugins = async () => {
    if (!ev) return
    const id = ev.id
    setStatuses((m) => (m[id] ? { ...m, [id]: { ...m[id], stopping: true } } : m))
    try {
      const st = await source.stopPlugins(ev)
      setStatuses((m) => ({ ...m, [id]: st }))
    } catch (e) { setErr(String(e)) }
  }

  const select = (evId: string, catId: string) => {
    setSel({ ev: evId, cat: catId })
    if (evId !== selectedId) onSelectEvidence?.(evId)
  }
  const toggle = (k: string) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })

  const data = table?.key === `${ev?.id}|${cat?.id}` ? table.data : null
  // column titles come from the localized manifest; fall back to what the backend returned
  const allCols = cat?.output?.columns ?? data?.columns ?? []
  // the grid hides the "source" column; it is shown in the record details below
  const gridCols: GridColumn[] = allCols.filter((c) => c.kind !== 'source')
    .map((c) => ({ key: c.key, title: c.title, width: c.width ?? 220, align: c.kind === 'size' ? 'right' : 'left', className: cellClass(c) }))
  const row = data && rowIdx !== null ? data.rows[rowIdx] : null
  const evRunning = !!status?.running
  const missing = cat?.plugin?.missing ?? []
  const python = catalog?.python
  const pythonBroken = source.kind === 'live' && python && !python.ok

  // ---- tree: evidence > group > category ----
  const renderEvidence = (e: Evidence) => {
    const st = statuses[e.id]
    const total = st ? Object.values(st.counts).reduce((a, b) => a + b, 0) : undefined
    const ek = `ev:${e.id}`
    return (
      <div key={ek}>
        <TreeRow depth={0} label={<b className="tree-ev">{e.name}</b>} icon={<HardDrive size={16} className="ico-drive" />}
          count={st?.running ? <Loader size={13} className="spin" /> : total !== undefined ? formatInt(total) : undefined}
          hasChildren expanded={expanded.has(ek)} selected={false} title={e.path}
          onToggle={() => toggle(ek)} onSelect={() => toggle(ek)} />
        {expanded.has(ek) && groups.map((g) => {
          const gk = `${e.id}:${g}`
          const items = cats.filter((c) => c.group === g)
          const gCount = items.reduce((s, c) => s + (st?.counts[c.id] ?? 0), 0)
          const [, GIcon, gColor] = GROUPS.find((x) => x[0] === g) ?? [g, FolderOpen, '#8a94a3']
          return (
            <div key={gk}>
              <TreeRow depth={1} label={items[0]?.groupLabel ?? g} icon={<GIcon size={16} color={gColor} style={{ flex: 'none' }} />}
                count={st ? formatInt(gCount) : undefined} hasChildren expanded={expanded.has(gk)} selected={false}
                onToggle={() => toggle(gk)} onSelect={() => toggle(gk)} />
              {expanded.has(gk) && items.map((c) => {
                const [Icon, color] = ICONS[c.id] ?? [FileSearch, '#8a94a3']
                const n = st?.counts[c.id]
                const r = c.plugin && st?.runs.find((x) => x.pluginId === c.plugin!.id)
                return (
                  <TreeRow key={c.id} depth={2} label={c.name}
                    icon={<Icon size={16} color={color} className={c.plugin ? undefined : 'ico-off'} style={{ flex: 'none' }} />}
                    count={!c.plugin ? <span className="badge sm-badge">{t('Planned')}</span>
                      : busy(st, c.plugin.id) ? <Loader size={13} className="spin" />
                      : c.plugin.missing?.length ? <TriangleAlert size={13} className="warn-ico" />
                      : r?.state === 'error' ? <CircleAlert size={13} className="err-ico" />
                      : r?.state === 'skipped' ? <CircleMinus size={13} />
                      : n !== undefined ? formatInt(n) : r ? '0' : '—'}
                    selected={e.id === ev?.id && c.id === cat?.id}
                    onSelect={() => select(e.id, c.id)} />
                )
              })}
            </div>
          )
        })}
      </div>
    )
  }

  const pluginName = (id?: string) => cats.find((c) => c.plugin?.id === id)?.plugin?.name ?? id

  // ---- right-click menu ----
  const menu = useContextMenu()
  const sourceCol = allCols.find((c) => c.kind === 'source')
  const text = (r: Record<string, unknown>, c: PluginColumn) => cellText(r[c.key], c, cat?.plugin)
  const tsv = (r: Record<string, unknown>) => allCols.filter((c) => c.kind !== 'source').map((c) => text(r, c)).join('\t')
  const named = (r: Record<string, unknown>) => allCols.map((c) => `${c.title}: ${text(r, c)}`).join('\n')
  const showInFiles = async (path: string) => {
    if (!ev || !onLocate) return
    try {
      onLocate(await source.locate(ev, path))
    } catch {
      toast(t('Not found in the evidence: {path}', { path }), 'error')
    }
  }
  const exportSource = async (path: string) => {
    if (!ev) return
    try {
      const r = await backend.locate(ev.id, path)
      requestExport(ev, [{ part: r.part, inode: r.inode, name: r.path.split('/').pop() || r.path, path: r.path.split('/').join('\\'), isDir: r.isDir }])
    } catch {
      toast(t('Not found in the evidence: {path}', { path }), 'error')
    }
  }
  const recordMenu = (e: ReactMouseEvent, r: Record<string, unknown>, col: PluginColumn | null) => {
    const cell = col ? text(r, col) : ''
    const file = typeof r._file === 'string' ? r._file : ''
    const cellPath = cell && looksLikePath(cell) && cell !== file ? cell : ''
    const src = sourceCol ? text(r, sourceCol) : ''
    const live = source.kind === 'live'
    menu.open(e, [
      { label: t('Copy'), icon: Copy, hint: cell, disabled: !cell, onClick: () => copyText(cell) },
      { label: t('Copy row'), icon: Rows3, shortcut: 'Ctrl+C', onClick: () => copyText(tsv(r), t('row')) },
      { label: t('Copy row with column names'), icon: AlignLeft, onClick: () => copyText(named(r), t('row')) },
      col && data && {
        label: t('Copy column "{name}"', { name: col.title }), icon: Columns3,
        onClick: () => copyText(data.rows.map((x) => text(x, col)).join('\n'), t('{n} values', { n: data.rows.length })),
      },
      'sep',
      { label: t('Show source file in Files'), icon: LocateFixed, hint: file, disabled: !file || !live, onClick: () => showInFiles(file) },
      { label: t('Export source file…'), icon: Download, hint: file, disabled: !file || !live, onClick: () => exportSource(file) },
      !!cellPath && { label: t('Show this path in Files'), icon: FolderSearch, hint: cellPath, disabled: !live, onClick: () => showInFiles(cellPath) },
      'sep',
      !!src && { label: t('Copy source'), icon: Quote, hint: src, onClick: () => copyText(src) },
      !!file && { label: t('Copy source file path'), icon: FileText, hint: file, onClick: () => copyText(file) },
      'sep',
      data && {
        label: t('Copy whole table'), icon: Table2, hint: t('{n} rows', { n: formatInt(data.rows.length) }),
        onClick: () => copyText([allCols.filter((c) => c.kind !== 'source').map((c) => c.title).join('\t'), ...data.rows.map(tsv)].join('\n'),
          t('{n} rows', { n: formatInt(data.rows.length) })),
      },
    ])
  }

  return (
    <div className="page analysis-layout" style={{ gridTemplateColumns: `${treeW.width}px 10px minmax(0, 1fr)` }}>
      <TitleBarTools>
        {evRunning
          ? <ToolButton icon={CircleStop} label={status?.stopping ? t('Stopping…') : t('Stop')} disabled={!!status?.stopping} onClick={stopPlugins}
              title={t('Stop the running plugin and clear the queue; results of a stopped run are discarded')} />
          : <ToolButton icon={Play} label={t('Run all plugins')} disabled={source.kind === 'demo' || !!pythonBroken} onClick={() => runPlugins()}
              title={source.kind === 'demo' ? t('Results of the demo case are precomputed') : t('Run every analysis plugin on {name}', { name: ev?.name ?? '' })} />}
        <ToolButton icon={RefreshCw} label={t('Refresh')} title={t('Reload plugins and re-check Python dependencies')}
          onClick={() => { loadCatalog(true); evidence.forEach((e) => refreshStatus(e.id)); loadTable() }} />
      </TitleBarTools>

      <section className="panel">
        <div className="panel-body flush tree-scroll">
          <div className="tree">
            {evidence.map(renderEvidence)}
            {!catalog && !err && <div className="empty-mini"><Loader size={18} className="spin" /></div>}
          </div>
          {!!catalog?.problems.length && (
            <div className="tree-problems" title={catalog.problems.join('\n')}>
              <TriangleAlert size={14} />{t('{n} plugins could not be loaded (see Settings)', { n: catalog.problems.length })}
            </div>
          )}
        </div>
      </section>

      <Splitter onPointerDown={treeW.startDrag} onReset={treeW.reset} />

      <div className="analysis-main">
        {pythonBroken && (
          <section className="panel run-strip warn-strip">
            <TriangleAlert size={15} />
            <span>{t('Plugins cannot run: {error}', { error: python!.error ?? '' })}</span>
          </section>
        )}
        {evRunning && (
          <section className="panel run-strip">
            <Loader size={15} className="spin" />
            <span>{status?.stopping ? t('{name}: stopping…', { name: ev?.name ?? '' })
              : <>{t('{name}: running', { name: ev?.name ?? '' })} <b>{pluginName(status!.current)}</b>{status!.message ? ` · ${status!.message}` : ''}</>}</span>
            <div className="ov-track"><span className="ov-bar" style={{ width: `${Math.round((status!.progress || 0) * 100)}%` }} /></div>
            <span className="muted">{status!.queue.length ? t('{n} left', { n: status!.queue.length }) : ''}</span>
          </section>
        )}

        <Panel
          className="grow"
          title={<span className="crumb-title"><span className="dim">{ev?.name}</span><span className="bc-sep">›</span><span className="dim">{cat?.groupLabel}</span><span className="bc-sep">›</span>{cat?.name}</span>}
          count={data ? t('{n} rows', { n: formatInt(data.rows.length) }) : undefined}
          bodyClass="flush list-body"
          actions={cat?.plugin && (
            <>
              {run?.state === 'done' && <span className="badge ok"><CircleCheck size={12} />{run.finishedAt}</span>}
              {run?.state === 'error' && <span className="badge danger"><CircleAlert size={12} />{t('Failed')}</span>}
              {run?.state === 'cancelled' && <span className="badge warn">{t('Stopped')}</span>}
              {run?.state === 'skipped' && <span className="badge">{t('Not applicable')}</span>}
              <span className="badge accent" title={cat.plugin.id}><Puzzle size={12} />{cat.plugin.id} {cat.plugin.version}</span>
              {source.kind === 'live' && (
                <button className="btn sm" disabled={busy(status, cat.plugin.id) || !!pythonBroken || missing.length > 0} onClick={() => runPlugins([cat.plugin!.id])}>
                  <Play size={13} />{run ? t('Run again') : t('Run')}
                </button>
              )}
            </>
          )}
        >
          {err ? (
            <div className="err-box" style={{ margin: 12 }}><CircleAlert size={15} />{err}</div>
          ) : !cat?.plugin ? (
            <EmptyState icon={<Puzzle size={36} strokeWidth={1.3} className="muted" />} title={t('No plugin for this category yet')}
              text={t('Create a plugin folder under plugins/ (plugin.json + main.py) that declares this table; it shows up here after a refresh. See plugins/README.md.')} />
          ) : missing.length > 0 ? (
            <EmptyState icon={<TriangleAlert size={32} strokeWidth={1.4} className="muted" />} title={t('Missing Python dependencies')}
              text={<>{t('This plugin needs: {mods}. Install them, then click Refresh:', { mods: missing.join(', ') })}<br /><code className="cmd">.venv\Scripts\pip install -r plugins\requirements.txt</code></>} />
          ) : busy(status, cat.plugin.id) && !data?.rows.length ? (
            <EmptyState icon={<Loader size={28} className="spin muted" />} title={t('Running plugin')} text={cat.plugin.description} />
          ) : !run ? (
            <EmptyState icon={<Play size={32} strokeWidth={1.4} className="muted" />} title={t('Plugin has not run yet')} text={cat.plugin.description}
              actions={source.kind === 'live' && <><button className="btn primary" onClick={() => runPlugins([cat.plugin!.id])}><Play size={14} />{t('Run this plugin')}</button><button className="btn" onClick={() => runPlugins()}>{t('Run all plugins')}</button></>} />
          ) : run.state === 'skipped' ? (
            <EmptyState icon={<CircleMinus size={32} strokeWidth={1.4} className="muted" />} title={t('Not applicable to this evidence')} text={run.error} />
          ) : (run.state === 'error' || run.state === 'cancelled') && !data?.rows.length ? (
            <EmptyState icon={<CircleAlert size={32} strokeWidth={1.4} className="muted" />} title={run.state === 'error' ? t('Plugin failed') : t('Plugin was stopped')} text={run.error} />
          ) : !data ? (
            <div className="empty-mini"><Loader size={20} className="spin" /></div>
          ) : data.rows.length === 0 ? (
            <EmptyState icon={<CircleCheck size={32} strokeWidth={1.4} className="muted" />} title={t('No records found')} text={t('The plugin ran; this evidence has no artifacts of this kind.')} />
          ) : (
            <>
              {(run.state === 'error' || run.state === 'cancelled') && (
                <div className="stale-note"><CircleAlert size={14} />{t('The last run did not finish ({error}); the table shows the results of the previous successful run.', { error: run.error ?? run.state })}</div>
              )}
              <DataGrid
                columns={gridCols}
                rows={data.rows}
                storageKey={`ds.grid.${cat.id}`}
                selected={rowIdx}
                onSelect={setRowIdx}
                onCellContextMenu={(e, i, c) => recordMenu(e, data.rows[i], c && (allCols.find((x) => x.key === c.key) ?? null))}
                onCopy={(i) => copyText(tsv(data.rows[i]), t('row'))}
                render={(r, c) => cellText(r[c.key], allCols.find((x) => x.key === c.key)!, cat.plugin) || '—'}
              />
            </>
          )}
        </Panel>

        {cat?.plugin && <Splitter orientation="horizontal" onPointerDown={detailH.startDrag} onReset={detailH.reset} />}
        {cat?.plugin && (
          <Panel title={row ? t('Record {n}', { n: rowIdx! + 1 }) : t('Plugin')} className="detail-strip" style={{ height: detailH.width }}>
            {row ? (
              <dl className="kv">
                {allCols.map((c) => (
                  <div key={c.key} className="kv-pair" onContextMenu={(e) => recordMenu(e, row, c)}>
                    <dt>{c.title}</dt>
                    <dd className={c.kind === 'source' || c.kind === 'mono' ? 'mono' : undefined}>{cellText(row[c.key], c, cat.plugin) || '—'}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <dl className="kv">
                <dt>{t('Plugin')}</dt><dd>{cat.plugin.name} <span className="muted">({cat.plugin.id} {cat.plugin.version}{cat.plugin.author ? ` · ${cat.plugin.author}` : ''})</span></dd>
                <dt>{t('Description')}</dt><dd>{cat.plugin.description}</dd>
                {!!cat.plugin.dependencies?.length && <><dt>{t('Dependencies')}</dt><dd>{cat.plugin.dependencies.join(', ')}</dd></>}
                {run && <><dt>{t('Last run')}</dt><dd className="num">{run.startedAt} → {run.finishedAt || t('running')} · {t(STATE_LABEL[run.state] ?? run.state)} · {t('{n} rows', { n: formatInt(run.rows) })}{run.version ? ` · v${run.version}` : ''}</dd></>}
                {run?.error && <><dt>{t('Error')}</dt><dd className="err-text">{run.error}</dd></>}
                {run?.log && <><dt>{t('Log')}</dt><dd><pre className="plugin-log">{run.log}</pre></dd></>}
              </dl>
            )}
          </Panel>
        )}
      </div>
      {menu.node}
    </div>
  )
}
