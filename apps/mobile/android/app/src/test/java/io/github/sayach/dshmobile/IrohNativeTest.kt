package io.github.sayach.dshmobile

import org.junit.Assert.assertFalse
import org.junit.Test

class IrohNativeTest {
    @Test
    fun hostJvmDoesNotPretendAnAndroidAbiCanLoad() {
        // JVM tests run outside Android, including native-enabled APK builds.
        assertFalse(IrohNative.loadIfAvailable())
    }
}
