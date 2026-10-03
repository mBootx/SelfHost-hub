package com.selfhosthub.wear.service.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import com.selfhosthub.wear.core.UpdateState
import com.selfhosthub.wear.service.Notifications
import com.selfhosthub.wear.service.watchGraph
import kotlinx.coroutines.launch

/**
 * Android's package installer answers here once the update was handed to it: it needs the person wearing the watch to
 * confirm (the first time, or whenever Android decides so), it failed, or it worked (the process is then replaced, so
 * that answer is rarely seen). What the phone should hear is sent to it.
 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val code = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val systemMessage = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        Log.i(TAG, "The installer answered $code ($systemMessage)")
        val status = InstallOutcomes.statusOf(code, systemMessage) ?: return
        if (status.state == UpdateState.CONFIRM) {
            // Android hands over the screen that asks for the confirmation; a notification is how it gets to the person
            // (a receiver in the background cannot open a screen by itself).
            confirmation(intent)?.let { Notifications.updateConfirm(context, it) }
        }
        val pending: PendingResult? = goAsync()
        val graph = context.watchGraph()
        graph.scope.launch {
            try {
                graph.updates.report(status)
            } finally {
                pending?.finish()
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun confirmation(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)

    companion object {
        const val ACTION = "com.selfhosthub.wear.action.INSTALL_RESULT"
        private const val TAG = "WatchUpdate"
    }
}

/**
 * The app was just replaced (by an update from the phone, or by anything else): the new version tells the phone which
 * one it is, which is how the phone learns that the update went through. It is not a boot receiver: it is only
 * started when this very app is replaced.
 */
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Notifications.cancel(context, Notifications.ID_UPDATE)
        val pending: PendingResult? = goAsync()
        val graph = context.watchGraph()
        graph.scope.launch {
            try {
                graph.updates.announceInstalled()
            } finally {
                pending?.finish()
            }
        }
    }
}
