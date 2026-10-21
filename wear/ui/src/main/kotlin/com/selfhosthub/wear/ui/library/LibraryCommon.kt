package com.selfhosthub.wear.ui.library

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.selfhosthub.wear.data.ArtworkSize
import com.selfhosthub.wear.data.LoadResult
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.CoverBox
import com.selfhosthub.wear.ui.theme.WatchColors
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** A list read from the watch's own storage, and whether something is still being fetched to fill it. */
class StoredList<T>(
    /** Null until the storage has answered once. */
    val items: List<T>?,
    val loading: Boolean,
    val error: String?,
    val retry: () -> Unit
)

/**
 * `flow` is what is stored (and keeps the screen up to date as the server's answers are written); `ensure`, when
 * given, asks the server for what is missing and says how it went. A failed `ensure` does not hide what is stored.
 */
@Composable
fun <T> rememberStoredList(key: Any?, flow: Flow<List<T>>, ensure: (suspend () -> LoadResult)? = null): StoredList<T> {
    val items by remember(flow) { flow.map<List<T>, List<T>?> { it } }.collectAsStateWithLifecycle(initialValue = null)
    var attempt by remember(key) { mutableIntStateOf(0) }
    var loading by remember(key) { mutableStateOf(ensure != null) }
    var error by remember(key) { mutableStateOf<String?>(null) }
    LaunchedEffect(key, attempt) {
        if (ensure == null) return@LaunchedEffect
        loading = true
        error = null
        val result = ensure()
        if (result is LoadResult.Unavailable) error = result.message
        loading = false
    }
    return StoredList(items, loading, error) { attempt++ }
}

/** The frame every list screen has: the clock, a title, the scroll indicator, the round-screen edge fade. */
@Composable
fun ListScreen(
    title: String,
    modifier: Modifier = Modifier,
    state: ScalingLazyListState = rememberScalingLazyListState(),
    content: ScalingLazyListScope.() -> Unit
) {
    Scaffold(
        modifier = modifier,
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(scalingLazyListState = state) }
    ) {
        ScalingLazyColumn(
            state = state,
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(5.dp, Alignment.Top)
        ) {
            item {
                ListHeader {
                    Text(
                        title,
                        maxLines = 1,
                        style = MaterialTheme.typography.title3.copy(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                        color = WatchColors.OnSurface
                    )
                }
            }
            content()
        }
    }
}

/** What a stored list shows besides its rows: a spinner, an empty message, or the reason the server did not answer. */
fun <T> ScalingLazyListScope.storedListStates(
    list: StoredList<T>,
    emptyTitle: String,
    emptyHint: String? = null,
    notice: String? = null
) {
    if (list.items == null || (list.items.isEmpty() && list.loading)) {
        item { Loading() }
        return
    }
    if (list.error != null) {
        item { Notice(Icons.Filled.CloudOff, stringResource(R.string.load_failed, list.error), stringResource(R.string.retry), list.retry) }
    } else if (notice != null) {
        item { Text(notice, style = MaterialTheme.typography.caption3, color = WatchColors.OnSurfaceMuted, textAlign = TextAlign.Center) }
    }
    if (list.items.isEmpty() && list.error == null) {
        item { Notice(Icons.Filled.LibraryMusic, emptyTitle, emptyHint, null) }
    }
}

@Composable
fun Loading(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator(Modifier.size(28.dp), indicatorColor = WatchColors.Accent, strokeWidth = 3.dp)
    }
}

@Composable
fun Notice(icon: ImageVector, title: String, hint: String?, onAction: (() -> Unit)?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(icon, contentDescription = null, tint = WatchColors.OnSurfaceMuted, modifier = Modifier.size(24.dp))
        Text(title, style = MaterialTheme.typography.caption1, textAlign = TextAlign.Center)
        if (hint != null && onAction == null) Text(hint, style = MaterialTheme.typography.caption3, color = WatchColors.OnSurfaceMuted, textAlign = TextAlign.Center)
        if (onAction != null && hint != null) {
            Chip(
                onClick = onAction,
                label = { Text(hint, maxLines = 1) },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth().height(36.dp).padding(top = 4.dp)
            )
        }
    }
}

/**
 * A press held on the row, for a screen that offers more than a tap. It watches the touch before the chip does
 * (PointerEventPass.Initial): the chip's own click takes every touch it is given, so a long-press detector placed
 * around it never saw one (the "more" actions could not be opened). A finger that moves is scrolling the list, not
 * holding a row; once the hold is recognised the rest of the touch is used up, so lifting the finger does not also
 * play the song.
 */
private fun Modifier.onHold(onHold: (() -> Unit)?, feedback: () -> Unit): Modifier =
    if (onHold == null) this
    else pointerInput(onHold) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val slop = viewConfiguration.touchSlop
            val ended = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                while (true) {
                    val change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: break
                    if (!change.pressed || (change.position - down.position).getDistance() > slop) break
                }
                true
            }
            if (ended == null) {
                feedback()
                onHold()
                do {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    event.changes.forEach { it.consume() }
                } while (event.changes.any { it.pressed })
            }
        }
    }

/** One row of a list: a cover, a title, a line under it. A long press opens more actions, when the screen has them. */
@Composable
fun MediaRow(
    graph: WatchGraph?,
    coverId: String?,
    title: String,
    subtitle: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null
) {
    val haptic = LocalHapticFeedback.current
    val longPress = Modifier.onHold(onLongClick) { haptic.performHapticFeedback(HapticFeedbackType.LongPress) }
    Chip(
        onClick = onClick,
        label = { Text(title, maxLines = 1, fontWeight = FontWeight.Medium) },
        secondaryLabel = subtitle?.let { { Text(it, maxLines = 1, color = WatchColors.OnSurfaceMuted) } },
        icon = { CoverBox(graph, coverId, ArtworkSize.THUMBNAIL, Modifier.size(34.dp), RoundedCornerShape(8.dp)) },
        colors = ChipDefaults.chipColors(
            backgroundColor = Color(0xFF18191C),
            contentColor = WatchColors.OnSurface,
            secondaryContentColor = WatchColors.OnSurfaceMuted
        ),
        modifier = modifier.fillMaxWidth().height(if (subtitle != null) 52.dp else 46.dp).then(longPress)
    )
}
