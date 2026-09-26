import { useEffect, useRef, useState } from 'react'
import { Search, Home, Users, Disc3, ListMusic, Heart, LogOut, PanelRight, Download, Sparkles, Plus } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { useHistoryStore } from '@renderer/store/historyStore'
import { NDAlbum, NDArtist, NDSong } from '@renderer/services/navidrome'
import { DowntifySong } from '@renderer/services/downtify'
import { fetchLyrics, LyricsResult } from '@renderer/services/lyrics'
import { findArtwork, loadArtworkOverrides } from '@renderer/services/artwork'
import { prefetchCoverArt } from '@renderer/services/imagePrefetch'
import { seekTo } from '@renderer/services/playbackEngine'
import ArtistView from './ArtistView'
import AlbumView from './AlbumView'
import PlaylistView from './PlaylistView'
import NewPlaylistPrompt from './NewPlaylistPrompt'
import LyricsPanel from './LyricsPanel'
import ServiceUnavailable from '@renderer/components/ServiceUnavailable'
import SearchResultsList from '@renderer/components/Downtify/SearchResultsList'

const SEARCH_DEBOUNCE_MS = 300

type Section = 'home' | 'artists' | 'albums' | 'playlists' | 'favorites' | 'search'

function AlbumGrid({
  albums,
  onSelect
}: {
  albums: NDAlbum[]
  onSelect: (id: string) => void
}): JSX.Element {
  const client = useNavidromeStore((s) => s.client)
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {albums.map((album) => (
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
  const history = useHistoryStore((s) => s.entries)

  const downtifyClient = useDowntifyStore((s) => s.client)
  const downtifyStatus = useDowntifyStore((s) => s.status)

  const [section, setSection] = useState<Section>('home')
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
  const [downtifySearching, setDowntifySearching] = useState(false)
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null)
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null)
  const [selectedPlaylist, setSelectedPlaylist] = useState<string | null>(null)
  const [showNewPlaylist, setShowNewPlaylist] = useState(false)
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
      client.getStarred().then((res) => {
        setFavorites(res)
        prefetchCoverArt(client, res.albums.map((a) => a.coverArt), 300)
      })
    }
  }

  // Bumped on every keystroke; a response whose ticket is stale gets dropped so
  // a slow early request can't overwrite the results of a later one.
  const searchTicket = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      return
    }

    setSection('search')
    const mine = ++searchTicket.current
    setDowntifySearching(downtifyStatus === 'connected' && !!downtifyClient)

    searchTimer.current = setTimeout(async () => {
      // Library and Downtify are searched together; allSettled so a sleeping
      // Downtify box never costs us the Navidrome results.
      const [local, remote] = await Promise.allSettled([
        client.search(term),
        downtifyStatus === 'connected' && downtifyClient
          ? downtifyClient.searchSongs(term)
          : Promise.resolve([] as DowntifySong[])
      ])
      if (searchTicket.current !== mine) return
      const localResults = local.status === 'fulfilled' ? local.value : { artists: [], albums: [], songs: [] }
      setSearchResults(localResults)
      setDowntifyResults(remote.status === 'fulfilled' ? remote.value.slice(0, 8) : [])
      setDowntifySearching(false)
      prefetchCoverArt(client, localResults.albums.map((a) => a.coverArt), 300)
      prefetchCoverArt(client, localResults.songs.map((s) => s.coverArt || s.albumId), 80)
    }, SEARCH_DEBOUNCE_MS)
  }

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
  }, [])

  if (status === 'unavailable' || status === 'error') {
    return (
      <ServiceUnavailable
        serviceName="Navidrome"
        onRetry={() => restoreSession()}
      />
    )
  }

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
    if (selectedPlaylist && client) return <PlaylistView client={client} playlistId={selectedPlaylist} />

    if (section === 'search') {
      return (
        <div className="animate-fade-in space-y-8 p-6">
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
                    onDoubleClick={() => playQueue(searchResults.songs, i)}
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
                Pas dans votre bibliotheque ? Telecharger via Downtify
              </h2>
              {downtifySearching ? (
                <p className="text-sm text-gray-400">Recherche sur Downtify...</p>
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
          <AlbumGrid albums={recentAlbums} onSelect={setSelectedAlbum} />
        </div>
      )
    }

    if (section === 'playlists') {
      return (
        <div className="animate-fade-in grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          <button
            onClick={() => setShowNewPlaylist(true)}
            className="lazy-tile group rounded-md p-3 text-left hover:bg-surface-hover"
          >
            <div className="mb-3 flex aspect-square w-full items-center justify-center rounded border-2 border-dashed border-surface-border text-gray-500 transition-colors group-hover:border-accent group-hover:text-accent">
              <Plus className="h-8 w-8" />
            </div>
            <p className="truncate text-sm font-medium">Nouvelle playlist</p>
          </button>
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedPlaylist(p.id)}
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
              <p className="text-xs text-gray-400">{p.songCount} titres</p>
            </button>
          ))}
        </div>
      )
    }

    if (section === 'favorites') {
      return (
        <div className="animate-fade-in space-y-8 p-6">
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
        {history.length > 0 && (
          <div>
            <h2 className="mb-3 text-lg font-semibold">Recemment ecoute</h2>
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
          <h2 className="mb-4 text-xl font-bold">Ajouts recents</h2>
          <AlbumGrid albums={recentAlbums} onSelect={setSelectedAlbum} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-surface-border px-6 py-3">
        <div className="flex w-96 items-center gap-2 rounded-full bg-surface-hover px-4 py-2">
          <Search className="h-4 w-4 text-gray-400" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Rechercher artistes, albums, titres... (/)"
            className="w-full bg-transparent text-sm outline-none placeholder:text-gray-500"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowRightPanel((v) => !v)}
            className={`rounded-full p-2 transition-colors ${showRightPanel ? 'text-accent' : 'text-gray-400 hover:text-white'}`}
            title="Details"
          >
            <PanelRight className="h-4 w-4" />
          </button>
          <span className="text-sm text-gray-300">{username}</span>
          <button
            onClick={() => logout()}
            className="flex items-center gap-1.5 rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-red-500 hover:text-red-400"
          >
            <LogOut className="h-3.5 w-3.5" /> Se deconnecter
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
    </div>
  )
}
