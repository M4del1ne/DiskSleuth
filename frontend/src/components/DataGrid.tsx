// Result grid: index column + resizable columns (drag the header edge); scrolls horizontally when too wide, stretches the last column when too narrow; widths are remembered per storageKey.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { t } from '../i18n'

export interface GridColumn {
  key: string
  title: string
  width?: number
  align?: 'left' | 'right'
  className?: string
}

const MIN_W = 56
const INDEX_W = 56

function loadWidths(key?: string): Record<string, number> {
  if (!key) return {}
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') } catch { return {} }
}

export function DataGrid<R>({ columns, rows, render, rowKey, selected, onSelect, onActivate, storageKey, rowClass, onCellContextMenu, onCopy }: {
  columns: GridColumn[]
  rows: R[]
  /** Cell content (strings double as the hover tooltip) */
  render: (row: R, col: GridColumn) => ReactNode
  rowKey?: (row: R, i: number) => string | number
  selected?: number | null
  onSelect?: (i: number) => void
  onActivate?: (i: number) => void
  storageKey?: string
  rowClass?: (row: R) => string | undefined
  /** right-click on a cell (col is null for the index column); the row is selected first */
  onCellContextMenu?: (e: ReactMouseEvent, rowIndex: number, col: GridColumn | null) => void
  /** Ctrl+C with a selected row */
  onCopy?: (rowIndex: number) => void
}) {
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths(storageKey))
  useEffect(() => { setWidths(loadWidths(storageKey)) }, [storageKey])
  useEffect(() => {
    if (!storageKey) return
    try { localStorage.setItem(storageKey, JSON.stringify(widths)) } catch { /* ignore */ }
  }, [storageKey, widths])

  // visible width: when the columns are narrower than the view, the last column takes the rest
  const wrapRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAvail(el.clientWidth))
    ro.observe(el)
    setAvail(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const w = (c: GridColumn) => widths[c.key] ?? c.width ?? 200
  const total = INDEX_W + columns.reduce((s, c) => s + w(c), 0)
  const extra = Math.max(0, avail - total)
  const lastKey = columns[columns.length - 1]?.key
  const shown = (c: GridColumn) => w(c) + (c.key === lastKey ? extra : 0)

  const startResize = (e: ReactPointerEvent, c: GridColumn) => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const w0 = shown(c)
    const move = (ev: PointerEvent) => setWidths((m) => ({ ...m, [c.key]: Math.max(MIN_W, Math.round(w0 + ev.clientX - x0)) }))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.classList.add('resizing')
  }

  // keyboard: arrows move the selection, Enter activates, Ctrl+C copies
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!rows.length) return
    const cur = selected ?? -1
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(0, Math.min(rows.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))
      onSelect?.(next)
      wrapRef.current?.querySelectorAll('tbody tr')[next]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && cur >= 0) {
      onActivate?.(cur)
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && cur >= 0 && !window.getSelection()?.toString()) {
      e.preventDefault()
      onCopy?.(cur)
    }
  }

  return (
    <div className="table-wrap" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown}>
      <table className="grid data-grid" style={{ width: total + extra }}>
        <colgroup>
          <col style={{ width: INDEX_W }} />
          {columns.map((c) => <col key={c.key} style={{ width: shown(c) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="r idx">#</th>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'r' : undefined}>
                <span className="th-text">{c.title}</span>
                <span
                  className="col-resizer"
                  title={t('Drag to resize, double-click to reset')}
                  onPointerDown={(e) => startResize(e, c)}
                  onDoubleClick={() => setWidths((m) => { const n = { ...m }; delete n[c.key]; return n })}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={rowKey ? rowKey(r, i) : i}
              className={[i === selected ? 'selected' : '', rowClass?.(r) ?? ''].join(' ').trim() || undefined}
              onClick={() => onSelect?.(i)}
              onDoubleClick={() => onActivate?.(i)}
              onContextMenu={onCellContextMenu && ((e) => {
                onSelect?.(i)
                const key = (e.target as HTMLElement).closest('td')?.dataset.col
                onCellContextMenu(e, i, columns.find((c) => c.key === key) ?? null)
              })}
            >
              <td className="r idx num">{i + 1}</td>
              {columns.map((c) => {
                const v = render(r, c)
                return (
                  <td key={c.key} data-col={c.key} className={[c.className, c.align === 'right' ? 'r' : ''].filter(Boolean).join(' ') || undefined}
                    title={typeof v === 'string' || typeof v === 'number' ? String(v) : undefined}>
                    {v}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
