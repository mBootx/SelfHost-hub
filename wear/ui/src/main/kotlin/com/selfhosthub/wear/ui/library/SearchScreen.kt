package com.selfhosthub.wear.ui.library

import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Search
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.Text
import androidx.wear.input.RemoteInputIntentHelper
import com.selfhosthub.wear.core.PlayMode
import com.selfhosthub.wear.data.LibrarySearchResult
import com.selfhosthub.wear.data.db.AlbumEntity
import com.selfhosthub.wear.data.db.ArtistEntity
import com.selfhosthub.wear.data.db.TrackEntity
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.rememberHaptics

private const val QUERY_KEY = "query"

/**
 * Search: the query is typed on the system keyboard (or spoken), and the results are the server's when it answers
 * and the watch's own library when it does not. Artists and albums open; a song plays from its album.
 */
@Composable
fun SearchContent(
    graph: WatchGraph?,
    query: String,
    result: LibrarySearchResult?,
    searching: Boolean,
    onEdit: () -> Unit,
    onArtist: (ArtistEntity) -> Unit,
    onAlbum: (AlbumEntity) -> Unit,
    onPlay: (TrackEntity) -> Unit,
    onMore: (TrackEntity) -> Unit
) {
    val haptics = rememberHaptics()
    ListScreen(stringResource(R.string.search)) {
        item {
            Chip(
                onClick = { haptics.tap(); onEdit() },
                label = { Text(query.ifEmpty { stringResource(R.string.search_hint) }, maxLines = 1) },
                icon = { Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.size(20.dp)) },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth().height(44.dp)
            )
        }
        if (searching) item { Loading() }
        if (result != null) {
            if (!result.fromServer) {
                item { Notice(Icons.Filled.CloudOff, stringResource(R.string.search_offline), null, null) }
            }
            if (result.isEmpty) item { Notice(Icons.Filled.Search, stringResource(R.string.no_results), null, null) }
            if (result.artists.isNotEmpty()) {
                item { ListHeader { Text(stringResource(R.string.section_artists)) } }
                items(result.artists, key = { "ar-" + it.id }) { artist ->
                    MediaRow(graph, artist.coverId, artist.name, null, onClick = { onArtist(artist) })
                }
            }
            if (result.albums.isNotEmpty()) {
                item { ListHeader { Text(stringResource(R.string.section_albums)) } }
                items(result.albums, key = { "al-" + it.id }) { album ->
                    MediaRow(graph, album.coverId, album.name, albumsLine(album.artist, album.year), onClick = { onAlbum(album) })
                }
            }
            if (result.tracks.isNotEmpty()) {
                item { ListHeader { Text(stringResource(R.string.section_tracks)) } }
                items(result.tracks, key = { "so-" + it.id }) { track ->
                    MediaRow(graph, track.coverId, track.title, trackLine(track), onClick = { onPlay(track) }, onLongClick = { onMore(track) })
                }
            }
        }
    }
}

@Composable
fun SearchRoute(graph: WatchGraph, onArtist: (ArtistEntity) -> Unit, onAlbum: (AlbumEntity) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var result by remember { mutableStateOf<LibrarySearchResult?>(null) }
    var searching by remember { mutableStateOf(false) }
    var more by remember { mutableStateOf<TrackEntity?>(null) }
    val sender = rememberMediaSender(graph)
    val label = stringResource(R.string.search_hint)

    val keyboard = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { activityResult ->
        if (activityResult.resultCode == Activity.RESULT_OK) {
            val typed = RemoteInput.getResultsFromIntent(activityResult.data ?: Intent())?.getCharSequence(QUERY_KEY)?.toString()
            if (!typed.isNullOrBlank()) query = typed.trim()
        }
    }
    fun openKeyboard() {
        val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
        RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(RemoteInput.Builder(QUERY_KEY).setLabel(label).build()))
        keyboard.launch(intent)
    }

    // The query only changes when the keyboard (or the voice input) hands back a whole one, so each change is one request.
    LaunchedEffect(query) {
        if (query.isBlank()) {
            result = null
            return@LaunchedEffect
        }
        searching = true
        result = graph.library.search(query)
        searching = false
    }

    SearchContent(
        graph = graph,
        query = query,
        result = result,
        searching = searching,
        onEdit = ::openKeyboard,
        onArtist = onArtist,
        onAlbum = onAlbum,
        onPlay = { track -> if (track.albumId != null) sender.playAlbum(track.albumId!!, songId = track.id) else sender.playSong(track.id, PlayMode.NOW) },
        onMore = { more = it }
    )
    TrackActionsDialog(
        track = more,
        onDismiss = { more = null },
        onNow = { more?.let { track -> if (track.albumId != null) sender.playAlbum(track.albumId!!, songId = track.id) else sender.playSong(track.id, PlayMode.NOW) } },
        onNext = { more?.let { sender.playSong(it.id, PlayMode.NEXT) } },
        onLast = { more?.let { sender.playSong(it.id, PlayMode.LAST) } }
    )
    sender.Host()
}
