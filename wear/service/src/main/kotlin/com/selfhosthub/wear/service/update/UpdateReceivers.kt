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
        var status = InstallOutcomes.statusOf(code, systemMessage) ?: return
        // Android hands over the screen that asks for the confirmation. A receiver in the background cannot open a
        // screen by itself: it is kept for the app's activity, announced by a notification when notifications are on,
        // and the phone is asked to open the app on the watch, which then shows it straight away.
        val confirm = if (status.state == UpdateState.CONFIRM) confirmation(intent) else null
        if (confirm != null) {
            PendingConfirm.offer(confirm)
            if (!Notifications.updateConfirm(context, confirm)) {
                Log.w(TAG, "Notifications are off: the confirmation is only shown when the app is opened")
                status = status.copy(message = NO_NOTIFICATION)
            }
        }
        val pending: PendingResult? = goAsync()
        val graph = context.watchGraph()
        graph.scope.launch {
            try {
                graph.updates.report(status)
                if (confirm != null) graph.updates.askPhoneToOpenApp()
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
        const val NO_NOTIFICATION =
            "Les notifications de SelfHost Hub sont désactivées sur la montre : ouvrez l’application sur la montre pour confirmer la mise à jour"
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
        PendingConfirm.clear()
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
