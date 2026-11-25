import { AppState } from 'react-native'
import type { HubServerClient, HubServerStatus } from '@/services/hubServer'
import {
  ackDirtyWeeks,
  applyOtherEntries,
  flushListening,
  getListeningRev,
  setListeningRev,
  takeDirtyWeeks,
  useListeningStore,
  whenListeningLoaded
} from '@/services/listeningLog'
import { logEvent } from '@/services/diagnostics'

/**
 * Keeps this phone's listening and the other devices' in step through the hub server (docs/server-protocol.md,
 * "Listening data"): after the welcome it uploads the weeks that changed (8 at a time) and downloads what the others
 * have since the last revision it saw; while connected it uploads again when something changed (at most every 60 s, and
 * at once when the app goes to the background) and downloads when the server says another device uploaded.
 */

export const PUSH_BATCH = 8
export const PUSH_MIN_INTERVAL_MS = 60_000
/** A change is uploaded this long after it was saved, to gather the saves that follow. */
const PUSH_DELAY_MS = 3_000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_PULL_PAGES = 200

type Reply = { kind: 'ok'; message: Record<string, any> } | { kind: 'error'; message: Record<string, any> } | { kind: 'lost' }

/** Starts syncing over `client`; returns the function that stops it. */
export function attachListeningSync(client: HubServerClient): () => void {
  let active = true
  let connected = false
  let lastPushAt = 0
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let pushQueued = false
  let pullQueued = false
  let chain: Promise<void> = Promise.resolve()
  let waiting: { type: string; resolve: (reply: Reply) => void; timer: ReturnType<typeof setTimeout> } | null = null

  function settle(reply: Reply): void {
    const current = waiting
    if (!current) return
    waiting = null
    clearTimeout(current.timer)
    current.resolve(reply)
  }

  /** Sends a frame and waits for the answer of type `type` (or for an `error`, the connection's loss, or 20 s). */
  function request(message: Record<string, unknown>, type: string): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      if (!connected || !client.send(message)) {
        resolve({ kind: 'lost' })
        return
      }
      const timer = setTimeout(() => settle({ kind: 'lost' }), REQUEST_TIMEOUT_MS)
      waiting = { type, resolve, timer }
    })
  }

  function run(task: () => Promise<void>): void {
    chain = chain.then(task).catch((err) => {
      logEvent('remote', `Synchronisation de l'écoute : ${err?.message ?? err}`, 'warn')
    })
  }

  /** Uploads every changed week, 8 at a time. False when it was cut short. */
  async function pushAll(): Promise<boolean> {
    await whenListeningLoaded()
    for (;;) {
      if (!active || !connected) return false
      const { weeks, versions } = takeDirtyWeeks(PUSH_BATCH)
      const keys = Object.keys(weeks)
      if (keys.length === 0) return true
      const reply = await request({ type: 'listening.push', weeks }, 'listening.ack')
      if (reply.kind === 'lost') return false
      if (reply.kind === 'error') {
        // One week the server refuses (too large) must not hold the others back: they are sent one by one, and a week
        // refused on its own is given up.
        if (keys.length > 1) {
          for (const key of keys) {
            if (!connected) return false
            const single = await request({ type: 'listening.push', weeks: { [key]: weeks[key] } }, 'listening.ack')
            if (single.kind === 'lost') return false
            if (single.kind === 'error') {
              logEvent('remote', `Semaine ${key} refusée par le serveur (${String(single.message.code ?? 'erreur')})`, 'warn')
              ackDirtyWeeks([key], versions)
            } else {
              ackDirtyWeeks([key], versions)
            }
          }
          continue
        }
        logEvent('remote', `Semaine ${keys[0]} refusée par le serveur (${String(reply.message.code ?? 'erreur')})`, 'warn')
        ackDirtyWeeks(keys, versions)
        continue
      }
      const acked = Array.isArray(reply.message.weeks) ? (reply.message.weeks as unknown[]).filter((w): w is string => typeof w === 'string') : keys
      // An answer that clears nothing would be asked for again for ever.
      if (ackDirtyWeeks(acked, versions) === 0) return false
    }
  }

  /** Downloads the other devices' weeks since the last revision, page by page. */
  async function pullAll(): Promise<void> {
    await whenListeningLoaded()
    let since = getListeningRev()
    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      if (!active || !connected) return
      const reply = await request({ type: 'listening.pull', since }, 'listening.data')
      if (reply.kind !== 'ok') return
      const data = reply.message
      const entries: any[] = Array.isArray(data.entries) ? data.entries : []
      applyOtherEntries(entries)
      const lastRev = entries.length > 0 ? entries[entries.length - 1]?.rev : undefined
      if (data.more === true && typeof lastRev === 'number' && lastRev > since) {
        since = lastRev
        setListeningRev(since)
        continue
      }
      if (typeof data.rev === 'number' && data.rev > since) setListeningRev(data.rev)
      return
    }
  }

  function syncNow(): void {
    if (!connected) return
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = null
    run(async () => {
      lastPushAt = Date.now()
      await pushAll()
      await pullAll()
      schedulePush()
    })
  }

  function schedulePush(): void {
    if (!connected || pushQueued || useListeningStore.getState().dirty === 0) return
    const wait = Math.max(PUSH_DELAY_MS, lastPushAt + PUSH_MIN_INTERVAL_MS - Date.now())
    pushQueued = true
    pushTimer = setTimeout(() => {
      pushTimer = null
      pushQueued = false
      run(async () => {
        lastPushAt = Date.now()
        await pushAll()
        // Weeks that changed during the upload wait for the next one.
        schedulePush()
      })
    }, wait)
  }

  function schedulePull(): void {
    if (!connected || pullQueued) return
    pullQueued = true
    run(async () => {
      pullQueued = false
      await pullAll()
    })
  }

  const offStatus = client.onStatus((status: HubServerStatus) => {
    if (status === 'connected') {
      connected = true
      syncNow()
    } else {
      connected = false
      if (pushTimer) clearTimeout(pushTimer)
      pushTimer = null
      pushQueued = false
      settle({ kind: 'lost' })
    }
  })

  const offMessage = client.onMessage((message) => {
    switch (message.type) {
      case 'listening.ack':
      case 'listening.data':
        if (waiting?.type === message.type) settle({ kind: 'ok', message })
        break
      case 'error':
        // An error about a push or a pull being waited for; one about anything else is nobody's business here.
        if (waiting && (message.code === 'too-large' || message.code === 'bad-message')) settle({ kind: 'error', message })
        break
      case 'listening.changed':
        schedulePull()
        break
    }
  })

  const offStore = useListeningStore.subscribe((state, prev) => {
    // Any save counts, not only a change of the number: a week changing again while its upload is on its way stays dirty.
    if (state.dirty > 0 && (state.dirty !== prev.dirty || state.weeks !== prev.weeks)) schedulePush()
  })

  const appState = AppState.addEventListener('change', (next) => {
    if (next !== 'background' || !connected) return
    flushListening()
    if (useListeningStore.getState().dirty > 0) {
      if (pushTimer) clearTimeout(pushTimer)
      pushTimer = null
      pushQueued = false
      run(async () => {
        lastPushAt = Date.now()
        await pushAll()
      })
    }
  })

  // A client already connected when the sync is attached.
  if (client.status === 'connected') {
    connected = true
    syncNow()
  }

  return () => {
    active = false
    connected = false
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = null
    settle({ kind: 'lost' })
    offStatus()
    offMessage()
    offStore()
    appState.remove()
  }
}
