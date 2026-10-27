# Third-party notices

## Brand artwork

The Android launcher whale-mark variants were contributed by [@abworks-dev in PR #175](https://github.com/saya-ch/dsh-mobile/pull/175), which describes rendering the DeepSeek whale SVG path. They identify the upstream brand; DSH Mobile remains a community-maintained client, not an official DeepSeek Android application or an assertion of endorsement. This repository's code license does not assert ownership of third-party names or marks. The default character artwork and repository hero remain the project's existing brand assets.

## Runtime components

DSH Mobile includes platform-specific Windows and Linux Funnel helpers built from the source in `native/funnel-host`. They use [Tailscale tsnet](https://pkg.go.dev/tailscale.com/tsnet) `v1.102.3`, distributed under the BSD 3-Clause license. Their exact statically linked Go module versions and complete license and notice texts are generated from the bundled executables into `FUNNEL_THIRD_PARTY_LICENSES.txt`, which is included in every npm package.

The optional cpolar component is not included in the npm package or Android App. When a user explicitly chooses cpolar installation, DSH Mobile downloads the pinned official archive shown in the UI, verifies its size and SHA-256 digest, and stores it only under the user's DSH Mobile data directory. cpolar remains subject to its [terms of service](https://www.cpolar.com/tos).

The optional [FRP](https://github.com/fatedier/frp) client is not included in the npm package or Android App. When a user explicitly chooses self-hosted FRP installation, DSH Mobile downloads the pinned official `frpc` 0.70.1 archive, verifies its origin, exact size, SHA-256 digest, archive paths, and executable version, then stores only `frpc` under the user's DSH Mobile data directory. FRP is distributed under the Apache License 2.0.

The optional [cloudflared](https://github.com/cloudflare/cloudflared) client is not included in the npm package or Android App. When a user explicitly chooses cloudflared installation, DSH Mobile downloads the pinned official release asset for the supported host platform (version recorded in `src/cloudflared-component.ts`), verifies its exact size and SHA-256 digest, and stores it only under the user's DSH Mobile data directory. The client is started with automatic updates disabled. Quick tunnels do not require account credentials; named tunnels use an operator-supplied connector token stored in the plugin's private directory. cloudflared is distributed under the Apache License 2.0; use of Cloudflare's quick tunnels remains subject to Cloudflare's [website terms](https://www.cloudflare.com/website-terms/).

The optional managed Caddy component is not included in the npm package or Android App. Since plugin 0.6.9, users on Windows/Linux x64 can explicitly confirm an on-demand download of the fixed [DSH Mobile component distribution](https://github.com/saya-ch/dsh-mobile/releases/tag/caddy-component-2.11.7-tencentcloud-0.4.3-r1); its source, exact size and SHA-256 are pinned in the plugin. This distribution builds [Caddy v2.11.7](https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE), under Apache License 2.0, with [caddy-dns/tencentcloud v0.4.3](https://github.com/caddy-dns/tencentcloud/blob/v0.4.3/LICENSE), under the MIT License. The component release supplies each platform's exact embedded dependency manifest, Go build metadata and complete third-party license/notice texts as separate assets. It is a DSH Mobile build, not an upstream Caddy release or a dynamically generated download. Existing user-managed proxies are separate from this optional component.

The experimental Rust transport is adapted from [dsh-mobile-iroh](https://github.com/saya-ch/dsh-mobile-iroh), copyright 2026 Guangqi Zhang, under the MIT License, and the host baseline preserves zexadev's MIT-licensed dsh-tether attribution. The source notices and complete licenses are retained under `native/iroh-host/` and included with the npm package. The optional sidecar is not bundled: explicit installation reuses a verified companion copy or downloads the size- and SHA-256-pinned companion release payload. Enabling the channel alone does not download it.

The npm package declares direct runtime dependencies on [Schemastery](https://github.com/shigma/schemastery) `^3.18.1`, [@noble/hashes](https://github.com/paulmillr/noble-hashes) `1.8.0`, [bonjour-service](https://github.com/onlxltd/bonjour-service) `1.4.4`, [eventsource-parser](https://github.com/rexxars/eventsource-parser) `3.1.0`, [qrcode](https://github.com/soldair/node-qrcode) `^1.5.4`, [selfsigned](https://github.com/jfromaniello/selfsigned) `^5.5.0`, and [ws](https://github.com/websockets/ws) `8.22.0`. These packages are distributed under the MIT License; the release checkout's exact transitive versions appear in the attached CycloneDX npm SBOM.

The Android App runtime contains [Kotlin standard library](https://github.com/JetBrains/kotlin) `2.1.0`, [kotlinx.coroutines](https://github.com/Kotlin/kotlinx.coroutines) `1.6.4`, [JetBrains annotations](https://github.com/JetBrains/java-annotations) `13.0`, [AndroidX Core](https://developer.android.com/jetpack/androidx/releases/core) `1.15.0`, [AndroidX WebKit](https://developer.android.com/jetpack/androidx/releases/webkit) `1.17.1`, their AndroidX transitive components, [Guava listenablefuture](https://github.com/google/guava) `1.0`, and [ZXing Core](https://github.com/zxing/zxing) `3.5.4`. These runtime libraries are distributed under the Apache License 2.0; the exact resolved tree is attached to each release as `dsh-mobile-android-v<version>-dependencies.txt`.

Native-enabled Android candidate builds package `libdsh_mobile_iroh_android_transport.so` for arm64-v8a and x86_64, from `native/iroh-android-transport` and `native/iroh-core`. These sources retain their MIT license; the surrounding Android shell remains Apache-2.0. `native/Cargo.lock` records Rust dependency versions. The ordinary CI lane explicitly opts out with `-PirohNative=false`; the native CI/release lanes build both selected ABIs. This candidate does not change the already published APK or establish 32-bit-device installation support.

### Rust dependency licenses in the native Android build

`cargo metadata --locked --manifest-path native/Cargo.toml` resolves 412 packages for the
native-enabled build, across 30 license expressions. Almost all are permissive (MIT,
Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, CC0-1.0, Unicode-3.0, Unlicense,
CDLA-Permissive-2.0), typically offered as a choice such as `MIT OR Apache-2.0`.

Two entries need a specific statement rather than "permissive":

- **`attohttpc` 0.30.1** and **`option-ext` 0.2.0** are **MPL-2.0**
  (<https://github.com/sbstp/attohttpc>, <https://github.com/soc/option-ext>). MPL-2.0 is
  file-level copyleft: it permits static linking and distribution inside a larger
  work, and requires that the MPL-covered source files remain available under MPL-2.0
  and that recipients are told where to get them. Both are unmodified upstream crates;
  their source is available from the repositories above and from crates.io at the
  pinned versions in `native/Cargo.lock`. No DSH Mobile source file is derived from
  them.
- **`r-efi` 5.3.0 and 6.0.0** declare `MIT OR Apache-2.0 OR LGPL-2.1-or-later`. The
  permissive options are taken, so LGPL-2.1 does not apply to this distribution.

The exact resolved versions are fixed by `native/Cargo.lock`. Anyone rebuilding must
re-run `cargo metadata --locked` against that lock file to regenerate this list; the
package set is not guaranteed stable across an unlocked dependency update.

## Notification identity hashing

The client bundle includes the SHA-256 implementation from @noble/hashes to derive bounded notification tags from complete IDs. Its MIT license is included below:

```text
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Event-stream parsing

The Gateway uses eventsource-parser for Server-Sent Events framing. Its MIT license is included below:

```text
MIT License

Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## core-js browser compatibility bundle

The standalone `lib/mobile-compat.js` bundles selected compatibility modules, including Iterator, `Promise.withResolvers`, collection methods and structured cloning, from [core-js](https://github.com/zloirock/core-js) `^3.50.0` (exact version recorded in `package-lock.json`). It is built into the npm package; browsers do not download a polyfill from a CDN. core-js is distributed under the following MIT License:

```text
Copyright (c) 2013–2025 Denis Pushkarev (zloirock.ru)
Copyright (c) 2025–2026 CoreJS Company (core-js.io)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
