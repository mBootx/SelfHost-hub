import * as Network from 'expo-network'
import { NavidromeClient, NDSong } from '@/services/navidrome'
import { useNavidromeStore } from '@/store/navidromeStore'
import { selectEvictions, useOfflineStore } from '@/store/offlineStore'

export { selectEvictions }

/**
 * Picks up to `count` distinct upcoming songs starting at `currentIndex + 1`
 * that are not already in `alreadyOfflineIds`.
 */
export function pickQueueToPreCache<T extends { id: string }>(
  queue: readonly T[],
  currentIndex: number,
  count: number,
  alreadyOfflineIds: ReadonlySet<string>
): T[] {
  if (count <= 0 || queue.length === 0) return []
  const start = Math.max(0, currentIndex + 1)
  const picked: T[] = []
  const seen = new Set<string>()
  for (let i = start; i < queue.length && picked.length < count; i++) {
    const song = queue[i]
    if (!song || alreadyOfflineIds.has(song.id) || seen.has(song.id)) continue
    seen.add(song.id)
    picked.push(song)
  }
  return picked
}

/** Whether the phone is on an unmetered network (Wi-Fi or Ethernet). */
async function isWifi(): Promise<boolean> {
  const state = await Network.getNetworkStateAsync().catch(() => null)
  return state?.type === Network.NetworkStateType.WIFI || state?.type === Network.NetworkStateType.ETHERNET
}

/**
 * Quietly pre-caches upcoming queue songs on Wi-Fi when `preCacheCount > 0`,
 * then enforces `maxCacheMb` via LRU eviction.
 */
export async function preCacheUpcoming(queue: NDSong[], currentIndex: number, client: NavidromeClient | null): Promise<void> {
  if (!client || queue.length === 0) return
  if (useOfflineStore.getState().preCacheCount <= 0) return
  if (!(await isWifi())) return

  const state = useOfflineStore.getState()
  if (state.preCacheCount <= 0) return

  const alreadyOfflineIds = new Set<string>([
    ...Object.keys(state.tracks),
    ...Object.keys(state.downloading)
  ])
  const songs = pickQueueToPreCache(queue, currentIndex, state.preCacheCount, alreadyOfflineIds)
  if (songs.length === 0) return

  await state.downloadAutoTracks(songs, client)
  const currentId = queue[currentIndex]?.id
  await useOfflineStore.getState().evictIfNeeded(currentId ? new Set([currentId]) : undefined)
}

let started = false

/** Subscribes to playback changes to update LRU timestamps and pre-cache upcoming queue songs on Wi-Fi. */
export function startPreCache(): void {
  if (started) return
  started = true
  useNavidromeStore.subscribe((state, prev) => {
    if (!state.isPlaying) return
    const song = state.queue[state.queueIndex]
    if (!song) return
    const prevSong = prev.queue[prev.queueIndex]
    const trackChanged = song.id !== prevSong?.id || state.queueIndex !== prev.queueIndex || !prev.isPlaying
    const queueChanged = state.queue !== prev.queue
    if (trackChanged) useOfflineStore.getState().touchPlayed(song.id)
    if (trackChanged || queueChanged) void preCacheUpcoming(state.queue, state.queueIndex, state.client)
  })
}
