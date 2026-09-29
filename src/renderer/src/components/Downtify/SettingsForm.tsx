import { useEffect, useState } from 'react'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { DowntifySettings } from '@renderer/services/downtify'

const FORMATS = ['mp3', 'flac', 'ogg', 'opus', 'm4a']
const BITRATES = ['128', '192', '256', '320']
const AUDIO_PROVIDERS = ['youtube', 'youtube-music']
const LYRICS_PROVIDERS = ['lrclib', 'genius', 'musixmatch', 'azlyrics']
const PARALLEL_OPTIONS = [1, 2, 3, 5, 8]

const selectClass =
  'w-full rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-accent'

/** Downtify's server-side download options. Lives in Reglages now that the module has no tab of its own. */
export default function DowntifySettingsForm(): JSX.Element | null {
  const client = useDowntifyStore((s) => s.client)
  const [settings, setSettings] = useState<DowntifySettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!client) {
      setSettings(null)
      return
    }
    client.getSettings().then(setSettings).catch(() => {})
  }, [client])

  if (!settings) return null

  async function saveSettings(): Promise<void> {
    if (!client || !settings) return
    setSaving(true)
    try {
      await client.updateSettings(settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-md space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-400">Source audio</label>
        <select
          value={settings.audio_providers[0] || 'youtube-music'}
          onChange={(e) => setSettings({ ...settings, audio_providers: [e.target.value] })}
          className={selectClass}
        >
          {AUDIO_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-400">Format</label>
          <select
            value={settings.format}
            onChange={(e) => setSettings({ ...settings, format: e.target.value })}
            className={selectClass}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-400">Qualité</label>
          <select
            value={settings.bitrate}
            onChange={(e) => setSettings({ ...settings, bitrate: e.target.value })}
            className={selectClass}
          >
            {BITRATES.map((b) => (
              <option key={b} value={b}>
                {b} kbps
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-400">Format du nom de fichier</label>
        <input
          value={settings.output}
          onChange={(e) => setSettings({ ...settings, output: e.target.value })}
          className={selectClass}
        />
        <p className="mt-1 text-[11px] text-gray-500">
          Utilisez / pour des sous-dossiers. Jetons : {'{artists} {artist} {title} {album} {output-ext}'}
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-400">Sources de paroles</label>
        <div className="flex flex-wrap gap-3">
          {LYRICS_PROVIDERS.map((p) => (
            <label key={p} className="flex items-center gap-1.5 text-xs text-gray-300">
              <input
                type="checkbox"
                checked={settings.lyrics_providers.includes(p)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    lyrics_providers: e.target.checked
                      ? [...settings.lyrics_providers, p]
                      : settings.lyrics_providers.filter((x) => x !== p)
                  })
                }
              />
              {p}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-400">Téléchargements parallèles</label>
        <select
          value={settings.max_parallel_downloads}
          onChange={(e) => setSettings({ ...settings, max_parallel_downloads: Number(e.target.value) })}
          className={selectClass}
        >
          {PARALLEL_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input
          type="checkbox"
          checked={settings.download_lyrics}
          onChange={(e) => setSettings({ ...settings, download_lyrics: e.target.checked })}
        />
        Télécharger les paroles (embarquées + .lrc)
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input
          type="checkbox"
          checked={settings.generate_m3u}
          onChange={(e) => setSettings({ ...settings, generate_m3u: e.target.checked })}
        />
        Générer un fichier M3U pour les playlists
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input
          type="checkbox"
          checked={settings.organize_by_artist}
          onChange={(e) => setSettings({ ...settings, organize_by_artist: e.target.checked })}
        />
        Organiser par artiste (sous-dossiers)
      </label>

      <div className="flex items-center gap-3">
        <button
          onClick={saveSettings}
          disabled={saving}
          className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black hover:bg-accent-hover disabled:opacity-60"
        >
          {saving ? 'Enregistrement...' : 'Enregistrer'}
        </button>
        {saved && <span className="text-xs text-accent">Enregistré</span>}
      </div>
    </div>
  )
}
