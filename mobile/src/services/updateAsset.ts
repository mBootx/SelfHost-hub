/** The name a release gives the phone's APK. */
export function phoneApkName(version: string): string {
  return `SelfHost-Hub-${version}.apk`
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
