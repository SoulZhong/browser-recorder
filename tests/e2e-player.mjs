// 素材库修剪的端到端检查：在真实 Chromium 里加载扩展，把测试素材写进 IndexedDB，
// 点按钮走完「修剪 → 另存 / 替换」，并确认成片在 <video> 里能播到头。
// 用法：node tests/e2e-player.mjs <Chrome for Testing 可执行文件> [截图输出目录]
//
// 正式版 Chrome 137 起不再支持 --load-extension，必须用 Chrome for Testing / Chromium。
// 不依赖任何库：直接走 DevTools 协议（Node 自带 WebSocket）。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const chrome = process.argv[2];
const shotDir = process.argv[3];
if (!chrome) { console.error('用法：node tests/e2e-player.mjs <chrome 路径> [截图目录]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 素材服务：扩展页面从这里 fetch 测试素材 ──
const server = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  const f = path.join(here, 'fixtures', path.basename(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── 启动浏览器 ──
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-e2e-'));
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-downloads-'));
fs.mkdirSync(path.join(profile, 'Default'));
fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
  profile: { default_content_setting_values: { automatic_downloads: 2 } },
  download: { prompt_for_download: false, default_directory: downloadDir },
}));
const proc = spawn(chrome, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--remote-debugging-port=0',
  `--load-extension=${root}`, `--disable-extensions-except=${root}`, 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => proc.kill());
let port = null;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
}
assert.ok(port, '浏览器没有起来');

let extId = null;
for (let i = 0; i < 50 && !extId; i++) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'));
  if (sw) extId = new URL(sw.url).host;
  else await sleep(200);
}
assert.ok(extId, '扩展没有加载');

// 扩展页面要由浏览器端 Target.createTarget 打开；/json/new 或 Page.navigate 过去会被拦成错误页
const playerUrl = `chrome-extension://${extId}/src/player/player.html`;
{
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const bws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => bws.addEventListener('open', r));
  bws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: playerUrl } }));
  await new Promise((r) => bws.addEventListener('message', r, { once: true }));
  bws.close();
}
let page = null;
for (let i = 0; i < 50 && !page; i++) {
  page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && t.url === playerUrl);
  if (!page) await sleep(100);
}
assert.ok(page, '素材库页面没有打开');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const waiting = new Map();
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, label, ms = 15000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) {
    if (await evaluate(`return !!(${expr});`)) return;
  }
  throw new Error(`等待超时：${label}`);
};
const shot = async (name) => {
  if (!shotDir) return;
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
};
await cdp('Runtime.enable');
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// ── 写入测试素材：一条完成的 MP4、一条中断过的 WebM ──
await waitFor(`document.readyState === 'complete'`, '页面加载');
await evaluate(`
  const db = await new Promise((res, rej) => { const r = indexedDB.open('browser-recorder', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const put = (store, v) => new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(v); t.oncomplete = res; t.onerror = () => rej(t.error); });
  const fixtures = [
    ['mp4', { id: 'rec_e2e_mp4', title: '演示 MP4', status: 'done', mode: 'tab', duration: 11996, createdAt: Date.now() - 60000 }],
    ['webm-vp8', { id: 'rec_e2e_webm', title: '演示 WebM', status: 'interrupted', mode: 'screen', duration: 8000, createdAt: Date.now() - 120000 }],
    ['webm-vp8', { id: 'rec_e2e_cut_webm', title: '拼接 WebM', status: 'interrupted', mode: 'screen', duration: 8000, createdAt: Date.now() - 180000 }],
  ];
  for (const [name, rec] of fixtures) {
    const meta = await (await fetch('${base}/' + name + '.json')).json();
    const ext = meta.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    const buf = new Uint8Array(await (await fetch('${base}/' + name + '.' + ext)).arrayBuffer());
    let o = 0;
    for (const [i, n] of meta.chunkSizes.entries()) {
      const blob = new Blob([buf.subarray(o, o + n)], { type: meta.mimeType.split(';')[0] });
      await put('chunks', { recordingId: rec.id, seq: i, blob, size: n, ts: Date.now() });
      o += n;
    }
    await put('recordings', { ...rec, mimeType: meta.mimeType.split(';')[0], size: buf.length, chunkCount: meta.chunkSizes.length, width: 640, height: 360 });
  }
  db.close();
`);
await evaluate(`location.href = location.pathname + '?id=rec_e2e_mp4';`);
await sleep(500);
await waitFor(`document.querySelectorAll('.item').length === 3 && !document.getElementById('stage').hidden`, '列表与播放区');

// 禁止网页自动下载多个文件时，全选仍应下载全部素材；不能只验证下载函数被调用。
await cdp('Browser.setDownloadBehavior', { behavior: 'default' });
const downloadedFiles = () => fs.readdirSync(downloadDir).filter((name) => !name.endsWith('.crdownload'));
const expectedHashes = await evaluate(`
  const { listRecordings, assembleBlob } = await import('../lib/db.js');
  const hashes = [];
  for (const rec of await listRecordings()) {
    const bytes = await (await assembleBlob(rec.id)).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    hashes.push([...digest].map((n) => n.toString(16).padStart(2, '0')).join(''));
  }
  return hashes.sort();
`);
await evaluate(`document.getElementById('pickAll').click(); document.getElementById('bulkDownload').click();`);
await waitFor(`!document.getElementById('bulkDownload').disabled`, '批量下载完成', 30000);
assert.equal(downloadedFiles().length, 3, '全选 3 条视频，必须实际写出 3 个文件');
assert.deepEqual(downloadedFiles().map((name) => createHash('sha256').update(fs.readFileSync(path.join(downloadDir, name))).digest('hex')).sort(), expectedHashes,
  '下载文件必须与素材库中的每一条视频逐字节一致');
await evaluate(`document.getElementById('bulkDownload').click();`);
await waitFor(`!document.getElementById('bulkDownload').disabled`, '重复批量下载完成', 30000);
assert.equal(downloadedFiles().length, 6, '重名文件应保留两份，不能覆盖或跳过');
await evaluate(`document.getElementById('download').click();`);
for (const start = Date.now(); downloadedFiles().length < 7 && Date.now() - start < 15000; await sleep(100)) {}
assert.equal(downloadedFiles().length, 7, '单条下载也应正常完成');
await cdp('Browser.setDownloadBehavior', { behavior: 'deny' });
await evaluate(`document.getElementById('bulkDownload').click();`);
await waitFor(`!document.getElementById('bulkDownload').disabled`, '浏览器拒绝下载后恢复操作', 30000);
assert.match(await evaluate(`return document.getElementById('downloadStatus').textContent;`), /3 项失败/, '下载被拒绝时必须显示实际失败数');
assert.equal(downloadedFiles().length, 7);
await cdp('Browser.setDownloadBehavior', { behavior: 'default' });
await evaluate(`document.getElementById('bulkDownload').click();`);
await waitFor(`!document.getElementById('bulkDownload').disabled`, '失败后重试下载', 30000);
assert.equal(downloadedFiles().length, 10, '失败之后仍可重新下载全部视频');
console.log('✔ 批量下载：3 条全量、字节校验、重名保留、单条下载、拒绝后重试通过');
await evaluate(`document.getElementById('pickAll').click();`);

const ui = {
  /** 把视频跳到某秒再点按钮，等价于用户先拖播放进度再点「设为起点/终点」 */
  async setEdge(edge, sec) {
    await evaluate(`
      const v = document.getElementById('video');
      await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = ${sec}; });
      document.getElementById('${edge === 'start' ? 'trimSetStart' : 'trimSetEnd'}').click();
    `);
  },
  text: (id) => evaluate(`return document.getElementById('${id}').textContent;`),
  async openTrim() {
    await evaluate(`document.getElementById('trim').click();`);
    await waitFor(`!document.getElementById('trimSave').disabled && document.querySelectorAll('#trimKeys i').length > 0`, '修剪条就绪');
  },
  /** 当前播放区的视频能完整播放：时长有限、能拖到末尾、没有解码错误 */
  async playable() {
    return evaluate(`
      const v = document.getElementById('video');
      if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
      v.muted = true;
      await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = Math.max(0, v.duration - 0.3); });
      await v.play().catch(() => {});
      await new Promise((r) => { v.addEventListener('ended', r, { once: true }); setTimeout(r, 3000); });
      return { duration: v.duration, ended: v.ended, error: v.error && v.error.message, w: v.videoWidth };
    `);
  },
};

// 1. MP4：另存为新素材
await ui.openTrim();
await ui.setEdge('start', 5);
await ui.setEdge('end', 9);
const snap = await ui.text('trimSnap');
console.log('起点对齐提示：', snap);
assert.match(snap, /从 00:04\.19 开始/, '入点应往前对齐到 4.19 秒的关键帧');
assert.equal(await ui.text('trimStartText'), '00:04.19');
assert.equal(await ui.text('trimEndText'), '00:09.00');
await shot('1-trim-panel');
await evaluate(`document.getElementById('trimSave').click();`);
await waitFor(`document.querySelectorAll('.item').length === 4 && document.getElementById('trimPanel').hidden`, '另存完成');
const copy = await evaluate(`return { title: document.getElementById('title').value, meta: document.getElementById('stageMeta').textContent, url: location.search };`);
console.log('新素材：', copy);
assert.equal(copy.title, '演示 MP4（修剪）');
assert.match(copy.meta, /修剪自「演示 MP4」/);
const p1 = await ui.playable();
console.log('新素材播放：', p1);
assert.ok(!p1.error && p1.ended && Math.abs(p1.duration - 4.85) < 0.1, '修剪后的 MP4 应能播到头，时长约 4.85 秒');
await shot('2-saved-copy');

// 2. WebM（中断过）：替换原录像
await evaluate(`[...document.querySelectorAll('.item')].find((el) => el.textContent.includes('演示 WebM')).click();`);
await waitFor(`document.getElementById('title').value === '演示 WebM'`, '切到 WebM');
await ui.openTrim();
await ui.setEdge('start', 4);
await evaluate(`window.confirm = () => true;`);
await evaluate(`document.getElementById('trimReplace').click();`);
await waitFor(`document.getElementById('trimPanel').hidden && !location.search.includes('rec_e2e_webm')`, '替换完成');
const replaced = await evaluate(`
  const items = [...document.querySelectorAll('.item')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
  return { title: document.getElementById('title').value, items, meta: document.getElementById('stageMeta').textContent };
`);
console.log('替换后：', replaced);
assert.equal(replaced.title, '演示 WebM', '替换后标题不变');
assert.equal(replaced.items.length, 4, '替换不增加条目');
assert.ok(replaced.items.some((t) => t.includes('演示 WebM') && t.includes('已恢复')), '替换后保留「已恢复」标签');
const p2 = await ui.playable();
console.log('替换后播放：', p2);
assert.ok(!p2.error && p2.ended && Math.abs(p2.duration - 4.1) < 0.2, '替换后的 WebM 应能播到头，时长约 4.1 秒');
await shot('3-replaced');

// 3. 删除中间片段：恢复选区、预览跳过删除部分，再拼接三段并另存。
await evaluate(`[...document.querySelectorAll('.item')].find((el) => el.querySelector('.name').textContent === '演示 MP4').click();`);
await waitFor(`document.getElementById('title').value === '演示 MP4'`, '切到原 MP4');
await evaluate(`document.getElementById('cut').click();`);
await waitFor(`!document.getElementById('cutControls').hidden && !document.getElementById('trimSetStart').disabled`, '删除片段模式');
assert.equal(await evaluate(`return document.getElementById('cutRemove').disabled;`), true, '不能删除整条录像');
assert.equal(await evaluate(`return document.getElementById('trimSave').disabled;`), true, '没有删除片段时不能保存');
await ui.setEdge('end', 7);
await ui.setEdge('start', 4.3);
await evaluate(`document.getElementById('cutRemove').click();`);
assert.equal(await evaluate(`return document.querySelectorAll('#cutMarks i').length;`), 1);
await evaluate(`document.querySelector('#cutList button').click();`);
assert.equal(await evaluate(`return document.querySelectorAll('#cutMarks i').length;`), 0, '恢复后应移除删除标记');
await ui.setEdge('end', 7);
await ui.setEdge('start', 4.3);
await evaluate(`document.getElementById('cutRemove').click(); document.getElementById('trimPreview').click();`);
await evaluate(`document.getElementById('video').currentTime = 4.25;`);
await waitFor(`document.getElementById('video').currentTime >= 8.14`, '预览跳过删除片段');
await evaluate(`document.getElementById('video').pause();`);
await ui.setEdge('start', 10.1);
await ui.setEdge('end', 11);
await evaluate(`document.getElementById('cutRemove').click();`);
assert.equal(await evaluate(`return document.querySelectorAll('#cutMarks i').length;`), 2);
await shot('5-cut-segments');
await evaluate(`document.getElementById('trimSave').click();`);
await waitFor(`document.getElementById('title').value === '演示 MP4（剪辑）' && document.getElementById('trimPanel').hidden`, '拼接另存完成');
const edited = await evaluate(`
  const { getRecording } = await import('../lib/db.js');
  const rec = await getRecording(new URLSearchParams(location.search).get('id'));
  return { ranges: rec.trim.ranges, removed: rec.trim.removed, duration: rec.duration, original: (await getRecording('rec_e2e_mp4')).duration };
`);
assert.equal(edited.ranges.length, 3, '两次删除应拼接三个保留片段');
assert.equal(edited.removed.length, 2);
assert.equal(edited.original, 11996, '另存不得修改原录像');
assert.ok(Math.abs(edited.duration - 6207) < 100);
const joinedMp4 = await ui.playable();
assert.ok(joinedMp4.ended && !joinedMp4.error && Math.abs(joinedMp4.duration - 6.207) < 0.1);
await evaluate(`location.reload();`);
await waitFor(`document.getElementById('title').value === '演示 MP4（剪辑）' && document.getElementById('video').readyState >= 2`, '刷新后拼接素材仍可读取');
await shot('6-joined-mp4');

// 4. WebM 拼接替换，保留原来的标题和中断状态。
await evaluate(`[...document.querySelectorAll('.item')].find((el) => el.querySelector('.name').textContent === '拼接 WebM').click();`);
await waitFor(`document.getElementById('title').value === '拼接 WebM'`, '切到待拼接 WebM');
await evaluate(`document.getElementById('cut').click();`);
await waitFor(`!document.getElementById('trimSetStart').disabled && !document.getElementById('cutControls').hidden`, 'WebM 剪辑就绪');
await ui.setEdge('end', 5);
await ui.setEdge('start', 4);
await evaluate(`document.getElementById('cutRemove').click(); window.confirm = () => true; document.getElementById('trimReplace').click();`);
await waitFor(`document.getElementById('trimPanel').hidden && !location.search.includes('rec_e2e_cut_webm')`, 'WebM 拼接替换完成');
assert.equal(await ui.text('viewerName'), '拼接 WebM');
const joinedWebm = await ui.playable();
assert.ok(joinedWebm.ended && !joinedWebm.error && Math.abs(joinedWebm.duration - 3.931) < 0.1);
console.log('拼接后的播放检查：', { mp4: joinedMp4, webm: joinedWebm });

// 窄窗口（约 1000px）走纵向布局，截一张看排版
await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
await sleep(800);
await evaluate(`document.getElementById('trim').click();`);
await waitFor(`!document.getElementById('trimSave').disabled`, '窄屏修剪条');
await shot('4-narrow');

// 3. 原录像的分片确实删掉了
const left = await evaluate(`
  const db = await new Promise((res) => { const r = indexedDB.open('browser-recorder', 1); r.onsuccess = () => res(r.result); });
  const keys = await new Promise((res) => { const r = db.transaction('chunks').objectStore('chunks').getAllKeys(); r.onsuccess = () => res(r.result); });
  db.close();
  return keys.filter((k) => k[0] === 'rec_e2e_webm').length;
`);
assert.equal(left, 0, '替换后原录像的分片应被删除');

assert.deepEqual(consoleErrors, [], '页面上有未捕获的异常');
console.log('✔ 端到端检查通过');
ws.close();
proc.kill();
server.close();
