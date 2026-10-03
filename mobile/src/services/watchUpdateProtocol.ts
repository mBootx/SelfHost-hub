/**
 * Updating the watch app from this phone, over the Wear OS data layer (the phone and watch's own encrypted link,
 * delivered only to the app of the same package signed with the same key):
 *
 * - this phone downloads the watch APK from the GitHub release and opens a channel to the watch on UPDATE_PATHS.apk;
 *   what it writes there is one line of JSON (the header: version, size, SHA-256) and then the APK itself;
 * - the watch checks the header, keeps the bytes, checks them against the header and against the APK's own manifest and
 *   signature, and hands the file to Android's package installer;
 * - the watch tells this phone how it goes, in messages on UPDATE_PATHS.status; this phone can also ask it which version
 *   it is (UPDATE_PATHS.ask), and the watch says which one it is in every request for the state (see watchLink.ts).
 *
 * Everything read here comes off a radio link, so it is checked. The watch's side is wear/core/.../UpdateProtocol.kt;
 * tests/watchupdate.test.js and wear's UpdateProtocolTest read the same sample files in wear/core/src/test/resources.
 */

import { isNewer } from './updateAsset'

export const UPDATE_VERSION = 1
export const UPDATE_PREFIX = '/selfhost/update'
export const UPDATE_PATHS = {
  apk: '/selfhost/update/apk',
  status: '/selfhost/update/status',
  ask: '/selfhost/update/ask'
} as const

/** The first version of the watch app that can receive an update (the one that has this protocol). */
export const FIRST_UPDATABLE_CODE = 20502

/** Whether the watch app that is installed knows how to receive an update. */
export function watchCanReceive(code: number): boolean {
  return code >= FIRST_UPDATABLE_CODE
}

/** The version of the watch app, as the watch says it. */
export interface WatchAppVersion {
  name: string
  code: number
}

const VERSION_NAME = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

/** The number Android knows a version by, as the repository computes it (wear/app/build.gradle.kts): major * 10000 + minor * 100 + patch. */
export function versionCodeOf(version: string): number | null {
  if (!VERSION_NAME.test(version)) return null
  const [major, minor, patch] = version.split('.').map(Number)
  return major * 10000 + minor * 100 + patch
}

function readAppVersion(value: unknown): WatchAppVersion | null {
  if (!value || typeof value !== 'object') return null
  const { name, code } = value as { name?: unknown; code?: unknown }
  if (typeof name !== 'string' || !VERSION_NAME.test(name)) return null
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 1 || code > 2_000_000_000) return null
  return { name, code }
}

/** The version of the watch app that a request for the state carries; null when it says none (an older watch app, or garbage). */
export function parseWatchRequest(json: string): WatchAppVersion | null {
  if (typeof json !== 'string' || json.length > 4096) return null
  try {
    const message = JSON.parse(json)
    return message && typeof message === 'object' ? readAppVersion(message.app) : null
  } catch {
    return null
  }
}

export interface UpdateHeaderInput {
  versionName: string
  versionCode: number
  size: number
  sha256: string
  reinstall?: boolean
}

/** The line that opens the stream to the watch. The watch refuses anything that is not exactly this. */
export function buildUpdateHeader(input: UpdateHeaderInput): string {
  return JSON.stringify({
    v: UPDATE_VERSION,
    versionName: input.versionName,
    versionCode: input.versionCode,
    size: input.size,
    sha256: input.sha256,
    reinstall: input.reinstall === true
  })
}

export type UpdateState = 'received' | 'confirm' | 'installed' | 'version' | 'refused' | 'failed'
export type UpdateRefusal = 'up-to-date' | 'not-allowed' | 'no-space' | 'bad-header' | 'busy'

const STATES: readonly string[] = ['received', 'confirm', 'installed', 'version', 'refused', 'failed']
const REFUSALS: readonly string[] = ['up-to-date', 'not-allowed', 'no-space', 'bad-header', 'busy']

/** What the watch says about an update. */
export interface WatchUpdateStatus {
  state: UpdateState
  versionName?: string
  versionCode?: number
  reason?: UpdateRefusal
  message?: string
}

/** A message from the watch on UPDATE_PATHS.status, or null when it is anything else. */
export function parseUpdateStatus(json: string): WatchUpdateStatus | null {
  if (typeof json !== 'string' || json.length > 4096) return null
  let message: any
  try {
    message = JSON.parse(json)
  } catch {
    return null
  }
  if (!message || typeof message !== 'object' || message.v !== UPDATE_VERSION) return null
  if (typeof message.state !== 'string' || !STATES.includes(message.state)) return null
  const status: WatchUpdateStatus = { state: message.state as UpdateState }
  if (typeof message.versionName === 'string' && VERSION_NAME.test(message.versionName)) status.versionName = message.versionName
  if (typeof message.versionCode === 'number' && Number.isInteger(message.versionCode) && message.versionCode > 0) status.versionCode = message.versionCode
  if (typeof message.reason === 'string' && REFUSALS.includes(message.reason)) status.reason = message.reason as UpdateRefusal
  if (typeof message.message === 'string' && message.message.length > 0) status.message = message.message.slice(0, 300)
  return status
}

/** Where an update is: what the Montre setting shows while it goes, and when it may be started again. */
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'sending' | 'installing' | 'confirm' | 'done' | 'error'

/** What the screen says while an update is under way; null when none is. */
export function describePhase(phase: UpdatePhase, progress: number): string | null {
  const percent = `${Math.round(progress * 100)} %`
  switch (phase) {
    case 'checking':
      return 'Préparation…'
    case 'downloading':
      return `Téléchargement de la mise à jour… ${percent}`
    case 'sending':
      return `Envoi à la montre… ${percent}`
    case 'installing':
      return 'La montre installe la mise à jour…'
    case 'confirm':
      return 'En attente de votre confirmation sur la montre…'
    default:
      return null
  }
}

/** What the Montre setting says about the watch app's version, and which buttons it offers. */
export interface WatchAppView {
  text: string
  /** A newer version is out and this watch app can receive it. */
  canUpdate: boolean
  /** The watch has the latest version: sending it again (to repair it) is still possible. */
  canReinstall: boolean
  /** The watch app is too old to receive an update: it has to be installed once by hand. */
  tooOld: boolean
}

export function describeWatchApp(watch: { version: string; code: number } | null, latest: { version: string } | null): WatchAppView {
  if (!watch) {
    return { text: "Version de l'application de la montre inconnue : ouvrez SelfHost Hub sur la montre.", canUpdate: false, canReinstall: false, tooOld: false }
  }
  const newest = latest ? ` La dernière version publiée est la ${latest.version}.` : ''
  if (!watchCanReceive(watch.code)) {
    return {
      text: `Application de la montre : version ${watch.version}. Elle ne sait pas se mettre à jour toute seule : installez-la une fois avec adb (voir le README).${newest}`,
      canUpdate: false,
      canReinstall: false,
      tooOld: true
    }
  }
  if (latest && isNewer(latest.version, watch.version)) {
    return { text: `Application de la montre : version ${watch.version}. La version ${latest.version} est disponible.`, canUpdate: true, canReinstall: false, tooOld: false }
  }
  return {
    text: `Application de la montre : version ${watch.version}${latest ? ', à jour' : ''}.`,
    canUpdate: false,
    canReinstall: !!latest && latest.version === watch.version,
    tooOld: false
  }
}

/** What the screen says when the watch refuses an update, in the user's terms. */
export function describeRefusal(reason: UpdateRefusal | undefined, message: string | undefined): string {
  switch (reason) {
    case 'up-to-date':
      return 'La montre a déjà cette version.'
    case 'not-allowed':
      return "La montre n'autorise pas l'application à installer des mises à jour. Autorisez-la une fois depuis un ordinateur : adb shell cmd appops set com.selfhosthub.mobile REQUEST_INSTALL_PACKAGES allow"
    case 'no-space':
      return "Il n'y a pas assez de place sur la montre."
    case 'busy':
      return 'Une mise à jour est déjà en cours sur la montre.'
    default:
      return message || 'La montre a refusé la mise à jour.'
  }
}
