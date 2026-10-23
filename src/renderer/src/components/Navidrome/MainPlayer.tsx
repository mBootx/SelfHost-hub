import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Home, Users, Disc3, ListMusic, Heart, LogOut, PanelRight, Download, Sparkles, Plus, FolderOpen, Trash2, WifiOff, RefreshCw } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { OFFLINE_PLAYLIST_ID, offlinePlaylist, useOfflineStore } from '@renderer/store/offlineStore'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { useHistoryStore } from '@renderer/store/historyStore'
import { useToastStore } from '@renderer/store/toastStore'
import { NDAlbum, NDArtist, NDPlaylist, NDSong } from '@renderer/services/navidrome'
import { DowntifySong } from '@renderer/services/downtify'
import { fetchLyrics, LyricsResult } from '@renderer/services/lyrics'
import { findArtwork, loadArtworkOverrides } from '@renderer/services/artwork'
import { prefetchCoverArt } from '@renderer/services/imagePrefetch'
import { scanLibrary } from '@renderer/services/libraryScan'
import { seekTo } from '@renderer/services/playbackEngine'
import { plural } from '@renderer/services/plural'
import ArtistView from './ArtistView'
import AlbumView from './AlbumView'
import PlaylistView from './PlaylistView'
import NewPlaylistPrompt from './NewPlaylistPrompt'
import LyricsPanel from './LyricsPanel'
import ContextMenu from '@renderer/components/ContextMenu'
import ConfirmModal from '@renderer/components/ConfirmModal'
import SearchResultsList from '@renderer/components/Downtify/SearchResultsList'
import { useNavigate } from 'react-router-dom'
import { useIsOwner } from '@renderer/hooks/useIsOwner'

const SEARCH_DEBOUNCE_MS = 300
/** A grid of albums is drawn this many at a time, more as it is scrolled: a whole library at once (thousands) was slow. */
const GRID_PAGE = 120

type Section = 'home' | 'artists' | 'albums' | 'playlists' | 'favorites' | 'search'

function AlbumGrid({
  albums,
  onSelect
}: {
  albums: NDAlbum[]
  onSelect: (id: string) => void
}): JSX.Element {
  const client = useNavidromeStore((s) => s.client)
  const [shown, setShown] = useState(GRID_PAGE)
  const sentinel = useRef<HTMLDivElement>(null)
  const more = shown < albums.length

  // Back to the first page when the list itself changes (another section, a new search).
  useEffect(() => setShown(GRID_PAGE), [albums])

  // The next page is drawn when the end of this one comes near.
  useEffect(() => {
    const target = sentinel.current
    if (!more || !target) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => n + GRID_PAGE)
      },
      { rootMargin: '800px 0px' }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [more, shown])

  return (
    <>
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {albums.slice(0, shown).map((album) => (
        <button
          key={album.id}
          onClick={() => onSelect(album.id)}
          className="lazy-tile group rounded-md p-3 text-left transition-colors hover:bg-surface-hover"
        >
          {album.coverArt && client ? (
            <img
              src={client.coverArtUrl(album.coverArt, 300)}
              alt=""
              loading="lazy"
              className="mb-3 aspect-square w-full rounded object-cover shadow"
            />
          ) : (
            <div className="mb-3 aspect-square w-full rounded bg-surface-hover" />
          )}
          <p className="truncate text-sm font-medium group-hover:text-accent">{album.name}</p>
          <p className="truncate text-xs text-gray-400">{album.artist}</p>
        </button>
      ))}
    </div>
    {more && <div ref={sentinel} className="h-8" />}
    </>
  )
}

export default function MainPlayer(): JSX.Element {
  const client = useNavidromeStore((s) => s.client)
  const status = useNavidromeStore((s) => s.status)
  const username = useNavidromeStore((s) => s.username)
  const logout = useNavidromeStore((s) => s.logout)
  const restoreSession = useNavidromeStore((s) => s.restoreSession)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const currentSong = useNavidromeStore((s) => s.queue[s.queueIndex] || null)
  const artists = useNavidromeStore((s) => s.artists)
  const playlists = useNavidromeStore((s) => s.playlists)
  const recentAlbums = useNavidromeStore((s) => s.recentAlbums)
  const recentlyPlayed = useNavidromeStore((s) => s.recentlyPlayed)
  const refreshRecentlyPlayed = useNavidromeStore((s) => s.refreshRecentlyPlayed)
  const history = useHistoryStore((s) => s.entries)

  const downtifyClient = useDowntifyStore((s) => s.client)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const lastCompletedAt = useDowntifyStore((s) => s.lastCompletedAt)
  const loadLibrary = useNavidromeStore((s) => s.loadLibrary)
  const offlineTracks = useOfflineStore((s) => s.tracks)
  const playlistCache = useOfflineStore((s) => s.playlistCache)
  const isOffline = status === 'unavailable' || status === 'error'

  const allPlaylists = useMemo(() => {
    const byId = new Map<string, NDPlaylist>()
    for (const p of playlists) byId.set(p.id, p)
    for (const entry of Object.values(playlistCache)) {
      if (!byId.has(entry.playlist.id)) byId.set(entry.playlist.id, entry.playlist)
    }
    const list = Array.from(byId.values())
    if (Object.keys(offlineTracks).length > 0) {
      return [offlinePlaylist(offlineTracks), ...list]
    }
    return list
  }, [playlists, playlistCache, offlineTracks])

  const [section, setSection] = useState<Section>(() => (isOffline ? 'playlists' : 'home'))

  useEffect(() => {
    if (isOffline && section === 'home') setSection('playlists')
  }, [isOffline, section])
  const [favorites, setFavorites] = useState<{ artists: NDArtist[]; albums: NDAlbum[]; songs: NDSong[] }>({
    artists: [],
    albums: [],
    songs: []
  })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ artists: NDArtist[]; albums: NDAlbum[]; songs: NDSong[] }>({
    artists: [],
    albums: [],
    songs: []
  })
  const [downtifyResults, setDowntifyResults] = useState<DowntifySong[]>([])
  const downtifyResultsRef = useRef<DowntifySong[]>([])
  downtifyResultsRef.current = downtifyResults
  const [downtifySearching, setDowntifySearching] = useState(false)
  const [refreshingSearch, setRefreshingSearch] = useState(false)
  // Why the library could not be searched (the server out of reach): not the same as finding nothing.
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchDone, setSearchDone] = useState(false)
  // The whole library's albums, newest first; until they are in, the newest ones already loaded stand in.
  const [allAlbums, setAllAlbums] = useState<NDAlbum[] | null>(null)
  const [albumsError, setAlbumsError] = useState<string | null>(null)
  const [favoritesError, setFavoritesError] = useState<string | null>(null)
  const [favoritesLoaded, setFavoritesLoaded] = useState(false)
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null)
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null)
  const [selectedPlaylist, setSelectedPlaylist] = useState<string | null>(null)
  const [showNewPlaylist, setShowNewPlaylist] = useState(false)
  const [playlistMenu, setPlaylistMenu] = useState<{ x: number; y: number; playlist: NDPlaylist } | null>(null)
  const [playlistToDelete, setPlaylistToDelete] = useState<NDPlaylist | null>(null)
  const deletePlaylist = useNavidromeStore((s) => s.deletePlaylist)
  const showToast = useToastStore((s) => s.show)
  const navigate = useNavigate()
  const isOwner = useIsOwner()

  async function handleDeletePlaylist(playlist: NDPlaylist): Promise<void> {
    try {
      await deletePlaylist(playlist.id)
      showToast(`Playlist « ${playlist.name} » supprimée`)
    } catch (err: any) {
      showToast(err?.message || 'Impossible de supprimer la playlist')
    } finally {
      setPlaylistToDelete(null)
    }
  }
  const [showRightPanel, setShowRightPanel] = useState(true)
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null)
  const [loadingLyrics, setLoadingLyrics] = useState(false)
  const [autoSearching, setAutoSearching] = useState(false)
  const [artworkOverrides, setArtworkOverrides] = useState<Record<string, string>>({})

  // Deliberately not subscribing to currentTime/duration: LyricsPanel owns that
  // subscription so this view - which renders the entire library - doesn't redraw
  // on every playback tick.
  const setProgress = useNavidromeStore((s) => s.setProgress)

  const artworkKey = currentSong?.albumId || currentSong?.id
  const artworkOverride = artworkKey ? artworkOverrides[artworkKey] : undefined

  useEffect(() => {
    loadArtworkOverrides().then(setArtworkOverrides)
  }, [])

  // Every album, the first time the Albums section is opened (it used to show only the 20 newest).
  useEffect(() => {
    if (section !== 'albums' || allAlbums !== null || !client) return
    let cancelled = false
    client
      .getAllAlbums()
      .then((albums) => {
        if (cancelled) return
        setAllAlbums(albums)
        setAlbumsError(null)
      })
      .catch((err) => {
        if (!cancelled) setAlbumsError(err instanceof Error ? err.message : 'Impossible de charger les albums')
      })
    return () => {
      cancelled = true
    }
  }, [section, allAlbums, client])

  // Picks up what was played on the phone since this list was last loaded.
  useEffect(() => {
    if (section === 'home' && client) refreshRecentlyPlayed()
  }, [section, client, refreshRecentlyPlayed])

  // The player bar's "/" shortcut can't reach this input directly (it lives in a
  // sibling component), so it dispatches a plain DOM event instead.
  useEffect(() => {
    function onFocusSearch(): void {
      searchInputRef.current?.focus()
    }
    window.addEventListener('shub:focus-search', onFocusSearch)
    return () => window.removeEventListener('shub:focus-search', onFocusSearch)
  }, [])

  // Lyrics follow the track. The exact LRCLIB lookup is cheap and cached, so it
  // runs on its own; the wider search stays behind the button.
  useEffect(() => {
    if (!currentSong || !showRightPanel) {
      setLyrics(null)
      return
    }
    let cancelled = false
    setLyrics(null)
    setLoadingLyrics(true)
    fetchLyrics(currentSong)
      .then((res) => {
        if (!cancelled) setLyrics(res)
      })
      .finally(() => {
        if (!cancelled) setLoadingLyrics(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentSong?.id, showRightPanel])

  async function handleAutoSearch(): Promise<void> {
    if (!currentSong || !client) return
    setAutoSearching(true)
    try {
      if (!lyrics) {
        const res = await fetchLyrics(currentSong, {
          wide: true,
          navidromeLookup: (artist, title) => client.getLyrics(artist, title)
        })
        if (res) setLyrics(res)
      }
      // Navidrome already having art wins; only go looking when it has none.
      const hasServerArt = !!(currentSong.coverArt || currentSong.albumId)
      if (!hasServerArt && !artworkOverride && artworkKey && currentSong.album) {
        const url = await findArtwork(artworkKey, currentSong.artist, currentSong.album)
        if (url) setArtworkOverrides((prev) => ({ ...prev, [artworkKey]: url }))
      }
    } finally {
      setAutoSearching(false)
    }
  }

  function goSection(s: Section): void {
    setSection(s)
    setSelectedArtist(null)
    setSelectedAlbum(null)
    setSelectedPlaylist(null)
    if (s === 'favorites' && client) {
      setFavoritesError(null)
      client
        .getStarred()
        .then((res) => {
          setFavorites(res)
          setFavoritesLoaded(true)
          prefetchCoverArt(client, res.albums.map((a) => a.coverArt), 300)
        })
        .catch((err) => setFavoritesError(err instanceof Error ? err.message : 'Impossible de charger les favoris'))
    }
  }

  // Bumped on every keystroke; a response whose ticket is stale gets dropped so
  // a slow early request can't overwrite the results of a later one.
  const searchTicket = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function executeSearch(term: string, localOnly = false): Promise<void> {
    if (!client) return
    const mine = ++searchTicket.current
    if (!localOnly) {
      setDowntifySearching(downtifyStatus === 'connected' && !!downtifyClient)
    }
    const currentDownloadableIds = new Set(downtifyResultsRef.current.map((s) => s.song_id))
    const dtState = useDowntifyStore.getState()
    const doneSongs = [
      ...dtState.completedSongs,
      ...dtState.queue.filter((q) => q.status === 'done').map((q) => q.song)
    ].filter((s) => currentDownloadableIds.has(s.song_id))
    const doneTitles = Array.from(new Set(doneSongs.map((s) => s.name))).filter(
      (name) => name && name.toLowerCase() !== term.toLowerCase()
    )

    const [local, remote, ...extraLocals] = await Promise.allSettled([
      client.search(term),
      !localOnly && downtifyStatus === 'connected' && downtifyClient
        ? downtifyClient.searchSongs(term)
        : Promise.resolve(downtifyResultsRef.current),
      ...doneTitles.slice(0, 3).map((title) => client.search(title))
    ])
    if (searchTicket.current !== mine) return
    const baseLocal = local.status === 'fulfilled' ? local.value : { artists: [], albums: [], songs: [] }
    const songMap = new Map<string, NDSong>()
    for (const s of baseLocal.songs) songMap.set(s.id, s)
    for (const extra of extraLocals) {
      if (extra.status === 'fulfilled') {
        for (const s of extra.value.songs) {
          if (!songMap.has(s.id)) songMap.set(s.id, s)
        }
      }
    }
    const localResults = {
      artists: baseLocal.artists,
      albums: baseLocal.albums,
      songs: Array.from(songMap.values())
    }
    setSearchResults(localResults)
    setSearchError(local.status === 'rejected' ? (local.reason instanceof Error ? local.reason.message : 'Serveur injoignable') : null)
    setSearchDone(true)
    if (!localOnly) {
      setDowntifyResults(remote.status === 'fulfilled' ? remote.value.slice(0, 8) : [])
      setDowntifySearching(false)
    }
    prefetchCoverArt(client, localResults.albums.map((a) => a.coverArt), 300)
    prefetchCoverArt(client, localResults.songs.map((s) => s.coverArt || s.albumId), 80)
  }

  function handleSearch(q: string): void {
    setSearchQuery(q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (!client) return

    const term = q.trim()
    if (term.length < 2) {
      searchTicket.current++
      setSearchResults({ artists: [], albums: [], songs: [] })
      setDowntifyResults([])
      setDowntifySearching(false)
      setSearchError(null)
      setSearchDone(false)
      // The box emptied: back to the home page rather than an empty page of results.
      if (term.length === 0 && section === 'search') setSection('home')
      return
    }

    setSection('search')
    // The results take the place of an album, artist or playlist that was open (they used to stay hidden behind it).
    setSelectedAlbum(null)
    setSelectedArtist(null)
    setSelectedPlaylist(null)
    setSearchDone(false)

    searchTimer.current = setTimeout(() => {
      void executeSearch(term, false)
    }, SEARCH_DEBOUNCE_MS)
  }

  async function handleRefreshSearch(): Promise<void> {
    const term = searchQuery.trim()
    if (!client || term.length < 2) return
    setRefreshingSearch(true)
    try {
      await scanLibrary().catch(() => loadLibrary())
      await executeSearch(term, downtifyResultsRef.current.length > 0)
    } finally {
      setRefreshingSearch(false)
    }
  }

  useEffect(() => {
    if (!lastCompletedAt || !client) return
    const term = searchQuery.trim()
    if (term.length >= 2) {
      void executeSearch(term, downtifyResultsRef.current.length > 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCompletedAt])

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
  }, [])

  const navItems: { key: Section; label: string; icon: typeof Home }[] = [
    { key: 'home', label: 'Accueil', icon: Home },
    { key: 'artists', label: 'Artistes', icon: Users },
    { key: 'albums', label: 'Albums', icon: Disc3 },
    { key: 'playlists', label: 'Playlists', icon: ListMusic },
    { key: 'favorites', label: 'Favoris', icon: Heart }
  ]

  function renderCenter(): JSX.Element {
    if (selectedAlbum && client) return <AlbumView client={client} albumId={selectedAlbum} />
    if (selectedArtist && client)
      return <ArtistView client={client} artistId={selectedArtist} onSelectAlbum={setSelectedAlbum} />
    if (selectedPlaylist) {
      return <PlaylistView client={client} playlistId={selectedPlaylist} onDeleted={() => setSelectedPlaylist(null)} />
    }

    if (section === 'search') {
      const nothing = searchResults.artists.length === 0 && searchResults.albums.length === 0 && searchResults.songs.length === 0
      return (
        <div className="animate-fade-in space-y-8 p-6">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400">
              Résultats pour « {searchQuery.trim()} »
            </p>
            <button
              onClick={() => void handleRefreshSearch()}
              disabled={refreshingSearch}
              title="Scanner la bibliothèque et actualiser les résultats"
              className="flex items-center gap-1.5 rounded-full border border-surface-border px-3 py-1 text-xs text-gray-300 transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshingSearch ? 'animate-spin text-accent' : ''}`} />
              Actualiser
            </button>
          </div>
          {searchDone && searchError && <p className="text-sm text-red-400">Recherche impossible : {searchError}</p>}
          {searchDone && !searchError && nothing && downtifyResults.length === 0 && !downtifySearching && (
            <p className="text-sm text-gray-400">Aucun résultat pour « {searchQuery.trim()} ».</p>
          )}
          {searchResults.artists.length > 0 && (
            <div>
              <h2 className="mb-3 text-lg font-semibold">Artistes</h2>
              <div className="flex flex-wrap gap-3">
                {searchResults.artists.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setSelectedArtist(a.id)}
                    className="rounded-full bg-surface-hover px-4 py-2 text-sm hover:bg-surface-border"
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {searchResults.albums.length > 0 && (
            <div>
              <h2 className="mb-3 text-lg font-semibold">Albums</h2>
              <AlbumGrid albums={searchResults.albums} onSelect={setSelectedAlbum} />
            </div>
          )}
          {searchResults.songs.length > 0 && (
            <div>
              <h2 className="mb-3 text-lg font-semibold">Titres</h2>
              <div className="space-y-1">
                {searchResults.songs.map((s, i) => (
                  <button
                    key={s.id}
                    onClick={() => playQueue(searchResults.songs, i)}
                    className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-hover"
                  >
                    {client && (s.coverArt || s.albumId) ? (
                      <img
                        src={client.coverArtUrl(s.coverArt || s.albumId || s.id, 80)}
                        alt=""
                        loading="lazy"
                        className="h-10 w-10 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="h-10 w-10 shrink-0 rounded bg-surface-hover" />
                    )}
                    <span className="min-w-0 truncate">
                      {s.title} <span className="text-gray-400">- {s.artist}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {downtifyStatus === 'connected' && (downtifySearching || downtifyResults.length > 0) && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
                <Download className="h-4 w-4 text-accent" />
                Pas dans votre bibliothèque ? Télécharger via Downtify
              </h2>
              {downtifySearching ? (
                <p className="text-sm text-gray-400">Recherche sur Downtify…</p>
              ) : (
                <SearchResultsList songs={downtifyResults} compact />
              )}
            </div>
          )}
        </div>
      )
    }

    if (section === 'artists') {
      return (
        <div className="animate-fade-in grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {artists.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelectedArtist(a.id)}
              className="lazy-tile flex flex-col items-center gap-2 rounded-md p-3 hover:bg-surface-hover"
            >
              {a.coverArt && client ? (
                <img src={client.coverArtUrl(a.coverArt, 200)} alt="" className="h-24 w-24 rounded-full object-cover" />
              ) : (
                <div className="h-24 w-24 rounded-full bg-surface-hover" />
              )}
              <p className="truncate text-sm font-medium">{a.name}</p>
            </button>
          ))}
        </div>
      )
    }

    if (section === 'albums') {
      return (
        <div className="animate-fade-in p-6">
          {albumsError && <p className="mb-4 text-sm text-red-400">Albums indisponibles : {albumsError}</p>}
          <AlbumGrid albums={allAlbums ?? recentAlbums} onSelect={setSelectedAlbum} />
        </div>
      )
    }

    if (section === 'playlists') {
      return (
        <div className="animate-fade-in p-6">
          {isOwner && !isOffline && (
            <button onClick={() => navigate('/server')} className="mb-4 text-xs text-gray-400 underline hover:text-white">
              Playlists de tous les comptes : à qui elles sont, modifiables ou non (page Serveur)
            </button>
          )}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {!isOffline && (
            <button
              onClick={() => setShowNewPlaylist(true)}
              className="lazy-tile group rounded-md p-3 text-left hover:bg-surface-hover"
            >
              <div className="mb-3 flex aspect-square w-full items-center justify-center rounded border-2 border-dashed border-surface-border text-gray-500 transition-colors group-hover:border-accent group-hover:text-accent">
                <Plus className="h-8 w-8" />
              </div>
              <p className="truncate text-sm font-medium">Nouvelle playlist</p>
            </button>
          )}
          {allPlaylists.map((p) => {
            const isLocalOffline = p.id === OFFLINE_PLAYLIST_ID
            const isCached = isLocalOffline || !!playlistCache[p.id]
            return (
              <button
                key={p.id}
                onClick={() => setSelectedPlaylist(p.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (!isLocalOffline) {
                    setPlaylistMenu({ x: e.clientX, y: e.clientY, playlist: p })
                  }
                }}
                className="lazy-tile rounded-md p-3 text-left hover:bg-surface-hover"
              >
                {p.coverArt && client ? (
                  <img
                    src={client.coverArtUrl(p.coverArt, 300)}
                    alt=""
                    loading="lazy"
                    className="mb-3 aspect-square w-full rounded object-cover shadow"
                  />
                ) : (
                  <div className="mb-3 flex aspect-square w-full items-center justify-center rounded bg-surface-hover">
                    <ListMusic className="h-8 w-8 text-gray-500" />
                  </div>
                )}
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="text-xs text-gray-400">
                  {plural(p.songCount, 'titre', 'titres')}
                  {isLocalOffline ? ' · hors ligne' : isCached ? ' · en cache' : ''}
                </p>
              </button>
            )
          })}
        </div>
        </div>
      )
    }

    if (section === 'favorites') {
      return (
        <div className="animate-fade-in space-y-8 p-6">
          {favoritesError && <p className="text-sm text-red-400">Favoris indisponibles : {favoritesError}</p>}
          {favoritesLoaded && !favoritesError && favorites.albums.length === 0 && favorites.songs.length === 0 && (
            <p className="text-sm text-gray-400">Aucun favori pour le moment : les titres et albums que vous aimez apparaîtront ici.</p>
          )}
          <div>
            <h2 className="mb-3 text-lg font-semibold">Albums favoris</h2>
            <AlbumGrid albums={favorites.albums} onSelect={setSelectedAlbum} />
          </div>
          <div>
            <h2 className="mb-3 text-lg font-semibold">Titres favoris</h2>
            <div className="space-y-1">
              {favorites.songs.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => playQueue(favorites.songs, i)}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-surface-hover"
                >
                  <span>
                    {s.title} <span className="text-gray-400">- {s.artist}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="animate-fade-in space-y-8 p-6">
        {/* Plays reported to Navidrome from any device; this computer's own history until there are some. */}
        {recentlyPlayed.length > 0 ? (
          <div>
            <h2 className="mb-3 text-lg font-semibold">Récemment écouté</h2>
            <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
              {recentlyPlayed.map((album) => (
                <button
                  key={album.id}
                  onClick={() => setSelectedAlbum(album.id)}
                  className="lazy-tile w-32 shrink-0 rounded-md p-2 text-left hover:bg-surface-hover"
                >
                  {client && album.coverArt ? (
                    <img
                      src={client.coverArtUrl(album.coverArt, 200)}
                      alt=""
                      loading="lazy"
                      className="mb-2 aspect-square w-full rounded object-cover shadow"
                    />
                  ) : (
                    <div className="mb-2 flex aspect-square w-full items-center justify-center rounded bg-surface-hover">
                      <ListMusic className="h-6 w-6 text-gray-500" />
                    </div>
                  )}
                  <p className="truncate text-xs font-medium">{album.name}</p>
                  <p className="truncate text-[11px] text-gray-400">{album.artist}</p>
                </button>
              ))}
            </div>
          </div>
        ) : history.length > 0 && (
          <div>
            <h2 className="mb-3 text-lg font-semibold">Récemment écouté</h2>
            <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
              {history.slice(0, 12).map((h, i) => (
                <button
                  key={`${h.id}-${i}`}
                  onClick={() => playQueue([h], 0)}
                  className="lazy-tile w-32 shrink-0 rounded-md p-2 text-left hover:bg-surface-hover"
                >
                  {client ? (
                    <img
                      src={client.coverArtUrl(h.coverArt || h.albumId || h.id, 200)}
                      alt=""
                      loading="lazy"
                      className="mb-2 aspect-square w-full rounded object-cover shadow"
                    />
                  ) : (
                    <div className="mb-2 flex aspect-square w-full items-center justify-center rounded bg-surface-hover">
                      <ListMusic className="h-6 w-6 text-gray-500" />
                    </div>
                  )}
                  <p className="truncate text-xs font-medium">{h.title}</p>
                  <p className="truncate text-[11px] text-gray-400">{h.artist}</p>
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <h2 className="mb-4 text-xl font-bold">Ajouts récents</h2>
          <AlbumGrid albums={recentAlbums} onSelect={setSelectedAlbum} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {isOffline && (
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-elevated px-6 py-2 text-xs">
          <div className="flex items-center gap-2 text-gray-300">
            <WifiOff className="h-4 w-4 text-accent" />
            <span className="font-medium">Hors ligne · Playlists et titres téléchargés disponibles</span>
          </div>
          <button
            onClick={() => restoreSession()}
            className="flex items-center gap-1.5 rounded-full border border-surface-border px-3 py-1 text-xs font-semibold text-accent transition-colors hover:border-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Réessayer
          </button>
        </div>
      )}
      <div className="flex items-center justify-between border-b border-surface-border px-6 py-3">
        <div className="flex w-96 items-center gap-2 rounded-full bg-surface-hover px-4 py-2">
          <Search className="h-4 w-4 text-gray-400" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Rechercher artistes, albums, titres… (/)"
            className="w-full bg-transparent text-sm outline-none placeholder:text-gray-500"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowRightPanel((v) => !v)}
            className={`rounded-full p-2 transition-colors ${showRightPanel ? 'text-accent' : 'text-gray-400 hover:text-white'}`}
            title="Détails"
          >
            <PanelRight className="h-4 w-4" />
          </button>
          <span className="text-sm text-gray-300">{username}</span>
          <button
            onClick={() => logout()}
            className="flex items-center gap-1.5 rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-red-500 hover:text-red-400"
          >
            <LogOut className="h-3.5 w-3.5" /> Se déconnecter
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-surface-border p-3">
          {navItems.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => goSection(key)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                section === key && !selectedAlbum && !selectedArtist && !selectedPlaylist
                  ? 'bg-surface-hover text-accent'
                  : 'text-gray-300 hover:bg-surface-hover hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">{renderCenter()}</div>

        {showRightPanel && (
          <div className="w-72 shrink-0 overflow-y-auto border-l border-surface-border p-5">
            {currentSong && client ? (
              <div className="animate-fade-in space-y-4">
                {currentSong.coverArt || currentSong.albumId || artworkOverride ? (
                  <img
                    src={
                      currentSong.coverArt || currentSong.albumId
                        ? client.coverArtUrl(currentSong.coverArt || currentSong.albumId || currentSong.id, 400)
                        : artworkOverride
                    }
                    alt=""
                    className="w-full rounded-lg shadow-2xl"
                  />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-surface-hover">
                    <ListMusic className="h-10 w-10 text-gray-600" />
                  </div>
                )}
                <div>
                  <p className="text-lg font-semibold">{currentSong.title}</p>
                  <p className="text-sm text-gray-400">{currentSong.artist}</p>
                  <p className="text-xs text-gray-500">{currentSong.album}</p>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Paroles</p>
                    <button
                      onClick={handleAutoSearch}
                      disabled={autoSearching}
                      title="Rechercher paroles et pochette manquantes"
                      className={`rounded-full p-1.5 transition-colors ${
                        autoSearching ? 'text-accent' : 'text-gray-500 hover:text-white'
                      }`}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <LyricsPanel
                    lines={lyrics?.synced ?? null}
                    plain={lyrics?.plain ?? null}
                    loading={loadingLyrics}
                    searching={autoSearching}
                    onSeek={(seconds) => {
                      seekTo(seconds)
                      setProgress(seconds, useNavidromeStore.getState().duration)
                    }}
                    onAutoSearch={handleAutoSearch}
                  />
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Aucun titre en cours de lecture.</p>
            )}
          </div>
        )}
      </div>

      {showNewPlaylist && (
        <NewPlaylistPrompt
          onClose={() => setShowNewPlaylist(false)}
          onCreated={(id) => setSelectedPlaylist(id)}
        />
      )}

      {playlistMenu && (
        <ContextMenu
          x={playlistMenu.x}
          y={playlistMenu.y}
          items={[
            { label: 'Ouvrir', icon: FolderOpen, onClick: () => setSelectedPlaylist(playlistMenu.playlist.id) },
            {
              label: 'Supprimer la playlist',
              icon: Trash2,
              danger: true,
              separatorBefore: true,
              onClick: () => setPlaylistToDelete(playlistMenu.playlist)
            }
          ]}
          onClose={() => setPlaylistMenu(null)}
        />
      )}
      <ConfirmModal
        open={!!playlistToDelete}
        title="Supprimer la playlist ?"
        description={playlistToDelete ? `« ${playlistToDelete.name} » sera définitivement supprimée.` : ''}
        onCancel={() => setPlaylistToDelete(null)}
        onConfirm={() => (playlistToDelete ? handleDeletePlaylist(playlistToDelete) : undefined)}
      />
    </div>
  )
}
