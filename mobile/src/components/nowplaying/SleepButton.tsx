import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { Moon } from 'lucide-react-native'
import ActionSheet, { ActionSheetItem } from '@/components/ActionSheet'
import { describeRemaining, SLEEP_PRESETS_MINUTES, useSleepTimerStore } from '@/services/sleepTimer'
import { colors } from '@/constants/theme'

function presetLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} h` : minutes > 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} minutes`
}

/** The moon on the player: sets the sleep timer, and says how long is left on it. */
export default function SleepButton({
  idleColor,
  activeColor = colors.accent,
  size = 22
}: {
  idleColor: string
  /** The colour it takes while a timer is set (the cover's, on the player). */
  activeColor?: string
  size?: number
}) {
  const mode = useSleepTimerStore((s) => s.mode)
  const endsAt = useSleepTimerStore((s) => s.endsAt)
  const startTimer = useSleepTimerStore((s) => s.startTimer)
  const stopAfterTrack = useSleepTimerStore((s) => s.stopAfterTrack)
  const cancel = useSleepTimerStore((s) => s.cancel)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())

  // The remaining time is shown to the minute: no need to redraw more often than that while the screen is on.
  useEffect(() => {
    if (mode !== 'timer') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [mode, endsAt])

  const active = mode !== 'off'
  const remaining = mode === 'timer' && endsAt !== null ? describeRemaining(endsAt - now) : null

  const items: ActionSheetItem[] = [
    ...SLEEP_PRESETS_MINUTES.map((minutes) => ({ label: presetLabel(minutes), icon: Moon, onPress: () => startTimer(minutes) })),
    { label: 'À la fin du titre', icon: Moon, onPress: stopAfterTrack },
    ...(active ? [{ label: 'Annuler la minuterie', icon: Moon, danger: true, onPress: cancel }] : [])
  ]
  const title = mode === 'timer' ? `Minuterie de sommeil · il reste ${remaining}` : mode === 'track' ? 'Arrêt à la fin du titre' : 'Minuterie de sommeil'

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={10}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel={active ? `Minuterie de sommeil active${remaining ? `, ${remaining}` : ''}` : 'Minuterie de sommeil'}
      >
        <Moon size={size} color={active ? activeColor : idleColor} fill={active ? activeColor : 'none'} />
        {remaining ? (
          <Text style={[styles.remaining, { color: activeColor }]}>{remaining}</Text>
        ) : mode === 'track' ? (
          <Text style={[styles.remaining, { color: activeColor }]}>fin du titre</Text>
        ) : null}
      </Pressable>
      <ActionSheet visible={open} title={title} items={items} onClose={() => setOpen(false)} />
    </>
  )
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  remaining: { fontSize: 12, fontWeight: '700' }
})
