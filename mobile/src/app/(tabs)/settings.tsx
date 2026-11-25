import { ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Cloud, SlidersHorizontal, Download, Palette, Car, Watch, ImageUp, Lock, HardDriveDownload, Info } from 'lucide-react-native'
import { installedVersion } from '@/services/appUpdate'
import WrappedSection from '@/components/settings/WrappedSection'
import { useUpdateStore } from '@/store/updateStore'
import { useTabAnimationStore } from '@/store/tabAnimationStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { useAudioSettingsStore } from '@/store/audioSettingsStore'
import { offlineBytes, useOfflineStore } from '@/store/offlineStore'
import { useRemoteStore } from '@/store/remoteStore'
import { plural } from '@/services/plural'
import { Screen, ScreenHeader } from '@/components/Screen'
import { GroupLabel, SettingsCard, SettingsHero, SettingsRow } from '@/components/settings/SettingsKit'
import { SETTINGS_SECTIONS, SettingsSectionId } from '@/components/settings/sections'
import { ACCENT_PRESETS, BACKGROUNDS, appearance, colors, layout, spacing } from '@/constants/theme'

/** A size in Mo or Go. */
function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1).replace('.', ',')} Go`
  return mb >= 10 ? `${Math.round(mb)} Mo` : `${mb.toFixed(1).replace('.', ',')} Mo`
}

export default function SettingsTab() {
  const router = useRouter()
  const navidromeStatus = useNavidromeStore((s) => s.status)
  const fileBrowserStatus = useFileBrowserStore((s) => s.status)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const downtifyQueue = useDowntifyStore((s) => s.queue)
  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const remoteStatus = useRemoteStore((s) => s.status)
  const availableUpdate = useUpdateStore((s) => s.update)
  const checkForUpdate = useUpdateStore((s) => s.check)
  const crossfadeSeconds = useAudioSettingsStore((s) => s.crossfadeSeconds)
  const eqEnabled = useAudioSettingsStore((s) => s.eqEnabled)
  const offlineTracks = useOfflineStore((s) => s.tracks)
  // The room the downloaded songs take: measured again when the list changes.
  const offlineSize = offlineBytes(offlineTracks)
  const offlineCount = Object.keys(offlineTracks).length
  const tabAnimationSummary = useTabAnimationStore((s) => s.getSummary())

  const accentName = ACCENT_PRESETS.find((p) => p.hex.toLowerCase() === appearance.accent.toLowerCase())?.label ?? 'Perso'
  const connectedServices = [navidromeStatus, fileBrowserStatus, downtifyStatus].filter((s) => s === 'connected').length
  const activeDownloads = downtifyQueue.filter((q) => q.status === 'downloading' || q.status === 'queued').length

  function open(section: SettingsSectionId): void {
    router.push({ pathname: '/settings/[section]', params: { section } })
  }

  return (
    <Screen>
      <ScreenHeader title="Réglages" />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <SettingsHero
          version={installedVersion()}
          chips={[
            { label: 'Navidrome', on: navidromeStatus === 'connected' },
            { label: 'FileBrowser', on: fileBrowserStatus === 'connected' },
            { label: 'Downtify', on: downtifyStatus === 'connected' },
            { label: 'PC', on: remoteEnabled && remoteStatus === 'connected' }
          ]}
          notice={availableUpdate ? { text: `Mettre à jour vers la version ${availableUpdate.version}`, onPress: () => void checkForUpdate(true) } : undefined}
        />

        <GroupLabel>Compte</GroupLabel>
        <SettingsCard>
          <SettingsRow
            icon={Cloud}
            title={SETTINGS_SECTIONS.services.title}
            meta={`${connectedServices} service${connectedServices > 1 ? 's' : ''} connecté${connectedServices > 1 ? 's' : ''} sur 3 · Navidrome, FileBrowser, Downtify`}
            onPress={() => open('services')}
          />
        </SettingsCard>

        <GroupLabel>Musique</GroupLabel>
        <SettingsCard>
          <SettingsRow
            icon={SlidersHorizontal}
            title={SETTINGS_SECTIONS.lecture.title}
            meta={`${crossfadeSeconds === 0 ? 'Fondu désactivé' : `Fondu de ${crossfadeSeconds} s`} · Égaliseur ${eqEnabled ? 'activé' : 'désactivé'}`}
            onPress={() => open('lecture')}
          />
          {downtifyStatus === 'connected' ? (
            <SettingsRow
              icon={Download}
              tone={colors.downtify}
              title={SETTINGS_SECTIONS.downtify.title}
              meta={activeDownloads > 0 ? `${activeDownloads} en cours · format et qualité` : 'File d’attente, format et qualité'}
              onPress={() => open('downtify')}
            />
          ) : null}
        </SettingsCard>
        {/* Opens the Wrapped modal directly. */}
        <View style={styles.gap} />
        <WrappedSection />

        <GroupLabel>Personnaliser</GroupLabel>
        <SettingsCard>
          <SettingsRow
            icon={Palette}
            title={SETTINGS_SECTIONS.apparence.title}
            meta={`${accentName} · ${BACKGROUNDS[appearance.background].label} · ${tabAnimationSummary}`}
            onPress={() => open('apparence')}
          />
          <SettingsRow icon={Car} title={SETTINGS_SECTIONS.voiture.title} meta="Gestes de la main, gros boutons" onPress={() => open('voiture')} />
        </SettingsCard>

        <GroupLabel>Appareils et sécurité</GroupLabel>
        <SettingsCard>
          <SettingsRow icon={Watch} title={SETTINGS_SECTIONS.montre.title} meta="Envoyer la bibliothèque à la montre" onPress={() => open('montre')} />
          <SettingsRow icon={ImageUp} title={SETTINGS_SECTIONS.photos.title} meta="Envoi automatique vers FileBrowser" onPress={() => open('photos')} />
          <SettingsRow icon={Lock} title={SETTINGS_SECTIONS.verrouillage.title} meta="Code, schéma ou empreinte à l'ouverture" onPress={() => open('verrouillage')} />
        </SettingsCard>

        <GroupLabel>Application</GroupLabel>
        <SettingsCard>
          <SettingsRow
            icon={HardDriveDownload}
            title={SETTINGS_SECTIONS.stockage.title}
            meta={offlineCount === 0 ? 'Aucun titre hors ligne' : `${plural(offlineCount, 'titre', 'titres')} hors ligne · ${formatMegabytes(offlineSize)}`}
            onPress={() => open('stockage')}
          />
          <SettingsRow
            icon={Info}
            title={SETTINGS_SECTIONS.apropos.title}
            meta={availableUpdate ? `Version ${availableUpdate.version} disponible` : `Version ${installedVersion()} · nouveautés, diagnostic`}
            onPress={() => open('apropos')}
          />
        </SettingsCard>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  gap: { height: spacing.sm }
})
