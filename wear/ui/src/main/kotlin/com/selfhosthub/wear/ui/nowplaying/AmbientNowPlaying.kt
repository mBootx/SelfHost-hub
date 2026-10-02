package com.selfhosthub.wear.ui.nowplaying

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.selfhosthub.wear.core.formatClock
import com.selfhosthub.wear.ui.common.AmbientPolicy
import com.selfhosthub.wear.ui.common.AmbientState
import com.selfhosthub.wear.ui.common.CoverBox

/**
 * The always-on screen: pure black (an OLED pixel that is black is off), a small grey cover, the title and the
 * elapsed time, and nothing that moves. With burn-in protection the content shifts by a few pixels each minute and
 * the cover is dropped for a thin ring, so that no pixel is lit in the same place for hours.
 */
@Composable
fun AmbientNowPlayingContent(
    ui: NowPlayingUi,
    cover: ImageBitmap?,
    ambient: AmbientState,
    minuteOfDay: Long,
    modifier: Modifier = Modifier
) {
    val (dx, dy) = AmbientPolicy.shiftFor(minuteOfDay, ambient.burnInProtection)
    Box(modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        Column(
            Modifier.offset(dx.dp, dy.dp).padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            if (ui.hasSong) {
                if (ambient.burnInProtection) {
                    Box(Modifier.size(34.dp).border(1.dp, Color(0xFF777777), CircleShape))
                } else {
                    CoverBox(cover, Modifier.size(42.dp), grayscale = true)
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    ui.title.orEmpty(),
                    color = Color.White,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center
                )
                Text(
                    ui.artist.orEmpty(),
                    color = Color(0xFF9A9A9A),
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    formatClock(ui.position),
                    color = Color.White,
                    style = MaterialTheme.typography.display3,
                    textAlign = TextAlign.Center
                )
            } else {
                Text("SelfHost Hub", color = Color(0xFF9A9A9A), fontSize = 14.sp, textAlign = TextAlign.Center)
            }
        }
    }
}
