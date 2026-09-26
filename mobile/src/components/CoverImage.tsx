import { View, StyleSheet, StyleProp, ImageStyle, ViewStyle } from 'react-native'
import { Image } from 'expo-image'
import { Music } from 'lucide-react-native'
import { colors } from '@/constants/theme'

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
 * Single place where remote artwork is rendered. Uses expo-image rather than the
 * React Native one for its memory + disk cache: covers survive scrolling, tab
 * switches and app restarts instead of being re-fetched from the server.
 */
export default function CoverImage({ uri, style, icon: Icon = Music, iconSize = 24, recyclingKey }: Props) {
  if (!uri) {
    return (
      <View style={[style as StyleProp<ViewStyle>, styles.placeholder]}>
        <Icon size={iconSize} color={colors.textMuted} />
      </View>
    )
  }

  return (
    <Image
      source={{ uri }}
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
