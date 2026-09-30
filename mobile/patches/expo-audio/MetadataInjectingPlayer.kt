package expo.modules.audio.service

import android.os.Handler
import android.os.Looper
import androidx.core.net.toUri
import androidx.media3.common.FlagSet
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import expo.modules.audio.Metadata
import java.util.IdentityHashMap

// MediaSession reads artwork from Player.mediaMetadata, but expo-audio lock-screen metadata can
// change independently of the underlying MediaItem. This wrapper lets the session observe those
// metadata updates without replacing the active media item on the real ExoPlayer instance.
//
// The cover goes in as bytes (see NowPlayingArtwork) rather than only as a URL: with just a URL, Media3
// publishes the track without a picture and adds it when its own download ends, so a Now Bar that was
// already drawn never gets one.
@UnstableApi
internal class MetadataInjectingPlayer(
  player: Player,
  /**
   * Invoked when a MediaSession client (lock screen, Samsung Now Bar, Android Auto,
   * Bluetooth headset) asks to skip tracks. `true` means next, `false` previous.
   */
  private val onRemoteSkip: ((toNext: Boolean) -> Unit)? = null
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
    if (onRemoteSkip == null) return commands
    return commands.buildUpon()
      .add(Player.COMMAND_SEEK_TO_NEXT)
      .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
      .build()
  }

  // A stop from the Now Bar, a headset or the notification would leave ExoPlayer idle, and expo-audio's
  // play() can't bring it back (nothing prepares it again): the song would never play until it is
  // reloaded. The real queue lives in JavaScript, so treat stop as pause.
  override fun stop() = pause()

  override fun hasNextMediaItem(): Boolean = onRemoteSkip != null || super.hasNextMediaItem()

  override fun hasPreviousMediaItem(): Boolean = onRemoteSkip != null || super.hasPreviousMediaItem()

  override fun seekToNext() = dispatchSkip(true)

  override fun seekToNextMediaItem() = dispatchSkip(true)

  override fun seekToPrevious() = dispatchSkip(false)

  override fun seekToPreviousMediaItem() = dispatchSkip(false)

  private fun dispatchSkip(toNext: Boolean) {
    val callback = onRemoteSkip ?: return
    if (Looper.myLooper() != applicationLooper) {
      handler.post { callback(toNext) }
    } else {
      callback(toNext)
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

  private inner class MetadataForwardingListener(
    private val listener: Player.Listener
  ) : Player.Listener by listener {
    override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) {
      listener.onMediaMetadataChanged(this@MetadataInjectingPlayer.mediaMetadata)
    }

    override fun onEvents(player: Player, events: Player.Events) {
      listener.onEvents(this@MetadataInjectingPlayer, events)
    }
  }
}
