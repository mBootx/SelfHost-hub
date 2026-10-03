package com.selfhosthub.wear.service.update

import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.test.core.app.ApplicationProvider
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.selfhosthub.wear.core.AppVersion
import com.selfhosthub.wear.core.UpdateProtocol
import com.selfhosthub.wear.service.Notifications
import com.selfhosthub.wear.service.TestApplication
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApplication::class)
class UpdateReceiversTest {
    private val app: TestApplication get() = ApplicationProvider.getApplicationContext()

    private fun told(): List<JsonObject> = app.transport.sent.filter { it.path == UpdateProtocol.STATUS_PATH }.map { JsonParser.parseString(it.text).asJsonObject }

    /** The receivers hand their work to the app's scope: wait for the phone to have been told. */
    private fun waitForPhone(count: Int = 1): List<JsonObject> {
        val deadline = System.currentTimeMillis() + 5_000
        while (told().size < count && System.currentTimeMillis() < deadline) Thread.sleep(20)
        return told()
    }

    private fun installResult(status: Int, message: String? = null, confirm: Intent? = null) =
        Intent(InstallResultReceiver.ACTION).putExtra(PackageInstaller.EXTRA_STATUS, status).apply {
            if (message != null) putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, message)
            if (confirm != null) putExtra(Intent.EXTRA_INTENT, confirm)
        }

    private fun notifications(): List<Notification> = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications

    @Test
    fun `when Android asks for a confirmation a notification takes it to the wrist, and the phone is told`() {
        InstallResultReceiver().onReceive(app, installResult(PackageInstaller.STATUS_PENDING_USER_ACTION, confirm = Intent(Intent.ACTION_VIEW)))
        val said = waitForPhone()
        assertEquals("confirm", said.single()["state"].asString)
        val note = notifications().single()
        assertEquals(app.getString(com.selfhosthub.wear.service.R.string.update_confirm_title), note.extras.getString(Notification.EXTRA_TITLE))
        assertNotNull("a tap opens the screen of the installer", note.contentIntent)
        assertEquals(Notifications.CHANNEL_UPDATE, note.channelId)
    }

    @Test
    fun `an installation that failed is told to the phone with what went wrong`() {
        InstallResultReceiver().onReceive(app, installResult(PackageInstaller.STATUS_FAILURE_BLOCKED, "INSTALL_FAILED_USER_RESTRICTED"))
        val said = waitForPhone().single()
        assertEquals("failed", said["state"].asString)
        assertTrue(said["message"].asString.contains("INSTALL_FAILED_USER_RESTRICTED"))
        assertTrue("nothing to confirm", notifications().isEmpty())
    }

    @Test
    fun `an installation that worked says nothing, the new version announces itself`() {
        InstallResultReceiver().onReceive(app, installResult(PackageInstaller.STATUS_SUCCESS))
        Thread.sleep(300)
        assertTrue(told().isEmpty())
    }

    @Test
    fun `another intent is ignored`() {
        InstallResultReceiver().onReceive(app, Intent("something.else").putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE))
        Thread.sleep(300)
        assertTrue(told().isEmpty())
    }

    @Test
    fun `an app that was just replaced tells the phone which version it is, and withdraws the notification of the update`() {
        app.updateHost.installed = AppVersion("2.5.2", 20502)
        Notifications.updateConfirm(app, Intent(Intent.ACTION_VIEW))
        assertEquals(1, notifications().size)

        PackageReplacedReceiver().onReceive(app, Intent(Intent.ACTION_MY_PACKAGE_REPLACED))
        val said = waitForPhone().single()
        assertEquals("installed", said["state"].asString)
        assertEquals("2.5.2", said["versionName"].asString)
        assertEquals(20502L, said["versionCode"].asLong)
        assertTrue(notifications().isEmpty())
    }

    @Test
    fun `nothing else that reaches that receiver is taken for a replacement`() {
        PackageReplacedReceiver().onReceive(app, Intent(Intent.ACTION_BOOT_COMPLETED))
        Thread.sleep(300)
        assertNull(told().firstOrNull())
    }

    @Test
    fun `the phone that went away does not make the report throw`() {
        app.transport.nodes = emptyList()
        app.transport.nodesError = IllegalStateException("no data layer")
        kotlinx.coroutines.runBlocking { app.watchUpdates.announceInstalled() }
        app.transport.nodesError = null
        app.transport.sendError = IllegalStateException("gone")
        kotlinx.coroutines.runBlocking { app.watchUpdates.announceInstalled() }
        assertTrue(told().isEmpty())
    }

    @Test
    fun `what the installer says maps to what the phone is told`() {
        assertNull(InstallOutcomes.statusOf(PackageInstaller.STATUS_SUCCESS, null))
        for (code in listOf(
            PackageInstaller.STATUS_FAILURE,
            PackageInstaller.STATUS_FAILURE_ABORTED,
            PackageInstaller.STATUS_FAILURE_BLOCKED,
            PackageInstaller.STATUS_FAILURE_CONFLICT,
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE,
            PackageInstaller.STATUS_FAILURE_INVALID,
            PackageInstaller.STATUS_FAILURE_STORAGE
        )) {
            val status = InstallOutcomes.statusOf(code, "détail")!!
            assertEquals("$code", "failed", status.state.wire)
            assertTrue("$code", status.message!!.contains("détail"))
        }
        assertEquals("confirm", InstallOutcomes.statusOf(PackageInstaller.STATUS_PENDING_USER_ACTION, null)!!.state.wire)
    }
}
