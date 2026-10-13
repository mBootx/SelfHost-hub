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
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
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
 *  - This is the app's only media session: the decks no longer get expo-audio's "basic" session each
 *    (see AudioPlayer), which the system could pick instead, with no title and buttons that worked on a
 *    deck that wasn't playing.
 *  - Previous and next are standard skip actions, which every surface understands, and every press from
 *    outside the app (play and pause too) is reported to JavaScript as a `remoteCommand` event.
 *  - The notification is only posted again when what it shows changes: Android drops updates past about
 *    five a second, and a dropped one left the notification showing the previous song.
 *  - Swiping the app away from the recent apps doesn't stop the music.
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
  /** One wrapper per deck, kept, so handing the session back and forth doesn't build a new one each time. */
  private val sessionPlayers = WeakHashMap<AudioPlayer, MetadataInjectingPlayer>()

  private var listenerOwner: AudioPlayer? = null
  private var ownListener: Player.Listener? = null

  private var foregroundStarted = false
  private var lastForegroundFailureAt = -FOREGROUND_RETRY_MS
  /** What the media buttons were last set to, so an unchanged layout isn't pushed to the system again. */
  private var layoutKey: String? = null
  /** What the posted notification shows, so an identical one isn't posted again (see [updateNotification]). */
  private var notificationKey: List<Any?>? = null
  private var sessionCounter = 0
  private var destroyed = false

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
        // Whoever started us (a deck binding, the notification's buttons) gets the current notification. A media
        // key can start the service in the foreground (Android 11 and older), which must then be confirmed at once.
        updateNotification(force = intent?.action == Intent.ACTION_MEDIA_BUTTON)
      } else if (intent?.action == Intent.ACTION_MEDIA_BUTTON) {
        // Started by a media key with nothing loaded: android insists on a notification, then it can go.
        startForegroundSafely(buildPlaceholderNotification(), force = true)
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
      }
      handleAction(intent?.action)
    } catch (e: Exception) {
      report("Failed to handle a start command", e)
    }
    return super.onStartCommand(intent, flags, startId)
  }

  /** The notification's own buttons (Android 12 and older). They go through the session's player like any press. */
  private fun handleAction(action: String?) {
    val player = sessionPlayer ?: return
    when (action) {
      ACTION_PLAY -> if (shouldPlayInSilentMode()) player.play()
      ACTION_PAUSE -> player.pause()
      ACTION_TOGGLE ->
        if (player.playWhenReady) {
          player.pause()
        } else if (shouldPlayInSilentMode()) {
          player.play()
        }
      ACTION_SEEK_FORWARD -> player.seekTo(player.currentPosition + SEEK_INTERVAL_MS)
      ACTION_SEEK_BACKWARD -> player.seekTo(maxOf(0L, player.currentPosition - SEEK_INTERVAL_MS))
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

  /**
   * The app was swiped away from the recent apps. Media3 would pause the music and stop the service here, because it
   * judges "playback ongoing" by a foreground state only its own notification code sets, and this service posts its
   * own notification: so it always thought nothing was playing. The music and the Now Bar stay, as in any music app;
   * only a service with nothing to show goes.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    if (mediaSession == null) stopSelf()
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
    sessionPlayers.clear()
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
    val wrapper = sessionPlayerFor(player)
    sessionPlayer = wrapper
    setMetadata(metadata, wrapper)

    val session = mediaSession
    if (session == null) {
      createSession(wrapper)
    } else if (session.player !== wrapper) {
      switchSessionPlayer(session, wrapper)
    }

    attachPlayerListener(player)
    updateMediaButtons()
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

  /**
   * The deck as the session sees it. A live stream needs nothing special: ExoPlayer itself reports it unseekable and
   * Media3 then publishes no position. (The wrapper used to be rebuilt whenever the deck looked live or not, and a
   * deck still loading its source looked one way, then the other.)
   */
  private fun sessionPlayerFor(player: AudioPlayer): MetadataInjectingPlayer =
    sessionPlayers.getOrPut(player) {
      val deck = WeakReference(player)
      MetadataInjectingPlayer(player.ref) { command -> forwardRemoteCommand(deck.get(), command) }
    }

  /** A press from outside the app goes to JavaScript, from the deck the session holds (JS listens on both). */
  private fun forwardRemoteCommand(player: AudioPlayer?, command: String) {
    if (player == null) return
    try {
      player.emit(REMOTE_COMMAND_EVENT, mapOf("command" to command))
    } catch (e: Exception) {
      Log.w(TAG, "Failed to forward a $command press to JavaScript", e)
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
    discardSession()

    if (foregroundStarted) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      foregroundStarted = false
    }
    notificationKey = null
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID)
  }

  // endregion

  // region Player events

  private fun attachPlayerListener(player: AudioPlayer) {
    if (listenerOwner === player && ownListener != null) return
    detachPlayer()

    val listener = object : Player.Listener {
      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        updateNotification()
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
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

  /**
   * The extra buttons: +/-10 s in the overflow, when asked for. Previous, play/pause and next are not in this list
   * on purpose: left out, Media3 publishes them as the standard skip and play actions (the player claims the skip
   * commands, see MetadataInjectingPlayer), which the Now Bar, the lock screen, Bluetooth, cars and watches all
   * understand. Put in the back and forward slots here, Media3 turned them into custom actions instead, which only
   * some of those surfaces show or answer.
   */
  private fun updateMediaButtons() {
    val session = mediaSession ?: return
    val showBackward = currentOptions?.showSeekBackward == true
    val showForward = currentOptions?.showSeekForward == true
    val key = "$showBackward|$showForward"
    if (key == layoutKey) return
    layoutKey = key

    val mediaButtons = mutableListOf<CommandButton>()
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

      // From what the person asked for, not from isPlaying, which flickers off while the stream buffers.
      val showPlay = Util.shouldShowPlayButton(session.player)
      builder.addAction(
        NotificationCompat.Action(
          if (showPlay) {
            androidx.media3.session.R.drawable.media3_icon_play
          } else {
            androidx.media3.session.R.drawable.media3_icon_pause
          },
          if (showPlay) "Play" else "Pause",
          buildActionPendingIntent(if (showPlay) ACTION_PLAY else ACTION_PAUSE)
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
   *
   * It is only posted again when something it shows changed. Every player event lands here (from this service's
   * listener and from Media3's), several per track change, and Android drops a package's notification updates past
   * about five a second; a dropped last update left the previous song showing. The play state is part of what it
   * shows: it is the button on Android 12 and older, and posting again on play brings back a notification the
   * person swiped away while paused (Android 14 lets them).
   */
  private fun updateNotification(force: Boolean = false) {
    val session = mediaSession ?: return
    val key = listOf(
      System.identityHashCode(session),
      currentMetadata?.title,
      currentMetadata?.artist,
      currentMetadata?.albumTitle,
      currentArt?.let { System.identityHashCode(it) },
      currentOptions?.showSeekBackward,
      currentOptions?.showSeekForward,
      Util.shouldShowPlayButton(session.player)
    )
    // Unchanged: nothing to post, unless Android refused the foreground and it is time to ask again.
    if (!force && key == notificationKey &&
      (foregroundStarted || SystemClock.elapsedRealtime() - lastForegroundFailureAt < FOREGROUND_RETRY_MS)
    ) {
      return
    }
    val notification = buildNotification() ?: return
    notificationKey = key
    if (foregroundStarted) {
      postNotification(notification)
    } else {
      startForegroundSafely(notification, force)
    }
  }

  private fun postNotification(notification: Notification) {
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification)
  }

  private fun startForegroundSafely(notification: Notification, force: Boolean = false) {
    // Android refused a moment ago: don't hammer it (and the log) on every player event.
    val now = SystemClock.elapsedRealtime()
    if (!force && now - lastForegroundFailureAt < FOREGROUND_RETRY_MS) {
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
