import { useEffect, useState, type ReactNode } from 'react'
import {
  Briefcase, CalendarClock, CircleAlert, CircleCheck, Clock, DatabaseZap, FolderOpen, FolderTree, HardDrive, Hash, Layers, Loader,
  Microscope, Monitor, Play, Plus, Search, ShieldCheck, Trash2, TriangleAlert, UserRound, X,
} from 'lucide-react'
import { EmptyState, Modal, Panel, Splitter, useResizableWidth } from '../components/common'
import type { PageId } from '../components/Sidebar'
import type { CaseSummary, Evidence, EvidenceSummary, HashStatus, IndexStatus, PluginManifest, PluginStatus } from '../api/types'
import { localizeManifest } from '../api/plugins'
import { backend } from '../api/client'
import { PLANNED, type DataSource } from '../api/source'
import type { NewCaseInput, Session } from '../App'
import { toast } from '../components/Toast'
import { firstSegments, pickImages } from '../util/evidence'
import { formatBytes, formatInt } from '../util/format'
import { t } from '../i18n'

export function CasePage({ session, selected, backendOnline, onOpenDemo, onCreate, onOpenCase, onAddEvidence, onPickEvidence, addingImages, onUpdateEvidence, onSelect, onClose, onNavigate }: {
  session: Session | null
  selected?: Evidence
  backendOnline: boolean
  onOpenDemo: () => void
  onCreate: (c: NewCaseInput) => Promise<void>
  onOpenCase: (dir: string) => Promise<void>
  onAddEvidence: (path: string) => Promise<void>
  /** open the system image picker (Electron); without it a path dialog is shown */
  onPickEvidence?: () => void
  /** images still being added */
  addingImages: number
  onUpdateEvidence: (ev: Evidence) => void
  onSelect: (id: string) => void
  onClose: () => void
  onNavigate: (p: PageId) => void
}) {
  const [creating, setCreating] = useState(false)

  if (!session) {
    return (
      <div className="page case-start">
        <EmptyState
          icon={<CaseIllustration />}
          title={t('No case is open')}
          text={backendOnline
            ? t('Create a case and add E01 / DD images, or open an existing case to continue.')
            : t('The backend is not connected, only the demo case is available. Build and start the Go backend first (scripts\\build-backend.ps1).')}
          actions={
            <>
              <button className="btn primary" onClick={() => setCreating(true)}><Plus size={15} />{t('New case')}</button>
              <button className="btn" onClick={onOpenDemo}><FolderOpen size={15} />{t('Open demo case')}</button>
            </>
          }
        />
        {backendOnline && <RecentCases onOpen={onOpenCase} />}
        {creating && <NewCaseModal live={backendOnline} onClose={() => setCreating(false)} onCreate={async (c) => { await onCreate(c); setCreating(false) }} />}
      </div>
    )
  }

  return (
    <CaseOverview
      session={session}
      selected={selected}
      onAddEvidence={onAddEvidence}
      onPickEvidence={onPickEvidence}
      addingImages={addingImages}
      onUpdateEvidence={onUpdateEvidence}
      onSelect={onSelect}
      onClose={onClose}
      onNavigate={onNavigate}
    />
  )
}

/** Cases in the cases folder and cases saved elsewhere */
function RecentCases({ onOpen }: { onOpen: (dir: string) => Promise<void> }) {
  const [cases, setCases] = useState<CaseSummary[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<CaseSummary | null>(null)
  const reload = () => backend.listCases().then(setCases, (e) => setErr(String(e)))
  useEffect(() => { reload() }, [])
  const open = async (dir: string) => {
    setBusy(dir)
    setErr(null)
    try { await onOpen(dir) } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(null) }
  }
  const openFolder = async () => {
    const dir = await window.ds?.dialog.chooseFolder()
    if (dir) await open(dir)
  }
  if (!cases) return null
  return (
    <section className="panel recent-cases">
      <div className="panel-head">
        <h3>{t('Recent cases')}</h3><span className="count">{cases.length}</span>
        <span className="spacer" />
        {window.ds && <button className="btn ghost sm" onClick={openFolder} disabled={busy !== null}><FolderOpen size={14} />{t('Open case folder…')}</button>}
      </div>
      {err && <div className="err-box" style={{ margin: 10 }}><CircleAlert size={15} />{err}</div>}
      {cases.length === 0 ? <div className="empty-mini">{t('No cases yet')}</div> : (
        <table className="grid">
          <colgroup><col /><col style={{ width: 190 }} /><col style={{ width: 160 }} /><col style={{ width: 64 }} /><col style={{ width: 120 }} /></colgroup>
          <thead><tr><th>{t('Case name')}</th><th>{t('Number')}</th><th>{t('Created')}</th><th className="r">{t('Evidence')}</th><th /></tr></thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.info.dir} onDoubleClick={() => open(c.info.dir)}>
                <td>
                  <div className="cell-name"><Briefcase size={15} className="ico-drive" /><span>{c.info.name}</span></div>
                  <div className="case-dir muted ellipsis" title={c.info.dir}>{c.info.dir}</div>
                </td>
                <td className="num dim">{c.info.number}</td>
                <td className="num dim">{c.info.createdAt}</td>
                <td className="r num">{c.evidenceCount}</td>
                <td className="r case-actions">
                  <button className="btn sm" disabled={busy !== null} onClick={() => open(c.info.dir)}>{busy === c.info.dir ? <Loader size={13} className="spin" /> : null}{t('Open')}</button>
                  <button className="btn ghost sm icon danger-hover" title={t('Delete case')} disabled={busy !== null} onClick={() => setDeleting(c)}><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deleting && <DeleteCaseModal c={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); reload() }} />}
    </section>
  )
}

function DeleteCaseModal({ c, onClose, onDeleted }: { c: CaseSummary; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const remove = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await backend.deleteCase(c.info.dir)
      toast(r.left.length ? t('Case deleted; other files in its folder were kept') : t('Case deleted'))
      onDeleted()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false) }
  }
  return (
    <Modal
      title={t('Delete case')}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('Cancel')}</button>
        <button className="btn danger" onClick={remove} disabled={busy}>{busy ? <Loader size={14} className="spin" /> : <Trash2 size={14} />}{t('Delete')}</button></>}
    >
      <dl className="kv">
        <dt>{t('Case name')}</dt><dd><b>{c.info.name}</b></dd>
        <dt>{t('Case number')}</dt><dd className="num">{c.info.number}</dd>
        <dt>{t('Location')}</dt><dd className="mono-sm">{c.info.dir}</dd>
        <dt>{t('Evidence')}</dt><dd>{c.evidenceCount}</dd>
      </dl>
      <div className="warn-box"><TriangleAlert size={16} />
        <span>{t('This deletes the case database and its work folder: evidence list, hashes, file index, analysis results and the audit log. The evidence image files and files exported to other folders are not deleted. This cannot be undone.')}</span>
      </div>
      {err && <div className="err-box"><CircleAlert size={15} />{err}</div>}
    </Modal>
  )
}

function CaseOverview({ session, selected, onAddEvidence, onPickEvidence, addingImages, onUpdateEvidence, onSelect, onClose, onNavigate }: {
  session: Session; selected?: Evidence; onAddEvidence: (path: string) => Promise<void>; onUpdateEvidence: (ev: Evidence) => void
  onPickEvidence?: () => void; addingImages: number
  onSelect: (id: string) => void; onClose: () => void; onNavigate: (p: PageId) => void
}) {
  const { info, evidence, source } = session
  const side = useResizableWidth('ds.case.sideWidth', 320, 260, 560)
  const [adding, setAdding] = useState(false)
  const live = source.kind === 'live'
  const addEvidence = () => (onPickEvidence ? onPickEvidence() : setAdding(true))

  return (
    <div className="page case-layout" style={{ gridTemplateColumns: `${side.width}px 10px minmax(0, 1fr)` }}>
      <div className="case-side">
        <Panel
          title={t('Case')}
          actions={<button className="btn ghost sm" onClick={onClose} title={t('Close case')}><X size={14} />{t('Close')}</button>}
        >
          <dl className="kv">
            <dt>{t('Case name')}</dt><dd>{info.name}</dd>
            <dt>{t('Case number')}</dt><dd className="num">{info.number}</dd>
            <dt>{t('Examiner')}</dt><dd>{info.examiner}</dd>
            <dt>{t('Created')}</dt><dd className="num">{info.createdAt}</dd>
            <dt>{t('Location')}</dt><dd className="dim">{info.location}</dd>
          </dl>
        </Panel>
        <Panel
          title={t('Evidence')}
          count={evidence.length}
          className="grow"
          bodyClass="flush"
          actions={
            <button className="btn sm" disabled={!live} title={live ? t('Add an E01 / DD image') : t('Evidence cannot be added to the demo case')} onClick={addEvidence}>
              <Plus size={14} />{t('Add evidence')}
            </button>
          }
        >
          <div className="ev-list">
            {evidence.map((e) => (
              <button key={e.id} className={`ev-card${e.id === selected?.id ? ' selected' : ''}`} onClick={() => onSelect(e.id)}>
                <HardDrive size={20} className="ev-icon" />
                <div className="ev-main">
                  <div className="ev-name">{e.name}</div>
                  <div className="ev-meta">{e.format === 'ewf' ? 'E01' : 'RAW'} · {formatBytes(e.fileSize)} · {t('source disk {size}', { size: formatBytes(e.mediaSize) })}</div>
                </div>
                <ShieldCheck size={17} className="ok-ico" />
              </button>
            ))}
            {addingImages > 0 && (
              <div className="ev-card adding"><Loader size={18} className="spin" /><span>{t('Opening {n} images…', { n: addingImages })}</span></div>
            )}
            {evidence.length === 0 && addingImages === 0 && (
              <div className="empty-mini">
                {t('No evidence yet')}
                <button className="btn primary sm" onClick={addEvidence} disabled={!live}><Plus size={14} />{t('Add evidence')}</button>
              </div>
            )}
          </div>
        </Panel>
      </div>

      <Splitter onPointerDown={side.startDrag} onReset={side.reset} />

      {selected
        ? <EvidenceDetail key={selected.id} ev={selected} source={source} onNavigate={onNavigate} onUpdate={onUpdateEvidence} />
        : <section className="panel case-main"><EmptyState title={t('Add evidence first')} text={t('E01 (including multi-segment) and DD / RAW images are supported; paths may contain non-ASCII characters.')} /></section>}

      {adding && <AddEvidenceModal onClose={() => setAdding(false)} onAdd={async (p) => { await onAddEvidence(p); setAdding(false) }} />}
    </div>
  )
}

function EvidenceDetail({ ev, source, onNavigate, onUpdate }: {
  ev: Evidence; source: DataSource; onNavigate: (p: PageId) => void; onUpdate: (ev: Evidence) => void
}) {
  const totalSectors = ev.mediaSize / ev.sectorSize
  const [summary, setSummary] = useState<EvidenceSummary | null>(null)
  const [plug, setPlug] = useState<PluginStatus | null>(null)
  const [manifests, setManifests] = useState<PluginManifest[]>([])
  const outputs = manifests.flatMap((m) => localizeManifest(m).outputs.map((o) => ({ id: o.id, name: o.name })))
  const [sumErr, setSumErr] = useState<string | null>(null)
  const [hash, setHash] = useState<HashStatus | null>(null)

  // system summary and analysis overview come from plugin results (case database); refreshed every second while plugins run
  const plugRunning = !!plug?.running
  useEffect(() => {
    let alive = true
    const load = () => Promise.all([source.summary(ev), source.pluginStatus(ev)]).then(
      ([s, st]) => { if (alive) { setSummary(s); setPlug(st) } },
      (e) => alive && setSumErr(e instanceof Error ? e.message : String(e)),
    )
    load()
    source.plugins().then((c) => alive && setManifests(c.plugins), () => {})
    const t = plugRunning ? window.setInterval(load, 1000) : undefined
    return () => { alive = false; clearInterval(t) }
  }, [ev, source, plugRunning])

  const runAll = async () => {
    try { setPlug(await source.runPlugins(ev)) } catch (e) { setSumErr(e instanceof Error ? e.message : String(e)) }
  }

  // hash status: refreshed every second while hashing
  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const poll = () => source.hashStatus(ev).then((h) => {
      if (!alive) return
      setHash(h)
      if (h.state === 'running') timer = window.setTimeout(poll, 1000)
    }, () => {})
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [ev, source])

  const startHash = async () => {
    setHash(await source.startHash(ev))
    const poll = async () => {
      const h = await source.hashStatus(ev)
      setHash(h)
      if (h.state === 'running') setTimeout(poll, 1000)
    }
    setTimeout(poll, 1000)
  }

  const hashing = hash?.state === 'running'
  const allocated = ev.partitions.filter((p) => p.allocated)
  const sysPart = allocated.find((p) => p.fsType)

  return (
    <section className="panel case-main">
      <header className="ev-header">
        <div className="ev-header-icon"><HardDrive size={22} /></div>
        <div className="ev-header-main">
          <h2>{ev.name}</h2>
          <div className="ev-header-meta">
            <span>{ev.format === 'ewf' ? 'EnCase E01' : 'RAW / DD'}</span>
            <span>{t('Image {size}', { size: formatBytes(ev.fileSize) })}</span>
            <span>{t('Source disk {size}', { size: formatBytes(ev.mediaSize) })}</span>
            <span>{t('{n} partitions', { n: allocated.length })}</span>
            {ev.acquiredAt && <span>{t('Acquired {date}', { date: ev.acquiredAt })}</span>}
          </div>
        </div>
        <div className="ev-header-actions">
          <button className="btn" onClick={startHash} disabled={hashing || source.kind === 'demo'} title={source.kind === 'demo' ? t('Hashes of the demo case are precomputed') : t('Compute whole-disk MD5 / SHA1 / SHA256')}>
            {hashing ? <Loader size={15} className="spin" /> : <Hash size={15} />}{hashing ? t('Hashing…') : t('Compute hashes')}
          </button>
          <button className="btn primary" onClick={() => onNavigate('analysis')}><Microscope size={15} />{t('View analysis')}</button>
        </div>
      </header>

      <div className="ev-body">
        <div className="ev-row two">
          <section className="block">
            <h4>{t('Evidence details')}</h4>
            <dl className="kv">
              <dt>{t('File path')}</dt><dd>{ev.path}</dd>
              <dt>{t('Image format')}</dt><dd>{ev.format === 'ewf' ? 'EnCase (E01)' : 'RAW / DD'} · {t('{n} segments', { n: ev.segments })}</dd>
              <dt>{t('Image size')}</dt><dd>{formatBytes(ev.fileSize)} <span className="muted">({t('{n} bytes', { n: formatInt(ev.fileSize) })})</span></dd>
              <dt>{t('Source disk size')}</dt><dd>{formatBytes(ev.mediaSize)} <span className="muted">({t('{n} sectors × {size} bytes', { n: formatInt(totalSectors), size: ev.sectorSize })})</span></dd>
              {ev.acquiredWith && <><dt>{t('Imaging tool')}</dt><dd>{ev.acquiredWith}</dd></>}
              {ev.acquiredAt && <><dt>{t('Acquired')}</dt><dd className="num">{ev.acquiredAt} <span className="muted">({t('acquisition machine local time')})</span></dd></>}
            </dl>
          </section>
          <section className="block">
            <h4>{t('System summary')}</h4>
            {summary ? (
              <div className="sum-list">
                <SumRow icon={<Monitor size={16} />} label={t('Computer name')} value={summary.hostname} />
                <SumRow icon={<Layers size={16} />} label={t('Operating system')} value={summary.os} />
                <SumRow icon={<CalendarClock size={16} />} label={t('Install date')} value={summary.installDate} />
                <SumRow icon={<UserRound size={16} />} label={t('Last logon')} value={summary.lastUser} />
                <SumRow icon={<Clock size={16} />} label={t('Time zone')} value={summary.timezone} />
              </div>
            ) : sumErr ? (
              <div className="err-box"><CircleAlert size={15} />{sumErr}</div>
            ) : !plug ? (
              <div className="muted loading-line"><Loader size={15} className="spin" />{t('Loading…')}</div>
            ) : plugRunning ? (
              <div className="muted loading-line"><Loader size={15} className="spin" />{t('Running analysis plugins…')}</div>
            ) : (
              <div className="sum-empty">
                <span className="muted">{t('No analysis plugins have run yet. The system summary is extracted from the registry by the "Windows System Info" plugin.')}</span>
                <button className="btn primary sm" onClick={runAll}><Play size={14} />{t('Run all plugins')}</button>
              </div>
            )}
          </section>
        </div>

        <section className="block">
          <h4>{t('Partitions')}</h4>
          <div className="part-bar">
            {ev.partitions.map((p) => (
              <div
                key={p.index}
                className={`seg-part${p.allocated ? ' alloc' : ''}`}
                style={{ flexGrow: p.length / totalSectors, minWidth: p.allocated ? 80 : 10 }}
                title={`${p.description} · ${formatBytes(p.length * ev.sectorSize)}`}
              >
                {p.allocated && <span>{t('Partition {n}', { n: p.index })}{p.fsType ? ` · ${p.fsType}` : ''} · {formatBytes(p.length * ev.sectorSize)}</span>}
              </div>
            ))}
          </div>
          <div className="part-cards" style={{ gridTemplateColumns: ev.partitions.map((p) => (p.allocated ? '2.4fr' : '1fr')).join(' ') }}>
            {ev.partitions.map((p) => (
              <div key={p.index} className={`part-card${p.allocated ? ' alloc' : ''}`}>
                <div className="part-card-head">
                  <span className="swatch" />
                  <b>{p.allocated ? t('Partition {n}', { n: p.index }) : t('Unallocated {n}', { n: p.index })}</b>
                  {p.fsType && <span className="badge info">{p.fsType}</span>}
                  {p.index === sysPart?.index && summary && <span className="badge">{t('System')}</span>}
                </div>
                <div className="part-card-size">{formatBytes(p.length * ev.sectorSize)}</div>
                <div className="part-card-meta num">{t('Sectors {from} – {to}', { from: formatInt(p.start), to: formatInt(p.start + p.length - 1) })}{p.blockSize ? ` · ${t('cluster {n} bytes', { n: p.blockSize })}` : ''}</div>
                {p.allocated && p.fsType && (
                  <div className="part-card-actions">
                    <button className="btn sm" onClick={() => onNavigate('files')}><FolderTree size={14} />{t('Browse files')}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {source.kind === 'live' && <IndexBlock ev={ev} onUpdate={onUpdate} onSearch={() => onNavigate('search')} />}

        <div className="ev-row two">
          <section className="block">
            <h4>
              {t('Integrity')}
              {hash?.state === 'done' && ev.storedHashes.md5 && hash.md5 === ev.storedHashes.md5 && <span className="badge ok"><CircleCheck size={12} />{t('Matches the hashes stored in the image')}</span>}
              {hash?.state === 'done' && ev.storedHashes.md5 && hash.md5 !== ev.storedHashes.md5 && <span className="badge danger"><CircleAlert size={12} />{t('Does not match the stored hashes')}</span>}
            </h4>
            {hashing && hash && (
              <div className="hash-progress">
                <div className="ov-track"><span className="ov-bar" style={{ width: `${(hash.progress * 100).toFixed(1)}%` }} /></div>
                <span className="num muted">{(hash.progress * 100).toFixed(1)}% · {formatBytes(hash.done)} / {formatBytes(hash.total)}</span>
              </div>
            )}
            {hash?.state === 'error' && <div className="err-box"><CircleAlert size={15} />{hash.error}</div>}
            <table className="grid hash-table">
              <colgroup><col style={{ width: 78 }} /><col /><col style={{ width: 96 }} /></colgroup>
              <tbody>
                {(['md5', 'sha1', 'sha256'] as const).map((alg) => {
                  const v = hash?.state === 'done' ? hash[alg] : undefined
                  const stored = alg === 'sha256' ? undefined : ev.storedHashes[alg]
                  return (
                    <tr key={alg}>
                      <td className="dim">{alg.toUpperCase()}</td>
                      <td className="mono selectable" title={v ?? stored}>
                        {v ?? (stored ? <span className="muted">{stored}<br />({t('stored in the image, not recomputed yet')})</span> : <span className="muted">{t('Not computed')}</span>)}
                      </td>
                      <td className="r">{!v ? <span className="muted">—</span>
                        : stored === undefined ? <span className="muted" title={t('The E01 stores no hash for this algorithm')}>{t('Computed only')}</span>
                        : stored === v ? <span className="ok-text"><CircleCheck size={13} />{t('Match')}</span>
                        : <span className="badge danger">{t('Mismatch')}</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {hash?.state === 'done' && hash.seconds ? <div className="muted hash-note">{t('Reading the whole disk took {n} s', { n: Math.round(hash.seconds) })}</div> : null}
          </section>
          <section className="block">
            <h4>{t('Analysis overview')}</h4>
            <AnalysisOverview outputs={outputs} status={plug} onOpen={() => onNavigate('analysis')} />
          </section>
        </div>
      </div>
    </section>
  )
}

/** Full file index: needed for file name and content search */
function IndexBlock({ ev, onUpdate, onSearch }: { ev: Evidence; onUpdate: (ev: Evidence) => void; onSearch: () => void }) {
  const [st, setSt] = useState<IndexStatus | undefined>(ev.index)
  const running = st?.state === 'running'

  useEffect(() => {
    if (!running) return
    let alive = true
    const t = window.setInterval(async () => {
      const s = await backend.indexStatus(ev.id).catch(() => null)
      if (!alive || !s) return
      setSt(s)
      if (s.state !== 'running') onUpdate({ ...ev, index: s })
    }, 800)
    return () => { alive = false; clearInterval(t) }
  }, [running, ev, onUpdate])

  const start = async () => setSt(await backend.startIndex(ev.id))

  return (
    <section className="block index-block">
      <h4>
        {t('File index')}
        {st?.state === 'done' && <span className="badge ok"><CircleCheck size={12} />{t('Built')}</span>}
        {st?.state === 'partial' && <span className="badge warn">{t('Incomplete')}</span>}
        {st?.state === 'error' && <span className="badge danger">{t('Failed')}</span>}
      </h4>
      <div className="index-row">
        <div className="index-text">
          {running ? (
            <span className="num"><Loader size={14} className="spin" /> {t('Walking directories… {dirs} directories read, {files} entries', { dirs: formatInt(st!.dirs), files: formatInt(st!.files) })}{st!.seconds ? ` (${Math.round(st!.seconds)} s)` : ''}</span>
          ) : st?.state === 'done' || st?.state === 'partial' ? (
            <span className="num">{t('{n} files and directories indexed (deleted included)', { n: formatInt(st.files) })}{st.indexedAt ? ` · ${t('built {date}', { date: st.indexedAt })}` : ''}{st.errors ? ` · ${t('{n} directories unreadable', { n: st.errors })}` : ''}</span>
          ) : st?.state === 'error' ? (
            <span className="err-text">{st.error}</span>
          ) : (
            <span className="muted">{t('Not built yet. The index walks the full directory tree of every partition (deleted files included) and stores it in the case database for file name and content search.')}</span>
          )}
        </div>
        <div className="index-actions">
          {(st?.state === 'done' || st?.state === 'partial') && <button className="btn sm" onClick={onSearch}><Search size={14} />{t('Search')}</button>}
          <button className={`btn sm${!st || st.state === 'none' ? ' primary' : ''}`} onClick={start} disabled={running}>
            {running ? <Loader size={14} className="spin" /> : <DatabaseZap size={14} />}
            {st && st.state !== 'none' ? t('Rebuild index') : t('Build index')}
          </button>
        </div>
      </div>
    </section>
  )
}

function SumRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="sum-row">
      <span className="sum-ico">{icon}</span>
      <span className="sum-label">{label}</span>
      <span className="sum-value" title={value}>{value}</span>
    </div>
  )
}

function AnalysisOverview({ outputs, status, onOpen }: {
  outputs: { id: string; name: string }[]; status: PluginStatus | null; onOpen: () => void
}) {
  const counts = status?.counts ?? {}
  const done = outputs.filter((o) => counts[o.id] !== undefined)
  const max = Math.max(...done.map((o) => counts[o.id]), 1)
  const failed = status?.runs.filter((r) => r.state === 'error').length ?? 0
  return (
    <div className="ov">
      {done.length === 0 && (
        <div className="muted loading-line">
          {status?.running ? <><Loader size={15} className="spin" />{t('Running plugins…')}</> : t('No analysis results yet')}
        </div>
      )}
      {done.map((o) => (
        <button key={o.id} className="ov-row" onClick={onOpen}>
          <span className="ov-label" title={o.name}>{o.name}</span>
          <span className="ov-track"><span className="ov-bar" style={{ width: `${(counts[o.id] / max) * 100}%` }} /></span>
          <span className="ov-num num">{formatInt(counts[o.id])}</span>
        </button>
      ))}
      <div className="ov-pending muted">
        {t('{n} result types installed', { n: outputs.length })}{failed ? ` · ${t('{n} plugins failed', { n: failed })}` : ''}{PLANNED.length ? ` · ${t('Planned')}: ${PLANNED.map((c) => t(c.name)).join(', ')}` : ''}
      </div>
    </div>
  )
}

function AddEvidenceModal({ onClose, onAdd }: { onClose: () => void; onAdd: (path: string) => Promise<void> }) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const pick = async () => {
    const p = await window.ds?.dialog.openEvidence()
    if (p) setPath(p)
  }
  const submit = async () => {
    if (!path.trim()) return
    setBusy(true)
    setErr(null)
    try { await onAdd(path.trim()) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <Modal
      title={t('Add evidence')}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('Cancel')}</button><button className="btn primary" onClick={submit} disabled={busy || !path.trim()}>{busy && <Loader size={14} className="spin" />}{t('Add')}</button></>}
    >
      <div className="field">
        <label>{t('Image file')}</label>
        <div className="path-row">
          <input className="input" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('e.g. D:\\evidence\\disk.E01 (for multi-segment E01 pick the first segment)')} onKeyDown={(e) => e.key === 'Enter' && submit()} spellCheck={false} />
          {window.ds && <button className="btn" onClick={pick}><FolderOpen size={14} />{t('Browse…')}</button>}
        </div>
      </div>
      {err && <div className="err-box"><CircleAlert size={15} />{err}</div>}
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{t('Evidence is opened read-only. Partitions and file systems are detected on open; large images may take a few seconds.')}</p>
    </Modal>
  )
}

function NewCaseModal({ live, onClose, onCreate }: { live: boolean; onClose: () => void; onCreate: (c: NewCaseInput) => Promise<void> }) {
  const [name, setName] = useState('')
  const [number, setNumber] = useState('')
  const [examiner, setExaminer] = useState('')
  const [location, setLocation] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const electron = !!window.ds
  const addPaths = (paths: string[]) => setImages((xs) => firstSegments([...xs, ...paths.filter((p) => !xs.includes(p))]))
  const pickImgs = async () => { const p = await pickImages(); if (p) addPaths(p) }
  const pickLocation = async () => { const p = await window.ds?.dialog.chooseFolder(location || undefined); if (p) setLocation(p) }
  const addTyped = () => { if (typed.trim()) { addPaths([typed.trim()]); setTyped('') } }
  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      await onCreate({ name: name.trim(), number: number.trim(), examiner: examiner.trim(), location: location.trim(), images })
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false) }
  }
  return (
    <Modal
      title={t('New case')}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('Cancel')}</button><button className="btn primary" onClick={submit} disabled={busy}>{busy && <Loader size={14} className="spin" />}{t('Create')}</button></>}
    >
      <div className="form-grid">
        <div className="field"><label>{t('Case name')}</label><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Workstation examination')} /></div>
        <div className="field"><label>{t('Case number')}</label><input className="input" value={number} onChange={(e) => setNumber(e.target.value)} placeholder={t('Leave empty to generate (DS-date-time)')} spellCheck={false} /></div>
        <div className="field"><label>{t('Examiner')}</label><input className="input" value={examiner} onChange={(e) => setExaminer(e.target.value)} placeholder={t('Name or ID')} /></div>
        <div className="field">
          <label>{t('Save location')}</label>
          <div className="path-row">
            <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t('Default: the cases folder of DiskSleuth')} spellCheck={false} disabled={!live} />
            {electron && <button className="btn" onClick={pickLocation} disabled={!live}><FolderOpen size={14} />{t('Browse…')}</button>}
          </div>
        </div>
      </div>
      <div className="field">
        <label>{t('Evidence images')} <span className="muted">({t('optional, can be added later')})</span></label>
        {images.length > 0 && (
          <ul className="image-list">
            {images.map((p) => (
              <li key={p}><HardDrive size={15} className="ico-drive" /><span className="ellipsis" title={p}>{p}</span>
                <button className="btn ghost icon sm" title={t('Remove')} onClick={() => setImages((xs) => xs.filter((x) => x !== p))}><X size={14} /></button></li>
            ))}
          </ul>
        )}
        {electron
          ? <div><button className="btn" onClick={pickImgs} disabled={!live}><Plus size={14} />{t('Select images…')}</button></div>
          : <div className="path-row">
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTyped()} disabled={!live}
                placeholder={t('e.g. D:\\evidence\\disk.E01 (for multi-segment E01 pick the first segment)')} spellCheck={false} />
              <button className="btn" onClick={addTyped} disabled={!live || !typed.trim()}><Plus size={14} />{t('Add')}</button>
            </div>}
      </div>
      {err && <div className="err-box"><CircleAlert size={15} />{err}</div>}
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {live ? t('The case is saved in a folder named after the case number inside the save location; every action is written to the audit log. Images are opened read-only.') : t('Backend not connected: the demo evidence will be loaded.')}
      </p>
    </Modal>
  )
}

/** Empty state illustration: disk platter + lens (original) */
function CaseIllustration() {
  return (
    <svg width="168" height="128" viewBox="0 0 168 128" aria-hidden="true">
      <ellipse cx="84" cy="116" rx="64" ry="7" fill="#dde2e8" />
      <rect x="30" y="26" width="96" height="76" rx="6" fill="#fff" stroke="#cfd5dc" strokeWidth="2" />
      <circle cx="72" cy="62" r="26" fill="#f5f6f8" stroke="#cfd5dc" strokeWidth="2" />
      <circle cx="72" cy="62" r="15" fill="none" stroke="#e3e6eb" strokeWidth="2" />
      <circle cx="72" cy="62" r="4" fill="#b9c1cb" />
      <rect x="106" y="86" width="12" height="4" rx="1" fill="#1f5fbf" />
      <circle cx="112" cy="46" r="18" fill="rgba(31,95,191,.07)" stroke="#1f5fbf" strokeWidth="4" />
      <path d="M125 59l14 14" stroke="#1f5fbf" strokeWidth="6" strokeLinecap="round" />
      <circle cx="112" cy="46" r="3.5" fill="#f2a93b" />
    </svg>
  )
}
