/** Small helpers for names and paths on the file server (always "/"-separated, whatever the phone is). */

/** The last part of a path: "/a/b/c.jpg" gives "c.jpg". */
export function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() || ''
}

/** The folder a path sits in: "/a/b/c.jpg" gives "/a/b", and "/c.jpg" gives "/". */
export function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return `/${parts.slice(0, -1).join('/')}`
}

/** Whether two paths name the same place, ignoring doubled and trailing slashes. */
export function samePath(a: string, b: string): boolean {
  return a.split('/').filter(Boolean).join('/') === b.split('/').filter(Boolean).join('/')
}

/** A folder and a name made into a path, with no doubled slashes. */
export function childPath(dir: string, name: string): string {
  return `/${[...dir.split('/').filter(Boolean), name].join('/')}`
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
