import { useMemo, useState } from 'react'
import { Search, SearchX } from 'lucide-react'
import { EmptyState, Highlight, Panel } from '../components/common'
import type { Evidence, FileTarget, SearchHit, SearchMode } from '../api/types'
import type { PageId } from '../components/Sidebar'
import { LiveSearch } from './LiveSearch'
import type { DataSource } from '../api/source'
import { demoEvidence, demoHash, search } from '../api/mock'
import { hex } from '../util/format'
import { t } from '../i18n'

const SCOPES = [
  { id: 'filename', label: 'File names' },
  { id: 'content', label: 'File content' },
  { id: 'registry', label: 'Registry' },
  { id: 'deleted', label: 'Include deleted' },
]

const KIND_LABEL: Record<SearchHit['kind'], { text: string; cls: string }> = {
  filename: { text: 'File name', cls: 'info' },
  content: { text: 'Content', cls: 'accent' },
  registry: { text: 'Registry', cls: 'warn' },
}

const EXAMPLES: { q: string; mode: SearchMode }[] = [
  { q: 'poiuy', mode: 'keyword' },
  { q: 'WIN-49I0SNRJAMF', mode: 'keyword' },
  { q: '\\.(docx|xlsx)$', mode: 'regex' },
  { q: demoHash.md5!, mode: 'hash' },
]

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function SearchPage({ evidence, selected, source, onLocate, onNavigate }: {
  evidence: Evidence[]; selected: Evidence; source: DataSource; onLocate: (t: FileTarget) => void; onNavigate: (p: PageId) => void
}) {
  if (source.kind === 'live') return <LiveSearch evidence={evidence} selected={selected} onLocate={onLocate} onNavigate={onNavigate} />
  return <DemoSearch />
}

function DemoSearch() {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('keyword')
  const [scopes, setScopes] = useState<Set<string>>(() => new Set(['filename', 'content', 'registry', 'deleted']))
  const [submitted, setSubmitted] = useState<{ q: string; mode: SearchMode } | null>(null)
  const [selId, setSelId] = useState<string | null>(null)

  const results = useMemo(() => (submitted ? search(submitted.q, submitted.mode, scopes) : []), [submitted, scopes])
  const re = useMemo(() => {
    if (!submitted || submitted.mode === 'hash') return null
    try { return new RegExp(submitted.mode === 'regex' ? submitted.q : escapeRe(submitted.q), 'gi') } catch { return null }
  }, [submitted])
  const regexError = mode === 'regex' && query && (() => { try { new RegExp(query); return false } catch { return true } })()

  const run = (q = query, m = mode) => { if (q.trim()) { setSubmitted({ q, mode: m }); setSelId(null) } }
  const toggleScope = (id: string) => setScopes((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="page">
      <section className="panel search-box">
        <div className="search-row">
          <div className={`search-input${regexError ? ' invalid' : ''}`}>
            <Search size={17} className="muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && run()}
              placeholder={mode === 'hash' ? t('Enter an MD5 / SHA1 / SHA256') : mode === 'regex' ? t('Regular expression, e.g. \\.(docx|xlsx)$') : t('Keyword, e.g. a user name, host name or e-mail address')}
              spellCheck={false}
            />
          </div>
          <div className="seg">
            {(['keyword', 'regex', 'hash'] as const).map((m) => (
              <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
                {m === 'keyword' ? t('Keyword') : m === 'regex' ? t('Regex') : t('Hash')}
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={() => run()} disabled={!query.trim() || !!regexError}>{t('Search')}</button>
        </div>
        <div className="search-opts">
          <span className="muted">{t('Scope')}</span>
          {SCOPES.map((s) => (
            <label key={s.id} className="check">
              <input type="checkbox" checked={scopes.has(s.id)} onChange={() => toggleScope(s.id)} disabled={mode === 'hash'} />
              {t(s.label)}
            </label>
          ))}
          <div className="spacer" />
          {regexError ? <span className="err-text">{t('Invalid regular expression')}</span> : <span className="muted">{t('Demo data · evidence: {name}', { name: demoEvidence.name })}</span>}
        </div>
      </section>

      <Panel
        className="grow"
        title={t('Results')}
        count={submitted ? t('{n} hits', { n: results.length }) : undefined}
        bodyClass="flush list-body"
      >
        {!submitted ? (
          <EmptyState
            icon={<Search size={36} strokeWidth={1.3} className="muted" />}
            title={t('Search the whole evidence')}
            text={t('File names, file content, registry values and deleted files; files can also be found by hash.')}
            actions={EXAMPLES.map((e) => (
              <button key={e.q} className="btn sm" onClick={() => { setQuery(e.q); setMode(e.mode); run(e.q, e.mode) }}>
                <span className="muted">{e.mode === 'keyword' ? t('Keyword') : e.mode === 'regex' ? t('Regex') : t('Hash')}</span>
                <span className="mono">{e.q.length > 24 ? e.q.slice(0, 22) + '…' : e.q}</span>
              </button>
            ))}
          />
        ) : results.length === 0 ? (
          <EmptyState icon={<SearchX size={36} strokeWidth={1.3} className="muted" />} title={t('No matches')} text={t('Try another keyword or a wider scope.')} />
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <colgroup><col style={{ width: 84 }} /><col style={{ width: '38%' }} /><col /><col style={{ width: 120 }} /><col style={{ width: 70 }} /></colgroup>
              <thead><tr><th>{t('Type')}</th><th>{t('Path')}</th><th>{t('Hit')}</th><th className="r">{t('Offset')}</th><th>{t('Partition')}</th></tr></thead>
              <tbody>
                {results.map((h) => (
                  <tr key={h.id} className={`${h.id === selId ? 'selected' : ''}${h.deleted ? ' deleted' : ''}`} onClick={() => setSelId(h.id)}>
                    <td><span className={`badge ${KIND_LABEL[h.kind].cls}`}>{t(KIND_LABEL[h.kind].text)}</span></td>
                    <td className="mono" title={h.path}><Highlight text={h.path} re={h.kind === 'filename' ? re : null} /></td>
                    <td title={h.context}>{h.deleted && <span className="badge danger" style={{ marginRight: 6 }}>{t('Deleted')}</span>}<Highlight text={h.context} re={h.kind === 'filename' ? null : re} /></td>
                    <td className="r mono">{h.offset !== undefined ? hex(h.offset) : '—'}</td>
                    <td>{h.partition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
