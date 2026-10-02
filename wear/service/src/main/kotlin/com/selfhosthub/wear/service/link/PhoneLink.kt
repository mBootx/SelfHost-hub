package com.selfhosthub.wear.service.link

import com.selfhosthub.wear.core.DeviceState
import com.selfhosthub.wear.core.LinkCodec
import com.selfhosthub.wear.core.LinkMessage
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.core.Snapshot
import com.selfhosthub.wear.core.WatchPrefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** How messages get to the phone: the Wear OS data layer, or a stand-in in the tests. */
interface LinkTransport {
    /** The phones connected right now (their node ids). Throws when the data layer cannot be reached. */
    suspend fun phones(): List<String>

    /** Hands one message for the phone `nodeId` to the data layer. Throws when that cannot be done. */
    suspend fun send(nodeId: String, path: String, data: ByteArray)
}

/**
 * The watch's seat at the phone app, which is the only thing it talks to: the phone answers with the state of the
 * players (its own, and the PC's and the others that its hub link lists) and carries out the commands sent to it. It
 * pushes a new state by itself when something changes, so the watch hears about a song starting without asking.
 *
 * While a screen is shown (see LinkLeases) the watch asks every half minute, which is also how it learns that the
 * phone has gone: no phone connected, or a phone whose app does not answer. Between two messages the progress of a
 * playing song is moved along by the clock (PlayerSnapshot.positionAt).
 */
class PhoneLink(
    private val transport: LinkTransport,
    private val scope: CoroutineScope,
    private val prefs: WatchPrefs,
    private val clock: () -> Long = System::currentTimeMillis,
    private val answerTimeoutMs: Long = 6_000,
    private val refreshEveryMs: Long = 30_000
) : LinkSwitch {
    private val _state = MutableStateFlow(LinkUiState(manualTargetId = prefs.manualTargetId))
    val state: StateFlow<LinkUiState> = _state.asStateFlow()

    private val lock = Any()
    private val playingSince = HashMap<String, Long>()

    /** When the phone last said anything (a snapshot, or that its app is closed). */
    @Volatile private var lastHeardAt = Long.MIN_VALUE
    private var job: Job? = null

    private class Outgoing(val target: String, val command: PlayerCommand)

    /** The commands waiting to go out, in the order they were given. */
    private val outbox = ArrayDeque<Outgoing>()
    private val outboxWake = Channel<Unit>(Channel.CONFLATED)

    init {
        // One at a time and in order: commands given in quick succession (the crown turning) must not overtake each other.
        scope.launch {
            while (true) {
                outboxWake.receive()
                while (true) {
                    val next = synchronized(lock) { outbox.removeFirstOrNull() } ?: break
                    withTimeoutOrNull(DELIVERY_TIMEOUT_MS) { deliver(next.target, next.command) }
                }
            }
        }
    }

    /** Starts keeping in touch: asks now, and again every half minute. Calling it again does nothing. */
    @Synchronized
    override fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (currentCoroutineContext().isActive) {
                ask()
                delay(refreshEveryMs)
            }
        }
    }

    @Synchronized
    override fun stop() {
        job?.cancel()
        job = null
    }

    /** Asks the phone for the state now (the screen woke up, the user pulled to retry). */
    fun refresh() {
        scope.launch { ask() }
    }

    /** What the phone sent, from the service that receives the data layer's messages. */
    fun onMessage(path: String, data: ByteArray) {
        when (val message = LinkCodec.parse(path, String(data, Charsets.UTF_8))) {
            is LinkMessage.Snap -> {
                lastHeardAt = clock()
                apply(message.snapshot)
            }
            LinkMessage.Closed -> {
                lastHeardAt = clock()
                lose(LinkStatus.PHONE_APP_CLOSED)
            }
            is LinkMessage.UnsupportedVersion -> {
                lastHeardAt = clock()
                lose(LinkStatus.VERSION_MISMATCH)
            }
            is LinkMessage.Unknown -> Unit
        }
    }

    /** Controls a player by hand (null: follow the one that plays). */
    fun selectTarget(id: String?) {
        prefs.manualTargetId = id
        _state.update { current -> retarget(current.copy(manualTargetId = id)) }
    }

    /**
     * Sends a command to the player the controls act on, and shows its effect at once. Returns whether the phone was
     * answering a moment ago; the command goes out either way, and the state says so if there is nobody to take it.
     * Something to play is always asked of the phone itself.
     */
    fun send(command: PlayerCommand): Boolean {
        val current = _state.value
        val target = targetFor(current, command)
        applyOptimistically(target, command)
        if (command is PlayerCommand.PlayMedia && current.manualTargetId != null && current.manualTargetId != LinkProtocol.PHONE_ID) {
            // What was just asked to play is on the phone: follow it, as a player picked by hand would hide it.
            selectTarget(null)
        }
        enqueue(target, command)
        return current.connected
    }

    private fun enqueue(target: String, command: PlayerCommand) {
        synchronized(lock) {
            // A later seek or volume replaces an earlier one that has not gone out yet: the crown makes many, only the last counts.
            if (command is PlayerCommand.Seek || command is PlayerCommand.SetVolume) {
                outbox.removeAll { it.target == target && it.command::class == command::class }
            }
            outbox.addLast(Outgoing(target, command))
        }
        outboxWake.trySend(Unit)
    }

    private companion object {
        const val DELIVERY_TIMEOUT_MS = 8_000L
    }

    /** Like send, but returns once the command has been handed to the data layer: for a button whose process may end right after. */
    suspend fun sendAndWait(command: PlayerCommand): Boolean {
        val target = targetFor(_state.value, command)
        applyOptimistically(target, command)
        return deliver(target, command)
    }

    // --- Talking to the phone ---

    private fun targetFor(current: LinkUiState, command: PlayerCommand): String =
        if (command is PlayerCommand.PlayMedia) LinkProtocol.PHONE_ID else current.targetId ?: LinkProtocol.PHONE_ID

    private suspend fun ask() {
        val asked = clock()
        val phones = phonesOrNone()
        if (phones.isEmpty()) {
            lose(LinkStatus.NO_PHONE)
            return
        }
        val request = LinkCodec.request().toByteArray(Charsets.UTF_8)
        if (phones.count { trySend(it, LinkProtocol.REQUEST_PATH, request) } == 0) {
            lose(LinkStatus.NO_PHONE)
            return
        }
        scope.launch {
            delay(answerTimeoutMs)
            // Nobody answered in time: the phone is there, its app is not (closed, or too old to know this link).
            if (lastHeardAt < asked) lose(LinkStatus.PHONE_APP_CLOSED)
        }
    }

    private suspend fun deliver(target: String, command: PlayerCommand): Boolean {
        val phones = phonesOrNone()
        val body = LinkCodec.command(target, command).toByteArray(Charsets.UTF_8)
        if (phones.count { trySend(it, LinkProtocol.COMMAND_PATH, body) } == 0) {
            lose(LinkStatus.NO_PHONE)
            return false
        }
        return true
    }

    private suspend fun phonesOrNone(): List<String> =
        try {
            transport.phones()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }

    private suspend fun trySend(nodeId: String, path: String, data: ByteArray): Boolean =
        try {
            transport.send(nodeId, path, data)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            false
        }

    // --- What the phone says ---

    private fun apply(snapshot: Snapshot) {
        val now = clock()
        val ids = snapshot.devices.map { it.deviceId }.toSet()
        synchronized(lock) {
            val before = _state.value.players
            for ((id, player) in snapshot.states) {
                if (id !in ids) continue
                if (player.isPlaying && before[id]?.state?.isPlaying != true) playingSince[id] = now
                if (!player.isPlaying) playingSince.remove(id)
            }
            playingSince.keys.retainAll(ids)
        }
        _state.update { current ->
            val players = snapshot.states.filterKeys { it in ids }.mapValues { (_, player) -> PlayerSnapshot(player, now) }
            retarget(
                current.copy(
                    status = LinkStatus.CONNECTED,
                    phoneName = snapshot.phoneName,
                    pc = snapshot.pc,
                    devices = snapshot.devices,
                    players = players
                )
            )
        }
    }

    /** The phone cannot be reached: nothing known about the players is true any more. */
    private fun lose(status: LinkStatus) {
        synchronized(lock) { playingSince.clear() }
        _state.update { LinkUiState(status = status, manualTargetId = it.manualTargetId) }
    }

    /** Works out which player the controls act on, and remembers the one that played. */
    private fun retarget(current: LinkUiState): LinkUiState {
        val since = synchronized(lock) { HashMap(playingSince) }
        val target = TargetPicker.pick(current.devices, current.players, current.manualTargetId, prefs.lastTargetId, since)
        if (target != null && current.players[target]?.state?.isPlaying == true) prefs.lastTargetId = target
        return if (target == current.targetId) current else current.copy(targetId = target)
    }

    /** Shows the effect of a command before the player's own state arrives, which makes the controls feel immediate. */
    private fun applyOptimistically(targetId: String, command: PlayerCommand) {
        val now = clock()
        _state.update { current ->
            val snapshot = current.players[targetId] ?: return@update current
            val base = snapshot.state.copy(currentTime = snapshot.positionAt(now))
            val next: DeviceState = when (command) {
                PlayerCommand.Toggle -> base.copy(isPlaying = !base.isPlaying)
                PlayerCommand.Play -> base.copy(isPlaying = true)
                PlayerCommand.Pause -> base.copy(isPlaying = false)
                is PlayerCommand.Seek -> base.copy(currentTime = command.seconds.coerceAtLeast(0.0))
                is PlayerCommand.SetVolume -> base.copy(volume = command.volume.coerceIn(0.0, 1.0))
                PlayerCommand.ToggleShuffle -> base.copy(shuffle = !base.shuffle)
                is PlayerCommand.SetRepeatMode -> base.copy(repeatMode = command.mode)
                else -> return@update current
            }
            current.copy(players = current.players + (targetId to PlayerSnapshot(next, now)))
        }
    }
}
