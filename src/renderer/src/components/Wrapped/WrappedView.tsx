import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Copy,
  Disc3,
  Download,
  Flame,
  Headphones,
  Info,
  MicVocal,
  Music,
  Play
} from 'lucide-react'
import { flushListening, useListeningStore, useMergedLedger } from '@renderer/services/listeningLog'
import type { NavidromeClient } from '@renderer/services/navidrome'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useToastStore } from '@renderer/store/toastStore'
import {
  addDays,
  changeLabel,
  customPeriod,
  DAY_LETTERS,
  dayKey,
  dayRange,
  daySeconds,
  dayStart,
  durationLabel,
  formatWrappedShare,
  latestWeek,
  periodCurrent,
  periodKey,
  periodLabel,
  periodNoun,
  periodOf,
  shiftPeriod,
  songOf,
  summarize,
  summarizePeriod,
  type AlbumStat,
  type ArtistStat,
  type Ledger,
  type Period,
  type PeriodKind,
  type PeriodSummary,
  type SongStat
} from '@renderer/services/wrapped'

const TABS: { kind: PeriodKind; label: string }[] = [
  { kind: 'day', label: 'Jour' },
  { kind: 'week', label: 'Semaine' },
  { kind: 'month', label: 'Mois' },
  { kind: 'year', label: 'Année' },
  { kind: 'custom', label: 'Personnalisé' }
]

const MONTH_NAMES = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre'
]

function coverUrl(
  client: NavidromeClient | null,
  item: { coverArt?: string; albumId?: string; id?: string },
  size: number
): string | null {
  const id = item.coverArt || item.albumId || item.id
  return client && id ? client.coverArtUrl(id, size) : null
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('fr-FR')} ${count > 1 ? many : one}`
}

const capitalize = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text)

function secondsLabel(seconds: number): string {
  if (seconds > 0 && seconds < 60) return `${Math.round(seconds)} s`
  return durationLabel(Math.round(seconds / 60))
}

function songMeta(song: SongStat): string {
  return `${plural(song.plays, 'écoute', 'écoutes')} · ${durationLabel(Math.round(song.seconds / 60))}`
}

function useCountUp(target: number, key: string): number {
  const [value, setValue] = useState(target)
  useEffect(() => {
    const start = Date.now()
    let frame = 0
    const step = (): void => {
      const t = Math.min(1, (Date.now() - start) / 700)
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))))
      if (t < 1) frame = requestAnimationFrame(step)
    }
    setValue(0)
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, key])
  return value
}

function CoverTile({
  url,
  className,
  round = false,
  icon = Music
}: {
  url: string | null
  className: string
  round?: boolean
  icon?: typeof Music
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  const Icon = icon
  if (!url || failed) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center bg-surface-hover text-gray-500 ${
          round ? 'rounded-full' : 'rounded-lg'
        } ${className}`}
      >
        <Icon className="h-1/2 w-1/2" />
      </div>
    )
  }
  return (
    <img
      src={url}
      alt=""
      onError={() => setFailed(true)}
      className={`shrink-0 object-cover ${round ? 'rounded-full' : 'rounded-lg'} ${className}`}
    />
  )
}

function InteractiveChart({
  summary,
  onDrill
}: {
  summary: PeriodSummary
  onDrill: (period: Period) => void
}): JSX.Element {
  const [selected, setSelected] = useState<number | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const key = periodKey(summary.period)
  useEffect(() => {
    setSelected(null)
    setHovered(null)
  }, [key])

  const { buckets, busiest } = summary
  const most = Math.max(1, ...buckets.map((b) => b.seconds))
  const drillable = buckets.some((b) => b.drill)
  const shown = hovered ?? selected ?? busiest

  let caption: string
  if (shown === null) caption = drillable ? 'Rien écouté sur cette période' : 'Rien écouté ce jour-là'
  else if (shown === hovered || shown === selected) caption = `${buckets[shown].label} : ${secondsLabel(buckets[shown].seconds)}`
  else caption = `Le plus écouté : ${buckets[shown].label}, ${secondsLabel(buckets[shown].seconds)}`

  return (
    <div className="rounded-2xl border border-surface-border bg-surface-elevated p-5">
      <p className="mb-4 text-center text-sm font-semibold text-white">{caption}</p>
      <div className="flex h-36 items-end gap-1.5">
        {buckets.map((bucket, i) => {
          const highlighted = i === shown
          const pct = bucket.seconds > 0 ? Math.max(5, Math.round((bucket.seconds / most) * 100)) : 2
          const canClick = !!bucket.drill || !bucket.future
          return (
            <button
              key={bucket.key}
              type="button"
              disabled={!canClick}
              onClick={() => (bucket.drill ? onDrill(bucket.drill) : setSelected(i === selected ? null : i))}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              title={`${bucket.label} : ${secondsLabel(bucket.seconds)}`}
              aria-label={`${bucket.label} : ${secondsLabel(bucket.seconds)}${bucket.drill ? ' · Ouvrir' : ''}`}
              className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5 disabled:cursor-default"
            >
              <div className="flex w-full flex-1 items-end justify-center">
                <div
                  style={{ height: `${pct}%` }}
                  className={`w-full max-w-[28px] rounded-t transition-all duration-150 ${
                    bucket.future
                      ? 'bg-white/10'
                      : highlighted
                        ? 'bg-accent'
                        : 'bg-white/25 group-hover:bg-accent/70'
                  }`}
                />
              </div>
              <span
                className={`h-4 text-[10px] font-semibold leading-4 ${
                  highlighted ? 'text-accent' : 'text-gray-400'
                }`}
              >
                {bucket.short || ''}
              </span>
            </button>
          )
        })}
      </div>
      {drillable && (
        <p className="mt-3 text-center text-[11px] text-gray-500">
          Cliquez sur une barre pour ouvrir le détail · Survolez pour voir la durée
        </p>
      )}
      {summary.partialHours && (
        <p className="mt-2 text-center text-[11px] text-gray-400">
          Les heures ne sont enregistrées que depuis la mise à jour : une partie de ce jour n&apos;y figure pas.
        </p>
      )}
    </div>
  )
}

function RangePicker({
  initial,
  ledger,
  today,
  onDone,
  onCancel
}: {
  initial: Period
  ledger: Ledger
  today: string
  onDone: (period: Period) => void
  onCancel: () => void
}): JSX.Element {
  const lastOfInitial = addDays(initial.end, -1) > today ? today : addDays(initial.end, -1)
  const [month, setMonth] = useState(() => {
    const d = dayStart(lastOfInitial)
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [from, setFrom] = useState<string | null>(initial.start)
  const [to, setTo] = useState<string | null>(lastOfInitial)

  const cells = useMemo(() => {
    const first = new Date(month)
    const lead = (first.getDay() + 6) % 7
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead)
    const list: { key: string; day: number; inMonth: boolean }[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      if (i >= 35 && d.getMonth() !== month.getMonth()) break
      list.push({ key: dayKey(d.getTime()), day: d.getDate(), inMonth: d.getMonth() === month.getMonth() })
    }
    return list
  }, [month])

  const pick = (day: string): void => {
    if (!from || to) {
      setFrom(day)
      setTo(null)
    } else {
      setTo(day)
    }
  }

  const lo = from && to ? (from < to ? from : to) : from
  const hi = from && to ? (from < to ? to : from) : from
  const thisMonth = new Date(dayStart(today).getFullYear(), dayStart(today).getMonth(), 1)
  const canNext = month < thisMonth

  return (
    <div className="rounded-2xl border border-surface-border bg-surface-elevated p-5">
      <div className="mb-4 flex flex-wrap gap-2">
        {[7, 30, 90].map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => onDone(customPeriod(addDays(today, -(days - 1)), today))}
            className="rounded-full bg-surface-hover px-3 py-1 text-xs font-semibold text-gray-200 transition-colors hover:bg-surface-border hover:text-white"
          >
            {days} derniers jours
          </button>
        ))}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          aria-label="Mois précédent"
          className="rounded-full bg-surface-hover p-1.5 text-gray-200 hover:bg-surface-border hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-bold capitalize text-white">
          {MONTH_NAMES[month.getMonth()]} {month.getFullYear()}
        </span>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          aria-label="Mois suivant"
          className="rounded-full bg-surface-hover p-1.5 text-gray-200 hover:bg-surface-border hover:text-white disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {DAY_LETTERS.map((letter, i) => (
          <span key={i} className="py-1 text-center text-[11px] font-bold text-gray-500">
            {letter}
          </span>
        ))}
        {cells.map((cell) => {
          const future = cell.key > today
          const inRange = !!lo && !!hi && cell.key >= lo && cell.key <= hi
          const end = cell.key === lo || cell.key === hi
          const heard = !future && daySeconds(ledger, cell.key) > 0
          return (
            <button
              key={cell.key}
              type="button"
              disabled={future}
              onClick={() => pick(cell.key)}
              className={`relative flex h-9 flex-col items-center justify-center rounded-lg text-xs font-semibold transition-colors ${
                end
                  ? 'bg-accent text-black'
                  : inRange
                    ? 'bg-accent/20 text-white'
                    : future
                      ? 'text-gray-600'
                      : cell.inMonth
                        ? 'text-gray-200 hover:bg-surface-hover'
                        : 'text-gray-500 hover:bg-surface-hover'
              }`}
            >
              <span>{cell.day}</span>
              {heard && (
                <span className={`mt-0.5 h-1 w-1 rounded-full ${end ? 'bg-black' : 'bg-accent'}`} />
              )}
            </button>
          )
        })}
      </div>

      <p className="mt-3 text-center text-xs text-gray-400">
        {!from
          ? 'Cliquez sur le premier jour'
          : !to
            ? 'Puis sur le dernier jour (ou Afficher pour ce seul jour)'
            : periodLabel(customPeriod(from, to))}
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full bg-surface-hover px-4 py-1.5 text-xs font-bold text-gray-200 hover:bg-surface-border"
        >
          Annuler
        </button>
        <button
          type="button"
          disabled={!from}
          onClick={() => from && onDone(customPeriod(from, to ?? from))}
          className="rounded-full bg-accent px-4 py-1.5 text-xs font-bold text-black hover:bg-accent-hover disabled:opacity-40"
        >
          Afficher
        </button>
      </div>
    </div>
  )
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let trimmed = text
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1)
  }
  return `${trimmed}…`
}

async function loadImageForCanvas(url: string | null): Promise<{ img: HTMLImageElement; revoke: () => void } | null> {
  if (!url) return null
  try {
    const res = await window.api.net.request({ url, method: 'GET', responseType: 'arraybuffer' })
    if (!res.ok || !res.data) return null
    const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data as ArrayBuffer)
    const contentType = res.headers?.['content-type'] || 'image/jpeg'
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }))
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('image decode failed'))
      img.src = blobUrl
    })
    return { img, revoke: () => URL.revokeObjectURL(blobUrl) }
  } catch {
    return null
  }
}

async function renderCardPng(
  summary: PeriodSummary,
  label: string,
  streakWeeks: number | undefined,
  coverArtUrl: string | null
): Promise<Blob | null> {
  const W = 900
  const H = 1160
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const rawAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '29 185 84'
  const accentParts = rawAccent.split(/[\s,]+/).slice(0, 3).map(Number)
  const [ar, ag, ab] = accentParts.length === 3 && accentParts.every(Number.isFinite) ? accentParts : [29, 185, 84]
  const accentCss = `rgb(${ar}, ${ag}, ${ab})`
  const accentSoft = `rgba(${ar}, ${ag}, ${ab}, 0.18)`
  const accentGlow = `rgba(${ar}, ${ag}, ${ab}, 0.28)`

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#101318')
  bg.addColorStop(0.5, '#0b0d11')
  bg.addColorStop(1, '#07080a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  const glow = ctx.createRadialGradient(W * 0.85, H * 0.12, 20, W * 0.85, H * 0.12, 460)
  glow.addColorStop(0, accentGlow)
  glow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)

  // Card border
  roundRectPath(ctx, 20, 20, W - 40, H - 40, 28)
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 2
  ctx.stroke()

  const padX = 56
  let y = 78

  ctx.fillStyle = accentCss
  ctx.font = '700 15px Inter, system-ui, sans-serif'
  ctx.fillText('SELFHOST HUB · RÉTROSPECTIVE', padX, y)

  y += 42
  ctx.fillStyle = '#ffffff'
  ctx.font = '800 36px Inter, system-ui, sans-serif'
  ctx.fillText(fitText(ctx, capitalize(label), W - padX * 2), padX, y)

  // Hero minutes
  y += 86
  ctx.fillStyle = '#ffffff'
  ctx.font = '900 84px Inter, system-ui, sans-serif'
  const minText = summary.minutes.toLocaleString('fr-FR')
  ctx.fillText(minText, padX, y)
  const minW = ctx.measureText(minText).width
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.font = '700 24px Inter, system-ui, sans-serif'
  ctx.fillText(summary.minutes > 1 ? "minutes d'écoute" : "minute d'écoute", padX + minW + 16, y - 10)

  y += 34
  ctx.fillStyle = 'rgba(255,255,255,0.62)'
  ctx.font = '600 18px Inter, system-ui, sans-serif'
  const subParts = [
    durationLabel(summary.minutes),
    plural(summary.plays, 'écoute', 'écoutes'),
    plural(summary.artistCount, 'artiste', 'artistes')
  ]
  if (streakWeeks && streakWeeks > 1) subParts.push(`Série de ${streakWeeks} semaines`)
  ctx.fillText(fitText(ctx, subParts.join(' · '), W - padX * 2), padX, y)

  // Chart box
  y += 34
  const chartBoxW = W - padX * 2
  const chartBoxH = 160
  roundRectPath(ctx, padX, y, chartBoxW, chartBoxH, 20)
  ctx.fillStyle = 'rgba(255,255,255,0.04)'
  ctx.fill()

  const buckets = summary.buckets
  if (buckets.length > 0) {
    const most = Math.max(1, ...buckets.map((b) => b.seconds))
    const innerPad = 24
    const barGap = buckets.length > 16 ? 4 : 10
    const availW = chartBoxW - innerPad * 2
    const barW = Math.max(4, (availW - barGap * (buckets.length - 1)) / buckets.length)
    const maxBarH = 92
    const baseY = y + chartBoxH - 36
    buckets.forEach((b, i) => {
      const x = padX + innerPad + i * (barW + barGap)
      const h = b.seconds > 0 ? Math.max(6, (b.seconds / most) * maxBarH) : 3
      roundRectPath(ctx, x, baseY - h, barW, h, Math.min(6, barW / 2))
      ctx.fillStyle = b.future ? 'rgba(255,255,255,0.08)' : i === summary.busiest ? accentCss : 'rgba(255,255,255,0.28)'
      ctx.fill()
      if (b.short) {
        ctx.fillStyle = i === summary.busiest ? accentCss : 'rgba(255,255,255,0.5)'
        ctx.font = '600 12px Inter, system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(b.short, x + barW / 2, y + chartBoxH - 12)
        ctx.textAlign = 'left'
      }
    })
  }

  y += chartBoxH + 34

  // Featured #1 track card
  const topSong = summary.topSongs[0]
  if (topSong) {
    const cardH = 136
    roundRectPath(ctx, padX, y, chartBoxW, cardH, 20)
    ctx.fillStyle = accentSoft
    ctx.fill()

    const loadedCover = await loadImageForCanvas(coverArtUrl)
    try {
      const cx = padX + 20
      const cy = y + 20
      const cs = 96
      ctx.save()
      roundRectPath(ctx, cx, cy, cs, cs, 14)
      ctx.clip()
      if (loadedCover) {
        ctx.drawImage(loadedCover.img, cx, cy, cs, cs)
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.1)'
        ctx.fillRect(cx, cy, cs, cs)
      }
      ctx.restore()
    } finally {
      loadedCover?.revoke()
    }

    const tx = padX + 136
    const maxTW = chartBoxW - 156
    ctx.fillStyle = accentCss
    ctx.font = '800 13px Inter, system-ui, sans-serif'
    ctx.fillText('TITRE N° 1', tx, y + 42)
    ctx.fillStyle = '#ffffff'
    ctx.font = '800 24px Inter, system-ui, sans-serif'
    ctx.fillText(fitText(ctx, topSong.title, maxTW), tx, y + 76)
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = '500 17px Inter, system-ui, sans-serif'
    ctx.fillText(fitText(ctx, `${topSong.artist} · ${songMeta(topSong)}`, maxTW), tx, y + 106)
    y += cardH + 32
  }

  // Two columns: Top Titres & Top Artistes
  const colGap = 28
  const colW = (chartBoxW - colGap) / 2
  const leftX = padX
  const rightX = padX + colW + colGap

  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = '700 13px Inter, system-ui, sans-serif'
  ctx.fillText('TOP TITRES', leftX, y)
  ctx.fillText('TOP ARTISTES', rightX, y)

  let ly = y + 28
  summary.topSongs.slice(0, 5).forEach((s, i) => {
    ctx.fillStyle = i === 0 ? accentCss : 'rgba(255,255,255,0.45)'
    ctx.font = '800 16px Inter, system-ui, sans-serif'
    ctx.fillText(`${i + 1}`, leftX, ly)
    ctx.fillStyle = '#ffffff'
    ctx.font = '600 16px Inter, system-ui, sans-serif'
    ctx.fillText(fitText(ctx, s.title, colW - 28), leftX + 26, ly)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = '400 13px Inter, system-ui, sans-serif'
    ctx.fillText(fitText(ctx, `${s.artist} · ${s.plays}×`, colW - 28), leftX + 26, ly + 20)
    ly += 54
  })

  let ry = y + 28
  summary.topArtists.slice(0, 5).forEach((a, i) => {
    ctx.fillStyle = i === 0 ? accentCss : 'rgba(255,255,255,0.45)'
    ctx.font = '800 16px Inter, system-ui, sans-serif'
    ctx.fillText(`${i + 1}`, rightX, ry)
    ctx.fillStyle = '#ffffff'
    ctx.font = '600 16px Inter, system-ui, sans-serif'
    ctx.fillText(fitText(ctx, a.name, colW - 28), rightX + 26, ry)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = '400 13px Inter, system-ui, sans-serif'
    ctx.fillText(fitText(ctx, durationLabel(Math.round(a.seconds / 60)), colW - 28), rightX + 26, ry + 20)
    ry += 54
  })

  // Top album highlight at bottom
  const topAlbum = summary.topAlbums[0]
  if (topAlbum) {
    const ay = H - 122
    roundRectPath(ctx, padX, ay, chartBoxW, 56, 14)
    ctx.fillStyle = 'rgba(255,255,255,0.05)'
    ctx.fill()
    ctx.fillStyle = accentCss
    ctx.font = '700 12px Inter, system-ui, sans-serif'
    ctx.fillText('ALBUM N° 1', padX + 20, ay + 24)
    ctx.fillStyle = '#ffffff'
    ctx.font = '600 16px Inter, system-ui, sans-serif'
    ctx.fillText(
      fitText(ctx, `${topAlbum.name} — ${topAlbum.artist} (${durationLabel(Math.round(topAlbum.seconds / 60))})`, chartBoxW - 40),
      padX + 20,
      ay + 44
    )
  }

  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.font = '600 13px Inter, system-ui, sans-serif'
  ctx.fillText('SelfHost Hub', padX, H - 42)

  return new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

export default function WrappedView(): JSX.Element {
  const ledger = useMergedLedger()
  const syncedDevices = useListeningStore((s) => s.devices)
  const loaded = useListeningStore((s) => s.loaded)
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const showToast = useToastStore((s) => s.show)

  const [period, setPeriod] = useState<Period>(() => periodOf('week', latestWeek(ledger, Date.now())))
  const [trail, setTrail] = useState<Period[]>([])
  const [picking, setPicking] = useState(false)
  const [initializedDefault, setInitializedDefault] = useState(false)
  const [busyCard, setBusyCard] = useState(false)

  useEffect(() => {
    flushListening()
  }, [])

  // Once saved weeks finish loading, default to the latest active week if user hasn't navigated yet.
  useEffect(() => {
    if (loaded && !initializedDefault) {
      setInitializedDefault(true)
      setPeriod(periodOf('week', latestWeek(ledger, Date.now())))
    }
  }, [loaded, initializedDefault, ledger])

  const now = Date.now()
  const today = dayKey(now)
  const summary = useMemo(() => summarizePeriod(ledger, period, Date.now()), [ledger, period])
  const range = useMemo(() => dayRange(ledger, Date.now()), [ledger, period])
  const weekly = useMemo(() => (period.kind === 'week' ? summarize(ledger, period.start) : null), [ledger, period])
  const animatedMinutes = useCountUp(summary.minutes, periodKey(period))

  const current = periodCurrent(period, now)
  const noun = periodNoun(period)
  const change = !current ? changeLabel(summary.minutes, summary.previousMinutes, noun.before) : null
  const earlier = shiftPeriod(period, -1)
  const later = shiftPeriod(period, 1)
  const canGoBack = earlier.end > range.first
  const canGoForward = later.start <= today
  const parent = trail[trail.length - 1]
  const empty = summary.minutes === 0 && summary.topSongs.length === 0

  const showPeriod = (next: Period): void => {
    flushListening()
    setPeriod(next)
    setTrail([])
  }

  const drill = (next: Period): void => {
    setPicking(false)
    setTrail((t) => [...t, period])
    setPeriod(next)
  }

  const back = (): void => {
    if (trail.length === 0) return
    setPeriod(trail[trail.length - 1])
    setTrail((t) => t.slice(0, -1))
  }

  const pickKind = (kind: PeriodKind): void => {
    if (kind === 'custom') {
      setPicking((v) => !v)
      return
    }
    setPicking(false)
    const anchor = current ? today : addDays(period.end, -1)
    showPeriod(periodOf(kind, anchor > today ? today : anchor))
  }

  const playFrom = (index: number): void => {
    if (summary.topSongs.length === 0) return
    playQueue(summary.topSongs.map(songOf), index)
  }

  const label = periodLabel(period, now)

  const handleSaveCard = async (): Promise<void> => {
    if (busyCard) return
    setBusyCard(true)
    try {
      const hero = summary.topSongs[0]
      const art = hero ? coverUrl(client, hero, 320) : summary.topArtists[0] ? coverUrl(client, summary.topArtists[0], 320) : null
      const blob = await renderCardPng(summary, label, weekly?.streakWeeks, art)
      if (!blob) {
        showToast('Impossible de générer la carte')
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `retrospective-${period.start}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showToast('Carte enregistrée')
    } finally {
      setBusyCard(false)
    }
  }

  const handleCopyCard = async (): Promise<void> => {
    if (busyCard) return
    setBusyCard(true)
    try {
      const hero = summary.topSongs[0]
      const art = hero ? coverUrl(client, hero, 320) : summary.topArtists[0] ? coverUrl(client, summary.topArtists[0], 320) : null
      const blob = await renderCardPng(summary, label, weekly?.streakWeeks, art)
      if (blob && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          showToast('Carte copiée dans le presse-papiers')
          return
        } catch {
          // Fall back to text share summary if image clipboard isn't permitted
        }
      }
      await navigator.clipboard.writeText(formatWrappedShare({ ...summary, streakWeeks: weekly?.streakWeeks }, label))
      showToast('Récapitulatif copié dans le presse-papiers')
    } catch {
      showToast('Impossible de copier le récapitulatif')
    } finally {
      setBusyCard(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-surface-base">
      <div className="mx-auto max-w-4xl space-y-6 p-6 pb-14">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {parent && (
              <button
                type="button"
                onClick={back}
                className="flex items-center gap-1.5 rounded-full bg-surface-elevated px-3 py-1.5 text-xs font-semibold text-gray-200 transition-colors hover:bg-surface-hover hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
                Retour · {periodLabel(parent, now)}
              </button>
            )}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-accent">
                {current ? `${noun.name} en cours` : `Votre récap ${noun.of}`}
              </p>
              <h1 className="text-2xl font-extrabold tracking-tight text-white">Rétrospective</h1>
            </div>
          </div>

          {!empty && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busyCard}
                onClick={() => void handleCopyCard()}
                className="flex items-center gap-2 rounded-full border border-surface-border bg-surface-elevated px-4 py-2 text-xs font-bold text-gray-200 transition-colors hover:bg-surface-hover hover:text-white disabled:opacity-50"
              >
                <Copy className="h-3.5 w-3.5" />
                Copier
              </button>
              <button
                type="button"
                disabled={busyCard}
                onClick={() => void handleSaveCard()}
                className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-xs font-bold text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                Enregistrer la carte
              </button>
            </div>
          )}
        </div>

        {/* Period tabs + nav */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex rounded-full border border-surface-border bg-surface-elevated p-1" role="tablist">
            {TABS.map((tab) => {
              const active = (picking ? 'custom' : period.kind) === tab.kind
              return (
                <button
                  key={tab.kind}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => pickKind(tab.kind)}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
                    active ? 'bg-accent text-black' : 'text-gray-300 hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canGoBack}
              onClick={() => showPeriod(earlier)}
              aria-label="Période précédente"
              className="rounded-full border border-surface-border bg-surface-elevated p-2 text-gray-200 transition-colors hover:bg-surface-hover hover:text-white disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPicking((v) => !v)}
              className="flex items-center gap-2 rounded-full border border-surface-border bg-surface-elevated px-4 py-1.5 text-sm font-bold text-white transition-colors hover:bg-surface-hover"
            >
              <span>{capitalize(label)}</span>
              <CalendarRange className="h-4 w-4 text-gray-400" />
            </button>
            <button
              type="button"
              disabled={!canGoForward}
              onClick={() => showPeriod(later)}
              aria-label="Période suivante"
              className="rounded-full border border-surface-border bg-surface-elevated p-2 text-gray-200 transition-colors hover:bg-surface-hover hover:text-white disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {syncedDevices.length > 0 && (
          <p className="text-xs text-gray-400">
            Inclut cet ordinateur et : <span className="text-gray-200">{syncedDevices.map((d) => d.deviceName).join(', ')}</span>
          </p>
        )}

        {picking && (
          <RangePicker
            initial={period}
            ledger={ledger}
            today={today}
            onCancel={() => setPicking(false)}
            onDone={(picked) => {
              setPicking(false)
              showPeriod(picked)
            }}
          />
        )}

        {empty ? (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-surface-border bg-surface-elevated px-6 py-16 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-hover text-gray-300">
              <Headphones className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-white">
              {current ? "Rien écouté pour l'instant" : 'Rien écouté sur cette période'}
            </h2>
            <p className="mt-2 max-w-md text-sm text-gray-400">
              Le récap compte ce qui est écouté sur cet ordinateur et sur vos appareils synchronisés. Changez de période avec les onglets ou les flèches.
            </p>
          </div>
        ) : (
          <>
            {/* Hero block */}
            <div className="relative overflow-hidden rounded-3xl border border-surface-border bg-surface-elevated p-6 sm:p-8">
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/20 via-accent/5 to-transparent" />
              <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="flex items-baseline gap-3">
                    <span className="text-5xl font-black tabular-nums tracking-tight text-white sm:text-6xl">
                      {animatedMinutes.toLocaleString('fr-FR')}
                    </span>
                    <span className="text-lg font-bold text-gray-200">
                      {summary.minutes > 1 ? "minutes d'écoute" : "minute d'écoute"}
                    </span>
                  </div>
                  {summary.minutes >= 60 && (
                    <p className="mt-1 text-sm text-gray-300">soit {durationLabel(summary.minutes)}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {change && (
                    <span className="rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-bold text-accent">
                      {change}
                    </span>
                  )}
                  {weekly && weekly.streakWeeks > 1 && (
                    <span className="flex items-center gap-1.5 rounded-full bg-surface-hover px-3 py-1 text-xs font-bold text-white">
                      <Flame className="h-3.5 w-3.5 text-accent" />
                      {weekly.streakWeeks} semaines de suite · {weekly.activeDays}/7 jours actifs
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Interactive chart */}
            <InteractiveChart summary={summary} onDrill={drill} />

            {/* Summary stats */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
              {summary.dailyAverage !== null && (
                <div className="rounded-2xl border border-surface-border bg-surface-elevated p-4 text-center">
                  <p className="text-lg font-extrabold tabular-nums text-white">{durationLabel(summary.dailyAverage)}</p>
                  <p className="mt-0.5 text-xs text-gray-400">par jour</p>
                </div>
              )}
              <div className="rounded-2xl border border-surface-border bg-surface-elevated p-4 text-center">
                <p className="text-lg font-extrabold tabular-nums text-white">
                  {summary.songCount.toLocaleString('fr-FR')}
                </p>
                <p className="mt-0.5 text-xs text-gray-400">{summary.songCount > 1 ? 'titres' : 'titre'}</p>
              </div>
              <div className="rounded-2xl border border-surface-border bg-surface-elevated p-4 text-center">
                <p className="text-lg font-extrabold tabular-nums text-white">
                  {summary.artistCount.toLocaleString('fr-FR')}
                </p>
                <p className="mt-0.5 text-xs text-gray-400">{summary.artistCount > 1 ? 'artistes' : 'artiste'}</p>
              </div>
              {summary.albumCount > 0 && (
                <div className="rounded-2xl border border-surface-border bg-surface-elevated p-4 text-center">
                  <p className="text-lg font-extrabold tabular-nums text-white">
                    {summary.albumCount.toLocaleString('fr-FR')}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-400">{summary.albumCount > 1 ? 'albums' : 'album'}</p>
                </div>
              )}
              <div className="rounded-2xl border border-surface-border bg-surface-elevated p-4 text-center">
                <p className="text-lg font-extrabold tabular-nums text-white">
                  {summary.plays.toLocaleString('fr-FR')}
                </p>
                <p className="mt-0.5 text-xs text-gray-400">{summary.plays > 1 ? 'écoutes' : 'écoute'}</p>
              </div>
            </div>

            {summary.partial && (
              <div className="flex items-start gap-3 rounded-2xl border border-surface-border bg-surface-elevated p-4 text-xs leading-relaxed text-gray-300">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <p>
                  Avant la mise à jour, les titres n&apos;étaient comptés que semaine par semaine : ceux de certains jours de cette période n&apos;apparaissent pas ci-dessous. Les minutes, elles, sont justes.
                </p>
              </div>
            )}

            {/* Top Titres */}
            {summary.topSongs.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-extrabold tracking-tight text-white">Top titres</h2>
                  <button
                    type="button"
                    onClick={() => playFrom(0)}
                    className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-bold text-black transition-colors hover:bg-accent-hover"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    Écouter le top {noun.of}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => playFrom(0)}
                  className="flex w-full items-center gap-4 rounded-2xl border border-accent/30 bg-surface-elevated p-4 text-left transition-colors hover:bg-surface-hover"
                >
                  <CoverTile url={coverUrl(client, summary.topSongs[0], 320)} className="h-24 w-24" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-extrabold uppercase tracking-wider text-accent">N° 1 {noun.of}</p>
                    <p className="mt-1 truncate text-lg font-extrabold text-white">{summary.topSongs[0].title}</p>
                    <p className="truncate text-sm text-gray-300">{summary.topSongs[0].artist}</p>
                    <p className="mt-1 text-xs text-gray-400">{songMeta(summary.topSongs[0])}</p>
                  </div>
                </button>

                {summary.topSongs.length > 1 && (
                  <div className="divide-y divide-surface-border overflow-hidden rounded-2xl border border-surface-border bg-surface-elevated">
                    {summary.topSongs.slice(1).map((song, i) => (
                      <button
                        key={song.id}
                        type="button"
                        onClick={() => playFrom(i + 1)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                      >
                        <span className="w-6 text-center text-sm font-extrabold tabular-nums text-gray-500">{i + 2}</span>
                        <CoverTile url={coverUrl(client, song, 160)} className="h-11 w-11" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-white">{song.title}</p>
                          <p className="truncate text-xs text-gray-400">{song.artist}</p>
                        </div>
                        <span className="shrink-0 text-xs text-gray-400">{songMeta(song)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Top Artistes & Top Albums */}
            <div className="grid gap-6 md:grid-cols-2">
              {summary.topArtists.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-lg font-extrabold tracking-tight text-white">Top artistes</h2>
                  <div className="divide-y divide-surface-border overflow-hidden rounded-2xl border border-surface-border bg-surface-elevated">
                    {summary.topArtists.map((artist: ArtistStat, i) => (
                      <div key={artist.artistId || artist.name} className="flex items-center gap-3 px-4 py-3">
                        <span className={`w-6 text-center text-sm font-extrabold tabular-nums ${i === 0 ? 'text-accent' : 'text-gray-500'}`}>
                          {i + 1}
                        </span>
                        <CoverTile url={coverUrl(client, artist, 160)} className="h-11 w-11" round icon={MicVocal} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-white">{artist.name}</p>
                          <p className="truncate text-xs text-gray-400">
                            {durationLabel(Math.round(artist.seconds / 60))} · {plural(artist.plays, 'écoute', 'écoutes')}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {summary.topAlbums.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-lg font-extrabold tracking-tight text-white">Top albums</h2>
                  <div className="divide-y divide-surface-border overflow-hidden rounded-2xl border border-surface-border bg-surface-elevated">
                    {summary.topAlbums.map((album: AlbumStat, i) => (
                      <div key={album.albumId || `${album.name}-${album.artist}`} className="flex items-center gap-3 px-4 py-3">
                        <span className={`w-6 text-center text-sm font-extrabold tabular-nums ${i === 0 ? 'text-accent' : 'text-gray-500'}`}>
                          {i + 1}
                        </span>
                        <CoverTile url={coverUrl(client, album, 160)} className="h-11 w-11" icon={Disc3} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-white">{album.name}</p>
                          <p className="truncate text-xs text-gray-400">
                            {album.artist} · {durationLabel(Math.round(album.seconds / 60))}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
