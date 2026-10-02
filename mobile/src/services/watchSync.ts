import SelfHostNative, { WatchInfo, WatchOutcome } from '../../modules/selfhost-native'
import { describeError, logEvent } from '@/services/diagnostics'
import { useNavidromeStore } from '@/store/navidromeStore'

/**
 * The "Montre" setting: gives a Wear OS watch the Navidrome login, so that it can show the library without anyone
 * typing a server address or a password on a watch.
 *
 * What goes over is the Navidrome address and user with a salt and the token made from the password and that salt (the
 * password itself never leaves this phone). It travels over the Wear OS data layer, the phone and watch's own
 * encrypted link, to the watch app only (same package, same signing key). Nothing about the PC goes to the watch: the
 * watch talks to this phone and to Navidrome, never to the PC (see services/watchLink.ts for the live link). The
 * format is read by wear/core/.../WatchSetup.kt; tests/watchsync.test.js and wear's SetupCodec tests both check
 * against one shared sample file, so the two cannot drift apart unnoticed.
 */

export interface SetupSources {
  navidrome: { url: string; username: string; salt: string; token: string } | null
}

/** Twelve random hex characters. The salt is not a secret: it only has to differ from one setup to the next. */
export function newSalt(random: () => number = Math.random): string {
  let salt = ''
  for (let i = 0; i < 12; i++) salt += Math.floor(random() * 16).toString(16)
  return salt
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * The message the watch reads, or null when there is nothing to tell it. A login that is not complete (no token, no
 * user) is not sent half empty, which the watch would refuse as a whole.
 */
export function buildWatchSetup(sources: SetupSources): string | null {
  const login = sources.navidrome
  if (!login || ![login.url, login.username, login.salt, login.token].every(isText)) return null
  return JSON.stringify({ v: 1, navidrome: { url: login.url, username: login.username, salt: login.salt, token: login.token } })
}

/** What this phone knows right now: the signed-in Navidrome, if any. */
export function readSetupSources(): SetupSources {
  const client = useNavidromeStore.getState().client
  return { navidrome: client ? client.sharedLogin(newSalt()) : null }
}

/** The watches connected to this phone. Throws with a sentence when they cannot be listed. */
export async function listWatches(): Promise<WatchInfo[]> {
  if (!SelfHostNative?.getWatches) return []
  return SelfHostNative.getWatches()
}

export function watchSupported(): boolean {
  return !!SelfHostNative?.getWatches && !!SelfHostNative?.sendSetupToWatch
}

export type WatchSendResult =
  | { status: 'unsupported' }
  | { status: 'nothing-to-send' }
  | { status: 'no-watch' }
  | { status: 'sent'; outcomes: WatchOutcome[] }
  | { status: 'error'; message: string }

/** Sends the setup to every connected watch that has the app, and says how each took it. */
export async function sendSetupToWatches(): Promise<WatchSendResult> {
  if (!watchSupported()) return { status: 'unsupported' }
  const json = buildWatchSetup(readSetupSources())
  if (!json) return { status: 'nothing-to-send' }
  try {
    const outcomes = await SelfHostNative!.sendSetupToWatch!(json)
    if (outcomes.length === 0) {
      logEvent('watch', 'Aucune montre avec l’application SelfHost Hub', 'warn')
      return { status: 'no-watch' }
    }
    for (const outcome of outcomes) {
      logEvent('watch', outcome.ok ? `Montre configurée : ${outcome.name}` : `Montre ${outcome.name} : ${outcome.error ?? 'refusé'}`, outcome.ok ? 'info' : 'warn')
    }
    return { status: 'sent', outcomes }
  } catch (err) {
    logEvent('watch', `Envoi à la montre impossible : ${describeError(err)}`, 'warn')
    return { status: 'error', message: err instanceof Error ? err.message : 'Envoi impossible' }
  }
}
