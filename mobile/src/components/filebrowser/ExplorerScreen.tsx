import { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl, Alert, Linking, ActivityIndicator, BackHandler } from 'react-native'
import { useRouter } from 'expo-router'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as Clipboard from 'expo-clipboard'
import {
  ArrowLeft,
  ArrowRight,
  LogOut,
  FolderPlus,
  FolderInput,
  Upload,
  FolderOpen,
  Eye,
  Download,
  Link2,
  Pencil,
  Search,
  Trash2
} from 'lucide-react-native'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { expectExternalScreen } from '@/services/appLock'
import { useUploadStore } from '@/store/uploadStore'
import { useDownloadStore } from '@/store/downloadStore'
import { useToastStore } from '@/store/toastStore'
import { FBItem, SearchHit } from '@/services/filebrowser'
import { baseName, childPath, parentPath, samePath } from '@/services/fileNames'
import { ConflictChoice, findConflicts, planUploads } from '@/services/uploadConflicts'
import { SHARE_DURATIONS } from '@/services/shareLinks'
import { hidePeerFolders } from '@/services/photoVault'
import { useCameraBackupStore } from '@/store/cameraBackupStore'
import { useIsOwner } from '@/hooks/useIsOwner'
import FileRow from './FileRow'
import FilesSelectionBar from './FilesSelectionBar'
import FolderPicker from './FolderPicker'
import PreviewModal from './PreviewModal'
import UsageMeter from './UsageMeter'
import ActionSheet, { ActionSheetItem } from '@/components/ActionSheet'
import PromptModal from '@/components/PromptModal'
import { SearchField } from '@/components/photos/PhotosChrome'
import { EmptyState } from '@/components/Screen'
import { colors, layout, radius, spacing } from '@/constants/theme'

const MIN_SEARCH_LENGTH = 2
const SEARCH_DELAY_MS = 400

function reason(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Erreur inconnue'
}

function hitToItem(hit: SearchHit): FBItem {
  return { name: hit.name, path: hit.path, size: hit.size, isDir: hit.isDir, modified: hit.modified, type: hit.type, hasPreview: hit.hasPreview }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`
}

export default function ExplorerScreen() {
  const router = useRouter()
  const currentPath = useFileBrowserStore((s) => s.currentPath)
  const items = useFileBrowserStore((s) => s.items)
  const loading = useFileBrowserStore((s) => s.loading)
  const client = useFileBrowserStore((s) => s.client)
  const navigate = useFileBrowserStore((s) => s.navigate)
  const goBack = useFileBrowserStore((s) => s.goBack)
  const goForward = useFileBrowserStore((s) => s.goForward)
  const canGoBack = useFileBrowserStore((s) => s.canGoBack)
  const canGoForward = useFileBrowserStore((s) => s.canGoForward)
  const refresh = useFileBrowserStore((s) => s.refresh)
  const logout = useFileBrowserStore((s) => s.logout)
  const startUpload = useUploadStore((s) => s.startUpload)
  const uploadTasks = useUploadStore((s) => s.tasks)
  const uploadsFinished = useUploadStore((s) => s.finished)
  const recordDownload = useDownloadStore((s) => s.record)
  const showToast = useToastStore((s) => s.show)

  const [menuItem, setMenuItem] = useState<{ item: FBItem; fromSearch: boolean } | null>(null)
  const [preview, setPreview] = useState<FBItem | null>(null)
  const [renaming, setRenaming] = useState<FBItem | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [selection, setSelection] = useState<ReadonlyMap<string, FBItem>>(new Map())
  const [moving, setMoving] = useState<FBItem[] | null>(null)
  const [sharing, setSharing] = useState<FBItem | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FBItem[] | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchNonce, setSearchNonce] = useState(0)

  // Inside the central photo-backup folder an account is shown only its own sub-folder. The server's scope
  // for the account is what really keeps other accounts out; this just doesn't list what isn't theirs.
  // The server's owner sees everything.
  const backupFolder = useCameraBackupStore((s) => s.settings.folder)
  const isOwner = useIsOwner()
  const shownItems = useMemo(
    () => (isOwner || !client ? items : hidePeerFolders(items, currentPath, backupFolder, client.getAccountName())),
    [items, currentPath, backupFolder, client, isOwner]
  )

  const selecting = selection.size > 0
  const showingHits = searching && query.trim().length >= MIN_SEARCH_LENGTH

  // A finished upload shows up in the folder it went to, without a pull to refresh.
  const seenUploads = useRef(uploadsFinished.seq)
  useEffect(() => {
    if (uploadsFinished.seq === seenUploads.current) return
    seenUploads.current = uploadsFinished.seq
    if (samePath(uploadsFinished.destPath, currentPath)) refresh()
  }, [uploadsFinished.seq, uploadsFinished.destPath, currentPath, refresh])

  // Back leaves the selection, then the search, as in any file manager.
  useEffect(() => {
    if (!selecting && !searching) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selecting) setSelection(new Map())
      else closeSearch()
      return true
    })
    return () => subscription.remove()
  }, [selecting, searching])

  // Search as the name is typed, a moment after the last key, ignoring answers that arrive late.
  useEffect(() => {
    if (!searching || !client) return
    const text = query.trim()
    if (text.length < MIN_SEARCH_LENGTH) {
      setHits(null)
      setSearchError(null)
      setSearchBusy(false)
      return
    }
    let stale = false
    setSearchBusy(true)
    const timer = setTimeout(() => {
      client
        .search(text, currentPath)
        .then((found) => {
          if (stale) return
          setHits(found.map(hitToItem))
          setSearchError(null)
        })
        .catch((err) => {
          if (stale) return
          setHits([])
          setSearchError(reason(err))
        })
        .finally(() => {
          if (!stale) setSearchBusy(false)
        })
    }, SEARCH_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, searching, currentPath, client, searchNonce])

  if (!client) return <View style={styles.container} />

  const crumbs = currentPath.split('/').filter(Boolean)

  function closeSearch(): void {
    setSearching(false)
    setQuery('')
    setHits(null)
    setSearchError(null)
  }

  function toggle(item: FBItem): void {
    setSelection((previous) => {
      const next = new Map(previous)
      if (next.has(item.path)) next.delete(item.path)
      else next.set(item.path, item)
      return next
    })
  }

  /** Saves the file, logs it in the Downloads tab, then hands it to another app. */
  async function saveToDevice(item: FBItem): Promise<string> {
    const uri = await client!.downloadToDevice(item.path, item.name)
    const file = new File(uri)
    await recordDownload({
      filename: file.name,
      sourcePath: item.path,
      sizeBytes: file.size ?? item.size,
      downloadedAt: Date.now()
    })
    return uri
  }

  async function openExternally(item: FBItem): Promise<void> {
    if (!client) return
    setBusy('Ouverture…')
    try {
      const uri = await saveToDevice(item)
      const contentUri = new File(uri).contentUri
      expectExternalScreen()
      await Linking.openURL(contentUri)
    } catch {
      Alert.alert('Impossible', "Aucune application ne peut ouvrir ce fichier, ou le téléchargement a échoué.")
    } finally {
      setBusy(null)
    }
  }

  function handleItemPress(item: FBItem, fromSearch = false): void {
    if (selecting) {
      toggle(item)
      return
    }
    if (item.isDir) {
      if (fromSearch) closeSearch()
      navigate(item.path)
      return
    }
    const type = item.type || ''
    if (type.includes('image') || type.includes('text')) {
      setPreview(item)
    } else {
      openExternally(item)
    }
  }

  async function handlePickUpload(): Promise<void> {
    if (!client) return
    expectExternalScreen()
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (result.canceled) return
    const assets = result.assets
    const names = assets.map((a) => a.name)
    // Names already in the folder, plus those still on their way there.
    const taken = new Set([
      ...items.map((i) => i.name),
      ...uploadTasks.filter((t) => t.destPath === currentPath && (t.status === 'queued' || t.status === 'uploading')).map((t) => t.filename)
    ])
    const send = (choice: ConflictChoice): void => {
      for (const planned of planUploads(names, taken, choice)) {
        const asset = assets[planned.index]
        void startUpload({ uri: asset.uri, name: planned.name, size: asset.size || 0 }, currentPath, client, { override: planned.override })
      }
    }
    const conflicts = findConflicts(names, taken)
    if (conflicts.length === 0) {
      send('keep-both')
      return
    }
    const first = names[conflicts[0]]
    Alert.alert(
      conflicts.length === 1 ? 'Ce fichier existe déjà' : `${conflicts.length} fichiers existent déjà`,
      conflicts.length === 1
        ? `« ${first} » est déjà dans ce dossier. Que faire ? (Touchez en dehors pour annuler.)`
        : `« ${first} » et ${plural(conflicts.length - 1, 'autre', 'autres')} sont déjà dans ce dossier. Que faire ? (Touchez en dehors pour annuler.)`,
      [
        { text: 'Ignorer', onPress: () => send('skip') },
        { text: 'Garder les deux', onPress: () => send('keep-both') },
        { text: 'Remplacer', style: 'destructive', onPress: () => send('replace') }
      ],
      { cancelable: true }
    )
  }

  async function handleCreateFolder(name: string): Promise<void> {
    if (!client) return
    setCreatingFolder(false)
    if (name.includes('/') || name === '.' || name === '..') {
      Alert.alert('Nom invalide', "Un nom de dossier ne peut pas contenir « / ».")
      return
    }
    try {
      await client.createFolder(childPath(currentPath, name))
    } catch (err: any) {
      Alert.alert(
        'Dossier non créé',
        err?.status === 409 ? `« ${name} » existe déjà.` : err?.status === 403 ? "Ce compte n'a pas le droit de créer des dossiers ici." : reason(err)
      )
    }
    await refresh()
  }

  async function handleRename(name: string): Promise<void> {
    if (!client || !renaming) return
    const target = renaming
    setRenaming(null)
    if (name.includes('/') || name === '.' || name === '..') {
      Alert.alert('Nom invalide', "Un nom ne peut pas contenir « / ».")
      return
    }
    if (name === target.name) return
    try {
      await client.rename(target.path, childPath(parentPath(target.path), name))
      setSearchNonce((n) => n + 1)
    } catch (err) {
      Alert.alert('Renommage impossible', reason(err))
    }
    await refresh()
  }

  function confirmDelete(targets: FBItem[]): void {
    const one = targets.length === 1
    Alert.alert(
      one ? 'Supprimer' : `Supprimer ${targets.length} éléments ?`,
      one ? `Supprimer « ${targets[0].name} » ?` : 'Ils seront supprimés définitivement du serveur.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Supprimer', style: 'destructive', onPress: () => void deleteItems(targets) }
      ]
    )
  }

  async function deleteItems(targets: FBItem[]): Promise<void> {
    if (!client) return
    setBusy('Suppression…')
    try {
      const result = await client.removeMany(targets.map((t) => t.path))
      if (result.failed.length > 0) {
        Alert.alert('Suppression incomplète', `${plural(result.failed.length, 'élément n\'a', 'éléments n\'ont')} pas pu être supprimé${result.failed.length > 1 ? 's' : ''} : ${result.failed[0].message}`)
      } else {
        showToast(pick(targets.length, 'Supprimé', `${targets.length} éléments supprimés`))
      }
      const gone = new Set(result.done)
      setHits((previous) => (previous ? previous.filter((h) => !gone.has(h.path)) : previous))
    } catch (err) {
      Alert.alert('Suppression impossible', reason(err))
    } finally {
      setBusy(null)
      setSelection(new Map())
      await refresh()
    }
  }

  async function moveItems(targets: FBItem[], destination: string): Promise<void> {
    if (!client) return
    setMoving(null)
    setBusy('Déplacement…')
    try {
      const result = await client.move(targets.map((t) => t.path), destination)
      if (result.failed.length > 0) {
        Alert.alert('Déplacement incomplet', `${plural(result.failed.length, 'élément n\'a', 'éléments n\'ont')} pas pu être déplacé${result.failed.length > 1 ? 's' : ''} : ${result.failed[0].message}`)
      } else {
        showToast(pick(targets.length, 'Déplacé', `${targets.length} éléments déplacés`))
      }
      setSearchNonce((n) => n + 1)
    } catch (err) {
      Alert.alert('Déplacement impossible', reason(err))
    } finally {
      setBusy(null)
      setSelection(new Map())
      await refresh()
    }
  }

  /** One file as it is; anything else (a folder, or several things) as a zip. Either way it lands in the Downloads tab. */
  async function downloadItems(targets: FBItem[]): Promise<void> {
    if (!client) return
    setBusy('Téléchargement…')
    try {
      if (targets.length === 1 && !targets[0].isDir) {
        await saveToDevice(targets[0])
        Alert.alert('Téléchargé', `« ${targets[0].name} » est disponible dans l'onglet Téléchargements.`)
      } else {
        const name = targets.length === 1 ? `${targets[0].name}.zip` : `selection-${new Date().toISOString().slice(0, 10)}.zip`
        const uri = await client.downloadArchive(targets.map((t) => t.path), name)
        const file = new File(uri)
        await recordDownload({ filename: file.name, sourcePath: targets.map((t) => t.path).join(', '), sizeBytes: file.size ?? 0, downloadedAt: Date.now() })
        Alert.alert('Téléchargé', `« ${file.name} » est disponible dans l'onglet Téléchargements.`)
      }
    } catch (err) {
      Alert.alert('Échec', `Le téléchargement a échoué : ${reason(err)}`)
    } finally {
      setBusy(null)
      setSelection(new Map())
    }
  }

  async function makeShare(item: FBItem, label: string, duration: (typeof SHARE_DURATIONS)[number]['duration']): Promise<void> {
    if (!client) return
    setBusy('Création du lien…')
    try {
      const link = await client.createShare(item.path, duration)
      await Clipboard.setStringAsync(link.url)
      showToast(duration ? `Lien copié (valable ${label})` : 'Lien copié (sans limite de durée)')
      await refresh()
    } catch (err) {
      Alert.alert('Lien impossible', reason(err))
    } finally {
      setBusy(null)
      setSelection(new Map())
    }
  }

  function buildMenuItems(item: FBItem, fromSearch: boolean): ActionSheetItem[] {
    const list: ActionSheetItem[] = []
    if (fromSearch) {
      list.push({
        label: 'Afficher dans son dossier',
        icon: FolderOpen,
        onPress: () => {
          closeSearch()
          navigate(item.isDir ? item.path : parentPath(item.path))
        }
      })
    }
    list.push(
      item.isDir
        ? { label: 'Ouvrir', icon: FolderOpen, onPress: () => handleItemPress(item, fromSearch) }
        : { label: 'Aperçu', icon: Eye, onPress: () => handleItemPress(item, fromSearch) }
    )
    list.push(
      { label: item.isDir ? 'Télécharger en zip' : 'Télécharger', icon: Download, onPress: () => void downloadItems([item]) },
      { label: 'Créer un lien de partage', icon: Link2, onPress: () => setSharing(item) },
      { label: 'Déplacer…', icon: FolderInput, onPress: () => setMoving([item]) },
      { label: 'Renommer', icon: Pencil, onPress: () => setRenaming(item) },
      { label: 'Supprimer', icon: Trash2, danger: true, onPress: () => confirmDelete([item]) }
    )
    return list
  }

  const selected = [...selection.values()]
  const data: FBItem[] = showingHits ? (hits ?? []) : shownItems

  return (
    <View style={styles.container}>
      {selecting ? (
        <FilesSelectionBar
          count={selection.size}
          onClear={() => setSelection(new Map())}
          actions={[
            { label: 'Télécharger', icon: Download, onPress: () => void downloadItems(selected) },
            ...(selected.length === 1 ? [{ label: 'Créer un lien de partage', icon: Link2, onPress: () => setSharing(selected[0]) }] : []),
            { label: 'Déplacer', icon: FolderInput, onPress: () => setMoving(selected) },
            { label: 'Supprimer', icon: Trash2, danger: true, onPress: () => confirmDelete(selected) }
          ]}
        />
      ) : (
        <View style={styles.topBar}>
          <Pressable onPress={() => goBack()} disabled={!canGoBack} hitSlop={10}>
            <ArrowLeft size={20} color={canGoBack ? colors.text : colors.textMuted} />
          </Pressable>
          <Pressable onPress={() => goForward()} disabled={!canGoForward} hitSlop={10}>
            <ArrowRight size={20} color={canGoForward ? colors.text : colors.textMuted} />
          </Pressable>
          <Text style={styles.breadcrumb} numberOfLines={1}>
            {crumbs.length === 0 ? 'Racine' : `/${crumbs.join('/')}`}
          </Text>
          <Pressable onPress={() => setSearching((on) => !on)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Rechercher des fichiers">
            <Search size={18} color={searching ? colors.accent : colors.textSecondary} />
          </Pressable>
          <Pressable onPress={() => router.push('/shares')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Liens de partage">
            <Link2 size={18} color={colors.textSecondary} />
          </Pressable>
          <Pressable onPress={() => logout()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Se déconnecter de FileBrowser">
            <LogOut size={18} color={colors.textSecondary} />
          </Pressable>
        </View>
      )}

      {searching && !selecting && (
        <View style={styles.searchWrap}>
          <SearchField
            value={query}
            onChange={setQuery}
            onClose={closeSearch}
            placeholder={`Rechercher dans ${currentPath === '/' ? 'tout le serveur' : `« ${baseName(currentPath)} »`}`}
            label="Rechercher des fichiers et des dossiers par leur nom"
          />
        </View>
      )}

      {!searching && !selecting && <UsageMeter />}

      {!searching && !selecting && (
        <View style={styles.actionsRow}>
          <Pressable style={styles.actionButton} onPress={() => setCreatingFolder(true)}>
            <FolderPlus size={14} color={colors.textSecondary} />
            <Text style={styles.actionButtonText}>Nouveau dossier</Text>
          </Pressable>
          <Pressable style={[styles.actionButton, styles.actionButtonPrimary]} onPress={handlePickUpload}>
            <Upload size={14} color="#000" />
            <Text style={[styles.actionButtonText, { color: '#000' }]}>Uploader</Text>
          </Pressable>
        </View>
      )}

      {showingHits && searchBusy && hits === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : loading && !showingHits ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(i) => i.path}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          initialNumToRender={14}
          maxToRenderPerBatch={14}
          windowSize={7}
          removeClippedSubviews
          extraData={selection}
          refreshControl={
            showingHits ? undefined : <RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} colors={[colors.accent]} />
          }
          ListEmptyComponent={
            showingHits ? (
              <EmptyState
                icon={Search}
                title={searchError ? 'Recherche impossible' : 'Aucun résultat'}
                hint={searchError ?? 'Seuls les fichiers déjà indexés par le serveur sont trouvés.'}
              />
            ) : searching ? (
              <EmptyState icon={Search} title="Rechercher" hint={`Tapez au moins ${MIN_SEARCH_LENGTH} lettres du nom d'un fichier ou d'un dossier.`} />
            ) : (
              <EmptyState icon={FolderOpen} title="Dossier vide" hint="Utilisez Uploader pour y ajouter des fichiers." />
            )
          }
          renderItem={({ item }) => (
            <FileRow
              item={item}
              subtitle={showingHits ? parentPath(item.path) : undefined}
              selecting={selecting}
              selected={selection.has(item.path)}
              onPress={() => handleItemPress(item, showingHits)}
              onLongPress={() => toggle(item)}
              onMenu={() => setMenuItem({ item, fromSearch: showingHits })}
            />
          )}
        />
      )}

      {busy && (
        <View style={styles.openingOverlay}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.busyText}>{busy}</Text>
        </View>
      )}

      {preview && <PreviewModal item={preview} client={client} onClose={() => setPreview(null)} />}

      {moving && (
        <FolderPicker
          client={client}
          startPath={parentPath(moving[0].path)}
          currentFolder={parentPath(moving[0].path)}
          title={moving.length === 1 ? `Déplacer « ${moving[0].name} »` : `Déplacer ${moving.length} éléments`}
          confirmLabel="Déplacer"
          blocked={moving.filter((m) => m.isDir).map((m) => m.path)}
          onPick={(folder) => void moveItems(moving, folder)}
          onClose={() => setMoving(null)}
        />
      )}

      <ActionSheet
        visible={!!menuItem}
        title={menuItem?.item.name}
        items={menuItem ? buildMenuItems(menuItem.item, menuItem.fromSearch) : []}
        onClose={() => setMenuItem(null)}
      />

      <ActionSheet
        visible={!!sharing}
        title={sharing ? `Lien de partage : « ${sharing.name} » valable…` : undefined}
        items={SHARE_DURATIONS.map<ActionSheetItem>(({ label, duration }) => ({
          label,
          icon: Link2,
          onPress: () => sharing && void makeShare(sharing, label, duration)
        }))}
        onClose={() => setSharing(null)}
      />

      <PromptModal
        visible={creatingFolder}
        title="Nouveau dossier"
        confirmLabel="Créer"
        onCancel={() => setCreatingFolder(false)}
        onConfirm={handleCreateFolder}
      />
      <PromptModal
        visible={!!renaming}
        title="Renommer"
        initialValue={renaming?.name}
        confirmLabel="Renommer"
        onCancel={() => setRenaming(null)}
        onConfirm={handleRename}
      />
    </View>
  )
}

function pick(count: number, single: string, many: string): string {
  return count === 1 ? single : many
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, minHeight: 44 },
  breadcrumb: { flex: 1, color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
  searchWrap: { paddingTop: spacing.sm },
  actionsRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  actionButtonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  actionButtonText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  list: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  openingOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm
  },
  busyText: { color: colors.text, fontSize: 13, fontWeight: '600' }
})
