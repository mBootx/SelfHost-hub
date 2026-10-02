package com.selfhosthub.wear.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.theme.WatchColors

/**
 * Shown in place of the library until the phone has sent its setup: the watch has no way to sign in to Navidrome on its
 * own (typing a server address and a password on a watch is a poor idea), so it says where to tap on the phone and
 * waits. The screen leaves by itself once the setup arrives. Controlling the music needs none of this.
 */
@Composable
fun SetupContent(modifier: Modifier = Modifier) {
    val state = rememberScalingLazyListState()
    Scaffold(
        modifier = modifier,
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) }
    ) {
        ScalingLazyColumn(
            state = state,
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
            contentPadding = PaddingValues(top = 36.dp, bottom = 36.dp, start = 18.dp, end = 18.dp)
        ) {
            item { Icon(Icons.Filled.PhoneAndroid, contentDescription = null, tint = WatchColors.Accent, modifier = Modifier.size(30.dp)) }
            item { Text(stringResource(R.string.setup_title), style = MaterialTheme.typography.title3, textAlign = TextAlign.Center) }
            item { Text(stringResource(R.string.setup_step_phone), style = MaterialTheme.typography.body2, textAlign = TextAlign.Center, color = WatchColors.OnSurface) }
            item { Text(stringResource(R.string.setup_bluetooth), style = MaterialTheme.typography.caption2, textAlign = TextAlign.Center, color = WatchColors.OnSurfaceMuted) }
            item { CircularProgressIndicator(Modifier.size(22.dp), indicatorColor = WatchColors.Accent, strokeWidth = 2.dp) }
            item { Text(stringResource(R.string.setup_waiting), style = MaterialTheme.typography.caption3, textAlign = TextAlign.Center, color = WatchColors.OnSurfaceMuted) }
        }
    }
}
