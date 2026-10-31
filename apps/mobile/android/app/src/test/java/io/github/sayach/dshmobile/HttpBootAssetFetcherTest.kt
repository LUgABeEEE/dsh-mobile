package io.github.sayach.dshmobile

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.concurrent.CopyOnWriteArrayList
import java.util.zip.GZIPOutputStream
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Exercises the real conditional fetch over the pinned loopback transport. */
class HttpBootAssetFetcherTest {
    private val path = "/mobile-access/mobile-boot/${"c".repeat(64)}.js"
    private val body = "boot-body".toByteArray()

    @Test
    fun firstFetchStoresTheValidatorAndTheSecondRevalidatesWithA304() {
        val server = BatchServer(body, etag = "\"v1\"")
        try {
            val fetcher = fetcher(server)
            val url = server.origin.serialized + path

            val first = fetcher.fetch(url, null)

            assertTrue(first is BootAssetFetch.Modified)
            first as BootAssetFetch.Modified
            assertArrayEquals(body, first.body)
            assertEquals("\"v1\"", first.etag)
            assertEquals("text/javascript", first.contentType)
            assertEquals("dsh_ma_session=abc", server.requests[0]["cookie"])
            assertEquals("test-agent", server.requests[0]["user-agent"])

            assertEquals(BootAssetFetch.NotModified, fetcher.fetch(url, "\"v1\""))
            assertEquals("\"v1\"", server.requests[1]["if-none-match"])
        } finally {
            server.close()
        }
    }

    @Test
    fun anUnauthorizedResponseFallsThroughInsteadOfServingBytes() {
        val server = BatchServer(body, status = 401)
        try {
            assertEquals(BootAssetFetch.Rejected, fetcher(server).fetch(server.origin.serialized + path, "\"v1\""))
        } finally {
            server.close()
        }
    }

    @Test
    fun urlsOutsideTheRevisionedBootPrefixNeverOpenAConnection() {
        val server = BatchServer(body)
        try {
            val fetcher = fetcher(server)
            assertEquals(BootAssetFetch.Failed, fetcher.fetch(server.origin.serialized + "/mobile-access/compat.js", null))
            assertTrue(server.requests.isEmpty())
        } finally {
            server.close()
        }
    }

    @Test
    fun aStalledResponseFailsWithinTheReadBudgetInsteadOfHoldingThePage() {
        val server = BatchServer(body, hang = true)
        try {
            assertEquals(
                BootAssetFetch.Failed,
                fetcher(server, readTimeoutMs = 300).fetch(server.origin.serialized + path, null),
            )
        } finally {
            server.close()
        }
    }

    @Test
    fun anUnsupportedContentEncodingFallsBackInsteadOfStoringOpaqueBytes() {
        val server = BatchServer(body, contentEncoding = "br")
        try {
            assertEquals(
                BootAssetFetch.Failed,
                fetcher(server).fetch(server.origin.serialized + path, null),
            )
        } finally {
            server.close()
        }
    }

    @Test
    fun aDeclaredBodyOverTheCapIsRefusedBeforeReadingIt() {
        val server = BatchServer(body, declaredLength = (MAX_BOOT_ASSET_BYTES + 1).toInt())
        try {
            assertEquals(
                BootAssetFetch.Failed,
                fetcher(server).fetch(server.origin.serialized + path, null),
            )
        } finally {
            server.close()
        }
    }

    private fun fetcher(
        server: BatchServer,
        connectTimeoutMs: Int = 5_000,
        readTimeoutMs: Int = 5_000,
    ): HttpBootAssetFetcher = HttpBootAssetFetcher(
        origin = server.origin,
        caCertificate = TestCertificates.ingressCa,
        userAgent = "test-agent",
        cookieProvider = { "dsh_ma_session=abc" },
        connectTimeoutMs = connectTimeoutMs,
        readTimeoutMs = readTimeoutMs,
    )

    private class BatchServer(
        private val body: ByteArray,
        private val etag: String = "\"v1\"",
        private val status: Int = 200,
        private val declaredLength: Int? = null,
        private val hang: Boolean = false,
        private val contentEncoding: String = "gzip",
    ) {
        val requests = CopyOnWriteArrayList<Map<String, String>>()
        private val serverSocket =
            serverContext().serverSocketFactory.createServerSocket(0, 4, InetAddress.getByName(LOOPBACK)) as SSLServerSocket
        val origin: GatewayOrigin = GatewayOrigin.parse("https://$LOOPBACK:${serverSocket.localPort}")!!
        private val worker = Thread({ serve() }, "boot-asset-test-server").apply {
            isDaemon = true
            start()
        }

        fun close() {
            runCatching { serverSocket.close() }
            worker.join(SOCKET_TIMEOUT_MS.toLong())
        }

        private fun serve() {
            while (true) {
                val client = try {
                    serverSocket.accept()
                } catch (_: IOException) {
                    return
                }
                try {
                    respond(client)
                } catch (_: IOException) {
                    // A client that aborts ends only this connection.
                } finally {
                    runCatching { client.close() }
                }
            }
        }

        private fun respond(client: Socket) {
            client.soTimeout = SOCKET_TIMEOUT_MS
            val input = client.getInputStream().buffered()
            readLine(input) ?: return
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = readLine(input) ?: return
                if (line.isEmpty()) break
                headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
            }
            requests += headers
            val output = client.getOutputStream()
            if (hang) {
                Thread.sleep(1_000)
                return
            }
            if (status != 200) {
                output.write("HTTP/1.1 $status Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                output.flush()
                return
            }
            if (headers["if-none-match"] == etag) {
                output.write("HTTP/1.1 304 Not Modified\r\nETag: $etag\r\nConnection: close\r\n\r\n".toByteArray())
                output.flush()
                return
            }
            val payload = gzip(body)
            val response = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/javascript; charset=utf-8\r\n" +
                "Content-Length: ${declaredLength ?: payload.size}\r\n" +
                "Content-Encoding: $contentEncoding\r\n" +
                "ETag: $etag\r\n" +
                "Connection: close\r\n\r\n"
            output.write(response.toByteArray())
            if (declaredLength == null) output.write(payload)
            output.flush()
        }

        private fun readLine(input: InputStream): String? {
            val line = StringBuilder()
            while (true) {
                val next = input.read()
                if (next < 0) return line.takeIf { it.isNotEmpty() }?.toString()
                if (next == '\n'.code) return line.toString().removeSuffix("\r")
                line.append(next.toChar())
            }
        }

        private fun gzip(bytes: ByteArray): ByteArray {
            val output = ByteArrayOutputStream()
            GZIPOutputStream(output).use { it.write(bytes) }
            return output.toByteArray()
        }

        private fun serverContext(): SSLContext {
            val certificate = CertificateFactory.getInstance("X.509")
                .generateCertificate(ByteArrayInputStream(TestCertificates.leafLoopback)) as X509Certificate
            val key = KeyFactory.getInstance("RSA")
                .generatePrivate(PKCS8EncodedKeySpec(TestCertificates.leafLoopbackKey))
            val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                load(null)
                setKeyEntry(KEY_ALIAS, key, EMPTY_PASSWORD, arrayOf(certificate))
            }
            val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
                .apply { init(store, EMPTY_PASSWORD) }
                .keyManagers
            return SSLContext.getInstance("TLS").apply { init(managers, null, null) }
        }

        private companion object {
            const val LOOPBACK = "127.0.0.1"
            const val SOCKET_TIMEOUT_MS = 5_000
            const val KEY_ALIAS = "gateway"
            val EMPTY_PASSWORD = charArrayOf()
        }
    }
}
