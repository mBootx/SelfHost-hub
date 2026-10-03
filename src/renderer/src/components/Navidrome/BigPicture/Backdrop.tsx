import { useEffect, useRef, useState } from 'react'

interface Layer {
  id: number
  url: string
}

/** How long the old cover stays under the new one, which fades in over it (see .bp-fade in globals.css). */
const CROSSFADE_MS = 1200

/**
 * What is behind the full-screen player: the cover blown up, blurred and slowly drifting, tinted with its own colour,
 * darkened at the edges. When the song changes the new cover fades in over the old one instead of cutting.
 */
export default function Backdrop({ url }: { url: string | null }): JSX.Element {
  const [layers, setLayers] = useState<Layer[]>(() => (url ? [{ id: 0, url }] : []))
  const counter = useRef(1)

  useEffect(() => {
    if (!url) {
      setLayers([])
      return
    }
    const id = counter.current++
    setLayers((current) => (current[current.length - 1]?.url === url ? current : [...current, { id, url }]))
    const timer = setTimeout(() => setLayers((current) => (current.length > 1 ? current.slice(-1) : current)), CROSSFADE_MS)
    return () => clearTimeout(timer)
  }, [url])

  return (
    <div className="absolute inset-0 overflow-hidden bg-black" aria-hidden>
      {layers.map((layer) => (
        <div key={layer.id} className="bp-fade absolute inset-[-9%]">
          <div
            className="bp-drift h-full w-full"
            style={{
              backgroundImage: `url("${layer.url}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              filter: 'blur(64px) saturate(1.5) brightness(0.5)'
            }}
          />
        </div>
      ))}
      {/* The cover's own colour, pooled behind the artwork. */}
      <div
        className="absolute inset-0 transition-opacity duration-1000"
        style={{ background: 'radial-gradient(60% 70% at 28% 48%, rgb(var(--bp) / 0.42), transparent 70%)' }}
      />
      {/* A light cover would wash the text out: everything sits on a little shade. */}
      <div className="absolute inset-0 bg-black/25" />
      {/* The vignette: dark corners, dark top and bottom for the bars. */}
      <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 45%, transparent 38%, rgb(0 0 0 / 0.72) 100%)' }} />
      <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-black/60" />
    </div>
  )
}
