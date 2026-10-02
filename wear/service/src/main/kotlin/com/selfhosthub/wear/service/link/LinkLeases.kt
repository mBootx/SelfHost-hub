package com.selfhosthub.wear.service.link

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What is switched on and off by the leases: the watch keeping in touch with the phone. */
interface LinkSwitch {
    fun start()
    fun stop()
}

/**
 * Several parts of the app want to keep in touch with the phone (the screen while it is shown); the keeping goes on
 * while any of them holds a lease, and stops a little after the last lets go, so that turning the wrist does not stop
 * it and start it again.
 */
class LinkLeases(private val link: LinkSwitch, private val scope: CoroutineScope, private val graceMs: Long = 15_000) {
    private var count = 0
    private var stopJob: Job? = null

    inner class Lease internal constructor() : AutoCloseable {
        private var released = false

        override fun close() {
            synchronized(this@LinkLeases) {
                if (released) return
                released = true
                count--
                if (count <= 0) {
                    count = 0
                    stopJob = scope.launch {
                        delay(graceMs)
                        synchronized(this@LinkLeases) {
                            if (count == 0) link.stop()
                        }
                    }
                }
            }
        }
    }

    @Synchronized
    fun acquire(): Lease {
        count++
        stopJob?.cancel()
        stopJob = null
        link.start()
        return Lease()
    }

    /** How many parts of the app currently want it. */
    @get:Synchronized
    val holders: Int get() = count
}
