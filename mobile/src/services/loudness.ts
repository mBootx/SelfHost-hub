import type { ReplayGain } from '@/services/navidrome'

/**
 * Volume normalisation from ReplayGain tags: a loud track is turned down so that tracks come out at about the
 * same level. It only ever turns down - a player's volume cannot go above its maximum, and boosting would
 * distort - so a quiet track is left as it is.
 */
export type NormalizeMode = 'off' | 'track' | 'album'

export const NORMALIZE_MODES: NormalizeMode[] = ['off', 'track', 'album']

export const NORMALIZE_LABELS: Record<NormalizeMode, string> = {
  off: 'Désactivée',
  track: 'Par titre',
  album: 'Par album'
}

/**
 * ReplayGain 2 aims at -18 LUFS, which is quiet next to the music of the last twenty years; streaming services
 * play at about -14. This much is added to every gain before it is capped, so most tracks come out turned down
 * a little instead of a lot.
 */
export const TARGET_BOOST_DB = 4

/** The most a track can be turned down: past this, the tags are not to be trusted. */
const FLOOR_DB = -30

/**
 * What to multiply a track's volume by (1 = leave it). With `track`, the track's own gain is used, else its album's;
 * with `album` the other way round, which keeps the quieter and louder songs of one album in proportion.
 * A track without usable tags is left alone, unless the server gave a fallback gain for such files.
 */
export function loudnessFactor(song: { replayGain?: ReplayGain } | null | undefined, mode: NormalizeMode): number {
  if (mode === 'off' || !song?.replayGain) return 1
  const tags = song.replayGain
  const own = mode === 'album' ? (tags.albumGain ?? tags.trackGain) : (tags.trackGain ?? tags.albumGain)
  const gain = own ?? tags.fallbackGain
  if (typeof gain !== 'number' || !Number.isFinite(gain)) return 1
  const db = Math.max(FLOOR_DB, gain + TARGET_BOOST_DB)
  return Math.min(1, 10 ** (db / 20))
}
