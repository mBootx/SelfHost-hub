package com.selfhosthub.wear.core

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Updating the watch app from the phone, over the Wear OS data layer (the phone and watch's own encrypted link,
 * delivered only between two apps of the same package signed with the same key).
 *
 * - the phone downloads the watch APK from the GitHub release and opens a channel to the watch on [UpdateProtocol.APK_PATH];
 *   what it writes is one line of JSON (an [UpdateHeader]: the version, the size, the SHA-256) and then the APK itself;
 * - the watch checks the header, keeps the bytes, checks them against the header and against the APK's own manifest and
 *   signature, and hands the file to Android's package installer;
 * - the watch tells the phone how it goes, in messages on [UpdateProtocol.STATUS_PATH] (an [UpdateStatus]).
 *
 * The phone's side is mobile/src/services/watchUpdate.ts. Both sides' tests read the sample files in core/src/test/resources.
 * Installing needs the "install unknown apps" permission, which the watch app asks Android for but a watch may have no
 * screen to grant it on: the watch then refuses before receiving anything, and says so.
 */
object UpdateProtocol {
    const val VERSION = 1
    const val PREFIX = "/selfhost/update"
    const val APK_PATH = "/selfhost/update/apk"
    const val STATUS_PATH = "/selfhost/update/status"

    /** The phone asks which version of the app the watch has; the watch answers with a status ([UpdateState.VERSION]). */
    const val ASK_PATH = "/selfhost/update/ask"

    /** The header is one short line: anything longer is not one of ours. */
    const val MAX_HEADER_BYTES = 1024

    /** The watch APK is about 3.5 MB; this is room to grow, and a limit on what a confused sender can fill the watch with. */
    const val MAX_APK_BYTES = 40L * 1024 * 1024
}

/** What the phone says about the APK it is about to send. */
data class UpdateHeader(val versionName: String, val versionCode: Long, val size: Long, val sha256: String, val reinstall: Boolean = false)

/** What the watch says about an update: how far it got, or why it will not go on. */
enum class UpdateState(val wire: String) {
    /** The whole APK arrived and matches what was announced: it is being handed to the installer. */
    RECEIVED("received"),

    /** Android is asking the person wearing the watch to confirm (a notification was posted). */
    CONFIRM("confirm"),

    /** The new version is running: sent by the new version itself, as soon as it starts. */
    INSTALLED("installed"),

    /** Which version the app is, in answer to the phone's question. */
    VERSION("version"),

    /** The watch will not take it; the reason says why, before anything was transferred. */
    REFUSED("refused"),

    /** It went wrong on the way; the message says how. */
    FAILED("failed");

    companion object {
        fun fromWire(value: String?): UpdateState? = entries.firstOrNull { it.wire == value }
    }
}

enum class UpdateRefusal(val wire: String) {
    /** The watch has this version or a newer one (and no reinstall was asked for). */
    UP_TO_DATE("up-to-date"),

    /** The app is not allowed to install apps ("install unknown apps"), and the watch may have no screen to allow it on. */
    NOT_ALLOWED("not-allowed"),

    /** Not enough room on the watch for the file and the installer's copy of it. */
    NO_SPACE("no-space"),

    /** The header was not one the watch understands. */
    BAD_HEADER("bad-header"),

    /** Another update is being received or installed. */
    BUSY("busy")
}

data class UpdateStatus(
    val state: UpdateState,
    val versionName: String? = null,
    val versionCode: Long? = null,
    val reason: UpdateRefusal? = null,
    val message: String? = null
)

class UpdateFormatException(message: String) : Exception(message)

/** What the watch app is: its version, as the phone is told in every request for the state. */
data class AppVersion(val name: String, val code: Long)

object UpdateCodec {
    private val VERSION_NAME = Regex("""\d{1,4}\.\d{1,4}\.\d{1,4}""")
    private val SHA256 = Regex("""[0-9a-fA-F]{64}""")

    fun header(header: UpdateHeader): String {
        val obj = JsonObject()
        obj.addProperty("v", UpdateProtocol.VERSION)
        obj.addProperty("versionName", header.versionName)
        obj.addProperty("versionCode", header.versionCode)
        obj.addProperty("size", header.size)
        obj.addProperty("sha256", header.sha256)
        obj.addProperty("reinstall", header.reinstall)
        return obj.toString()
    }

    /** Reads and checks the header line; anything that is not exactly what it should be is refused. */
    fun decodeHeader(line: String): UpdateHeader {
        val root = try {
            JsonParser.parseString(line)
        } catch (_: Exception) {
            throw UpdateFormatException("en-tête illisible")
        }
        if (!root.isJsonObject) throw UpdateFormatException("en-tête illisible")
        val obj = root.asJsonObject
        if (obj.long("v") != UpdateProtocol.VERSION.toLong()) throw UpdateFormatException("version de mise à jour inconnue")
        val name = obj.text("versionName")?.takeIf { VERSION_NAME.matches(it) } ?: throw UpdateFormatException("version invalide")
        val code = obj.long("versionCode")?.takeIf { it in 1..2_000_000_000L } ?: throw UpdateFormatException("numéro de version invalide")
        val size = obj.long("size")?.takeIf { it in 1..UpdateProtocol.MAX_APK_BYTES } ?: throw UpdateFormatException("taille invalide")
        val sha = obj.text("sha256")?.takeIf { SHA256.matches(it) } ?: throw UpdateFormatException("empreinte invalide")
        val reinstall = obj.get("reinstall")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean ?: false
        return UpdateHeader(name, code, size, sha.lowercase(), reinstall)
    }

    fun status(status: UpdateStatus): String {
        val obj = JsonObject()
        obj.addProperty("v", UpdateProtocol.VERSION)
        obj.addProperty("state", status.state.wire)
        status.versionName?.let { obj.addProperty("versionName", it) }
        status.versionCode?.let { obj.addProperty("versionCode", it) }
        status.reason?.let { obj.addProperty("reason", it.wire) }
        status.message?.let { obj.addProperty("message", it.take(300)) }
        return obj.toString()
    }

    private fun JsonObject.text(name: String): String? {
        val element = get(name)
        return if (element != null && element.isJsonPrimitive && element.asJsonPrimitive.isString) element.asString else null
    }

    private fun JsonObject.long(name: String): Long? {
        val element = get(name)
        if (element == null || !element.isJsonPrimitive || !element.asJsonPrimitive.isNumber) return null
        return try {
            val value = element.asBigDecimal
            if (value.scale() > 0 && value.stripTrailingZeros().scale() > 0) null else value.toLong()
        } catch (_: Exception) {
            null
        }
    }
}

/** Whether an update that has been announced is one the watch should take, from what the watch knows about itself. */
object UpdatePolicy {
    /** The file is kept, then copied into the installer's session, then installed: room for it twice over. */
    private const val SPACE_FACTOR = 2

    /** Null when the update can go on; otherwise why not. */
    fun refusal(header: UpdateHeader, installedCode: Long, freeBytes: Long, mayInstall: Boolean): UpdateRefusal? {
        if (header.versionCode < installedCode || (header.versionCode == installedCode && !header.reinstall)) return UpdateRefusal.UP_TO_DATE
        if (!mayInstall) return UpdateRefusal.NOT_ALLOWED
        if (freeBytes < header.size * SPACE_FACTOR) return UpdateRefusal.NO_SPACE
        return null
    }
}
