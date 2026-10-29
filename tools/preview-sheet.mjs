// 生成三方案对比图：每个方案在 16/32/48/128 下的真实像素，分别放在浅色和深色工具栏底上。
import fs from 'node:fs';
import { render, CONCEPTS, encodePng } from './render-icons.mjs';

const SIZES = [16, 32, 48, 128];
const NAMES = { aperture: 'A  aperture', screen: 'B  screen', dot: 'C  dot', crimson: 'D  crimson' };
const CONCEPT_KEYS = ['aperture', 'screen', 'dot', 'crimson'];

const PAD = 26, GAP = 30, LABEL_W = 0, ROW_H = 128 + 46;
const CELL_W = 128 + GAP;
const W = PAD * 2 + CELL_W * SIZES.length;
const BAND_H = PAD + CONCEPT_KEYS.length * ROW_H;
const H = BAND_H * 2;

const px = new Uint8Array(W * H * 4);
const put = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const al = a / 255, ia = 1 - al;
  px[i]     = Math.round(r * al + px[i] * ia);
  px[i + 1] = Math.round(g * al + px[i + 1] * ia);
  px[i + 2] = Math.round(b * al + px[i + 2] * ia);
  px[i + 3] = 255;
};
const fillRect = (x0, y0, w, h, c) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, c[0], c[1], c[2], 255);
};

// 上半：浅色工具栏 #EDEEF2 ；下半：深色工具栏 #202124（Chrome 实际值）
fillRect(0, 0, W, BAND_H, [237, 238, 242]);
fillRect(0, BAND_H, W, BAND_H, [32, 33, 36]);

// 把渲染出的图标按原始像素贴上去（不缩放，看真实观感）
function stamp(canvas, size, ox, oy) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const a = Math.max(0, Math.min(1, canvas.a[i]));
      if (a <= 0) continue;
      const d = a > 0.0001 ? 1 / a : 0;
      put(ox + x, oy + y, canvas.r[i] * d, canvas.g[i] * d, canvas.b[i] * d, a * 255);
    }
  }
}

for (let band = 0; band < 2; band++) {
  const baseY = band * BAND_H + PAD;
  CONCEPT_KEYS.forEach((key, ci) => {
    SIZES.forEach((s, si) => {
      const cx = PAD + si * CELL_W + (128 - s) / 2;
      const cy = baseY + ci * ROW_H + (128 - s) / 2;
      stamp(render(key, s), s, Math.round(cx), Math.round(cy));
    });
  });
}

fs.mkdirSync('tools/preview', { recursive: true });
fs.writeFileSync('tools/preview/icon-concepts.png', encodePng(px, W, H));
console.log(`对比图 tools/preview/icon-concepts.png  ${W}x${H}`);
console.log('列（左→右）: 16px, 32px, 48px, 128px');
console.log('行（上→下）: ' + CONCEPT_KEYS.map((k) => NAMES[k]).join('  /  '));
console.log('上半浅色工具栏 #EDEEF2, 下半深色工具栏 #202124');
