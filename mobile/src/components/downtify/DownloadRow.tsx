import { useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, Alert, StyleSheet } from 'react-native'
import { Download, CircleCheck, CircleAlert } from 'lucide-react-native'
import { useDowntifyStore } from '@/store/downtifyStore'
import { DowntifySong } from '@/services/downtify'
import CoverImage from '@/components/CoverImage'
import { colors, radius, spacing } from '@/constants/theme'

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * A Downtify search hit, shown alongside the local Navidrome results. Once the
 * download is requested the row stops being a button and mirrors whatever the
 * polled queue says about it.
 */
export default function DownloadRow({ song }: { song: DowntifySong }) {
  const client = useDowntifyStore((s) => s.client)
  const queueDownload = useDowntifyStore((s) => s.queueDownload)
  const queued = useDowntifyStore((s) => s.queue.find((q) => q.song.song_id === song.song_id))
  const [pending, setPending] = useState(false)

  async function handleDownload(): Promise<void> {
    if (!client) return
    setPending(true)
    // queueDownload bootstraps the queue poll right away, so `queued` below
    // starts reflecting real progress within a second or two - it doesn't wait
    // on the request itself, which only resolves once the server has finished
    // downloading and transcoding the whole track.
    try {
      await queueDownload(song)
    } catch (err: any) {
      Alert.alert('Telechargement impossible', err?.message || 'Downtify n’a pas pu recuperer ce titre.')
    } finally {
      setPending(false)
    }
  }

  const busy = pending || queued?.status === 'downloading' || queued?.status === 'queued'
  const percent = queued?.status === 'downloading' ? Math.min(100, Math.round(queued.progress)) : 0

  return (
    <View style={styles.row}>
      <CoverImage uri={song.cover_url} style={styles.cover} iconSize={16} recyclingKey={song.song_id} />
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>
          {song.name}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {song.artists.join(', ')}
          {song.album_name ? ` · ${song.album_name}` : ''}
        </Text>
        {queued?.status === 'downloading' && (
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
        )}
      </View>

      {queued?.status === 'done' ? (
        <CircleCheck size={18} color={colors.accent} />
      ) : queued?.status === 'error' ? (
        <CircleAlert size={18} color={colors.danger} />
      ) : busy ? (
        <ActivityIndicator size="small" color={colors.accent} />
      ) : (
        <>
          <Text style={styles.duration}>{formatDuration(song.duration)}</Text>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            onPress={handleDownload}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Telecharger ${song.name}`}
          >
            <Download size={18} color={colors.textSecondary} />
          </Pressable>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.xs },
  cover: { width: 44, height: 44, borderRadius: radius.sm },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '500' },
  artist: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  duration: { color: colors.textMuted, fontSize: 12 },
  button: { padding: spacing.xs },
  pressed: { opacity: 0.6 },
  track: { height: 3, borderRadius: radius.full, backgroundColor: colors.hover, overflow: 'hidden', marginTop: spacing.xs },
  fill: { height: 3, backgroundColor: colors.downtify }
})
