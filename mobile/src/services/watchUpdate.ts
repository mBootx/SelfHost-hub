import { sha256 } from 'js-sha256'
import { Directory, File, Paths } from 'expo-file-system'
import SelfHostNative from '../../modules/selfhost-native'
import { describeError, logEvent } from '@/services/diagnostics'
import { BUSY_PHASES, useWatchUpdate, WatchRelease } from '@/store/watchUpdateStore'
import { fetchWithTimeout } from './http'
import { isNewer, LATEST_RELEASE_URL, pickWatchApk, watchApkName } from './updateAsset'
import { buildUpdateHeader, UPDATE_PATHS, versionCodeOf, watchCanReceive } from './watchUpdateProtocol'

/**
 * Updating the watch app from this phone (the protocol is in watchUpdateProtocol.ts): finds the watch APK in the latest
 * GitHub release, downloads it, and sends it to the watch over the data layer, which installs it and says how it went
 * (see watchLink.ts, which hands what the watch says to the store). GitHub allows 60 anonymous API calls an hour; the
 * automatic check stays far below that.
 */

const CHECK_INTERVAL_MS = 60 * 60 * 1000
/** A watch that refuses the file closes the channel, and says why a moment later: the reason is worth the wait. */
const REASON_WAIT_MS = 1500

const folder = () => new Directory(Paths.cache, 'watch-updates')

/** Whether this build of the app can send an update to a watch. */
export function updateSupported(): boolean {
  return !!SelfHostNative?.sendUpdateToWatch && !!SelfHostNative?.sendToWatch
}

/** The watch APK of the latest GitHub release, if it ships one. */
export async function findWatchRelease(): Promise<WatchRelease | null> {
  const res = await fetchWithTimeout(LATEST_RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`)
  const release = await res.json()
  const version = String(release.tag_name ?? '').replace(/^v/i, '')
  const code = versionCodeOf(version)
  const asset = pickWatchApk<{ name: string; browser_download_url: string; size: number; digest?: string }>(release.assets ?? [], version)
  if (!asset || code === null || typeof asset.browser_download_url !== 'string' || !(asset.size > 0)) return null
  const digest = typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null
  return { version, code, url: asset.browser_download_url, size: asset.size, digest }
}

export type WatchCheck = 'available' | 'current' | 'unknown' | 'error' | 'skipped'

/** Looks for a newer watch app. `manual` skips the hourly throttle and reports failures. */
export async function checkWatchUpdate(manual = false): Promise<WatchCheck> {
  const store = useWatchUpdate
  const { phase, checkedAt } = store.getState()
  if (BUSY_PHASES.includes(phase)) return 'skipped'
  if (!manual && Date.now() - checkedAt < CHECK_INTERVAL_MS) return 'skipped'
  store.setState({ checkedAt: Date.now() })
  try {
    const latest = await findWatchRelease()
    store.setState({ latest })
    const watch = store.getState().watch
    if (!latest || !watch) return 'unknown'
    return isNewer(latest.version, watch.version) ? 'available' : 'current'
  } catch (err) {
    logEvent('update', `Recherche de mise à jour de la montre impossible : ${describeError(err)}`, 'warn')
    return 'error'
  }
}

/** Asks the watch which version of its app it has: the answer comes back through watchLink.ts, into the store. */
export async function askWatchVersion(): Promise<void> {
  if (!SelfHostNative?.sendToWatch) return
  try {
    await SelfHostNative.sendToWatch(UPDATE_PATHS.ask, JSON.stringify({ v: 1 }))
  } catch (err) {
    logEvent('watch', `Question à la montre sur sa version impossible : ${describeError(err)}`, 'warn')
  }
}

/** Downloads the APK unless a complete copy is already in the cache. */
async function downloadWatchApk(release: WatchRelease, onProgress: (fraction: number) => void): Promise<File> {
  const dir = folder()
  if (!dir.exists) dir.create({ intermediates: true })
  const name = watchApkName(release.version)
  const cached = new File(dir, name)
  if (cached.exists && cached.size === release.size) return cached
  // Other versions and unfinished downloads only take room.
  for (const entry of dir.list()) {
    try {
      entry.delete()
    } catch {
      // best effort
    }
  }
  // Fetched under a temporary name and renamed once complete, so an interrupted download never passes for a finished one.
  const partial = new File(dir, `${name}.part`)
  const task = File.createDownloadTask(release.url, partial, {
    onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten / (totalBytes || release.size || 1))
  })
  const file = await task.downloadAsync()
  if (!file) throw new Error('Téléchargement interrompu')
  file.rename(name)
  const done = new File(dir, name)
  if (done.size !== release.size) {
    done.delete()
    throw new Error('Fichier téléchargé incomplet, réessayez')
  }
  return done
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function fail(message: string): void {
  useWatchUpdate.setState({ phase: 'error', message })
}

/**
 * Sends the watch the newest version of its app. `reinstall` sends the version it already has (to repair it). The watch
 * is asked to install it, and says how it goes: the store follows (see watchUpdateStore.ts).
 */
export async function updateWatch(options: { reinstall?: boolean } = {}): Promise<void> {
  const store = useWatchUpdate
  if (BUSY_PHASES.includes(store.getState().phase)) return
  if (!updateSupported()) return fail("Cette version de l'application ne sait pas envoyer de mise à jour à la montre.")
  const watch = store.getState().watch
  if (!watch) return fail("La montre ne s'est pas encore fait connaître : ouvrez SelfHost Hub sur la montre, puis réessayez.")
  if (!watchCanReceive(watch.code)) {
    return fail(`L'application installée sur la montre (version ${watch.version}) est trop ancienne pour se mettre à jour toute seule : installez-la une fois avec adb (voir le README).`)
  }

  store.setState({ phase: 'checking', progress: 0, message: null })
  let latest = store.getState().latest
  if (!latest) {
    try {
      latest = await findWatchRelease()
      store.setState({ latest })
    } catch (err) {
      return fail(`Recherche de la nouvelle version impossible : ${describeError(err)}`)
    }
  }
  if (!latest) return fail("La dernière version publiée ne contient pas d'application pour montre.")
  const newer = isNewer(latest.version, watch.version)
  if (!newer && !(options.reinstall && latest.version === watch.version)) {
    store.setState({ phase: 'idle', message: 'La montre est déjà à jour.' })
    return
  }

  const release = latest
  let sending = false
  try {
    logEvent('watch', `Mise à jour de la montre : ${watch.version} vers ${release.version}${options.reinstall ? ' (réinstallation)' : ''}`)
    store.setState({ phase: 'downloading', progress: 0 })
    const file = await downloadWatchApk(release, (fraction) => store.setState({ progress: Math.min(1, fraction) }))

    const bytes = new Uint8Array(await file.arrayBuffer())
    const digest = sha256(bytes)
    if (release.digest && release.digest !== digest) {
      file.delete()
      throw new Error('Le fichier téléchargé est corrompu, réessayez')
    }

    store.setState({ phase: 'sending', progress: 0 })
    sending = true
    const header = buildUpdateHeader({ versionName: release.version, versionCode: release.code, size: bytes.length, sha256: digest, reinstall: options.reinstall === true })
    const progress = SelfHostNative?.addListener?.('onWatchUpdateProgress', ({ sent, total }) => {
      if (total > 0 && useWatchUpdate.getState().phase === 'sending') useWatchUpdate.setState({ progress: Math.min(1, sent / total) })
    })
    try {
      await SelfHostNative!.sendUpdateToWatch!(watch.nodeId, file.uri, header)
    } finally {
      progress?.remove()
    }
    // Handed over. The watch says what it makes of it; a status that came already has moved the phase on.
    if (store.getState().phase === 'sending') store.setState({ phase: 'installing', progress: 1 })
  } catch (err) {
    logEvent('watch', `Envoi de la mise à jour à la montre impossible : ${describeError(err)}`, 'warn')
    // If the watch refused and closed the channel, its reason is on its way: it says more than "channel closed".
    if (sending) await sleep(REASON_WAIT_MS)
    if (store.getState().phase !== 'error') fail(err instanceof Error && err.message ? err.message : "L'envoi à la montre a échoué")
  }
}

/** Closes the message about an update (a failure, or one that finished). */
export function dismissWatchUpdate(): void {
  useWatchUpdate.setState({ phase: 'idle', message: null, progress: 0 })
}
