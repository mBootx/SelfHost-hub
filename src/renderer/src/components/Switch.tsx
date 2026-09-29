interface Props {
  checked: boolean
  onChange: (on: boolean) => void
  label: string
}

export default function Switch({ checked, onChange, label }: Props): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-hover'}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      {/* left-0.5 anchors the knob: without it, it starts from the button's centred content and
          slides past the right edge when switched on. */}
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}
