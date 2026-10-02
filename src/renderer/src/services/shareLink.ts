import type { FBItem, FileBrowserClient, ShareDuration } from '@renderer/services/filebrowser'

export const WEEK: ShareDuration = { value: 7, unit: 'days' }

/**
 * Puts a share link for the item on the clipboard and says what was copied. The link is made by the server:
 * unlike the address the app uses to show a file, it holds nothing of this session, so pasting it somewhere
 * gives away the file and nothing else.
 */
export async function copyShareLink(client: FileBrowserClient, item: FBItem, duration: ShareDuration): Promise<string> {
  const link = await client.createShare(item.path, duration)
  await navigator.clipboard.writeText(link.url)
  if (!duration) return 'Lien copié (sans limite de durée)'
  return `Lien copié (valable ${duration.value} ${duration.unit === 'days' ? (duration.value > 1 ? 'jours' : 'jour') : duration.unit === 'hours' ? 'h' : 'min'})`
}
