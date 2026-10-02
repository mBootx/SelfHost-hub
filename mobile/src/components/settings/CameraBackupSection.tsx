import { useEffect, useState } from 'react'
import { View, Text, TextInput, Switch, Pressable, Alert, Linking, ActivityIndicator, StyleSheet } from 'react-native'
import LegacyBackups from '@/components/photos/LegacyBackups'
import BackupAlbums from '@/components/settings/BackupAlbums'
import { SectionTitle } from '@/components/Screen'
import { DEFAULT_BACKUP_FOLDER, useCameraBackupStore } from '@/store/cameraBackupStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import {
  countCameraRoll,
  disableCameraBackup,
  enableCameraBackup,
  requestCameraRollAccess,
  retryFailedBackups,
  runCameraBackup
} from '@/services/cameraBackup'
import { expectExternalScreen } from '@/services/appLock'
import { USER_TOKEN, vaultRootFor } from '@/services/photoVault'
import { timeAgo } from '@/services/syncStatus'
import { colors, radius, spacing } from '@/constants/theme'

function openAndroidSettings(): void {
  expectExternalScreen()
  Linking.openSettings()
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
  const gaveUp = useCameraBackupStore((s) => s.gaveUp)
  const lastSuccessAt = useCameraBackupStore((s) => s.lastSuccessAt)
  const limitedAccess = useCameraBackupStore((s) => s.limitedAccess)
  const error = useCameraBackupStore((s) => s.error)
  const saveSettings = useCameraBackupStore((s) => s.saveSettings)
  const fileBrowserConnected = useFileBrowserStore((s) => s.status === 'connected')
  const client = useFileBrowserStore((s) => s.client)

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
    // A folder the vault would refuse (one that climbs out with "..", say) is never saved.
    try {
      vaultRootFor(folder, 'compte')
    } catch (err) {
      Alert.alert('Dossier invalide', err instanceof Error ? err.message : 'Ce dossier ne peut pas être utilisé.')
      setFolderDraft(settings.folder)
      return
    }
    setFolderDraft(folder)
    if (folder !== settings.folder) saveSettings({ folder })
  }

  /** Where this account's photos go, for the line under the field; null while nobody is signed in to FileBrowser. */
  let destination: { path: string } | { problem: string } | null = null
  if (client) {
    try {
      destination = { path: vaultRootFor(settings.folder, client.getAccountName()) }
    } catch (err) {
      destination = { problem: err instanceof Error ? err.message : 'Dossier invalide' }
    }
  }
  const organisedByAccount = settings.folder.includes(USER_TOKEN)

  /** Moves a folder chosen by hand onto the per-account layout; the photos already there can then be moved over. */
  function organiseByAccount(): void {
    const previous = settings.folder
    saveSettings({ folder: DEFAULT_BACKUP_FOLDER, legacyFolder: previous !== DEFAULT_BACKUP_FOLDER ? previous : settings.legacyFolder })
  }

  let status: string
  if (!settings.enabled) status = 'Désactivée'
  else if (phase === 'running' && progress) status = `Envoi ${progress.done + 1} sur ${progress.total} : ${progress.filename}`
  else if (phase === 'waiting-wifi') status = 'En attente du Wi-Fi'
  else if (phase === 'waiting-charger') status = 'En attente du chargeur'
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
          Les photos et vidéos de l&apos;appareil photo sont envoyées dans FileBrowser, dans un dossier à votre nom, rangées par
          année et par mois. En arrière-plan, Android relance la sauvegarde environ tous les quarts d&apos;heure.
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
            <Text style={styles.folderHint}>
              {USER_TOKEN} est remplacé par le nom de votre compte : chaque compte a son propre dossier, et l&apos;onglet Photos ne
              montre que le vôtre.
            </Text>
            {destination && (
              <Text style={'problem' in destination ? styles.warning : styles.destination}>
                {'problem' in destination ? `Dossier invalide : ${destination.problem}` : `Vos photos vont dans : ${destination.path}/AAAA/MM`}
              </Text>
            )}
            {!organisedByAccount && (
              <Pressable
                style={({ pressed }) => [styles.pillButton, styles.standalone, pressed && styles.pressed]}
                onPress={organiseByAccount}
                accessibilityRole="button"
                accessibilityLabel="Ranger les photos par compte"
              >
                <Text style={styles.pillText}>Ranger par compte ({DEFAULT_BACKUP_FOLDER})</Text>
              </Pressable>
            )}
            {client && destination && 'path' in destination && settings.legacyFolder ? (
              <LegacyBackups client={client} root={destination.path} />
            ) : null}
            <Text style={styles.folderHint}>
              Pour que les autres comptes ne puissent pas lire ce dossier, c&apos;est le serveur qui doit les en empêcher : limitez
              chaque compte à son dossier dans FileBrowser (la « portée » du compte).
            </Text>

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

            <View style={[styles.toggleRow, styles.toggleBelow]}>
              <View style={styles.toggleText}>
                <Text style={styles.label}>Seulement en charge</Text>
                <Text style={styles.hint}>N’envoie que lorsque le téléphone est branché : une grosse sauvegarde ne vide pas la batterie.</Text>
              </View>
              <Switch
                value={settings.chargingOnly}
                onValueChange={(chargingOnly) => {
                  saveSettings({ chargingOnly }).then(() => runCameraBackup())
                }}
                trackColor={{ false: colors.hover, true: colors.accent }}
                thumbColor="#ffffff"
                accessibilityLabel="Sauvegarder seulement en charge"
              />
            </View>

            <BackupAlbums />

            <View style={styles.divider} />
            {gaveUp > 0 && (
              <Pressable onPress={() => retryFailedBackups()} accessibilityRole="button" accessibilityLabel="Réessayer les fichiers non envoyés">
                <Text style={styles.warning}>
                  {gaveUp.toLocaleString('fr-FR')} fichier{gaveUp > 1 ? 's' : ''} que le serveur n&apos;a pas voulu{gaveUp > 1 ? 's' : ''} (trop volumineux, refusé) : touchez ici pour réessayer.
                </Text>
              </Pressable>
            )}
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
  toggleBelow: { marginTop: spacing.lg },
  toggleText: { flex: 1 },
  label: { color: colors.text, fontSize: 14, fontWeight: '600' },
  value: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm, lineHeight: 17 },
  warning: { color: colors.warning, fontSize: 12, marginTop: spacing.sm, lineHeight: 17 },
  folderHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: -spacing.xs, marginBottom: spacing.sm },
  destination: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, marginBottom: spacing.sm },
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
