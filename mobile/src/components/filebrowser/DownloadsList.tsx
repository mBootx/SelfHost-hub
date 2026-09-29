import { useState } from 'react'
import { View, Text, FlatList, Pressable, Alert, Linking, StyleSheet } from 'react-native'
import { File } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { Download, Share2, Trash2 } from 'lucide-react-native'
import { useDownloadStore, DownloadedFile } from '@/store/downloadStore'
import { EmptyState } from '@/components/Screen'
import { FBItem } from '@/services/filebrowser'
import { iconFor } from './FileRow'
import { colors, layout, radius, spacing } from '@/constants/theme'

function formatSize(bytes: number): string {
  if (!bytes) return '-'
  const units = ['o', 'Ko', 'Mo', 'Go']
  let i = 0
  let value = bytes
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** iconFor() picks its glyph from the name and type, which is all a local file has. */
function asItem(file: DownloadedFile): FBItem {
  return {
    name: file.filename,
    path: file.sourcePath,
    size: file.sizeBytes,
    isDir: false,
    modified: new Date(file.downloadedAt).toISOString()
  }
}

export default function DownloadsList() {
  const files = useDownloadStore((s) => s.files)
  const remove = useDownloadStore((s) => s.remove)
  const clear = useDownloadStore((s) => s.clear)
  const uriFor = useDownloadStore((s) => s.uriFor)
  const [busy, setBusy] = useState<string | null>(null)

  async function open(file: DownloadedFile): Promise<void> {
    setBusy(file.filename)
    try {
      // content:// rather than file://, which Android refuses to hand to other apps.
      const contentUri = new File(uriFor(file.filename)).contentUri
      await Linking.openURL(contentUri)
    } catch {
      Alert.alert('Impossible', "Aucune application ne peut ouvrir ce fichier.")
    } finally {
      setBusy(null)
    }
  }

  async function share(file: DownloadedFile): Promise<void> {
    if (!(await Sharing.isAvailableAsync())) return
    await Sharing.shareAsync(uriFor(file.filename))
  }

  function confirmRemove(file: DownloadedFile): void {
    Alert.alert('Supprimer', `Supprimer "${file.filename}" de cet appareil ?`, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: () => remove(file.filename) }
    ])
  }

  function confirmClear(): void {
    Alert.alert('Tout supprimer', `Supprimer les ${files.length} fichiers téléchargés ?`, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: () => clear() }
    ])
  }

  return (
    <FlatList
      data={files}
      keyExtractor={(f) => f.filename}
      contentContainerStyle={styles.list}
      showsVerticalScrollIndicator={false}
      removeClippedSubviews
      initialNumToRender={12}
      windowSize={7}
      ListHeaderComponent={
        files.length > 0 ? (
          <Pressable onPress={confirmClear} style={({ pressed }) => [styles.clear, pressed && styles.pressed]}>
            <Text style={styles.clearText}>Tout supprimer</Text>
          </Pressable>
        ) : null
      }
      ListEmptyComponent={
        <EmptyState
          icon={Download}
          title="Aucun téléchargement"
          hint="Les fichiers que vous téléchargez depuis le serveur restent ici, même hors-ligne."
        />
      }
      renderItem={({ item }) => (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => open(item)}
          disabled={busy === item.filename}
          accessibilityRole="button"
          accessibilityLabel={`Ouvrir ${item.filename}`}
        >
          <View style={styles.iconWrap}>{iconFor(asItem(item))}</View>
          <View style={styles.info}>
            <Text style={styles.name} numberOfLines={1}>
              {item.filename}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {formatSize(item.sizeBytes)} - {formatDate(item.downloadedAt)}
            </Text>
          </View>
          <Pressable onPress={() => share(item)} hitSlop={8} style={styles.action} accessibilityLabel="Partager">
            <Share2 size={17} color={colors.textMuted} />
          </Pressable>
          <Pressable onPress={() => confirmRemove(item)} hitSlop={8} style={styles.action} accessibilityLabel="Supprimer">
            <Trash2 size={17} color={colors.textMuted} />
          </Pressable>
        </Pressable>
      )}
    />
  )
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, borderRadius: radius.sm },
  pressed: { opacity: 0.6 },
  iconWrap: { width: 32, alignItems: 'center' },
  info: { flex: 1, minWidth: 0 },
  name: { color: colors.text, fontSize: 14, fontWeight: '500' },
  meta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  action: { padding: spacing.xs },
  clear: { alignSelf: 'flex-end', paddingVertical: spacing.xs },
  clearText: { color: colors.textMuted, fontSize: 12 }
})
