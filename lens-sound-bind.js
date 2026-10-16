/**
 * Lens 声音绑定 — 把 Lens 音频接到 QQ 控件
 *
 * 三条声音来源（均移植自 Lens 设计系统）:
 *   1. 发送按钮  → CUES.success  （Lens button variant:'success'，图一）
 *   2. 控件点击  → CUES.select   （Lens dock/segmented 的 data-lg-sound="select"，图二）
 *   3. 拖拽摩擦  → friction 循环 （Lens lg:gesture drag + synthesizeFriction，图三/四）
 *
 * 摩擦音的三个来源（这是本项目相对 Lens 的扩展）:
 *   a. 应用内拖拽：pointerdown/move 直接给速度（Lens 原始做法）
 *   b. 原生窗口拖动：app-region:drag 由操作系统处理，renderer 收不到 pointer 事件，
 *      但【实测渲染进程仍在运行】（12 秒 239 次心跳、0 卡顿），
 *      所以改用轮询 window.screenX/screenY 反推窗口移动速度。
 *   c. 滚轮滚动：内容持续位移，同样映射为摩擦音。
 *
 * 约束（沿用动效层的教训）:
 *   - 事件委托挂在 document，不用 getComputedStyle 做全量查询
 *   - 全部 { passive: true }，绝不 preventDefault
 *   - 音效只在真实用户手势后才会出声（AudioContext 需手势解锁）
 */

import { LensSound } from "./lens-sound.js";
import { loadConfig, onConfigBroadcast } from "./lens-settings.js";

const sound = new LensSound({ volume: .28, frictionGain: .32 });

/*
 * 设置项（存于 <profile>\data\lens-skin\config.json）
 * 三条声音来源各自独立开关；改设置后即时生效，无需重启。
 */
export const cfg = {
    clickSound: true,
    hoverSound: true,
    frictionSound: true,
    volume: .28,
    frictionGain: .32,
};

/** 应用一份配置到本窗口的声音层 */
function applyConfig(next) {
    Object.assign(cfg, next);
    sound.volume = cfg.volume;             // setter 会同步到音频图
    sound.frictionGain = cfg.frictionGain;
    if (!cfg.frictionSound) sound.endFriction(true);
}

loadConfig().then((saved) => {
    applyConfig(saved);
    console.log("[lens-skin] 设置已应用:", JSON.stringify(cfg));
}).catch(() => { });

/*
 * 接收其他窗口（设置页）的配置变更。
 * 关键：设置页与主界面是【不同的渲染进程】，window.dispatchEvent 跨不过去，
 *       必须用 localStorage 的 storage 事件（浏览器原生跨窗口机制，实测可用）。
 */
onConfigBroadcast((next) => {
    applyConfig(next);
    console.log("[lens-skin] 收到跨窗口设置变更:", JSON.stringify(cfg));
});

// 同窗口内改设置（例如设置页自己也挂了声音层）仍走本地事件
window.addEventListener("lens:config-changed", (event) => {
    applyConfig(event.detail || {});
});

/*
 * 可调参数（滚轮摩擦），两项独立，便于按听感取舍：
 *   wheelHold   停手后摩擦音的"余韵"时长（ms）。调大 = 连续滚动时不反复重启，
 *               声音更连贯（少一些每次重启的起音感），这是滚轮的"冷却"。
 *   wheelScale  滚轮摩擦相对响度（1 = 与拖拽一致）。滚轮比拖拽轻一些。
 * 运行时可通过 window.__lensTune 直接改，便于现场对比。
 */
const TUNE = window.__lensTune = {
    wheelHold: 400,      // 原 140：明显加长，减少重启
    wheelScale: 0.6,     // 原 1：响度降低
};
const WHEEL_HOLD = () => TUNE.wheelHold;
const WHEEL_SCALE = () => TUNE.wheelScale;

/* ---------- 1. 点击音效（事件委托） ---------- */

const CLICK_MAP = [
    { sel: ".send-btn-wrap", cue: "success" },      // 图一：发送
    { sel: ".nav-item", cue: "select" },            // 图二：左侧那排小按钮
    { sel: ".func-menu__item", cue: "select" },
    { sel: ".tab-item", cue: "select" },
    { sel: ".recent-contact-item", cue: "select" }, // 点会话
];

document.addEventListener("click", (event) => {
    if (!cfg.clickSound) return;
    for (const { sel, cue } of CLICK_MAP) {
        const el = event.target.closest && event.target.closest(sel);
        if (!el) continue;
        if (/disabled/.test(el.className)) return;  // 禁用态不响
        sound.play(cue);
        return;
    }
}, { capture: true, passive: true });

/* ---------- 1b. 悬浮音效（图二 dock 的手感） ---------- */
/*
 * 鼠标划过控件轻响一声。
 * 关键约束：grab 的 cooldown 在 CUES 里设为 140ms，
 * 否则快速划过一整排按钮会变成密集爆音。
 * pointerenter 不冒泡，用 pointerover + 记录上一个元素来模拟。
 */
const HOVER_SEL = ".nav-item, .func-menu__item, .tab-item, .recent-contact-item, .send-btn-wrap";

let lastHover = null;

document.addEventListener("pointerover", (event) => {
    if (!cfg.hoverSound) return;
    const el = event.target.closest && event.target.closest(HOVER_SEL);
    if (!el) {
        // 移出所有控件：清空，否则回到同一个控件时不会再响
        lastHover = null;
        return;
    }
    if (el === lastHover) return;          // 仍在同一控件内（含其子元素）
    lastHover = el;
    sound.play("grab");
}, { capture: true, passive: true });

/* ---------- 1c. 回车发送 ---------- */
/*
 * 实测遗漏：点发送按钮有声，但按回车发送无声。
 * 回车不产生 click，需要在编辑器上监听 keydown。
 * 只认 Enter（不含 Shift/Ctrl/Alt，那些是换行或组合键）。
 */
const EDITOR_SEL = ".qq-msg-editor, .ProseMirror, .ck-content";

document.addEventListener("keydown", (event) => {
    if (!cfg.clickSound) return;
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    const editor = event.target.closest && event.target.closest(EDITOR_SEL);
    if (!editor) return;
    sound.play("success");
}, { capture: true, passive: true });

/* ---------- 2a. 应用内拖拽摩擦 ---------- */
/*
 * 关键：不在 pointerdown 就出声。
 * 单击联系人只应播放 select，若 pointerdown 即起摩擦音，
 * 每次单击都会叠一层 grab 声（实测这个设计是错的）。
 * 改为：按下只记录起点，位移超过阈值才真正开始摩擦。
 */
const FRICTION_SEL = ".recent-contact-item, .recent-contact-list, .chat-msg-area, .q-scroll-view, .viewport-list";

const DRAG_THRESHOLD = 6;   // 像素：小于此值视为点击而非拖拽

let drag = null;

document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const el = event.target.closest && event.target.closest(FRICTION_SEL);
    if (!el) return;
    drag = { id: event.pointerId, x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY,
             time: event.timeStamp, moving: false };
}, { capture: true, passive: true });

document.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0);
    if (!drag.moving) {
        if (moved < DRAG_THRESHOLD) return;
        drag.moving = true;
        // 拖拽起手的摩擦音属于"摩擦音"开关；起手的 grab 属于悬浮反馈
        if (cfg.frictionSound) sound.startFriction();
        if (cfg.hoverSound) sound.play("grab");
    }
    if (cfg.frictionSound) {
        sound.updateFriction(speedOf(event.clientX - drag.x, event.clientY - drag.y, event.timeStamp - drag.time));
    }
    drag.x = event.clientX; drag.y = event.clientY; drag.time = event.timeStamp;
}, { capture: true, passive: true });

function speedOf(dx, dy, dt) {
    return Math.hypot(dx, dy) * 1000 / Math.max(8, dt);
}

function endDrag(event) {
    if (!drag) return;
    if (event && event.pointerId !== undefined && event.pointerId !== drag.id) return;
    if (drag.moving) sound.endFriction();
    drag = null;
}
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    document.addEventListener(type, endDrag, { capture: true, passive: true });
}

/* ---------- 2b. 原生窗口拖动摩擦 ---------- */
/*
 * app-region:drag 由操作系统处理，renderer 收不到 pointer 事件。
 * 实测：拖动时渲染进程【仍在正常运行】（12 秒 239 次心跳、0 卡顿），
 *       因此可以轮询 window.screenX/screenY 反推窗口移动速度。
 * 只对可见窗口生效；后台窗口的 screen 值不可信。
 */
let lastX = null, lastY = null, lastT = 0, winDrag = false;

const windowDragTimer = setInterval(() => {
    if (document.visibilityState !== "visible") { lastX = lastY = null; winDrag = false; return; }
    if (!cfg.frictionSound) { if (winDrag) { winDrag = false; } lastX = lastY = null; return; }
    const x = window.screenX, y = window.screenY, t = performance.now();
    if (lastX !== null && lastT) {
        const moved = Math.hypot(x - lastX, y - lastY);
        if (moved > 4) {
            if (!winDrag) { winDrag = true; sound.startFriction(); }
            sound.updateFriction(speedOf(x - lastX, y - lastY, t - lastT));
        } else if (winDrag) {
            winDrag = false;
            sound.endFriction();
        }
    }
    lastX = x; lastY = y; lastT = t;
}, 90);

/* ---------- 2c. 滚轮摩擦（列表内容滚动） ---------- */
/*
 * 边界判断为什么不用 scrollHeight：
 *   QQ 的消息列表是【虚拟列表】，实测 scrollHeight 是伪造的大值（300000），
 *   clientHeight 只有 322，所以 scrollHeight-clientHeight-scrollTop 永远不可能接近 0，
 *   用几何公式判断"到底"会永远失败（这是上一版的 bug）。
 *
 * 改用行为判据：滚轮在响，但 scrollTop 没动 → 已经到边界。
 *   对虚拟列表、普通列表、以及顶/底两个方向都成立。
 *   反向滚动时方向改变，会正常恢复出声。
 */
let wheelDecay = 0;
const boxState = new WeakMap();      // 滚动容器 → { top, dir }

const NO_SOUND_SEL = ".chat-input-area";   // 输入框区域：滚轮不出声

// 命中点向上找最近的可滚动容器（overlay 是 QQ 实际使用的 overflowY）
function scrollableAt(node) {
    let el = node;
    while (el && el.nodeType === 1) {
        const cs = getComputedStyle(el);
        if (el.scrollHeight > el.clientHeight + 4 && /auto|scroll|overlay/.test(cs.overflowY)) return el;
        el = el.parentElement;
    }
    return null;
}

document.addEventListener("wheel", (event) => {
    if (!cfg.frictionSound) return;
    const target = event.target;
    if (target.closest && target.closest(NO_SOUND_SEL)) return;   // 输入框不发声

    if (!(target.closest && target.closest(FRICTION_SEL))) return;

    const box = scrollableAt(target);
    if (box && event.deltaY) {
        const dir = Math.sign(event.deltaY);
        const prev = boxState.get(box);
        const top = box.scrollTop;
        // 上一次滚轮（同方向）之后位置没变 → 已在边界，静音
        if (prev && prev.dir === dir && Math.abs(top - prev.top) < 0.5) {
            boxState.set(box, { top, dir });
            if (wheelDecay) { clearTimeout(wheelDecay); wheelDecay = 0; sound.endFriction(); }
            return;
        }
        boxState.set(box, { top, dir });
    }

    if (!wheelDecay) sound.startFriction();
    sound.updateFriction(Math.abs(event.deltaY) * 12, WHEEL_SCALE());
    clearTimeout(wheelDecay);
    wheelDecay = setTimeout(() => { wheelDecay = 0; sound.endFriction(); }, WHEEL_HOLD());
}, { capture: true, passive: true });

/* ---------- 收尾 ---------- */

window.addEventListener("blur", () => {
    drag = null; winDrag = false;
    sound.endFriction(true);
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden) { drag = null; winDrag = false; sound.endFriction(true); }
});

// 暴露给调试用（PROFILE 环境可读），不改动业务行为
window.__lensSound = sound;
console.log("[lens-skin] 声音已启用：点击 select/success · 拖拽/滚动/窗口拖动 friction");
