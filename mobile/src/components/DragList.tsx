import { ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  SharedValue,
  measure,
  runOnJS,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { GripVertical } from 'lucide-react-native'
import { edgeSpeed, moveSlot, slotAt } from '@/services/dragMath'

interface DragState {
  positions: SharedValue<Record<string, number>>
  activeKey: SharedValue<string>
  startSlot: SharedValue<number>
  /** How far the finger has moved since it took the row. */
  dy: SharedValue<number>
  /** Where the finger is on screen, for scrolling near the edges; -1 when it isn't dragging. */
  fingerY: SharedValue<number>
  scrollY: SharedValue<number>
  scrollAtStart: SharedValue<number>
}

interface Props<T> {
  items: T[]
  /** A key that stays with the item when it moves (see dragMath.occurrenceKeys for items that repeat). */
  keyOf: (item: T, index: number) => string
  /** Every row is this high: what lets the rows be placed while one moves. */
  rowHeight: number
  /** A row; `grip` is the handle to drag it by, to be placed in it (at the start or the end). */
  renderRow: (item: T, index: number, grip: ReactNode) => ReactNode
  /** The item at `from` was dropped at `to`. */
  onMove: (from: number, to: number) => void
  header?: ReactNode
  footer?: ReactNode
  contentContainerStyle?: StyleProp<ViewStyle>
  gripColor?: string
  /** Behind the row being dragged, so it reads clearly over the ones it passes. */
  activeBackground?: string
  style?: StyleProp<ViewStyle>
}

/** The duration of the moves around the row being dragged, and of the dropped row settling into its slot. */
const SHIFT_MS = 150
const SETTLE_MS = 120

/**
 * A list reordered by dragging the grip of a row: the row follows the finger, the others make room, and the list scrolls
 * on its own when the finger nears its top or bottom. Rows are all the same height and absolutely placed, each at its
 * slot (`positions`), so a drop changes nothing on screen when the new order comes back from the caller.
 */
export default function DragList<T>({
  items,
  keyOf,
  rowHeight,
  renderRow,
  onMove,
  header,
  footer,
  contentContainerStyle,
  gripColor = '#ffffff',
  activeBackground = 'rgba(40,40,40,0.96)',
  style
}: Props<T>) {
  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const keys = useMemo(() => items.map((item, i) => keyOf(item, i)), [items, keyOf])
  const order = () => Object.fromEntries(keys.map((key, i) => [key, i]))

  const positions = useSharedValue<Record<string, number>>(order())
  const activeKey = useSharedValue('')
  const startSlot = useSharedValue(0)
  const dy = useSharedValue(0)
  const fingerY = useSharedValue(-1)
  const scrollY = useSharedValue(0)
  const scrollAtStart = useSharedValue(0)
  // One object for the rows, the same at every render (so their gestures are not rebuilt while a finger holds one).
  const state = useMemo<DragState>(
    () => ({ positions, activeKey, startSlot, dy, fingerY, scrollY, scrollAtStart }),
    [positions, activeKey, startSlot, dy, fingerY, scrollY, scrollAtStart]
  )
  const count = items.length

  // The order given is the order shown (after a drop, it is the one the rows are already in).
  const latestKeys = useRef(keys)
  latestKeys.current = keys
  useLayoutEffect(() => {
    state.positions.value = order()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])

  const onScroll = useAnimatedScrollHandler((event) => {
    state.scrollY.value = event.contentOffset.y
  })

  // While a row is held near an edge, the list scrolls, and the row stays under the finger.
  useFrameCallback(() => {
    if (!state.activeKey.value || state.fingerY.value < 0) return
    const box = measure(scrollRef)
    if (!box) return
    const speed = edgeSpeed(state.fingerY.value, box.pageY, box.height)
    if (speed === 0) return
    scrollTo(scrollRef, 0, Math.max(0, state.scrollY.value + speed), false)
    const offset = state.dy.value + state.scrollY.value - state.scrollAtStart.value
    const slot = slotAt(state.startSlot.value, offset, rowHeight, count)
    if (slot !== state.positions.value[state.activeKey.value]) state.positions.value = moveSlot(state.positions.value, state.activeKey.value, slot)
  })

  // A drop the caller did not take (an error, a list that changed meanwhile) puts the rows back as they are given.
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove
  const dropped = useCallback(
    (from: number, to: number): void => {
      onMoveRef.current(from, to)
      setTimeout(() => {
        positions.value = Object.fromEntries(latestKeys.current.map((key, i) => [key, i]))
      }, 80)
    },
    [positions]
  )

  return (
    <Animated.ScrollView ref={scrollRef} onScroll={onScroll} scrollEventThrottle={16} style={style} contentContainerStyle={contentContainerStyle}>
      {header}
      <View style={{ height: count * rowHeight }}>
        {items.map((item, index) => (
          <DragRow key={keys[index]} rowKey={keys[index]} index={index} count={count} rowHeight={rowHeight} state={state} onDropped={dropped} gripColor={gripColor} activeBackground={activeBackground}>
            {(grip) => renderRow(item, index, grip)}
          </DragRow>
        ))}
      </View>
      {footer}
    </Animated.ScrollView>
  )
}

function DragRow({
  rowKey,
  index,
  count,
  rowHeight,
  state,
  onDropped,
  gripColor,
  activeBackground,
  children
}: {
  rowKey: string
  index: number
  count: number
  rowHeight: number
  state: DragState
  onDropped: (from: number, to: number) => void
  gripColor: string
  activeBackground: string
  children: (grip: ReactNode) => ReactNode
}) {
  const style = useAnimatedStyle(() => {
    const slot = state.positions.value[rowKey] ?? index
    if (state.activeKey.value === rowKey) {
      return {
        top: state.startSlot.value * rowHeight + state.dy.value + state.scrollY.value - state.scrollAtStart.value,
        zIndex: 10,
        elevation: 10,
        backgroundColor: activeBackground,
        transform: [{ scale: 1.02 }]
      }
    }
    const target = slot * rowHeight
    // The others glide out of the way while a row is dragged; otherwise a row simply sits at its slot.
    return {
      top: state.activeKey.value ? withTiming(target, { duration: SHIFT_MS }) : target,
      zIndex: 0,
      elevation: 0,
      backgroundColor: 'transparent',
      transform: [{ scale: 1 }]
    }
  })

  // Taken as soon as the grip is touched, before the list can start scrolling.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((_event, manager) => {
          if (state.activeKey.value === '') manager.activate()
          else manager.fail()
        })
        .onStart((event) => {
          state.startSlot.value = state.positions.value[rowKey] ?? index
          state.scrollAtStart.value = state.scrollY.value
          state.dy.value = 0
          state.fingerY.value = event.absoluteY
          state.activeKey.value = rowKey
        })
        .onUpdate((event) => {
          state.dy.value = event.translationY
          state.fingerY.value = event.absoluteY
          const offset = event.translationY + state.scrollY.value - state.scrollAtStart.value
          const slot = slotAt(state.startSlot.value, offset, rowHeight, count)
          if (slot !== state.positions.value[rowKey]) state.positions.value = moveSlot(state.positions.value, rowKey, slot)
        })
        .onFinalize(() => {
          if (state.activeKey.value !== rowKey) return
          state.fingerY.value = -1
          const from = state.startSlot.value
          const to = state.positions.value[rowKey] ?? from
          // The row settles into its slot, then the new order is handed over.
          const settled = (to - from) * rowHeight - (state.scrollY.value - state.scrollAtStart.value)
          state.dy.value = withTiming(settled, { duration: SETTLE_MS }, () => {
            state.activeKey.value = ''
            if (to !== from) runOnJS(onDropped)(from, to)
          })
        }),
    [rowKey, index, count, rowHeight, state, onDropped]
  )

  const grip = (
    <GestureDetector gesture={pan}>
      <View style={styles.grip} accessibilityLabel="Glisser pour déplacer" hitSlop={8}>
        <GripVertical size={20} color={gripColor} />
      </View>
    </GestureDetector>
  )

  return <Animated.View style={[styles.row, { height: rowHeight }, style]}>{children(grip)}</Animated.View>
}

const styles = StyleSheet.create({
  row: { position: 'absolute', left: 0, right: 0, borderRadius: 10 },
  grip: { paddingHorizontal: 6, paddingVertical: 10, justifyContent: 'center' }
})
