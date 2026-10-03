package com.selfhosthub.wear.service.update

import com.selfhosthub.wear.core.AppVersion
import com.selfhosthub.wear.core.UpdateCodec
import com.selfhosthub.wear.core.UpdateFormatException
import com.selfhosthub.wear.core.UpdateHeader
import com.selfhosthub.wear.core.UpdatePolicy
import com.selfhosthub.wear.core.UpdateProtocol
import com.selfhosthub.wear.core.UpdateRefusal
import com.selfhosthub.wear.core.UpdateState
import com.selfhosthub.wear.core.UpdateStatus
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/** What an APK file says about itself, read without installing it. `signers` are SHA-256 digests of the certificates, in hex. */
data class ApkInfo(val packageName: String, val versionName: String?, val versionCode: Long, val signers: Set<String>)

/** What the update needs from the watch: Android's answers in the app, stand-ins in the tests. */
interface UpdateHost {
    val packageName: String

    /** The version of the app that is running. */
    val installed: AppVersion

    /** Whether Android lets this app install apps ("install unknown apps"). */
    fun mayInstall(): Boolean

    fun freeBytes(): Long

    /** Where the file is kept while it is received and handed over. */
    val workDir: File

    /** What the APK says about itself, or null when it is not a readable APK. */
    fun inspect(apk: File): ApkInfo?

    /** The certificates this app is signed with. */
    fun ownSigners(): Set<String>

    /** Hands the file to Android's package installer, which tells how it went later (see InstallResultReceiver). Throws if it cannot. */
    fun install(apk: File)
}

/**
 * Takes in an update the phone sends over a data layer channel (see UpdateProtocol): a header line, then the APK. The
 * header is checked against what the watch has and may do before a byte of the file is kept; the file is checked against
 * the header (size, SHA-256) and against its own manifest and signature before the installer is asked to install it.
 * Each step the phone should hear about is reported. Blocking: it runs on the data layer's worker thread.
 */
class UpdateReceiver(private val host: UpdateHost, private val report: (UpdateStatus) -> Unit) {
    private val receiving = AtomicBoolean(false)

    fun receive(input: InputStream) {
        if (!receiving.compareAndSet(false, true)) {
            report(UpdateStatus(UpdateState.REFUSED, reason = UpdateRefusal.BUSY, message = "Une mise à jour est déjà en cours sur la montre"))
            return
        }
        try {
            handle(input.buffered(BUFFER))
        } catch (e: Exception) {
            // The channel closed under the transfer (the phone went away), or the watch could not keep the file.
            val what = if (e is IOException) "Transfert interrompu" else "Mise à jour impossible"
            report(UpdateStatus(UpdateState.FAILED, message = "$what : ${e.message ?: e.javaClass.simpleName}"))
        } finally {
            receiving.set(false)
            clean()
        }
    }

    private fun handle(input: InputStream) {
        clean()
        val line = readHeaderLine(input)
        if (line == null) {
            report(UpdateStatus(UpdateState.REFUSED, reason = UpdateRefusal.BAD_HEADER, message = "En-tête de mise à jour illisible"))
            return
        }
        val header = try {
            UpdateCodec.decodeHeader(line)
        } catch (e: UpdateFormatException) {
            report(UpdateStatus(UpdateState.REFUSED, reason = UpdateRefusal.BAD_HEADER, message = e.message))
            return
        }
        val refusal = UpdatePolicy.refusal(header, host.installed.code, host.freeBytes(), host.mayInstall())
        if (refusal != null) {
            report(UpdateStatus(UpdateState.REFUSED, header.versionName, header.versionCode, refusal, refusalText(refusal, header)))
            return
        }

        val apk = keep(input, header) ?: return
        val problem = check(apk, header)
        if (problem != null) {
            apk.delete()
            report(failed(header, problem))
            return
        }
        report(UpdateStatus(UpdateState.RECEIVED, header.versionName, header.versionCode))
        try {
            host.install(apk)
        } catch (e: Exception) {
            report(failed(header, "L’installation n’a pas pu démarrer : ${e.message ?: e.javaClass.simpleName}"))
        }
        // The installer works from its own copy, made before this returns.
    }

    /** The bytes after the header, kept in a file and checked against the header. Null (already reported) when they are not what was announced. */
    private fun keep(input: InputStream, header: UpdateHeader): File? {
        val dir = host.workDir
        dir.mkdirs()
        val part = File(dir, PART)
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        part.outputStream().use { out ->
            val buffer = ByteArray(BUFFER)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > header.size) {
                    part.delete()
                    report(failed(header, "Plus de données reçues que annoncé"))
                    return null
                }
                digest.update(buffer, 0, read)
                out.write(buffer, 0, read)
            }
        }
        if (total != header.size) {
            part.delete()
            report(failed(header, "Transfert incomplet ($total octets sur ${header.size})"))
            return null
        }
        if (toHex(digest.digest()) != header.sha256) {
            part.delete()
            report(failed(header, "Fichier endommagé pendant le transfert"))
            return null
        }
        val apk = File(dir, "SelfHost-Hub-Watch-${header.versionName}.apk")
        apk.delete()
        if (!part.renameTo(apk)) {
            part.delete()
            report(failed(header, "Fichier impossible à enregistrer sur la montre"))
            return null
        }
        return apk
    }

    /** What is wrong with the file, or null: it must be this app, the version that was announced, signed by the same key. */
    private fun check(apk: File, header: UpdateHeader): String? {
        val info = host.inspect(apk) ?: return "Ce fichier n’est pas une application lisible"
        if (info.packageName != host.packageName) return "Ce n’est pas l’application SelfHost Hub pour montre"
        if (info.versionCode != header.versionCode || info.versionName != header.versionName) return "La version du fichier n’est pas celle annoncée"
        val own = host.ownSigners()
        if (own.isEmpty() || info.signers != own) return "Le fichier n’est pas signé avec la même clé que l’application installée"
        return null
    }

    private fun readHeaderLine(input: InputStream): String? {
        val bytes = ByteArrayOutputStream()
        while (bytes.size() <= UpdateProtocol.MAX_HEADER_BYTES) {
            val next = input.read()
            if (next < 0) return null
            if (next == '\n'.code) return bytes.toString(Charsets.UTF_8.name())
            bytes.write(next)
        }
        return null
    }

    private fun refusalText(refusal: UpdateRefusal, header: UpdateHeader): String = when (refusal) {
        UpdateRefusal.UP_TO_DATE -> "La montre a déjà la version ${host.installed.name} (envoyée : ${header.versionName})"
        UpdateRefusal.NOT_ALLOWED -> "L’application n’a pas le droit d’installer des applications sur la montre"
        UpdateRefusal.NO_SPACE -> "Pas assez de place sur la montre"
        UpdateRefusal.BAD_HEADER -> "En-tête de mise à jour illisible"
        UpdateRefusal.BUSY -> "Une mise à jour est déjà en cours sur la montre"
    }

    private fun failed(header: UpdateHeader, message: String) = UpdateStatus(UpdateState.FAILED, header.versionName, header.versionCode, message = message)

    /** Leftovers of an earlier update: they only take room. */
    private fun clean() {
        host.workDir.listFiles()?.forEach { if (it.isFile) it.delete() }
    }

    private fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    private companion object {
        const val PART = "update.apk.part"
        const val BUFFER = 32 * 1024
    }
}
