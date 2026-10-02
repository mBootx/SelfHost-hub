package com.selfhosthub.wear.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.selfhosthub.wear.core.DeviceState
import com.selfhosthub.wear.core.DeviceSummary
import com.selfhosthub.wear.core.PcLink
import com.selfhosthub.wear.core.PcState
import com.selfhosthub.wear.core.RemoteSong
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.data.LibrarySearchResult
import com.selfhosthub.wear.data.db.AlbumEntity
import com.selfhosthub.wear.data.db.ArtistEntity
import com.selfhosthub.wear.data.db.PlaylistEntity
import com.selfhosthub.wear.data.db.TrackEntity
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.service.link.PlayerSnapshot
import com.selfhosthub.wear.ui.common.AmbientState
import com.selfhosthub.wear.ui.devices.DevicesContent
import com.selfhosthub.wear.ui.library.AlbumsContent
import com.selfhosthub.wear.ui.library.ArtistsContent
import com.selfhosthub.wear.ui.library.LibraryHomeContent
import com.selfhosthub.wear.ui.library.PlaylistsContent
import com.selfhosthub.wear.ui.library.SearchContent
import com.selfhosthub.wear.ui.library.StoredList
import com.selfhosthub.wear.ui.library.TracksContent
import com.selfhosthub.wear.ui.nowplaying.AmbientNowPlayingContent
import com.selfhosthub.wear.ui.nowplaying.NowPlayingActions
import com.selfhosthub.wear.ui.nowplaying.NowPlayingContent
import com.selfhosthub.wear.ui.nowplaying.NowPlayingUi
import com.selfhosthub.wear.ui.nowplaying.OptionsPage
import com.selfhosthub.wear.ui.nowplaying.toNowPlaying
import com.selfhosthub.wear.ui.settings.SettingsActions
import com.selfhosthub.wear.ui.settings.SettingsContent
import com.selfhosthub.wear.ui.settings.SettingsUi
import com.selfhosthub.wear.ui.setup.SetupContent
import com.selfhosthub.wear.ui.theme.SelfHostWatchTheme
import java.io.File
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders each screen on a round 227 dp watch (a Galaxy Watch is 432 px / 1.5 = 288 dp; a Pixel Watch 2 is 192 dp; this
 * is between the two) and saves the picture under build/screenshots, so that the layout can be looked at. These are
 * not compared with anything: they exist to be opened. They do fail if a screen cannot be drawn at all.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w227dp-h227dp-round-xhdpi")
class ScreenshotTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun shot(name: String, content: @Composable () -> Unit) {
        compose.setContent {
            SelfHostWatchTheme {
                Box(Modifier.fillMaxSize().clip(CircleShape).background(Color.Black)) { content() }
            }
        }
        compose.waitForIdle()
        val bitmap = capture()
        val file = File("build/screenshots/$name.png").also { it.parentFile?.mkdirs() }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** Draws the window's top view into a bitmap: PixelCopy, which captureToImage uses, never completes under Robolectric. */
    private fun capture(): Bitmap {
        val view = compose.activity.window.decorView
        val size = (227 * view.resources.displayMetrics.density).toInt()
        view.measure(View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, size, size)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        return bitmap
    }

    private val noActions = NowPlayingActions({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})

    private fun player(title: String, artist: String, playing: Boolean = true, position: Double = 83.0, duration: Double = 227.0) = NowPlayingUi(
        status = LinkStatus.CONNECTED,
        playerName = "PC du salon",
        title = title,
        artist = artist,
        album = "An Awesome Wave",
        coverArt = "al-1",
        isPlaying = playing,
        position = position,
        duration = duration,
        shuffle = true,
        repeat = RepeatMode.ALL,
        volume = 0.62
    )

    @Test fun nowPlaying() = shot("now-playing") { NowPlayingContent(player("Breezeblocks", "alt-J"), null, noActions, null) }

    @Test fun nowPlayingLongTitle() = shot("now-playing-long-title") {
        NowPlayingContent(player("Les cornichons sont dans le frigo de la cuisine", "Jean-Michel Un-Artiste-Au-Nom-Très-Long", playing = false), null, noActions, null)
    }

    @Test fun nowPlayingVolume() = shot("now-playing-volume") { NowPlayingContent(player("Tessellate", "alt-J"), null, noActions, 62) }

    @Test fun options() = shot("options") { OptionsPage(player("Breezeblocks", "alt-J"), noActions) }

    @Test fun nowPlayingNothing() = shot("now-playing-nothing") { NowPlayingContent(NowPlayingUi(status = LinkStatus.CONNECTED), null, noActions, null) }

    @Test fun nowPlayingNoPhone() = shot("now-playing-no-phone") {
        NowPlayingContent(NowPlayingUi(status = LinkStatus.NO_PHONE), null, noActions, null)
    }

    @Test fun nowPlayingAppClosed() = shot("now-playing-app-closed") {
        NowPlayingContent(NowPlayingUi(status = LinkStatus.PHONE_APP_CLOSED), null, noActions, null)
    }

    @Test fun ambient() = shot("ambient") {
        AmbientNowPlayingContent(player("Breezeblocks", "alt-J"), null, AmbientState(isAmbient = true), minuteOfDay = 0)
    }

    @Test fun ambientBurnIn() = shot("ambient-burn-in") {
        AmbientNowPlayingContent(player("Breezeblocks", "alt-J"), null, AmbientState(isAmbient = true, burnInProtection = true), minuteOfDay = 1)
    }

    @Test fun library() = shot("library") { LibraryHomeContent({}, {}, {}, {}) }

    private val artists = StoredList(
        listOf(
            ArtistEntity("1", "alt-J", 3, "ar-1", 0),
            ArtistEntity("2", "Björk", 12, "ar-2", 0),
            ArtistEntity("3", "Daft Punk", 4, "ar-3", 0),
            ArtistEntity("4", "Stromae", 1, "ar-4", 0)
        ),
        false, null
    ) {}

    @Test fun artists() = shot("artists") { ArtistsContent(null, artists) {} }

    @Test fun artistsLoading() = shot("artists-loading") { ArtistsContent(null, StoredList<ArtistEntity>(null, true, null) {}) {} }

    @Test fun artistsFailed() = shot("artists-failed") { ArtistsContent(null, StoredList<ArtistEntity>(emptyList(), false, "Serveur injoignable") {}) {} }

    @Test fun albums() = shot("albums") {
        AlbumsContent(
            null, "alt-J",
            StoredList(
                listOf(
                    AlbumEntity("a1", "An Awesome Wave", "alt-J", "1", "al-1", 2012, 13, null, 0),
                    AlbumEntity("a2", "This Is All Yours", "alt-J", "1", "al-2", 2014, 14, null, 0),
                    AlbumEntity("a3", "Relaxer", "alt-J", "1", "al-3", 2017, 8, null, 0)
                ),
                false, null
            ) {}
        ) {}
    }

    private val tracks = StoredList(
        listOf(
            TrackEntity("t1", "Intro", "alt-J", "An Awesome Wave", "a1", 168, "al-1", 1, 0),
            TrackEntity("t2", "Tessellate", "alt-J", "An Awesome Wave", "a1", 183, "al-1", 2, 0),
            TrackEntity("t3", "Breezeblocks", "alt-J", "An Awesome Wave", "a1", 227, "al-1", 3, 0)
        ),
        false, null
    ) {}

    @Test fun tracks() = shot("tracks") { TracksContent(null, "An Awesome Wave", "Lire l'album", tracks, {}, {}, {}) }

    @Test fun playlists() = shot("playlists") {
        PlaylistsContent(null, StoredList(listOf(PlaylistEntity("p1", "Route", 42, null, null, 0), PlaylistEntity("p2", "Calme", 1, null, null, 0)), false, null) {}) {}
    }

    @Test fun searchResults() = shot("search") {
        SearchContent(
            graph = null,
            query = "alt",
            result = LibrarySearchResult(
                artists = listOf(ArtistEntity("1", "alt-J", 3, "ar-1", 0)),
                albums = listOf(AlbumEntity("a1", "An Awesome Wave", "alt-J", "1", "al-1", 2012, 13, null, 0)),
                tracks = listOf(TrackEntity("t3", "Breezeblocks", "alt-J", "An Awesome Wave", "a1", 227, "al-1", 3, 0)),
                fromServer = true
            ),
            searching = false, onEdit = {}, onArtist = {}, onAlbum = {}, onPlay = {}, onMore = {}
        )
    }

    private val song = RemoteSong("t3", "Breezeblocks", "alt-J", "An Awesome Wave", "a1", "al-1", 227.0)

    @Test fun devices() = shot("devices") {
        DevicesContent(
            LinkUiState(
                status = LinkStatus.CONNECTED,
                devices = listOf(
                    DeviceSummary("local", "Galaxy S25 Ultra", "mobile"),
                    DeviceSummary("hub", "PC du salon", "desktop"),
                    DeviceSummary("p1", "Tablette salon", "mobile")
                ),
                players = mapOf("p1" to PlayerSnapshot(DeviceState(song, true, 10.0, 227.0, false, RepeatMode.OFF, 0.5), 0)),
                manualTargetId = "hub",
                targetId = "hub"
            )
        ) {}
    }

    private val pcUp = PcLink(PcState.CONNECTED, "PC du salon", null)

    @Test fun settings() = shot("settings") {
        SettingsContent(
            SettingsUi(
                navidromeUser = "maxime",
                navidromeHost = "music.example.org",
                lastSyncAt = 1_000_000L,
                phoneStatus = LinkStatus.CONNECTED,
                phoneName = "Galaxy S25 Ultra",
                pc = pcUp,
                cacheBytes = 18_400_000,
                versionName = "2.5.0"
            ),
            now = 1_000_000L + 12 * 60_000,
            actions = SettingsActions({}, {}, {}, {}, {})
        )
    }

    @Test fun settingsProblems() = shot("settings-problems") {
        SettingsContent(
            SettingsUi(
                navidromeUser = "maxime",
                navidromeHost = "music.example.org",
                syncError = "Compte refusé par Navidrome",
                phoneStatus = LinkStatus.PHONE_APP_CLOSED,
                autoLaunch = false,
                versionName = "2.5.0"
            ),
            now = 1_000_000L,
            actions = SettingsActions({}, {}, {}, {}, {})
        )
    }

    @Test fun settingsPcOff() = shot("settings-pc-off") {
        SettingsContent(
            SettingsUi(
                navidromeUser = "maxime",
                navidromeHost = "music.example.org",
                lastSyncAt = 1_000_000L,
                phoneStatus = LinkStatus.CONNECTED,
                phoneName = "Galaxy S25 Ultra",
                pc = PcLink(PcState.OFF, null, null),
                versionName = "2.5.0"
            ),
            now = 1_000_000L,
            actions = SettingsActions({}, {}, {}, {}, {})
        )
    }

    @Test fun setup() = shot("setup") { SetupContent() }

    @Test fun fromLinkState() {
        // The model that feeds the screen: the PC playing, as the phone reports it.
        val state = LinkUiState(
            status = LinkStatus.CONNECTED,
            phoneName = "Galaxy S25 Ultra",
            devices = listOf(DeviceSummary("local", "Galaxy S25 Ultra", "mobile"), DeviceSummary("hub", "PC du salon", "desktop")),
            players = mapOf("hub" to PlayerSnapshot(DeviceState(song, true, 100.0, 227.0, true, RepeatMode.ONE, 0.3), 1_000L)),
            targetId = "hub"
        )
        val ui = state.toNowPlaying(now = 6_000L)
        org.junit.Assert.assertEquals("Breezeblocks", ui.title)
        org.junit.Assert.assertEquals(105.0, ui.position, 0.0)
        org.junit.Assert.assertEquals(RepeatMode.ONE, ui.repeat)
    }
}
