import {
  listRecordings, getRecording, assembleBlob, deleteRecording, deleteRecordings,
  patchRecording, storageEstimate, reconcileInterrupted, saveTrimmed,
} from '../lib/db.js';
import { indexMedia, snapStart, trimMedia, planCuts, cutMedia } from '../lib/trim.js';
import { STATUS, MODE, MODE_LABEL, SHOT, SHOT_LABEL, KIND, kindOf, extOf, nameOf, IMAGE_FORMAT } from '../lib/constants.js';
import { fmtDuration, fmtBytes, fmtDate, fmtStamp, safeFileName } from '../lib/format.js';

const $ = (id) => document.getElementById(id);
const els = {
  list: $('list'), binCount: $('binCount'), crumb: $('crumb'),
  stage: $('stage'), empty: $('empty'), monitor: $('monitor'), video: $('video'),
  shotWrap: $('shotWrap'), shot: $('shot'), viewerName: $('viewerName'), viewerSpec: $('viewerSpec'),
  transport: $('transport'), tcNow: $('tcNow'), tcDur: $('tcDur'),
  tHome: $('tHome'), tBack: $('tBack'), tPlay: $('tPlay'), tFwd: $('tFwd'), tEnd: $('tEnd'),
  tMute: $('tMute'), tFull: $('tFull'),
  insp: $('insp'), inspEmpty: $('inspEmpty'), title: $('title'), props: $('props'), stageMeta: $('stageMeta'),
  download: $('download'), delete: $('delete'), copy: $('copy'),
  usageText: $('usageText'), usageBar: $('usageBar'),
  listBar: $('listBar'), pickAll: $('pickAll'), pickText: $('pickText'),
  bulk: $('bulk'), bulkDownload: $('bulkDownload'), bulkDelete: $('bulkDelete'),
  tlBody: $('tlBody'), ruler: $('ruler'), filmstrip: $('filmstrip'), clipName: $('clipName'),
  wave: $('wave'), audioName: $('audioName'), clipAudio: $('clipAudio'),
  trim: $('trim'), trimPanel: $('trimPanel'), trimTrack: $('trimTrack'), trimKeys: $('trimKeys'),
  shadeL: $('shadeL'), shadeR: $('shadeR'),
  trimRange: $('trimRange'), trimHead: $('trimHead'), trimStart: $('trimStart'), trimEnd: $('trimEnd'),
  trimStartText: $('trimStartText'), trimEndText: $('trimEndText'), trimKeepText: $('trimKeepText'),
  trimSizeText: $('trimSizeText'), trimSnap: $('trimSnap'), trimMsg: $('trimMsg'),
  trimSetStart: $('trimSetStart'), trimSetEnd: $('trimSetEnd'), trimPreview: $('trimPreview'),
  trimCancel: $('trimCancel'), trimReplace: $('trimReplace'), trimSave: $('trimSave'),
  cut: $('cut'), cutControls: $('cutControls'), cutRemove: $('cutRemove'), cutList: $('cutList'),
  cutHint: $('cutHint'), cutMarks: $('cutMarks'), trimLabel: $('trimLabel'), trimPreviewText: $('trimPreviewText'),
};

let recordings = [];
let current = null;
let currentUrl = null;

/** 批量选中的 id。录制中的记录不可选：分片还在写，既不能完整导出也不该被删。 */
const selected = new Set();
let lastPicked = null;   // 上一次点的复选框，Shift 点击时以它为范围起点
let bulkBusy = false;    // 批量下载/删除进行中，期间禁掉两个按钮
const selectable = (rec) => rec.status !== STATUS.RECORDING;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOT_ICON = {
  [SHOT.VISIBLE]: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10h8"/></svg>',
  [SHOT.FULL]: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 7h6M9 12h6M9 17h6"/></svg>',
  [SHOT.AREA]: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 8V5a2 2 0 012-2h3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M8 21H5a2 2 0 01-2-2v-3"/></svg>',
};

const MODE_ICON = {
  [MODE.AREA]: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 8V5a2 2 0 012-2h3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M8 21H5a2 2 0 01-2-2v-3"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>',
  [MODE.TAB]: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>',
  [MODE.SCREEN]: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  [MODE.CAMERA]: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/></svg>',
};

const iconFor = (rec) => (kindOf(rec) === KIND.IMAGE
  ? (SHOT_ICON[rec.shot] || SHOT_ICON[SHOT.VISIBLE])
  : (MODE_ICON[rec.mode] || MODE_ICON[MODE.TAB]));

function describe(rec) {
  // 截图没有时长，把它换成模式名更有信息量
  const head = kindOf(rec) === KIND.IMAGE
    ? (SHOT_LABEL[rec.shot] || '截图')
    : fmtDuration(rec.duration);
  const parts = [head, fmtBytes(rec.size), fmtDate(rec.createdAt)];
  if (rec.width && rec.height) parts.splice(2, 0, `${rec.width}×${rec.height}`);
  return parts.join(' · ');
}

/** 图片扩展名跟着实际 mimeType 走，不猜。 */
function imageExt(mimeType) {
  const f = Object.values(IMAGE_FORMAT).find((x) => x.mimeType === mimeType);
  return f?.ext || 'png';
}
const isImage = (rec) => kindOf(rec) === KIND.IMAGE;

/** 标题 + 录制开始时间：标题可以随便改，时间戳保证文件名唯一且可排序 */
function fileNameOf(rec) {
  const ext = isImage(rec) ? imageExt(rec.mimeType) : extOf(rec.mimeType);
  return `${safeFileName(rec.title)}_${fmtStamp(rec.createdAt)}.${ext}`;
}

function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

/** 时间码：mm:ss.cc，超过一小时带上小时。监视器、时间轴、修剪面板共用一种写法。 */
function fmtTC(ms) {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const p = (n) => String(n).padStart(2, '0');
  return `${h ? `${h}:` : ''}${p(m)}:${p(s)}.${p(cs % 100)}`;
}

/** 从 mimeType 的 codecs 参数读出人话：avc1 → H.264 之类。 */
function codecLabel(mimeType = '') {
  const m = /codecs="?([^";]+)/i.exec(mimeType);
  if (!m) return '';
  const NAMES = [[/^avc/i, 'H.264'], [/^vp9|^vp09/i, 'VP9'], [/^vp8/i, 'VP8'], [/^av01/i, 'AV1'], [/^mp4a/i, 'AAC'], [/^opus/i, 'Opus']];
  return m[1].split(',').map((c) => NAMES.find(([re]) => re.test(c.trim()))?.[1] || c.trim()).join(' / ');
}

const STATUS_LABEL = {
  [STATUS.RECORDING]: '录制中',
  [STATUS.DONE]: '已完成',
  [STATUS.INTERRUPTED]: '已恢复（录制曾中断）',
  [STATUS.ERROR]: '写入失败',
};

// ── 素材面板 ──

/**
 * 切换一条的选中态。Shift 点击把上一次点的那条到这条之间的都设成同一状态，
 * 中间遇到录制中的跳过。
 */
function togglePick(id, on, shift) {
  const ids = recordings.map((r) => r.id);
  let range = [id];
  if (shift && lastPicked && ids.includes(lastPicked)) {
    const [a, b] = [ids.indexOf(lastPicked), ids.indexOf(id)].sort((x, y) => x - y);
    range = ids.slice(a, b + 1);
  }
  for (const rid of range) {
    const rec = recordings.find((r) => r.id === rid);
    if (!rec || !selectable(rec)) continue;
    if (on) selected.add(rid); else selected.delete(rid);
  }
  lastPicked = id;
  renderList();
}

function renderBulkBar() {
  const pool = recordings.filter(selectable);
  const n = selected.size;
  els.listBar.hidden = recordings.length === 0;
  els.pickAll.disabled = pool.length === 0;
  els.pickAll.checked = pool.length > 0 && n === pool.length;
  els.pickAll.indeterminate = n > 0 && n < pool.length;
  const size = recordings.filter((r) => selected.has(r.id)).reduce((s, r) => s + (r.size || 0), 0);
  els.pickText.textContent = n ? `已选 ${n} 项 · ${fmtBytes(size)}` : '全选';
  els.bulk.hidden = n === 0;
  els.bulkDownload.disabled = bulkBusy;
  els.bulkDelete.disabled = bulkBusy;
  if (!bulkBusy) els.bulkDownload.textContent = `下载 ${n} 项`;
}

function renderList() {
  els.list.innerHTML = '';
  els.binCount.textContent = recordings.length ? `${recordings.length} 项` : '';
  for (const rec of recordings) {
    // 复选框不能嵌在 <button> 里（交互元素不允许嵌套），所以行本身是 div + role=button
    const row = document.createElement('div');
    row.className = 'item' + (selected.has(rec.id) ? ' picked' : '');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-current', String(current?.id === rec.id));
    row.innerHTML = `
      <input type="checkbox" class="pick" aria-label="选中这一项">
      <span class="thumb">${rec.thumb ? '<img alt="">' : iconFor(rec)}</span>
      <span class="body">
        <span class="name"></span>
        <span class="meta"></span>
        <span class="tags"></span>
      </span>`;
    if (rec.thumb) row.querySelector('.thumb img').src = rec.thumb;
    if (!isImage(rec)) {
      const d = document.createElement('span');
      d.className = 'dur';
      d.textContent = fmtDuration(rec.duration);
      row.querySelector('.thumb').appendChild(d);
    }
    const pick = row.querySelector('.pick');
    pick.checked = selected.has(rec.id);
    pick.disabled = !selectable(rec);
    if (pick.disabled) pick.title = '录制中，结束后才能批量操作';
    pick.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePick(rec.id, pick.checked, e.shiftKey);
    });
    row.querySelector('.name').textContent = rec.title || rec.id;
    const kind = isImage(rec) ? (SHOT_LABEL[rec.shot] || '截图') : (MODE_LABEL[rec.mode] || '录像');
    row.querySelector('.meta').textContent = [kind, fmtBytes(rec.size), fmtDate(rec.createdAt)].join(' · ');
    const tags = row.querySelector('.tags');
    const TAGS = {
      [STATUS.RECORDING]:   ['录制中', '这段录制仍在进行，结束后才能完整播放'],
      [STATUS.INTERRUPTED]: ['已恢复', '录制被意外中断，这是已落盘的部分'],
      [STATUS.ERROR]:       ['写入失败', rec.error || '分片写入失败，只保留了中断前的部分'],
    };
    const addTag = (cls, [text, title]) => {
      const tag = document.createElement('span');
      tag.className = `tag ${cls}`;
      tag.textContent = text;
      tag.title = title;
      tags.appendChild(tag);
    };
    if (TAGS[rec.status]) addTag('', TAGS[rec.status]);
    if (rec.warnings?.length) addTag('warn', ['有降级', rec.warnings.join('\n')]);
    if (rec.trim && !rec.trim.replaced) addTag('info', [rec.trim.removed ? '剪辑' : '修剪', `${rec.trim.removed ? '剪辑' : '修剪'}自「${rec.trim.fromTitle || '未命名'}」`]);
    row.addEventListener('click', () => select(rec.id));
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(rec.id); }
    });
    els.list.appendChild(row);
  }
  els.empty.hidden = !!current;
  els.empty.querySelector('span').textContent = recordings.length ? '从左侧选择一个素材' : '还没有内容';
  els.empty.querySelector('small').hidden = recordings.length > 0;
  renderBulkBar();
}

// ── 缩略图：后台逐条生成，存进记录里，下次打开直接用 ──

let thumbQueue = Promise.resolve();
const thumbPending = new Set();

async function makeThumb(rec) {
  const W = 176;
  const H = 99;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  g.fillStyle = '#0B0D12';
  g.fillRect(0, 0, W, H);
  const blob = await assembleBlob(rec.id);
  const cover = (sw, sh, draw) => {
    const s = Math.max(W / sw, H / sh);
    // 长截图取顶部，视频取中间
    const dy = isImage(rec) ? 0 : (H - sh * s) / 2;
    draw((W - sw * s) / 2, dy, sw * s, sh * s);
  };
  if (isImage(rec)) {
    const bmp = await createImageBitmap(blob);
    cover(bmp.width, bmp.height, (x, y, w, h) => g.drawImage(bmp, x, y, w, h));
    bmp.close();
  } else {
    const url = URL.createObjectURL(blob);
    try {
      const v = await grabFrames(url, [Math.min(1, (rec.duration || 0) / 2000)], (frame) => {
        cover(frame.videoWidth, frame.videoHeight, (x, y, w, h) => g.drawImage(frame, x, y, w, h));
      });
      if (!v) return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return canvas.toDataURL('image/jpeg', 0.8);
}

/**
 * 在一个不显示的 <video> 上依次跳到各个时间点，每到一处回调一次。
 * 胶片条和缩略图共用。cancelled() 返回 true 时提前收手。
 */
async function grabFrames(url, seconds, onFrame, cancelled = () => false) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise((resolve, reject) => {
      v.addEventListener('loadeddata', resolve, { once: true });
      v.addEventListener('error', () => reject(v.error), { once: true });
    });
    for (const [i, t] of seconds.entries()) {
      if (cancelled()) return false;
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 3000);   // 个别时间点 seek 不回来时不要卡住整条
        v.addEventListener('seeked', done, { once: true });
        v.currentTime = Math.max(0, t);
      });
      if (cancelled()) return false;
      onFrame(v, i);
    }
    return true;
  } catch {
    return false;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

function ensureThumbs() {
  for (const rec of recordings) {
    if (rec.thumb || rec.status === STATUS.RECORDING || thumbPending.has(rec.id)) continue;
    thumbPending.add(rec.id);
    thumbQueue = thumbQueue.then(async () => {
      try {
        const thumb = await makeThumb(rec);
        if (!thumb) return;
        await patchRecording(rec.id, { thumb });
        const row = recordings.find((r) => r.id === rec.id);
        if (row) { row.thumb = thumb; renderList(); }
      } catch (err) {
        console.warn('[recorder] 缩略图生成失败', rec.id, err);
      } finally {
        thumbPending.delete(rec.id);
      }
    });
  }
}

// ── 监视器 ──

/** 把舞台清空并释放当前对象 URL；删除当前项或批量删除命中当前项时用。 */
function clearStage() {
  closeTrim();
  timelineToken++;
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  els.video.removeAttribute('src');
  els.video.load();
  els.shot.removeAttribute('src');
  current = null;
  els.stage.hidden = true;
  els.empty.hidden = false;
  els.transport.hidden = true;
  els.insp.hidden = true;
  els.inspEmpty.hidden = false;
  els.viewerName.textContent = '';
  els.viewerSpec.textContent = '';
  els.crumb.textContent = '';
  els.trim.disabled = true;
  els.cut.disabled = true;
  els.tlBody.classList.add('off');
}

function renderInspector(rec) {
  els.title.value = rec.title || rec.id;
  const rows = [
    ['类型', isImage(rec) ? `截图 · ${SHOT_LABEL[rec.shot] || '可见区域'}` : `录像 · ${MODE_LABEL[rec.mode] || '标签页'}`],
  ];
  if (!isImage(rec)) rows.push(['时长', fmtTC(rec.duration || 0)]);
  if (rec.width && rec.height) rows.push(['分辨率', `${rec.width} × ${rec.height}`]);
  rows.push(['大小', fmtBytes(rec.size)]);
  const codec = codecLabel(rec.mimeType);
  rows.push(['格式', isImage(rec) ? imageExt(rec.mimeType).toUpperCase() : `${nameOf(rec.mimeType)}${codec ? ` · ${codec}` : ''}`]);
  if (isImage(rec) && rec.sliceCount) rows.push(['拼接', `由 ${rec.sliceCount} 屏拼接`]);
  if (!isImage(rec)) rows.push(['分片', `${rec.chunkCount} 个`]);
  rows.push(['录制于', fmtDate(rec.createdAt)]);
  rows.push(['状态', STATUS_LABEL[rec.status] || rec.status]);
  els.props.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    if (['时长', '分辨率', '大小'].includes(k)) dd.className = 'num';
    els.props.append(dt, dd);
  }

  // 提示：修剪来源是信息，中断 / 写入失败 / 降级是警告
  els.stageMeta.innerHTML = '';
  const note = (text, warn) => {
    const n = document.createElement('div');
    n.className = warn ? 'note warn' : 'note';
    n.textContent = text;
    els.stageMeta.appendChild(n);
  };
  if (rec.trim && !rec.trim.replaced) note(`${rec.trim.removed ? '剪辑' : '修剪'}自「${rec.trim.fromTitle || '未命名'}」`);
  if (rec.status === STATUS.INTERRUPTED) note('录制曾被中断，这是已保存的部分', true);
  if (rec.status === STATUS.ERROR) note(rec.error || '分片写入失败，只保留了中断前的部分', true);
  for (const w of rec.warnings || []) note(w, true);

  els.download.textContent = `下载 ${isImage(rec) ? imageExt(rec.mimeType).toUpperCase() : nameOf(rec.mimeType)}`;
  els.copy.hidden = !isImage(rec);
  els.insp.hidden = false;
  els.inspEmpty.hidden = true;
}

async function select(id) {
  const rec = await getRecording(id);
  if (!rec) return;
  closeTrim();
  current = rec;

  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  const blob = await assembleBlob(id);
  currentUrl = URL.createObjectURL(blob);

  els.stage.hidden = false;
  els.empty.hidden = true;
  els.viewerName.textContent = rec.title || rec.id;
  els.crumb.textContent = rec.title || rec.id;
  els.viewerSpec.textContent = [rec.width && rec.height ? `${rec.width}×${rec.height}` : '', isImage(rec) ? imageExt(rec.mimeType).toUpperCase() : nameOf(rec.mimeType)]
    .filter(Boolean).join(' · ');

  // 视频和图片共用一个舞台，切换时必须把另一个彻底停掉，
  // 否则上一段视频会在背后继续播（有声音，找不到源头）。
  if (isImage(rec)) {
    els.video.removeAttribute('src');
    els.video.load();
    els.video.hidden = true;
    els.shotWrap.hidden = false;
    els.shot.src = currentUrl;
    els.transport.hidden = true;
  } else {
    els.shot.removeAttribute('src');
    els.shotWrap.hidden = true;
    els.video.hidden = false;
    els.video.src = currentUrl;
    els.transport.hidden = false;
  }
  renderInspector(rec);
  setupTimeline(rec);
  renderList();
  history.replaceState(null, '', `?id=${id}`);
}

const togglePlay = () => {
  if (!current || isImage(current)) return;
  if (els.video.paused) els.video.play().catch(() => {}); else els.video.pause();
};
function seekTo(ms) {
  if (!current || isImage(current)) return;
  els.video.currentTime = Math.max(0, Math.min(timelineMs(), ms)) / 1000;
  drawPlayhead();
}
const nowMs = () => els.video.currentTime * 1000;

els.video.addEventListener('click', togglePlay);
els.tPlay.addEventListener('click', togglePlay);
els.tHome.addEventListener('click', () => seekTo(0));
els.tEnd.addEventListener('click', () => seekTo(timelineMs()));
els.tBack.addEventListener('click', () => seekTo(nowMs() - 1000));
els.tFwd.addEventListener('click', () => seekTo(nowMs() + 1000));
els.tMute.addEventListener('click', () => { els.video.muted = !els.video.muted; });
els.tFull.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else els.monitor.requestFullscreen().catch(() => {});
});
els.video.addEventListener('volumechange', () => els.tMute.classList.toggle('on', els.video.muted));

// 播放时逐帧推进播放头和时间码；timeupdate 一秒只来四次，拿它画会一顿一顿
let rafId = 0;
const tick = () => { drawPlayhead(); if (!els.video.paused) rafId = requestAnimationFrame(tick); };
els.video.addEventListener('play', () => { els.tPlay.classList.add('on'); cancelAnimationFrame(rafId); tick(); });
els.video.addEventListener('pause', () => { els.tPlay.classList.remove('on'); drawPlayhead(); });
els.video.addEventListener('seeked', drawPlayhead);
els.video.addEventListener('timeupdate', drawPlayhead);
els.video.addEventListener('loadedmetadata', () => {
  // WebM 没修好时长时 duration 可能是 Infinity，这时继续用记录里的时长
  if (current && !trim) { renderRuler(); drawPlayhead(); }
});

// ── 时间轴 ──

let timelineToken = 0;

/** 时间轴的总长：修剪时以录像结构为准，否则用播放器给的时长，再不行用记录里的。 */
function timelineMs() {
  if (trim) return trim.index.durationMs;
  const d = els.video.duration;
  return Number.isFinite(d) && d > 0 ? d * 1000 : (current?.duration || 1);
}

const pctOf = (ms) => `${(Math.min(timelineMs(), Math.max(0, ms)) / timelineMs()) * 100}%`;

function drawPlayhead() {
  if (!current || isImage(current)) return;
  const ms = nowMs();
  els.trimHead.style.left = pctOf(ms);
  els.tcNow.textContent = fmtTC(ms);
  els.tcDur.textContent = fmtTC(timelineMs());
  if (trim?.previewing && ms >= trim.previewRanges[trim.previewIndex].endMs) {
    const next = trim.previewRanges[++trim.previewIndex];
    if (next) seekTo(next.startMs);
    else { els.video.pause(); trim.previewing = false; }
  }
}

const RULER_STEPS = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000];

function fmtRuler(ms, step) {
  const t = Math.round(ms / 100) / 10;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = step < 1000 ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 标尺：主刻度之间至少留 84px 放得下时间，主刻度之间再分 5 格。 */
function renderRuler() {
  const width = els.ruler.clientWidth;
  const D = timelineMs();
  els.ruler.innerHTML = '';
  if (!width || !(D > 0)) return;
  const step = RULER_STEPS.find((s) => (s / D) * width >= 84) || RULER_STEPS.at(-1);
  const minor = step / 5;
  const frag = document.createDocumentFragment();
  for (let i = 0, t = 0; t <= D + 0.5; i++, t = i * minor) {
    const tick = document.createElement('div');
    tick.className = i % 5 === 0 ? 'tick major' : 'tick';
    tick.style.left = `${(t / D) * 100}%`;
    if (i % 5 === 0 && (t / D) * width < width - 40) {
      const label = document.createElement('span');
      label.textContent = fmtRuler(t, step);
      tick.appendChild(label);
    }
    frag.appendChild(tick);
  }
  els.ruler.appendChild(frag);
}

function setupTimeline(rec) {
  const token = ++timelineToken;
  els.filmstrip.innerHTML = '';
  const g = els.wave.getContext('2d');
  g.clearRect(0, 0, els.wave.width, els.wave.height);
  els.trimKeys.innerHTML = '';
  if (isImage(rec)) {
    els.tlBody.classList.add('off');
    els.trim.disabled = true;
    els.cut.disabled = true;
    return;
  }
  els.tlBody.classList.remove('off');
  els.trim.disabled = rec.status === STATUS.RECORDING;
  els.cut.disabled = els.trim.disabled;
  els.clipName.textContent = rec.title || rec.id;
  els.audioName.textContent = '音频';
  renderRuler();
  drawPlayhead();
  // 胶片条和波形都要解码，排在后面慢慢来，切走了就作废
  requestAnimationFrame(() => {
    if (token !== timelineToken) return;
    drawFilmstrip(rec, token);
    drawWaveform(rec, token);
  });
}

/** 胶片条：按轨道宽度均匀取帧，每格保持画面比例。 */
async function drawFilmstrip(rec, token) {
  const lane = els.filmstrip;
  const width = lane.clientWidth;
  const height = lane.clientHeight;
  if (!width || !height) return;
  const ratio = rec.width && rec.height ? rec.width / rec.height : 16 / 9;
  const cell = Math.max(48, Math.round(height * ratio));
  const n = Math.max(1, Math.ceil(width / cell));
  const D = rec.duration || timelineMs();
  const dpr = window.devicePixelRatio || 1;
  const canvases = [];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('canvas');
    c.width = Math.round(cell * dpr);
    c.height = Math.round(height * dpr);
    c.style.width = `${cell}px`;
    canvases.push(c);
    lane.appendChild(c);
  }
  const times = canvases.map((_, i) => Math.min(D - 50, ((i + 0.5) / n) * D) / 1000);
  await grabFrames(currentUrl, times, (v, i) => {
    const c = canvases[i];
    const ctx = c.getContext('2d');
    const s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
    ctx.drawImage(v, (c.width - v.videoWidth * s) / 2, (c.height - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
  }, () => token !== timelineToken);
}

/**
 * 音频波形。要把整条音轨解码成 PCM，十分钟以上或体积太大的录像不画——
 * 30 分钟立体声解出来就是六七百 MB 内存，为一条装饰性的波形不值得。
 */
async function drawWaveform(rec, token) {
  const c = els.wave;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr);
  c.height = Math.round(c.clientHeight * dpr);
  const g = c.getContext('2d');
  const mid = c.height / 2;
  const flat = (label) => {
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(92, 199, 164, .35)';
    g.fillRect(0, mid - dpr / 2, c.width, dpr);
    els.audioName.textContent = label;
  };
  if ((rec.duration || 0) > 10 * 60 * 1000 || (rec.size || 0) > 150 * 1024 * 1024) {
    flat('音频 · 录像较长，未绘制波形');
    return;
  }
  let audio;
  try {
    const buf = await (await assembleBlob(rec.id, { fixDuration: false })).arrayBuffer();
    if (token !== timelineToken) return;
    const ctx = new OfflineAudioContext(1, 1, 44100);
    audio = await ctx.decodeAudioData(buf);
  } catch {
    if (token === timelineToken) flat('无音频');
    return;
  }
  if (token !== timelineToken) return;
  const D = timelineMs() / 1000;
  const cols = c.width;
  const data = audio.getChannelData(0);
  const perSec = audio.sampleRate;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#5CC7A4';
  let peak = 0.0001;
  const peaks = new Float32Array(cols);
  for (let x = 0; x < cols; x++) {
    const a = Math.floor(((x / cols) * D) * perSec);
    const b = Math.min(data.length, Math.floor((((x + 1) / cols) * D) * perSec));
    let m = 0;
    for (let i = a; i < b; i += 4) m = Math.max(m, Math.abs(data[i]));
    peaks[x] = m;
    peak = Math.max(peak, m);
  }
  for (let x = 0; x < cols; x++) {
    const h = Math.max(dpr, (peaks[x] / peak) * (c.height * 0.8));
    g.fillRect(x, mid - h / 2, 1, h);
  }
  els.audioName.textContent = '音频';
}

new ResizeObserver(() => {
  if (!current || isImage(current)) return;
  renderRuler();
  if (trim) renderTrim();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => setupTimeline(current), 250);
}).observe(els.trimTrack);
let resizeTimer = null;

// 在标尺或轨道上按下：拖播放头；按在把手上：拖入点 / 出点
els.trimTrack.addEventListener('pointerdown', (e) => {
  if (!current || isImage(current) || e.button !== 0) return;
  const rect = els.trimTrack.getBoundingClientRect();
  const msAt = (x) => (Math.min(rect.width, Math.max(0, x - rect.left)) / rect.width) * timelineMs();
  const edge = trim && (e.target === els.trimStart ? 'start' : e.target === els.trimEnd ? 'end' : null);
  els.trimTrack.setPointerCapture(e.pointerId);
  if (edge) (edge === 'start' ? els.trimStart : els.trimEnd).focus();
  else els.video.pause();
  const move = (ev) => {
    if (edge) {
      setTrimEdge(edge, msAt(ev.clientX));
      seekTo(edge === 'start' ? snapStart(trim.index, trim.start) : trim.end);
    } else {
      seekTo(msAt(ev.clientX));
    }
  };
  move(e);
  const up = () => {
    els.trimTrack.removeEventListener('pointermove', move);
    els.trimTrack.removeEventListener('pointerup', up);
    els.trimTrack.removeEventListener('pointercancel', up);
  };
  els.trimTrack.addEventListener('pointermove', move);
  els.trimTrack.addEventListener('pointerup', up);
  els.trimTrack.addEventListener('pointercancel', up);
});

// ── 下载 / 复制 / 删除 ──

els.download.addEventListener('click', () => {
  if (!current || !currentUrl) return;
  triggerDownload(currentUrl, fileNameOf(current));
});

els.copy.addEventListener('click', async () => {
  if (!current || !isImage(current)) return;
  const original = els.copy.textContent;
  try {
    // 剪贴板只认 PNG。JPEG 截图要先转一道，否则 write() 直接拒绝。
    let blob = await assembleBlob(current.id);
    if (blob.type !== 'image/png') blob = await toPngBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    els.copy.textContent = '已复制';
  } catch (err) {
    console.error(err);
    els.copy.textContent = '复制失败';
  }
  setTimeout(() => { els.copy.textContent = original; }, 1600);
});

async function toPngBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

els.delete.addEventListener('click', async () => {
  if (!current) return;
  if (!confirm(`删除「${current.title}」？此操作不可撤销。`)) return;
  const id = current.id;
  clearStage();
  selected.delete(id);
  await deleteRecording(id);
  await refresh();
});

// ── 批量操作 ──

els.pickAll.addEventListener('change', () => {
  if (els.pickAll.checked) {
    for (const rec of recordings) if (selectable(rec)) selected.add(rec.id);
  } else {
    selected.clear();
  }
  lastPicked = null;
  renderList();
});

els.bulkDownload.addEventListener('click', async () => {
  const targets = recordings.filter((r) => selected.has(r.id));
  if (!targets.length || bulkBusy) return;
  bulkBusy = true;
  renderBulkBar();
  // 逐条触发下载。第一次多文件下载 Chrome 会弹一次"允许此站点下载多个文件"，允许后不再问。
  // 对象 URL 统一在最后释放：点击触发的下载是异步接手的，立刻 revoke 会拿到空文件。
  const urls = [];
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    els.bulkDownload.textContent = `下载中 ${i + 1}/${targets.length}`;
    try {
      const url = URL.createObjectURL(await assembleBlob(targets[i].id));
      urls.push(url);
      triggerDownload(url, fileNameOf(targets[i]));
      await sleep(300);
    } catch (err) {
      console.error('[recorder] 批量下载失败', targets[i].id, err);
      failed++;
    }
  }
  els.bulkDownload.textContent = failed ? `${failed} 项失败` : '已开始下载';
  await sleep(1600);
  for (const u of urls) URL.revokeObjectURL(u);
  bulkBusy = false;
  renderBulkBar();
});

els.bulkDelete.addEventListener('click', async () => {
  const targets = recordings.filter((r) => selected.has(r.id));
  if (!targets.length || bulkBusy) return;
  const size = targets.reduce((s, r) => s + (r.size || 0), 0);
  if (!confirm(`删除选中的 ${targets.length} 项（${fmtBytes(size)}）？此操作不可撤销。`)) return;
  bulkBusy = true;
  renderBulkBar();
  if (current && selected.has(current.id)) clearStage();
  try {
    await deleteRecordings(targets.map((r) => r.id));
    selected.clear();
    lastPicked = null;
  } catch (err) {
    console.error('[recorder] 批量删除失败', err);
    alert('删除失败，请重试');
  }
  bulkBusy = false;
  await refresh();
});

// ── 修剪（见 GLOSSARY.md、docs/adr/0001）──
// 入点只能落在关键帧上：拖动时入点把手直接吸附到关键帧，所见即所得；
// 用户想要的位置和实际入点不一致时，检查器里说清楚差了多少。

/** 修剪会话：打开修剪时建立，切换素材/关闭时丢弃。blob 是分片的原样拼接，不带 duration 补丁。 */
let trim = null;
let trimOpening = null;
let trimGeneration = 0;
let openingMode = 'trim';
const MIN_KEEP_MS = 100;

function closeTrim() {
  trimGeneration++;
  trim = null;
  trimOpening = null;
  els.trimPanel.hidden = true;
  els.tlBody.classList.remove('trimming', 'cutting');
  els.trim.setAttribute('aria-pressed', 'false');
  els.cut.setAttribute('aria-pressed', 'false');
  for (const b of [els.trimSetStart, els.trimSetEnd, els.trimPreview, els.cutRemove]) b.disabled = true;
  els.trimKeys.innerHTML = '';
  els.cutMarks.innerHTML = '';
  if (current && !isImage(current)) { renderRuler(); drawPlayhead(); }
}

function trimBusy(on, text = '') {
  if (trim) trim.busy = on;
  for (const b of [els.trimSetStart, els.trimSetEnd, els.trimPreview, els.trimReplace, els.trimSave, els.cutRemove]) b.disabled = on;
  els.trimCancel.disabled = on && !!trim;
  for (const b of els.cutList.querySelectorAll('button')) b.disabled = on;
  if (!on && trim) renderTrim();
  els.trimMsg.hidden = !text;
  els.trimMsg.className = 'msg warn';
  els.trimMsg.textContent = text;
}

function trimFail(text) {
  trimBusy(false);
  els.trimMsg.hidden = false;
  els.trimMsg.className = 'msg';
  els.trimMsg.textContent = text;
}

function renderTrim() {
  if (!trim) return;
  const { index, start, end } = trim;
  const actual = snapStart(index, start);
  const D = index.durationMs;
  const cutting = trim.mode === 'cut';
  const plan = planCuts(index, trim.removed);
  const keepMs = cutting ? plan.kept.reduce((n, range) => n + range.endMs - range.startMs, 0) : end - actual;
  els.tlBody.classList.toggle('cutting', cutting);
  els.cutControls.hidden = !cutting;
  els.trimLabel.textContent = cutting ? '删除片段并拼接' : '修剪';
  els.trimPreviewText.textContent = cutting ? '试看拼接' : '试看选区';
  els.trimPreview.title = cutting ? '跳过已删除片段，预览拼接结果' : '只播放入点到出点这一段';
  els.trimCancel.textContent = cutting ? '取消剪辑' : '取消修剪';
  els.trim.setAttribute('aria-pressed', String(!cutting));
  els.cut.setAttribute('aria-pressed', String(cutting));
  els.trimSave.disabled = els.trimReplace.disabled = !!trim.busy || (cutting && !plan.removed.length);
  els.trimStart.style.left = pctOf(actual);
  els.trimEnd.style.left = pctOf(end);
  els.trimRange.style.left = pctOf(actual);
  els.trimRange.style.width = `${((end - actual) / D) * 100}%`;
  els.shadeL.style.width = pctOf(actual);
  els.shadeR.style.width = `${((D - end) / D) * 100}%`;
  els.trimStart.setAttribute('aria-valuetext', fmtTC(actual));
  els.trimEnd.setAttribute('aria-valuetext', fmtTC(end));
  els.trimStartText.textContent = fmtTC(actual);
  els.trimEndText.textContent = fmtTC(end);
  els.trimKeepText.textContent = fmtTC(keepMs);
  els.trimSizeText.textContent = fmtBytes((current.size || trim.blob.size) * (keepMs / D));
  // 偏差超过 0.1 秒才值得说
  const drift = start - actual;
  els.trimSnap.hidden = drift < 100;
  els.trimSnap.textContent = actual === 0 && index.cuts.length === 1
    ? '这段录像只有开头一个关键帧，入点只能在 00:00.00'
    : `入点对齐到关键帧：从 ${fmtTC(actual)} 开始，比所选的 ${fmtTC(start)} 早 ${(drift / 1000).toFixed(1)} 秒`;
  if (cutting) {
    const candidate = planCuts(index, [{ startMs: actual, endMs: end }]).removed[0];
    const pending = planCuts(index, [...trim.removed, candidate]);
    const boundary = candidate.endMs >= D ? '选区将删除至片尾。' : `选区将删除至 ${fmtTC(candidate.endMs)}，后半段从下一个关键帧接上。`;
    els.cutHint.textContent = `${!pending.kept.length ? '请设定入点和出点，至少保留一段视频。' : boundary} 已删除 ${plan.removed.length} 段，保留 ${plan.kept.length} 段；保存时按原顺序拼接。`;
    els.cutRemove.disabled = trim.busy || !pending.kept.length || JSON.stringify(pending.removed) === JSON.stringify(plan.removed);
  }
  els.cutList.replaceChildren();
  els.cutMarks.replaceChildren();
  plan.removed.forEach((range, i) => {
    const mark = document.createElement('i');
    mark.style.left = pctOf(range.startMs);
    mark.style.width = `${(range.endMs - range.startMs) / D * 100}%`;
    els.cutMarks.appendChild(mark);
    const row = document.createElement('div');
    row.className = 'cut-row';
    const label = document.createElement('span');
    label.className = 'num';
    label.textContent = `${fmtTC(range.startMs)} – ${fmtTC(range.endMs)}`;
    const restore = document.createElement('button');
    restore.className = 'link';
    restore.textContent = '恢复';
    restore.setAttribute('aria-label', `恢复片段 ${i + 1}`);
    restore.disabled = !!trim.busy;
    restore.addEventListener('click', () => { if (trim && !trim.busy) { trim.removed.splice(i, 1); trim.previewing = false; renderTrim(); } });
    row.append(label, restore);
    els.cutList.appendChild(row);
  });
}

function setTrimEdge(edge, ms) {
  if (!trim || trim.busy) return;
  trim.previewing = false;
  const D = trim.index.durationMs;
  if (edge === 'start') trim.start = Math.max(0, Math.min(ms, trim.end - MIN_KEEP_MS));
  else trim.end = Math.min(D, Math.max(ms, snapStart(trim.index, trim.start) + MIN_KEEP_MS));
  renderTrim();
}

/** 打开修剪：读出录像结构（关键帧位置）。I / O 快捷键也会走到这里。 */
function openTrim(mode = trim?.mode || 'trim') {
  if (!current || isImage(current) || current.status === STATUS.RECORDING) return null;
  if (trim) {
    if (!trim.busy) { trim.mode = mode; trim.previewing = false; renderTrim(); }
    return Promise.resolve(trim);
  }
  openingMode = mode;
  if (trimOpening) return trimOpening;
  const generation = ++trimGeneration;
  const rec = current;
  els.trim.setAttribute('aria-pressed', 'true');
  els.trimPanel.hidden = false;
  trimBusy(true, '正在读取录像结构…');
  trimOpening = (async () => {
    try {
      const blob = await assembleBlob(rec.id, { fixDuration: false });
      const index = await indexMedia(blob, rec.mimeType);
      if (current?.id !== rec.id || generation !== trimGeneration) return null;
      trim = { recId: rec.id, blob, index, start: 0, end: index.durationMs, previewing: false, mode: openingMode, removed: [] };
      els.trimKeys.innerHTML = '';
      for (const c of index.cuts) {
        const i = document.createElement('i');
        i.style.left = `${(c.ms / index.durationMs) * 100}%`;
        i.title = `关键帧 ${fmtTC(c.ms)}`;
        els.trimKeys.appendChild(i);
      }
      els.tlBody.classList.add('trimming');
      trimBusy(false);
      // 窄窗口里检查器很矮，修剪面板可能在折叠线下面
      els.trimPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      renderRuler();
      renderTrim();
      drawPlayhead();
      return trim;
    } catch (err) {
      if (generation !== trimGeneration) return null;
      console.error('[recorder] 读取录像结构失败', err);
      trimFail(`无法修剪：${err.message}`);
      return null;
    } finally {
      if (generation === trimGeneration) trimOpening = null;
    }
  })();
  return trimOpening;
}

els.trim.addEventListener('click', () => { if (trim?.busy) return; if (trim?.mode === 'trim') closeTrim(); else openTrim('trim'); });
els.cut.addEventListener('click', () => { if (trim?.busy) return; if (trim?.mode === 'cut') closeTrim(); else openTrim('cut'); });
els.cutRemove.addEventListener('click', () => {
  if (!trim || trim.busy) return;
  const plan = planCuts(trim.index, [...trim.removed, { startMs: snapStart(trim.index, trim.start), endMs: trim.end }]);
  if (!plan.kept.length) return;
  trim.removed = plan.removed;
  trim.start = 0;
  trim.end = trim.index.durationMs;
  trim.previewing = false;
  renderTrim();
});
els.trimCancel.addEventListener('click', closeTrim);
els.trimSetStart.addEventListener('click', () => setTrimEdge('start', nowMs()));
els.trimSetEnd.addEventListener('click', () => setTrimEdge('end', nowMs()));
els.trimPreview.addEventListener('click', () => {
  if (!trim) return;
  trim.previewRanges = trim.mode === 'cut' ? planCuts(trim.index, trim.removed).kept
    : [{ startMs: snapStart(trim.index, trim.start), endMs: trim.end }];
  if (!trim.previewRanges.length) return;
  trim.previewIndex = 0;
  seekTo(trim.previewRanges[0].startMs);
  trim.previewing = true;
  els.video.play().catch(() => {});
});

for (const [handle, edge] of [[els.trimStart, 'start'], [els.trimEnd, 'end']]) {
  handle.addEventListener('keydown', (e) => {
    if (!trim || trim.busy || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    // 入点只能落在关键帧上：方向键直接跳到上一个 / 下一个关键帧
    if (edge === 'start') {
      const cur = snapStart(trim.index, trim.start);
      const cuts = trim.index.cuts.map((c) => c.ms);
      const next = e.key === 'ArrowLeft' ? [...cuts].reverse().find((t) => t < cur - 0.5) : cuts.find((t) => t > cur + 0.5);
      if (next !== undefined) setTrimEdge('start', next);
      seekTo(snapStart(trim.index, trim.start));
    } else {
      setTrimEdge('end', trim.end + (e.shiftKey ? 1000 : 100) * (e.key === 'ArrowLeft' ? -1 : 1));
      seekTo(trim.end);
    }
  });
}

async function saveTrim(replace) {
  if (!trim || trim.busy || current?.id !== trim.recId) return;
  const rec = current;
  const action = trim.mode === 'cut' ? '剪辑' : '修剪';
  if (replace && !confirm(`用${action}结果替换「${rec.title}」？\n原录像将被永久删除，不可撤销。`)) return;
  const { blob, index, start, end, mode, removed } = trim;
  const session = trim;
  trim.previewing = false;
  els.video.pause();
  trimBusy(true, `正在${action}…`);
  try {
    const result = mode === 'cut' ? await cutMedia(blob, index, removed) : await trimMedia(blob, index, start, end);
    if (trim === session) trimBusy(true, '正在保存…');
    const saved = await saveTrimmed(rec, result, { replace });
    const showSaved = trim === session && current?.id === rec.id;
    if (showSaved) closeTrim();
    if (replace) selected.delete(rec.id);
    await refresh();
    if (showSaved && current?.id === rec.id) await select(saved.id);
  } catch (err) {
    console.error('[recorder] 修剪失败', err);
    if (trim === session) trimFail(`${action}失败：${err.message}${replace ? '。原录像没有改动' : ''}`);
  }
}

els.trimSave.addEventListener('click', () => saveTrim(false));
els.trimReplace.addEventListener('click', () => saveTrim(true));

// ── 快捷键：和常见剪辑软件一致 ──

document.addEventListener('keydown', async (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
  if (!current || isImage(current)) return;
  const step = e.shiftKey ? 1000 : 100;
  switch (e.key) {
    case ' ':
      if (t?.getAttribute?.('role') === 'button' || t instanceof HTMLButtonElement) return;
      e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); els.video.pause(); seekTo(nowMs() - step); break;
    case 'ArrowRight': e.preventDefault(); els.video.pause(); seekTo(nowMs() + step); break;
    case 'Home': e.preventDefault(); seekTo(0); break;
    case 'End': e.preventDefault(); seekTo(timelineMs()); break;
    case 'm': case 'M': els.video.muted = !els.video.muted; break;
    case 'f': case 'F': els.tFull.click(); break;
    case 'i': case 'I': {
      const at = nowMs();
      if (await openTrim()) setTrimEdge('start', at);
      break;
    }
    case 'o': case 'O': {
      const at = nowMs();
      if (await openTrim()) setTrimEdge('end', at);
      break;
    }
    case 'Escape': if (trim || trimOpening) closeTrim(); break;
    default:
  }
});

// ── 重命名 ──

let renameTimer = null;
els.title.addEventListener('input', () => {
  if (!current) return;
  clearTimeout(renameTimer);
  const title = els.title.value.trim() || current.title;
  renameTimer = setTimeout(async () => {
    await patchRecording(current.id, { title });
    current.title = title;
    els.viewerName.textContent = title;
    els.crumb.textContent = title;
    els.clipName.textContent = title;
    const row = recordings.find((r) => r.id === current.id);
    if (row) row.title = title;
    renderList();
  }, 400);
});

async function renderUsage() {
  const { usage, quota } = await storageEstimate();
  els.usageBar.style.width = `${quota ? Math.min(100, (usage / quota) * 100) : 0}%`;
  els.usageText.textContent = quota
    ? `本地已用 ${fmtBytes(usage)} / 可用 ${fmtBytes(quota)}`
    : `本地已用 ${fmtBytes(usage)}`;
}

async function refresh() {
  recordings = await listRecordings();
  // 别的入口（单条删除、录制结束后的刷新）可能让已选 id 失效，收敛一下
  const alive = new Set(recordings.map((r) => r.id));
  for (const id of [...selected]) if (!alive.has(id)) selected.delete(id);
  if (lastPicked && !alive.has(lastPicked)) lastPicked = null;
  renderList();
  ensureThumbs();
  await renderUsage();
}

(async () => {
  clearStage();
  // 录制库可能在录制过程中被打开：必须把当前活跃的 recordingId 排除在外，
  // 否则崩溃恢复逻辑会把正在写入的那条误判成"已中断"。
  let activeIds = [];
  try {
    const res = await chrome.runtime.sendMessage({ target: 'background', type: 'STATUS' });
    if (res?.ok && res.data?.active) activeIds = (res.data.sessions || []).map((s) => s.recordingId);
  } catch {}

  await reconcileInterrupted(activeIds);
  await refresh();

  const wanted = new URLSearchParams(location.search).get('id');
  const playable = recordings.filter((r) => r.status !== STATUS.RECORDING);
  const target = playable.find((r) => r.id === wanted) || playable[0];
  if (target) await select(target.id);
})();

// 新录制结束时自动刷新列表
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'REC_STOPPED') refresh();
});
