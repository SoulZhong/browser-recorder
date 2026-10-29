// 注入被截图页面的脚本：负责区域选择框，以及整页拼接时的滚动驱动。
// 真正的像素抓取在 Service Worker 里（captureVisibleTab），这里只做页面侧的配合。

(() => {
  if (window.__brCaptureInstalled) return;
  window.__brCaptureInstalled = true;

  let host = null;
  let shadow = null;

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return shadow;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return shadow;
  }

  function removeHost() {
    host?.remove();
    host = null;
    shadow = null;
  }

  const CSS = `
    :host { all: initial; }
    .mask {
      position: fixed; inset: 0; cursor: crosshair;
      background: rgba(10,11,15,.42);
      font: 500 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    /* 用四块遮罩挖出选区，而不是给选区加反色滤镜——选区内必须是原始像素 */
    .shade { position: fixed; background: rgba(10,11,15,.42); }
    .sel {
      position: fixed; border: 1px solid #f03e4e;
      box-shadow: 0 0 0 1px rgba(255,255,255,.35);
      pointer-events: none;
    }
    .size {
      position: fixed; padding: 3px 7px; border-radius: 6px; pointer-events: none;
      background: #14161c; color: #e8eaf0; font-size: 11.5px; white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .tip {
      position: fixed; left: 50%; top: 24px; transform: translateX(-50%);
      padding: 8px 14px; border-radius: 10px; pointer-events: none;
      background: rgba(20,22,28,.94); color: #e8eaf0;
      box-shadow: 0 8px 28px rgba(0,0,0,.4);
    }
  `;

  // ------------------------------------------------------------ 区域选择

  function selectArea() {
    const root = ensureHost();
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'mask';
      const shades = [0, 1, 2, 3].map(() => {
        const d = document.createElement('div');
        d.className = 'shade';
        return d;
      });
      const sel = document.createElement('div');
      sel.className = 'sel';
      const size = document.createElement('div');
      size.className = 'size';
      const tip = document.createElement('div');
      tip.className = 'tip';
      tip.textContent = '拖拽选择区域 · Esc 取消';
      sel.style.display = size.style.display = 'none';
      root.append(mask, ...shades, sel, size, tip);

      let sx = 0, sy = 0, dragging = false;

      const rect = () => {
        const x = Math.min(sx, cx), y = Math.min(sy, cy);
        return { x, y, w: Math.abs(cx - sx), h: Math.abs(cy - sy) };
      };
      let cx = 0, cy = 0;

      function paint() {
        const r = rect();
        sel.style.cssText += '';
        Object.assign(sel.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
        // 选区外四块遮罩：上 / 下 / 左 / 右
        const W = innerWidth, H = innerHeight;
        const boxes = [
          { left: 0, top: 0, width: W, height: r.y },
          { left: 0, top: r.y + r.h, width: W, height: Math.max(0, H - r.y - r.h) },
          { left: 0, top: r.y, width: r.x, height: r.h },
          { left: r.x + r.w, top: r.y, width: Math.max(0, W - r.x - r.w), height: r.h },
        ];
        shades.forEach((d, i) => {
          const b = boxes[i];
          Object.assign(d.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
        });
        mask.style.background = 'transparent';
        size.style.display = 'block';
        size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
        const sxPos = Math.min(Math.max(0, r.x), innerWidth - 90);
        const syPos = r.y > 28 ? r.y - 26 : r.y + r.h + 8;
        Object.assign(size.style, { left: `${sxPos}px`, top: `${syPos}px` });
      }

      function finish(result) {
        cleanup();
        // 覆层必须先从页面上消失，再让 SW 去截图，否则遮罩会被截进去。
        // 两帧足够让浏览器完成一次合成。
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
      }

      function onDown(e) {
        if (e.button !== 0) return;
        dragging = true;
        sx = cx = e.clientX; sy = cy = e.clientY;
        tip.remove();
        paint();
        e.preventDefault();
      }
      function onMove(e) {
        if (!dragging) return;
        cx = e.clientX; cy = e.clientY;
        paint();
      }
      function onUp() {
        if (!dragging) return;
        dragging = false;
        const r = rect();
        if (r.w < 4 || r.h < 4) { finish({ cancelled: true }); return; }
        // viewportWidth 是裁剪时换算 CSS 像素 → 设备像素的分母，必须一起送回去
        finish({
          rect: r,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
        });
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish({ cancelled: true }); }
      }
      function cleanup() {
        removeEventListener('mousedown', onDown, true);
        removeEventListener('mousemove', onMove, true);
        removeEventListener('mouseup', onUp, true);
        removeEventListener('keydown', onKey, true);
        removeHost();
      }

      addEventListener('mousedown', onDown, true);
      addEventListener('mousemove', onMove, true);
      addEventListener('mouseup', onUp, true);
      addEventListener('keydown', onKey, true);
    });
  }

  // ------------------------------------------------------------ 整页拼接

  let fullPageState = null;

  const SCROLLABLE = /^(auto|scroll|overlay)$/;

  /**
   * 找出真正在滚的那个东西。
   * 很多应用（飞书、Notion、Gmail、各种后台）是 100vh 的壳子 + 内部滚动容器，
   * window 本身一像素都滚不动——只滚 window 的话，"整页"截出来就只有一屏。
   * 返回 null 表示就滚 window。
   */
  function findScrollContainer() {
    const W = innerWidth, H = innerHeight;
    const se = document.scrollingElement || document.documentElement;
    const windowRange = se.scrollHeight - H;

    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.clientHeight < 100 || el.scrollHeight - el.clientHeight < 2) continue;
      if (!SCROLLABLE.test(getComputedStyle(el).overflowY)) continue;
      const r = el.getBoundingClientRect();
      // 只看基本完整落在视口里的——露一半的容器截不全，不如退回滚 window
      const visW = Math.min(r.right, W) - Math.max(r.left, 0);
      const visH = Math.min(r.bottom, H) - Math.max(r.top, 0);
      if (visW <= 0 || visH < r.height * 0.9) continue;
      const area = visW * visH;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    if (!best) return null;
    // 占视口不到三成的是侧栏、下拉框之类，不是页面主体
    if (bestArea < W * H * 0.3) return null;
    // window 也能滚、而且滚得比容器还多时，页面主体还是 window
    if (windowRange > 1 && windowRange >= best.scrollHeight - best.clientHeight) return null;
    return best;
  }

  function stepsFor(totalH, viewH) {
    const steps = [];
    for (let y = 0; y < totalH; y += viewH) steps.push(Math.min(y, Math.max(0, totalH - viewH)));
    // 去重：页面不足两屏时上面会算出重复的 0
    return [...new Set(steps)];
  }

  /** 量出页面尺寸并排好每一屏的滚动位置。 */
  function planFullPage(maxHeight) {
    const doc = document.documentElement;
    const body = document.body;
    const viewH = window.innerHeight;
    const viewW = window.innerWidth;
    const dpr = window.devicePixelRatio || 1;
    // maxHeight 是设备像素上限（画布高度有硬上限），换成 CSS 像素
    const maxCssH = Math.floor(maxHeight / dpr);
    const container = findScrollContainer();

    fullPageState = {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      htmlOverflow: doc.style.overflow,
      bodyOverflow: body ? body.style.overflow : '',
      container,
      containerTop: container ? container.scrollTop : 0,
      hidden: [],
    };

    if (container) {
      // 只截容器的内容区：clientLeft/Top 跳过边框，clientWidth/Height 不含滚动条
      const r = container.getBoundingClientRect();
      const clip = {
        x: Math.max(0, r.left + container.clientLeft),
        y: Math.max(0, r.top + container.clientTop),
        w: Math.min(container.clientWidth, viewW),
        h: Math.min(container.clientHeight, viewH),
      };
      const totalH = Math.min(container.scrollHeight, maxCssH);
      return { mode: 'element', totalH, viewH, viewW, clip, steps: stepsFor(totalH, clip.h), dpr };
    }

    const totalH = Math.min(
      Math.max(doc.scrollHeight, body?.scrollHeight || 0, doc.offsetHeight, viewH),
      maxCssH,
    );
    const clip = { x: 0, y: 0, w: viewW, h: viewH };
    return { mode: 'window', totalH, viewH, viewW, clip, steps: stepsFor(totalH, viewH), dpr };
  }

  /**
   * 藏起 fixed / sticky 元素。
   * 不做这一步，吸顶导航和悬浮客服会出现在每一屏里，拼出来的长图全是重复的横条——
   * 这是整页截图能不能用的分水岭。第一屏保留它们（那才是页面真实的样子）。
   */
  function hideFloating() {
    if (!fullPageState) return 0;
    const { container } = fullPageState;
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (el.getBoundingClientRect().height === 0) continue;
      // 应用壳子常常本身就是 fixed 的，滚动容器在它里面——
      // 把它藏了，visibility 会继承下去，后面每一屏都是白的
      if (container && el.contains(container)) continue;
      fullPageState.hidden.push([el, el.style.visibility]);
      el.style.visibility = 'hidden';
    }
    return fullPageState.hidden.length;
  }

  function scrollToStep(y) {
    const container = fullPageState?.container;
    // behavior: 'instant' 压过页面的 scroll-behavior: smooth，
    // 否则截图时还在半路上，量到的位置和画面对不上
    if (container) {
      container.scrollTo({ top: y, behavior: 'instant' });
    } else {
      const doc = document.documentElement;
      doc.style.overflow = 'hidden';          // 滚动条会在每一屏右侧留下一道竖线
      if (document.body) document.body.style.overflow = 'hidden';
      window.scrollTo({ left: 0, top: y, behavior: 'instant' });
    }
    return new Promise((resolve) => {
      // 两帧 + 一点余量，让懒加载图片和滚动动画落定
      requestAnimationFrame(() => requestAnimationFrame(() => {
        setTimeout(() => resolve({ y: container ? container.scrollTop : window.scrollY }), 60);
      }));
    });
  }

  function restore() {
    if (!fullPageState) return;
    const doc = document.documentElement;
    doc.style.overflow = fullPageState.htmlOverflow;
    if (document.body) document.body.style.overflow = fullPageState.bodyOverflow;
    for (const [el, vis] of fullPageState.hidden) el.style.visibility = vis;
    fullPageState.container?.scrollTo({ top: fullPageState.containerTop, behavior: 'instant' });
    window.scrollTo({ left: fullPageState.scrollX, top: fullPageState.scrollY, behavior: 'instant' });
    fullPageState = null;
    removeHost();
  }

  // ------------------------------------------------------------ 消息

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'SHOT_SELECT_AREA':
        // 覆层一挂上就广播一声，弹窗听到才让开——盲目定时关窗会出现
        // "弹窗没了但覆层也没出来"的死角，而且那之后任何错误都无处显示。
        chrome.runtime.sendMessage({ type: 'AREA_OVERLAY_READY' }).catch(() => {});
        // 选择结果仍走 sendResponse：这条挂起的调用同时也是 Service Worker 的保活，
        // 用户拖拽期间 SW 不会被回收。
        selectArea().then(sendResponse);
        return true;
      case 'SHOT_PLAN_FULLPAGE':
        sendResponse(planFullPage(msg.maxHeight || 32000));
        return false;
      case 'SHOT_HIDE_FLOATING':
        sendResponse({ hidden: hideFloating() });
        return false;
      case 'SHOT_SCROLL_TO':
        scrollToStep(msg.y).then(sendResponse);
        return true;
      case 'SHOT_RESTORE':
        restore();
        sendResponse({ ok: true });
        return false;
      default:
        return undefined;
    }
  });
})();
