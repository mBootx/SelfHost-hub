package com.selfhosthub.wear.ui.library

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Album
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QueueMusic
import androidx.compose.material.icons.filled.Search
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.Text
import com.selfhosthub.wear.core.PlayMode
import com.selfhosthub.wear.core.formatClock
import com.selfhosthub.wear.data.db.AlbumEntity
import com.selfhosthub.wear.data.db.ArtistEntity
import com.selfhosthub.wear.data.db.PlaylistEntity
import com.selfhosthub.wear.data.db.TrackEntity
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.rememberHaptics

// --- The way in -------------------------------------------------------------------------------------------------

@Composable
fun LibraryHomeContent(onArtists: () -> Unit, onAlbums: () -> Unit, onPlaylists: () -> Unit, onSearch: () -> Unit) {
    val haptics = rememberHaptics()
    ListScreen(stringResource(R.string.library)) {
        item { HomeChip(Icons.Filled.Person, stringResource(R.string.artists)) { haptics.tap(); onArtists() } }
        item { HomeChip(Icons.Filled.Album, stringResource(R.string.albums)) { haptics.tap(); onAlbums() } }
        item { HomeChip(Icons.Filled.QueueMusic, stringResource(R.string.playlists)) { haptics.tap(); onPlaylists() } }
        item { HomeChip(Icons.Filled.Search, stringResource(R.string.search)) { haptics.tap(); onSearch() } }
    }
}

@Composable
private fun HomeChip(icon: ImageVector, label: String, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        label = { Text(label, maxLines = 1) },
        icon = { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)) },
        colors = ChipDefaults.secondaryChipColors(),
        modifier = Modifier.fillMaxWidth().height(48.dp)
    )
}

// --- Artists, albums, playlists ----------------------------------------------------------------------------------

fun albumsLine(artist: String, year: Int?): String = if (year != null) "$artist · $year" else artist

@Composable
fun ArtistsContent(graph: WatchGraph?, list: StoredList<ArtistEntity>, onArtist: (ArtistEntity) -> Unit) {
    val emptyTitle = stringResource(R.string.empty_library)
    val emptyHint = stringResource(R.string.empty_library_hint)
    ListScreen(stringResource(R.string.artists)) {
        storedListStates(list, emptyTitle, emptyHint)
        items(list.items.orEmpty(), key = { it.id }) { artist ->
            MediaRow(
                graph,
                artist.coverId,
                artist.name,
                pluralStringResource(R.plurals.albums_count, artist.albumCount, artist.albumCount),
                onClick = { onArtist(artist) }
            )
        }
    }
}

@Composable
fun ArtistsRoute(graph: WatchGraph, onArtist: (ArtistEntity) -> Unit) {
    val list = rememberStoredList("artists", graph.library.artists)
    ArtistsContent(graph, list, onArtist)
}

@Composable
fun AlbumsContent(graph: WatchGraph?, title: String, list: StoredList<AlbumEntity>, onAlbum: (AlbumEntity) -> Unit) {
    val emptyTitle = stringResource(R.string.empty_library)
    val emptyHint = stringResource(R.string.empty_library_hint)
    ListScreen(title) {
        storedListStates(list, emptyTitle, emptyHint)
        items(list.items.orEmpty(), key = { it.id }) { album ->
            MediaRow(graph, album.coverId, album.name, albumsLine(album.artist, album.year), onClick = { onAlbum(album) })
        }
    }
}

@Composable
fun ArtistAlbumsRoute(graph: WatchGraph, artistId: String, onAlbum: (AlbumEntity) -> Unit) {
    val list = rememberStoredList(artistId, graph.library.albumsOfArtist(artistId)) { graph.library.ensureAlbumsOfArtist(artistId) }
    var title by remember(artistId) { mutableStateOf("") }
    LaunchedEffect(artistId, list.loading) { title = graph.library.artist(artistId)?.name.orEmpty() }
    AlbumsContent(graph, title.ifEmpty { stringResource(R.string.albums) }, list, onAlbum)
}

@Composable
fun AllAlbumsRoute(graph: WatchGraph, onAlbum: (AlbumEntity) -> Unit) {
    val list = rememberStoredList("albums", graph.library.albums)
    AlbumsContent(graph, stringResource(R.string.albums), list, onAlbum)
}

@Composable
fun PlaylistsContent(graph: WatchGraph?, list: StoredList<PlaylistEntity>, onPlaylist: (PlaylistEntity) -> Unit) {
    val emptyTitle = stringResource(R.string.empty_library)
    val emptyHint = stringResource(R.string.empty_library_hint)
    ListScreen(stringResource(R.string.playlists)) {
        storedListStates(list, emptyTitle, emptyHint)
        items(list.items.orEmpty(), key = { it.id }) { playlist ->
            MediaRow(
                graph,
                playlist.coverId,
                playlist.name,
                pluralStringResource(R.plurals.songs_count, playlist.songCount, playlist.songCount),
                onClick = { onPlaylist(playlist) }
            )
        }
    }
}

@Composable
fun PlaylistsRoute(graph: WatchGraph, onPlaylist: (PlaylistEntity) -> Unit) {
    val list = rememberStoredList("playlists", graph.library.playlists)
    PlaylistsContent(graph, list, onPlaylist)
}

// --- Songs ---------------------------------------------------------------------------------------------------------

fun trackLine(track: TrackEntity): String = "${track.artist} · ${formatClock(track.duration.toDouble())}"

/** The songs of an album or a playlist: tap one to play from it, press and hold for the other ways, or play the whole thing from its first song. */
@Composable
fun TracksContent(
    graph: WatchGraph?,
    title: String,
    playAllLabel: String,
    list: StoredList<TrackEntity>,
    onPlayAll: () -> Unit,
    onPlay: (TrackEntity) -> Unit,
    onMore: (TrackEntity) -> Unit
) {
    val haptics = rememberHaptics()
    val emptyTitle = stringResource(R.string.empty_library)
    ListScreen(title) {
        storedListStates(list, emptyTitle)
        if (!list.items.isNullOrEmpty()) {
            item {
                Chip(
                    onClick = { haptics.confirm(); onPlayAll() },
                    label = { Text(playAllLabel, maxLines = 1) },
                    icon = { Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(22.dp)) },
                    colors = ChipDefaults.primaryChipColors(),
                    modifier = Modifier.fillMaxWidth().height(44.dp)
                )
            }
        }
        items(list.items.orEmpty(), key = { it.id }) { track ->
            MediaRow(graph, track.coverId, track.title, trackLine(track), onClick = { onPlay(track) }, onLongClick = { onMore(track) })
        }
    }
}

@Composable
fun AlbumRoute(graph: WatchGraph, albumId: String) {
    val list = rememberStoredList(albumId, graph.library.tracksOfAlbum(albumId)) { graph.library.ensureTracksOfAlbum(albumId) }
    var title by remember(albumId) { mutableStateOf("") }
    LaunchedEffect(albumId, list.loading) { title = graph.library.album(albumId)?.name.orEmpty() }
    val sender = rememberMediaSender(graph)
    var more by remember { mutableStateOf<TrackEntity?>(null) }

    TracksContent(
        graph = graph,
        title = title.ifEmpty { stringResource(R.string.albums) },
        playAllLabel = stringResource(R.string.play_album),
        list = list,
        onPlayAll = { sender.playAlbum(albumId) },
        onPlay = { track -> sender.playAlbum(albumId, songId = track.id) },
        onMore = { more = it }
    )
    TrackActionsDialog(
        track = more,
        onDismiss = { more = null },
        onNow = { more?.let { sender.playAlbum(albumId, songId = it.id) } },
        onNext = { more?.let { sender.playSong(it.id, PlayMode.NEXT) } },
        onLast = { more?.let { sender.playSong(it.id, PlayMode.LAST) } }
    )
    sender.Host()
}

@Composable
fun PlaylistRoute(graph: WatchGraph, playlistId: String) {
    val list = rememberStoredList(playlistId, graph.library.tracksOfPlaylist(playlistId)) { graph.library.ensureTracksOfPlaylist(playlistId) }
    var title by remember(playlistId) { mutableStateOf("") }
    LaunchedEffect(playlistId, list.loading) { title = graph.library.playlist(playlistId)?.name.orEmpty() }
    val sender = rememberMediaSender(graph)
    var more by remember { mutableStateOf<TrackEntity?>(null) }

    TracksContent(
        graph = graph,
        title = title.ifEmpty { stringResource(R.string.playlists) },
        playAllLabel = stringResource(R.string.play_playlist),
        list = list,
        onPlayAll = { sender.playPlaylist(playlistId) },
        onPlay = { track -> sender.playPlaylist(playlistId, songId = track.id) },
        onMore = { more = it }
    )
    TrackActionsDialog(
        track = more,
        onDismiss = { more = null },
        onNow = { more?.let { sender.playPlaylist(playlistId, songId = it.id) } },
        onNext = { more?.let { sender.playSong(it.id, PlayMode.NEXT) } },
        onLast = { more?.let { sender.playSong(it.id, PlayMode.LAST) } }
    )
    sender.Host()
}
