package com.selfhosthub.wear.ui.devices

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.selfhosthub.wear.core.DeviceSummary
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.ui.library.ListScreen
import com.selfhosthub.wear.ui.library.Notice
import com.selfhosthub.wear.ui.theme.WatchColors

/**
 * Which player the controls act on, among the ones the phone lists: itself, and the PC and the other devices its link
 * to the PC shows. "Automatique" follows whichever one is playing, which is what you want when a song starts on the
 * phone and then on the PC; picking one by hand pins it until it leaves.
 */
@Composable
fun DevicesContent(state: LinkUiState, onSelect: (String?) -> Unit) {
    val haptics = rememberHaptics()
    val thisPhone = stringResource(R.string.this_phone)
    ListScreen(stringResource(R.string.devices)) {
        item {
            DeviceChip(R.drawable.ic_spotify_auto, stringResource(R.string.automatic), stringResource(R.string.automatic_hint), selected = state.manualTargetId == null) {
                haptics.confirm()
                onSelect(null)
            }
        }
        if (state.devices.isEmpty()) {
            item { Notice(Icons.Filled.Computer, stringResource(R.string.no_devices), null, null) }
        }
        items(state.devices, key = { it.deviceId }) { device ->
            val song = state.players[device.deviceId]?.state?.song
            DeviceChip(
                iconResFor(device),
                device.deviceName,
                song?.let { "${it.title} · ${it.artist}" } ?: if (device.deviceId == LinkProtocol.PHONE_ID) thisPhone else null,
                selected = state.manualTargetId == device.deviceId
            ) {
                haptics.confirm()
                onSelect(device.deviceId)
            }
        }
    }
}

@DrawableRes
private fun iconResFor(device: DeviceSummary): Int =
    if (device.platform == "desktop" || device.deviceId == LinkProtocol.HUB_ID) R.drawable.ic_spotify_desktop else R.drawable.ic_spotify_phone

@Composable
private fun DeviceChip(@DrawableRes iconRes: Int, label: String, secondary: String?, selected: Boolean, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        label = {
            Text(
                label,
                maxLines = 1,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium
            )
        },
        secondaryLabel = secondary?.let { { Text(it, maxLines = 1) } },
        icon = {
            Box(
                Modifier
                    .size(30.dp)
                    .background(
                        if (selected) Color.Black.copy(alpha = 0.16f) else WatchColors.Accent.copy(alpha = 0.14f),
                        CircleShape
                    ),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    painter = painterResource(iconRes),
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = if (selected) MaterialTheme.colors.onPrimary else WatchColors.Accent
                )
            }
        },
        colors = if (selected) {
            ChipDefaults.primaryChipColors()
        } else {
            ChipDefaults.chipColors(
                backgroundColor = Color(0xFF18191C),
                contentColor = WatchColors.OnSurface,
                secondaryContentColor = WatchColors.OnSurfaceMuted
            )
        },
        modifier = Modifier.fillMaxWidth().height(if (secondary != null) 52.dp else 46.dp)
    )
}

@Composable
fun DevicesRoute(graph: WatchGraph, onDone: () -> Unit) {
    val state by graph.link.state.collectAsStateWithLifecycle()
    DevicesContent(state) { id ->
        graph.link.selectTarget(id)
        onDone()
    }
}
