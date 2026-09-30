import { useRouter } from 'expo-router'
import { ListEnd, ListStart, ListPlus, Disc3, Heart } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useTrackSheetStore } from '@/store/trackSheetStore'
import { isStarred, useStarStore } from '@/store/starStore'
import { usePlaylistPickerStore } from '@/store/playlistPickerStore'
import { useToastStore } from '@/store/toastStore'
import ActionSheet, { ActionSheetItem } from '@/components/ActionSheet'

/** Long-press menu for a track. Mounted once, near the tab navigator. */
export default function TrackOptionsSheet() {
  const router = useRouter()
  const song = useTrackSheetStore((s) => s.song)
  const close = useTrackSheetStore((s) => s.close)
  const client = useNavidromeStore((s) => s.client)
  const playNext = useNavidromeStore((s) => s.playNext)
  const addToQueue = useNavidromeStore((s) => s.addToQueue)
  const openPlaylistPicker = usePlaylistPickerStore((s) => s.open)
  const showToast = useToastStore((s) => s.show)
  const starred = useStarStore((s) => (song ? isStarred(s, song) : false))
  const toggleStar = useStarStore((s) => s.toggle)

  const items: ActionSheetItem[] = song
    ? [
        {
          label: 'Lire ensuite',
          icon: ListStart,
          onPress: () => {
            playNext(song)
            showToast(`"${song.title}" sera lu ensuite`)
          }
        },
        {
          label: 'Ajouter à la file',
          icon: ListEnd,
          onPress: () => {
            addToQueue([song])
            showToast('Ajouté à la file de lecture')
          }
        },
        { label: 'Ajouter à une playlist', icon: ListPlus, onPress: () => openPlaylistPicker(song) },
        {
          label: starred ? 'Retirer des favoris' : 'Ajouter aux favoris',
          icon: Heart,
          onPress: async () => {
            if (!client) return
            if (await toggleStar(song, client)) showToast(starred ? 'Retiré des favoris' : 'Ajouté aux favoris')
          }
        },
        ...(song.albumId
          ? [
              {
                label: "Voir l'album",
                icon: Disc3,
                onPress: () => router.push({ pathname: '/album/[id]', params: { id: song.albumId! } })
              }
            ]
          : [])
      ]
    : []

  return <ActionSheet visible={!!song} title={song?.title} items={items} onClose={close} />
}
