package com.selfhosthub.wear.service.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.os.StatFs
import com.selfhosthub.wear.core.AppVersion
import java.io.File
import java.security.MessageDigest

/** The real thing: Android's package manager and package installer. */
class AndroidUpdateHost(context: Context) : UpdateHost {
    private val context = context.applicationContext
    private val packages = this.context.packageManager

    override val packageName: String = this.context.packageName

    override val installed: AppVersion
        get() {
            val info = packages.getPackageInfo(packageName, 0)
            return AppVersion(info.versionName ?: "0.0.0", info.longVersionCode)
        }

    override fun mayInstall(): Boolean = packages.canRequestPackageInstalls()

    override fun freeBytes(): Long =
        try {
            StatFs(context.cacheDir.path).availableBytes
        } catch (_: Exception) {
            0L
        }

    override val workDir: File get() = File(context.cacheDir, "update")

    @Suppress("DEPRECATION")
    override fun inspect(apk: File): ApkInfo? {
        val info = packages.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: return null
        return ApkInfo(info.packageName ?: return null, info.versionName, info.longVersionCode, signersOf(info))
    }

    @Suppress("DEPRECATION")
    override fun ownSigners(): Set<String> = signersOf(packages.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES))

    private fun signersOf(info: PackageInfo): Set<String> {
        val signers = info.signingInfo?.apkContentsSigners ?: return emptySet()
        return signers.map { signer -> MessageDigest.getInstance("SHA-256").digest(signer.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
    }

    /**
     * Copies the file into a package installer session and commits it. The answer comes later, to InstallResultReceiver:
     * either Android asks the person wearing the watch to confirm (a notification), or it goes through (the first time
     * Android always asks; from the next ones, an app that installed itself may update itself without being asked), or
     * it fails. When it succeeds the app is replaced: this process ends, and the new one announces itself (see
     * PackageReplacedReceiver).
     */
    override fun install(apk: File) {
        val installer = packages.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("update.apk", 0, apk.length()).use { out ->
                        input.copyTo(out)
                        session.fsync(out)
                    }
                }
                // The system adds the status to this intent, so it has to be mutable; it names its receiver, so it cannot be hijacked.
                val result = Intent(context, InstallResultReceiver::class.java).setAction(InstallResultReceiver.ACTION)
                val pending = PendingIntent.getBroadcast(context, id, result, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(id) }
            throw e
        }
    }
}
