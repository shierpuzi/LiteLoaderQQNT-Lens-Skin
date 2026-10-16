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

/* ---------- 设置面板 ----------
 * LiteLoader 在每次打开插件设置页时调用这个钩子，传入该插件的容器元素。
 * 注意：renderer.js 由 loader 用 ESM 动态 import，其返回值不参与钩子注册，
 *       所以钩子通过全局函数暴露（loader 的 Runtime.registerPlugin 会查找导出），
 *       这里同时挂到 window 以便稳妥。
 */
const settingsUrl = assetUrl("lens-settings.js");
if (settingsUrl) {
    let settingsModule = null;
    const openSettings = async (view) => {
        try {
            settingsModule = settingsModule || await import(settingsUrl);
            const config = await settingsModule.loadConfig();
            // onChange 留空：saveConfig 内部已经统一广播（跨窗口 + 本窗口），
            // 这里再派发一次会造成重复应用。
            await settingsModule.renderSettings(view, config, () => { });
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
