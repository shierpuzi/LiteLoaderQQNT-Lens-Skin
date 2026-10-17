# Lens 透镜 · QQ NT 皮肤插件

**当前版本：v0.9.1** ｜ [Release](https://github.com/shierpuzi/LiteLoaderQQNT-Lens-Skin/releases/tag/v0.9.1)

把开源设计体系 **[Lens 透镜](https://github.com/ruiqichenbiec/design-systems)**（`lens/lab/design-system`）的视觉与听觉语言映射到 QQ NT 桌面端。

Lens 的立论是「**玻璃承载信息，液体表达连续变化，光表达状态**」。这个插件把这三条落到 QQ 的界面令牌、过渡曲线与合成音上——不含任何图片素材或音频文件。

> 灵感来源与设计体系：[ruiqichenbiec/design-systems](https://github.com/ruiqichenbiec/design-systems)（MIT）。本插件是独立实现，只复用其**设计令牌、弹簧曲线常数与音频合成算法**，不包含该仓库的代码或素材。

## 功能

| 层 | 内容 |
|---|---|
| **令牌** | 把 QQ 原生主题令牌换成 Lens 的值：`--brand_standard` → `#2875ed`、正文 `#22252b`、chrome 圆角 14px、玻璃面板（`backdrop-filter`） |
| **玻璃面板** | 面板透明度（`--lg-alpha`）与高斯模糊（`--lg-blur`）**可在设置页实时调**，模糊为 0 时自动关闭 `backdrop-filter`（不白付合成开销） |
| **派生色补全** | QQ 有 25 个蓝色系令牌是**构建期预计算**的、不跟随基色。插件用 `color-mix()` 从唯一真源推导，避免界面出现两套蓝 |
| **GPU 光源** | 全窗口一张 WebGL2 画布、一次 `drawArrays` 画出所有控件：**边缘迎光/背光随鼠标位置联动**（逐像素方向光 + 距离衰减），强度可调、可一键关闭。CSS 阴影方案实测只有 ~20fps，故改用 GPU |
| **控件边界** | 控件边界收敛：`.func-menu__item` 等圆角为 0 的元素不参与光照（否则画出方框）；虚拟列表的隐藏测量副本按可见性过滤 |
| **动效** | 导航项 / 联系人项 / 底部功能项 / 发送按钮的弹性按压，走 Lens 弹簧 `cubic-bezier(.2,.9,.25,1.22)` |
| **声音** | Web Audio **实时合成**（零音频文件）：点击、发送、悬浮、拖拽/滚动/拖动窗口的摩擦音 |
| **设置页** | QQ 设置 → 插件 → Lens 透镜：面板透明度 + 高斯模糊 + 鼠标光源开关/强度 + 3 个音效开关 + 总音量 + 摩擦音强度 + 光照调试 + 恢复默认 |
| **光照调试** | 拖框把光照限制在指定范围内渲染（按窗口比例计算，缩放不错位，`Ctrl+Shift+B` 开关）＋ 导出光照命中清单到控制台；元素拾取统一交给「DSH 调试日志」插件 |

## 安装

1. 安装 [LiteLoaderQQNT](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT)（需先绕开 QQ 的文件校验）
2. 下载 [最新 Release](https://github.com/shierpuzi/LiteLoaderQQNT-Lens-Skin/releases/latest) 的 `lens-skin.zip`
3. 解压到 `<profile>\plugins\lens-skin\`（`manifest.json` 需在该目录顶层）
4. 重启 QQ

验证：左侧栏、联系人列表、发送按钮应换成 Lens 蓝与玻璃质感；点一下按钮能听到轻响。

> **首次点击前没有声音是正常的** —— 浏览器要求真实用户手势后才能启动音频。

## 设置

QQ 设置 → 插件 → Lens 透镜：

**界面**

- **面板透明度**：左侧栏 / 会话列表 / 聊天区 / 输入区玻璃底色的通透程度（越低越透）
- **高斯模糊**：面板背后内容的模糊程度，0 ~ 64px；设为 0 即关闭模糊
- **鼠标光源**：全部控件共用同一个 GPU 光源，边缘迎光/背光随鼠标联动
- **光照强度**：光影强弱；设为 0 等同关闭

**声音**

- **点击音效**：控件点击、发送（含回车）
- **悬浮音效**：鼠标划过控件（带 95ms 冷却，快速滑动不会爆音）
- **摩擦音效**：拖拽联系人、滚动列表、拖动窗口
- **总音量** / **摩擦音强度**：可调
- **恢复默认**：一键复位全部选项

改动**即时生效**，无需重启。

**光照调试**

- **限制光照范围**：拖一个框，光照只在该范围内渲染（按窗口比例计算，缩放不错位）；`Ctrl+Shift+B` 可开关
- **导出光照报告**：把光照命中清单 + 当前范围写入控制台
- **光照调试总开关**：关闭后不挂任何事件，完全不影响正常使用

## 已知限制

- **选择器会随 QQ 版本漂移**。实测于 **QQ NT 9.9.33-52230 + LiteLoaderQQNT 5.2.1**（2026-10）；换版本后若样式不生效，请按下方「实测要点」重新确认选择器。
- **浅色 / 暗色主题均支持**：CSS 作用域已从 `body.q-theme-tokens-light` 改为 `body:is(.q-theme-tokens-light, .q-theme-tokens-dark)`。**新增 CSS 规则时务必沿用 `:is(...)` 写法**，只写 `light` 会导致暗色主题下整条规则失效。
- **QQ 原生 shell 无法覆盖**：内置浏览器、原生菜单等由 `QQNT.dll` 绘制，CSS/JS 触及不到。
- **平台**：仅 `win32`（实测环境），未在其他平台验证。
- **光照范围限制不落盘**：`uClip` 只在当前窗口会话内有效，重启/刷新后回到全窗口 —— 它是有意的排查工具，不是常态设置。
- **光照强度为 0 时画布仍在**（只画出全透明结果），不释放 GPU 资源。
- **GPU 光源目标有限**：`TARGET_SEL` 默认只覆盖 `.recent-contact-item` 与 `.nav-item`；`.func-menu__item` 圆角为 `0px`，参与光照会画出方框，故已排除。
- **`DPR` 上限 2**：4K + 200% 缩放时画布会很大，如遇显存压力需降低 `DPR_CAP`。

## 实测要点

以下均在 QQ NT 9.9.33-52230 + LiteLoaderQQNT 5.2.1 + Chromium 144 + Windows 上实测。

### 主题令牌

| 事实 | 值 |
|---|---|
| 令牌挂载点 | `body.q-theme-tokens-light`（暗色为同级 `i.q-theme-tokens-dark`），**不是** `documentElement` |
| 令牌总数 | 388 ~ 429 |
| 派生令牌行为 | `--nt_*` 是**预计算字面色值**，改 `--brand_standard` 后 **25 个**蓝色系令牌仍是旧值 → 出现两套蓝 |
| 解法 | `color-mix(in srgb, var(--lg-accent) N%, transparent)` 从唯一真源推导；Chromium 144 支持 |
| 校验 | 派生令牌 32/32 补齐；全界面 637 个元素扫描 0 处旧色残留 |

### 跨窗口（最大的坑）

| 事实 | 值 |
|---|---|
| 窗口隔离 | 每个窗口是**独立 JS 上下文**（主界面 `webcontentsid=2`、设置页 `=6`） |
| 症状 | 设置页改完**主界面不生效**，重启 QQ 才生效（磁盘写入一直是对的） |
| 原因 | `window.dispatchEvent` **跨不过窗口边界** |
| 解法 | `localStorage` 的 `storage` 事件（原生跨窗口，实测可用）；注意它**不在写入者自己的窗口触发**，本窗口另走 CustomEvent |
| 验证 | 主窗口写入后，其余 3 个窗口均收到通知 |

### 开关组件

| 事实 | 值 |
|---|---|
| 外观驱动 | class **`is-active`**，**不是** `aria-checked` |
| 踩坑 | 只改 `aria-checked`：状态值正确但外观永远是关的 → 用户以为「开关点不动」 |
| 开启态实测 | 轨道 `rgb(40,117,237)`、手柄 `translate 12px` |

### 音量

`AudioContext` 的 `master.gain.value` 只在创建时设一次；之后改 `volume` 字段**不影响声音**。必须用 getter/setter 同步到音频节点，否则音量滑杆「没反应」。

### 滚动边界

| 事实 | 值 |
|---|---|
| 滚动容器 `overflowY` | **`overlay`**（不是 `auto`/`scroll`） |
| 消息列表 | **虚拟列表**：`scrollHeight` 是伪造的 `300000`，`clientHeight` 仅 `322` |
| 后果 | `scrollHeight - clientHeight - scrollTop ≈ 0` 判断「到底」**永远失败** |
| 解法 | 行为判据：滚轮触发但 `scrollTop` 未变化 → 已在边界 |

### 原生窗口拖动

| 事实 | 值 |
|---|---|
| `app-region: drag` 区域 | 顶栏 1061×40、左侧竖条 52×581 |
| 指针事件 | **收不到**（pointerdown/move/up 全为 0） |
| 渲染进程 | **仍在正常运行**：12 秒 239 次心跳、最长卡顿 0ms、窗口位移 214px 被正确读到 |
| 结论 | 不可拦截，但**可观察** → 轮询 `window.screenX/screenY` 反推速度做拖动音效 |

### 动效

| 事实 | 值 |
|---|---|
| 弹簧过冲 | `cubic-bezier(.2,.9,.25,1.22)`：scale 0.94 → 峰值 1.004 → 1.000（过冲 0.4%） |
| 用独立属性 | 用 `scale`/`translate` 而非 `transform` 简写（QQ 浮层可能用 transform 做居中） |
| 发送按钮结构 | **不是 `<button>`**，是 div 组合；最外层 `.send-btn-wrap` 才画蓝色背景（`rgb(40,117,237)`、94×32），内层 `.send`/`.send-msg` 只有文字 |
| 危险写法 | 覆盖**全站 `button`** 的规则会让「点头像开资料卡」时界面卡死 —— 必须限定在明确容器内 |

### 性能

| 指标 | 实测 |
|---|---|
| 动效层开销 | **0.5ms**（A/B：2.1ms vs 1.6ms，1300+ 元素） |
| 全量样式遍历 | 1691 元素 7.7ms |
| 皮肤层规模 | 95 张样式表 / 7570 条规则 |
| GPU 光源 CPU 每帧开销 | ≈ **0ms**（测不出；单次 `drawArrays` 画 20~24 个控件） |
| 几何重建频率 | 700ms 一次 + scroll/resize 事件 |
| 对比 CSS 阴影方案 | 后者 **~20fps**（27 控件 × 5~6 层模糊阴影 = 每帧 160+ 层光栅化） |

> GPU 光源的完整实现说明、着色器数学与踩坑清单见 [`docs/GPU-LIGHT.md`](docs/GPU-LIGHT.md)。

## 结构

| 文件 | 作用 |
|---|---|
| `manifest.json` | LiteLoader manifest v4（`type: theme`，仅注入 renderer） |
| `renderer.js` | 读取并注入两个 CSS 层；挂设置页钩子；按窗口启动 GPU 光源 |
| `lens-skin.css` | 令牌层：QQ 原生令牌 → Lens，含派生色 `color-mix` 补全 + 玻璃面板变量 |
| `lens-motion.css` | 动效层：静态元素的被动 `transition` |
| `lens-light.js` | **GPU 光源**：WebGL2 全窗口画布，逐像素边缘光 |
| `lens-sound.js` | 音频引擎：PCM 合成 + 摩擦纹理（移植自 Lens `sound.js`） |
| `lens-sound-bind.js` | 事件绑定：点击 / 悬浮 / 拖拽 / 滚轮 / 窗口拖动 |
| `lens-settings.js` | 设置页 + 配置持久化 + 跨窗口广播 |
| `lens-debug.js` | 光照调试：拖框限制渲染范围 + 导出报告 |
| `lens-sound.check.mjs` | 音效自检脚本（开发用，不随 Release 分发） |
| `docs/GPU-LIGHT.md` | GPU 光源开发文档（开发用，不随 Release 分发） |
| `icon.png` | 插件图标 |

## 许可

[MIT](LICENSE)。

设计令牌、弹簧曲线常数与音频合成算法源自 [ruiqichenbiec/design-systems](https://github.com/ruiqichenbiec/design-systems)（MIT © 2026 DayDreamInAReverie）。本源代码为独立实现。

## 免责声明

本插件仅用于**软件架构与 JavaScript 注入技术的教育 / 研究**。使用即表示你接受：不违反软件保护法规，不逆向、修改或分发腾讯 QQ 的修改版；不侵害腾讯的权利（含著作权与技术保护措施）；**非商业用途**；确保你自己的 QQ 使用是**被合法授权**的。作者不对滥用及其后果负责，**风险全部由你承担**。

在中国大陆，下列行为可能构成犯罪：①提供侵入 / 非法控制计算机信息系统的程序或工具（刑法第 285 条第 3 款）；②侵犯著作权（含规避技术措施，第 217 条）；③破坏计算机信息系统（第 286 条）。

本插件不修改 QQ 的任何文件；它通过 LiteLoaderQQNT 在运行时注入样式与脚本，删除插件目录即可完全移除。
