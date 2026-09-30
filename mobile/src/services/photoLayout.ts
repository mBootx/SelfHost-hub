import type { Photo } from '@/services/photoVault'

export type SortKey = 'newest' | 'oldest' | 'name-asc' | 'name-desc' | 'largest' | 'smallest'

export const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Plus récentes',
  oldest: 'Plus anciennes',
  'name-asc': 'Nom (A → Z)',
  'name-desc': 'Nom (Z → A)',
  largest: 'Plus volumineuses',
  smallest: 'Plus légères'
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

/** Year and month of the folder a photo is filed in, as one number; photos outside year/month folders sort last. */
function monthKey(photo: Photo): number {
  return photo.year === null ? -1 : photo.year * 100 + (photo.month ?? 0)
}

/** A sorted copy. By date it follows the year/month folders, then when the server last saw the file, then the name. */
export function sortPhotos(photos: Photo[], key: SortKey): Photo[] {
  const byNameDesc = (a: Photo, b: Photo): number => collator.compare(b.name, a.name)
  const newestFirst = (a: Photo, b: Photo): number => monthKey(b) - monthKey(a) || b.modified - a.modified || byNameDesc(a, b)
  const sorted = [...photos]
  switch (key) {
    case 'newest':
      return sorted.sort(newestFirst)
    case 'oldest':
      return sorted.sort((a, b) => newestFirst(b, a))
    case 'name-asc':
      return sorted.sort((a, b) => collator.compare(a.name, b.name) || a.path.localeCompare(b.path))
    case 'name-desc':
      return sorted.sort((a, b) => byNameDesc(a, b) || b.path.localeCompare(a.path))
    case 'largest':
      return sorted.sort((a, b) => b.size - a.size || newestFirst(a, b))
    case 'smallest':
      return sorted.sort((a, b) => a.size - b.size || newestFirst(a, b))
  }
}

/** Photos whose name contains every word typed, ignoring case and accents. */
export function filterPhotos(photos: Photo[], query: string): Photo[] {
  const words = fold(query).split(' ').filter(Boolean)
  if (words.length === 0) return photos
  return photos.filter((photo) => {
    const name = fold(photo.name)
    return words.every((word) => name.includes(word))
  })
}

function fold(text: string): string {
  // Decomposed accents are the combining marks U+0300 to U+036F: dropped, so "é" matches "e".
  const plain = [...text.normalize('NFD')].filter((ch) => ch.charCodeAt(0) < 0x300 || ch.charCodeAt(0) > 0x36f)
  return plain.join('').toLowerCase().trim()
}

export type GridRow =
  | { kind: 'header'; key: string; title: string; count: number }
  | { kind: 'photos'; key: string; photos: Photo[]; firstIndex: number }

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

export function monthTitle(year: number | null, month: number | null): string {
  if (year === null) return 'Autres photos'
  return month === null ? String(year) : `${MONTHS[month - 1][0].toUpperCase()}${MONTHS[month - 1].slice(1)} ${year}`
}

/**
 * Rows for the grid: `columns` photos per row. Sorted by date the photos are grouped under a header per
 * month; any other order is one plain run. `firstIndex` is the position in `photos` of the row's first
 * photo, so a tap can open the viewer at the right place.
 */
export function buildRows(photos: Photo[], columns: number, grouped: boolean): GridRow[] {
  const rows: GridRow[] = []
  const pushRun = (run: Photo[], start: number, group: string): void => {
    for (let i = 0; i < run.length; i += columns) {
      rows.push({ kind: 'photos', key: `${group}:${start + i}`, photos: run.slice(i, i + columns), firstIndex: start + i })
    }
  }
  if (!grouped) {
    pushRun(photos, 0, 'all')
    return rows
  }
  let start = 0
  while (start < photos.length) {
    const key = monthKey(photos[start])
    let end = start
    while (end < photos.length && monthKey(photos[end]) === key) end++
    const { year, month } = photos[start]
    rows.push({ kind: 'header', key: `h:${key}`, title: monthTitle(year, month), count: end - start })
    pushRun(photos.slice(start, end), start, `m:${key}`)
    start = end
  }
  return rows
}

export function formatSize(bytes: number): string {
  if (!bytes) return '-'
  const units = ['o', 'Ko', 'Mo', 'Go']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
