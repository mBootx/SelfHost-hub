import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { Copy, Link2, LockKeyhole, Trash2 } from 'lucide-react-native'
import { EmptyState } from '@/components/Screen'
import type { ShareLink } from '@/services/filebrowser'
import { baseName } from '@/services/fileNames'
import { describeExpiry } from '@/services/shareLinks'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useToastStore } from '@/store/toastStore'
import { colors, layout, radius, spacing } from '@/constants/theme'

/** The share links this account has made, with the means to copy or revoke each one. */
export default function SharesScreen() {
  const navigation = useNavigation()
  const client = useFileBrowserStore((s) => s.client)
  const showToast = useToastStore((s) => s.show)
  const [links, setLinks] = useState<ShareLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!client) return
    setLoading(true)
    try {
      setLinks(await client.listShares())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    navigation.setOptions({ title: 'Liens de partage' })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function copy(link: ShareLink): Promise<void> {
    await Clipboard.setStringAsync(link.url)
    showToast('Lien copié')
  }

  function revoke(link: ShareLink): void {
    Alert.alert('Supprimer ce lien ?', `Le lien vers « ${baseName(link.path) || link.path} » cessera de fonctionner. Le fichier lui-même n'est pas touché.`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer le lien',
        style: 'destructive',
        onPress: async () => {
          try {
            await client!.deleteShare(link.hash)
            setLinks((previous) => (previous ? previous.filter((l) => l.hash !== link.hash) : previous))
            showToast('Lien supprimé')
          } catch (err) {
            Alert.alert('Suppression impossible', err instanceof Error ? err.message : 'Erreur inconnue')
          }
        }
      }
    ])
  }

  return (
    <View style={styles.screen}>
      {!client ? (
        <EmptyState icon={Link2} title="Non connecté" hint="Connectez-vous à FileBrowser depuis l'onglet Fichiers." />
      ) : links === null && loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={links ?? []}
          keyExtractor={(link) => link.hash}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading && links !== null} onRefresh={load} tintColor={colors.accent} colors={[colors.accent]} />}
          ListEmptyComponent={
            error ? (
              <EmptyState icon={Link2} title="Liste indisponible" hint={error} />
            ) : (
              <EmptyState icon={Link2} title="Aucun lien" hint="Dans Fichiers, ouvrez le menu d'un fichier ou d'un dossier puis « Créer un lien de partage »." />
            )
          }
          renderItem={({ item }) => {
            const expired = item.expiresAt !== null && item.expiresAt <= Date.now()
            return (
              <View style={styles.row}>
                <View style={styles.info}>
                  <View style={styles.titleLine}>
                    {item.hasPassword ? <LockKeyhole size={13} color={colors.textMuted} /> : null}
                    <Text style={styles.name} numberOfLines={1}>
                      {baseName(item.path) || item.path}
                    </Text>
                  </View>
                  <Text style={[styles.meta, expired && styles.expired]} numberOfLines={1}>
                    {describeExpiry(item.expiresAt)}
                    {item.username ? ` · ${item.username}` : ''}
                    {item.pathExists === false ? ' · fichier supprimé' : ''}
                  </Text>
                </View>
                <Pressable onPress={() => void copy(item)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Copier le lien">
                  <Copy size={19} color={colors.text} />
                </Pressable>
                <Pressable onPress={() => revoke(item)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Supprimer le lien">
                  <Trash2 size={19} color={colors.danger} />
                </Pressable>
              </View>
            )
          }}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.elevated
  },
  info: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: { flexShrink: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  expired: { color: colors.warning }
})
