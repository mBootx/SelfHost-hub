package com.selfhosthub.wear.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sync
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.ToggleChip
import androidx.wear.compose.material.ToggleChipDefaults
import androidx.wear.compose.material.dialog.Alert
import androidx.wear.compose.material.dialog.Dialog
import com.selfhosthub.wear.core.PcLink
import com.selfhosthub.wear.core.PcState
import com.selfhosthub.wear.core.formatBytes
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.ArtworkMemory
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.ui.library.ListScreen
import com.selfhosthub.wear.ui.theme.WatchColors
import kotlinx.coroutines.launch

/** Everything the settings screen shows, already worked out. */
data class SettingsUi(
    val navidromeUser: String? = null,
    val navidromeHost: String? = null,
    val syncing: Boolean = false,
    val lastSyncAt: Long? = null,
    val syncError: String? = null,
    /** How the watch stands with the phone app, its only way to the players. */
    val phoneStatus: LinkStatus = LinkStatus.CONNECTING,
    val phoneName: String? = null,
    /** How the phone says it stands with the PC; null while it has not said. */
    val pc: PcLink? = null,
    val cacheBytes: Long = 0,
    val autoLaunch: Boolean = true,
    val versionName: String = ""
)

class SettingsActions(
    val onSync: () -> Unit,
    val onRetryPhone: () -> Unit,
    val onClearCache: () -> Unit,
    val onAutoLaunch: (Boolean) -> Unit,
    val onForget: () -> Unit
)

/** "à l'instant", "il y a 12 min", "il y a 3 h", "il y a 2 j". */
@Composable
fun agoText(at: Long?, now: Long): String {
    if (at == null) return stringResource(R.string.never_synced)
    val minutes = ((now - at).coerceAtLeast(0) / 60_000).toInt()
    val text = when {
        minutes < 1 -> stringResource(R.string.ago_now)
        minutes < 60 -> stringResource(R.string.ago_minutes, minutes)
        minutes < 24 * 60 -> stringResource(R.string.ago_hours, minutes / 60)
        else -> stringResource(R.string.ago_days, minutes / (24 * 60))
    }
    return text
}

@Composable
fun SettingsContent(ui: SettingsUi, now: Long, actions: SettingsActions) {
    val haptics = rememberHaptics()
    var confirm by remember { mutableStateOf<Confirm?>(null) }

    ListScreen(stringResource(R.string.settings)) {
        // --- Navidrome ---
        item {
            InfoCard(
                stringResource(R.string.navidrome),
                if (ui.navidromeUser != null) "${ui.navidromeUser} · ${ui.navidromeHost.orEmpty()}" else stringResource(R.string.not_configured)
            )
        }
        if (ui.navidromeUser != null) {
            item {
                Text(
                    if (ui.syncing) stringResource(R.string.syncing) else stringResource(R.string.last_sync, agoText(ui.lastSyncAt, now)),
                    style = MaterialTheme.typography.caption3,
                    color = WatchColors.OnSurfaceMuted,
                    textAlign = TextAlign.Center
                )
            }
            if (ui.syncError != null) {
                item {
                    Text(
                        stringResource(R.string.sync_failed, ui.syncError),
                        style = MaterialTheme.typography.caption3,
                        color = WatchColors.Warning,
                        textAlign = TextAlign.Center
                    )
                }
            }
            item {
                ActionChip(Icons.Filled.Sync, stringResource(if (ui.syncing) R.string.syncing else R.string.sync_now), enabled = !ui.syncing) {
                    haptics.confirm()
                    actions.onSync()
                }
            }
        }

        // --- The phone, which is the watch's only way to the players ---
        item {
            InfoCard(
                stringResource(R.string.phone),
                when (ui.phoneStatus) {
                    LinkStatus.CONNECTED -> ui.phoneName?.let { "${stringResource(R.string.status_connected)} · $it" } ?: stringResource(R.string.status_connected)
                    LinkStatus.CONNECTING -> stringResource(R.string.status_connecting)
                    else -> ui.phoneStatus.message ?: stringResource(R.string.status_disconnected)
                }
            )
        }
        if (ui.phoneStatus != LinkStatus.CONNECTED) {
            item {
                ActionChip(Icons.Filled.Refresh, stringResource(R.string.retry)) {
                    haptics.tap()
                    actions.onRetryPhone()
                }
            }
        }

        // --- The PC, as the phone reaches it ---
        if (ui.phoneStatus == LinkStatus.CONNECTED && ui.pc != null) {
            item {
                InfoCard(
                    stringResource(R.string.pc),
                    when (ui.pc.state) {
                        PcState.CONNECTED -> ui.pc.name?.let { "${stringResource(R.string.pc_connected)} · $it" } ?: stringResource(R.string.pc_connected)
                        PcState.CONNECTING -> stringResource(R.string.status_connecting)
                        PcState.DISCONNECTED -> stringResource(R.string.pc_disconnected)
                        PcState.OFF -> stringResource(R.string.pc_off)
                        PcState.UNPAIRED -> stringResource(R.string.pc_unpaired)
                        PcState.ERROR -> ui.pc.message ?: stringResource(R.string.pc_error)
                    }
                )
            }
        }

        // --- Behaviour ---
        item {
            SwitchChip(stringResource(R.string.auto_launch), stringResource(R.string.auto_launch_hint), ui.autoLaunch) {
                haptics.tap()
                actions.onAutoLaunch(it)
            }
        }

        // --- Storage ---
        item { InfoCard(stringResource(R.string.cache), stringResource(R.string.cache_size, formatBytes(ui.cacheBytes))) }
        item {
            ActionChip(Icons.Filled.DeleteSweep, stringResource(R.string.clear_cache)) {
                haptics.tap()
                confirm = Confirm.ClearCache
            }
        }
        item {
            ActionChip(Icons.Filled.Delete, stringResource(R.string.forget_setup), danger = true) {
                haptics.tap()
                confirm = Confirm.Forget
            }
        }
        if (ui.versionName.isNotEmpty()) {
            item {
                ListHeader { Text(stringResource(R.string.version, ui.versionName), style = MaterialTheme.typography.caption3, color = WatchColors.OnSurfaceMuted) }
            }
        }
    }

    val pending = confirm
    Dialog(showDialog = pending != null, onDismissRequest = { confirm = null }) {
        Alert(
            title = { Text(stringResource(if (pending == Confirm.Forget) R.string.forget_setup else R.string.clear_cache), textAlign = TextAlign.Center) },
            negativeButton = {
                Button(onClick = { confirm = null }, colors = ButtonDefaults.secondaryButtonColors()) {
                    Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.cancel))
                }
            },
            positiveButton = {
                Button(
                    onClick = {
                        when (pending) {
                            Confirm.Forget -> actions.onForget()
                            Confirm.ClearCache -> actions.onClearCache()
                            null -> Unit
                        }
                        confirm = null
                    }
                ) {
                    Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.confirm))
                }
            }
        ) {
            Text(
                stringResource(if (pending == Confirm.Forget) R.string.forget_setup_confirm else R.string.clear_cache_confirm),
                style = MaterialTheme.typography.body2,
                textAlign = TextAlign.Center
            )
        }
    }
}

private enum class Confirm { ClearCache, Forget }

@Composable
private fun InfoCard(title: String, text: String) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.caption1, color = WatchColors.Accent, textAlign = TextAlign.Center)
        Text(text, style = MaterialTheme.typography.body2, textAlign = TextAlign.Center, color = WatchColors.OnSurface, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun ActionChip(icon: ImageVector, label: String, enabled: Boolean = true, danger: Boolean = false, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        enabled = enabled,
        label = { Text(label, maxLines = 1) },
        icon = { Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = if (danger) WatchColors.Danger else WatchColors.OnSurface) },
        colors = ChipDefaults.secondaryChipColors(),
        modifier = Modifier.fillMaxWidth().height(44.dp)
    )
}

@Composable
private fun SwitchChip(label: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    ToggleChip(
        checked = checked,
        onCheckedChange = onChange,
        label = { Text(label, maxLines = 1) },
        secondaryLabel = { Text(hint, maxLines = 2) },
        toggleControl = { Icon(imageVector = ToggleChipDefaults.switchIcon(checked), contentDescription = null) },
        modifier = Modifier.fillMaxWidth()
    )
}

@Composable
fun SettingsRoute(graph: WatchGraph, versionName: String, onForgotten: () -> Unit) {
    val setup by graph.setup.collectAsStateWithLifecycle()
    val sync by graph.sync.state.collectAsStateWithLifecycle()
    val link by graph.link.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var cacheBytes by remember { mutableLongStateOf(0) }
    var autoLaunch by remember { mutableStateOf(graph.prefs.autoLaunch) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }

    LaunchedEffect(sync.running, sync.lastSuccessAt) {
        cacheBytes = graph.artwork.cacheBytes()
        now = System.currentTimeMillis()
    }

    val navidrome = setup?.navidrome
    val ui = SettingsUi(
        navidromeUser = navidrome?.username,
        navidromeHost = navidrome?.baseUrl?.substringAfter("://")?.substringBefore('/'),
        syncing = sync.running,
        lastSyncAt = sync.lastSuccessAt,
        syncError = sync.lastError,
        phoneStatus = link.status,
        phoneName = link.phoneName,
        pc = link.pc,
        cacheBytes = cacheBytes,
        autoLaunch = autoLaunch,
        versionName = versionName
    )
    SettingsContent(
        ui,
        now,
        SettingsActions(
            onSync = { scope.launch { graph.sync.run(force = true) } },
            onRetryPhone = { graph.link.refresh() },
            onClearCache = {
                scope.launch {
                    graph.clearCache()
                    ArtworkMemory.clear()
                    cacheBytes = graph.artwork.cacheBytes()
                }
            },
            onAutoLaunch = { on ->
                autoLaunch = on
                graph.prefs.autoLaunch = on
            },
            onForget = {
                scope.launch {
                    graph.reset()
                    ArtworkMemory.clear()
                    onForgotten()
                }
            }
        )
    )
}
