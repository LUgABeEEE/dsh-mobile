# iroh experimental channel (Phase 1: computer side only)

iroh replaces public domains and tunnel accounts with an encrypted direct connection (relay fallback when direct fails): the phone finds the computer's cryptographic identity first, then traffic returns to the loopback gateway. You need no domain, port mapping, or separate HTTPS tunnel.

> **Experimental.** The computer side is merged: provider registration, sidecar lifecycle, endpoint-pinned gateway TLS, panel status, and QR pairing. The phone side is merged into the main App (transport modules, versioned pairing records, QR pairing, carrier-aware restore and revocation monitoring) but ships only in native-enabled builds with `-PirohNative=true`; default builds remain the plain HTTPS shell.
> The design lives in the companion's [integration seam](https://github.com/saya-ch/dsh-mobile-iroh/blob/main/docs/INTEGRATION_SEAM.md).

## Prerequisites

- Windows x64 or Linux x64 (the only published sidecar targets).
- Press **Install official component** once to fetch the sidecar: the plugin downloads the pinned `dsh-mobile-iroh 0.1.0-alpha.1` release per platform (about 15 MB on Windows x64, 24 MB on Linux x64), verifies its SHA-256, and stores it in the plugin private directory. An installed companion plugin with a verified copy is reused instead, with no download. The Rust source lives with the main repository under `native/iroh-host` (shared core under `native/iroh-core`) and is built per platform in CI.
- DSH Mobile stays enabled; the iroh channel is off by default and never disturbs LAN or other remote channels.

## Usage

1. Under **Mobile access → Remote**, pick `iroh (Experimental)`.
2. Press **Prepare iroh → Install official component** (labelled with the download size): the first run downloads and verifies the sidecar; later runs reuse the verified copy. A hash mismatch or an unsupported platform stops here with a reason instead of a half-started channel. Merely switching the channel on never triggers a download.
3. Turn remote access on: the plugin resolves the endpoint identity, issues the endpoint gateway certificate (own CA, 90-day leaf, 30-day renewal headroom), starts a dedicated gateway, launches the sidecar, and waits for `ready`. `ready` means the sidecar is connected and the gateway serves its loopback socket.
4. Press **Generate iroh pairing QR code**: the sidecar issues a six-digit one-time code while the gateway opens a one-time pairing window, and both are sealed into the descriptor with the pinned CA. Scanning replaces nothing server-side, but minting again replaces the old window. The gateway token reuses the standard one-time pairing mechanism, redeemed by the Phase 2 phone through the ordinary pair flow over the iroh transport.
5. Switching off or switching providers sends `shutdown` first, then reclaims the process and gateway. An already installed companion keeps being reused during the transition; remove it through DSH plugin management.

## Security boundaries

- The sidecar proxies only to a `127.0.0.1`/`::1` loopback gateway with end-to-end TLS; commands and events are versioned, bounded, and rejected closed on unknown fields.
- A rotated fingerprint, replaced binary, or moved file fails verification and parks the channel at `unavailable` instead of silently running a stale one.
- Transport revocation and device-token revocation are separate authorizations; their unified management is Phase 2 work. Computer-side revocation keeps working through the existing device management.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `iroh_companion_missing` | Nothing installed yet: press Install first, or point `DSH_MOBILE_IROH_COMPANION` at a companion absolute path to reuse |
| `iroh_sidecar_invalid` | An installed file was modified; reinstalling overwrites it in place, or reinstall the companion for a damaged companion copy |
| `iroh_platform_unsupported` | No sidecar is published for this OS/architecture |
| `iroh_identity_failed` / `iroh_start_timeout` | Sidecar process misbehaving; check the iroh lines in the DSH log, then retry. A persistent failure can be reproduced directly: `<sidecar> --lang en id --data-dir "<data-dir>"` should exit 0 and print 64 hex chars. If creation in an empty directory fails while an existing `identity.key` still reads, endpoint protection is likely intercepting private file creation; back up `identity.key` first. Confirm on a real binary with `DSH_IROH_SIDECAR=<sidecar> npx vitest run tests/iroh-host-real.test.ts` |
| Channel `ready` but no phone connects | Expected: waits on the Phase 2 Android transport |

Chinese version: [IROH.md](IROH.md).
