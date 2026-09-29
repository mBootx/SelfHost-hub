import * as Application from 'expo-application'
import { startActivityAsync } from 'expo-intent-launcher'
import { Directory, File, Paths } from 'expo-file-system'
import { fetchWithTimeout } from './http'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/mBootx/SelfHost-hub/releases/latest'
const FLAG_GRANT_READ_URI_PERMISSION = 1
const updatesDir = new Directory(Paths.cache, 'updates')
const COMPLETE_APK = /^SelfHost-Hub-(.+)\.apk$/

export interface AvailableUpdate {
  version: string
  apkUrl: string
  sizeBytes: number
}

function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
}

function isNewer(candidate: string, current: string): boolean {
  const a = versionParts(candidate)
  const b = versionParts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

function apkName(version: string): string {
  return `SelfHost-Hub-${version}.apk`
}

/** The versionName of the APK actually installed, not app.json's, so the two can never disagree. */
export function installedVersion(): string {
  return Application.nativeApplicationVersion ?? '0.0.0'
}

/** The latest GitHub release, if it is newer than this install and ships an APK. */
export async function findUpdate(): Promise<AvailableUpdate | null> {
  const res = await fetchWithTimeout(LATEST_RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub a repondu ${res.status}`)
  const release = await res.json()
  const version = String(release.tag_name ?? '').replace(/^v/i, '')
  const apk = (release.assets ?? []).find((a: { name: string }) => a.name.endsWith('.apk'))
  if (!version || !apk || !isNewer(version, installedVersion())) return null
  return { version, apkUrl: apk.browser_download_url, sizeBytes: apk.size }
}

/** True once this release's APK sits complete in the cache, so a retry can skip the download. */
export function isDownloaded(update: AvailableUpdate): boolean {
  const apk = new File(updatesDir, apkName(update.version))
  return apk.exists && apk.size === update.sizeBytes
}

/** Deletes unfinished downloads, plus every complete APK whose version `keep` rejects. */
function pruneDownloads(keep: (version: string) => boolean): void {
  try {
    if (!updatesDir.exists) return
    for (const entry of updatesDir.list()) {
      const version = COMPLETE_APK.exec(entry.name)?.[1]
      if (!version || !keep(version)) entry.delete()
    }
  } catch {
    // Best-effort: leftovers only cost cache space, which Android reclaims on its own.
  }
}

/** At launch: an APK no newer than the installed app was installed or superseded; a newer one is kept for a retry. */
export function pruneStaleDownloads(): void {
  pruneDownloads((version) => isNewer(version, installedVersion()))
}

/** Downloads the APK unless a complete copy is already cached. */
export async function downloadUpdate(update: AvailableUpdate, onProgress: (fraction: number) => void): Promise<void> {
  if (isDownloaded(update)) return
  pruneDownloads(() => false)
  if (!updatesDir.exists) updatesDir.create({ intermediates: true })
  // Fetched under a temporary name and renamed once complete, so an interrupted download never passes for a finished one.
  const partial = new File(updatesDir, `${apkName(update.version)}.part`)
  const task = File.createDownloadTask(update.apkUrl, partial, {
    onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten / (totalBytes || update.sizeBytes || 1))
  })
  const file = await task.downloadAsync()
  if (!file) throw new Error('Telechargement interrompu')
  file.rename(apkName(update.version))
  if (!isDownloaded(update)) throw new Error('Fichier telecharge incomplet, reessayez')
}

/** Opens Android's installer on the downloaded APK; the user confirms the update there. */
export async function openInstaller(update: AvailableUpdate): Promise<void> {
  await startActivityAsync('android.intent.action.VIEW', {
    data: new File(updatesDir, apkName(update.version)).contentUri,
    type: 'application/vnd.android.package-archive',
    flags: FLAG_GRANT_READ_URI_PERMISSION
  })
}
