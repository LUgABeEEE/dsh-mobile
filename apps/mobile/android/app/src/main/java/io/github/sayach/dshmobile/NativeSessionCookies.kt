package io.github.sayach.dshmobile

/** Keep the exact HTTPS write URL while serializing the host-only cookie scope independently of its port. */
internal data class NativeSessionCookieWrite(val origin: String, val value: String)

/** Expire all legacy/protected session aliases without clearing another computer's cookies. */
internal fun nativeSessionCookieDeletions(): List<String> = listOf(
    "dsh_ma_session", "dsh_ma_csrf", "__Host-dsh_ma_session", "__Host-dsh_ma_csrf",
).map { name -> "$name=; Max-Age=0; Path=/; Secure; SameSite=Strict" }

/** Host-only Session aliases installed on the paired HTTPS origin. */
internal fun nativeSessionCookies(session: NativeSession): List<String> {
    val sessionValue = "=${session.sessionToken}; Path=/; Secure; HttpOnly; SameSite=Strict"
    val csrfValue = "=${session.csrfToken}; Path=/; Secure; SameSite=Strict"
    return listOf(
        "dsh_ma_session$sessionValue",
        "dsh_ma_csrf$csrfValue",
        "__Host-dsh_ma_session$sessionValue",
        "__Host-dsh_ma_csrf$csrfValue",
    )
}
