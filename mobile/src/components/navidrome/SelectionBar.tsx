import { useEffect } from 'react'
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { HardDriveDownload, Heart, ListEnd, ListPlus, ListStart, Play, X } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import { usePlaylistPickerStore } from '@/store/playlistPickerStore'
import { useSelectionStore } from '@/store/selectionStore'
import { isStarred, useStarStore } from '@/store/starStore'
import { useToastStore } from '@/store/toastStore'
import { plural } from '@/services/plural'
import { colors, radius, spacing, tint } from '@/constants/theme'

type IconComponent = React.ComponentType<{ size?: number; color?: string }>

function Action({ icon: Icon, label, onPress, disabled }: { icon: IconComponent; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.action, (pressed || disabled) && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={styles.tile}>
        <Icon size={19} color={colors.accent} />
      </View>
      <Text style={styles.actionText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

/**
 * Mounted once at the root. While songs are being picked it floats over the tab bar and the mini player with what can
 * be done to them all at once: play, queue, add to a playlist, download, like. Back (or the cross) ends the selection.
 */
export default function SelectionBar() {
  const insets = useSafeAreaInsets()
  const active = useSelectionStore((s) => s.active)
  const picked = useSelectionStore((s) => s.picked)
  const poolSize = useSelectionStore((s) => s.pool.length)
  const clear = useSelectionStore((s) => s.clear)
  const selectAll = useSelectionStore((s) => s.selectAll)
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const playNext = useNavidromeStore((s) => s.playNext)
  const addToQueue = useNavidromeStore((s) => s.addToQueue)
  const downloadTracks = useOfflineStore((s) => s.downloadTracks)
  const openMany = usePlaylistPickerStore((s) => s.openMany)
  const showToast = useToastStore((s) => s.show)

  useEffect(() => {
    if (!active) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      clear()
      return true
    })
    return () => subscription.remove()
  }, [active, clear])

  if (!active) return null
  const count = picked.length
  const none = count === 0
  const done = (message: string): void => {
    showToast(message)
    clear()
  }

  async function like(): Promise<void> {
    if (!client) return
    const stars = useStarStore.getState()
    const todo = picked.filter((song) => !isStarred(stars, song))
    let liked = 0
    for (const song of todo) {
      if (await stars.toggle(song, client)) liked++
    }
    done(todo.length === 0 ? 'Déjà dans vos favoris' : liked === todo.length ? `${plural(liked, 'titre ajouté', 'titres ajoutés')} aux favoris` : 'Favoris injoignables')
  }

  return (
    <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOutDown.duration(140)} style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
      <View style={styles.head}>
        <Pressable onPress={clear} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="Annuler la sélection">
          <X size={16} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.count}>{none ? 'Touchez des titres' : plural(count, 'titre sélectionné', 'titres sélectionnés')}</Text>
        {poolSize > count && (
          <Pressable onPress={selectAll} hitSlop={8} accessibilityRole="button" accessibilityLabel="Tout sélectionner">
            <Text style={styles.all}>Tout sélectionner</Text>
          </Pressable>
        )}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actions}>
        <Action
          icon={Play}
          label="Lire"
          disabled={none}
          onPress={() => {
            playQueue(picked, 0)
            clear()
          }}
        />
        <Action
          icon={ListStart}
          label="Ensuite"
          disabled={none}
          onPress={() => {
            // First in, first out: the first picked plays next, the others follow it.
            for (const song of picked) playNext(song)
            done(count === 1 ? 'Sera lu ensuite' : `${count} titres seront lus ensuite`)
          }}
        />
        <Action
          icon={ListEnd}
          label="File"
          disabled={none}
          onPress={() => {
            addToQueue(picked)
            done(count === 1 ? 'Ajouté à la file de lecture' : `${count} titres ajoutés à la file`)
          }}
        />
        <Action
          icon={ListPlus}
          label="Playlist"
          disabled={none}
          onPress={() => {
            openMany(picked, plural(count, 'titre', 'titres'))
            clear()
          }}
        />
        <Action
          icon={HardDriveDownload}
          label="Télécharger"
          disabled={none || !client}
          onPress={() => {
            if (client) void downloadTracks(picked, client)
            clear()
          }}
        />
        <Action icon={Heart} label="Favoris" disabled={none || !client} onPress={() => void like()} />
      </ScrollView>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.elevated,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: tint(colors.accent, 0.4),
    paddingTop: spacing.md,
    elevation: 28
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
  close: { width: 30, height: 30, borderRadius: radius.full, backgroundColor: colors.hover, alignItems: 'center', justifyContent: 'center' },
  count: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '700' },
  all: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  actions: { paddingHorizontal: spacing.md, paddingTop: spacing.md, gap: spacing.xs },
  action: { width: 74, alignItems: 'center', gap: 6 },
  tile: { width: 46, height: 46, borderRadius: 15, backgroundColor: tint(colors.accent, 0.14), alignItems: 'center', justifyContent: 'center' },
  actionText: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  pressed: { opacity: 0.4 }
})
