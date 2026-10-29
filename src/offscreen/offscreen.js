// Offscreen Document：MV3 里唯一能跑 MediaRecorder / getUserMedia 的常驻 DOM 环境。
// Service Worker 没有 DOM，而且随时会被回收；录制状态全部活在这里。
//
// 支持多路并发：sessions 是 recordingId -> 会话 的 Map，每路有自己的
// MediaRecorder、采集流、音频混流和写入队列，互不影响。
//
// 关键点：Blob 无法通过 chrome.runtime 消息通道传递（结构化克隆不支持），
// 所以分片由本文件直接写进 IndexedDB，SW 只收到轻量的进度事件。

import {
  TIMESLICE_MS, QUALITY, AUDIO_BPS, MIME_CANDIDATES, MODE, STATUS,
  FORMAT, formatOf, MODE_TITLE, isTabSource, areaSourceSize, MAX_ENCODE_W, MAX_ENCODE_H,
} from '../lib/constants.js';
import { cropBox } from '../lib/capture.js';
import {
  newRecordingId, createRecording, appendChunk,
  patchRecording, chunkStats, deleteRecording,
} from '../lib/db.js';

/** @type {Map<string, object>} recordingId -> session */
const sessions = new Map();

/** 所有会话共用一个心跳，而不是每路一个定时器。 */
let tickTimer = null;

function makeSession(id) {
  return {
    id,
    recorder: null,
    mimeType: '',
    picked: null,
    streams: [],       // 结束时要 stop() 的所有轨道来源
    audioCtx: null,
    seq: 0,
    bytes: 0,
    startedAt: 0,
    pausedAt: 0,
    pausedTotal: 0,
    ticks: 0,
    cropper: null,     // 区域录制的裁剪管线句柄（含显式拆卸）
    cropBox: null,     // 区域录制的真实输出尺寸，第一帧到达时才知道
    writeError: null,  // 首次分片落盘失败，该路录制立刻收尾并标记为出错
    recorderError: null, // 编码器报错的可读描述
    writeQueue: Promise.resolve(),
    stopping: null,    // Promise，保证 STOP 幂等
    meta: {},
  };
}

const elapsedMs = (s) => {
  if (!s?.startedAt) return 0;
  const end = s.pausedAt || Date.now();
  return Math.max(0, end - s.startedAt - s.pausedTotal);
};

const isPaused = (s) => s.recorder?.state === 'paused';

function send(msg) {
  // 没有监听方时 sendMessage 会 reject，属于正常情况。
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * offscreen 文档有自己独立的控制台（chrome://extensions 里是另一个 inspect 目标），
 * 光看 Service Worker 的日志根本看不到这边发生了什么。
 * 关键诊断转发过去，一个控制台就能读完整条链路。
 */
function report(text) {
  console.log('[recorder]', text);
  send({ type: 'REC_LOG', text });
}

const snapshot = (s) => ({
  recordingId: s.id,
  title: s.meta.title,
  mode: s.meta.mode,
  tabId: s.meta.tabId ?? null,
  elapsedMs: elapsedMs(s),
  bytes: s.bytes,
  paused: isPaused(s),
  error: s.writeError ? String(s.writeError.message || s.writeError) : null,
});

const allSnapshots = () => [...sessions.values()].map(snapshot);

/**
 * 挑一个真正能用的编码器。
 * MP4 录制要 Chrome 130+，且 H.264 编码依赖平台编码器——不可用时静默退回 WebM
 * 是不行的，用户选了 MP4 却拿到 WebM 必须被告知，所以这里把降级事实一并返回。
 */
function pickMimeType(requested) {
  const order = requested === FORMAT.WEBM
    ? [FORMAT.WEBM, FORMAT.MP4]
    : [FORMAT.MP4, FORMAT.WEBM];
  for (const fmt of order) {
    for (const m of MIME_CANDIDATES[fmt]) {
      if (MediaRecorder.isTypeSupported(m)) {
        return { mimeType: m, format: fmt, fellBack: fmt !== requested };
      }
    }
  }
  return { mimeType: '', format: requested, fellBack: false }; // 交给浏览器默认
}

// ---------------------------------------------------------------- 采集

/** tabCapture / desktopCapture 拿到的 streamId 在这里还原成真实 MediaStream。 */
async function captureFromStreamId(streamId, source, q, wantAudio) {
  const video = {
    mandatory: {
      chromeMediaSource: source,
      chromeMediaSourceId: streamId,
      maxWidth: q.width,
      maxHeight: q.height,
      maxFrameRate: q.fps,
    },
  };
  const audio = wantAudio
    ? { mandatory: { chromeMediaSource: source, chromeMediaSourceId: streamId } }
    : false;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch (err) {
    if (!wantAudio) throw err;
    // 用户在屏幕选择器里没勾"分享音频"时，带 audio 的约束会直接失败。
    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }
}

async function buildStream(opts, onCropBox, onCropEnd) {
  const cleanup = [];
  let audioCtx = null;
  try {
    return await buildStreamInner(opts, cleanup, (ctx) => { audioCtx = ctx; }, onCropBox, onCropEnd);
  } catch (err) {
    // 任何一步失败都要回收已经打开的轨道，否则摄像头指示灯会一直亮着，
    // 直到 offscreen 文档被销毁为止。
    for (const stream of cleanup) stream.getTracks().forEach((t) => t.stop());
    if (audioCtx && audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
    throw err;
  }
}

/**
 * 按选区裁出一条新的视频轨。
 *
 * 用 Insertable Streams（MediaStreamTrackProcessor + VideoFrame 的 visibleRect），
 * 不用 canvas 逐帧重绘——offscreen 文档是隐藏的，requestAnimationFrame 根本不会触发，
 * canvas 方案会直接停摆。visibleRect 还是零拷贝，不需要每帧 drawImage。
 */
function cropVideoTrack(track, region, onBox, onUnexpectedEnd) {
  if (typeof MediaStreamTrackProcessor === 'undefined'
      || typeof MediaStreamTrackGenerator === 'undefined') {
    throw new Error('当前浏览器不支持区域录制（缺少 Insertable Streams 支持）');
  }
  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const reader = processor.readable.getReader();
  const w = generator.writable.getWriter();

  let box = null;
  let cropWarned = false;
  let closed = false;
  let framesIn = 0;
  let framesOut = 0;
  let fresh = false;
  let keeper = null;     // 最近一帧的副本，静止画面时用它续命

  /**
   * 心跳。
   *
   * tabCapture 是"内容有变化才出帧"的模型：直接把源轨喂给 MediaRecorder 时，
   * 浏览器内部会补齐时序；但经过 Insertable Streams 之后，源不出帧，
   * 生成器就一帧都没有，录出来是空文件——完全静止的页面正好命中这个坑。
   *
   * 所以没有新帧时重发上一帧。offscreen 文档是隐藏的，定时器被钳到最小 1 秒，
   * 1fps 作为下限足够让数据持续流动；页面一动，源帧照常走主链路。
   */
  const HEARTBEAT_MS = 1000;
  const heartbeat = setInterval(() => {
    if (closed || !keeper) return;
    if (fresh) { fresh = false; return; }   // 源在出帧，不用管
    try {
      w.write(new VideoFrame(keeper, { timestamp: Math.round(performance.now() * 1000) }));
      framesOut++;
    } catch (err) {
      if (!cropWarned) { cropWarned = true; console.warn('[recorder] 心跳帧写入失败', err); }
    }
  }, HEARTBEAT_MS);

  // 静止页面最多补 1fps；连一帧都没有说明采集源本身有问题，要说出来
  const stallCheck = setTimeout(() => {
    if (framesIn === 0) {
      report('⚠ 区域录制 3 秒内没有收到任何视频帧，采集源可能异常');
    }
  }, 3000);

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(stallCheck);
    try { keeper?.close(); } catch {}
    keeper = null;
    report(`区域裁剪结束 收到 ${framesIn} 帧 / 输出 ${framesOut} 帧`);
  };

  /**
   * 显式拆管线。
   * 不能指望读循环自己结束——源一旦卡住（静止页面 + 采集异常），reader.read()
   * 会永远挂着，finally 永远不执行，心跳定时器就泄漏了：录制早停了，
   * 帧还在往一个没人要的轨道里写。
   */
  let teardownRequested = false;
  const stop = () => {
    teardownRequested = true;
    finish();
    reader.cancel().catch(() => {});
    try { w.close(); } catch {}
    try { generator.stop(); } catch {}
  };

  (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        framesIn++;
        if (!box) {
          const fw = frame.displayWidth || frame.codedWidth;
          const fh = frame.displayHeight || frame.codedHeight;
          box = cropBox({ width: fw, height: fh }, region.rect, region.viewportWidth);
          report(`区域裁剪 源=${fw}x${fh} 视口宽=${region.viewportWidth} `
            + `选区=${JSON.stringify(region.rect)} → 裁剪框=${JSON.stringify(box)}`);
          onBox?.(box); // 真实输出尺寸只有拿到第一帧才知道，回填进元数据
        }
        let out = frame;
        try {
          out = new VideoFrame(frame, {
            visibleRect: box,
            displayWidth: box.width,
            displayHeight: box.height,
          });
          frame.close();
        } catch (err) {
          // 裁剪失败就透传原帧：宁可录到整个标签页，也好过整条录制断掉
          if (!cropWarned) { cropWarned = true; console.warn('[recorder] 区域裁剪失败，改为整页录制', err); }
          out = frame;
        }
        // 留一份副本给心跳用。必须在 write 之前克隆——write 会接管并关闭这一帧。
        try { keeper?.close(); } catch {}
        try { keeper = new VideoFrame(out, { timestamp: out.timestamp }); } catch { keeper = null; }
        fresh = true;
        await w.write(out);
        framesOut++;
      }
    } catch (err) {
      console.warn('[recorder] 裁剪管线结束', err);
    } finally {
      const unexpected = !teardownRequested;
      finish();
      try { await w.close(); } catch {}
      // 管线自己断了（不是我们主动拆的）说明采集链路出了问题，
      // 继续录下去只会产出空文件，得让上层知道原因。
      if (unexpected) onUnexpectedEnd?.(framesIn);
    }
  })();

  return { track: generator, stop };
}

async function buildStreamInner(opts, cleanup, onAudioCtx, onCropBox, onCropEnd) {
  const q = QUALITY[opts.quality] || QUALITY['1080p'];
  let videoTrack = null;
  let sourceVideoTrack = null;
  let sourceAudioTracks = [];

  if (opts.mode === MODE.CAMERA) {
    const cam = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: opts.cameraDeviceId ? { exact: opts.cameraDeviceId } : undefined,
        width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps },
      },
      audio: false,
    });
    cleanup.push(cam);
    videoTrack = cam.getVideoTracks()[0];
    sourceVideoTrack = videoTrack;
  } else {
    const source = isTabSource(opts.mode) ? 'tab' : 'desktop';
    // 区域录制按视口的实际设备像素采集（1:1），既不降采样也不上采样。
    // 之前拍了个 7680×4320 的上限，tabCapture 真的照这个尺寸出帧，
    // 把标签页上采样到 8K，裁剪结果直接撞穿 H.264 编码器上限而中止录制。
    let sourceQuality = q;
    if (opts.mode === MODE.AREA) {
      const src = areaSourceSize(opts.region, q);
      sourceQuality = { ...q, width: src.width, height: src.height };
      report(`区域采集源 ${src.width}x${src.height}`
        + (src.scale < 1 ? `（为不超出编码上限已整体缩至 ${(src.scale * 100).toFixed(0)}%）` : '（1:1 原生）'));
    }
    const stream = await captureFromStreamId(opts.streamId, source, sourceQuality, opts.systemAudio);
    cleanup.push(stream);
    videoTrack = stream.getVideoTracks()[0];
    sourceVideoTrack = videoTrack;
    sourceAudioTracks = stream.getAudioTracks();
  }
  if (!videoTrack) throw new Error('没有取到视频轨道');

  let cropper = null;
  if (opts.mode === MODE.AREA) {
    // 选区丢了却照常录，出来的是整个标签页——每一步都"成功"，结果完全不对。
    // 这种静默错位必须当场拦下。
    if (!opts.region?.rect) throw new Error('区域录制没有收到选区范围');
    const vw = Number(opts.region.viewportWidth);
    if (!(vw > 0)) throw new Error(`区域录制缺少视口宽度（拿到 ${opts.region.viewportWidth}），无法换算裁剪比例`);
    report(`区域录制：选区 ${JSON.stringify(opts.region.rect)} 视口宽 ${vw}`);
    cropper = cropVideoTrack(videoTrack, opts.region, onCropBox, onCropEnd);
    videoTrack = cropper.track;
  }

  // ---- 音频混流 ----
  let audioCtx = null;
  let mixedTracks = [];
  let micStream = null;

  if (opts.mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.micDeviceId ? { exact: opts.micDeviceId } : undefined,
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
        video: false,
      });
      cleanup.push(micStream);
    } catch (err) {
      console.warn('[recorder] 麦克风不可用，改为静音录制:', err);
    }
  }

  const inputs = [];
  // monitor：是否把这路声音同时回接扬声器。
  // 只要走 tabCapture（标签页 / 区域），Chrome 就会把标签页原声掐掉，必须回接，
  // 否则用户录制期间完全听不到声音。之前这里写的是 opts.mode === MODE.TAB，
  // 区域录制漏掉了——它同样是 tabCapture，同样会静音。
  if (sourceAudioTracks.length) {
    inputs.push({ tracks: sourceAudioTracks, monitor: isTabSource(opts.mode) });
  }
  if (micStream?.getAudioTracks().length) inputs.push({ tracks: micStream.getAudioTracks(), monitor: false });

  if (inputs.length) {
    audioCtx = new AudioContext();
    onAudioCtx(audioCtx);
    const dest = audioCtx.createMediaStreamDestination();
    for (const input of inputs) {
      const node = audioCtx.createMediaStreamSource(new MediaStream(input.tracks));
      node.connect(dest);
      // 屏幕录制不能回接，会形成回环把系统声音再喂回系统声音。
      if (input.monitor) node.connect(audioCtx.destination);
    }
    mixedTracks = dest.stream.getAudioTracks();
  }

  const settings = videoTrack.getSettings?.() || {};
  // 采集源本身的轨道。'ended' 只能监听它——那才是"用户点了停止共享 / 标签页关了"。
  // 裁剪轨的尺寸要等第一帧才知道，先按选区推一个值，正式尺寸由 recorder 落库时更新
  const est = opts.mode === MODE.AREA && opts.region?.rect
    ? { width: Math.round(opts.region.rect.w), height: Math.round(opts.region.rect.h) }
    : {};
  return {
    stream: new MediaStream([videoTrack, ...mixedTracks]),
    sourceVideoTrack,
    cleanup,
    audioCtx,
    cropper,
    hasAudio: mixedTracks.length > 0,
    width: settings.width || est.width || q.width,
    height: settings.height || est.height || q.height,
  };
}

// ---------------------------------------------------------------- 生命周期

async function prepare(opts) {
  const s = makeSession(newRecordingId());
  sessions.set(s.id, s);

  // 裁剪管线自己断了：报出来并收尾，但要说清楚是管线断的，不是用户停的
  const onCropEnd = (framesIn) => {
    report(`⚠ 裁剪管线意外结束 rec=${s.id}（共收到 ${framesIn} 帧）`);
    if (sessions.has(s.id)) stop(s.id, 'crop-pipeline-ended').catch(() => {});
  };

  // 裁剪框要等第一帧才算得出来，而记录此时可能还没建。
  // 先存到会话上，begin() 再兜底写一次，保证库里显示的是真实输出分辨率。
  const onCropBox = (box) => {
    s.cropBox = box;
    s.meta.width = box.width;
    s.meta.height = box.height;
    patchRecording(s.id, { width: box.width, height: box.height }).catch(() => {});
  };

  let built;
  try {
    built = await buildStream(opts, onCropBox, onCropEnd);
  } catch (err) {
    sessions.delete(s.id);
    console.error('[recorder] 打开采集流失败', err);
    throw new Error(`打开采集流：${err?.message || err}`);
  }

  s.streams = built.cleanup;
  s.audioCtx = built.audioCtx;
  s.cropper = built.cropper || null;
  const picked = pickMimeType(opts.format || FORMAT.MP4);
  s.mimeType = picked.mimeType;
  s.picked = picked;

  try {
    await setupRecorder(s, built, opts);
  } catch (err) {
    console.error('[recorder] 创建编码器失败', err);
    // 建 MediaRecorder 失败：把已经打开的轨道回收掉，
    // 不要留下悬空的采集设备（摄像头灯会一直亮着）。
    teardown(s);
    sessions.delete(s.id);
    throw new Error(`创建编码器（${s.mimeType || '默认编码'}）：${err?.message || err}`);
  }

  return {
    recordingId: s.id,
    mimeType: s.mimeType,
    formatFellBack: s.picked.fellBack,
    requestedFormat: opts.format || FORMAT.MP4,
    ...s.meta,
  };
}

async function setupRecorder(s, built, opts) {
  const q = QUALITY[opts.quality] || QUALITY['1080p'];
  s.meta = {
    id: s.id,
    title: opts.title || defaultTitle(opts),
    mode: opts.mode,
    tabId: opts.tabId ?? null,
    mimeType: s.mimeType || 'video/webm',
    format: s.mimeType ? formatOf(s.mimeType) : FORMAT.WEBM,
    quality: opts.quality,
    width: built.width,
    height: built.height,
    hasAudio: built.hasAudio,
    hasCamera: !!opts.camera,
  };
  await createRecording(s.meta);

  s.recorder = new MediaRecorder(built.stream, {
    mimeType: s.mimeType || undefined,
    videoBitsPerSecond: q.videoBps,
    audioBitsPerSecond: AUDIO_BPS,
  });

  s.recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size || !sessions.has(s.id)) return;
    const seq = s.seq++;
    s.bytes += e.data.size;
    // 串行化写入，避免高码率下并发事务把 IDB 压垮
    s.writeQueue = s.writeQueue
      .then(() => appendChunk(s.id, seq, e.data))
      .catch((err) => onWriteFailure(s, seq, err));
  };

  s.recorder.onerror = (e) => {
    const name = e.error?.name || '';
    report(`⚠ 编码器报错 rec=${s.id}：${name} ${e.error?.message || e.error}`);
    console.error('[recorder] MediaRecorder error', e.error);
    // EncodingError 绝大多数是分辨率撞穿了硬件编码器上限。把尺寸写进记录里，
    // 用户看到"编码失败"三个字是没法处理的，看到尺寸就知道该缩小选区。
    s.recorderError = name === 'EncodingError'
      ? `编码器不支持当前分辨率 ${s.meta.width}×${s.meta.height}（上限约 ${MAX_ENCODE_W}×${MAX_ENCODE_H}），请缩小录制区域或降低画质`
      : `编码器报错：${name} ${e.error?.message || ''}`.trim();
    send({ type: 'REC_ERROR', recordingId: s.id, error: String(e.error?.message || e.error) });
    finalize(s, STATUS.ERROR).catch(() => {});
  };

  // 用户点了 Chrome 自带的"停止共享"，或标签页被关闭。
  //
  // 必须挂在采集源上，不能挂 built.stream 的第一条轨：区域录制时那是裁剪管线的
  // 输出轨，我们的 writer 一关它就 'ended'，读循环打个嗝就会把整条录制干掉——
  // 表现就是"红框闪一下就没了"。输出轨的生死是我们自己的事，不该当成用户意图。
  (built.sourceVideoTrack || built.stream.getVideoTracks()[0])
    .addEventListener('ended', () => {
      if (sessions.has(s.id)) stop(s.id, 'source-ended').catch(() => {});
    });
}

/**
 * 分片落盘失败的处理。
 * 最现实的原因是磁盘/配额耗尽——那不会自行恢复，继续录下去只会产出一段中间有洞、
 * 却被标成"已完成"的视频。所以第一次失败就收尾，并把记录标记为出错，
 * 让用户知道只有前面这段是完整的。
 *
 * 多路并发时配额是共享的：一路写满盘，其他几路马上也会撞上，各自独立收尾。
 */
function onWriteFailure(s, seq, err) {
  console.error('[recorder] 分片写入失败', s.id, seq, err);
  if (s.writeError) return;
  s.writeError = err;
  send({
    type: 'REC_WRITE_FAILED',
    recordingId: s.id,
    seq,
    error: err?.name === 'QuotaExceededError' ? '本地存储空间不足' : (err?.message || String(err)),
  });
  if (sessions.has(s.id)) stop(s.id, 'write-failed').catch(() => {});
}

function defaultTitle(opts) {
  return MODE_TITLE[opts.mode] || '录制';
}

// ---------------------------------------------------------------- 心跳

function ensureTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (!sessions.size) { stopTicker(); return; }
    send({ type: 'REC_TICK', sessions: allSnapshots() });
    for (const s of sessions.values()) {
      // 每 10 秒把真实时长写进元数据：崩溃恢复时时间戳相减会把暂停和倒计时算进去，
      // 有这个值就能把误差压到 10 秒以内。相对 3 秒一片的视频写入，开销可以忽略。
      if (++s.ticks % 10 === 0) patchRecording(s.id, { duration: elapsedMs(s) }).catch(() => {});
    }
  }, 1000);
}

function stopTicker() {
  clearInterval(tickTimer);
  tickTimer = null;
}

// ---------------------------------------------------------------- 控制

function requireSession(recordingId) {
  const s = sessions.get(recordingId);
  if (!s) throw new Error(`录制不存在或已结束：${recordingId}`);
  return s;
}

function begin(recordingId) {
  const s = requireSession(recordingId);
  if (!s.recorder) throw new Error('尚未准备录制');
  // 对已经在录的 recorder 再调 start() 会抛 InvalidStateError。
  // 重复的 BEGIN 当成幂等，不该把整条录制打断。
  if (s.recorder.state !== 'inactive') return { recordingId: s.id, startedAt: s.startedAt };
  s.startedAt = Date.now();
  patchRecording(s.id, {
    startedAt: s.startedAt,
    // onCropBox 可能在 createRecording 之前就跑了，那次 patch 会落空，这里补写
    ...(s.cropBox ? { width: s.cropBox.width, height: s.cropBox.height } : {}),
  }).catch(() => {});
  s.recorder.start(TIMESLICE_MS);
  ensureTicker();
  send({ type: 'REC_STARTED', recordingId: s.id });
  return { recordingId: s.id, startedAt: s.startedAt };
}

function pause(recordingId) {
  const s = requireSession(recordingId);
  if (s.recorder.state === 'recording') {
    s.recorder.pause();
    s.pausedAt = Date.now();
    send({ type: 'REC_PAUSED', recordingId: s.id });
  }
  return snapshot(s);
}

function resume(recordingId) {
  const s = requireSession(recordingId);
  if (s.recorder.state === 'paused') {
    s.pausedTotal += Date.now() - s.pausedAt;
    s.pausedAt = 0;
    s.recorder.resume();
    send({ type: 'REC_RESUMED', recordingId: s.id });
  }
  return snapshot(s);
}

function teardown(s) {
  // 裁剪管线不属于任何 cleanup 流，必须显式拆掉：
  // 停掉心跳、取消 reader、关掉输出轨，否则录制结束后帧还在往空轨道里写。
  try { s.cropper?.stop(); } catch {}
  for (const stream of s.streams) stream.getTracks().forEach((t) => t.stop());
  if (s.audioCtx && s.audioCtx.state !== 'closed') s.audioCtx.close().catch(() => {});
  s.streams = [];
}

/** 停止 → 冲刷分片 → 落库。这一路的资源在这里全部释放。 */
async function finalize(s, finalStatus = STATUS.DONE) {
  if (!sessions.has(s.id)) return null;
  sessions.delete(s.id);
  if (!sessions.size) stopTicker();

  const duration = elapsedMs(s);
  teardown(s);
  await s.writeQueue;

  const stats = await chunkStats(s.id);
  if (stats.chunkCount === 0) {
    // 一片都没落盘。绝不能静默删掉了事——那样用户点了"结束"之后什么都不会发生，
    // 录制库里也空空如也，完全不知道发生了什么。留下这条记录并写明原因。
    const rec = await patchRecording(s.id, {
      status: STATUS.ERROR,
      error: s.recorderError
        || (s.writeError
          ? `分片写入失败：${s.writeError.message || s.writeError}`
          : '没有采集到任何视频数据（录制时间过短，或采集源在开录前就已结束）'),
      duration,
      finishedAt: Date.now(),
      chunkCount: 0,
      size: 0,
    });
    return rec || { ...s.meta, id: s.id, empty: true, duration, size: 0 };
  }

  // 注意：这里不给分片打 EBML 补丁。Duration 修复放在读取侧（db.assembleBlob）
  // 在内存里做，落盘数据保持 MediaRecorder 原样——补丁改的是整段视频的解码入口，
  // 写坏了就是整段不能播，不值得拿录制成果去赌。

  const finalStats = await chunkStats(s.id);
  const rec = await patchRecording(s.id, {
    status: (s.writeError || s.recorderError) ? STATUS.ERROR : finalStatus,
    error: s.recorderError
      || (s.writeError
        ? (s.writeError.name === 'QuotaExceededError' ? '本地存储空间不足，只保留了中断前的部分' : String(s.writeError.message || s.writeError))
        : undefined),
    duration,
    finishedAt: Date.now(),
    ...finalStats,
  });
  return rec || { ...s.meta, id: s.id, duration, ...finalStats };
}

function stop(recordingId, reason = 'manual') {
  const s = sessions.get(recordingId);
  if (!s) return Promise.resolve(null);
  if (s.stopping) return s.stopping;
  report(`停止录制 rec=${recordingId} 原因=${reason}`);

  s.stopping = new Promise((resolve) => {
    const r = s.recorder;
    if (!r || r.state === 'inactive') {
      finalize(s).then(resolve);
      return;
    }
    r.onstop = () => { finalize(s).then(resolve); };
    try { r.requestData(); } catch {}
    r.stop();
  }).then((rec) => {
    send({ type: 'REC_STOPPED', recordingId, recording: rec });
    return rec;
  });

  return s.stopping;
}

async function stopAll() {
  const ids = [...sessions.keys()];
  const recs = await Promise.all(ids.map((id) => stop(id).catch(() => null)));
  return { recordings: recs.filter(Boolean) };
}

/** 放弃这一路：停下来并把已落盘的分片一并删掉。 */
async function cancel(recordingId) {
  const rec = await stop(recordingId);
  if (rec?.id) await deleteRecording(rec.id);
  send({ type: 'REC_CANCELLED', recordingId });
  return { ok: true, recordingId };
}

function status(recordingId) {
  if (recordingId) {
    const s = sessions.get(recordingId);
    return s ? { active: true, ...snapshot(s) } : { active: false };
  }
  return { active: sessions.size > 0, count: sessions.size, sessions: allSnapshots() };
}

// ---------------------------------------------------------------- 消息路由

const handlers = {
  PREPARE: (msg) => prepare(msg.options),
  BEGIN: (msg) => begin(msg.recordingId),
  PAUSE: (msg) => pause(msg.recordingId),
  RESUME: (msg) => resume(msg.recordingId),
  STOP: (msg) => stop(msg.recordingId).then((rec) => ({ recording: rec })),
  STOP_ALL: () => stopAll(),
  CANCEL: (msg) => cancel(msg.recordingId),
  STATUS: (msg) => status(msg.recordingId),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return undefined;
  const fn = handlers[msg.type];
  if (!fn) return undefined;
  Promise.resolve()
    .then(() => fn(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.error('[recorder] offscreen', msg.type, err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    });
  return true; // 异步响应
});
