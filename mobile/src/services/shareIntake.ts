import { Directory, File, Paths } from 'expo-file-system'
import { create } from 'zustand'
import SelfHostNative from '../../modules/selfhost-native'
import type { SharedContent, SharedFile } from '../../modules/selfhost-native'
import { logEvent } from '@/services/diagnostics'

/**
 * Files and text that other apps send to this one ("Partager" > "SelfHost Hub"). Android hands them to the
 * module, which copies the files into the cache; they wait here for the person to say where they go. Nothing
 * is sent anywhere before that.
 */
export type { SharedContent, SharedFile }

interface ShareState {
  /** What is waiting for a destination, or null. A second share while the first is still open is added to it. */
  pending: SharedContent | null
  receive: (content: SharedContent) => void
  /** Closes the sheet. The copies are not touched: uploads may still be reading them (see forgetShared). */
  dismiss: () => void
}

export const useShareStore = create<ShareState>((set) => ({
  pending: null,

  receive: (content) =>
    set((state) => {
      if (content.files.length === 0 && !content.text && content.unreadable === 0) return state
      const before = state.pending
      if (!before) return { pending: content }
      return {
        pending: {
          files: [...before.files, ...content.files],
          text: content.text ?? before.text,
          unreadable: before.unreadable + content.unreadable
        }
      }
    }),

  dismiss: () => set({ pending: null })
}))

/** Deletes the cached copies of files that have been sent, or that were never going to be. */
export function forgetShared(files: SharedFile[]): void {
  for (const file of files) {
    try {
      new File(file.uri).delete()
    } catch {
      // already gone
    }
  }
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * The name offered for text that was shared on its own, which is saved as a note: the first words of the
 * text when there are some, otherwise the date and time.
 */
export function noteName(text: string, now: Date): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  const isLink = /^\s*[a-z][a-z0-9+.-]*:\/\//i.test(firstLine)
  // A link is named after where it points, without the tracking parameters behind the question mark.
  const words = (isLink ? firstLine.trim().replace(/[?#].*$/, '') : firstLine)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`
  // A name made only of dots would be a hidden or special file.
  const stem = words.replace(/^\.+/, '').trim()
  return `${stem ? `${stem} - ` : 'Note '}${stamp}.txt`
}

/** A name that ends in .txt, whatever was typed. */
export function withTextExtension(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  if (clean === '' || /^\.+$/.test(clean)) return 'Note.txt'
  return /\.[A-Za-z0-9]{1,5}$/.test(clean) ? clean : `${clean}.txt`
}

/** Writes shared text to the cache as a file, so it goes up like any other. */
export function writeNote(name: string, text: string): SharedFile {
  const folder = new Directory(Paths.cache, 'shared-in')
  if (!folder.exists) folder.create({ intermediates: true })
  const finalName = withTextExtension(name)
  const file = new File(folder, `${Date.now()}-${finalName}`)
  file.create()
  file.write(text)
  // The size in bytes, which is not the number of characters once there are accents.
  return { uri: file.uri, name: finalName, size: file.size ?? text.length, mime: 'text/plain' }
}

let started = false

/** At app start: picks up the share the app was opened with, and listens for the ones that come later. */
export function startShareIntake(): void {
  if (started) return
  started = true
  const native = SelfHostNative
  if (!native?.consumeSharedContent) return
  const check = async (): Promise<void> => {
    try {
      const content = await native.consumeSharedContent!()
      if (!content) return
      logEvent('files', `Partage reçu : ${content.files.length} fichier(s)${content.text ? ' et du texte' : ''}${content.unreadable > 0 ? `, ${content.unreadable} illisible(s)` : ''}`)
      useShareStore.getState().receive(content)
    } catch (err) {
      logEvent('files', `Partage illisible : ${err instanceof Error ? err.message : String(err)}`, 'warn')
    }
  }
  void check()
  native.addListener?.('onShareReceived', () => void check())
}
