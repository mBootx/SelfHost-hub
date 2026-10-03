import { StyleSheet, Text, View } from 'react-native'
import Slider from '@react-native-community/slider'
import { seekTo } from '@/services/playbackEngine'
import { usePlayhead } from '@/hooks/usePlayhead'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useRemoteStore } from '@/store/remoteStore'

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * The seek bar and the two times under it. It owns the playhead subscription, so the cover, the title and
 * the buttons around it don't redraw four times a second. Follows whichever device is selected; the part already
 * played is in the cover's colour.
 */
export default function SeekBar({ accent }: { accent: string }) {
  const { currentTime, duration, isRemote } = usePlayhead()
  const setProgress = useNavidromeStore((s) => s.setProgress)
  const sendCommand = useRemoteStore((s) => s.sendCommand)

  return (
    <View>
      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={duration || 0}
        value={currentTime}
        minimumTrackTintColor={accent}
        maximumTrackTintColor="rgba(255,255,255,0.3)"
        thumbTintColor={accent}
        accessibilityLabel="Position dans le titre"
        onSlidingComplete={(value) => {
          if (isRemote) {
            sendCommand('seek', { seconds: value })
          } else {
            seekTo(value)
            setProgress(value, duration)
          }
        }}
      />
      <View style={styles.times}>
        <Text style={styles.time}>{formatTime(currentTime)}</Text>
        <Text style={styles.time}>-{formatTime(Math.max(0, duration - currentTime))}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  // The native slider pads its track by the thumb's radius; pulling it out lines the bar up with the cover.
  slider: { height: 36, marginHorizontal: -10 },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 },
  time: { color: 'rgba(255,255,255,0.65)', fontSize: 12 }
})
