package com.selfhosthub.wear.service

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.selfhosthub.wear.core.DeviceState
import com.selfhosthub.wear.core.DeviceSummary
import com.selfhosthub.wear.core.MemoryWatchPrefs
import com.selfhosthub.wear.core.RemoteSong
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.service.link.PlayerSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

private val song = RemoteSong("s1", "Breezeblocks", "alt-J", "An Awesome Wave", "a1", "al-1", 227.0)

private fun player(playing: Boolean, position: Double = 83.0, title: String = "Breezeblocks") =
    PlayerSnapshot(DeviceState(song.copy(id = title, title = title), playing, position, 227.0, false, RepeatMode.OFF, 1.0), receivedAt = 10_000)

private fun linked(player: PlayerSnapshot?, status: LinkStatus = LinkStatus.CONNECTED) = LinkUiState(
    status = status,
    devices = listOf(DeviceSummary("local", "Pixel", "mobile"), DeviceSummary("hub", "PC du salon", "desktop")),
    players = if (player != null) mapOf("hub" to player) else emptyMap(),
    targetId = "hub"
)

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun `the chip names the song, the artist and the player, and has three buttons`() {
        val notification = Notifications.playing(context, player(true), "PC du salon")
        assertEquals("Breezeblocks", notification.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("alt-J · PC du salon", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(3, notification.actions.size)
        assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(Notification.CATEGORY_TRANSPORT, notification.category)
    }

    @Test
    fun `the middle button is pause while playing and play while paused`() {
        val playing = Notifications.playing(context, player(true), null)
        val paused = Notifications.playing(context, player(false), null)
        assertEquals(context.getString(R.string.action_pause), playing.actions[1].title.toString())
        assertEquals(context.getString(R.string.action_play), paused.actions[1].title.toString())
    }

    @Test
    fun `a chip nobody refreshes goes away at the end of the song at the latest`() {
        // 144 s left at the moment the message was heard, and the clock is at the same moment.
        assertEquals(204_000L, Notifications.lifetimeMs(player(true, position = 83.0), now = 10_000))
        // Ten seconds later there are ten fewer.
        assertEquals(194_000L, Notifications.lifetimeMs(player(true, position = 83.0), now = 20_000))
        // Past the end: only the grace.
        assertEquals(60_000L, Notifications.lifetimeMs(player(true, position = 220.0), now = 100_000))
        // Paused: it may stay a while for the resume.
        assertEquals(600_000L, Notifications.lifetimeMs(player(false), now = 10_000))
        assertTrue(Notifications.playing(context, player(true), null).timeoutAfter > 0)
    }

    @Test
    fun `a song with no title still gets a chip with the app's name`() {
        val unnamed = PlayerSnapshot(DeviceState(null, false, 0.0, 0.0, false, RepeatMode.OFF, 1.0), 0)
        val notification = Notifications.playing(context, unnamed, null)
        assertEquals("SelfHost Hub", notification.extras.getString(Notification.EXTRA_TITLE))
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NowPlayingNotifierTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val manager: NotificationManager get() = context.getSystemService(NotificationManager::class.java)
    private val prefs = MemoryWatchPrefs()

    private fun posted(): Notification? = shadowOf(manager).getNotification(Notifications.ID_PLAYING)

    @Before
    fun channels() {
        Notifications.ensureChannels(context)
    }

    @Test
    fun `a song playing puts the chip up, and the chip follows play and pause`() {
        val notifier = NowPlayingNotifier(context, prefs)
        notifier.update(linked(player(true)))
        val playing = posted()
        assertNotNull(playing)
        assertEquals("Breezeblocks", playing!!.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(context.getString(R.string.action_pause), playing.actions[1].title.toString())

        notifier.update(linked(player(false)))
        assertEquals(context.getString(R.string.action_play), posted()!!.actions[1].title.toString())

        notifier.update(linked(player(false, title = "Tessellate")))
        assertEquals("Tessellate", posted()!!.extras.getString(Notification.EXTRA_TITLE))
    }

    @Test
    fun `the progress of the song does not redraw it`() {
        val notifier = NowPlayingNotifier(context, prefs)
        notifier.update(linked(player(true, position = 10.0)))
        val first = posted()
        notifier.update(linked(player(true, position = 11.0)))
        assertTrue("the same notification, not a new one", first === posted())
    }

    @Test
    fun `nothing playing, no phone or the offer turned off takes the chip down`() {
        val notifier = NowPlayingNotifier(context, prefs)
        notifier.update(linked(player(true)))
        assertNotNull(posted())
        notifier.update(linked(null))
        assertNull(posted())

        notifier.update(linked(player(true)))
        assertNotNull(posted())
        notifier.update(linked(player(true), status = LinkStatus.NO_PHONE))
        assertNull("what is not known to be true is not shown", posted())

        notifier.update(linked(player(true)))
        prefs.autoLaunch = false
        notifier.update(linked(player(true, title = "Autre")))
        assertNull(posted())
    }

    @Test
    fun `a chip left by an earlier run of the app is taken down the first time nothing plays`() {
        shadowOf(manager).apply {
            // Put there by a process that has since ended.
            manager.notify(Notifications.ID_PLAYING, Notifications.playing(context, player(true), null))
        }
        assertNotNull(posted())
        NowPlayingNotifier(context, prefs).update(linked(null))
        assertNull(posted())
    }

    @Test
    fun `without the permission to notify nothing is posted and nothing breaks`() {
        shadowOf(manager).setNotificationsEnabled(false)
        NowPlayingNotifier(context, prefs).update(linked(player(true)))
        assertNull(posted())
    }
}
