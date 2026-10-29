// Offscreen 文档无法弹权限框，必须由一个真实的扩展页面来申请。
// 授权对象是 chrome-extension:// 这个源，之后 offscreen 和 camera iframe 都能直接用。
const status = document.getElementById('status');

document.getElementById('grant').addEventListener('click', async () => {
  status.className = 'status';
  status.textContent = '等待授权…';
  let granted = false;

  for (const constraints of [{ audio: true, video: true }, { audio: true }, { video: true }]) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((t) => t.stop());
      granted = true;
      break;
    } catch (err) {
      status.textContent = err.name === 'NotAllowedError' ? '授权被拒绝' : `无法获取设备：${err.message}`;
    }
  }

  if (granted) {
    status.className = 'status ok';
    status.textContent = '已授权，正在关闭…';
    setTimeout(() => window.close(), 900);
  } else {
    status.className = 'status err';
  }
});
