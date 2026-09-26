import { Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { HardDriveDownload, CircleCheck } from 'lucide-react-native'
import { NavidromeClient, NDSong } from '@/services/navidrome'
import { useOfflineStore } from '@/store/offlineStore'
import { colors } from '@/constants/theme'

interface Props {
  song: NDSong
  client: NavidromeClient
}

export default function OfflineButton({ song, client }: Props) {
  const isOffline = useOfflineStore((s) => !!s.tracks[song.id])
  const downloading = useOfflineStore((s) => s.downloading[song.id])
  const downloadTrack = useOfflineStore((s) => s.downloadTrack)
  const removeOffline = useOfflineStore((s) => s.removeOffline)

  if (downloading) {
    return (
      <Pressable style={styles.button} disabled hitSlop={8}>
        <ActivityIndicator size="small" color={colors.accent} />
      </Pressable>
    )
  }

  if (isOffline) {
    return (
      <Pressable style={styles.button} onPress={() => removeOffline(song.id)} hitSlop={8}>
        <CircleCheck size={18} color={colors.accent} />
      </Pressable>
    )
  }

  return (
    <Pressable style={styles.button} onPress={() => downloadTrack(song, client)} hitSlop={8}>
      <HardDriveDownload size={18} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 4, paddingVertical: 4 }
})
