package com.selfhosthub.wear.core

/**
 * Whether a server's address is one only the home network can reach: a private IPv4 address, a link-local or
 * unique-local IPv6 one, a name without a dot or ending in `.local`, `.lan`, `.home` and the like.
 *
 * It decides which connection the watch uses for Navidrome. A watch paired to a phone often has no Wi-Fi of its own
 * switched on and reaches the internet through the phone over Bluetooth; for a server on the internet that is fine,
 * but a socket opened on that connection may never reach `192.168.x.x`. For the home addresses the watch binds its
 * connection to its Wi-Fi when it has one (see WifiSocketFactory); for the others it lets the system choose.
 */
object PrivateAddress {
    fun isPrivate(host: String): Boolean {
        val name = host.trim().removePrefix("[").removeSuffix("]").lowercase()
        if (name.isEmpty()) return false
        ipv4(name)?.let { (a, b) -> return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254) }
        if (name.contains(':')) return name.startsWith("fc") || name.startsWith("fd") || name.startsWith("fe80")
        return !name.contains('.') || HOME_SUFFIXES.any { name.endsWith(it) }
    }

    /** The first two numbers of a dotted IPv4 address, or null when `text` is not one. */
    private fun ipv4(text: String): Pair<Int, Int>? {
        val parts = text.split('.')
        if (parts.size != 4) return null
        val numbers = parts.map { it.toIntOrNull()?.takeIf { n -> n in 0..255 } ?: return null }
        return numbers[0] to numbers[1]
    }

    private val HOME_SUFFIXES = listOf(".local", ".lan", ".home", ".home.arpa", ".internal")
}
