import { useEffect, useState } from 'react'

const cache = new Map<string, string>()
const inFlight = new Map<string, Promise<string | null>>()

async function fetchAsBlobUrl(url: string): Promise<string | null> {
  const cached = cache.get(url)
  if (cached) return cached
  const pending = inFlight.get(url)
  if (pending) return pending

  const promise = (async () => {
    try {
      const res = await window.api.net.request({ url, method: 'GET', responseType: 'arraybuffer' })
      if (!res.ok || !res.data) return null
      const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data)
      const contentType = res.headers?.['content-type'] || 'image/jpeg'
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }))
      cache.set(url, blobUrl)
      return blobUrl
    } catch {
      return null
    } finally {
      inFlight.delete(url)
    }
  })()

  inFlight.set(url, promise)
  return promise
}

/**
 * Some remote thumbnail CDNs (e.g. Google's yt3.googleusercontent.com, used
 * by Downtify search results) reject direct cross-origin <img> loads from
 * embedded apps. Fetching the bytes through the main process (no browser
 * CORS/CORP restrictions there) and displaying them as a blob URL sidesteps
 * that entirely, regardless of the exact restriction the CDN enforces.
 */
export function useProxiedImage(url: string | null | undefined): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(url ? cache.get(url) || null : null)

  useEffect(() => {
    if (!url) {
      setBlobUrl(null)
      return
    }
    const cached = cache.get(url)
    if (cached) {
      setBlobUrl(cached)
      return
    }
    let cancelled = false
    setBlobUrl(null)
    fetchAsBlobUrl(url).then((result) => {
      if (!cancelled) setBlobUrl(result)
    })
    return () => {
      cancelled = true
    }
  }, [url])

  return blobUrl
}
