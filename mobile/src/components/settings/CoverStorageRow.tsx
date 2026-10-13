import { useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Network from 'expo-network'
import { Image as ImageIcon } from 'lucide-react-native'
import { clearCovers, LibraryProgress, storeLibraryCovers, useCoverStore } from '@/services/coverStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { colors, radius, spacing } from '@/constants/theme'

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 10 ? `${Math.round(mb)} Mo` : `${mb.toFixed(1).replace('.', ',')} Mo`
}

/**
 * Réglages → Stockage: the covers kept on the phone (services/coverStore). They are saved as they are shown; this saves
 * the whole library's at once (asked first on mobile data), and empties the store, except the covers of downloaded songs.
 */
export default function CoverStorageRow() {
  const client = useNavidromeStore((s) => s.client)
  const count = useCoverStore((s) => s.count)
  const bytes = useCoverStore((s) => s.bytes)
  const [progress, setProgress] = useState<LibraryProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const stop = useRef(false)

  async function saveAll(): Promise<void> {
    if (!client || running) return
    stop.current = false
    setRunning(true)
    setResult(null)
    setProgress(null)
    try {
      const done = await storeLibraryCovers(
        (offset, size) => client.getAlbumPage(offset, size),
        (coverId) => client.coverArtUrl(coverId, 300),
        setProgress,
        () => stop.current
      )
      setResult(
        stop.current
          ? `Arrêté : ${done.done} pochettes vues sur ${done.total ?? '?'}.`
          : done.failed > 0
            ? `${done.total} pochettes, dont ${done.failed} introuvables.`
            : `Les ${done.total} pochettes de la bibliothèque sont sur le téléphone.`
      )
    } catch (err: any) {
      setResult(`Impossible de lire la bibliothèque : ${err?.message || 'erreur'}`)
    } finally {
      setRunning(false)
    }
  }

  async function confirmSaveAll(): Promise<void> {
    const state = await Network.getNetworkStateAsync().catch(() => null)
    if (state?.type === Network.NetworkStateType.CELLULAR) {
      Alert.alert('Données mobiles', 'Enregistrer toutes les pochettes peut prendre plusieurs dizaines de Mo. Continuer sans Wi-Fi ?', [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Continuer', onPress: () => void saveAll() }
      ])
      return
    }
    void saveAll()
  }

  function confirmClear(): void {
    Alert.alert('Vider les pochettes', 'Supprimer les pochettes enregistrées ? Celles des titres téléchargés restent.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: clearCovers }
    ])
  }

  const meta = running
    ? progress?.total
      ? `Enregistrement… ${progress.done} / ${progress.total}`
      : 'Lecture de la bibliothèque…'
    : result ?? (count === 0 ? 'Aucune pochette enregistrée' : `${count} pochettes · ${megabytes(bytes)} sur le téléphone`)

  return (
    <View style={styles.row}>
      <View style={styles.iconWrap}>
        <ImageIcon size={20} color={colors.textSecondary} />
      </View>
      <View style={styles.info}>
        <Text style={styles.title}>Pochettes</Text>
        <Text style={styles.meta}>{meta}</Text>
        <View style={styles.actions}>
          {running ? (
            <Pressable
              style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
              onPress={() => (stop.current = true)}
              accessibilityRole="button"
              accessibilityLabel="Arrêter l'enregistrement des pochettes"
            >
              <Text style={styles.pillText}>Arrêter</Text>
            </Pressable>
          ) : (
            <Pressable
              style={({ pressed }) => [styles.pill, styles.pillPrimary, pressed && styles.pressed, !client && styles.disabled]}
              onPress={confirmSaveAll}
              disabled={!client}
              accessibilityRole="button"
              accessibilityLabel="Enregistrer toutes les pochettes"
            >
              <Text style={[styles.pillText, { color: '#000' }]}>Tout enregistrer</Text>
            </Pressable>
          )}
          {count > 0 && !running && (
            <Pressable
              style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
              onPress={confirmClear}
              accessibilityRole="button"
              accessibilityLabel="Vider les pochettes enregistrées"
            >
              <Text style={[styles.pillText, { color: colors.danger }]}>Vider</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm
  },
  iconWrap: { width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.hover },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '600' },
  meta: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  pill: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  pillPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 }
})
