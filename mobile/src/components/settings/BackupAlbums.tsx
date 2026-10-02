import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { addBackupAlbum, countAlbumItems, listDeviceAlbums, removeBackupAlbum } from '@/services/cameraBackup'
import { albumFolderName } from '@/services/photoVault'
import { BackupAlbum, useCameraBackupStore } from '@/store/cameraBackupStore'
import { colors, radius, spacing } from '@/constants/theme'

function folderOf(title: string): string {
  try {
    return albumFolderName(title)
  } catch {
    return title
  }
}

/**
 * The phone's other albums (screenshots, WhatsApp...), each of which can be backed up along with the camera,
 * into a folder of its own named after it. The list is only read when asked for: it needs the photo access.
 */
export default function BackupAlbums() {
  const selected = useCameraBackupStore((s) => s.settings.albums)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [albums, setAlbums] = useState<BackupAlbum[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setProblem(null)
    try {
      const found = await listDeviceAlbums()
      setAlbums(found)
      // Counted one at a time: an album of thousands takes a moment, and the list is usable meanwhile.
      for (const album of found) {
        const count = await countAlbumItems(album.id).catch(() => null)
        if (count !== null) setCounts((previous) => ({ ...previous, [album.id]: count }))
      }
    } catch (err) {
      setProblem(err instanceof Error && err.message ? err.message : 'Impossible de lister les albums')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && albums === null && !loading) void load()
  }, [open, albums, loading, load])

  function choose(album: BackupAlbum, on: boolean): void {
    if (!on) {
      void run(album.id, () => removeBackupAlbum(album.id))
      return
    }
    const count = counts[album.id]
    if (!count) {
      void run(album.id, () => addBackupAlbum(album, false))
      return
    }
    Alert.alert(
      `Album « ${album.title} »`,
      `Il contient déjà ${count.toLocaleString('fr-FR')} photos et vidéos. Les sauvegarder aussi, ou seulement les prochaines ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Les prochaines', onPress: () => void run(album.id, () => addBackupAlbum(album, false)) },
        { text: 'Tout sauvegarder', onPress: () => void run(album.id, () => addBackupAlbum(album, true)) }
      ],
      { cancelable: true }
    )
  }

  async function run(id: string, action: () => Promise<void>): Promise<void> {
    setBusy(id)
    try {
      await action()
    } finally {
      setBusy(null)
    }
  }

  // Albums chosen earlier that the phone no longer has still need a way to be taken off the list.
  const known = new Set((albums ?? []).map((album) => album.id))
  const missing = selected.filter((album) => !known.has(album.id))

  return (
    <View>
      <Pressable
        style={styles.header}
        onPress={() => setOpen((on) => !on)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Autres albums à sauvegarder"
      >
        <View style={styles.headerText}>
          <Text style={styles.label}>Autres albums</Text>
          <Text style={styles.value}>
            {selected.length === 0 ? 'Seul l’appareil photo est sauvegardé' : selected.map((album) => album.title).join(', ')}
          </Text>
        </View>
        <Text style={styles.toggle}>{open ? 'Masquer' : 'Choisir'}</Text>
      </Pressable>

      {open && (
        <View style={styles.list}>
          <Text style={styles.hint}>Chaque album est rangé dans un sous-dossier à son nom, par année et par mois.</Text>
          {loading && albums === null ? <ActivityIndicator color={colors.accent} style={styles.loader} /> : null}
          {problem ? <Text style={styles.warning}>{problem}</Text> : null}
          {albums !== null && albums.length === 0 && !problem ? <Text style={styles.hint}>Aucun autre album sur ce téléphone.</Text> : null}
          {[...(albums ?? []), ...missing].map((album) => {
            const on = selected.some((chosen) => chosen.id === album.id)
            const gone = !known.has(album.id)
            return (
              <View key={album.id} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {album.title}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {gone ? 'introuvable sur le téléphone' : counts[album.id] !== undefined ? `${counts[album.id].toLocaleString('fr-FR')} éléments` : '…'}
                    {on ? ` · dossier ${folderOf(album.title)}` : ''}
                  </Text>
                </View>
                {busy === album.id ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <Switch
                    value={on}
                    onValueChange={(value) => choose(album, value)}
                    trackColor={{ false: colors.hover, true: colors.accent }}
                    thumbColor="#ffffff"
                    accessibilityLabel={`Sauvegarder l’album ${album.title}`}
                  />
                )}
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md },
  headerText: { flex: 1 },
  label: { color: colors.text, fontSize: 14, fontWeight: '600' },
  value: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  toggle: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  list: { marginTop: spacing.sm, gap: spacing.sm },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  warning: { color: colors.warning, fontSize: 12, lineHeight: 17 },
  loader: { marginVertical: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.raised, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowMeta: { color: colors.textMuted, fontSize: 11, marginTop: 1 }
})
