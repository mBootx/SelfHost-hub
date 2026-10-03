import type { GestureName } from '@/services/gestureRecognizer'
import type { NDSong } from '@/services/navidrome'
import { useNavidromeStore } from '@/store/navidromeStore'
import { LOCAL_DEVICE_ID, useRemoteStore } from '@/store/remoteStore'
import { isStarred, useStarStore } from '@/store/starStore'
import SelfHostNative from '../../modules/selfhost-native'

/**
 * What the car mode's gestures and buttons do. They drive whatever the player drives: this phone, or the device picked
 * as the output (the PC, another phone), exactly like the player's own buttons (remoteStore.sendCommand).
 */

export type CarAction = 'toggle' | 'next' | 'prev' | 'volumeUp' | 'volumeDown' | 'like'

export const ACTION_FOR: Record<GestureName, CarAction> = {
  PINCH: 'toggle',
  WAVE_RIGHT: 'next',
  WAVE_LEFT: 'prev',
  PALM_UP: 'volumeUp',
  PALM_DOWN: 'volumeDown',
  THUMB_UP: 'like'
}

/** A step of the volume of a remote device, or of the app's own player when the phone's volume can't be reached. */
const VOLUME_STEP = 0.1

/** What happened, in a few words for the screen (the volume reached, the like); null when there is nothing to add. */
export type CarOutcome = string | null

const percent = (level: number): string => `${Math.round(Math.min(1, Math.max(0, level)) * 100)} %`

export async function runCarAction(action: CarAction): Promise<CarOutcome> {
  const remote = useRemoteStore.getState()
  const isRemote = remote.selectedDeviceId !== LOCAL_DEVICE_ID
  const device = isRemote ? remote.devices[remote.selectedDeviceId] : undefined

  switch (action) {
    case 'toggle':
    case 'next':
    case 'prev':
      remote.sendCommand(action)
      return null

    case 'volumeUp':
    case 'volumeDown': {
      const direction = action === 'volumeUp' ? 1 : -1
      if (isRemote) {
        const level = Math.min(1, Math.max(0, (device?.volume ?? 0.5) + direction * VOLUME_STEP))
        remote.sendCommand('setVolume', { volume: Math.round(level * 100) / 100 })
        return `Volume ${percent(level)}`
      }
      // The phone's media volume, as its buttons move it: in a car that is what reaches the speakers.
      const after = SelfHostNative?.stepMediaVolume?.(direction)
      if (typeof after === 'number' && after >= 0) return `Volume ${percent(after)}`
      const player = useNavidromeStore.getState()
      const level = Math.min(1, Math.max(0, player.volume + direction * VOLUME_STEP))
      player.setVolume(level)
      return `Volume ${percent(level)}`
    }

    case 'like': {
      const player = useNavidromeStore.getState()
      const song = (isRemote ? device?.song : player.queue[player.queueIndex]) as NDSong | null | undefined
      const client = player.client
      if (!song || !client) return 'Aucun titre en cours'
      const stars = useStarStore.getState()
      // A like, never an unlike: a thumb up on a favourite leaves it one.
      if (isStarred(stars, song)) return 'Déjà dans vos favoris'
      return (await stars.toggle(song, client)) ? 'Ajouté aux favoris' : 'Favoris injoignables'
    }
  }
}
