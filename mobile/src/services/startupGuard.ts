import { File, Paths } from 'expo-file-system'
import * as SplashScreen from 'expo-splash-screen'
import { logEvent } from '@/services/diagnostics'

/**
 * Startup, watched. Two things went wrong rarely and silently: the logo staying up (React's one-time "content
 * appeared" signal missed when the process was already alive without a screen) and nothing telling why afterwards.
 *
 * - `hideSplash` takes the logo down as soon as the first screen is mounted, and again whenever the app comes back to
 *   the foreground, instead of trusting that signal alone (the native side also has a timer, see SplashSafety.kt).
 * - A marker file is written when a launch starts and removed once the app has stayed up a few seconds. One found at the
 *   next launch means the previous start never finished: it is written in the diagnostics journal, with how long that
 *   launch had lasted, so the next time it happens there is something to read in Réglages → Diagnostic.
 */
const marker = new File(Paths.document, 'startup-pending.json')
const STABLE_AFTER_MS = 4_000

let started = Date.now()

/** Call as early as possible (module load of the root layout). */
export function markStarting(): void {
  started = Date.now()
  try {
    if (marker.exists) {
      const previous = JSON.parse(marker.textSync()) as { at?: number }
      const seconds = previous.at ? Math.round((started - previous.at) / 1000) : null
      logEvent('app', `Le démarrage précédent ne s'est pas terminé${seconds !== null ? ` (lancé ${seconds} s plus tôt)` : ''} : le logo est peut-être resté affiché.`, 'warn')
    } else {
      marker.create()
    }
    marker.write(JSON.stringify({ at: started }))
  } catch {
    // The guard is a convenience: starting must never fail over it.
  }
}

export function hideSplash(): void {
  try {
    SplashScreen.hide()
  } catch {
    // Already hidden, or no splash in this build.
  }
}

/** Call once the first screen is mounted: hides the logo, then records that the start went through. */
export function markStarted(): void {
  hideSplash()
  const took = Date.now() - started
  setTimeout(() => {
    try {
      if (marker.exists) marker.delete()
    } catch {
      // Left behind: the next launch will report a start that did in fact finish, which is only noise.
    }
    if (took > 15_000) logEvent('app', `Démarrage lent : ${Math.round(took / 1000)} s avant le premier écran.`, 'warn')
  }, STABLE_AFTER_MS)
}
