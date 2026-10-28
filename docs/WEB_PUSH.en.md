# iPhone and iPad Web Push

[简体中文](<WEB_PUSH.md>) · [Documentation](<README.md>)

> **Web Push is an unreleased candidate** for capable iOS/iPadOS **18.4+ Safari Home Screen apps**. The author recorded single-iPhone development observations; iPad, other device/OS combinations and a final-head recheck remain open. See [verification status](<#verification-status>).

## Using DSH Mobile on iPhone and iPad

DSH Mobile runs as a plugin on your **computer**. On iPhone/iPad, open its dedicated Mobile Access page in **Safari**, pair with the computer, then optionally add it to the Home Screen as a web app (PWA). No native iOS app download is needed. Start with the [connection guide](<../README.en.md#connection-guide>); you can use DSH sessions and Workspaces without enabling notifications.

Home Screen installation does not provide offline DSH: the computer, DSH and its Mobile Gateway must stay running, and the phone must be able to reach the gateway to use it. The **18.4+ target below applies to optional Web Push**, not to ordinary browser access; browser compatibility still depends on the DSH frontend.

## Requirements

- A capable iPhone/iPad Home Screen web app, opened in standalone mode, with the page-level `window.pushManager` API. The plugin detects capabilities rather than trusting a browser version string. Ordinary Safari tabs and unsupported browsers do not get a service-worker fallback.
- A **stable, trusted HTTPS origin** and an existing DSH Mobile browser pairing. HTTP and continuing through a certificate warning are not supported push configurations. The Android app's private-CA pin does not make an iPhone browser trust that CA.
- A running DSH host and active Mobile Gateway for that exact origin. Public lifecycle contract evidence is currently pinned to DSH **0.2.1-rc.2**; the broader Mobile boot matrix is not a Web Push support claim. Missing required public DSH services make push unavailable without disabling ordinary Mobile access.
- Outbound access to Apple's push infrastructure from the host and phone. No Apple developer membership, notification SaaS account or new public inbound port is required. This feature does not create a VPN, change certificates, open a firewall or configure a proxy.

A publicly trusted private HTTPS hostname is architecturally eligible. The phone must still reach that origin to install, enable, authenticate and open a conversation. Delivery over a private/Tailscale origin is **unverified**; do not expose a private backend just to try push. Random tunnel hostnames are unsuitable for stable installation consent: an origin change never migrates authorization or subscriptions automatically. For persistent addresses, see [Cloudflare named tunnels](<CLOUDFLARE_TUNNEL.en.md>) or [your own HTTPS reverse proxy](<SELF_HOSTED_ORIGIN.en.md>); configuring an address alone does not prove push delivery.

## Enable explicitly

1. Open and pair the dedicated DSH Mobile page on the intended HTTPS origin. Use Safari's **Add to Home Screen**, then launch that icon rather than an ordinary tab. If the installed app shows a pairing-code form, follow the [fresh-code recovery steps](<#if-the-home-screen-app-shows-a-pairing-form>); do not reuse the code consumed by Safari. Keep an existing installation until its upgrade behavior has been checked; do not clear its pairing or site data as a shortcut.
2. **Inside the DSH page**, open **Settings → General** and find **Web push notifications**, separate from the Android **Task notifications** action. This is not the iPhone/iPad system Settings app.
3. Select **Enable** and respond to the browser's permission prompt. Page load, reconnect and host restart never request permission or subscribe automatically. Enable completes only after the host saves consent.
4. Choose the categories you want. **Send test** allows one request per installation per minute, with a 60-second TTL; its success means **accepted by the push provider**, not delivered, displayed, read or answered on the phone.

The browser installation ID only distinguishes containers; it is not a credential. Another browser/profile or origin has separate consent. The host derives ownership from the authenticated paired device, not an ID supplied by the page.

### If the Home Screen app shows a pairing form

Safari and the installed app may have separate login state. This recovery is for a **Pairing code** form, not the ordinary reconnect page that renews an existing pairing; it is also independent of whether you enable push.

1. On the computer, stay on the **same LAN/Remote connection and HTTPS origin** used for the Home Screen installation. Generate a fresh browser pairing link: LAN **Copy pairing link**, or Remote **Generate remote pairing QR code** then **Copy remote pairing link**. Merely re-copying the old Remote link can reuse its consumed code until expiry.
2. From that fresh link's fragment (after `#`), copy **only the 43-character value of `token=`** into the installed app's **Pairing code** field. Do not paste the whole URL or an Android `dsh1.`/`dsh2.` key. If the link has no `token=` field, check that you selected a browser-compatible HTTPS entry; do not extract a code from an Android key or bypass a certificate warning.
3. Complete pairing in the **Home Screen app** before the new code expires; do not consume it in Safari first. Pairing codes work once, so generate a new link after use or expiry. Treat the entire link and code as secrets: do not post them in issues or logs. Keep existing installations, paired-device records and site data.

### Everyday notification expectations

Push is best effort, not an alarm service. Host sleep/shutdown, disabled origin, phone connectivity, Focus settings and platform scheduling can delay or prevent delivery.

Closing the page does **not** disable saved push consent. Use **Disable** to stop future eligible sends; explicit logout and device revocation have the separate effects listed [below](<#consent-logout-and-revocation>). A notification tap may require login and never answers or approves anything; **Send test** opens the app root, not a conversation.

## What can notify

All six categories default on **after** master opt-in. They cover authorized user-facing sessions, including off-screen sessions and ordinary forks; they are not restricted to the conversation currently open on the phone.

| Category | Meaning |
| --- | --- |
| Questions | A public input request remains unresolved/answerable. A timed question that continues after timeout may still qualify; a queued matching answer suppresses the obsolete alert. |
| Plans | An actual unresolved plan-review request. |
| Approvals | A permission request actually dispatched through the public request lifetime, not merely an audit entry. |
| Responses | An ordinary non-goal response has committed and remains current after coalescing. |
| Goals | A committed goal completion or genuine blocked outcome, not each continuation round. |
| Failures | A confirmed unrecovered terminal failure requiring attention, not every error or retry. |

Routine streaming/progress, runtime-child completion chatter and user-requested Stop do not notify. A child blocker is observed only when DSH exposes an actual human-directed request through the owning workflow; the plugin never fabricates parent questions or inspects private child state. Quick auto-decisions can settle before the attention delay and produce no alert. A notification says an event occurred, not that someone currently owns a wait.

Lock-screen text is generic and localized in English, Simplified Chinese or Italian. It contains no question body, tool arguments, goal objective, conversation excerpt or raw error. Notification tags do not guarantee replacement or withdrawal.

## Consent, logout and revocation

| Action/event | Effect |
| --- | --- |
| Close the page or let its short login session expire | Saved push consent remains while persistent pairing authorization and the origin remain valid. Opening DSH still requires authentication. |
| Select Disable | The host durably stops sending first, then the page best-effort unsubscribes only a subscription it owns. A failed browser unsubscribe does not restore host consent. |
| Explicit Mobile logout | Disable this paired device's push on the current origin before clearing its short session; retain the pairing. A failed disable must not report a completed logout. |
| Revoke/reset a device or let its persistent credential expire | Purge affected push registrations and queued work, including devices with no open page. |
| Stop a Gateway/provider or change its origin | Stop that origin's sends. Other origins keep their own consent. Re-enabling on a new origin is explicit. |
| Restart DSH | Preserve keys, consent and bounded fresh delivery state, then recheck authorization and source eligibility. Do not replay historical conversations. |

A send already accepted/in flight at the provider may still arrive after disable or revocation; it cannot reliably be recalled. Re-enabling does not announce old history to a newly enrolled installation. Stale settings must be refreshed before a new user action; old Enable/preferences/Disable requests are never automatically replayed after an authentication or generation failure.

## Tap behavior and privacy

A payload opens the same-origin root with an opaque delivery reference. The reference contains no conversation text or authorization token. The Gateway authenticates the paired device and checks scope, device, origin and expiry before resolving it. Expired login uses the existing safe root-return flow; an opaque reference does not bypass login.

After the public Workspace and Session lists are ready, Mobile rechecks that the session exists and opens it through DSH's normal UI action. A resolved request can open its session with a neutral notice; a tap never answers, approves or reopens an old prompt. An expired, foreign, missing or deleted target gives a neutral unavailable/session-list fallback. Consuming the reference removes only its query parameter without forcing a reload.

The browser chooses warm versus cold navigation. Do not assume unsent drafts or in-flight sends survive every notification navigation; physical-device acceptance must record the actual effect. The plugin does not register or unregister a service worker or cache authenticated pages/API data.

## Limits and delivery failures

- At most **4 registrations per paired device**, **256 registrations and 256 pending deliveries per authorization scope**, and **4 concurrent sends**. Overflow rejects new work rather than deleting another installation or blocking DSH.
- Attention expires **5 minutes** after the original request; outcomes expire **30 minutes** after their source event. Retries do not renew freshness.
- At most **3 attempts**, each with an absolute **10-second** budget; retry delays start at **1 second**, then **5 seconds**, with bounded Retry-After only inside the original lifetime.
- HTTP 404/410 removes a dead registration. HTTP 401/403 suspends delivery for configuration/key repair without clearing pairings. Other permanent errors drop the job; network/429/5xx retries remain bounded.
- Receipts and tap references are bounded. A crash after provider acceptance but before saving the receipt can cause a duplicate; delivery is not exactly once.

The sender accepts only validated Apple HTTPS push endpoints, rejects redirects and unsafe DNS destinations, and encrypts payloads with Web Push/VAPID. Subscription endpoints, keys and private notification state are credentials: do not paste them into issues or logs. A notification storage/network failure must not change a DSH answer, approval or turn result.

## Troubleshooting and deliberate repair

| State/problem | Next step |
| --- | --- |
| No row / unavailable | Check required page-level capability, trusted HTTPS, authenticated dedicated browser context and DSH public services. There is no worker or old-iOS fallback. |
| Install guidance | Launch the Home Screen icon rather than an ordinary browser tab. |
| Permission denied | Change the site's notification permission in system/browser settings, return to the app and make a new explicit Enable action. No prompt is forced. |
| Registration failed / stale settings | Refresh/reopen to read current state, then explicitly retry. Do not repeatedly resubmit an old request. |
| Existing subscription uses another application key | Do not automatically unsubscribe it. After a host key reset, retrying Enable alone will not fix this conflict; identify its owner and arrange deliberate browser-side repair. |
| Suspended / repair-required | Check host key/configuration and private-file access. Do not delete paired-device state or silently replace VAPID keys. |
| Test accepted but no alert | Check phone permission/Focus/network, whether the host and gateway are running, and original freshness; provider acceptance is not a delivery receipt. |

Lost/corrupt VAPID material with existing registrations fails closed. A host administrator may deliberately reset **notification state only** with `POST /api/mobile-access/push/reset` and JSON `{ "confirm": "reset-web-push" }` through the existing trusted local desktop-admin API. This is a destructive notification reset, not a phone endpoint or an automatic repair button: all browser push consents require explicit re-enrollment afterwards, while pairings remain intact. The reset is **host-registry-wide** — it clears registrations across attached devices and origins, not only the browser that later meets the conflict — so an existing subscription can keep ordinary re-enable failing; no validated destructive repair recipe is promised here. Keep the normal desktop Host/Origin/source protections; never expose this administration path publicly or manually remove paired-device files.

## Independent channels and acceptance

Android's native permission/SSE path and APK/signing remain unchanged. The independently maintained **dsh-ping** channel is not modified or automatically disabled; enabling both can produce separate alerts. Web Push adds no cross-channel deduplication or foreground suppression.

Before calling this candidate iPhone-ready, record physical results for existing/new Home Screen identity; grant/denial/repair; hidden/closed/locked delivery of every category; ordinary forks and public owning-workflow blockers; no progress/round/Stop spam; localized generic content; warm/cold/expired-login taps; resolved/deleted sessions; draft/held-send effects; VPN connected/disconnected; offline past TTL; host restart; and permission/device revoke/logout. Automated fixture results and this checklist are not substitutes for those observations. See [contribution checks](<../CONTRIBUTING.md#select-behavior-checks>) for packed runtime validation.

## Verification status

> **Development candidate, not a released feature.** The target is iOS/iPadOS 18.4+ Home Screen web apps using Declarative Web Push; availability is an explicit opt-in/configuration for capable iOS/iPadOS **Safari** Home Screen apps only. The author exercised the full acceptance matrix — per-category delivery, locked/all-closed states, Home Screen upgrades, warm/cold and expired-login taps, deleted-target handling, suppression, disable/logout/revocation, offline/VPN/TTL, host restart, and permission/reset recovery — on iPhone 17 Pro Max (iOS 27.0.1) during development; these are retrospective development observations without per-run build provenance, and iPad, other device/OS combinations and a focused re-check on the final head remain open. A source test, Chromium fixture or provider acceptance is not device evidence. Due intents whose gateway origin detaches around delivery now defer inside their original TTL and deliver after re-attach instead of being dropped, and a revoked device is never revived. A packed fixture proves server-side session absence on the tap path (authentication enforced before content, pairing renewal, push consent intact), while a genuinely persisted-then-deleted target remains unprovable: this DSH runtime exposes no public session delete, and deleting every id-named persisted artifact still left the session resolvable. A host push-key reset is registry-wide, no validated destructive repair exists for an old browser subscription, and a repair-required registration may hide the settings row instead of showing a repair label. Push opt-out still persists before logout completes.
