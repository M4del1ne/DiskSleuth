// Copy text to the clipboard and confirm with a toast. Falls back to execCommand when the async API is unavailable.
import { toast } from '../components/Toast'
import { t } from '../i18n'

export async function copyText(text: string, what?: string) {
  if (!(await write(text))) {
    toast(t('Copy failed: the clipboard is not available'), 'error')
    return
  }
  const lines = text.split('\n').length
  toast(what ? t('Copied {what}', { what }) : lines > 1 ? t('Copied {n} lines', { n: lines }) : t('Copied'))
}

async function write(text: string): Promise<boolean> {
  try {
    if (window.ds?.clipboard) return await window.ds.clipboard.writeText(text) // Electron: main process clipboard
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall back below */ }
  return fallbackCopy(text)
}

function fallbackCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  return ok
}

/** Does this text look like a file path inside the evidence (C:\…, %SystemRoot%\…, \SystemRoot\…, p2:/…, /Users/…)? */
export function looksLikePath(s: string): boolean {
  const v = s.trim().replace(/^"/, '')
  return /^([A-Za-z]:\\|\\\\\?\\|\\\?\?\\|\\SystemRoot\\|%[\w() ]+%\\|p\d+:[\\/]|\/[^/\s]|system32\\|syswow64\\)/i.test(v) && !/^\w+:\/\//.test(v)
}
