// 截图的像素处理。跑在 Service Worker 里——SW 没有 DOM，但有 OffscreenCanvas
// 和 createImageBitmap，拼接和裁剪不需要额外开一个 offscreen 文档。

/** captureVisibleTab 给的是 data: URL，转成 ImageBitmap 才能画。 */
export async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function canvasToBlob(canvas, format) {
  const opts = { type: format.mimeType };
  if (format.quality != null) opts.quality = format.quality;
  return canvas.convertToBlob(opts);
}

/**
 * 裁剪：把可见区域截图按选区切出来。
 * 选区是 CSS 像素，截图是设备像素——比例用实际图宽除以视口宽算，
 * 不要直接信 devicePixelRatio：页面缩放、Windows 上的显示缩放都会让两者对不上。
 */
export async function cropCapture(dataUrl, rect, viewportCssWidth, format) {
  const bmp = await dataUrlToBitmap(dataUrl);
  const scale = bmp.width / (viewportCssWidth || bmp.width);
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.max(1, Math.min(Math.round(rect.w * scale), bmp.width - sx));
  const sh = Math.max(1, Math.min(Math.round(rect.h * scale), bmp.height - sy));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  bmp.close();
  const blob = await canvasToBlob(canvas, format);
  return { blob, width: sw, height: sh };
}

/** 单屏截图：只是把 data URL 转成 Blob，顺带拿到尺寸。 */
export async function encodeCapture(dataUrl, format) {
  const bmp = await dataUrlToBitmap(dataUrl);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  const { width, height } = bmp;
  bmp.close();
  const blob = await canvasToBlob(canvas, format);
  return { blob, width, height };
}

// Chrome 画布单边上限 32767 设备像素，超了 convertToBlob 直接失败
const MAX_CANVAS_SIDE = 32767;

/**
 * 整页拼接。
 * slices 是 [{ y, dataUrl }]，y 是那一屏实际停下的 CSS 滚动位置。
 * clip 是每一屏里要用的那块（CSS 像素、视口坐标）：滚 window 时是整个视口，
 * 滚内部容器时是容器的内容区。
 *
 * 按实际 y 逐屏往下画，重叠部分由后画的覆盖——页面到底时最后一屏没法再往下滚，
 * 必然和上一屏重叠，这样处理刚好正确，不需要单独算裁剪。
 */
export async function stitchFullPage(slices, { totalH, viewW, viewH, clip }, format) {
  if (!slices.length) throw new Error('没有可拼接的截图');
  clip ||= { x: 0, y: 0, w: viewW, h: viewH };

  const first = await dataUrlToBitmap(slices[0].dataUrl);
  // 比例用实际图宽 ÷ 视口宽，不信 devicePixelRatio
  const scale = first.width / (viewW || first.width);
  const sx = Math.max(0, Math.round(clip.x * scale));
  const sy = Math.max(0, Math.round(clip.y * scale));
  const sw = Math.max(1, Math.min(Math.round(clip.w * scale), first.width - sx));
  const sh = Math.max(1, Math.min(Math.round(clip.h * scale), first.height - sy));
  const outW = sw;
  const outH = Math.max(1, Math.min(Math.round(totalH * scale), MAX_CANVAS_SIDE));

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < slices.length; i++) {
    const bmp = i === 0 ? first : await dataUrlToBitmap(slices[i].dataUrl);
    const dy = Math.round(slices[i].y * scale);
    // 最后一屏可能比剩余高度还高，画超出去也没关系，canvas 会自己裁掉
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, dy, sw, sh);
    bmp.close();
  }

  const blob = await canvasToBlob(canvas, format);
  return { blob, width: outW, height: outH, sliceCount: slices.length };
}

/**
 * 把 CSS 像素的选区换算成视频帧里的裁剪框。
 *
 * 两个必须处理的约束：
 * 1. 选区是页面 CSS 像素，视频帧是设备像素，而且 tabCapture 还可能按 maxWidth 降采样过。
 *    比例只能用「实际帧宽 ÷ 视口 CSS 宽」算，devicePixelRatio 不可信。
 * 2. VideoFrame 的 visibleRect 在 I420 这类色度二次采样格式下要求坐标和尺寸都是偶数，
 *    传奇数会直接抛 TypeError，整条录制就断了。
 *
 * @param {{width:number,height:number}} frame 视频帧的实际像素尺寸
 * @param {{x:number,y:number,w:number,h:number}} rect 选区（CSS 像素）
 * @param {number} viewportCssWidth 选区所在视口的 CSS 宽度
 */
export function cropBox(frame, rect, viewportCssWidth) {
  const fw = Math.max(2, Math.floor(frame.width));
  const fh = Math.max(2, Math.floor(frame.height));
  const scale = viewportCssWidth > 0 ? fw / viewportCssWidth : 1;

  const floorEven = (n) => Math.max(0, Math.floor(n / 2) * 2);
  const clampEven = (n, max) => Math.max(2, Math.min(floorEven(n), floorEven(max)));

  let x = floorEven(Math.max(0, rect.x) * scale);
  let y = floorEven(Math.max(0, rect.y) * scale);
  // 起点先夹进画面，至少给裁剪框留 2px
  x = Math.min(x, floorEven(fw - 2));
  y = Math.min(y, floorEven(fh - 2));

  const width = clampEven(Math.max(2, rect.w) * scale, fw - x);
  const height = clampEven(Math.max(2, rect.h) * scale, fh - y);
  return { x, y, width, height };
}
