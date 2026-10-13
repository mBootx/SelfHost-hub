import { useEffect } from 'react'
import { View, StyleSheet, StyleProp, ImageStyle, ViewStyle } from 'react-native'
import { Image } from 'expo-image'
import { Music } from 'lucide-react-native'
import { colors } from '@/constants/theme'
import { coverKey, storeCover, storedCoverUri, useCoverStore } from '@/services/coverStore'

type IconComponent = React.ComponentType<{ size?: number; color?: string }>

interface Props {
  /** Already-built cover art URL, or nothing when the item has no artwork. */
  uri?: string | null
  style: StyleProp<ImageStyle>
  icon?: IconComponent
  iconSize?: number
  /** Item id, so recycled list rows don't briefly show the previous row's art. */
  recyclingKey?: string
}

/**
 * Single place where remote artwork is rendered. A Navidrome cover is shown from the phone's own copy
 * (services/coverStore) once it has one, and saved there the first time it is shown; until then, or for any other
 * picture, expo-image shows it from the network or from its cache.
 */
export default function CoverImage({ uri, style, icon: Icon = Music, iconSize = 24, recyclingKey }: Props) {
  const key = uri ? coverKey(uri) : null
  // Only this cover's arrival redraws this picture, not every other one's.
  const stored = useCoverStore((s) => (key ? !!s.stored[key] : false))
  useEffect(() => {
    if (uri && key && !stored) void storeCover(uri)
  }, [uri, key, stored])
  const source = uri && stored ? storedCoverUri(uri) ?? uri : uri

  if (!source) {
    return (
      <View style={[style as StyleProp<ViewStyle>, styles.placeholder]}>
        <Icon size={iconSize} color={colors.textMuted} />
      </View>
    )
  }

  return (
    <Image
      source={{ uri: source }}
      style={[style, styles.image]}
      contentFit="cover"
      transition={160}
      cachePolicy="memory-disk"
      recyclingKey={recyclingKey}
    />
  )
}

const styles = StyleSheet.create({
  image: { backgroundColor: colors.elevated },
  placeholder: { backgroundColor: colors.elevated, alignItems: 'center', justifyContent: 'center' }
})
