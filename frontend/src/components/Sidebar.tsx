import type { LucideIcon } from 'lucide-react'
import { Briefcase, FolderTree, Microscope, Search, Settings } from 'lucide-react'
import { LogoMark } from './Logo'
import { BRAND } from '../brand'
import { t } from '../i18n'

export type PageId = 'case' | 'files' | 'analysis' | 'search' | 'settings'

export const PAGES: { id: PageId; label: string; icon: LucideIcon; needsCase: boolean }[] = [
  { id: 'case', label: 'Case', icon: Briefcase, needsCase: false },
  { id: 'files', label: 'Files', icon: FolderTree, needsCase: true },
  { id: 'analysis', label: 'Analysis', icon: Microscope, needsCase: true },
  { id: 'search', label: 'Search', icon: Search, needsCase: true },
]

export function Sidebar({ page, onChange, caseOpen }: { page: PageId; onChange: (p: PageId) => void; caseOpen: boolean }) {
  return (
    <nav className="nav">
      <div className="brand" title={`${BRAND.name} ${BRAND.version} · ${BRAND.slogan}`}>
        <LogoMark size={40} />
      </div>
      {PAGES.map(({ id, label, icon: Icon, needsCase }) => {
        const disabled = needsCase && !caseOpen
        return (
          <button
            key={id}
            className={`nav-item${page === id ? ' active' : ''}`}
            disabled={disabled}
            title={disabled ? t('Open a case first') : t(label)}
            onClick={() => onChange(id)}
          >
            <Icon size={19} strokeWidth={1.8} />
            {t(label)}
          </button>
        )
      })}
      <div className="grow" />
      <button className={`nav-item${page === 'settings' ? ' active' : ''}`} title={t('Settings')} onClick={() => onChange('settings')}>
        <Settings size={20} strokeWidth={1.7} />
        {t('Settings')}
      </button>
    </nav>
  )
}
