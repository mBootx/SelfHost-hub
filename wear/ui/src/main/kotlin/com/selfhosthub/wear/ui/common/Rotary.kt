package com.selfhosthub.wear.ui.common

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/** The system feature of watches whose rotary input clicks (a Galaxy Watch's turning or touch bezel) instead of gliding like a crown. */
private const val LOW_RES_ROTARY = "android.hardware.rotaryencoder.lowres"

/**
 * Whether the watch turns by clicks: then each click is one step, whatever number of pixels it reports. Galaxy Watches
 * don't all declare the feature, but their bezel does click, so Samsung is taken for it too.
 */
@Composable
fun rememberLowResRotary(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        context.packageManager.hasSystemFeature(LOW_RES_ROTARY) || Build.MANUFACTURER.equals("samsung", ignoreCase = true)
    }
}
