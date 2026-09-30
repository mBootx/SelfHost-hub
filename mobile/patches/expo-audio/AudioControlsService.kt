package expo.modules.audio.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.app.NotificationCompat
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.MediaStyleNotificationHelper
import androidx.media3.session.SessionCommand
import expo.modules.audio.AudioLockScreenOptions
import expo.modules.audio.AudioPlayer
import expo.modules.audio.Metadata
import expo.modules.audio.getPlaybackServiceErrorMessage
import expo.modules.kotlin.AppContext
import java.lang.ref.WeakReference
import java.util.Collections
import java.util.WeakHashMap

/**
 * The lock screen / media notification / Samsung Now Bar side of expo-audio.
 *
 * This is a rewrite of the stock service, which rebuilt everything on each track change. That closed the
 * Now Bar on every skip and, worse, broke it for good: the old MediaSession was released but never
 * removed from the service, so adding its replacement (same default ID) threw "Session ID should be
 * unique" inside a coroutine, and the notification kept pointing at the released one.
 *
 * The rules here:
 *  - ONE MediaSession lives from the first track until the queue is cleared. Skipping, changing the
 *    metadata or handing over to the other deck (crossfade, gapless, a preloaded skip) never releases it:
 *    the session just gets the new player with [MediaSession.setPlayer], so the system keeps the same card.
 *  - ONE notification ID, so the foreground notification is updated in place, never replaced.
 *  - Everything runs on the main thread, in call order, and an error is logged instead of leaving the
 *    service half-updated.
 *  - The cover comes from [NowPlayingArtwork] and goes into the session as bytes as well as into the
 *    notification, and is already there when the track is published if it was loaded ahead.
 */
@OptIn(UnstableApi::class)
class AudioControlsService : MediaSessionService() {
  private lateinit var audioManager: AudioManager
  private val binder = AudioPlaybackServiceBinder(this)
  private val mainHandler = Handler(Looper.getMainLooper())

  private var mediaSession: MediaSession? = null
  private var currentPlayer: AudioPlayer? = null
  private var currentMetadata: Metadata? = null
  private var currentOptions: AudioLockScreenOptions? = null
  private var currentArt: NowPlayingArtwork.Art? = null

  /** What the session currently sees: [currentPlayer]'s ExoPlayer, with the metadata injected. */
  private var sessionPlayer: MetadataInjectingPlayer? = null
  private var sessionPlayerOwner: AudioPlayer? = null
  private var sessionPlayerIsLive = false

  private var listenerOwner: AudioPlayer? = null
  private var ownListener: Player.Listener? = null

  private var foregroundStarted = false
  private var lastForegroundFailureAt = -FOREGROUND_RETRY_MS
  /** What the media buttons were last set to, so an unchanged layout isn't pushed to the system again. */
  private var layoutKey: String? = null
  private var sessionCounter = 0
  private var destroyed = false
  private val basicSessionsReleased: MutableSet<AudioPlayer> = Collections.newSetFromMap(WeakHashMap<AudioPlayer, Boolean>())

  private var weakContext: WeakReference<AppContext>? = null
  var appContext: AppContext?
    get() = weakContext?.get()
    set(value) {
      weakContext = value?.let { WeakReference(it) }
    }

  var playsInSilentMode: Boolean = true

  /** Kept because [AudioPlaybackServiceConnection] clears it when the service disconnects. */
  var playbackListener: Player.Listener? = null

  // region Service lifecycle

  override fun onCreate() {
    super.onCreate()
    audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
    createNotificationChannelIfNeeded()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      if (mediaSession != null) {
        // Whoever started us (a deck binding, the notification's buttons) gets the current notification.
        updateNotification()
      } else if (intent?.action == Intent.ACTION_MEDIA_BUTTON) {
        // Started by a media key with nothing loaded: android insists on a notification, then it can go.
        startForegroundSafely(buildPlaceholderNotification())
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
      }
      handleAction(intent?.action)
    } catch (e: Exception) {
      report("Failed to handle a start command", e)
    }
    return super.onStartCommand(intent, flags, startId)
  }

  private fun handleAction(action: String?) {
    val exo = currentPlayer?.ref ?: return
    when (action) {
      ACTION_PLAY -> if (shouldPlayInSilentMode()) exo.play()
      ACTION_PAUSE -> exo.pause()
      ACTION_TOGGLE ->
        if (exo.isPlaying) {
          exo.pause()
        } else if (shouldPlayInSilentMode()) {
          exo.play()
        }
      ACTION_SEEK_FORWARD -> exo.seekTo(exo.currentPosition + SEEK_INTERVAL_MS)
      ACTION_SEEK_BACKWARD -> exo.seekTo(exo.currentPosition - SEEK_INTERVAL_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder {
    super.onBind(intent)
    return binder
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

  // Media3 says whether it wants the service in the foreground; it always is here once a session exists.
  override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
    if (session !== mediaSession) return
    try {
      updateNotification()
    } catch (e: Exception) {
      report("Failed to update the media notification", e)
    }
  }

  override fun onDestroy() {
    destroyed = true
    if (instance === this) instance = null
    try {
      detachPlayer()
      discardSession()
    } catch (e: Exception) {
      Log.w(TAG, "Failed to clean up the media session", e)
    }
    currentPlayer = null
    currentMetadata = null
    currentArt = null
    currentOptions = null
    sessionPlayer = null
    sessionPlayerOwner = null
    super.onDestroy()
  }

  // endregion

  // region Called by AudioPlayer / AudioPlaybackServiceConnection

  /** Makes [player] the one the lock screen shows, with this metadata. Calling it again just updates it. */
  fun setPlayerOptions(player: AudioPlayer, metadata: Metadata?, options: AudioLockScreenOptions?) {
    onMain { applyPlayer(player, metadata, options) }
  }

  fun setPlayerMetadata(player: AudioPlayer, metadata: Metadata?) {
    onMain {
      if (player === currentPlayer) applyMetadata(metadata)
    }
  }

  fun unregisterPlayer() {
    onMain { clearSession() }
  }

  /** Like [unregisterPlayer], but only if [player] is the one on the lock screen. */
  fun unregisterPlayer(player: AudioPlayer) {
    onMain {
      if (player === currentPlayer) clearSession()
    }
  }

  // endregion

  // region The session

  private fun applyPlayer(player: AudioPlayer, metadata: Metadata?, options: AudioLockScreenOptions?) {
    val previous = currentPlayer
    if (previous != null && previous !== player) previous.isActiveForLockScreen = false
    currentPlayer = player
    currentOptions = options
    player.isActiveForLockScreen = true

    // Title, artist and cover go in first: they have to be there when the session looks at the player.
    val wrapper = sessionPlayerFor(player, options)
    setMetadata(metadata, wrapper)

    val session = mediaSession
    if (session == null) {
      createSession(wrapper)
    } else if (session.player !== wrapper) {
      switchSessionPlayer(session, wrapper)
    }

    // The player's own basic session would only show the system a second copy of this one.
    releaseBasicSession(player)
    attachPlayerListener(player)
    updateSessionCustomLayout(player.ref.isPlaying)
    updateNotification()
    loadArtworkIfMissing()
  }

  private fun applyMetadata(metadata: Metadata?) {
    val wrapper = sessionPlayer ?: return
    setMetadata(metadata, wrapper)
    updateNotification()
    loadArtworkIfMissing()
  }

  /** Notes what is playing and hands it to [wrapper], with the cover if it is already in memory. */
  private fun setMetadata(metadata: Metadata?, wrapper: MetadataInjectingPlayer) {
    currentMetadata = metadata
    currentArt = metadata?.artworkUrl?.toString()?.let { NowPlayingArtwork.peek(it) }
    wrapper.updateMetadata(metadata, currentArt?.bytes)
  }

  private fun loadArtworkIfMissing() {
    if (currentArt != null) return
    val url = currentMetadata?.artworkUrl?.toString() ?: return
    NowPlayingArtwork.request(url) { art ->
      onMain {
        // Nothing to do if the queue moved on while the cover was downloading.
        if (art != null && currentMetadata?.artworkUrl?.toString() == url) {
          currentArt = art
          sessionPlayer?.updateMetadata(currentMetadata, art.bytes)
          updateNotification()
        }
      }
    }
  }

  private fun sessionPlayerFor(player: AudioPlayer, options: AudioLockScreenOptions?): MetadataInjectingPlayer {
    val live = options?.isLiveStream ?: player.isLive
    val existing = sessionPlayer
    if (existing != null && sessionPlayerOwner === player && sessionPlayerIsLive == live) return existing

    val created = MetadataInjectingPlayer(resolveSessionPlayer(player, live)) { toNext ->
      try {
        player.emit(REMOTE_COMMAND_EVENT, mapOf("command" to if (toNext) "next" else "previous"))
      } catch (e: Exception) {
        Log.w(TAG, "Failed to forward a skip to JavaScript", e)
      }
    }
    sessionPlayer = created
    sessionPlayerOwner = player
    sessionPlayerIsLive = live
    return created
  }

  private fun resolveSessionPlayer(player: AudioPlayer, isLive: Boolean): Player {
    if (!isLive) return player.ref

    return object : ForwardingPlayer(player.ref) {
      override fun getAvailableCommands(): Player.Commands {
        return super.getAvailableCommands().buildUpon()
          .remove(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
          .build()
      }
    }
  }

  private fun createSession(wrapper: MetadataInjectingPlayer) {
    val builder = MediaSession.Builder(this, wrapper).setCallback(AudioMediaSessionCallback())
    // Tapping the card opens the app.
    buildContentIntent()?.let { builder.setSessionActivity(it) }
    val session = try {
      builder.setId(SESSION_ID).build()
    } catch (e: IllegalStateException) {
      // A session with that ID is somehow still registered: use a fresh one rather than have none.
      builder.setId("${SESSION_ID}_${++sessionCounter}").build()
    }
    mediaSession = session
    layoutKey = null
    addSession(session)
  }

  /** Hands the existing session to another deck. The session, its ID and its notification stay as they are. */
  private fun switchSessionPlayer(session: MediaSession, wrapper: MetadataInjectingPlayer) {
    try {
      session.setPlayer(wrapper)
    } catch (e: RuntimeException) {
      report("Failed to hand the media session to the other player", e)
      // Playback controls matter more than continuity: start over with a session for this player.
      discardSession()
      foregroundStarted = false
      createSession(wrapper)
    }
  }

  private fun discardSession() {
    val session = mediaSession ?: return
    mediaSession = null
    layoutKey = null
    try {
      // Without this the service keeps the released session under its ID and refuses the next one.
      if (isSessionAdded(session)) removeSession(session)
    } catch (e: RuntimeException) {
      Log.w(TAG, "Failed to remove the media session from the service", e)
    }
    try {
      session.release()
    } catch (e: RuntimeException) {
      Log.w(TAG, "Failed to release the media session", e)
    }
  }

  private fun clearSession() {
    detachPlayer()
    currentPlayer?.isActiveForLockScreen = false
    currentPlayer = null
    currentMetadata = null
    currentArt = null
    currentOptions = null
    sessionPlayer = null
    sessionPlayerOwner = null
    discardSession()

    if (foregroundStarted) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      foregroundStarted = false
    }
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID)
  }

  private fun releaseBasicSession(player: AudioPlayer) {
    if (!basicSessionsReleased.add(player)) return
    try {
      player.mediaSession.release()
    } catch (e: RuntimeException) {
      Log.w(TAG, "Failed to release the player's basic media session", e)
    }
  }

  // endregion

  // region Player events

  private fun attachPlayerListener(player: AudioPlayer) {
    if (listenerOwner === player && ownListener != null) return
    detachPlayer()

    val listener = object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        updateSessionCustomLayout(isPlaying)
        updateNotification()
      }

      override fun onPlaybackStateChanged(playbackState: Int) {
        updateNotification()
      }
    }
    ownListener = listener
    listenerOwner = player
    playbackListener = listener
    player.ref.addListener(listener)
  }

  private fun detachPlayer() {
    val listener = ownListener
    val owner = listenerOwner
    ownListener = null
    listenerOwner = null
    playbackListener = null
    if (listener != null && owner != null) {
      try {
        owner.ref.removeListener(listener)
      } catch (e: RuntimeException) {
        Log.w(TAG, "Failed to remove the player listener", e)
      }
    }
  }

  // endregion

  // region Buttons

  private fun updateSessionCustomLayout(isPlaying: Boolean) {
    val session = mediaSession ?: return
    val showBackward = currentOptions?.showSeekBackward == true
    val showForward = currentOptions?.showSeekForward == true
    val key = "$isPlaying|$showBackward|$showForward"
    if (key == layoutKey) return
    layoutKey = key

    val mediaButtons = mutableListOf<CommandButton>()

    // Previous track takes the back slot so Samsung's Now Bar and the standard
    // media notification render a real skip control there.
    mediaButtons.add(
      CommandButton.Builder(CommandButton.ICON_PREVIOUS)
        .setDisplayName("Previous")
        .setEnabled(true)
        .setPlayerCommand(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
        .setSlots(CommandButton.SLOT_BACK)
        .build()
    )

    // Seek buttons move to the overflow now that back/forward carry track skip.
    if (showBackward) {
      mediaButtons.add(
        CommandButton.Builder(CommandButton.ICON_SKIP_BACK_10)
          .setDisplayName("Seek Backward")
          .setEnabled(true)
          .setSessionCommand(SessionCommand(ACTION_SEEK_BACKWARD, Bundle.EMPTY))
          .setSlots(CommandButton.SLOT_OVERFLOW)
          .build()
      )
    }

    // Add play/pause button (always present)
    mediaButtons.add(
      CommandButton.Builder(if (isPlaying) CommandButton.ICON_PAUSE else CommandButton.ICON_PLAY)
        .setDisplayName(if (isPlaying) "Pause" else "Play")
        .setEnabled(true)
        .setPlayerCommand(Player.COMMAND_PLAY_PAUSE)
        .setSlots(CommandButton.SLOT_CENTRAL)
        .build()
    )

    if (showForward) {
      mediaButtons.add(
        CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_10)
          .setDisplayName("Seek Forward")
          .setEnabled(true)
          .setSessionCommand(SessionCommand(ACTION_SEEK_FORWARD, Bundle.EMPTY))
          .setSlots(CommandButton.SLOT_OVERFLOW)
          .build()
      )
    }

    mediaButtons.add(
      CommandButton.Builder(CommandButton.ICON_NEXT)
        .setDisplayName("Next")
        .setEnabled(true)
        .setPlayerCommand(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
        .setSlots(CommandButton.SLOT_FORWARD)
        .build()
    )

    session.setCustomLayout(mediaButtons)
    session.setMediaButtonPreferences(mediaButtons)
  }

  // endregion

  // region Notification

  private fun createNotificationChannelIfNeeded() {
    val notificationManager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (notificationManager.getNotificationChannel(CHANNEL_ID) == null) {
        notificationManager.createNotificationChannel(
          NotificationChannel(
            CHANNEL_ID,
            CHANNEL_ID,
            NotificationManager.IMPORTANCE_LOW
          )
        )
      }
    }
  }

  private fun shouldPlayInSilentMode(): Boolean {
    return playsInSilentMode || audioManager.ringerMode == AudioManager.RINGER_MODE_NORMAL
  }

  private fun buildContentIntent(): PendingIntent? {
    val appIntent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(
      this,
      0,
      appIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun buildActionPendingIntent(action: String): PendingIntent {
    val intent = Intent(this, AudioControlsService::class.java).setAction(action)
    return PendingIntent.getService(
      this,
      action.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun buildPlaceholderNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(androidx.media3.session.R.drawable.media3_icon_circular_play)
      .setContentTitle("‎")
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setSilent(true)
      .setShowWhen(false)
      .build()

  private fun buildNotification(): Notification? {
    val session = mediaSession ?: return null

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(androidx.media3.session.R.drawable.media3_icon_circular_play)
      // If the title is null or empty string android sets the notification to "<AppName> is running..." we want to keep the notification empty so we ‎ to keep the text empty.
      .setContentTitle(currentMetadata?.title ?: "‎")
      .setContentText(currentMetadata?.artist)
      .setSubText(currentMetadata?.albumTitle)
      // The same cover the session carries: older Android and some launchers only look here.
      .setLargeIcon(currentArt?.bitmap)
      .setContentIntent(buildContentIntent())
      .setAutoCancel(false)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)

    val style = MediaStyleNotificationHelper.MediaStyle(session)

    // Older Android system UI expects explicit notification actions for transport controls.
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
      val compactViewIndices = mutableListOf<Int>()
      var currentIndex = 0

      if (currentOptions?.showSeekBackward == true) {
        builder.addAction(
          NotificationCompat.Action(
            androidx.media3.session.R.drawable.media3_icon_skip_back,
            "Seek Backward",
            buildActionPendingIntent(ACTION_SEEK_BACKWARD)
          )
        )
        compactViewIndices.add(currentIndex)
        currentIndex++
      }

      builder.addAction(
        NotificationCompat.Action(
          if (session.player.isPlaying) {
            androidx.media3.session.R.drawable.media3_icon_pause
          } else {
            androidx.media3.session.R.drawable.media3_icon_play
          },
          if (session.player.isPlaying) "Pause" else "Play",
          buildActionPendingIntent(if (session.player.isPlaying) ACTION_PAUSE else ACTION_PLAY)
        )
      )
      compactViewIndices.add(currentIndex)
      currentIndex++

      if (currentOptions?.showSeekForward == true) {
        builder.addAction(
          NotificationCompat.Action(
            androidx.media3.session.R.drawable.media3_icon_skip_forward,
            "Seek Forward",
            buildActionPendingIntent(ACTION_SEEK_FORWARD)
          )
        )
        compactViewIndices.add(currentIndex)
      }

      style.setShowActionsInCompactView(*compactViewIndices.toIntArray())
    }

    builder.setStyle(style)
    return builder.build()
  }

  /**
   * Shows the current notification. It always has the same ID, so the foreground notification is updated
   * in place. The first one also puts the service in the foreground, where it then stays (paused too, so
   * the Now Bar remains and Android doesn't stop the app) until the queue is cleared.
   */
  private fun updateNotification() {
    val notification = buildNotification() ?: return
    if (foregroundStarted) {
      postNotification(notification)
    } else {
      startForegroundSafely(notification)
    }
  }

  private fun postNotification(notification: Notification) {
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification)
  }

  private fun startForegroundSafely(notification: Notification) {
    // Android refused a moment ago: don't hammer it (and the log) on every player event.
    val now = SystemClock.elapsedRealtime()
    if (now - lastForegroundFailureAt < FOREGROUND_RETRY_MS) {
      postNotification(notification)
      return
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      foregroundStarted = true
    } catch (e: Exception) {
      // Android can refuse while the app is in the background; the notification is still worth showing.
      lastForegroundFailureAt = now
      report("Failed to promote the expo-audio playback service to foreground", e)
      postNotification(notification)
    }
  }

  // endregion

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      runGuarded(block)
    } else {
      mainHandler.post { runGuarded(block) }
    }
  }

  private fun runGuarded(block: () -> Unit) {
    if (destroyed) return
    try {
      block()
    } catch (e: Exception) {
      report("Failed to update the lock screen controls", e)
    }
  }

  private fun report(message: String, error: Throwable) {
    Log.e(TAG, message, error)
    try {
      appContext?.jsLogger?.error(getPlaybackServiceErrorMessage(message), error)
    } catch (e: Exception) {
      // Nothing more to do: it's in logcat.
    }
  }

  companion object {
    private const val TAG = "AudioControlsService"
    private const val CHANNEL_ID = "expo_audio_channel"
    /** A fixed ID keeps the foreground notification in one place across tracks and players. */
    private const val NOTIFICATION_ID = 0x5EAF
    private const val SESSION_ID = "selfhost_now_playing"
    private const val FOREGROUND_RETRY_MS = 5_000L
    private const val ACTION_PLAY = "expo.modules.audio.action.PLAY"
    private const val ACTION_PAUSE = "expo.modules.audio.action.PAUSE"
    private const val ACTION_TOGGLE = "expo.modules.audio.action.TOGGLE"

    const val ACTION_SEEK_FORWARD = "expo.modules.audio.action.SEEK_FORWARD"
    const val ACTION_SEEK_BACKWARD = "expo.modules.audio.action.SEEK_BACKWARD"

    /** Shared object event the JS player listens on for lock screen skip presses. */
    const val REMOTE_COMMAND_EVENT = "remoteCommand"

    const val SEEK_INTERVAL_MS = 10000L

    /**
     * The running service, if any. Lets a player hand the lock screen over to itself directly instead of
     * binding first, which would leave the previous player on the Now Bar for a moment.
     */
    @Volatile
    var instance: AudioControlsService? = null
      private set
  }
}
