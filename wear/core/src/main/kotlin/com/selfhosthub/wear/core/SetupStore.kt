package com.selfhosthub.wear.core

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Where the watch keeps what the phone gave it: the Navidrome token. It is a secret, so on the watch it lives in
 * encrypted preferences whose key sits in the Android keystore.
 */
interface SetupStore {
    fun load(): WatchSetup?
    fun save(setup: WatchSetup)
    fun clear()
}

class MemorySetupStore(private var setup: WatchSetup? = null) : SetupStore {
    override fun load(): WatchSetup? = setup
    override fun save(setup: WatchSetup) {
        this.setup = setup
    }

    override fun clear() {
        setup = null
    }
}

// The Jetpack Security library is deprecated upstream, but it is still the supported way to keep a small secret
// behind an Android keystore key without writing the cryptography here.
@Suppress("DEPRECATION")
class EncryptedSetupStore(private val context: Context) : SetupStore {
    private val prefs: SharedPreferences? by lazy { open() }

    override fun load(): WatchSetup? {
        val raw = prefs?.getString(KEY, null) ?: return null
        return try {
            SetupCodec.decode(raw)
        } catch (e: SetupFormatException) {
            Log.w(TAG, "Stored setup unreadable, ignoring it: ${e.message}")
            null
        }
    }

    override fun save(setup: WatchSetup) {
        // commit(), not apply(): a setup that arrives while the app is closed must be on disk before the process can be stopped.
        prefs?.edit()?.putString(KEY, SetupCodec.encode(setup))?.commit()
    }

    override fun clear() {
        prefs?.edit()?.remove(KEY)?.apply()
    }

    /**
     * The keystore can lose a key (a restore from backup, a changed lock screen on some watches): the old file then
     * can never be read again. It is deleted and started over once; the watch simply asks to be set up again.
     */
    private fun open(): SharedPreferences? {
        repeat(2) { attempt ->
            try {
                val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
                return EncryptedSharedPreferences.create(
                    context,
                    FILE,
                    key,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                )
            } catch (e: Exception) {
                Log.w(TAG, "Encrypted storage unavailable (attempt ${attempt + 1}): ${e.javaClass.simpleName}")
                context.deleteSharedPreferences(FILE)
            }
        }
        return null
    }

    private companion object {
        const val TAG = "SetupStore"
        const val FILE = "selfhost_wear_secure"
        const val KEY = "setup"
    }
}
