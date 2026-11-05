import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { t } from '../i18n'
import { TaskCenter } from './TaskCenter'

export type BackendState =
  | { status: 'connecting' }
  | { status: 'online'; tsk: string }
  | { status: 'offline'; error: string }

/** Title bar: page tool buttons on the left, window controls on the right. Shows a notice only when the backend is offline or a demo case is open. */
export function TitleBar({ toolsRef, backend, demoCase }: {
  toolsRef?: (el: HTMLDivElement | null) => void
  backend: BackendState
  demoCase?: boolean
}) {
  const api = window.ds?.window
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!api) return
    api.isMaximized().then(setMaximized)
    return api.onMaximizedChange(setMaximized)
  }, [api])

  const warn =
    backend.status === 'offline' ? { text: t('Backend offline · demo only'), title: backend.error }
    : demoCase ? { text: t('Demo case'), title: t('This case uses built-in demo data, not real evidence results') }
    : null

  return (
    <header className="titlebar" onDoubleClick={() => api?.toggleMaximize()}>
      {/* slot for page tool buttons (see TitleBarTools.tsx) */}
      <div className="tb-tools no-drag" ref={toolsRef} onDoubleClick={(e) => e.stopPropagation()} />
      <div className="spacer" />
      {warn && (
        <span className="status-pill no-drag warn" title={warn.title}>
          <span className="dot" />
          {warn.text}
        </span>
      )}
      <TaskCenter online={backend.status === 'online'} />
      <div className="winctl no-drag" onDoubleClick={(e) => e.stopPropagation()}>
        <button title={t('Minimize')} onClick={() => api?.minimize()}>
          <Minus size={16} strokeWidth={1.6} />
        </button>
        <button title={maximized ? t('Restore') : t('Maximize')} onClick={() => api?.toggleMaximize()}>
          {maximized ? <Copy size={13} strokeWidth={1.6} /> : <Square size={13} strokeWidth={1.6} />}
        </button>
        <button className="close" title={t('Close')} onClick={() => api?.close()}>
          <X size={17} strokeWidth={1.6} />
        </button>
      </div>
    </header>
  )
}
