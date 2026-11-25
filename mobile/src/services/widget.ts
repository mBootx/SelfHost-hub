import SelfHostNative from '../../modules/selfhost-native'
import { runPlayMedia } from '@/services/playMedia'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useStarStore } from '@/store/starStore'
import { useToastStore } from '@/store/toastStore'

let started = false

async function ensureClient() {
  const state = useNavidromeStore.getState()
  if (state.client) return state.client
  if (typeof state.restoreSession === 'function') {
    await state.restoreSession().catch(() => {})
    return useNavidromeStore.getState().client
  }
  return null
}

async function runQuickAction(action: 'like' | 'shuffleAll' | 'favorites'): Promise<void> {
  const client = await ensureClient()
  const player = useNavidromeStore.getState()
  if (action === 'like') {
    const song = player.queue?.[player.queueIndex]
    if (!song || !client) return
    await useStarStore.getState().toggle(song, client)
    return
  }
  if (!client) {
    useToastStore.getState().show('Connectez-vous à Navidrome')
    return
  }
  try {
    const ok = await runPlayMedia({ kind: action, id: 'all', mode: 'now' }, client, player)
    if (!ok) {
      useToastStore.getState().show(action === 'favorites' ? 'Aucun titre favori' : 'Aucun titre disponible')
    }
  } catch {
    useToastStore.getState().show(action === 'favorites' ? 'Impossible de lire les favoris' : 'Impossible de lancer le mix')
  }
}

/** What a button of the home-screen widget does: the same as the matching button on the player. */
export function handleWidgetAction(action: string): void {
  const player = useNavidromeStore.getState()
  if (action === 'toggle') player.togglePlay()
  else if (action === 'next') player.next()
  else if (action === 'previous') player.prev()
  else if (action === 'like' || action === 'shuffleAll' || action === 'favorites') {
    void runQuickAction(action)
  }
}

/** At app start: listens for the widget's buttons and runs any action that opened the app. */
export function startWidget(): void {
  if (started) return
  started = true
  try {
    SelfHostNative?.addListener?.('onWidgetAction', (payload) => handleWidgetAction(payload?.action))
    const pending = SelfHostNative?.consumePendingWidgetAction?.()
    if (pending) handleWidgetAction(pending)
  } catch {
    // an older build without the widget
  }
}
