package io.github.sayach.dshmobile

import java.net.URI

/**
 * Decides which URLs may be answered by the device-side boot-asset cache.
 *
 * Only the gateway's content-revisioned batches qualify: `origin + path` is the module-selection
 * key, and every hit still revalidates because the same path can be reassembled with different
 * layout bytes. Documents, API responses, credentials and non-revisioned assets never qualify.
 */
internal object BootAssetPolicy {
    private val REVISIONED_BATCH = Regex("^/mobile-access/mobile-boot/[0-9a-f]{64}\\.js$")

    /** Returns the storage key, or null when the cache must not answer this URL. */
    fun key(origin: GatewayOrigin, rawUrl: String): String? {
        val candidate = runCatching { URI(rawUrl) }.getOrNull() ?: return null
        if (!candidate.isAbsolute || candidate.isOpaque) return null
        if (candidate.scheme?.lowercase() != "https") return null
        if (candidate.rawUserInfo != null || candidate.rawQuery != null || candidate.rawFragment != null) return null
        val path = candidate.rawPath ?: return null
        if (!REVISIONED_BATCH.matches(path)) return null
        if (!GatewayUrlPolicy.isSameOrigin(origin, rawUrl)) return null
        return origin.serialized + path
    }
}

/** One transport attempt for a boot batch; only [Modified] carries bytes to serve. */
internal sealed interface BootAssetFetch {
    data class Modified(val etag: String?, val contentType: String, val body: ByteArray) : BootAssetFetch
    data object NotModified : BootAssetFetch
    data object Rejected : BootAssetFetch
    data object Failed : BootAssetFetch
}

/** Performs the authenticated conditional request that keeps a cached body valid. */
internal fun interface BootAssetFetcher {
    fun fetch(url: String, etag: String?): BootAssetFetch
}

/**
 * Serves a boot batch from disk only after the current session revalidated it.
 *
 * The URL is content-revisioned against the module list, but the gateway reassembles the layout
 * batch when its layout file changes. A URL hit therefore still sends [If-None-Match]: a 304 keeps
 * the stored body, a 200 replaces it, and 401/403/network failures fall through to the WebView so
 * authentication and revocation keep their normal behavior.
 */
internal class BootAssetCache(
    private val origin: GatewayOrigin,
    private val store: BootAssetStore,
    private val fetcher: BootAssetFetcher,
) {
    internal sealed interface Result {
        data class Body(val body: ByteArray, val contentType: String, val etag: String?) : Result
        data object Miss : Result
    }

    fun resolve(rawUrl: String): Result {
        val key = BootAssetPolicy.key(origin, rawUrl) ?: return Result.Miss
        val cached = store.entry(key)
        return when (val fetched = fetcher.fetch(rawUrl, cached?.etag)) {
            BootAssetFetch.NotModified -> {
                val body = cached?.let { store.read(key) }
                if (cached != null && body != null) {
                    store.markUsed(key)
                    Result.Body(body, cached.contentType, cached.etag)
                } else {
                    // The index outlived its body; drop it and retry without a validator.
                    if (cached != null) store.remove(key)
                    storeAndServe(key, fetcher.fetch(rawUrl, null))
                }
            }
            is BootAssetFetch.Modified -> storeAndServe(key, fetched)
            BootAssetFetch.Rejected, BootAssetFetch.Failed -> Result.Miss
        }
    }

    private fun storeAndServe(key: String, fetched: BootAssetFetch): Result {
        val modified = fetched as? BootAssetFetch.Modified ?: return Result.Miss
        // Anything but JavaScript means the response is not a boot batch; leave it to the WebView.
        if (!isJavaScript(modified.contentType)) return Result.Miss
        if (!modified.etag.isNullOrBlank()) {
            store.put(key, modified.etag, modified.contentType, modified.body)
        }
        return Result.Body(modified.body, modified.contentType, modified.etag)
    }

    private fun isJavaScript(contentType: String): Boolean = when (
        contentType.substringBefore(';').trim().lowercase()
    ) {
        "text/javascript", "application/javascript" -> true
        else -> false
    }
}
