import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, X } from 'lucide-react'
import { t } from '../i18n'

export function Panel({ title, count, actions, children, className = '', bodyClass = '', style }: {
  title?: ReactNode; count?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; style?: CSSProperties
}) {
  return (
    <section className={`panel ${className}`} style={style}>
      {title !== undefined && (
        <div className="panel-head">
          <h3>{title}</h3>
          {count !== undefined && <span className="count">{count}</span>}
          <div className="spacer" />
          {actions}
        </div>
      )}
      <div className={`panel-body ${bodyClass}`}>{children}</div>
    </section>
  )
}

export function EmptyState({ icon, title, text, actions }: { icon?: ReactNode; title: string; text?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

export function TreeRow({ depth, label, icon, count, expanded, hasChildren, selected, onToggle, onSelect, title, onContextMenu }: {
  depth: number; label: ReactNode; icon?: ReactNode; count?: ReactNode; expanded?: boolean; hasChildren?: boolean
  selected?: boolean; onToggle?: () => void; onSelect?: () => void; title?: string; onContextMenu?: (e: ReactMouseEvent) => void
}) {
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 4 + depth * 16 }}
      onClick={onSelect}
      onDoubleClick={onToggle}
      onContextMenu={onContextMenu}
      title={title}
    >
      <span
        className="twist"
        onClick={(e) => { e.stopPropagation(); onToggle?.() }}
      >
        {hasChildren ? (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
      </span>
      {icon}
      <span className="label">{label}</span>
      {count !== undefined && <span className="cnt">{count}</span>}
    </div>
  )
}

export function Modal({ title, children, footer, onClose }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost icon" onClick={onClose} title={t('Close')}><X size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Hex viewer: offset | 16 bytes | ASCII */
export function HexView({ bytes, base = 0 }: { bytes: Uint8Array; base?: number }) {
  const rows = []
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.subarray(off, off + 16)
    const hexCells = Array.from(chunk, (b, i) => (
      <span key={i} className={b === 0 ? 'zero' : undefined}>{b.toString(16).padStart(2, '0')}{i === 7 ? '  ' : ' '}</span>
    ))
    const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    rows.push(
      <div key={off}>
        <span className="off">{(base + off).toString(16).toUpperCase().padStart(8, '0')}</span>{'  '}
        {hexCells}
        {'   '.repeat(16 - chunk.length)}{' '}
        <span className="asc">{ascii}</span>
      </div>,
    )
  }
  return <div className="hex">{rows}</div>
}

/** Highlight the parts of text matched by matcher with <mark> */
export function Highlight({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <>{text}</>
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index === undefined || m[0] === '') continue
    parts.push(text.slice(last, m.index), <mark key={m.index}>{m[0]}</mark>)
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

/** Filled folder icon (easier to recognize than an outline) */
export function FolderIco({ size = 17 }: { size?: number }) {
  return <Folder size={size} color="#d6981f" fill="#f7c95c" strokeWidth={1.6} style={{ flex: 'none' }} />
}

/**
 * Resizable width/height: returns the current size and a drag start handler. The size is kept in localStorage (a per-machine convenience; defaults are used when storage fails).
 * axis 'y' drags up/down; invert means the panel sits after the splitter (right/below), so the drag direction is reversed.
 */
export function useResizableWidth(key: string, initial: number, min: number, max: number, opts: { axis?: 'x' | 'y'; invert?: boolean } = {}) {
  const { axis = 'x', invert = false } = opts
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key))
      if (v >= min && v <= max) return v
    } catch { /* storage unavailable: use the default */ }
    return initial
  })
  useEffect(() => {
    try { localStorage.setItem(key, String(width)) } catch { /* ignore */ }
  }, [key, width])

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault()
    const pos = (ev: { clientX: number; clientY: number }) => (axis === 'x' ? ev.clientX : ev.clientY)
    const p0 = pos(e)
    const w0 = width
    const cls = axis === 'x' ? 'resizing' : 'resizing-y'
    const move = (ev: PointerEvent) => {
      const d = (pos(ev) - p0) * (invert ? -1 : 1)
      setWidth(Math.min(max, Math.max(min, Math.round(w0 + d))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove(cls)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.classList.add(cls)
  }
  return { width, startDrag, reset: () => setWidth(initial) }
}

/** Splitter: vertical drags the width, horizontal drags the height; double-click resets */
export function Splitter({ onPointerDown, onReset, orientation = 'vertical' }: {
  onPointerDown: (e: ReactPointerEvent) => void; onReset: () => void; orientation?: 'vertical' | 'horizontal'
}) {
  return (
    <div
      className={orientation === 'vertical' ? 'splitter' : 'splitter-h'}
      role="separator"
      aria-orientation={orientation}
      title={orientation === 'vertical' ? t('Drag to resize width, double-click to reset') : t('Drag to resize height, double-click to reset')}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    >
      <span className="grip" />
    </div>
  )
}
