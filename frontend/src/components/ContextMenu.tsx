// Custom right-click menu. Usage:
//   const menu = useContextMenu()
//   <tr onContextMenu={(e) => menu.open(e, [{ label: 'Copy', onClick }, 'sep', ...])}>  … {menu.node}
// Closes on click outside, Escape, scroll, resize or window blur; arrow keys + Enter work while it is open.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'

export interface MenuAction {
  label: string
  icon?: LucideIcon
  /** the value or path the action uses; shown as a tooltip, not in the menu */
  hint?: string
  shortcut?: string
  disabled?: boolean
  onClick: () => void
}
export type MenuItem = MenuAction | 'sep' | null | false

interface MenuState { x: number; y: number; items: MenuAction[] | ('sep' | MenuAction)[] }

export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const open = (e: ReactMouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    // drop empty entries and separators that would be first, last or doubled
    const clean: ('sep' | MenuAction)[] = []
    for (const it of items) {
      if (!it) continue
      if (it === 'sep' && (clean.length === 0 || clean[clean.length - 1] === 'sep')) continue
      clean.push(it)
    }
    while (clean[clean.length - 1] === 'sep') clean.pop()
    if (clean.length) setMenu({ x: e.clientX, y: e.clientY, items: clean })
  }
  const node = menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />
  return { open, node, isOpen: !!menu }
}

function ContextMenu({ x, y, items, onClose }: MenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [active, setActiveState] = useState(-1)
  const activeRef = useRef(-1)
  const setActive = (f: number | ((a: number) => number)) => {
    const v = typeof f === 'function' ? f(activeRef.current) : f
    activeRef.current = v
    setActiveState(v)
  }
  const actions = items.map((it, i) => (it !== 'sep' && !it.disabled ? i : -1)).filter((i) => i >= 0)

  // keep the menu inside the window
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y,
    })
  }, [x, y])

  useEffect(() => {
    const close = () => onClose()
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => {
          const k = actions.indexOf(a)
          const n = e.key === 'ArrowDown' ? (k + 1) % actions.length : (k - 1 + actions.length) % actions.length
          return actions[n] ?? -1
        })
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const it = items[activeRef.current]
        if (it && it !== 'sep') { onClose(); it.onClick() }
      }
    }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', down, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [onClose, items, actions])

  return createPortal(
    <div ref={ref} className="ctx-menu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => it === 'sep'
        ? <div key={`sep${i}`} className="ctx-sep" role="separator" />
        : (
          <button
            key={i}
            role="menuitem"
            className={`ctx-item${i === active ? ' active' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(it.disabled ? -1 : i)}
            onClick={() => { onClose(); it.onClick() }}
          >
            <span className="ctx-ico">{it.icon && <it.icon size={15} strokeWidth={1.8} />}</span>
            {/* only the action name is shown; the value or path it uses is available as a tooltip */}
            <span className="ctx-label" title={it.hint || undefined}>{it.label}</span>
            {it.shortcut && <span className="ctx-key">{it.shortcut}</span>}
          </button>
        ))}
    </div>,
    document.body,
  )
}
