import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { Sparkles } from 'lucide-react-native'
import { useWhatsNewStore } from '@/store/whatsNewStore'
import { useAppLockStore } from '@/store/appLockStore'
import { colors, radius, spacing } from '@/constants/theme'

export default function WhatsNewModal() {
  const notes = useWhatsNewStore((s) => s.notes)
  const dismiss = useWhatsNewStore((s) => s.dismiss)
  // Waits for the app to be unlocked: a popup opening later would sit above the lock screen.
  const unlocked = useAppLockStore((s) => s.status === 'unlocked')

  return (
    <Modal visible={unlocked && !!notes && notes.length > 0} transparent animationType="fade" onRequestClose={dismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              <Sparkles size={18} color={colors.accent} />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.title}>Nouveautés</Text>
              <Text style={styles.subtitle}>
                {notes?.length === 1 ? `Version ${notes[0].version}` : 'Dernières mises à jour'}
              </Text>
            </View>
          </View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {notes?.map((note) => (
              <View key={note.version} style={styles.version}>
                {notes.length > 1 && <Text style={styles.versionLabel}>Version {note.version}</Text>}
                {note.items.map((item) => (
                  <View key={item.title} style={styles.item}>
                    <View style={styles.dot} />
                    <View style={styles.itemText}>
                      <Text style={styles.itemTitle}>{item.title}</Text>
                      <Text style={styles.itemBody}>{item.text}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            onPress={dismiss}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>Continuer</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: { width: '100%', maxHeight: '80%', backgroundColor: colors.elevated, borderRadius: radius.lg, padding: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.hover,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  // Shrinks to fit the card's max height, then scrolls.
  list: { flexShrink: 1, marginTop: spacing.lg },
  listContent: { gap: spacing.lg },
  version: { gap: spacing.md },
  versionLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  item: { flexDirection: 'row', gap: spacing.sm },
  dot: { width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.accent, marginTop: 6 },
  itemText: { flex: 1, minWidth: 0 },
  itemTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  itemBody: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 2 },
  button: {
    alignSelf: 'flex-end',
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginTop: spacing.lg
  },
  pressed: { opacity: 0.7 },
  buttonText: { color: '#000', fontWeight: '700', fontSize: 13 }
})
