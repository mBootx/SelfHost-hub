import type { QueueItem } from '@/services/downtify'
import { scanLibrary } from '@/services/libraryScan'
import { useDowntifyStore } from '@/store/downtifyStore'
import { useToastStore } from '@/store/toastStore'

/**
 * Makes songs downloaded with Downtify show up in the library right away: when a download finishes,
 * Navidrome is asked to scan for new files, and the library reloads once the scan is done. Downloads
 * finishing together (a whole album) share one scan.
 */
const SETTLE_MS = 4000

let started = false
let timer: ReturnType<typeof setTimeout> | null = null
/** Downloads already seen finished; null until the first queue arrives. */
let finished: Set<string> | null = null

function key(item: QueueItem): string {
  return item.song.url || item.song.song_id || item.filename || item.song.name
}

async function scanForNewSongs(): Promise<void> {
  try {
    await scanLibrary()
  } catch {
    // Not an admin account, or Navidrome unreachable: its own scheduled scan will pick them up.
    return
  }
  useToastStore.getState().show('Nouveaux titres ajoutés à la bibliothèque')
}

export function startDownloadWatcher(): void {
  if (started) return
  started = true
  useDowntifyStore.subscribe((s, prev) => {
    if (s.queue === prev.queue) return
    const done = s.queue.filter((item) => item.status === 'done').map(key)
    if (finished === null) {
      // Whatever had already finished before this session was scanned back then.
      finished = new Set(done)
      return
    }
    const fresh = done.filter((k) => !finished!.has(k))
    if (fresh.length === 0) return
    fresh.forEach((k) => finished!.add(k))
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      scanForNewSongs()
    }, SETTLE_MS)
  })
}
