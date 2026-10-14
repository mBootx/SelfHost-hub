import { ReactNode, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import AppLogo from '@renderer/components/AppLogo'

type IconComponent = React.ComponentType<{ className?: string }>

/**
 * The pieces of the Settings page. Their colours are the theme's (accent, surface-*), so a colour change in
 * Apparence reaches all of them; the tinted tiles and chips are the accent at a low opacity.
 */

/** A small label over a group of rows. */
export function GroupLabel({ children }: { children: ReactNode }): JSX.Element {
  return <h2 className="mb-2.5 ml-1 text-xs font-bold uppercase tracking-widest text-gray-400">{children}</h2>
}

/** Rows in one rounded card, a hairline between them. */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`divide-y divide-surface-border overflow-hidden rounded-2xl bg-surface-elevated ${className}`}>{children}</div>
}

/** An icon in a rounded tile tinted with `tone` (a Tailwind text colour on a tinted background; the accent by default). */
export function Tile({ icon: Icon, tone = 'bg-accent/15 text-accent' }: { icon: IconComponent; tone?: string }): JSX.Element {
  return (
    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
      <Icon className="h-5 w-5" />
    </div>
  )
}

export function Row({
  icon,
  tone,
  title,
  meta,
  right,
  onClick
}: {
  icon: IconComponent
  tone?: string
  title: string
  meta?: ReactNode
  right?: ReactNode
  onClick?: () => void
}): JSX.Element {
  const body = (
    <>
      <Tile icon={icon} tone={tone} />
      <div className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-semibold">{title}</p>
        {meta && <p className="text-xs leading-relaxed text-gray-400">{meta}</p>}
      </div>
      {right}
    </>
  )
  const base = 'flex w-full items-center gap-4 px-4 py-3.5'
  return onClick ? (
    <button onClick={onClick} className={`${base} transition-colors hover:bg-surface-hover`}>
      {body}
    </button>
  ) : (
    <div className={base}>{body}</div>
  )
}

/** A small button at the right of a row. */
export function PillButton({
  children,
  onClick,
  primary,
  danger,
  disabled
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
}): JSX.Element {
  const look = primary
    ? 'bg-accent text-black hover:bg-accent-hover'
    : danger
      ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
      : 'bg-surface-hover text-gray-200 hover:bg-surface-border hover:text-white'
  return (
    <button onClick={onClick} disabled={disabled} className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-50 ${look}`}>
      {children}
    </button>
  )
}

/** The top of the page: the app, its version, and which services answer, on a wash of the accent colour. */
export function Hero({ version, chips, notice }: { version: string; chips: { label: string; on: boolean }[]; notice?: ReactNode }): JSX.Element {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-surface-border bg-surface-elevated p-6">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/30 via-accent/5 to-transparent" />
      <div className="relative flex items-center gap-4">
        <AppLogo className="h-16 w-16 shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold tracking-tight">SelfHost Hub</h1>
          <p className="text-sm text-gray-400">{version ? `Version ${version}` : 'Réglages'}</p>
        </div>
        {notice}
      </div>
      <div className="relative mt-5 flex flex-wrap gap-2">
        {chips.map((chip) => (
          <span
            key={chip.label}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
              chip.on ? 'border-accent/40 bg-accent/10 text-white' : 'border-surface-border bg-surface-raised text-gray-400'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${chip.on ? 'bg-accent' : 'bg-gray-600'}`} />
            {chip.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** A group folded under one row: open it to see what is in it. */
export function Fold({
  icon: Icon,
  title,
  summary,
  defaultOpen = false,
  children
}: {
  icon: IconComponent
  title: string
  summary?: string
  defaultOpen?: boolean
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`overflow-hidden rounded-2xl bg-surface-elevated ${open ? 'ring-1 ring-accent/30' : ''}`}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-surface-hover"
      >
        <Tile icon={Icon} tone={open ? 'bg-accent/25 text-accent' : 'bg-accent/15 text-accent'} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          {summary && <p className="truncate text-xs text-gray-400">{summary}</p>}
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="space-y-6 bg-surface-raised p-4">{children}</div>}
    </div>
  )
}
