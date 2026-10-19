package com.selfhosthub.wear.ui.nowplaying

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.MaterialTheme
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlinx.coroutines.delay

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

/** How long a position that was just asked for stays on the ring while the PC has not yet said it got there. */
private const val SOUGHT_HOLD_MS = 1_500L

/** How far inside and outside the ring's stroke a touch still counts as on it (the stroke itself is thin for a finger). */
private val RING_GRAB_INSIDE = 12.dp
private val RING_GRAB_OUTSIDE = 8.dp

/**
 * A circular time slider around the play/pause button (Spotify's watch player): the elapsed part of the song is an
 * arc, and a touch on the ring jumps there, or a finger sliding round it moves the handle and the position is sent
 * when it lifts. Only the band of the ring takes touches: the button in the middle keeps its own, and a swipe that
 * starts anywhere else still changes the page. Going round past 12 o'clock stops at the end of the song rather than
 * jumping to its other end. The position asked for stays on the ring a moment after the finger lifts, so that it
 * does not snap back to the old one before the PC has moved.
 */
@Composable
fun CircularSeekBar(
    progress: Float,
    enabled: Boolean,
    contentDescription: String,
    modifier: Modifier = Modifier,
    strokeWidth: Dp = 3.5.dp,
    onPreview: (Float?) -> Unit = {},
    onSeek: (Float) -> Unit,
    content: @Composable () -> Unit
) {
    val currentOnSeek by rememberUpdatedState(onSeek)
    val currentOnPreview by rememberUpdatedState(onPreview)
    var dragging by remember { mutableStateOf<Float?>(null) }
    var sought by remember { mutableStateOf<Float?>(null) }
    val shown = (dragging ?: sought ?: progress).coerceIn(0f, 1f)
    val accent = MaterialTheme.colors.primary

    // The asked-for position goes once the song is there, or after a moment if it never gets there.
    LaunchedEffect(sought) {
        if (sought != null) {
            delay(SOUGHT_HOLD_MS)
            sought = null
            currentOnPreview(null)
        }
    }
    LaunchedEffect(progress) {
        val asked = sought
        if (asked != null && abs(progress - asked) < 0.03f) {
            sought = null
            currentOnPreview(null)
        }
    }

    Box(
        modifier = modifier.semantics {
            this.contentDescription = contentDescription
            progressBarRangeInfo = ProgressBarRangeInfo(shown, 0f..1f)
        },
        contentAlignment = Alignment.Center
    ) {
        Canvas(
            Modifier
                .fillMaxSize()
                .pointerInput(enabled, strokeWidth) {
                    if (!enabled) return@pointerInput
                    val strokePx = strokeWidth.toPx()
                    val inside = RING_GRAB_INSIDE.toPx()
                    val outside = RING_GRAB_OUTSIDE.toPx()
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = true)
                        val centre = Offset(size.width / 2f, size.height / 2f)
                        val radius = (minOf(size.width, size.height) - strokePx) / 2f
                        val from = down.position - centre
                        // Off the ring the touch is left alone: the pager can take a swipe that starts there.
                        if (!ControlMath.onSeekRing(from.getDistance(), radius, inside, outside)) return@awaitEachGesture
                        down.consume()
                        var fraction = ControlMath.ringFraction(from.x, from.y)
                        dragging = fraction
                        currentOnPreview(fraction)
                        // A tap is a press that lifts without moving: it seeks to where it landed.
                        val lifted = drag(down.id) { change ->
                            change.consume()
                            val at = change.position - centre
                            fraction = ControlMath.ringFractionFrom(fraction, ControlMath.ringFraction(at.x, at.y))
                            dragging = fraction
                            currentOnPreview(fraction)
                        }
                        dragging = null
                        if (lifted) {
                            sought = fraction
                            currentOnSeek(fraction)
                        } else {
                            currentOnPreview(null)
                        }
                    }
                }
        ) {
            val strokePx = strokeWidth.toPx()
            val diameter = minOf(size.width, size.height) - strokePx
            val topLeft = Offset((size.width - diameter) / 2f, (size.height - diameter) / 2f)
            val arcSize = Size(diameter, diameter)
            val stroke = Stroke(width = strokePx, cap = StrokeCap.Round)

            // The whole ring, faint, and the elapsed part of the song over it.
            drawArc(Color.White.copy(alpha = 0.22f), startAngle = -90f, sweepAngle = 360f, useCenter = false, topLeft = topLeft, size = arcSize, style = stroke)
            if (shown > 0f) {
                drawArc(accent, startAngle = -90f, sweepAngle = shown * 360f, useCenter = false, topLeft = topLeft, size = arcSize, style = stroke)
                if (enabled) {
                    // The handle, at the end of the elapsed arc; larger while it is being moved.
                    val angle = Math.toRadians((-90f + shown * 360f).toDouble())
                    val handle = Offset(
                        size.width / 2f + diameter / 2f * cos(angle).toFloat(),
                        size.height / 2f + diameter / 2f * sin(angle).toFloat()
                    )
                    drawCircle(Color.White, radius = if (dragging != null) strokePx * 1.5f else strokePx, center = handle)
                }
            }
        }

        // The play/pause button in the middle.
        content()
    }
}
