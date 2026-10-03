import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, Polyline } from 'react-native-svg'
import { HandCameraPreview } from '../../../modules/selfhost-native'
import type { HandDetection } from '@/hooks/useHandGestureDetection'

/** The bones drawn between the 21 points: the palm, then each finger from the wrist out. */
const BONES = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [5, 9, 10, 11, 12],
  [9, 13, 14, 15, 16],
  [13, 17, 18, 19, 20],
  [0, 17]
]

const POSE_LABEL: Record<string, string> = { pinch: 'pince', thumbUp: 'pouce levé', openPalm: 'main ouverte', other: 'autre' }

/**
 * The test mode: what the front camera sees, with the hands the landmarker found drawn over it, and the numbers that
 * say how well it keeps up (frames a second, milliseconds per frame). Without the camera view (an older build) the
 * hands are drawn on black.
 */
export default function CameraFeed({ detection, accent }: { detection: HandDetection; accent: string }) {
  const [box, setBox] = useState({ width: 0, height: 0 })
  const view = detection.view
  // The picture is shown whole: scale it into the box and centre it, the way the camera view does.
  const frameW = view?.width || 3
  const frameH = view?.height || 4
  const scale = Math.min(box.width / frameW, box.height / frameH) || 0
  const drawnW = frameW * scale
  const drawnH = frameH * scale
  const left = (box.width - drawnW) / 2
  const top = (box.height - drawnH) / 2

  return (
    <View style={styles.root} onLayout={(e) => setBox(e.nativeEvent.layout)}>
      {HandCameraPreview ? <HandCameraPreview style={StyleSheet.absoluteFill} /> : null}
      {view && scale > 0 && (
        <Svg style={[styles.overlay, { left, top, width: drawnW, height: drawnH }]} width={drawnW} height={drawnH}>
          {view.hands.map((points, h) => (
            <HandDrawing key={h} points={points} width={drawnW} height={drawnH} color={h === 0 ? accent : '#ffffff'} />
          ))}
        </Svg>
      )}
      <View style={styles.stats}>
        <Text style={styles.statsText}>
          {detection.fps} img/s · {detection.processingMs} ms ·{' '}
          {detection.isHand ? `main : ${POSE_LABEL[detection.pose ?? 'other']}` : 'pas de main'}
        </Text>
      </View>
    </View>
  )
}

function HandDrawing({ points, width, height, color }: { points: number[]; width: number; height: number; color: string }) {
  if (points.length < 63) return null
  const at = (i: number): string => `${points[i * 3] * width},${points[i * 3 + 1] * height}`
  return (
    <>
      {BONES.map((bone, i) => (
        <Polyline key={`b${i}`} points={bone.map(at).join(' ')} fill="none" stroke={color} strokeWidth={3} strokeOpacity={0.8} />
      ))}
      {Array.from({ length: 21 }, (_, i) => (
        <Circle key={i} cx={points[i * 3] * width} cy={points[i * 3 + 1] * height} r={i === 4 || i === 8 ? 6 : 4} fill={color} />
      ))}
    </>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignSelf: 'stretch', borderRadius: 16, overflow: 'hidden', backgroundColor: '#050505', borderWidth: 1, borderColor: '#2a2a2a' },
  overlay: { position: 'absolute' },
  stats: { position: 'absolute', left: 8, bottom: 8, backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  statsText: { color: '#ffffff', fontSize: 13, fontWeight: '600' }
})
