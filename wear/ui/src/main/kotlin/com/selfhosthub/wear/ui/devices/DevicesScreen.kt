package com.selfhosthub.wear.ui.devices

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoMode
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.Text
import com.selfhosthub.wear.core.DeviceSummary
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.ui.library.ListScreen
import com.selfhosthub.wear.ui.library.Notice

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
            DeviceChip(Icons.Filled.AutoMode, stringResource(R.string.automatic), stringResource(R.string.automatic_hint), selected = state.manualTargetId == null) {
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
                iconFor(device),
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

private fun iconFor(device: DeviceSummary): ImageVector =
    if (device.platform == "desktop" || device.deviceId == LinkProtocol.HUB_ID) Icons.Filled.Computer else Icons.Filled.PhoneAndroid

@Composable
private fun DeviceChip(icon: ImageVector, label: String, secondary: String?, selected: Boolean, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        label = { Text(label, maxLines = 1) },
        secondaryLabel = secondary?.let { { Text(it, maxLines = 1) } },
        icon = { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)) },
        colors = if (selected) ChipDefaults.primaryChipColors() else ChipDefaults.secondaryChipColors(),
        modifier = Modifier.fillMaxWidth().height(if (secondary != null) 52.dp else 44.dp)
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
