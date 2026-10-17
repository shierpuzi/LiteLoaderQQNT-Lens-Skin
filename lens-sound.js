/**
 * Lens 音频原语 — 移植自 Lens 设计系统
 * 来源: ruiqichenbiec/design-systems · lens/lab/design-system/sound.js (MIT)
 *
 * 保留原版的核心：全部声音由 Web Audio 实时合成，不含任何音频文件、不联网。
 *   - synthesizeCue:     短促提示音（正弦扫频 + 滤波噪声，指数衰减包络）
 *   - synthesizeFriction: 2 秒循环摩擦纹理，由播放速率与带通滤波映射速度
 *
 * 裁剪（相对原版 GlassSound）：
 *   - 去掉 localStorage 偏好持久化、onChange 回调、register 自定义音效
 *   - 只保留本项目要用的音效与摩擦音，音量固定
 *   ponytail: 音量不可调，需要时把 volume 接出来即可。
 */

/** 短音效定义：duration 秒 · tones [起始Hz, 结束Hz, 增益, 延迟秒] · noise 噪声量 · cooldown 毫秒 */
export const CUES = Object.freeze({
    // 图一：发送按钮 —— Lens 的 success 原语
    success: { duration: .28, tones: [[660, 660, .15], [990, 990, .085, .085]] },
    // 图二：控件点击 —— Lens 的 select 原语
    select: { duration: .105, tones: [[760, 620, .17], [1140, 960, .035]] },
    // 悬浮反馈：鼠标划过控件时轻响一声
    // cooldown 防止快速滑动鼠标变成密集爆音：
    //   70ms（原版默认）过密；140ms 显得迟钝；95ms 是实测折中。
    grab: { duration: .12, tones: [[210, 340, .21], [520, 430, .045]], cooldown: 95 },
});

/** 原版逐字保留：合成一段短提示音的 PCM */
export function synthesizeCue(definition, sampleRate = 48000) {
    const d = definition;
    if (!d || !Number.isFinite(d.duration) || d.duration <= 0 || d.duration > 1 ||
        !Array.isArray(d.tones) || !d.tones.length) throw new TypeError('Invalid sound cue');
    const data = new Float32Array(Math.ceil(d.duration * sampleRate));
    let random = 1709, filtered = 0;
    for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate, tail = Math.min(1, (data.length - 1 - i) / Math.max(1, sampleRate * .012));
        let sample = 0;
        for (const [from, to, gain, delay = 0] of d.tones) {
            const u = t - delay;
            if (u < 0) continue;
            const length = d.duration - delay;
            const phase = 2 * Math.PI * (from * u + (to - from) * u * u / (2 * length));
            sample += Math.sin(phase) * gain * Math.min(1, u / .004) * Math.exp(-u * 7 / length);
        }
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        filtered = .58 * filtered + .42 * (random / 4294967295 * 2 - 1);
        sample += filtered * (d.noise || 0) * Math.min(1, t / .003) * Math.exp(-t * 12 / d.duration);
        data[i] = Math.max(-.8, Math.min(.8, sample)) * tail;
    }
    return data;
}

/** 原版逐字保留：合成 2 秒摩擦纹理（纸面颗粒 + 玻璃共振） */
export function synthesizeFriction(sampleRate = 48000) {
    const data = new Float32Array(Math.round(sampleRate * 2));
    let random = 4217, low = 0, grain = 0;
    for (let i = 0; i < data.length; i++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const white = random / 4294967295 * 2 - 1, t = i / sampleRate;
        low += .035 * (white - low); grain += .32 * (white - grain);
        const texture = (grain - low) * .72 + white * .10;
        const envelope = .78 + .13 * Math.sin(2 * Math.PI * 37 * t) + .09 * Math.sin(2 * Math.PI * 83 * t);
        const seam = Math.min(1, i / (sampleRate * .006), (data.length - 1 - i) / (sampleRate * .006));
        data[i] = texture * envelope * seam;
    }
    return data;
}

export class LensSound {
    constructor({ volume = .28, cooldown = 70, maxVoices = 6, frictionGain = .42 } = {}) {
        this._volume = volume;
        this.cooldown = cooldown;
        this.maxVoices = maxVoices;
        // 摩擦音的最大增益。原版为 .42，实测在 QQ 里偏响，调到 .22。
        this.frictionGain = frictionGain;
        this.context = null;
        this.voices = new Set();
        this.cache = new Map();
        this.last = new Map();
        this.friction = null;
        this.frictionIntent = false;
        this.frictionSpeed = 0;
        this.frictionTimer = 0;
        this.enabled = true;
    }

    /*
     * 音量必须在写入时同步到音频图。
     * 原来只在创建 AudioContext 时设过一次 master.gain，
     * 之后 sound.volume = x 只改了字段值、对实际声音毫无影响 ——
     * 表现就是"拖动音量滑杆没反应，重启后才生效"。
     */
    get volume() { return this._volume; }
    set volume(value) {
        const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : this._volume;
        this._volume = v;
        if (this.master) this.master.gain.value = v;
    }

    ensureContext() {
        if (!this.context) {
            const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!Ctor) { this.enabled = false; return false; }
            this.context = new Ctor();
            this.master = this.context.createGain();
            this.master.gain.value = this._volume;   // 用 _volume，setter 在 master 存在前无副作用
            this.master.connect(this.context.destination);
        }
        return true;
    }

    /*
     * 惰性缓冲缓存。
     *
     * 【实测踩坑，改动前务必读】早期签名是 buffer(name, pcm)，
     * 但 pcm 参数由调用方【提前求值】——即使缓存命中，
     * synthesizeFriction() / synthesizeCue() 依然每次都跑一遍。
     * 摩擦纹理是 2 秒噪声（约 96000 个采样 + 滤波运算），
     * 滚动列表时每个滚轮事件都重算一次 → CPU/GC 爆炸 → 整个窗口卡死，
     * 同时 startFriction 反复重启导致"沙沙声停不下来"。
     * 改成接收工厂函数：只有缓存未命中时才真正合成。
     */
    buffer(name, makePcm) {
        let buf = this.cache.get(name);
        if (!buf) {
            const pcm = makePcm();
            buf = this.context.createBuffer(1, pcm.length, this.context.sampleRate);
            buf.copyToChannel(pcm, 0);
            this.cache.set(name, buf);
        }
        return buf;
    }

    /** 摩擦音是否正在播放（用于避免重复 startFriction 造成的重启爆音） */
    get frictionActive() {
        return !!this.friction;
    }

    play(name) {
        if (!this.enabled || !this.volume) return false;
        const cue = CUES[name];
        if (!cue) return false;
        const now = performance.now();
        if (now - (this.last.get(name) ?? -Infinity) < (cue.cooldown ?? this.cooldown)) return false;
        this.last.set(name, now);
        try {
            if (!this.ensureContext()) return false;
            if (this.context.state === 'suspended') this.context.resume();
            const buf = this.buffer(name, () => synthesizeCue(cue, this.context.sampleRate));
            if (this.voices.size >= this.maxVoices) {
                const oldest = this.voices.values().next().value;
                try { oldest.stop(); oldest.disconnect(); } catch { }
                this.voices.delete(oldest);
            }
            const src = this.context.createBufferSource();
            src.buffer = buf;
            src.connect(this.master);
            this.voices.add(src);
            src.onended = () => { src.disconnect(); this.voices.delete(src); };
            src.start();
            return true;
        } catch { return false; }
    }

    startFriction() {
        this.endFriction(true);
        if (!this.enabled || !this.volume) return false;
        this.frictionIntent = true;
        try {
            if (!this.ensureContext()) { this.frictionIntent = false; return false; }
            if (this.context.state === 'suspended') this.context.resume();
            const buf = this.buffer('@friction', () => synthesizeFriction(this.context.sampleRate));
            const source = this.context.createBufferSource(), filter = this.context.createBiquadFilter(), gain = this.context.createGain();
            source.buffer = buf; source.loop = true;
            filter.type = 'bandpass'; filter.Q.value = .65;
            gain.gain.value = 0;
            source.connect(filter); filter.connect(gain); gain.connect(this.master);
            const voice = { source, filter, gain };
            this.friction = voice;
            source.onended = () => {
                source.disconnect(); filter.disconnect(); gain.disconnect();
                if (this.friction === voice) this.friction = null;
            };
            source.start();
            this.updateFriction(this.frictionSpeed);
            return true;
        } catch { this.endFriction(true); return false; }
    }

    /** speed 为像素/秒；原版映射：(speed-8)/1100 夹到 0..1 · scale 用于分场景微调响度 */
    updateFriction(speed = 0, scale = 1) {
        if (!this.frictionIntent) return;
        this.frictionSpeed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
        const amount = Math.min(1, Math.max(0, (this.frictionSpeed - 8) / 1100));
        if (this.friction) {
            const { source, filter, gain } = this.friction, time = this.context.currentTime;
            gain.gain.setTargetAtTime(Math.pow(amount, .55) * this.frictionGain * scale, time, .025);
            filter.frequency.setTargetAtTime(650 + amount * 1900, time, .035);
            source.playbackRate.setTargetAtTime(.82 + amount * .45, time, .035);
        }
        clearTimeout(this.frictionTimer);
        if (this.frictionSpeed > 0) this.frictionTimer = setTimeout(() => this.updateFriction(0), 90);
    }

    endFriction(immediate = false) {
        this.frictionIntent = false;
        this.frictionSpeed = 0;
        clearTimeout(this.frictionTimer);
        const voice = this.friction;
        if (!voice) return;
        this.friction = null;
        try {
            voice.gain.gain.setTargetAtTime(0, this.context.currentTime, .018);
            voice.source.stop(this.context.currentTime + (immediate ? 0 : .09));
            if (immediate) { voice.source.disconnect(); voice.filter.disconnect(); voice.gain.disconnect(); }
        } catch { }
    }
}
