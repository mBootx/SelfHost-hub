/** What to do with a picked file whose name is already taken in the folder. */
export type ConflictChoice = 'replace' | 'keep-both' | 'skip'

export interface PlannedUpload {
  /** Position of the file in the picked list. */
  index: number
  /** The name to send it under. */
  name: string
  /** Replace what is on the server under that name. */
  override: boolean
}

/**
 * The first free name when `name` is taken: "photo.jpg" becomes "photo (2).jpg", then "photo (3).jpg", and so on.
 * `taken` holds the names already in the folder; a name that isn't in it comes back unchanged.
 */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem} (${i})${extension}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${extension}`
}

/** The picked files, by position, whose names are already taken in the folder. */
export function findConflicts(names: string[], taken: ReadonlySet<string>): number[] {
  const conflicts: number[] = []
  names.forEach((name, index) => {
    if (taken.has(name)) conflicts.push(index)
  })
  return conflicts
}

/**
 * What to send once the user has said what to do about the clashing names. A file that clashes with one
 * picked just before it always gets a new name, whatever the choice: replacing one picked file with another
 * is never what anyone means.
 */
export function planUploads(names: string[], taken: ReadonlySet<string>, choice: ConflictChoice): PlannedUpload[] {
  const used = new Set(taken)
  const picked = new Set<string>()
  const plan: PlannedUpload[] = []
  names.forEach((name, index) => {
    if (picked.has(name)) {
      const renamed = freeName(name, used)
      used.add(renamed)
      picked.add(renamed)
      plan.push({ index, name: renamed, override: false })
      return
    }
    picked.add(name)
    if (!taken.has(name)) {
      used.add(name)
      plan.push({ index, name, override: false })
      return
    }
    if (choice === 'skip') return
    if (choice === 'replace') {
      plan.push({ index, name, override: true })
      return
    }
    const renamed = freeName(name, used)
    used.add(renamed)
    picked.add(renamed)
    plan.push({ index, name: renamed, override: false })
  })
  return plan
}
