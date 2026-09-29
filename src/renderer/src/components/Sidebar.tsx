import { NavLink, useLocation } from 'react-router-dom'
import { Music, FolderOpen, Settings, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useUIStore } from '@renderer/store/uiStore'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import AppLogo from './AppLogo'

// Downtify has no destination of its own: its search folds into Navidrome's and
// its queue/options live in Reglages, which also shows every service's status.
const NAV_ITEMS = [
  { to: '/navidrome', label: 'Navidrome', icon: Music },
  { to: '/filebrowser', label: 'FileBrowser', icon: FolderOpen },
  { to: '/settings', label: 'Réglages', icon: Settings }
]

function StatusDot({ status }: { status: string }): JSX.Element {
  const color =
    status === 'connected' ? 'bg-accent' : status === 'connecting' ? 'bg-yellow-500' : 'bg-transparent'
  return <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
}

function PlayingIndicator({ title }: { title: string }): JSX.Element {
  return (
    <span className="flex h-3 shrink-0 items-end gap-[2px]" title={title}>
      <span className="eq-bar h-full w-[3px] rounded-sm bg-accent" style={{ animationDelay: '0ms' }} />
      <span className="eq-bar h-full w-[3px] rounded-sm bg-accent" style={{ animationDelay: '180ms' }} />
      <span className="eq-bar h-full w-[3px] rounded-sm bg-accent" style={{ animationDelay: '360ms' }} />
    </span>
  )
}

export default function Sidebar(): JSX.Element {
  const { sidebarCollapsed, toggleSidebar } = useUIStore()
  const navidromeStatus = useNavidromeStore((s) => s.status)
  const filebrowserStatus = useFileBrowserStore((s) => s.status)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const currentSong = useNavidromeStore((s) => s.queue[s.queueIndex] || null)
  const location = useLocation()
  const onNavidromeTab = location.pathname.startsWith('/navidrome')

  // Reglages shows a dot only when something there needs attention, which for now
  // means Downtify: it's the one service with no screen of its own.
  const statuses: Record<string, string> = {
    '/navidrome': navidromeStatus,
    '/filebrowser': filebrowserStatus,
    '/settings': downtifyStatus
  }

  const showBackgroundPlayback = isPlaying && !!currentSong && !onNavidromeTab

  return (
    <aside
      className={`flex h-full flex-col border-r border-surface-border bg-surface-raised transition-all duration-200 ${
        sidebarCollapsed ? 'w-[72px]' : 'w-[220px]'
      }`}
    >
      <div className="flex items-center gap-2 px-4 py-5">
        <AppLogo className="h-8 w-8 shrink-0" />
        {!sidebarCollapsed && <span className="truncate font-semibold tracking-tight">SelfHost Hub</span>}
      </div>

      <nav className="flex-1 space-y-1 px-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
          const showIndicator = to === '/navidrome' && showBackgroundPlayback
          return (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                  isActive
                    ? 'bg-surface-hover text-white'
                    : 'text-gray-400 hover:bg-surface-hover hover:text-white hover:translate-x-0.5'
                }`
              }
              title={showIndicator ? `${label} - lecture en cours : ${currentSong?.title}` : label}
            >
              <span className="relative shrink-0">
                <Icon className="h-5 w-5 transition-transform duration-150 group-hover:scale-110" />
                {showIndicator && sidebarCollapsed && (
                  <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-surface-raised">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  </span>
                )}
              </span>
              {!sidebarCollapsed && <span className="flex-1 truncate">{label}</span>}
              {!sidebarCollapsed && (showIndicator ? <PlayingIndicator title="Lecture en arrière-plan" /> : <StatusDot status={statuses[to]} />)}
            </NavLink>
          )
        })}
      </nav>

      <button
        onClick={toggleSidebar}
        className="mx-2 mb-4 flex items-center justify-center gap-2 rounded-md py-2 text-gray-400 transition-colors hover:bg-surface-hover hover:text-white"
      >
        {sidebarCollapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
        {!sidebarCollapsed && <span className="text-xs">Réduire</span>}
      </button>
    </aside>
  )
}
