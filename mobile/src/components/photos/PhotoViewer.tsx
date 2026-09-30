import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { Trash2, X } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { FileBrowserClient } from '@/services/filebrowser'
import type { Photo } from '@/services/photoVault'
import { formatSize, monthTitle } from '@/services/photoLayout'
import { colors, spacing } from '@/constants/theme'

interface Props {
  photos: Photo[]
  client: FileBrowserClient
  startIndex: number
  onClose: () => void
  /** The screen asks for confirmation and does the deleting; the viewer follows the list as it shrinks. */
  onDelete: (photo: Photo) => void
}

function FullPhoto({ photo, client, width, height }: { photo: Photo; client: FileBrowserClient; width: number; height: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <View style={{ width, height }}>
      <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.accent} />
      {failed ? (
        <View style={styles.failed}>
          <Text style={styles.failedText}>Impossible d&apos;afficher cette photo</Text>
        </View>
      ) : (
        <Image
          // The original, at full size. Keyed on the file, not the URL: the URL embeds the login token.
          source={{ uri: client.rawUrl(photo.path), cacheKey: `fb:${client.getSourceName()}:${photo.path}:${photo.modified}` }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          cachePolicy="memory-disk"
          transition={120}
          onError={() => setFailed(true)}
        />
      )}
    </View>
  )
}

export default function PhotoViewer({ photos, client, startIndex, onClose, onDelete }: Props) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const list = useRef<FlatList<Photo>>(null)
  const [index, setIndex] = useState(Math.min(startIndex, Math.max(0, photos.length - 1)))
  const [chrome, setChrome] = useState(true)
  const mounted = useRef(false)

  // The list shrinks when the photo on show is deleted: stay on the one that took its place, or the last.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    if (photos.length === 0) {
      onClose()
      return
    }
    const clamped = Math.min(index, photos.length - 1)
    setIndex(clamped)
    list.current?.scrollToIndex({ index: clamped, animated: false })
  }, [photos.length])

  const photo = photos[index]
  if (!photo) return null

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <FlatList
          ref={list}
          data={photos}
          keyExtractor={(p) => p.path}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={index}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          initialNumToRender={1}
          maxToRenderPerBatch={1}
          windowSize={3}
          onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => (
            <Pressable onPress={() => setChrome((c) => !c)} accessibilityLabel={`Photo ${item.name}`}>
              <FullPhoto photo={item} client={client} width={width} height={height} />
            </Pressable>
          )}
        />

        {chrome && (
          <>
            <View style={[styles.bar, styles.top, { paddingTop: insets.top + spacing.sm }]} pointerEvents="box-none">
              <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Fermer">
                <X size={24} color="#ffffff" />
              </Pressable>
              <Text style={styles.title} numberOfLines={1}>
                {photo.name}
              </Text>
              <Text style={styles.counter}>
                {index + 1} / {photos.length}
              </Text>
            </View>
            <View style={[styles.bar, styles.bottom, { paddingBottom: insets.bottom + spacing.md }]} pointerEvents="box-none">
              <Text style={styles.info} numberOfLines={1}>
                {monthTitle(photo.year, photo.month)} · {formatSize(photo.size)}
              </Text>
              <Pressable onPress={() => onDelete(photo)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Supprimer cette photo">
                <Trash2 size={22} color="#ffffff" />
              </Pressable>
            </View>
          </>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000' },
  bar: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, backgroundColor: 'rgba(0,0,0,0.55)' },
  top: { top: 0, paddingBottom: spacing.md },
  bottom: { bottom: 0, paddingTop: spacing.md, justifyContent: 'space-between' },
  title: { flex: 1, color: '#ffffff', fontSize: 14, fontWeight: '600' },
  counter: { color: 'rgba(255,255,255,0.75)', fontSize: 13 },
  info: { flex: 1, color: 'rgba(255,255,255,0.85)', fontSize: 13 },
  failed: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  failedText: { color: colors.textSecondary, fontSize: 13 }
})
