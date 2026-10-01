import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { FolderInput } from 'lucide-react-native'
import type { FileBrowserClient } from '@/services/filebrowser'
import { hasBackups, migrateBackups } from '@/services/photoVault'
import { useCameraBackupStore } from '@/store/cameraBackupStore'
import { usePhotosStore } from '@/store/photosStore'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  client: FileBrowserClient
  /** The account's own backup folder, where the old photos are moved to. */
  root: string
}

const NEWLINE = String.fromCharCode(10)

/**
 * Shown in the backup settings while an older backup folder (from before backups were kept per account) still
 * has photos in it. Those photos already appear in the Photos tab, so nothing depends on this: moving them is
 * only tidying up, and the user's call. They are moved rather than copied, into the same year/month folders,
 * without overwriting anything.
 */
export default function LegacyBackups({ client, root }: Props) {
  const legacyFolder = useCameraBackupStore((s) => s.settings.legacyFolder)
  const saveSettings = useCameraBackupStore((s) => s.saveSettings)
  const [found, setFound] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    let stale = false
    setFound(false)
    if (legacyFolder) {
      hasBackups(client, legacyFolder).then((yes) => {
        if (!stale) setFound(yes)
      })
    }
    return () => {
      stale = true
    }
  }, [client, legacyFolder])

  if (!legacyFolder || !found) return null
  const folder = legacyFolder

  async function run(): Promise<void> {
    cancelled.current = false
    setProgress({ done: 0, total: 0 })
    try {
      const report = await migrateBackups(client, folder, root, {
        onProgress: (done, total) => setProgress({ done, total }),
        isCancelled: () => cancelled.current
      })
      const lines = [`${report.moved} fichier${report.moved > 1 ? 's' : ''} déplacé${report.moved > 1 ? 's' : ''}.`]
      if (report.skipped > 0) lines.push(`${report.skipped} déjà présent${report.skipped > 1 ? 's' : ''} dans votre dossier : laissé${report.skipped > 1 ? 's' : ''} dans l'ancien dossier.`)
      if (report.failed > 0) lines.push(`${report.failed} échec${report.failed > 1 ? 's' : ''}${report.errors[0] ? ` (${report.errors[0]})` : ''}.`)
      if (report.cancelled) lines.push('Déplacement interrompu : vous pouvez le reprendre.')
      Alert.alert(report.failed > 0 || report.cancelled ? 'Déplacement incomplet' : 'Déplacement terminé', lines.join(NEWLINE))
      if (!report.cancelled && report.failed === 0 && report.skipped === 0) await saveSettings({ legacyFolder: null })
    } catch (err) {
      Alert.alert('Déplacement impossible', err instanceof Error ? err.message : 'Erreur inconnue')
    } finally {
      setProgress(null)
      // The Photos tab reads the folders again the next time it is shown.
      usePhotosStore.getState().reset()
      hasBackups(client, folder).then(setFound)
    }
  }

  function ask(): void {
    Alert.alert(
      'Ranger les anciennes sauvegardes',
      `Les photos et vidéos de « ${folder} » seront déplacées (pas copiées) vers « ${root} », dans les mêmes dossiers par année et par mois. Rien n'est écrasé.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Ranger', onPress: run }
      ]
    )
  }

  return (
    <View style={styles.box}>
      <FolderInput size={20} color={colors.accent} />
      <View style={styles.text}>
        <Text style={styles.title}>Anciennes sauvegardes</Text>
        <Text style={styles.hint}>
          {progress
            ? progress.total > 0
              ? `Déplacement : ${progress.done} sur ${progress.total}`
              : 'Préparation du déplacement…'
            : `Des photos sont encore dans « ${folder} ». Elles apparaissent déjà dans l'onglet Photos ; vous pouvez aussi les ranger dans votre dossier.`}
        </Text>
      </View>
      {progress ? (
        <Pressable onPress={() => (cancelled.current = true)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Interrompre le déplacement">
          <ActivityIndicator color={colors.accent} />
        </Pressable>
      ) : (
        <Pressable style={styles.primary} onPress={ask} accessibilityRole="button" accessibilityLabel="Ranger les anciennes sauvegardes">
          <Text style={styles.primaryText}>Ranger</Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.raised
  },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 13, fontWeight: '700' },
  hint: { color: colors.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 17 },
  primary: { backgroundColor: colors.accent, borderRadius: radius.full, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2 },
  primaryText: { color: '#000000', fontSize: 12, fontWeight: '800' }
})
