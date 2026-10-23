import { useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CloudOff, RefreshCw } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import ReconnectPanel from '@/components/ReconnectPanel'
import LoginScreen from './LoginScreen'
import { colors, radius, spacing } from '@/constants/theme'

export default function NavidromeGate({ children }: { children: React.ReactNode }) {
  const status = useNavidromeStore((s) => s.status)
  const error = useNavidromeStore((s) => s.error)
  const savedSession = useNavidromeStore((s) => s.savedSession)
  const restoreSession = useNavidromeStore((s) => s.restoreSession)
  const playlistsCount = useNavidromeStore((s) => s.playlists.length)
  const downloaded = useOfflineStore((s) => Object.keys(s.tracks).length)
  const cachedPlaylists = useOfflineStore((s) => Object.keys(s.playlistCache).length)
  const keptPlaylists = useOfflineStore((s) => Object.keys(s.keptPlaylists).length)
  const insets = useSafeAreaInsets()
  const [switching, setSwitching] = useState(false)
  const [forceOffline, setForceOffline] = useState(false)
  const [retrying, setRetrying] = useState(false)

  if (status === 'connected') return <>{children}</>
  // Connecting, or the app has just started and hasn't looked for a saved login yet: no login form flashes by.
  if (status === 'connecting' || (status === 'disconnected' && savedSession === null)) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }
  if (status === 'error' && savedSession && !switching) {
    const hasOfflineContent = downloaded > 0 || cachedPlaylists > 0 || keptPlaylists > 0 || playlistsCount > 0 || forceOffline
    if (hasOfflineContent) {
      return (
        <View style={styles.root}>
          <View style={[styles.offlineBanner, { marginTop: insets.top + spacing.xs }]}>
            <CloudOff size={15} color={colors.warning} />
            <Text style={styles.offlineText} numberOfLines={1}>
              Hors ligne · Playlists et titres téléchargés disponibles
            </Text>
            <Pressable
              style={({ pressed }) => [styles.retryPill, (pressed || retrying) && styles.pressed]}
              onPress={async () => {
                setRetrying(true)
                try {
                  await restoreSession()
                } finally {
                  setRetrying(false)
                }
              }}
              disabled={retrying}
              accessibilityRole="button"
              accessibilityLabel="Réessayer de joindre Navidrome"
            >
              <RefreshCw size={12} color={colors.text} />
              <Text style={styles.retryText}>{retrying ? '…' : 'Réessayer'}</Text>
            </Pressable>
          </View>
          <View style={styles.body}>{children}</View>
        </View>
      )
    }
    return (
      <ReconnectPanel
        service="Navidrome"
        error={error}
        onRetry={restoreSession}
        onSwitch={() => setSwitching(true)}
        onOffline={() => setForceOffline(true)}
        hint={downloaded > 0 ? "Les titres téléchargés de la file d'attente se lisent toujours." : undefined}
      />
    )
  }
  return <LoginScreen />
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  body: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.base },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.border
  },
  offlineText: { flex: 1, color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  retryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.hover,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5
  },
  retryText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  pressed: { opacity: 0.6 }
})
