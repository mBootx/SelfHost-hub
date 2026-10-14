import { useEffect, useMemo, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, Alert, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Music, FolderOpen, Download, HardDriveDownload, Check, Cast, RefreshCw, Sparkles, Server, Activity, ListMusic, Palette, SlidersHorizontal, Car, Watch, ImageUp, Lock } from 'lucide-react-native'
import { installedVersion } from '@/services/appUpdate'
import { useIsOwner } from '@/hooks/useIsOwner'
import { useWhatsNewStore } from '@/store/whatsNewStore'
import AppearanceSection from '@/components/settings/AppearanceSection'
import PlaybackSection from '@/components/settings/PlaybackSection'
import CarModeSection from '@/components/settings/CarModeSection'
import CoverStorageRow from '@/components/settings/CoverStorageRow'
import CameraBackupSection from '@/components/settings/CameraBackupSection'
import AppLockSection from '@/components/settings/AppLockSection'
import WatchSection from '@/components/settings/WatchSection'
import WrappedSection from '@/components/settings/WrappedSection'
import { useUpdateStore } from '@/store/updateStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { offlineBytes, useOfflineStore } from '@/store/offlineStore'
import { useRemoteStore } from '@/store/remoteStore'
import { DowntifySettings } from '@/services/downtify'
import { plural } from '@/services/plural'
import { Screen, ScreenHeader } from '@/components/Screen'
import { GroupLabel, RowButton, SettingsCard, SettingsGroup, SettingsHero, SettingsRow } from '@/components/settings/SettingsKit'
import { ACCENT_PRESETS, BACKGROUNDS, appearance, colors, layout, radius, spacing } from '@/constants/theme'

/** A size in Mo or Go, as the storage rows show it. */
function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1).replace('.', ',')} Go`
  return mb >= 10 ? `${Math.round(mb)} Mo` : `${mb.toFixed(1).replace('.', ',')} Mo`
}

/** Signing out forgets the password saved on the phone: a stray tap on the button must not do that. */
function confirmLogout(name: string, logout: () => void): void {
  Alert.alert(`Se déconnecter de ${name} ?`, 'Le mot de passe enregistré sur ce téléphone sera effacé : il faudra le saisir de nouveau.', [
    { text: 'Annuler', style: 'cancel' },
    { text: 'Se déconnecter', style: 'destructive', onPress: logout }
  ])
}

export default function SettingsTab() {
  const router = useRouter()
  const isOwner = useIsOwner()
  const navidromeStatus = useNavidromeStore((s) => s.status)
  const navidromeUsername = useNavidromeStore((s) => s.username)
  const navidromeLogout = useNavidromeStore((s) => s.logout)
  const fileBrowserStatus = useFileBrowserStore((s) => s.status)
  const fileBrowserLogout = useFileBrowserStore((s) => s.logout)

  const downtifyClient = useDowntifyStore((s) => s.client)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const downtifyLogout = useDowntifyStore((s) => s.logout)
  const downtifyQueue = useDowntifyStore((s) => s.queue)

  const offlineTracks = useOfflineStore((s) => s.tracks)
  const removeOffline = useOfflineStore((s) => s.removeOffline)
  const offlineIds = Object.keys(offlineTracks)
  const keptCount = useOfflineStore((s) => Object.keys(s.keptPlaylists).length)
  // The room the downloaded songs take: measured again when the list changes.
  const offlineSize = useMemo(() => offlineBytes(offlineTracks), [offlineTracks])

  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const remoteStatus = useRemoteStore((s) => s.status)

  const [dtSettings, setDtSettings] = useState<DowntifySettings | null>(null)
  const [dtSettingsError, setDtSettingsError] = useState<string | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)

  const updatePhase = useUpdateStore((s) => s.phase)
  const availableUpdate = useUpdateStore((s) => s.update)
  const checkForUpdate = useUpdateStore((s) => s.check)
  const showWhatsNew = useWhatsNewStore((s) => s.showAll)
  const [updateMessage, setUpdateMessage] = useState('Vérifiées au démarrage, au plus une fois par heure.')

  async function handleCheckUpdate(): Promise<void> {
    const outcome = await checkForUpdate(true)
    if (outcome === 'current') setUpdateMessage('Vous avez la dernière version.')
    else if (outcome === 'error') setUpdateMessage('Vérification impossible (hors ligne ?).')
  }

  useEffect(() => {
    setDtSettings(null)
    setDtSettingsError(null)
    if (!downtifyClient) return
    let cancelled = false
    downtifyClient
      .getSettings()
      .then((settings) => {
        if (!cancelled) setDtSettings(settings)
      })
      .catch((err) => {
        if (!cancelled) setDtSettingsError(err instanceof Error && err.message ? err.message : 'Downtify ne répond pas')
      })
    return () => {
      cancelled = true
    }
  }, [downtifyClient])

  async function saveDowntifySettings(): Promise<void> {
    if (!downtifyClient || !dtSettings) return
    setSavingSettings(true)
    try {
      await downtifyClient.updateSettings(dtSettings)
      Alert.alert('Options', 'Enregistrées avec succès.')
    } catch (err: any) {
      Alert.alert('Erreur', err?.message || 'Enregistrement impossible')
    } finally {
      setSavingSettings(false)
    }
  }

  function confirmClearOffline(): void {
    Alert.alert(
      'Vider les titres hors ligne ?',
      offlineIds.length > 1 ? `Les ${offlineIds.length} titres téléchargés seront supprimés de ce téléphone.` : 'Le titre téléchargé sera supprimé de ce téléphone.',
      [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: () => {
          offlineIds.forEach((id) => removeOffline(id))
        }
      }
      ]
    )
  }

  const activeDownloads = downtifyQueue.filter((q) => q.status === 'downloading' || q.status === 'queued').length
  const accentName = ACCENT_PRESETS.find((p) => p.hex.toLowerCase() === appearance.accent.toLowerCase())?.label ?? 'Perso'

  return (
    <Screen>
      <ScreenHeader title="Réglages" />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <SettingsHero
          version={installedVersion()}
          chips={[
            { label: 'Navidrome', on: navidromeStatus === 'connected' },
            { label: 'FileBrowser', on: fileBrowserStatus === 'connected' },
            { label: 'Downtify', on: downtifyStatus === 'connected' },
            { label: 'PC', on: remoteEnabled && remoteStatus === 'connected' }
          ]}
          notice={availableUpdate ? { text: `Mettre à jour vers la version ${availableUpdate.version}`, onPress: handleCheckUpdate } : undefined}
        />

        <GroupLabel>Services</GroupLabel>
        <SettingsCard>
          <SettingsRow
            icon={Music}
            title="Navidrome"
            meta={navidromeStatus === 'connected' ? `Connecté en tant que ${navidromeUsername}` : 'Non connecté'}
            right={navidromeStatus === 'connected' ? <RowButton label="Déconnexion" onPress={() => confirmLogout('Navidrome', navidromeLogout)} accessibilityLabel="Se déconnecter de Navidrome" /> : undefined}
          />
          <SettingsRow
            icon={FolderOpen}
            tone={colors.filebrowser}
            title="FileBrowser"
            meta={fileBrowserStatus === 'connected' ? 'Connecté' : 'Non connecté'}
            right={fileBrowserStatus === 'connected' ? <RowButton label="Déconnexion" onPress={() => confirmLogout('FileBrowser', fileBrowserLogout)} accessibilityLabel="Se déconnecter de FileBrowser" /> : undefined}
          />
          <SettingsRow
            icon={Download}
            tone={colors.downtify}
            title="Downtify"
            meta={downtifyStatus === 'connected' ? 'Résultats intégrés à la recherche' : 'Non connecté'}
            right={
              downtifyStatus === 'connected' ? (
                <RowButton label="Déconnexion" onPress={downtifyLogout} accessibilityLabel="Se déconnecter de Downtify" />
              ) : (
                <RowButton label="Connecter" primary onPress={() => router.push('/downtify/connect')} accessibilityLabel="Se connecter à Downtify" />
              )
            }
          />
          <SettingsRow
            icon={Cast}
            title="Appareils"
            meta={
              !remoteEnabled ? 'Contrôle à distance désactivé' : remoteStatus === 'connected' ? 'Contrôle à distance : connecté au PC' : remoteStatus === 'connecting' ? 'Recherche en cours…' : 'Activé, non connecté'
            }
            onPress={() => router.push('/devices')}
            accessibilityLabel="Contrôle à distance"
          />
          {/* The server dashboard and the playlists of the accounts: only for the account that runs the server. */}
          {isOwner && <SettingsRow icon={Server} title="Serveur" meta="État des services, stockage, scan, réveil à distance" onPress={() => router.push('/server')} />}
          {isOwner && navidromeStatus === 'connected' && (
            <SettingsRow icon={ListMusic} title="Playlists des comptes" meta="Attribuer chaque playlist à son compte, la rendre modifiable" onPress={() => router.push('/playlists-admin')} />
          )}
        </SettingsCard>

        {downtifyStatus === 'connected' && (
          <>
            <GroupLabel>Téléchargements</GroupLabel>
            <SettingsCard>
              <SettingsRow
                icon={Download}
                tone={colors.downtify}
                title="File de téléchargement"
                meta={activeDownloads > 0 ? `${activeDownloads} en cours` : downtifyQueue.length > 0 ? `${downtifyQueue.length} dans l'historique` : 'Aucun téléchargement'}
                onPress={() => router.push('/downtify/queue')}
                accessibilityLabel="Voir la file de téléchargement"
              />
            </SettingsCard>
            <View style={styles.gap} />
            {dtSettings ? (
              <View style={styles.card}>
                <Text style={styles.fieldLabel}>Format</Text>
                <TextInput style={styles.input} value={dtSettings.format} onChangeText={(v) => setDtSettings({ ...dtSettings, format: v })} autoCapitalize="none" accessibilityLabel="Format" selectionColor={colors.accent} />
                <Text style={styles.fieldLabel}>Qualité (kb/s)</Text>
                <TextInput style={styles.input} value={dtSettings.bitrate} onChangeText={(v) => setDtSettings({ ...dtSettings, bitrate: v })} autoCapitalize="none" accessibilityLabel="Qualité en kb/s" selectionColor={colors.accent} />
                <Text style={styles.fieldLabel}>Format du nom de fichier</Text>
                <TextInput style={styles.input} value={dtSettings.output} onChangeText={(v) => setDtSettings({ ...dtSettings, output: v })} autoCapitalize="none" accessibilityLabel="Format du nom de fichier" selectionColor={colors.accent} />
                <Pressable
                  style={({ pressed }) => [styles.saveButton, (savingSettings || pressed) && styles.pressed]}
                  onPress={saveDowntifySettings}
                  disabled={savingSettings}
                  accessibilityRole="button"
                  accessibilityLabel="Enregistrer les options"
                >
                  {savingSettings ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <>
                      <Check size={16} color={colors.onAccent} />
                      <Text style={styles.saveButtonText}>Enregistrer</Text>
                    </>
                  )}
                </Pressable>
              </View>
            ) : dtSettingsError ? (
              <View style={styles.card}>
                <Text style={styles.rowMeta}>Options de Downtify indisponibles : {dtSettingsError}</Text>
              </View>
            ) : (
              <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.lg }} />
            )}
          </>
        )}

        <GroupLabel>Écoute</GroupLabel>
        <WrappedSection />

        <GroupLabel>Personnaliser</GroupLabel>
        <SettingsGroup icon={Palette} title="Apparence" summary={`${accentName} · ${BACKGROUNDS[appearance.background].label}`}>
          <AppearanceSection />
        </SettingsGroup>
        <SettingsGroup icon={SlidersHorizontal} title="Lecture et égaliseur" summary="Fondu enchaîné, volume constant, égaliseur">
          <PlaybackSection />
        </SettingsGroup>
        <SettingsGroup icon={Car} title="Mode voiture" summary="Gestes de la main, gros boutons">
          <CarModeSection />
        </SettingsGroup>

        <GroupLabel>Appareils et sécurité</GroupLabel>
        <SettingsGroup icon={Watch} title="Montre" summary="Envoyer la bibliothèque à la montre">
          <WatchSection />
        </SettingsGroup>
        <SettingsGroup icon={ImageUp} title="Sauvegarde des photos" summary="Envoi automatique vers FileBrowser">
          <CameraBackupSection />
        </SettingsGroup>
        <SettingsGroup icon={Lock} title="Verrouillage" summary="Code, schéma ou empreinte à l'ouverture">
          <AppLockSection />
        </SettingsGroup>

        <GroupLabel>Stockage</GroupLabel>
        <SettingsCard>
          <SettingsRow
            icon={HardDriveDownload}
            title="Titres hors ligne"
            meta={
              (offlineIds.length === 0 ? 'Aucun titre téléchargé' : `${plural(offlineIds.length, 'titre', 'titres')} · ${formatMegabytes(offlineSize)} sur ce téléphone`) +
              (keptCount > 0 ? ` · ${plural(keptCount, 'playlist gardée', 'playlists gardées')}` : '')
            }
            right={offlineIds.length > 0 ? <RowButton label="Vider" danger onPress={confirmClearOffline} accessibilityLabel="Vider les titres hors ligne" /> : undefined}
          />
        </SettingsCard>
        <View style={styles.gap} />
        <CoverStorageRow />

        <GroupLabel>Application</GroupLabel>
        <SettingsCard>
          <SettingsRow
            icon={RefreshCw}
            title={`SelfHost Hub v${installedVersion()}`}
            meta={updatePhase === 'checking' ? 'Recherche…' : availableUpdate ? `Version ${availableUpdate.version} disponible.` : updateMessage}
            right={
              <RowButton
                label="Rechercher"
                onPress={handleCheckUpdate}
                disabled={updatePhase === 'checking' || updatePhase === 'downloading' || updatePhase === 'installing'}
                accessibilityLabel="Rechercher des mises à jour"
              />
            }
          />
          <SettingsRow icon={Sparkles} title="Nouveautés" meta="Ce qui a changé dans les dernières versions." onPress={showWhatsNew} />
          <SettingsRow icon={Activity} title="Diagnostic" meta="État des serveurs et de la sauvegarde, journal des erreurs, rapport à copier." onPress={() => router.push('/diagnostics')} />
        </SettingsCard>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  gap: { height: spacing.sm },
  pressed: { opacity: 0.6 },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  card: { backgroundColor: colors.elevated, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.sm },
  fieldLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.text,
    fontSize: 14,
    marginBottom: spacing.md
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingVertical: spacing.md
  },
  saveButtonText: { color: colors.onAccent, fontWeight: '800', fontSize: 14 }
})
