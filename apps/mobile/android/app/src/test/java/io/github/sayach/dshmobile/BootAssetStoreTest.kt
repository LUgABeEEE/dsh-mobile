package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The store is the only component that touches disk; these tests pin its bounds and durability rules. */
class BootAssetStoreTest {
    private fun temporaryDirectory(): File = kotlin.io.path.createTempDirectory("boot-assets").toFile()

    private fun body(size: Int, marker: Byte = 0x41): ByteArray = ByteArray(size) { marker }

    @Test
    fun storesAndReadsACompleteBodyWithItsValidator() {
        val directory = temporaryDirectory()
        try {
            var now = 1_000L
            val store = BootAssetStore(directory, quotaBytes = 1_000, clock = { now })
            assertTrue(store.put("key", "\"v1\"", "text/javascript", body(4)))
            now = 2_000L
            store.markUsed("key")
            val entry = store.entry("key")
            assertEquals("\"v1\"", entry?.etag)
            assertEquals("text/javascript", entry?.contentType)
            assertEquals(4L, entry?.size)
            assertEquals(2_000L, entry?.lastUsedAt)
            assertArrayEquals(body(4), store.read("key"))
            assertTrue((directory.listFiles() ?: emptyArray()).none { it.name.endsWith(".part") })
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun evictsTheLeastRecentlyUsedEntryOnceTheQuotaIsExceeded() {
        val directory = temporaryDirectory()
        try {
            var now = 1_000L
            val store = BootAssetStore(directory, quotaBytes = 100, clock = { now })
            assertTrue(store.put("a", "\"a\"", "text/javascript", body(40)))
            now = 2_000L
            assertTrue(store.put("b", "\"b\"", "text/javascript", body(40)))
            now = 3_000L
            assertTrue(store.put("c", "\"c\"", "text/javascript", body(40)))

            assertNull(store.entry("a"))
            assertNull(store.read("a"))
            assertArrayEquals(body(40), store.read("b"))
            assertArrayEquals(body(40), store.read("c"))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun refusesBodiesLargerThanTheConfiguredQuota() {
        val directory = temporaryDirectory()
        try {
            val store = BootAssetStore(directory, quotaBytes = 100, clock = { 1_000L })
            assertFalse(store.put("large", "\"v1\"", "text/javascript", body(101)))
            assertNull(store.entry("large"))
            assertTrue(directory.listFiles().isNullOrEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun ignoresACorruptIndexInsteadOfServingUnknownBytes() {
        val directory = temporaryDirectory()
        try {
            directory.mkdirs()
            File(directory, "index.json").writeText("{not json")
            val store = BootAssetStore(directory, quotaBytes = 1_000, clock = { 1_000L })
            assertNull(store.entry("key"))
            assertTrue(store.put("key", "\"v1\"", "text/javascript", body(4)))
            assertArrayEquals(body(4), store.read("key"))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun dropsAnEntryWhenItsBodyFileDisappeared() {
        val directory = temporaryDirectory()
        try {
            val store = BootAssetStore(directory, quotaBytes = 1_000, clock = { 1_000L })
            assertTrue(store.put("key", "\"v1\"", "text/javascript", body(4)))
            directory.listFiles()!!.first { it.name.endsWith(".bin") }.delete()
            assertNull(store.read("key"))
            assertNull(store.entry("key"))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun removesInterruptedWritesAndBodiesTheIndexNeverReferenced() {
        val directory = temporaryDirectory()
        try {
            val store = BootAssetStore(directory, quotaBytes = 1_000, clock = { 1_000L })
            assertTrue(store.put("key", "\"v1\"", "text/javascript", body(4)))
            File(directory, "orphan.bin").writeBytes(body(8))
            File(directory, "leftover.part").writeBytes(body(8))

            val reopened = BootAssetStore(directory, quotaBytes = 1_000, clock = { 1_000L })

            assertArrayEquals(body(4), reopened.read("key"))
            assertFalse(File(directory, "orphan.bin").exists())
            assertFalse(File(directory, "leftover.part").exists())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun clearRemovesBodiesAndIndex() {
        val directory = temporaryDirectory()
        try {
            val store = BootAssetStore(directory, quotaBytes = 1_000, clock = { 1_000L })
            assertTrue(store.put("key", "\"v1\"", "text/javascript", body(4)))
            store.clear()
            assertNull(store.entry("key"))
            assertTrue(directory.listFiles().isNullOrEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }
}
