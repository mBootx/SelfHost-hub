import { useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { Image } from 'expo-image'
import { X } from 'lucide-react-native'
import { FileBrowserClient, FBItem } from '@/services/filebrowser'
import { colors, spacing } from '@/constants/theme'

interface Props {
  item: FBItem
  client: FileBrowserClient
  onClose: () => void
}

export default function PreviewModal({ item, client, onClose }: Props) {
  const type = item.type || ''
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    if (type.includes('text')) client.getTextPreview(item.path).then(setText)
  }, [item.path])

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {item.name}
          </Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <X size={22} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.body}>
          {type.includes('image') && (
            <Image
              // The login travels in a header, not in the address; the cache key names the file so it outlives a session.
              source={client.imageSource(client.rawUrl(item.path), `fb:${client.getSourceName()}:${item.path}:${item.modified}`)}
              style={styles.image}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={120}
            />
          )}
          {type.includes('text') && (
            <ScrollView style={styles.textScroll}>
              {text === null ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.text}>{text}</Text>}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', paddingTop: 56 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  title: { color: colors.text, fontSize: 15, fontWeight: '600', flex: 1, marginRight: spacing.md },
  body: { flex: 1, paddingHorizontal: spacing.md },
  image: { flex: 1, width: '100%' },
  textScroll: { flex: 1, backgroundColor: colors.raised, borderRadius: 8, padding: spacing.md },
  text: { color: colors.textSecondary, fontSize: 12, fontFamily: 'monospace' }
})
