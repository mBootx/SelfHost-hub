import { useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, Alert, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Music, FolderOpen, Download, HardDriveDownload, ChevronRight, Check, Cast, RefreshCw } from 'lucide-react-native'
import { installedVersion } from '@/services/appUpdate'
import AppearanceSection from '@/components/settings/AppearanceSection'
import PlaybackSection from '@/components/settings/PlaybackSection'
import { useUpdateStore } from '@/store/updateStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useRemoteStore } from '@/store/remoteStore'
import { DowntifySettings } from '@/services/downtify'
import { Screen, ScreenHeader, SectionTitle } from '@/components/Screen'
import { colors, layout, radius, spacing } from '@/constants/theme'

type IconComponent = React.ComponentType<{ size?: number; color?: string }>

function ServiceRow({
  icon: Icon,
  iconColor,
  accent,
  name,
  connected,
  subtitle,
  onLogout,
  onConnect
}: {
  icon: IconComponent
  iconColor: string
  accent: string
  name: string
  connected: boolean
  subtitle: string
  onLogout: () => void
  /** Only the services without a tab of their own need an entry point here. */
  onConnect?: () => void
}) {
  return (
    <View style={styles.row}>
      <View style={[styles.iconWrap, { backgroundColor: accent }]}>
        <Icon size={20} color={iconColor} />
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle}>{name}</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: connected ? colors.accent : colors.textMuted }]} />
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </View>
      {connected ? (
        <Pressable
          style={({ pressed }) => [styles.pillButton, pressed && styles.pressed]}
          onPress={onLogout}
          accessibilityRole="button"
          accessibilityLabel={`Se deconnecter de ${name}`}
        >
          <Text style={styles.pillText}>Deconnexion</Text>
        </Pressable>
      ) : onConnect ? (
        <Pressable
          style={({ pressed }) => [styles.pillButton, styles.pillPrimary, pressed && styles.pressed]}
          onPress={onConnect}
          accessibilityRole="button"
          accessibilityLabel={`Se connecter a ${name}`}
        >
          <Text style={[styles.pillText, { color: '#000' }]}>Connecter</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export default function SettingsTab() {
  const router = useRouter()
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

  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const remoteStatus = useRemoteStore((s) => s.status)

  const [dtSettings, setDtSettings] = useState<DowntifySettings | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)

  const updatePhase = useUpdateStore((s) => s.phase)
  const availableUpdate = useUpdateStore((s) => s.update)
  const checkForUpdate = useUpdateStore((s) => s.check)
  const [updateMessage, setUpdateMessage] = useState('Verifiees au demarrage, au plus une fois par heure.')

  async function handleCheckUpdate(): Promise<void> {
    const outcome = await checkForUpdate(true)
    if (outcome === 'current') setUpdateMessage('Vous avez la derniere version.')
    else if (outcome === 'error') setUpdateMessage('Verification impossible (hors ligne ?).')
  }

  useEffect(() => {
    if (!downtifyClient) {
      setDtSettings(null)
      return
    }
    downtifyClient.getSettings().then(setDtSettings).catch(() => {})
  }, [downtifyClient])

  async function saveDowntifySettings(): Promise<void> {
    if (!downtifyClient || !dtSettings) return
    setSavingSettings(true)
    try {
      await downtifyClient.updateSettings(dtSettings)
      Alert.alert('Options', 'Enregistrees avec succes.')
    } catch (err: any) {
      Alert.alert('Erreur', err?.message || 'Enregistrement impossible')
    } finally {
      setSavingSettings(false)
    }
  }

  function confirmClearOffline(): void {
    Alert.alert('Vider le cache hors-ligne', `Supprimer les ${offlineIds.length} titres telecharges sur cet appareil ?`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: () => {
          offlineIds.forEach((id) => removeOffline(id))
        }
      }
    ])
  }

  const activeDownloads = downtifyQueue.filter((q) => q.status === 'downloading' || q.status === 'queued').length

  return (
    <Screen>
      <ScreenHeader title="Reglages" />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <SectionTitle>Services</SectionTitle>
        <ServiceRow
          icon={Music}
          iconColor="#000"
          accent={colors.accent}
          name="Navidrome"
          connected={navidromeStatus === 'connected'}
          subtitle={navidromeStatus === 'connected' ? `Connecte en tant que ${navidromeUsername}` : 'Non connecte'}
          onLogout={navidromeLogout}
        />
        <ServiceRow
          icon={FolderOpen}
          iconColor="#fff"
          accent={colors.filebrowser}
          name="FileBrowser"
          connected={fileBrowserStatus === 'connected'}
          subtitle={fileBrowserStatus === 'connected' ? 'Connecte' : 'Non connecte'}
          onLogout={fileBrowserLogout}
        />
        <ServiceRow
          icon={Download}
          iconColor="#fff"
          accent={colors.downtify}
          name="Downtify"
          connected={downtifyStatus === 'connected'}
          subtitle={downtifyStatus === 'connected' ? 'Resultats integres a la recherche' : 'Non connecte'}
          onLogout={downtifyLogout}
          onConnect={() => router.push('/downtify/connect')}
        />

        <View style={styles.sectionSpacer}>
          <SectionTitle>Controle a distance</SectionTitle>
        </View>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => router.push('/devices')}
          accessibilityRole="button"
          accessibilityLabel="Controle a distance"
        >
          <View style={[styles.iconWrap, { backgroundColor: colors.hover }]}>
            <Cast size={20} color={colors.textSecondary} />
          </View>
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle}>Appareils</Text>
            <Text style={styles.rowMeta}>
              {!remoteEnabled
                ? 'Desactive'
                : remoteStatus === 'connected'
                  ? 'Connecte au PC'
                  : remoteStatus === 'connecting'
                    ? 'Recherche en cours...'
                    : 'Active - non connecte'}
            </Text>
          </View>
          <ChevronRight size={18} color={colors.textMuted} />
        </Pressable>

        {downtifyStatus === 'connected' && (
          <>
            <View style={styles.sectionSpacer}>
              <SectionTitle>Telechargements</SectionTitle>
            </View>

            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              onPress={() => router.push('/downtify/queue')}
              accessibilityRole="button"
              accessibilityLabel="Voir la file de telechargement"
            >
              <View style={[styles.iconWrap, { backgroundColor: colors.hover }]}>
                <Download size={20} color={colors.textSecondary} />
              </View>
              <View style={styles.rowInfo}>
                <Text style={styles.rowTitle}>File de telechargement</Text>
                <Text style={styles.rowMeta}>
                  {activeDownloads > 0
                    ? `${activeDownloads} en cours`
                    : downtifyQueue.length > 0
                      ? `${downtifyQueue.length} dans l'historique`
                      : 'Aucun telechargement'}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.textMuted} />
            </Pressable>

            {dtSettings ? (
              <View style={styles.card}>
                <Text style={styles.fieldLabel}>Format</Text>
                <TextInput
                  style={styles.input}
                  value={dtSettings.format}
                  onChangeText={(v) => setDtSettings({ ...dtSettings, format: v })}
                  autoCapitalize="none"
                  accessibilityLabel="Format"
                />
                <Text style={styles.fieldLabel}>Qualite (kbps)</Text>
                <TextInput
                  style={styles.input}
                  value={dtSettings.bitrate}
                  onChangeText={(v) => setDtSettings({ ...dtSettings, bitrate: v })}
                  autoCapitalize="none"
                  accessibilityLabel="Qualite en kbps"
                />
                <Text style={styles.fieldLabel}>Format du nom de fichier</Text>
                <TextInput
                  style={styles.input}
                  value={dtSettings.output}
                  onChangeText={(v) => setDtSettings({ ...dtSettings, output: v })}
                  autoCapitalize="none"
                  accessibilityLabel="Format du nom de fichier"
                />
                <Pressable
                  style={({ pressed }) => [styles.saveButton, (savingSettings || pressed) && styles.pressed]}
                  onPress={saveDowntifySettings}
                  disabled={savingSettings}
                  accessibilityRole="button"
                  accessibilityLabel="Enregistrer les options"
                >
                  {savingSettings ? (
                    <ActivityIndicator color="#000" />
                  ) : (
                    <>
                      <Check size={16} color="#000" />
                      <Text style={styles.saveButtonText}>Enregistrer</Text>
                    </>
                  )}
                </Pressable>
              </View>
            ) : (
              <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.lg }} />
            )}
          </>
        )}

        <AppearanceSection />
        <PlaybackSection />

        <View style={styles.sectionSpacer}>
          <SectionTitle>Stockage</SectionTitle>
        </View>
        <View style={styles.row}>
          <View style={[styles.iconWrap, { backgroundColor: colors.hover }]}>
            <HardDriveDownload size={20} color={colors.textSecondary} />
          </View>
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle}>Titres hors-ligne</Text>
            <Text style={styles.rowMeta}>
              {offlineIds.length === 0 ? 'Aucun titre telecharge' : `${offlineIds.length} titres sur cet appareil`}
            </Text>
          </View>
          {offlineIds.length > 0 && (
            <Pressable
              style={({ pressed }) => [styles.pillButton, pressed && styles.pressed]}
              onPress={confirmClearOffline}
              accessibilityRole="button"
              accessibilityLabel="Vider le cache hors-ligne"
            >
              <Text style={[styles.pillText, { color: colors.danger }]}>Vider</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.sectionSpacer}>
          <SectionTitle>Application</SectionTitle>
        </View>
        <View style={styles.row}>
          <View style={[styles.iconWrap, { backgroundColor: colors.hover }]}>
            <RefreshCw size={20} color={colors.textSecondary} />
          </View>
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle}>SelfHost Hub v{installedVersion()}</Text>
            <Text style={styles.rowMeta}>
              {updatePhase === 'checking'
                ? 'Recherche...'
                : availableUpdate
                  ? `Version ${availableUpdate.version} disponible.`
                  : updateMessage}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.pillButton, pressed && styles.pressed]}
            onPress={handleCheckUpdate}
            disabled={updatePhase === 'checking' || updatePhase === 'downloading' || updatePhase === 'installing'}
            accessibilityRole="button"
            accessibilityLabel="Rechercher des mises a jour"
          >
            <Text style={styles.pillText}>Rechercher</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  sectionSpacer: { marginTop: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm
  },
  iconWrap: { width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  rowInfo: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 3 },
  dot: { width: 7, height: 7, borderRadius: radius.full },
  rowSubtitle: { flex: 1, color: colors.textSecondary, fontSize: 12 },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  pillButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border
  },
  pillPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
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
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingVertical: spacing.md
  },
  saveButtonText: { color: '#000', fontWeight: '700', fontSize: 14 }
})
