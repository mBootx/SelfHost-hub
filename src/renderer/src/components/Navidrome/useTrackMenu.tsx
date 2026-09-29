import { useState } from 'react'
import { ListEnd, ListStart, ListPlus, Heart } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useToastStore } from '@renderer/store/toastStore'
import { NDSong } from '@renderer/services/navidrome'
import ContextMenu from '@renderer/components/ContextMenu'
import AddToPlaylistModal from './AddToPlaylistModal'

/**
 * Right-click queue actions for a track row. Returns the handler to attach and
 * the menu element to render - one menu per list, not one per row.
 */
export function useTrackMenu(): {
  onContextMenu: (e: React.MouseEvent, song: NDSong) => void
  menu: JSX.Element | null
} {
  const playNext = useNavidromeStore((s) => s.playNext)
  const addToQueue = useNavidromeStore((s) => s.addToQueue)
  const client = useNavidromeStore((s) => s.client)
  const showToast = useToastStore((s) => s.show)
  const [state, setState] = useState<{ x: number; y: number; song: NDSong } | null>(null)
  const [addToPlaylistSong, setAddToPlaylistSong] = useState<NDSong | null>(null)

  function onContextMenu(e: React.MouseEvent, song: NDSong): void {
    e.preventDefault()
    e.stopPropagation()
    setState({ x: e.clientX, y: e.clientY, song })
  }

  const menu =
    state || addToPlaylistSong ? (
      <>
        {state && (
          <ContextMenu
            x={state.x}
            y={state.y}
            onClose={() => setState(null)}
            items={[
              {
                label: 'Lire ensuite',
                icon: ListStart,
                onClick: () => {
                  playNext(state.song)
                  showToast(`"${state.song.title}" sera lu ensuite`)
                }
              },
              {
                label: 'Ajouter à la file',
                icon: ListEnd,
                onClick: () => {
                  addToQueue([state.song])
                  showToast('Ajouté à la file de lecture')
                }
              },
              { label: 'Ajouter à une playlist', icon: ListPlus, onClick: () => setAddToPlaylistSong(state.song) },
              {
                label: state.song.starred ? 'Retirer des favoris' : 'Ajouter aux favoris',
                icon: Heart,
                onClick: async () => {
                  if (!client) return
                  if (state.song.starred) await client.unstar(state.song.id)
                  else await client.star(state.song.id)
                  showToast(state.song.starred ? 'Retiré des favoris' : 'Ajouté aux favoris')
                }
              }
            ]}
          />
        )}
        {addToPlaylistSong && <AddToPlaylistModal songs={[addToPlaylistSong]} onClose={() => setAddToPlaylistSong(null)} />}
      </>
    ) : null

  return { onContextMenu, menu }
}
