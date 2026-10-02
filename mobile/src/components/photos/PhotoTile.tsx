import { memo, useMemo, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'
import { Check, Film, ImageOff, Play } from 'lucide-react-native'
import type { FileBrowserClient } from '@/services/filebrowser'
import type { Photo } from '@/services/photoVault'
import { colors } from '@/constants/theme'

/** What a tile needs to know about the file it shows: photos and the bin's files both fit. */
export type TileMedia = Pick<Photo, 'path' | 'name' | 'modified' | 'hasPreview' | 'kind'>

interface Props<T extends TileMedia> {
  photo: T
  client: FileBrowserClient
  size: number
  /** Position in the list being shown, so a tap can open the viewer there. */
  index: number
  selecting: boolean
  selected: boolean
  onPress: (index: number, photo: T) => void
  onLongPress: (photo: T) => void
}

/** One square of the grid. Memoised: a screen of these must not redraw when the list around it changes. */
function PhotoTileBase<T extends TileMedia>({ photo, client, size, index, selecting, selected, onPress, onLongPress }: Props<T>) {
  const video = photo.kind === 'video'
  // The server's thumbnail first (at the route its version uses, then the other one), the original when it
  // can't make one, a placeholder if everything fails. Loading originals for a whole grid would cost
  // hundreds of megabytes, so a server that says it has no thumbnail is the only reason to skip them. A
  // video's original is a video, not a picture: without a thumbnail it gets a placeholder.
  const candidates = useMemo(
    () => [...(photo.hasPreview === false ? [] : client.previewUrls(photo.path)), ...(video ? [] : [client.rawUrl(photo.path)])],
    [client, photo.path, photo.hasPreview, video]
  )
  const [stage, setStage] = useState(0)
  const failed = stage >= candidates.length
  const url = candidates[Math.min(stage, candidates.length - 1)]
  const original = !video && stage === candidates.length - 1

  return (
    <Pressable
      style={[styles.tile, { width: size, height: size }]}
      onPress={() => onPress(index, photo)}
      onLongPress={() => onLongPress(photo)}
      delayLongPress={250}
      accessibilityRole="button"
      accessibilityLabel={`${video ? 'Vidéo' : 'Photo'} ${photo.name}`}
      accessibilityState={{ selected: selecting ? selected : undefined }}
    >
      {failed ? (
        <View style={styles.missing}>
          {video ? <Film size={26} color={colors.textMuted} /> : <ImageOff size={22} color={colors.textMuted} />}
        </View>
      ) : (
        <Image
          // Keyed on the file, not the address: either thumbnail route gives the same picture, and the key
          // must outlive a session.
          source={client.imageSource(url, `fb:${client.getSourceName()}:${original ? '' : 'preview:'}${photo.path}:${photo.modified}`)}
          style={styles.image}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={photo.path}
          transition={120}
          onLoad={() => {
            if (!original) client.notePreviewWorked(url)
          }}
          onError={() => setStage((current) => current + 1)}
        />
      )}
      {video && (
        <View style={styles.badge} pointerEvents="none">
          <Play size={12} color="#ffffff" fill="#ffffff" />
        </View>
      )}
      {selecting && (
        <View style={[styles.shade, selected && styles.shadeSelected]} pointerEvents="none">
          <View style={[styles.check, selected && styles.checkOn]}>{selected && <Check size={14} color="#000000" strokeWidth={3} />}</View>
        </View>
      )}
    </Pressable>
  )
}

// memo() forgets the component's type parameter; this puts it back.
export default memo(PhotoTileBase) as typeof PhotoTileBase

const styles = StyleSheet.create({
  tile: { backgroundColor: colors.elevated },
  image: { width: '100%', height: '100%' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  shade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'flex-end', padding: 6 },
  shadeSelected: { backgroundColor: 'rgba(0,0,0,0.35)' },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#ffffff',
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent }
})
