export function formatBytes(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do { v /= 1024; i++ } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}

export function formatInt(n: number): string {
  return n.toLocaleString('en-US')
}

export function hex(n: number, width = 8): string {
  return '0x' + n.toString(16).toUpperCase().padStart(width, '0')
}
