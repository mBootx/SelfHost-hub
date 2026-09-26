import { HardDrive } from 'lucide-react'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

export default function UsageMeter(): JSX.Element | null {
  const usage = useFileBrowserStore((s) => s.usage)

  if (!usage || !usage.total) return null

  const barColor = usage.usedPercentage >= 90 ? 'bg-red-500' : usage.usedPercentage >= 75 ? 'bg-yellow-500' : 'bg-accent'

  return (
    <div className="flex items-center gap-3 rounded-lg bg-surface-elevated px-4 py-2.5">
      <HardDrive className="h-4 w-4 shrink-0 text-gray-400" />
      <div className="min-w-[180px] flex-1">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-400">
          <span className="truncate">{usage.name}</span>
          <span className="shrink-0 font-medium text-gray-300">
            {formatGb(usage.used)} Go / {formatGb(usage.total)} Go
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(100, usage.usedPercentage)}%` }}
          />
        </div>
      </div>
      <span className="shrink-0 text-xs font-semibold text-gray-300">{usage.usedPercentage}%</span>
    </div>
  )
}
