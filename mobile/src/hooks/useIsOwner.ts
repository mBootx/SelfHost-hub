import { useEffect, useState } from 'react'
import { storage } from '@/services/storage'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useNavidromeStore } from '@/store/navidromeStore'

/** The account that runs the server: the server dashboard is for it alone. */
const OWNER = 'mbootx'

function isOwner(username: string | null | undefined): boolean {
  return username?.trim().toLowerCase() === OWNER
}

/**
 * Whether the server's owner is signed in; null until the saved sign-ins have been read. Those count
 * too: the dashboard (and its Wake-on-LAN) is most needed when the server is asleep and nothing connects.
 */
export function useIsOwner(): boolean | null {
  const navidromeUser = useNavidromeStore((s) => s.username)
  const filebrowserUser = useFileBrowserStore((s) => s.client?.getUsername() ?? null)
  const [savedOwner, setSavedOwner] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([storage.loadConnection('navidrome'), storage.loadConnection('filebrowser')])
      .then((conns) => {
        if (!cancelled) setSavedOwner(conns.some((c) => isOwner(c?.username)))
      })
      .catch(() => {
        if (!cancelled) setSavedOwner(false)
      })
    return () => {
      cancelled = true
    }
  }, [navidromeUser, filebrowserUser])

  if (isOwner(navidromeUser) || isOwner(filebrowserUser)) return true
  return savedOwner
}
