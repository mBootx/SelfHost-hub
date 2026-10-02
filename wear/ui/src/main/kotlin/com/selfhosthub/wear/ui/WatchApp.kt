package com.selfhosthub.wear.ui

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.navArgument
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.ui.common.AmbientState
import com.selfhosthub.wear.ui.devices.DevicesRoute
import com.selfhosthub.wear.ui.library.AlbumRoute
import com.selfhosthub.wear.ui.library.AllAlbumsRoute
import com.selfhosthub.wear.ui.library.ArtistAlbumsRoute
import com.selfhosthub.wear.ui.library.ArtistsRoute
import com.selfhosthub.wear.ui.library.LibraryHomeContent
import com.selfhosthub.wear.ui.library.PlaylistRoute
import com.selfhosthub.wear.ui.library.PlaylistsRoute
import com.selfhosthub.wear.ui.library.SearchRoute
import com.selfhosthub.wear.ui.nowplaying.AmbientNowPlayingRoute
import com.selfhosthub.wear.ui.nowplaying.ArtRoute
import com.selfhosthub.wear.ui.nowplaying.NowPlayingRoute
import com.selfhosthub.wear.ui.settings.SettingsRoute
import com.selfhosthub.wear.ui.setup.SetupContent
import com.selfhosthub.wear.ui.theme.SelfHostWatchTheme

object Routes {
    const val NOW_PLAYING = "now-playing"
    const val ART = "art"
    const val LIBRARY = "library"
    const val ARTISTS = "artists"
    const val ALBUMS = "albums"
    const val PLAYLISTS = "playlists"
    const val SEARCH = "search"
    const val DEVICES = "devices"
    const val SETTINGS = "settings"
    const val ARTIST = "artist/{id}"
    const val ALBUM = "album/{id}"
    const val PLAYLIST = "playlist/{id}"

    fun artist(id: String) = "artist/${Uri.encode(id)}"
    fun album(id: String) = "album/${Uri.encode(id)}"
    fun playlist(id: String) = "playlist/${Uri.encode(id)}"
}

/**
 * The whole app: the always-on screen when the watch is in ambient mode, otherwise the navigation between Now Playing
 * (where everything starts and where a swipe to the right brings you back), the library, the player picker and the
 * settings. Now Playing needs nothing but the phone app; the library needs the login the phone sends from its Montre
 * setting, and until it has arrived the library is the setup instructions.
 */
@Composable
fun WatchApp(graph: WatchGraph, ambient: AmbientState, versionName: String) {
    // Created before the ambient branch, so that the place in the library is still there when the screen wakes up.
    val nav = rememberSwipeDismissableNavController()
    SelfHostWatchTheme {
        if (ambient.isAmbient) {
            AmbientNowPlayingRoute(graph, ambient)
            return@SelfHostWatchTheme
        }
        val setup by graph.setup.collectAsStateWithLifecycle()

        SwipeDismissableNavHost(navController = nav, startDestination = Routes.NOW_PLAYING) {
            composable(Routes.NOW_PLAYING) {
                NowPlayingRoute(
                    graph,
                    onLibrary = { nav.navigate(Routes.LIBRARY) },
                    onDevices = { nav.navigate(Routes.DEVICES) },
                    onSettings = { nav.navigate(Routes.SETTINGS) },
                    onArt = { nav.navigate(Routes.ART) }
                )
            }
            composable(Routes.ART) { ArtRoute(graph, onClose = { nav.popBackStack() }) }
            composable(Routes.LIBRARY) {
                if (setup == null) {
                    SetupContent()
                } else {
                    LibraryHomeContent(
                        onArtists = { nav.navigate(Routes.ARTISTS) },
                        onAlbums = { nav.navigate(Routes.ALBUMS) },
                        onPlaylists = { nav.navigate(Routes.PLAYLISTS) },
                        onSearch = { nav.navigate(Routes.SEARCH) }
                    )
                }
            }
            composable(Routes.ARTISTS) { ArtistsRoute(graph) { artist -> nav.navigate(Routes.artist(artist.id)) } }
            composable(Routes.ALBUMS) { AllAlbumsRoute(graph) { album -> nav.navigate(Routes.album(album.id)) } }
            composable(Routes.PLAYLISTS) { PlaylistsRoute(graph) { playlist -> nav.navigate(Routes.playlist(playlist.id)) } }
            composable(Routes.SEARCH) {
                SearchRoute(
                    graph,
                    onArtist = { artist -> nav.navigate(Routes.artist(artist.id)) },
                    onAlbum = { album -> nav.navigate(Routes.album(album.id)) }
                )
            }
            composable(Routes.ARTIST, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                ArtistAlbumsRoute(graph, entry.arguments?.getString("id").orEmpty()) { album -> nav.navigate(Routes.album(album.id)) }
            }
            composable(Routes.ALBUM, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                AlbumRoute(graph, entry.arguments?.getString("id").orEmpty())
            }
            composable(Routes.PLAYLIST, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                PlaylistRoute(graph, entry.arguments?.getString("id").orEmpty())
            }
            composable(Routes.DEVICES) { DevicesRoute(graph, onDone = { nav.popBackStack() }) }
            composable(Routes.SETTINGS) {
                SettingsRoute(graph, versionName, onForgotten = { nav.popBackStack(Routes.NOW_PLAYING, inclusive = false) })
            }
        }
    }
}
