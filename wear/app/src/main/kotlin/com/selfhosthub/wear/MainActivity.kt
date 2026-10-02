package com.selfhosthub.wear

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.ambient.AmbientLifecycleObserver
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.WatchGraphProvider
import com.selfhosthub.wear.service.link.LinkLeases
import com.selfhosthub.wear.ui.WatchApp
import com.selfhosthub.wear.ui.common.AmbientState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

class MainActivity : ComponentActivity() {
    private val ambient = MutableStateFlow(AmbientState())
    private var lease: LinkLeases.Lease? = null

    // Lint mistakes this for a Fragment calling registerForActivityResult; a ComponentActivity has always had it.
    @SuppressLint("InvalidFragmentVersionForActivityResult")
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    private val graph: WatchGraph get() = (application as WatchGraphProvider).graph

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Ambient mode: the system tells the activity when the display dims to its always-on version, and once a
        // minute while it stays there. What is drawn then is AmbientNowPlayingContent, in pure black.
        val callback = object : AmbientLifecycleObserver.AmbientLifecycleCallback {
            override fun onEnterAmbient(ambientDetails: AmbientLifecycleObserver.AmbientDetails) {
                ambient.update {
                    AmbientState(
                        isAmbient = true,
                        burnInProtection = ambientDetails.burnInProtectionRequired,
                        lowBit = ambientDetails.deviceHasLowBitAmbient,
                        tick = it.tick + 1
                    )
                }
            }

            override fun onExitAmbient() {
                ambient.update { AmbientState(isAmbient = false, tick = it.tick + 1) }
                // The screen is up again after a while of nobody looking: ask the phone how things are.
                graph.link.refresh()
            }

            override fun onUpdateAmbient() {
                ambient.update { it.copy(tick = it.tick + 1) }
            }
        }
        lifecycle.addObserver(AmbientLifecycleObserver(this, callback))

        askForPermissionsOnce()

        setContent {
            val state by ambient.collectAsStateWithLifecycle()
            WatchApp(graph, state, BuildConfig.VERSION_NAME)
        }
    }

    override fun onStart() {
        super.onStart()
        // The screen is up: staying in touch with the phone (asking how the players are) is wanted for as long as it is.
        lease = graph.linkLeases.acquire()
    }

    override fun onStop() {
        lease?.close()
        lease = null
        super.onStop()
    }

    /** The notification (the chip with the music playing) is asked for once, not at every launch. */
    private fun askForPermissionsOnce() {
        val prefs = getSharedPreferences("selfhost_wear_ui", MODE_PRIVATE)
        if (prefs.getBoolean("permissionsAsked", false)) return
        val wanted = buildList {
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        prefs.edit { putBoolean("permissionsAsked", true) }
        if (wanted.isNotEmpty()) permissions.launch(wanted.toTypedArray())
    }
}
