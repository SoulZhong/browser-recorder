// Service Worker：编排者。
// 它自己不碰媒体流——只负责拿 streamId、管理 offscreen 文档生命周期、
// 注入页面覆层、维护徽标。真正的录制活在 offscreen 里，
// 所以 SW 被回收也不会中断录制。
//
// 支持多路并发：会话状态是 recordingId -> 元信息 的对象，存在
// chrome.storage.session 里（SW 重启后仍在）。控制界面只有扩展弹窗一个。

import {
  MODE, OFFSCREEN_PATH, PLAYER_PATH, PERMISSION_PATH, DEFAULT_SETTINGS, FORMAT_NAME,
  SHOT, SHOT_LABEL, IMAGE_FORMAT, CAPTURE_INTERVAL_MS, MAX_FULLPAGE_HEIGHT, isTabSource,
} from '../lib/constants.js';
import { reconcileInterrupted, listRecordings, patchRecording, createCapture } from '../lib/db.js';
import { encodeCapture, cropCapture, stitchFullPage } from '../lib/capture.js';
import { fmtBadge } from '../lib/format.js';

const SESSIONS_KEY = 'recordingSessions';

const BADGE_REC = '#f03e4e';
const BADGE_PAUSED = '#8a8f9c';

// ---------------------------------------------------------------- 会话状态

async function getSessions() {
  return (await chrome.storage.session.get(SESSIONS_KEY))[SESSIONS_KEY] || {};
}
const setSessions = (map) =>
  (Object.keys(map).length
    ? chrome.storage.session.set({ [SESSIONS_KEY]: map })
    : chrome.storage.session.remove(SESSIONS_KEY));

async function putSession(rec) {
  const all = await getSessions();
  all[rec.recordingId] = rec;
  await setSessions(all);
  return all;
}
async function dropSession(recordingId) {
  const all = await getSessions();
  const removed = all[recordingId] || null;
  delete all[recordingId];
  await setSessions(all);
  return { removed, remaining: all };
}
const sessionList = async () => Object.values(await getSessions());

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---------------------------------------------------------------- offscreen

async function offscreenExists() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'BLOBS'],
    justification: '在后台运行 MediaRecorder 采集音视频，并把分片写入本地 IndexedDB。',
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

async function closeOffscreen() {
  if (await offscreenExists()) {
    try { await chrome.offscreen.closeDocument(); } catch {}
  }
}

/**
 * 给每一步加上下文。
 * 浏览器抛出来的 "Invalid state"、"Not supported" 这类裸消息，单独看完全无法定位——
 * 用户只能看到四个字，我们也不知道是采集、编码还是存储出的问题。
 * 包一层之后消息变成「获取标签页采集源失败：Invalid state」，一眼就知道去哪查。
 */
/** 开始录制的每一步都留一行痕迹。整条链路横跨 SW / offscreen / 内容脚本，
 *  出问题时没有这个就只能靠猜。 */
const trace = (...a) => console.log('[recorder]', ...a);

async function step(label, fn) {
  try {
    const r = await fn();
    trace(`✓ ${label}`);
    return r;
  } catch (err) {
    const raw = err?.message || String(err);
    console.error(`[recorder] ${label}失败`, err);
    const wrapped = new Error(`${label}失败：${raw}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

/** 与 offscreen 通信，统一拆包 {ok,data,error}。 */
async function toOffscreen(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload });
  if (!res) throw new Error('offscreen 无响应');
  if (!res.ok) throw new Error(res.error || 'offscreen 执行失败');
  return res.data;
}

// ---------------------------------------------------------------- 徽标

/**
 * chrome.action.* 一律走这里。
 * 这些调用如果同步抛错（API 不存在、参数被拒），会把整个 onMessage 监听器打死——
 * 之后每一次 REC_TICK 都进不来，徽标就永远停在最后一个值上，而且没有任何报错可见。
 * 徽标是纯装饰，任何失败都不该影响录制，所以整体吞掉并只记一次日志。
 */
let actionWarned = false;
function safeAction(method, arg) {
  try {
    const r = chrome.action?.[method]?.(arg);
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (err) {
    if (!actionWarned) { actionWarned = true; console.warn('[recorder] chrome.action 不可用，徽标已降级', err); }
  }
}

function setBadge(text, color = BADGE_REC) {
  safeAction('setBadgeText', { text });
  safeAction('setBadgeBackgroundColor', { color });
}
const setTitle = (title) => safeAction('setTitle', { title });

/**
 * 徽标只有约 4 个字符可读，多路并发时塞不下所有时长。
 * 单路 → 显示时长；多路 → 显示路数，明细放进悬浮提示。
 */
function paintBadge(list) {
  if (!list.length) { setBadge(''); setTitle('开始录制'); return; }
  const allPaused = list.every((x) => x.paused);
  const color = allPaused ? BADGE_PAUSED : BADGE_REC;
  if (list.length === 1) {
    setBadge(fmtBadge(list[0].elapsedMs), color);
    setTitle(`${list[0].paused ? '已暂停' : '正在录制'} · ${list[0].title || ''}`);
    return;
  }
  setBadge(String(list.length), color);
  const lines = list.map((x) => `${x.paused ? '⏸' : '●'} ${x.title || x.recordingId} ${fmtBadge(x.elapsedMs)}`);
  setTitle([`${list.length} 路录制进行中`, ...lines].join('\n'));
}

// ---------------------------------------------------------------- 页面覆层

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/overlay.js'] });
    return true;
  } catch {
    return false; // chrome:// / Web Store 等受保护页面注入不了，静默降级
  }
}

const tellTab = async (tabId, msg) => {
  try { return await chrome.tabs.sendMessage(tabId, msg); } catch { return null; }
};

// ---------------------------------------------------------------- 窗口

/**
 * 扩展页必须开在普通窗口里，不能开在无痕窗口。
 *
 * 扩展是 spanning 模式：全局只有一份实例、一份存储，录制分片落在常规 profile 的
 * IndexedDB 里。如果 tabs.create 不指定窗口，它会开在当前聚焦的窗口——在无痕里录制时
 * 那就是无痕窗口，而那个上下文读不到常规 profile 的库，用户看到的就是
 * "点了结束什么都没发生 / 录制库是空的"。
 */
async function openExtensionTab(url) {
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const normal = wins.find((w) => !w.incognito);
    if (normal) {
      const tab = await chrome.tabs.create({ url, windowId: normal.id, active: true });
      await chrome.windows.update(normal.id, { focused: true }).catch(() => {});
      return tab;
    }
    return await chrome.windows.create({ url, incognito: false });
  } catch (err) {
    console.error('[recorder] 在普通窗口打开扩展页失败，退回默认窗口', err);
    try {
      return await chrome.tabs.create({ url });
    } catch (err2) {
      console.error('[recorder] 打开扩展页彻底失败', err2);
      return null;
    }
  }
}

/**
 * 用页面标题给录制命名，比笼统的"标签页录制"有信息量得多。
 *
 * 权限上靠 activeTab：用户点扩展图标那一刻，当前标签页的 title/url 就可读了，
 * 不需要 tabs 权限（那会带来"读取浏览记录"的安装警告）。
 * 受保护页面、about:blank、或标签页还没加载完时 title 可能为空，退回模式名。
 *
 * 只用于标签页录制。屏幕录制时用户在选择器里选的可能是别的窗口甚至别的屏幕，
 * 拿当前标签页的标题去命名是误导。
 */
function titleFromTab(tab) {
  const raw = (tab?.title || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // 页面标题可以很长（有些站点把整段描述塞进 title），截断到看得完的长度
  return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
}

// ---------------------------------------------------------------- 屏幕选择器

function chooseDesktopMedia(tab) {
  return new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(
      ['screen', 'window', 'tab', 'audio'], tab, (streamId) => resolve(streamId || ''),
    );
  });
}

// ---------------------------------------------------------------- 开始录制

async function startRecording(input = {}) {
  const settings = await getSettings();
  const opts = { ...settings, ...input };
  trace(`START mode=${opts.mode} format=${opts.format} quality=${opts.quality} countdown=${opts.countdown}`);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab && opts.mode !== MODE.CAMERA) throw new Error('找不到当前标签页');
  const tabId = tab?.id ?? null;

  // 同一个标签页不能录两遍——tabCapture 对同一 tab 的第二次采集没有意义，
  // 而且用户几乎必然是误操作。其他标签页 / 屏幕 / 摄像头可以并发。
  if (isTabSource(opts.mode) && tabId != null) {
    const dup = (await sessionList()).find((s) => isTabSource(s.mode) && s.tabId === tabId);
    if (dup) throw new Error('这个标签页已经在录制中了');
  }

  // 标签页录制用页面标题命名。时间戳不塞进标题——录制库列表有独立日期列，
  // 导出文件名会拼 createdAt，标题里再来一次就是三处重复。
  if (isTabSource(opts.mode) && !opts.title) {
    const pageTitle = titleFromTab(tab);
    if (pageTitle) opts.title = pageTitle;
  }

  // 区域录制先让用户框出范围。复用截图那套选区覆层——两边要的东西完全一样，
  // 没必要写第二个拖拽框。
  let region = null;
  if (opts.mode === MODE.AREA) {
    const injected = await injectCaptureScript(tabId);
    if (!injected) throw new Error('当前页面受浏览器保护，无法在上面选择区域');
    const sel = await step('选择录制区域', () => tellTab(tabId, { type: 'SHOT_SELECT_AREA' }));
    // 分清两件事：用户主动取消（sel.cancelled）是正常流程，
    // 完全没有回应（sel 为空，页面跳转了 / 脚本没起来）是故障，必须说出来——
    // 否则用户点了"开始录制"什么都没发生，又是一次无从判断的静默失败。
    if (!sel) throw new Error('无法在当前页面选择区域，请刷新页面后重试');
    if (sel.cancelled) return { cancelled: true };
    if (!sel.rect) throw new Error('没有取到选区范围');
    // viewportHeight / dpr 是算采集尺寸用的，缺一个就只能退回预设分辨率
    region = {
      rect: sel.rect,
      viewportWidth: sel.viewportWidth,
      viewportHeight: sel.viewportHeight,
      dpr: sel.dpr,
    };
    trace(`✓ 选区 ${JSON.stringify(sel.rect)} 视口宽=${sel.viewportWidth} dpr=${sel.dpr}`);
  }

  // 1. 先拿 streamId —— 必须紧贴用户手势
  let streamId = '';
  if (isTabSource(opts.mode)) {
    streamId = await step('获取标签页采集源', () =>
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }));
  } else if (opts.mode === MODE.SCREEN) {
    streamId = await chooseDesktopMedia(tab);
    if (!streamId) return { cancelled: true }; // 用户关掉了选择器
  }

  // 2. 起 offscreen，建流、建 MediaRecorder，但先不开录
  await step('启动后台录制环境', ensureOffscreen);
  let prepared;
  try {
    prepared = await step('建立采集流', () =>
      toOffscreen('PREPARE', { options: { ...opts, streamId, tabId, region } }));
  } catch (err) {
    if (!(await sessionList()).length) await closeOffscreen();
    throw err;
  }

  // 覆层注入可能失败（chrome:// 等受保护页面、页面用 Permissions-Policy 掐了摄像头委派）。
  // 录制本身不受影响，但必须让用户知道成片里不会有摄像头/倒计时，不能默默降级。
  const warnings = [];
  const wantsCamera = opts.camera && opts.mode !== MODE.CAMERA && tabId != null;
  let overlayInjected = false;
  let cameraOk = false;

  try {
    // 区域录制要在页面上画边框，overlay.js 必须先就位
    if (opts.mode === MODE.AREA && tabId != null) overlayInjected = await injectOverlay(tabId);
    // 3. 摄像头画中画：注入扩展源 iframe，tabCapture 会连它一起录进去
    if (wantsCamera) {
      overlayInjected = await injectOverlay(tabId);
      if (overlayInjected) {
        const res = await tellTab(tabId, { type: 'OVERLAY_CAMERA_ON', deviceId: opts.cameraDeviceId || '' });
        cameraOk = !!res?.ok;
      }
      if (!cameraOk) warnings.push('摄像头画中画未能注入，本次录制不含摄像头画面');
    }

    // 4. 倒计时。必须在 recorder.start() 之前结束，否则会被录进去。
    if (opts.countdown > 0 && tabId != null) {
      if (!overlayInjected) overlayInjected = await injectOverlay(tabId);
      const shown = overlayInjected
        && !!(await tellTab(tabId, { type: 'OVERLAY_COUNTDOWN', seconds: opts.countdown }))?.ok;
      if (!shown) warnings.push('当前页面无法显示倒计时，已直接开始');
    }

    // 用户选了 MP4 但这台机器录不了（Chrome < 130 或缺 H.264 编码器）时，
    // 我们退回 WebM 继续录，但必须说出来——拿到的文件后缀跟预期不一样是会踩坑的。
    if (prepared.formatFellBack) {
      warnings.push(`当前浏览器不支持 ${FORMAT_NAME[prepared.requestedFormat] || prepared.requestedFormat} 录制，已改用 ${FORMAT_NAME[prepared.format] || prepared.format}`);
    }

    // 5. 正式开录
    await step('启动编码器', () => toOffscreen('BEGIN', { recordingId: prepared.recordingId }));

    // 自检：BEGIN 返回成功不等于真的在录。轨道可能已经结束、编码器可能没进 recording，
    // 这种情况下什么都不做的话，用户看到的就是"倒计时完了，然后没了"。
    const live = await toOffscreen('STATUS', { recordingId: prepared.recordingId });
    if (!live?.active) throw new Error('编码器启动后立即结束（采集源可能已关闭）');
    trace(`✓ 录制中 rec=${prepared.recordingId} mime=${prepared.mimeType}`);

    // 6. 区域录制：在页面上标出正在录的范围。
    // 边框整体画在选区之外，不会进入成片（见 overlay.js 的 REGION_GAP）。
    if (opts.mode === MODE.AREA && region) {
      const drawn = overlayInjected
        && !!(await tellTab(tabId, { type: 'OVERLAY_REGION_ON', rect: region.rect }))?.ok;
      trace(drawn ? '✓ 区域边框已绘制' : '区域边框未能绘制（页面不可注入）');
      if (!drawn) warnings.push('无法在页面上标出录制区域，但录制正常进行');
    }
  } catch (err) {
    await toOffscreen('CANCEL', { recordingId: prepared.recordingId }).catch(() => {});
    // 区域录制时弹窗已经主动关掉了，错误没地方显示——就近在页面上说一声
    if (overlayInjected && tabId != null) {
      await tellTab(tabId, { type: 'OVERLAY_TOAST', text: `录制失败：${err?.message || err}` });
      await tellTab(tabId, { type: 'OVERLAY_REGION_OFF' });
    }
    if (opts.mode !== MODE.AREA && overlayInjected && tabId != null) {
      await tellTab(tabId, { type: 'OVERLAY_CLEAR' });
    }
    if (!(await sessionList()).length) await closeOffscreen();
    throw err;
  }

  const all = await putSession({
    recordingId: prepared.recordingId,
    title: prepared.title,
    mode: opts.mode,
    tabId,
    overlayInjected,
    startedAt: Date.now(),
    paused: false,
  });

  paintBadge(Object.values(all).map((s) => ({ ...s, elapsedMs: 0 })));

  if (warnings.length) {
    if (wantsCamera && !cameraOk) {
      patchRecording(prepared.recordingId, { hasCamera: false, warnings }).catch(() => {});
    } else {
      patchRecording(prepared.recordingId, { warnings }).catch(() => {});
    }
    chrome.runtime.sendMessage({ type: 'REC_WARNING', recordingId: prepared.recordingId, warnings })
      .catch(() => {});
  }

  return { recordingId: prepared.recordingId, warnings };
}

// ---------------------------------------------------------------- 截图

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function injectCaptureScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/capture.js'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * captureVisibleTab 每秒最多 2 次，超了会抛 quota exceeded 而不是返回图片。
 * 整页拼接要连拍很多张，撞限流是常态，所以退避重试而不是直接失败——
 * 拼到一半丢一屏，整张长图就废了。
 */
async function captureVisible(windowId, attempt = 0) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(CAPTURE_INTERVAL_MS * (attempt + 1));
    return captureVisible(windowId, attempt + 1);
  }
}

function shotTitle(tab, shot) {
  const raw = titleFromTab(tab);
  return raw || SHOT_LABEL[shot] || '截图';
}

async function takeScreenshot(input = {}) {
  const settings = await getSettings();
  const opts = { ...settings, ...input };
  const shot = opts.shot || SHOT.VISIBLE;
  const format = IMAGE_FORMAT[opts.shotFormat] || IMAGE_FORMAT.PNG;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('找不到当前标签页');

  // 受保护页面（chrome://、应用商店）连可见区域都截不了，提前说清楚，
  // 别让用户对着一个失败的空结果猜原因。
  const injected = await injectCaptureScript(tab.id);
  if (!injected && shot !== SHOT.VISIBLE) {
    throw new Error('当前页面受浏览器保护，只能截取可见区域');
  }

  if (opts.shotDelay > 0 && shot !== SHOT.AREA) await sleep(opts.shotDelay * 1000);

  const meta = {
    title: shotTitle(tab, shot),
    shot,
    tabId: tab.id,
    mimeType: format.mimeType,
  };

  if (shot === SHOT.AREA) return captureArea(tab, meta, format);
  if (shot === SHOT.FULL) return captureFullPage(tab, meta, format);
  return captureViewport(tab, meta, format);
}

async function captureViewport(tab, meta, format) {
  const dataUrl = await step('截取可见区域', () => captureVisible(tab.windowId));
  const { blob, width, height } = await step('编码图片', () => encodeCapture(dataUrl, format));
  const rec = await createCapture({ ...meta, width, height }, blob);
  await openExtensionTab(chrome.runtime.getURL(`${PLAYER_PATH}?id=${rec.id}`));
  return { id: rec.id, width, height, size: blob.size };
}

async function captureArea(tab, meta, format) {
  const sel = await tellTab(tab.id, { type: 'SHOT_SELECT_AREA' });
  if (!sel) throw new Error('无法在当前页面选择区域，请刷新页面后重试');
  if (sel.cancelled) return { cancelled: true };
  if (!sel.rect) throw new Error('没有取到选区范围');

  const dataUrl = await captureVisible(tab.windowId);
  // 选区是 CSS 像素，截图是设备像素。比例交给 cropCapture 用「实际图宽 ÷ 视口宽」去算，
  // 不直接信 devicePixelRatio：页面缩放和系统显示缩放都会让两者对不上。
  const { blob, width, height } = await step('裁剪选区', () =>
    cropCapture(dataUrl, sel.rect, sel.viewportWidth, format));
  const rec = await createCapture({ ...meta, width, height }, blob);
  await openExtensionTab(chrome.runtime.getURL(`${PLAYER_PATH}?id=${rec.id}`));
  return { id: rec.id, width, height, size: blob.size };
}

async function captureFullPage(tab, meta, format) {
  const plan = await tellTab(tab.id, { type: 'SHOT_PLAN_FULLPAGE', maxHeight: MAX_FULLPAGE_HEIGHT });
  if (!plan?.steps?.length) throw new Error('无法测量页面尺寸');

  const slices = [];
  try {
    for (let i = 0; i < plan.steps.length; i++) {
      const at = await tellTab(tab.id, { type: 'SHOT_SCROLL_TO', y: plan.steps[i] });
      if (i > 0) await sleep(CAPTURE_INTERVAL_MS);
      slices.push({ y: at?.y ?? plan.steps[i], dataUrl: await captureVisible(tab.windowId) });
      // 第一屏截完再藏吸顶导航（第一屏里的才是页面真实的样子），
      // 否则每一屏都带一条同样的横条，拼出来的长图没法看。
      if (i === 0 && plan.steps.length > 1) await tellTab(tab.id, { type: 'SHOT_HIDE_FLOATING' });
    }
  } finally {
    await tellTab(tab.id, { type: 'SHOT_RESTORE' });
  }

  const { blob, width, height, sliceCount } = await step('拼接整页截图', () =>
    stitchFullPage(slices, plan, format));
  const rec = await createCapture({ ...meta, width, height, sliceCount }, blob);
  await openExtensionTab(chrome.runtime.getURL(`${PLAYER_PATH}?id=${rec.id}`));
  return { id: rec.id, width, height, size: blob.size, sliceCount };
}

// ---------------------------------------------------------------- 停止

// 每一路各有一个在途 Promise：停止有多个触发源（弹窗、Chrome 自带的
// "停止共享"、标签页被关闭），会互相触发，用它收敛避免重复清理和重复开播放页。
const stopInFlight = new Map();

function stopRecording(recordingId, opts = {}) {
  if (!recordingId) return Promise.resolve({ recording: null });
  const running = stopInFlight.get(recordingId);
  if (running) return running;
  const p = doStop(recordingId, opts).finally(() => stopInFlight.delete(recordingId));
  stopInFlight.set(recordingId, p);
  return p;
}

async function doStop(recordingId, { openPlayer = true, cancel = false, why = 'manual' } = {}) {
  trace(`停止 rec=${recordingId} 触发=${why}${cancel ? ' (放弃)' : ''}`);
  // 先把 session 摘掉，后面关窗口触发的 onRemoved 才不会又绕回来。
  const { removed, remaining } = await dropSession(recordingId);

  let rec = null;
  try {
    if (cancel) {
      await toOffscreen('CANCEL', { recordingId });
    } else {
      const data = await toOffscreen('STOP', { recordingId });
      rec = data?.recording || null;
    }
  } catch (err) {
    console.warn('[recorder] 停止时 offscreen 无响应', recordingId, err);
  }

  if (removed?.overlayInjected && removed.tabId != null) {
    await tellTab(removed.tabId, { type: 'OVERLAY_CLEAR' });
  }

  if (Object.keys(remaining).length === 0) {
    await closeOffscreen();
    setBadge('');
    setTitle('开始录制');
  }

  await reconcileInterrupted(Object.keys(remaining));

  // 即使这次录制失败（一片没存下），也要把播放页打开：
  // 用户点了"结束"却什么都不发生，是最糟糕的反馈。
  if (openPlayer && !cancel && rec?.id) {
    await openExtensionTab(chrome.runtime.getURL(`${PLAYER_PATH}?id=${rec.id}`));
  }
  return { recording: rec };
}

async function stopAll({ openPlayer = false, why = 'stop-all' } = {}) {
  const ids = Object.keys(await getSessions());
  const results = [];
  for (const id of ids) results.push(await stopRecording(id, { openPlayer, why }));
  return { recordings: results.map((r) => r.recording).filter(Boolean) };
}

async function togglePause(recordingId, paused) {
  const data = await toOffscreen(paused ? 'PAUSE' : 'RESUME', { recordingId });
  const all = await getSessions();
  if (all[recordingId]) { all[recordingId].paused = paused; await setSessions(all); }
  return data;
}

// ---------------------------------------------------------------- 状态

async function getStatus() {
  const stored = await getSessions();
  if (!Object.keys(stored).length) return { active: false, sessions: [] };
  try {
    const live = await toOffscreen('STATUS');
    if (!live?.active) { await resetAll(); return { active: false, sessions: [] }; }
    // 以 offscreen 为准：SW 的存储可能落后（例如 offscreen 自行结束了某一路）
    const byId = new Map(live.sessions.map((s) => [s.recordingId, s]));
    for (const id of Object.keys(stored)) if (!byId.has(id)) await dropSession(id);
    const merged = live.sessions.map((s) => ({ ...(stored[s.recordingId] || {}), ...s }));
    return { active: merged.length > 0, count: merged.length, sessions: merged };
  } catch {
    await resetAll();
    return { active: false, sessions: [] };
  }
}

async function resetAll() {
  await setSessions({});
  setBadge('');
  setTitle('开始录制');
  await reconcileInterrupted();
}

// ---------------------------------------------------------------- 消息入口

const routes = {
  START: (msg) => startRecording(msg.options),
  SCREENSHOT: (msg) => takeScreenshot(msg.options),
  STOP: (msg) => stopRecording(msg.recordingId),
  STOP_ALL: () => stopAll(),
  CANCEL: (msg) => stopRecording(msg.recordingId, { openPlayer: false, cancel: true }),
  PAUSE: (msg) => togglePause(msg.recordingId, true),
  RESUME: (msg) => togglePause(msg.recordingId, false),
  STATUS: () => getStatus(),
  LIST: () => listRecordings(),
  OPEN_PLAYER: (msg) => openExtensionTab(
    chrome.runtime.getURL(PLAYER_PATH + (msg.id ? `?id=${msg.id}` : '')),
  ).then((t) => ({ ok: !!t })),
  OPEN_PERMISSION: () => openExtensionTab(
    chrome.runtime.getURL(PERMISSION_PATH),
  ).then((t) => ({ ok: !!t })),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return undefined;
  const fn = routes[msg.type];
  if (!fn) return undefined;
  Promise.resolve()
    .then(() => fn(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.error('[recorder] background', msg.type, err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    });
  return true;
});

// offscreen 文档的控制台是独立的，它把关键诊断转发过来，在这里汇合成一条链路。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'REC_LOG') console.log('[recorder][offscreen]', msg.text);
});

// 徽标实时反映全部录制。offscreen 每秒广播一次 REC_TICK，SW 本来就会收到，
// 这里顺带刷徽标，不额外增加唤醒开销。
// 徽标依赖 offscreen 每秒广播的 REC_TICK。这条链路一旦断了，徽标会静默停在最后一个值上，
// 从外面完全看不出原因——所以在 Service Worker 控制台留下可读的痕迹：
// 第一条 tick 证明链路通了，之后每 60 条打一次，用来判断是否被节流。
let tickCount = 0;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'REC_TICK') return;
  const list = msg.sessions || [];
  if (tickCount === 0 || tickCount % 60 === 0) {
    console.log(`[recorder] REC_TICK #${tickCount} · ${list.length} 路 · 徽标=${list.length === 1 ? fmtBadge(list[0].elapsedMs) : list.length}`);
  }
  tickCount++;
  try { paintBadge(list); } catch (err) { console.warn('[recorder] 徽标刷新失败', err); }
});

// offscreen 自行结束（用户点了 Chrome 的"停止共享"、轨道被关闭、或录制出错）时兜底清理。
// 若停止是由 SW 发起的，stopInFlight 已经在跑，这里会被 no-op 掉。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'REC_STOPPED' && msg?.type !== 'REC_ERROR') return;
  const id = msg.recordingId;
  if (!id || stopInFlight.has(id)) return;
  getSessions().then((all) => {
    if (all[id]) stopRecording(id, { openPlayer: msg.type === 'REC_STOPPED', why: `offscreen:${msg.type}` });
  });
});

// 录制中的标签页被关掉 → 只收掉这一路
chrome.tabs.onRemoved.addListener(async (tabId) => {
  for (const s of await sessionList()) {
    if (isTabSource(s.mode) && s.tabId === tabId) stopRecording(s.recordingId, { why: 'tab-closed' });
  }
});

async function boot() {
  setBadge('');
  setTitle('开始录制');
  await setSessions({});
  const n = await reconcileInterrupted();
  if (n) console.info(`[recorder] 恢复了 ${n} 段被中断的录制`);
}

chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
