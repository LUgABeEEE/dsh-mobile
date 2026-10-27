# iroh 实验性整合候选

iroh 用加密直连（打不通时走中继）代替公网域名和隧道账号：手机先找到电脑的加密身份，再把流量送回本机网关。你不需要准备域名、端口映射或另一套 HTTPS 隧道。

> **未发布候选。** 本分支将电脑端 provider、固定 TLS、配对界面和 Android 传输整合到 DSH Mobile。开发构建默认包含 arm64-v8a 和 x86_64 原生库，传 `-PirohNative=false` 才明确省略。本地整合不代表已发布插件和 APK 已支持 iroh；真机、跨网与最终发布 CI 验收仍待完成。
> 相关设计见独立仓的[集成接缝](https://github.com/saya-ch/dsh-mobile-iroh/blob/main/docs/INTEGRATION_SEAM.md)。

## 前提

- Windows x64 或 Linux x64（sidecar 只发布这两个目标）。
- 点 **安装官方组件** 一次下好 sidecar：插件从固定的 `dsh-mobile-iroh 0.1.0-alpha.1` 发行版按平台下载（Windows x64 约 15 MB，Linux x64 约 24 MB），校验 SHA-256 后放进插件私有目录；已装配套插件且副本校验通过时会直接复用，不再下载。Rust 源码随主仓在 `native/iroh-host`（公共 core 在 `native/iroh-core`）维护，CI 按平台构建校验。
- DSH Mobile 保持启用；iroh 通道默认关闭，不影响局域网和其他远程通道。

## 使用

1. 在 **移动访问 → 远程** 选择 `iroh（实验性）`。
2. 点 **准备 iroh → 安装官方组件**（带下载大小）：首次下载并校验 sidecar，通过才算就绪；再次点击会复用已校验的副本。哈希不对、平台不支持都会直接给出原因，不会启动半截通道。注意只是点开通道开关不会触发下载。
3. 打开远程开关：插件依次解析端点身份、签发端点专属网关证书（自有 CA，90 天叶子、30 天提前续）、起专用网关、拉起 sidecar 进程并等待 `ready`。`ready` 表示 sidecar 已连接且网关在回环监听。
4. 点 **生成 iroh 配对二维码**，用包含原生传输的候选 App 扫描。描述符绑定 sidecar 的 6 位码、网关的一次性 token 和固定 CA；再次生成会替换旧配对窗口，手机通过 iroh 上的普通 pair 接口核销网关 token。
5. 关闭或切换通道会停止自有进程与网关，不删除已保存的配对。独立实验 App 的包名不同，其 Keystore 凭据不会自动迁移到本 App。

## 安全边界

- sidecar 只允许代理到 `127.0.0.1`/`::1` 的回环网关，TLS 仍端到端；命令与事件都是版本化、定长、未知字段直接拒绝。
- 换指纹/换二进制/挪文件都会让校验失败并停在 `unavailable`，不会静默跑旧通道。
- 传输层撤销与设备 Token 撤销是两套授权，统一管理界面是 Phase 2 内容；电脑端撤销仍按现有设备管理生效。

## 排障

组件发布前必须使用目录中固定的二进制验证首次启用，不能只测本地编译的 host 或手工初始化过的目录。控制器调用 `tls-prepare`，因为 `id` 只读取既有身份。Windows 可设置 `DSH_IROH_PINNED_FIRST_USE=<已校验的程序>` 后运行 `npx vitest run tests/iroh-pinned-first-use.test.ts`，检查私有测试目录中的初始化、复用与损坏拒绝。失败应阻止组件验收，不得通过放松目录 ACL 检查或替换真实身份来让测试通过。

| 现象 | 含义 |
| --- | --- |
| `iroh_companion_missing` | 还没点安装（或配套不在常规布局旁）；先点安装官方组件，或用 `DSH_MOBILE_IROH_COMPANION` 指向配套绝对路径复用 |
| `iroh_sidecar_invalid` | 已装文件被改动过；重新点安装即可覆盖修复，配套副本损坏则重装配套 |
| `iroh_platform_unsupported` | 当前系统/架构没有 sidecar 发布 |
| `iroh_identity_failed` / `iroh_start_timeout` | sidecar 进程异常看 DSH 日志的 iroh 行后重试；反复失败可直接跑 sidecar 自检：`<sidecar> --lang en id --data-dir "<数据目录>"`，exit 0 并打出 64 位 hex 即正常。空目录建身份失败、但已有 `identity.key` 可用，多半是端点防护拦截了私有文件创建，先备份好 `identity.key`。真机确认再用 `DSH_IROH_SIDECAR=<sidecar> npx vitest run tests/iroh-host-real.test.ts` |
| 通道 `ready` 但手机连不上 | 检查 App 是否为包含原生传输的候选、设备是否支持打包的 ABI，以及描述符是否有效；电脑就绪不等于端到端验收通过 |

英文版见 [IROH.en.md](IROH.en.md)。
