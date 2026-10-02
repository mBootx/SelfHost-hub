import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, AppState, BackHandler, FlatList, Pressable, RefreshControl, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { ArrowUpDown, CloudOff, Download, Images, Search, Share2, ShieldAlert, Trash2 } from 'lucide-react-native'
import ActionSheet, { ActionSheetItem } from '@/components/ActionSheet'
import LoginScreen from '@/components/filebrowser/LoginScreen'
import PhotoTile from '@/components/photos/PhotoTile'
import PhotoViewer, { ViewerAction } from '@/components/photos/PhotoViewer'
import { BarAction, Chips, SearchField, SelectionBar } from '@/components/photos/PhotosChrome'
import SyncStrip from '@/components/photos/SyncStrip'
import { EmptyState, Screen, ScreenHeader } from '@/components/Screen'
import {
  albumChips,
  ALL_ALBUMS,
  buildRows,
  countLabel,
  filterByAlbum,
  filterByKind,
  filterPhotos,
  formatSize,
  GridRow,
  KIND_LABELS,
  KindFilter,
  monthTitle,
  SORT_LABELS,
  SortKey,
  sortPhotos
} from '@/services/photoLayout'
import { runCameraBackup } from '@/services/cameraBackup'
import { saveToGallery, shareMedia } from '@/services/photoActions'
import { Photo, TRASH_DAYS, vaultRootFor } from '@/services/photoVault'
import { useCameraBackupStore } from '@/store/cameraBackupStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { PhotoTarget, targetKey, usePhotosStore } from '@/store/photosStore'
import { useToastStore } from '@/store/toastStore'
import { colors, layout, spacing } from '@/constants/theme'

/** The grid runs edge to edge with a hairline between tiles, like a phone's own gallery. */
const GAP = 2
/** Coming back to the tab re-reads the folder only if it was read longer ago than this. */
const STALE_MS = 60_000
/** While the backup is sending, the gallery reads the folder again at most this often. */
const LIVE_REFRESH_MS = 8_000
/** Showing the tab looks for new photos on the phone unless that was done more recently than this. */
const SYNC_MIN_GAP_MS = 15_000

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`
}

/** Starts a backup run when the phone hasn't been looked at lately; a run already going is joined, not doubled. */
function syncSoon(force = false): void {
  const { settings, phase, lastCheckAt } = useCameraBackupStore.getState()
  if (!settings.enabled || phase === 'running') return
  if (force || lastCheckAt === null || Date.now() - lastCheckAt > SYNC_MIN_GAP_MS) void runCameraBackup()
}

/**
 * Photos sent by the backup show up in the gallery as they land: while a run is sending, `refresh` is called
 * every few seconds if anything new went up, and once more when the run ends. Only while the tab is shown:
 * reading the folders over and over for a screen nobody is looking at would cost data and battery, and
 * coming back to the tab catches up at once.
 */
function useBackupRefresh(refresh: () => void, active: boolean): void {
  const uploaded = useCameraBackupStore((s) => s.uploadedTotal)
  const phase = useCameraBackupStore((s) => s.phase)
  const seen = useRef(uploaded)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    if (!active) {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      return
    }
    if (uploaded === seen.current) return
    if (phase !== 'running') {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      seen.current = uploaded
      latest.current()
      return
    }
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      seen.current = useCameraBackupStore.getState().uploadedTotal
      latest.current()
    }, LIVE_REFRESH_MS)
  }, [uploaded, phase, active])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
}

/**
 * The signed-in account's backed-up photos. The folder is worked out from the account's own name and
 * nothing else (see photoVault), so there is no way from here to reach anyone else's photos; what FileBrowser
 * lets the account see is the server's side of that, configured with the account's scope.
 */
export default function PhotosTab() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const client = useFileBrowserStore((s) => s.client)
  const connection = useFileBrowserStore((s) => s.status)
  const template = useCameraBackupStore((s) => s.settings.folder)
  const olderFolder = useCameraBackupStore((s) => s.settings.legacyFolder)
  const backupOn = useCameraBackupStore((s) => s.settings.enabled)
  const loadSettings = useCameraBackupStore((s) => s.load)

  const photos = usePhotosStore((s) => s.photos)
  const status = usePhotosStore((s) => s.status)
  const incomplete = usePhotosStore((s) => s.incomplete)
  const error = usePhotosStore((s) => s.error)
  const load = usePhotosStore((s) => s.load)
  const trash = usePhotosStore((s) => s.trash)
  const showToast = useToastStore((s) => s.show)

  const [sort, setSort] = useState<SortKey>('newest')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [sortSheet, setSortSheet] = useState(false)
  const [kind, setKind] = useState<KindFilter>('all')
  const [album, setAlbum] = useState(ALL_ALBUMS)
  const [working, setWorking] = useState<string | null>(null)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [viewerAt, setViewerAt] = useState<number | null>(null)

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  // The account's own folder: the setting with the account's name in it. A setting that can't make a valid
  // folder is reported instead of used.
  const vault = useMemo(() => {
    if (!client) return null
    try {
      return { root: vaultRootFor(template, client.getAccountName()), problem: null }
    } catch (err) {
      return { root: null, problem: err instanceof Error ? err.message : 'Dossier invalide' }
    }
  }, [client, template])
  const root = vault?.root ?? null
  // Photos still in the old backup folder are shown too, so nothing has to be moved to see them.
  const target = useMemo<PhotoTarget | null>(() => (root ? { root, older: olderFolder ? [olderFolder] : [] } : null), [root, olderFolder])

  // Signing out, or into another account, must not leave the previous account's photos in memory.
  useEffect(() => {
    if (!client) usePhotosStore.getState().reset()
  }, [client])

  const [pulled, setPulled] = useState(false)
  const [focused, setFocused] = useState(false)
  const refresh = useCallback(() => {
    if (client && target) void load(client, target, { fresh: true })
  }, [client, target, load])

  // Showing the tab - or coming back to the app while it is shown - reads the folders and looks for new
  // photos on the phone; whatever the backup sends meanwhile is picked up by useBackupRefresh.
  useFocusEffect(
    useCallback(() => {
      if (!client || !target) return
      const { key, loadedAt, status: current } = usePhotosStore.getState()
      const stale = key !== targetKey(target) || loadedAt === null || Date.now() - loadedAt > STALE_MS
      if (stale && current !== 'loading') void load(client, target)
      syncSoon()
      const subscription = AppState.addEventListener('change', (next) => {
        if (next !== 'active') return
        syncSoon()
        void load(client, target, { fresh: true })
      })
      return () => subscription.remove()
    }, [client, target, load])
  )
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  useBackupRefresh(refresh, focused)

  const pull = useCallback(() => {
    if (!client || !target) return
    setPulled(true)
    syncSoon(true)
    load(client, target, { fresh: true }).finally(() => setPulled(false))
  }, [client, target, load])

  const hasVideos = useMemo(() => photos.some((photo) => photo.kind === 'video'), [photos])
  const albums = useMemo(() => albumChips(photos), [photos])
  // A filter whose choice has disappeared (the last video was deleted, an album emptied) falls back to "all".
  const activeKind: KindFilter = hasVideos ? kind : 'all'
  const activeAlbum = albums.some((chip) => chip.id === album) ? album : ALL_ALBUMS
  const visible = useMemo(
    () => sortPhotos(filterPhotos(filterByAlbum(filterByKind(photos, activeKind), activeAlbum), query), sort),
    [photos, activeKind, activeAlbum, query, sort]
  )
  const columns = width >= 600 ? 5 : 3
  const size = Math.floor((width - GAP * (columns - 1)) / columns)
  const rows = useMemo(() => buildRows(visible, columns, sort === 'newest' || sort === 'oldest'), [visible, columns, sort])

  const selecting = selection.size > 0
  const selectingRef = useRef(selecting)
  selectingRef.current = selecting

  const toggle = useCallback((photo: Photo) => {
    setSelection((previous) => {
      const next = new Set(previous)
      if (next.has(photo.path)) next.delete(photo.path)
      else next.add(photo.path)
      return next
    })
  }, [])
  const open = useCallback(
    (index: number, photo: Photo) => {
      if (selectingRef.current) toggle(photo)
      else setViewerAt(index)
    },
    [toggle]
  )

  // Back leaves the selection first, as in any gallery.
  useEffect(() => {
    if (!selecting) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelection(new Set())
      return true
    })
    return () => subscription.remove()
  }, [selecting])

  function confirmDelete(paths: string[]): void {
    const one = paths.length === 1
    Alert.alert(
      one ? 'Mettre à la corbeille ?' : `Mettre ${paths.length} éléments à la corbeille ?`,
      `${one ? 'Il sera déplacé' : 'Ils seront déplacés'} dans la corbeille du serveur et supprimé${one ? '' : 's'} définitivement au bout de ${TRASH_DAYS} jours; vous pouvez les récupérer d'ici là. Les copies restées sur votre téléphone ne sont pas touchées.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Mettre à la corbeille', style: 'destructive', onPress: () => void trashPaths(paths) }
      ]
    )
  }

  async function trashPaths(paths: string[]): Promise<void> {
    if (!client) return
    const result = await trash(client, paths)
    setSelection(new Set())
    if (result.failed > 0) {
      Alert.alert('Corbeille incomplète', `${result.failed} sur ${paths.length} n'ont pas pu être déplacés${result.message ? ` : ${result.message}` : ''}.`)
    } else {
      showToast(plural(result.moved, 'élément mis à la corbeille', 'éléments mis à la corbeille'))
    }
  }

  const byPath = useMemo(() => new Map(photos.map((photo) => [photo.path, photo])), [photos])

  async function shareSelection(): Promise<void> {
    const item = [...selection].map((path) => byPath.get(path)).find(Boolean)
    if (!client || !item || working) return
    setWorking('Préparation du partage…')
    try {
      if (!(await shareMedia(client, item))) showToast("Le partage n'est pas disponible sur ce téléphone")
    } catch (err) {
      Alert.alert('Partage impossible', err instanceof Error && err.message ? err.message : 'Le fichier n’a pas pu être téléchargé.')
    } finally {
      setWorking(null)
    }
  }

  async function saveSelection(): Promise<void> {
    const items = [...selection].map((path) => byPath.get(path)).filter((item): item is Photo => item !== undefined)
    if (!client || items.length === 0 || working) return
    setWorking('Enregistrement…')
    try {
      const report = await saveToGallery(client, items, (done, total) => setWorking(`Enregistrement ${done} sur ${total}…`))
      setSelection(new Set())
      if (report.failed > 0) {
        Alert.alert('Enregistrement incomplet', `${report.failed} sur ${items.length} n'ont pas pu être enregistrés${report.message ? ` : ${report.message}` : ''}.`)
      } else {
        showToast(plural(report.saved, 'élément enregistré sur le téléphone', 'éléments enregistrés sur le téléphone'))
      }
    } finally {
      setWorking(null)
    }
  }

  const selectionActions: BarAction[] = [
    ...(selection.size === 1 ? [{ key: 'share', label: 'Partager', icon: Share2, onPress: () => void shareSelection() }] : []),
    { key: 'save', label: 'Enregistrer sur le téléphone', icon: Download, onPress: () => void saveSelection() },
    { key: 'trash', label: 'Mettre à la corbeille', icon: Trash2, destructive: true, onPress: () => confirmDelete([...selection]) }
  ]
  const viewerActions: ViewerAction<Photo>[] = [
    { key: 'trash', label: 'Mettre à la corbeille', icon: Trash2, destructive: true, onPress: (photo) => confirmDelete([photo.path]) }
  ]
  const describe = (photo: Photo): string =>
    [monthTitle(photo.year, photo.month), photo.album, formatSize(photo.size)].filter(Boolean).join(' · ')

  const renderRow = useCallback(
    ({ item }: { item: GridRow }) => {
      if (item.kind === 'header') {
        return (
          <View style={styles.monthHeader}>
            <Text style={styles.monthTitle}>{item.title}</Text>
            <Text style={styles.monthCount}>{item.count}</Text>
          </View>
        )
      }
      return (
        <View style={styles.row}>
          {item.photos.map((photo, i) => (
            <PhotoTile
              key={photo.path}
              photo={photo}
              client={client!}
              size={size}
              index={item.firstIndex + i}
              selecting={selecting}
              selected={selection.has(photo.path)}
              onPress={open}
              onLongPress={toggle}
            />
          ))}
        </View>
      )
    },
    [client, size, selecting, selection, open, toggle]
  )

  if (connection === 'connecting') {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </Screen>
    )
  }
  if (connection !== 'connected' || !client) {
    return (
      <Screen>
        <LoginScreen />
      </Screen>
    )
  }

  const retry = (
    <Pressable style={styles.button} onPress={() => target && load(client, target, { fresh: true })} accessibilityRole="button">
      <Text style={styles.buttonText}>Réessayer</Text>
    </Pressable>
  )
  let body: React.ReactNode
  if (vault?.problem) {
    body = <EmptyState icon={ShieldAlert} title="Dossier de sauvegarde invalide" hint={`${vault.problem}. Corrigez-le dans Réglages, rubrique Sauvegarde des photos.`} />
  } else if (status === 'error' && photos.length === 0 && error) {
    const offline = error.code === 'offline'
    const title = error.code === 'denied' ? 'Accès refusé' : error.code === 'unauthorized' ? 'Session expirée' : offline ? 'Serveur injoignable' : 'Chargement impossible'
    const hint =
      error.code === 'denied'
        ? "Votre compte FileBrowser n'a pas accès à ce dossier de photos. Demandez à l'administrateur du serveur de vérifier sa portée."
        : error.code === 'unauthorized'
          ? "Reconnectez-vous à FileBrowser depuis l'onglet Fichiers."
          : offline
            ? 'Vérifiez votre connexion, puis réessayez.'
            : error.message
    body = (
      <View>
        <EmptyState icon={offline ? CloudOff : ShieldAlert} title={title} hint={hint} />
        <View style={styles.centerButton}>{retry}</View>
      </View>
    )
  } else if (photos.length === 0 && status !== 'ready') {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  } else if (photos.length === 0) {
    body = (
      <View>
        <EmptyState
          icon={Images}
          title="Aucune photo sur le serveur"
          hint={backupOn ? "Les photos du téléphone arrivent ici dès qu'elles sont envoyées : l'état de l'envoi est indiqué plus haut." : 'Activez la sauvegarde automatique dans Réglages : vos photos apparaîtront ici.'}
        />
        {!backupOn && (
          <View style={styles.centerButton}>
            <Pressable style={styles.button} onPress={() => router.navigate('/settings')} accessibilityRole="button">
              <Text style={styles.buttonText}>Ouvrir les réglages</Text>
            </Pressable>
          </View>
        )}
      </View>
    )
  } else if (visible.length === 0) {
    body = <EmptyState icon={Search} title="Aucun résultat" hint="Rien ne correspond à ces filtres ou à cette recherche." />
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
        removeClippedSubviews
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: layout.contentBottom }}
        refreshControl={<RefreshControl refreshing={pulled} onRefresh={pull} tintColor={colors.accent} colors={[colors.accent]} />}
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

  const count = countLabel(photos)
  const filtered = query !== '' || activeKind !== 'all' || activeAlbum !== ALL_ALBUMS
  const subtitle =
    photos.length === 0 && status !== 'ready'
      ? 'Chargement…'
      : `${filtered ? `${countLabel(visible)} sur ${photos.length}` : count} · ${SORT_LABELS[sort]}${status === 'loading' ? ' · actualisation…' : ''}`

  return (
    <Screen>
      {selecting ? (
        <SelectionBar count={selection.size} onClear={() => setSelection(new Set())} actions={selectionActions} />
      ) : (
        <>
          <ScreenHeader
            title="Photos"
            action={
              <View style={styles.actions}>
                <Pressable onPress={() => setSearching((on) => !on)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Rechercher">
                  <Search size={22} color={searching ? colors.accent : colors.text} />
                </Pressable>
                <Pressable onPress={() => setSortSheet(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Trier les photos">
                  <ArrowUpDown size={22} color={colors.text} />
                </Pressable>
                <Pressable onPress={() => router.push('/trash')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Corbeille">
                  <Trash2 size={22} color={colors.text} />
                </Pressable>
              </View>
            }
          />
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </>
      )}
      {searching && !selecting && (
        <SearchField
          value={query}
          onChange={setQuery}
          onClose={() => {
            setQuery('')
            setSearching(false)
          }}
        />
      )}
      <SyncStrip />
      {hasVideos && !selecting && (
        <Chips
          label="Afficher"
          items={(Object.keys(KIND_LABELS) as KindFilter[]).map((id) => ({ id, label: KIND_LABELS[id] }))}
          value={activeKind}
          onChange={(id) => setKind(id as KindFilter)}
        />
      )}
      {albums.length > 0 && !selecting && <Chips label="Albums" items={albums} value={activeAlbum} onChange={setAlbum} />}
      {body}
      {working && (
        <View style={styles.working} pointerEvents="auto">
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.workingText}>{working}</Text>
        </View>
      )}

      <ActionSheet
        visible={sortSheet}
        title="Trier par"
        items={(Object.keys(SORT_LABELS) as SortKey[]).map<ActionSheetItem>((key) => ({
          label: `${key === sort ? '✓ ' : ''}${SORT_LABELS[key]}`,
          icon: ArrowUpDown,
          onPress: () => setSort(key)
        }))}
        onClose={() => setSortSheet(false)}
      />
      {viewerAt !== null && (
        <PhotoViewer photos={visible} client={client} startIndex={viewerAt} onClose={() => setViewerAt(null)} actions={viewerActions} describe={describe} />
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerButton: { alignItems: 'center', marginTop: spacing.sm },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  subtitle: { flexShrink: 0, color: colors.textMuted, fontSize: 12, lineHeight: 16, paddingHorizontal: spacing.lg, marginTop: -spacing.sm, marginBottom: spacing.md },
  row: { flexDirection: 'row', gap: GAP, marginBottom: GAP },
  monthHeader: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  monthTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  monthCount: { color: colors.textMuted, fontSize: 12 },
  footer: { padding: spacing.lg, gap: spacing.xs },
  footerText: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  working: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: 'rgba(0,0,0,0.55)' },
  workingText: { color: colors.text, fontSize: 14 },
  button: { backgroundColor: colors.accent, borderRadius: 999, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm + 2 },
  buttonText: { color: '#000000', fontWeight: '800', fontSize: 14 }
})
