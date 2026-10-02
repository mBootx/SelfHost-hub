import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, BackHandler, FlatList, Pressable, RefreshControl, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useNavigation } from 'expo-router'
import { ArchiveRestore, Trash2 } from 'lucide-react-native'
import { EmptyState } from '@/components/Screen'
import PhotoTile from '@/components/photos/PhotoTile'
import PhotoViewer, { ViewerAction } from '@/components/photos/PhotoViewer'
import { BarAction, SelectionBar } from '@/components/photos/PhotosChrome'
import { describeError, logEvent } from '@/services/diagnostics'
import { binTimeLeft, buildTrashRows, formatBinDay, formatSize, TrashRow } from '@/services/photoLayout'
import { deletePhotos, emptyTrash, loadTrash, purgeExpiredTrash, restoreTrashed, TRASH_DAYS, TrashedPhoto, vaultRootFor } from '@/services/photoVault'
import { useCameraBackupStore } from '@/store/cameraBackupStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { usePhotosStore } from '@/store/photosStore'
import { useToastStore } from '@/store/toastStore'
import { colors, layout, radius, spacing } from '@/constants/theme'

const GAP = 2

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`
}

/**
 * What was deleted from the gallery in the last TRASH_DAYS days: still on the server, in the bin folder of the
 * account's backup folder. From here it goes back where it was, or is deleted for good.
 */
export default function TrashScreen() {
  const navigation = useNavigation()
  const { width } = useWindowDimensions()
  const client = useFileBrowserStore((s) => s.client)
  const template = useCameraBackupStore((s) => s.settings.folder)
  const showToast = useToastStore((s) => s.show)

  const [items, setItems] = useState<TrashedPhoto[] | null>(null)
  const [incomplete, setIncomplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [viewerAt, setViewerAt] = useState<number | null>(null)

  const root = useMemo(() => {
    if (!client) return null
    try {
      return vaultRootFor(template, client.getAccountName())
    } catch {
      return null
    }
  }, [client, template])

  useEffect(() => {
    navigation.setOptions({ title: 'Corbeille' })
  }, [])

  const load = useCallback(async () => {
    if (!client || !root) return
    setLoading(true)
    try {
      const listing = await loadTrash(client, root)
      setItems(listing.items)
      setIncomplete(listing.incomplete)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Corbeille illisible')
      logEvent('photos', `Corbeille illisible : ${describeError(err)}`, 'warn')
    } finally {
      setLoading(false)
    }
  }, [client, root])

  // What has been here for good is deleted first, so it is not shown just to vanish.
  useEffect(() => {
    if (!client || !root) return
    void purgeExpiredTrash(client, root)
      .then((result) => {
        if (result.removed > 0) logEvent('photos', `Corbeille : ${plural(result.removed, 'jour effacé', 'jours effacés')} (plus de ${TRASH_DAYS} jours)`)
      })
      .catch(() => {})
      .finally(() => void load())
  }, [client, root, load])

  const columns = width >= 600 ? 5 : 3
  const size = Math.floor((width - GAP * (columns - 1)) / columns)
  const today = new Date()
  const rows = useMemo(() => buildTrashRows(items ?? [], columns), [items, columns])

  const selecting = selection.size > 0
  const selectingRef = useRef(selecting)
  selectingRef.current = selecting

  const toggle = useCallback((item: TrashedPhoto) => {
    setSelection((previous) => {
      const next = new Set(previous)
      if (next.has(item.path)) next.delete(item.path)
      else next.add(item.path)
      return next
    })
  }, [])
  const open = useCallback(
    (index: number, item: TrashedPhoto) => {
      if (selectingRef.current) toggle(item)
      else setViewerAt(index)
    },
    [toggle]
  )

  useEffect(() => {
    if (!selecting) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelection(new Set())
      return true
    })
    return () => subscription.remove()
  }, [selecting])

  /** The gallery reads its folders again next time it is shown: restored photos are back in it. */
  function invalidateGallery(): void {
    usePhotosStore.setState({ loadedAt: null })
  }

  async function restore(paths: string[]): Promise<void> {
    if (!client || !root) return
    setWorking('Restauration…')
    try {
      const report = await restoreTrashed(client, root, paths, { onEach: (done, total) => setWorking(`Restauration ${done} sur ${total}…`) })
      setSelection(new Set())
      setViewerAt(null)
      invalidateGallery()
      if (report.failed.length > 0) {
        Alert.alert('Restauration incomplète', `${report.failed.length} sur ${paths.length} n'ont pas pu être restaurés : ${report.failed[0].message}.`)
      } else {
        showToast(plural(report.restored.length, 'élément restauré', 'éléments restaurés'))
      }
      await load()
    } finally {
      setWorking(null)
    }
  }

  function confirmDestroy(paths: string[]): void {
    const one = paths.length === 1
    Alert.alert(
      one ? 'Supprimer définitivement ?' : `Supprimer définitivement ${paths.length} éléments ?`,
      `${one ? 'Il sera effacé' : 'Ils seront effacés'} du serveur, sans retour possible.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Supprimer', style: 'destructive', onPress: () => void destroy(paths) }
      ]
    )
  }

  async function destroy(paths: string[]): Promise<void> {
    if (!client || !root) return
    setWorking('Suppression…')
    try {
      const report = await deletePhotos(client, root, paths)
      setSelection(new Set())
      setViewerAt(null)
      if (report.failed.length > 0) {
        Alert.alert('Suppression incomplète', `${report.failed.length} sur ${paths.length} n'ont pas pu être supprimés : ${report.failed[0].message}.`)
      } else {
        showToast(plural(report.deleted.length, 'élément supprimé', 'éléments supprimés'))
      }
      await load()
    } finally {
      setWorking(null)
    }
  }

  function confirmEmpty(): void {
    Alert.alert('Vider la corbeille ?', 'Tout ce qu’elle contient sera effacé du serveur, sans retour possible.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Vider', style: 'destructive', onPress: () => void empty() }
    ])
  }

  async function empty(): Promise<void> {
    if (!client || !root) return
    setWorking('Suppression…')
    try {
      const result = await emptyTrash(client, root)
      if (result.failed > 0) Alert.alert('Corbeille incomplète', `${result.failed} jours n'ont pas pu être effacés.`)
      else showToast('Corbeille vidée')
      await load()
    } catch (err) {
      Alert.alert('Impossible de vider la corbeille', err instanceof Error ? err.message : 'Erreur inconnue')
    } finally {
      setWorking(null)
    }
  }

  const selectionActions: BarAction[] = [
    { key: 'restore', label: 'Restaurer', icon: ArchiveRestore, onPress: () => void restore([...selection]) },
    { key: 'destroy', label: 'Supprimer définitivement', icon: Trash2, destructive: true, onPress: () => confirmDestroy([...selection]) }
  ]
  const viewerActions: ViewerAction<TrashedPhoto>[] = [
    { key: 'restore', label: 'Restaurer', icon: ArchiveRestore, onPress: (item) => void restore([item.path]) },
    { key: 'destroy', label: 'Supprimer définitivement', icon: Trash2, destructive: true, onPress: (item) => confirmDestroy([item.path]) }
  ]
  const describe = (item: TrashedPhoto): string => `Supprimé le ${formatBinDay(item.trashedOn)} · ${binTimeLeft(item.trashedOn, today)} · ${formatSize(item.size)}`

  const renderRow = useCallback(
    ({ item: row }: { item: TrashRow }) => {
      if (row.kind === 'header') {
        return (
          <View style={styles.dayHeader}>
            <Text style={styles.dayTitle}>Supprimé le {formatBinDay(row.day)}</Text>
            <Text style={styles.dayMeta}>
              {binTimeLeft(row.day, new Date())} · {row.count}
            </Text>
          </View>
        )
      }
      return (
        <View style={styles.row}>
          {row.items.map((item, i) => (
            <PhotoTile
              key={item.path}
              photo={item}
              client={client!}
              size={size}
              index={row.firstIndex + i}
              selecting={selecting}
              selected={selection.has(item.path)}
              onPress={open}
              onLongPress={toggle}
            />
          ))}
        </View>
      )
    },
    [client, size, selecting, selection, open, toggle]
  )

  let body: React.ReactNode
  if (!client || !root) {
    body = <EmptyState icon={Trash2} title="Non connecté" hint="Connectez-vous à FileBrowser depuis l'onglet Fichiers." />
  } else if (items === null && !error) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  } else if (items === null) {
    body = (
      <View>
        <EmptyState icon={Trash2} title="Corbeille illisible" hint={error ?? undefined} />
        <View style={styles.centerButton}>
          <Pressable style={styles.button} onPress={() => void load()} accessibilityRole="button">
            <Text style={styles.buttonText}>Réessayer</Text>
          </Pressable>
        </View>
      </View>
    )
  } else if (items.length === 0) {
    body = <EmptyState icon={Trash2} title="La corbeille est vide" hint={`Ce que vous supprimez de la galerie reste ici ${TRASH_DAYS} jours avant d'être effacé du serveur.`} />
  } else {
    body = (
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        extraData={selection}
        initialNumToRender={8}
        maxToRenderPerBatch={6}
        windowSize={9}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: layout.contentBottom }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={colors.accent} colors={[colors.accent]} />}
        ListFooterComponent={
          incomplete ? (
            <View style={styles.footer}>
              <Text style={styles.footerText}>Certains dossiers n’ont pas pu être lus : la liste peut être incomplète.</Text>
            </View>
          ) : null
        }
      />
    )
  }

  return (
    <View style={styles.screen}>
      {selecting ? (
        <SelectionBar count={selection.size} onClear={() => setSelection(new Set())} actions={selectionActions} />
      ) : items && items.length > 0 ? (
        <View style={styles.intro}>
          <Text style={styles.introText}>
            {plural(items.length, 'élément', 'éléments')} · supprimés définitivement au bout de {TRASH_DAYS} jours
          </Text>
          <Pressable onPress={confirmEmpty} hitSlop={8} accessibilityRole="button" accessibilityLabel="Vider la corbeille">
            <Text style={styles.empty}>Vider</Text>
          </Pressable>
        </View>
      ) : null}
      {body}
      {working ? (
        <View style={styles.working} pointerEvents="auto">
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.workingText}>{working}</Text>
        </View>
      ) : null}
      {viewerAt !== null && items && client && (
        <PhotoViewer photos={items} client={client} startIndex={viewerAt} onClose={() => setViewerAt(null)} actions={viewerActions} describe={describe} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerButton: { alignItems: 'center', marginTop: spacing.sm },
  intro: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  introText: { flex: 1, color: colors.textMuted, fontSize: 12, lineHeight: 16 },
  empty: { color: colors.danger, fontSize: 13, fontWeight: '700' },
  row: { flexDirection: 'row', gap: GAP, marginBottom: GAP },
  dayHeader: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  dayTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  dayMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  footer: { padding: spacing.lg },
  footerText: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  button: { backgroundColor: colors.accent, borderRadius: radius.full, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm + 2 },
  buttonText: { color: '#000000', fontWeight: '800', fontSize: 14 },
  working: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: 'rgba(0,0,0,0.55)' },
  workingText: { color: colors.text, fontSize: 14 }
})
