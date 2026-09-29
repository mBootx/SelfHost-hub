import { useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl, Alert, Linking, ActivityIndicator } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as Clipboard from 'expo-clipboard'
import {
  ArrowLeft,
  ArrowRight,
  LogOut,
  FolderPlus,
  Upload,
  FolderOpen,
  Eye,
  Download,
  Link2,
  Pencil,
  Trash2
} from 'lucide-react-native'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useUploadStore } from '@/store/uploadStore'
import { useDownloadStore } from '@/store/downloadStore'
import { FBItem } from '@/services/filebrowser'
import FileRow, { isPdf } from './FileRow'
import PreviewModal from './PreviewModal'
import UsageMeter from './UsageMeter'
import ActionSheet, { ActionSheetItem } from '@/components/ActionSheet'
import PromptModal from '@/components/PromptModal'
import { EmptyState } from '@/components/Screen'
import { colors, layout, radius, spacing } from '@/constants/theme'

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

export default function ExplorerScreen() {
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
  const recordDownload = useDownloadStore((s) => s.record)

  const [menuItem, setMenuItem] = useState<FBItem | null>(null)
  const [preview, setPreview] = useState<FBItem | null>(null)
  const [renaming, setRenaming] = useState<FBItem | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [opening, setOpening] = useState(false)

  if (!client) return <View style={styles.container} />

  const crumbs = currentPath.split('/').filter(Boolean)

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
    setOpening(true)
    try {
      const uri = await saveToDevice(item)
      const contentUri = new File(uri).contentUri
      await Linking.openURL(contentUri)
    } catch {
      Alert.alert('Impossible', "Aucune application ne peut ouvrir ce fichier, ou le téléchargement a échoué.")
    } finally {
      setOpening(false)
    }
  }

  function handleItemPress(item: FBItem): void {
    if (item.isDir) {
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
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (result.canceled) return
    for (const asset of result.assets) {
      startUpload({ uri: asset.uri, name: asset.name, size: asset.size || 0 }, currentPath, client)
    }
  }

  async function handleCreateFolder(name: string): Promise<void> {
    if (!client) return
    setCreatingFolder(false)
    await client.createFolder(`${currentPath}/${name}`)
    await refresh()
  }

  async function handleRename(name: string): Promise<void> {
    if (!client || !renaming) return
    const parent = renaming.path.split('/').slice(0, -1).join('/')
    setRenaming(null)
    await client.rename(renaming.path, `${parent}/${name}`)
    await refresh()
  }

  function buildMenuItems(item: FBItem): ActionSheetItem[] {
    const openItem: ActionSheetItem = item.isDir
      ? { label: 'Ouvrir', icon: FolderOpen, onPress: () => navigate(item.path) }
      : { label: 'Aperçu', icon: Eye, onPress: () => handleItemPress(item) }
    const list: ActionSheetItem[] = [openItem]
    if (!item.isDir) {
      list.push({
        label: 'Télécharger',
        icon: Download,
        onPress: async () => {
          try {
            await saveToDevice(item)
            Alert.alert('Téléchargé', `"${item.name}" est disponible dans l'onglet Téléchargements.`)
          } catch {
            Alert.alert('Échec', 'Le téléchargement a échoué.')
          }
        }
      })
    }
    list.push(
      { label: 'Copier le lien', icon: Link2, onPress: () => Clipboard.setStringAsync(client!.rawUrl(item.path)) },
      { label: 'Renommer', icon: Pencil, onPress: () => setRenaming(item) },
      {
        label: 'Supprimer',
        icon: Trash2,
        danger: true,
        onPress: () =>
          Alert.alert('Supprimer', `Supprimer "${item.name}" ?`, [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Supprimer', style: 'destructive', onPress: async () => { await client!.remove(item.path); await refresh() } }
          ])
      }
    )
    return list
  }

  return (
    <View style={styles.container}>
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
        <Pressable onPress={() => logout()} hitSlop={10}>
          <LogOut size={18} color={colors.textSecondary} />
        </Pressable>
      </View>

      <UsageMeter />

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

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.path}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          initialNumToRender={14}
          maxToRenderPerBatch={14}
          windowSize={7}
          removeClippedSubviews
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} colors={[colors.accent]} />
          }
          ListEmptyComponent={<EmptyState icon={FolderOpen} title="Dossier vide" hint="Utilisez Uploader pour y ajouter des fichiers." />}
          renderItem={({ item }) => (
            <FileRow item={item} onPress={() => handleItemPress(item)} onMenu={() => setMenuItem(item)} />
          )}
        />
      )}

      {opening && (
        <View style={styles.openingOverlay}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}

      {preview && <PreviewModal item={preview} client={client} onClose={() => setPreview(null)} />}

      <ActionSheet
        visible={!!menuItem}
        title={menuItem?.name}
        items={menuItem ? buildMenuItems(menuItem) : []}
        onClose={() => setMenuItem(null)}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  breadcrumb: { flex: 1, color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
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
    justifyContent: 'center'
  }
})
