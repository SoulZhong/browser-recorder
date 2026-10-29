// 全局常量与录制预设。

export const DB_NAME = 'browser-recorder';
export const DB_VERSION = 1;
export const STORE_RECORDINGS = 'recordings';
export const STORE_CHUNKS = 'chunks';

/**
 * MediaRecorder 的 timeslice。每 3 秒吐出一个分片并立刻落盘 IndexedDB，
 * 这是"边录边存"的关键：内存不随时长增长，浏览器崩溃也只丢最后 3 秒。
 */
export const TIMESLICE_MS = 3000;

export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
export const PLAYER_PATH = 'src/player/player.html';
export const PERMISSION_PATH = 'src/permission/permission.html';

/** 库里两类产物：录像和截图。老记录没有这个字段，一律当视频。 */
export const KIND = {
  VIDEO: 'video',
  IMAGE: 'image',
};
export const kindOf = (rec) => (rec?.kind === KIND.IMAGE ? KIND.IMAGE : KIND.VIDEO);

/** 截图模式 */
export const SHOT = {
  VISIBLE: 'visible',   // 当前可见区域
  FULL: 'full',         // 整个页面（滚动拼接）
  AREA: 'area',         // 拖拽选定区域
};

export const SHOT_LABEL = {
  [SHOT.VISIBLE]: '可见区域',
  [SHOT.FULL]: '整个页面',
  [SHOT.AREA]: '选定区域',
};

export const IMAGE_FORMAT = {
  PNG: { mimeType: 'image/png', ext: 'png', label: 'PNG · 无损' },
  JPEG: { mimeType: 'image/jpeg', ext: 'jpg', label: 'JPEG · 体积小', quality: 0.92 },
};

/**
 * chrome.tabs.captureVisibleTab 有每秒 2 次的硬限流（MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND）。
 * 整页拼接要连续截很多张，必须按这个节奏走，否则会拿到
 * "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded" 而不是图片。
 */
export const CAPTURE_INTERVAL_MS = 520;

/**
 * 整页拼接的高度上限（设备像素）。Chrome 画布单边最多 32767，超了直接编码失败；
 * 内容脚本会按 devicePixelRatio 换成 CSS 像素再截断。
 */
export const MAX_FULLPAGE_HEIGHT = 32000;

export const MODE = {
  TAB: 'tab',       // 当前标签页
  AREA: 'area',     // 标签页里拖拽选定的区域
  SCREEN: 'screen', // 整个屏幕 / 窗口（desktopCapture 选择器）
  CAMERA: 'camera', // 仅摄像头
};

export const MODE_LABEL = {
  [MODE.TAB]: '标签页',
  [MODE.AREA]: '选定区域',
  [MODE.SCREEN]: '整个屏幕',
  [MODE.CAMERA]: '摄像头',
};

/** 默认标题用的名字。按钮文案（MODE_LABEL）要短，标题要读得顺，两者不通用。 */
export const MODE_TITLE = {
  [MODE.TAB]: '标签页录制',
  [MODE.AREA]: '区域录制',
  [MODE.SCREEN]: '屏幕录制',
  [MODE.CAMERA]: '摄像头录制',
};

/**
 * H.264 硬件编码器的常见上限（Level 5.x）。超过就是
 * "EncodingError: The given encoder configuration is not supported by the encoder"，
 * 录制会在开始的瞬间中止。区域录制必须把输出压在这个框里。
 */
export const MAX_ENCODE_W = 4096;
export const MAX_ENCODE_H = 2304;

/**
 * 区域录制的采集尺寸。
 *
 * 别拍一个巨大的 maxWidth 上去——tabCapture 会真的按这个尺寸出帧，
 * 把 3584×2240 的标签页上采样到 7680×4320，既浪费又让裁剪结果直接撞穿编码器上限。
 * 正确做法是按视口的实际设备像素采集（1:1），必要时整体等比缩小让裁剪结果落进编码上限。
 */
export function areaSourceSize(region, fallback) {
  const dpr = Number(region?.dpr) > 0 ? Number(region.dpr) : 1;
  const vw = Number(region?.viewportWidth) > 0 ? Number(region.viewportWidth) : 0;
  const vh = Number(region?.viewportHeight) > 0 ? Number(region.viewportHeight) : 0;
  if (!vw || !vh) return { width: fallback.width, height: fallback.height, scale: 1 };

  let width = Math.round(vw * dpr);
  let height = Math.round(vh * dpr);

  // 裁剪结果超出编码上限时，把整个采集源等比缩小——缩源比缩裁剪框简单可靠，
  // 裁剪比例是按实际帧宽算的，源一缩，裁剪框自然跟着缩。
  const cropW = Math.max(1, Number(region.rect?.w) || 0) * dpr;
  const cropH = Math.max(1, Number(region.rect?.h) || 0) * dpr;
  const over = Math.max(cropW / MAX_ENCODE_W, cropH / MAX_ENCODE_H, 1);
  if (over > 1) {
    width = Math.max(2, Math.round(width / over));
    height = Math.max(2, Math.round(height / over));
  }
  return { width, height, scale: 1 / over };
}

/** 走 tabCapture 的模式（区域录制本质上是裁过的标签页录制）。 */
export const isTabSource = (mode) => mode === MODE.TAB || mode === MODE.AREA;

export const QUALITY = {
  '480p':  { label: '流畅 480p',  width: 854,  height: 480,  fps: 30, videoBps: 1_000_000 },
  '720p':  { label: '标清 720p',  width: 1280, height: 720,  fps: 30, videoBps: 2_500_000 },
  '1080p': { label: '高清 1080p', width: 1920, height: 1080, fps: 30, videoBps: 5_000_000 },
  'max':   { label: '原画 4K60',  width: 3840, height: 2160, fps: 60, videoBps: 12_000_000 },
};

export const AUDIO_BPS = 128_000;

export const FORMAT = {
  MP4: 'mp4',    // H.264 + AAC，剪辑软件 / 办公软件 / 微信都能直接吃
  WEBM: 'webm',  // VP9 + Opus，同码率画质更好，体积更小
};

/**
 * 按优先级挑选编码器。实际可用性要用 MediaRecorder.isTypeSupported 逐个探测：
 * MP4 录制是 Chrome 130 才有的能力，且 H.264 编码依赖平台硬件编码器。
 */
export const MIME_CANDIDATES = {
  [FORMAT.MP4]: [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H.264 baseline + AAC，兼容性最好
    'video/mp4;codecs=avc1.4D401F,mp4a.40.2', // H.264 main
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
  ],
  [FORMAT.WEBM]: [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ],
};

/** 面向用户的容器名（Blob.type 会被规范小写化，展示时不要直接用它）。 */
export const FORMAT_NAME = {
  [FORMAT.MP4]: 'MP4',
  [FORMAT.WEBM]: 'WebM',
};

export const FORMAT_LABEL = {
  [FORMAT.MP4]: 'MP4 · 通用兼容',
  [FORMAT.WEBM]: 'WebM · 体积更小',
};

/** 从实际使用的 mimeType 反推容器，用于文件扩展名和读取侧的 duration 修复。 */
export function formatOf(mimeType = '') {
  return mimeType.startsWith('video/mp4') ? FORMAT.MP4 : FORMAT.WEBM;
}

export const extOf = (mimeType) => (formatOf(mimeType) === FORMAT.MP4 ? 'mp4' : 'webm');
export const nameOf = (mimeType) => FORMAT_NAME[formatOf(mimeType)];

export const STATUS = {
  RECORDING: 'recording',
  DONE: 'done',
  INTERRUPTED: 'interrupted', // 进程被杀/崩溃，分片仍然可播
  ERROR: 'error',
};

export const DEFAULT_SETTINGS = {
  tool: 'record',        // 弹窗停留在哪个页签：record | shot
  shot: SHOT.VISIBLE,
  shotFormat: 'PNG',
  shotDelay: 0,
  mode: MODE.TAB,
  format: FORMAT.MP4,
  quality: '1080p',
  mic: false,
  micDeviceId: '',
  systemAudio: true,
  camera: false,
  cameraDeviceId: '',
  countdown: 3,
};
