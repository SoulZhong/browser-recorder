/**
 * 修剪 MediaRecorder 产出的 WebM，不解码、不重新编码。
 *
 * Chrome 的 WebM 是 EBML 头 + Segment（未知长度）> Info + Tracks + 一串 Cluster（也是未知长度）。
 * 关键帧不保证落在 Cluster 开头：Chrome 每过一个 timeslice 就强制开新 Cluster，
 * 而且 Cluster 里常常先是一个音频块、后面才是视频关键帧。所以这里逐块扫描：
 * - SimpleBlock 看标志位 0x80；BlockGroup 里没有 ReferenceBlock 的就是关键帧；
 * - 起点往前对齐到最近的视频关键帧，比它早的块全部丢掉；
 * - 每个 Cluster 重写：时间码减去起点偏移，块数据原样引用（Blob.slice）；
 *   起始 Cluster 的块相对时间码要改（2 个字节），其余块一个字节都不动；
 * - 终点之后的块丢掉。
 *
 * Duration 不在这里写：成片和原录像一样，由 assembleBlob 在读取时补（见 webm-duration.js）。
 */

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  TIMECODE_SCALE: 0x2ad7b1,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  REFERENCE_BLOCK: 0xfb,
};

/** Segment 的直接子元素：在未知长度的 Cluster 里碰到它们，说明这个 Cluster 结束了。 */
const SEGMENT_LEVEL = new Set([
  ID.CLUSTER, ID.INFO, ID.TRACKS,
  0x1c53bb6b, // Cues
  0x114d9b74, // SeekHead
  0x1254c367, // Tags
  0x1043a770, // Chapters
  0x1941a469, // Attachments
]);

const unsupported = (msg) => { throw new Error(msg); };

/** 按窗口顺序读 Blob：整段视频可能上 GB，只把正在解析的那一截读进内存。 */
class Reader {
  constructor(blob) { this.blob = blob; this.base = 0; this.buf = new Uint8Array(0); }

  /** 保证 [off, off+n) 在缓冲区里；越过文件末尾返回 false。 */
  async ensure(off, n) {
    if (off + n > this.blob.size) return false;
    if (off >= this.base && off + n <= this.base + this.buf.length) return true;
    const len = Math.min(this.blob.size - off, Math.max(n, 4 * 1024 * 1024));
    this.buf = new Uint8Array(await this.blob.slice(off, off + len).arrayBuffer());
    this.base = off;
    return true;
  }

  byte(off) { return this.buf[off - this.base]; }

  /** 元素头：{id, size(null=未知长度), dataStart}；读不完整返回 null。 */
  async header(off) {
    if (off >= this.blob.size) return null;
    await this.ensure(off, Math.min(12, this.blob.size - off));
    const first = this.byte(off);
    let idLen = 1;
    while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++;
    if (idLen > 4) unsupported('EBML 元素 ID 不合法');
    if (off + idLen >= this.blob.size) return null;
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + this.byte(off + i);
    const s0 = this.byte(off + idLen);
    let sLen = 1;
    while (sLen <= 8 && !(s0 & (0x80 >> (sLen - 1)))) sLen++;
    if (sLen > 8) unsupported('EBML 长度字段不合法');
    if (off + idLen + sLen > this.blob.size) return null;
    let size = s0 & (0xff >> sLen);
    let unknown = size === (0xff >> sLen);
    for (let i = 1; i < sLen; i++) {
      const b = this.byte(off + idLen + i);
      if (b !== 0xff) unknown = false;
      size = size * 256 + b;
    }
    return { id, size: unknown ? null : size, dataStart: off + idLen + sLen };
  }

  async uint(off, n) {
    await this.ensure(off, n);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.byte(off + i);
    return v;
  }
}

/** Block / SimpleBlock 的数据头：轨道号（vint）+ 相对时间码（int16）+ 标志位。 */
async function blockHead(r, dataStart) {
  if (!(await r.ensure(dataStart, 4))) return null;
  const b = r.byte(dataStart);
  let len = 1;
  while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
  if (len > 4) unsupported('块的轨道号不合法');
  await r.ensure(dataStart, len + 3);
  let track = b & (0xff >> len);
  for (let i = 1; i < len; i++) track = track * 256 + r.byte(dataStart + i);
  const tcOff = dataStart + len;
  let rel = (r.byte(tcOff) << 8) | r.byte(tcOff + 1);
  if (rel & 0x8000) rel -= 0x10000;
  return { track, tcOff, rel, flags: r.byte(tcOff + 2) };
}

/**
 * 建立修剪索引：头部、每个 Cluster 的块列表、可作为起点的视频关键帧。
 * 中断或写入失败的录像末尾可能有半截块，那一块和之后的都不算。
 */
export async function indexWebm(blob) {
  const r = new Reader(blob);
  const ebml = await r.header(0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === null) unsupported('不是 WebM 文件');
  const segAt = ebml.dataStart + ebml.size;
  const seg = await r.header(segAt);
  if (!seg || seg.id !== ID.SEGMENT) unsupported('找不到 Segment');
  const segEnd = seg.size === null ? blob.size : Math.min(blob.size, seg.dataStart + seg.size);

  let timecodeScale = 1_000_000;
  let videoTrack = null;
  const keep = []; // 头部要原样带走的元素：Info、Tracks
  const clusters = [];
  let off = seg.dataStart;

  while (off < segEnd) {
    const h = await r.header(off);
    if (!h) break;
    if (h.id === ID.CLUSTER) {
      const c = await scanCluster(r, h, segEnd);
      if (c.blocks.length) clusters.push(c);
      if (!c.end) break; // 文件在这个 Cluster 中间断了
      off = c.end;
      continue;
    }
    if (h.size === null) unsupported('Segment 里有未知长度的非 Cluster 元素');
    const end = h.dataStart + h.size;
    if (end > blob.size) break;
    if (h.id === ID.INFO) {
      keep.push([off, end]);
      for (let p = h.dataStart; p < end;) {
        const e = await r.header(p);
        if (e.id === ID.TIMECODE_SCALE) timecodeScale = await r.uint(e.dataStart, e.size) || timecodeScale;
        p = e.dataStart + e.size;
      }
    } else if (h.id === ID.TRACKS) {
      keep.push([off, end]);
      for (let p = h.dataStart; p < end;) {
        const e = await r.header(p);
        if (e.id === ID.TRACK_ENTRY) {
          let num = null;
          let type = null;
          for (let q = e.dataStart; q < e.dataStart + e.size;) {
            const f = await r.header(q);
            if (f.id === ID.TRACK_NUMBER) num = await r.uint(f.dataStart, f.size);
            if (f.id === ID.TRACK_TYPE) type = await r.uint(f.dataStart, f.size);
            q = f.dataStart + f.size;
          }
          if (type === 1 && videoTrack === null) videoTrack = num;
        }
        p = e.dataStart + e.size;
      }
    }
    // SeekHead / Cues / Void 等：位置信息搬动后就错了，直接丢掉
    off = end;
  }

  if (videoTrack === null) unsupported('没有视频轨');
  if (!clusters.length) unsupported('没有可用的视频数据');

  const unitMs = timecodeScale / 1_000_000;
  const cuts = [];
  const videoTimes = [];
  const lastByTrack = new Map();
  clusters.forEach((c, ci) => c.blocks.forEach((b, bi) => {
    const previous = lastByTrack.get(b.track);
    if (previous) previous.duration = Math.max(0, b.time - previous.time);
    lastByTrack.set(b.track, b);
    if (b.track !== videoTrack) return;
    videoTimes.push(b.time);
    if (b.key) cuts.push({ ms: b.time * unitMs, cluster: ci, block: bi, time: b.time });
  }));
  if (!cuts.length) unsupported('找不到关键帧');

  // 最后一帧本身还要占一帧的时长；块里没写，用最后两帧的间隔估一个（封顶 100ms）
  const n = videoTimes.length;
  const tail = n > 1 ? Math.min(100 / unitMs, Math.max(0, videoTimes[n - 1] - videoTimes[n - 2])) : 0;

  return {
    kind: 'webm',
    ebml: [0, segAt],
    keep, clusters, videoTrack, unitMs, cuts,
    // 时间轴以视频为准，和 MP4 一致
    durationMs: ((n ? videoTimes[n - 1] : 0) + tail) * unitMs,
  };
}

/** 扫一个 Cluster：时间码和其中每个块的位置、时间、是否关键帧。 */
async function scanCluster(r, h, segEnd) {
  const limit = h.size === null ? segEnd : Math.min(segEnd, h.dataStart + h.size);
  let tc = null;
  const blocks = [];
  let p = h.dataStart;
  while (p < limit) {
    const e = await r.header(p);
    if (!e) return { tc, blocks, end: null };
    if (h.size === null && SEGMENT_LEVEL.has(e.id)) return { tc, blocks, end: p };
    if (e.size === null) unsupported('Cluster 里有未知长度的元素');
    const end = e.dataStart + e.size;
    if (end > r.blob.size) return { tc, blocks, end: null };
    if (e.id === ID.TIMECODE) {
      tc = await r.uint(e.dataStart, e.size);
    } else if (e.id === ID.SIMPLE_BLOCK || e.id === ID.BLOCK_GROUP) {
      if (tc === null) unsupported('块出现在 Cluster 时间码之前');
      let head;
      let key;
      if (e.id === ID.SIMPLE_BLOCK) {
        head = await blockHead(r, e.dataStart);
        key = !!(head.flags & 0x80);
      } else {
        key = true;
        for (let q = e.dataStart; q < end;) {
          const f = await r.header(q);
          if (f.id === ID.BLOCK) head = await blockHead(r, f.dataStart);
          if (f.id === ID.REFERENCE_BLOCK) key = false;
          q = f.dataStart + f.size;
        }
        if (!head) unsupported('BlockGroup 里没有 Block');
      }
      blocks.push({ start: p, end, track: head.track, tcOff: head.tcOff, rel: head.rel, time: tc + head.rel, key });
    }
    // Position / PrevSize / Void：搬动后无意义，丢掉
    p = end;
  }
  return { tc, blocks, end: limit };
}

// ── 写出 ──

function vintFixed8(value) {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 7; i > 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] = 0x01;
  return out;
}

function uintElement(id, value) {
  const bytes = [];
  let v = value;
  do { bytes.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
  return new Uint8Array([id, 0x80 | bytes.length, ...bytes]);
}

const CLUSTER_ID = new Uint8Array([0x1f, 0x43, 0xb6, 0x75]);
const SEGMENT_ID = new Uint8Array([0x18, 0x53, 0x80, 0x67]);
const UNKNOWN_SIZE = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const partSize = (p) => (p instanceof Blob ? p.size : p.length);

/**
 * 按 [startMs, endMs) 截取。起点往前对齐到视频关键帧，终点之后的块丢掉。
 * @returns {{parts: Array<Blob|Uint8Array>, startMs: number, durationMs: number, videoFrames: number}}
 */
export function trimWebm(blob, index, startMs, endMs, { offsetMs = 0, strictAudioEnd = false } = {}) {
  const { unitMs } = index;
  const cut = [...index.cuts].reverse().find((c) => c.ms <= startMs + 0.5) || index.cuts[0];
  const t0 = cut.time;
  const endT = Math.min(endMs, index.durationMs) / unitMs;

  const parts = [
    blob.slice(index.ebml[0], index.ebml[1]),
    SEGMENT_ID, UNKNOWN_SIZE,
    ...index.keep.map(([a, b]) => blob.slice(a, b)),
  ];
  let videoFrames = 0;
  let lastVideo = null;
  const offsetT = Math.round(offsetMs / unitMs);

  for (let ci = cut.cluster; ci < index.clusters.length; ci++) {
    const c = index.clusters[ci];
    if (c.blocks[0].time >= endT) break;
    const tc = Math.max(0, c.tc - t0) + offsetT;
    const body = [];
    let run = null; // 连续的、不用改的块合成一个切片
    const flush = () => { if (run) { body.push(blob.slice(run[0], run[1])); run = null; } };
    c.blocks.forEach((b, bi) => {
      if (ci === cut.cluster && bi < cut.block) return;
      if (b.time < t0 || b.time >= endT) return;
      if (strictAudioEnd && b.track !== index.videoTrack && b.time + (b.duration || 20 / unitMs) > endT) return;
      if (b.track === index.videoTrack) { videoFrames++; lastVideo = b; }
      const rel = b.time - t0 + offsetT - tc;
      if (rel < -0x8000 || rel > 0x7fff) unsupported('块时间码超出范围');
      if (rel === b.rel) {
        if (run && run[1] === b.start) run[1] = b.end;
        else { flush(); run = [b.start, b.end]; }
        return;
      }
      flush();
      const patched = new Uint8Array([(rel >> 8) & 0xff, rel & 0xff]);
      body.push(blob.slice(b.start, b.tcOff), patched, blob.slice(b.tcOff + 2, b.end));
    });
    flush();
    if (!body.length) continue;
    const timecode = uintElement(ID.TIMECODE, tc);
    const size = timecode.length + body.reduce((n, p) => n + partSize(p), 0);
    parts.push(CLUSTER_ID, vintFixed8(size), timecode, ...body);
  }

  if (!videoFrames) unsupported('选中的范围里没有视频帧');
  return {
    parts,
    startMs: t0 * unitMs,
    durationMs: strictAudioEnd
      ? (lastVideo.time - t0 + Math.min(100 / unitMs, lastVideo.duration || Math.max(1, (index.durationMs / unitMs - lastVideo.time)))) * unitMs
      : Math.min(endMs, index.durationMs) - t0 * unitMs,
    videoFrames,
  };
}

/** 同一录像只写一个 Segment 和 Tracks，后续区间的 Cluster 接在上一段末尾。 */
export function joinWebm(blob, index, kept) {
  const headerParts = 3 + index.keep.length;
  const parts = [];
  const ranges = [];
  let durationMs = 0;
  let videoFrames = 0;
  for (const range of kept) {
    const out = trimWebm(blob, index, range.startMs, range.endMs, { offsetMs: durationMs, strictAudioEnd: true });
    parts.push(...(ranges.length ? out.parts.slice(headerParts) : out.parts));
    ranges.push({ startMs: out.startMs, endMs: out.startMs + out.durationMs, durationMs: out.durationMs });
    durationMs += out.durationMs;
    videoFrames += out.videoFrames;
  }
  return { parts, startMs: ranges[0].startMs, endMs: ranges.at(-1).endMs, durationMs, videoFrames, ranges };
}
