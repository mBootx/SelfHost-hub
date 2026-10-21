package com.selfhosthub.wear.ui.library

import android.app.Activity
import android.app.RemoteInput
import android.widget.Toast
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.HourglassTop
import androidx.compose.material.icons.filled.Search
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.Text
import androidx.wear.input.RemoteInputIntentHelper
import com.selfhosthub.wear.core.DowntifySong
import com.selfhosthub.wear.core.PlayMode
import com.selfhosthub.wear.core.formatClock
import com.selfhosthub.wear.data.LibrarySearchResult
import com.selfhosthub.wear.data.db.AlbumEntity
import com.selfhosthub.wear.data.db.ArtistEntity
import com.selfhosthub.wear.data.db.TrackEntity
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.link.DowntifySearch
import kotlinx.coroutines.launch
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.ui.theme.WatchColors

private const val QUERY_KEY = "query"

/** What the Downtify part of the search page is showing. */
sealed interface DowntifyUi {
    /** Not asked for yet: only the button is there. */
    data object Idle : DowntifyUi

    data object Searching : DowntifyUi

    data class Found(val songs: List<DowntifySong>) : DowntifyUi

    data class Failed(val message: String) : DowntifyUi
}

/** Where a song of the Downtify results stands once the watch asked for it. */
enum class AskedState { ASKING, ASKED, FAILED }

/**
 * The songs Downtify found, under the library's results: a button to look (Downtify is asked through the phone, so
 * only when wanted), then the songs. A tap asks the phone to have Downtify download one.
 */
private fun androidx.wear.compose.foundation.lazy.ScalingLazyListScope.downtifySection(
    query: String,
    state: DowntifyUi,
    asked: Map<String, AskedState>,
    onSearch: () -> Unit,
    onDownload: (DowntifySong) -> Unit,
    haptics: com.selfhosthub.wear.ui.common.Haptics
) {
    item { ListHeader { Text(stringResource(R.string.section_downtify)) } }
    when (state) {
        DowntifyUi.Idle -> item {
            Chip(
                onClick = { haptics.tap(); onSearch() },
                label = { Text(stringResource(R.string.downtify_search, query), maxLines = 1, fontWeight = FontWeight.Medium) },
                icon = {
                    Icon(
                        painter = painterResource(R.drawable.ic_spotify_download),
                        contentDescription = null,
                        modifier = Modifier.size(19.dp),
                        tint = WatchColors.Accent
                    )
                },
                colors = ChipDefaults.chipColors(
                    backgroundColor = Color(0xFF18191C),
                    contentColor = WatchColors.OnSurface
                ),
                modifier = Modifier.fillMaxWidth().height(46.dp)
            )
        }
        DowntifyUi.Searching -> item { Loading() }
        is DowntifyUi.Failed -> item { Notice(Icons.Filled.CloudOff, state.message, stringResource(R.string.retry), onSearch) }
        is DowntifyUi.Found -> {
            if (state.songs.isEmpty()) {
                item { Notice(Icons.Filled.Search, stringResource(R.string.downtify_none), null, null) }
            }
            items(state.songs, key = { "dt-" + it.id }) { song ->
                val status = asked[song.id]
                Chip(
                    onClick = { if (status == null || status == AskedState.FAILED) { haptics.confirm(); onDownload(song) } },
                    label = { Text(song.title, maxLines = 1, fontWeight = FontWeight.Medium) },
                    secondaryLabel = {
                        Text(
                            when (status) {
                                AskedState.ASKING -> stringResource(R.string.downtify_asking)
                                AskedState.ASKED -> stringResource(R.string.downtify_asked)
                                AskedState.FAILED -> stringResource(R.string.downtify_failed)
                                null -> listOfNotNull(song.artist.ifBlank { null }, song.duration.takeIf { it > 0 }?.let(::formatClock)).joinToString(" · ")
                            },
                            maxLines = 1
                        )
                    },
                    icon = {
                        when (status) {
                            AskedState.ASKING -> Icon(Icons.Filled.HourglassTop, contentDescription = null, modifier = Modifier.size(20.dp))
                            AskedState.ASKED -> Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(20.dp))
                            AskedState.FAILED -> Icon(Icons.Filled.ErrorOutline, contentDescription = null, modifier = Modifier.size(20.dp), tint = WatchColors.Danger)
                            null -> Icon(
                                painter = painterResource(R.drawable.ic_spotify_download),
                                contentDescription = null,
                                modifier = Modifier.size(19.dp),
                                tint = WatchColors.Accent
                            )
                        }
                    },
                    colors = if (status == AskedState.ASKED) {
                        ChipDefaults.primaryChipColors()
                    } else {
                        ChipDefaults.chipColors(
                            backgroundColor = Color(0xFF18191C),
                            contentColor = WatchColors.OnSurface,
                            secondaryContentColor = WatchColors.OnSurfaceMuted
                        )
                    },
                    modifier = Modifier.fillMaxWidth().height(52.dp)
                )
            }
        }
    }
}

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
    onMore: (TrackEntity) -> Unit,
    downtify: DowntifyUi? = null,
    asked: Map<String, AskedState> = emptyMap(),
    onDowntifySearch: () -> Unit = {},
    onDowntifyDownload: (DowntifySong) -> Unit = {}
) {
    val haptics = rememberHaptics()
    ListScreen(stringResource(R.string.search)) {
        item {
            Chip(
                onClick = { haptics.tap(); onEdit() },
                label = { Text(query.ifEmpty { stringResource(R.string.search_hint) }, maxLines = 1, fontWeight = FontWeight.Medium) },
                icon = {
                    Box(
                        Modifier
                            .size(28.dp)
                            .background(WatchColors.Accent.copy(alpha = 0.16f), CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.ic_spotify_search),
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = WatchColors.Accent
                        )
                    }
                },
                colors = ChipDefaults.chipColors(
                    backgroundColor = Color(0xFF18191C),
                    contentColor = WatchColors.OnSurface
                ),
                modifier = Modifier.fillMaxWidth().height(46.dp)
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
        // Whatever the library had (or did not), the song may still be worth getting from Downtify.
        if (downtify != null && query.isNotBlank() && !searching) {
            downtifySection(query, downtify, asked, onDowntifySearch, onDowntifyDownload, haptics)
        }
    }
}

@Composable
fun SearchRoute(graph: WatchGraph, onArtist: (ArtistEntity) -> Unit, onAlbum: (AlbumEntity) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var result by remember { mutableStateOf<LibrarySearchResult?>(null) }
    var searching by remember { mutableStateOf(false) }
    var more by remember { mutableStateOf<TrackEntity?>(null) }
    var downtify by remember { mutableStateOf<DowntifyUi>(DowntifyUi.Idle) }
    var asked by remember { mutableStateOf<Map<String, AskedState>>(emptyMap()) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
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
        // Another search: what Downtify said about the last one no longer applies.
        downtify = DowntifyUi.Idle
        asked = emptyMap()
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
        onPlay = { track ->
            val albumId = track.albumId
            if (albumId != null) sender.playAlbum(albumId, songId = track.id) else sender.playSong(track.id, PlayMode.NOW)
        },
        onMore = { more = it },
        downtify = downtify,
        asked = asked,
        onDowntifySearch = {
            val words = query
            downtify = DowntifyUi.Searching
            scope.launch {
                downtify = when (val outcome = graph.downtify.search(words)) {
                    is DowntifySearch.Found -> DowntifyUi.Found(outcome.songs)
                    is DowntifySearch.Failed -> DowntifyUi.Failed(outcome.message)
                }
            }
        },
        onDowntifyDownload = { song ->
            asked = asked + (song.id to AskedState.ASKING)
            scope.launch {
                val done = graph.downtify.download(song.id)
                asked = asked + (song.id to if (done.ok) AskedState.ASKED else AskedState.FAILED)
                Toast.makeText(context, if (done.ok) context.getString(R.string.downtify_toast_asked) else (done.message ?: context.getString(R.string.downtify_failed)), Toast.LENGTH_SHORT).show()
            }
        }
    )
    TrackActionsDialog(
        track = more,
        onDismiss = { more = null },
        onNow = {
            more?.let { track ->
                val albumId = track.albumId
                if (albumId != null) sender.playAlbum(albumId, songId = track.id) else sender.playSong(track.id, PlayMode.NOW)
            }
        },
        onNext = { more?.let { sender.playSong(it.id, PlayMode.NEXT) } },
        onLast = { more?.let { sender.playSong(it.id, PlayMode.LAST) } },
        onRadio = { more?.let { sender.startRadio(it.id) } }
    )
    sender.Host()
}
