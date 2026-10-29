// 用真实 Chrome 的 MediaRecorder 录几段测试素材，供修剪测试使用。
// 用法：node tests/gen-fixtures.mjs [chrome 可执行文件路径]
//
// 素材必须出自 MediaRecorder 本身：手工拼的或 ffmpeg 转出来的 MP4/WebM 盒子布局不一样，
// 测过了也不代表能处理真实录像。画面每帧画一个递增的帧号，便于肉眼核对截取位置。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'fixtures');
const chrome = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** 每段：容器候选、总时长、可选的暂停区间（录制中暂停/继续是真实场景）。 */
const CASES = [
  { name: 'mp4', mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ms: 12000 },
  { name: 'mp4-pause', mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ms: 10000, pause: [4000, 6000] },
  { name: 'webm', mime: 'video/webm;codecs=vp9,opus', ms: 12000 },
  { name: 'webm-vp8', mime: 'video/webm;codecs=vp8,opus', ms: 8000 },
  { name: 'webm-pause', mime: 'video/webm;codecs=vp9,opus', ms: 10000, pause: [4000, 6000] },
];

const page = `<!doctype html><canvas id=c width=640 height=360></canvas><script>
const CASES = ${JSON.stringify(CASES)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const c = document.getElementById('c'), g = c.getContext('2d');
  let n = 0;
  setInterval(() => {
    g.fillStyle = 'hsl(' + (n * 3 % 360) + ',60%,40%)'; g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#fff'; g.font = 'bold 120px sans-serif'; g.fillText(String(n++), 40, 220);
  }, 33);
  const ac = new AudioContext(); const osc = ac.createOscillator();
  const dest = ac.createMediaStreamDestination(); osc.connect(dest); osc.start();
  for (const k of CASES) {
    const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    if (!MediaRecorder.isTypeSupported(k.mime)) { await fetch('/skip?name=' + k.name); continue; }
    const rec = new MediaRecorder(stream, { mimeType: k.mime, videoBitsPerSecond: 1_000_000 });
    let seq = 0; const pending = [];
    rec.ondataavailable = (e) => { if (e.data.size) pending.push(fetch('/chunk?name=' + k.name + '&seq=' + (seq++), { method: 'POST', body: e.data })); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(3000);
    if (k.pause) {
      await sleep(k.pause[0]); rec.pause(); await sleep(k.pause[1] - k.pause[0]); rec.resume();
      await sleep(k.ms - k.pause[1]);
    } else await sleep(k.ms);
    rec.stop(); await stopped; await Promise.all(pending);
    stream.getTracks().forEach((t) => t !== dest.stream.getAudioTracks()[0] && t.stop());
    await fetch('/meta?name=' + k.name, { method: 'POST', body: JSON.stringify({ mimeType: k.mime, seq }) });
  }
  await fetch('/done');
})().catch((e) => fetch('/fail', { method: 'POST', body: String(e && e.stack || e) }));
</script>`;

fs.mkdirSync(outDir, { recursive: true });
const chunks = {};
let chromeProc;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise((r) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => r(Buffer.concat(b))); });
  const name = url.searchParams.get('name');
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(page); return; }
  if (url.pathname === '/chunk') {
    (chunks[name] ||= [])[Number(url.searchParams.get('seq'))] = body;
  } else if (url.pathname === '/meta') {
    const meta = JSON.parse(body);
    const parts = chunks[name];
    fs.writeFileSync(path.join(outDir, `${name}.${meta.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'}`), Buffer.concat(parts));
    // 分片边界也存下来：修剪读的是 IndexedDB 里一片片的 Blob，测试要能还原同样的切法
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({
      mimeType: meta.mimeType, chunkSizes: parts.map((p) => p.length),
    }, null, 2) + '\n');
    console.log(`  ${name}: ${parts.length} 片, ${parts.reduce((n, p) => n + p.length, 0)} 字节`);
  } else if (url.pathname === '/skip') {
    console.log(`  ${name}: 浏览器不支持，跳过`);
  } else if (url.pathname === '/fail') {
    console.error(String(body)); process.exitCode = 1; finish();
  } else if (url.pathname === '/done') {
    finish();
  }
  res.end('ok');
});

function finish() {
  chromeProc?.kill();
  server.close();
}

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-fixtures-'));
  console.log(`录制测试素材 → ${outDir}`);
  chromeProc = spawn(chrome, [
    '--headless=new', `--user-data-dir=${profile}`, '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', `http://127.0.0.1:${port}/`,
  ], { stdio: 'ignore' });
});
