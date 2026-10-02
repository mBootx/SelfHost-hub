import { useEffect, useRef } from 'react'
import { View, Text, StyleSheet, Pressable } from 'react-native'
import { Upload, CircleCheck, CircleAlert, X } from 'lucide-react-native'
import { useUploadStore } from '@/store/uploadStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { colors, layout, radius, spacing } from '@/constants/theme'

function formatSpeed(bps: number): string {
  return `${(bps / (1024 * 1024)).toFixed(1)} Mo/s`
}

export default function UploadToast({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const tasks = useUploadStore((s) => s.tasks)
  const dismiss = useUploadStore((s) => s.dismiss)
  const hasMiniPlayer = useNavidromeStore((s) => s.queue.length > 0)
  const autoDismissed = useRef<Set<string>>(new Set())

  useEffect(() => {
    tasks.forEach((t) => {
      if (t.status === 'done' && !autoDismissed.current.has(t.id)) {
        autoDismissed.current.add(t.id)
        setTimeout(() => dismiss(t.id), 3000)
      }
    })
  }, [tasks, dismiss])

  if (tasks.length === 0) return null
  const visible = tasks.slice(-3)

  return (
    <View
      style={[styles.container, { bottom: bottomOffset + (hasMiniPlayer ? layout.miniPlayer : 0) + spacing.sm }]}
      pointerEvents="box-none"
    >
      {visible.map((t) => {
        const percent = t.sizeBytes ? Math.min(100, Math.round((t.loaded / t.sizeBytes) * 100)) : 0
        return (
          <View key={t.id} style={styles.card}>
            <View style={styles.row}>
              {(t.status === 'uploading' || t.status === 'queued') && <Upload size={14} color={t.status === 'queued' ? colors.textMuted : colors.accent} />}
              {t.status === 'done' && <CircleCheck size={14} color={colors.accent} />}
              {t.status === 'error' && <CircleAlert size={14} color={colors.danger} />}
              <Text style={styles.filename} numberOfLines={1}>
                {t.filename}
              </Text>
              <Pressable onPress={() => dismiss(t.id)} hitSlop={8}>
                <X size={14} color={colors.textMuted} />
              </Pressable>
            </View>
            {t.status === 'error' ? (
              <Text style={styles.error} numberOfLines={1}>
                {t.error}
              </Text>
            ) : (
              <>
                <View style={styles.track}>
                  <View style={[styles.fill, { width: `${t.status === 'done' ? 100 : percent}%` }]} />
                </View>
                <Text style={styles.meta}>
                  {t.status === 'done' ? 'Terminé' : t.status === 'queued' ? 'En attente' : `${percent}%${t.speedBps > 0 ? ` - ${formatSpeed(t.speedBps)}` : ''}`}
                </Text>
              </>
            )}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    gap: spacing.xs
  },
  card: {
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs
  },
  filename: {
    flex: 1,
    color: colors.text,
    fontSize: 12,
    fontWeight: '500'
  },
  track: {
    height: 4,
    borderRadius: radius.full,
    backgroundColor: colors.hover,
    overflow: 'hidden'
  },
  fill: {
    height: 4,
    backgroundColor: colors.accent
  },
  meta: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 4
  },
  error: {
    color: colors.danger,
    fontSize: 11
  }
})
