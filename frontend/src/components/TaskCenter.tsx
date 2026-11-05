// Task list in the title bar: plugin runs, file index, hashing, content search and export of the open case.
// Polls GET /api/tasks (every second while something runs or the panel is open, otherwise every 3 s).
// Plugin/index/hash jobs disappear from the backend list when they finish; they are kept here as "done" until dismissed.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, Download, FileSearch, FolderTree, Hash, ListChecks, Loader, Microscope, Square, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { backend } from '../api/client'
import { localizeManifest } from '../api/plugins'
import type { Task } from '../api/types'
import { formatBytes, formatInt } from '../util/format'
import { t } from '../i18n'

interface Item extends Task { key: string; finishedAt?: string }

const ICON: Record<Task['kind'], LucideIcon> = { plugins: Microscope, index: FolderTree, hash: Hash, content: FileSearch, export: Download }
const TITLE: Record<Task['kind'], string> = {
  plugins: 'Analysis plugins', index: 'Building file index', hash: 'Computing hashes', content: 'Content search', export: 'File export',
}
const running = (s: Task['state']) => s === 'running' || s === 'stopping'
const keyOf = (x: Task) => `${x.id}:${x.started ?? ''}`
const nowText = () => new Date().toLocaleTimeString()

export function TaskCenter({ online }: { online: boolean }) {
  const [tasks, setTasks] = useState<Item[]>([])
  const [finished, setFinished] = useState<Item[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState(false)
  const [names, setNames] = useState<Record<string, string>>({})
  const prev = useRef<Item[]>([])
  const box = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    let list: Task[]
    try { list = await backend.tasks() } catch { return }
    const items = list.map((x) => ({ ...x, key: keyOf(x) }))
    // jobs that were running and are gone now have finished
    const gone = prev.current.filter((p) => running(p.state) && ['plugins', 'index', 'hash'].includes(p.kind) && !items.some((x) => x.id === p.id))
    if (gone.length) {
      const at = nowText()
      setFinished((f) => [...gone.map((g) => ({ ...g, state: 'done' as const, progress: 1, canStop: false, key: `${g.id}:${Date.now()}`, finishedAt: at })), ...f].slice(0, 20))
    }
    prev.current = items
    setTasks(items)
  }, [])

  const anyRunning = tasks.some((x) => running(x.state))
  useEffect(() => {
    if (!online) return
    refresh()
    const timer = window.setInterval(refresh, open || anyRunning ? 1000 : 3000)
    return () => clearInterval(timer)
  }, [online, open, anyRunning, refresh])

  // plugin names in the UI language
  const needNames = tasks.some((x) => x.kind === 'plugins' && x.current && !names[x.current])
  useEffect(() => {
    if (!needNames) return
    backend.plugins().then((c) => setNames(Object.fromEntries(c.plugins.map((p) => [p.id, localizeManifest(p).name]))), () => {})
  }, [needNames])

  // close on click outside / Escape
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])

  const stop = async (x: Task) => {
    try {
      if (x.kind === 'plugins' && x.evidenceId) await backend.stopPlugins(x.evidenceId)
      else if (x.kind === 'index' && x.evidenceId) await backend.cancelIndex(x.evidenceId)
      else if (x.kind === 'content') await backend.cancelContent()
      else if (x.kind === 'export') await backend.cancelExport()
    } finally { refresh() }
  }

  const items = [...tasks, ...finished].filter((x) => !dismissed.has(x.key))
  const runningCount = items.filter((x) => running(x.state)).length
  const finishedKeys = items.filter((x) => !running(x.state)).map((x) => x.key)

  return (
    <div className="task-center no-drag" ref={box} onDoubleClick={(e) => e.stopPropagation()}>
      <button className={`task-btn${open ? ' active' : ''}`} title={t('Tasks')} onClick={() => setOpen((v) => !v)}>
        {runningCount ? <Loader size={17} className="spin" /> : <ListChecks size={18} strokeWidth={1.7} />}
        {runningCount > 0 && <span className="task-badge">{runningCount}</span>}
      </button>
      {open && (
        <div className="task-panel">
          <div className="task-panel-head">
            <b>{t('Tasks')}</b>
            <span className="muted">{runningCount ? t('{n} running', { n: runningCount }) : ''}</span>
            <span className="spacer" />
            {finishedKeys.length > 0 && (
              <button className="btn ghost sm" onClick={() => setDismissed((d) => new Set([...d, ...finishedKeys]))}>{t('Clear finished')}</button>
            )}
          </div>
          {!online ? <div className="task-empty muted">{t('The backend is not connected.')}</div>
            : items.length === 0 ? <div className="task-empty muted">{t('No background tasks')}</div>
            : items.map((x) => (
              <TaskRow key={x.key} task={x} pluginName={(id) => names[id] ?? id}
                onStop={() => stop(x)} onDismiss={() => setDismissed((d) => new Set(d).add(x.key))} />
            ))}
        </div>
      )}
    </div>
  )
}

function TaskRow({ task: x, pluginName, onStop, onDismiss }: {
  task: Item; pluginName: (id: string) => string; onStop: () => void; onDismiss: () => void
}) {
  const Icon = ICON[x.kind]
  const isRunning = running(x.state)
  const pct = x.progress >= 0 ? Math.round(x.progress * 100) : null
  let detail: ReactNode = null
  switch (x.kind) {
    case 'plugins':
      detail = isRunning
        ? <>{x.current ? pluginName(x.current) : ''}{x.message ? ` · ${x.message}` : ''}{x.queue ? ` · ${t('{n} left', { n: x.queue })}` : ''}</>
        : t('All queued plugins finished')
      break
    case 'index':
      detail = isRunning ? t('{dirs} directories read, {files} entries', { dirs: formatInt(x.total), files: formatInt(x.done) }) : t('Index built')
      break
    case 'hash':
      detail = isRunning ? `${formatBytes(x.done)} / ${formatBytes(x.total)}` : t('Hashes computed')
      break
    case 'content':
      detail = <>“{x.current}” · {t('{done} / {total} files', { done: formatInt(x.done), total: formatInt(x.total) })} · {t('{n} hits', { n: x.message ?? '0' })}</>
      break
    case 'export':
      detail = <>{t('{done} / {files} files', { done: formatInt(x.done), files: formatInt(x.total) })}{x.queue ? ` · ${t('{n} with problems', { n: x.queue })}` : ''}</>
      break
  }
  const stateText = x.state === 'stopping' ? t('Stopping…') : isRunning ? (pct !== null ? `${pct}%` : t('Running'))
    : x.state === 'done' ? t('Done') : x.state === 'cancelled' ? t('Stopped') : t('Failed')
  const sub = x.kind === 'export' ? (isRunning ? x.current : x.message) : undefined
  return (
    <div className={`task-row ${x.state}`}>
      <span className="task-ico"><Icon size={16} /></span>
      <div className="task-main">
        <div className="task-title">
          <b>{t(TITLE[x.kind])}</b>
          {x.evidenceName && <span className="muted ellipsis">{x.evidenceName}</span>}
          <span className="spacer" />
          <span className={`task-state ${x.state}`}>
            {x.state === 'done' ? <CircleCheck size={13} /> : x.state === 'error' ? <CircleAlert size={13} /> : null}{stateText}
          </span>
        </div>
        <div className="task-detail ellipsis">{detail}</div>
        {sub && <div className="task-detail muted ellipsis" title={sub}>{sub}</div>}
        {x.error && <div className="task-detail err-text ellipsis" title={x.error}>{x.error}</div>}
        {isRunning && <div className={`ov-track${pct === null ? ' indeterminate' : ''}`}><span className="ov-bar" style={{ width: pct === null ? '30%' : `${pct}%` }} /></div>}
        {x.finishedAt && <div className="task-detail muted">{t('Finished at {time}', { time: x.finishedAt })}</div>}
      </div>
      <div className="task-actions">
        {x.canStop && <button className="btn ghost sm icon" title={t('Stop')} onClick={onStop}><Square size={12} /></button>}
        {!isRunning && <button className="btn ghost sm icon" title={t('Dismiss')} onClick={onDismiss}><X size={14} /></button>}
      </div>
    </div>
  )
}
