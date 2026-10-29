// 修剪的端到端测试：素材出自真实 Chrome 的 MediaRecorder（tests/gen-fixtures.mjs）。
// 用法：node --test tests/
//
// 自己的解析器说「对」不算数，所以每个结果都交给 ffprobe / ffmpeg 独立核对：
// 从关键帧开始、时间从 0 起、视频帧与原片对应区间逐帧一致（大小 + 关键帧标志）、能完整解码。
// 机器上没有 ffmpeg 时这部分跳过，只跑自校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { indexMedia, snapStart, trimMedia, TrimError } from '../src/lib/trim.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-test-'));
const hasFfmpeg = (() => { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** 按录制时的分片边界切成多个 Blob 再拼起来，和 IndexedDB 里读出来的形态一致。 */
function load(name) {
  const file = fs.readdirSync(dir).find((f) => f.startsWith(`${name}.`) && !f.endsWith('.json'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, file));
  const parts = [];
  let o = 0;
  for (const n of meta.chunkSizes) { parts.push(buf.subarray(o, o + n)); o += n; }
  return { file: path.join(dir, file), buf, mimeType: meta.mimeType, blob: new Blob(parts, { type: meta.mimeType.split(';')[0] }) };
}

/** ffprobe 列出视频包：[{pts(秒), size, key}]，按显示时间排序。 */
function videoPackets(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries',
    'packet=pts_time,size,flags', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return out.trim().split('\n').map((l) => {
    const [pts, size, flags] = l.split(',');
    return { pts: Number(pts), size: Number(size), key: flags.startsWith('K') };
  }).sort((a, b) => a.pts - b.pts);
}

async function writeOut(blob, ext) {
  const f = path.join(tmp, `out-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(f, Buffer.from(await blob.arrayBuffer()));
  return f;
}

/** 独立核对一个修剪结果。 */
function verifyWithFfmpeg(src, outFile, res) {
  const before = videoPackets(src.file);
  const after = videoPackets(outFile);
  const s = res.startMs / 1000;
  const e = res.endMs / 1000;
  // 原片里落在 [实际起点, 实际终点) 的视频帧，就是成片应有的全部视频帧。
  // 片段边界上 tfdt 和上一片段累计时长能差零点几毫秒，留 2ms 余量（极短的区间按比例缩）
  const slack = Math.min(0.002, (e - s) / 2);
  const expected = before.filter((p) => p.pts >= s - 0.002 && p.pts < e - slack);
  assert.ok(after.length > 0, '成片没有视频帧');
  assert.ok(after[0].key, '成片第一帧不是关键帧');
  assert.ok(Math.abs(after[0].pts) < 0.002, `成片视频不是从 0 开始：${after[0].pts}`);
  assert.deepEqual(after.map((p) => [p.size, p.key]), expected.map((p) => [p.size, p.key]), '视频帧和原片对应区间不一致');
  for (let i = 0; i < after.length; i++) {
    assert.ok(Math.abs(after[i].pts - (expected[i].pts - s)) < 0.002, `第 ${i} 帧时间不对`);
  }
  // 解码一遍。null 封装器对可变帧率会报 "non monotonically increasing dts"，那是它自己的换算，不是文件问题
  let log = '';
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-i', outFile, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) { log = String(err.stderr || err); }
  const errors = log.split('\n').filter((l) => l.trim() && !l.includes('non monotonically increasing dts'));
  assert.deepEqual(errors, [], '解码出错');
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outFile], { encoding: 'utf8' });
  assert.deepEqual(streams.trim().split('\n').sort(), ['audio', 'video'], '音轨或视频轨丢了');
}

const FIXTURES = ['mp4', 'mp4-pause', 'webm', 'webm-vp8', 'webm-pause'];

for (const name of FIXTURES) {
  test(`${name}：各种起止点`, async (t) => {
    const src = load(name);
    const index = await indexMedia(src.blob, src.mimeType);
    const D = index.durationMs;
    const k = index.cuts.map((c) => c.ms);
    assert.equal(k[0], 0, '第一个关键帧应在 0');
    assert.ok(k.length >= 2, '素材里至少要有两个关键帧才测得到对齐');

    const ranges = [
      ['整段', 0, D],
      ['终点超出', 0, D + 5000],
      ['只剪片尾', 0, D / 3],
      ['只剪片头', D / 2, D],
      ['中间一段', D / 4, (D * 3) / 4],
      ['起点恰在关键帧', k[1], D],
      ['起点在关键帧前 1ms', k[1] - 1, D],
      ['起点在关键帧后 1ms', k[1] + 1, D],
      ['极短', k[1], k[1] + 1],
    ];
    for (const [label, a, b] of ranges) {
      await t.test(label, async () => {
        const res = await trimMedia(src.blob, index, a, b);
        assert.equal(res.startMs, snapStart(index, a), '实际起点应是往前对齐的关键帧');
        assert.ok(res.startMs <= a + 0.5, '起点只能往前对齐');
        // 终点之前开始的那一帧会完整保留，所以实际终点最多比要求晚一帧
        assert.ok(res.endMs <= Math.min(b, D) + 100, '终点不能超过要求');
        if (hasFfmpeg) verifyWithFfmpeg(src, await writeOut(res.blob, path.extname(src.file).slice(1)), res);
      });
    }
  });

  test(`${name}：中断的录像（尾部半截）照样能修剪`, async () => {
    const src = load(name);
    const full = await indexMedia(src.blob, src.mimeType);
    for (const frac of [0.55, 0.8, 0.97]) {
      // 截在任意字节上，模拟崩溃时最后一片写了一半
      const cutAt = Math.floor(src.buf.length * frac) + 7;
      const blob = new Blob([src.buf.subarray(0, cutAt)], { type: src.blob.type });
      const index = await indexMedia(blob, src.mimeType);
      assert.ok(index.durationMs < full.durationMs, '截断后时长应变短');
      const res = await trimMedia(blob, index, index.durationMs / 3, index.durationMs);
      if (hasFfmpeg) {
        const f = path.join(tmp, `trunc-${name}-${frac}${path.extname(src.file)}`);
        fs.writeFileSync(f, src.buf.subarray(0, cutAt));
        verifyWithFfmpeg({ file: f }, await writeOut(res.blob, path.extname(src.file).slice(1)), res);
      }
    }
  });
}

test('修剪结果可以再修剪', async () => {
  for (const name of ['mp4', 'webm-vp8']) {
    const src = load(name);
    const index = await indexMedia(src.blob, src.mimeType);
    const once = await trimMedia(src.blob, index, index.cuts[1].ms, index.durationMs);
    const index2 = await indexMedia(once.blob, src.mimeType);
    const twice = await trimMedia(once.blob, index2, 0, index2.durationMs / 2);
    assert.ok(twice.durationMs > 0 && twice.durationMs < once.durationMs);
  }
});

test('非法输入给出可读的错误，而不是崩溃', async () => {
  const src = load('mp4');
  const index = await indexMedia(src.blob, src.mimeType);
  await assert.rejects(trimMedia(src.blob, index, 3000, 3000), TrimError);
  await assert.rejects(trimMedia(src.blob, index, 5000, 1000), TrimError);
  await assert.rejects(indexMedia(new Blob([new Uint8Array(1000)]), 'video/mp4'), TrimError);
  await assert.rejects(indexMedia(new Blob([new Uint8Array(1000)]), 'video/webm'), TrimError);
  // 容器和声明的类型对不上
  await assert.rejects(indexMedia(load('webm').blob, 'video/mp4'), TrimError);
  await assert.rejects(indexMedia(src.blob, 'video/webm'), TrimError);
  // 只有文件头、一帧都没有
  await assert.rejects(indexMedia(new Blob([src.buf.subarray(0, 1247)]), 'video/mp4'), TrimError);
});
