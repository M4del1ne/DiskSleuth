// Picking evidence images with the system dialog.

/** Drop later segments of split images when their first segment is selected too
 *  (disk.E02… / disk.EAA… with disk.E01, disk.002… with disk.001): the backend opens the set from the first one. */
export function firstSegments(paths: string[]): string[] {
  const lower = new Set(paths.map((p) => p.toLowerCase()))
  return paths.filter((p) => {
    const m = p.match(/^(.*)\.(e(?:0[2-9]|[1-9]\d|[a-z]{2})|ex(?:0[2-9]|[1-9]\d)|0(?:0[2-9]|[1-9]\d))$/i)
    if (!m) return true
    const base = m[1].toLowerCase()
    const first = /^ex/i.test(m[2]) ? `${base}.ex01` : /^e/i.test(m[2]) ? `${base}.e01` : `${base}.001`
    return !lower.has(first)
  })
}

/** Open the system picker for one or more images; null when cancelled or outside Electron. */
export async function pickImages(): Promise<string[] | null> {
  const r = await window.ds?.dialog.openEvidences?.()
  return r && r.length ? firstSegments(r) : null
}
