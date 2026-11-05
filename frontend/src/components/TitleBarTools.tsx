// Pages "portal" their tool buttons into the title bar: App owns the slot element, pages render into it with <TitleBarTools>.
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'

export const ToolsSlotContext = createContext<HTMLElement | null>(null)

export function TitleBarTools({ children }: { children: ReactNode }) {
  const slot = useContext(ToolsSlotContext)
  return slot ? createPortal(children, slot) : null
}

/** Title bar tool button: icon above, label below */
export function ToolButton({ icon: Icon, label, onClick, active, disabled, title }: {
  icon: LucideIcon; label: string; onClick?: () => void; active?: boolean; disabled?: boolean; title?: string
}) {
  return (
    <button className={`tb-btn${active ? ' active' : ''}`} onClick={onClick} disabled={disabled} title={title ?? label}>
      <Icon size={18} strokeWidth={1.8} />
      <span>{label}</span>
    </button>
  )
}

export function ToolDivider() {
  return <span className="tb-divider" />
}
