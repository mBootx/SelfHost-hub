package com.selfhosthub.wear.core

import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * The live link between the watch and the phone app, over the Wear OS data layer (the phone and watch's own encrypted
 * link, delivered only between two apps of the same package signed with the same key). The watch never talks to the PC:
 * the phone is the only thing that does, and it passes on what the watch needs.
 *
 * - the watch sends a request, and the phone answers with a snapshot: its own player, and the players the PC's hub lists;
 * - the watch sends commands, which the phone applies to its own player or forwards to the hub;
 * - the phone sends a fresh snapshot whenever something worth showing changes;
 * - when the phone app's process runs without its JavaScript, the phone says so at once ("closed").
 *
 * The phone's side is mobile/src/services/watchLink.ts. Both sides' tests read the sample files in
 * core/src/test/resources, and the integration test runs the real phone code against this one.
 */
object LinkProtocol {
    const val VERSION = 1
    const val PREFIX = "/selfhost/link"
    const val REQUEST_PATH = "/selfhost/link/request"
    const val SNAPSHOT_PATH = "/selfhost/link/snapshot"
    const val COMMAND_PATH = "/selfhost/link/command"
    const val CLOSED_PATH = "/selfhost/link/closed"

    /** What the watch calls the phone's own player. */
    const val PHONE_ID = "local"

    /** What the watch calls the PC's player (the hub names itself so). */
    const val HUB_ID = "hub"
}

enum class RepeatMode(val wire: String) {
    OFF("off"),
    ALL("all"),
    ONE("one");

    /** The mode the repeat button goes to next. */
    fun next(): RepeatMode = when (this) {
        OFF -> ALL
        ALL -> ONE
        ONE -> OFF
    }

    companion object {
        fun fromWire(value: String?): RepeatMode = entries.firstOrNull { it.wire == value } ?: OFF
    }
}

/** The song a player is on, as the players describe it (seconds for the duration). */
data class RemoteSong(
    val id: String,
    val title: String,
    val artist: String,
    val album: String?,
    val albumId: String?,
    val coverArt: String?,
    val duration: Double
)

/** One player's state: the phone, a PC, another phone. `volume` runs from 0 to 1, times are in seconds. */
data class DeviceState(
    val song: RemoteSong?,
    val isPlaying: Boolean,
    val currentTime: Double,
    val duration: Double,
    val shuffle: Boolean,
    val repeatMode: RepeatMode,
    val volume: Double
)

data class DeviceSummary(val deviceId: String, val deviceName: String, val platform: String)

/** How the phone stands with the PC, as the phone tells it. */
enum class PcState(val wire: String) {
    CONNECTED("connected"),
    CONNECTING("connecting"),
    DISCONNECTED("disconnected"),
    OFF("off"),
    UNPAIRED("unpaired"),
    ERROR("error");

    companion object {
        fun fromWire(value: String?): PcState = entries.firstOrNull { it.wire == value } ?: DISCONNECTED
    }
}

data class PcLink(val state: PcState, val name: String?, val message: String?)

/** What the phone tells the watch: the players, and how the phone stands with the PC. The phone's own player is first. */
data class Snapshot(val phoneName: String, val pc: PcLink, val devices: List<DeviceSummary>, val states: Map<String, DeviceState>)

sealed interface LinkMessage {
    data class Snap(val snapshot: Snapshot) : LinkMessage

    /** The phone app's process is there but its JavaScript is not running. */
    data object Closed : LinkMessage

    /** A message of a version this app does not know: the phone and the watch need to be updated together. */
    data class UnsupportedVersion(val version: Int?) : LinkMessage

    data class Unknown(val path: String) : LinkMessage
}

/** What can be asked of a player. The names are the phone's: it ignores any other. */
sealed class PlayerCommand(val action: String, val payload: Map<String, Any?>? = null) {
    data object Toggle : PlayerCommand("toggle")
    data object Play : PlayerCommand("play")
    data object Pause : PlayerCommand("pause")
    data object Next : PlayerCommand("next")
    data object Prev : PlayerCommand("prev")
    data class Seek(val seconds: Double) : PlayerCommand("seek", mapOf("seconds" to seconds))
    data class SetVolume(val volume: Double) : PlayerCommand("setVolume", mapOf("volume" to volume.coerceIn(0.0, 1.0)))
    data object ToggleShuffle : PlayerCommand("toggleShuffle")
    data class SetRepeatMode(val mode: RepeatMode) : PlayerCommand("setRepeatMode", mapOf("mode" to mode.wire))

    /**
     * Asks the phone to play something from its Navidrome: the whole album or playlist (from the song `songId`, or the
     * position `index`, when given) or one song. `mode` says whether it replaces the queue, goes next, or goes last.
     * It always plays on the phone, whichever player the watch was controlling.
     */
    data class PlayMedia(val kind: MediaKind, val id: String, val index: Int? = null, val songId: String? = null, val mode: PlayMode = PlayMode.NOW) :
        PlayerCommand(
            "playMedia",
            buildMap<String, Any?> {
                put("kind", kind.wire)
                put("id", id)
                if (index != null) put("index", index)
                if (songId != null) put("songId", songId)
                put("mode", mode.wire)
            }
        )
}

enum class MediaKind(val wire: String) { SONG("song"), ALBUM("album"), PLAYLIST("playlist") }

enum class PlayMode(val wire: String) { NOW("now"), NEXT("next"), LAST("last") }

object LinkCodec {
    /**
     * What the watch sends to ask for a snapshot. It says which version of the app it is: that is how the phone knows
     * whether to offer an update (see UpdateProtocol). A phone that does not read it simply ignores it.
     */
    fun request(app: AppVersion? = null): String = JsonObject().apply {
        addProperty("v", LinkProtocol.VERSION)
        if (app != null) add("app", JsonObject().apply { addProperty("name", app.name); addProperty("code", app.code) })
    }.toString()

    fun command(targetId: String, command: PlayerCommand): String {
        val obj = JsonObject()
        obj.addProperty("v", LinkProtocol.VERSION)
        obj.addProperty("targetId", targetId)
        obj.addProperty("action", command.action)
        val payload = command.payload
        if (payload != null) {
            val body = JsonObject()
            for ((key, value) in payload) {
                when (value) {
                    null -> body.add(key, JsonNull.INSTANCE)
                    is Number -> body.addProperty(key, value)
                    is Boolean -> body.addProperty(key, value)
                    else -> body.addProperty(key, value.toString())
                }
            }
            obj.add("payload", body)
        }
        return obj.toString()
    }

    /** Reads a message the phone sent on `path`. Nothing that arrives is trusted to be well formed. */
    fun parse(path: String, text: String): LinkMessage {
        if (path == LinkProtocol.CLOSED_PATH) return LinkMessage.Closed
        if (path != LinkProtocol.SNAPSHOT_PATH) return LinkMessage.Unknown(path)
        val root = try {
            JsonParser.parseString(text)
        } catch (_: Exception) {
            return LinkMessage.Unknown(path)
        }
        val obj = root.asObjectOrNull() ?: return LinkMessage.Unknown(path)
        val version = obj.int("v")
        if (version != LinkProtocol.VERSION) return LinkMessage.UnsupportedVersion(version)

        val devices = obj.get("devices").let { list ->
            if (list != null && list.isJsonArray) {
                list.asJsonArray.mapNotNull { element ->
                    val device = element.asObjectOrNull() ?: return@mapNotNull null
                    val id = device.string("deviceId")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    DeviceSummary(id, device.string("deviceName") ?: id, device.string("platform") ?: "mobile")
                }
            } else {
                emptyList()
            }
        }
        val states = LinkedHashMap<String, DeviceState>()
        obj.get("states").asObjectOrNull()?.entrySet()?.forEach { (id, element) ->
            element.asObjectOrNull()?.let { states[id] = parseState(it) }
        }
        val pc = obj.get("pc").asObjectOrNull()?.let {
            PcLink(PcState.fromWire(it.string("state")), it.string("name"), it.string("message"))
        } ?: PcLink(PcState.DISCONNECTED, null, null)
        return LinkMessage.Snap(Snapshot(obj.string("phone") ?: devices.firstOrNull()?.deviceName ?: "Téléphone", pc, devices, states))
    }

    private fun parseState(obj: JsonObject): DeviceState {
        val song = obj.get("song").asObjectOrNull()?.let { s ->
            val id = s.string("id") ?: return@let null
            RemoteSong(
                id = id,
                title = s.string("title") ?: "",
                artist = s.string("artist") ?: "",
                album = s.string("album"),
                albumId = s.string("albumId"),
                coverArt = s.string("coverArt"),
                duration = s.double("duration", 0.0)
            )
        }
        return DeviceState(
            song = song,
            isPlaying = obj.bool("isPlaying", false),
            currentTime = obj.double("currentTime", 0.0).coerceAtLeast(0.0),
            duration = obj.double("duration", song?.duration ?: 0.0).coerceAtLeast(0.0),
            shuffle = obj.bool("shuffle", false),
            repeatMode = RepeatMode.fromWire(obj.string("repeatMode")),
            volume = obj.double("volume", 1.0).coerceIn(0.0, 1.0)
        )
    }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = if (this != null && this.isJsonObject) this.asJsonObject else null

private fun JsonObject.string(name: String): String? {
    val element = get(name)
    return if (element != null && element.isJsonPrimitive) element.asString else null
}

private fun JsonObject.int(name: String): Int? {
    val element = get(name)
    if (element == null || !element.isJsonPrimitive) return null
    return try {
        element.asInt
    } catch (_: NumberFormatException) {
        null
    }
}

private fun JsonObject.bool(name: String, default: Boolean): Boolean {
    val element = get(name)
    return if (element != null && element.isJsonPrimitive && element.asJsonPrimitive.isBoolean) element.asBoolean else default
}

private fun JsonObject.double(name: String, default: Double): Double {
    val element = get(name)
    if (element == null || !element.isJsonPrimitive) return default
    return try {
        val value = element.asDouble
        if (value.isNaN() || value.isInfinite()) default else value
    } catch (_: NumberFormatException) {
        default
    }
}
