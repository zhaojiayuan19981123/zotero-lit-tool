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
 * ============================ 字体与字号（用户明确要求「统一」） ============================
 *
 * 字体只有一套：西文 Times New Roman、中文宋体。写法就是把 Times New Roman 放
 * 最前面 —— 它没有汉字字形，浏览器逐个字符回退，于是拉丁字母落在 TNR、汉字落到
 * 宋体（macOS 上退到 Songti SC），标题与正文共用同一族，不再出现「标题黑体、正文
 * 宋体」的割裂感。
 *
 * 字号也**不再一块一个值**：先量出本页每块「不改框时能放下的最大字号」，取 60%
 * 分位作为本页基准（base），全页正文统一用这个字。放不下的块依次走
 * 「长高（不压下一块）→ 缩号（最后手段）→ 截断」，所以少数超长段落会比别处小
 * 半号到一号字，但绝大多数文字是同一个尺寸 —— 这正是「统一」要的效果。
 */
(function () {
  'use strict';

  /** 会被译文覆盖的块类型（其余一律保留原图） */
  const TEXT_KINDS = new Set(['title', 'heading', 'body', 'caption', 'footnote', 'reference']);
  /** 图表 / 表格 / 公式：绝不覆盖，整块留在页面上（用户明确要求表格也原样保留） */
  const KEEP_KINDS = new Set(['figure', 'table', 'formula']);

  const MIN_FONT = 6;
  const MAX_FONT = 30;
  /** 本页统一字号的可读区间。下限就是本页原文字号附近：版面还原的译文不该比原文更小 */
  const BASE_LO = 7;
  const BASE_HI = 14;
  /**
   * 唯一一套字体：西文 Times New Roman + 中文宋体。
   *
   * Times New Roman 不含汉字，浏览器按字符回退 —— 字母落在 TNR，汉字落到 SimSun；
   * macOS 上 SimSun 不存在，继续退到 Songti SC。顺序不能颠倒：SimSun 自己带拉丁
   * 字形，放前面会让英文也变成宋体那副瘦硬的样子。
   */
  const SERIF = "'Times New Roman',SimSun,'Songti SC','Noto Serif CJK SC','Source Han Serif SC',serif";
  const PAGE_PAD = 20;      // 滚动容器左右留白（与 CSS 保持一致）
  const MAX_RENDERED = 5;   // 同时保留几页画布（多了内存吃不消）
  const DPR_BUDGET = 16e6;  // 单页画布像素预算，和主 PDF 视图同一口径
  const ZOOM_LO = 0.5;
  const ZOOM_HI = 3;

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
    zoom: 1,                // 用户缩放倍数（适应宽度 = 1）
    zoomTimer: 0,           // 滚轮缩放的防抖句柄
    base: new Map(),        // page -> 本页统一字号
    wheelBound: false,
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

  /** 译文页的缩放：铺满容器宽度（每页各算各的，极少见的不等宽页也能贴边），再乘用户缩放 */
  function computeScale(n = 1) {
    const host = state.host;
    const avail = Math.max(160, (host?.clientWidth || 0) - PAGE_PAD * 2 - 4);
    const size = pageSize(n);
    return clamp((avail / Math.max(1, size.w)) * state.zoom, 0.2, 4);
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
    if (!state.wheelBound) {
      // Ctrl / ⌘ + 滚轮（触控板捏合在 Chromium 里也带 ctrlKey）缩放译文页。
      // passive:false 才能 preventDefault 掉「整个应用被缩放」的默认行为。
      host.addEventListener('wheel', onWheel, { passive: false });
      state.wheelBound = true;
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

  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const step = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    setZoom(state.zoom * step);
  }

  /**
   * 设置缩放。
   *
   * 重铺整页要重建十几个占位节点，60Hz 的滚轮连发会把主线程打满，所以：
   * 百分比立刻更新（用户看得见反馈），真正的重排防抖 90ms 一次。
   */
  function setZoom(z) {
    const next = clamp(Number(z) || 1, ZOOM_LO, ZOOM_HI);
    if (Math.abs(next - state.zoom) < 0.001) return;
    state.zoom = next;
    state.opts.onZoom?.(next);
    if (state.zoomTimer) clearTimeout(state.zoomTimer);
    state.zoomTimer = setTimeout(() => {
      state.zoomTimer = 0;
      refit();
    }, 90);
  }

  function getZoom() { return state.zoom; }

  /** 回到「适应宽度」 */
  function fitWidth() {
    if (Math.abs(state.zoom - 1) < 0.001) return;
    state.zoom = 1;
    state.opts.onZoom?.(1);
    if (state.zoomTimer) { clearTimeout(state.zoomTimer); state.zoomTimer = 0; }
    refit();
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
  function buildPages(view = null) {
    const host = state.host;
    if (!host) return;
    teardownObservers();
    // 重铺后页面高度会变（缩放 / 换数据）。记住了「滚动比例 + 选中块在屏幕上的位置」，
    // 铺完再还原 —— 否则缩一次就跳回页首，读长文献时很打断。
    const ratio = view?.ratio ?? (host.scrollTop / Math.max(1, host.scrollHeight));
    const anchor = view?.anchor || null;
    host.innerHTML = '';
    state.wraps.clear();
    state.rendered = [];
    state.base.clear();
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

    // 恢复阅读位置：有选中块就跟着块走（缩放在读的那一段不会跑掉），否则按比例
    restoreScroll(ratio, anchor);
    const active = state.activeId && state.blocks.find((b) => b.id === state.activeId);
    if (active) requestAnimationFrame(() => focus(active.id, { flash: false }));
  }

  /**
   * 恢复阅读位置。
   *
   * 有锚点块时按**几何**还原（块所在的页 + 页内纵向百分比），不依赖该块已渲染 ——
   * 缩放那一刻目标页往往还没画出来，等它画好再对齐就晚了（用户已经看到跳了一下）。
   */
  function restoreScroll(ratio, anchor) {
    const host = state.host;
    if (!host) return;
    if (anchor) {
      const b = state.blocks.find((x) => x.id === anchor.id);
      const rec = b ? state.wraps.get(b.page) : null;
      const p = b ? blockPercent(b, pageSize(b.page)) : null;
      if (rec && p) {
        const wrapTop = (rec.wrap.getBoundingClientRect().top - host.getBoundingClientRect().top) + host.scrollTop;
        host.scrollTop = Math.max(0, wrapTop + (p.top / 100) * rec.wrap.clientHeight - anchor.offset);
        return;
      }
    }
    host.scrollTop = ratio * Math.max(0, host.scrollHeight - host.clientHeight);
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
    const jobs = [];
    for (const it of merged) {
      const el = buildBlockEl(it.b, it.p, it.grow);
      rec.layer.appendChild(el);
      const textEl = el.querySelector('.ctp-text');
      if (textEl) jobs.push({ el, textEl, grow: it.grow, kind: it.b.kind || 'body' });
    }
    if (jobs.length) fitPage(n, jobs);
  }

  /**
   * 一页一次排版：先量完所有块，定下一个统一的基准字号，再统一落笔。
   *
   * 分两遍是必须的 —— 只有量完本页全部块，才知道「基准」该定多大。逐块各算各的
   * 正是用户看到「同一页里有大字有小字」的原因。
   */
  function fitPage(n, jobs) {
    const usable = [];
    for (const j of jobs) {
      if (!prepText(j.el, j.textEl)) continue;
      j.max = maxFit(j.textEl, j.el.clientHeight);
      j.len = (j.textEl.textContent || '').length;
      usable.push(j);
    }
    const base = pickBase(usable);
    state.base.set(n, base);
    for (const j of usable) applySize(j, base);
  }

  /**
   * 本页统一字号 = 各块「能放下的最大字号」的**按字数加权**中位数。
   *
   * 两个要点：
   *   · 加权：一页里十几个小字块（作者单位、脚注、页码行）字少，一个长正文块字多；
   *     不按字数加权的话，小字块的极值会把整页基准拖到最低那档。
   *   · 取中位数而不是最小值：最小值意味着「一个超长脚注决定全页」，那正是把字号
   *     压到 6px 的原因。中位数下仍有一半的文字要降档，所以还要靠「先长高」兜住。
   */
  function pickBase(jobs) {
    const items = jobs
      .filter((j) => Number.isFinite(j.max) && j.max > 0)
      .map((j) => ({ max: j.max, w: Math.max(1, Math.min(400, j.len || 1)) }))
      .sort((a, b) => a.max - b.max);
    if (!items.length) return clamp(11, BASE_LO, BASE_HI);
    const total = items.reduce((s, x) => s + x.w, 0);
    let acc = 0;
    let pick = items[items.length - 1].max;
    for (const it of items) {
      acc += it.w;
      if (acc >= total * 0.5) { pick = it.max; break; }
    }
    return Math.round(clamp(pick, BASE_LO, BASE_HI) * 2) / 2;   // 取到 0.5px 档
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
      // 字号由 paintLayer / refreshBlock 统一给（这里还不知道本页基准是多少）
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

  /** 落笔前的公共样式：宽度 / 内边距 / 字体族 / 行高 / 对齐。返回 false = 还没进布局，量不了 */
  function prepText(el, textEl) {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return false;
    const kind = el.dataset.kind;
    const isTitle = kind === 'title';
    const isHeading = isTitle || kind === 'heading';
    const padX = w < 60 ? 2 : 4;
    const padY = h < 18 ? 1 : 2;
    textEl.style.width = Math.max(8, w - padX * 2) + 'px';
    textEl.style.padding = padY + 'px ' + padX + 'px';
    textEl.style.boxSizing = 'border-box';
    el.style.padding = '0';
    textEl.style.fontFamily = SERIF;
    textEl.style.fontWeight = isHeading ? '700' : '400';
    textEl.style.lineHeight = isTitle ? '1.4' : isHeading ? '1.35' : '1.55';
    textEl.style.textAlign = isTitle ? 'center' : 'justify';
    // 中文按字断行本来就没问题；关掉连字符与「单词中间断行」能让英文缩写在块里不被拆开
    textEl.style.hyphens = 'none';
    textEl.style.wordBreak = 'normal';
    textEl.style.overflowWrap = 'break-word';
    return true;
  }

  /** 在不改动块高度的前提下，能完整放下的最大字号 */
  function maxFit(textEl, h) {
    const ceil = Math.min(MAX_FONT, Math.max(MIN_FONT, h));
    textEl.style.fontSize = ceil + 'px';
    if (textEl.scrollHeight <= h + 0.5) return ceil;
    let lo = MIN_FONT;
    let hi = ceil;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) / 2;
      textEl.style.fontSize = mid + 'px';
      if (textEl.scrollHeight <= h + 0.5) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * 按本页基准字号落笔。
   *
   * 字号只允许三档：base、base-0.5、base-1（只在放不下时往下走）。为什么不「每块算到
   * 刚好放得下」：那样实测一页会出现 6 / 6.25 / 6.69 / 6.75 / 7.5 五种字，肉眼就是
   * 「排版乱、字号不统一」。0.5px 一档的差别几乎看不出，超过两档才会被察觉。
   *
   * 顺序是「先长高、后降档」：长高只多吃一点行间留白，降档会破坏字号统一。
   */
  function applySize(j, base) {
    const isTitle = j.kind === 'title';
    const isHeading = isTitle || j.kind === 'heading';
    const want = isTitle ? base * 1.35 : isHeading ? base * 1.15 : base;
    const h = Math.round(j.el.clientHeight || 0);
    const room = Math.round(Math.max(0, j.grow || 0));
    const target = h + room;

    let fs = Math.round(want * 2) / 2;
    if (fs < MIN_FONT) fs = MIN_FONT;

    // 标题不做「先按原框缩号」的预判：原框是给英文排的一行高，中文标题哪怕同字号
    // 也常常高出一两像素，先缩号会让标题比正文还小。交给下面的 target（含可长高度）
    // 判断就够了 —— target 的上沿就是下一块的位置，不会压到正文。

    for (let step = 0; step < 3; step++) {
      const size = Math.max(MIN_FONT, Math.round((fs - step * 0.5) * 2) / 2);
      j.textEl.style.fontSize = size + 'px';
      if (j.textEl.scrollHeight <= target + 0.5) {
        growTo(j, h, Math.min(target, Math.ceil(j.textEl.scrollHeight) + 1));
        j.el.classList.remove('ctp-clip');
        j.el.removeAttribute('title');
        return;
      }
      if (size <= MIN_FONT) break;
    }
    // 三档都放不下：最低那档 + 长到上限 + 截断（悬停看全文）
    j.textEl.style.fontSize = Math.max(MIN_FONT, Math.round((fs - 1) * 2) / 2) + 'px';
    growTo(j, h, target);
    j.el.classList.add('ctp-clip');
    j.el.title = j.textEl.textContent || '';
  }

  /** 让白底长到 need 高（不超过 h 就保持原样） */
  function growTo(j, h, need) {
    if (need <= h + 0.5) { j.el.classList.remove('ctp-grown'); return; }
    j.el.style.height = 'auto';
    j.el.style.minHeight = h + 'px';
    j.el.style.maxHeight = Math.round(need) + 'px';
    j.el.classList.add('ctp-grown');
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
    // 单块重排只是换个内容，字号要沿用本页基准 —— 否则这一块会突然比邻居大/小
    const textEl = el.querySelector('.ctp-text');
    if (textEl && prepText(el, textEl)) {
      const job = { el, textEl, grow, kind: b.kind || 'body' };
      job.max = maxFit(textEl, el.clientHeight);
      job.len = (textEl.textContent || '').length;
      // 本页基准还没算过（例如单块刷新发生在整页铺之前）就先按这一块定一个
      const base = state.base.get(b.page) || pickBase([job]);
      state.base.set(b.page, base);
      applySize(job, base);
    }
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

  /**
   * 按当前宽度（× 缩放）重铺。缩放时以「选中的那一块」为锚点，读到的位置不会跳走。
   */
  function refit() {
    const host = state.host;
    if (!host || !state.blocks.length) return;
    // 栏被藏起来时（切到「文本重排」/「仅原文」）宽度是 0，这时候铺出来的页面
    // 只有 0.2 倍缩放，白算一遍；等它重新显示时 bindCmpStyle 会再叫一次。
    if (!host.clientHeight || !host.clientWidth) return;
    let anchor = null;
    if (state.activeId) {
      const el = elOf(state.activeId);
      if (el) anchor = { id: state.activeId, offset: el.getBoundingClientRect().top - host.getBoundingClientRect().top };
    }
    buildPages({ anchor, ratio: host.scrollTop / Math.max(1, host.scrollHeight) });
  }

  function destroy() {
    state.destroyed = true;
    teardownObservers();
    if (state.zoomTimer) { clearTimeout(state.zoomTimer); state.zoomTimer = 0; }
    if (state.resizeObserver) { try { state.resizeObserver.disconnect(); } catch (_) { /* ignore */ } state.resizeObserver = null; }
    if (state.host) state.host.innerHTML = '';
    state.host = null;
    state.blocks = [];
    state.byPage.clear();
    state.wraps.clear();
    state.rendered = [];
    state.base.clear();
    state.pending.clear();
    state.errors.clear();
    state.activeId = null;
    state.zoom = 1;
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
    setZoom,
    getZoom,
    fitWidth,
    destroy,
    /** 排查用：不暴露大对象 */
    debug: () => ({
      pages: state.wraps.size,
      rendered: [...state.rendered],
      blocks: state.blocks.length,
      scale: state.scale,
      zoom: state.zoom,
      base: [...state.base.entries()],
      activeId: state.activeId,
      hasDoc: !!state.opts.getDoc?.(),
      pageCount: state.opts.pageCount?.(),
      hostH: state.host?.getBoundingClientRect?.().height || 0,
      lastError: state.lastError || null,
      lastBail: state.lastBail || null,
    }),
  };
})();
