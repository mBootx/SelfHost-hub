import { useEffect, useRef, useState } from 'react'

export interface ContextMenuItem {
  label: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  danger?: boolean
  separatorBefore?: boolean
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, visible: false })

  useEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    const width = rect?.width || 190
    const height = rect?.height || items.length * 34 + 16
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
      visible: true
    })
  }, [x, y])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    function onScroll(): void {
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={(e) => {
        // Releasing the right mouse button right after the row's onContextMenu
        // opened this overlay makes Chromium synthesize a click (button === 2)
        // on whatever now sits under the cursor - this backdrop. Without this
        // check that closed the menu in the same gesture that opened it, before
        // an actual (left-button) click on an item could ever land.
        if (e.button === 0) onClose()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={ref}
        style={{ left: pos.left, top: pos.top, opacity: pos.visible ? 1 : 0 }}
        className="absolute min-w-[190px] rounded-lg border border-surface-border bg-surface-elevated py-1.5 shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {items.map(({ label, icon: Icon, onClick, danger, separatorBefore }, i) => (
          <div key={i}>
            {separatorBefore && <div className="my-1 border-t border-surface-border" />}
            <button
              onClick={() => {
                onClick()
                onClose()
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors ${
                danger ? 'text-red-400 hover:bg-red-500/10' : 'text-gray-200 hover:bg-surface-hover'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
