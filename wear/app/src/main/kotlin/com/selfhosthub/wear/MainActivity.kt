package com.selfhosthub.wear

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.wear.ambient.AmbientLifecycleObserver
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.WatchGraphProvider
import com.selfhosthub.wear.service.link.LinkLeases
import com.selfhosthub.wear.service.update.PendingConfirm
import com.selfhosthub.wear.ui.WatchApp
import com.selfhosthub.wear.ui.common.AmbientState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val ambient = MutableStateFlow(AmbientState())
    /** Grows each time the app is opened again for the player (the phone opening it when music starts). */
    private val playerRequests = MutableStateFlow(0)
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
        showUpdateConfirmations()

        setContent {
            val state by ambient.collectAsStateWithLifecycle()
            val requests by playerRequests.collectAsStateWithLifecycle()
            WatchApp(graph, state, BuildConfig.VERSION_NAME, requests)
        }
        refreshLibrary()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.data?.toString()?.startsWith(LinkProtocol.OPEN_URI) == true) playerRequests.update { it + 1 }
    }

    override fun onStart() {
        super.onStart()
        // The screen is up: staying in touch with the phone (asking how the players are) is wanted for as long as it is.
        lease = graph.linkLeases.acquire()
        graph.appVisible = true
        refreshLibrary()
    }

    /** Opening the app reads the library again when it is old, or never came (the hourly job is not the only chance). */
    private fun refreshLibrary() {
        val graph = graph
        graph.scope.launch { graph.refreshLibraryIfDue() }
    }

    override fun onStop() {
        lease?.close()
        lease = null
        graph.appVisible = false
        super.onStop()
    }

    /**
     * While the app is in front, the installer's "confirm this update" screen is shown as soon as there is one (see
     * PendingConfirm): from a notification nobody saw, or because the phone opened the app for it.
     */
    private fun showUpdateConfirmations() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                PendingConfirm.intent.filterNotNull().collect {
                    val confirm = PendingConfirm.take() ?: return@collect
                    try {
                        startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (e: Exception) {
                        Log.w("WatchUpdate", "Could not show the update confirmation: ${e.message}")
                    }
                }
            }
        }
    }

    /**
     * The notification permission (the chip with the music playing, the update confirmation) is asked for once per
     * version of the app while it is not granted, not at every launch: one refusal must not hide every later update.
     */
    private fun askForPermissionsOnce() {
        val prefs = getSharedPreferences("selfhost_wear_ui", MODE_PRIVATE)
        if (prefs.getLong("permissionsAskedFor", -1L) == BuildConfig.VERSION_CODE.toLong()) return
        val wanted = buildList {
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        prefs.edit { putLong("permissionsAskedFor", BuildConfig.VERSION_CODE.toLong()) }
        if (wanted.isNotEmpty()) permissions.launch(wanted.toTypedArray())
    }
}
