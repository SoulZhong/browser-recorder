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
import { indexMedia, snapStart, trimMedia, planCuts, cutMedia, TrimError } from '../src/lib/trim.js';

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
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_packets', '-show_data_hash', 'sha256', '-show_entries',
    'packet=pts_time,size,flags,data_hash', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(out).packets.map((p) => ({
    pts: Number(p.pts_time), size: Number(p.size), key: p.flags.includes('K'), hash: p.data_hash,
  })).sort((a, b) => a.pts - b.pts);
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
  let offset = 0;
  const expected = (res.ranges || [res]).flatMap((range) => {
    const s = range.startMs / 1000;
    const e = range.endMs / 1000;
    const slack = Math.min(0.002, (e - s) / 2);
    const packets = before.filter((p) => p.pts >= s - 0.002 && p.pts < e - slack)
      .map((p) => ({ ...p, pts: p.pts - s + offset }));
    offset += range.durationMs / 1000;
    return packets;
  });
  assert.ok(after.length > 0, '成片没有视频帧');
  assert.ok(after[0].key, '成片第一帧不是关键帧');
  assert.ok(Math.abs(after[0].pts) < 0.002, `成片视频不是从 0 开始：${after[0].pts}`);
  assert.deepEqual(after.map((p) => [p.size, p.key, p.hash]), expected.map((p) => [p.size, p.key, p.hash]), '视频帧和原片对应区间不一致');
  for (let i = 0; i < after.length; i++) {
    assert.ok(Math.abs(after[i].pts - expected[i].pts) < 0.002, `第 ${i} 帧时间不对`);
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

test('删除范围合并，并向后对齐恢复播放的关键帧', () => {
  const index = { durationMs: 10000, cuts: [0, 3000, 6000, 9000].map((ms) => ({ ms })) };
  assert.deepEqual(planCuts(index, [{ startMs: 1000, endMs: 2000 }, { startMs: 2500, endMs: 4000 }]), {
    removed: [{ startMs: 1000, endMs: 6000 }],
    kept: [{ startMs: 0, endMs: 1000 }, { startMs: 6000, endMs: 10000 }],
  });
  assert.deepEqual(planCuts(index, [{ startMs: 8000, endMs: 9500 }]).kept, [{ startMs: 0, endMs: 8000 }]);
  assert.deepEqual(planCuts(index, [{ startMs: 0, endMs: 10000 }]).kept, []);
  assert.throws(() => planCuts(index, [{ startMs: NaN, endMs: 2000 }]), TrimError);
  assert.throws(() => planCuts(index, [{ startMs: 3000, endMs: 2000 }]), TrimError);
});

for (const name of FIXTURES) {
  test(`${name}：删除中间片段后无损拼接`, async (t) => {
    const src = load(name);
    const index = await indexMedia(src.blob, src.mimeType);
    const k = index.cuts.map((c) => c.ms);
    const cases = [
      ['中间一段', [{ startMs: k[1] / 2, endMs: k[1] - 100 }]],
      ['两次删除保留三段', [
        { startMs: k[1] / 4, endMs: k[1] / 2 },
        { startMs: (k[1] + k[2]) / 2, endMs: k[2] - 1 },
      ]],
      ['多段含重叠', [
        { startMs: k[1] / 4, endMs: k[1] / 2 },
        { startMs: k[1] / 3, endMs: k[1] - 100 },
        { startMs: k[1] + 100, endMs: index.durationMs - 100 },
      ]],
      ['去掉片头片尾', [
        { startMs: 0, endMs: k[1] - 100 },
        { startMs: index.durationMs - 500, endMs: index.durationMs },
      ]],
    ];
    for (const [label, removed] of cases) await t.test(label, async () => {
      const res = await cutMedia(src.blob, index, removed);
      assert.ok(res.durationMs > 0 && res.durationMs < index.durationMs);
      assert.equal(res.ranges.length, planCuts(index, removed).kept.length);
      const check = await indexMedia(res.blob, src.mimeType);
      assert.ok(Math.abs(check.durationMs - res.durationMs) < 150);
      if (hasFfmpeg) {
        const out = await writeOut(res.blob, path.extname(src.file).slice(1));
        verifyWithFfmpeg(src, out, res);
        const audioPackets = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_packets',
          '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', file], { encoding: 'utf8' })).packets;
        const sourceAudio = audioPackets(src.file);
        // MediaRecorder 的 WebM 原片本身有毫秒级音频时间抖动，拼接不能增加它。
        const overlap = sourceAudio.slice(1).reduce((max, packet, i) => Math.max(max,
          Number(sourceAudio[i].pts_time) + Number(sourceAudio[i].duration_time) - Number(packet.pts_time)), 0);
        const audio = audioPackets(out);
        for (let i = 1; i < audio.length; i++) {
          assert.ok(Number(audio[i].pts_time) > Number(audio[i - 1].pts_time), '音频时间不能倒退');
          assert.ok(Number(audio[i].pts_time) >= Number(audio[i - 1].pts_time) + Number(audio[i - 1].duration_time) - overlap - 0.002,
            '拼接不能引入超过原片的音频时间重叠');
        }
      }
      const again = await cutMedia(res.blob, check, [{ startMs: res.durationMs / 2, endMs: res.durationMs }]);
      assert.ok(again.durationMs > 0 && again.durationMs < res.durationMs, '拼接结果应可继续编辑');
    });
    await assert.rejects(cutMedia(src.blob, index, [{ startMs: 0, endMs: index.durationMs }]), TrimError);
    await assert.rejects(cutMedia(src.blob, index, []), TrimError);
  });
}
