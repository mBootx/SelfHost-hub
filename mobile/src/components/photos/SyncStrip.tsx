import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import type { LucideIcon } from 'lucide-react-native'
import { CircleCheck, CloudOff, CloudUpload, TriangleAlert, WifiOff } from 'lucide-react-native'
import { backupOverMobileData, retryFailedBackups, runCameraBackup } from '@/services/cameraBackup'
import { describeSync, SyncAction, SyncKind } from '@/services/syncStatus'
import { useCameraBackupStore } from '@/store/cameraBackupStore'
import { colors, radius, spacing } from '@/constants/theme'

const ICONS: Record<SyncKind, LucideIcon> = {
  off: CloudOff,
  checking: CloudUpload,
  running: CloudUpload,
  'waiting-wifi': WifiOff,
  'no-permission': TriangleAlert,
  'no-server': CloudOff,
  error: TriangleAlert,
  pending: CloudUpload,
  failed: TriangleAlert,
  ok: CircleCheck
}

const TINTS: Record<SyncKind, string> = {
  off: colors.textMuted,
  checking: colors.textSecondary,
  running: colors.accent,
  'waiting-wifi': colors.warning,
  'no-permission': colors.warning,
  'no-server': colors.warning,
  error: colors.warning,
  pending: colors.textSecondary,
  failed: colors.warning,
  ok: colors.textMuted
}

const ACTION_LABELS: Record<SyncAction, string> = {
  enable: 'Activer',
  'send-now': 'Envoyer',
  'send-anyway': 'Envoyer quand même',
  'allow-access': 'Autoriser',
  retry: 'Réessayer',
  'retry-failed': 'Réessayer'
}

/**
 * Where the photo backup stands, right above the gallery: a photo missing from the grid is explained here
 * (still on the phone, waiting for Wi-Fi, refused by the server, backup off) and can be sent from here.
 */
export default function SyncStrip() {
  const router = useRouter()
  const enabled = useCameraBackupStore((s) => s.settings.enabled)
  const phase = useCameraBackupStore((s) => s.phase)
  const progress = useCameraBackupStore((s) => s.progress)
  const pending = useCameraBackupStore((s) => s.pending)
  const gaveUp = useCameraBackupStore((s) => s.gaveUp)
  const error = useCameraBackupStore((s) => s.error)
  const lastSuccessAt = useCameraBackupStore((s) => s.lastSuccessAt)
  const lastCheckAt = useCameraBackupStore((s) => s.lastCheckAt)

  const sync = describeSync({ enabled, phase, progress, pending, gaveUp, error, lastSuccessAt, checked: lastCheckAt !== null })
  const Icon = ICONS[sync.kind]
  const busy = sync.kind === 'running' || sync.kind === 'checking'

  function act(action: SyncAction): void {
    switch (action) {
      case 'enable':
      case 'allow-access':
        router.navigate('/settings')
        break
      case 'send-anyway':
        void backupOverMobileData()
        break
      case 'retry-failed':
        void retryFailedBackups()
        break
      default:
        void runCameraBackup()
    }
  }

  return (
    <View style={styles.strip} accessibilityRole="summary" accessibilityLabel={`${sync.title}${sync.hint ? `. ${sync.hint}` : ''}`}>
      {busy ? <ActivityIndicator size="small" color={TINTS[sync.kind]} /> : <Icon size={18} color={TINTS[sync.kind]} />}
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {sync.title}
        </Text>
        {sync.hint ? (
          <Text style={styles.hint} numberOfLines={2}>
            {sync.hint}
          </Text>
        ) : null}
      </View>
      {sync.action ? (
        <Pressable style={styles.action} onPress={() => act(sync.action!)} hitSlop={6} accessibilityRole="button" accessibilityLabel={ACTION_LABELS[sync.action]}>
          <Text style={styles.actionText}>{ACTION_LABELS[sync.action]}</Text>
        </Pressable>
      ) : null}
      {sync.fraction !== null ? (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.max(2, Math.round(sync.fraction * 100))}%` }]} />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    backgroundColor: colors.elevated,
    overflow: 'hidden'
  },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 13, fontWeight: '700' },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 16, marginTop: 1 },
  action: { borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2 },
  actionText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, backgroundColor: colors.hover },
  fill: { height: 2, backgroundColor: colors.accent }
})
