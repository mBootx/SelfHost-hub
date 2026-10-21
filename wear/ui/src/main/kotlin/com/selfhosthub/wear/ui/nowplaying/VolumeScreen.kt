package com.selfhosthub.wear.ui.nowplaying

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.CoverBackdrop
import com.selfhosthub.wear.ui.common.CoverLook
import com.selfhosthub.wear.ui.common.CoverTheme
import com.selfhosthub.wear.ui.theme.WatchColors
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/** The icon of a volume: crossed out at 0, one wave up to half, two above. */
@DrawableRes
internal fun volumeIconRes(volume: Double): Int = when {
    volume <= 0.0 -> R.drawable.ic_spotify_volume_off
    volume < 0.5 -> R.drawable.ic_spotify_volume_low
    else -> R.drawable.ic_spotify_volume_high
}

/**
 * The volume, as a ring round the edge of the screen. The crown or the bezel turns it (on a Galaxy Watch, a click of
 * the bezel is a step of 4 %), and a finger can slide it round the ring; the middle of the screen is left to the mute
 * button and to swiping back. The cover of the song is behind it, and the ring takes its colour, as on Now Playing.
 */
@Composable
fun VolumeContent(
    volume: Double,
    /** Who plays (the player the controls act on), or why nothing can be changed. */
    caption: String?,
    captionIsWarning: Boolean,
    enabled: Boolean,
    /** The crown or the bezel moved by this many pixels of scrolling. */
    onRotary: (Float) -> Unit,
    /** A finger on the ring moved the volume here. */
    onChange: (Double) -> Unit,
    onMute: () -> Unit,
    modifier: Modifier = Modifier,
    look: CoverLook? = null
) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val shown = volume.coerceIn(0.0, 1.0)
    val percent = ControlMath.volumePercent(shown)
    val label = stringResource(R.string.volume)

    Box(
        modifier
            .fillMaxSize()
            .onRotaryScrollEvent {
                if (enabled) onRotary(it.verticalScrollPixels)
                true
            }
            .focusRequester(focus)
            .focusable(),
        contentAlignment = Alignment.Center
    ) {
        CoverBackdrop(look)
        CoverTheme(look?.colours) {
            VolumeRing(shown, enabled, label, onChange, Modifier.fillMaxSize())
            Column(
                Modifier.widthIn(max = 136.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                val muted = shown <= 0.0
                Button(
                    onClick = onMute,
                    enabled = enabled,
                    modifier = Modifier.size(46.dp),
                    colors = ButtonDefaults.buttonColors(
                        backgroundColor = if (muted) WatchColors.Danger.copy(alpha = 0.22f) else Color.White.copy(alpha = 0.12f),
                        contentColor = if (muted) WatchColors.Danger else WatchColors.OnSurface
                    ),
                    shape = CircleShape
                ) {
                    Icon(
                        painter = painterResource(volumeIconRes(shown)),
                        contentDescription = stringResource(if (muted) R.string.volume_unmute else R.string.volume_mute),
                        modifier = Modifier.size(22.dp),
                        tint = if (muted) WatchColors.Danger else WatchColors.OnSurface
                    )
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    stringResource(R.string.volume_percent, percent),
                    style = MaterialTheme.typography.display2.copy(
                        fontSize = 32.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFeatureSettings = "tnum"
                    ),
                    color = WatchColors.OnSurface,
                    maxLines = 1
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    caption ?: label,
                    style = MaterialTheme.typography.caption2,
                    color = if (captionIsWarning) WatchColors.Warning else MaterialTheme.colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}

/** The ring itself: the track, the part filled in the accent colour, and a handle at the volume. */
@Composable
private fun VolumeRing(volume: Double, enabled: Boolean, label: String, onChange: (Double) -> Unit, modifier: Modifier) {
    // The gesture below lives as long as `enabled` does; the volume and the callback change while it runs.
    val current by rememberUpdatedState(volume)
    val currentOnChange by rememberUpdatedState(onChange)
    val density = LocalDensity.current
    val stroke = with(density) { 5.dp.toPx() }
    val inset = with(density) { 9.dp.toPx() }
    val handle = with(density) { 5.5.dp.toPx() }
    val accent = MaterialTheme.colors.primary

    Canvas(
        modifier
            .semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo(volume.toFloat(), 0f..1f, steps = 24)
                if (enabled) {
                    setProgress { target ->
                        currentOnChange(target.toDouble().coerceIn(0.0, 1.0))
                        true
                    }
                }
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val centre = Offset(size.width / 2f, size.height / 2f)
                    val radius = min(size.width, size.height) / 2f
                    if (!ControlMath.onRing((down.position - centre).getDistance(), radius)) return@awaitEachGesture
                    var angle = ControlMath.angleOf(down.position.x - centre.x, down.position.y - centre.y)
                    var value = current
                    var travelled = 0f
                    var turning = false
                    while (true) {
                        val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) break
                        val now = ControlMath.angleOf(change.position.x - centre.x, change.position.y - centre.y)
                        val turn = ControlMath.turnBetween(angle, now)
                        angle = now
                        if (!turning) {
                            // A tap on the ring does nothing (no jump to full volume by mistake): only a slide turns it.
                            travelled += (change.position - change.previousPosition).getDistance()
                            if (travelled < viewConfiguration.touchSlop) continue
                            turning = true
                        }
                        change.consume()
                        value = ControlMath.volumeTurned(value, turn)
                        currentOnChange(value)
                    }
                }
            }
    ) {
        val diameter = min(size.width, size.height) - 2 * inset
        val topLeft = Offset((size.width - diameter) / 2f, (size.height - diameter) / 2f)
        val arcSize = Size(diameter, diameter)
        val style = Stroke(width = stroke, cap = StrokeCap.Round)
        drawArc(Color.White.copy(alpha = 0.14f), ControlMath.ARC_START, ControlMath.ARC_SWEEP, false, topLeft, arcSize, style = style)
        val sweep = ControlMath.ARC_SWEEP * volume.toFloat()
        if (sweep > 0f) drawArc(if (enabled) accent else Color(0xFF666666), ControlMath.ARC_START, sweep, false, topLeft, arcSize, style = style)
        if (enabled) {
            val radians = Math.toRadians((ControlMath.ARC_START + sweep).toDouble())
            val centre = Offset(size.width / 2f, size.height / 2f)
            val at = Offset(centre.x + diameter / 2f * cos(radians).toFloat(), centre.y + diameter / 2f * sin(radians).toFloat())
            drawCircle(Color.White, handle, at)
        }
    }
}
