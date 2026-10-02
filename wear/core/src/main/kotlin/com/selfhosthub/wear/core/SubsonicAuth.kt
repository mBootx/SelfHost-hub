package com.selfhosthub.wear.core

import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Subsonic's "token" authentication (API 1.13 and later, which Navidrome speaks): a request carries the user,
 * a salt and `md5(password + salt)` instead of the password itself.
 */
object SubsonicAuth {
    const val API_VERSION = "1.16.1"
    const val CLIENT_NAME = "SelfHostHubWear"

    fun md5Hex(text: String): String {
        val digest = MessageDigest.getInstance("MD5").digest(text.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    fun token(password: String, salt: String): String = md5Hex(password + salt)

    /** A random salt of twelve hex characters. */
    fun newSalt(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(6)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}

/**
 * Where Navidrome is and how to sign in to it. The phone sends the salt and the token, not the password: the
 * server accepts any salt, so a fixed pair works for every request, and the password never reaches the watch.
 */
data class NavidromeLogin(
    val url: String,
    val username: String,
    val salt: String,
    val token: String
) {
    val baseUrl: String get() = url.trim().trimEnd('/')

    /** The query parameters every Subsonic call carries, JSON answers requested. */
    fun queryParameters(): List<Pair<String, String>> = listOf(
        "u" to username,
        "t" to token,
        "s" to salt,
        "v" to SubsonicAuth.API_VERSION,
        "c" to SubsonicAuth.CLIENT_NAME,
        "f" to "json"
    )

    /** Same server and account, whatever the secret: used to tell whether the library on the watch is still the right one. */
    fun sameAccount(other: NavidromeLogin?): Boolean =
        other != null && other.baseUrl.equals(baseUrl, ignoreCase = true) && other.username == username
}
