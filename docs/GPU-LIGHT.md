# GPU 光源开发文档

> 目标读者：要在这个插件里继续改光照渲染的人（包括未来的我）。
> 所有带 `[实测]` 的结论都在 **QQ NT 9.9.33-52230 + LiteLoaderQQNT 5.2.1 + Windows + NVIDIA RTX 3070 Ti** 上亲测过。
> 换版本请按第 8 节的清单重验。

---

## 1. 为什么必须用 GPU 而不是 CSS

最初的光影是纯 CSS 做的，两个方案都失败：

| 方案 | 结果 |
|---|---|
| v0.7.0：只在 `:hover` 给控件加 `box-shadow` | 一次只有鼠标下**那一个**控件有光影，其它控件不联动 —— 用户否决 |
| 给**所有**控件都挂 CSS 阴影 | fork 的 v0.8.0 走过，其源码注释记录 **约 20fps**：27 个控件 × 5~6 层模糊阴影 = 每帧 160+ 层光栅化 |

`box-shadow` 走的是**绘制路径而非合成器**，层数一多必然崩。CSS 也无法做逐像素的方向光计算。

**结论：光照改成一张覆盖全窗口的 WebGL2 画布，一次 draw call 画出所有控件。**

- 实测 QQ 渲染进程是**真硬件加速**：`ANGLE (NVIDIA GeForce RTX 3070 Ti, D3D11)`，`MAX_TEXTURE_SIZE=16384`
- 实测一次绘制 CPU 开销**低到测不出**（`cpuMedianMs: 0`）

---

## 2. 整体结构

```
lens-light.js
├── TARGET_SEL        光照作用的控件选择器
├── 常量              MARGIN / RIM_BAND / WRITE_MS / REBUILD_MS / MAX_TARGET / MAX_QUADS
├── VS               顶点着色器：像素坐标 → clip space，透传 rect 与圆角
├── FS               片元着色器：SDF 圆角矩形 + 边缘光
├── startGpuLight()  入口（renderer.js 调用）
│   ├── 等待 UI 就绪（有限次重试），只在承载 UI 的窗口创建上下文
│   ├── create()     建画布 / 编译着色器 / 建 VBO
│   ├── rebuild()    批量读 rect + 圆角 → 组装顶点
│   ├── draw()       一次 drawArrays 画全部控件
│   └── 事件           pointermove（节流）/ scroll / resize / 定时刷新
└── refreshGpuLight() 设置变更后立即重画
```

**渲染模型**：光源 = 鼠标位置，全局唯一。每个控件在片元着色器里按**自身相对光源的方向**取光，所以所有控件同时受光、按距离衰减 → 这就是"整块玻璃板被一束光照射"的联动感。

---

## 3. 着色器数学

### 3.1 圆角矩形 SDF

```glsl
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
```

- `p` 是相对控件中心的像素偏移，`b` 是**真实半宽高**，`r` 是该控件**自己的圆角**
- `d < 0` 在内部，`d ≈ 0` 落在边缘，`d > 0` 在外部

### 3.2 法线（用于方向光）

```glsl
vec2 sdfNormal(vec2 p, vec2 b, float r) {
  float e = 0.75;                        // 采样步长，够小即可
  float dx = sdRoundBox(p + vec2(e,0), b, r) - sdRoundBox(p - vec2(e,0), b, r);
  float dy = sdRoundBox(p + vec2(0,e), b, r) - sdRoundBox(p - vec2(0,e), b, r);
  return normalize(vec2(dx, dy) + 1e-6); // 加 ε 防零向量
}
```

### 3.3 光照（逐字照搬 Lens 原件 `internal/renderer.js`）

```glsl
vec2 light = normalize(uPointer - center + vec2(-80.0, 150.0));
float directional = pow(max(dot(n2, light), 0.0), 7.0);          // 迎光边
float opposite    = pow(max(dot(n2, -light), 0.0), 7.0) * 0.52;  // 背光边，权重更低
float glint = exp(-length(vPos - uPointer) / 170.0 * 2.0);       // 跟随指针的高光
```

- `vec2(-80, 150)` 是**固定偏置**：让光默认来自左上，视觉更自然
- 指数 `7.0` 决定边缘光的**锐利程度**：越大越像硬边高光

### 3.4 合成

```glsl
float rim = 1.0 - smoothstep(0.0, uBand, abs(d));   // 边缘带
rim = pow(rim, 1.6);
if (rim < 0.002) { outColor = vec4(0.0); return; }  // 早退，省片元

float spec = (directional + opposite) * rim * 0.85 + 0.04;
spec *= uStrength;
float a = clamp((spec + glint + shade) * rim, 0.0, 1.0);
```

⚠️ **`outline` 亮线已被删除**。Lens 原件有一条 1px 轮廓线（`1 - smoothstep(0, 1.2, abs(d+0.65))`），但 DOM 侧 CSS 已经画了 1px 内描边，两条线叠一起 = 用户看到的"双边框"。别再加回来。

---

## 4. 顶点数据布局（改这里最容易出隐形 bug）

每个顶点 **7 个 float / 28 字节**：

| 属性 | 分量 | 偏移 | 含义 |
|---|---|---|---|
| `aPos` | 2 | 0 | 像素坐标 |
| `aRect` | 4 | 8 | `xy`=中心，`zw`=半宽半高 |
| `aCorner` | 1 | 24 | 该控件的圆角半径 |

```js
const STRIDE = 28;
gl.vertexAttribPointer(aPos,    2, gl.FLOAT, false, STRIDE, 0);
gl.vertexAttribPointer(aRect,   4, gl.FLOAT, false, STRIDE, 8);
gl.vertexAttribPointer(aCorner, 1, gl.FLOAT, false, STRIDE, 24);
```

**必须同步维护的三处**，漏一处不会报错、只会画错位：

1. 顶点属性偏移与 stride（上面）
2. 顶点数组长度：`new Float32Array(need * 7)`
3. `push()` 里写入的 float 个数（7 个）

每个控件 6 个顶点、两个三角形。

### 4.1 圆角必须逐元素读取

**[实测修过的 bug]** 早期版本对所有控件固定用 `uCorner = 14px`，但 `.func-menu__item` 的真实圆角是 `0px`，于是给它画出方框状光带 —— 用户截图指出左下角多了个矩形。

```js
const corner = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
// 夹到半宽高以内：sdRoundBox 要求 r 不超过短边，否则 SDF 退化
const cr = Math.max(0, Math.min(corner, Math.min(hw, hh)));
```

⚠️ 对 36×36 的导航项，`hh = 18`，若 `r = 14` 尚可；`r > 18` 会让 `abs(p) - b + r` 变成负值、SDF 行为异常。

### 4.2 SDF 尺寸 ≠ 外扩尺寸

**[实测修过的 bug]** 顶点要外扩 `MARGIN`（给光晕留绘制空间），但 **SDF 的 `b` 必须是真实半宽高**：

```js
const hw = r.width / 2, hh = r.height / 2;        // SDF 用这个
const x0 = r.left - MARGIN, y1 = r.bottom + MARGIN; // 顶点用这个
```

早期误写成 `r.width/2 + MARGIN`，导致发光框整体外移 7px、控件看起来大了一圈。

---

## 5. 必须守住的约束（每条都是踩过的坑）

### 5.1 `pointer-events: none` —— 最高优先级

```js
canvas.style.pointerEvents = "none";
```

否则**整块全屏画布会吞掉 QQ 的所有点击**。这类坑在 `qqnt-plugin-debug` 技能里也记录过（背景插件的 `<video>` 层曾让"更多"按钮要点三次）。

**验收方法**：`document.elementFromPoint()` 在控件中心必须返回控件本身，而不是 `canvas`。

### 5.2 只在实际承载 UI 的窗口创建上下文

腾讯会给**隐藏窗口、会话池窗口、空白窗口**都注入 renderer。在这些窗口各建一块全屏 WebGL 画布纯属浪费 GPU，多块全屏透明层叠加足以把合成器拖垮。

```js
// 有限次重试等 UI 出现，等不到就永不创建
const wait = setInterval(() => {
  if (document.querySelector(TARGET_SEL)) { clearInterval(wait); create(); }
  else if (++tries > 60) clearInterval(wait);
}, 200);
```

### 5.3 窗口不可见时跳过绘制

```js
if (document.hidden) return;
```

意义：省 GPU。**副作用**：最小化时画布内容为空白，用 `readPixels` 采样会全 0 —— 这是**预期行为，不是 bug**（我因此在排查时困惑过一轮）。

### 5.4 几何过滤必须做上下限

**[实测：群成员列表滑到最后一项时整个窗口卡死]**

原因：早期只过滤了最小值（`width/height < 10`），没有上限、也没查 `NaN`。一个异常大的矩形（虚拟列表占位/末项容器）会生成巨型四边形，片元着色器要光栅化海量像素 → GPU 卡住 → 窗口失去响应。`NaN` 更糟：顶点成 `NaN` 后光栅化行为未定义。

```js
if (!Number.isFinite(r.left) || !Number.isFinite(r.top) ||
    !Number.isFinite(r.width) || !Number.isFinite(r.height)) { continue; }
if (r.width < 10 || r.height < 10) continue;
if (r.width > MAX_TARGET || r.height > MAX_TARGET) continue;   // MAX_TARGET = 2000
if (rects.length >= MAX_QUADS) break;                          // MAX_QUADS = 300
```

### 5.4.1 还要过滤 `visibility: hidden`

**[实测：主界面上凭空多出一个 1086x84 的框]**

QQ 的虚拟列表（`.viewport-list`）会在 `.viewport-list__measure` 里放一份**测量副本**：它是
`visibility: hidden`（仍占位，`getBoundingClientRect()` 非零），却带着**同一个**
`.recent-contact-item` 类，而且宽度是**整行宽**。

| 元素 | 尺寸 | 位置 | visibility |
|---|---|---|---|
| 真实行 | 304×72 | (64, 100) | visible |
| 测量副本 | **1029×72** | (56, 92) | **hidden** |

1029 < `MAX_TARGET`(2000)，所以**尺寸上限永远拦不住它** —— 表现为一条与真实行等高的巨型圆角
光框，位置固定不变（测量容器不会滚动）。**尺寸过滤之外必须再过一道可见性**：

```js
const cs = getComputedStyle(el);
if (cs.visibility === "hidden") continue;
```

只读元素**自己的** `visibility`：父级隐藏而自身 `visibility: visible` 的元素确实可见；
`display: none` 的矩形本来就是 0，已被最小尺寸挡掉。

排查方法（只读探针，写进 `eval.txt`）：列出所有命中元素的 `w/h/left/top` 与 `getComputedStyle(el).visibility`，
宽度明显大于同级真实行、且 `visibility: hidden` 的那个就是测量副本。

### 5.5 不要依赖 `requestAnimationFrame`

**[实测]** QQ 里 rAF 回调**可能被丢弃**：同一轮测试中「事件已收到、`closest` 已命中、rAF 已调度」，但**回调从未执行**；而另一处自递归 rAF 却能跑 31 帧。

改用**时间节流 + 定时器补写**，行为可预期：

```js
if (now - lastWrite >= WRITE_MS) { lastWrite = now; draw(); }
else if (!pending) { pending = setTimeout(() => { pending = 0; draw(); }, WRITE_MS); }
```

节流窗口内的坐标**不能直接丢弃** —— 那会让快速移动时最后一帧写不进去、光影"粘"在旧位置。

### 5.6 不要把 `getBoundingClientRect` 放进 `pointermove`

每次读都会**强制同步布局**，QQ 这种大 DOM 应用会立刻卡。只在 `rebuild()` 里批量读，触发时机：`scroll` / `resize` / 定时（`REBUILD_MS = 700`）/ 光照设置变更。

### 5.7 视口外的控件不登记

虚拟列表里大量元素在视口外，画了也看不见：

```js
const top = -200, bottom = innerHeight + 200;   // 留 200px 余量
if (r.bottom < top || r.top > bottom) continue;
```

余量的作用：滚动时元素刚进入视口边缘就已登记，不必等到下一次 `rebuild`。

---

## 6. 性能预算（实测数据）

| 指标 | 实测值 |
|---|---|
| 渲染方式 | 单次 `drawArrays`，20~24 个控件 |
| CPU 每帧开销 | ≈ 0ms（测不出） |
| GPU | ANGLE / D3D11 硬件加速 |
| 几何重建频率 | 700ms 一次 + scroll/resize 事件 |

**对比 CSS 方案**：后者 20fps（每帧 160+ 层模糊阴影）。

要降开销，按优先级：① 减少 `TARGET_SEL` 覆盖的控件数 ② 加大 `REBUILD_MS` ③ 降低 `DPR_CAP`。

---

## 7. 调试方法

### 7.0 优先用可视化调试工具（别靠截图猜）

插件内置类 DevTools 的元素选择器，直接在界面上把出问题的元素点出来：

| 操作 | 效果 |
|---|---|
| `Ctrl+Shift+C` | 进入元素拾取模式（也可在设置页点「开始拾取」） |
| 鼠标划过控件 | 蓝框高亮 + 显示 `选择器 尺寸 r=圆角` |
| 点击 | 选中并输出类名/尺寸/圆角/背景/**样式来源规则**到控制台 |
| `Ctrl+Esc` | 退出（拾取 → 拖框 → 关工具，逐级退出） |
| 设置页「拖框限制」 | 拖一个矩形，**光照只在该范围内渲染**，便于判断"哪块该改" |
| 设置页「清除范围」 | 恢复全窗口渲染 |
| 设置页「导出到控制台」 | 输出选中元素 + 光照目标清单 + 当前范围（console 搜 `lens-debug`） |

**为什么用 `Ctrl+Esc` 而不是 `Esc`**：QQ 自己用 Esc 关窗口。占用它会与原生行为冲突——想退出调试反而把窗口关了。

渲染范围用**归一化 0..1**坐标（不是像素），窗口缩放时比例不变、不会错位。实测窗口 1061 与 2122 宽下同一比例都是 `0.5`。

**两个必须注意的实现点**（都在 `lens-debug.js`）：
1. 拾取/拖框时覆盖层临时 `pointer-events: auto` 才能收到事件，**用完必须恢复 `none`**，否则会吞掉 QQ 全部点击。
2. **拖完一个框自动退出拖框模式**。否则覆盖层持续吞点击，用户会发现界面突然点不动且不知原因。

`lens-debug.js` 工作在**主界面窗口**（设置页与主界面是独立 JS 上下文），设置页通过 localStorage 广播命令（与配置同步同一条 `storage` 通道）。

### 7.1 用 eval REPL 做像素级验证（工具覆盖不到时）

用 `qqnt-plugin-debug` 技能的 `eval.txt` REPL。**注意 eval 会在每个窗口同时执行**，探针必须自己过滤窗口，否则多窗口并发写会污染结论（我曾因此得出错误判断）。

⚠️ **窗口最小化时 `document.hidden === true`，`draw()` 会跳过，`readPixels` 全 0** —— 设计行为，不是 bug。像素级验证必须在窗口可见时做。

#### 7.1.1 确认画布存在且不吞点击

```js
(() => {
  const nav = document.querySelector(".sidebar__nav");
  if (!nav) return { skip: true };
  const c = [...document.querySelectorAll("canvas")].find(x => x.style.zIndex === "2147483000");
  const item = document.querySelector(".recent-contact-item");
  const r = item.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
  return {
    canvas: c ? c.width + "x" + c.height : null,
    pe: c ? getComputedStyle(c).pointerEvents : null,   // 必须是 "none"
    hitIsCanvas: top === c,                              // 必须是 false
    hidden: document.hidden,
    strength: document.body.style.getPropertyValue("--lg-light"),
  };
})()
```

### 7.2 读取画布像素，确认真的画了东西

```js
(() => {
  const c = [...document.querySelectorAll("canvas")].find(x => x.style.zIndex === "2147483000");
  if (!c || document.hidden) return { skip: true, reason: "canvas missing or window hidden" };
  const gl = c.getContext("webgl2");
  const D = Math.min(devicePixelRatio || 1, 2);
  const item = document.querySelector(".recent-contact-item");
  const r = item.getBoundingClientRect();
  const cy = r.top + r.height / 2;
  const out = [];
  const buf = new Uint8Array(4);
  for (let dx = -10; dx <= 4; dx++) {
    gl.readPixels(
      Math.max(0, Math.min(c.width - 1, Math.round((r.left + dx) * D))),
      Math.max(0, Math.min(c.height - 1, c.height - 1 - Math.round(cy * D))),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf
    );
    out.push({ dx, a: buf[3] });
  }
  return { scan: out, peak: Math.max(...out.map(o => o.a)) };
})()
```

判读：光带**峰值应贴近 `dx = 0`（元素边缘）**；若峰值在 `dx ≈ -7`，说明 SDF 用了外扩尺寸（bug 4.2）。

### 7.3 验证联动（核心诉求）

在 A 点派发 `pointermove`，然后沿多个控件的边缘采样：**受光控件数应 ≥ 2 且亮度递减**。若只有鼠标下那一个亮，说明退回成了 CSS 单控件方案。

---

## 8. 换 QQ 版本后的重验清单

- [ ] `getContext("webgl2")` 是否仍返回非 null（否则整个光照静默失效）
- [ ] `MAX_TEXTURE_SIZE` 与硬件加速是否仍在（`WEBGL_debug_renderer_info`）
- [ ] `TARGET_SEL` 的类名是否仍存在：`.recent-contact-item` / `.nav-item`
- [ ] 各控件的 `borderTopLeftRadius` 实值（变了要确认第 4.1 节的夹取仍合理）
- [ ] 画布仍不吞点击（7.1 的 `hitIsCanvas === false`）
- [ ] `document.hidden` 语义未变
- [ ] 16:9 与高 DPI（`devicePixelRatio > 1`）下坐标换算正确

---

## 9. 待办 / 已知限制

1. **`.func-menu__item` 不在光照目标内**（左下角邮箱/手机/更多）。它的真实圆角是 `0px`，与其它控件的 `14px` 不同；统一处理会画出方框，用户明确要求去掉。**若要让它参与光照，必须先给它加圆角**（CSS 与 GPU 侧同步改）。
1.1 **隐藏的测量副本已过滤**（`.viewport-list__measure` 里的 `.recent-contact-item`）。见 5.4.1。
    若 QQ 改结构、方框再次出现，先按 5.4.1 的探针确认是哪个元素。
2. **主题作用域已修**：CSS 选择器从 `body.q-theme-tokens-light` 改为 `body:is(.q-theme-tokens-light, .q-theme-tokens-dark)`。**新增 CSS 规则时务必沿用 `:is(...)` 写法**，只写 `light` 会导致暗色主题下整条规则失效（这是曾经的真实 bug）。
3. **QQ 原生行背景未处理**：`.recent-contact-item--top .item__content` 用 `--overlay_top` 上色且无圆角（来源：QQ 自己的 `app://./renderer/css/52093.07732163.css`）。当前做法是给它补 `border-radius` 收边。若不想要这个背景，可把它设为透明 —— 改动很小，但属于**覆盖 QQ 原生样式**，需确认视觉副作用。
4. **光照强度 0 时画布仍在**（只是画出全透明结果）。若要在关闭时彻底释放 GPU 资源，可在 `lightStrength() === 0` 时调用 `stop()`，但重新开启需重建上下文（约几十毫秒）。
5. **DPR 上限 2**：4K + 200% 缩放时画布会很大。如遇显存压力，降低 `DPR_CAP`。
6. **渲染范围限制（`uClip`）只在当前窗口会话内有效**，不落盘：重启或刷新后回到全窗口。这是有意的 —— 它是排查工具，不是常态设置。
7. **`.item__content` 的圆角目前是写死的 `--lg-chrome`**。若 QQ 改了行背景的类名或结构，这条会失效（表现为方角再次露出）。用调试工具的「导出到控制台」能直接看到它当前的实际圆角。

---

## 10. 文件职责速查

| 文件 | 职责 |
|---|---|
| `lens-light.js` | **本文档主角**：GPU 光源 |
| `lens-skin.css` | 令牌映射 / 圆角 / 玻璃 / 固定边界（**不含**方向光） |
| `lens-motion.css` | 静态元素的被动 `transition` 弹性按压 |
| `lens-sound.js` | Web Audio 实时合成音效（无音频文件） |
| `lens-sound-bind.js` | 音效与 QQ 控件的事件绑定 |
| `lens-debug.js` | **调试工具**：元素选择器（Ctrl+Shift+C）+ 拖框限制渲染范围 + 导出报告 |
| `lens-settings.js` | 设置页 + 配置持久化 + **跨窗口同步**（`storage` 事件） |
| `renderer.js` | 入口：注入 CSS / 启动声音 / 启动光源 / 调试命令接收端 / 挂设置钩子 |

### 跨窗口注意事项

QQ 每个窗口是**独立 JS 上下文**（主界面 `webcontentsid=2`、设置页 `6`）。`window.dispatchEvent` **跨不过窗口边界**，必须用 `localStorage` 的 `storage` 事件（实测可用）。`storage` 事件**不会在写入者自己的窗口触发**，所以两个通道都要走。
