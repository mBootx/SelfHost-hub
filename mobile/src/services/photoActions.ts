import { Asset } from 'expo-media-library'
import * as Sharing from 'expo-sharing'
import { expectExternalScreen } from '@/services/appLock'
import { requestCameraRollAccess } from '@/services/cameraBackup'
import type { FileBrowserClient } from '@/services/filebrowser'

/** What hands a photo or video from the server to something else on the phone: another app, or the gallery. */

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo'
}

export function mimeTypeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return MIME_TYPES[dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''] ?? 'application/octet-stream'
}

export interface MediaRef {
  path: string
  name: string
}

/** Opens Android's share sheet with the file. False when this phone has no share sheet to offer. */
export async function shareMedia(client: FileBrowserClient, item: MediaRef, onProgress?: (loaded: number, total: number) => void): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false
  const uri = await client.downloadToCache(item.path, item.name, onProgress)
  expectExternalScreen()
  await Sharing.shareAsync(uri, { mimeType: mimeTypeOf(item.name), dialogTitle: item.name })
  return true
}

export interface SaveReport {
  saved: number
  failed: number
  /** Why the first one failed, if any did. */
  message: string | null
}

/** Copies photos and videos from the server into the phone's gallery, one after the other. */
export async function saveToGallery(
  client: FileBrowserClient,
  items: MediaRef[],
  onEach?: (done: number, total: number) => void
): Promise<SaveReport> {
  const report: SaveReport = { saved: 0, failed: 0, message: null }
  if (!(await requestCameraRollAccess())) {
    return { saved: 0, failed: items.length, message: "L'accès aux photos du téléphone est refusé" }
  }
  for (const [index, item] of items.entries()) {
    try {
      const uri = await client.downloadToCache(item.path, item.name)
      await Asset.create(uri)
      report.saved++
    } catch (err) {
      report.failed++
      report.message ??= err instanceof Error && err.message ? err.message : 'Enregistrement impossible'
    }
    onEach?.(index + 1, items.length)
  }
  return report
}
