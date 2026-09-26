/**
 * The <audio> element lives inside Player.tsx, but the store owns the transport
 * actions (next/prev/repeat) and sometimes has to move the playhead itself -
 * restarting the current track on "previous", for instance. Player registers its
 * element here so those actions can reach it without prop drilling or a context.
 */
let element: HTMLAudioElement | null = null

export function registerAudioElement(el: HTMLAudioElement | null): void {
  element = el
}

export function seekTo(seconds: number): void {
  if (element) element.currentTime = seconds
}
