import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Sparkles } from 'lucide-react-native'
import BottomSheet from '@/components/BottomSheet'
import { useWhatsNewStore } from '@/store/whatsNewStore'
import { useAppLockStore } from '@/store/appLockStore'
import { colors, radius, spacing, tint } from '@/constants/theme'

export default function WhatsNewModal() {
  const notes = useWhatsNewStore((s) => s.notes)
  const dismiss = useWhatsNewStore((s) => s.dismiss)
  // Waits for the app to be unlocked: a popup opening later would sit above the lock screen.
  const unlocked = useAppLockStore((s) => s.status === 'unlocked')

  return (
    <BottomSheet
      visible={unlocked && !!notes && notes.length > 0}
      onClose={dismiss}
      title="Nouveautés"
      subtitle={notes?.length === 1 ? `Version ${notes[0].version}` : 'Dernières mises à jour'}
      leading={
        <View style={styles.iconWrap}>
          <Sparkles size={20} color={colors.accent} />
        </View>
      }
      maxHeight={0.88}
    >
      <View style={styles.content}>
        {notes?.map((note) => (
          <View key={note.version} style={styles.version}>
            {notes.length > 1 && <Text style={styles.versionLabel}>Version {note.version}</Text>}
            {note.items.map((item) => (
              <View key={item.title} style={styles.item}>
                <View style={styles.bar} />
                <View style={styles.itemText}>
                  <Text style={styles.itemTitle}>{item.title}</Text>
                  <Text style={styles.itemBody}>{item.text}</Text>
                </View>
              </View>
            ))}
          </View>
        ))}
        <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={dismiss} accessibilityRole="button">
          <Text style={styles.buttonText}>Continuer</Text>
        </Pressable>
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  iconWrap: { width: 44, height: 44, borderRadius: 14, backgroundColor: tint(colors.accent, 0.16), alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.lg },
  version: { gap: spacing.sm },
  versionLabel: { color: colors.accent, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 },
  item: { flexDirection: 'row', gap: spacing.md, backgroundColor: colors.raised, borderRadius: radius.md, padding: spacing.md },
  bar: { width: 3, borderRadius: 2, backgroundColor: colors.accent },
  itemText: { flex: 1, minWidth: 0 },
  itemTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  itemBody: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 3 },
  button: { backgroundColor: colors.accent, borderRadius: radius.full, paddingVertical: spacing.md, alignItems: 'center' },
  pressed: { opacity: 0.7 },
  buttonText: { color: colors.onAccent, fontWeight: '800', fontSize: 14 }
})
