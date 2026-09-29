const NODES = [
  [212, 238],
  [346, 314],
  [212, 390]
]

/**
 * The app icon (branding/icon.svg) drawn in the current accent colour, so it follows the chosen
 * colour scheme: a roof over a play button made of three linked nodes.
 */
export default function AppLogo({ className = '' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 512 512" className={`text-accent ${className}`} aria-hidden="true">
      <defs>
        <mask id="app-logo-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" fill="#fff" />
          {NODES.map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="11" fill="#000" />
          ))}
        </mask>
      </defs>
      <rect width="512" height="512" rx="112" fill="currentColor" fillOpacity="0.14" />
      <g mask="url(#app-logo-holes)" fill="currentColor" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M128 226 L256 116 L384 226" fill="none" strokeWidth="38" />
        <path d="M212 238 L346 314 L212 390 Z" fillOpacity="0.14" strokeWidth="24" />
        {NODES.map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="31" stroke="none" />
        ))}
      </g>
    </svg>
  )
}
