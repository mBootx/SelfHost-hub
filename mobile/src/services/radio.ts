import type { NDSong } from '@/services/navidrome'

/** What the radio needs from the server; the Navidrome client has all of it. */
export interface RadioSource {
  getSimilarSongs(id: string, count?: number): Promise<NDSong[]>
  getSimilarSongs2(artistId: string, count?: number): Promise<NDSong[]>
  getRandomSongs(count?: number, genre?: string): Promise<NDSong[]>
}

export type RadioKind = 'similar' | 'artist' | 'genre'

/** How many songs a radio is started with, and how many are added each time it runs low. */
export const RADIO_BATCH = 30
/** The queue is topped up once this few songs are left after the current one. */
export const RADIO_LOW_WATER = 3

/** A server without one of these calls (or with nothing to say) is the same thing here: no songs. */
async function attempt(load: () => Promise<NDSong[]>): Promise<NDSong[]> {
  try {
    const songs = await load()
    return Array.isArray(songs) ? songs : []
  } catch {
    return []
  }
}

/**
 * Songs to play after `seed`: the ones the server finds similar to it; if that is not enough, songs from
 * artists like its artist; if still not, random songs of its genre. Never the seed, nothing already in
 * `exclude`, nothing twice. `kind` is the first source that gave anything - what to call the radio.
 */
export async function findRadioSongs(
  source: RadioSource,
  seed: NDSong,
  options: { count?: number; exclude?: ReadonlySet<string> } = {}
): Promise<{ songs: NDSong[]; kind: RadioKind | null }> {
  const count = options.count ?? RADIO_BATCH
  const seen = new Set<string>([seed.id, ...(options.exclude ?? [])])
  const songs: NDSong[] = []
  let kind: RadioKind | null = null

  const take = (found: NDSong[], from: RadioKind): void => {
    for (const song of found) {
      if (songs.length >= count) return
      if (!song?.id || seen.has(song.id)) continue
      seen.add(song.id)
      songs.push(song)
      kind ??= from
    }
  }

  take(await attempt(() => source.getSimilarSongs(seed.id, count)), 'similar')
  if (songs.length < count && seed.artistId) take(await attempt(() => source.getSimilarSongs2(seed.artistId!, count)), 'artist')
  if (songs.length < count) take(await attempt(() => source.getRandomSongs(count + seen.size, seed.genre || undefined)), 'genre')
  return { songs, kind }
}

/** Whether a radio's queue has run low enough to add more. */
export function radioNeedsMore(queueLength: number, queueIndex: number): boolean {
  return queueLength - queueIndex - 1 <= RADIO_LOW_WATER
}
