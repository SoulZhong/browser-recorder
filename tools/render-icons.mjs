// 图标渲染器：超采样抗锯齿 + 线性/径向渐变 + 分尺寸微调。
// 用法：node tools/render-icons.mjs [concept]   concept = aperture | screen | dot
import zlib from 'node:zlib';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function encodePng(px, w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0]));                       // filter: none
    rows.push(Buffer.from(px.buffer, px.byteOffset + y * w * 4, w * 4));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 颜色 / 合成

const hex = (s) => {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** 画布用直通 alpha 存储，最后一次性转成 PNG 的非预乘格式。 */
class Canvas {
  constructor(n) { this.n = n; this.r = new Float64Array(n * n); this.g = new Float64Array(n * n);
                   this.b = new Float64Array(n * n); this.a = new Float64Array(n * n); }
  // source-over，输入是已按 alpha 加权的颜色贡献
  blend(i, color, alpha) {
    if (alpha <= 0) return;
    const ia = 1 - alpha;
    this.r[i] = color[0] * alpha + this.r[i] * ia;
    this.g[i] = color[1] * alpha + this.g[i] * ia;
    this.b[i] = color[2] * alpha + this.b[i] * ia;
    this.a[i] = alpha + this.a[i] * ia;
  }
  toPng() {
    const n = this.n, px = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      const a = clamp01(this.a[i]);
      // 存回非预乘：画布里存的是已合成的直通值，除以 alpha 还原
      const d = a > 0.0001 ? 1 / a : 0;
      px[i * 4]     = Math.round(clamp01(this.r[i] * d / 255) * 255);
      px[i * 4 + 1] = Math.round(clamp01(this.g[i] * d / 255) * 255);
      px[i * 4 + 2] = Math.round(clamp01(this.b[i] * d / 255) * 255);
      px[i * 4 + 3] = Math.round(a * 255);
    }
    return encodePng(px, n, n);
  }
}

// ---------------------------------------------------------------- 形状（SDF）

// 超椭圆（squircle）：|x/a|^k + |y/a|^k = 1。k=4 接近 iOS 图标的圆角质感。
const sdSquircle = (x, y, a, k) => Math.pow(Math.abs(x / a) ** k + Math.abs(y / a) ** k, 1 / k) - 1;
const sdCircle = (x, y, r) => Math.hypot(x, y) / r - 1;
// 圆角矩形：返回"到边界的归一化距离"，<0 在内部
function sdRoundRect(x, y, hw, hh, r) {
  const qx = Math.abs(x) - (hw - r), qy = Math.abs(y) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// ---------------------------------------------------------------- 三个方案

/**
 * 每个方案是一个 (u, v, S, hints) => layers 的函数。
 * u,v ∈ [-1,1] 归一化坐标（原点在中心），S = 输出边长（用于分尺寸微调）。
 * 返回 [{color:[r,g,b], alpha}]，按顺序 source-over 合成。
 */

const GRAPHITE_TOP = hex('#333949');
const GRAPHITE_BOT = hex('#14161D');
const RED_HI = hex('#FF5C68');
const RED_LO = hex('#D81E33');
const INK = hex('#0A0B0F');
const CRIMSON_TOP = hex('#FF6470');
const CRIMSON_BOT = hex('#D0142A');
const PAPER = hex('#F4F6FA');

/** 深色 squircle 底板：竖向渐变 + 顶部高光 + 外缘暗边。 */
function tile(u, v, S, out) {
  const px = 2 / S;                       // 一个像素在归一化坐标里的宽度
  const d = sdSquircle(u, v, 0.94, 4.2);
  const cov = 1 - smooth(-px * 0.9, px * 0.9, d);
  if (cov <= 0) return 0;

  // 竖向渐变，顶部亮
  const ground = mix(GRAPHITE_TOP, GRAPHITE_BOT, smooth(-0.95, 0.95, v));
  out.push({ color: ground, alpha: cov });

  // 顶部内高光：贴着上边缘的一道亮线，模拟自上而来的光
  const rim = smooth(-px * 2.2, 0, d) * (1 - smooth(0, px * 1.2, d));
  const topLit = clamp01(-v - 0.15) * 1.35;
  out.push({ color: [255, 255, 255], alpha: cov * rim * topLit * 0.5 });

  // 底部内暗边，压住形体
  const botShade = clamp01(v - 0.2) * 1.2;
  out.push({ color: INK, alpha: cov * rim * botShade * 0.45 });
  return cov;
}

/** 红色 squircle 底板：明暗工具栏上都能压住，是唯一在 16px 两种底色都成立的方案。 */
function crimsonTile(u, v, S, out) {
  const px = 2 / S;
  const d = sdSquircle(u, v, 0.94, 4.2);
  const cov = 1 - smooth(-px * 0.9, px * 0.9, d);
  if (cov <= 0) return 0;
  const ground = mix(CRIMSON_TOP, CRIMSON_BOT, smooth(-0.95, 0.95, v));
  out.push({ color: ground, alpha: cov });
  const rim = smooth(-px * 2.2, 0, d) * (1 - smooth(0, px * 1.2, d));
  out.push({ color: [255, 255, 255], alpha: cov * rim * clamp01(-v - 0.15) * 1.35 * 0.55 });
  out.push({ color: INK, alpha: cov * rim * clamp01(v - 0.2) * 1.2 * 0.30 });
  return cov;
}

/** 实心屏幕块（白），带底座。用于红底方案，靠色块而非细描边保住小尺寸。 */
function solidScreen(u, v, S, out, hw, hh, rr, withStand) {
  const px = 2 / S;
  const d = sdRoundRect(u, v, hw, hh, rr);
  out.push({ color: PAPER, alpha: (1 - smooth(-px * 0.8, px * 0.8, d)) * 0.97 });
  if (withStand) {
    const st = sdRoundRect(u, v - hh - 0.16, 0.20, 0.035, 0.035);
    out.push({ color: PAPER, alpha: (1 - smooth(-px * 0.8, px * 0.8, st)) * 0.97 });
  }
}

/** 红色录制点：径向渐变（左上受光）+ 一点高光。 */
function recordDot(u, v, S, r, out, glow = true) {
  const px = 2 / S;
  const d = sdCircle(u, v, r);
  const cov = 1 - smooth(-px * 0.9, px * 0.9, d);

  if (glow && S >= 48) {
    // 外围柔光，把红点从深底上"托"起来
    const g = 1 - smooth(0, 1.15, Math.hypot(u, v) / r);
    out.push({ color: RED_LO, alpha: g * 0.16 });
  }
  if (cov <= 0) return;

  // 光源在左上：沿 (-0.45,-0.45) 方向做径向混合
  const t = clamp01((u * 0.42 + v * 0.42) / r * 0.85 + 0.42);
  out.push({ color: mix(RED_HI, RED_LO, t), alpha: cov });

  if (S >= 48) {
    // 左上高光小点
    const hx = u + r * 0.34, hy = v + r * 0.34;
    const h = 1 - smooth(0, r * 0.52, Math.hypot(hx, hy));
    out.push({ color: [255, 255, 255], alpha: cov * h * 0.30 });
  }
}

/** 环形描边（浅色）。w = 线宽（归一化）。 */
function ring(u, v, S, r, w, out, color = PAPER, alpha = 1) {
  const px = 2 / S;
  const dist = Math.hypot(u, v);
  const cov = smooth(r - w / 2 - px * 0.8, r - w / 2 + px * 0.8, dist)
            * (1 - smooth(r + w / 2 - px * 0.8, r + w / 2 + px * 0.8, dist));
  if (cov > 0) out.push({ color, alpha: cov * alpha });
}

const CONCEPTS = {
  // A. 光圈录制键 —— 底板 + 白环 + 红点。经典录制语义，克制。
  aperture(u, v, S, out) {
    if (S < 48) return CONCEPTS.dot(u, v, S, out);
    if (!tile(u, v, S, out)) return;
    {
      ring(u, v, S, 0.60, S >= 96 ? 0.075 : 0.095, out, PAPER, 0.92);
      recordDot(u, v, S, 0.32, out);
    }
  },

  // B. 屏幕录制 —— 底板 + 屏幕轮廓 + 红点。语义最准："在屏幕上录"。
  screen(u, v, S, out) {
    if (S < 48) return CONCEPTS.dot(u, v, S, out);
    if (!tile(u, v, S, out)) return;
    const px = 2 / S;
    {
      const hw = 0.62, hh = 0.46, rr = 0.13;
      const w = S >= 96 ? 0.068 : 0.088;
      const d = sdRoundRect(u, v + 0.06, hw, hh, rr);
      const cov = smooth(-w / 2 - px * 0.8, -w / 2 + px * 0.8, d)
                * (1 - smooth(w / 2 - px * 0.8, w / 2 + px * 0.8, d));
      out.push({ color: PAPER, alpha: cov * 0.94 });
      // 底座
      const st = sdRoundRect(u, v - 0.62, 0.20, w / 2, w / 2);
      out.push({ color: PAPER, alpha: (1 - smooth(-px * 0.8, px * 0.8, st)) * 0.94 });
      recordDot(u, v + 0.06, S, 0.17, out);
    }
  },

  // D. 红底屏幕 —— 红色底板 + 白色实心屏幕 + 红色录制点。三层高对比，明暗工具栏通吃。
  crimson(u, v, S, out) {
    if (!crimsonTile(u, v, S, out)) return;
    if (S >= 96)      { solidScreen(u, v + 0.05, S, out, 0.60, 0.44, 0.12, true);  recordDot(u, v + 0.05, S, 0.17, out, false); }
    else if (S >= 48) { solidScreen(u, v + 0.04, S, out, 0.60, 0.44, 0.12, true);  recordDot(u, v + 0.04, S, 0.18, out, false); }
    else if (S >= 32) { solidScreen(u, v,        S, out, 0.56, 0.42, 0.11, false); recordDot(u, v, S, 0.20, out, false); }
    else              { solidScreen(u, v,        S, out, 0.56, 0.42, 0.11, false); recordDot(u, v, S, 0.22, out, false); }
  },

  // C. 纯录制点 —— 无底板，红环 + 红点。工具栏里最轻，明暗背景都可见。
  dot(u, v, S, out) {
    if (S >= 48) {
      ring(u, v, S, 0.74, S >= 96 ? 0.10 : 0.13, out, RED_LO, 0.95);
      recordDot(u, v, S, 0.42, out);
    } else {
      recordDot(u, v, S, S >= 32 ? 0.62 : 0.70, out, false);
    }
  },
};

// ---------------------------------------------------------------- 渲染

const SS = 6; // 每像素 6x6 超采样

function render(concept, size) {
  const fn = CONCEPTS[concept];
  const c = new Canvas(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          const u = (px / size) * 2 - 1, v = (py / size) * 2 - 1;
          const layers = [];
          fn(u, v, size, layers);
          // 子样本内部先合成
          let r = 0, g = 0, b = 0, a = 0;
          for (const L of layers) {
            const al = clamp01(L.alpha);
            if (al <= 0) continue;
            const ia = 1 - al;
            r = L.color[0] * al + r * ia; g = L.color[1] * al + g * ia;
            b = L.color[2] * al + b * ia; a = al + a * ia;
          }
          ar += r; ag += g; ab += b; aa += a;
        }
      }
      const n = SS * SS;
      c.r[i] = ar / n; c.g[i] = ag / n; c.b[i] = ab / n; c.a[i] = aa / n;
    }
  }
  return c;
}

export const SHIPPING_CONCEPT = 'screen';
export { render, CONCEPTS, encodePng, Canvas };

// 仅在被直接执行时写盘。被 preview-sheet.mjs import 时不能跑，
// 否则会拿默认方案覆盖掉正在使用的正式图标。
const runAsCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (runAsCli) {
  const concept = process.argv[2] || SHIPPING_CONCEPT;
  if (!CONCEPTS[concept]) {
    console.error(`未知方案: ${concept}（可选 ${Object.keys(CONCEPTS).join(', ')}）`);
    process.exit(1);
  }
  fs.mkdirSync('icons', { recursive: true });
  for (const s of [16, 32, 48, 128]) {
    fs.writeFileSync(`icons/icon${s}.png`, render(concept, s).toPng());
  }
  console.log(`已渲染方案「${concept}」→ icons/icon{16,32,48,128}.png`);
}
