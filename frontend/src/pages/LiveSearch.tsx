// Search on real evidence: file name search (index, instant) + content search (background job reading every file).
import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, DatabaseZap, File, FileSearch, Loader, LocateFixed, Search, SearchX, Square, Trash2 } from 'lucide-react'
import { EmptyState, FolderIco, Highlight, Panel } from '../components/common'
import type { ContentHit, ContentStatus, Evidence, FileTarget, IndexedFile } from '../api/types'
import { backend } from '../api/client'
import { unixToText } from '../api/source'
import type { PageId } from '../components/Sidebar'
import { formatBytes, formatInt, hex } from '../util/format'
import { t } from '../i18n'

type Tab = 'name' | 'content'

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function LiveSearch({ evidence, selected, onLocate, onNavigate }: {
  evidence: Evidence[]; selected: Evidence; onLocate: (t: FileTarget) => void; onNavigate: (p: PageId) => void
}) {
  const [tab, setTab] = useState<Tab>('name')
  const indexed = evidence.filter((e) => e.index?.state === 'done' || e.index?.state === 'partial')
  const evName = (id: string) => evidence.find((e) => e.id === id)?.name ?? id

  const locate = async (fileId: number) => {
    const r = await backend.fileTrail(fileId)
    onLocate({ evidenceId: r.file.evidenceId, part: r.file.part, trail: r.trail, inode: r.file.inode })
  }

  if (indexed.length === 0) {
    return (
      <div className="page">
        <section className="panel grow">
          <EmptyState
            icon={<DatabaseZap size={36} strokeWidth={1.3} className="muted" />}
            title={t('Build the file index first')}
            text={t('Search uses the full file index in the case database. Click "Build index" for {name} on the Case page; after that you can search file names and content.', { name: selected.name })}
            actions={<button className="btn primary" onClick={() => onNavigate('case')}>{t('Build index')}</button>}
          />
        </section>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="search-tabs">
        <div className="seg">
          <button className={tab === 'name' ? 'active' : ''} onClick={() => setTab('name')}><Search size={14} />{t('File names')}</button>
          <button className={tab === 'content' ? 'active' : ''} onClick={() => setTab('content')}><FileSearch size={14} />{t('File content')}</button>
        </div>
        <span className="muted">{t('Indexed')}: {indexed.map((e) => `${e.name} (${t('{n} items', { n: formatInt(e.index!.files) })})`).join(', ')}</span>
      </div>
      {/* both panels stay mounted so switching tabs keeps their results */}
      <div style={{ display: tab === 'name' ? 'contents' : 'none' }}><NameSearch evName={evName} multi={evidence.length > 1} onLocate={locate} /></div>
      <div style={{ display: tab === 'content' ? 'contents' : 'none' }}><ContentSearch evName={evName} multi={evidence.length > 1} onLocate={locate} /></div>
    </div>
  )
}

// ---------------- file name search ----------------

function NameSearch({ evName, multi, onLocate }: { evName: (id: string) => string; multi: boolean; onLocate: (id: number) => Promise<void> }) {
  const [q, setQ] = useState('')
  const [regex, setRegex] = useState(false)
  const [inPath, setInPath] = useState(false)
  const [deleted, setDeleted] = useState(true)
  const [kind, setKind] = useState<'all' | 'file' | 'dir'>('all')
  const [res, setRes] = useState<{ q: string; hits: IndexedFile[]; truncated: boolean; ms: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<number | null>(null)

  const regexError = regex && q && (() => { try { new RegExp(q); return false } catch { return true } })()
  const run = async () => {
    if (!q.trim() || regexError) return
    setBusy(true)
    setErr(null)
    try {
      const r = await backend.search({ q: q.trim(), regex, inPath, deleted, kind })
      setRes({ q: q.trim(), ...r })
      setSel(null)
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  // search again automatically when a filter changes
  useEffect(() => { if (res) run() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [inPath, deleted, kind])

  const re = useMemo(() => {
    if (!res) return null
    try { return new RegExp(regex ? res.q : escapeRe(res.q), 'gi') } catch { return null }
  }, [res, regex])

  return (
    <>
      <section className="panel search-box">
        <div className="search-row">
          <div className={`search-input${regexError ? ' invalid' : ''}`}>
            <Search size={17} className="muted" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} spellCheck={false}
              placeholder={regex ? t('Regular expression, e.g. \\.(docx|xlsx|pdf)$') : t('File name keyword, e.g. password, poiuy, .lnk (case-insensitive)')} />
          </div>
          <div className="seg">
            <button className={!regex ? 'active' : ''} onClick={() => setRegex(false)}>{t('Keyword')}</button>
            <button className={regex ? 'active' : ''} onClick={() => setRegex(true)}>{t('Regex')}</button>
          </div>
          <button className="btn primary" onClick={run} disabled={busy || !q.trim() || !!regexError}>{busy && <Loader size={14} className="spin" />}{t('Search')}</button>
        </div>
        <div className="search-opts">
          <span className="muted">{t('Match by')}</span>
          <label className="check"><input type="radio" checked={!inPath} onChange={() => setInPath(false)} />{t('File name')}</label>
          <label className="check"><input type="radio" checked={inPath} onChange={() => setInPath(true)} />{t('Full path')}</label>
          <span className="tb-divider" />
          <span className="muted">{t('Type')}</span>
          <label className="check"><input type="radio" checked={kind === 'all'} onChange={() => setKind('all')} />{t('All')}</label>
          <label className="check"><input type="radio" checked={kind === 'file'} onChange={() => setKind('file')} />{t('Files')}</label>
          <label className="check"><input type="radio" checked={kind === 'dir'} onChange={() => setKind('dir')} />{t('Directories')}</label>
          <span className="tb-divider" />
          <label className="check"><input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} />{t('Include deleted')}</label>
          <div className="spacer" />
          {regexError && <span className="err-text">{t('Invalid regular expression')}</span>}
        </div>
      </section>

      <Panel
        className="grow"
        title={t('Results')}
        count={res ? `${t('{n} hits', { n: formatInt(res.hits.length) + (res.truncated ? '+' : '') })} · ${res.ms} ms` : undefined}
        bodyClass="flush list-body"
        actions={res?.truncated && <span className="badge warn">{t('Too many results, showing the first {n}; narrow the search', { n: formatInt(res.hits.length) })}</span>}
      >
        {err ? (
          <div className="err-box" style={{ margin: 12 }}><CircleAlert size={15} />{err}</div>
        ) : !res ? (
          <EmptyState icon={<Search size={36} strokeWidth={1.3} className="muted" />} title={t('Search the whole evidence by file name')} text={t('Keywords of three or more characters use the full-text index and return almost instantly; regular expressions work too. Double-click a result to show it in Files.')} />
        ) : res.hits.length === 0 ? (
          <EmptyState icon={<SearchX size={36} strokeWidth={1.3} className="muted" />} title={t('No matches')} text={t('Try another keyword, tick "Include deleted" or match the full path.')} />
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <colgroup><col style={{ width: '24%' }} /><col /><col style={{ width: 90 }} /><col style={{ width: 160 }} />{multi && <col style={{ width: 140 }} />}<col style={{ width: 70 }} /></colgroup>
              <thead><tr><th>{t('Name')}</th><th>{t('Path')}</th><th className="r">{t('Size')}</th><th>{t('Modified (UTC)')}</th>{multi && <th>{t('Evidence')}</th>}<th /></tr></thead>
              <tbody>
                {res.hits.map((f) => (
                  <tr key={f.id} className={`${f.id === sel ? 'selected' : ''}${f.deleted ? ' deleted' : ''}`} onClick={() => setSel(f.id)} onDoubleClick={() => onLocate(f.id)}>
                    <td title={f.name}>
                      <div className="cell-name">
                        {f.isDir ? <FolderIco /> : f.deleted ? <Trash2 size={16} /> : <File size={16} className="ico-file" />}
                        <span><Highlight text={f.name} re={inPath ? null : re} /></span>
                        {f.deleted && <span className="badge danger">{t('Deleted')}</span>}
                      </div>
                    </td>
                    <td className="dim" title={`p${f.part}:${f.path}`}>{t('Partition {n}', { n: f.part })}<Highlight text={f.path} re={inPath ? re : null} /></td>
                    <td className="r num">{f.isDir ? '' : formatBytes(f.size)}</td>
                    <td className="num dim">{unixToText(f.modified)}</td>
                    {multi && <td className="dim">{evName(f.evidenceId)}</td>}
                    <td className="r"><button className="btn ghost sm icon" title={t('Show in Files')} onClick={() => onLocate(f.id)}><LocateFixed size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  )
}

// ---------------- content search ----------------

function ContentSearch({ evName, multi, onLocate }: { evName: (id: string) => string; multi: boolean; onLocate: (id: number) => Promise<void> }) {
  const [q, setQ] = useState('')
  const [st, setSt] = useState<ContentStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const running = st?.state === 'running'

  // when the page opens, restore the content search that is running or ran last in the backend
  useEffect(() => { backend.contentStatus().then((s) => s.state !== 'idle' && setSt(s), () => {}) }, [])
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => backend.contentStatus().then(setSt, () => {}), 700)
    return () => clearInterval(t)
  }, [running])

  const start = async () => {
    setErr(null)
    try { setSt(await backend.startContent(q.trim())) } catch (e) { setErr(errText(e)) }
  }
  const cancel = async () => setSt(await backend.cancelContent())

  const re = useMemo(() => (st?.query ? new RegExp(escapeRe(st.query), 'gi') : null), [st?.query])
  const pct = st && st.total ? (st.scanned / st.total) * 100 : 0
  const hitKey = (h: ContentHit) => `${h.fileId}:${h.offset}:${h.encoding}`

  return (
    <>
      <section className="panel search-box">
        <div className="search-row">
          <div className="search-input">
            <FileSearch size={17} className="muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !running && q.trim().length >= 2 && start()} spellCheck={false}
              placeholder={t('Find in file content, e.g. password, an e-mail address, a phone number, any keyword (2+ characters)')} />
          </div>
          {running
            ? <button className="btn" onClick={cancel}><Square size={13} />{t('Stop')}</button>
            : <button className="btn primary" onClick={start} disabled={q.trim().length < 2}>{t('Start search')}</button>}
        </div>
        <div className="search-opts">
          <span className="muted">{t('Searches both UTF-8 and UTF-16LE (common on Windows), ASCII case-insensitive; skips files over 64 MB; includes still-readable data of deleted files.')}</span>
        </div>
        {st && st.state !== 'idle' && (
          <div className="hash-progress">
            <div className="ov-track"><span className="ov-bar" style={{ width: `${pct.toFixed(1)}%` }} /></div>
            <span className="num muted">
              {st.state === 'running' ? t('Searching') : st.state === 'done' ? t('Done') : st.state === 'cancelled' ? t('Stopped') : t('Error')}
              {' · '}{t('{scanned} / {total} files · read {bytes} · {s} s', { scanned: formatInt(st.scanned), total: formatInt(st.total), bytes: formatBytes(st.bytes), s: Math.round(st.seconds) })}
            </span>
          </div>
        )}
      </section>

      <Panel
        className="grow"
        title={st?.query ? t('Hits for "{q}"', { q: st.query }) : t('Content hits')}
        count={st ? t('{n} hits', { n: formatInt(st.hits.length) + (st.truncated ? '+' : '') }) : undefined}
        bodyClass="flush list-body"
        actions={st?.truncated && <span className="badge warn">{t('Too many hits, stopped at {n}', { n: formatInt(st.hits.length) })}</span>}
      >
        {err || st?.error ? (
          <div className="err-box" style={{ margin: 12 }}><CircleAlert size={15} />{err ?? st?.error}</div>
        ) : !st ? (
          <EmptyState icon={<FileSearch size={36} strokeWidth={1.3} className="muted" />} title={t('Find keywords in file content')} text={t('Reads the data of every indexed file; a 30 GB system disk usually takes a few minutes. The search runs in the background and can be stopped at any time.')} />
        ) : st.hits.length === 0 ? (
          running
            ? <EmptyState icon={<Loader size={28} className="spin muted" />} title={t('Searching…')} text={t('Hits appear here as they are found.')} />
            : <EmptyState icon={<SearchX size={36} strokeWidth={1.3} className="muted" />} title={t('No matching content')} />
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <colgroup><col style={{ width: '20%' }} /><col style={{ width: '26%' }} /><col /><col style={{ width: 110 }} /><col style={{ width: 90 }} />{multi && <col style={{ width: 130 }} />}<col style={{ width: 56 }} /></colgroup>
              <thead><tr><th>{t('File')}</th><th>{t('Path')}</th><th>{t('Hit')}</th><th className="r">{t('Offset')}</th><th>{t('Encoding')}</th>{multi && <th>{t('Evidence')}</th>}<th /></tr></thead>
              <tbody>
                {st.hits.map((h) => (
                  <tr key={hitKey(h)} className={`${hitKey(h) === sel ? 'selected' : ''}${h.deleted ? ' deleted' : ''}`} onClick={() => setSel(hitKey(h))} onDoubleClick={() => onLocate(h.fileId)}>
                    <td title={h.name}><div className="cell-name">{h.deleted ? <Trash2 size={16} /> : <File size={16} className="ico-file" />}<span>{h.name}</span></div></td>
                    <td className="dim" title={`p${h.part}:${h.path}`}>{t('Partition {n}', { n: h.part })}{h.path}</td>
                    <td className="ctx" title={h.context}><Highlight text={h.context} re={re} /></td>
                    <td className="r mono">{hex(h.offset)}</td>
                    <td className="dim">{h.encoding}</td>
                    {multi && <td className="dim">{evName(h.evidenceId)}</td>}
                    <td className="r"><button className="btn ghost sm icon" title={t('Show in Files')} onClick={() => onLocate(h.fileId)}><LocateFixed size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  )
}
