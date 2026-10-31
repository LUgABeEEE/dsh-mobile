package io.github.sayach.dshmobile

import android.webkit.CookieManager
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.util.zip.GZIPInputStream
import javax.net.ssl.HttpsURLConnection

/**
 * Fetches one revisioned boot batch over the same pinned transport the shell already uses.
 *
 * Requests carry the WebView's own session cookie, so a cached body is only ever served after the
 * gateway answered the current request (304). Responses without a validator are served but not
 * stored; 401/403 and any transport failure are reported as [BootAssetFetch.Rejected] or
 * [BootAssetFetch.Failed] and fall through to the WebView's normal path.
 */
internal class HttpBootAssetFetcher(
    private val origin: GatewayOrigin,
    private val transport: TransportEndpoint = LocalTransport,
    private val caCertificate: ByteArray?,
    private val userAgent: String?,
    private val cookieProvider: (String) -> String? = { url -> CookieManager.getInstance().getCookie(url) },
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 20_000,
) : BootAssetFetcher {
    override fun fetch(url: String, etag: String?): BootAssetFetch {
        if (BootAssetPolicy.key(origin, url) == null) return BootAssetFetch.Failed
        val path = runCatching { URI(url).rawPath }.getOrNull() ?: return BootAssetFetch.Failed
        val connection = runCatching { transport.open(origin, path) }.getOrNull() ?: return BootAssetFetch.Failed
        return try {
            if (caCertificate != null) connection.sslSocketFactory = PinnedTls.socketFactory(caCertificate)
            connection.instanceFollowRedirects = false
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.useCaches = false
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept-Encoding", "gzip")
            if (!userAgent.isNullOrBlank()) connection.setRequestProperty("User-Agent", userAgent)
            if (!etag.isNullOrBlank()) connection.setRequestProperty("If-None-Match", etag)
            cookieProvider(url)?.takeIf { it.isNotBlank() }?.let { cookie ->
                connection.setRequestProperty("Cookie", cookie)
            }
            when (connection.responseCode) {
                HTTP_NOT_MODIFIED -> BootAssetFetch.NotModified
                HTTP_OK -> readResponse(connection)
                HTTP_UNAUTHORIZED, HTTP_FORBIDDEN -> BootAssetFetch.Rejected
                else -> BootAssetFetch.Failed
            }
        } catch (_: IOException) {
            BootAssetFetch.Failed
        } catch (_: RuntimeException) {
            BootAssetFetch.Failed
        } finally {
            connection.disconnect()
        }
    }

    private fun readResponse(connection: HttpsURLConnection): BootAssetFetch {
        if (connection.contentLengthLong > MAX_BOOT_ASSET_BYTES) return BootAssetFetch.Failed
        val encoding = connection.contentEncoding?.trim()?.lowercase()
        if (encoding != null && encoding != "gzip" && encoding != "identity") return BootAssetFetch.Failed
        val body = runCatching {
            val stream: InputStream = if (encoding == "gzip") {
                GZIPInputStream(connection.inputStream)
            } else {
                connection.inputStream
            }
            stream.use { readAtMost(it) }
        }.getOrNull() ?: return BootAssetFetch.Failed
        val contentType = connection.contentType
            ?.substringBefore(';')
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: DEFAULT_CONTENT_TYPE
        return BootAssetFetch.Modified(connection.getHeaderField("ETag"), contentType, body)
    }

    /** Reads a body but refuses to allocate past {@link MAX_BOOT_ASSET_BYTES}. */
    private fun readAtMost(input: InputStream): ByteArray? {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return output.toByteArray()
            total += read
            if (total > MAX_BOOT_ASSET_BYTES) return null
            output.write(buffer, 0, read)
        }
    }

    private companion object {
        const val HTTP_OK = 200
        const val HTTP_NOT_MODIFIED = 304
        const val HTTP_UNAUTHORIZED = 401
        const val HTTP_FORBIDDEN = 403
        const val DEFAULT_CONTENT_TYPE = "text/javascript"
    }
}
