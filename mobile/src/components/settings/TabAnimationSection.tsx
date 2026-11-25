import { useState, useRef } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import Slider from '@react-native-community/slider'
import Animated, { useAnimatedStyle, withTiming, withSequence } from 'react-native-reanimated'
import { Sparkles, Layers, Zap } from 'lucide-react-native'
import {
  ANIMATION_TYPES,
  SPEED_PRESETS,
  TabAnimationSpeed,
  TabAnimationType,
  useTabAnimationStore
} from '@/store/tabAnimationStore'
import { colors, radius, spacing, tint } from '@/constants/theme'

export default function TabAnimationSection() {
  const animationType = useTabAnimationStore((s) => s.animationType)
  const speed = useTabAnimationStore((s) => s.speed)
  const durationMs = useTabAnimationStore((s) => s.durationMs)
  const setAnimationType = useTabAnimationStore((s) => s.setAnimationType)
  const setSpeed = useTabAnimationStore((s) => s.setSpeed)
  const setCustomDurationMs = useTabAnimationStore((s) => s.setCustomDurationMs)

  // Where the slider is while the finger is on it; the setting is only saved when it lets go.
  const [dragMs, setDragMs] = useState<number | null>(null)

  // Interactive preview state
  const [previewTab, setPreviewTab] = useState<'A' | 'B'>('A')

  const previewStyleA = useAnimatedStyle(() => {
    const isCurrent = previewTab === 'A'
    if (animationType === 'none') {
      return { opacity: isCurrent ? 1 : 0, transform: [{ translateX: 0 }] }
    }
    if (animationType === 'fade') {
      return {
        opacity: withTiming(isCurrent ? 1 : 0, { duration: durationMs }),
        transform: [{ translateX: 0 }]
      }
    }
    // shift
    return {
      opacity: withTiming(isCurrent ? 1 : 0, { duration: durationMs }),
      transform: [
        {
          translateX: withTiming(isCurrent ? 0 : -25, { duration: durationMs })
        }
      ]
    }
  }, [previewTab, animationType, durationMs])

  const previewStyleB = useAnimatedStyle(() => {
    const isCurrent = previewTab === 'B'
    if (animationType === 'none') {
      return { opacity: isCurrent ? 1 : 0, transform: [{ translateX: 0 }] }
    }
    if (animationType === 'fade') {
      return {
        opacity: withTiming(isCurrent ? 1 : 0, { duration: durationMs }),
        transform: [{ translateX: 0 }]
      }
    }
    // shift
    return {
      opacity: withTiming(isCurrent ? 1 : 0, { duration: durationMs }),
      transform: [
        {
          translateX: withTiming(isCurrent ? 0 : 25, { duration: durationMs })
        }
      ]
    }
  }, [previewTab, animationType, durationMs])

  return (
    <>
      {/* 1. Style de transition */}
      <View style={styles.card}>
        <Text style={styles.label}>Style de transition</Text>
        <View style={styles.presets}>
          {(Object.keys(ANIMATION_TYPES) as TabAnimationType[]).map((type) => {
            const selected = animationType === type
            return (
              <Pressable
                key={type}
                onPress={() => setAnimationType(type)}
                style={[styles.chip, selected && styles.chipSelected]}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={ANIMATION_TYPES[type].label}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                  {ANIMATION_TYPES[type].label}
                </Text>
              </Pressable>
            )
          })}
        </View>
        <Text style={styles.hint}>{ANIMATION_TYPES[animationType].description}</Text>
      </View>

      {/* 2. Vitesse de transition */}
      <View style={[styles.card, animationType === 'none' && styles.dimmed]}>
        <View style={styles.labelRow}>
          <Text style={styles.label}>Vitesse</Text>
          <Text style={styles.value}>{animationType === 'none' ? 'Désactivée' : `${dragMs ?? durationMs} ms`}</Text>
        </View>

        <View style={styles.presets}>
          {(Object.keys(SPEED_PRESETS) as TabAnimationSpeed[]).map((sp) => {
            const preset = SPEED_PRESETS[sp]
            const selected = speed === sp && durationMs === preset.duration
            return (
              <Pressable
                key={sp}
                onPress={() => setSpeed(sp)}
                disabled={animationType === 'none'}
                style={[styles.chip, selected && styles.chipSelected]}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={preset.label}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{preset.label}</Text>
              </Pressable>
            )
          })}
        </View>

        <Slider
          value={dragMs ?? durationMs}
          minimumValue={80}
          maximumValue={500}
          step={10}
          onValueChange={setDragMs}
          onSlidingComplete={(ms) => {
            setDragMs(null)
            setCustomDurationMs(ms)
          }}
          disabled={animationType === 'none'}
          minimumTrackTintColor={colors.accent}
          maximumTrackTintColor={colors.hover}
          thumbTintColor="#ffffff"
          accessibilityLabel="Ajustement personnalisé de la durée en millisecondes"
        />

        <Text style={styles.hint}>
          {animationType === 'none'
            ? 'Les animations sont désactivées.'
            : `${SPEED_PRESETS[speed]?.hint ?? `${durationMs} ms`} — vous pouvez ajuster précisément au curseur.`}
        </Text>
      </View>

      {/* 3. Aperçu interactif en direct */}
      <View style={styles.card}>
        <View style={styles.labelRow}>
          <Text style={styles.label}>Aperçu en direct</Text>
          <Text style={styles.value}>Touchez pour tester</Text>
        </View>

        <View style={styles.previewContainer}>
          <View style={styles.previewTabsBar}>
            <Pressable
              onPress={() => setPreviewTab('A')}
              style={[styles.previewTabItem, previewTab === 'A' && styles.previewTabItemActive]}
            >
              <Text style={[styles.previewTabText, previewTab === 'A' && styles.previewTabTextActive]}>
                Accueil
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setPreviewTab('B')}
              style={[styles.previewTabItem, previewTab === 'B' && styles.previewTabItemActive]}
            >
              <Text style={[styles.previewTabText, previewTab === 'B' && styles.previewTabTextActive]}>
                Bibliothèque
              </Text>
            </Pressable>
          </View>

          <View style={styles.previewScene}>
            <Animated.View style={[styles.previewContent, previewStyleA]}>
              <View style={[styles.previewIconBox, { backgroundColor: tint(colors.accent, 0.2) }]}>
                <Sparkles size={20} color={colors.accent} />
              </View>
              <Text style={styles.previewTitle}>Écran Accueil</Text>
              <Text style={styles.previewSubtitle}>Transition fluide configurée à {durationMs} ms</Text>
            </Animated.View>

            <Animated.View style={[styles.previewContent, previewStyleB]}>
              <View style={[styles.previewIconBox, { backgroundColor: tint(colors.info, 0.2) }]}>
                <Layers size={20} color={colors.info} />
              </View>
              <Text style={styles.previewTitle}>Écran Bibliothèque</Text>
              <Text style={styles.previewSubtitle}>Style : {ANIMATION_TYPES[animationType].label}</Text>
            </Animated.View>
          </View>
        </View>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  label: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600'
  },
  value: {
    color: colors.textSecondary,
    fontSize: 12
  },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16
  },
  presets: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginVertical: spacing.sm
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.hover
  },
  chipSelected: {
    backgroundColor: colors.accent
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600'
  },
  chipTextSelected: {
    color: '#000000'
  },
  dimmed: {
    opacity: 0.4
  },
  previewContainer: {
    marginTop: spacing.md,
    backgroundColor: colors.base,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden'
  },
  previewTabsBar: {
    flexDirection: 'row',
    backgroundColor: colors.raised,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  previewTabItem: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center'
  },
  previewTabItemActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.accent
  },
  previewTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted
  },
  previewTabTextActive: {
    color: colors.accent
  },
  previewScene: {
    height: 100,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative'
  },
  previewContent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.sm
  },
  previewIconBox: {
    width: 34,
    height: 34,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4
  },
  previewTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700'
  },
  previewSubtitle: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2
  }
})
