import { Alert, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { HardDriveDownload, CircleCheck } from 'lucide-react-native'
import { NavidromeClient, NDSong } from '@/services/navidrome'
import { useOfflineStore } from '@/store/offlineStore'
import { colors } from '@/constants/theme'

interface Props {
  song: NDSong
  client: NavidromeClient | null
  /** Icon size; the default suits a list row. */
  size?: number
  /** Colour of the not-yet-downloaded icon: the muted grey is too dim over a coloured backdrop. */
  idleColor?: string
  /** Colour of the downloaded tick and the spinner (the cover's, on the player). */
  activeColor?: string
}

export default function OfflineButton({ song, client, size = 18, idleColor = colors.textMuted, activeColor = colors.accent }: Props) {
  const isOffline = useOfflineStore((s) => !!s.tracks[song.id])
  const downloading = useOfflineStore((s) => s.downloading[song.id])
  const downloadTrack = useOfflineStore((s) => s.downloadTrack)
  const removeOffline = useOfflineStore((s) => s.removeOffline)

  // The tick sits right next to the song's other buttons: a stray tap must not delete the file.
  function confirmRemove(): void {
    Alert.alert('Retirer du téléphone ?', `« ${song.title} » ne sera plus disponible hors ligne. Il reste sur le serveur.`, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Retirer', style: 'destructive', onPress: () => void removeOffline(song.id) }
    ])
  }

  if (downloading) {
    const percent = downloading.total > 0 ? Math.round((downloading.loaded / downloading.total) * 100) : null
    return (
      <Pressable
        style={styles.button}
        disabled
        hitSlop={8}
        accessibilityRole="progressbar"
        accessibilityLabel={percent === null ? 'Téléchargement en cours' : `Téléchargement : ${percent} %`}
      >
        <ActivityIndicator size="small" color={activeColor} />
      </Pressable>
    )
  }

  if (isOffline) {
    return (
      <Pressable style={styles.button} onPress={confirmRemove} hitSlop={8} accessibilityRole="button" accessibilityLabel="Téléchargé sur le téléphone. Retirer">
        <CircleCheck size={size} color={activeColor} />
      </Pressable>
    )
  }

  if (!client) return null

  return (
    <Pressable
      style={styles.button}
      onPress={() => void downloadTrack(song, client)}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Télécharger pour l'écoute hors ligne"
    >
      <HardDriveDownload size={size} color={idleColor} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 4, paddingVertical: 4 }
})
