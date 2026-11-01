/**
 * reader-mode.js —— 阅读模式（Reading Mode）重排视图
 *
 * 这个模块只做一件事：把后端 `src/readingMode.js` 产出的结构树渲染成普通 HTML 文本流，
 * 并把「重排视图里的字符区间」和「原始 PDF 里的矩形」互相翻译。
 *
 * 为什么正文文字要在前端重新拼，而不是直接用后端给的 text：
 * 标注要精确到字，就必须知道「第 N 个字符落在哪一行、哪一个片段、片段里第几个字」。
 * 后端只给「行 + 片段（x / w / 文本）」，由这里按统一规则拼成文本，同时记下每个字符
 * 的来源；于是「字符 ↔ 原始坐标」是一条可以双向查的表，而不是事后猜出来的近似值。
 * 这套东西对应 Zotero 的 anchor.textMap —— 只是它逐字符存，我们按片段存、片段内线性插值，
 * 数据量小一个数量级，误差在 1~2px。
 *
 * 坐标系约定（最容易踩坑的地方）：
 *   · 结构树里的几何全部是 **PDF 用户空间**：原点在左下，y 向上，单位 pt。
 *   · 批注（annotations）里存的是 **自上而下** 的坐标：y1 是上边、y2 是下边。
 *     两套坐标差一个 pageHeight 的翻转，转换集中在 toTopDown / toUpward 两个函数里。
 */
(function () {
  'use strict';

  const FONT_STACKS = {
    serif: "Georgia, 'Times New Roman', 'Songti SC', 'Source Han Serif SC', SimSun, serif",
    sans: "-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
  };

  /** 排版默认值；用户可以改，改完写 localStorage */
  const DEFAULT_TYPO = { font: 'auto', size: 18, lineHeight: 1.75, width: 720 };

  const state = {
    doc: null,
    host: null,          // #rmScroll
    column: null,        // 正文列容器
    hooks: {},           // 由 app.js 注入
    typo: { ...DEFAULT_TYPO },
    blocks: [],          // 已装配（含 _text / _runs / 映射表）的块
    byId: new Map(),
    blockByEl: new WeakMap(),
    cropObserver: null,
    cropDone: new Set(),
    scrollRaf: 0,
    page: 1,
    noteSeq: 0,
  };

  function $(id) { return document.getElementById(id); }

  // ==================== 文本装配（含逐字符坐标表）====================

  const CJK_EDGE = /[\u3000-\u9fff\uff00-\uffef]/;

  /**
   * 把一块的「行 + 片段」拼成文本，并记录每个字符来自哪个片段。
   *
   * 拼接规则必须与排版观感一致：
   *   · 片段之间横向间隙超过 0.22em → 补一个空格（pdf.js 常把单词拆成多段）
   *   · 行尾英文连字符 + 下一行小写开头 → 去掉连字符直接接上（跨行断词）
   *   · 两端有中日韩字符 → 不补空格；其余情况补一个空格
   * 插入的分隔符在映射表里记为 runIdx = -1，求矩形时直接跳过。
   */
  function assemble(block) {
    const runs = [];
    let text = '';
    const runOf = [];
    const idxOf = [];
    const lineOf = [];
    const lines = block.lines || [];

    const push = (ch, ri, ci, li) => {
      text += ch;
      runOf.push(ri);
      idxOf.push(ci);
      lineOf.push(li);
    };
    const pushSep = (li) => {
      text += ' ';
      runOf.push(-1);
      idxOf.push(0);
      lineOf.push(li);
    };

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const size = Number(line.s) || Number(block.size) || 10;
      let prevEnd = null;
      for (const [x, w, str] of line.runs || []) {
        const s = String(str || '');
        if (!s) continue;
        if (prevEnd !== null) {
          const gap = Number(x) - prevEnd;
          if (gap > size * 0.22 && !/\s$/.test(text) && !/^\s/.test(s)) pushSep(li);
        }
        const ri = runs.length;
        runs.push({ x: Number(x) || 0, w: Number(w) || 0, len: s.length, line: li });
        for (let i = 0; i < s.length; i++) push(s[i], ri, i, li);
        prevEnd = Number(x) + (Number(w) || 0);
      }
      if (li === lines.length - 1) continue;
      const next = lines[li + 1];
      const nextFirst = next?.runs?.[0]?.[2]?.[0] || '';
      const lastCh = text.slice(-1);
      if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(nextFirst)) {
        // 行尾断词：删掉连字符（映射表同步弹出）
        text = text.slice(0, -1);
        runOf.pop(); idxOf.pop(); lineOf.pop();
        continue;
      }
      if (CJK_EDGE.test(lastCh) || CJK_EDGE.test(nextFirst)) continue;
      pushSep(li);
    }

    block._text = text;
    block._runs = runs;
    block._runOf = Int32Array.from(runOf);
    block._idxOf = Int32Array.from(idxOf);
    block._lineOf = Int32Array.from(lineOf);
    return block;
  }

  /** 第 i 个字符在原始 PDF 上的横向区间（pt）+ 所属行 */
  function charBox(block, i) {
    const ri = block._runOf[i];
    if (ri < 0) return null;
    const run = block._runs[ri];
    const ci = block._idxOf[i];
    const width = run.len ? run.w / run.len : 0;
    return { x1: run.x + width * ci, x2: run.x + width * (ci + 1), line: run.line };
  }

  // ==================== 坐标翻转 ====================

  function pageHeight(pageNum) {
    const size = state.hooks.pageSize?.(pageNum);
    return size?.h || 0;
  }

  /** 结构树的「y 向上」→ 批注的「y 向下」 */
  function toTopDown(pageNum, yUp) {
    const h = pageHeight(pageNum);
    return h ? h - yUp : yUp;
  }

  // ==================== 渲染 ====================

  function blockElement(block) {
    if (block.t === 'crop') return cropElement(block);
    const level = block.level | 0;
    let tag = 'p';
    if (level === 1) tag = 'h1';
    else if (level >= 2) tag = 'h' + Math.min(5, level);
    const el = document.createElement(tag);
    el.className = 'rm-block';
    el.dataset.id = block.id;
    el.dataset.kind = block.kind || 'body';
    if (block.align === 'center') el.classList.add('rm-center');
    if (block.bold) el.classList.add('rm-bold');
    if (block.kind === 'reference') el.classList.add('rm-ref');
    fillText(el, block);
    return el;
  }

  function cropElement(block) {
    const fig = document.createElement('figure');
    fig.className = 'rm-crop rm-crop-' + (block.k || 'figure');
    fig.dataset.id = block.id;
    fig.dataset.page = block.page;
    fig.dataset.rect = block.rect.join(',');
    const box = document.createElement('div');
    box.className = 'rm-crop-box';
    box.style.aspectRatio = Math.max(0.05, (block.rect[2] - block.rect[0]) / Math.max(1, block.rect[3] - block.rect[1])) + '';
    const ph = document.createElement('span');
    ph.className = 'rm-crop-ph';
    ph.textContent = block.k === 'table' ? '表格' : block.k === 'formula' ? '公式' : '插图';
    box.appendChild(ph);
    fig.appendChild(box);
    if (block.caption) {
      const cap = document.createElement('figcaption');
      cap.textContent = block.caption;
      fig.appendChild(cap);
    }
    return fig;
  }

  /** 用带高亮的片段填满一个文本块 */
  function fillText(el, block) {
    const ranges = highlightsFor(block);
    const text = block._text || '';
    el.textContent = '';
    if (!ranges.length) { el.appendChild(document.createTextNode(text)); return; }
    let pos = 0;
    for (const r of ranges) {
      const start = Math.max(0, Math.min(text.length, r.start));
      const end = Math.max(start, Math.min(text.length, r.end));
      if (start > pos) el.appendChild(document.createTextNode(text.slice(pos, start)));
      if (end > start) {
        const mark = document.createElement('mark');
        mark.className = 'rm-hl';
        mark.dataset.ann = r.id;
        if (r.type === 'underline') {
          mark.classList.add('rm-underline');
        } else {
          mark.style.background = r.color || '#ffe08a';
          mark.style.opacity = '0.42';
        }
        mark.textContent = text.slice(start, end);
        el.appendChild(mark);
      }
      if (r.type === 'note' && r.note) {
        const sup = document.createElement('sup');
        sup.className = 'rm-note';
        sup.dataset.ann = r.id;
        sup.title = r.note;
        sup.textContent = '✎';
        el.appendChild(sup);
      }
      pos = Math.max(pos, end);
    }
    if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
  }

  function render(options = {}) {
    if (!state.column || !state.doc) return;
    const scroll = state.host;
    const keep = options.keepScroll ? (scroll ? scroll.scrollTop : 0) : null;
    disconnectCrops();
    state.column.textContent = '';
    state.byId.clear();
    state.blockByEl = new WeakMap();
    state.cropDone.clear();
    const frag = document.createDocumentFragment();
    for (const block of state.blocks) {
      const el = blockElement(block);
      frag.appendChild(el);
      state.byId.set(block.id, el);
      state.blockByEl.set(el, block);
    }
    state.column.appendChild(frag);
    if (keep != null) scroll.scrollTop = keep;
    observeCrops();
  }

  function applyTypography() {
    const host = $('prReading');
    if (!host) return;
    const t = state.typo;
    const auto = state.doc?.bodySerif;
    const family = t.font === 'auto' ? (auto === false ? FONT_STACKS.sans : FONT_STACKS.serif)
      : t.font === 'sans' ? FONT_STACKS.sans : FONT_STACKS.serif;
    host.style.setProperty('--rm-size', t.size + 'px');
    host.style.setProperty('--rm-lh', String(t.lineHeight));
    host.style.setProperty('--rm-font', family);
    host.style.setProperty('--rm-width', t.width + 'px');
    const sizeLabel = $('rmSizeLabel');
    if (sizeLabel) sizeLabel.textContent = String(t.size);
    const lhLabel = $('rmLhLabel');
    if (lhLabel) lhLabel.textContent = t.lineHeight.toFixed(2).replace(/0$/, '');
    const fontSel = $('rmFont');
    if (fontSel && fontSel.value !== t.font) fontSel.value = t.font;
    const widthSel = $('rmWidth');
    if (widthSel && Number(widthSel.value) !== t.width) widthSel.value = String(t.width);
  }

  function saveTypo() {
    try { localStorage.setItem('prReadingTypo', JSON.stringify(state.typo)); } catch (_) { /* 隐私模式下写不进去 */ }
  }

  function loadTypo() {
    try {
      const raw = JSON.parse(localStorage.getItem('prReadingTypo') || 'null');
      if (raw && typeof raw === 'object') {
        state.typo = {
          font: ['auto', 'serif', 'sans'].includes(raw.font) ? raw.font : DEFAULT_TYPO.font,
          size: Math.min(30, Math.max(12, Number(raw.size) || DEFAULT_TYPO.size)),
          lineHeight: Math.min(2.6, Math.max(1.2, Number(raw.lineHeight) || DEFAULT_TYPO.lineHeight)),
          width: Math.min(1200, Math.max(480, Number(raw.width) || DEFAULT_TYPO.width)),
        };
      }
    } catch (_) { /* 用默认值 */ }
  }

  // ==================== 裁图（图表 / 表格 / 公式）====================

  function disconnectCrops() {
    if (state.cropObserver) { state.cropObserver.disconnect(); state.cropObserver = null; }
  }

  function observeCrops() {
    const figs = [...state.column.querySelectorAll('.rm-crop')];
    if (!figs.length) return;
    state.cropObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        paintCrop(en.target).catch(() => { /* 单张失败不影响正文 */ });
      }
    }, { root: state.host, rootMargin: '800px 0px' });
    figs.forEach((f) => state.cropObserver.observe(f));
  }

  /**
   * 把原始页面的一块区域画成位图贴进 <figure>。
   * 目标像素宽度跟着版心走，但**上限 1600px**：阅读模式里图是缩略呈现，
   * 按 4K 屏宽度画满会把内存吃光，而用户想放大时还有「点击看原图」。
   */
  async function paintCrop(fig) {
    if (fig.dataset.painted === '1' || fig.dataset.painting === '1') return;
    const doc = state.hooks.getDoc?.();
    if (!doc) return;
    const pageNum = parseInt(fig.dataset.page, 10);
    const rect = (fig.dataset.rect || '').split(',').map(Number);
    if (!pageNum || rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) return;
    fig.dataset.painting = '1';
    try {
      const page = await doc.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });
      const rotate = ((Number(page.rotate) || 0) % 360 + 360) % 360;
      const [x0, y0, x1, y1] = rect;
      const boxW = Math.max(80, fig.querySelector('.rm-crop-box')?.clientWidth || 480);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.min(3, Math.max(0.6, (boxW * dpr) / Math.max(1, x1 - x0)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((x1 - x0) * scale));
      canvas.height = Math.max(1, Math.round((y1 - y0) * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const viewport = page.getViewport({ scale });
      if (rotate === 0) {
        // 常见情况：直接把视口平移到裁切区，只画需要的像素
        const transform = [1, 0, 0, 1, -x0 * scale, -(base.height - y1) * scale];
        await page.render({ canvasContext: ctx, viewport, transform }).promise;
      } else {
        // 旋转页：先整页画到离屏画布再裁（坐标系要多绕一次，不值得为少数页面优化）
        const full = document.createElement('canvas');
        full.width = Math.ceil(viewport.width);
        full.height = Math.ceil(viewport.height);
        const fctx = full.getContext('2d');
        await page.render({ canvasContext: fctx, viewport }).promise;
        // 旋转后的显示尺寸与原始尺寸互换
        const sx = (base.width - y1) * scale;
        const sy = x0 * scale;
        ctx.drawImage(full, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        full.width = 0; full.height = 0;
      }
      canvas.className = 'rm-crop-canvas';
      const box = fig.querySelector('.rm-crop-box');
      box?.replaceChildren(canvas);
      fig.dataset.painted = '1';
      state.cropDone.add(blockKey(fig));
      try { page.cleanup(); } catch (_) { /* ignore */ }
    } finally {
      fig.dataset.painting = '';
    }
  }

  function blockKey(fig) {
    return fig.dataset.page + ':' + fig.dataset.rect;
  }

  // ==================== 选区 → 原始坐标 ====================

  /** 选区落点所在的文本块元素 */
  function blockFromNode(node) {
    let n = node;
    while (n) {
      if (n.nodeType === 1 && n.classList?.contains('rm-block')) return n;
      n = n.parentNode;
    }
    return null;
  }

  /** 从「块首」到 (node, offset) 的字符数 —— 精确到字，与内部 span 结构无关 */
  function offsetIn(blockEl, node, offset) {
    const r = document.createRange();
    r.selectNodeContents(blockEl);
    try { r.setEnd(node, offset); } catch (_) { return 0; }
    return r.toString().length;
  }

  /**
   * 字符区间 → 原始 PDF 矩形（每行一个，直角坐标 y 向下，与批注存储格式一致）。
   * 同一行内跨片段的字符会合并成一个矩形，所以下划线不会断成一节一节。
   */
  function rectsForRange(block, start, end) {
    const out = [];
    const byLine = new Map();
    for (let i = start; i < end; i++) {
      const box = charBox(block, i);
      if (!box) continue;
      const line = block.lines[box.line];
      if (!line) continue;
      const key = line.p + ':' + box.line;
      let rec = byLine.get(key);
      if (!rec) {
        rec = { page: line.p, line, x1: box.x1, x2: box.x2 };
        byLine.set(key, rec);
        out.push(rec);
      } else {
        rec.x1 = Math.min(rec.x1, box.x1);
        rec.x2 = Math.max(rec.x2, box.x2);
      }
    }
    return out.map((r) => {
      const h = pageHeight(r.page);
      return {
        page: r.page,
        // 行盒上下各留一点余量，高亮不至于压着字的上沿
        x1: round2(r.x1),
        y1: round2(toTopDown(r.page, r.line.y1 + (r.line.s || 10) * 0.06)),
        x2: round2(r.x2),
        y2: round2(toTopDown(r.page, r.line.y0 - (r.line.s || 10) * 0.14)),
        hasHeight: !!h,
      };
    });
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  /** 当前选区 → { text, parts:[{page,rects}], pageNum, rects, clientRects } */
  function selection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const startEl = blockFromNode(range.startContainer);
    const endEl = blockFromNode(range.endContainer);
    if (!startEl || !endEl || !state.column?.contains(startEl)) return null;
    const all = [...state.column.querySelectorAll('.rm-block')];
    const i0 = all.indexOf(startEl);
    const i1 = all.indexOf(endEl);
    if (i0 < 0 || i1 < 0) return null;
    const from = Math.min(i0, i1);
    const to = Math.max(i0, i1);
    const parts = [];
    for (let i = from; i <= to; i++) {
      const el = all[i];
      const block = state.blockByEl.get(el);
      if (!block) continue;
      const start = el === startEl ? offsetIn(el, range.startContainer, range.startOffset) : 0;
      const end = el === endEl ? offsetIn(el, range.endContainer, range.endOffset) : (block._text || '').length;
      if (end <= start) continue;
      const rects = rectsForRange(block, start, end);
      for (const r of rects) {
        let part = parts.find((p) => p.page === r.page);
        if (!part) { part = { page: r.page, rects: [] }; parts.push(part); }
        part.rects.push({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
      }
    }
    const text = String(sel.toString() || '').replace(/\s+/g, ' ').trim();
    if (!parts.length || !text) return null;
    parts.sort((a, b) => a.page - b.page);
    const first = parts[0];
    const clientRects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    return {
      text,
      kind: 'pdf',
      pageNum: first.page,
      rects: first.rects,
      parts,
      clientRects,
      fromReading: true,
    };
  }

  // ==================== 批注 → 字符区间 ====================

  /**
   * 一个 PDF 矩形落在某个块里对应哪几个字符。
   * 逐行求交：只有与行盒纵向相交的矩形才参与，横向按字符中心位置二分逼近。
   * 高亮在 PDF 里存的是一个外包矩形，用它和每行分别求交，正好还原出逐行的字符区间。
   *
   * 注意两套 y 轴：批注里的 rect/rects 存的是**自上而下**的规范坐标（与
   * pdfReaderUtils.toCanonicalRect 一致，y1 在上、y2 在下），而结构树的行盒是
   * PDF 用户空间（y 向上）。所以这里只把「行」翻过来，矩形本身不能再翻一次 ——
   * 翻了就等于上下镜像，任何高亮都对不上行，表现为「切回重排视图看不到高亮」。
   */
  function offsetsForRect(block, page, rect) {
    const yA = rect.y1 ?? rect[1];
    const yB = rect.y2 ?? rect[3];
    const top = Math.min(yA, yB);
    const bottom = Math.max(yA, yB);
    const x1 = Math.min(rect.x1 ?? rect[0], rect.x2 ?? rect[2]);
    const x2 = Math.max(rect.x1 ?? rect[0], rect.x2 ?? rect[2]);
    let best = null;
    for (let li = 0; li < block.lines.length; li++) {
      const line = block.lines[li];
      if (line.p !== page) continue;
      const lineTop = toTopDown(page, line.y1);
      const lineBottom = toTopDown(page, line.y0);
      if (bottom <= lineTop || top >= lineBottom) continue;
      const s = line.s || block.size || 10;
      if (x2 < line.x0 - s * 1.5 || x1 > line.x1 + s * 1.5) continue;
      // 这一行里有哪几个字符？按行扫描一次（一行通常几十个字符，够快）
      let firstIdx = -1;
      let lastIdx = -1;
      const base = block._lineOf.indexOf(li);
      if (base < 0) continue;
      for (let i = base; i < block._lineOf.length && block._lineOf[i] === li; i++) {
        const box = charBox(block, i);
        if (!box) continue;
        const center = (box.x1 + box.x2) / 2;
        if (center < x1 || center > x2) continue;
        if (firstIdx < 0) firstIdx = i;
        lastIdx = i;
      }
      if (firstIdx < 0) continue;
      if (!best) best = { start: firstIdx, end: lastIdx + 1 };
      else {
        best.start = Math.min(best.start, firstIdx);
        best.end = Math.max(best.end, lastIdx + 1);
      }
    }
    return best;
  }

  /** 某一块要画哪些高亮（供 fillText 调用） */
  function highlightsFor(block) {
    const anns = state.hooks.getAnnotations?.() || [];
    const out = [];
    for (const a of anns) {
      if (!a || a.cfi) continue; // EPUB 批注走 CFI，与这里无关
      const list = Array.isArray(a.rects) && a.rects.length ? a.rects : (a.rect ? [a.rect] : []);
      if (!list.length) continue;
      const page = a.page;
      let span = null;
      for (const r of list) {
        const rect = Array.isArray(r)
          ? { x1: r[0], y1: r[1], x2: r[2], y2: r[3] }
          : r;
        const hit = offsetsForRect(block, page, rect);
        if (!hit) continue;
        span = span
          ? { start: Math.min(span.start, hit.start), end: Math.max(span.end, hit.end) }
          : hit;
      }
      if (!span) continue;
      out.push({
        id: a.id,
        type: a.type,
        color: a.color === 'green' ? '#b6f0c2' : a.color === 'blue' ? '#bfe0ff' : a.color === 'pink' ? '#ffd6e7' : '#ffe08a',
        note: a.note || '',
        start: span.start,
        end: span.end,
      });
    }
    out.sort((x, y) => x.start - y.start || y.end - x.end);
    // 重叠区间合并成一段，避免 <mark> 互相嵌套出怪样子
    const merged = [];
    for (const r of out) {
      const prev = merged[merged.length - 1];
      if (prev && r.start < prev.end) { prev.end = Math.max(prev.end, r.end); continue; }
      merged.push(r);
    }
    return merged;
  }

  // ==================== 位置同步 ====================

  /** 视口顶部所在的块 → { page, y }（y 为自上而下的 pt，可直接定位到 PDF 页内） */
  function anchor() {
    if (!state.column || !state.blocks.length) return null;
    const hostRect = state.host.getBoundingClientRect();
    const blocks = [...state.column.querySelectorAll('.rm-block')];
    let el = blocks[blocks.length - 1];
    let elRect = el?.getBoundingClientRect();
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (r.bottom > hostRect.top + 4) { el = b; elRect = r; break; }
    }
    const block = state.blockByEl.get(el);
    if (!block) return null;
    if (block.t === 'crop') return { blockId: block.id, page: block.page, y: toTopDown(block.page, block.rect[3]) };
    // 文本块可能跨页；取视口顶部所在的那一行
    const offsetInEl = Math.max(0, hostRect.top + 4 - elRect.top);
    const perLine = elRect.height / Math.max(1, block.lines.length);
    const li = Math.min(block.lines.length - 1, Math.floor(offsetInEl / Math.max(1, perLine)));
    const line = block.lines[li] || block.lines[0];
    return { blockId: block.id, page: line.p, y: toTopDown(line.p, line.y1) };
  }

  function currentPage() {
    const a = anchor();
    return a?.page || state.page || 1;
  }

  /** 把某个块滚到视口顶部（用 rect 差值，不依赖 offsetParent 是谁） */
  function scrollToEl(el) {
    if (!el || !state.host) return;
    const delta = el.getBoundingClientRect().top - state.host.getBoundingClientRect().top;
    state.host.scrollTop = Math.max(0, state.host.scrollTop + delta - 8);
  }

  /** 跳到某一页（找这一页的第一个块；跨页块按行判断） */
  function scrollToPage(page) {
    if (!state.column) return false;
    const blocks = [...state.column.querySelectorAll('.rm-block')];
    for (const el of blocks) {
      const block = state.blockByEl.get(el);
      if (!block) continue;
      const hit = block.t === 'crop'
        ? block.page === page
        : block.lines.some((l) => l.p === page);
      if (hit) { scrollToEl(el); return true; }
    }
    return false;
  }

  function scrollToBlock(id) {
    const el = state.byId.get(id);
    if (!el) return false;
    scrollToEl(el);
    return true;
  }

  /** 滚动时把当前页回传给调用方（更新页码输入框 / 侧栏） */
  function onScroll() {
    if (state.scrollRaf) return;
    state.scrollRaf = requestAnimationFrame(() => {
      state.scrollRaf = 0;
      const page = currentPage();
      if (page !== state.page) {
        state.page = page;
        state.hooks.onPageChange?.(page);
      } else {
        state.hooks.onScroll?.();
      }
    });
  }

  // ==================== 装载 / 卸载 ====================

  function setDoc(doc) {
    state.doc = doc || null;
    state.blocks = [];
    state.byId.clear();
    state.page = 1;
    if (!doc?.blocks?.length) return;
    state.blocks = doc.blocks.map((b) => (b.t === 'text' ? assemble({ ...b }) : { ...b }));
  }

  function mount() {
    const host = $('rmScroll');
    if (!host) return;
    state.host = host;
    state.column = $('rmColumn');
    if (!state.column) return;
    if (host.dataset.rmBound !== '1') {
      host.dataset.rmBound = '1';
      host.addEventListener('scroll', onScroll, { passive: true });
    }
    loadTypo();
    applyTypography();
    bindControls();
    render();
  }

  function unmount() {
    disconnectCrops();
    if (state.host) state.host.scrollTop = 0;
    if (state.column) {
      state.column.textContent = '';
      state.column = null;
    }
    state.host = null;
    state.blocks = [];
    state.byId.clear();
    state.doc = null;
  }

  function bindControls() {
    const font = $('rmFont');
    if (font && font.dataset.bound !== '1') {
      font.dataset.bound = '1';
      font.addEventListener('change', () => { state.typo.font = font.value; applyTypography(); saveTypo(); });
    }
    const width = $('rmWidth');
    if (width && width.dataset.bound !== '1') {
      width.dataset.bound = '1';
      width.addEventListener('change', () => {
        state.typo.width = Number(width.value) || DEFAULT_TYPO.width;
        applyTypography(); saveTypo();
      });
    }
    const bindStep = (minusId, plusId, key, step, min, max, digits) => {
      const minus = $(minusId); const plus = $(plusId);
      if (!minus || !plus) return;
      const apply = (delta) => {
        const cur = Number(state.typo[key]) || 0;
        state.typo[key] = Math.min(max, Math.max(min, Math.round((cur + delta * step) * 100) / 100));
        applyTypography(); saveTypo();
      };
      if (minus.dataset.bound !== '1') { minus.dataset.bound = '1'; minus.addEventListener('click', () => apply(-1)); }
      if (plus.dataset.bound !== '1') { plus.dataset.bound = '1'; plus.addEventListener('click', () => apply(1)); }
    };
    bindStep('rmSizeMinus', 'rmSizePlus', 'size', 1, 12, 30);
    bindStep('rmLhMinus', 'rmLhPlus', 'lineHeight', 0.1, 1.2, 2.6);
  }

  /** 标注变动后重画高亮（保留滚动位置，不整页重排） */
  function refreshHighlights() {
    if (!state.column) return;
    for (const block of state.blocks) {
      if (block.t !== 'text') continue;
      const el = state.byId.get(block.id);
      if (!el) continue;
      fillText(el, block);
    }
  }

  // 点击高亮/笔记图标 → 交给外层定位到批注条目
  document.addEventListener('click', (e) => {
    const hit = e.target?.closest?.('.rm-hl, .rm-note');
    if (!hit) return;
    const ann = hit.dataset.ann;
    if (!ann) return;
    state.hooks.onAnnotationClick?.(ann, e);
  });

  window.PrReading = {
    configure(hooks) { Object.assign(state.hooks, hooks || {}); },
    setDoc,
    mount,
    unmount,
    render,
    refreshHighlights,
    applyTypography,
    selection,
    anchor,
    currentPage,
    scrollToPage,
    scrollToBlock,
    get doc() { return state.doc; },
    get typography() { return state.typo; },
    debug: () => ({
      blocks: state.blocks.length,
      text: state.blocks.filter((b) => b.t === 'text').length,
      crops: state.blocks.filter((b) => b.t === 'crop').length,
      chars: state.blocks.reduce((n, b) => n + (b._text ? b._text.length : 0), 0),
      page: state.page,
    }),
  };
})();
