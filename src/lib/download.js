/** 下载本地素材，等到浏览器确认完成或中断后再释放对象 URL。 */
export async function downloadBlob(blob, filename) {
  if (!chrome.downloads?.download) throw new Error('请在扩展管理页刷新扩展并允许下载权限后重试');
  if (!blob.size) throw new Error('素材没有可下载的数据');
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        chrome.downloads.onChanged.removeListener(changed);
        chrome.downloads.onErased.removeListener(erased);
        if (error) reject(error); else resolve();
      };
      const interrupted = (reason) => new Error(reason === 'USER_CANCELED' ? '下载已取消'
        : reason === 'FILE_NO_SPACE' ? '磁盘空间不足' : `下载已中断${reason ? `（${reason}）` : ''}`);
      const changed = (delta) => {
        if (delta.id !== id) return;
        if (delta.state?.current === 'complete') finish();
        else if (delta.state?.current === 'interrupted') finish(interrupted(delta.error?.current));
      };
      const erased = (erasedId) => { if (erasedId === id) finish(new Error('下载记录已移除')); };
      chrome.downloads.onChanged.addListener(changed);
      chrome.downloads.onErased.addListener(erased);
      // 小文件可能在 download() 返回 id 前就已完成，补查状态，避免永远等不到事件。
      Promise.resolve().then(() => chrome.downloads.search({ id })).then(([item]) => {
        if (!item) finish(new Error('找不到下载记录'));
        else if (item.state === 'complete') finish();
        else if (item.state === 'interrupted') finish(interrupted(item.error));
      }).catch(finish);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
