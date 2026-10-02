import { useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { ArrowLeft, Folder, X } from 'lucide-react-native'
import type { FBItem, FileBrowserClient } from '@/services/filebrowser'
import { baseName, parentPath } from '@/services/fileNames'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  client: FileBrowserClient
  /** Where to start looking (usually the folder the items are in). */
  startPath: string
  title: string
  confirmLabel: string
  /** Folders that can't be the destination, nor be entered: the ones being moved, which can't go inside themselves. */
  blocked?: string[]
  /** The folder the items are in already: moving there would do nothing. */
  currentFolder?: string
  onPick: (folder: string) => void
  onClose: () => void
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

function isBlocked(path: string, blocked: string[]): boolean {
  return blocked.some((b) => path === b || path.startsWith(`${b}/`))
}

/** A list of folders to walk through and pick one from. */
export default function FolderPicker({ client, startPath, title, confirmLabel, blocked = [], currentFolder, onPick, onClose }: Props) {
  const [path, setPath] = useState(startPath || '/')
  const [folders, setFolders] = useState<FBItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    setLoading(true)
    setError(null)
    client
      .list(path)
      .then((items) => {
        if (!stale) setFolders(items.filter((i) => i.isDir).sort((a, b) => collator.compare(a.name, b.name)))
      })
      .catch((err) => {
        if (!stale) {
          setFolders([])
          setError(err instanceof Error ? err.message : 'Impossible de lister le dossier')
        }
      })
      .finally(() => {
        if (!stale) setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [client, path])

  const here = path === '/' ? 'Racine' : baseName(path)
  const unusable = isBlocked(path, blocked) || path === currentFolder

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer">
              <X size={22} color={colors.text} />
            </Pressable>
          </View>
          <View style={styles.location}>
            <Pressable
              onPress={() => setPath(parentPath(path))}
              disabled={path === '/'}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Dossier parent"
            >
              <ArrowLeft size={20} color={path === '/' ? colors.textMuted : colors.text} />
            </Pressable>
            <Text style={styles.path} numberOfLines={1}>
              {path}
            </Text>
          </View>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : error ? (
            <View style={styles.center}>
              <Text style={styles.empty}>{error}</Text>
            </View>
          ) : (
            <FlatList
              data={folders}
              keyExtractor={(item) => item.path}
              style={styles.list}
              ListEmptyComponent={<Text style={styles.empty}>Aucun sous-dossier</Text>}
              renderItem={({ item }) => {
                const disabled = isBlocked(item.path, blocked)
                return (
                  <Pressable style={[styles.row, disabled && styles.disabled]} disabled={disabled} onPress={() => setPath(item.path)} accessibilityRole="button">
                    <Folder size={20} color="#60a5fa" />
                    <Text style={styles.name} numberOfLines={1}>
                      {item.name}
                    </Text>
                  </Pressable>
                )
              }}
            />
          )}
          <Pressable
            style={[styles.confirm, unusable && styles.confirmOff]}
            disabled={unusable}
            onPress={() => onPick(path)}
            accessibilityRole="button"
            accessibilityLabel={`${confirmLabel} dans ${here}`}
          >
            <Text style={[styles.confirmText, unusable && { color: colors.textMuted }]} numberOfLines={1}>
              {unusable && path === currentFolder ? 'Ces éléments sont déjà ici' : `${confirmLabel} dans « ${here} »`}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { height: '75%', backgroundColor: colors.elevated, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingTop: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '700', marginRight: spacing.md },
  location: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  path: { flex: 1, color: colors.textSecondary, fontSize: 12 },
  list: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  empty: { color: colors.textMuted, fontSize: 13, textAlign: 'center', padding: spacing.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  disabled: { opacity: 0.35 },
  name: { flex: 1, color: colors.text, fontSize: 15 },
  confirm: { margin: spacing.lg, borderRadius: radius.full, backgroundColor: colors.accent, paddingVertical: spacing.md, alignItems: 'center' },
  confirmOff: { backgroundColor: colors.hover },
  confirmText: { color: '#000000', fontWeight: '800', fontSize: 14 }
})
