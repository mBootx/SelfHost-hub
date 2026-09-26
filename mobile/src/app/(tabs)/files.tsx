import { useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useDownloadStore } from '@/store/downloadStore'
import LoginScreen from '@/components/filebrowser/LoginScreen'
import ExplorerScreen from '@/components/filebrowser/ExplorerScreen'
import DownloadsList from '@/components/filebrowser/DownloadsList'
import { Screen } from '@/components/Screen'
import { colors, radius, spacing } from '@/constants/theme'

type Pane = 'server' | 'downloads'

export default function FilesTab() {
  const status = useFileBrowserStore((s) => s.status)
  const downloadCount = useDownloadStore((s) => s.files.length)
  const [pane, setPane] = useState<Pane>('server')

  if (status === 'connecting') {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </Screen>
    )
  }

  // Downloads are local files, so they stay reachable even when the server is
  // unreachable - that's most of the point of having saved them.
  if (status !== 'connected' && pane === 'server') {
    return (
      <Screen>
        {downloadCount > 0 && (
          <Pressable
            onPress={() => setPane('downloads')}
            style={({ pressed }) => [styles.offlineLink, pressed && styles.pressed]}
          >
            <Text style={styles.offlineLinkText}>Voir mes {downloadCount} fichiers telecharges</Text>
          </Pressable>
        )}
        <LoginScreen />
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.segments}>
        {(
          [
            ['server', 'Serveur'],
            ['downloads', downloadCount > 0 ? `Telechargements (${downloadCount})` : 'Telechargements']
          ] as [Pane, string][]
        ).map(([key, label]) => {
          const active = pane === key
          return (
            <Pressable
              key={key}
              onPress={() => setPane(key)}
              style={[styles.segment, active && styles.segmentActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      {pane === 'downloads' ? <DownloadsList /> : <ExplorerScreen />}
    </Screen>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  segments: {
    flexDirection: 'row',
    backgroundColor: colors.raised,
    borderRadius: radius.full,
    padding: 3,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.sm
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.full },
  segmentActive: { backgroundColor: colors.accent },
  segmentText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: '#000' },
  offlineLink: { alignSelf: 'center', paddingVertical: spacing.sm },
  offlineLinkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.6 }
})
