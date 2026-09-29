import type { ScanStatus } from '@renderer/services/navidrome'
import { useNavidromeStore } from '@renderer/store/navidromeStore'

const POLL_MS = 2000
const TIMEOUT_MS = 3 * 60 * 1000
/** A small scan can be over before the first poll sees it running: stop waiting after this many polls. */
const START_GRACE_POLLS = 3

let running: Promise<void> | null = null

async function run(): Promise<void> {
  const client = useNavidromeStore.getState().client
  if (!client) throw new Error('Navidrome non connecté')
  const before: ScanStatus = await client.startScan()
  const deadline = Date.now() + TIMEOUT_MS
  for (let polls = 1; Date.now() < deadline; polls++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    let status: ScanStatus
    try {
      status = await client.getScanStatus()
    } catch {
      break
    }
    if (status.scanning) continue
    if (status.lastScan !== before.lastScan || polls >= START_GRACE_POLLS) break
  }
  await useNavidromeStore.getState().loadLibrary()
}

/**
 * Asks Navidrome to look for new or changed files, waits for the scan to finish, then reloads the
 * library. Needs an admin account (throws otherwise). Calls made while a scan runs share it.
 */
export function scanLibrary(): Promise<void> {
  if (!running) {
    running = run().finally(() => {
      running = null
    })
  }
  return running
}
