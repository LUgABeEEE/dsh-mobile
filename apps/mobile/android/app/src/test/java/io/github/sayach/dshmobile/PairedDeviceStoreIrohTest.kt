package io.github.sayach.dshmobile

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.*
import org.junit.Test

private class IrohMemoryPreferences : CredentialPreferences {
    val strings = linkedMapOf<String, String>()
    val flags = linkedMapOf<String, Boolean>()
    override fun string(key: String): String? = strings[key]
    override fun boolean(key: String): Boolean = flags[key] ?: false
    override fun write(strings: Map<String, String>, booleans: Map<String, Boolean>) { this.strings.putAll(strings); flags.putAll(booleans) }
    override fun clear() { strings.clear(); flags.clear() }
}

private class IrohJvmEncryption : CredentialEncryption {
    private val keys = mutableMapOf<String, SecretKey>()
    override fun decrypt(payload: String, iv: String, alias: String): String {
        val key = keys[alias] ?: throw CredentialStorageUnavailable()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.getDecoder().decode(iv)))
        return String(cipher.doFinal(Base64.getDecoder().decode(payload)), Charsets.UTF_8)
    }
    override fun encrypt(plaintext: String, alias: String, allowNewKey: Boolean): EncryptedCredential {
        val key = keys[alias] ?: if (allowNewKey) SecretKeySpec(MessageDigest.getInstance("SHA-256").digest(alias.toByteArray()), "AES").also { keys[alias] = it } else throw CredentialStorageUnavailable()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return EncryptedCredential(Base64.getEncoder().encodeToString(cipher.doFinal(plaintext.toByteArray())), Base64.getEncoder().encodeToString(cipher.iv))
    }
    override fun deleteKey(alias: String) { keys.remove(alias) }
}

class PairedDeviceStoreIrohTest {
    private val endpoint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    private val ca = TestCertificates.ingressCa
    private val instance = TestCertificates.instanceIdOf(ca)
    private val origin = GatewayOrigin.parse("https://${endpoint.take(32)}.${endpoint.drop(32)}.iroh.localhost:25443")!!

    private fun record(binding: IrohDeviceBinding? = IrohDeviceBinding(endpoint, 25443)) = PairedDeviceRecord(
        instanceId = instance, deviceId = "", displayName = "iroh computer", mode = AccessMode.REMOTE,
        origin = origin, deviceToken = "T".repeat(43),
        expiresAt = 9999999999999L, caCertificate = ca, lastConnectedAt = 10L, lastReachableAt = 10L,
        status = PairedDeviceStatus.REACHABLE, iroh = binding,
    )

    @Test fun irohBindingRoundTripsWithItsOwnKey() {
        val store = PairedDeviceStore(IrohMemoryPreferences(), IrohJvmEncryption())
        val saved = record()
        assertEquals("iroh:$endpoint:$instance", saved.key)
        store.upsert(saved)
        val loaded = store.load().single()
        assertEquals(saved.key, loaded.key)
        assertEquals(saved.iroh, loaded.iroh)
        assertEquals(saved.origin.serialized, loaded.origin.serialized)
        assertTrue(saved.caCertificate contentEquals loaded.caCertificate)
    }

    @Test fun legacyRecordsWithoutBindingKeepTheirKeyAndStayReadable() {
        val store = PairedDeviceStore(IrohMemoryPreferences(), IrohJvmEncryption())
        val legacyOrigin = GatewayOrigin.parse("https://computer.example")!!
        val legacy = record(null).copy(origin = legacyOrigin)
        assertEquals("remote:$instance", legacy.key)
        store.upsert(legacy)
        val loaded = store.load().single()
        assertEquals(legacy.key, loaded.key)
        assertEquals(legacyOrigin.serialized, loaded.origin.serialized)
        assertNull(loaded.iroh)
    }

    @Test fun strictBindingObjectsAreRejectedWithoutDroppingTheStore() {
        val store = PairedDeviceStore(IrohMemoryPreferences(), IrohJvmEncryption())
        store.upsert(record())
        // LAN mode, missing CA, origin mismatch, and bad ports all fail closed.
        for (mutate in listOf<(PairedDeviceRecord) -> PairedDeviceRecord>(
            { it.copy(mode = AccessMode.LAN) },
            { it.copy(caCertificate = null) },
            { it.copy(origin = GatewayOrigin.parse("https://computer.example")!!) },
            { it.copy(iroh = IrohDeviceBinding(endpoint, 80)) },
        )) {
            try {
                store.update(record().key, mutate)
                fail("expected an invalid paired device record")
            } catch (_: IllegalArgumentException) {
            }
        }
        assertEquals(1, store.load().size)
    }

    @Test fun irohHostWithoutBindingIsRejected() {
        val store = PairedDeviceStore(IrohMemoryPreferences(), IrohJvmEncryption())
        val row = record(null).copy(origin = origin)
        try {
            store.upsert(row)
            fail("expected an invalid paired device record")
        } catch (_: IllegalArgumentException) {
        }
        assertTrue(store.load().isEmpty())
    }
}
