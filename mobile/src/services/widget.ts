import SelfHostNative from '../../modules/selfhost-native'
import { useNavidromeStore } from '@/store/navidromeStore'

let started = false

/** What a button of the home-screen widget does: the same as the matching button on the player. */
export function handleWidgetAction(action: string): void {
  const player = useNavidromeStore.getState()
  if (action === 'toggle') player.togglePlay()
  else if (action === 'next') player.next()
  else if (action === 'previous') player.prev()
}

/** At app start: listens for the widget's buttons. */
export function startWidget(): void {
  if (started) return
  started = true
  try {
    SelfHostNative?.addListener?.('onWidgetAction', (payload) => handleWidgetAction(payload?.action))
  } catch {
    // an older build without the widget
  }
}
