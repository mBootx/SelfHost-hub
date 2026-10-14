import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useNavigation, useRouter } from 'expo-router'
import { Eye, EyeOff, FolderOpen, Lock, LockOpen, ListMusic, Pencil, Trash2, UserRound } from 'lucide-react-native'
import ActionSheet, { ActionSheetItem } from '@/components/ActionSheet'
import PromptModal from '@/components/PromptModal'
import { EmptyState } from '@/components/Screen'
import { useIsOwner } from '@/hooks/useIsOwner'
import { AdminPlaylist, AdminUser, NavidromeAdmin, PlaylistChanges, tracksEditable } from '@/services/navidromeAdmin'
import { describeError, logEvent } from '@/services/diagnostics'
import { plural } from '@/services/plural'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useToastStore } from '@/store/toastStore'
import { colors, layout, radius, spacing } from '@/constants/theme'

/**
 * Every account's playlists, for the server's owner: each account sees only its own in the apps, so this is where a
 * playlist is given to the account it belongs to, unlocked when it still follows the M3U file it was imported from,
 * renamed, made private or public, or deleted.
 */
export default function PlaylistsAdminScreen() {
  const navigation = useNavigation()
  const router = useRouter()
  const isOwner = useIsOwner()
  const client = useNavidromeStore((s) => s.client)
  const status = useNavidromeStore((s) => s.status)
  const loadLibrary = useNavidromeStore((s) => s.loadLibrary)
  const showToast = useToastStore((s) => s.show)

  const [playlists, setPlaylists] = useState<AdminPlaylist[] | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [menu, setMenu] = useState<AdminPlaylist | null>(null)
  const [assigning, setAssigning] = useState<AdminPlaylist | null>(null)
  const [renaming, setRenaming] = useState<AdminPlaylist | null>(null)

  // One sign-in to Navidrome's own API for as long as the screen is open.
  const admin = useMemo<NavidromeAdmin | null>(() => (client && status === 'connected' ? client.admin() : null), [client, status])

  useEffect(() => {
    navigation.setOptions({ title: 'Playlists des comptes' })
  }, [navigation])

  const load = useCallback(async () => {
    if (!admin) return
    setLoading(true)
    try {
      const [all, accounts] = await Promise.all([admin.playlists(), admin.users()])
      setPlaylists(all)
      setUsers(accounts)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible')
    } finally {
      setLoading(false)
    }
  }, [admin])

  useEffect(() => {
    void load()
  }, [load])

  async function change(playlist: AdminPlaylist, changes: PlaylistChanges, done: string): Promise<void> {
    if (!admin) return
    setWorking(true)
    try {
      await admin.update(playlist.id, changes)
      showToast(done)
      logEvent('music', `Playlist « ${playlist.name} » : ${done}`)
      await load()
      // The account's own list follows (a playlist given away leaves it, one received joins it).
      void loadLibrary()
    } catch (err) {
      Alert.alert('Modification impossible', err instanceof Error ? err.message : describeError(err))
    } finally {
      setWorking(false)
    }
  }

  function assign(playlist: AdminPlaylist, user: AdminUser): void {
    // Given to an account, a playlist is that account's alone, and its songs can be changed: it stops following the
    // M3U file it came from, which would otherwise put its songs back at every scan.
    const changes: PlaylistChanges = { ownerId: user.id, public: false }
    if (playlist.sync) changes.sync = false
    void change(playlist, changes, `attribuée à ${user.name || user.userName}`)
  }

  function confirmDelete(playlist: AdminPlaylist): void {
    Alert.alert('Supprimer la playlist ?', `« ${playlist.name} » (${ownerLabel(playlist)}) sera définitivement supprimée.`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: async () => {
          if (!admin) return
          setWorking(true)
          try {
            await admin.remove(playlist.id)
            showToast(`Playlist « ${playlist.name} » supprimée`)
            await load()
            void loadLibrary()
          } catch (err) {
            Alert.alert('Suppression impossible', err instanceof Error ? err.message : describeError(err))
          } finally {
            setWorking(false)
          }
        }
      }
    ])
  }

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  function ownerLabel(p: AdminPlaylist): string {
    const user = userById.get(p.ownerId)
    return user ? user.name || user.userName : p.ownerName || 'compte inconnu'
  }

  const menuItems: ActionSheetItem[] = menu
    ? [
        { label: 'Attribuer à un compte…', icon: UserRound, onPress: () => setAssigning(menu) },
        ...(menu.sync
          ? [{ label: 'Rendre modifiable (ne plus suivre le fichier M3U)', icon: LockOpen, onPress: () => void change(menu, { sync: false }, 'modifiable') }]
          : []),
        menu.public
          ? { label: 'Rendre privée (son compte seulement)', icon: EyeOff, onPress: () => void change(menu, { public: false }, 'privée') }
          : { label: 'Rendre publique (tous les comptes)', icon: Eye, onPress: () => void change(menu, { public: true }, 'publique') },
        { label: 'Renommer', icon: Pencil, onPress: () => setRenaming(menu) },
        { label: 'Ouvrir', icon: FolderOpen, onPress: () => router.push({ pathname: '/playlist/[id]', params: { id: menu.id } }) },
        { label: 'Supprimer', icon: Trash2, danger: true, onPress: () => confirmDelete(menu) }
      ]
    : []
  const userItems: ActionSheetItem[] = assigning
    ? users.map((user) => ({
        label: `${user.id === assigning.ownerId ? '✓ ' : ''}${user.name || user.userName}${user.name && user.name !== user.userName ? ` (${user.userName})` : ''}`,
        icon: UserRound,
        onPress: () => assign(assigning, user)
      }))
    : []

  let body: React.ReactNode
  if (isOwner === false) {
    body = <EmptyState icon={Lock} title="Réservé au propriétaire du serveur" />
  } else if (!admin) {
    body = <EmptyState icon={ListMusic} title="Navidrome non connecté" hint="Connectez-vous à Navidrome pour gérer les playlists." />
  } else if (playlists === null && error) {
    body = <EmptyState icon={ListMusic} title="Playlists indisponibles" hint={error} action={{ label: 'Réessayer', onPress: () => void load() }} />
  } else if (playlists === null) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  } else {
    body = (
      <FlatList
        data={playlists}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={colors.accent} colors={[colors.accent]} />}
        ListHeaderComponent={
          <Text style={styles.intro}>
            Chaque compte ne voit que ses propres playlists. Touchez une playlist pour l’attribuer à son compte (elle devient
            alors privée et modifiable), la renommer ou la supprimer.
          </Text>
        }
        ListEmptyComponent={<EmptyState icon={ListMusic} title="Aucune playlist sur le serveur" />}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onPress={() => setMenu(item)}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, à ${ownerLabel(item)}`}
          >
            <View style={styles.info}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.meta} numberOfLines={2}>
                {[
                  ownerLabel(item),
                  plural(item.songCount ?? 0, 'titre', 'titres'),
                  item.public ? 'publique' : 'privée',
                  ...(tracksEditable(item) ? [] : [item.sync ? 'suit son fichier M3U (non modifiable)' : 'intelligente'])
                ].join(' · ')}
              </Text>
            </View>
            {item.sync ? <Lock size={16} color={colors.warning} /> : null}
          </Pressable>
        )}
      />
    )
  }

  return (
    <View style={styles.screen}>
      {body}
      {working && (
        <View style={styles.working}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}
      <ActionSheet visible={!!menu} title={menu ? `${menu.name} · ${ownerLabel(menu)}` : undefined} items={menuItems} onClose={() => setMenu(null)} />
      <ActionSheet visible={!!assigning} title={assigning ? `Attribuer « ${assigning.name} » à` : undefined} items={userItems} onClose={() => setAssigning(null)} />
      <PromptModal
        visible={!!renaming}
        title="Renommer la playlist"
        initialValue={renaming?.name ?? ''}
        confirmLabel="Renommer"
        onCancel={() => setRenaming(null)}
        onConfirm={(value) => {
          const target = renaming
          setRenaming(null)
          const name = value.trim()
          if (target && name && name !== target.name) void change(target, { name }, `renommée en « ${name} »`)
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  intro: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, marginBottom: spacing.md, marginTop: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm
  },
  pressed: { opacity: 0.6 },
  info: { flex: 1, minWidth: 0 },
  name: { color: colors.text, fontSize: 14, fontWeight: '600' },
  meta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  working: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }
})
