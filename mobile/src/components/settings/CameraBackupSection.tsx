import { useEffect, useState } from 'react'
import { View, Text, TextInput, Switch, Pressable, Alert, Linking, ActivityIndicator, StyleSheet } from 'react-native'
import { SectionTitle } from '@/components/Screen'
import { DEFAULT_BACKUP_FOLDER, useCameraBackupStore } from '@/store/cameraBackupStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import {
  countCameraRoll,
  disableCameraBackup,
  enableCameraBackup,
  requestCameraRollAccess,
  runCameraBackup
} from '@/services/cameraBackup'
import { expectExternalScreen } from '@/services/appLock'
import { colors, radius, spacing } from '@/constants/theme'

function openAndroidSettings(): void {
  expectExternalScreen()
  Linking.openSettings()
}

function timeAgo(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  return `il y a ${Math.round(hours / 24)} j`
}

function normalizeFolder(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_BACKUP_FOLDER
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export default function CameraBackupSection() {
  const settings = useCameraBackupStore((s) => s.settings)
  const phase = useCameraBackupStore((s) => s.phase)
  const progress = useCameraBackupStore((s) => s.progress)
  const pending = useCameraBackupStore((s) => s.pending)
  const uploadedTotal = useCameraBackupStore((s) => s.uploadedTotal)
  const lastSuccessAt = useCameraBackupStore((s) => s.lastSuccessAt)
  const limitedAccess = useCameraBackupStore((s) => s.limitedAccess)
  const error = useCameraBackupStore((s) => s.error)
  const saveSettings = useCameraBackupStore((s) => s.saveSettings)
  const fileBrowserConnected = useFileBrowserStore((s) => s.status === 'connected')

  const [folderDraft, setFolderDraft] = useState(settings.folder)
  const [busy, setBusy] = useState(false)
  useEffect(() => setFolderDraft(settings.folder), [settings.folder])

  async function turnOn(): Promise<void> {
    if (!fileBrowserConnected) {
      Alert.alert('FileBrowser', "Connectez-vous d'abord à FileBrowser : c'est là que les photos sont envoyées.")
      return
    }
    setBusy(true)
    try {
      if (!(await requestCameraRollAccess())) {
        Alert.alert('Accès aux photos', 'Sans accès aux photos et vidéos, la sauvegarde ne peut pas fonctionner.', [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Ouvrir les réglages', onPress: openAndroidSettings }
        ])
        return
      }
      const existing = await countCameraRoll().catch(() => 0)
      if (existing === 0) {
        await enableCameraBackup(false)
        return
      }
      Alert.alert(
        'Photos déjà sur le téléphone',
        `L'appareil photo contient déjà ${existing.toLocaleString('fr-FR')} photos et vidéos. Les sauvegarder aussi, ou seulement les prochaines ?`,
        [
          { text: 'Les prochaines', onPress: () => enableCameraBackup(false) },
          { text: 'Tout sauvegarder', onPress: () => enableCameraBackup(true) }
        ],
        { cancelable: true }
      )
    } finally {
      setBusy(false)
    }
  }

  async function grantAccess(): Promise<void> {
    if (await requestCameraRollAccess()) runCameraBackup()
    else openAndroidSettings()
  }

  function saveFolder(): void {
    const folder = normalizeFolder(folderDraft)
    setFolderDraft(folder)
    if (folder !== settings.folder) saveSettings({ folder })
  }

  let status: string
  if (!settings.enabled) status = 'Désactivée'
  else if (phase === 'running' && progress) status = `Envoi ${progress.done + 1} sur ${progress.total} : ${progress.filename}`
  else if (phase === 'waiting-wifi') status = 'En attente du Wi-Fi'
  else if (phase === 'no-permission') status = 'Accès aux photos refusé'
  else if (phase === 'no-server') status = error ? `FileBrowser injoignable : ${error}` : 'FileBrowser non connecté'
  else if (phase === 'error') status = `Interrompue : ${error || 'erreur inconnue'}`
  else if (pending) status = `${pending.toLocaleString('fr-FR')} en attente`
  else status = lastSuccessAt ? `À jour - dernier envoi ${timeAgo(lastSuccessAt)}` : 'À jour'

  return (
    <>
      <View style={styles.sectionGap}>
        <SectionTitle>Sauvegarde des photos</SectionTitle>
      </View>
      <View style={styles.card}>
        <View style={styles.toggleRow}>
          <View style={styles.toggleText}>
            <Text style={styles.label}>Sauvegarde automatique</Text>
            <Text style={styles.value} numberOfLines={2}>
              {status}
            </Text>
          </View>
          {busy ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Switch
              value={settings.enabled}
              onValueChange={(on) => (on ? turnOn() : disableCameraBackup())}
              trackColor={{ false: colors.hover, true: colors.accent }}
              thumbColor="#ffffff"
              accessibilityLabel="Sauvegarde automatique des photos"
            />
          )}
        </View>
        <Text style={styles.hint}>
          Les photos et vidéos de l&apos;appareil photo sont envoyées dans FileBrowser, rangées par année et par mois. En
          arrière-plan, Android relance la sauvegarde environ tous les quarts d&apos;heure.
        </Text>

        {settings.enabled && (
          <>
            {phase === 'no-permission' && (
              <Pressable
                style={({ pressed }) => [styles.pillButton, styles.standalone, styles.pillPrimary, pressed && styles.pressed]}
                onPress={grantAccess}
                accessibilityRole="button"
                accessibilityLabel="Autoriser l'accès aux photos"
              >
                <Text style={[styles.pillText, { color: '#000' }]}>Autoriser l&apos;accès aux photos</Text>
              </Pressable>
            )}
            {limitedAccess && phase !== 'no-permission' && (
              <Pressable onPress={openAndroidSettings} accessibilityRole="button">
                <Text style={styles.warning}>
                  Accès limité aux photos choisies : seules celles-ci sont sauvegardées. Touchez ici pour autoriser toutes
                  les photos dans les réglages Android.
                </Text>
              </Pressable>
            )}

            <View style={styles.divider} />
            <Text style={styles.fieldLabel}>Dossier sur le serveur</Text>
            <TextInput
              style={styles.input}
              value={folderDraft}
              onChangeText={setFolderDraft}
              onEndEditing={saveFolder}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Dossier de sauvegarde sur le serveur"
            />

            <View style={styles.toggleRow}>
              <View style={styles.toggleText}>
                <Text style={styles.label}>Wi-Fi uniquement</Text>
                <Text style={styles.hint}>Les vidéos peuvent être lourdes pour un forfait mobile.</Text>
              </View>
              <Switch
                value={settings.wifiOnly}
                onValueChange={(wifiOnly) => {
                  saveSettings({ wifiOnly }).then(() => runCameraBackup())
                }}
                trackColor={{ false: colors.hover, true: colors.accent }}
                thumbColor="#ffffff"
                accessibilityLabel="Sauvegarder en Wi-Fi uniquement"
              />
            </View>

            <View style={styles.divider} />
            <View style={styles.toggleRow}>
              <Text style={[styles.value, styles.toggleText]}>
                {uploadedTotal === 0
                  ? 'Aucun fichier envoyé pour le moment'
                  : `${uploadedTotal.toLocaleString('fr-FR')} fichier${uploadedTotal > 1 ? 's' : ''} sauvegardé${uploadedTotal > 1 ? 's' : ''}`}
              </Text>
              <Pressable
                style={({ pressed }) => [styles.pillButton, (phase === 'running' || pressed) && styles.pressed]}
                onPress={() => runCameraBackup()}
                disabled={phase === 'running'}
                accessibilityRole="button"
                accessibilityLabel="Sauvegarder maintenant"
              >
                <Text style={styles.pillText}>Sauvegarder maintenant</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  sectionGap: { marginTop: spacing.lg },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  toggleText: { flex: 1 },
  label: { color: colors.text, fontSize: 14, fontWeight: '600' },
  value: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm, lineHeight: 17 },
  warning: { color: colors.warning, fontSize: 12, marginTop: spacing.sm, lineHeight: 17 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  fieldLabel: { color: colors.textSecondary, fontSize: 12, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 14,
    marginBottom: spacing.md
  },
  pillButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border
  },
  standalone: { alignSelf: 'flex-start', marginTop: spacing.sm },
  pillPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.6 }
})
