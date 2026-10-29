// 修剪：在时间轴上只保留录像中连续的一段（见 GLOSSARY.md、docs/adr/0001）。
// 按关键帧截取，不解码、不重新编码：起点往前对齐到关键帧，终点精确截断。
import { FORMAT, formatOf } from './constants.js';
import { indexMp4, trimMp4 } from './trim-mp4.js';
import { indexWebm, trimWebm } from './trim-webm.js';

/** 修剪失败的原因都是给用户看的，统一用这个类型包起来。 */
export class TrimError extends Error {}

const isMp4 = (mimeType) => formatOf(mimeType) === FORMAT.MP4;

/**
 * 读出录像的结构，得到可作为起点的关键帧时间（毫秒，升序）和总时长。
 * blob 必须是落盘分片的原样拼接（assembleBlob 的 fixDuration: false）。
 */
export async function indexMedia(blob, mimeType) {
  try {
    const index = isMp4(mimeType) ? await indexMp4(blob) : await indexWebm(blob);
    index.mimeType = mimeType;
    return index;
  } catch (err) {
    throw new TrimError(`无法读取录像结构：${err.message}`);
  }
}

/** 起点往前对齐：不晚于 ms 的最近一个关键帧。 */
export function snapStart(index, ms) {
  let best = index.cuts[0].ms;
  for (const c of index.cuts) if (c.ms <= ms + 0.5) best = c.ms;
  return best;
}

const videoFrameCount = (index) => (index.kind === 'mp4'
  ? index.fragments.reduce((n, f) => n + f.trafs.filter((t) => t.track.video).reduce((m, t) => m + t.samples.length, 0), 0)
  : index.clusters.reduce((n, c) => n + c.blocks.filter((b) => b.track === index.videoTrack).length, 0));

/**
 * 截取 [startMs, endMs)。
 *
 * 截取会重写容器结构，写错一个字段整段都放不了，所以产物必须用同一套解析器重新读一遍：
 * 从关键帧开始、视频帧数一帧不差、时长对得上，才交出去；否则报错，原录像不受影响。
 *
 * @returns {Promise<{blob: Blob, startMs: number, endMs: number, durationMs: number}>}
 *   startMs 是对齐后的实际起点，endMs 是实际终点，都在原录像的时间轴上
 */
export async function trimMedia(blob, index, startMs, endMs) {
  if (!(endMs > startMs)) throw new TrimError('终点必须晚于起点');
  let out;
  try {
    out = index.kind === 'mp4'
      ? trimMp4(blob, index, startMs, endMs)
      : trimWebm(blob, index, startMs, endMs);
  } catch (err) {
    throw new TrimError(err.message);
  }
  const result = new Blob(out.parts, { type: blob.type || index.mimeType });

  let check;
  try {
    check = await indexMedia(result, index.mimeType);
  } catch (err) {
    throw new TrimError(`截取结果校验失败（${err.message}）`);
  }
  const frames = videoFrameCount(check);
  if (check.cuts[0].ms > 1) throw new TrimError('截取结果校验失败（没有从关键帧开始）');
  if (frames !== out.videoFrames) {
    throw new TrimError(`截取结果校验失败（视频帧数 ${frames}，应为 ${out.videoFrames}）`);
  }
  // WebM 的总时长是按最后两帧的间隔估的，留一点余量
  if (Math.abs(check.durationMs - out.durationMs) > 150) {
    throw new TrimError(`截取结果校验失败（时长 ${Math.round(check.durationMs)}ms，应为 ${Math.round(out.durationMs)}ms）`);
  }

  return {
    blob: result,
    startMs: out.startMs,
    endMs: out.startMs + out.durationMs,
    durationMs: out.durationMs,
  };
}
