package com.selfhosthub.wear.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme

/** The green of the phone and desktop apps, on the black that costs an OLED screen nothing. */
object WatchColors {
    val Accent = Color(0xFF1DB954)
    val AccentDim = Color(0xFF14803A)
    val Surface = Color(0xFF1A1A1A)
    val SurfaceRaised = Color(0xFF262626)
    val OnSurface = Color(0xFFF2F2F2)
    val OnSurfaceMuted = Color(0xFF9A9A9A)
    val Danger = Color(0xFFEF5350)
    val Warning = Color(0xFFFFB74D)
}

private val colors = Colors(
    primary = WatchColors.Accent,
    primaryVariant = WatchColors.AccentDim,
    secondary = WatchColors.Accent,
    secondaryVariant = WatchColors.AccentDim,
    background = Color.Black,
    surface = WatchColors.Surface,
    error = WatchColors.Danger,
    onPrimary = Color.Black,
    onSecondary = Color.Black,
    onBackground = WatchColors.OnSurface,
    onSurface = WatchColors.OnSurface,
    onSurfaceVariant = WatchColors.OnSurfaceMuted,
    onError = Color.Black
)

@Composable
fun SelfHostWatchTheme(content: @Composable () -> Unit) {
    MaterialTheme(colors = colors, content = content)
}
