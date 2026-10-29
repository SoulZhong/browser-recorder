// 注入到被录制页面的覆层：倒计时 + 摄像头画中画气泡。
//
// 摄像头没有直接在这里 getUserMedia —— 那会走页面自身的源，触发站点级授权弹窗。
// 改成插一个指向 chrome-extension:// 的 iframe，复用扩展已有的摄像头授权，
// 而 tabCapture 录的是整个渲染结果，气泡自然被录进成片里。

(() => {
  if (window.__brOverlayInstalled) return;
  window.__brOverlayInstalled = true;

  const NS = 'br-overlay-root';
  let host = null;
  let shadow = null;

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return shadow;
    host = document.createElement('div');
    host.id = NS;
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return shadow;
  }

  const CSS = `
    :host { all: initial; }
    .cd-backdrop {
      position: fixed; inset: 0; display: grid; place-items: center;
      background: rgba(10,11,15,.55); backdrop-filter: blur(2px);
      font: 500 16px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #fff; pointer-events: none;
    }
    .cd-num {
      font-size: 132px; font-weight: 700; letter-spacing: -.04em;
      animation: cd-pop .9s cubic-bezier(.16,1,.3,1);
      text-shadow: 0 8px 40px rgba(0,0,0,.5);
    }
    .cd-hint { margin-top: 8px; opacity: .78; font-size: 15px; }
    @keyframes cd-pop {
      0%   { transform: scale(.55); opacity: 0; }
      25%  { transform: scale(1);   opacity: 1; }
      100% { transform: scale(1.06); opacity: .82; }
    }
    .cam {
      position: fixed; left: 24px; bottom: 24px;
      width: 180px; height: 180px; border-radius: 50%;
      overflow: hidden; pointer-events: auto; cursor: grab;
      box-shadow: 0 10px 32px rgba(0,0,0,.38), 0 0 0 3px rgba(255,255,255,.9);
      background: #16171d; touch-action: none;
    }
    .cam.dragging { cursor: grabbing; }
    .cam iframe { width: 100%; height: 100%; border: 0; display: block; pointer-events: none; }

    /* 录制区域边框。必须整体画在选区之外——裁剪是从选区内取像素的，
       画在里面就会被录进成片。GAP 是留给裁剪时偶数对齐的余量。 */
    .region {
      position: fixed; pointer-events: none;
      border: 2px solid #f03e4e; border-radius: 3px;
      box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 0 14px rgba(240,62,78,.35);
      animation: region-pulse 2s ease-in-out infinite;
    }
    @keyframes region-pulse {
      50% { border-color: rgba(240,62,78,.45); box-shadow: 0 0 0 1px rgba(0,0,0,.25), 0 0 6px rgba(240,62,78,.2); }
    }
    .region-tag {
      position: fixed; pointer-events: none; display: flex; align-items: center; gap: 5px;
      padding: 3px 8px; border-radius: 6px; white-space: nowrap;
      background: #f03e4e; color: #fff; font: 600 11px/1.4 -apple-system, "PingFang SC", sans-serif;
    }
    .region-tag i {
      width: 6px; height: 6px; border-radius: 50%; background: #fff;
      animation: region-blink 1.4s ease-in-out infinite;
    }
    @keyframes region-blink { 50% { opacity: .25; } }

    .toast {
      position: fixed; left: 50%; top: 20px; transform: translateX(-50%);
      max-width: 70vw; padding: 9px 14px; border-radius: 10px; pointer-events: none;
      background: rgba(20,22,28,.96); color: #ffb3ba; box-shadow: 0 8px 28px rgba(0,0,0,.45);
      font: 500 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
  `;

  // ---- 倒计时 ----
  function countdown(seconds) {
    const root = ensureHost();
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'cd-backdrop';
      const num = document.createElement('div');
      num.className = 'cd-num';
      const hint = document.createElement('div');
      hint.className = 'cd-hint';
      hint.textContent = '即将开始录制';
      const box = document.createElement('div');
      box.style.cssText = 'text-align:center';
      box.append(num, hint);
      backdrop.appendChild(box);
      root.appendChild(backdrop);

      let n = seconds;
      const tick = () => {
        if (n <= 0) {
          backdrop.remove();
          resolve();
          return;
        }
        num.textContent = String(n);
        num.style.animation = 'none';
        void num.offsetWidth;
        num.style.animation = '';
        n--;
        setTimeout(tick, 1000);
      };
      tick();
    });
  }

  // ---- 录制区域边框 ----

  /**
   * 边框整体画在选区之外：内边缘距选区 GAP 像素，外面再加 2px 描边。
   * 裁剪时坐标会向下取整到偶数设备像素，最坏情况裁剪框比选区大出 2 个设备像素
   * （高分屏上 1 个 CSS 像素），GAP=3 足够保证边框不进画面。
   */
  const REGION_GAP = 3;
  const REGION_BORDER = 2;
  let regionEl = null;
  let regionTagEl = null;

  function regionOn(rect) {
    const root = ensureHost();
    regionOff();
    const out = REGION_GAP + REGION_BORDER;

    regionEl = document.createElement('div');
    regionEl.className = 'region';
    Object.assign(regionEl.style, {
      left: `${rect.x - out}px`,
      top: `${rect.y - out}px`,
      width: `${rect.w + out * 2 - REGION_BORDER * 2}px`,
      height: `${rect.h + out * 2 - REGION_BORDER * 2}px`,
    });

    regionTagEl = document.createElement('div');
    regionTagEl.className = 'region-tag';
    const dot = document.createElement('i');
    regionTagEl.append(dot, document.createTextNode('录制中'));
    // 标签也不能压到选区上：优先放在框上方，上方不够就放下方
    const above = rect.y - out - 24;
    Object.assign(regionTagEl.style, {
      left: `${Math.max(4, rect.x - out)}px`,
      top: above >= 4 ? `${above}px` : `${rect.y + rect.h + out + 6}px`,
    });

    root.append(regionEl, regionTagEl);
  }

  function regionOff() {
    regionEl?.remove(); regionEl = null;
    regionTagEl?.remove(); regionTagEl = null;
  }

  // ---- 提示条 ----

  /** 弹窗已经关掉之后出问题，只能在页面上说。 */
  function toast(text, ms = 5000) {
    const root = ensureHost();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    root.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ---- 摄像头气泡 ----
  let camEl = null;

  function cameraOn(deviceId) {
    const root = ensureHost();
    if (camEl) return;
    camEl = document.createElement('div');
    camEl.className = 'cam';
    const frame = document.createElement('iframe');
    frame.allow = 'camera; microphone';
    const url = new URL(chrome.runtime.getURL('src/camera/camera.html'));
    if (deviceId) url.searchParams.set('deviceId', deviceId);
    frame.src = url.toString();
    camEl.appendChild(frame);
    root.appendChild(camEl);
    makeDraggable(camEl);
  }

  function makeDraggable(el) {
    let sx = 0, sy = 0, ox = 0, oy = 0;
    el.addEventListener('pointerdown', (e) => {
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      el.style.bottom = 'auto';
      el.style.left = `${ox}px`;
      el.style.top = `${oy}px`;
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.classList.contains('dragging')) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      const x = Math.min(Math.max(0, ox + e.clientX - sx), innerWidth - w);
      const y = Math.min(Math.max(0, oy + e.clientY - sy), innerHeight - h);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    });
    const end = (e) => {
      el.classList.remove('dragging');
      try { el.releasePointerCapture(e.pointerId); } catch {}
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function clear() {
    camEl = null;
    regionEl = null;
    regionTagEl = null;
    host?.remove();
    host = null;
    shadow = null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'OVERLAY_COUNTDOWN':
        countdown(msg.seconds || 3).then(() => sendResponse({ ok: true }));
        return true;
      case 'OVERLAY_CAMERA_ON':
        cameraOn(msg.deviceId);
        sendResponse({ ok: true });
        return false;
      case 'OVERLAY_REGION_ON':
        regionOn(msg.rect);
        sendResponse({ ok: true });
        return false;
      case 'OVERLAY_REGION_OFF':
        regionOff();
        sendResponse({ ok: true });
        return false;
      case 'OVERLAY_TOAST':
        toast(msg.text, msg.ms);
        sendResponse({ ok: true });
        return false;
      case 'OVERLAY_CLEAR':
        clear();
        sendResponse({ ok: true });
        return false;
      default:
        return undefined;
    }
  });
})();
