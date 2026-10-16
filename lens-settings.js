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
        <h2>Lens 透镜 · 声音</h2>
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
      </div>
    `;

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
            const on = !!next[sw.dataset.key];
            sw.setAttribute("aria-checked", String(on));
            sw.classList.toggle("is-active", on);
        });
        view.querySelectorAll(".lens-range input[type=range]").forEach((input) => {
            const key = input.dataset.key;
            const pct = key === "volume"
                ? Math.round(next.volume * 100)
                : Math.round(next.frictionGain / 0.6 * 100);
            input.value = String(pct);
            const out = input.parentElement.querySelector("output");
            if (out) out.textContent = pct + "%";
        });
    };

    // 开关
    view.querySelectorAll(".lens-sw").forEach((sw) => {
        sw.addEventListener("click", async (event) => {
            event.stopPropagation();
            const key = sw.dataset.key;
            const on = !sw.classList.contains("is-active");   // 以 is-active 为准
            sw.classList.toggle("is-active", on);             // 外观
            sw.setAttribute("aria-checked", String(on));      // 语义
            // 必须 await：onChange 收到的应是配置对象本身，不是 Promise
            onChange(await saveConfig({ [key]: on }));
        });
    });

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
        let timer = 0;

        const commit = async () => {
            const v = Number(input.value);
            const patch = key === "volume"
                ? { volume: v / 100 }
                : { frictionGain: v / 100 * 0.6 };
            onChange(await saveConfig(patch));
        };

        input.addEventListener("input", () => {
            const v = Number(input.value);
            out.textContent = v + "%";
            clearTimeout(timer);
            timer = setTimeout(commit, 160);   // 停手后再落盘
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
}
