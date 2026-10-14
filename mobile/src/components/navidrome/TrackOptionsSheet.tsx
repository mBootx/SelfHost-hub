import { useRouter } from 'expo-router'
import { ListEnd, ListStart, ListPlus, Disc3, Heart, Radio } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useTrackSheetStore } from '@/store/trackSheetStore'
import { isStarred, useStarStore } from '@/store/starStore'
import { usePlaylistPickerStore } from '@/store/playlistPickerStore'
import { useToastStore } from '@/store/toastStore'
import ActionSheet, { ActionSheetItem } from '@/components/ActionSheet'
import CoverImage from '@/components/CoverImage'
import { StyleSheet } from 'react-native'
import { radius } from '@/constants/theme'

/** Long-press menu for a track. Mounted once, near the tab navigator. */
export default function TrackOptionsSheet() {
  const router = useRouter()
  const song = useTrackSheetStore((s) => s.song)
  const close = useTrackSheetStore((s) => s.close)
  const client = useNavidromeStore((s) => s.client)
  const playNext = useNavidromeStore((s) => s.playNext)
  const addToQueue = useNavidromeStore((s) => s.addToQueue)
  const startRadio = useNavidromeStore((s) => s.startRadio)
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
            const ahead = playNext(song)
            showToast(ahead === 0 ? `« ${song.title} » sera lu ensuite` : `« ${song.title} » sera lu après ${ahead === 1 ? 'le titre déjà ajouté' : `les ${ahead} titres déjà ajoutés`}`)
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
          label: 'Lancer la radio',
          icon: Radio,
          onPress: async () => {
            showToast('Recherche de titres similaires…')
            const result = await startRadio(song).catch(() => 'empty' as const)
            showToast(result === 'started' ? `Radio lancée depuis « ${song.title} »` : 'Aucun titre similaire trouvé')
          }
        },
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

  const coverId = song?.coverArt || song?.albumId
  const leading = <CoverImage uri={coverId && client ? client.coverArtUrl(coverId, 120) : null} style={styles.cover} iconSize={20} recyclingKey={song?.id} />

  return <ActionSheet visible={!!song} title={song?.title} subtitle={song ? [song.artist, song.album].filter(Boolean).join(" · ") : undefined} leading={leading} items={items} onClose={close} />
}

const styles = StyleSheet.create({ cover: { width: 48, height: 48, borderRadius: radius.sm + 2 } })
