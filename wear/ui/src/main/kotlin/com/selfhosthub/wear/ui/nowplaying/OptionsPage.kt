package com.selfhosthub.wear.ui.nowplaying

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeDown
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
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
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.ui.theme.WatchColors

/** The second page of Now Playing: shuffle and repeat, the volume, which player is controlled, and the way to the rest of the app. */
@Composable
internal fun OptionsPage(ui: NowPlayingUi, actions: NowPlayingActions) {
    val haptics = rememberHaptics()
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
                ToggleIconButton(Icons.Filled.Shuffle, stringResource(R.string.shuffle), active = ui.shuffle) {
                    haptics.tap()
                    actions.onShuffle()
                }
                ToggleIconButton(
                    if (ui.repeat == RepeatMode.ONE) Icons.Filled.RepeatOne else Icons.Filled.Repeat,
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
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                ToggleIconButton(Icons.AutoMirrored.Filled.VolumeDown, stringResource(R.string.volume), active = false) {
                    haptics.tick()
                    actions.onVolumeStep(-1)
                }
                Text(
                    stringResource(R.string.volume_percent, ControlMath.volumePercent(ui.volume)),
                    style = MaterialTheme.typography.title3,
                    modifier = Modifier.size(width = 56.dp, height = 24.dp),
                    maxLines = 1
                )
                ToggleIconButton(Icons.AutoMirrored.Filled.VolumeUp, stringResource(R.string.volume), active = false) {
                    haptics.tick()
                    actions.onVolumeStep(1)
                }
            }
        }
        item {
            OptionChip(Icons.Filled.Devices, stringResource(R.string.devices), ui.playerName ?: stringResource(R.string.automatic_hint)) {
                haptics.tap()
                actions.onDevices()
            }
        }
        item {
            OptionChip(Icons.Filled.LibraryMusic, stringResource(R.string.library), null) {
                haptics.tap()
                actions.onLibrary()
            }
        }
        item {
            OptionChip(Icons.Filled.Settings, stringResource(R.string.settings), null) {
                haptics.tap()
                actions.onSettings()
            }
        }
    }
}

@Composable
private fun ToggleIconButton(icon: ImageVector, description: String, active: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.size(42.dp),
        colors = if (active) ButtonDefaults.primaryButtonColors() else ButtonDefaults.secondaryButtonColors(),
        shape = CircleShape
    ) {
        Icon(icon, contentDescription = description, modifier = Modifier.size(22.dp), tint = if (active) Color.Black else WatchColors.OnSurface)
    }
}

@Composable
private fun OptionChip(icon: ImageVector, label: String, secondary: String?, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        label = { Text(label, maxLines = 1) },
        secondaryLabel = secondary?.let { { Text(it, maxLines = 1) } },
        icon = { Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp)) },
        colors = ChipDefaults.secondaryChipColors(),
        modifier = Modifier.fillMaxWidth().height(if (secondary != null) 52.dp else 44.dp)
    )
}
