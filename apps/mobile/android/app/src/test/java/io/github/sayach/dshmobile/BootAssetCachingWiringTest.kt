package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The policy and store are covered behaviorally; this contract keeps the WebView wiring from
 * silently widening what is intercepted or losing the two places that must clear the cache.
 */
class BootAssetCachingWiringTest {
    private fun source(name: String): String = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base ->
            listOf("app/src/main", "src/main", "apps/mobile/android/app/src/main").asSequence()
                .map { File(base, "$it/java/io/github/sayach/dshmobile/$name") }
        }
        .first { it.isFile }
        .readText()

    @Test
    fun theClientInterceptsOnlySubresourceGetsAndNeverFabricatesABody() {
        val text = source("SecureWebViewClient.kt")
        val method = text.substringAfter("override fun shouldInterceptRequest(")
            .substringBefore("\n    override fun ")
        assertTrue(method.contains("request.method != \"GET\" || request.isForMainFrame"))
        assertTrue(method.contains("cache.resolve(request.url.toString())"))
        assertTrue(method.contains("resolved !is BootAssetCache.Result.Body"))
        assertTrue(method.contains("ByteArrayInputStream(resolved.body)"))
    }

    @Test
    fun theActivityWiresTheCacheAndClearsItWithSiteDataAndDeviceRemoval() {
        val text = source("MainActivity.kt")
        assertTrue(text.contains("private val bootAssetStore by lazy { BootAssetStore(File(filesDir, \"boot-assets\")) }"))
        assertTrue(text.contains("fetcher = HttpBootAssetFetcher(origin, bootTransport, caCertificate, browser.settings.userAgentString)"))
        assertTrue(text.contains("bootAssets = bootAssets"))
        val clearSiteData = text.substringAfter("private fun clearSiteData()").substringBefore("private fun shareGateway(")
        assertTrue(clearSiteData.contains("bootAssetStore.clear()"))
        val deleteDevice = text.substringAfter("private fun confirmDeleteDevice(").substringBefore("private fun showDeviceUndo(")
        assertTrue(deleteDevice.contains("bootAssetStore.clear()"))
    }
}
