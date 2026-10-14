import Svg, { Circle, Defs, G, Mask, Path, Rect } from 'react-native-svg'
import { colors, tint } from '@/constants/theme'

const NODES: [number, number][] = [
  [212, 238],
  [346, 314],
  [212, 390]
]

/**
 * The app's logo (branding/icon.svg) drawn in the accent colour, so it follows the colour setting: a play button
 * made of three linked nodes.
 */
export default function LogoMark({ size = 56 }: { size?: number }) {
  const accent = colors.accent
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512" accessibilityElementsHidden>
      <Defs>
        <Mask id="logo-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <Rect width="512" height="512" fill="#fff" />
          {NODES.map(([x, y]) => (
            <Circle key={`${x}-${y}`} cx={x} cy={y} r="11" fill="#000" />
          ))}
        </Mask>
      </Defs>
      <Rect width="512" height="512" rx="112" fill={tint(accent, 0.16)} />
      <G mask="url(#logo-holes)" transform="translate(256 256) scale(1.3) translate(-279 -314)">
        <Path d="M212 238 L346 314 L212 390 Z" fill={accent} fillOpacity={0.14} stroke={accent} strokeWidth={24} strokeLinejoin="round" />
        {NODES.map(([x, y]) => (
          <Circle key={`${x}-${y}`} cx={x} cy={y} r="31" fill={accent} />
        ))}
      </G>
    </Svg>
  )
}
