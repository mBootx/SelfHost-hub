import { useEffect, useMemo, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, Alert, ActivityIndicator, Switch, StyleSheet } from 'react-native'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { Music, FolderOpen, Download, HardDriveDownload, Heart, Check, Cast, RefreshCw, Sparkles, Server, Activity, ListMusic } from 'lucide-react-native'
import { installedVersion } from '@/services/appUpdate'
import { syncKeptPlaylists } from '@/services/keptPlaylists'
import { useIsOwner } from '@/hooks/useIsOwner'
import { useWhatsNewStore } from '@/store/whatsNewStore'
import AppearanceSection from '@/components/settings/AppearanceSection'
import TabAnimationSection from '@/components/settings/TabAnimationSection'
import PlaybackSection from '@/components/settings/PlaybackSection'
import CarModeSection from '@/components/settings/CarModeSection'
import CoverStorageRow from '@/components/settings/CoverStorageRow'
import CameraBackupSection from '@/components/settings/CameraBackupSection'
import AppLockSection from '@/components/settings/AppLockSection'
import WatchSection from '@/components/settings/WatchSection'
import { useUpdateStore } from '@/store/updateStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { offlineBytes, useOfflineStore } from '@/store/offlineStore'
import { useRemoteStore } from '@/store/remoteStore'
import { DowntifySettings } from '@/services/downtify'
import { plural } from '@/services/plural'
import { GroupLabel, RowButton, SettingsCard, SettingsRow } from '@/components/settings/SettingsKit'
import { SETTINGS_SECTIONS, SettingsSectionId, isSettingsSection } from '@/components/settings/sections'
import { colors, layout, radius, spacing } from '@/constants/theme'

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

function ServicesPage() {
  const router = useRouter()
  const isOwner = useIsOwner()
  const navidromeStatus = useNavidromeStore((s) => s.status)
  const navidromeUsername = useNavidromeStore((s) => s.username)
  const navidromeLogout = useNavidromeStore((s) => s.logout)
  const fileBrowserStatus = useFileBrowserStore((s) => s.status)
  const fileBrowserLogout = useFileBrowserStore((s) => s.logout)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const downtifyLogout = useDowntifyStore((s) => s.logout)
  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const remoteStatus = useRemoteStore((s) => s.status)

  return (
    <>
      <GroupLabel>Connexions</GroupLabel>
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
      </SettingsCard>

      <GroupLabel>Contrôle à distance</GroupLabel>
      <SettingsCard>
        <SettingsRow
          icon={Cast}
          title="Appareils"
          meta={
            !remoteEnabled ? 'Contrôle à distance désactivé' : remoteStatus === 'connected' ? 'Contrôle à distance : connecté au PC' : remoteStatus === 'connecting' ? 'Recherche en cours…' : 'Activé, non connecté'
          }
          onPress={() => router.push('/devices')}
          accessibilityLabel="Contrôle à distance"
        />
      </SettingsCard>

      {/* The server dashboard and the playlists of the accounts: only for the account that runs the server. */}
      {isOwner && (
        <>
          <GroupLabel>Administration</GroupLabel>
          <SettingsCard>
            <SettingsRow icon={Server} title="Serveur" meta="État des services, stockage, scan, réveil à distance" onPress={() => router.push('/server')} />
            {navidromeStatus === 'connected' ? (
              <SettingsRow icon={ListMusic} title="Playlists des comptes" meta="Attribuer chaque playlist à son compte, la rendre modifiable" onPress={() => router.push('/playlists-admin')} />
            ) : null}
          </SettingsCard>
        </>
      )}
    </>
  )
}

function DowntifyPage() {
  const router = useRouter()
  const downtifyClient = useDowntifyStore((s) => s.client)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const downtifyQueue = useDowntifyStore((s) => s.queue)
  const [dtSettings, setDtSettings] = useState<DowntifySettings | null>(null)
  const [dtSettingsError, setDtSettingsError] = useState<string | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)

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

  if (downtifyStatus !== 'connected') {
    return (
      <View style={styles.card}>
        <Text style={styles.rowMeta}>Downtify n’est pas connecté : connectez-le depuis la page Services.</Text>
      </View>
    )
  }

  const activeDownloads = downtifyQueue.filter((q) => q.status === 'downloading' || q.status === 'queued').length

  return (
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

      <GroupLabel>Options des fichiers</GroupLabel>
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
  )
}

function AppearancePage() {
  return (
    <>
      <GroupLabel>Couleurs et fond</GroupLabel>
      <AppearanceSection />
      <GroupLabel>Animation des onglets</GroupLabel>
      <TabAnimationSection />
    </>
  )
}

function ChipPicker<T extends number>({
  title,
  hint,
  options,
  value,
  onSelect
}: {
  title: string
  hint: string
  options: readonly { label: string; value: T }[]
  value: T
  onSelect: (value: T) => void
}) {
  return (
    <View style={styles.pickerBlock}>
      <Text style={styles.pickerTitle}>{title}</Text>
      <View style={styles.chips}>
        {options.map((opt) => {
          const selected = value === opt.value
          return (
            <Pressable
              key={opt.value}
              onPress={() => onSelect(opt.value)}
              style={[styles.chip, selected && styles.chipSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${title} : ${opt.label}`}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt.label}</Text>
            </Pressable>
          )
        })}
      </View>
      <Text style={styles.rowMeta}>{hint}</Text>
    </View>
  )
}

const CACHE_LIMIT_OPTIONS = [
  { label: 'Illimité', value: 0 },
  { label: '512 Mo', value: 512 },
  { label: '1 Go', value: 1024 },
  { label: '2 Go', value: 2048 },
  { label: '5 Go', value: 5120 },
  { label: '10 Go', value: 10240 }
] as const

const PRE_CACHE_OPTIONS = [
  { label: 'Désactivé', value: 0 },
  { label: '3 titres', value: 3 },
  { label: '5 titres', value: 5 },
  { label: '10 titres', value: 10 }
] as const

function StoragePage() {
  const offlineTracks = useOfflineStore((s) => s.tracks)
  const removeOffline = useOfflineStore((s) => s.removeOffline)
  const keepFavorites = useOfflineStore((s) => s.keepFavorites)
  const setKeepFavorites = useOfflineStore((s) => s.setKeepFavorites)
  const maxCacheMb = useOfflineStore((s) => s.maxCacheMb)
  const setMaxCacheMb = useOfflineStore((s) => s.setMaxCacheMb)
  const preCacheCount = useOfflineStore((s) => s.preCacheCount)
  const setPreCacheCount = useOfflineStore((s) => s.setPreCacheCount)
  const offlineIds = Object.keys(offlineTracks)
  const keptCount = useOfflineStore((s) => Object.keys(s.keptPlaylists).length)
  // The room the downloaded songs take: measured again when the list changes.
  const offlineSize = useMemo(() => offlineBytes(offlineTracks), [offlineTracks])
  const capText = maxCacheMb > 0 ? formatMegabytes(maxCacheMb * 1024 * 1024) : null
  const usageText = capText ? `${formatMegabytes(offlineSize)} / ${capText}` : `${formatMegabytes(offlineSize)} sur ce téléphone`

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

  return (
    <>
      <GroupLabel>Titres hors ligne</GroupLabel>
      <SettingsCard>
        <SettingsRow
          icon={HardDriveDownload}
          title="Titres hors ligne"
          meta={
            (offlineIds.length === 0
              ? capText
                ? `Aucun titre téléchargé (${usageText})`
                : 'Aucun titre téléchargé'
              : `${plural(offlineIds.length, 'titre', 'titres')} · ${usageText}`) +
            (keptCount > 0 ? ` · ${plural(keptCount, 'playlist gardée', 'playlists gardées')}` : '')
          }
          right={offlineIds.length > 0 ? <RowButton label="Vider" danger onPress={confirmClearOffline} accessibilityLabel="Vider les titres hors ligne" /> : undefined}
        />
        <SettingsRow
          icon={Heart}
          title="Garder les titres aimés hors ligne"
          meta="Télécharge automatiquement vos favoris en Wi-Fi."
          right={
            <Switch
              value={keepFavorites}
              onValueChange={(next) => {
                setKeepFavorites(next)
                if (next) void syncKeptPlaylists(true)
              }}
              trackColor={{ false: colors.hover, true: colors.accent }}
              thumbColor="#ffffff"
              accessibilityLabel="Garder les titres aimés hors ligne"
            />
          }
        />
      </SettingsCard>
      <GroupLabel>Cache automatique</GroupLabel>
      <View style={styles.card}>
        <ChipPicker
          title="Limite du cache auto"
          hint="Supprime les titres pré-chargés les moins écoutés si la limite est dépassée. Les téléchargements manuels, playlists gardées et favoris restent conservés."
          options={CACHE_LIMIT_OPTIONS}
          value={maxCacheMb}
          onSelect={setMaxCacheMb}
        />
        <View style={styles.pickerDivider} />
        <ChipPicker
          title="Pré-chargement en Wi-Fi"
          hint="Télécharge automatiquement les prochains titres de la file d’attente lorsque vous êtes en Wi-Fi."
          options={PRE_CACHE_OPTIONS}
          value={preCacheCount}
          onSelect={setPreCacheCount}
        />
      </View>
      <GroupLabel>Pochettes</GroupLabel>
      <CoverStorageRow />
    </>
  )
}

function AboutPage() {
  const router = useRouter()
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

  return (
    <>
      <GroupLabel>Version</GroupLabel>
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
      </SettingsCard>
      <GroupLabel>Dépannage</GroupLabel>
      <SettingsCard>
        <SettingsRow icon={Activity} title="Diagnostic" meta="État des serveurs et de la sauvegarde, journal des erreurs, rapport à copier." onPress={() => router.push('/diagnostics')} />
      </SettingsCard>
    </>
  )
}

function SectionContent({ id }: { id: SettingsSectionId }) {
  switch (id) {
    case 'services':
      return <ServicesPage />
    case 'lecture':
      return <PlaybackSection />
    case 'downtify':
      return <DowntifyPage />
    case 'apparence':
      return <AppearancePage />
    case 'voiture':
      return <CarModeSection />
    case 'montre':
      return <WatchSection />
    case 'photos':
      return <CameraBackupSection />
    case 'verrouillage':
      return <AppLockSection />
    case 'stockage':
      return <StoragePage />
    case 'apropos':
      return <AboutPage />
  }
}

export default function SettingsSectionScreen() {
  const { section } = useLocalSearchParams<{ section: string }>()
  const navigation = useNavigation()
  const id = isSettingsSection(section) ? section : null

  useEffect(() => {
    navigation.setOptions({ title: id ? SETTINGS_SECTIONS[id].title : 'Réglages' })
  }, [id])

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {id ? (
        <>
          <Text style={styles.intro}>{SETTINGS_SECTIONS[id].intro}</Text>
          <SectionContent id={id} />
        </>
      ) : (
        <Text style={styles.intro}>Cette page de réglages n’existe pas.</Text>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  intro: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: spacing.xs },
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
  saveButtonText: { color: colors.onAccent, fontWeight: '800', fontSize: 14 },
  pickerBlock: { gap: spacing.xs },
  pickerTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  pickerDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  chip: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full, backgroundColor: colors.hover },
  chipSelected: { backgroundColor: colors.accent },
  chipText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  chipTextSelected: { color: colors.onAccent }
})
