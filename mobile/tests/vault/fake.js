// An in-memory FileBrowser: folders and files, with the answers the real one gives (404 for a missing path,
// 409 for something that already exists), plus failure injection and a record of everything it is asked.
class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

function parts(path) {
  return path.split('/').filter(Boolean)
}

function dirNode() {
  return { dir: true, children: new Map() }
}

/** tree: { folder: { sub: { 'file.jpg': 1200 } } } - numbers are file sizes. */
function build(tree) {
  const node = dirNode()
  for (const [name, value] of Object.entries(tree || {})) {
    node.children.set(name, typeof value === 'number' ? { dir: false, size: value, modified: '2026-09-15T10:00:00Z' } : build(value))
  }
  return node
}

function createFake(tree) {
  const root = build(tree)
  const fake = {
    root,
    requested: [],
    failures: { list: {}, rename: {}, remove: {} },
    listInFlight: 0,
    listPeak: 0,
    listDelay: 2,
    find(path) {
      let node = root
      for (const part of parts(path)) {
        if (!node.dir || !node.children.has(part)) return null
        node = node.children.get(part)
      }
      return node
    },
    async list(path) {
      fake.requested.push(['list', path])
      fake.listInFlight++
      fake.listPeak = Math.max(fake.listPeak, fake.listInFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, fake.listDelay))
        if (fake.failures.list[path] !== undefined) throw new ApiError('list failed', fake.failures.list[path])
        const node = fake.find(path)
        if (!node) throw new ApiError('not found', 404)
        if (!node.dir) throw new ApiError('not a folder', 400)
        const base = '/' + parts(path).join('/')
        return [...node.children.entries()].map(([name, child]) => ({
          name,
          path: (base === '/' ? '' : base) + '/' + name,
          size: child.dir ? 0 : child.size,
          isDir: child.dir,
          modified: child.dir ? '' : child.modified,
          type: child.dir ? 'directory' : 'image'
        }))
      } finally {
        fake.listInFlight--
      }
    },
    async remove(path) {
      fake.requested.push(['remove', path])
      if (fake.failures.remove[path] !== undefined) throw new ApiError('remove failed', fake.failures.remove[path])
      const segs = parts(path)
      const parent = fake.find('/' + segs.slice(0, -1).join('/'))
      if (!parent || !parent.children.has(segs[segs.length - 1])) throw new ApiError('not found', 404)
      parent.children.delete(segs[segs.length - 1])
    },
    async rename(from, to) {
      fake.requested.push(['rename', from, to])
      if (fake.failures.rename[from] !== undefined) throw new ApiError('rename failed', fake.failures.rename[from])
      const a = parts(from)
      const b = parts(to)
      const source = fake.find(from)
      if (!source) throw new ApiError('not found', 404)
      const targetParent = fake.find('/' + b.slice(0, -1).join('/'))
      if (!targetParent || !targetParent.dir) throw new ApiError('parent missing', 404)
      if (targetParent.children.has(b[b.length - 1])) throw new ApiError('exists', 409)
      fake.find('/' + a.slice(0, -1).join('/')).children.delete(a[a.length - 1])
      targetParent.children.set(b[b.length - 1], source)
    },
    async createFolder(path) {
      fake.requested.push(['createFolder', path])
      const segs = parts(path)
      const parent = fake.find('/' + segs.slice(0, -1).join('/'))
      if (!parent) throw new ApiError('parent missing', 404)
      if (parent.children.has(segs[segs.length - 1])) throw new ApiError('exists', 409)
      parent.children.set(segs[segs.length - 1], dirNode())
    },
    /** Every path in the tree, as "/a/b/c.jpg" (folders end with a slash). */
    dump() {
      const out = []
      const walk = (node, prefix) => {
        for (const [name, child] of [...node.children.entries()].sort()) {
          out.push(prefix + '/' + name + (child.dir ? '/' : ''))
          if (child.dir) walk(child, prefix + '/' + name)
        }
      }
      walk(root, '')
      return out
    }
  }
  return fake
}

module.exports = { createFake, ApiError }
