package com.selfhosthub.wear.ui.library

import android.content.Context
import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.dialog.Alert
import androidx.wear.compose.material.dialog.Confirmation
import androidx.wear.compose.material.dialog.Dialog
import com.selfhosthub.wear.core.MediaKind
import com.selfhosthub.wear.core.PlayMode
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.Haptics
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.data.db.TrackEntity
import com.selfhosthub.wear.ui.theme.WatchColors

/**
 * Asks the phone to play something. Nothing is played on the watch: the album, playlist or song is named, and the
 * phone looks it up in its own Navidrome and plays it itself, whichever player the watch was showing (the PC cannot be
 * asked to play from the library). The answer shown is "sent", which is all the watch can know; if the phone does not
 * seem to be there the message says so, and the request is still handed to the data layer.
 */
class MediaSender(private val graph: WatchGraph, private val context: Context, private val haptics: Haptics) {
    /** The confirmation on screen, if any. */
    var message by mutableStateOf<String?>(null)
        private set

    fun playAlbum(albumId: String, songId: String? = null, mode: PlayMode = PlayMode.NOW) =
        send(PlayerCommand.PlayMedia(MediaKind.ALBUM, albumId, songId = songId, mode = mode))

    fun playPlaylist(playlistId: String, songId: String? = null, mode: PlayMode = PlayMode.NOW) =
        send(PlayerCommand.PlayMedia(MediaKind.PLAYLIST, playlistId, songId = songId, mode = mode))

    fun playSong(songId: String, mode: PlayMode) = send(PlayerCommand.PlayMedia(MediaKind.SONG, songId, mode = mode))

    fun playFavorites(songId: String? = null, mode: PlayMode = PlayMode.NOW) =
        send(PlayerCommand.PlayMedia(MediaKind.FAVORITES, "all", songId = songId, mode = mode))

    fun playShuffleAll() = send(PlayerCommand.PlayMedia(MediaKind.SHUFFLE_ALL, "all", mode = PlayMode.NOW))

    fun startRadio(songId: String) = send(PlayerCommand.PlayMedia(MediaKind.RADIO, songId, mode = PlayMode.NOW))

    private fun send(command: PlayerCommand.PlayMedia) {
        val reachable = graph.link.send(command)
        haptics.confirm()
        message = context.getString(if (reachable) R.string.sent_to_phone else R.string.phone_unreachable)
    }

    fun dismiss() {
        message = null
    }

    /** The "sent" confirmation, to be placed anywhere inside the screen that uses this sender. */
    @Composable
    fun Host() {
        val text = message
        Dialog(showDialog = text != null, onDismissRequest = { dismiss() }) {
            Confirmation(
                onTimeout = { dismiss() },
                icon = { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(32.dp)) },
                durationMillis = 1_400
            ) {
                Text(text.orEmpty(), maxLines = 3)
            }
        }
    }
}

@Composable
fun rememberMediaSender(graph: WatchGraph): MediaSender {
    val context = LocalContext.current
    val haptics = rememberHaptics()
    return remember(graph, context, haptics) { MediaSender(graph, context, haptics) }
}

/** The ways to play a song: right away (from its album or playlist), after the current one, at the end of the queue, or as a song radio. */
@Composable
fun TrackActionsDialog(
    track: TrackEntity?,
    onDismiss: () -> Unit,
    onNow: () -> Unit,
    onNext: () -> Unit,
    onLast: () -> Unit,
    onRadio: (() -> Unit)? = null
) {
    Dialog(showDialog = track != null, onDismissRequest = onDismiss) {
        Alert(title = { Text(track?.title.orEmpty(), maxLines = 2) }) {
            item { ActionChip(R.drawable.ic_spotify_play, stringResource(R.string.play_now), primary = true) { onNow(); onDismiss() } }
            item { ActionChip(R.drawable.ic_spotify_next, stringResource(R.string.play_next)) { onNext(); onDismiss() } }
            item { ActionChip(R.drawable.ic_spotify_playlists, stringResource(R.string.add_to_queue)) { onLast(); onDismiss() } }
            if (onRadio != null) {
                item { ActionChip(R.drawable.ic_spotify_radio, stringResource(R.string.start_radio)) { onRadio(); onDismiss() } }
            }
        }
    }
}

@Composable
private fun ActionChip(@DrawableRes iconRes: Int, label: String, primary: Boolean = false, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        label = { Text(label, maxLines = 1, fontWeight = FontWeight.Medium) },
        icon = {
            Icon(
                painter = painterResource(iconRes),
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = if (primary) Color.Black else WatchColors.Accent
            )
        },
        colors = if (primary) {
            ChipDefaults.primaryChipColors()
        } else {
            ChipDefaults.chipColors(
                backgroundColor = Color(0xFF18191C),
                contentColor = WatchColors.OnSurface
            )
        },
        modifier = Modifier.fillMaxWidth().height(44.dp)
    )
}
