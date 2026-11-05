// Plugin manifest localization: plugins ship optional locales/<lang>.json files with translated
// names, groups, column titles and cell values. English (the manifest itself) is the fallback.
import { getLang, t } from '../i18n'
import type { PluginManifest } from './types'

/** Manifest with names, groups and column titles in the current UI language. group stays the canonical English key; groupLabel is for display. */
export function localizeManifest(m: PluginManifest): PluginManifest & { outputs: (PluginManifest['outputs'][number] & { groupLabel: string })[] } {
  const loc = m.locales?.[getLang()]
  return {
    ...m,
    name: loc?.name ?? m.name,
    description: loc?.description ?? m.description,
    outputs: m.outputs.map((o) => {
      const lo = loc?.outputs?.[o.id]
      return {
        ...o,
        name: lo?.name ?? t(o.name),
        groupLabel: lo?.group ?? t(o.group),
        columns: o.columns.map((c) => ({ ...c, title: lo?.columns?.[c.key] ?? t(c.title) })),
      }
    }),
  }
}

/** Translate a text cell value with the plugin's value dictionary (e.g. "Yes" -> "是"). */
export function localizeValue(m: PluginManifest | undefined, v: string): string {
  if (!m || !v) return v
  return m.locales?.[getLang()]?.values?.[v] ?? v
}
