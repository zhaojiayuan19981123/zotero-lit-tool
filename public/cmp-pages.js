/**
 * cmp-pages.js —— 对照精读的「译文页」渲染器
 *
 * ============================ 这是什么 ============================
 *
 * 参照 FreePDF（pdf2zh 那条线）的读法，把译文栏从「一段一段的文本流」换成
 * **和原文同样排版的页面**：页面底图是原 PDF 那一页，版面识别给出的每个文字块
 * 在原坐标上被白底盖住、填上译文；图表 / 表格 / 公式**不盖不翻**，原样留在页面上。
 *
 * 为什么不用「文本流」：文献的图表、双栏、公式位置本身就是信息。文本流把整页压成
 * 一条竖线，图只能看裁图、表只能看一句「按原样保留」，读起来和读 PDF 是两件事。
 *
 * ============================ 坐标口径 ============================
 *
 * 版面块（manifest / buildAlignOutput）给的是**未旋转页面**的归一化坐标：
 *   x / y / width / height ∈ [0,1]，左上角原点。
 * 页面被用户旋转过时，块也要跟着转，换算统一走 PdfReaderUtils.toDisplayRect ——
 * 与 reader-blocks.js 用的是同一套（否则译文和原文会差 90°）。
 *
 * ============================ 文字怎么塞进原块 ============================
 *
 * 译文长度和原文不可能一样，所以字号是**按块算出来的**：二分找「能完整放进块里」
 * 的最大字号（下限 MIN_FONT）。中文译文通常是英文原文字符数的 0.55~0.7 倍，
 * 绝大多数块在 10~14px 就能放下；实在放不下时让底色跟着长高（宁可压到下一块的
 * 留白，也不要把句子截断 —— 截断的译文比排版不齐更糟）。
 */
(function () {
  'use strict';

  /** 会被译文覆盖的块类型（其余一律保留原图） */
  const TEXT_KINDS = new Set(['title', 'heading', 'body', 'caption', 'footnote', 'reference']);
  /** 图表 / 表格 / 公式：绝不覆盖，整块留在页面上（用户明确要求表格也原样保留） */
  const KEEP_KINDS = new Set(['figure', 'table', 'formula']);

  const MIN_FONT = 6;
  const MAX_FONT = 30;
  const PAGE_PAD = 20;      // 滚动容器左右留白（与 CSS 保持一致）
  const MAX_RENDERED = 5;   // 同时保留几页画布（多了内存吃不消）
  const DPR_BUDGET = 16e6;  // 单页画布像素预算，和主 PDF 视图同一口径

  const KIND_LABEL = {
    title: '大标题', heading: '小节标题', body: '正文', caption: '图题',
    footnote: '脚注', reference: '参考文献', figure: '图表', table: '表格', formula: '公式',
  };

  const state = {
    host: null,
    opts: {},
    blocks: [],
    byPage: new Map(),
    wraps: new Map(),       // page -> { wrap, layer, canvas, rendered, rendering }
    rendered: [],           // 已渲染页码（按渲染先后，回收最早的）
    scale: 1,
    refWidth: 612,
    activeId: null,
    observer: null,
    resizeObserver: null,
    destroyed: false,
    gen: 0,                 // 重建代数：重排 / 换文档时让旧的异步渲染结果失效
    seq: 0,                 // 渲染序号（仅用于排查）
    clickBound: false,
    pending: new Set(),     // 正在翻译的块 id
    errors: new Map(),      // id -> 错误信息
    docRetry: null,         // 等 pdf.js 文档就位的定时器
    docWait: 0,
  };

  function U() { return window.PdfReaderUtils; }
  function r2(n) { return Math.round(n * 100) / 100; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ==================== 几何 ====================

  /** 块 → 页面显示百分比（含旋转） */
  function blockPercent(b, size) {
    if (!b || !size?.w || !size?.h) return null;
    const rotation = Number(size.rotation) || 0;
    const raw = [b.x * size.w, b.y * size.h, (b.x + b.width) * size.w, (b.y + b.height) * size.h];
    const util = U();
    const disp = util ? util.getDisplaySize({ w: size.w, h: size.h }, rotation) : { w: size.w, h: size.h };
    const r = util ? util.toDisplayRect(raw, { w: size.w, h: size.h }, rotation) : { x1: raw[0], y1: raw[1], x2: raw[2], y2: raw[3] };
    if (!disp.w || !disp.h) return null;
    return {
      left: (r.x1 / disp.w) * 100,
      top: (r.y1 / disp.h) * 100,
      width: ((r.x2 - r.x1) / disp.w) * 100,
      height: ((r.y2 - r.y1) / disp.h) * 100,
    };
  }

  function pageSize(n) {
    const s = state.opts.pageSize?.(n);
    if (s?.w && s?.h) return { w: s.w, h: s.h, rotation: Number(s.rotation) || 0 };
    return { w: 612, h: 792, rotation: 0 };
  }

  /** 译文页的缩放：铺满容器宽度（每页各算各的，极少见的不等宽页也能贴边） */
  function computeScale(n = 1) {
    const host = state.host;
    const avail = Math.max(160, (host?.clientWidth || 0) - PAGE_PAD * 2 - 4);
    const size = pageSize(n);
    return clamp(avail / Math.max(1, size.w), 0.35, 2.6);
  }

  // ==================== 装配 ====================

  function mount(host, opts) {
    destroy();
    state.host = host;
    state.opts = opts || {};
    state.destroyed = false;
    if (!host) return;
    host.classList.add('ctp-scroll');
    host.innerHTML = '';

    if (!state.clickBound) {
      host.addEventListener('click', onClick, true);
      state.clickBound = true;
    }
    if (typeof ResizeObserver === 'function') {
      state.resizeObserver = new ResizeObserver(() => {
        if (state.destroyed || !state.blocks.length) return;
        const next = computeScale(1);
        if (Math.abs(next - state.scale) / state.scale > 0.02) refit();
      });
      state.resizeObserver.observe(host);
    }
  }

  function setBlocks(blocks) {
    state.blocks = Array.isArray(blocks) ? blocks.filter((b) => Number.isFinite(b?.page)) : [];
    state.byPage.clear();
    for (const b of state.blocks) {
      if (!state.byPage.has(b.page)) state.byPage.set(b.page, []);
      state.byPage.get(b.page).push(b);
    }
    for (const list of state.byPage.values()) list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    buildPages();
  }

  function pageCount() {
    const total = Number(state.opts.pageCount?.()) || 0;
    const maxBlockPage = state.blocks.reduce((m, b) => Math.max(m, b.page), 0);
    return Math.max(total, maxBlockPage);
  }

  /** 重建所有页面占位（缩放变化、换文档、数据换版都走这里） */
  function buildPages() {
    const host = state.host;
    if (!host) return;
    teardownObservers();
    const keepScroll = host.scrollTop;
    host.innerHTML = '';
    state.wraps.clear();
    state.rendered = [];
    state.gen += 1;
    const total = pageCount();
    if (!total) {
      host.innerHTML = '<div class="ctp-empty">还没有对照数据。<br />先点工具条上的「整篇翻译」，在弹出的面板里跑一次<b>版面识别</b>。</div>';
      return;
    }
    state.scale = computeScale(1);
    state.refWidth = pageSize(1).w;

    for (let n = 1; n <= total; n++) {
      const size = pageSize(n);
      // 每页各算各的缩放：论文里偶尔夹一张横向大表，用同一个比例会让它横向溢出
      const pageScale = computeScale(n);
      const wrap = document.createElement('div');
      wrap.className = 'ctp-page';
      wrap.dataset.page = String(n);
      wrap.style.width = Math.round(size.w * pageScale) + 'px';
      wrap.style.height = Math.round(size.h * pageScale) + 'px';
      const ph = document.createElement('div');
      ph.className = 'ctp-placeholder';
      ph.textContent = String(n);
      wrap.appendChild(ph);
      host.appendChild(wrap);
      state.wraps.set(n, { wrap, layer: null, canvas: null, rendered: false, rendering: false, scale: pageScale });
    }

    state.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const n = parseInt(en.target.dataset.page, 10);
        const rec = state.wraps.get(n);
        if (rec && !rec.rendered && !rec.rendering) renderPage(n);
      }
    }, { root: host, rootMargin: '600px 0px' });
    for (const rec of state.wraps.values()) state.observer.observe(rec.wrap);

    // 观察器之外再补一次：容器刚从 display:none 切回来、或外层刚换过宽度时，
    // IntersectionObserver 的首次回调可能不会来（元素一直「已经在视口里」），
    // 那样页面就永远停在占位符上。这里主动把视口内的页渲染掉。
    requestAnimationFrame(() => primeVisible());

    // 恢复滚动位置（重排前后用户读的还是同一段）
    host.scrollTop = keepScroll;
    const active = state.activeId && state.blocks.find((b) => b.id === state.activeId);
    if (active) requestAnimationFrame(() => focus(active.id, { flash: false }));
  }

  /** 主动渲染视口内（含上下各一屏）的页面 */
  function primeVisible() {
    if (state.destroyed || !state.host) return;
    // pdf.js 文档还没到手：这时候硬渲染只会白跑一遍，挂个定时器等它就位
    if (!state.opts.getDoc?.()) { scheduleDocRetry(); return; }
    const hr = state.host.getBoundingClientRect();
    if (!hr.height) return;
    for (const [n, rec] of state.wraps) {
      const r = rec.wrap.getBoundingClientRect();
      if (r.bottom < hr.top - 700 || r.top > hr.bottom + 700) continue;
      if (!rec.rendered && !rec.rendering) renderPage(n);
    }
  }

  /**
   * 等 pdf.js 文档就位后再铺页。
   *
   * 对照数据是本地 JSON，通常比 PDF 字节先到 —— 自动管线在文档还没解出来时就
   * setBlocks 了，那一轮的 primeVisible 必然空转。没有这个重试，页面就会一直
   * 停在页码占位符上（观察器也不会补刀：元素从头到尾都在视口里，没有「进入」事件）。
   */
  function scheduleDocRetry() {
    if (state.docRetry || state.destroyed) return;
    if (state.docWait++ > 40) return;   // ≈16s 还没下来，认为文档加载失败
    state.docRetry = setTimeout(() => {
      state.docRetry = null;
      if (state.destroyed || !state.host) return;
      if (!state.opts.getDoc?.()) { scheduleDocRetry(); return; }
      state.docWait = 0;
      buildPages();   // 文档到位：整页重铺一次，画布才有底图可画
    }, 400);
  }

  function teardownObservers() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    if (state.docRetry) { clearTimeout(state.docRetry); state.docRetry = null; }
    state.docWait = 0;
  }

  // ==================== 页面渲染 ====================

  async function renderPage(n) {
    const rec = state.wraps.get(n);
    const doc = state.opts.getDoc?.();
    // 排查用：提前 return 的原因要能看见，否则页面停在占位符上无从下手
    if (!rec) { state.lastBail = 'no-rec:' + n; return; }
    if (!doc) { state.lastBail = 'no-doc'; return; }
    if (rec.rendering) { state.lastBail = 'busy:' + n; return; }
    if (rec.rendered) { state.lastBail = 'done:' + n; return; }
    state.lastBail = 'start:' + n;
    rec.rendering = true;
    const gen = state.gen;
    state.seq += 1;
    try {
      const page = await doc.getPage(n);
      if (state.destroyed || state.gen !== gen || !state.wraps.has(n)) return;
      const viewport = page.getViewport({ scale: rec.scale || state.scale });
      const area = Math.max(1, viewport.width * viewport.height);
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(DPR_BUDGET / area)));

      const canvas = document.createElement('canvas');
      canvas.className = 'ctp-canvas';
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = Math.round(viewport.width) + 'px';
      canvas.style.height = Math.round(viewport.height) + 'px';
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise;
      if (state.destroyed || state.gen !== gen) return;

      const wrap = rec.wrap;
      wrap.innerHTML = '';
      wrap.appendChild(canvas);
      const layer = document.createElement('div');
      layer.className = 'ctp-layer';
      wrap.appendChild(layer);
      const badge = document.createElement('div');
      badge.className = 'ctp-page-no';
      badge.textContent = 'P' + n;
      wrap.appendChild(badge);

      rec.canvas = canvas;
      rec.layer = layer;
      rec.rendered = true;
      state.rendered.push(n);
      paintLayer(n);
      prunePages(n);
      if (state.activeId) setActive(state.activeId);
    } catch (e) {
      // 失败要留痕：否则页面永远停在占位符上，控制台却什么都没有
      state.lastError = String(e?.message || e);
      rec.rendering = false;
      return;
    } finally {
      rec.rendering = false;
    }
  }

  /** 画布回收：超出预算就把离当前页最远的几页退回占位符 */
  function prunePages(keepPage) {
    while (state.rendered.length > MAX_RENDERED) {
      let worst = null;
      let worstD = -1;
      for (const n of state.rendered) {
        if (n === keepPage) continue;
        const d = Math.abs(n - keepPage);
        if (d > worstD) { worstD = d; worst = n; }
      }
      if (worst == null) break;
      releasePage(worst);
    }
  }

  function releasePage(n) {
    const rec = state.wraps.get(n);
    if (!rec) return;
    rec.rendered = false;
    rec.canvas = null;
    rec.layer = null;
    rec.wrap.innerHTML = '';
    const ph = document.createElement('div');
    ph.className = 'ctp-placeholder';
    ph.textContent = String(n);
    rec.wrap.appendChild(ph);
    state.rendered = state.rendered.filter((x) => x !== n);
    if (state.observer) state.observer.observe(rec.wrap);
  }

  // ==================== 译文覆盖层 ====================

  function paintLayer(n) {
    const rec = state.wraps.get(n);
    if (!rec?.layer) return;
    rec.layer.innerHTML = '';
    const size = pageSize(n);
    const pageH = rec.wrap.clientHeight || 1;
    const items = [];
    for (const b of state.byPage.get(n) || []) {
      const p = blockPercent(b, size);
      if (p) items.push({ b, p, grow: 0 });
    }
    // 先算「每块往下还能长多高」，再铺块：译文比原文长时，长到不压下一块为止
    const merged = mergeOverlapping(items);
    for (const it of merged) it.grow = growRoom(it, merged, pageH);
    for (const it of merged) rec.layer.appendChild(buildBlockEl(it.b, it.p, it.grow));
  }

  /**
   * 把「互相盖住的文字块」并成一块。
   *
   * 版面识别在作者单位、脚注、DOI 这类小字上常切出几块互相重叠的碎块（实测
   * 一页作者单位有 3 块彼此覆盖 40% 以上）。各填各的译文 = 两行字叠在一起，
   * 谁也读不了。并成并集矩形、译文按阅读顺序拼起来，至少是连续可读的一段。
   *
   * 只并「本身要被译文覆盖」的块：图 / 表 / 公式不参与，否则中文会盖到图上。
   */
  function mergeOverlapping(items) {
    const n = items.length;
    const parent = items.map((_, i) => i);
    const find = (i) => { let r = i; while (parent[r] !== r) r = parent[r]; let c = i; while (parent[c] !== c) { const nx = parent[c]; parent[c] = r; c = nx; } return r; };
    const eligible = (it) => !isKeepBlock(it.b) && !!translationOf(it.b);
    for (let i = 0; i < n; i++) {
      if (!eligible(items[i])) continue;
      for (let j = i + 1; j < n; j++) {
        if (!eligible(items[j])) continue;
        if (overlapRatio(items[i].p, items[j].p) > 0.35) parent[find(j)] = find(i);
      }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(items[i]);
    }
    const out = [];
    for (const list of groups.values()) {
      if (list.length === 1) { out.push(list[0]); continue; }
      // 按阅读顺序（上→下、左→右）拼译文
      const sorted = [...list].sort((a, b) => (a.p.top - b.p.top) || (a.p.left - b.p.left));
      const left = Math.min(...list.map((x) => x.p.left));
      const top = Math.min(...list.map((x) => x.p.top));
      const right = Math.max(...list.map((x) => x.p.left + x.p.width));
      const bottom = Math.max(...list.map((x) => x.p.top + x.p.height));
      const head = sorted[0].b;
      const seen = new Set();
      const parts = [];
      for (const x of sorted) {
        const t = translationOf(x.b);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        parts.push(t);
      }
      out.push({
        b: { ...head, translation: parts.join(' '), mergedIds: sorted.map((x) => x.b.id) },
        p: { left, top, width: right - left, height: bottom - top },
        grow: 0,
      });
    }
    return out;
  }

  /** 交集面积占「较小心块」的比例（0~1） */
  function overlapRatio(a, b) {
    const l = Math.max(a.left, b.left);
    const t = Math.max(a.top, b.top);
    const r = Math.min(a.left + a.width, b.left + b.width);
    const bo = Math.min(a.top + a.height, b.top + b.height);
    if (r <= l || bo <= t) return 0;
    const inter = (r - l) * (bo - t);
    const small = Math.min(a.width * a.height, b.width * b.height) || 1;
    return inter / small;
  }

  /**
   * 一块文字往下还能长多少像素，才不压到下一块。
   *
   * 只把「水平方向与它交叠、且起笔在它下方」的块算作邻居 —— 双栏里右栏的块
   * 与左栏同高是常事，不问水平位置会算出 0 的生长空间。
   */
  function growRoom(it, items, pageH) {
    const p = it.p;
    const bottom = p.top + p.height;
    const left = p.left;
    const right = p.left + p.width;
    let limit = 100;   // 页面底边
    for (const o of items) {
      if (o === it) continue;
      const ob = o.p.top;
      if (ob < bottom - 0.4) continue;                                        // 在上方 / 同一行
      if (o.p.left + o.p.width <= left + 0.4 || o.p.left >= right - 0.4) continue;  // 不同栏
      if (ob < limit) limit = ob;
    }
    const gap = 0.8;   // 留 0.8% 页高当行距，免得两段贴在一起
    return Math.max(0, ((limit - bottom - gap) / 100) * pageH);
  }

  function isKeepBlock(b) {
    return KEEP_KINDS.has(b.kind) || b.translatable === false;
  }

  function translationOf(b) {
    return String(b.translation || '').trim();
  }

  function buildBlockEl(b, p, grow = 0) {
    const el = document.createElement('div');
    el.className = 'ctp-block';
    el.dataset.id = String(b.id);
    el.dataset.kind = String(b.kind || 'body');
    el.style.left = r2(p.left) + '%';
    el.style.top = r2(p.top) + '%';
    el.style.width = r2(p.width) + '%';
    el.style.height = r2(p.height) + '%';

    const keep = isKeepBlock(b);
    const tr = translationOf(b);
    const label = KIND_LABEL[b.kind] || b.label || '区域';
    el.dataset.label = label;
    // 合并块：id 取第一块的，其余记在 data-merge 里，选中任一块都能找到这个元素
    if (b.mergedIds?.length > 1) el.dataset.merge = b.mergedIds.join(' ');

    if (keep) {
      // 图表 / 表格 / 公式：不遮不翻，只留一层可点区域（原来那张图就在底下）
      el.classList.add('ctp-keep');
      return el;
    }
    if (!b.translatable) return el;

    if (tr) {
      el.classList.add('ctp-filled');
      const text = document.createElement('div');
      text.className = 'ctp-text';
      text.textContent = tr;
      el.appendChild(text);
      // 先挂到文档里再量尺寸：脱离文档的节点 scrollHeight 恒为 0
      fitWhenMounted(el, text, grow);
    } else if (state.pending.has(b.id)) {
      el.classList.add('ctp-pending');
      el.innerHTML = '<span class="ctp-spin"></span>';
    } else if (state.errors.has(b.id)) {
      el.classList.add('ctp-error');
      el.title = state.errors.get(b.id);
    } else {
      el.classList.add('ctp-missing');
      el.title = '点一下翻译这一段';
    }
    return el;
  }

  /**
   * 文字要挂进真实布局才量得准，所以推迟到下一帧再二分字号。
   * 用 requestAnimationFrame 而不是同步量：一次铺 30 个块同步二分会把主线程卡住。
   */
  function fitWhenMounted(el, textEl, grow = 0) {
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      fitText(el, textEl, grow);
    });
  }

  function fitText(el, textEl, grow = 0) {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const kind = el.dataset.kind;
    const padX = w < 60 ? 2 : 4;
    const padY = h < 18 ? 1 : 2;
    textEl.style.width = Math.max(8, w - padX * 2) + 'px';
    textEl.style.padding = padY + 'px ' + padX + 'px';
    el.style.padding = '0';

    const isHeading = kind === 'title' || kind === 'heading';
    const family = isHeading
      ? "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif"
      : "'Songti SC','Source Han Serif SC','Noto Serif CJK SC',SimSun,serif";
    textEl.style.fontFamily = family;
    textEl.style.fontWeight = isHeading ? '700' : '400';
    textEl.style.lineHeight = isHeading ? '1.26' : '1.32';
    textEl.style.textAlign = kind === 'title' ? 'center' : 'justify';

    const cap = clamp(h, MIN_FONT, MAX_FONT);
    let lo = MIN_FONT;
    let hi = cap;
    textEl.style.fontSize = hi + 'px';
    if (textEl.scrollHeight <= h + 0.5 && textEl.scrollWidth <= w + 0.5) {
      el.style.height = 'auto';
      el.style.minHeight = h + 'px';
      return;
    }

    // 短标题不折行：标题折成两半（"ARTICLE INF / O"）比缩一号字难看得多，
    // 所以宁可把字号压到放得下宽度为止。
    const short = (textEl.textContent || '').trim().length <= 16;
    if (isHeading && short) {
      textEl.style.whiteSpace = 'nowrap';
      let fs = cap;
      textEl.style.fontSize = fs + 'px';
      let guard = 0;
      while (fs > 5 && textEl.scrollWidth > w - padX * 2 && guard++ < 60) {
        fs -= 0.5;
        textEl.style.fontSize = fs + 'px';
      }
      if (textEl.scrollHeight <= h + 0.5) {
        el.style.height = 'auto';
        el.style.minHeight = h + 'px';
        return;
      }
    }

    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      textEl.style.fontSize = mid + 'px';
      if (textEl.scrollHeight <= h + 0.5) lo = mid; else hi = mid;
    }
    textEl.style.fontSize = lo.toFixed(2) + 'px';

    // 最小字号还放不下：白底往下长 —— 但只长到「下一块的上沿」，不压别人的字。
    // 长到头仍然放不下才截断（加 … 角标，悬停看全文）——文字互相叠着最难读。
    if (textEl.scrollHeight > h + 0.5) {
      const need = textEl.scrollHeight + 1;
      const target = Math.min(need, h + Math.max(0, grow));
      el.style.height = 'auto';
      el.style.minHeight = h + 'px';
      el.style.maxHeight = target + 'px';
      el.style.overflow = 'hidden';
      if (need > target + 1) {
        el.classList.add('ctp-clip');
        el.title = textEl.textContent || '';
      } else {
        el.classList.add('ctp-grown');
      }
    }
  }

  /** 单块重绘（按需翻译完成后只动这一块，不重铺整页） */
  function refreshBlock(id) {
    const b = state.blocks.find((x) => x.id === id);
    if (!b) return;
    const rec = state.wraps.get(b.page);
    if (!rec?.layer) return;
    // 这一块被并进了合并块：成员变了就得整页重铺（一页二十来块，重铺代价可接受）
    if (rec.layer.querySelector(`.ctp-block[data-merge~="${CSS.escape(String(id))}"]`)) {
      paintLayer(b.page);
      if (state.activeId) setActive(state.activeId);
      return;
    }
    const old = rec.layer.querySelector(`.ctp-block[data-id="${CSS.escape(String(id))}"]`);
    const p = blockPercent(b, pageSize(b.page));
    if (!p) return;
    // 生长预算要按当前页的邻居重算（这一块的身份变了，能长的空间也可能变）
    const items = [];
    for (const x of state.byPage.get(b.page) || []) {
      const px = x.id === id ? p : blockPercent(x, pageSize(b.page));
      if (px) items.push({ id: x.id, p: px });
    }
    const self = items.find((x) => x.id === id);
    const grow = self ? growRoom(self, items, rec.wrap.clientHeight || 1) : 0;
    const el = buildBlockEl(b, p, grow);
    if (old) old.replaceWith(el); else rec.layer.appendChild(el);
    if (state.activeId === id) el.classList.add('active');
  }

  function setPending(id, on) {
    if (on) state.pending.add(id); else state.pending.delete(id);
    state.errors.delete(id);
    refreshBlock(id);
  }

  function setError(id, message) {
    state.pending.delete(id);
    state.errors.set(id, String(message || '翻译失败'));
    refreshBlock(id);
  }

  // ==================== 选中 / 定位 ====================

  /**
   * 按块 id 找元素。
   *
   * 合并块（见 mergeOverlapping）的 id 只记第一块，其余 id 在 data-merge 里 ——
   * 用 [data-merge~="id"] 才能让「点原文的第 3 个作者单位块」也落到这个元素上。
   */
  function elOf(id) {
    const host = state.host;
    if (!host || id == null) return null;
    const esc = CSS.escape(String(id));
    return host.querySelector(`.ctp-block[data-id="${esc}"]`)
      || host.querySelector(`.ctp-block[data-merge~="${esc}"]`);
  }

  function setActive(id) {
    state.activeId = id || null;
    const host = state.host;
    if (!host) return;
    host.querySelectorAll('.ctp-block.active').forEach((el) => el.classList.remove('active'));
    if (!id) return;
    elOf(id)?.classList.add('active');
  }

  function focus(id, { flash = true } = {}) {
    const host = state.host;
    if (!host) return;
    const b = state.blocks.find((x) => x.id === id);
    if (!b) return;
    const el = elOf(id);
    if (!el) {
      // 目标页还没渲染：先把那一页滚进视野，渲染完自然会画出来
      const wrap = state.wraps.get(b.page)?.wrap;
      if (wrap) wrap.scrollIntoView({ block: 'center' });
      return;
    }
    const hr = host.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const fullyVisible = er.top >= hr.top + 12 && er.bottom <= hr.bottom - 12;
    if (!fullyVisible) {
      host.scrollTop += (er.top - hr.top) - Math.max(24, hr.height * 0.28);
    }
    if (!flash) return;
    el.classList.remove('ctp-flash');
    void el.offsetWidth;
    el.classList.add('ctp-flash');
    setTimeout(() => el.classList.remove('ctp-flash'), 900);
  }

  function onClick(event) {
    if (window.getSelection()?.toString().trim()) return;
    const el = event.target.closest('.ctp-block');
    if (!el) return;
    const id = el.dataset.id;
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    const b = state.blocks.find((x) => x.id === id);
    const missing = b && b.translatable && !isKeepBlock(b) && !translationOf(b);
    state.opts.onPick?.(id, { needTranslate: !!missing });
  }

  /** 从已渲染的画布上裁出某一块（没有画布时返回 null，调用方退回 assets 裁图） */
  function capture(id) {
    const b = state.blocks.find((x) => x.id === id);
    if (!b) return null;
    const rec = state.wraps.get(b.page);
    const canvas = rec?.canvas;
    if (!canvas) return null;
    const p = blockPercent(b, pageSize(b.page));
    if (!p) return null;
    const sx = Math.max(0, (p.left / 100) * canvas.width - 2);
    const sy = Math.max(0, (p.top / 100) * canvas.height - 2);
    const sw = Math.min(canvas.width - sx, (p.width / 100) * canvas.width + 4);
    const sh = Math.min(canvas.height - sy, (p.height / 100) * canvas.height + 4);
    if (sw < 4 || sh < 4) return null;
    const out = document.createElement('canvas');
    out.width = Math.round(sw);
    out.height = Math.round(sh);
    out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    try { return out.toDataURL('image/jpeg', 0.9); } catch (_) { return null; }
  }

  function refit() {
    if (!state.host || !state.blocks.length) return;
    buildPages();
  }

  function destroy() {
    state.destroyed = true;
    teardownObservers();
    if (state.resizeObserver) { try { state.resizeObserver.disconnect(); } catch (_) { /* ignore */ } state.resizeObserver = null; }
    if (state.host) state.host.innerHTML = '';
    state.host = null;
    state.blocks = [];
    state.byPage.clear();
    state.wraps.clear();
    state.rendered = [];
    state.pending.clear();
    state.errors.clear();
    state.activeId = null;
  }

  window.CmpPages = {
    mount,
    setBlocks,
    setActive,
    focus,
    refreshBlock,
    setPending,
    setError,
    capture,
    refit,
    destroy,
    /** 排查用：不暴露大对象 */
    debug: () => ({
      pages: state.wraps.size,
      rendered: [...state.rendered],
      blocks: state.blocks.length,
      scale: state.scale,
      activeId: state.activeId,
      hasDoc: !!state.opts.getDoc?.(),
      pageCount: state.opts.pageCount?.(),
      hostH: state.host?.getBoundingClientRect?.().height || 0,
      lastError: state.lastError || null,
      lastBail: state.lastBail || null,
    }),
  };
})();
