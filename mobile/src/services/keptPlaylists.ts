import { AppState } from 'react-native'
import * as Network from 'expo-network'
import { describeError, logEvent } from '@/services/diagnostics'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'

/**
 * Playlists kept on the phone: a song added to one later (on the PC, the phone, the web page) is downloaded on its own
 * when Navidrome connects or the app comes back to the screen, on Wi-Fi only (songs can be big for a mobile plan), at
 * most every half hour. Opening a kept playlist fetches what it is missing at once, whatever the network.
 */

const MIN_GAP_MS = 30 * 60_000

let lastRun = 0
let running = false
let started = false

/** Whether the phone is on a network that costs nothing per byte. */
async function unmetered(): Promise<boolean> {
  const state = await Network.getNetworkStateAsync().catch(() => null)
  return state?.type === Network.NetworkStateType.WIFI || state?.type === Network.NetworkStateType.ETHERNET
}

/** Downloads the songs the kept playlists don't have on the phone yet. `force`: now, on any network. */
export async function syncKeptPlaylists(force = false): Promise<void> {
  const { client, status } = useNavidromeStore.getState()
  const kept = useOfflineStore.getState().keptPlaylists
  if (!client || status !== 'connected' || running || Object.keys(kept).length === 0) return
  if (!force && (Date.now() - lastRun < MIN_GAP_MS || !(await unmetered()))) return
  running = true
  lastRun = Date.now()
  try {
    for (const [id, name] of Object.entries(kept)) {
      try {
        const { playlist, songs } = await client.getPlaylist(id)
        await useOfflineStore.getState().downloadTracks(songs, client, { quiet: true, label: playlist?.name || name })
      } catch (err) {
        // A playlist deleted since (Subsonic error 70) is not kept any more.
        if ((err as { code?: number } | null)?.code === 70) useOfflineStore.getState().setKeptPlaylist(id, name, false)
        logEvent('music', `Playlist gardée « ${name} » : ${describeError(err)}`, 'warn')
      }
    }
  } finally {
    running = false
  }
}

export function startKeptPlaylists(): void {
  if (started) return
  started = true
  useNavidromeStore.subscribe((state, prev) => {
    if (state.status === 'connected' && prev.status !== 'connected') void syncKeptPlaylists()
  })
  AppState.addEventListener('change', (next) => {
    if (next === 'active') void syncKeptPlaylists()
  })
}
