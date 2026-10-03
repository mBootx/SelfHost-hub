package com.selfhosthub.wear.service.update

import com.selfhosthub.wear.core.AppVersion
import com.selfhosthub.wear.core.UpdateCodec
import com.selfhosthub.wear.core.UpdateHeader
import com.selfhosthub.wear.core.UpdateRefusal
import com.selfhosthub.wear.core.UpdateState
import com.selfhosthub.wear.core.UpdateStatus
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A watch for the update to land on: what Android would answer, and what the installer was given. */
class FakeUpdateHost(override val workDir: File) : UpdateHost {
    override val packageName = "com.selfhosthub.mobile"
    override var installed = AppVersion("2.5.0", 20500)
    var allowed = true
    var free = 100L * 1024 * 1024
    var signers = setOf("aa11")

    /** What any APK file says about itself (null: not a readable APK). */
    var apkInfo: ApkInfo? = ApkInfo("com.selfhosthub.mobile", "2.5.2", 20502, setOf("aa11"))
    var installError: Exception? = null

    /** The bytes the installer was handed, and how many times. */
    var installedBytes: ByteArray? = null
    var installs = 0

    override fun mayInstall() = allowed
    override fun freeBytes() = free
    override fun inspect(apk: File): ApkInfo? = apkInfo
    override fun ownSigners() = signers

    override fun install(apk: File) {
        installError?.let { throw it }
        installs++
        installedBytes = apk.readBytes()
    }
}

class UpdateReceiverTest {
    private lateinit var dir: File
    private lateinit var host: FakeUpdateHost
    private val reports = ArrayList<UpdateStatus>()
    private lateinit var receiver: UpdateReceiver

    private val apk = ByteArray(10_000) { (it * 31 % 251).toByte() }

    @Before
    fun start() {
        dir = Files.createTempDirectory("update-test").toFile()
        host = FakeUpdateHost(File(dir, "update"))
        receiver = UpdateReceiver(host) { synchronized(reports) { reports += it } }
    }

    @After
    fun stop() {
        dir.deleteRecursively()
    }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun header(
        bytes: ByteArray = apk,
        name: String = "2.5.2",
        code: Long = 20502,
        size: Long = bytes.size.toLong(),
        sha: String = sha(bytes),
        reinstall: Boolean = false
    ) = UpdateCodec.header(UpdateHeader(name, code, size, sha, reinstall))

    private fun stream(header: String = header(), body: ByteArray = apk): InputStream = ByteArrayInputStream((header + "\n").toByteArray() + body)

    private fun states() = reports.map { it.state }

    @Test
    fun `an update that is newer, whole and signed by the same key is received and handed to the installer`() {
        receiver.receive(stream())
        assertEquals(listOf(UpdateState.RECEIVED), states())
        assertEquals("2.5.2", reports[0].versionName)
        assertEquals(20502L, reports[0].versionCode)
        assertArrayEquals(apk, host.installedBytes)
        assertEquals(1, host.installs)
    }

    @Test
    fun `nothing is left on the watch afterwards`() {
        receiver.receive(stream())
        assertTrue(host.workDir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun `the version the watch has, or a newer one, is refused before anything is kept`() {
        for (code in listOf(20500L, 20400L)) {
            reports.clear()
            receiver.receive(stream(header(code = code, name = "2.5.0")))
            assertEquals(listOf(UpdateState.REFUSED), states())
            assertEquals(UpdateRefusal.UP_TO_DATE, reports[0].reason)
        }
        assertEquals(0, host.installs)
        assertTrue(host.workDir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun `the same version is taken again when a reinstall was asked for`() {
        host.apkInfo = ApkInfo("com.selfhosthub.mobile", "2.5.0", 20500, setOf("aa11"))
        receiver.receive(stream(header(code = 20500, name = "2.5.0", reinstall = true)))
        assertEquals(listOf(UpdateState.RECEIVED), states())
        assertEquals(1, host.installs)
    }

    @Test
    fun `without the right to install apps it is refused before the transfer, and says why`() {
        host.allowed = false
        receiver.receive(stream())
        assertEquals(listOf(UpdateState.REFUSED), states())
        assertEquals(UpdateRefusal.NOT_ALLOWED, reports[0].reason)
        assertEquals(0, host.installs)
    }

    @Test
    fun `a watch with no room refuses it`() {
        host.free = 5_000
        receiver.receive(stream())
        assertEquals(UpdateRefusal.NO_SPACE, reports.single().reason)
    }

    @Test
    fun `a header that is not one of ours is refused`() {
        val longLine = "x".repeat(2_000)
        val bad = listOf(
            stream("not json"),
            stream("[1,2]"),
            stream("""{"v":2,"versionName":"2.5.2","versionCode":20502,"size":10,"sha256":"${sha(apk)}"}"""),
            stream("""{"v":1,"versionName":"two","versionCode":20502,"size":10,"sha256":"${sha(apk)}"}"""),
            stream("""{"v":1,"versionName":"2.5.2","versionCode":20502,"size":0,"sha256":"${sha(apk)}"}"""),
            stream("""{"v":1,"versionName":"2.5.2","versionCode":20502,"size":99999999999,"sha256":"${sha(apk)}"}"""),
            stream("""{"v":1,"versionName":"2.5.2","versionCode":20502,"size":10,"sha256":"abc"}"""),
            stream(longLine),
            // A header that is right in every field, but too long to be one of ours.
            stream("""{"v":1,"versionName":"2.5.2","versionCode":20502,"size":${apk.size},"sha256":"${sha(apk)}","pad":"${"x".repeat(2_000)}"}"""),
            ByteArrayInputStream(ByteArray(0)),
            ByteArrayInputStream("no newline at all".toByteArray())
        )
        for (input in bad) {
            reports.clear()
            receiver.receive(input)
            assertEquals(listOf(UpdateState.REFUSED), states())
            assertEquals(UpdateRefusal.BAD_HEADER, reports[0].reason)
        }
        assertEquals(0, host.installs)
    }

    @Test
    fun `a file that stops short is not installed`() {
        receiver.receive(stream(body = apk.copyOf(6_000)))
        assertEquals(listOf(UpdateState.FAILED), states())
        assertTrue(reports[0].message!!.contains("incomplet"))
        assertNull(host.installedBytes)
        assertTrue(host.workDir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun `a file with more bytes than announced is not installed`() {
        receiver.receive(stream(body = apk + ByteArray(50)))
        assertEquals(listOf(UpdateState.FAILED), states())
        assertTrue(reports[0].message!!.contains("Plus de données"))
        assertNull(host.installedBytes)
    }

    @Test
    fun `a file that changed on the way is not installed`() {
        val damaged = apk.copyOf().also { it[4_000] = (it[4_000] + 1).toByte() }
        receiver.receive(stream(body = damaged))
        assertEquals(listOf(UpdateState.FAILED), states())
        assertEquals("Fichier endommagé pendant le transfert", reports[0].message)
        assertNull(host.installedBytes)
    }

    @Test
    fun `a file that is not an app, or not this app, or not the version announced, or signed by another key, is not installed`() {
        val wrong = listOf(
            null,
            ApkInfo("com.example.other", "2.5.2", 20502, setOf("aa11")),
            ApkInfo("com.selfhosthub.mobile", "2.9.9", 20999, setOf("aa11")),
            ApkInfo("com.selfhosthub.mobile", "2.5.2", 20502, setOf("bb22")),
            ApkInfo("com.selfhosthub.mobile", "2.5.2", 20502, emptySet())
        )
        for (info in wrong) {
            reports.clear()
            host.apkInfo = info
            receiver.receive(stream())
            assertEquals("$info", listOf(UpdateState.FAILED), states())
        }
        assertEquals(0, host.installs)
        assertTrue(host.workDir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun `a watch that has no signature to compare with installs nothing`() {
        host.signers = emptySet()
        receiver.receive(stream())
        assertEquals(listOf(UpdateState.FAILED), states())
    }

    @Test
    fun `an installer that cannot start is reported`() {
        host.installError = IllegalStateException("no session")
        receiver.receive(stream())
        assertEquals(listOf(UpdateState.RECEIVED, UpdateState.FAILED), states())
        assertTrue(reports[1].message!!.contains("no session"))
    }

    @Test
    fun `a channel that breaks in the middle is reported, not thrown`() {
        val breaking = object : InputStream() {
            private val source = stream()
            private var count = 0
            override fun read(): Int = source.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (++count > 2) throw IOException("channel closed")
                return source.read(b, off, minOf(len, 3_000))
            }
        }
        receiver.receive(breaking)
        assertEquals(listOf(UpdateState.FAILED), states())
        assertTrue(reports[0].message!!.contains("channel closed"))
        assertTrue(host.workDir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun `a second update arriving while one is being received is turned away`() {
        val firstStarted = CountDownLatch(1)
        val release = CountDownLatch(1)
        val slow = object : InputStream() {
            private val source = stream()
            override fun read(): Int = source.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                firstStarted.countDown()
                release.await(5, TimeUnit.SECONDS)
                return source.read(b, off, len)
            }
        }
        val first = thread { receiver.receive(slow) }
        assertTrue(firstStarted.await(5, TimeUnit.SECONDS))
        receiver.receive(stream())
        release.countDown()
        first.join(5_000)
        assertEquals(UpdateRefusal.BUSY, reports.first { it.state == UpdateState.REFUSED }.reason)
        assertEquals(1, host.installs)
    }

    @Test
    fun `a file of a megabyte, read in many pieces, goes through the same way`() {
        val big = ByteArray(1_000_000) { it.toByte() }
        host.free = 100L * 1024 * 1024
        receiver.receive(stream(header(big), big))
        assertEquals(listOf(UpdateState.RECEIVED), states())
        assertNotNull(host.installedBytes)
    }
}
