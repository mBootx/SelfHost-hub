package com.selfhosthub.wear.core

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * What the phone hands the watch once, from its "Montre" setting: where Navidrome is and the signed-in token. It
 * travels over the Wear OS data layer (the phone and watch's own encrypted link, between two apps of the same name
 * signed with the same key), as one message. Nothing about the PC is in it: the watch never talks to the PC, only to
 * this phone (see LinkProtocol) and to Navidrome.
 */
object SetupProtocol {
    /** The watch app declares this capability, which is how the phone knows that a watch has it installed. */
    const val CAPABILITY = "selfhost_watch"
    const val SETUP_PATH = "/selfhost/setup"
    const val ACK_PATH = "/selfhost/setup/ack"
    const val VERSION = 1
}

data class WatchSetup(val navidrome: NavidromeLogin)

class SetupFormatException(message: String) : Exception(message)

object SetupCodec {
    private const val MAX_TEXT = 300

    fun encode(setup: WatchSetup): String {
        val root = JsonObject()
        root.addProperty("v", SetupProtocol.VERSION)
        val n = JsonObject()
        n.addProperty("url", setup.navidrome.url)
        n.addProperty("username", setup.navidrome.username)
        n.addProperty("salt", setup.navidrome.salt)
        n.addProperty("token", setup.navidrome.token)
        root.add("navidrome", n)
        return root.toString()
    }

    /** Reads and checks what the phone sent; anything that is not exactly what it should be is refused whole. */
    fun decode(json: String): WatchSetup {
        val root = try {
            JsonParser.parseString(json)
        } catch (_: Exception) {
            throw SetupFormatException("Message illisible")
        }
        if (!root.isJsonObject) throw SetupFormatException("Message illisible")
        val obj = root.asJsonObject
        val version = obj.get("v")?.takeIf { it.isJsonPrimitive }?.let { runCatching { it.asInt }.getOrNull() }
        if (version != SetupProtocol.VERSION) throw SetupFormatException("Version de configuration inconnue : mettez à jour les deux applications")

        val n = obj.get("navidrome")?.takeIf { it.isJsonObject }?.asJsonObject ?: throw SetupFormatException("Rien à configurer")
        val url = n.text("url") ?: throw SetupFormatException("Adresse Navidrome manquante")
        if (!isHttpUrl(url)) throw SetupFormatException("Adresse Navidrome invalide")
        val username = n.text("username") ?: throw SetupFormatException("Nom d'utilisateur manquant")
        val salt = n.text("salt") ?: throw SetupFormatException("Sel manquant")
        val token = n.text("token") ?: throw SetupFormatException("Jeton manquant")
        if (!token.matches(Regex("[0-9a-fA-F]{32}"))) throw SetupFormatException("Jeton invalide")
        return WatchSetup(NavidromeLogin(url.trim(), username, salt, token.lowercase()))
    }

    private fun JsonObject.text(name: String): String? {
        val element = get(name)
        if (element == null || !element.isJsonPrimitive) return null
        val value = element.asString.trim()
        return if (value.isEmpty() || value.length > MAX_TEXT) null else value
    }

    private fun isHttpUrl(url: String): Boolean {
        val lower = url.trim().lowercase()
        if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false
        val rest = lower.substringAfter("://")
        return rest.isNotEmpty() && !rest.startsWith("/") && !rest.startsWith(":")
    }
}
