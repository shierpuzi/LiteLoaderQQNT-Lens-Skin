/**
 * Lens 光照范围限制（只保留"限制光照渲染范围"）
 *
 * ===== 为什么这里【没有】元素选择器 =====
 * 元素选择器已经统一由 dsh-debug-logger 插件提供（那份实现更完整：
 * 多选、剪贴板、可自定义快捷键、设置页）。
 * 之前两个插件各有一套拾取器，实测会互相干扰：
 *   1. 两个全屏覆盖层都存在，各自显示一个提示气泡 → 屏幕上两个气泡重叠；
 *   2. 更严重的是 elementFromPoint 的竞争：lens 的覆盖层（全屏、pointer-events:auto）
 *      会在 dsh 做命中测试时被当成"命中的元素"返回，
 *      于是 dsh 选中的是"一整个全屏覆盖层"，而不是鼠标下的真实控件。
 * 所以这里彻底移除拾取逻辑，只保留 Lens 专有的能力：
 *   把光照限制在一个手拉的矩形范围内（归一化坐标，抗窗口缩放）。
 *
 * 用法：
 *   主界面按 Ctrl+Shift+B 进入拖框（或在设置页点「拖框限制」）
 *   拖完自动退出；点「清除范围」恢复全窗口
 *   Ctrl+Esc 退出
 *
 * 安全约束：
 *   - 覆盖层 pointer-events 默认 none，只在拖框时临时 auto，用完立刻恢复
 *   - 拖完一个框自动退出，避免覆盖层持续吞掉 QQ 点击
 */

import { setLightClip, getLightClip } from "./lens-light.js";

const STYLE_ID = "lens-debug-style";
const OVERLAY_ID = "lens-debug-overlay";

/*
 * 快捷键只保留 Lens 用得到的两个。
 * 【注意】Esc 必须写别名映射：KeyboardEvent.key 的值是 "Escape"，
 * 而快捷键描述里用户习惯写 "Esc" —— 早期版本直接字符串比较，
 * 导致 "Ctrl+Esc" 永远匹配不上（退出键失效）。见 normalizeKey。
 */
const DEFAULT_HOTKEYS = Object.freeze({
    box: "Ctrl+Shift+B",     // 进入/退出拖框限制范围
    exit: "Ctrl+Esc",        // 退出拖框 / 关工具
});

let hotkeys = { ...DEFAULT_HOTKEYS };

let active = false;
let boxMode = false;
let boxDrag = null;
let host = null;

const els = {};

/* ---------- 键名别名 ----------
 * 把用户习惯写的名字映射到 KeyboardEvent.key 的实际值。
 * 不加这个映射，"Esc" / "Del" / "Space" 这类写法永远匹配不上。
 */
const KEY_ALIAS = {
    esc: "escape",
    escape: "escape",
    del: "delete",
    ins: "insert",
    space: " ",
    spacebar: " ",
    enter: "enter",
    return: "enter",
    up: "arrowup",
    down: "arrowdown",
    left: "arrowleft",
    right: "arrowright",
    plus: "+",
};

function normalizeKey(name) {
    const k = String(name || "").trim().toLowerCase();
    return KEY_ALIAS[k] ?? k;
}

/** 判断按键事件是否匹配快捷键描述（"Ctrl+Shift+B" 这种） */
function matchesHotkey(event, spec) {
    if (!spec) return false;
    const parts = String(spec).split("+").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return false;
    const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
    const key = normalizeKey(parts[parts.length - 1]);

    const need = (m) => mods.includes(m);
    if (need("ctrl") !== !!event.ctrlKey) return false;
    if (need("shift") !== !!event.shiftKey) return false;
    if (need("alt") !== !!event.altKey) return false;
    if (need("meta") !== !!event.metaKey) return false;
    return normalizeKey(event.key) === key;
}

export function setHotkeys(patch) {
    const next = { ...hotkeys };
    for (const [k, v] of Object.entries(patch || {})) {
        if (typeof v === "string" && v.trim()) next[k] = v.trim();
    }
    hotkeys = next;
    return { ...hotkeys };
}

export function getHotkeys() { return { ...hotkeys }; }

/* ---------- 覆盖层 ---------- */

function ensureDom() {
    if (host) return;
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
          #${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483001; pointer-events: none; }
          #${OVERLAY_ID} .lg-margin { position: fixed; pointer-events: none; background: rgba(255,164,0,.24); }
          #${OVERLAY_ID} .lg-clip {
            position: fixed; pointer-events: none;
            border: 2px solid #ff3b6b; border-radius: 3px;
            background: rgba(255,59,107,.06);
            box-shadow: 0 0 0 100vmax rgba(0,0,0,.28);
          }
          #${OVERLAY_ID} .lg-hint {
            position: fixed; left: 50%; top: 12px; transform: translateX(-50%);
            pointer-events: none; font: 12px/1.8 system-ui, "Microsoft YaHei", sans-serif;
            background: rgba(20,24,32,.92); color: #e8eefc; padding: 6px 14px;
            border-radius: 8px; border: 1px solid rgba(255,255,255,.12);
          }
          #${OVERLAY_ID} .lg-toast {
            position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%);
            pointer-events: none; font: 13px/1.7 system-ui, "Microsoft YaHei", sans-serif;
            background: rgba(24,120,70,.96); color: #fff; padding: 8px 18px;
            border-radius: 10px; border: 1px solid rgba(255,255,255,.18);
            box-shadow: 0 6px 20px rgba(0,0,0,.32); animation: lg-toast-in .18s ease-out;
          }
          @keyframes lg-toast-in {
            from { opacity: 0; transform: translateX(-50%) translateY(8px); }
            to   { opacity: 1; transform: translateX(-50%) translateY(0); }
          }
        `;
        document.head.appendChild(style);
    }
    host = document.createElement("div");
    host.id = OVERLAY_ID;
    host.innerHTML = `
      <div class="lg-margin" hidden></div>
      <div class="lg-clip" hidden></div>
      <div class="lg-hint" hidden></div>
      <div class="lg-toast" hidden></div>
    `;
    (document.body || document.documentElement).appendChild(host);
    els.margin = host.querySelector(".lg-margin");
    els.clip = host.querySelector(".lg-clip");
    els.hint = host.querySelector(".lg-hint");
    els.toast = host.querySelector(".lg-toast");
}

const show = (el, visible) => { if (el) el.hidden = !visible; };

function setHint(text) {
    ensureDom();
    if (!text) { show(els.hint, false); return; }
    els.hint.textContent = text;
    show(els.hint, true);
}

/** 气泡提示；自动关闭，不会一直挂在页面上 */
function toast(text, ms = 2000) {
    ensureDom();
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.hidden = false;
    els.toast.style.animation = "none";
    void els.toast.offsetHeight;
    els.toast.style.animation = "";
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

/* ---------- 拖框限制渲染范围 ---------- */

function cancelBoxDrag() {
    boxDrag = null;
    // 同样避免凭空建层：只在已有 DOM 时隐藏拖动预览
    if (host) show(els.margin, false);
}

function onBoxDown(event) {
    if (!boxMode || !active) return;
    event.preventDefault();
    event.stopPropagation();
    boxDrag = { x0: event.clientX, y0: event.clientY, cur: null };
}

function onBoxMove(event) {
    if (!boxDrag) return;
    const x0 = Math.min(boxDrag.x0, event.clientX), y0 = Math.min(boxDrag.y0, event.clientY);
    const x1 = Math.max(boxDrag.x0, event.clientX), y1 = Math.max(boxDrag.y0, event.clientY);
    boxDrag.cur = { x0, y0, x1, y1 };
    ensureDom();
    Object.assign(els.margin.style, {
        left: x0 + "px", top: y0 + "px", width: (x1 - x0) + "px", height: (y1 - y0) + "px",
    });
    show(els.margin, true);
    applyBoxClip(boxDrag.cur);      // 实时预览
}

function onBoxUp() {
    if (!boxDrag) return;
    const cur = boxDrag.cur;
    boxDrag = null;
    // 拖完自动退出，避免覆盖层持续吞掉 QQ 点击
    setBoxMode(false);
    if (!cur || (cur.x1 - cur.x0) < 8 || (cur.y1 - cur.y0) < 8) { cancelBoxDrag(); return; }
    applyBoxClip(cur);
    renderClipMarker();
    toast("光照已限制在所选范围，点「清除范围」恢复");
    try { window.dispatchEvent(new CustomEvent("lens:debug-clip", { detail: getLightClip() })); } catch { }
}

/** 像素矩形 → 归一化 clip 并交给 GPU（归一化保证窗口缩放不错位） */
function applyBoxClip(px) {
    setLightClip({
        x: px.x0 / innerWidth, y: px.y0 / innerHeight,
        z: px.x1 / innerWidth, w: px.y1 / innerHeight,
    });
}

function renderClipMarker() {
    ensureDom();
    const c = getLightClip();
    if (!c || (c.x === 0 && c.y === 0 && c.z === 1 && c.w === 1)) { show(els.clip, false); return; }
    Object.assign(els.clip.style, {
        left: (c.x * innerWidth) + "px", top: (c.y * innerHeight) + "px",
        width: ((c.z - c.x) * innerWidth) + "px", height: ((c.w - c.y) * innerHeight) + "px",
    });
    show(els.clip, true);
}

export function setBoxMode(on) {
    boxMode = !!on && active;
    ensureDom();
    if (host) host.style.pointerEvents = boxMode ? "auto" : "none";
    if (boxMode) setHint(`拖动鼠标框选范围：光照只在框内渲染（${hotkeys.exit} 取消）`);
    else setHint("");
}

export function clearClip() {
    setLightClip(null);
    // 只在 DOM 已存在时操作，避免在工具未启动时凭空建出覆盖层（孤儿层）
    if (host) {
        show(els.clip, false);
        cancelBoxDrag();
    }
    try { window.dispatchEvent(new CustomEvent("lens:debug-clip", { detail: null })); } catch { }
}

/* ---------- 生命周期 ---------- */

function onKeyDown(event) {
    if (!active) return;

    if (matchesHotkey(event, hotkeys.exit)) {
        event.preventDefault();
        event.stopPropagation();
        if (boxMode) { setBoxMode(false); toast("已退出拖框"); }
        else stopDebugTool();
        return;
    }

    if (matchesHotkey(event, hotkeys.box)) {
        event.preventDefault();
        event.stopPropagation();
        setBoxMode(!boxMode);
    }
}

export function startDebugTool() {
    if (active) return;
    ensureDom();
    active = true;
    window.__lensDebugOn = true;

    document.addEventListener("keydown", onKeyDown, { capture: true });
    host.addEventListener("pointerdown", onBoxDown, { capture: true });
    document.addEventListener("pointermove", onBoxMove, { capture: true, passive: true });
    document.addEventListener("pointerup", onBoxUp, { capture: true, passive: true });
}

export function stopDebugTool() {
    if (!active) return;
    active = false;
    boxMode = false;
    window.__lensDebugOn = false;
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointermove", onBoxMove, true);
    document.removeEventListener("pointerup", onBoxUp, true);
    if (host) {
        host.removeEventListener("pointerdown", onBoxDown, true);
        host.style.pointerEvents = "none";
        host.innerHTML = "";
        host.remove();
    }
    host = null;
    setLightClip(null);
}

/** 导出报告：光照目标清单 + 当前范围（元素选择请用 dsh-debug-logger） */
export function exportReport() {
    const lightState = window.__lensGpuLight;
    const targets = lightState && typeof lightState.listTargets === "function" ? lightState.listTargets() : [];
    const report = {
        time: new Date().toISOString(),
        window: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
        theme: document.body.matches(".q-theme-tokens-dark") ? "dark"
             : document.body.matches(".q-theme-tokens-light") ? "light" : "?",
        clip: getLightClip(),
        hotkeys: { ...hotkeys },
        lightTargets: targets.map((t) => ({
            selector: t.cls ? "." + t.cls.trim().split(/\s+/)[0] : t.tag,
            cls: t.cls, rect: t.rect, radius: t.radius, eligible: t.eligible,
        })),
        gpu: {
            on: !!window.__lensGpuLightOn,
            canvasCount: [...document.querySelectorAll("canvas")].filter((c) => c.style.zIndex === "2147483000").length,
        },
    };
    console.log("[lens-debug] 报告:", report);
    try { window.__lensDebugReport = report; } catch { }
    return report;
}

// 便捷入口：供设置页按钮 / eval REPL / 控制台调用
export const __api = {
    start: startDebugTool,
    stop: stopDebugTool,
    setBoxMode,
    clearClip,
    exportReport,
    setHotkeys,
    getHotkeys,
    toast,
};

try {
    window.__lensDebug = __api;
} catch { }

/*
 * 自举：让用户在主界面直接按 Ctrl+Shift+B 就能拖框限制范围，
 * 不必先去设置页开工具（这才是 DevTools 式的顺手体验）。
 *
 * 只在【真正承载 UI 的窗口】挂这个引导监听：腾讯会给隐藏窗口、会话池窗口、
 * 空白窗口也注入 renderer，在那里挂全局键盘监听纯属浪费。
 * 判据用"窗口里有没有实际的界面元素"，不用 URL（实测多个窗口 URL 相同）。
 */
export function bootLightTools() {
    if (window.__lensLightToolsBooted) return;
    window.__lensLightToolsBooted = true;

    window.addEventListener("keydown", (event) => {
        if (window.__lensDebugOn) return;            // 已启动 → 交给工具自己处理
        if (!matchesHotkey(event, hotkeys.box)) return;
        event.preventDefault();
        event.stopPropagation();
        startDebugTool();
        setBoxMode(true);
    }, { capture: true });
}

(function waitForUi() {
    const hasUi = () => !!document.querySelector(
        ".sidebar__nav, .recent-contact, .chat-msg-area, .q-dialog-main, #app, .main"
    );
    if (hasUi()) { bootLightTools(); return; }

    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        if (hasUi() || tries > 100) {            // 最多等约 20 秒
            clearInterval(timer);
            if (hasUi()) bootLightTools();
        }
    }, 200);
})();
