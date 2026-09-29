import {
  CROSSFADE_MAX_S,
  EQ_FREQUENCIES,
  EQ_MAX_DB,
  EQ_PRESETS,
  useAudioSettingsStore
} from '@renderer/store/audioSettingsStore'
import Switch from '@renderer/components/Switch'

function formatFrequency(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz)
}

export default function PlaybackSection(): JSX.Element {
  const crossfadeSeconds = useAudioSettingsStore((s) => s.crossfadeSeconds)
  const gapless = useAudioSettingsStore((s) => s.gapless)
  const eqEnabled = useAudioSettingsStore((s) => s.eqEnabled)
  const eqPreset = useAudioSettingsStore((s) => s.eqPreset)
  const eqGains = useAudioSettingsStore((s) => s.eqGains)
  const setCrossfade = useAudioSettingsStore((s) => s.setCrossfade)
  const setGapless = useAudioSettingsStore((s) => s.setGapless)
  const setEqEnabled = useAudioSettingsStore((s) => s.setEqEnabled)
  const applyEqPreset = useAudioSettingsStore((s) => s.applyEqPreset)
  const setEqBand = useAudioSettingsStore((s) => s.setEqBand)

  return (
    <>
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Lecture</h2>
        <div className="space-y-5 rounded-lg border border-surface-border bg-surface-elevated p-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Fondu enchaîné</p>
              <span className="text-xs tabular-nums text-gray-400">
                {crossfadeSeconds === 0 ? 'Désactivé' : `${crossfadeSeconds} s`}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={CROSSFADE_MAX_S}
              step={1}
              value={crossfadeSeconds}
              onChange={(e) => setCrossfade(Number(e.target.value))}
              className="range-accent w-full"
              style={{ '--range-progress': `${(crossfadeSeconds / CROSSFADE_MAX_S) * 100}%` } as React.CSSProperties}
              aria-label="Durée du fondu enchaîné"
            />
            <p className="mt-2 text-xs text-gray-500">
              Quand un titre se termine, le suivant commence en fondu par-dessus. Les changements manuels restent instantanés.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">Lecture sans blanc</p>
              <p className="text-xs text-gray-500">
                Précharge le titre suivant pour l'enchaîner sans silence quand le fondu est désactivé.
              </p>
            </div>
            <Switch checked={gapless} onChange={setGapless} label="Lecture sans blanc" />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Égaliseur</h2>
        <div className="space-y-5 rounded-lg border border-surface-border bg-surface-elevated p-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-semibold">Activer l'égaliseur</p>
            <Switch checked={eqEnabled} onChange={setEqEnabled} label="Activer l'égaliseur" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {EQ_PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => applyEqPreset(preset.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  eqEnabled && eqPreset === preset.id ? 'bg-accent text-black' : 'bg-surface-hover text-gray-300 hover:text-white'
                }`}
              >
                {preset.label}
              </button>
            ))}
            {eqPreset === 'custom' && (
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${eqEnabled ? 'bg-accent text-black' : 'bg-surface-hover text-gray-400'}`}>
                Personnalisé
              </span>
            )}
          </div>
          <div className={`flex items-end justify-between gap-1 transition-opacity ${eqEnabled ? '' : 'opacity-50'}`}>
            {EQ_FREQUENCIES.map((frequency, i) => (
              <div key={frequency} className="flex flex-1 flex-col items-center gap-1.5">
                <span className="text-[10px] tabular-nums text-gray-400">
                  {eqGains[i] > 0 ? '+' : ''}
                  {eqGains[i]}
                </span>
                <input
                  type="range"
                  min={-EQ_MAX_DB}
                  max={EQ_MAX_DB}
                  step={1}
                  value={eqGains[i]}
                  onChange={(e) => setEqBand(i, Number(e.target.value))}
                  // Vertical, with the minimum at the bottom.
                  style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                  className="h-32 w-5 cursor-pointer accent-accent"
                  aria-label={`${formatFrequency(frequency)} Hz`}
                />
                <span className="text-[10px] text-gray-500">{formatFrequency(frequency)}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500">En dB. Le volume global baisse d'autant que la bande la plus poussée pour éviter la saturation.</p>
        </div>
      </section>
    </>
  )
}
