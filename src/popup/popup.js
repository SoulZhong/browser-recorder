import {
  MODE, QUALITY, DEFAULT_SETTINGS, FORMAT, FORMAT_LABEL, MIME_CANDIDATES,
  SHOT, IMAGE_FORMAT, isTabSource,
} from '../lib/constants.js';
import { storageEstimate } from '../lib/db.js';
import { fmtDuration, fmtBytes } from '../lib/format.js';

const $ = (id) => document.getElementById(id);
const els = {
  idle: $('idle'), live: $('live'), shotPane: $('shotPane'),
  error: $('error'), shotError: $('shotError'),
  start: $('start'), shoot: $('shoot'),
  pause: $('pause'), stop: $('stop'), cancel: $('cancel'),
  timer: $('timer'), liveMeta: $('liveMeta'), liveDot: $('liveDot'), liveState: $('liveState'),
  deviceRow: $('deviceRow'), micDevice: $('micDevice'), cameraDevice: $('cameraDevice'),
  sysAudioChip: $('sysAudioChip'), sysAudioLabel: $('sysAudioLabel'),
  quality: $('quality'), countdown: $('countdown'), format: $('format'),
  shotFormat: $('shotFormat'), shotDelay: $('shotDelay'), shotDelayRow: $('shotDelayRow'),
  storageText: $('storageText'), storageBar: $('storageBar'), openLibrary: $('openLibrary'),
  others: $('others'), othersText: $('othersText'), othersRows: $('othersRows'),
  stopOthers: $('stopOthers'),
};

let settings = { ...DEFAULT_SETTINGS };
/** 当前标签页正在录的那一路（没有就是 null）。弹窗的控制按钮只作用于它。 */
let currentRecordingId = null;
let currentTabId = null;

const bg = async (type, extra = {}) => {
  const res = await chrome.runtime.sendMessage({ target: 'background', type, ...extra });
  if (!res) throw new Error('后台无响应');
  if (!res.ok) throw new Error(res.error);
  return res.data;
};

const showError = (msg) => { els.error.textContent = msg; els.error.hidden = !msg; };
const showShotError = (msg) => { els.shotError.textContent = msg; els.shotError.hidden = !msg; };

// ------------------------------------------------------------ 设置

async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
}
const saveSettings = () => chrome.storage.local.set({ settings });

function fillSelect(sel, entries, value) {
  sel.innerHTML = '';
  for (const [v, label, disabled] of entries) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label; o.disabled = !!disabled;
    sel.appendChild(o);
  }
  sel.value = value;
}

/**
 * 格式可用性当场探测。MP4 录制是 Chrome 130+ 的能力，还依赖平台 H.264 编码器——
 * 与其让用户选完再在录制中途降级，不如在这里就把不可用的选项标出来。
 */
function renderFormat() {
  let firstOk = null;
  const entries = [FORMAT.MP4, FORMAT.WEBM].map((fmt) => {
    const ok = MIME_CANDIDATES[fmt].some((m) => {
      try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
    });
    if (ok && !firstOk) firstOk = fmt;
    return [fmt, ok ? FORMAT_LABEL[fmt] : `${FORMAT_LABEL[fmt]}（不支持）`, !ok];
  });
  fillSelect(els.format, entries, settings.format);
  const ok = [...els.format.options].some((o) => o.value === settings.format && !o.disabled);
  els.format.value = ok ? settings.format : (firstOk || FORMAT.WEBM);
  if (els.format.value !== settings.format) { settings.format = els.format.value; saveSettings(); }
}

const renderQuality = () =>
  fillSelect(els.quality, Object.entries(QUALITY).map(([k, q]) => [k, q.label]), settings.quality);

const renderShotFormat = () =>
  fillSelect(els.shotFormat, Object.entries(IMAGE_FORMAT).map(([k, f]) => [k, f.label]), settings.shotFormat);

// ------------------------------------------------------------ 渲染

/** 页签切换。录制进行中时"录屏"面板展示的是计时，不是表单。 */
function renderTool() {
  const tool = settings.tool === 'shot' ? 'shot' : 'record';
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.setAttribute('aria-selected', String(b.dataset.tool === tool));
  }
  const rec = tool === 'record';
  els.shotPane.hidden = rec;
  els.idle.hidden = !rec || !!currentRecordingId;
  els.live.hidden = !rec || !currentRecordingId;
  // 其他录制在两个页签下都要能操作——切到截图页签不该失去停止它们的入口
  if (els.othersRows.children.length === 0) els.others.hidden = true;
}

const setPressed = (sel, on) => document.querySelector(sel)?.setAttribute('aria-pressed', String(on));

function renderMode() {
  for (const b of document.querySelectorAll('.tile[data-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode));
  }
  const isCamera = settings.mode === MODE.CAMERA;
  els.sysAudioChip.hidden = isCamera;
  document.querySelector('.chip[data-src="camera"]').hidden = isCamera;
  els.sysAudioLabel.textContent = isTabSource(settings.mode) ? '标签页声音' : '系统声音';

  // 设备选择器只在真的要用时出现，不占位
  const needMic = settings.mic;
  const needCam = isCamera || settings.camera;
  els.micDevice.hidden = !needMic;
  els.cameraDevice.hidden = !needCam;
  els.deviceRow.hidden = !needMic && !needCam;
}

function renderToggles() {
  setPressed('.chip[data-src="mic"]', settings.mic);
  setPressed('.chip[data-src="audio"]', settings.systemAudio);
  setPressed('.chip[data-src="camera"]', settings.camera);
  els.countdown.value = String(settings.countdown);
  renderMode();
}

function renderShot() {
  for (const b of document.querySelectorAll('.tile[data-shot]')) {
    b.setAttribute('aria-pressed', String(b.dataset.shot === settings.shot));
  }
  // 区域选择要等用户拖拽，延时没有意义
  els.shotDelayRow.hidden = settings.shot === SHOT.AREA;
  els.shotFormat.value = settings.shotFormat;
  els.shotDelay.value = String(settings.shotDelay);
}

// ------------------------------------------------------------ 设备与权限

async function loadDevices() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const fill = (select, kind, current, fallback) => {
    let n = 0;
    const entries = [['', `默认${fallback}`]];
    for (const d of devices.filter((x) => x.kind === kind)) {
      entries.push([d.deviceId, d.label || `${fallback} ${++n}`]);
    }
    fillSelect(select, entries, entries.some(([v]) => v === current) ? current : '');
  };
  fill(els.micDevice, 'audioinput', settings.micDeviceId, '麦克风');
  fill(els.cameraDevice, 'videoinput', settings.cameraDeviceId, '摄像头');
  // 没授权时拿不到 label，以此判断是否还需要走授权页
  return devices.some((d) => (d.kind === 'audioinput' || d.kind === 'videoinput') && !d.label);
}

/**
 * Offscreen 文档弹不出权限框，所以必须在真实的扩展页面里先把权限拿到。
 * 判定依据：Permissions API（准），否则退回"设备 label 为空说明未授权"。
 */
async function hasMediaGrant(kinds) {
  try {
    const states = await Promise.all(
      kinds.map((name) => navigator.permissions.query({ name }).then((p) => p.state)),
    );
    if (states.every((s) => s === 'granted')) return true;
    if (states.some((s) => s === 'denied')) return false;
  } catch { /* Chrome 不支持查询该权限名时走下面的兜底 */ }
  return !(await loadDevices());
}

async function ensureMediaPermission() {
  const kinds = [];
  if (settings.mic) kinds.push('microphone');
  if (settings.camera || settings.mode === MODE.CAMERA) kinds.push('camera');
  if (!kinds.length) return true;
  if (await hasMediaGrant(kinds)) return true;
  await bg('OPEN_PERMISSION');
  window.close();
  return false;
}

async function renderStorage() {
  const { usage, quota } = await storageEstimate();
  els.storageBar.style.width = `${quota ? Math.min(100, (usage / quota) * 100) : 0}%`;
  els.storageText.textContent = quota
    ? `本地已用 ${fmtBytes(usage)} / 可用 ${fmtBytes(quota)}`
    : `本地已用 ${fmtBytes(usage)}`;
}

// ------------------------------------------------------------ 录制状态

let tickTimer = null;
let mineSnapshot = null;

/**
 * 弹窗是唯一的控制台（控制条窗口已撤掉）：
 * 当前标签页那一路给大计时和完整控制，其他标签页每路一行、都能单独结束。
 */
function renderSessions(list) {
  const mine = list.find((s) => s.recordingId === currentRecordingId)
    || list.find((s) => s.tabId != null && s.tabId === currentTabId);
  currentRecordingId = mine?.recordingId || null;

  mineSnapshot = mine || null;
  if (mine) paintMine();

  const others = list.filter((s) => s.recordingId !== currentRecordingId);
  els.others.hidden = others.length === 0;
  if (others.length) {
    els.othersText.textContent = mine ? `另有 ${others.length} 路录制` : `${others.length} 路录制进行中`;
    els.stopOthers.textContent = mine ? '结束其他' : '全部结束';
    renderOthers(others);
  }
  renderTool();
}

function renderOthers(list) {
  const seen = new Set();
  for (const s of list) {
    seen.add(s.recordingId);
    let row = els.othersRows.querySelector(`[data-id="${s.recordingId}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'row';
      row.dataset.id = s.recordingId;
      row.innerHTML = '<span class="live-dot"></span>'
        + '<span class="row-name"></span><span class="row-time num"></span>'
        + '<button class="row-btn" data-act="pause"></button>'
        + '<button class="row-btn stop" data-act="stop">结束</button>';
      row.addEventListener('click', (e) => {
        const act = e.target?.dataset?.act;
        if (!act) return;
        const id = row.dataset.id;
        if (act === 'stop') bg('STOP', { recordingId: id }).catch((err) => showError(err.message));
        else bg(row.dataset.paused === 'true' ? 'RESUME' : 'PAUSE', { recordingId: id })
          .catch((err) => showError(err.message));
      });
      els.othersRows.appendChild(row);
    }
    row.dataset.paused = String(!!s.paused);
    row.querySelector('.live-dot').classList.toggle('paused', !!s.paused);
    row.querySelector('.row-name').textContent = s.title || '录制';
    row.querySelector('.row-time').textContent = fmtDuration(s.elapsedMs || 0);
    row.querySelector('[data-act="pause"]').textContent = s.paused ? '继续' : '暂停';
  }
  for (const el of [...els.othersRows.children]) {
    if (!seen.has(el.dataset.id)) el.remove();
  }
}

function paintMine() {
  const s = mineSnapshot;
  if (!s) return;
  els.timer.textContent = fmtDuration(s.elapsedMs || 0);
  els.liveDot.classList.toggle('paused', !!s.paused);
  els.liveState.textContent = s.paused ? '已暂停' : '正在录制';
  els.pause.textContent = s.paused ? '继续' : '暂停';
  els.liveMeta.textContent = `已写入 ${fmtBytes(s.bytes || 0)}`;
}

function startTicker() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (mineSnapshot && !mineSnapshot.paused) {
      mineSnapshot.elapsedMs = (mineSnapshot.elapsedMs || 0) + 1000;
      paintMine();
    }
  }, 1000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'REC_TICK') renderSessions(msg.sessions || []);
  // 选区覆层已经挂到页面上了，弹窗让开——此刻关窗是安全的，
  // 用户接下来的拖拽不会被"先关闭弹窗"吃掉。
  if (msg?.type === 'AREA_OVERLAY_READY') window.close();
  if (msg?.type === 'REC_STOPPED' || msg?.type === 'REC_CANCELLED') {
    if (msg.recordingId === currentRecordingId) window.close();
  }
});

// ------------------------------------------------------------ 事件

// 这些按钮以前是裸 await：后台一旦出错就静默无反应，用户只会觉得"点了没用"。
const guard = (fn) => async () => {
  try { await fn(); } catch (err) { showError(err.message || String(err)); }
};

document.querySelectorAll('.seg-btn').forEach((b) => {
  b.addEventListener('click', () => { settings.tool = b.dataset.tool; renderTool(); saveSettings(); });
});

document.querySelectorAll('.tile[data-mode]').forEach((b) => {
  b.addEventListener('click', () => { settings.mode = b.dataset.mode; renderMode(); saveSettings(); });
});

document.querySelectorAll('.tile[data-shot]').forEach((b) => {
  b.addEventListener('click', () => { settings.shot = b.dataset.shot; renderShot(); saveSettings(); });
});

document.querySelectorAll('.chip[data-src]').forEach((b) => {
  b.addEventListener('click', async () => {
    const key = b.dataset.src;
    if (key === 'mic') settings.mic = !settings.mic;
    else if (key === 'audio') settings.systemAudio = !settings.systemAudio;
    else if (key === 'camera') settings.camera = !settings.camera;
    renderToggles();
    saveSettings();
    if ((key === 'mic' && settings.mic) || (key === 'camera' && settings.camera)) {
      await ensureMediaPermission();
    }
  });
});

const bindSelect = (el, key, cast = (v) => v) =>
  el.addEventListener('change', () => { settings[key] = cast(el.value); saveSettings(); });

bindSelect(els.format, 'format');
bindSelect(els.quality, 'quality');
bindSelect(els.countdown, 'countdown', Number);
bindSelect(els.micDevice, 'micDeviceId');
bindSelect(els.cameraDevice, 'cameraDeviceId');
bindSelect(els.shotFormat, 'shotFormat');
bindSelect(els.shotDelay, 'shotDelay', Number);

els.start.addEventListener('click', async () => {
  showError('');
  els.start.disabled = true;
  try {
    if (!(await ensureMediaPermission())) return;

    // 区域录制要在页面上拖拽框选，弹窗必须让开：它挡着页面，而且拖拽的第一下点击
    // 会先被浏览器用来关闭弹窗，用户会以为"拖了但没反应"。
    //
    // 但不能盲目定时关窗——注入失败 / 覆层没起来时，弹窗一关错误就无处可显，
    // 变成"弹窗消失了但什么也没发生"。所以等内容脚本广播 AREA_OVERLAY_READY，
    // 确认覆层真的挂上去了再关（见下方监听器）。在那之前保持 await，
    // 任何失败都能正常回到这里显示出来。
    if (settings.mode === MODE.AREA) els.start.lastChild.textContent = '正在唤起选区…';

    const res = await bg('START', { options: settings });
    if (res?.cancelled) { els.start.disabled = false; return; }

    // 有降级就别急着关：摄像头没注入这类问题，
    // 弹窗一关用户就再也看不到了，只会以为"点了没反应"。
    if (res?.warnings?.length) {
      showError(res.warnings.join('；'));
      els.start.lastChild.textContent = '录制中，可关闭此窗口';
      return;
    }
    window.close(); // 录制状态可以从图标徽标看到，再次点开图标即可控制
  } catch (err) {
    showError(err.message || String(err));
    els.start.disabled = false;
  }
});

els.shoot.addEventListener('click', async () => {
  showShotError('');
  els.shoot.disabled = true;
  try {
    const res = await bg('SCREENSHOT', { options: settings });
    if (res?.cancelled) { els.shoot.disabled = false; return; }
    window.close(); // 结果会在素材库里打开
  } catch (err) {
    showShotError(err.message || String(err));
    els.shoot.disabled = false;
  }
});

els.pause.addEventListener('click', guard(async () => {
  const paused = els.pause.textContent === '暂停';
  await bg(paused ? 'PAUSE' : 'RESUME', { recordingId: currentRecordingId });
  if (mineSnapshot) mineSnapshot.paused = paused;
  paintMine();
}));
els.stop.addEventListener('click', guard(async () => { await bg('STOP', { recordingId: currentRecordingId }); window.close(); }));
els.cancel.addEventListener('click', guard(async () => { await bg('CANCEL', { recordingId: currentRecordingId }); window.close(); }));
els.stopOthers.addEventListener('click', guard(async () => {
  // 只结束"其他"那些；当前标签页那一路有自己的按钮
  const ids = [...els.othersRows.children].map((el) => el.dataset.id);
  for (const id of ids) await bg('STOP', { recordingId: id });
}));
els.openLibrary.addEventListener('click', guard(async () => { await bg('OPEN_PLAYER'); window.close(); }));

// ------------------------------------------------------------ 启动

async function readCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id ?? null;
  } catch { currentTabId = null; }
}

(async () => {
  await loadSettings();
  renderFormat();
  renderQuality();
  renderShotFormat();
  renderShot();
  renderToggles();
  loadDevices();
  renderStorage();
  await readCurrentTab();

  const status = await bg('STATUS').catch(() => ({ active: false, sessions: [] }));
  renderSessions(status?.sessions || []);
  startTicker();
})();
