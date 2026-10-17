/**
 * Lens 透镜 — LiteLoaderQQNT 皮肤插件（渲染进程部分）
 *
 * 设计系统来源: ruiqichenbiec/design-systems · lens/lab/design-system (MIT)
 *
 * 为什么需要读取外部 CSS 文件而不是把样式内联在这里:
 *   QQ 重启后插件才会重新加载，但样式是设计资产，需要能独立迭代。
 *   放在同目录的 lens-skin.css 里，改完重启 QQ 即生效。
 *
 * 路径处理（实测）:
 *   LiteLoader 注册的 local:// 协议里，只有 local://profile/<相对路径> 可用；
 *   local:///绝对路径 会拼出非法 file URL 而失败。
 *   所以从 LiteLoader.plugins[slug].path.plugin 反推出相对 profile 的路径。
 */

const SLUG = "lens-skin";

// 两个样式层，各自独立文件，便于单独迭代与停用
const LAYERS = [
    { id: "lens-skin", file: "lens-skin.css" },       // 令牌映射（配色 / 圆角 / 玻璃）
    { id: "lens-motion", file: "lens-motion.css" },   // 动效（静态元素的被动 transition）
];

function assetUrl(file) {
    // 从插件绝对路径推导出 local://profile/ 形式的 URL，避免硬编码盘符或用户名
    const self = LiteLoader?.plugins?.[SLUG]?.path?.plugin;
    const profile = LiteLoader?.path?.profile;
    if (!self || !profile) return null;
    const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const s = norm(self), p = norm(profile);
    if (!s.toLowerCase().startsWith(p.toLowerCase() + "/")) return null;
    return `local://profile/${s.slice(p.length + 1)}/${file}`;
}

async function injectLayer({ id, file }) {
    const url = assetUrl(file);
    if (!url) {
        console.error(`[${SLUG}] 无法推导样式路径（LiteLoader.path.profile 不可用）`);
        return;
    }
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
        console.error(`[${SLUG}] ${file} 读取失败: ${res.status} → ${url}`);
        return;
    }
    const css = await res.text();

    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement("style");
        el.id = id;
        // 插到 head 末尾，保证在 QQ 自己的样式之后，令牌覆盖才生效
        (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css;
    console.log(`[${SLUG}] ${id}: ${css.length} 字节 / ${el.sheet?.cssRules.length ?? "?"} 条规则`);
}

Promise.all(LAYERS.map(injectLayer))
    .catch((e) => console.error(`[${SLUG}] 注入异常:`, e));

// 声音层：独立模块，仅注入一次；加载失败不影响皮肤与动效
if (!window.__lensSoundLoaded) {
    const soundUrl = assetUrl("lens-sound-bind.js");
    if (soundUrl) {
        window.__lensSoundLoaded = true;
        import(soundUrl).catch((e) => console.error(`[${SLUG}] 声音模块加载失败:`, e));
    } else {
        console.error(`[${SLUG}] 无法推导声音模块路径，跳过声音`);
    }
}

/*
 * 光源层：WebGL2 画布统一渲染所有控件的边缘光。
 * 所有控件共用同一个光源（鼠标位置）→ 真正联动，而不是只有鼠标下那一个。
 * 画布 pointer-events: none，不会吞掉 QQ 的点击。
 */
let lightModule = null;
if (!window.__lensLightLoaded) {
    const lightUrl = assetUrl("lens-light.js");
    if (lightUrl) {
        window.__lensLightLoaded = true;
        import(lightUrl)
            .then((m) => {
                lightModule = m;
                m.startGpuLight();
            })
            .catch((e) => console.error(`[${SLUG}] 光源模块加载失败:`, e));
    }
}

/* ---------- 调试工具命令接收端 ----------
 * 设置页与主界面是独立 JS 上下文，设置页的按钮无法直接操作主界面的 DOM。
 * 所以设置页把命令写进 localStorage，主界面在这里收到并执行
 * （复用与配置同步相同的 storage 事件通道）。
 */
const DEBUG_CMD_KEY = "lens-skin:debug-command";
if (!window.__lensDebugCmdBound) {
    window.__lensDebugCmdBound = true;
    let debugModule = null;
    let lastSeq = null;

    const loadDebug = async () => {
        if (debugModule) return debugModule;
        const url = assetUrl("lens-debug.js");
        if (!url) throw new Error("缺少 lens-debug.js");
        debugModule = await import(url);
        return debugModule;
    };

    window.addEventListener("storage", async (event) => {
        if (event.key !== DEBUG_CMD_KEY || !event.newValue) return;
        let msg;
        try { msg = JSON.parse(event.newValue); } catch { return; }
        if (!msg || !msg.command) return;
        if (msg.seq === lastSeq) return;            // 防重复执行
        lastSeq = msg.seq;
        /*
         * 【实测踩坑】命令用完必须立刻删掉（消费掉）。
         * storage 事件只在值变化时触发，但重启 QQ 后 renderer 重新注入，
         * 各窗口会重新读到 localStorage 里的旧命令并重放 ——
         * 表现为"每次重启都自动开调试工具"。所以先消费再执行。
         */
        try { localStorage.removeItem(DEBUG_CMD_KEY); } catch { }
        try {
            const m = await loadDebug();
            switch (msg.command) {
                case "start": m.startDebugTool(); break;
                case "stop": m.stopDebugTool(); break;
                case "box": m.startDebugTool(); m.setBoxMode(true); break;
                case "clear-clip": m.clearClip(); break;
                case "report": m.exportReport(); break;
                default: break;
            }
        } catch (e) {
            console.error(`[${SLUG}] 调试命令执行失败:`, e);
        }
    });

    /*
     * 启动自愈：清掉上回会话遗留的命令（超过 30 秒视为残留）。
     * 保证重启后不会被旧命令自动打开调试工具。
     */
    try {
        const raw = localStorage.getItem(DEBUG_CMD_KEY);
        if (raw) {
            let stale = true;
            try {
                const m = JSON.parse(raw);
                const t = Math.floor(Number(m && m.seq) || 0);
                if (t && Date.now() - t < 30000) stale = false;
            } catch { }
            if (stale) localStorage.removeItem(DEBUG_CMD_KEY);
        }
    } catch { }

    /*
     * 【已移除】"未启动时按 Ctrl+Shift+C 进入拾取"的引导入口。
     *
     * 原因：元素拾取已统一由 dsh-debug-logger 插件提供（那份实现更完整：
     * 多选、剪贴板、可自定义快捷键、设置页）。
     * 两个插件各留一套拾取器会互相干扰 —— 两个全屏覆盖层同时存在，
     * 命中测试时 lens 的覆盖层会被当成"命中的元素"返回，
     * 于是 dsh 选中的是"一整个全屏覆盖层"，而不是鼠标下的真实控件
     * （这正是用户反馈"选不中内部元素"的原因）。
     *
     * Lens 侧现在只保留 Ctrl+Shift+B 拖框限制渲染范围（由 lens-debug.js 自己监听）。
     */
}

/* ---------- 设置面板 ----------
 * LiteLoader 在每次打开插件设置页时调用这个钩子，传入该插件的容器元素。
 * 注意：renderer.js 由 loader 用 ESM 动态 import，其返回值不参与钩子注册，
 *       所以钩子通过全局函数暴露（loader 的 Runtime.registerPlugin 会查找导出），
 *       这里同时挂到 window 以便稳妥。
 */
const settingsUrl = assetUrl("lens-settings.js");
if (settingsUrl) {
    let settingsModule = null;
    const loadSettings = async () => {
        settingsModule = settingsModule || await import(settingsUrl);
        return settingsModule;
    };

    /*
     * 抽出"界面类设置"的应用逻辑。
     * 只挑界面相关字段传入，避免把声音设置也塞进 CSS 变量。
     */
    const applyUi = (m, config) => {
        if (!config) return;
        const { panelOpacity, panelBlur, lightEnabled, lightStrength } = config;
        if (panelOpacity === undefined && panelBlur === undefined &&
            lightEnabled === undefined && lightStrength === undefined) return;
        m.applyUiConfig({ panelOpacity, panelBlur, lightEnabled, lightStrength });
        // 光照强度变了要立刻重画 GPU 画布，否则要等下一次鼠标移动才看到变化
        if ((lightEnabled !== undefined || lightStrength !== undefined) && lightModule) {
            try { lightModule.refreshGpuLight(); } catch { }
        }
    };

    /*
     * 启动时应用已保存的界面设置（透明度 / 高斯模糊）。
     * 必须在每个窗口都跑：设置存在磁盘上，各窗口独立读取，
     * 否则重启后主界面会回到 CSS 里的默认值而不是用户选的值。
     */
    loadSettings()
        .then(async (m) => applyUi(m, await m.loadConfig()))
        .catch((e) => console.error(`[${SLUG}] 界面设置应用失败:`, e));

    // 跨窗口同步：在设置页改完，主界面立即跟随
    loadSettings()
        .then((m) => m.onConfigBroadcast((next) => applyUi(m, next)))
        .catch(() => { });

    // 同窗口同步：storage 事件不会在写入者自己的窗口触发（例如在设置页点"恢复默认"），
    // 所以本窗口还要听自己的 CustomEvent。
    window.addEventListener("lens:config-changed", (event) => {
        if (settingsModule) applyUi(settingsModule, event.detail || {});
    });

    const openSettings = async (view) => {
        try {
            const m = await loadSettings();
            const config = await m.loadConfig();
            // onChange 留空：saveConfig 内部已经统一广播（跨窗口 + 本窗口），
            // 这里再派发一次会造成重复应用。
            await m.renderSettings(view, config, () => { });
        } catch (e) {
            console.error(`[${SLUG}] 设置面板渲染失败:`, e);
        }
    };
    // 暴露给 loader 的 onSettingWindowCreated 钩子（两处冗余，兼容不同加载方式）
    window.lensSkinSettings = openSettings;
    globalThis.lensSkinSettings = openSettings;
}

export const onSettingWindowCreated = (view) => {
    if (typeof window.lensSkinSettings === "function") window.lensSkinSettings(view);
};
