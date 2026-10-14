import { AppState } from 'react-native'
import * as Network from 'expo-network'
import { useDowntifyStore } from '@/store/downtifyStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useRemoteStore } from '@/store/remoteStore'

/**
 * Services whose saved login could not reach their server (the phone offline at launch, the server asleep) are tried
 * again on their own: as soon as the phone is back on a network, and every half minute while the app is on screen.
 * Before, only leaving the app for a while and coming back did it, and the screens meanwhile looked logged out.
 */

const RETRY_EVERY_MS = 30_000
/** Network changes come in bursts (Wi-Fi drops, mobile data takes over): one try for the lot. */
const MIN_GAP_MS = 5_000

let lastTry = 0
let started = false

/** Tries again whatever is down. `withPc`: the PC as well, which means looking for it on the network. */
export function retryDownServices(withPc = false): void {
  const now = Date.now()
  if (now - lastTry < MIN_GAP_MS) return
  lastTry = now
  const navidrome = useNavidromeStore.getState()
  if (navidrome.status === 'error' && navidrome.savedSession) void navidrome.restoreSession()
  const filebrowser = useFileBrowserStore.getState()
  if (filebrowser.status === 'error' && filebrowser.savedSession) void filebrowser.restoreSession()
  const downtify = useDowntifyStore.getState()
  if (downtify.status === 'error') void downtify.restoreSession()
  if (withPc) {
    const remote = useRemoteStore.getState()
    if (remote.enabled && remote.pairing && (remote.status === 'disconnected' || remote.status === 'error')) {
      remote.autoConnect().catch(() => {})
    }
  }
}

export function startReconnect(): void {
  if (started) return
  started = true
  Network.addNetworkStateListener((state) => {
    if (state.isConnected) retryDownServices(true)
  })
  // The PC is not looked for here: finding it means probing the whole home network, not worth doing twice a minute.
  setInterval(() => {
    if (AppState.currentState === 'active') retryDownServices()
  }, RETRY_EVERY_MS)
}
