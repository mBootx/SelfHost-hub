package com.selfhosthub.wear.ui.nowplaying

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.Text
import com.selfhosthub.wear.ui.common.AmbientPolicy
import com.selfhosthub.wear.ui.common.AmbientState
import com.selfhosthub.wear.ui.common.CoverBox
import com.selfhosthub.wear.ui.common.OutlineCover
import com.selfhosthub.wear.ui.theme.WatchColors
import java.util.Date
import kotlinx.coroutines.delay

/**
 * Which page of Now Playing is up, kept for the whole process: the always-on screen is a separate screen, and it shows
 * the page that was being looked at (the clock, when the clock was), and the watch coming back wakes on it.
 */
object NowPlayingPage {
    const val CLOCK = 0
    const val PLAYER = 1
    const val OPTIONS = 2
    const val COUNT = 3

    /** Snapshot state, so that whatever shows the page follows it. */
    var current by mutableIntStateOf(PLAYER)
}

/** The time as the watch is set to show it (12 or 24 hours), from the system clock. */
fun clockText(context: android.content.Context, millis: Long): String = DateFormat.getTimeFormat(context).format(Date(millis))

/** The time, moved on at each change of minute while shown. */
@Composable
fun rememberClockText(): String {
    val context = LocalContext.current
    val text by produceState(clockText(context, System.currentTimeMillis())) {
        while (true) {
            val now = System.currentTimeMillis()
            value = clockText(context, now)
            // To the start of the next minute, a little after it so that the new minute is the one read.
            delay(60_000 - now % 60_000 + 50)
        }
    }
    return text
}

/**
 * The page above the player: the cover of the song as a thumbnail, and the time, and nothing else. A tap on the
 * cover opens it full screen, as on the player.
 */
@Composable
fun ClockPage(cover: ImageBitmap?, hasSong: Boolean, time: String, onCoverClick: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        if (hasSong) {
            CoverBox(cover, Modifier.size(84.dp).clickable(onClickLabel = null) { onCoverClick() }, RoundedCornerShape(16.dp))
            Spacer(Modifier.height(8.dp))
        } else {
            Icon(Icons.Filled.MusicNote, contentDescription = null, tint = WatchColors.OnSurfaceMuted, modifier = Modifier.size(28.dp))
            Spacer(Modifier.height(6.dp))
        }
        Text(time, color = WatchColors.OnSurface, fontSize = 38.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/**
 * The always-on version of the clock page: pure black, the cover as outlines in a thin frame (an area of cover would be
 * lit all night), and the time. With burn-in protection the content shifts a few pixels each minute and everything is
 * dimmer; on a low-bit display the outlines are lit or not, with no shades.
 */
@Composable
fun AmbientClockContent(
    hasSong: Boolean,
    cover: ImageBitmap?,
    time: String,
    ambient: AmbientState,
    minuteOfDay: Long,
    modifier: Modifier = Modifier
) {
    val (dx, dy) = AmbientPolicy.shiftFor(minuteOfDay, ambient.burnInProtection)
    Box(modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        Column(Modifier.offset(dx.dp, dy.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            if (hasSong) {
                OutlineCover(cover, 78.dp, lowBit = ambient.lowBit, dim = ambient.burnInProtection)
                Spacer(Modifier.height(8.dp))
            }
            Text(time, color = if (ambient.burnInProtection) Color(0xFFD0D0D0) else Color.White, fontSize = if (hasSong) 34.sp else 44.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        }
    }
}
