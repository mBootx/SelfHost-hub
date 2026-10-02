import { create } from 'zustand'
import { storage } from '@/services/storage'

/**
 * A short written record of what the app did and what went wrong - backups, sync, updates, connections,
 * crashes - kept on the phone for the Diagnostic screen. Nothing leaves the phone unless the user copies
 * the report. It holds no passwords or tokens: messages are written by the app itself, from error texts.
 */
export type LogScope = 'app' | 'backup' | 'photos' | 'files' | 'music' | 'scrobbler' | 'update' | 'remote' | 'connection' | 'lock'
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  /** When it happened (ms). */
  t: number
  scope: LogScope
  level: LogLevel
  message: string
}

const LOG_KEY = 'diagnostics.log'
const MAX_ENTRIES = 300
const MAX_MESSAGE_LENGTH = 400
/** Writes to storage are gathered for this long, so a busy run doesn't write for every line. */
const SAVE_DELAY_MS = 2000

interface DiagnosticsState {
  entries: LogEntry[]
  /** Reads what earlier runs and background runs saved and merges it in. */
  load: () => Promise<void>
  clear: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function keyOf(entry: LogEntry): string {
  return `${entry.t}|${entry.scope}|${entry.message}`
}

function trim(entries: LogEntry[]): LogEntry[] {
  return entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries
}

function persist(): Promise<void> {
  return storage.savePref(LOG_KEY, useDiagnosticsStore.getState().entries).catch(() => {})
}

/** Entries another run (the background task has its own copy of the app) saved meanwhile are merged in first, so writing doesn't erase them. */
async function mergeAndSave(): Promise<void> {
  await useDiagnosticsStore.getState().load()
  await persist()
}

/** Writes the record now instead of after the usual delay: for the end of a background run, which may be frozen at once. */
export async function flushDiagnostics(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  await mergeAndSave()
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void mergeAndSave()
  }, SAVE_DELAY_MS)
  // Never keep a process alive just to write the record (matters to tests; the phone has no such thing).
  ;(saveTimer as { unref?: () => void }).unref?.()
}

export const useDiagnosticsStore = create<DiagnosticsState>((set, get) => ({
  entries: [],

  load: async () => {
    const saved = await storage.loadPref<LogEntry[]>(LOG_KEY).catch(() => null)
    if (!Array.isArray(saved)) return
    // What is in memory is newer than what was saved before it; entries from another run (the background task
    // has its own copy of this module) are added in time order.
    const known = new Set(get().entries.map(keyOf))
    const merged = [...saved.filter((e) => e && typeof e.t === 'number' && !known.has(keyOf(e))), ...get().entries]
    merged.sort((a, b) => a.t - b.t)
    set({ entries: trim(merged) })
  },

  clear: () => {
    set({ entries: [] })
    persist()
  }
}))

/** Writes one line to the record. Safe to call from anywhere, at any time. */
export function logEvent(scope: LogScope, message: string, level: LogLevel = 'info'): void {
  const text = message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message
  useDiagnosticsStore.setState((s) => ({ entries: trim([...s.entries, { t: Date.now(), scope, level, message: text }]) }))
  if (level === 'error') {
    // A crash may be the last thing that happens: write at once.
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    persist()
  } else {
    scheduleSave()
  }
}

/** The texts of an error that are worth writing down. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

let installed = false

/**
 * Keeps the record of uncaught errors: a crash that closes the app, or a promise nobody waited for that
 * failed, is written down before the previous handler (which shows the red screen or closes the app) runs.
 */
export function installErrorLogging(): void {
  if (installed) return
  installed = true
  void useDiagnosticsStore.getState().load()
  try {
    const utils = (globalThis as any).ErrorUtils
    const previous = utils?.getGlobalHandler?.()
    utils?.setGlobalHandler?.((error: unknown, isFatal?: boolean) => {
      const stack = error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : ''
      logEvent('app', `${isFatal ? 'Erreur fatale' : 'Erreur'} : ${describeError(error)}${stack ? ` — ${stack}` : ''}`, 'error')
      previous?.(error, isFatal)
    })
  } catch {
    // No global handler to wrap: the screen still works, it just won't show crashes.
  }
  try {
    const tracking = require('promise/setimmediate/rejection-tracking')
    tracking.enable({
      allRejections: true,
      onUnhandled: (_id: number, error: unknown) => logEvent('app', `Erreur non gérée : ${describeError(error)}`, 'warn')
    })
  } catch {
    // This engine does not track rejections.
  }
}
