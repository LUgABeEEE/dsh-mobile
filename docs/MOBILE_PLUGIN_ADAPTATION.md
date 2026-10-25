# 移动端插件适配指南

[English](MOBILE_PLUGIN_ADAPTATION.en.md) · [返回文档索引](README.md)

插件在小屏上是否易用，由插件自己决定：移动层负责布局与连接，不替第三方面板重排样式。这份指南给出一条最小路径——**桌面不变，小屏可用**，不要求重做交互，也不要求安卓真机才能开始。

## 移动页如何承载插件

| 事实 | 对插件的影响 |
| --- | --- |
| 注册在 `main` 槽的面板占满手机宽度，上方有 56px 的「返回会话」栏 | 面板高度比桌面少 56px，不要假设独占整屏 |
| 侧栏是 340px 抽屉，不是常驻列 | 侧栏入口的文字与按钮要能收缩 |
| 布局提供 `[data-pane="conversation"]`、`[data-pane="sidebar"]` 与 `.dshm-shell` | 需要针对性选择器时用这些标记，不要依赖桌面 CSS 模块类名 |
| 外壳对 `input`/`textarea` 强制 `font-size: max(16px, …)` | 输入框会变大，表单密度要按这个前提设计 |
| 外壳只修正公共插槽的触摸目标 | 插件自己的按钮、行内动作、关闭键要自己保证 ≥44px |

## 用面板实测宽度切换

在面板根节点上测量一次，并观察后续尺寸变化：

```js
const MOBILE_MAX_WIDTH = 600
const [panelWidth, setPanelWidth] = useState(null)
const isMobile = panelWidth !== null && panelWidth <= MOBILE_MAX_WIDTH

useEffect(() => {
  const element = rootRef.current
  if (element === null) return undefined
  const measure = () => setPanelWidth(element.getBoundingClientRect().width)
  measure()
  window.addEventListener('resize', measure)
  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null
  observer?.observe(element)
  return () => {
    window.removeEventListener('resize', measure)
    observer?.disconnect()
  }
}, [])
```

```js
h('div', { className: 'panel', 'data-mobile': isMobile ? '1' : '0' }, …)
```

不要用 UA 判断，也不要用 `@media (max-width: 600px)` 代替：

- 面板宽度不等于视口宽度。桌面侧栏里的同一面板可能只有 400px，它同样需要移动档；
- 桌面窗口拖窄时，用户期望的是能用，而不是一个假装很宽的布局；
- 实测宽度可以由静态预览夹具喂一个固定值，从而让适配可回归。

600px 是建议值，不是规定。已有的宽屏断点（例如 ≥960px 开第二列）继续保留：`data-mobile` 管触控与密度，`data-wide` 管列布局。

## 适配清单

### 触控目标 ≥44px

桌面尺寸的 28–32px 按钮在手机上点不中。按钮、输入、选择器统一 `min-height: 44px`，图标按钮补 `min-width: 44px`。圆形勾选框保持 24px 视觉，只放大命中区：

```css
[data-mobile="1"] .check { position: relative; }
[data-mobile="1"] .check::after { content: ''; position: absolute; inset: -10px; }
```

不要把整张卡片一起放大：命中区可以扩，视觉尺寸不必跟着变。

### 横向 chip 与标签条改为可横滑

手机上筛选条、分组标签是最先被裁掉的东西，被裁的往往正是「只在有数据时才出现」的过滤器。

```css
[data-mobile="1"] .chips {
  flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
  padding: 0; scrollbar-width: none; -webkit-overflow-scrolling: touch;
}
[data-mobile="1"] .chips::-webkit-scrollbar { display: none; }
[data-mobile="1"] .chip { flex: 0 0 auto; min-height: 44px; }
```

同时隐藏只起分隔作用的竖线：容器改为横滑后，它会换行落单。

### 行内文字动作收成图标

并排的文字按钮会吃掉标题宽度，把正文挤成两三行。把文字包一层标签，移动档隐藏标签、保留可访问名称；菜单与详情里继续保留文字入口：

```js
h('button', { className: 'btn', 'aria-label': label }, h(Icon, { name: 'play' }), h('span', { className: 'btn-label' }, label))
```

```css
[data-mobile="1"] .btn-label { display: none; }
[data-mobile="1"] .btn { min-width: 44px; padding: 0; justify-content: center; }
```

文字可以消失，动作不能消失。

### 隐藏桌面专属提示

`/` 聚焦搜索、`kbd` 角标、快捷键表在没有键盘的设备上只是噪声。移动档隐藏它们，说明留在帮助页。

### 底部安全区与滚动边界

面板自己是滚动容器时，外壳的顶部安全区管不到列表末尾；惯性滚动还可能把背后页面一起带着走。

```css
[data-mobile="1"] .inner { padding-bottom: max(28px, calc(14px + env(safe-area-inset-bottom))); }
[data-mobile="1"] .list { overscroll-behavior: contain; }
```

### 字号跟随外壳变量

移动页把「移动端字号」放在 `--dsh-content-font-size` 上（默认 16px）。写死 13px 会让调大字号时只有输入框变大：

```css
[data-mobile="1"] .panel { font-size: var(--dsh-content-font-size, 15px); }
[data-mobile="1"] .meta { font-size: max(12px, 0.8em); }
```

桌面没有这个变量，回退值即可，不影响电脑。

### 弹层与表单

固定 360px 的设置卡放进 390px 视口会两边被切；两列表单会挤成一条。移动档让弹层贴两边、表单收成单列、多行输入至少 96px：

```css
[data-mobile="1"] .settings { width: auto; max-width: none; }
[data-mobile="1"] .form-row { grid-template-columns: minmax(0, 1fr); }
[data-mobile="1"] textarea { min-height: 96px; }
```

### 标题区压缩、列表密度

手机首屏要留给内容。标题降到约 1.2em，副标题单行截断，卡片间距收紧——但不要把触控目标一起收紧。

## 验证

适配最容易烂在「只有真机能看出来」。下面这套做法能让大部分回归在自动检查里发现。

### 给静态预览夹具加宽度参数

若插件用「服务端渲染 + 静态 HTML 预览」生成截图基线，面板的宽度测量在这些静态页里不会执行（没有布局引擎），结果永远落到宽屏分支。让夹具回答这次测量：

```js
const viewport = { width: 0, height: 0 }
for (const arg of process.argv.slice(2)) {
  const match = /^--(width|height)=(\d+)$/.exec(arg)
  if (match) viewport[match[1]] = Number(match[2])
}
// 渲染时给每个 ref 一个按目标宽度回答的布局桩
if (typeof type === 'string' && viewport.width > 0 && props?.ref) {
  props.ref.current = {
    getBoundingClientRect: () => ({ width: viewport.width, height: viewport.height, top: 0, left: 0, right: viewport.width, bottom: viewport.height }),
    contains: () => false, focus() {}, blur() {}, scrollIntoView() {},
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  }
}
```

这样 `--width=390` 渲染的是真实窄屏分支，而不是把桌面页缩小。

### 把结构断言接进渲染检查

- 窄屏渲染出现移动档标记；
- CSS 里仍存在 44px、`safe-area-inset-bottom`、`--dsh-content-font-size` 规则；
- 被隐藏的提示与收起的文字，仍保留可访问名称；
- 桌面渲染与基线逐像素一致。

### 截图基线

手机档取 390×844，至少覆盖列表、详情、设置三态；桌面档改完后重拍，与旧图对比。

### 静态检查证明不了的事

软键盘弹出后的可视区、真实 `env(safe-area-inset-*)` 的值、惯性滚动与回弹、系统字号放大后的换行，都要留到真机。

## 参考实现

`dsh-global-todo` 的 0.19.0 移动档按本指南走了一遍（该版本尚未公开发布）：

| 项 | 做法 |
| --- | --- |
| 信号 | 面板实测宽度 ≤600px → `data-mobile="1"` |
| 触控 | 按钮/输入/筛选 44px；圆形勾选框 24px 视觉 + 伪元素扩命中区 |
| 密度 | 行内「交给 Agent」收成图标（`aria-label` 保留）；创建者归属移入详情；meta 恢复每行 2–3 条 |
| 横滑 | 筛选 chip 单行横滑、隐藏分隔条；工具栏改单列、搜索满宽 |
| 桌面提示 | `/` 角标与 `kbd` 隐藏 |
| 安全区 | 底部 `max(28px, 14px + env(safe-area-inset-bottom))`；列表 `overscroll-behavior: contain` |
| 字号 | 正文取 `--dsh-content-font-size`（回退 15px） |
| 弹层 | 设置卡贴两边、保留实测 top，不再固定 360px |
| 结果 | 390×844 卡片高度约 250px → 150px；所有目标 ≥44px；桌面截图逐像素不变 |
| 回归 | 预览夹具 `--width=390`；渲染检查断言移动分支与关键规则；生成 390×844 基线 |

改动只用三个稳定挂钩：移动档开关、一个文字标签的包装类、以及需要隐藏的事实的类名。没有第二套渲染路径——详情仍然只有一份实现。

## 给插件作者的模板

### Issue

```markdown
## 插件与小屏
- 插件名/版本：
- 面板位置（侧栏入口 / 主面板 / 其他）：
- 手机与 App（或浏览器）版本：
- 现象（截图/录屏）：
- 期望（只要求「桌面不变 + 小屏可用」）：

## 验收
- [ ] 触控目标 ≥44px
- [ ] 横向 chip 可横滑、无被裁的尾部
- [ ] 行内文字动作收成图标且保留可访问名称
- [ ] 桌面专属提示已隐藏
- [ ] 底部安全区与 overscroll 处理
- [ ] 字号跟随 --dsh-content-font-size
- [ ] 弹层/表单在 390px 下不溢出
- [ ] 桌面截图无回归
```

### PR

- [ ] 只有一份渲染/详情实现，没有为移动复制第二套；
- [ ] 断点基于实测宽度，不是 UA/viewport；
- [ ] 移动规则挂在同一个开关下，桌面选择器未改动；
- [ ] 静态预览可以指定宽度，且窄屏分支真的被执行；
- [ ] 渲染检查新增结构断言，桌面基线已对比；
- [ ] 真机未验的部分在描述里写明（键盘、安全区、惯性滚动）。

## 边界与反模式

- 不要由移动层按类名注入第三方 CSS：类名一变就碎，而且会同时影响桌面。
- 不要为移动端复制一套组件树：两份实现一定会在第一个字段变更时分叉。
- 不要承诺所有插件都能适配：后台型、依赖原生窗口的插件不在此列。
- 不要把「能滚动」当成验收通过：还要看首个异常、实际尺寸与焦点顺序。
