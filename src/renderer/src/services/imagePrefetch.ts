import type { NavidromeClient } from './navidrome'

/** Caps a single call so refreshing a huge library can't burst-fetch hundreds of covers at once. */
const MAX_BATCH = 80

/**
 * Warms Chromium's HTTP cache for a batch of covers before they scroll into
 * view. Most grids mark their <img> `loading="lazy"`, which is good for not
 * mounting hundreds of decoders at once but means the network fetch itself
 * doesn't start until the tile nears the viewport - this fires those requests
 * as soon as the data arrives instead (a plain Image() object, unrelated to
 * any <img>'s lazy attribute), so the later lazy <img> is a cache hit.
 *
 * Callers pass the exact coverArt id each tile will render (already resolved
 * through whatever fallback that tile uses) so the prefetched URL is
 * guaranteed to match, via the same memoized `coverArtUrl` the tile itself calls.
 */
export function prefetchCoverArt(client: NavidromeClient | null, ids: Array<string | null | undefined>, size: number): void {
  if (!client) return
  const unique = new Set<string>()
  for (const id of ids) {
    if (id) unique.add(id)
    if (unique.size >= MAX_BATCH) break
  }
  unique.forEach((id) => {
    const img = new Image()
    img.src = client.coverArtUrl(id, size)
  })
}
