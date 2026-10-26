package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Keeps a held first download under one connection deadline without renewing or replacing its page. */
class InitialPageLoadRecoveryTest {
    private val origin = GatewayOrigin.parse("https://dsh.example.com")!!

    @Test
    fun aFirstDownloadMayOutliveTheShortPageTimerAndBecomeReadyWithinTheOriginalBudget() {
        val fixture = Fixture()
        val attempt = fixture.start()
        val document = WebViewDocumentState(origin)
        document.started()
        val generation = document.generation

        for (elapsed in listOf(15_000L, 30_000L, 45_000L)) {
            fixture.advanceTo(elapsed)
            assertTrue(fixture.controller.isCurrent(attempt))
            assertFalse(document.shouldTimeout(generation, fixture.controller.isCurrent(attempt)))
            assertEquals(generation, document.generation)
        }

        assertTrue(document.confirmContentReady(generation))
        assertTrue(fixture.controller.finish(attempt))
        fixture.advanceTo(60_000L)
        assertTrue(fixture.outcomes.isEmpty())
        assertEquals(1, fixture.timers.size)
        assertFalse(document.shouldTimeout(generation))
    }

    @Test
    fun aNeverReadyPageEndsAtTheOriginalDeadlineAndDoesNotStartAnotherBudget() {
        val fixture = Fixture()
        val attempt = fixture.start()
        val document = WebViewDocumentState(origin)
        document.started()
        val generation = document.generation

        fixture.advanceTo(59_999L)
        assertFalse(document.shouldTimeout(generation, fixture.controller.isCurrent(attempt)))
        fixture.advanceTo(60_000L)
        assertFalse(fixture.controller.isCurrent(attempt))
        assertTrue(attempt.cancellation.isCancelled)
        assertEquals(listOf(ConnectionAttemptController.Reason.TIMED_OUT), fixture.outcomes)
        assertEquals(1, fixture.timers.size)
        assertFalse(fixture.controller.finish(attempt))
        fixture.advanceTo(120_000L)
        assertEquals(listOf(ConnectionAttemptController.Reason.TIMED_OUT), fixture.outcomes)
    }

    @Test
    fun aFirstPageFailureRequiresExplicitRetryWhileMountedPageRecoveryRemainsAvailable() {
        for (failure in LoadFailure.entries) assertFalse(shouldAutomaticallyRecoverPage(failure, initialLoadPending = true))
        for (failure in listOf(LoadFailure.NETWORK, LoadFailure.AUTH_EXPIRED, LoadFailure.SERVICE_UNAVAILABLE)) {
            assertTrue(shouldAutomaticallyRecoverPage(failure, initialLoadPending = false))
        }
        for (failure in listOf(LoadFailure.TLS, LoadFailure.RATE_LIMITED)) {
            assertFalse(shouldAutomaticallyRecoverPage(failure, initialLoadPending = false))
        }
    }

    @Test
    fun theActivityBindsTheExceptionToTheLiveInitialLoadAndPreservesManualRetry() {
        val activity = source("MainActivity.kt")
        val loading = method(activity, "initialPageLoadPending")
        assertTrue(loading.contains("val attempt = loadingConnectionAttempt ?: return false"))
        assertTrue(loading.contains("pendingConnection === attempt && connectionAttempts.isCurrent(attempt)"))
        val browser = method(activity, "showBrowser")
        assertTrue(browser.contains("connectionDeadlineActive = { ownsBrowser() && initialPageLoadPending() }"))
        val recovery = method(activity, "recoverAutomatically")
        assertTrue(recovery.indexOf("if (initialPageLoadPending()) return") < recovery.indexOf("loadingConnectionAttempt = null"))
        val failure = method(activity, "showLoadFailure")
        assertTrue(failure.indexOf("shouldAutomaticallyRecoverPage(failure, initialPageLoadPending())") < failure.indexOf("scheduleAutomaticRecovery()"))
        assertTrue(failure.contains(".setPositiveButton(R.string.retry)"))
        assertTrue(failure.substringAfter(".setPositiveButton(R.string.retry)").contains("recoverAutomatically()"))
        assertTrue(activity.contains("const val LAN_CONNECTION_BUDGET_MS = 30_000L"))
        assertTrue(activity.contains("const val REMOTE_CONNECTION_BUDGET_MS = 60_000L"))
    }

    private class Fixture {
        class Timer(val dueAt: Long, val task: Runnable) {
            var disposed = false
            var delivered = false
        }

        private var now = 0L
        val timers = mutableListOf<Timer>()
        val outcomes = mutableListOf<ConnectionAttemptController.Reason>()
        val controller = ConnectionAttemptController(
            schedule = { delay, task ->
                val timer = Timer(now + delay, task)
                timers += timer
                ({ timer.disposed = true })
            },
            cancellationFactory = { NativeConnectionCancellation { it.run() } },
        )

        fun start(): ConnectionAttemptController.Attempt = controller.start(60_000L, outcomes::add)

        fun advanceTo(next: Long) {
            require(next >= now)
            now = next
            timers.filter { !it.disposed && !it.delivered && it.dueAt <= now }.forEach {
                it.delivered = true
                it.task.run()
            }
        }
    }

    private fun method(source: String, name: String): String =
        source.substringAfter("private fun $name(").substringBefore("\n    private fun ")

    private fun source(name: String): String = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base -> listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
            .map { File(base, "$it/java/io/github/sayach/dshmobile/$name") } }
        .first { it.isFile }.readText()
}
