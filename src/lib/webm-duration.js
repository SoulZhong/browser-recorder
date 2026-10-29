/**
 * 修复 MediaRecorder 产出的 WebM 缺失 Duration 的问题。
 *
 * MediaRecorder 是流式封装，写 EBML 头的时候还不知道总时长，于是 Segment>Info
 * 里没有 Duration 元素，播放器读到的 video.duration === Infinity，进度条不能拖。
 *
 * 做法：只解析头部，把 Duration 写进 Segment>Info。
 * - 已有 Duration → 原地覆盖浮点值，字节数不变；
 * - 没有 Duration → 追加 11 字节 (id 0x4489 + size 0x88 + float64)，
 *   并用"等长填充"的方式重写 Info 的 size 字段，从而不影响任何后续偏移。
 *
 * 因为 EBML 头一定落在 MediaRecorder 的第一个分片里，调用方只需要把第 0 个
 * 分片传进来打补丁再写回，不必重写整段视频。
 */

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_DURATION = 0x4489;
const ID_TIMECODE_SCALE = 0x2ad7b1;

function readId(view, off) {
  const b = view.getUint8(off);
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && !(b & mask)) { mask >>= 1; length++; }
  if (length > 4) throw new Error('bad EBML id');
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + view.getUint8(off + i);
  return { id, length };
}

function readVint(view, off) {
  const b = view.getUint8(off);
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(b & mask)) { mask >>= 1; length++; }
  if (length > 8) throw new Error('bad EBML size');
  let value = b & (mask - 1);
  let unknown = value === mask - 1;
  for (let i = 1; i < length; i++) {
    const n = view.getUint8(off + i);
    if (n !== 0xff) unknown = false;
    value = value * 256 + n;
  }
  return { value, length, unknown };
}

/** 把 value 编码成恰好 length 字节的 vint（高位补零），用于原地改写 size。 */
function encodeVintFixed(value, length) {
  const max = 2 ** (7 * length) - 2;
  if (value > max) return null; // 装不下，放弃打补丁
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

/**
 * 解析 EBML 头，定位 Segment / Info / TimecodeScale / Duration。
 * 打补丁和事后校验共用同一套解析，保证"写进去的"和"读出来的"用同一把尺子。
 * @returns {null | {segment, info, timecodeScale, duration}} 解析不了时返回 null
 */
function parseHead(buf) {
  try {
    const view = new DataView(buf);
    const len = buf.byteLength;

    // 1. 顶层找 Segment
    let off = 0;
    let segment = null;
    while (off < len) {
      const id = readId(view, off);
      const size = readVint(view, off + id.length);
      const contentStart = off + id.length + size.length;
      if (id.id === ID_SEGMENT) {
        segment = { sizeOff: off + id.length, size, contentStart };
        break;
      }
      if (size.unknown) return null;
      off = contentStart + size.value;
    }
    if (!segment) return null;

    // 2. Segment 里找 Info
    let p = segment.contentStart;
    let info = null;
    while (p < len) {
      const id = readId(view, p);
      const size = readVint(view, p + id.length);
      const contentStart = p + id.length + size.length;
      if (id.id === ID_INFO) {
        info = { sizeOff: p + id.length, size, contentStart, contentEnd: contentStart + size.value };
        break;
      }
      if (size.unknown) return null;
      p = contentStart + size.value;
    }
    if (!info || info.contentEnd > len) return null;

    // 3. Info 里找 TimecodeScale / Duration
    let timecodeScale = 1_000_000; // 默认 1ms
    let duration = null;
    let q = info.contentStart;
    while (q < info.contentEnd) {
      const id = readId(view, q);
      const size = readVint(view, q + id.length);
      const contentStart = q + id.length + size.length;
      if (id.id === ID_TIMECODE_SCALE) {
        let v = 0;
        for (let i = 0; i < size.value; i++) v = v * 256 + view.getUint8(contentStart + i);
        if (v > 0) timecodeScale = v;
      } else if (id.id === ID_DURATION) {
        duration = { off: contentStart, byteLength: size.value };
      }
      q = contentStart + size.value;
    }

    return { view, len, segment, info, timecodeScale, duration };
  } catch {
    return null;
  }
}

/** 读出头里已有的 Duration（毫秒）。校验补丁结果用。 */
export async function readWebmDuration(blob) {
  const buf = await blob.slice(0, Math.min(blob.size, 1024 * 1024)).arrayBuffer();
  const h = parseHead(buf);
  if (!h?.duration) return null;
  const v = h.duration.byteLength === 8
    ? h.view.getFloat64(h.duration.off)
    : h.view.getFloat32(h.duration.off);
  return (v * h.timecodeScale) / 1_000_000;
}

/**
 * 给 WebM 头补上 Duration。
 *
 * 只在内存里做，绝不回写已落盘的分片：这个补丁改的是整段视频的解码入口，
 * 一旦打歪就是整段无法播放。原始分片保持 MediaRecorder 的原样，
 * 补丁失败最多是进度条不能拖，不会毁掉录制。
 *
 * 打完补丁会重新解析一遍自己的输出做校验，对不上就退回原始 Blob。
 *
 * @param {Blob} blob         含 EBML 头的 Blob
 * @param {number} durationMs 录制总时长（毫秒）
 * @returns {Promise<Blob>}   修复后的 Blob；不可解析或校验不过时原样返回
 */
export async function fixWebmDuration(blob, durationMs) {
  if (!(durationMs > 0)) return blob;
  try {
    const headSize = Math.min(blob.size, 1024 * 1024);
    const buf = await blob.slice(0, headSize).arrayBuffer();
    const parsed = parseHead(buf);
    if (!parsed) return blob;
    const { view, segment, info, timecodeScale, duration } = parsed;

    const scaled = (durationMs * 1_000_000) / timecodeScale;
    const head = new Uint8Array(buf.slice(0, info.contentEnd));
    const headView = new DataView(head.buffer);

    if (duration) {
      // 原地覆盖，长度不变
      if (duration.byteLength === 8) headView.setFloat64(duration.off, scaled);
      else if (duration.byteLength === 4) headView.setFloat32(duration.off, scaled);
      else return blob;
      return verified(new Blob([head, blob.slice(info.contentEnd)], { type: blob.type }), blob, durationMs);
    }

    // 追加 Duration：Info 与 Segment 的 size 都要 +11（等长重写）
    const added = 11;
    const newInfoSize = encodeVintFixed(info.size.value + added, info.size.length);
    if (!newInfoSize) return blob;
    head.set(newInfoSize, info.sizeOff);

    if (!segment.size.unknown) {
      const newSegSize = encodeVintFixed(segment.size.value + added, segment.size.length);
      if (!newSegSize) return blob;
      head.set(newSegSize, segment.sizeOff);
    }

    const elem = new Uint8Array(added);
    elem[0] = 0x44; elem[1] = 0x89; elem[2] = 0x88; // id + size(8)
    new DataView(elem.buffer).setFloat64(3, scaled);

    return verified(new Blob([head, elem, blob.slice(info.contentEnd)], { type: blob.type }), blob, durationMs);
  } catch {
    return blob; // 修复失败不影响录制成果
  }
}

/** 重新解析补丁产物；读不回预期时长就说明改坏了，退回原始 Blob。 */
async function verified(patched, original, expectedMs) {
  try {
    const got = await readWebmDuration(patched);
    if (got === null) return original;
    // 允许千分之一的浮点误差
    if (Math.abs(got - expectedMs) > Math.max(1, expectedMs * 0.001)) return original;
    return patched;
  } catch {
    return original;
  }
}
