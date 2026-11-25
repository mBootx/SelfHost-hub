package com.selfhosthub.wear.service.tile

import android.content.Context
import androidx.concurrent.futures.ResolvableFuture
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DeviceParametersBuilders.DeviceParameters
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material.Button
import androidx.wear.protolayout.material.ButtonColors
import androidx.wear.protolayout.material.Text
import androidx.wear.protolayout.material.Typography
import androidx.wear.protolayout.material.layouts.PrimaryLayout
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import com.selfhosthub.wear.core.MediaKind
import com.selfhosthub.wear.core.PlayMode
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.service.R
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.service.watchGraph

/** What the tile shows, from the state of the players: kept apart from the drawing so it is checked on its own. */
data class TileContent(
    val title: String,
    val subtitle: String,
    val playing: Boolean,
    val controls: Boolean,
    val isStarred: Boolean = false,
    val quickActions: Boolean = false
) {
    companion object {
        fun of(state: LinkUiState): TileContent {
            val player = state.target?.state
            val song = player?.song
            if (!state.connected) {
                return TileContent("SelfHost Hub", state.status.short ?: "Connexion…", playing = false, controls = false, isStarred = false, quickActions = false)
            }
            if (song == null || song.title.isBlank()) {
                return TileContent("Rien en lecture", state.targetName ?: "Touchez pour ouvrir", playing = false, controls = false, isStarred = false, quickActions = true)
            }
            return TileContent(song.title, song.artist.ifBlank { state.targetName ?: "" }, playing = player.isPlaying, controls = true, isStarred = player.isStarred, quickActions = true)
        }
    }
}

/** The tile's buttons, by the id they come back with when pressed. */
object TileClicks {
    const val PREVIOUS = "previous"
    const val TOGGLE = "toggle"
    const val NEXT = "next"
    const val LIKE = "like"
    const val SHUFFLE_ALL = "shuffleAll"
    const val FAVORITES = "favorites"

    fun commandFor(id: String?): PlayerCommand? = when (id) {
        PREVIOUS -> PlayerCommand.Prev
        TOGGLE -> PlayerCommand.Toggle
        NEXT -> PlayerCommand.Next
        LIKE -> PlayerCommand.ToggleLike
        SHUFFLE_ALL -> PlayerCommand.PlayMedia(MediaKind.SHUFFLE_ALL, "all", mode = PlayMode.NOW)
        FAVORITES -> PlayerCommand.PlayMedia(MediaKind.FAVORITES, "all", mode = PlayMode.NOW)
        else -> null
    }
}

/**
 * The "En lecture" tile, a swipe away from the watch face: the song playing, playback + like controls, and quick
 * actions (Mix aléatoire, Titres aimés); the title opens the app. A press comes back here as a new request carrying
 * the button's id: the command goes to the phone, and the tile is drawn again from the state as it stands (the phone's
 * answer then asks for another redraw, see TileRefresher).
 */
class NowPlayingTileService : TileService() {

    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
        val graph = applicationContext.watchGraph()
        TileClicks.commandFor(requestParams.currentState.lastClickableId)?.let { graph.link.send(it) }
        // Shown again: ask the phone how things are, its answer redraws the tile.
        graph.link.refresh()
        val content = TileContent.of(graph.link.state.value)
        return done(
            TileBuilders.Tile.Builder()
                .setResourcesVersion(RESOURCES_VERSION)
                .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout(this, requestParams.deviceConfiguration, content)))
                .build()
        )
    }

    override fun onTileResourcesRequest(requestParams: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
        done(
            ResourceBuilders.Resources.Builder()
                .setVersion(RESOURCES_VERSION)
                .addIdToImageMapping(ICON_PREVIOUS, image(R.drawable.tile_previous))
                .addIdToImageMapping(ICON_PLAY, image(R.drawable.tile_play))
                .addIdToImageMapping(ICON_PAUSE, image(R.drawable.tile_pause))
                .addIdToImageMapping(ICON_NEXT, image(R.drawable.tile_next))
                .addIdToImageMapping(ICON_HEART, image(R.drawable.tile_heart))
                .addIdToImageMapping(ICON_HEART_OUTLINE, image(R.drawable.tile_heart_outline))
                .addIdToImageMapping(ICON_SHUFFLE, image(R.drawable.tile_shuffle))
                .build()
        )

    companion object {
        const val RESOURCES_VERSION = "2"
        private const val ICON_PREVIOUS = "previous"
        private const val ICON_PLAY = "play"
        private const val ICON_PAUSE = "pause"
        private const val ICON_NEXT = "next"
        private const val ICON_HEART = "heart"
        private const val ICON_HEART_OUTLINE = "heart_outline"
        private const val ICON_SHUFFLE = "shuffle"
        private const val ACCENT = 0xFF1DB954.toInt()
        private const val ON_SURFACE = 0xFFF2F2F2.toInt()
        private const val MUTED = 0xFF9A9A9A.toInt()
        private const val SURFACE = 0xFF262626.toInt()

        private fun <T> done(value: T): ListenableFuture<T> = ResolvableFuture.create<T>().apply { set(value) }

        private fun image(resourceId: Int) = ResourceBuilders.ImageResource.Builder()
            .setAndroidResourceByResId(ResourceBuilders.AndroidImageResourceByResId.Builder().setResourceId(resourceId).build())
            .build()

        private fun clickable(id: String) = ModifiersBuilders.Clickable.Builder()
            .setId(id)
            .setOnClick(ActionBuilders.LoadAction.Builder().build())
            .build()

        /** Opens the app (its activity lives in the app module, so it is named rather than referenced). */
        private fun openApp(context: Context) = ModifiersBuilders.Clickable.Builder()
            .setId("open")
            .setOnClick(
                ActionBuilders.LaunchAction.Builder()
                    .setAndroidActivity(
                        ActionBuilders.AndroidActivity.Builder()
                            .setPackageName(context.packageName)
                            .setClassName("com.selfhosthub.wear.MainActivity")
                            .build()
                    )
                    .build()
            )
            .build()

        private fun quickActionChip(
            context: Context,
            id: String,
            iconId: String,
            iconTint: Int,
            label: String
        ): LayoutElementBuilders.LayoutElement {
            val row = LayoutElementBuilders.Row.Builder()
                .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                .addContent(
                    LayoutElementBuilders.Image.Builder()
                        .setResourceId(iconId)
                        .setWidth(dp(14f))
                        .setHeight(dp(14f))
                        .setColorFilter(LayoutElementBuilders.ColorFilter.Builder().setTint(argb(iconTint)).build())
                        .build()
                )
                .addContent(LayoutElementBuilders.Spacer.Builder().setWidth(dp(4f)).build())
                .addContent(
                    Text.Builder(context, label)
                        .setTypography(Typography.TYPOGRAPHY_CAPTION2)
                        .setColor(argb(ON_SURFACE))
                        .setMaxLines(1)
                        .build()
                )
                .build()

            val modifiers = ModifiersBuilders.Modifiers.Builder()
                .setClickable(clickable(id))
                .setBackground(
                    ModifiersBuilders.Background.Builder()
                        .setColor(argb(SURFACE))
                        .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(14f)).build())
                        .build()
                )
                .setPadding(ModifiersBuilders.Padding.Builder().setStart(dp(10f)).setEnd(dp(10f)).build())
                .setSemantics(ModifiersBuilders.Semantics.Builder().setContentDescription(label).build())
                .build()

            return LayoutElementBuilders.Box.Builder()
                .setHeight(dp(28f))
                .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                .setModifiers(modifiers)
                .addContent(row)
                .build()
        }

        fun layout(context: Context, device: DeviceParameters, content: TileContent): LayoutElementBuilders.LayoutElement {
            val title = Text.Builder(context, content.title)
                .setTypography(Typography.TYPOGRAPHY_TITLE3)
                .setColor(argb(ON_SURFACE))
                .setMaxLines(if (content.controls) 1 else 2)
                .build()
            val subtitle = Text.Builder(context, content.subtitle)
                .setTypography(Typography.TYPOGRAPHY_CAPTION1)
                .setColor(argb(MUTED))
                .setMaxLines(1)
                .build()
            val texts = LayoutElementBuilders.Column.Builder()
                .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
                .addContent(title)
                .addContent(subtitle)
                .setModifiers(ModifiersBuilders.Modifiers.Builder().setClickable(openApp(context)).build())
                .build()
            val body = LayoutElementBuilders.Column.Builder()
                .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
                .addContent(texts)
            if (content.controls) {
                val side = ButtonColors(argb(SURFACE), argb(ON_SURFACE))
                val main = ButtonColors(argb(ACCENT), argb(0xFF000000.toInt()))
                val likeColors = ButtonColors(argb(SURFACE), argb(if (content.isStarred) ACCENT else ON_SURFACE))
                val buttons = LayoutElementBuilders.Row.Builder()
                    .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                    .addContent(
                        Button.Builder(context, clickable(TileClicks.PREVIOUS)).setIconContent(ICON_PREVIOUS)
                            .setContentDescription("Précédent").setButtonColors(side).setSize(dp(38f)).build()
                    )
                    .addContent(LayoutElementBuilders.Spacer.Builder().setWidth(dp(6f)).build())
                    .addContent(
                        Button.Builder(context, clickable(TileClicks.TOGGLE)).setIconContent(if (content.playing) ICON_PAUSE else ICON_PLAY)
                            .setContentDescription(if (content.playing) "Pause" else "Lecture").setButtonColors(main).setSize(dp(44f)).build()
                    )
                    .addContent(LayoutElementBuilders.Spacer.Builder().setWidth(dp(6f)).build())
                    .addContent(
                        Button.Builder(context, clickable(TileClicks.NEXT)).setIconContent(ICON_NEXT)
                            .setContentDescription("Suivant").setButtonColors(side).setSize(dp(38f)).build()
                    )
                    .addContent(LayoutElementBuilders.Spacer.Builder().setWidth(dp(6f)).build())
                    .addContent(
                        Button.Builder(context, clickable(TileClicks.LIKE))
                            .setIconContent(if (content.isStarred) ICON_HEART else ICON_HEART_OUTLINE)
                            .setContentDescription(if (content.isStarred) "Retirer des favoris" else "J’aime")
                            .setButtonColors(likeColors)
                            .setSize(dp(38f))
                            .build()
                    )
                    .build()
                body.addContent(LayoutElementBuilders.Spacer.Builder().setHeight(dp(6f)).build())
                body.addContent(buttons)
            }
            if (content.quickActions) {
                val quickRow = LayoutElementBuilders.Row.Builder()
                    .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                    .addContent(quickActionChip(context, TileClicks.SHUFFLE_ALL, ICON_SHUFFLE, ON_SURFACE, "Mix aléatoire"))
                    .addContent(LayoutElementBuilders.Spacer.Builder().setWidth(dp(6f)).build())
                    .addContent(quickActionChip(context, TileClicks.FAVORITES, ICON_HEART, ACCENT, "Titres aimés"))
                    .build()
                body.addContent(LayoutElementBuilders.Spacer.Builder().setHeight(dp(6f)).build())
                body.addContent(quickRow)
            }
            val label = Text.Builder(context, "En lecture")
                .setTypography(Typography.TYPOGRAPHY_CAPTION2)
                .setColor(argb(ACCENT))
                .build()
            return PrimaryLayout.Builder(device)
                .setPrimaryLabelTextContent(label)
                .setContent(body.build())
                .build()
        }
    }
}

/**
 * Asks the system to draw the tile again when what it shows changed (another song, play or pause, starred state, or
 * the link with the phone): not for the progress of the song, which the tile does not show.
 */
class TileRefresher(private val context: Context) {
    @Volatile private var shown: TileContent? = null

    fun update(state: LinkUiState) {
        val content = TileContent.of(state)
        if (content == shown) return
        shown = content
        runCatching { TileService.getUpdater(context).requestUpdate(NowPlayingTileService::class.java) }
    }
}
