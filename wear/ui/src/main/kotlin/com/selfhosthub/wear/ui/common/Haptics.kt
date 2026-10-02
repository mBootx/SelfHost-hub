package com.selfhosthub.wear.ui.common

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback

/** The vibrations of the app: a short tick for a tap, a firmer one when something is done or refused. */
class Haptics(private val feedback: HapticFeedback) {
    /** A press on a button. */
    fun tap() = feedback.performHapticFeedback(HapticFeedbackType.ContextClick)

    /** A command went out, a position was chosen. */
    fun confirm() = feedback.performHapticFeedback(HapticFeedbackType.Confirm)

    /** Something could not be done. */
    fun reject() = feedback.performHapticFeedback(HapticFeedbackType.Reject)

    /** A step of a continuous control, such as the crown moving the volume. */
    fun tick() = feedback.performHapticFeedback(HapticFeedbackType.SegmentTick)
}

@Composable
fun rememberHaptics(): Haptics {
    val feedback = LocalHapticFeedback.current
    return remember(feedback) { Haptics(feedback) }
}
