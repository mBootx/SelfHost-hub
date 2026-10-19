package com.selfhosthub.wear.data

import com.selfhosthub.wear.data.db.ArtworkDao
import com.selfhosthub.wear.data.db.ArtworkEntity
import com.selfhosthub.wear.data.net.SubsonicApi
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The three sizes a cover is kept at. Lists use the first, the song playing uses the last. */
enum class ArtworkSize(val pixels: Int) { THUMBNAIL(160), MEDIUM(320), LARGE(640) }

/**
 * Covers, from the watch's own storage when it has them and from Navidrome otherwise. The server resizes, so a
 * list of two hundred albums costs two hundred small downloads once, and the large size is only ever fetched
 * for the song that is playing.
 */
class ArtworkRepository(
    private val dao: ArtworkDao,
    private val api: SubsonicApi,
    private val now: () -> Long = System::currentTimeMillis
) {
    // One download per cover at a time: a list that scrolls back and forth asks for the same ones again.
    private val locks = ConcurrentHashMap<String, Mutex>()

    /** The cover at `size`, or null when the server has none (or cannot be reached and none is stored). */
    suspend fun get(coverId: String, size: ArtworkSize): ByteArray? {
        val mutex = locks.getOrPut(coverId) { Mutex() }
        return mutex.withLock {
            val stored = dao.get(coverId)
            readStored(stored, size)?.let { return@withLock it }
            try {
                // A larger size is only stored next to a thumbnail, so the thumbnail comes first.
                val thumbnail = stored?.thumbnail ?: api.coverArt(coverId, ArtworkSize.THUMBNAIL.pixels)
                val bytes = if (size == ArtworkSize.THUMBNAIL) thumbnail else api.coverArt(coverId, size.pixels)
                val base = stored ?: ArtworkEntity(coverId, thumbnail)
                dao.upsert(
                    when (size) {
                        ArtworkSize.THUMBNAIL -> base.copy(thumbnail = bytes, updatedAt = now())
                        ArtworkSize.MEDIUM -> base.copy(medium = bytes, updatedAt = now())
                        ArtworkSize.LARGE -> base.copy(large = bytes, updatedAt = now())
                    }
                )
                bytes
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Offline or no such cover: fall back to a smaller size that is stored, which beats no picture.
                stored?.let { it.large ?: it.medium ?: it.thumbnail }
            }
        }
    }

    private fun readStored(stored: ArtworkEntity?, size: ArtworkSize): ByteArray? = when (size) {
        ArtworkSize.THUMBNAIL -> stored?.thumbnail
        ArtworkSize.MEDIUM -> stored?.medium
        ArtworkSize.LARGE -> stored?.large
    }

    /** What the stored covers weigh, in bytes. */
    suspend fun cacheBytes(): Long = dao.totalBytes()

    suspend fun clear() = dao.clear()

    /** Deletes the oldest covers until the rest weighs at most `maxBytes`. */
    suspend fun trimTo(maxBytes: Long) {
        var total = dao.totalBytes()
        if (total <= maxBytes) return
        for (entry in dao.sizesOldestFirst()) {
            if (total <= maxBytes) break
            dao.delete(entry.coverId)
            total -= entry.bytes
        }
    }

    /** Large covers are only worth keeping while their song is around: drops those not used for `maxAgeMs`. */
    suspend fun dropOldLarge(maxAgeMs: Long) = dao.dropLargeOlderThan(now() - maxAgeMs)
}
