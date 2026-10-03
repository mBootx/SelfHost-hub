import { useEffect, useState } from 'react'
import { cachedPalette, coverPalette, Palette } from '@/services/coverColor'

/**
 * The palette of the cover at `url`. While the next cover's palette is being read the previous one stays, so the
 * screen eases from one song to the next instead of flashing grey in between. A song with no cover (or no way to read
 * one) gets null, which the Now Playing screen shows in the app's own colours.
 */
export function useCoverPalette(url: string | null): Palette | null {
  const [palette, setPalette] = useState<Palette | null>(() => (url ? cachedPalette(url) : null))

  useEffect(() => {
    if (!url) {
      setPalette(null)
      return
    }
    const cached = cachedPalette(url)
    if (cached) {
      setPalette(cached)
      return
    }
    let cancelled = false
    coverPalette(url).then((found) => {
      if (!cancelled) setPalette(found)
    })
    return () => {
      cancelled = true
    }
  }, [url])

  return palette
}
