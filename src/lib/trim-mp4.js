/**
 * 修剪 MediaRecorder 产出的分段 MP4（fMP4），不解码、不重新编码。
 *
 * Chrome 的 MP4 录像是 ftyp + moov（只有轨道描述，没有样本表）+ 一串 moof/mdat 片段，
 * 而且每遇到一个视频关键帧就开一个新片段——所以「从关键帧开始」等价于「从某个片段开始」。
 *
 * 做法：
 * - 起点：往前对齐到最近的、以视频关键帧开头的片段，此前的片段整段丢掉；
 * - 中间片段：mdat 原样引用（Blob.slice，不读进内存），只改 moof 里的序号和 tfdt 时间；
 * - 终点所在片段：按样本截断，重建这一个片段的 moof/mdat；
 * - 所有轨道的时间统一减去同一个偏移，音画同步不变。
 *
 * 轨道顺序不固定（有的录像 1 号是音频），必须按 hdlr 认视频轨。
 * 只处理 Chrome 实际产出的结构，遇到不认识的（多个 trun、绝对 base_data_offset……）直接报错，
 * 绝不猜着改：这里改错一个字段，整段视频都放不了。
 */

const NON_SYNC = 0x00010000;

const u8 = async (blob, off, len) =>
  new Uint8Array(await blob.slice(off, Math.min(blob.size, off + len)).arrayBuffer());
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

const unsupported = (msg) => { throw new Error(msg); };

/** 遍历一段内存里的子盒子：[{type, start, headerSize, size}]，start 相对 bytes。 */
function children(bytes, from = 0, to = bytes.length) {
  const v = view(bytes);
  const out = [];
  let o = from;
  while (o + 8 <= to) {
    let size = v.getUint32(o);
    let headerSize = 8;
    if (size === 1) { size = Number(v.getBigUint64(o + 8)); headerSize = 16; }
    if (size === 0) size = to - o;
    if (size < headerSize || o + size > to) unsupported('盒子长度越界');
    out.push({ type: fourcc(bytes, o + 4), start: o, headerSize, size });
    o += size;
  }
  return out;
}
const find = (list, type) => list.find((b) => b.type === type);
const inside = (bytes, box) => children(bytes, box.start + box.headerSize, box.start + box.size);

/** 读 moov：每条轨道的 id、时间刻度、是否视频，以及 trex 默认值。 */
function parseMoov(bytes, moov) {
  const v = view(bytes);
  const tracks = new Map();
  const kids = inside(bytes, moov);
  for (const trak of kids.filter((b) => b.type === 'trak')) {
    const tk = inside(bytes, trak);
    const tkhd = find(tk, 'tkhd');
    const mdia = find(tk, 'mdia');
    if (!tkhd || !mdia) unsupported('轨道缺少 tkhd/mdia');
    const md = inside(bytes, mdia);
    const mdhd = find(md, 'mdhd');
    const hdlr = find(md, 'hdlr');
    if (!mdhd || !hdlr) unsupported('轨道缺少 mdhd/hdlr');
    const tkv = bytes[tkhd.start + 8];
    const id = v.getUint32(tkhd.start + 8 + (tkv === 1 ? 20 : 12));
    const mdv = bytes[mdhd.start + 8];
    const timescale = v.getUint32(mdhd.start + 8 + (mdv === 1 ? 20 : 12));
    const handler = fourcc(bytes, hdlr.start + 16);
    tracks.set(id, { id, timescale, video: handler === 'vide', defaults: {} });
  }
  const mvex = find(kids, 'mvex');
  if (mvex) {
    for (const trex of inside(bytes, mvex).filter((b) => b.type === 'trex')) {
      const t = tracks.get(v.getUint32(trex.start + 12));
      if (t) {
        t.defaults = {
          duration: v.getUint32(trex.start + 20),
          size: v.getUint32(trex.start + 24),
          flags: v.getUint32(trex.start + 28),
        };
      }
    }
  }
  if (![...tracks.values()].some((t) => t.video)) unsupported('没有视频轨');
  return tracks;
}

/** 解析一个 moof：每个 traf 的时间、样本表和数据位置。偏移都是相对 moof 起点。 */
function parseMoof(bytes, tracks) {
  const v = view(bytes);
  const kids = inside(bytes, children(bytes)[0]);
  const mfhd = find(kids, 'mfhd');
  if (!mfhd) unsupported('moof 缺少 mfhd');
  const trafs = [];
  for (const traf of kids.filter((b) => b.type === 'traf')) {
    const tk = inside(bytes, traf);
    const tfhd = find(tk, 'tfhd');
    const tfdt = find(tk, 'tfdt');
    const truns = tk.filter((b) => b.type === 'trun');
    if (!tfhd || !tfdt) unsupported('traf 缺少 tfhd/tfdt');
    if (truns.length !== 1) unsupported(`traf 里有 ${truns.length} 个 trun`);
    if (tk.some((b) => !['tfhd', 'tfdt', 'trun'].includes(b.type))) unsupported('traf 里有不认识的盒子');

    const hf = v.getUint32(tfhd.start + 8) & 0xffffff;
    if (hf & 0x1) unsupported('tfhd 使用绝对 base_data_offset');
    if (!(hf & 0x20000)) unsupported('tfhd 未设 default-base-is-moof');
    const track = tracks.get(v.getUint32(tfhd.start + 12));
    if (!track) unsupported('片段引用了不存在的轨道');
    let p = tfhd.start + 16;
    if (hf & 0x2) p += 4;
    const def = { ...track.defaults };
    if (hf & 0x8) { def.duration = v.getUint32(p); p += 4; }
    if (hf & 0x10) { def.size = v.getUint32(p); p += 4; }
    if (hf & 0x20) { def.flags = v.getUint32(p); p += 4; }

    const tdv = bytes[tfdt.start + 8];
    const baseTime = tdv === 1 ? Number(v.getBigUint64(tfdt.start + 12)) : v.getUint32(tfdt.start + 12);

    const trun = truns[0];
    const rv = bytes[trun.start + 8];
    const rf = v.getUint32(trun.start + 8) & 0xffffff;
    if (!(rf & 0x1)) unsupported('trun 缺少 data_offset');
    const count = v.getUint32(trun.start + 12);
    let q = trun.start + 16;
    const dataOffset = v.getInt32(q); q += 4;
    let firstFlags = null;
    if (rf & 0x4) { firstFlags = v.getUint32(q); q += 4; }
    const samples = [];
    for (let i = 0; i < count; i++) {
      const s = { duration: def.duration, size: def.size, flags: def.flags, cto: 0 };
      if (rf & 0x100) { s.duration = v.getUint32(q); q += 4; }
      if (rf & 0x200) { s.size = v.getUint32(q); q += 4; }
      if (rf & 0x400) { s.flags = v.getUint32(q); q += 4; }
      if (rf & 0x800) { s.cto = rv === 1 ? v.getInt32(q) : v.getUint32(q); q += 4; }
      if (i === 0 && firstFlags !== null) s.flags = firstFlags;
      samples.push(s);
    }
    if (q > trun.start + trun.size) unsupported('trun 长度不够');

    trafs.push({
      track, baseTime, samples, dataOffset,
      tfdtOff: tfdt.start + 12, tfdtVersion: tdv,
      tfhdBytes: bytes.slice(tfhd.start, tfhd.start + tfhd.size),
      trunVersion: rv, trunFlags: rf,
    });
  }
  return { seqOff: mfhd.start + 12, trafs };
}

const sec = (traf, ticks) => ticks / traf.track.timescale;
const trafEnd = (traf) => traf.baseTime + traf.samples.reduce((n, s) => n + s.duration, 0);
/** 时间轴以视频为准：成片的终点是最后一帧画面的结束时间。 */
const videoEnd = (trafs, prev) => trafs.reduce((m, t) => (t.track.video ? Math.max(m, sec(t, trafEnd(t))) : m), prev);

/**
 * 建立一段 MP4 的修剪索引：可以作为起点的关键帧时间、总时长，以及截取要用的结构信息。
 * 中断或写入失败的录像末尾可能有半截片段，那一段直接不算。
 */
export async function indexMp4(blob) {
  let head = null;
  let tracks = null;
  const fragments = [];
  let o = 0;
  while (o + 8 <= blob.size) {
    const h = await u8(blob, o, 16);
    const hv = view(h);
    let size = hv.getUint32(0);
    const headerSize = size === 1 ? 16 : 8;
    if (size === 1) size = Number(hv.getBigUint64(8));
    if (size === 0) size = blob.size - o;
    const type = fourcc(h, 4);
    if (size < 8 || o + size > blob.size) break; // 半截盒子：录制被打断的尾巴
    if (type === 'moov') {
      const bytes = await u8(blob, 0, o + size);
      tracks = parseMoov(bytes, { type, start: o, headerSize, size });
      head = { bytes, moov: { start: o, headerSize, size } };
    } else if (type === 'moof') {
      if (!tracks) unsupported('moof 出现在 moov 之前');
      // moof 连同后面 mdat 的头一起读，省一次往返
      const bytes = await u8(blob, o, size + 16);
      const mv = view(bytes);
      if (bytes.length < size + 8 || fourcc(bytes, size + 4) !== 'mdat') break;
      let mdatSize = mv.getUint32(size);
      let mdatHeader = 8;
      if (mdatSize === 1) { mdatSize = Number(mv.getBigUint64(size + 8)); mdatHeader = 16; }
      if (mdatSize === 0) mdatSize = blob.size - (o + size);
      const end = o + size + mdatSize;
      if (end > blob.size) break;
      const moof = parseMoof(bytes.subarray(0, size), tracks);
      // 样本数据必须落在紧跟着的 mdat 里，否则搬动片段时引用会断
      for (const t of moof.trafs) {
        const bytesTotal = t.samples.reduce((n, s) => n + s.size, 0);
        if (t.dataOffset < size + mdatHeader || t.dataOffset + bytesTotal > size + mdatSize) {
          unsupported('样本数据不在本片段的 mdat 里');
        }
      }
      fragments.push({ offset: o, moofBytes: bytes.slice(0, size), mdatEnd: end, ...moof });
      o = end;
      continue;
    }
    o += size;
  }
  if (!head || !fragments.length) unsupported('没有可用的视频片段');

  // 可作为起点的片段：视频轨第一个样本是关键帧
  const cuts = [];
  fragments.forEach((f, i) => {
    const vt = f.trafs.find((t) => t.track.video);
    if (vt?.samples.length && !(vt.samples[0].flags & NON_SYNC)) {
      cuts.push({ ms: sec(vt, vt.baseTime) * 1000, fragment: i });
    }
  });
  if (!cuts.length) unsupported('找不到关键帧');

  // 录像被打断时，最后一个完整片段里的音频可能比画面长出一截，不算进时长
  const endSec = fragments.reduce((m, f) => videoEnd(f.trafs, m), 0);

  return { kind: 'mp4', head, tracks, fragments, cuts, durationMs: endSec * 1000 };
}

// ── 写出 ──

function box(type, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  const v = view(out);
  v.setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * 重建一个片段的 moof + mdat，每条轨道只保留时间窗内的样本：
 * 开始时间不早于该轨道的起点偏移（起始片段里比关键帧早的音频），且早于终点。
 * 样本数据仍是原 mdat 的切片引用，不读进内存。
 */
function rebuildFragment(blob, f, seq, shift, endSec, offsetSec = 0, strictAudioEnd = false) {
  const kept = [];
  for (const t of f.trafs) {
    const from = shift.get(t.track.id);
    let a = 0;
    let ticks = t.baseTime;
    while (a < t.samples.length && ticks < from) { ticks += t.samples[a].duration; a++; }
    const startTicks = ticks;
    let b = a;
    while (b < t.samples.length && sec(t, ticks) < endSec) {
      if (strictAudioEnd && !t.track.video && sec(t, ticks + t.samples[b].duration) > endSec) break;
      ticks += t.samples[b].duration; b++;
    }
    if (b === a) continue;
    const skip = t.samples.slice(0, a).reduce((n, x) => n + x.size, 0);
    const samples = t.samples.slice(a, b);
    kept.push({
      t, samples, startTicks,
      dataFrom: t.dataOffset + skip,
      bytes: samples.reduce((n, x) => n + x.size, 0),
    });
  }
  if (!kept.length) return null;

  const mfhd = new Uint8Array(16);
  view(mfhd).setUint32(12, seq);
  mfhd.set([0, 0, 0, 16, 0x6d, 0x66, 0x68, 0x64]);

  const trafBoxes = kept.map(({ t, samples, startTicks }) => {
    const n = samples.length;
    const tfdt = new Uint8Array(20);
    const dv = view(tfdt);
    tfdt.set([0, 0, 0, 20, 0x74, 0x66, 0x64, 0x74, 1]);
    dv.setBigUint64(12, BigInt(startTicks - shift.get(t.track.id) + Math.round(offsetSec * t.track.timescale)));

    const rf = t.trunFlags;
    const per = ((rf & 0x100) ? 4 : 0) + ((rf & 0x200) ? 4 : 0) + ((rf & 0x400) ? 4 : 0) + ((rf & 0x800) ? 4 : 0);
    const body = new Uint8Array(8 + 4 + (rf & 0x4 ? 4 : 0) + per * n);
    const bv = view(body);
    bv.setUint32(0, (t.trunVersion << 24) | rf);
    bv.setUint32(4, n);
    let q = 12;
    // 去掉了开头的样本时，first_sample_flags 要换成新的第一个样本的
    if (rf & 0x4) { bv.setUint32(q, samples[0].flags); q += 4; }
    for (const s of samples) {
      if (rf & 0x100) { bv.setUint32(q, s.duration); q += 4; }
      if (rf & 0x200) { bv.setUint32(q, s.size); q += 4; }
      if (rf & 0x400) { bv.setUint32(q, s.flags); q += 4; }
      if (rf & 0x800) { bv.setInt32(q, s.cto); q += 4; }
    }
    return { t, tfdt, body };
  });

  // data_offset 取决于整个 moof 的长度，先算长度再回填
  const moofSize = 8 + mfhd.length + trafBoxes.reduce((n, x) => n + 8 + x.t.tfhdBytes.length + x.tfdt.length + 8 + x.body.length, 0);
  let dataAt = moofSize + 8;
  const trafs = trafBoxes.map((x, i) => {
    view(x.body).setInt32(8, dataAt);
    dataAt += kept[i].bytes;
    return box('traf', x.t.tfhdBytes, x.tfdt, box('trun', x.body));
  });
  const moof = box('moof', mfhd, ...trafs);

  const mdatSize = 8 + kept.reduce((n, k) => n + k.bytes, 0);
  const mdatHead = new Uint8Array(8);
  view(mdatHead).setUint32(0, mdatSize);
  mdatHead.set([0x6d, 0x64, 0x61, 0x74], 4);
  const data = kept.map(({ dataFrom, bytes }) => blob.slice(f.offset + dataFrom, f.offset + dataFrom + bytes));
  return {
    parts: [moof, mdatHead, ...data],
    trafs: kept.map(({ t, samples, startTicks }) => ({ track: t.track, samples, baseTime: startTicks })),
  };
}

/** 把 moov 里非零的时长字段改成新时长。Chrome 写的都是 0，这里是给别的写法兜底。 */
function patchHeadDurations(bytes, moov, tracks, durationSec) {
  const v = view(bytes);
  const set = (off, version, value) => {
    if (version === 1) { if (v.getBigUint64(off) !== 0n) v.setBigUint64(off, BigInt(value)); }
    else if (v.getUint32(off) !== 0) v.setUint32(off, Math.min(0xffffffff, value));
  };
  const kids = inside(bytes, moov);
  const mvhd = find(kids, 'mvhd');
  if (!mvhd) unsupported('moov 缺少 mvhd');
  const mv = bytes[mvhd.start + 8];
  const movieScale = v.getUint32(mvhd.start + 8 + (mv === 1 ? 20 : 12));
  const movieTicks = Math.round(durationSec * movieScale);
  set(mvhd.start + 8 + (mv === 1 ? 24 : 16), mv, movieTicks);
  const mvex = find(kids, 'mvex');
  const mehd = mvex && find(inside(bytes, mvex), 'mehd');
  if (mehd) set(mehd.start + 12, bytes[mehd.start + 8], movieTicks);
  for (const trak of kids.filter((b) => b.type === 'trak')) {
    const tk = inside(bytes, trak);
    const tkhd = find(tk, 'tkhd');
    const tv = bytes[tkhd.start + 8];
    set(tkhd.start + 8 + (tv === 1 ? 28 : 20), tv, movieTicks);
    const mdhd = find(inside(bytes, find(tk, 'mdia')), 'mdhd');
    const dv = bytes[mdhd.start + 8];
    const id = v.getUint32(tkhd.start + 8 + (tv === 1 ? 20 : 12));
    const scale = tracks.get(id).timescale;
    set(mdhd.start + 8 + (dv === 1 ? 24 : 16), dv, Math.round(durationSec * scale));
  }
}

/**
 * 按 [startMs, endMs) 截取。起点往前对齐到关键帧片段，终点按样本精确截断。
 * @returns {{parts: Array<Blob|Uint8Array>, startMs: number, durationMs: number, videoFrames: number}}
 *   parts 直接拼成 Blob 即是结果；startMs 是实际起点（原时间轴）
 */
export function trimMp4(blob, index, startMs, endMs, { offsetMs = 0, sequence = 1, strictAudioEnd = false } = {}) {
  const cut = [...index.cuts].reverse().find((c) => c.ms <= startMs + 0.5) || index.cuts[0];
  const first = index.fragments[cut.fragment];

  // 所有轨道减去同一个秒数（关键帧的时间），音画同步不变。
  // 起始片段里比关键帧还早的音频样本丢掉，保证成片从 0 开始、没有负时间。
  const vt = first.trafs.find((t) => t.track.video);
  const t0 = sec(vt, vt.baseTime);
  const shift = new Map([...index.tracks.values()].map((tr) => [tr.id, Math.floor(t0 * tr.timescale + 1e-6)]));
  const endSec = Math.min(endMs, index.durationMs) / 1000;

  const parts = [];
  let seq = sequence;
  let lastSec = t0;
  let videoFrames = 0;
  const countVideo = (trafs) => { for (const t of trafs) if (t.track.video) videoFrames += t.samples.length; };
  for (let i = cut.fragment; i < index.fragments.length; i++) {
    const f = index.fragments[i];
    const startSec = Math.min(...f.trafs.map((t) => sec(t, t.baseTime)));
    if (startSec >= endSec) break;
    const fragEnd = Math.max(...f.trafs.map((t) => sec(t, trafEnd(t))));
    const early = f.trafs.some((t) => t.baseTime < shift.get(t.track.id));
    if (fragEnd <= endSec && !early) {
      const moof = f.moofBytes.slice();
      const mv = view(moof);
      mv.setUint32(f.seqOff, seq++);
      for (const t of f.trafs) {
        const nt = t.baseTime - shift.get(t.track.id) + Math.round(offsetMs / 1000 * t.track.timescale);
        if (t.tfdtVersion === 1) mv.setBigUint64(t.tfdtOff, BigInt(nt));
        else mv.setUint32(t.tfdtOff, nt);
      }
      parts.push(moof, blob.slice(f.offset + moof.length, f.mdatEnd));
      countVideo(f.trafs);
      lastSec = videoEnd(f.trafs, lastSec);
      continue;
    }
    const rebuilt = rebuildFragment(blob, f, seq, shift, endSec, offsetMs / 1000, strictAudioEnd);
    if (rebuilt) {
      seq++;
      parts.push(...rebuilt.parts);
      countVideo(rebuilt.trafs);
      lastSec = videoEnd(rebuilt.trafs, lastSec);
    }
    if (fragEnd > endSec) break;
  }

  if (!videoFrames) unsupported('选中的范围里没有视频帧');
  const durationSec = lastSec - t0;
  const head = index.head.bytes.slice(0, index.head.moov.start + index.head.moov.size);
  patchHeadDurations(head, index.head.moov, index.tracks, durationSec);
  // 只留 ftyp + moov；moov 之前若还有别的盒子（Chrome 不会写）一并保留不动
  return { parts: [head, ...parts], startMs: t0 * 1000, durationMs: durationSec * 1000, videoFrames, nextSequence: seq };
}

/** 同一录像的多个保留区间：共用一个文件头，连续重排所有轨道的时间和片段序号。 */
export function joinMp4(blob, index, kept) {
  const parts = [];
  const ranges = [];
  let durationMs = 0;
  let sequence = 1;
  let videoFrames = 0;
  for (const range of kept) {
    const out = trimMp4(blob, index, range.startMs, range.endMs, { offsetMs: durationMs, sequence, strictAudioEnd: true });
    parts.push(...out.parts.slice(1));
    ranges.push({ startMs: out.startMs, endMs: out.startMs + out.durationMs, durationMs: out.durationMs });
    durationMs += out.durationMs;
    sequence = out.nextSequence;
    videoFrames += out.videoFrames;
  }
  const head = index.head.bytes.slice(0, index.head.moov.start + index.head.moov.size);
  patchHeadDurations(head, index.head.moov, index.tracks, durationMs / 1000);
  return { parts: [head, ...parts], startMs: ranges[0].startMs, endMs: ranges.at(-1).endMs, durationMs, videoFrames, ranges };
}
