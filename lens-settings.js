/**
 * Lens 透镜 — 设置面板
 *
 * 通过 LiteLoader 的 onSettingWindowCreated 钩子挂进 QQ 设置页。
 * 用 LiteLoader.api.config 持久化（存到 <profile>\data\lens-skin\config.json）。
 *
 * 开关粒度对应三条独立的声音来源：
 *   clickSound    点击音效（控件点击 / 发送 / 回车发送）
 *   hoverSound    悬浮音效（鼠标划过控件）
 *   frictionSound 摩擦音（拖拽 / 滚轮 / 窗口拖动）
 * 另有两个可调值：总音量、摩擦音强度。
 */

export const DEFAULT_CONFIG = Object.freeze({
    clickSound: true,
    hoverSound: true,
    frictionSound: true,
    volume: 0.28,
    frictionGain: 0.32,
    // 玻璃面板的底色 alpha（0 = 全透明，1 = 不透明）。
    // 与 lens-skin.css 里 --lg-alpha 的默认值保持一致。
    panelOpacity: 0.34,
    // 玻璃面板的 backdrop 高斯模糊半径（px，0 = 不模糊）。
    // 与 lens-skin.css 里 --lg-blur 的默认值保持一致。
    panelBlur: 12,
    // 鼠标光源：控件边界阴影 + 迎光边高光 + 投影方向随鼠标。
    lightEnabled: true,
    // 光照强度 0..1（0 关闭时的等价效果，但仍走同一套 CSS）。
    lightStrength: 1,
});

const SLUG = "lens-skin";

/*
 * 跨窗口同步（这是"改设置要重启才生效"的根治点）
 *
 * 实测：QQ 的每个窗口（主界面 / 设置页 / 隐藏窗口）都是【独立的 JS 上下文】，
 *       主窗口 webcontentsid=2、设置页 webcontentsid=6。
 *       所以在设置页里 window.dispatchEvent(...) 只有设置页自己收得到，
 *       主窗口的声音层完全不知情 —— 表现为"设置改了，重启后才生效"。
 *
 * localStorage 的 storage 事件是浏览器原生跨窗口机制，
 * 实测在 QQ 里可用（主窗口写入后，其他窗口都收到了通知）。
 */
const SYNC_KEY = "lens-skin:config-sync";
const LOCAL_EVENT = "lens:config-changed";

/**
 * 广播配置变更。
 * 两个通道都要走，缺一不可：
 *   1. localStorage 的 storage 事件 —— 跨窗口（设置页 → 主界面）。
 *      注意：storage 事件【不会】在写入者自己的窗口触发。
 *   2. 本窗口的 CustomEvent —— 覆盖同窗口场景（设置页自己的声音层）。
 */
export function broadcastConfig(config) {
    try {
        // 带时间戳，保证连续两次相同配置也能触发 storage 事件
        localStorage.setItem(SYNC_KEY, JSON.stringify({ ...config, _t: Date.now() }));
    } catch { /* localStorage 不可用时退化为仅本窗口生效 */ }
    try {
        window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: config }));
    } catch { }
}

/** 监听其他窗口的配置变更。返回取消函数。 */
export function onConfigBroadcast(handler) {
    const listener = (event) => {
        if (event.key !== SYNC_KEY || !event.newValue) return;
        try {
            const { _t, ...config } = JSON.parse(event.newValue);
            handler(config);
        } catch { }
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
}

const clamp = (v, min, max, fallback) => {
    // null / "" 会被 Number() 静默转成 0，导致"音量 0 静音"这种难查的问题，先挡掉
    if (v === null || v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/*
 * 把界面类设置写到 CSS 变量上。
 *   panelOpacity  → --lg-alpha，lens-skin.css 里 --lg-glass 由它计算
 *   panelBlur     → --lg-blur，面板的 backdrop-filter 由它计算
 *   lightEnabled  → --lg-light（开=lightStrength，关=0）
 *   lightStrength → --lg-light，控件边界阴影 / 迎光边 / 投影方向的总强度
 * 用内联样式设在 body 上：内联优先级高于样式表，能稳定覆盖 CSS 里的默认值，
 * 且所有使用这些变量的元素都会跟着变。
 *
 * 只传部分字段（例如拖动某个滑杆时）也能工作：未提供的字段保持不动。
 */
export function applyUiConfig({ panelOpacity, panelBlur, lightEnabled, lightStrength } = {}) {
    const target = document.body;
    if (!target) return;
    if (panelOpacity !== undefined) {
        target.style.setProperty("--lg-alpha", String(clamp(panelOpacity, 0, 1, DEFAULT_CONFIG.panelOpacity)));
    }
    if (panelBlur !== undefined) {
        const blur = clamp(panelBlur, 0, 64, DEFAULT_CONFIG.panelBlur);
        target.style.setProperty("--lg-blur", blur + "px");
        // 模糊为 0 时把整条 backdrop-filter 置 none：
        // blur(0px) 仍会让浏览器建立 backdrop root（合成成本照付）却毫无视觉效果。
        target.style.setProperty("--lg-backdrop", blur > 0 ? `blur(${blur}px) saturate(1.5)` : "none");
    }
    if (lightEnabled !== undefined || lightStrength !== undefined) {
        // 开关与强度合成一个数值：关掉即为 0，CSS 只需读 --lg-light 一个变量
        const on = lightEnabled === undefined ? true : !!lightEnabled;
        const strength = clamp(
            lightStrength === undefined ? DEFAULT_CONFIG.lightStrength : lightStrength,
            0, 1, DEFAULT_CONFIG.lightStrength
        );
        target.style.setProperty("--lg-light", String(on ? strength : 0));
    }
}

/** 读取配置并做范围校验（防住手工改坏或旧版本残留的值） */
export async function loadConfig() {
    let saved = {};
    try { saved = (await LiteLoader.api.config.get(SLUG, DEFAULT_CONFIG)) || {}; } catch { }
    const bool = (v, d) => (typeof v === "boolean" ? v : d);
    return {
        clickSound: bool(saved.clickSound, DEFAULT_CONFIG.clickSound),
        hoverSound: bool(saved.hoverSound, DEFAULT_CONFIG.hoverSound),
        frictionSound: bool(saved.frictionSound, DEFAULT_CONFIG.frictionSound),
        volume: clamp(saved.volume, 0, 1, DEFAULT_CONFIG.volume),
        frictionGain: clamp(saved.frictionGain, 0, 0.6, DEFAULT_CONFIG.frictionGain),
        panelOpacity: clamp(saved.panelOpacity, 0, 1, DEFAULT_CONFIG.panelOpacity),
        // 上限 64px：再高既看不出差别，又会显著增加 GPU 开销
        panelBlur: clamp(saved.panelBlur, 0, 64, DEFAULT_CONFIG.panelBlur),
        lightEnabled: bool(saved.lightEnabled, DEFAULT_CONFIG.lightEnabled),
        lightStrength: clamp(saved.lightStrength, 0, 1, DEFAULT_CONFIG.lightStrength),
    };
}

export async function saveConfig(patch) {
    const next = { ...(await loadConfig()), ...patch };
    try { await LiteLoader.api.config.set(SLUG, next); } catch { }
    // 落盘后立刻广播给其他窗口（主界面），否则要重启才生效。
    // 放在 saveConfig 里而不是各个调用点，保证开关/滑杆/恢复默认三处都不会漏。
    broadcastConfig(next);
    return next;
}

/** 渲染设置页。view 是 LiteLoader 提供的容器元素。 */
export async function renderSettings(view, config, onChange) {
    const c = config;
    view.innerHTML = `
      <style>
        .lens-set { padding: 12px 4px; font-size: 14px; }
        .lens-set h2 { font-size: 16px; margin: 0 0 4px; font-weight: 600; }
        .lens-set .hint { opacity: .6; font-size: 12px; line-height: 1.7; margin: 0 0 14px; }
        .lens-row { display: flex; align-items: center; justify-content: space-between;
                    gap: 16px; padding: 11px 0; border-bottom: 1px solid rgba(128,128,128,.14); }
        .lens-row:last-child { border-bottom: 0; }
        .lens-label { display: flex; flex-direction: column; gap: 3px; }
        .lens-label b { font-weight: 500; }
        .lens-label small { opacity: .55; font-size: 12px; }
        .lens-range { display: flex; align-items: center; gap: 10px; min-width: 190px; }
        .lens-range input[type=range] { flex: 1; accent-color: #2875ed; }
        .lens-range output { min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; opacity: .75; }
        /* 开关：用 QQ 自己的 q-switch 结构与样式，跟随主题 */
        .lens-sw { cursor: pointer; flex: none; }
        .lens-actions { display: flex; align-items: center; gap: 12px; padding-top: 16px; }
        .lens-reset-tip { font-size: 12px; opacity: .6; }
      </style>
      <div class="lens-set">
        <h2>Lens 透镜 · 界面</h2>
        <p class="hint">
          调整玻璃面板的通透程度。数值越低越透明（越能透出后面的壁纸）。
        </p>

        <div class="lens-row">
          <span class="lens-label"><b>面板透明度</b><small>左侧栏、会话列表、聊天区、输入区的玻璃底色</small></span>
          <span class="lens-range">
            <input type="range" min="0" max="100" value="${Math.round(c.panelOpacity * 100)}" data-key="panelOpacity">
            <output>${Math.round(c.panelOpacity * 100)}%</output>
          </span>
        </div>

        <div class="lens-row">
          <span class="lens-label"><b>高斯模糊</b><small>面板背后内容的模糊程度；0 为不模糊（更省 GPU）</small></span>
          <span class="lens-range">
            <input type="range" min="0" max="64" value="${Math.round(c.panelBlur)}" data-key="panelBlur">
            <output>${Math.round(c.panelBlur)}px</output>
          </span>
        </div>

        <div class="lens-row">
          <span class="lens-label"><b>鼠标光源</b><small>全部控件共用同一个光源：边缘迎光/背光随鼠标联动（GPU 渲染）</small></span>
          <div class="q-switch lens-sw ${c.lightEnabled ? "is-active" : ""}" data-key="lightEnabled" role="switch" aria-checked="${!!c.lightEnabled}">
            <span class="q-switch__handle"></span>
          </div>
        </div>

        <div class="lens-row">
          <span class="lens-label"><b>光照强度</b><small>全部控件边缘光影的强弱；设为 0 等同关闭</small></span>
          <span class="lens-range">
            <input type="range" min="0" max="100" value="${Math.round(c.lightStrength * 100)}" data-key="lightStrength">
            <output>${Math.round(c.lightStrength * 100)}%</output>
          </span>
        </div>

        <h2 style="margin-top:26px;">Lens 透镜 · 声音</h2>
        <p class="hint">
          全部音效由 Web Audio 实时合成，不含音频文件、不联网。<br>
          首次点击后才会出声（浏览器要求用户手势解锁音频）。
        </p>

        <div class="lens-row">
          <span class="lens-label"><b>点击音效</b><small>控件点击、发送消息（含回车）</small></span>
          <div class="q-switch lens-sw ${c.clickSound ? "is-active" : ""}" data-key="clickSound" role="switch" aria-checked="${!!c.clickSound}">
            <span class="q-switch__handle"></span>
          </div>
        </div>

        <div class="lens-row">
          <span class="lens-label"><b>悬浮音效</b><small>鼠标划过控件时轻响（带冷却，快速滑动不会爆音）</small></span>
          <div class="q-switch lens-sw ${c.hoverSound ? "is-active" : ""}" data-key="hoverSound" role="switch" aria-checked="${!!c.hoverSound}">
            <span class="q-switch__handle"></span>
          </div>
        </div>

        <div class="lens-row">
          <span class="lens-label"><b>摩擦音效</b><small>拖拽联系人、滚动列表、拖动窗口</small></span>
          <div class="q-switch lens-sw ${c.frictionSound ? "is-active" : ""}" data-key="frictionSound" role="switch" aria-checked="${!!c.frictionSound}">
            <span class="q-switch__handle"></span>
          </div>
        </div>

        <div class="lens-row">
          <span class="lens-label"><b>总音量</b><small>所有音效的统一音量</small></span>
          <span class="lens-range">
            <input type="range" min="0" max="100" value="${Math.round(c.volume * 100)}" data-key="volume">
            <output>${Math.round(c.volume * 100)}%</output>
          </span>
        </div>

        <div class="lens-row">
          <span class="lens-label"><b>摩擦音强度</b><small>拖拽与滚轮的沙沙声响度</small></span>
          <span class="lens-range">
            <input type="range" min="0" max="100" value="${Math.round(c.frictionGain / 0.6 * 100)}" data-key="frictionGain">
            <output>${Math.round(c.frictionGain / 0.6 * 100)}%</output>
          </span>
        </div>

        <div class="lens-actions">
          <button type="button" class="lens-reset q-button q-button--small q-button--secondary">恢复默认</button>
          <span class="lens-reset-tip" hidden>已恢复默认设置</span>
        </div>

        <h2 style="margin-top:26px;">Lens 透镜 · 光照调试</h2>
        <p class="hint">
          <b>元素选择器已统一到「DSH 调试日志」插件</b>（Ctrl+Shift+C 拾取，避免两个拾取器互相干扰）。<br>
          这里只保留 Lens 专有的能力：把光照限制在一个范围内渲染。
        </p>

        <div class="lens-row">
          <span class="lens-label"><b>限制光照范围</b><small>拖一个框，光照只在该范围内渲染（按窗口比例计算，缩放不错位）；Ctrl+Shift+B 可开关</small></span>
          <span class="lens-range">
            <button type="button" class="lens-dbg-box q-button q-button--small q-button--secondary">拖框限制</button>
            <button type="button" class="lens-dbg-clear q-button q-button--small q-button--secondary">清除范围</button>
          </span>
        </div>

        <div class="lens-row">
          <span class="lens-label"><b>导出光照报告</b><small>光照命中清单 + 当前范围写入控制台</small></span>
          <span class="lens-range">
            <button type="button" class="lens-dbg-report q-button q-button--small q-button--secondary">导出到控制台</button>
          </span>
        </div>

        <div class="lens-row">
          <span class="lens-label"><b>光照调试总开关</b><small>关闭后不挂任何事件，完全不影响正常使用</small></span>
          <div class="q-switch lens-sw lens-dbg-enable" data-key="__debug">
            <span class="q-switch__handle"></span>
          </div>
        </div>
      </div>
    `;

    /*
     * 滑杆的显示值 ↔ 配置值映射。
     * 集中在一处，避免 syncUI 与 input 处理各写一套、加新滑杆时漏改其中一处。
     *   toConfig: 界面 0-100 → 配置值
     *   toPercent: 配置值 → 界面 0-100
     */
    const SLIDERS = {
        volume: { toConfig: (v) => v / 100, toPercent: (c) => c.volume * 100, unit: "%" },
        frictionGain: { toConfig: (v) => v / 100 * 0.6, toPercent: (c) => c.frictionGain / 0.6 * 100, unit: "%" },
        panelOpacity: { toConfig: (v) => v / 100, toPercent: (c) => c.panelOpacity * 100, unit: "%" },
        panelBlur: { toConfig: (v) => v, toPercent: (c) => c.panelBlur, unit: "px" },
        lightStrength: { toConfig: (v) => v / 100, toPercent: (c) => c.lightStrength * 100, unit: "%" },
    };

    /*
     * 把配置写回控件。
     * 恢复默认后必须刷新界面，否则滑杆/开关还停在旧位置，
     * 看起来像"按钮没生效"（实测这种不一致最容易误导人）。
     *
     * QQ 的开关外观由 class "is-active" 驱动，不是 aria-checked
     * （实测：只改 aria-checked 时状态值正确但外观永远显示为关）。
     * aria-checked 仍然同步，用于无障碍语义。
     */
    const syncUI = (next) => {
        view.querySelectorAll(".lens-sw").forEach((sw) => {
            // 调试总开关是会话级状态，不受配置影响（恢复默认时不该把它关掉）
            if (sw.dataset.key === "__debug") return;
            const on = !!next[sw.dataset.key];
            sw.setAttribute("aria-checked", String(on));
            sw.classList.toggle("is-active", on);
        });
        view.querySelectorAll(".lens-range input[type=range]").forEach((input) => {
            const slider = SLIDERS[input.dataset.key];
            if (!slider) return;
            const v = Math.round(slider.toPercent(next));
            input.value = String(v);
            const out = input.parentElement.querySelector("output");
            if (out) out.textContent = v + (slider.unit || "%");
        });
    };

    // 开关
    view.querySelectorAll(".lens-sw").forEach((sw) => {
        sw.addEventListener("click", async (event) => {
            event.stopPropagation();
            const key = sw.dataset.key;
            // 调试总开关是【会话级】状态，不落盘（避免往配置里写无关字段）。
            // 不写进这里，恢复默认/同步配置时也不会被误当成配置项。
            if (key === "__debug") {
                sw.classList.toggle("is-active");
                sw.setAttribute("aria-checked", String(sw.classList.contains("is-active")));
                await toggleDebugTool(sw.classList.contains("is-active"));
                return;
            }
            const on = !sw.classList.contains("is-active");   // 以 is-active 为准
            sw.classList.toggle("is-active", on);             // 外观
            sw.setAttribute("aria-checked", String(on));      // 语义
            // 必须 await：onChange 收到的应是配置对象本身，不是 Promise
            onChange(await saveConfig({ [key]: on }));
        });
    });

    // 面板打开时先把当前界面设置应用到界面，保证所见即所存
    applyUiConfig({
        panelOpacity: c.panelOpacity,
        panelBlur: c.panelBlur,
        lightEnabled: c.lightEnabled,
        lightStrength: c.lightStrength,
    });

    // 属于"界面"的滑杆：拖动时即时预览（不等落盘）
    const UI_SLIDERS = new Set(["panelOpacity", "panelBlur", "lightStrength"]);

    // 滑杆
    /*
     * 两个要点（实测踩过）:
     *  1. 必须 await saveConfig 之后再 onChange，否则传出去的是 Promise，
     *     声音层 Object.assign(cfg, Promise) 是个空操作 → 拖动滑杆不即时生效。
     *  2. 拖动时 input 会高频触发，写入要防抖，避免连续写磁盘。
     */
    view.querySelectorAll(".lens-range input[type=range]").forEach((input) => {
        const out = input.parentElement.querySelector("output");
        const key = input.dataset.key;
        const slider = SLIDERS[key];
        if (!slider) return;
        let timer = 0;

        const commit = async () => {
            onChange(await saveConfig({ [key]: slider.toConfig(Number(input.value)) }));
        };

        input.addEventListener("input", () => {
            const raw = Number(input.value);
            out.textContent = raw + (slider.unit || "%");
            clearTimeout(timer);
            // 界面类滑杆要立刻看到变化，否则拖动时拖影严重；
            // 声音类无需预览（声音在落盘后的 commit 里统一生效）。
            if (UI_SLIDERS.has(key)) applyUiConfig({ [key]: slider.toConfig(raw) });
            timer = setTimeout(commit, 160);
        });
    });

    // 恢复默认
    const resetBtn = view.querySelector(".lens-reset");
    const tip = view.querySelector(".lens-reset-tip");
    if (resetBtn) {
        resetBtn.addEventListener("click", async (event) => {
            event.stopPropagation();
            // saveConfig 内部会 loadConfig 再合并，传全部默认值即可整体覆盖
            const next = await saveConfig({ ...DEFAULT_CONFIG });
            syncUI(next);                       // 界面同步，避免"看着没生效"
            onChange(next);
            if (tip) {
                tip.hidden = false;
                setTimeout(() => { tip.hidden = true; }, 1600);
            }
        });
    }

    /* ---------- 调试工具 ----------
     * 重要：QQ 的每个窗口是独立 JS 上下文，设置页与主界面互不可见。
     * 元素拾取必须作用在【主界面】的 DOM 上，所以这里不能直接 import 后调用，
     * 而是把"命令"通过 localStorage 广播出去，由主界面的 renderer 收到后执行
     * （复用已有的 storage 事件通道，与配置同步同一条路）。
     */
    const DBG_KEY = "lens-skin:debug-command";

    const sendDebugCommand = (command, payload) => {
        try {
            localStorage.setItem(DBG_KEY, JSON.stringify({
                command, payload, seq: Date.now() + Math.random(),
            }));
        } catch (e) {
            console.warn("[lens-skin] 调试命令发送失败:", e);
        }
    };

    let debugModule = null;
    const loadDebug = async () => {
        if (debugModule) return debugModule;
        const url = new URL("./lens-debug.js", import.meta.url).href;
        debugModule = await import(url);
        return debugModule;
    };

    /*
     * 调试工具必须在【主界面窗口】里运行（那里才有要检查的控件）。
     * 设置页自己也能开，但那是设置页的 DOM，没意义 —— 所以按钮统一发命令，
     * 由主界面执行。如果当前就在主界面（极少见），则本地直接执行。
     */
    const toggleDebugTool = async (on) => {
        if (isMainWindow()) {
            const m = await loadDebug();
            on ? m.startDebugTool() : m.stopDebugTool();
        } else {
            sendDebugCommand(on ? "start" : "stop");
        }
    };

    /** 当前窗口是否是承载 QQ 主界面的窗口（有侧边栏导航） */
    function isMainWindow() {
        return !!document.querySelector(".sidebar__nav");
    }

    /*
     * 允许在设置页直接开的按钮：先确保光照调试工具已启动，再执行动作。
     * 拾取类按钮已移除（统一到 dsh-debug-logger），这里只剩拖框/清除/导出。
     */
    const ensureToolOn = async () => {
        const enableSw = view.querySelector(".lens-dbg-enable");
        const isOn = enableSw?.classList.contains("is-active");
        if (isOn) return;
        if (enableSw) { enableSw.classList.add("is-active"); enableSw.setAttribute("aria-checked", "true"); }
        await toggleDebugTool(true);
    };

    const boxBtn = view.querySelector(".lens-dbg-box");
    boxBtn?.addEventListener("click", async (event) => {
        event.stopPropagation();
        await ensureToolOn();
        if (isMainWindow()) {
            const m = await loadDebug();
            m.setBoxMode(true);
        } else {
            sendDebugCommand("box");
        }
        if (tip) {
            tip.hidden = false;
            tip.textContent = "已开启拖框：到主界面按住左键拖出范围";
            setTimeout(() => { tip.hidden = true; tip.textContent = "已恢复默认设置"; }, 2600);
        }
    });

    const clearBtn = view.querySelector(".lens-dbg-clear");
    clearBtn?.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (isMainWindow()) {
            const m = await loadDebug();
            m.clearClip();
        } else {
            sendDebugCommand("clear-clip");
        }
        if (tip) {
            tip.hidden = false;
            tip.textContent = "已清除光照范围限制";
            setTimeout(() => { tip.hidden = true; tip.textContent = "已恢复默认设置"; }, 2000);
        }
    });

    const reportBtn = view.querySelector(".lens-dbg-report");
    reportBtn?.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (isMainWindow()) {
            const m = await loadDebug();
            m.exportReport();
        } else {
            sendDebugCommand("report");
        }
        if (tip) {
            tip.hidden = false;
            tip.textContent = "报告已写入主界面控制台（console.log 搜 lens-debug）";
            setTimeout(() => { tip.hidden = true; tip.textContent = "已恢复默认设置"; }, 2400);
        }
    });
}
