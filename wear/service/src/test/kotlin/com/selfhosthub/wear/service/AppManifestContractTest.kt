package com.selfhosthub.wear.service

import com.selfhosthub.wear.core.UpdateProtocol
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Things that no JVM test can exercise, because they only matter on a real watch with a release build, and that were
 * each found by looking at a built APK rather than by a failing test; and the rule that the watch only ever talks to
 * the phone app (and Navidrome), never to the PC. They are pinned here so that a later edit cannot quietly undo them.
 */
class AppManifestContractTest {
    private val app = File("../app/src/main")
    private val service = File("../service/src/main")

    private fun read(root: File, path: String): String {
        val file = File(root, path)
        assumeTrue("the module is next to this one", file.isFile)
        return file.readText()
    }

    @Test
    fun `the app may use plain http for a Navidrome at home`() {
        // Without it, Android 9 and later refuse every connection to a Navidrome at an http:// address.
        assertTrue(read(app, "AndroidManifest.xml").contains("""android:usesCleartextTraffic="true""""))
    }

    @Test
    fun `the capability the phone looks for is declared and protected from the resource shrinker`() {
        assertTrue(read(app, "res/values/wear.xml").contains("""name="android_wear_capabilities""""))
        assertTrue(read(app, "res/values/wear.xml").contains("<item>selfhost_watch</item>"))
        // Nothing in the code refers to the array, so the release build would delete it without this.
        assertTrue(read(app, "res/raw/keep.xml").contains("""tools:keep="@array/android_wear_capabilities""""))
    }

    @Test
    fun `the app is a watch app that does not need the phone around`() {
        val manifest = read(app, "AndroidManifest.xml")
        assertTrue(manifest.contains("android.hardware.type.watch"))
        assertTrue(manifest.contains("com.google.android.wearable.standalone"))
    }

    @Test
    fun `the app has the phone app's package, which is what the data layer matches on`() {
        val gradle = File("../app/build.gradle.kts")
        assumeTrue(gradle.isFile)
        assertTrue(gradle.readText().contains("""applicationId = "com.selfhosthub.mobile""""))
    }

    @Test
    fun `workers keep their names across releases`() {
        val rules = File("../app/proguard-rules.pro")
        assumeTrue(rules.isFile)
        assertTrue(rules.readText().contains("-keepnames class * extends androidx.work.ListenableWorker"))
    }

    @Test
    fun `what the phone sends reaches the app even when it is closed`() {
        val manifest = read(service, "AndroidManifest.xml")
        assertTrue(manifest.contains("com.selfhosthub.wear.service.WatchListenerService"))
        assertTrue(manifest.contains("com.google.android.gms.wearable.MESSAGE_RECEIVED"))
        // Both the setup and the live link, the two paths the phone writes (see SetupProtocol and LinkProtocol).
        assertTrue(manifest.contains("""android:pathPrefix="/selfhost/setup""""))
        assertTrue(manifest.contains("""android:pathPrefix="/selfhost/link""""))
    }

    @Test
    fun `the phone can send an update, the channel is heard, the installer answers, and the new version announces itself`() {
        val manifest = read(service, "AndroidManifest.xml")
        // The permission an app needs to install an app (here, itself), and what it receives the file on.
        assertTrue(manifest.contains("android.permission.REQUEST_INSTALL_PACKAGES"))
        assertTrue(manifest.contains("com.google.android.gms.wearable.CHANNEL_EVENT"))
        assertTrue(manifest.contains("""android:pathPrefix="/selfhost/update""""))
        assertTrue(manifest.contains("com.selfhosthub.wear.service.update.InstallResultReceiver"))
        assertTrue(manifest.contains("android.intent.action.MY_PACKAGE_REPLACED"))
        // Not a boot receiver, and not reachable by other apps.
        assertFalse(Regex("""InstallResultReceiver"\s+android:exported="true"""").containsMatchIn(manifest))
        assertFalse(Regex("""PackageReplacedReceiver"\s+android:exported="true"""").containsMatchIn(manifest))
    }

    @Test
    fun `the paths the manifests listen on are the ones the protocol writes`() {
        assertEquals("/selfhost/update/apk", UpdateProtocol.APK_PATH)
        assertEquals("/selfhost/update/status", UpdateProtocol.STATUS_PATH)
        assertEquals("/selfhost/update", UpdateProtocol.PREFIX)
    }

    @Test
    fun `nothing keeps a connection open in the background`() {
        val manifest = read(service, "AndroidManifest.xml")
        assertFalse(manifest.contains("FOREGROUND_SERVICE"))
        assertFalse(manifest.contains("foregroundServiceType"))
        assertFalse(manifest.contains("BLUETOOTH"))
        assertFalse(manifest.contains("BOOT_COMPLETED"))
    }

    @Test
    fun `the watch never talks to the PC`() {
        // The phone is the only thing that does; the watch talks to the phone app and to Navidrome.
        val forbidden = listOf("WebSocket", "51823", "selfhosthub/ping", "ws://", "wss://", "HubClient", "proofFor", "pairing code")
        val roots = listOf("core", "data", "service", "ui", "app").map { File("../$it/src/main") }
        assumeTrue(roots.all { it.isDirectory })
        val offenders = roots.flatMap { root ->
            root.walkTopDown().filter { it.isFile && (it.extension == "kt" || it.extension == "xml") }.toList()
        }.flatMap { file ->
            val text = file.readText()
            forbidden.filter { text.contains(it) }.map { "${file.name}: $it" }
        }
        assertTrue("these files talk to the PC: $offenders", offenders.isEmpty())
    }
}
