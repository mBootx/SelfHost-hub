package com.selfhosthub.wear.ui.nowplaying

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.selfhosthub.wear.ui.theme.WatchColors

/**
 * The progress of the song, which can be touched: a tap jumps there, a drag moves a handle and the position is
 * sent when the finger lifts (not on every pixel of the way, which would flood the PC). While the finger is down
 * the bar shows where it would go and reports it through `onPreview`, so the time label can follow.
 */
@Composable
fun SeekBar(
    progress: Float,
    enabled: Boolean,
    contentDescription: String,
    modifier: Modifier = Modifier,
    onPreview: (Float?) -> Unit = {},
    onSeek: (Float) -> Unit
) {
    // The gesture handlers below live as long as `enabled` does; the callbacks change with every song (its length).
    val currentOnSeek by rememberUpdatedState(onSeek)
    val currentOnPreview by rememberUpdatedState(onPreview)
    var width by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf<Float?>(null) }
    val shown = (dragging ?: progress).coerceIn(0f, 1f)
    val thumbRadius = with(LocalDensity.current) { (if (dragging != null) 7.dp else 5.dp).toPx() }
    val trackHeight = with(LocalDensity.current) { 4.dp.toPx() }

    Box(
        modifier
            .height(28.dp)
            .semantics {
                this.contentDescription = contentDescription
                progressBarRangeInfo = ProgressBarRangeInfo(shown, 0f..1f)
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures { offset -> currentOnSeek(ControlMath.fractionAt(offset.x, size.width.toFloat())) }
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectDragGestures(
                    onDragStart = { offset ->
                        val f = ControlMath.fractionAt(offset.x, size.width.toFloat())
                        dragging = f
                        currentOnPreview(f)
                    },
                    onDragEnd = {
                        dragging?.let(currentOnSeek)
                        dragging = null
                        currentOnPreview(null)
                    },
                    onDragCancel = {
                        dragging = null
                        currentOnPreview(null)
                    }
                ) { change, _ ->
                    change.consume()
                    val f = ControlMath.fractionAt(change.position.x, size.width.toFloat())
                    dragging = f
                    currentOnPreview(f)
                }
            },
        contentAlignment = Alignment.Center
    ) {
        Canvas(Modifier.fillMaxSize()) {
            width = size.width
            val y = size.height / 2
            val left = thumbRadius
            val right = size.width - thumbRadius
            val trackWidth = (right - left).coerceAtLeast(1f)
            drawRoundRect(Color(0xFF3A3A3A), Offset(left, y - trackHeight / 2), Size(trackWidth, trackHeight), CornerRadius(trackHeight / 2))
            val x = left + trackWidth * shown
            if (x > left) drawRoundRect(WatchColors.Accent, Offset(left, y - trackHeight / 2), Size(x - left, trackHeight), CornerRadius(trackHeight / 2))
            if (enabled) drawCircle(Color.White, thumbRadius, Offset(x, y))
        }
    }
}
