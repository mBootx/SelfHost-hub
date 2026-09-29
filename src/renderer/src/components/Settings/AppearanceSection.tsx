import { Check, Pipette, RotateCcw } from 'lucide-react'
import { ACCENT_PRESETS, BACKGROUNDS, BackgroundId, useAppearanceStore } from '@renderer/store/appearanceStore'

export default function AppearanceSection(): JSX.Element {
  const accent = useAppearanceStore((s) => s.accent)
  const background = useAppearanceStore((s) => s.background)
  const setAccent = useAppearanceStore((s) => s.setAccent)
  const setBackground = useAppearanceStore((s) => s.setBackground)
  const reset = useAppearanceStore((s) => s.reset)
  const isCustomAccent = !ACCENT_PRESETS.some((p) => p.hex.toLowerCase() === accent.toLowerCase())

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Apparence</h2>
      <div className="space-y-5 rounded-lg border border-surface-border bg-surface-elevated p-4">
        <div>
          <p className="mb-2.5 text-sm font-semibold">Couleur d'accent</p>
          <div className="flex flex-wrap items-center gap-2.5">
            {ACCENT_PRESETS.map((preset) => {
              const selected = preset.hex.toLowerCase() === accent.toLowerCase()
              return (
                <button
                  key={preset.hex}
                  onClick={() => setAccent(preset.hex)}
                  title={preset.label}
                  aria-label={preset.label}
                  aria-pressed={selected}
                  style={{ backgroundColor: preset.hex }}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-transform hover:scale-110 ${
                    selected ? 'ring-2 ring-white ring-offset-2 ring-offset-surface-elevated' : ''
                  }`}
                >
                  {selected && <Check className="h-4 w-4 text-black" />}
                </button>
              )
            })}
            <label
              title="Couleur personnalisee"
              style={isCustomAccent ? { backgroundColor: accent } : undefined}
              className={`relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-dashed border-gray-500 transition-transform hover:scale-110 ${
                isCustomAccent ? 'border-solid ring-2 ring-white ring-offset-2 ring-offset-surface-elevated' : ''
              }`}
            >
              <Pipette className={`h-4 w-4 ${isCustomAccent ? 'text-black' : 'text-gray-300'}`} />
              <input
                type="color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Couleur personnalisee"
              />
            </label>
          </div>
        </div>

        <div>
          <p className="mb-2.5 text-sm font-semibold">Fond</p>
          <div className="grid grid-cols-4 gap-2">
            {(Object.keys(BACKGROUNDS) as BackgroundId[]).map((id) => {
              const surfaces = BACKGROUNDS[id]
              const selected = id === background
              return (
                <button
                  key={id}
                  onClick={() => setBackground(id)}
                  aria-pressed={selected}
                  className={`rounded-lg border p-2 text-left text-xs transition-colors ${
                    selected ? 'border-accent text-white' : 'border-surface-border text-gray-300 hover:border-gray-500'
                  }`}
                >
                  <div className="mb-2 flex h-10 overflow-hidden rounded border border-white/5">
                    <span className="flex-1" style={{ backgroundColor: surfaces.base }} />
                    <span className="flex-1" style={{ backgroundColor: surfaces.elevated }} />
                    <span className="flex-1" style={{ backgroundColor: surfaces.hover }} />
                  </div>
                  {surfaces.label}
                </button>
              )
            })}
          </div>
        </div>

        <button onClick={reset} className="flex items-center gap-1.5 text-xs text-gray-400 transition-colors hover:text-white">
          <RotateCcw className="h-3.5 w-3.5" /> Revenir au theme d'origine
        </button>
      </div>
    </section>
  )
}
