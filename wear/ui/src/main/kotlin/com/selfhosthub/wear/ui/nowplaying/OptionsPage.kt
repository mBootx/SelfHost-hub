package com.selfhosthub.wear.ui.nowplaying

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListAnchorType
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.dialog.Alert
import androidx.wear.compose.material.dialog.Dialog
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.ui.theme.WatchColors

/** The second page of Now Playing: shuffle, like and repeat, the volume, which player is controlled, and the way to the rest of the app. */
@Composable
internal fun OptionsPage(ui: NowPlayingUi, actions: NowPlayingActions, liked: Boolean = false) {
    val haptics = rememberHaptics()
    var sleepDialog by remember { mutableStateOf(false) }

    ScalingLazyColumn(
        state = rememberScalingLazyListState(),
        modifier = Modifier.fillMaxWidth(),
        anchorType = ScalingLazyListAnchorType.ItemStart,
        verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.Top),
        horizontalAlignment = Alignment.CenterHorizontally,
        contentPadding = PaddingValues(top = 34.dp, bottom = 34.dp, start = 12.dp, end = 12.dp)
    ) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                ToggleIconButton(R.drawable.ic_spotify_shuffle, stringResource(R.string.shuffle), active = ui.shuffle) {
                    haptics.tap()
                    actions.onShuffle()
                }
                ToggleIconButton(
                    if (liked) R.drawable.ic_spotify_heart else R.drawable.ic_spotify_heart_outline,
                    stringResource(if (liked) R.string.liked else R.string.like),
                    active = liked,
                    enabled = ui.songId != null
                ) {
                    actions.onLike()
                }
                ToggleIconButton(
                    if (ui.repeat == RepeatMode.ONE) R.drawable.ic_spotify_repeat_one else R.drawable.ic_spotify_repeat,
                    stringResource(
                        when (ui.repeat) {
                            RepeatMode.OFF -> R.string.repeat_off
                            RepeatMode.ALL -> R.string.repeat_all
                            RepeatMode.ONE -> R.string.repeat_one
                        }
                    ),
                    active = ui.repeat != RepeatMode.OFF
                ) {
                    haptics.tap()
                    actions.onRepeat()
                }
            }
        }
        item {
            OptionChip(volumeIconRes(ui.volume), stringResource(R.string.volume), stringResource(R.string.volume_percent, ControlMath.volumePercent(ui.volume))) {
                haptics.tap()
                actions.onVolume()
            }
        }
        item {
            OptionChip(R.drawable.ic_spotify_devices, stringResource(R.string.devices), ui.playerName ?: stringResource(R.string.automatic_hint)) {
                haptics.tap()
                actions.onDevices()
            }
        }
        item {
            OptionChip(
                R.drawable.ic_spotify_queue,
                stringResource(R.string.queue),
                if (ui.upNext.isNotEmpty()) pluralStringResource(R.plurals.songs_count, ui.upNext.size, ui.upNext.size) else null
            ) {
                haptics.tap()
                actions.onQueue()
            }
        }
        if (ui.hasSong) {
            item {
                OptionChip(R.drawable.ic_spotify_lyrics, stringResource(R.string.lyrics), null) {
                    haptics.tap()
                    actions.onLyrics()
                }
            }
        }
        if (ui.songId != null) {
            item {
                OptionChip(R.drawable.ic_spotify_radio, stringResource(R.string.start_radio), null) {
                    haptics.confirm()
                    actions.onRadio()
                }
            }
        }
        item {
            OptionChip(R.drawable.ic_spotify_timer, stringResource(R.string.sleep_timer), null) {
                haptics.tap()
                sleepDialog = true
            }
        }
        item {
            OptionChip(R.drawable.ic_spotify_library, stringResource(R.string.library), null) {
                haptics.tap()
                actions.onLibrary()
            }
        }
        item {
            OptionChip(R.drawable.ic_spotify_settings, stringResource(R.string.settings), null) {
                haptics.tap()
                actions.onSettings()
            }
        }
    }

    Dialog(showDialog = sleepDialog, onDismissRequest = { sleepDialog = false }) {
        Alert(title = { Text(stringResource(R.string.sleep_timer)) }) {
            for (minutes in listOf(15, 30, 45, 60)) {
                item {
                    OptionChip(R.drawable.ic_spotify_timer, stringResource(R.string.sleep_timer_minutes, minutes), null) {
                        haptics.confirm()
                        actions.onSleepTimer(minutes)
                        sleepDialog = false
                    }
                }
            }
            item {
                OptionChip(R.drawable.ic_spotify_timer, stringResource(R.string.sleep_timer_end_of_track), null) {
                    haptics.confirm()
                    actions.onSleepTimer(-1)
                    sleepDialog = false
                }
            }
            item {
                OptionChip(R.drawable.ic_spotify_volume_off, stringResource(R.string.sleep_timer_off), null) {
                    haptics.tap()
                    actions.onSleepTimer(0)
                    sleepDialog = false
                }
            }
        }
    }
}

@Composable
private fun ToggleIconButton(@DrawableRes iconRes: Int, description: String, active: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.size(42.dp),
        colors = if (active) {
            ButtonDefaults.primaryButtonColors()
        } else {
            ButtonDefaults.buttonColors(
                backgroundColor = Color.White.copy(alpha = 0.14f),
                contentColor = WatchColors.OnSurface,
                disabledBackgroundColor = Color.White.copy(alpha = 0.06f),
                disabledContentColor = WatchColors.OnSurfaceMuted
            )
        },
        shape = CircleShape
    ) {
        Icon(
            painter = painterResource(iconRes),
            contentDescription = description,
            modifier = Modifier.size(20.dp),
            tint = if (active) MaterialTheme.colors.onPrimary else if (enabled) WatchColors.OnSurface else WatchColors.OnSurfaceMuted
        )
    }
}

@Composable
private fun OptionChip(@DrawableRes iconRes: Int, label: String, secondary: String?, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        label = { Text(label, maxLines = 1, fontWeight = FontWeight.Medium) },
        secondaryLabel = secondary?.let { { Text(it, maxLines = 1, color = MaterialTheme.colors.onSurfaceVariant) } },
        icon = {
            Box(
                Modifier
                    .size(30.dp)
                    .background(Color.White.copy(alpha = 0.10f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    painter = painterResource(iconRes),
                    contentDescription = null,
                    modifier = Modifier.size(17.dp),
                    tint = MaterialTheme.colors.primary
                )
            }
        },
        colors = ChipDefaults.chipColors(
            backgroundColor = Color(0xFF1A1B1E).copy(alpha = 0.86f),
            contentColor = WatchColors.OnSurface,
            secondaryContentColor = MaterialTheme.colors.onSurfaceVariant
        ),
        modifier = Modifier.fillMaxWidth().height(if (secondary != null) 52.dp else 46.dp)
    )
}
