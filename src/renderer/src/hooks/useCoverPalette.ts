import { useEffect, useState } from 'react'
import { dominantColor, Rgb } from '@renderer/services/bigPicture'
import { useProxiedImage } from './useProxiedImage'

/**
 * The colour a cover is about, for tinting the screen around it. The cover is fetched through the main process (as
 * a blob of this page's own origin), because a canvas that has drawn a cross-origin image refuses to give its pixels
 * back. The previous colour stays until the next cover has been read, so the tint doesn't flash between songs.
 * Undefined until the first cover has been read; null for a cover with no colour to speak of (greys), or none at all.
 */
export function useCoverPalette(url: string | null): Rgb | null | undefined {
  const blob = useProxiedImage(url)
  const [color, setColor] = useState<Rgb | null | undefined>(undefined)

  useEffect(() => {
    if (!url) {
      setColor(null)
      return
    }
    if (!blob) return
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('no canvas')
        context.drawImage(image, 0, 0, 32, 32)
        const found = dominantColor(context.getImageData(0, 0, 32, 32).data)
        if (!cancelled) setColor(found)
      } catch {
        if (!cancelled) setColor(null)
      }
    }
    image.onerror = () => {
      if (!cancelled) setColor(null)
    }
    image.src = blob
    return () => {
      cancelled = true
    }
  }, [url, blob])

  return color
}
