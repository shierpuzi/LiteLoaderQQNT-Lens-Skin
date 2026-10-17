/*
 * 回归检查：PCM 合成必须惰性化（只合成一次）。
 *
 * 锁住的 bug（实测让 QQ 卡死数次）：
 *   早期签名 buffer(name, pcm) 的 pcm 由【调用方提前求值】，
 *   即使缓存命中，synthesizeFriction() 依然每次都跑一遍。
 *   摩擦纹理是 2 秒噪声（约 96000 采样 + 滤波运算），
 *   滚动列表时每个滚轮事件都重算 → CPU/GC 爆炸 → 窗口卡死，
 *   同时 startFriction 反复重启导致"沙沙声停不下来"。
 *
 * 两项断言：
 *   A. 运行时：同名缓冲的工厂函数只应被调用一次（惰性契约）
 *   B. 源码：调用方必须传函数，不能提前求值（防止改回旧写法）
 *
 * 跑法：node lens-sound.check.mjs
 */
import { readFileSync } from "node:fs";
import { LensSound } from "./lens-sound.js";

class FakeNode {
    constructor() {
        this.gain = { value: 0, setTargetAtTime() { } };
        this.frequency = { value: 0, setTargetAtTime() { } };
        this.playbackRate = { value: 0, setTargetAtTime() { } };
        this.Q = { value: 0 };
    }
    connect() { return this; }
    disconnect() { }
}
class FakeContext {
    constructor() { this.sampleRate = 48000; this.destination = new FakeNode(); }
    createBuffer() { return { copyToChannel() { } }; }
}

const sound = new LensSound();
sound.context = new FakeContext();
sound.master = new FakeNode();

// A. 惰性契约
let factoryCalls = 0;
const make = () => { factoryCalls++; return new Float32Array(8); };
sound.buffer("probe", make);
sound.buffer("probe", make);
const runtimeOk = factoryCalls === 1;

// B. 源码守卫：调用点必须是 `this.buffer(x, () => synthesize...)` 形式。
//    判据：第二个参数若以标识符开头（如 synthesizeFriction）＝调用方提前求值了；
//    惰性写法必然以 `(` 开头（箭头函数）。
const src = readFileSync(new URL("./lens-sound.js", import.meta.url), "utf8");
const eagerCalls = [...src.matchAll(/this\.buffer\([^,]+,\s*([A-Za-z_$][\w$]*)/g)]
    .map(m => m[1]);
const sourceOk = eagerCalls.length === 0;

console.log(`A. 工厂调用次数: ${factoryCalls}（期望 1）`);
console.log(`B. 提前求值的 buffer 调用: ${eagerCalls.length} 处${eagerCalls.length ? " -> " + eagerCalls.join(" | ") : ""}`);

const ok = runtimeOk && sourceOk;
console.log(ok
    ? "PASS: PCM 合成惰性化生效，缓存不会被绕过"
    : "FAIL: 缓存被绕过，滚动时会把 CPU/GC 打爆并卡死 QQ");
process.exit(ok ? 0 : 1);
