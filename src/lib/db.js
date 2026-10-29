// IndexedDB 存储层：录制元数据 + 视频分片。
// 所有数据只存在本机，扩展没有任何网络请求。
import {
  DB_NAME, DB_VERSION, STORE_RECORDINGS, STORE_CHUNKS, STATUS,
} from './constants.js';
import { fixWebmDuration } from './webm-duration.js';
import { FORMAT, formatOf, KIND, kindOf } from './constants.js';

let dbPromise = null;

/** 连接失效后必须能重开：memo 住一个已关闭的连接，之后每次 transaction() 都是 InvalidStateError。 */
function resetDb() { dbPromise = null; }

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        const s = db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
        s.createIndex('byCreatedAt', 'createdAt');
        s.createIndex('byStatus', 'status');
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        // 复合主键 [recordingId, seq] 天然按序号排序，读取即拼接顺序。
        db.createObjectStore(STORE_CHUNKS, { keyPath: ['recordingId', 'seq'] });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 连接被浏览器关掉（上下文销毁、存储被清、版本变更）时丢掉 memo，下次自动重开
      db.onclose = resetDb;
      db.onversionchange = () => { db.close(); resetDb(); };
      resolve(db);
    };
    req.onerror = () => { resetDb(); reject(req.error); };
  });
  dbPromise.catch(resetDb);
  return dbPromise;
}

/**
 * 跑一个事务，连接失效时自动重开重试一次。
 *
 * IndexedDB 的连接可能在我们不知情的时候被关掉——offscreen 文档被销毁、
 * 用户清了站点数据、另一个上下文触发了版本变更。此时 db.transaction() 抛
 * InvalidStateError，而我们 memo 着那个死连接，后续每一次读写都会失败。
 *
 * body 同步发出请求，返回值可以是 wrap() 出来的 Promise。
 */
async function runTx(stores, mode, body) {
  for (let attempt = 0; ; attempt++) {
    const db = await openDb();
    try {
      const { t, done } = tx(db, stores, mode);
      const pending = body(t);
      await done;
      return await pending;
    } catch (err) {
      if (attempt === 0 && err?.name === 'InvalidStateError') {
        console.warn('[recorder] IndexedDB 连接已失效，重开后重试');
        resetDb();
        continue;
      }
      throw err;
    }
  }
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
  return { t, done };
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const chunkRange = (id) =>
  IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

export function newRecordingId() {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createRecording(meta) {
  const rec = {
    status: STATUS.RECORDING,
    createdAt: Date.now(),
    duration: 0,
    size: 0,
    chunkCount: 0,
    ...meta,
  };
  await runTx([STORE_RECORDINGS], 'readwrite', (t) => {
    t.objectStore(STORE_RECORDINGS).put(rec);
  });
  return rec;
}

/** 单个分片落盘。录制过程中被高频调用，保持轻量。 */
export async function appendChunk(recordingId, seq, blob) {
  await runTx([STORE_CHUNKS], 'readwrite', (t) => {
    t.objectStore(STORE_CHUNKS).put({ recordingId, seq, blob, size: blob.size, ts: Date.now() });
  });
}

/**
 * 读-改-写合并到一个事务里。
 * put 必须在 get 的 onsuccess 里同步发出，不能 `await wrap(get)` 之后再发：
 * 那样依赖"事务在 success 事件的微任务检查点里仍处于 active"这个规范灰区，
 * 一旦续体被推迟到下一个宏任务就是 TransactionInactiveError。
 */
export async function patchRecording(id, patch) {
  let merged = null;
  await runTx([STORE_RECORDINGS], 'readwrite', (t) => {
    const store = t.objectStore(STORE_RECORDINGS);
    const req = store.get(id);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      merged = { ...cur, ...patch };
      store.put(merged);
    };
  });
  return merged;
}

export async function getRecording(id) {
  return runTx([STORE_RECORDINGS], 'readonly', (t) =>
    wrap(t.objectStore(STORE_RECORDINGS).get(id)));
}

export async function listRecordings() {
  const all = await runTx([STORE_RECORDINGS], 'readonly', (t) =>
    wrap(t.objectStore(STORE_RECORDINGS).getAll()));
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 把分片拼回一个完整 Blob。
 * Blob 的分片是磁盘背书的，new Blob([...]) 只建引用，不会把整段视频读进内存。
 *
 * MediaRecorder 的头里没有 Duration，这里在内存中补上，让播放器能拖进度条。
 * 补丁不回写数据库：它改的是整段视频的解码入口，打歪就是整段不能播；
 * 落盘的分片永远保持 MediaRecorder 的原样，最坏情况只是进度条不可拖。
 */
export async function assembleBlob(id, { fixDuration = true } = {}) {
  const rows = await runTx([STORE_CHUNKS], 'readonly', (t) =>
    wrap(t.objectStore(STORE_CHUNKS).getAll(chunkRange(id))));
  const rec = await getRecording(id);
  rows.sort((a, b) => a.seq - b.seq);
  const mimeType = rec?.mimeType || 'video/webm';
  const raw = new Blob(rows.map((r) => r.blob), { type: mimeType });
  // duration 补丁是 EBML 专用的：套到 MP4 上会写坏 ISOBMFF 的盒子结构，
  // 套到截图上更是无从谈起。只有 WebM 视频才走。
  const isWebmVideo = kindOf(rec) === KIND.VIDEO && mimeType.startsWith('video/webm');
  if (!fixDuration || !(rec?.duration > 0) || !isWebmVideo) return raw;
  return fixWebmDuration(raw, rec.duration);
}

/**
 * 存一张截图。
 * 图片是单个 Blob，但仍然写进 chunks 表（seq 0）——这样 assembleBlob / deleteRecording /
 * 存储统计全都不用为图片开第二条路径，库里视频和截图共用一套读写。
 */
export async function createCapture(meta, blob) {
  const rec = await createRecording({
    id: meta.id || newRecordingId(),   // recordings 的 keyPath 是 id，缺了 put 直接被拒
    ...meta,
    kind: KIND.IMAGE,
    status: STATUS.DONE,
    size: blob.size,
    chunkCount: 1,
    duration: 0,
    finishedAt: Date.now(),
  });
  await appendChunk(rec.id, 0, blob);
  return rec;
}

/** 修剪结果落盘时的分片大小。和录制的 3 秒一片无关，只是不让单次写入过大。 */
const TRIM_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 保存修剪结果（见 docs/adr/0001）。
 *
 * 顺序是「先写后删」：新内容用一个新 id 完整写进 chunks，最后在一个事务里写入记录——
 * 替换原录像时，删除原录像也在这同一个事务里。中途任何一步失败，原录像都原封不动；
 * 已经写进去的半截分片会被清掉（只有进程在写入中途被杀，才会留下没有记录引用的分片）。
 *
 * 替换不是原地改写：对用户来说它还是那一条（标题、录制时间、状态标签都不变），
 * 只是换了 id，这样新旧分片永远不会混在同一个 id 下被拼到一起。
 *
 * @param {object} src     原录像的记录
 * @param {{blob: Blob, startMs: number, endMs: number, durationMs: number}} result trimMedia 的结果
 * @param {{replace: boolean}} opts
 * @returns {Promise<object>} 新记录
 */
export async function saveTrimmed(src, result, { replace }) {
  const { blob } = result;
  // 替换也是先写后删，写入时新旧两份同时在盘上，所以两种方式都要先看空间
  const { usage, quota } = await storageEstimate();
  if (quota && quota - usage < blob.size) {
    throw new Error(`本地空间不足：需要 ${Math.ceil(blob.size / 1048576)} MB，剩余 ${Math.floor((quota - usage) / 1048576)} MB`);
  }

  const id = newRecordingId();
  let seq = 0;
  try {
    for (let off = 0; off < blob.size; off += TRIM_CHUNK_BYTES) {
      await appendChunk(id, seq++, blob.slice(off, Math.min(blob.size, off + TRIM_CHUNK_BYTES), blob.type));
    }
  } catch (err) {
    await runTx([STORE_CHUNKS], 'readwrite', (t) => { t.objectStore(STORE_CHUNKS).delete(chunkRange(id)); })
      .catch(() => {});
    throw err;
  }

  const trim = {
    fromId: src.id, fromTitle: src.title, replaced: !!replace,
    startMs: result.startMs, endMs: result.endMs, at: Date.now(),
    ...(result.ranges ? { ranges: result.ranges, removed: result.removed } : {}),
  };
  const content = { id, duration: result.durationMs, size: blob.size, chunkCount: seq, trim };
  // 缩略图取自原录像的画面，修剪后开头变了，丢掉让素材库重新生成
  const { thumb, ...base } = src;
  let rec;
  if (replace) {
    rec = { ...base, ...content };
  } else {
    // 新素材是完整写好的：原录像中断过、写入失败过，不代表它也是
    const { error, ...rest } = base;
    rec = {
      ...rest,
      ...content,
      title: `${src.title || '录制'}（${result.removed ? '剪辑' : '修剪'}）`,
      status: STATUS.DONE,
      finishedAt: Date.now(),
    };
  }

  try {
    await runTx([STORE_RECORDINGS, STORE_CHUNKS], 'readwrite', (t) => {
      t.objectStore(STORE_RECORDINGS).put(rec);
      if (replace) {
        t.objectStore(STORE_RECORDINGS).delete(src.id);
        t.objectStore(STORE_CHUNKS).delete(chunkRange(src.id));
      }
    });
  } catch (err) {
    await runTx([STORE_CHUNKS], 'readwrite', (t) => { t.objectStore(STORE_CHUNKS).delete(chunkRange(id)); })
      .catch(() => {});
    throw err;
  }
  return rec;
}

export async function chunkStats(id) {
  const rows = await runTx([STORE_CHUNKS], 'readonly', (t) =>
    wrap(t.objectStore(STORE_CHUNKS).getAll(chunkRange(id))));
  return {
    chunkCount: rows.length,
    size: rows.reduce((n, r) => n + (r.size || 0), 0),
    lastTs: rows.length ? Math.max(...rows.map((r) => r.ts || 0)) : 0,
  };
}

export async function deleteRecording(id) {
  await deleteRecordings([id]);
}

/** 批量删除走同一个事务：要么全删掉，要么一条都不动，不会留下半截。 */
export async function deleteRecordings(ids) {
  if (!ids.length) return;
  await runTx([STORE_RECORDINGS, STORE_CHUNKS], 'readwrite', (t) => {
    for (const id of ids) {
      t.objectStore(STORE_RECORDINGS).delete(id);
      t.objectStore(STORE_CHUNKS).delete(chunkRange(id));
    }
  });
}

/**
 * 崩溃恢复：扩展重启时把仍标记为 recording 的记录收敛为 interrupted，
 * 并按已落盘的分片补全时长/体积——这些片段照样能播、能导出。
 *
 * @param {string|string[]|null} active 当前仍在录的 recordingId（可多路）。
 *   必须传：录制库可能在录制过程中被打开，漏传会把正在写入的记录误判成"已中断"。
 */
export async function reconcileInterrupted(active = null) {
  const keep = new Set(
    active == null ? [] : (Array.isArray(active) ? active : [active]).filter(Boolean),
  );
  const all = await listRecordings();
  const stale = all.filter((r) => r.status === STATUS.RECORDING && !keep.has(r.id));
  for (const r of stale) {
    const stats = await chunkStats(r.id);
    if (stats.chunkCount === 0) {
      await deleteRecording(r.id);
      continue;
    }
    // duration 由 offscreen 每 10s 落盘一次，误差上限 10 秒。
    // 没有的话（崩在前 10 秒）才退回时间戳相减，并从 startedAt 起算——
    // 用 createdAt 会把倒计时和建流准备的时间一并算进去，明显偏长。
    await patchRecording(r.id, {
      status: STATUS.INTERRUPTED,
      ...stats,
      duration: r.duration || Math.max(0, stats.lastTs - (r.startedAt || r.createdAt)),
    });
  }
  return stale.length;
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
