package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The cache serves bytes only after the current session answered, and replaces them on a 200. */
class BootAssetCacheTest {
    private val origin = GatewayOrigin.parse("https://gateway.example")!!
    private val path = "/mobile-access/mobile-boot/${"b".repeat(64)}.js"
    private val batchUrl = "https://gateway.example$path"
    private val directory: File = kotlin.io.path.createTempDirectory("boot-cache").toFile()

    private class RecordingFetcher(private val results: MutableList<BootAssetFetch>) : BootAssetFetcher {
        val calls = mutableListOf<Pair<String, String?>>()
        override fun fetch(url: String, etag: String?): BootAssetFetch {
            calls += url to etag
            return results.removeAt(0)
        }
    }

    private fun store(): BootAssetStore = BootAssetStore(directory, quotaBytes = 1_000, clock = { 1_000L })

    @Test
    fun coldLoadStoresTheBodyUnderItsRevisionedKey() {
        val fetcher = RecordingFetcher(mutableListOf(
            BootAssetFetch.Modified("\"v1\"", "text/javascript", "body".toByteArray()),
        ))
        val store = store()
        val result = BootAssetCache(origin, store, fetcher).resolve(batchUrl)
        assertTrue(result is BootAssetCache.Result.Body)
        assertArrayEquals("body".toByteArray(), (result as BootAssetCache.Result.Body).body)
        assertEquals(listOf(batchUrl to null), fetcher.calls)
        assertEquals("\"v1\"", store.entry(BootAssetPolicy.key(origin, batchUrl)!!)?.etag)
    }

    @Test
    fun revalidatedHitServesTheStoredBodyAndSendsTheStoredValidator() {
        val store = store()
        val key = BootAssetPolicy.key(origin, batchUrl)!!
        store.put(key, "\"v1\"", "text/javascript", "stored".toByteArray())
        val fetcher = RecordingFetcher(mutableListOf(BootAssetFetch.NotModified))

        val result = BootAssetCache(origin, store, fetcher).resolve(batchUrl)

        assertArrayEquals("stored".toByteArray(), (result as BootAssetCache.Result.Body).body)
        assertEquals(listOf(batchUrl to "\"v1\""), fetcher.calls)
    }

    @Test
    fun aModifiedResponseReplacesTheStoredBytes() {
        val store = store()
        val key = BootAssetPolicy.key(origin, batchUrl)!!
        store.put(key, "\"v1\"", "text/javascript", "old".toByteArray())
        val fetcher = RecordingFetcher(mutableListOf(
            BootAssetFetch.Modified("\"v2\"", "text/javascript", "new".toByteArray()),
        ))

        val result = BootAssetCache(origin, store, fetcher).resolve(batchUrl)

        assertArrayEquals("new".toByteArray(), (result as BootAssetCache.Result.Body).body)
        assertArrayEquals("new".toByteArray(), store.read(key))
        assertEquals("\"v2\"", store.entry(key)?.etag)
    }

    @Test
    fun aRejectedSessionNeverServesTheCachedBody() {
        val store = store()
        val key = BootAssetPolicy.key(origin, batchUrl)!!
        store.put(key, "\"v1\"", "text/javascript", "stored".toByteArray())
        val fetcher = RecordingFetcher(mutableListOf(BootAssetFetch.Rejected))

        assertEquals(BootAssetCache.Result.Miss, BootAssetCache(origin, store, fetcher).resolve(batchUrl))
    }

    @Test
    fun aMissingBodyIsDroppedAndRetriedWithoutAValidator() {
        val store = store()
        val key = BootAssetPolicy.key(origin, batchUrl)!!
        store.put(key, "\"v1\"", "text/javascript", "old".toByteArray())
        directory.listFiles()!!.first { it.name.endsWith(".bin") }.delete()
        val fetcher = RecordingFetcher(mutableListOf(
            BootAssetFetch.NotModified,
            BootAssetFetch.Modified("\"v2\"", "text/javascript", "fresh".toByteArray()),
        ))

        val result = BootAssetCache(origin, store, fetcher).resolve(batchUrl)

        assertArrayEquals("fresh".toByteArray(), (result as BootAssetCache.Result.Body).body)
        assertEquals(listOf(batchUrl to "\"v1\"", batchUrl to null), fetcher.calls)
    }

    @Test
    fun revisionedAssetsOutsideTheBootPrefixNeverReachTheFetcher() {
        val fetcher = RecordingFetcher(mutableListOf())
        val result = BootAssetCache(origin, store(), fetcher)
            .resolve("https://gateway.example/mobile-access/compat.js")
        assertEquals(BootAssetCache.Result.Miss, result)
        assertTrue(fetcher.calls.isEmpty())
    }

    @Test
    fun aFailedFetchNeverStoresBytes() {
        val fetcher = RecordingFetcher(mutableListOf(BootAssetFetch.Failed))
        val store = store()
        assertEquals(BootAssetCache.Result.Miss, BootAssetCache(origin, store, fetcher).resolve(batchUrl))
        assertNull(store.entry(BootAssetPolicy.key(origin, batchUrl)!!))
    }

    @Test
    fun responsesWithoutAValidatorAreServedButNotStored() {
        val fetcher = RecordingFetcher(mutableListOf(
            BootAssetFetch.Modified(null, "text/javascript", "body".toByteArray()),
        ))
        val store = store()
        val result = BootAssetCache(origin, store, fetcher).resolve(batchUrl)
        assertTrue(result is BootAssetCache.Result.Body)
        assertNull(store.entry(BootAssetPolicy.key(origin, batchUrl)!!))
    }

    @Test
    fun nonJavaScriptResponsesFallBackToTheWebViewAndAreNotCached() {
        val fetcher = RecordingFetcher(mutableListOf(
            BootAssetFetch.Modified("\"v1\"", "text/plain", "not js".toByteArray()),
        ))
        val store = store()
        val result = BootAssetCache(origin, store, fetcher).resolve(batchUrl)
        assertEquals(BootAssetCache.Result.Miss, result)
        assertNull(store.entry(BootAssetPolicy.key(origin, batchUrl)!!))
    }
}
