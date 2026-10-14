import { Children, Fragment, ReactNode, isValidElement, useState } from 'react'
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import LogoMark from '@/components/LogoMark'
import { colors, radius, spacing, tint } from '@/constants/theme'

type IconComponent = React.ComponentType<{ size?: number; color?: string }>

/**
 * The pieces the settings page is made of. Every colour comes from the theme (`colors`), the tinted tiles and chips
 * from the accent (`tint`), so changing the accent or the background in Apparence reaches all of them.
 */

/** A small label over a group of rows. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.groupLabel}>{children}</Text>
}

/** Rows in one rounded card, a hairline between them. */
export function SettingsCard({ children, style }: { children: ReactNode; style?: object }) {
  const rows = Children.toArray(children).filter(isValidElement)
  return (
    <View style={[styles.card, style]}>
      {rows.map((row, i) => (
        <Fragment key={row.key ?? i}>
          {i > 0 && <View style={styles.divider} />}
          {row}
        </Fragment>
      ))}
    </View>
  )
}

interface RowProps {
  icon: IconComponent
  /** The tile's colour: the accent unless a service has one of its own. */
  tone?: string
  title: string
  meta?: string
  /** Something at the right: a switch, a pill button, a value. */
  right?: ReactNode
  /** Makes the row a button; it then shows a chevron unless `right` is given. */
  onPress?: () => void
  accessibilityLabel?: string
}

export function SettingsRow({ icon: Icon, tone = colors.accent, title, meta, right, onPress, accessibilityLabel }: RowProps) {
  const content = (
    <>
      <View style={[styles.tile, { backgroundColor: tint(tone, 0.16) }]}>
        <Icon size={19} color={tone} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {!!meta && (
          <Text style={styles.rowMeta} numberOfLines={2}>
            {meta}
          </Text>
        )}
      </View>
      {right ?? (onPress ? <ChevronRight size={18} color={colors.textMuted} /> : null)}
    </>
  )
  if (!onPress) return <View style={styles.row}>{content}</View>
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title}>
      {content}
    </Pressable>
  )
}

/** A small button at the right of a row; `primary` fills it with the accent. */
export function RowButton({ label, onPress, primary, danger, disabled, accessibilityLabel }: { label: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean; accessibilityLabel?: string }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.rowButton, primary && styles.rowButtonPrimary, danger && styles.rowButtonDanger, (pressed || disabled) && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      <Text style={[styles.rowButtonText, primary && { color: colors.onAccent }, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  )
}

/**
 * A group of settings folded under one row: its icon tile, its name, a line on what is in it, and a chevron that
 * turns. Opening it shows the section as it was before, so nothing is more than one tap away and the page stays short.
 */
export function SettingsGroup({ icon: Icon, title, summary, defaultOpen = false, children }: { icon: IconComponent; title: string; summary?: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const turn = useAnimatedStyle(() => ({ transform: [{ rotate: withTiming(open ? '180deg' : '0deg', { duration: 200 }) }] }), [open])

  function toggle(): void {
    LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'))
    setOpen((was) => !was)
  }

  return (
    <View style={[styles.group, open && styles.groupOpen]}>
      <Pressable style={({ pressed }) => [styles.groupHead, pressed && styles.pressed]} onPress={toggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title}>
        <View style={[styles.tile, { backgroundColor: tint(colors.accent, open ? 0.26 : 0.16) }]}>
          <Icon size={19} color={colors.accent} />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{title}</Text>
          {!!summary && (
            <Text style={styles.rowMeta} numberOfLines={1}>
              {summary}
            </Text>
          )}
        </View>
        <Animated.View style={turn}>
          <ChevronDown size={18} color={colors.textMuted} />
        </Animated.View>
      </Pressable>
      {open && <View style={styles.groupBody}>{children}</View>}
    </View>
  )
}

/** The top of the page: the app, its version, and which services answer, on a wash of the accent colour. */
export function SettingsHero({ version, chips, notice }: { version: string; chips: { label: string; on: boolean }[]; notice?: { text: string; onPress: () => void } }) {
  return (
    <View style={styles.hero}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="wash" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={colors.accent} stopOpacity="0.34" />
            <Stop offset="0.65" stopColor={colors.accent} stopOpacity="0.06" />
            <Stop offset="1" stopColor={colors.accent} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#wash)" />
      </Svg>
      <View style={styles.heroTop}>
        <LogoMark size={60} />
        <View style={styles.rowText}>
          <Text style={styles.heroName}>SelfHost Hub</Text>
          <Text style={styles.heroVersion}>Version {version}</Text>
        </View>
      </View>
      <View style={styles.chips}>
        {chips.map((chip) => (
          <View key={chip.label} style={[styles.chip, chip.on && styles.chipOn]}>
            <View style={[styles.chipDot, { backgroundColor: chip.on ? colors.accent : colors.textMuted }]} />
            <Text style={[styles.chipText, chip.on && { color: colors.text }]}>{chip.label}</Text>
          </View>
        ))}
      </View>
      {notice && (
        <Pressable style={({ pressed }) => [styles.notice, pressed && styles.pressed]} onPress={notice.onPress} accessibilityRole="button">
          <Text style={styles.noticeText}>{notice.text}</Text>
          <ChevronRight size={16} color={colors.onAccent} />
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  groupLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: spacing.xl, marginBottom: spacing.sm, marginLeft: spacing.xs },
  card: { backgroundColor: colors.elevated, borderRadius: radius.lg, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: spacing.md + 40 + spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  pressed: { opacity: 0.6 },
  tile: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 },
  rowButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.full, backgroundColor: colors.hover },
  rowButtonPrimary: { backgroundColor: colors.accent },
  rowButtonDanger: { backgroundColor: tint(colors.danger, 0.14) },
  rowButtonText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  group: { backgroundColor: colors.elevated, borderRadius: radius.lg, marginBottom: spacing.sm, overflow: 'hidden' },
  groupOpen: { borderWidth: 1, borderColor: tint(colors.accent, 0.3) },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  groupBody: { backgroundColor: colors.raised, paddingHorizontal: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.xs },
  hero: { borderRadius: 24, padding: spacing.lg, backgroundColor: colors.elevated, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroName: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  heroVersion: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
  chipOn: { borderColor: tint(colors.accent, 0.4), backgroundColor: tint(colors.accent, 0.1) },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  notice: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.full, backgroundColor: colors.accent },
  noticeText: { color: colors.onAccent, fontSize: 14, fontWeight: '800' }
})
