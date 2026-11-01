import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadBlob } from '../src/lib/download.js';

/** Node 没有扩展 API；仅替代下载服务，使用真实 Blob URL 检查资源的存活和释放。 */
function browser(t, initial = 'in_progress') {
  const previous = globalThis.chrome;
  t.after(() => { globalThis.chrome = previous; });
  const listeners = () => {
    const callbacks = new Set();
    return { addListener: (fn) => callbacks.add(fn), removeListener: (fn) => callbacks.delete(fn),
      emit: (value) => { for (const fn of callbacks) fn(value); }, callbacks };
  };
  const onChanged = listeners();
  const onErased = listeners();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const state = { url: null, ready };
  const downloads = {
    onChanged, onErased,
    download: async ({ url }) => { state.url = url; return 42; },
    search: async () => { started(); return [{ id: 42, state: initial }]; },
  };
  globalThis.chrome = { downloads };
  return { state, downloads };
}

test('完成事件到达之前保留 Blob，完成后释放 URL 和监听器', async (t) => {
  const { state, downloads } = browser(t);
  const pending = downloadBlob(new Blob(['video bytes']), 'recording.webm');
  await state.ready;
  assert.equal(await (await fetch(state.url)).text(), 'video bytes');
  downloads.onChanged.emit({ id: 7, state: { current: 'complete' } });
  assert.equal(await (await fetch(state.url)).text(), 'video bytes', '其他下载的事件不能释放本次素材');
  downloads.onChanged.emit({ id: 42, state: { current: 'complete' } });
  await pending;
  await assert.rejects(fetch(state.url));
  assert.equal(downloads.onChanged.callbacks.size, 0);
  assert.equal(downloads.onErased.callbacks.size, 0);
});

test('小文件已在返回下载 id 前完成时，查询状态仍能收尾', async (t) => {
  const { state, downloads } = browser(t, 'complete');
  await downloadBlob(new Blob(['small']), 'small.mp4');
  await assert.rejects(fetch(state.url));
  assert.equal(downloads.onChanged.callbacks.size, 0);
});

test('取消下载会返回失败并释放临时资源', async (t) => {
  const { state, downloads } = browser(t);
  const pending = downloadBlob(new Blob(['cancel']), 'cancel.mp4');
  const rejected = assert.rejects(pending, /下载已取消/);
  await state.ready;
  downloads.onChanged.emit({ id: 42, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
  await rejected;
  await assert.rejects(fetch(state.url));
  assert.equal(downloads.onChanged.callbacks.size, 0);
});

test('发起下载失败也必须释放 Blob URL', async (t) => {
  const { state, downloads } = browser(t);
  downloads.download = async ({ url }) => { state.url = url; throw new Error('download denied'); };
  await assert.rejects(downloadBlob(new Blob(['denied']), 'denied.mp4'), /download denied/);
  await assert.rejects(fetch(state.url));
});

test('状态查询同步失败时不会泄漏监听器', async (t) => {
  const { state, downloads } = browser(t);
  downloads.search = () => { throw new Error('permission lost'); };
  await assert.rejects(downloadBlob(new Blob(['error']), 'error.mp4'), /permission lost/);
  await assert.rejects(fetch(state.url));
  assert.equal(downloads.onChanged.callbacks.size, 0);
  assert.equal(downloads.onErased.callbacks.size, 0);
});

test('下载记录被移除时结束等待并报告失败', async (t) => {
  const { state, downloads } = browser(t);
  const pending = downloadBlob(new Blob(['erased']), 'erased.mp4');
  const rejected = assert.rejects(pending, /下载记录已移除/);
  await state.ready;
  downloads.onErased.emit(42);
  await rejected;
  await assert.rejects(fetch(state.url));
});

test('空素材不能被报告为下载成功', async (t) => {
  browser(t);
  await assert.rejects(downloadBlob(new Blob([]), 'empty.mp4'), /没有可下载的数据/);
});
