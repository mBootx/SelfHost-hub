import { Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { HardDriveDownload, CircleCheck } from 'lucide-react-native'
import { NavidromeClient, NDSong } from '@/services/navidrome'
import { useOfflineStore } from '@/store/offlineStore'
import { colors } from '@/constants/theme'

interface Props {
  song: NDSong
  client: NavidromeClient
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

  if (downloading) {
    return (
      <Pressable style={styles.button} disabled hitSlop={8}>
        <ActivityIndicator size="small" color={activeColor} />
      </Pressable>
    )
  }

  if (isOffline) {
    return (
      <Pressable style={styles.button} onPress={() => removeOffline(song.id)} hitSlop={8}>
        <CircleCheck size={size} color={activeColor} />
      </Pressable>
    )
  }

  return (
    <Pressable style={styles.button} onPress={() => downloadTrack(song, client)} hitSlop={8}>
      <HardDriveDownload size={size} color={idleColor} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 4, paddingVertical: 4 }
})
