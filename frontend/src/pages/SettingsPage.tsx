import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Languages, Loader, Puzzle, RefreshCw, TriangleAlert } from 'lucide-react'
import { Panel } from '../components/common'
import { backend } from '../api/client'
import { localizeManifest } from '../api/plugins'
import type { PluginCatalog } from '../api/types'
import { BRAND } from '../brand'
import { LANGUAGES, setLang, t, useLang } from '../i18n'

export function SettingsPage({ backendOnline, tsk }: { backendOnline: boolean; tsk?: string }) {
  const lang = useLang()
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback((refresh = false) => {
    if (!backendOnline) return
    setLoading(true)
    backend.plugins(refresh).then((c) => { setCatalog(c); setErr(null) }, (e) => setErr(String(e))).finally(() => setLoading(false))
  }, [backendOnline])
  useEffect(() => { load() }, [load])

  const py = catalog?.python
  return (
    <div className="page settings-page">
      <Panel title={<><Languages size={16} className="h-ico" />{t('Language')}</>}>
        <div className="seg lang-seg">
          {LANGUAGES.map((l) => (
            <button key={l.id} className={lang === l.id ? 'active' : ''} onClick={() => setLang(l.id)}>{l.label}</button>
          ))}
        </div>
        <p className="muted settings-note">{t('Plugin result tables use the translations shipped with each plugin; values without a translation stay in English.')}</p>
      </Panel>

      <Panel title={<><Puzzle size={16} className="h-ico" />{t('Plugins')}</>} count={catalog ? catalog.plugins.length : undefined}
        actions={<button className="btn ghost sm" disabled={!backendOnline || loading} onClick={() => load(true)} title={t('Reload plugins and re-check Python dependencies')}>
          {loading ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}{t('Recheck')}
        </button>}>
        {!backendOnline ? (
          <p className="muted">{t('The backend is not connected.')}</p>
        ) : err ? (
          <div className="err-box"><CircleAlert size={15} />{err}</div>
        ) : !catalog ? null : (
          <>
            <dl className="kv">
              <dt>{t('Python')}</dt>
              <dd>{py?.ok
                ? <span className="ok-text"><CircleCheck size={13} />Python {py.version}</span>
                : <span className="err-text"><CircleAlert size={13} />{py?.error ?? t('unknown')}</span>}
                <div className="muted mono-sm">{py?.path}</div>
              </dd>
              {!!py?.missing.length && <>
                <dt>{t('Missing modules')}</dt>
                <dd><span className="err-text">{py.missing.join(', ')}</span><br /><code className="cmd">.venv\Scripts\pip install -r plugins\requirements.txt</code></dd>
              </>}
            </dl>
            <table className="grid settings-plugins">
              <thead><tr><th>{t('Plugin')}</th><th>ID</th><th>{t('Version')}</th><th>{t('Result tables')}</th><th>{t('Status')}</th></tr></thead>
              <tbody>
                {catalog.plugins.map((raw) => {
                  const p = localizeManifest(raw)
                  return (
                    <tr key={p.id}>
                      <td title={p.description}>{p.name}</td>
                      <td className="mono">{p.id}</td>
                      <td className="num">{p.version}</td>
                      <td>{p.outputs.map((o) => o.name).join(', ')}</td>
                      <td>{p.missing?.length
                        ? <span className="badge warn"><TriangleAlert size={12} />{t('Missing {mods}', { mods: p.missing.join(', ') })}</span>
                        : <span className="badge ok"><CircleCheck size={12} />{t('Ready')}</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {catalog.problems.length > 0 && (
              <div className="problems">
                <h4><TriangleAlert size={14} />{t('Plugins that could not be loaded')}</h4>
                <ul>{catalog.problems.map((p) => <li key={p} className="mono-sm">{p}</li>)}</ul>
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel title={t('About')}>
        <dl className="kv">
          <dt>{t('Version')}</dt><dd>{BRAND.name} {BRAND.version}</dd>
          <dt>{t('Backend')}</dt><dd>{backendOnline ? t('Connected') : t('Not connected')}{tsk ? ` · The Sleuth Kit ${tsk}` : ''}</dd>
          <dt>{t('License')}</dt><dd>Apache-2.0</dd>
        </dl>
      </Panel>
    </div>
  )
}
