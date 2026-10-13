package expo.modules.audio.service

import android.os.Handler
import android.os.Looper
import androidx.core.net.toUri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.DeviceInfo
import androidx.media3.common.FlagSet
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.text.Cue
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import expo.modules.audio.Metadata
import java.util.IdentityHashMap

/**
 * What the media session (lock screen, notification, Samsung Now Bar, headset and Bluetooth buttons, Android Auto)
 * sees of one deck: its ExoPlayer, with the song's title, artist and cover put in front, and every transport press
 * reported to JavaScript, where the play queue and the play state live.
 *
 * MediaSession reads the artwork from Player.mediaMetadata, but expo-audio's lock screen metadata changes on its own
 * schedule: this wrapper lets the session see those updates without replacing the media item on the real ExoPlayer.
 * The cover goes in as bytes (see NowPlayingArtwork) rather than only as a URL: with just a URL, Media3 publishes the
 * track without a picture and adds it when its own download ends, so a Now Bar that was already drawn never gets one.
 *
 * The app itself never goes through this wrapper (it drives the decks directly), so every call that reaches
 * play/pause/skip here came from outside: a press on the Now Bar, the notification, a headset, a car, a watch.
 */
@UnstableApi
internal class MetadataInjectingPlayer(
  player: Player,
  /**
   * Told about every transport press from outside the app: "play", "pause", "next" or "previous". Called on the
   * player's thread, before the press acts on the player, so JavaScript hears the person's intent before it sees the
   * player's state change.
   */
  private val onRemoteCommand: ((command: String) -> Unit)? = null
) : ForwardingPlayer(player) {
  private val handler = Handler(applicationLooper)
  private val listeners = IdentityHashMap<Player.Listener, Player.Listener>()
  private var injectedMetadata: Metadata? = null
  private var injectedArtwork: ByteArray? = null

  // expo-audio feeds ExoPlayer one media item at a time - the real play queue lives
  // in JavaScript - so ExoPlayer reports "no next/previous track" and every system
  // UI hides its skip buttons. Claim those commands here and hand the presses to
  // the JS queue instead of the underlying player.
  override fun getAvailableCommands(): Player.Commands {
    val commands = super.getAvailableCommands()
    if (onRemoteCommand == null) return commands
    return commands.buildUpon()
      .add(Player.COMMAND_SEEK_TO_NEXT)
      .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
      .build()
  }

  override fun isCommandAvailable(command: Int): Boolean = availableCommands.contains(command)

  // A press on play or pause acts on the deck at once, so the Now Bar answers straight away even if JavaScript is
  // slow, and JavaScript is told so it takes the press as the person's choice. Without that it only saw the deck's
  // state change, and a pause pressed while a song was loading was undone by the app, which "re-asserts" play once
  // a source is ready.
  override fun play() {
    dispatch("play")
    super.play()
  }

  override fun pause() {
    dispatch("pause")
    super.pause()
  }

  override fun setPlayWhenReady(playWhenReady: Boolean) {
    dispatch(if (playWhenReady) "play" else "pause")
    super.setPlayWhenReady(playWhenReady)
  }

  // A stop from the Now Bar, a headset or the notification would leave ExoPlayer idle, and expo-audio's
  // play() can't bring it back (nothing prepares it again): the song would never play until it is
  // reloaded. The real queue lives in JavaScript, so treat stop as pause.
  override fun stop() = pause()

  override fun hasNextMediaItem(): Boolean = onRemoteCommand != null || super.hasNextMediaItem()

  override fun hasPreviousMediaItem(): Boolean = onRemoteCommand != null || super.hasPreviousMediaItem()

  override fun seekToNext() = dispatch("next")

  override fun seekToNextMediaItem() = dispatch("next")

  override fun seekToPrevious() = dispatch("previous")

  override fun seekToPreviousMediaItem() = dispatch("previous")

  private fun dispatch(command: String) {
    val callback = onRemoteCommand ?: return
    if (Looper.myLooper() != applicationLooper) {
      handler.post { callback(command) }
    } else {
      callback(command)
    }
  }

  override fun addListener(listener: Player.Listener) {
    val forwardingListener = synchronized(listeners) {
      listeners.getOrPut(listener) { MetadataForwardingListener(listener) }
    }
    super.addListener(forwardingListener)
  }

  override fun removeListener(listener: Player.Listener) {
    val forwardingListener = synchronized(listeners) {
      listeners.remove(listener)
    }
    super.removeListener(forwardingListener ?: listener)
  }

  override fun getMediaMetadata(): MediaMetadata {
    val metadata = injectedMetadata
    val artwork = injectedArtwork
    return super.getMediaMetadata()
      .buildUpon()
      .setTitle(metadata?.title)
      .setArtist(metadata?.artist)
      .setAlbumTitle(metadata?.albumTitle)
      .setArtworkUri(metadata?.artworkUrl?.toString()?.toUri())
      // Also replaces any picture ExoPlayer found in the audio file's own tags.
      .setArtworkData(artwork, if (artwork != null) MediaMetadata.PICTURE_TYPE_FRONT_COVER else null)
      .build()
  }

  /** [artwork] is the encoded cover of [metadata]'s track, or null while it is still being loaded. */
  fun updateMetadata(metadata: Metadata?, artwork: ByteArray? = null) {
    if (Looper.myLooper() != applicationLooper) {
      handler.post { updateMetadata(metadata, artwork) }
      return
    }

    val previousMetadata = mediaMetadata
    injectedMetadata = metadata
    injectedArtwork = artwork
    val newMetadata = mediaMetadata

    if (previousMetadata == newMetadata) {
      return
    }

    val events = Player.Events(
      FlagSet.Builder()
        .add(Player.EVENT_MEDIA_METADATA_CHANGED)
        .build()
    )
    val currentListeners = synchronized(listeners) {
      listeners.keys.toList()
    }

    currentListeners.forEach {
      it.onMediaMetadataChanged(newMetadata)
    }
    currentListeners.forEach {
      it.onEvents(this, events)
    }
  }

  /**
   * Hands the deck's events on to a listener of the session (the media session's own, the notification's), with the
   * injected metadata in place of the file's and this wrapper as the player.
   *
   * Every event is forwarded by hand. This used to be `Player.Listener by listener`, but every Player.Listener method
   * is a Java default method, and Kotlin's delegation skips those: only the two overridden here got through. The
   * session never heard of play, pause, seeks, a new song or the time, so the Now Bar's play/pause button and time
   * went stale whenever nothing else refreshed them (a skip there then seemed to do nothing, or the time was wrong).
   * The JVM test checks that this class declares every method of Player.Listener.
   */
  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  private inner class MetadataForwardingListener(
    private val listener: Player.Listener
  ) : Player.Listener {
    override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) {
      listener.onMediaMetadataChanged(this@MetadataInjectingPlayer.mediaMetadata)
    }

    override fun onEvents(player: Player, events: Player.Events) {
      listener.onEvents(this@MetadataInjectingPlayer, events)
    }

    override fun onTimelineChanged(timeline: Timeline, reason: Int) = listener.onTimelineChanged(timeline, reason)

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = listener.onMediaItemTransition(mediaItem, reason)

    override fun onTracksChanged(tracks: Tracks) = listener.onTracksChanged(tracks)

    override fun onPlaylistMetadataChanged(mediaMetadata: MediaMetadata) = listener.onPlaylistMetadataChanged(mediaMetadata)

    override fun onIsLoadingChanged(isLoading: Boolean) = listener.onIsLoadingChanged(isLoading)

    override fun onLoadingChanged(isLoading: Boolean) = listener.onLoadingChanged(isLoading)

    override fun onAvailableCommandsChanged(availableCommands: Player.Commands) =
      // The skip commands this wrapper adds stay in.
      listener.onAvailableCommandsChanged(this@MetadataInjectingPlayer.availableCommands)

    override fun onTrackSelectionParametersChanged(parameters: TrackSelectionParameters) =
      listener.onTrackSelectionParametersChanged(parameters)

    override fun onPlayerStateChanged(playWhenReady: Boolean, playbackState: Int) =
      listener.onPlayerStateChanged(playWhenReady, playbackState)

    override fun onPlaybackStateChanged(playbackState: Int) = listener.onPlaybackStateChanged(playbackState)

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = listener.onPlayWhenReadyChanged(playWhenReady, reason)

    override fun onPlaybackSuppressionReasonChanged(playbackSuppressionReason: Int) =
      listener.onPlaybackSuppressionReasonChanged(playbackSuppressionReason)

    override fun onIsPlayingChanged(isPlaying: Boolean) = listener.onIsPlayingChanged(isPlaying)

    override fun onRepeatModeChanged(repeatMode: Int) = listener.onRepeatModeChanged(repeatMode)

    override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) = listener.onShuffleModeEnabledChanged(shuffleModeEnabled)

    override fun onPlayerError(error: PlaybackException) = listener.onPlayerError(error)

    override fun onPlayerErrorChanged(error: PlaybackException?) = listener.onPlayerErrorChanged(error)

    override fun onPositionDiscontinuity(reason: Int) = listener.onPositionDiscontinuity(reason)

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) =
      listener.onPositionDiscontinuity(oldPosition, newPosition, reason)

    override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) = listener.onPlaybackParametersChanged(playbackParameters)

    override fun onSeekBackIncrementChanged(seekBackIncrementMs: Long) = listener.onSeekBackIncrementChanged(seekBackIncrementMs)

    override fun onSeekForwardIncrementChanged(seekForwardIncrementMs: Long) = listener.onSeekForwardIncrementChanged(seekForwardIncrementMs)

    override fun onMaxSeekToPreviousPositionChanged(maxSeekToPreviousPositionMs: Long) =
      listener.onMaxSeekToPreviousPositionChanged(maxSeekToPreviousPositionMs)

    override fun onAudioSessionIdChanged(audioSessionId: Int) = listener.onAudioSessionIdChanged(audioSessionId)

    override fun onAudioAttributesChanged(audioAttributes: AudioAttributes) = listener.onAudioAttributesChanged(audioAttributes)

    override fun onVolumeChanged(volume: Float) = listener.onVolumeChanged(volume)

    override fun onSkipSilenceEnabledChanged(skipSilenceEnabled: Boolean) = listener.onSkipSilenceEnabledChanged(skipSilenceEnabled)

    override fun onDeviceInfoChanged(deviceInfo: DeviceInfo) = listener.onDeviceInfoChanged(deviceInfo)

    override fun onDeviceVolumeChanged(volume: Int, muted: Boolean) = listener.onDeviceVolumeChanged(volume, muted)

    override fun onVideoSizeChanged(videoSize: VideoSize) = listener.onVideoSizeChanged(videoSize)

    override fun onSurfaceSizeChanged(width: Int, height: Int) = listener.onSurfaceSizeChanged(width, height)

    override fun onRenderedFirstFrame() = listener.onRenderedFirstFrame()

    override fun onCues(cues: List<Cue>) = listener.onCues(cues)

    override fun onCues(cueGroup: CueGroup) = listener.onCues(cueGroup)

    override fun onMetadata(metadata: androidx.media3.common.Metadata) = listener.onMetadata(metadata)
  }
}
