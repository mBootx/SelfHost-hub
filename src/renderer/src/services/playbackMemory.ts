import { NDSong } from '@renderer/services/navidrome'
import { RepeatMode, useNavidromeStore } from '@renderer/store/navidromeStore'

/**
 * Remembers the queue and the playhead across restarts: reopening the app puts the same queue back,
 * paused on the same track at the same second. Kept in localStorage rather than the settings file
 * because it is synchronous, so the final position can still be written while the window closes.
 */
const QUEUE_KEY = 'shub.playback.queue'
const POSITION_KEY = 'shub.playback.position'
/** While the playhead moves it is written at most this often; pausing, skipping and closing write at once. */
const POSITION_WRITE_MS = 1000
/** A track left in its last seconds resumes from the top, rather than ending the moment you press play. */
const END_MARGIN_S = 2

interface SavedQueue {
  queue: NDSong[]
  orderedQueue: NDSong[] | null
  queueIndex: number
  shuffle: boolean
  repeatMode: RepeatMode
}

interface SavedPosition {
  songId: string
  seconds: number
}

let resume: SavedPosition | null = null
let started = false

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full: resuming is a convenience, playback must not fail over it.
  }
}

function restore(): void {
  const saved = read<SavedQueue>(QUEUE_KEY)
  const song = saved?.queue?.[saved.queueIndex]
  if (!saved || !song) return
  const position = read<SavedPosition>(POSITION_KEY)
  let seconds = position?.songId === song.id ? position.seconds : 0
  if (!(seconds > 0) || (song.duration > 0 && seconds > song.duration - END_MARGIN_S)) seconds = 0
  resume = { songId: song.id, seconds }
  useNavidromeStore.setState({
    queue: saved.queue,
    orderedQueue: saved.orderedQueue ?? null,
    queueIndex: saved.queueIndex,
    shuffle: !!saved.shuffle,
    repeatMode: saved.repeatMode ?? 'off',
    isPlaying: false,
    currentTime: seconds,
    duration: song.duration
  })
}

/**
 * Puts the last session's queue back, paused where it stopped, then keeps saving it.
 * Call at startup, before the player mounts.
 */
export function startPlaybackMemory(): void {
  if (started) return
  started = true
  restore()

  let positionTimer: ReturnType<typeof setTimeout> | null = null
  const writePosition = (): void => {
    if (positionTimer) clearTimeout(positionTimer)
    positionTimer = null
    const { queue, queueIndex, currentTime } = useNavidromeStore.getState()
    const song = queue[queueIndex]
    if (!song) return
    const position: SavedPosition = { songId: song.id, seconds: currentTime }
    write(POSITION_KEY, position)
  }

  useNavidromeStore.subscribe((s, prev) => {
    if (
      s.queue !== prev.queue ||
      s.orderedQueue !== prev.orderedQueue ||
      s.queueIndex !== prev.queueIndex ||
      s.shuffle !== prev.shuffle ||
      s.repeatMode !== prev.repeatMode
    ) {
      const saved: SavedQueue = {
        queue: s.queue,
        orderedQueue: s.orderedQueue,
        queueIndex: s.queueIndex,
        shuffle: s.shuffle,
        repeatMode: s.repeatMode
      }
      write(QUEUE_KEY, saved)
    }
    const songChanged = s.queue[s.queueIndex]?.id !== prev.queue[prev.queueIndex]?.id
    // Once something else plays, the restored position has served its purpose.
    if (songChanged || s.isPlaying) resume = null
    if (songChanged || s.isPlaying !== prev.isPlaying) writePosition()
    else if (s.currentTime !== prev.currentTime && !positionTimer) positionTimer = setTimeout(writePosition, POSITION_WRITE_MS)
  })
  window.addEventListener('beforeunload', writePosition)
}

/** Where to start `songId` if it is the track restored from the last session and hasn't played yet, else null. */
export function resumePosition(songId: string): number | null {
  return resume?.songId === songId ? resume.seconds : null
}
