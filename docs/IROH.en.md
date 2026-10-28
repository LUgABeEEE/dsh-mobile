# Experimental iroh connection

iroh replaces public domains and tunnel accounts with an encrypted direct connection (relay fallback when direct fails): the phone finds the computer's cryptographic identity first, then traffic returns to the loopback gateway. You need no domain, port mapping, or separate HTTPS tunnel.

> Plugin 0.7.0 and the full App 0.7.0 integrate the computer provider, pinned TLS, pairing UI and Android native transport. The feature is off by default and remains experimental. Direct connectivity, relay use and speed depend on both networks; availability on every campus, corporate or carrier network is not guaranteed.
> The design lives in the companion's [integration seam](https://github.com/saya-ch/dsh-mobile-iroh/blob/main/docs/INTEGRATION_SEAM.md).

## Prerequisites

- Windows x64 or Linux x64 (the only published sidecar targets).
- Android 10+ with the full `-iroh.apk`, supporting arm64-v8a and x86_64. The ordinary `.apk` is the compatibility build without native libraries: it retains existing HTTPS connections and serves older automatic-update links, but cannot use iroh. Mobile browsers cannot connect directly through iroh either. Both APKs have the same application ID and official signer; install only one.
- Press **Install official component** once to fetch the sidecar: the plugin downloads the pinned `dsh-mobile-iroh 0.1.0-alpha.1` release per platform (about 15 MB on Windows x64, 24 MB on Linux x64), verifies its SHA-256, and stores it in the plugin private directory. An installed companion plugin with a verified copy is reused instead, with no download. The Rust source lives with the main repository under `native/iroh-host` (shared core under `native/iroh-core`) and is built per platform in CI.
- DSH Mobile stays enabled; the iroh channel is off by default and never disturbs LAN or other remote channels.

## Usage

1. Under **Mobile access → Remote**, pick `iroh (Experimental)`.
2. Press **Prepare iroh → Install official component** (labelled with the download size): the first run downloads and verifies the sidecar; later runs reuse the verified copy. A hash mismatch or an unsupported platform stops here with a reason instead of a half-started channel. Merely switching the channel on never triggers a download.
3. Turn remote access on: the plugin resolves the endpoint identity, issues the endpoint gateway certificate (own CA, 90-day leaf, 30-day renewal headroom), starts a dedicated gateway, launches the sidecar, and waits for `ready`. `ready` means the sidecar is connected and the gateway serves its loopback socket.
4. Press **Generate iroh pairing QR code** and scan it with the full App. The descriptor binds the sidecar's six-digit code, the Gateway's one-time token and pinned CA. Generating another descriptor replaces the previous pairing window; pairing a phone redeems the Gateway token through the normal pair endpoint over iroh.
5. Switching off or switching providers stops the owned process and Gateway without deleting stored pairings. The independent App has a different package identity; its Keystore credentials are not automatically migrated into this App.

## Security boundaries

- The sidecar proxies only to a `127.0.0.1`/`::1` loopback gateway with end-to-end TLS; commands and events are versioned, bounded, and rejected closed on unknown fields.
- A rotated fingerprint, replaced binary, or moved file fails verification and parks the channel at `unavailable` instead of silently running a stale one.
- Transport revocation and device-token revocation are separate authorizations; their unified management is Phase 2 work. Computer-side revocation keeps working through the existing device management.

## Troubleshooting

Store the iroh identity and certificates in a directory tree writable only by the current user or trusted system accounts. DSH's default state under the Windows user profile is intended for this; custom locations also need private ancestors. Some AppData or shared locations grant other accounts write access and are rejected. Do not loosen ACLs, delete real identities or move state into untrusted storage to bypass the check. Back up and preserve existing identity files.

Before a component release, verify first use with the exact catalog-pinned executable, not only a locally compiled host or a directory initialized by hand. The controller invokes `tls-prepare` because `id` only reads existing identity state. On Windows, `DSH_IROH_PINNED_FIRST_USE=<verified executable> npx vitest run tests/iroh-pinned-first-use.test.ts` checks initialization, reuse and corruption refusal in owned private storage. A failure blocks component acceptance; do not loosen directory ACL checks or replace real identities to make it pass.

| Symptom | Meaning |
| --- | --- |
| `iroh_companion_missing` | Nothing installed yet: press Install first, or point `DSH_MOBILE_IROH_COMPANION` at a companion absolute path to reuse |
| `iroh_sidecar_invalid` | An installed file was modified; reinstalling overwrites it in place, or reinstall the companion for a damaged companion copy |
| `iroh_platform_unsupported` | No sidecar is published for this OS/architecture |
| `iroh_identity_invalid` / `iroh_identity_failed` | Check private permissions on the state directory and its ancestors and check for damaged identity files, preserving originals. `id` reads an existing identity; first use invokes `tls-prepare`, not copying or deleting an identity |
| `iroh_start_timeout` | Inspect iroh errors in the DSH log and network connectivity, and verify that the pinned component runs; repeated pairing is not a substitute for process diagnosis |
| Channel `ready` but no phone connects | Check that the App is the full build, the device supports a packaged ABI and the descriptor is fresh. Computer readiness does not establish phone connectivity; a relay-service connection alone does not establish that data uses the relay |

Chinese version: [IROH.md](IROH.md).
