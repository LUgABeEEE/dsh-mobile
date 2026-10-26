# iroh 实验性通道（Phase 1：仅电脑端）

iroh 用加密直连（打不通时走中继）代替公网域名和隧道账号：手机先找到电脑的加密身份，再把流量送回本机网关。你不需要准备域名、端口映射或另一套 HTTPS 隧道。

> **实验状态。** 电脑端已合入：provider 注册、sidecar 生命周期、端点专属网关 TLS、面板状态与配对二维码。手机端已合入主 App（传输模块、版本化配对记录、扫码配对、carrier 感知的恢复与撤销监视），但需要带 `-PirohNative=true` 的原生构建才包含传输库；默认构建仍是纯 HTTPS 外壳。
> 相关设计见独立仓的[集成接缝](https://github.com/saya-ch/dsh-mobile-iroh/blob/main/docs/INTEGRATION_SEAM.md)。

## 前提

- Windows x64 或 Linux x64（sidecar 只发布这两个目标）。
- 点 **安装官方组件** 一次下好 sidecar：插件从固定的 `dsh-mobile-iroh 0.1.0-alpha.1` 发行版按平台下载（Windows x64 约 15 MB，Linux x64 约 24 MB），校验 SHA-256 后放进插件私有目录；已装配套插件且副本校验通过时会直接复用，不再下载。Rust 源码随主仓在 `native/iroh-host`（公共 core 在 `native/iroh-core`）维护，CI 按平台构建校验。
- DSH Mobile 保持启用；iroh 通道默认关闭，不影响局域网和其他远程通道。

## 使用

1. 在 **移动访问 → 远程** 选择 `iroh（实验性）`。
2. 点 **准备 iroh → 安装官方组件**（带下载大小）：首次下载并校验 sidecar，通过才算就绪；再次点击会复用已校验的副本。哈希不对、平台不支持都会直接给出原因，不会启动半截通道。注意只是点开通道开关不会触发下载。
3. 打开远程开关：插件依次解析端点身份、签发端点专属网关证书（自有 CA，90 天叶子、30 天提前续）、起专用网关、拉起 sidecar 进程并等待 `ready`。`ready` 表示 sidecar 已连接且网关在回环监听。
4. 点 **生成 iroh 配对二维码**：sidecar 给出 6 位一次性码，网关同时打开一次性配对窗口，两者与固定 CA 一起封进描述符。扫一次就换，再生成会替换旧窗口。网关 token 复用标准一次性配对机制，Phase 2 手机经 iroh 传输用普通 pair 流程核销。
5. 关闭/切换通道会先发 `shutdown` 再回收进程与网关；过渡期已装的配套仍会被复用，卸载配套请走 DSH 插件管理。

## 安全边界

- sidecar 只允许代理到 `127.0.0.1`/`::1` 的回环网关，TLS 仍端到端；命令与事件都是版本化、定长、未知字段直接拒绝。
- 换指纹/换二进制/挪文件都会让校验失败并停在 `unavailable`，不会静默跑旧通道。
- 传输层撤销与设备 Token 撤销是两套授权，统一管理界面是 Phase 2 内容；电脑端撤销仍按现有设备管理生效。

## 排障

| 现象 | 含义 |
| --- | --- |
| `iroh_companion_missing` | 还没点安装（或配套不在常规布局旁）；先点安装官方组件，或用 `DSH_MOBILE_IROH_COMPANION` 指向配套绝对路径复用 |
| `iroh_sidecar_invalid` | 已装文件被改动过；重新点安装即可覆盖修复，配套副本损坏则重装配套 |
| `iroh_platform_unsupported` | 当前系统/架构没有 sidecar 发布 |
| `iroh_identity_failed` / `iroh_start_timeout` | sidecar 进程异常看 DSH 日志的 iroh 行后重试；反复失败可直接跑 sidecar 自检：`<sidecar> --lang en id --data-dir "<数据目录>"`，exit 0 并打出 64 位 hex 即正常。空目录建身份失败、但已有 `identity.key` 可用，多半是端点防护拦截了私有文件创建，先备份好 `identity.key`。真机确认再用 `DSH_IROH_SIDECAR=<sidecar> npx vitest run tests/iroh-host-real.test.ts` |
| 通道 `ready` 但手机连不上 | 预期内：等 Phase 2 Android 传输 |

英文版见 [IROH.en.md](IROH.en.md)。
