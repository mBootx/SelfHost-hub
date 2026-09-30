import { memo, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'
import { Check, ImageOff } from 'lucide-react-native'
import type { FileBrowserClient } from '@/services/filebrowser'
import type { Photo } from '@/services/photoVault'
import { colors } from '@/constants/theme'

interface Props {
  photo: Photo
  client: FileBrowserClient
  size: number
  /** Position in the list being shown, so a tap can open the viewer there. */
  index: number
  selecting: boolean
  selected: boolean
  onPress: (index: number, photo: Photo) => void
  onLongPress: (photo: Photo) => void
}

/** One square of the grid. Memoised: a screen of these must not redraw when the list around it changes. */
export default memo(function PhotoTile({ photo, client, size, index, selecting, selected, onPress, onLongPress }: Props) {
  // The server's small preview first; the original when it can't make one (HEIC, say); a placeholder if both fail.
  const [stage, setStage] = useState<'preview' | 'original' | 'failed'>('preview')
  const original = stage === 'original'

  return (
    <Pressable
      style={[styles.tile, { width: size, height: size }]}
      onPress={() => onPress(index, photo)}
      onLongPress={() => onLongPress(photo)}
      delayLongPress={250}
      accessibilityRole="button"
      accessibilityLabel={`Photo ${photo.name}`}
      accessibilityState={{ selected: selecting ? selected : undefined }}
    >
      {stage === 'failed' ? (
        <View style={styles.missing}>
          <ImageOff size={22} color={colors.textMuted} />
        </View>
      ) : (
        <Image
          source={{
            uri: original ? client.rawUrl(photo.path) : client.thumbnailUrl(photo.path),
            // Keyed on the file, not the URL: the URL embeds the login token, which changes every session.
            cacheKey: `fb:${client.getSourceName()}:${original ? '' : 'preview:'}${photo.path}:${photo.modified}`
          }}
          style={styles.image}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={photo.path}
          transition={120}
          onError={() => setStage(original ? 'failed' : 'original')}
        />
      )}
      {selecting && (
        <View style={[styles.shade, selected && styles.shadeSelected]} pointerEvents="none">
          <View style={[styles.check, selected && styles.checkOn]}>{selected && <Check size={14} color="#000000" strokeWidth={3} />}</View>
        </View>
      )}
    </Pressable>
  )
})

const styles = StyleSheet.create({
  tile: { backgroundColor: colors.elevated },
  image: { width: '100%', height: '100%' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
