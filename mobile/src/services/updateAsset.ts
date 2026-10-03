export const LATEST_RELEASE_URL = 'https://api.github.com/repos/mBootx/SelfHost-hub/releases/latest'
export const RELEASES_PAGE_URL = 'https://github.com/mBootx/SelfHost-hub/releases/latest'

function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
}

/** Whether `candidate` is a later version than `current` (both "major.minor.patch", a leading "v" allowed). */
export function isNewer(candidate: string, current: string): boolean {
  const a = versionParts(candidate)
  const b = versionParts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** The name a release gives the phone's APK. */
export function phoneApkName(version: string): string {
  return `SelfHost-Hub-${version}.apk`
}

/** The name a release gives the watch app's APK. */
export function watchApkName(version: string): string {
  return `SelfHost-Hub-Watch-${version}.apk`
}

/**
 * The phone's own APK among a release's files. A release also carries the watch app's APK (SelfHost-Hub-Watch-X.apk),
 * which must never be installed on a phone: the one named for this version comes first, then any other APK that is
 * not a watch's. Versions before 2.5.0 took the first APK of the list, which is why the phone's is uploaded first.
 */
export function pickPhoneApk<T extends { name: string }>(assets: T[], version: string): T | undefined {
  const named = assets.find((a) => a.name === phoneApkName(version))
  if (named) return named
  return assets.find((a) => a.name.endsWith('.apk') && !/watch|wear/i.test(a.name))
}

/** The watch app's APK among a release's files: only the one named for the version, never a phone's. */
export function pickWatchApk<T extends { name: string }>(assets: T[], version: string): T | undefined {
  return assets.find((a) => a.name === watchApkName(version))
}
