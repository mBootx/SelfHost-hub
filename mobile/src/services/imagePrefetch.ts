import { NavidromeClient } from './navidrome'
import { storeCover } from './coverStore'

/** Caps a single call so refreshing a huge library can't burst-fetch hundreds of covers at once. */
const MAX_BATCH = 80

/**
 * Saves a batch of covers on the phone (services/coverStore) before they're scrolled into
 * view. FlatList only mounts `initialNumToRender` rows, so without this the
 * rest of a list's artwork only starts its network fetch the moment it scrolls
 * near the viewport - this fires those requests as soon as the data arrives
 * instead, so by the time a row is visible its cover is already on the phone.
 *
 * Callers pass the exact coverArt id each row will render (already resolved
 * through whatever fallback - `song.coverArt || song.albumId`, etc. - that row
 * uses) so the prefetched URL is guaranteed to match, via the same memoized
 * `coverArtUrl` the row itself calls.
 */
export function prefetchCoverArt(client: NavidromeClient | null, ids: Array<string | null | undefined>, size: number): void {
  if (!client) return
  const unique = new Set<string>()
  for (const id of ids) {
    if (id) unique.add(id)
    if (unique.size >= MAX_BATCH) break
  }
  if (unique.size === 0) return
  // Saved on the phone (services/coverStore), where the rows will find them: nothing is decoded ahead of time.
  for (const id of unique) void storeCover(client.coverArtUrl(id, size))
}
