import * as Network from 'expo-network'
import { create } from 'zustand'
import { logEvent } from '@/services/diagnostics'
import { NetworkMonitor, NetworkQuality, nextLocalIndex, prioritizeLocal } from '@/services/offlinePriority'
import { useAudioSettingsStore } from '@/store/audioSettingsStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useToastStore } from '@/store/toastStore'

/**
 * Downloaded songs first when the network is bad. The verdict comes from services/offlinePriority.ts (stalls of the song
 * streaming, pings to the server, what the phone says about its connection); when it is "slow" or "offline" and the
 * setting is on, what is still to come in the queue is reordered so the songs on the phone come first, and with no
 * network at all a song that can't be streamed gives way to the next one on the phone. Streams also drop to a lower
 * bitrate while the network is slow (PlaybackController reads `quality`).
 */

interface NetworkState {
  quality: NetworkQuality
  reason: string
}

export const useNetworkStore = create<NetworkState>(() => ({ quality: 'good', reason: 'ok' }))

/** While the network is not good, the server is pinged this often to see whether it got better (or worse). */
const PROBE_EVERY_MS = 30_000
const PING_TIMEOUT_MS = 6_000

const monitor = new NetworkMonitor()
let started = false
let probing = false
let probeTimer: ReturnType<typeof setInterval> | null = null
/** The queue and song a "nothing on the phone" pause was made for, so it is said once, not at every check. */
let lastStuck = ''

/** The song playing (when it is streamed, not on the phone) started or stopped waiting for data. */
export function noteStall(buffering: boolean): void {
  monitor.noteBuffering(buffering)
  if (buffering) void probe()
  evaluate()
}

async function probe(): Promise<void> {
  const client = useNavidromeStore.getState().client
  if (!client || probing) return
  probing = true
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PING_TIMEOUT_MS))
    const { latencyMs } = await Promise.race([client.ping(), timeout])
    monitor.notePing(latencyMs)
  } catch {
    monitor.notePing(null)
  } finally {
    probing = false
  }
  evaluate()
}

function onConnectivity(state: { isConnected?: boolean | null; isInternetReachable?: boolean | null }): void {
  monitor.noteConnectivity(state.isConnected !== false, state.isInternetReachable ?? null)
  // Back on a network, or on one Android doubts reaches the internet: ask the server itself.
  if (state.isConnected !== false) void probe()
  evaluate()
}

function evaluate(): void {
  const { quality, reason } = monitor.snapshot()
  const before = useNetworkStore.getState().quality
  if (quality !== before) {
    useNetworkStore.setState({ quality, reason })
    logEvent('connection', `Réseau : ${quality} (${reason})`, quality === 'good' ? 'info' : 'warn')
    const first = useAudioSettingsStore.getState().offlineFirst
    const toast = useToastStore.getState().show
    if (quality === 'offline') toast(first ? 'Hors connexion : lecture des titres téléchargés' : 'Hors connexion')
    else if (quality === 'slow') toast(first ? 'Réseau lent : les titres téléchargés passent en premier' : 'Réseau lent')
    else toast('Connexion rétablie')
    lastStuck = ''
  } else if (reason !== useNetworkStore.getState().reason) {
    useNetworkStore.setState({ reason })
  }
  // While it is bad the server is asked now and then, which is also how it is found to be good again.
  if (quality !== 'good' && !probeTimer) probeTimer = setInterval(() => void probe(), PROBE_EVERY_MS)
  if (quality === 'good' && probeTimer) {
    clearInterval(probeTimer)
    probeTimer = null
  }
  react()
}

/** Puts the queue in order for the network there is. Safe to call at any time: it changes nothing when nothing needs to. */
function react(): void {
  const quality = useNetworkStore.getState().quality
  if (quality === 'good' || !useAudioSettingsStore.getState().offlineFirst) return
  const player = useNavidromeStore.getState()
  if (player.queue.length === 0) return
  const offline = useOfflineStore.getState()
  const isLocal = (id: string): boolean => offline.isOffline(id)

  const queue = prioritizeLocal(player.queue, player.queueIndex, isLocal)
  if (queue !== player.queue) useNavidromeStore.setState({ queue })

  if (quality !== 'offline') return
  const current = queue[player.queueIndex]
  if (!current || isLocal(current.id)) return
  const target = nextLocalIndex(queue, player.queueIndex, isLocal, player.repeatMode === 'all')
  if (target >= 0) {
    useNavidromeStore.setState({ queueIndex: target, currentTime: 0 })
    return
  }
  // Nothing on the phone to go to: stopping beats a player stuck trying to stream.
  const stuck = `${current.id}@${player.queueIndex}`
  if (player.isPlaying) useNavidromeStore.setState({ isPlaying: false })
  if (stuck !== lastStuck) {
    lastStuck = stuck
    useToastStore.getState().show('Hors connexion : aucun titre téléchargé dans la file')
  }
}

export function startOfflineMode(): void {
  if (started) return
  started = true
  Network.getNetworkStateAsync().then(onConnectivity).catch(() => {})
  Network.addNetworkStateListener(onConnectivity)
  // A new queue, another song, a download that finished or the setting switched on: the order is looked at again.
  useNavidromeStore.subscribe((state, prev) => {
    if (state.queue !== prev.queue || state.queueIndex !== prev.queueIndex) react()
  })
  useOfflineStore.subscribe((state, prev) => {
    if (state.tracks !== prev.tracks) react()
  })
  useAudioSettingsStore.subscribe((state, prev) => {
    if (state.offlineFirst !== prev.offlineFirst) react()
  })
}
