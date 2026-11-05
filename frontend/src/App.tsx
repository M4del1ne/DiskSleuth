import { useCallback, useEffect, useState } from 'react'
import { Sidebar, type PageId } from './components/Sidebar'
import { TitleBar, type BackendState } from './components/TitleBar'
import { ToolsSlotContext } from './components/TitleBarTools'
import { CasePage } from './pages/CasePage'
import { FilesPage } from './pages/FilesPage'
import { AnalysisPage } from './pages/AnalysisPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'
import { Toaster, toast } from './components/Toast'
import { pickImages } from './util/evidence'
import { ExportCenter } from './components/ExportCenter'
import type { CaseInfo, Evidence, FileTarget } from './api/types'
import { backend, connectBackend, type LiveCase } from './api/client'
import { demoSource, liveSource, type DataSource } from './api/source'
import { demoCase, demoEvidence } from './api/mock'
import { t, useLang } from './i18n'

/** The open case. source decides whether data comes from the backend or the built-in demo. */
/** What the New case dialog collects */
export interface NewCaseInput { name: string; examiner: string; number: string; location: string; images: string[] }

export interface Session {
  info: CaseInfo
  evidence: Evidence[]
  selectedId?: string
  source: DataSource
}

function liveSession(c: LiveCase): Session {
  return {
    info: { id: c.info.dir, name: c.info.name, number: c.info.number, examiner: c.info.examiner || '—', createdAt: c.info.createdAt, location: c.info.dir },
    evidence: c.evidence,
    selectedId: c.evidence[0]?.id,
    source: liveSource,
  }
}

export function App() {
  useLang() // re-render the whole tree when the language changes
  const [page, setPage] = useState<PageId>('case')
  const [session, setSession] = useState<Session | null>(null)
  const [backendState, setBackendState] = useState<BackendState>({ status: 'connecting' })
  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null)
  const [fileTarget, setFileTarget] = useState<FileTarget | null>(null)

  useEffect(() => {
    connectBackend().then(async (r) => {
      if (!('health' in r)) return setBackendState({ status: 'offline', error: r.error })
      setBackendState({ status: 'online', tsk: r.health.tsk })
      // after a page reload, restore the case the backend still has open
      const cur = await backend.currentCase()
      if (cur) setSession(liveSession(cur))
    })
  }, [])

  const online = backendState.status === 'online'
  const selected = session?.evidence.find((e) => e.id === session.selectedId) ?? session?.evidence[0]

  const openDemo = () => setSession({ info: demoCase, evidence: [demoEvidence], selectedId: demoEvidence.id, source: demoSource })
  const [addingImages, setAddingImages] = useState(0)
  const createCase = async (c: NewCaseInput) => {
    if (!online) return openDemo()
    setSession(liveSession(await backend.createCase({ name: c.name, examiner: c.examiner, number: c.number, location: c.location })))
    if (c.images.length) void addImages(c.images) // the dialog closes; progress shows in the evidence list
  }
  const openCase = async (dir: string) => setSession(liveSession(await backend.openCase(dir)))
  const closeCase = async () => {
    if (session?.source.kind === 'live') await backend.closeCase()
    setSession(null)
    setPage('case')
  }
  const addEvidence = async (path: string) => {
    const ev = await backend.addEvidence(path)
    setSession((s) => s && { ...s, evidence: s.evidence.some((e) => e.id === ev.id) ? s.evidence : [...s.evidence, ev], selectedId: ev.id })
  }
  // add several images one after another (opening an image takes a moment); failures are reported, the rest continue
  const addImages = async (paths: string[]) => {
    let ok = 0
    setAddingImages(paths.length)
    for (const p of paths) {
      try {
        await addEvidence(p)
        ok++
      } catch (e) {
        toast(t('Cannot add {path}: {error}', { path: p, error: e instanceof Error ? e.message : String(e) }), 'error')
      }
      setAddingImages((n) => Math.max(0, n - 1))
    }
    setAddingImages(0)
    if (ok) toast(t('{n} images added', { n: ok }))
  }
  // "Add evidence": the system picker in Electron; in a plain browser the Case page shows a path dialog instead
  const pickAndAdd = async () => {
    const paths = await pickImages()
    if (!paths) return
    setPage('case')
    await addImages(paths)
  }
  const updateEvidence = useCallback((ev: Evidence) => {
    setSession((s) => s && { ...s, evidence: s.evidence.map((e) => (e.id === ev.id ? ev : e)) })
  }, [])
  const locate = (t: FileTarget) => {
    setSession((s) => s && { ...s, selectedId: t.evidenceId })
    setFileTarget(t)
    setPage('files')
  }

  return (
    <ToolsSlotContext.Provider value={toolsSlot}>
      <div className="app">
        <Sidebar page={page} onChange={setPage} caseOpen={!!session} />
        <div className="main">
          <TitleBar
            toolsRef={setToolsSlot}
            backend={backendState}
            demoCase={session?.source.kind === 'demo'}
          />
          <main className="content">
            {page === 'case' && (
              <CasePage
                session={session}
                selected={selected}
                backendOnline={online}
                onOpenDemo={openDemo}
                onCreate={createCase}
                onOpenCase={openCase}
                onAddEvidence={addEvidence}
                onPickEvidence={window.ds ? pickAndAdd : undefined}
                addingImages={addingImages}
                onUpdateEvidence={updateEvidence}
                onSelect={(id) => setSession((s) => s && { ...s, selectedId: id })}
                onClose={closeCase}
                onNavigate={setPage}
              />
            )}
            {page === 'settings' && <SettingsPage backendOnline={online} tsk={backendState.status === 'online' ? backendState.tsk : undefined} />}
            {session && page !== 'case' && page !== 'settings' && !selected && <NoEvidence onAdd={window.ds ? pickAndAdd : () => setPage('case')} />}
            {session && selected && page === 'files' && (
              <FilesPage
                evidence={session.evidence}
                selectedId={selected.id}
                source={session.source}
                target={fileTarget}
                onTargetDone={() => setFileTarget(null)}
                onSelectEvidence={(id) => setSession((s) => s && { ...s, selectedId: id })}
              />
            )}
            {session && selected && page === 'analysis' && (
              <AnalysisPage
                evidence={session.evidence}
                selectedId={selected.id}
                source={session.source}
                onLocate={locate}
                onSelectEvidence={(id) => setSession((s) => s && { ...s, selectedId: id })}
              />
            )}
            {session && selected && page === 'search' && (
              <SearchPage evidence={session.evidence} selected={selected} source={session.source} onLocate={locate} onNavigate={setPage} />
            )}
          </main>
        </div>
      </div>
      <ExportCenter enabled={session?.source.kind === 'live'} />
      <Toaster />
    </ToolsSlotContext.Provider>
  )
}

function NoEvidence({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="empty">
      <h2>{t('This case has no evidence yet')}</h2>
      <p>{t('Add an E01 / DD image on the Case page first.')}</p>
      <div className="actions"><button className="btn primary" onClick={onAdd}>{t('Add evidence')}</button></div>
    </div>
  )
}
