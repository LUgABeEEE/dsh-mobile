package io.github.sayach.dshmobile

import org.junit.Assert.*
import org.junit.Test

class SameHostSwitchPolicyTest {
    private val lan = PairedDeviceRecord("a".repeat(64), "b".repeat(32), "PC", AccessMode.LAN,
        GatewayOrigin.parse("https://192.168.1.2:3443")!!, "L".repeat(43), 10_000,
        byteArrayOf(1), null, null, PairedDeviceStatus.REACHABLE, "c".repeat(64))
    private val remote = lan.copy(instanceId = "d".repeat(64), mode = AccessMode.REMOTE,
        origin = GatewayOrigin.parse("https://example.com")!!, deviceToken = "R".repeat(43), caCertificate = null)

    @Test fun selectionRequiresAuthenticatedIdentityAndIndependentValidPairing() {
        assertSame(remote, SameHostSwitchPolicy.candidate(lan, listOf(remote), AccessMode.REMOTE, 1))
        assertEquals("R".repeat(43), remote.deviceToken)
        assertNull(SameHostSwitchPolicy.candidate(lan.copy(installationId = null), listOf(remote), AccessMode.REMOTE, 1))
        listOf(remote.copy(installationId = null), remote.copy(installationId = "e".repeat(64)),
            remote.copy(expiresAt = 1), remote.copy(deviceToken = lan.deviceToken), remote.copy(origin = lan.origin), remote.copy(status = PairedDeviceStatus.REVOKED),
            remote.copy(status = PairedDeviceStatus.EXPIRED), remote.copy(status = PairedDeviceStatus.ADDRESS_CHANGED)).forEach {
            assertNull(SameHostSwitchPolicy.candidate(lan, listOf(it), AccessMode.REMOTE, 1))
        }
    }

    @Test fun irohRowsNeverJoinSameHostSwitching() {
        val endpoint = "0".repeat(64)
        val binding = IrohDeviceBinding(endpoint, 25443)
        val iroh = remote.copy(origin = binding.origin, caCertificate = byteArrayOf(1), iroh = binding)
        assertFalse(SameHostSwitchPolicy.eligible(iroh, 1))
        assertNull(SameHostSwitchPolicy.candidate(lan, listOf(iroh), AccessMode.REMOTE, 1))
        assertNull(SameHostSwitchPolicy.candidate(iroh, listOf(remote), AccessMode.REMOTE, 1))
        assertTrue(SameHostSwitchPolicy.eligible(remote, 1))
    }

    @Test fun aLiveOrUncertainPageNeverSilentlyLosesDraftsAcrossOrigins() {
        SameHostSwitchMode.entries.forEach { mode ->
            assertTrue(SameHostSwitchPolicy.requiresConfirmation(mode, true))
        }
        assertTrue(SameHostSwitchPolicy.requiresConfirmation(SameHostSwitchMode.CONFIRM, false))
        assertTrue(SameHostSwitchPolicy.requiresConfirmation(SameHostSwitchMode.MANUAL, false))
        assertFalse(SameHostSwitchPolicy.requiresConfirmation(SameHostSwitchMode.AUTOMATIC, false))
    }

    @Test fun legacyOptInMigratesToConfirmationNeverAutomatic() {
        assertEquals(SameHostSwitchMode.MANUAL, SameHostSwitchMode.resolve(null, false))
        assertEquals(SameHostSwitchMode.CONFIRM, SameHostSwitchMode.resolve(null, true))
        assertEquals(SameHostSwitchMode.MANUAL, SameHostSwitchMode.resolve("unrecognized", true))
        SameHostSwitchMode.entries.forEach { mode ->
            assertEquals(mode, SameHostSwitchMode.resolve(mode.name, true))
            assertEquals(mode, SameHostSwitchMode.resolve(mode.name, false))
        }
    }

    @Test fun aNetworkTransitionSupersedesSlowProbeWithoutBypassingSwitchCooldown() {
        val gate = SameHostSwitchGate()
        gate.resume()
        val lanOwner = gate.begin(0)!!
        gate.networkChanged()
        assertFalse(gate.current(lanOwner))
        val remoteOwner = gate.begin(750)!!
        gate.finish(lanOwner)
        assertTrue(gate.current(remoteOwner))
        gate.finish(remoteOwner)
        assertTrue(gate.reserveSwitch(750))
        gate.networkChanged()
        assertNull(gate.begin(1_000))
        assertNotNull(gate.begin(30_750))
    }

    @Test fun timedOutProbeCannotFinishItsSuccessorInTheSameForegroundGeneration() {
        val gate = SameHostSwitchGate().apply { resume() }
        val first = gate.begin(0)!!
        val lifecycle = gate.generation
        gate.finish(first)
        val second = gate.begin(10_000)!!
        assertEquals(lifecycle, gate.generation)
        assertNotEquals(first, second)
        assertFalse(gate.current(first))
        gate.finish(first)
        assertTrue(gate.current(second))
        assertNull(gate.begin(20_000))
        gate.finish(second)
        assertNotNull(gate.begin(20_000))
    }

    @Test fun trustAndIdentityFailuresNeverFallBack() {
        NativeAuthFailureKind.entries.forEach { kind ->
            assertEquals(kind in setOf(NativeAuthFailureKind.NETWORK, NativeAuthFailureKind.TIMEOUT, NativeAuthFailureKind.SERVER_UNAVAILABLE),
                SameHostSwitchPolicy.mayFallback(ConnectionRestorePolicy.failureDisposition(NativeAuthFailure(kind), false)))
            assertFalse(SameHostSwitchPolicy.mayFallback(ConnectionRestorePolicy.failureDisposition(NativeAuthFailure(kind), true)))
        }
    }

    @Test fun lifecycleDebounceCooldownAndStaleCallbacks() {
        val gate = SameHostSwitchGate()
        assertNull(gate.begin(0))
        gate.resume()
        val owner = gate.begin(0)!!
        assertTrue(gate.current(owner))
        assertNull(gate.begin(6_000))
        gate.pause()
        assertFalse(gate.current(owner))
        gate.resume()
        assertNull(gate.begin(1_000))
        val next = gate.begin(6_000)!!
        gate.finish(owner)
        assertTrue(gate.current(next))
        assertTrue(gate.reserveSwitch(6_000))
        assertFalse(gate.reserveSwitch(7_000))
        gate.finish(next)
        assertNull(gate.begin(35_999))
        assertNotNull(gate.begin(36_000))
        gate.invalidate()
        assertFalse(gate.current(next))
    }

    @Test fun authenticatedProbesLearnButNeverReplaceConflictingIdentity() {
        val old = remote.copy(installationId = null)
        val probe = NativeProbe(old.origin, old.instanceId, old.deviceId, 20_000, remote.installationId)
        assertEquals(remote.installationId, PairedDeviceStatusPolicy.applyProbe(old, old, probe, null, 1).installationId)
        val changed = PairedDeviceStatusPolicy.applyProbe(remote, remote, probe.copy(installationId = "e".repeat(64)), null, 1)
        assertEquals(PairedDeviceStatus.ADDRESS_CHANGED, changed.status)
        assertEquals(remote.installationId, changed.installationId)
    }
}
