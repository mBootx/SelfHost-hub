import { useEffect, useState } from 'react'
import { cachedCoverColor, coverColor } from '@/services/coverColor'

/**
 * The dominant colour of the cover at `url`. While the next cover's colour is being found the previous one
 * stays, so the backdrop eases from one song to the next instead of flashing grey in between. A song with
 * no cover (or no way to read one) gets null, which the Now Playing screen shows as its plain dark surfaces.
 */
export function useCoverColor(url: string | null): string | null {
  const [color, setColor] = useState<string | null>(() => (url ? cachedCoverColor(url) : null))

  useEffect(() => {
    if (!url) {
      setColor(null)
      return
    }
    const cached = cachedCoverColor(url)
    if (cached) {
      setColor(cached)
      return
    }
    let cancelled = false
    coverColor(url).then((found) => {
      if (!cancelled) setColor(found)
    })
    return () => {
      cancelled = true
    }
  }, [url])

  return color
}
