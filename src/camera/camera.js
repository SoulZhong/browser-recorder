// 跑在 chrome-extension:// 源里，所以复用扩展的摄像头授权，
// 不会向被录制的站点索要权限。
(async () => {
  const deviceId = new URLSearchParams(location.search).get('deviceId');
  const video = document.getElementById('v');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 640 }, height: { ideal: 640 },
      },
      audio: false,
    });
    video.srcObject = stream;
    addEventListener('pagehide', () => stream.getTracks().forEach((t) => t.stop()));
  } catch (err) {
    document.body.innerHTML = '<div class="err">摄像头不可用<br>请先在扩展中授权</div>';
    console.warn(err);
  }
})();
