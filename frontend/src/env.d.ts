/// <reference types="vite/client" />

// API exposed by preload.cjs (absent when the page is previewed in a plain browser)
interface DsWindowApi {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximizedChange(cb: (maximized: boolean) => void): () => void
}

interface Window {
  ds?: {
    platform: string
    window: DsWindowApi
    backend: { info(): Promise<{ url: string | null; token: string | null; error: string | null }> }
    dialog: {
      openEvidence(): Promise<string | null>
      openEvidences(): Promise<string[] | null>
      chooseFolder(defaultPath?: string): Promise<string | null>
    }
    shell?: { show(path: string): Promise<boolean> }
    clipboard?: { writeText(text: string): Promise<boolean> }
  }
}

interface ImportMetaEnv {
  /** Backend URL used when previewing in a plain browser (development) */
  readonly VITE_DS_BACKEND?: string
  readonly VITE_DS_TOKEN?: string
}
