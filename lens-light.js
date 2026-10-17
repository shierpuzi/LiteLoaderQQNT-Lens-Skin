/**
 * Lens 光源 — GPU 渲染的全局光源
 *
 * 参考 Lens 原件（lens/lab/design-system/internal/renderer.js）的着色器:
 *   vec2 light = normalize(uPointer - center + vec2(-80.,150.) * uScale);
 *   float directional = pow(max(dot(n2, light), 0.), 7.);
 *   float opposite    = pow(max(dot(n2, -light), 0.), 7.) * .52;
 *   float outline     = 1. - smoothstep(.12*uScale, 1.1*uScale, abs(d + .65*uScale));
 *   float edgeLight   = (directional + opposite) * pow(edge, 4.);
 *   float glint       = exp(-length((vPixel - uPointer) / vec2(180.,150.)) * 2.);
 *
 * ===== 为什么用 WebGL 而不是 CSS box-shadow =====
 * 上一版（v0.7.0）只用 CSS 给【鼠标指向的那一个】控件加光影，其它控件不联动；
 * 试过给所有控件都加 CSS 阴影的方案，但实测 27 个控件 × 5~6 层模糊阴影
 * = 每帧 160+ 层光栅化，掉到约 20fps。
 *
 * 本版把光照改成一个覆盖全窗口的 WebGL 画布：
 *   - 一次 draw call 画出所有控件的边缘光（实例化，无逐元素 DOM 操作）
 *   - 每个控件的边缘用 SDF 求法线，再套用与 Lens 相同的 directional/opposite 公式
 *   - 光从鼠标位置发出，所有控件按自身相对光源的方向同时受光 → 真正的联动
 *   - 实测 QQ 渲染进程是硬件加速的 WebGL2
 *     （ANGLE / NVIDIA RTX 3070 Ti / D3D11），一次绘制 CPU 开销低到测不出
 *
 * ===== 实测过的约束 =====
 * 1. 画布 pointer-events: none，否则会吞掉 QQ 全部点击（老坑，见 qqnt-plugin-debug）。
 * 2. 不用 requestAnimationFrame 依赖合成器时序；用时间节流 + 定时器补写。
 * 3. 只重建几何（getBoundingClientRect）在【滚动/尺寸变化/定时刷新】时批量做一次，
 *    不是每次 pointermove 都读 —— 那会强制同步布局。
 * 4. 视口外的控件不登记（虚拟列表里大量元素在视口外，画了也看不见）。
 */

/*
 * 光照目标。
 *
 * 不含 .func-menu__item（左下角邮箱/手机/更多）：它的真实圆角是 0px，
 * 与其它控件的 14px 不同；统一处理会在那里画出方框状光带与描边，
 * 用户明确要求去掉左下角那个矩形。故该控件不再参与光照。
 */
const TARGET_SEL = ".recent-contact-item, .nav-item";
const DPR_CAP = 2;          // 设备像素比上限，避免 4K 屏下纹理过大
const MARGIN = 7;           // 几何外扩：给边缘光晕留绘制空间（绝不参与 SDF 尺寸）
const RIM_BAND = 2.6;       // 边缘光带宽（px）
const WRITE_MS = 16;        // 写入节流 ≈60fps
const REBUILD_MS = 700;     // 几何缓存刷新间隔（滚动/布局变化兜底）

/*
 * 目标矩形的合理性上限。我们的目标都是小控件
 * （联系人行约 304x72、导航项 36x36、功能项 44x34），
 * 超过这个尺寸必然是误命中的容器/占位元素 —— 必须丢弃，
 * 否则会生成巨型四边形把 GPU 拖死（群成员列表末项卡死的元凶）。
 */
const MAX_TARGET = 2000;    // px，单边上限
const MAX_QUADS = 300;      // 兜底：一次性参与绘制的四边形数量上限

/*
 * 诊断：记录被丢弃的异常目标（每个元素只报一次，避免刷屏）。
 * 用于在真实客户端里确认 QQ 的 DOM 是否真的存在超大/NaN 矩形。
 */
const badReported = new WeakSet();
function reportBad(el, rect, reason) {
    if (badReported.has(el)) return;
    badReported.add(el);
    console.warn("[lens-skin] 丢弃异常光照目标:", {
        reason,
        cls: String(el.className).slice(0, 60),
        w: rect.width, h: rect.height, top: rect.top, left: rect.left,
    });
}

const VS = `#version 300 es
precision highp float;
in vec2 aPos;
in vec4 aRect;              // xy=中心, zw=半宽半高
in float aCorner;           // 该控件自己的圆角半径（每个控件不同，见 rebuild）
uniform vec2 uRes;
out vec2 vPos;
out vec4 vRect;
out float vCorner;
void main() {
  vPos = aPos;
  vRect = aRect;
  vCorner = aCorner;
  vec2 clip = (aPos / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vPos;
in vec4 vRect;
in float vCorner;
uniform vec2 uRes;
uniform vec2 uPointer;
uniform float uStrength;
uniform float uBand;
/*
 * 调试用渲染范围（归一化 0..1，xy=左上，zw=右下）。
 * 默认 (0,0,1,1) 即全窗口、无裁剪。
 * 用【归一化】而不是像素：窗口缩放时比例不变，不会出现绘制错位
 * （这是调试工具的要求 —— 用户拉一个框，只在该范围内渲染光照）。
 */
uniform vec4 uClip;
out vec4 outColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
vec2 sdfNormal(vec2 p, vec2 b, float r) {
  float e = 0.75;
  float dx = sdRoundBox(p + vec2(e, 0.0), b, r) - sdRoundBox(p - vec2(e, 0.0), b, r);
  float dy = sdRoundBox(p + vec2(0.0, e), b, r) - sdRoundBox(p - vec2(0.0, e), b, r);
  return normalize(vec2(dx, dy) + 1e-6);
}

void main() {
  /* 渲染范围裁剪：归一化比较，随窗口缩放自动保持比例 */
  vec2 uv = vPos / uRes;
  if (uv.x < uClip.x || uv.x > uClip.z || uv.y < uClip.y || uv.y > uClip.w) {
    outColor = vec4(0.0);
    return;
  }

  vec2 center = vRect.xy;
  vec2 b = vRect.zw;
  vec2 p = vPos - center;
  float d = sdRoundBox(p, b, vCorner);

  float rim = 1.0 - smoothstep(0.0, uBand, abs(d));
  rim = pow(rim, 1.6);
  if (rim < 0.002) { outColor = vec4(0.0); return; }

  vec2 n2 = sdfNormal(p, b, vCorner);
  vec2 light = normalize(uPointer - center + vec2(-80.0, 150.0));
  float directional = pow(max(dot(n2, light), 0.0), 7.0);
  float opposite    = pow(max(dot(n2, -light), 0.0), 7.0) * 0.52;

  /*
   * 只保留"边缘光晕 + 方向性明暗"。
   * 早期版本这里还有一条 outline 亮线（Lens 原件里的 1px 轮廓），
   * 但 DOM 侧 CSS 已经给控件画了 1px 内描边边界，
   * 两条线叠在同一个位置 = 看起来"多了一个边框"，实测被用户指为多余，故删除。
   */
  float spec = (directional + opposite) * rim * 0.85 + 0.04;
  spec *= uStrength;

  float glint = exp(-length(vPos - uPointer) / 170.0 * 2.0) * 0.10 * uStrength;
  float shade = pow(max(dot(n2, -light), 0.0), 5.0) * rim * 0.16 * uStrength;

  float a = clamp((spec + glint + shade) * rim, 0.0, 1.0);
  vec3 col = mix(vec3(1.0), vec3(0.86, 0.93, 1.0), 0.25);
  outColor = vec4(col * a, a);
}`;

let state = null;

function lightStrength() {
    const raw = document.body.style.getPropertyValue("--lg-light");
    if (!raw) return 1;                       // 未设置 = CSS 默认值（1）
    const v = parseFloat(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(log || "shader compile failed");
    }
    return s;
}

export function startGpuLight() {
    if (state || window.__lensGpuLightOn || window.__lensGpuPending) return;
    if (!document.body) return;

    /*
     * 只在【真正承载 UI 的窗口】里创建 WebGL 上下文。
     * 实测：QQ 会给隐藏窗口、会话池窗口、空白窗口都注入 renderer，
     * 在这些窗口里各建一块全屏 WebGL 画布纯属浪费 GPU ——
     * 多块全屏透明层叠加足以把合成器拖垮（本轮 QQ 卡死的教训之一）。
     * 注入时 DOM 可能还没就绪，所以有限次重试；一直等不到目标就永不创建。
     */
    window.__lensGpuPending = true;
    let tries = 0;
    const wait = setInterval(() => {
        tries++;
        const ready = !!document.querySelector(TARGET_SEL);
        if (!ready && tries <= 60) return;          // 最多等约 12 秒
        clearInterval(wait);
        window.__lensGpuPending = false;
        if (ready) create();
    }, 200);
}

function create() {
    const DPR = Math.min(globalThis.devicePixelRatio || 1, DPR_CAP);
    const canvas = document.createElement("canvas");
    // pointer-events: none 是关键 —— 否则整块画布会吞掉 QQ 的所有点击
    Object.assign(canvas.style, {
        position: "fixed", inset: "0",
        width: "100%", height: "100%",
        pointerEvents: "none",
        zIndex: "2147483000",
    });
    canvas.setAttribute("aria-hidden", "true");
    canvas.width = Math.max(1, Math.round(innerWidth * DPR));
    canvas.height = Math.max(1, Math.round(innerHeight * DPR));

    const gl = canvas.getContext("webgl2", {
        alpha: true, premultipliedAlpha: true, antialias: false,
        depth: false, stencil: false, powerPreference: "high-performance",
    });
    if (!gl) { console.warn("[lens-skin] WebGL2 不可用，跳过 GPU 光源"); return; }

    let prog;
    try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(prog) || "program link failed");
        }
    } catch (e) {
        console.error("[lens-skin] GPU 光源着色器失败:", e);
        try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { }
        return;
    }

    document.body.appendChild(canvas);
    window.__lensGpuLightOn = true;

    const aPos = gl.getAttribLocation(prog, "aPos");
    const aRect = gl.getAttribLocation(prog, "aRect");
    const aCorner = gl.getAttribLocation(prog, "aCorner");
    const uRes = gl.getUniformLocation(prog, "uRes");
    const uPointer = gl.getUniformLocation(prog, "uPointer");
    const uStrength = gl.getUniformLocation(prog, "uStrength");
    const uBand = gl.getUniformLocation(prog, "uBand");
    const uClip = gl.getUniformLocation(prog, "uClip");

    const STRIDE = 28;      // aPos(2) + aRect(4) + aCorner(1) = 7 float
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(aRect);
    gl.vertexAttribPointer(aRect, 4, gl.FLOAT, false, STRIDE, 8);
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 1, gl.FLOAT, false, STRIDE, 24);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const pointer = { x: innerWidth * 0.35, y: innerHeight * 0.3 };
    let verts = null;
    let quadCount = 0;
    let lastWrite = 0;
    let pending = 0;
    let rebuildTimer = 0;
    let lastRebuild = 0;

    /*
     * 重建几何。批量读取 rect（一次布局），且跳过视口外的元素：
     * 实测列表里 20+ 个目标有相当一部分在视口外（虚拟列表），
     * 给它们建几何纯属浪费顶点与绘制。
     *
     * ===== 必须做尺寸/有效性过滤（实测卡死教训）=====
     * 现象：群成员列表滑到【最后一项】时，整个窗口必然卡死（成员少时一打开就卡）。
     * 原因：早期版本只过滤了"最小值"（width/height < 10），没有上限、也没查 NaN。
     *   一个异常大的矩形（虚拟列表的占位/末项容器）会生成一个巨大的四边形，
     *   片元着色器要光栅化海量像素 → GPU 卡住 → 整个窗口失去响应。
     *   NaN 更糟：顶点位置成 NaN 后光栅化行为未定义，同样可能挂死。
     * 我们的目标都是小控件（联系人行约 304x72，导航项 36x36），
     * 所以超过 MAX_TARGET 的矩形一定是误命中，直接丢弃。
     */
    function rebuild() {
        const top = -200, bottom = innerHeight + 200;
        const rects = [];
        const seen = document.querySelectorAll(TARGET_SEL);
        for (const el of seen) {
            const r = el.getBoundingClientRect();
            // 有效性：NaN / Infinity 一律丢弃
            if (!Number.isFinite(r.left) || !Number.isFinite(r.top) ||
                !Number.isFinite(r.width) || !Number.isFinite(r.height)) {
                reportBad(el, r, "not-finite");
                continue;
            }
            if (r.width < 10 || r.height < 10) continue;
            // 上限：误命中的超大元素会撑出巨型四边形把 GPU 拖死
            if (r.width > MAX_TARGET || r.height > MAX_TARGET) {
                reportBad(el, r, "oversize");
                continue;
            }
            if (r.bottom < top || r.top > bottom) continue;

            /*
             * 不可见的元素不画 —— 尺寸过滤挡不住它。
             *
             * [实测] QQ 的虚拟列表（.viewport-list）在 .viewport-list__measure 里
             * 放了一份【测量副本】：它是 visibility:hidden（仍占位、矩形非零），
             * 却带着同一个 .recent-contact-item 类，宽度还是整行宽。
             * 实测副本 1029x72 @ (56,92)，而真实行是 304x72 @ (64,100)。
             * 结果就是主界面上凭空多出一个与真实行等高的巨型圆角光框。
             * 它宽度 1029 < MAX_TARGET，所以尺寸上限永远拦不住 —— 必须按可见性过滤。
             *
             * 只读自己的 visibility：父级隐藏而自己 visibility:visible 的元素确实可见；
             * display:none 的矩形本来就是 0，已被上面的最小尺寸挡掉。
             */
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden") continue;

            /*
             * 读取该元素【自己的】圆角。
             * getComputedStyle 会强制样式解析，所以只在 rebuild 里做一次
             * （不是每次 pointermove），成本可接受。
             * 取左上角的值：我们的目标都是四角一致的控件。
             */
            const corner = parseFloat(cs.borderTopLeftRadius) || 0;

            rects.push({
                left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                width: r.width, height: r.height, corner,
            });
            if (rects.length >= MAX_QUADS) break;      // 兜底：绝不让顶点数失控
        }
        quadCount = rects.length;
        const need = Math.max(6, quadCount * 6);
        if (!verts || verts.length < need * 7) verts = new Float32Array(need * 7);
        let i = 0;
        const push = (x, y, cx, cy, hw, hh, cr) => {
            verts[i++] = x; verts[i++] = y;
            verts[i++] = cx; verts[i++] = cy; verts[i++] = hw; verts[i++] = hh;
            verts[i++] = cr;
        };
        for (const r of rects) {
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            /*
             * 【关键】SDF 的盒子必须是控件的【真实】半宽高。
             * 早期版本写成 r.width/2 + MARGIN，导致发光的圆角矩形整体外移 MARGIN(7px)，
             * 表现就是"发光框浮在控件外面、控件看起来大了一圈"。
             * MARGIN 只用于外扩四边形顶点（给边缘光晕留绘制空间），绝不能用进 SDF。
             */
            const hw = r.width / 2, hh = r.height / 2;

            /*
             * 【关键】圆角必须用【该元素自己的值】。
             * 早期版本对所有控件固定用 14px，但 .func-menu__item 的真实圆角是 0px，
             * 于是给它画了个 14px 圆角的光带 —— 与元素形状不符，
             * 看起来就是一个悬空的方框（用户截图里左下角那个）。
             * 同时夹到半宽高的一半以内：sdRoundBox 要求 r 不超过短边，
             * 否则 q 会变成负值、SDF 退化（36x36 的导航项尤其明显）。
             */
            const cr = Math.max(0, Math.min(r.corner, Math.min(hw, hh)));
            const x0 = r.left - MARGIN, y0 = r.top - MARGIN;
            const x1 = r.right + MARGIN, y1 = r.bottom + MARGIN;
            push(x0, y0, cx, cy, hw, hh, cr); push(x1, y0, cx, cy, hw, hh, cr); push(x1, y1, cx, cy, hw, hh, cr);
            push(x0, y0, cx, cy, hw, hh, cr); push(x1, y1, cx, cy, hw, hh, cr); push(x0, y1, cx, cy, hw, hh, cr);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, i), gl.DYNAMIC_DRAW);
        lastRebuild = performance.now();
    }

    function draw() {
        // 窗口不可见时画了也没人看，直接跳过省 GPU
        if (document.hidden) return;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!quadCount) return;
        gl.useProgram(prog);
        gl.uniform2f(uRes, innerWidth, innerHeight);
        gl.uniform2f(uPointer, pointer.x, pointer.y);
        gl.uniform1f(uStrength, lightStrength());
        gl.uniform1f(uBand, RIM_BAND);
        // 渲染范围：默认全窗口；调试模式下由调试面板写入归一化矩形
        const clip = state?.clip ?? { x: 0, y: 0, z: 1, w: 1 };
        gl.uniform4f(uClip, clip.x, clip.y, clip.z, clip.w);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.drawArrays(gl.TRIANGLES, 0, quadCount * 6);
    }

    /* 光照为 0 时整块画布透明即可 —— 仍然保留，避免后续开灯要重建上下文 */
    function onMove(event) {
        if (lightStrength() === 0) return;
        pointer.x = event.clientX;
        pointer.y = event.clientY;

        // 时间节流；窗口内的事件不丢弃，记下最后坐标等窗口结束补写
        const now = performance.now();
        if (now - lastWrite >= WRITE_MS) {
            lastWrite = now;
            if (now - lastRebuild > REBUILD_MS) rebuild();   // 几何兜底刷新
            draw();
            return;
        }
        if (!pending) {
            pending = setTimeout(() => {
                pending = 0;
                lastWrite = performance.now();
                if (performance.now() - lastRebuild > REBUILD_MS) rebuild();
                draw();
            }, WRITE_MS);
        }
    }

    const onLayoutChange = () => {
        rebuild();
        if (lightStrength() !== 0) draw();
    };

    document.addEventListener("pointermove", onMove, { capture: true, passive: true });
    window.addEventListener("scroll", onLayoutChange, { capture: true, passive: true });
    window.addEventListener("resize", () => {
        canvas.width = Math.max(1, Math.round(innerWidth * DPR));
        canvas.height = Math.max(1, Math.round(innerHeight * DPR));
        onLayoutChange();
    }, { passive: true });

    // 周期刷新几何：QQ 会自己重排（新消息、切换会话），不能只靠 scroll 事件。
    // 窗口不可见时整轮跳过，别做无用的布局读取与绘制。
    rebuildTimer = setInterval(() => {
        if (document.hidden) return;
        rebuild();
        if (lightStrength() !== 0) draw();
    }, REBUILD_MS);

    rebuild();
    draw();

    state = {
        canvas, gl, prog,
        // 渲染范围（归一化 0..1）：默认全窗口。调试面板通过 setLightClip 修改。
        clip: { x: 0, y: 0, z: 1, w: 1 },
        // 设置变化时立即重画：光照归零时 draw() 内部会因 quadCount 正常但 strength=0
        // 而画出全透明结果，所以直接重画即可
        redraw: () => { rebuild(); draw(); },
        /** 当前参与绘制的控件清单（调试面板用来显示"光照命中了哪些元素"） */
        listTargets: () => [...document.querySelectorAll(TARGET_SEL)]
            .map((el) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return {
                    el,
                    cls: String(el.className),
                    tag: el.tagName,
                    rect: { w: Math.round(r.width), h: Math.round(r.height),
                            left: Math.round(r.left), top: Math.round(r.top) },
                    radius: parseFloat(cs.borderTopLeftRadius) || 0,
                    // 是否会真正参与绘制（与 rebuild 的过滤条件一致）
                    eligible: Number.isFinite(r.left) && Number.isFinite(r.top) &&
                              r.width >= 10 && r.height >= 10 &&
                              r.width <= MAX_TARGET && r.height <= MAX_TARGET &&
                              cs.visibility !== "hidden",
                };
            }),
        stop() {
            clearInterval(rebuildTimer);
            if (pending) clearTimeout(pending);
            document.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("scroll", onLayoutChange, true);
            try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { }
            canvas.remove();
            state = null;
            window.__lensGpuLightOn = false;
            window.__lensGpuLight = null;
        },
    };

    // 暴露给调试面板使用（只读/受控入口，不改变正常渲染路径）
    window.__lensGpuLight = state;
}

/** 设置变化后立即重画（不必等下一次鼠标移动） */
export function refreshGpuLight() {
    if (!state) return;
    state.redraw();
}

/**
 * 限制光照的渲染范围（调试用）。
 * @param {{x:number,y:number,z:number,w:number}|null} rect
 *        归一化 0..1（xy=左上，zw=右下）；传 null 或全窗口值即取消限制。
 *        用归一化而非像素：窗口缩放时比例不变，不会出现绘制错位。
 */
export function setLightClip(rect) {
    if (!state) return false;
    state.clip = rect
        ? {
            x: Math.max(0, Math.min(1, rect.x)),
            y: Math.max(0, Math.min(1, rect.y)),
            z: Math.max(0, Math.min(1, rect.z)),
            w: Math.max(0, Math.min(1, rect.w)),
        }
        : { x: 0, y: 0, z: 1, w: 1 };
    state.redraw();
    return true;
}

/** 读取当前渲染范围 */
export function getLightClip() {
    return state ? { ...state.clip } : null;
}
