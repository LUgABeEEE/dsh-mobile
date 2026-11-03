# dsh-mobile 缓存补丁（本地，独立于上游发行）

> 状态：**本地补丁，未提交上游**。基线 `saya-ch/dsh-mobile` **0.8.1**（commit `42cabbd`）。
> 生成时间：2026-11-02；真机回填 2026-11-03。作者：LUgABeEEE。

## 为什么存在这套补丁

上游 2026-10-31 撤回了 #267 的三组可选缓存（同日 revert，PR #327 把 main 退回 0.8.0），
2026-11-02 又关闭了跟进文档 PR #326，并把 #314 的 Android 启动批缓存标为 defer。
维护者给出的边界是：

- 列表/历史走 `/api/remote.mux` 帧，不存在可命中的 HTTP 路由，**不能**把这类“缓存收益”当证据；
- 只做静态资源优化也要给真实路径、生命周期、一致性与收益验证；
- 0.8.2 候选不恢复任何 API / history / native 缓存。

因此这套补丁只做**两件有真实路径的事**，作为独立补丁自用、并在验证充分后按上游口子重新提交：

1. **网关静态资源缓存组**（`/plugins`、`/assets` 两类真实回源路径，默认关闭）；
2. **Android 启动批缓存**（`/mobile-access/mobile-boot/<64hex>.js`，网关拼装的真实可拦截路径），
   并按上游点名的四项 defer 条件加固：请求取消、正文一致性、清空与下载隔离、收益测量。

**明确不做**：API 读缓存、会话历史读缓存、`/mobile-access` 下由网关本地应答的其它路径
（`compat*.js`、`mobile-layout.js`、`custom.css/js`、启动批本体）——它们进不了代理缓存，
写进白名单也不会命中，这类声明正是被撤回的原因。

## 补丁列表（按顺序应用）

| # | 文件 | 内容 |
|---|---|---|
| 1 | `0001-feat-gateway-add-an-opt-in-static-asset-cache-as-a-l.patch` | `src/{config,content-cache,gateway}.ts`、`tests/{content-cache,gateway}.test.ts`、`docs/SLOW_CONNECTIONS{,.en}.md`、`CHANGELOG.md` |
| 2 | `0002-feat-android-reuse-revalidated-boot-batches-with-own.patch` | `apps/mobile/android/**`（3 个实现类 + `BootAssetMetrics` + 5 个测试类 + `MainActivity`/`SecureWebViewClient` 挂接 + `BOOT_CACHE_PATCH.md`） |
| 3 | `0003-fix-android-proceed-pinned-WebSocket-certificate-err.patch` | `GatewayUrlPolicy.isPinnedAuthority` + `SecureWebViewClient` + `GatewayUrlPolicyWebSocketTest`（**前置修复**：`wss:` 证书错误不再取消文档） |
| 4 | `0004-docs-android-record-the-device-verification-of-the-b.patch` | 本 README 与 `BOOT_CACHE_PATCH.md` 的真机结果回填 |
| 5 | `0005-docs-android-record-the-first-paint-and-fallback-measurements.patch` | `BOOT_CACHE_PATCH.md` 补首屏无收益与慢链路回落现状 |

## 应用 / 回滚

```bash
cd dsh-mobile
git checkout -b local/cache-patch 42cabbd      # 基线：0.8.1
git am /path/to/patches/0001-*.patch /path/to/patches/0002-*.patch
# 或者只想要工作树改动、不要 commit：
# git apply --index /path/to/patches/*.patch
```

回滚：

```bash
git checkout -- . && git clean -fd apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile
# 或整体丢弃：git checkout main
```

（若已 commit：`git reset --hard 42cabbd` 之后自行恢复其它工作。）

## 验证证据（2026-11-02，SER8 本机）

网关：

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 |
| `npx vitest run tests/content-cache.test.ts tests/gateway.test.ts` | 2 files / 165 tests passed |
| `npm run check:docs` | passed（53 md，锚点可跳转） |
| 全量 `npx vitest run` | 3176 passed；仅 2 个 `npm pack` 因本机 `/data/agent/.npm` 属主 EACCES 失败（环境问题） |

Android（自包含工具链：JDK 17.0.2 + Android SDK platform 36 / build-tools 36.0.0 + Gradle 9.8.2）：

| 命令 | 结果 |
|---|---|
| `gradle --no-daemon -PirohNative=false :app:testDebugUnitTest` | **BUILD SUCCESSFUL**，74 个测试类 / **503 用例，0 失败 0 跳过** |
| 启动批缓存相关套件 | `BootAssetCacheTest` 19、`BootAssetStoreTest` 15、`BootAssetCachingWiringTest` 7、`BootAssetPolicyTest` 5、`HttpBootAssetFetcherTest` 9（共 55） |

真机（2026-11-03，Xiaomi Pad 9 Pro Max / Android 17 / WebView 150.0.7871.181 / LAN 配对）：

| 项 | 结果 |
|---|---|
| JVM + lint（补丁 + 0003 修复） | **75 套件 / 509 例，0 失败 0 跳过**；`:app:lintDebug` 0 error |
| 收益（5 组冷/热） | 冷 `hits=0 misses=4`、`savedPercent=0`；热 `hits=4 revalidated=4`、`fetched=0`、`savedPercent=100`，`served = fetched + saved` 每轮成立 |
| 真实线缆节省 | **3,930,340 B / 次热启动**（gzip 后；解码字节 9,163,737 B 只是“页面收到多少”） |
| 关闭缓存对照（3 组） | 每次启动都传 3,930,340 B，冷热无差别（Chromium 缓存不跨进程） |
| 正文一致性 | 篡改 16 B + 截断到 100 KB 后重启：`hits=2 misses=2`，`fetched=2,562,826 B`（正好是被动过的两个批包），页面正常 boot |
| 前置修复 | 未修时每次冷启动都因 `wss:` 证书错误取消文档（`pinned=false` + 「安全连接失败」），修复后 `pinned=true`，3/3 正常 |

证据全文：`/data/agent/workspace/dsh 手机应用/真机测量-20261102/t2-t3-真机验证-20261103.md`。

**仍未验证**：取消路径的真机演示（LAN 单批 80–123 ms，手动打不断；单测覆盖）、真机「清除站点数据」
（会连带清配对）、iroh lane、remote/cpolar 路径。测量方法见
`docs/SLOW_CONNECTIONS.md#本地补丁静态资源缓存` 与 `apps/mobile/android/BOOT_CACHE_PATCH.md`；
注意 `remote.mux` 帧不算 HTTP 命中。

## 已知限制（导出时如实记录）

1. **网关会剥离客户端的 `If-None-Match` / `If-Modified-Since`**（`src/gateway.ts:3812`）：启用缓存时由网关自己拿缓存条目的验证器去回源。浏览器侧因 `no-store`/`immutable` 很少触发，但自带验证器的自定义客户端在无 stale 时可能拿不到 `304`。低风险，未改。
2. **Android 拦截预算是 6s**（connect 3s / read 4s）：超时只是取消本次拦截，WebView 会用自己的更大预算重新请求，代价是一次重复请求而不是加载失败。真机 LAN 实测 `avgMs` 27–42、`maxMs` 28–123（5 组冷/热），`cancelled` 恒为 0，6s 对 LAN 有 50 倍余量；慢速远程链路（cpolar 等）下 MB 级批可能走不成缓存路径，仍等 remote 数据再定值。
3. **`ContentCache` 命中后不改变浏览器可缓存性**：响应仍是 `Cache-Control: no-store`，避免把“网关侧缓存”说成“浏览器缓存”。
4. 全量 `vitest run` 有 2 个失败与补丁无关：本机 `/data/agent/.npm` 存在 root 属主文件导致 `npm pack` EACCES（环境问题）。

## 上游提交清单（将来）

- [x] 真实设备的开启/关闭对比数据（2026-11-03，5 组冷/热 + 3 组关闭缓存对照；见上表）；
- [ ] `wss:` 证书修复（0003）先单独提交：它本身就是上游缺陷，且是本补丁真机可用的前置条件；
- [ ] 网关补丁按 0.8.2 候选的当前结构 rebase，确认 `contentCacheAssetPaths` 默认值仍是 `/plugins`、`/assets`；
- [ ] Android 补丁需在真实设备上验证 gzip 场景（网关 ETag 带 `-gzip`、缓存的是 decoded body）与取消竞态；
- [ ] 提交时说明：这是对撤回方案的收窄重启，只覆盖有真实路由的静态资源读，不含 API/历史缓存。
