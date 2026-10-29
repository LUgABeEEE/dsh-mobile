package io.github.sayach.dshmobile

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import org.json.JSONObject

/** Largest single boot batch this cache accepts; the gateway caps merged batches well below it. */
internal const val MAX_BOOT_ASSET_BYTES = 8L * 1024 * 1024

/**
 * On-disk copies of revisioned boot batches, bounded by [quotaBytes] and evicted least-recently-used.
 *
 * A URL is only a module-selection key: the gateway can reassemble the same path when its layout
 * file changes, so every entry keeps the response validator and every hit revalidates. Writes are
 * atomic (`.part` + rename), so a crash or an interrupted transfer never leaves a servable item.
 * Entries are stored under a private directory; bodies are JavaScript only and never credentials.
 */
internal class BootAssetStore(
    private val directory: File,
    private val quotaBytes: Long = DEFAULT_QUOTA_BYTES,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    internal data class Entry(
        val key: String,
        val etag: String,
        val contentType: String,
        val size: Long,
        val lastUsedAt: Long,
    )

    private val indexFile = File(directory, INDEX_FILE)
    private val entries = mutableMapOf<String, Entry>()
    private var loaded = false
    private var totalBytes = 0L

    /** Returns the stored metadata for [key] without touching its recency. */
    @Synchronized
    fun entry(key: String): Entry? {
        ensureLoaded()
        return entries[key]
    }

    /** Reads a complete body. A size mismatch or unreadable file drops the entry instead of returning bytes. */
    @Synchronized
    fun read(key: String): ByteArray? {
        ensureLoaded()
        val entry = entries[key] ?: return null
        val bytes = runCatching { bodyFile(key).readBytes() }.getOrNull()
        if (bytes == null || bytes.size.toLong() != entry.size) {
            removeLocked(key)
            persistIndexLocked()
            return null
        }
        return bytes
    }

    /** Records a successful hit. The index is flushed by the next write; LRU survives restarts approximately. */
    @Synchronized
    fun markUsed(key: String) {
        ensureLoaded()
        val entry = entries[key] ?: return
        entries[key] = entry.copy(lastUsedAt = clock())
    }

    /** Stores one complete body and evicts older entries until the quota holds. */
    @Synchronized
    fun put(key: String, etag: String, contentType: String, body: ByteArray): Boolean {
        ensureLoaded()
        if (etag.isBlank() || body.isEmpty()) return false
        if (body.size > MAX_BOOT_ASSET_BYTES || body.size > quotaBytes) return false
        if (!directory.isDirectory && !directory.mkdirs()) return false
        if (!writeAtomically(bodyFile(key), body)) return false
        totalBytes -= entries[key]?.size ?: 0L
        entries[key] = Entry(key, etag, contentType, body.size.toLong(), clock())
        totalBytes += body.size
        evictLocked(keep = key)
        persistIndexLocked()
        return true
    }

    /** Drops one entry; the body file is deleted even when the index never knew it. */
    @Synchronized
    fun remove(key: String) {
        ensureLoaded()
        removeLocked(key)
        persistIndexLocked()
    }

    /** Deletes every cached body and the index. Safe to call before the directory exists. */
    @Synchronized
    fun clear() {
        loaded = true
        entries.clear()
        totalBytes = 0L
        directory.listFiles()?.forEach { it.delete() }
    }

    private fun ensureLoaded() {
        if (loaded) return
        loaded = true
        val stored = runCatching { JSONObject(indexFile.readText()) }
            .getOrNull()
            ?.optJSONObject("entries")
        stored?.keys()?.forEach { key ->
            val row = stored.optJSONObject(key) ?: return@forEach
            val etag = row.optString("etag").takeIf { it.isNotBlank() } ?: return@forEach
            val size = row.optLong("size", -1L)
            val file = bodyFile(key)
            if (size <= 0L || size > MAX_BOOT_ASSET_BYTES || !file.isFile || file.length() != size) return@forEach
            entries[key] = Entry(
                key = key,
                etag = etag,
                contentType = row.optString("contentType", DEFAULT_CONTENT_TYPE),
                size = size,
                lastUsedAt = row.optLong("lastUsedAt", 0L),
            )
            totalBytes += size
        }
        pruneUnreferencedFiles()
    }

    /** Drops bodies the index does not reference and any interrupted `.part` write. */
    private fun pruneUnreferencedFiles() {
        val referenced = entries.keys.mapTo(HashSet()) { bodyFile(it).name }
        directory.listFiles()?.forEach { file ->
            if (file.name.endsWith(PART_SUFFIX) || (file.name.endsWith(BODY_SUFFIX) && file.name !in referenced)) {
                file.delete()
            }
        }
    }

    private fun evictLocked(keep: String) {
        var oldest = oldestCandidate(keep)
        while (totalBytes > quotaBytes && oldest != null) {
            removeLocked(oldest.key)
            oldest = oldestCandidate(keep)
        }
    }

    private fun oldestCandidate(keep: String): Entry? = entries.values
        .asSequence()
        .filter { it.key != keep }
        .minByOrNull { it.lastUsedAt }

    private fun removeLocked(key: String) {
        val entry = entries.remove(key)
        if (entry != null) totalBytes -= entry.size
        bodyFile(key).delete()
    }

    private fun persistIndexLocked() {
        if (!directory.isDirectory && !directory.mkdirs()) return
        val rows = JSONObject()
        entries.values.forEach { entry ->
            rows.put(entry.key, JSONObject().apply {
                put("etag", entry.etag)
                put("contentType", entry.contentType)
                put("size", entry.size)
                put("lastUsedAt", entry.lastUsedAt)
            })
        }
        val body = JSONObject().apply {
            put("version", INDEX_VERSION)
            put("entries", rows)
        }.toString().toByteArray(Charsets.UTF_8)
        writeAtomically(indexFile, body)
    }

    private fun bodyFile(key: String): File = File(directory, digest(key) + BODY_SUFFIX)

    private fun writeAtomically(target: File, bytes: ByteArray): Boolean {
        val part = File(target.parentFile, "${target.name}.part")
        val written = runCatching {
            FileOutputStream(part).use { output ->
                output.write(bytes)
                output.flush()
                output.fd.sync()
            }
        }.isSuccess
        if (!written) {
            part.delete()
            return false
        }
        return runCatching {
            Files.move(part.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }.recoverCatching {
            // A filesystem without atomic moves still replaces the target; the partial file is gone.
            Files.move(part.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }.onFailure {
            part.delete()
        }.isSuccess
    }

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private companion object {
        const val DEFAULT_QUOTA_BYTES = 64L * 1024 * 1024
        const val BODY_SUFFIX = ".bin"
        const val PART_SUFFIX = ".part"
        const val INDEX_FILE = "index.json"
        const val INDEX_VERSION = 1
        const val DEFAULT_CONTENT_TYPE = "text/javascript"
    }
}
