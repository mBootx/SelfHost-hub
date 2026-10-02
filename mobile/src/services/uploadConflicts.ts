import { freeName } from './fileNames'

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
