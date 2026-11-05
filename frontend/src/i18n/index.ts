// Minimal i18n: English source strings are the keys; other languages map them to translations.
// t('Opened {name}', { name }) interpolates {placeholders}. Missing translations fall back to English.
import { useEffect, useState } from 'react'
import { zhCN } from './zh-CN'

export type Lang = 'en' | 'zh-CN'

export const LANGUAGES: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '简体中文' },
]

const DICTS: Record<Lang, Record<string, string>> = { en: {}, 'zh-CN': zhCN }
const STORAGE_KEY = 'ds.lang'

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'en' || v === 'zh-CN') return v
  } catch { /* storage unavailable: use the default */ }
  return 'en'
}

let current: Lang = initialLang()
const listeners = new Set<(l: Lang) => void>()

export function getLang(): Lang {
  return current
}

export function setLang(l: Lang) {
  current = l
  try { localStorage.setItem(STORAGE_KEY, l) } catch { /* ignore */ }
  document.documentElement.lang = l
  listeners.forEach((f) => f(l))
}

/** Translate an English source string. */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = DICTS[current][s] ?? s
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  return out
}

/** Subscribe a component to language changes (App uses it, so the whole tree re-renders). */
export function useLang(): Lang {
  const [lang, set] = useState(current)
  useEffect(() => {
    listeners.add(set)
    return () => { listeners.delete(set) }
  }, [])
  return lang
}

document.documentElement.lang = current
