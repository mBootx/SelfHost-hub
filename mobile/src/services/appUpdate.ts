import * as Application from 'expo-application'
import { startActivityAsync } from 'expo-intent-launcher'
import { Directory, File, Paths } from 'expo-file-system'
import { fetchWithTimeout } from './http'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/mBootx/SelfHost-hub/releases/latest'
const FLAG_GRANT_READ_URI_PERMISSION = 1
const updatesDir = new Directory(Paths.cache, 'updates')

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

export function clearDownloadedUpdates(): void {
  try {
    if (updatesDir.exists) updatesDir.delete()
  } catch {
    // Best-effort: a leftover APK in the cache is harmless and Android reclaims cache space itself.
  }
}

/** Downloads the APK, then opens Android's installer on it - the user confirms the update there. */
export async function downloadAndInstall(update: AvailableUpdate, onProgress: (fraction: number) => void): Promise<void> {
  clearDownloadedUpdates()
  if (!updatesDir.exists) updatesDir.create({ intermediates: true })
  const destination = new File(updatesDir, `SelfHost-Hub-${update.version}.apk`)
  const task = File.createDownloadTask(update.apkUrl, destination, {
    onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten / (totalBytes || update.sizeBytes || 1))
  })
  const file = await task.downloadAsync()
  if (!file) throw new Error('Telechargement interrompu')
  await startActivityAsync('android.intent.action.VIEW', {
    data: file.contentUri,
    type: 'application/vnd.android.package-archive',
    flags: FLAG_GRANT_READ_URI_PERMISSION
  })
}
