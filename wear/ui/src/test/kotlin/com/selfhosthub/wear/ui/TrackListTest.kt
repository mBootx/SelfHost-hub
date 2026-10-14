package com.selfhosthub.wear.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import com.selfhosthub.wear.data.db.TrackEntity
import com.selfhosthub.wear.ui.library.StoredList
import com.selfhosthub.wear.ui.library.TracksContent
import com.selfhosthub.wear.ui.theme.SelfHostWatchTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The songs of an album or a playlist, as the hand uses them: a tap plays, a press and hold opens the other ways. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w227dp-h227dp-round-xhdpi")
class TrackListTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun track(id: String, title: String) = TrackEntity(id, title, "alt-J", "An Awesome Wave", "a1", 200, null, 1, 0)

    @Test
    fun aPlaylistWithTheSameSongTwiceShowsBothRows() {
        // A repeated key used to crash the whole list (and the app with it).
        val songs = listOf(track("t1", "Intro"), track("t1", "Intro"), track("t2", "Tessellate"))
        compose.setContent {
            SelfHostWatchTheme { TracksContent(null, "Route", "Lire la playlist", StoredList(songs, false, null) {}, {}, {}, {}) }
        }
        compose.waitForIdle()
        assertEquals(2, compose.onAllNodesWithText("Intro").fetchSemanticsNodes().size)
    }

    @Test
    fun aTapPlaysAndAPressAndHoldOpensTheOtherWays() {
        val played = mutableListOf<String>()
        val more = mutableListOf<String>()
        compose.setContent {
            SelfHostWatchTheme {
                TracksContent(null, "Route", "Lire la playlist", StoredList(listOf(track("t1", "Intro"), track("t2", "Tessellate")), false, null) {}, {}, { played += it.id }, { more += it.id })
            }
        }
        compose.onNodeWithText("Tessellate").performClick()
        compose.waitForIdle()
        assertEquals(listOf("t2"), played)
        assertEquals(emptyList<String>(), more)
        compose.onNodeWithText("Intro").performTouchInput { longClick() }
        compose.waitForIdle()
        assertEquals(listOf("t1"), more)
        assertEquals("a press and hold does not also play", listOf("t2"), played)
    }
}
