// File export: requestExport() from any page opens the export dialog; <ExportCenter /> (rendered once in App)
// owns the dialog and the progress card in the corner, which keeps polling the backend while an export runs.
import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Download, FileSpreadsheet, FolderOpen, Loader, Square, X } from 'lucide-react'
import { Modal } from './common'
import { toast } from './Toast'
import { backend } from '../api/client'
import type { Evidence, ExportItem, ExportStatus } from '../api/types'
import { formatBytes, formatInt } from '../util/format'
import { t } from '../i18n'

interface Request { evidence: Evidence; items: ExportItem[] }

const listeners = new Set<(r: Request) => void>()
const DEST_KEY = 'ds.export.dest'

/** Open the export dialog for these items. */
export function requestExport(evidence: Evidence, items: ExportItem[]) {
  listeners.forEach((f) => f({ evidence, items }))
}

function lastDest(): string {
  try { return localStorage.getItem(DEST_KEY) ?? '' } catch { return '' }
}

export function ExportCenter({ enabled }: { enabled: boolean }) {
  const [req, setReq] = useState<Request | null>(null)
  const [status, setStatus] = useState<ExportStatus | null>(null)
  const [visible, setVisible] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const poll = useCallback(() => {
    window.clearTimeout(timer.current)
    backend.exportStatus().then((s) => {
      setStatus(s)
      if (s.state === 'running') timer.current = window.setTimeout(poll, 600)
    }, () => {})
  }, [])

  useEffect(() => {
    const open = (r: Request) => {
      if (!enabled) return toast(t('Export is not available in the demo case'), 'error')
      setReq(r)
    }
    listeners.add(open)
    return () => { listeners.delete(open) }
  }, [enabled])

  // after a reload, show an export that is still running
  useEffect(() => {
    if (!enabled) return
    backend.exportStatus().then((s) => { if (s.state === 'running') { setStatus(s); setVisible(true); poll() } }, () => {})
    return () => window.clearTimeout(timer.current)
  }, [enabled, poll])

  const start = async (dest: string, hash: boolean, includeDeleted: boolean) => {
    if (!req) return
    const s = await backend.startExport(req.evidence.id, { items: req.items, dest, hash, includeDeleted })
    try { localStorage.setItem(DEST_KEY, dest) } catch { /* ignore */ }
    setReq(null)
    setStatus(s)
    setVisible(true)
    poll()
  }

  return (
    <>
      {req && <ExportDialog req={req} onClose={() => setReq(null)} onStart={start} />}
      {visible && status && status.state !== 'idle' && (
        <ExportCard status={status} onStop={() => backend.cancelExport().then(setStatus)} onClose={() => setVisible(false)} />
      )}
    </>
  )
}

function ExportDialog({ req, onClose, onStart }: {
  req: Request; onClose: () => void; onStart: (dest: string, hash: boolean, includeDeleted: boolean) => Promise<void>
}) {
  const [dest, setDest] = useState(lastDest)
  const [hash, setHash] = useState(true)
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const hasDir = req.items.some((i) => i.isDir)
  const first = req.items[0]

  const pick = async () => {
    const p = await window.ds?.dialog.chooseFolder(dest)
    if (p) setDest(p)
  }
  const submit = async () => {
    if (!dest.trim()) return
    setBusy(true)
    setErr(null)
    try { await onStart(dest.trim(), hash, includeDeleted) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <Modal
      title={t('Export')}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>{t('Cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || !dest.trim()}>
          {busy ? <Loader size={14} className="spin" /> : <Download size={14} />}{t('Export')}
        </button>
      </>}
    >
      <dl className="kv export-what">
        <dt>{t('Export')}</dt>
        <dd>
          <b>{first.name}</b>{first.isDir ? ` (${t('folder, with everything inside')})` : ''}
          {req.items.length > 1 && <span className="muted"> {t('and {n} more', { n: req.items.length - 1 })}</span>}
          <div className="muted mono-sm">{req.evidence.name} · {t('Partition {n}', { n: first.part })}{first.path}</div>
        </dd>
      </dl>
      <div className="field">
        <label>{t('Destination folder')}</label>
        <div className="row-input">
          <input className="input" autoFocus value={dest} onChange={(e) => setDest(e.target.value)} spellCheck={false}
            placeholder={t('e.g. D:\\cases\\export')} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          {window.ds && <button className="btn" onClick={pick}><FolderOpen size={14} />{t('Browse…')}</button>}
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={hash} onChange={(e) => setHash(e.target.checked)} />{t('Calculate MD5 / SHA-256 and write a CSV report')}</label>
      {hasDir && <label className="check"><input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />{t('Include deleted files inside folders')}</label>}
      {err && <div className="err-box"><CircleAlert size={15} />{err}</div>}
      <p className="muted export-note">{t('Files are read from the evidence without changing it. Exported files keep their original created, modified and accessed times; existing files are never overwritten.')}</p>
    </Modal>
  )
}

function ExportCard({ status: s, onStop, onClose }: { status: ExportStatus; onStop: () => void; onClose: () => void }) {
  const running = s.state === 'running'
  const pct = s.totalBytes ? Math.min(100, (s.bytes / s.totalBytes) * 100) : running ? 0 : 100
  const title = running ? t('Exporting…') : s.state === 'done' ? t('Export finished') : s.state === 'cancelled' ? t('Export stopped') : t('Export failed')
  const [showProblems, setShowProblems] = useState(false)
  return (
    <div className={`export-card ${s.state}`}>
      <div className="export-head">
        {running ? <Loader size={15} className="spin" /> : s.state === 'done' && !s.failed ? <CircleCheck size={15} className="ok-text" /> : <CircleAlert size={15} className="err-text" />}
        <b>{title}</b>
        <span className="muted">{s.evidence}</span>
        <span className="spacer" />
        {!running && <button className="btn ghost icon sm" title={t('Close')} onClick={onClose}><X size={14} /></button>}
      </div>
      <div className="ov-track"><span className="ov-bar" style={{ width: `${pct}%` }} /></div>
      <div className="export-line num">
        {t('{done} / {files} files', { done: formatInt(s.done), files: formatInt(s.files) })} · {formatBytes(s.bytes)} / {formatBytes(s.totalBytes)}
        {s.seconds ? ` · ${Math.round(s.seconds)} s` : ''}
      </div>
      {running && s.current && <div className="export-line muted ellipsis" title={s.current}>{s.current}</div>}
      {s.error && <div className="export-line err-text">{s.error}</div>}
      {(s.failed > 0 || s.partial > 0) && (
        <button className="export-line link-btn" onClick={() => setShowProblems((v) => !v)}>
          {t('{failed} failed, {partial} partly readable', { failed: s.failed, partial: s.partial })}
        </button>
      )}
      {showProblems && <ul className="export-problems">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="export-actions">
        {running
          ? <button className="btn sm" onClick={onStop}><Square size={12} />{t('Stop')}</button>
          : <>
              {s.dest && window.ds?.shell && <button className="btn sm" onClick={() => window.ds!.shell!.show(s.dest!)}><FolderOpen size={13} />{t('Open folder')}</button>}
              {s.report && window.ds?.shell && <button className="btn sm" onClick={() => window.ds!.shell!.show(s.report!)}><FileSpreadsheet size={13} />{t('Show report')}</button>}
              {!window.ds?.shell && s.dest && <span className="muted mono-sm ellipsis" title={s.dest}>{s.dest}</span>}
            </>}
      </div>
    </div>
  )
}
