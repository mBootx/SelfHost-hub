import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Check, Folder, File as FileIcon, Image as ImageIcon, Video, Music, FileText, FileType, Link2, MoreVertical } from 'lucide-react-native'
import { FBItem } from '@/services/filebrowser'
import { colors, spacing } from '@/constants/theme'

function formatSize(bytes: number): string {
  if (!bytes) return '-'
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  let i = 0
  let value = bytes
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

export function isPdf(item: FBItem): boolean {
  return (item.type || '').includes('pdf') || item.name.toLowerCase().endsWith('.pdf')
}

export function iconFor(item: FBItem, size = 22) {
  if (item.isDir) return <Folder size={size} color="#60a5fa" />
  if (isPdf(item)) return <FileType size={size} color={colors.danger} />
  const type = item.type || ''
  if (type.includes('image')) return <ImageIcon size={size} color="#c084fc" />
  if (type.includes('video')) return <Video size={size} color="#f472b6" />
  if (type.includes('audio')) return <Music size={size} color={colors.accent} />
  if (type.includes('text')) return <FileText size={size} color={colors.textMuted} />
  return <FileIcon size={size} color={colors.textMuted} />
}

interface Props {
  item: FBItem
  onPress: () => void
  onMenu: () => void
  onLongPress?: () => void
  /** Some rows are selected: every row shows a check circle and has no menu. */
  selecting?: boolean
  selected?: boolean
  /** Replaces the size and date (a search hit shows the folder it was found in). */
  subtitle?: string
}

export default function FileRow({ item, onPress, onMenu, onLongPress, selecting = false, selected = false, subtitle }: Props) {
  return (
    <Pressable
      style={[styles.row, selected && styles.rowSelected]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      accessibilityRole="button"
      accessibilityState={{ selected: selecting ? selected : undefined }}
    >
      {selecting ? (
        <View style={[styles.check, selected && styles.checkOn]}>{selected && <Check size={14} color="#000000" strokeWidth={3} />}</View>
      ) : null}
      <View style={styles.iconWrap}>{iconFor(item)}</View>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {subtitle ?? `${item.isDir ? 'Dossier' : formatSize(item.size)}${item.modified ? ` - ${new Date(item.modified).toLocaleDateString('fr-FR')}` : ''}`}
        </Text>
      </View>
      {item.isShared ? <Link2 size={14} color={colors.textMuted} /> : null}
      {selecting ? null : (
        <Pressable style={styles.menuButton} onPress={onMenu} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Actions pour ${item.name}`}>
          <MoreVertical size={18} color={colors.textMuted} />
        </Pressable>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  rowSelected: { backgroundColor: 'rgba(255,255,255,0.06)' },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  iconWrap: { width: 32, alignItems: 'center' },
  info: { flex: 1, minWidth: 0 },
  name: { color: colors.text, fontSize: 14, fontWeight: '500' },
  meta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  menuButton: { padding: spacing.xs }
})
