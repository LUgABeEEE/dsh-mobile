package io.github.sayach.dshmobile

internal enum class SameHostSwitchMode {
    MANUAL, CONFIRM, AUTOMATIC;

    companion object {
        fun resolve(saved: String?, legacyEnabled: Boolean): SameHostSwitchMode =
            entries.firstOrNull { it.name == saved } ?: if (saved == null && legacyEnabled) CONFIRM else MANUAL
    }
}

/** Grouping never changes an endpoint's own token, Origin, instance pin or CA. */
internal object SameHostSwitchPolicy {
    // iroh rows stay out: their carrier lifecycle is owned by the iroh transport,
    // and independently paired endpoints must not auto-migrate between transports.
    fun eligible(row: PairedDeviceRecord, now: Long): Boolean = row.iroh == null && row.expiresAt > now &&
        row.status !in setOf(PairedDeviceStatus.REVOKED, PairedDeviceStatus.EXPIRED, PairedDeviceStatus.ADDRESS_CHANGED)

    fun candidate(current: PairedDeviceRecord, rows: List<PairedDeviceRecord>, mode: AccessMode, now: Long): PairedDeviceRecord? {
        val id = current.installationId ?: return null
        if (!eligible(current, now)) return null
        return rows.firstOrNull { it.key != current.key && it.origin != current.origin &&
            it.deviceToken != current.deviceToken && it.mode == mode &&
            it.installationId == id && eligible(it, now) }
    }

    /** DSH exposes no exhaustive live-document safety contract (including detached drafts/uploads). */
    fun requiresConfirmation(mode: SameHostSwitchMode, hasBrowser: Boolean): Boolean =
        mode != SameHostSwitchMode.AUTOMATIC || hasBrowser

    fun mayFallback(disposition: RestoreFailureDisposition): Boolean =
        disposition == RestoreFailureDisposition.RETRY_TRANSIENT
}

/** Monotonic debounce/cooldown and ownership fence, independent of Android callbacks. */
internal class SameHostSwitchGate {
    @Volatile var generation = 0
        private set
    @Volatile var foreground = false
        private set
    @Volatile private var busy = false
    @Volatile private var probeOwner: Int? = null
    private var probeSequence = 0
    private var nextCheckAt = 0L
    private var nextSwitchAt = 0L
    fun resume() { foreground = true; generation++ }
    fun pause() { foreground = false; busy = false; generation++ }
    fun invalidate() { busy = false; generation++ }
    fun networkChanged() { invalidate(); nextCheckAt = 0L }
    fun begin(now: Long): Int? {
        if (!foreground || busy || now < nextCheckAt || now < nextSwitchAt) return null
        busy = true
        nextCheckAt = now + 5_000
        return (++probeSequence).also { probeOwner = it }
    }
    fun current(owner: Int): Boolean = foreground && busy && owner == probeOwner
    fun finish(owner: Int) { if (owner == probeOwner) { busy = false; probeOwner = null } }
    fun reserveSwitch(now: Long): Boolean {
        if (now < nextSwitchAt) return false
        nextSwitchAt = now + 30_000
        return true
    }
}
