# C pack — static assets and transport (0.8.0)

Branch `codex/0.8.0-c-transport`, worktree `local/wt-c-transport`, baseline
`66989a60e1c6b8f7f4bc0db2db1702efa8b9f252`. Local implementation and tests only:
nothing pushed, no release, no GitHub state changed, no DSH source touched, and the
release-owned files (`package.json`, `package-lock.json`, `.github/**`, `README*`,
`CHANGELOG.md`, `CONTRIBUTORS.md`) are left for the integrator.

## Disposition summary

| PR | Author head | Author | Merge | Maintainer corrections | Outcome |
| --- | --- | --- | --- | --- | --- |
| #310 owned static gzip | `7ce12653c1860bb470290867d3f52bdc2cc7ed4b` | LUgABeEEE | `e82a2a3` | `ec711dc` | Merged with corrections |
| #311 compat content URL | `7a2d99515bca1c56821fb78bce792ad8486ae88d` | LUgABeEEE | `31ef133` | `529567c` | Merged with corrections |
| #292 mux compression default | `8f4653b13d71a3b92f7c53de555ecb9d4b3c0b76` | LUgABeEEE | `d872c68` | — (default confirmed by measurement, see below) | Merged; default **on** justified by measurement |

Supporting commits on this branch: `d668b86` (keep release-owned files with the
integrator), `db069f8` + `043e919` (mux bridge frame coverage), `8d8b4e2` (two-group
measurement harness).

Baseline note: #310 and #311 branch from `a2281e4`, which is an **ancestor** of the
0.8.0 baseline `66989a6`. `git diff 66989a6 pr-310` therefore shows a large reverse
diff of unrelated 0.7.1 work; the real change is `git diff a2281e4 pr-310`
(4 files, +92/−3) and `git diff a2281e4 pr-311` (8 files, +155/−15). #292 branches
directly from `66989a6`. The remote #292 ref had been force-pushed (`82a3b07` →
`8f4653b`); the local ref was updated with `+refs/pull/292/head` to the stated head.

## #310 — gzip for owned static resources

Owned assets (`compat.js`, `mobile-layout.js`, custom CSS/JS) were sent as identity
bodies under `Cache-Control: private, no-cache`, so a client that never revalidates
paid the full length on every load. The PR negotiates gzip above the existing 1 KiB
floor, keeps `Vary: Accept-Encoding`, and gives the gzip representation its own
`-gzip` ETag so the two encodings cannot answer each other's `304`.

**Correction `ec711dc` — two defects found by review:**

1. The gzip representation was produced **before** the conditional-request check, so
   a `304` for an already-stored gzip asset paid for a compression it then discarded.
   Compression now runs only for a body response, with a cancellation check on either
   side of the async call.
2. The `304` carried `Content-Encoding` and `Content-Type`, which describe a body that
   response does not send (the stored `200` already holds them). The `304` now carries
   only `ETag`, `Last-Modified`, `Vary` and `Cache-Control`.

Coverage (author's tests plus the correction): identity/gzip, `gzip;q=0`, `Vary`
maintenance, GET/HEAD, 200/304, distinct strong ETags per representation, `Content-Length`
matching the encoding, sub-threshold assets staying identity and unvaried, and the new
`304` shape. Compression of the same bytes twice cannot occur: owned assets are never
stored pre-compressed.

## #311 — compatibility bundle addressed by content revision

The start document now names `/mobile-access/compat-<sha256>.js`, served
`private, max-age=31536000, immutable`; a body that no longer matches the digest in the
path is refused with `404`, so one URL never carries two byte sequences. The
un-revisioned `/mobile-access/compat.js` remains for already-delivered documents and
keeps its revalidating contract.

**Correction `529567c` — one defect and three uncovered paths:**

1. **Defect:** the revision was memoised on an `mtime+size` signature, so an edit that
   keeps the bundle's length and restores its timestamp was invisible. The document then
   named a revision the route refuses with `404`, dropping the compatibility shim exactly
   on the old WebViews it exists for. Reproduced by the new test: two same-length bodies
   with a restored mtime produced `404` for the revision the document had just named.
   The digest is now computed from the bytes on every page load (~78 KB; far below the
   page load it belongs to).
2. Added coverage for the paths the PR left open: authentication and device revocation
   before a revisioned body **or its `304`**, a missing bundle falling back to the plain
   revalidating path (so the document never names an unhashable URL), and an
   unsatisfiable revision being refused (`404` when the file exists, the ordinary `503`
   when it does not) instead of answered with different bytes.

Content addressing is **not** treated as authorization: the revisioned route sits behind
the same session/Origin/revocation checks as every other owned asset.

## #292 — compress `/api/remote.mux` by default

The PR changes one default: `websocketCompression.paths` from `[]` to
`['/api/remote.mux']`, with an explicit `paths: []` opting back out. Because this
changes behaviour for every existing user, it was measured before being accepted.

### Method

`scripts/measure-mux-compression.mjs` launches **two** owned isolated profiles from the
same packed tarball (real `npm pack` + pnpm install), differing only in
`websocketCompression.paths`, against a real isolated DSH `0.2.1-rc.3` and real
Chromium. Both carry the same seeded workload: two Sessions × 120 completed synthetic
Turns committed through the public Session services by a test-only Host fixture (no
Agent, no model request).

- **Wire bytes** come from a Node `ws` client speaking the real mux protocol
  (`open`/`item` frames). `socket.bytesRead`/`bytesWritten` count actual TCP bytes, so
  this is transferred volume rather than decoded payload size — the only way to see what
  compression actually saves.
- **Interactivity and resources** come from Chromium on the paired Gateway origin, with
  CDP `Performance.getMetrics` for task/script/layout time and JS heap.

### Wire-byte results (same workload, 120 seeded Turns)

| Scenario | compressed | identity | ratio |
| --- | --- | --- | --- |
| Initialize, `bytesRead` | 6,238 B | 44,891 B | **0.139** (−86.1 %) |
| Initialize, `bytesWritten` | 707 B | 707 B | 1.000 |
| Session switch, `bytesRead` | 5,484 B | 44,147 B | **0.124** (−87.6 %) |
| 64 KiB binary frame, `bytesWritten` | 116 B | 65,586 B | **0.0018** (−99.8 %) |
| Second concurrent connection, `bytesRead` | 785 B | 744 B | 1.055 |
| Both connections, combined `bytesRead` | 12,533 B | 89,810 B | **0.140** (−86.0 %) |

Negotiation and teardown behave as designed: the compressed group negotiates
`permessage-deflate`, the identity group reports no extension; a normal close releases
both legs; a corrupt deflate payload closes the compressed leg with `1007` and the
identity leg with `1002` (RSV1 set without a negotiated extension) — neither relays
garbage.

The one number above 1.0 is the second connection measured on its own (785 B vs 744 B,
+41 B): a small stream pays the deflate-context and handshake overhead without enough
payload to amortise it. This is why `thresholdBytes` (1 KiB) exists and is unchanged.

### Chromium results (LAN, loopback, zero RTT)

| Metric | compressed | identity | ratio |
| --- | --- | --- | --- |
| `domcontentloaded` → interactive | 185 ms | 140 ms | **1.32** (+45 ms) |
| Shell mounted | 819 ms | 837 ms | 0.98 |
| Composer visible | 856 ms | 873 ms | 0.98 |
| CDP `TaskDuration` | 722.6 ms | 772.6 ms | 0.94 |
| CDP `ScriptDuration` | 195.0 ms | 190.9 ms | 1.02 |
| CDP `JSHeapUsedSize` | 25.60 MB | 25.52 MB | 1.003 |
| Mounted under CDP throttle (150 ms RTT, 250 KB/s) | 1,007 ms | 1,013 ms | 0.99 |

### Decision

**Keep the default on.** The transferred-volume reduction is large and consistent
(−86 % to −88 % of live-stream bytes per Session open and per switch, −99.8 % for a
64 KiB binary frame), and it is the dominant cost on a limited link: at the 1 Mbps that
the cpolar free plan documents, 38.6 KB per switch is ≈ 309 ms of pure transmission.
The CPU side is bounded and small: `TaskDuration` did not increase, heap moved by
+0.3 %, and the mounted/composer timings did not regress.

The honest cost is `domcontentloaded`→interactive at +45 ms on a zero-RTT loopback,
where there is no transmission time to win back. That is a real CPU price paid by every
page load on a fast link; it is smaller than the transmission it saves once the link has
any meaningful RTT, but this measurement does not prove the crossover point on a real
phone.

Behaviour change and exit: `websocketCompression.paths` now defaults to
`['/api/remote.mux']`. Setting `paths: []` in the existing `mobile-access` config
restores the previous uncompressed relay — verified in this measurement, where the
identity group reported no negotiated extension and moved 44,891 B where the compressed
group moved 6,238 B. `thresholdBytes` (1 KiB) and `level` (3) still bound tiny-frame and
CPU cost.

Not claimed: public-network, cellular or provider-relay acceptance. The throttle leg is
CDP artificial shaping on loopback and is recorded as such; it is not a slow-link field
test, and the 7–15.6 s → 1–2 s figure quoted in the PR body is the reporter's own
deployment measurement, not reproduced here.

## Commands and exit codes

| Command | Exit |
| --- | --- |
| `npx tsc --noEmit` | 0 |
| `npm run build` | 0 |
| `npx vitest run --pool=threads --maxWorkers=1` (full suite) | 0 — 2,785 passed / 20 skipped, 167 files |
| `npm run check:docs` | 0 — 48 Markdown files |
| `node scripts/measure-mux-compression.mjs` (with `DSH_BOOT_SMOKE_BIN` on DSH 0.2.1-rc.3) | 0 — both groups, no failures |
| `npm run smoke:dsh-boot` (packed tarball + isolated DSH 0.2.1-rc.3) | 0 — `Mobile client mounted through DSH Loader and read 1 Workspaces over /api/remote.mux` (72 plugin entries, 79,904 ms) |

Isolated DSH runtime for the measurement:
`npm install --prefix <TEMP> --no-save --package-lock=false @deepseek-ai/dsh@0.2.1-rc.3`.

## Evidence paths

- `local/mux-compression-evidence/mux-compression-report.json` — both groups, every
  scenario and browser metric, plus the ratio table.
- Test evidence lives in the tracked suites: `tests/gateway.test.ts` (owned-asset gzip,
  `304` shape, compat revision, revision authentication/revocation, missing-bundle
  fallback), `tests/gateway-websocket-compression.test.ts` (negotiation, default on,
  opt-out, binary frames, invalid frames, sub-threshold frames, `maxMessageBytes`),
  `tests/config-network.test.ts` (the default and the explicit `paths: []`),
  `tests/mobile-compat.test.ts`, `tests/auth-failure-log.test.ts`.

## Gaps

- No physical Android device, no public relay, no cellular run. The throttle leg is
  artificial and labelled as such; the real crossover RTT where compression wins on
  first paint is not measured.
- The two-group measurement is a single run per group. Wire bytes are stable (they are
  byte counts, not timings), but the browser timings carry normal single-run noise: the
  `interactiveMs` +32 % is one sample, while `mounted`/`composer`/`TaskDuration` all moved
  the other way. Repeated runs would be needed to quote a confidence interval.
- The second-connection figure (785 B vs 744 B) is a small-sample comparison and is
  reported as the overhead case, not as a regression.
- `websocketCompression` remains a whole-path decision; per-Session or per-message
  policy is unchanged and untested.
- The compat bundle is hashed on every page load. That cost (~78 KB SHA-256) was not
  benchmarked separately; it is bounded and far below the load it belongs to, but it is
  an added per-load cost that the previous memoised version did not have.
- The measurement harness depends on `socket.bytesRead`/`bytesWritten` from Node's
  `net.Socket`; a runtime that stops exposing them would silently report zero, so the
  harness asserts non-zero volumes.
