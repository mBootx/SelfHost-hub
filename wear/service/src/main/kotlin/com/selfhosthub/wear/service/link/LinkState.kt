package com.selfhosthub.wear.service.link

import com.selfhosthub.wear.core.DeviceState
import com.selfhosthub.wear.core.DeviceSummary
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.core.PcLink

/** Where the watch stands with the phone app, which is its only way to the players. */
enum class LinkStatus(val short: String?, val message: String?) {
    /** Nothing heard yet. */
    CONNECTING("Connexion…", null),
    CONNECTED(null, null),
    NO_PHONE("Pas de téléphone", "Aucun téléphone connecté : le Bluetooth doit être actif sur la montre et sur le téléphone"),
    PHONE_APP_CLOSED("Appli fermée", "Ouvrez SelfHost Hub sur le téléphone (version 2.5 ou plus récente)"),
    VERSION_MISMATCH("Versions incompatibles", "Mettez à jour l'application du téléphone et celle de la montre")
}

/** A player's state, and when the watch heard it (to move the progress bar between two messages). */
data class PlayerSnapshot(val state: DeviceState, val receivedAt: Long) {
    /** Where the song is now: the last position heard plus the time since, while it plays. */
    fun positionAt(now: Long): Double {
        if (!state.isPlaying) return state.currentTime
        val elapsed = (now - receivedAt).coerceAtLeast(0) / 1000.0
        val position = state.currentTime + elapsed
        return if (state.duration > 0) position.coerceAtMost(state.duration) else position
    }
}

data class LinkUiState(
    val status: LinkStatus = LinkStatus.CONNECTING,
    /** The phone's own name, as it calls itself. */
    val phoneName: String? = null,
    /** How the phone stands with the PC; null until the phone has said. */
    val pc: PcLink? = null,
    /** The players: the phone first, then the PC and the other devices the phone's hub link lists. */
    val devices: List<DeviceSummary> = emptyList(),
    val players: Map<String, PlayerSnapshot> = emptyMap(),
    /** The player picked by hand, or null while the watch follows whichever one plays. */
    val manualTargetId: String? = null,
    /** The player the controls act on right now. */
    val targetId: String? = null
) {
    val connected: Boolean get() = status == LinkStatus.CONNECTED
    val target: PlayerSnapshot? get() = targetId?.let { players[it] }
    val targetName: String? get() = devices.firstOrNull { it.deviceId == targetId }?.deviceName
}

/**
 * Which player the controls act on. A choice made by hand wins as long as that player is still there; otherwise
 * the player that is playing (the one that started most recently, if several are); otherwise the one controlled
 * last; otherwise the phone itself, or whichever is first.
 */
object TargetPicker {
    fun pick(
        devices: List<DeviceSummary>,
        players: Map<String, PlayerSnapshot>,
        manualTargetId: String?,
        lastTargetId: String?,
        playingSince: Map<String, Long>
    ): String? {
        val ids = devices.map { it.deviceId }
        if (manualTargetId != null && manualTargetId in ids) return manualTargetId
        val playing = ids.filter { players[it]?.state?.isPlaying == true }
        if (playing.isNotEmpty()) return playing.maxByOrNull { playingSince[it] ?: 0L }
        if (lastTargetId != null && lastTargetId in ids) return lastTargetId
        if (LinkProtocol.PHONE_ID in ids) return LinkProtocol.PHONE_ID
        return ids.firstOrNull()
    }
}
