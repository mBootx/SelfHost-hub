import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { Watch } from 'lucide-react-native'
import { SectionTitle } from '@/components/Screen'
import { ago } from '@/services/diagnosticsReport'
import { RELEASES_PAGE_URL } from '@/services/updateAsset'
import { useWatchLinkStatus } from '@/services/watchLink'
import { listWatches, sendSetupToWatches, watchSupported } from '@/services/watchSync'
import { askWatchVersion, checkWatchUpdate, dismissWatchUpdate, updateSupported, updateWatch } from '@/services/watchUpdate'
import { describePhase, describeWatchApp } from '@/services/watchUpdateProtocol'
import { BUSY_PHASES, useWatchUpdate } from '@/store/watchUpdateStore'
import type { WatchInfo } from '../../../modules/selfhost-native'
import { colors, radius, spacing } from '@/constants/theme'

type Listing = { state: 'loading' } | { state: 'ready'; watches: WatchInfo[] } | { state: 'error'; message: string }

/** What the row says about the watches that are connected, and whether one is ready to be set up. */
export function describeWatches(watches: WatchInfo[]): { text: string; ready: boolean } {
  if (watches.length === 0) return { text: 'Aucune montre Wear OS connectée en Bluetooth', ready: false }
  const withApp = watches.filter((w) => w.hasApp)
  if (withApp.length === 0) {
    const name = watches[0].name
    return { text: `${name} : installez d'abord l'application SelfHost Hub pour montre`, ready: false }
  }
  const names = withApp.map((w) => w.name).join(', ')
  return { text: `${names} : prête à être configurée`, ready: true }
}

/** What the row says about the watch's messages to this phone (the live link, see services/watchLink.ts). */
export function describeLink(lastContactAt: number | null, error: string | null, now: number): string {
  if (error) return `Liaison avec la montre : ${error}`
  if (lastContactAt === null) return "Aucun message de la montre depuis le lancement de l'application"
  return `Dernier message de la montre : ${ago(lastContactAt, now)}`
}

/** Réglages → Montre: gives a Wear OS watch the app's setup, updates its app, and says whether it has been in touch. */
export default function WatchSection() {
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  const [sending, setSending] = useState(false)
  const lastContactAt = useWatchLinkStatus((s) => s.lastContactAt)
  const linkError = useWatchLinkStatus((s) => s.error)
  const watchApp = useWatchUpdate((s) => s.watch)
  const latest = useWatchUpdate((s) => s.latest)
  const phase = useWatchUpdate((s) => s.phase)
  const progress = useWatchUpdate((s) => s.progress)
  const updateMessage = useWatchUpdate((s) => s.message)

  const refresh = useCallback(async () => {
    if (!watchSupported()) {
      setListing({ state: 'ready', watches: [] })
      return
    }
    try {
      const watches = await listWatches()
      setListing({ state: 'ready', watches })
      // The watch tells which version of its app it has (the answer lands in the store), and the latest release is looked up.
      if (updateSupported() && watches.some((w) => w.hasApp)) {
        void askWatchVersion()
        void checkWatchUpdate()
      }
    } catch (err) {
      setListing({ state: 'error', message: err instanceof Error ? err.message : 'Montres illisibles' })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh()
    })
    return () => subscription.remove()
  }, [refresh])

  async function send(): Promise<void> {
    setSending(true)
    try {
      const result = await sendSetupToWatches()
      switch (result.status) {
        case 'unsupported':
          Alert.alert('Indisponible', "Cette version de l'application ne sait pas parler aux montres. Installez la dernière mise à jour.")
          break
        case 'nothing-to-send':
          Alert.alert('Rien à envoyer', "Connectez-vous d'abord à Navidrome, plus haut dans cet écran : la montre en a besoin pour afficher votre musique.")
          break
        case 'no-watch':
          Alert.alert('Aucune montre prête', "Aucune montre connectée n'a l'application SelfHost Hub. Installez-la sur la montre, puis réessayez.")
          break
        case 'error':
          Alert.alert('Envoi impossible', result.message)
          break
        case 'sent': {
          const failed = result.outcomes.filter((o) => !o.ok)
          if (failed.length === 0) Alert.alert('Montre configurée', result.outcomes.map((o) => o.name).join(', ') + ' peut maintenant afficher votre bibliothèque et piloter la lecture depuis ce téléphone.')
          else Alert.alert('Configuration incomplète', failed.map((o) => `${o.name} : ${o.error ?? 'refusé'}`).join('\n'))
          break
        }
      }
    } finally {
      setSending(false)
      void refresh()
    }
  }

  function reinstall(): void {
    Alert.alert('Réinstaller la même version ?', "L'application de la montre est renvoyée telle quelle et réinstallée : utile si elle se comporte mal. La montre demandera peut-être une confirmation.", [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Réinstaller', onPress: () => void updateWatch({ reinstall: true }) }
    ])
  }

  const summary = listing.state === 'ready' ? describeWatches(listing.watches) : null
  const text = listing.state === 'loading' ? 'Recherche des montres…' : listing.state === 'error' ? listing.message : summary!.text
  const ready = !!summary?.ready
  const app = describeWatchApp(watchApp, latest)
  const busy = BUSY_PHASES.includes(phase)
  const phaseText = describePhase(phase, progress)
  const canUpdateApp = ready && updateSupported()

  return (
    <>
      <View style={styles.sectionGap}>
        <SectionTitle>Montre</SectionTitle>
      </View>
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.iconWrap}>
            <Watch size={20} color={colors.textSecondary} />
          </View>
          <View style={styles.info}>
            <Text style={styles.title}>Montre Wear OS</Text>
            <Text style={styles.meta}>{text}</Text>
          </View>
        </View>
        <Text style={styles.hint}>
          Envoie à la montre l'adresse de Navidrome et un jeton de connexion (jamais le mot de passe) pour qu'elle affiche votre bibliothèque. Tout passe par la liaison
          chiffrée entre le téléphone et la montre. La montre pilote ensuite la lecture de ce téléphone et, par lui, celle du PC si le contrôle à distance est activé :
          elle ne se connecte jamais au PC elle-même.
        </Text>
        <Text style={styles.meta}>{describeLink(lastContactAt, linkError, Date.now())}</Text>
        <Pressable
          style={({ pressed }) => [styles.button, (!ready || sending) && styles.buttonOff, pressed && styles.pressed]}
          onPress={() => void send()}
          disabled={!ready || sending}
          accessibilityRole="button"
          accessibilityLabel="Envoyer à la montre"
        >
          {sending ? <ActivityIndicator color="#000" /> : <Text style={styles.buttonText}>Envoyer à la montre</Text>}
        </Pressable>

        {ready && updateSupported() ? (
          <View style={styles.updateBlock}>
            <Text style={styles.subtitle}>Application de la montre</Text>
            <Text style={styles.meta}>{app.text}</Text>
            {phaseText ? (
              <View style={styles.progressRow}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
                <Text style={styles.meta}>{phaseText}</Text>
              </View>
            ) : null}
            {updateMessage ? (
              <Text style={[styles.meta, phase === 'error' && styles.error]} selectable>
                {updateMessage}
              </Text>
            ) : null}
            {app.canUpdate && !busy ? (
              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                onPress={() => void updateWatch()}
                accessibilityRole="button"
                accessibilityLabel="Mettre à jour la montre"
              >
                <Text style={styles.buttonText}>Mettre à jour la montre</Text>
              </Pressable>
            ) : null}
            {app.tooOld ? (
              <Pressable
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                onPress={() => void Linking.openURL(RELEASES_PAGE_URL)}
                accessibilityRole="link"
                accessibilityLabel="Voir la dernière version"
              >
                <Text style={styles.secondaryText}>Voir la dernière version</Text>
              </Pressable>
            ) : null}
            {app.canReinstall && !busy && canUpdateApp ? (
              <Pressable onPress={reinstall} accessibilityRole="button" accessibilityLabel="Réinstaller la même version" hitSlop={8}>
                <Text style={styles.linkText}>Réinstaller cette version (dépannage)</Text>
              </Pressable>
            ) : null}
            {phase === 'error' || phase === 'done' || phase === 'installing' || phase === 'confirm' ? (
              <Pressable onPress={dismissWatchUpdate} accessibilityRole="button" accessibilityLabel="Fermer ce message" hitSlop={8}>
                <Text style={styles.linkText}>Fermer</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  sectionGap: { marginTop: spacing.lg },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconWrap: { width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.hover },
  info: { flex: 1 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  button: { backgroundColor: colors.accent, borderRadius: radius.full, paddingVertical: spacing.md, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  buttonOff: { opacity: 0.4 },
  buttonText: { color: '#000000', fontWeight: '800', fontSize: 14 },
  pressed: { opacity: 0.8 },
  updateBlock: { gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.md },
  subtitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  error: { color: colors.danger },
  secondaryButton: { borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, paddingVertical: spacing.md, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  secondaryText: { color: colors.text, fontWeight: '600', fontSize: 14 },
  linkText: { color: colors.textSecondary, fontSize: 12, textDecorationLine: 'underline' }
})
