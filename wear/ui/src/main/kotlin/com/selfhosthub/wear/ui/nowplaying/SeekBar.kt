package com.selfhosthub.wear.ui.nowplaying

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import androidx.wear.compose.material.MaterialTheme

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
    var dragging by remember { mutableStateOf<Float?>(null) }
    val shown = (dragging ?: progress).coerceIn(0f, 1f)
    val thumbRadius = with(LocalDensity.current) { (if (dragging != null) 7.dp else 5.dp).toPx() }
    val trackHeight = with(LocalDensity.current) { 4.dp.toPx() }
    // The cover's colour when the player has one (see CoverTheme).
    val accent = MaterialTheme.colors.primary

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
            val y = size.height / 2
            val left = thumbRadius
            val right = size.width - thumbRadius
            val trackWidth = (right - left).coerceAtLeast(1f)
            drawRoundRect(Color(0xFF3A3A3A), Offset(left, y - trackHeight / 2), Size(trackWidth, trackHeight), CornerRadius(trackHeight / 2))
            val x = left + trackWidth * shown
            if (x > left) drawRoundRect(accent, Offset(left, y - trackHeight / 2), Size(x - left, trackHeight), CornerRadius(trackHeight / 2))
            if (enabled) drawCircle(Color.White, thumbRadius, Offset(x, y))
        }
    }
}

/**
 * A circular time slider surrounding the center play/pause button (Spotify-style):
 * draws a circular progress arc around the center content and detects scrub gestures around the ring.
 */
@Composable
fun CircularSeekBar(
    progress: Float,
    enabled: Boolean,
    contentDescription: String,
    modifier: Modifier = Modifier,
    strokeWidth: androidx.compose.ui.unit.Dp = 3.5.dp,
    onPreview: (Float?) -> Unit = {},
    onSeek: (Float) -> Unit,
    content: @Composable () -> Unit
) {
    val currentOnSeek by rememberUpdatedState(onSeek)
    val currentOnPreview by rememberUpdatedState(onPreview)
    var dragging by remember { mutableStateOf<Float?>(null) }
    val shown = (dragging ?: progress).coerceIn(0f, 1f)
    val accent = MaterialTheme.colors.primary
    val density = LocalDensity.current

    Box(
        modifier = modifier
            .semantics {
                this.contentDescription = contentDescription
                progressBarRangeInfo = ProgressBarRangeInfo(shown, 0f..1f)
            },
        contentAlignment = Alignment.Center
    ) {
        Canvas(
            Modifier
                .fillMaxSize()
                .pointerInput(enabled) {
                    if (!enabled) return@pointerInput
                    detectTapGestures { offset ->
                        val cx = size.width / 2f
                        val cy = size.height / 2f
                        val dx = offset.x - cx
                        val dy = offset.y - cy
                        val dist = kotlin.math.hypot(dx, dy)
                        val strokePx = with(density) { strokeWidth.toPx() }
                        val ringRadius = (minOf(size.width, size.height) - strokePx) / 2f
                        if (dist >= ringRadius - with(density) { 10.dp.toPx() }) {
                            val angle = (ControlMath.angleOf(dx, dy) + 90f + 360f) % 360f
                            val f = (angle / 360f).coerceIn(0f, 1f)
                            currentOnSeek(f)
                        }
                    }
                }
                .pointerInput(enabled) {
                    if (!enabled) return@pointerInput
                    detectDragGestures(
                        onDragStart = { offset ->
                            val cx = size.width / 2f
                            val cy = size.height / 2f
                            val dx = offset.x - cx
                            val dy = offset.y - cy
                            val dist = kotlin.math.hypot(dx, dy)
                            val strokePx = with(density) { strokeWidth.toPx() }
                            val ringRadius = (minOf(size.width, size.height) - strokePx) / 2f
                            if (dist >= ringRadius - with(density) { 10.dp.toPx() }) {
                                val angle = (ControlMath.angleOf(dx, dy) + 90f + 360f) % 360f
                                val f = (angle / 360f).coerceIn(0f, 1f)
                                dragging = f
                                currentOnPreview(f)
                            }
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
                        if (dragging != null) {
                            change.consume()
                            val cx = size.width / 2f
                            val cy = size.height / 2f
                            val dx = change.position.x - cx
                            val dy = change.position.y - cy
                            val angle = (ControlMath.angleOf(dx, dy) + 90f + 360f) % 360f
                            val f = (angle / 360f).coerceIn(0f, 1f)
                            dragging = f
                            currentOnPreview(f)
                        }
                    }
                }
        ) {
            val strokePx = strokeWidth.toPx()
            val diameter = minOf(size.width, size.height) - strokePx
            val topLeft = Offset((size.width - diameter) / 2f, (size.height - diameter) / 2f)
            val arcSize = Size(diameter, diameter)
            val ringRadius = diameter / 2f
            val cx = size.width / 2f
            val cy = size.height / 2f

            // Full circular track (subtle translucent ring)
            drawArc(
                color = Color.White.copy(alpha = 0.22f),
                startAngle = -90f,
                sweepAngle = 360f,
                useCenter = false,
                topLeft = topLeft,
                size = arcSize,
                style = androidx.compose.ui.graphics.drawscope.Stroke(
                    width = strokePx,
                    cap = androidx.compose.ui.graphics.StrokeCap.Round
                )
            )

            // Elapsed time progress arc
            if (shown > 0f) {
                drawArc(
                    color = accent,
                    startAngle = -90f,
                    sweepAngle = shown * 360f,
                    useCenter = false,
                    topLeft = topLeft,
                    size = arcSize,
                    style = androidx.compose.ui.graphics.drawscope.Stroke(
                        width = strokePx,
                        cap = androidx.compose.ui.graphics.StrokeCap.Round
                    )
                )

                // Thumb dot at the head of the progress arc
                if (enabled) {
                    val rad = Math.toRadians((-90f + shown * 360f).toDouble())
                    val thumbX = (cx + ringRadius * kotlin.math.cos(rad)).toFloat()
                    val thumbY = (cy + ringRadius * kotlin.math.sin(rad)).toFloat()
                    val thumbR = if (dragging != null) strokePx * 1.5f else strokePx * 1.0f
                    drawCircle(Color.White, radius = thumbR, center = Offset(thumbX, thumbY))
                }
            }
        }

        // Center content (Play/Pause transport button)
        content()
    }
}
