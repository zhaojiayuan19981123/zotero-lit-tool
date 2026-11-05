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
  const DEFAULT_TYPO = {
    font: 'auto', size: 18, lineHeight: 1.75, width: 720,
    align: 'body',   // body=仅正文两端对齐 / all=全部两端对齐 / left=全部左对齐
    bg: 'theme',     // 论文底色：theme=跟随主题，其余为护眼预设或 #rrggbb
    autoFit: true,   // 窄栏（对照精读）空间不足时自动缩小字号
  };

  /**
   * 参考 zotero-eye-care 的四套护眼预设（该插件把配色接进 Zotero 原生主题引擎）。
   * 色值直接取自它的 README：淡豆沙绿 / 暖米黄 / 雾蓝灰 / 深灰夜读，
   * 四组正文对比度都超过 WCAG AA。这里同样只给论文版心换色，图表保持原色。
   */
  const BG_PRESETS = {
    paper: { surface: '#ffffff', bg: '#f1f2f4', text: '#1f2328' },
    green: { surface: '#DCEAD8', bg: '#D2E1CE', text: '#26352A' }, // 淡豆沙绿
    cream: { surface: '#F5E9CE', bg: '#EFE1C2', text: '#40372A' }, // 暖米黄
    mist: { surface: '#E3EBF1', bg: '#D9E3EB', text: '#293742' },  // 雾蓝灰
    dark: { surface: '#252A2E', bg: '#1C2023', text: '#D7DDD9' },  // 深灰夜读
  };

  function bgOf(value) {
    if (BG_PRESETS[value]) return BG_PRESETS[value];
    if (/^#[0-9a-f]{6}$/i.test(String(value || ''))) {
      const hex = String(value);
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const light = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      const darken = (v) => Math.max(0, Math.round(v * 0.93)).toString(16).padStart(2, '0');
      return {
        surface: hex,
        bg: `#${darken(r)}${darken(g)}${darken(b)}`,
        text: light < 0.5 ? '#eceef0' : '#22262b',
      };
    }
    return null; // theme：交给全局 CSS 变量
  }

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
    renderIndex: 0,      // 已装配到第几块（分帧渲染的游标）
    rendering: false,
    renderRaf: 0,
    pendingScrollPage: null, // 渲染未完成时请求跳页 → 补完再跳
    pendingScrollBlock: null, // 同上，按「原页 + 文字」定位的块
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
    const flagOf = [];
    const urlOf = [];
    const lines = block.lines || [];

    const push = (ch, ri, ci, li, flag, url) => {
      text += ch;
      runOf.push(ri);
      idxOf.push(ci);
      lineOf.push(li);
      flagOf.push(flag);
      urlOf.push(url || '');
    };
    const pushSep = (li) => {
      text += ' ';
      runOf.push(-1);
      idxOf.push(0);
      lineOf.push(li);
      flagOf.push(0);
      urlOf.push('');
    };
    // 脚注 / 作者单位这种「一行一个条目」的块要保留原始换行：
    // 通讯邮箱、单位地址挤成一段读起来就是一团，所以用真换行 + white-space: pre-line。
    const hardLines = block.kind === 'footnote';
    const pushBreak = (li) => {
      text += '\n';
      runOf.push(-1);
      idxOf.push(0);
      lineOf.push(li);
      flagOf.push(0);
      urlOf.push('');
    };

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const size = Number(line.s) || Number(block.size) || 10;
      let prevEnd = null;
      for (const run of line.runs || []) {
        const x = run[0];
        const w = run[1];
        const s = String(run[2] || '');
        const flag = Number(run[3]) || 0;
        const url = typeof run[4] === 'string' ? run[4] : '';
        if (!s) continue;
        if (prevEnd !== null) {
          const gap = Number(x) - prevEnd;
          if (gap > size * 0.22 && !/\s$/.test(text) && !/^\s/.test(s)) pushSep(li);
        }
        const ri = runs.length;
        runs.push({ x: Number(x) || 0, w: Number(w) || 0, len: s.length, line: li, flag, url });
        for (let i = 0; i < s.length; i++) push(s[i], ri, i, li, flag, url);
        prevEnd = Number(x) + (Number(w) || 0);
      }
      if (li === lines.length - 1) continue;
      const next = lines[li + 1];
      const nextFirst = next?.runs?.[0]?.[2]?.[0] || '';
      const lastCh = text.slice(-1);
      if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(nextFirst)) {
        // 行尾断词：删掉连字符（映射表同步弹出）
        text = text.slice(0, -1);
        runOf.pop(); idxOf.pop(); lineOf.pop(); flagOf.pop(); urlOf.pop();
        continue;
      }
      // 脚注块一行一个条目：换行比补空格忠实（邮箱 / 单位地址不该连成一段）
      if (hardLines) { pushBreak(li); continue; }
      if (CJK_EDGE.test(lastCh) || CJK_EDGE.test(nextFirst)) continue;
      pushSep(li);
    }

    block._text = text;
    block._runs = runs;
    block._runOf = Int32Array.from(runOf);
    block._idxOf = Int32Array.from(idxOf);
    block._lineOf = Int32Array.from(lineOf);
    block._flagOf = Int8Array.from(flagOf);
    block._urlOf = urlOf;
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
    if (block.kind === 'footnote') el.classList.add('rm-fn');
    if (block.sep) el.classList.add('rm-fn-sep');
    if (block.kind === 'kicker') el.classList.add('rm-kicker');
    if (block.kind === 'authors') el.classList.add('rm-authors');
    fillText(el, block);
    return el;
  }

  function cropElement(block) {
    const fig = document.createElement('figure');
    fig.className = 'rm-crop rm-crop-' + (block.k || 'figure');
    fig.dataset.id = block.id;
    fig.dataset.page = block.page;
    fig.dataset.rect = block.rect.join(',');
    if (block.size) fig.dataset.size = block.size;
    if (block.full) fig.dataset.full = '1';
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
      // 长图注按左对齐段落排（与正文一致）；只有一行短图题才居中，
      // 否则「Figure 8. 后面跟三句话」会整段浮在栏中间。
      if (String(block.caption).trim().length > 90) cap.classList.add('rm-cap-long');
      fig.appendChild(cap);
    }
    return fig;
  }

  /** 带样式（粗体 / 斜体）的文字节点 */
  function styledText(txt, flag) {
    if (!txt) return null;
    if (!flag) return document.createTextNode(txt);
    const span = document.createElement('span');
    span.className = 'rm-s' + (flag & 1 ? ' rm-b' : '') + (flag & 2 ? ' rm-i' : '');
    span.textContent = txt;
    return span;
  }

  /**
   * 填满一个文本块。
   *
   * 三种内联信息要同时成立：原文的粗体/斜体（run 第 4 位）、超链接（run 第 5 位）、
   * 批注高亮（按字符区间）。做法是给每个字符算三项属性，再按「属性完全相同的连续字符」
   * 切段，逐段生成 <mark> / <a> / <span> 的嵌套 —— 这样三者重叠也不会互相吃掉。
   */
  function fillText(el, block) {
    const text = block._text || '';
    el.textContent = '';
    if (!text) return;
    const ranges = highlightsFor(block);
    const flags = block._flagOf;
    const urls = block._urlOf;
    const n = text.length;

    // 每个字符落在哪条高亮里（-1 = 没有）
    const hlOf = new Int32Array(n).fill(-1);
    if (ranges.length) {
      for (let k = 0; k < ranges.length; k++) {
        const start = Math.max(0, Math.min(n, ranges[k].start));
        const end = Math.max(start, Math.min(n, ranges[k].end));
        for (let i = start; i < end; i++) if (hlOf[i] < 0) hlOf[i] = k;
      }
    }

    let i = 0;
    while (i < n) {
      const flag = flags ? flags[i] : 0;
      const url = urls ? urls[i] : '';
      const hl = hlOf[i];
      let j = i + 1;
      while (j < n
        && (flags ? flags[j] : 0) === flag
        && (urls ? urls[j] : '') === url
        && hlOf[j] === hl) j += 1;
      el.appendChild(segmentNode(text.slice(i, j), flag, url, hl >= 0 ? ranges[hl] : null));
      i = j;
    }
    // 笔记类批注在段末补一个小图标（点开看笔记）
    for (const r of ranges) {
      if (r.type !== 'note' || !r.note) continue;
      const sup = document.createElement('sup');
      sup.className = 'rm-note';
      sup.dataset.ann = r.id;
      sup.title = r.note;
      sup.textContent = '✎';
      el.appendChild(sup);
    }
  }

  /** 一段同属性的文字 → 可嵌套的 <mark> / <a> / <span> */
  function segmentNode(txt, flag, url, range) {
    let inner = styledText(txt, flag);
    if (url) {
      const a = document.createElement('a');
      a.className = 'rm-link';
      if (url.startsWith('#p')) {
        // 引文内部跳转：目标在重排视图里就是某一页，点一下滚过去，不用开新窗口
        const page = Number(url.slice(2)) || 0;
        a.classList.add('rm-xref');
        a.href = '#';
        a.title = '跳到第 ' + page + ' 页（参考文献）';
        a.dataset.page = page;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (page) scrollToPage(page);
        });
      } else {
        a.href = url;
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        a.title = url;
      }
      a.appendChild(inner);
      inner = a;
    }
    if (!range) return inner;
    const mark = document.createElement('mark');
    mark.className = 'rm-hl';
    mark.dataset.ann = range.id;
    if (range.type === 'underline') {
      mark.classList.add('rm-underline');
    } else {
      mark.style.background = range.color || '#ffe08a';
      mark.style.opacity = '0.42';
    }
    mark.appendChild(inner);
    return mark;
  }

  /**
   * 分帧装配：先铺满第一屏，剩下的每帧补一批。
   *
   * 为什么不一次插完：一篇 80 页的论文有 1800+ 块，一次性创建 + 插入会让主线程
   * 独占几百毫秒（这段时间滚动、点击都不响应，观感就是「卡住/加载不出来」）。
   * 首帧只铺够 2 屏的文字（用户马上能读），其余用 rAF 续上，插入期间界面始终可交互。
   */
  const FIRST_CHUNK = 90;
  const NEXT_CHUNK = 240;

  function cancelChunks() {
    if (state.renderRaf) { cancelAnimationFrame(state.renderRaf); state.renderRaf = 0; }
    state.rendering = false;
  }

  /** 把 [state.renderIndex, +n) 的块建好并插入；返回插入的裁图 figure */
  function pumpBlocks(n) {
    const blocks = state.blocks;
    const end = Math.min(blocks.length, state.renderIndex + n);
    if (end <= state.renderIndex) return [];
    const frag = document.createDocumentFragment();
    const figs = [];
    for (let i = state.renderIndex; i < end; i += 1) {
      const block = blocks[i];
      const el = block.t === 'text' ? blockElement(block) : cropElement(block);
      frag.appendChild(el);
      state.byId.set(block.id, el);
      state.blockByEl.set(el, block);
      if (block.t !== 'text') figs.push(el);
    }
    state.renderIndex = end;
    state.column.appendChild(frag);
    return figs;
  }

  /** 首屏之后逐帧补齐；补完再处理「挂载时就想跳页」的请求 */
  function scheduleNextChunks() {
    flushPendingBlock();
    if (state.renderIndex >= state.blocks.length) {
      state.rendering = false;
      state.renderRaf = 0;
      state.hooks.onRenderProgress?.(state.blocks.length, state.blocks.length);
      if (state.pendingScrollPage != null) {
        const target = state.pendingScrollPage;
        state.pendingScrollPage = null;
    state.pendingScrollBlock = null;
        scrollToPage(target);
      }
      return;
    }
    state.renderRaf = requestAnimationFrame(() => {
      state.renderRaf = 0;
      const figs = pumpBlocks(NEXT_CHUNK);
      observeCrops(figs);
      state.hooks.onRenderProgress?.(state.renderIndex, state.blocks.length);
      scheduleNextChunks();
    });
  }

  /** 目标块已经铺好了就立刻滚过去（分帧渲染期间可能晚几帧才轮到它） */
  function flushPendingBlock() {
    const id = state.pendingScrollBlock;
    if (!id) return;
    const el = state.byId.get(id);
    if (!el) return;
    state.pendingScrollBlock = null;
    scrollToEl(el);
    flashBlock(el);
  }

  function render(options = {}) {
    if (!state.column || !state.doc) return;
    const scroll = state.host;
    const keep = options.keepScroll ? (scroll ? scroll.scrollTop : 0) : null;
    cancelChunks();
    disconnectCrops();
    state.column.textContent = '';
    state.byId.clear();
    state.blockByEl = new WeakMap();
    state.cropDone.clear();
    state.renderIndex = 0;
    state.rendering = true;
    // 第一屏同步铺好，保证「点开就能读」
    const figs = pumpBlocks(FIRST_CHUNK);
    observeCrops(figs);
    if (keep != null) scroll.scrollTop = keep;
    scheduleNextChunks();
  }

  /**
   * 追加一段新块（首屏之后续拉回来的后 70 页走这里）。
   * 分帧泵会自动把新加进来的块铺完 —— 它每帧都重新读 state.blocks.length。
   */
  function appendBlocks(blocks) {
    if (!Array.isArray(blocks) || !blocks.length || !state.column) return 0;
    for (const b of blocks) {
      state.blocks.push(b.t === 'text' ? assemble({ ...b }) : { ...b });
    }
    if (!state.rendering) {
      state.rendering = true;
      if (!state.renderRaf) scheduleNextChunks();
    }
    return blocks.length;
  }

  /**
   * 空间不足时自动缩小字号：对照精读里阅读面板只占 1/3 屏，18px 会把正文挤成
   * 每七八个字一行。按滚动容器实际宽度折算，最低 13px；用户手动调的字号是上限。
   */
  function fittedSize() {
    const t = state.typo;
    if (!t.autoFit) return t.size;
    const w = state.host?.clientWidth || 0;
    if (!w || w >= 860) return t.size;
    const ratio = Math.min(1, Math.max(0.62, w / 860));
    return Math.max(13, Math.round(t.size * ratio));
  }

  function applyTypography() {
    const host = $('prReading');
    if (!host) return;
    const t = state.typo;
    const auto = state.doc?.bodySerif;
    const family = t.font === 'auto' ? (auto === false ? FONT_STACKS.sans : FONT_STACKS.serif)
      : t.font === 'sans' ? FONT_STACKS.sans : FONT_STACKS.serif;
    host.style.setProperty('--rm-size', fittedSize() + 'px');
    host.style.setProperty('--rm-lh', String(t.lineHeight));
    host.style.setProperty('--rm-font', family);
    host.style.setProperty('--rm-width', t.width + 'px');
    host.dataset.rmAlign = t.align;
    const preset = bgOf(t.bg);
    if (preset) {
      host.style.setProperty('--rm-surface', preset.surface);
      host.style.setProperty('--rm-bg', preset.bg);
      host.style.setProperty('--rm-text', preset.text);
    } else {
      host.style.removeProperty('--rm-surface');
      host.style.removeProperty('--rm-bg');
      host.style.removeProperty('--rm-text');
    }
    const sizeLabel = $('rmSizeLabel');
    if (sizeLabel) {
      const actual = fittedSize();
      sizeLabel.textContent = actual === t.size ? String(t.size) : `${actual}*`;
      sizeLabel.title = actual === t.size ? '' : `窄栏自动缩小（设定 ${t.size}px）`;
    }
    const lhLabel = $('rmLhLabel');
    if (lhLabel) lhLabel.textContent = t.lineHeight.toFixed(2).replace(/0$/, '');
    const syncSel = (id, value) => {
      const el = $(id);
      if (el && el.value !== String(value)) el.value = String(value);
    };
    syncSel('rmFont', t.font);
    syncSel('rmWidth', t.width);
    syncSel('rmAlign', t.align);
    syncSel('rmBg', BG_PRESETS[t.bg] ? t.bg : 'custom');
    const color = $('rmBgColor');
    if (color && /^#[0-9a-f]{6}$/i.test(t.bg)) color.value = t.bg;
    const fit = $('rmAutoFit');
    if (fit) fit.checked = !!t.autoFit;
    // 字号 / 栏宽变了，裁图的自然宽度也要跟着变（图是按正文比例排的）
    if (state.column) {
      for (const fig of state.column.querySelectorAll('.rm-crop')) {
        const r = (fig.dataset.rect || '').split(',').map(Number);
        if (r.length === 4 && r.every(Number.isFinite)) fitCropWidth(fig, r[2] - r[0]);
      }
    }
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
          align: ['body', 'all', 'left'].includes(raw.align) ? raw.align : DEFAULT_TYPO.align,
          bg: (BG_PRESETS[raw.bg] || /^#[0-9a-f]{6}$/i.test(String(raw.bg || '')))
            ? raw.bg : DEFAULT_TYPO.bg,
          autoFit: raw.autoFit === undefined ? DEFAULT_TYPO.autoFit : !!raw.autoFit,
        };
      }
    } catch (_) { /* 用默认值 */ }
  }

  // ==================== 裁图（图表 / 表格 / 公式）====================

  function disconnectCrops() {
    if (state.cropObserver) { state.cropObserver.disconnect(); state.cropObserver = null; }
  }

  /**
   * 给裁图挂懒加载观察。
   * 分帧渲染下它是**分批调用**的，所以观察器只建一个、后续增量 observe；
   * 每次都新建会 disconnect 掉上一批，导致已经露头的图永远画不出来。
   */
  function observeCrops(figs) {
    const list = Array.isArray(figs)
      ? figs
      : (state.column ? [...state.column.querySelectorAll('.rm-crop')] : []);
    if (!list.length) return;
    if (!state.cropObserver) {
      state.cropObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          paintCrop(en.target).catch(() => { /* 单张失败不影响正文 */ });
        }
      }, { root: state.host, rootMargin: '800px 0px' });
    }
    for (const f of list) state.cropObserver.observe(f);
  }

  /**
   * 裁图按「和正文相同的比例」排版。
   *
   * 原来一律铺满整栏：一条 20pt 宽的小公式会被放大十几倍（糊且刺眼），半截公式
   * 被拉满整栏后更显突兀。现在用「正文 pt → 当前阅读字号 px」的比例算出自然宽度，
   * 只在不超出栏宽时才按这个宽度居中显示；大图 / 跨栏图仍然铺满。
   */
  function fitCropWidth(fig, rectW) {
    const box = fig.querySelector('.rm-crop-box');
    if (!box) return;
    const figure = box.parentElement;
    const colW = figure ? figure.clientWidth : 0;
    if (!colW) return;
    const bodySize = Number(state.doc?.bodySize) || 10;
    const host = state.column || state.host;
    const fontPx = parseFloat(host ? getComputedStyle(host).fontSize : '') || 18;
    if (fig.dataset.full === '1') {
      box.style.width = '100%';
      return;
    }
    const ratio = fontPx / Math.max(1, bodySize);       // 1pt 原稿 ≈ ratio px
    const natural = Math.round(rectW * ratio);
    const width = Math.max(120, Math.min(colW, natural));
    box.style.width = Math.round((width / colW) * 10000) / 100 + '%';
    box.style.marginInline = 'auto';
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
      fitCropWidth(fig, rect[2] - rect[0]);
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
    const blocks = [...state.column.querySelectorAll('.rm-block, .rm-crop')];
    for (const el of blocks) {
      const block = state.blockByEl.get(el);
      if (!block) continue;
      const hit = block.t === 'crop'
        ? block.page === page
        : block.lines.some((l) => l.p === page);
      if (hit) { scrollToEl(el); return true; }
    }
    // 分帧渲染还没铺到这一页：记下来，补完再跳（否则「打开就停在原来读到的地方」会失效）
    if (state.rendering) { state.pendingScrollPage = page; return false; }
    return false;
  }

  function scrollToBlock(id) {
    const el = state.byId.get(id);
    if (!el) return false;
    scrollToEl(el);
    return true;
  }

  /** 归一化一段文字：去掉所有空白，只比「前十几个字」。中英混排也能对上。 */
  function normKey(t) {
    return String(t || '').replace(/\s+/g, '').toLowerCase();
  }

  /** 块在本页的「顶部」坐标（PDF 坐标，向上为正）：裁图用 bbox 上沿，文字用首行 */
  function topOfBlockOnPage(b, pg) {
    if (b.t === 'crop') return b.page === pg ? b.rect[3] : NaN;
    const lines = (b.lines || []).filter((l) => l.p === pg);
    return lines.length ? Math.max(...lines.map((l) => l.y1)) : NaN;
  }

  /**
   * 按「原页 + 纵向位置 + 文字」定位到重排视图里的那一段。
   *
   * 对照精读左侧目录、批注列表点过来时手里只有 PDF 的页码与坐标，而重排视图是另一套
   * 块 id（r1…rN），两边没有任何共享 id —— 以前这种情况会把已经隐藏的 PDF 页滚一下，
   * 用户看到的就是「点了没反应」。这里按「同页 + 文字前缀」先认，认不出再按纵向位置取最近。
   */
  function scrollToSource(info = {}) {
    const pg = Number(info.page) || 0;
    if (!pg || !state.blocks.length) return false;
    const want = normKey(info.text);
    const wantHead = want.slice(0, 16);
    let y = Number(info.y);
    // 调用方手里常是「归一化的 y（从页顶算）」—— 换算成 PDF 的 y（向上为正）
    if (!(y > 0)) {
      const ny = Number(info.ny);
      const h = pageHeight(pg);
      if (Number.isFinite(ny) && h) y = h * (1 - ny);
    }
    let best = null;
    let bestScore = -Infinity;
    state.blocks.forEach((b, i) => {
      const top = topOfBlockOnPage(b, pg);
      if (!Number.isFinite(top)) return;
      let score = 0;
      if (wantHead && b.t === 'text') {
        const have = normKey(b._text).slice(0, 16);
        if (have && (have.startsWith(wantHead.slice(0, 8)) || wantHead.startsWith(have.slice(0, 8)))) score += 20;
      }
      if (Number.isFinite(y) && y > 0) score -= Math.abs(top - y) / 20;
      // 同分时往前取（目录标题多半就是那一段的开头），序号越小越靠前
      score -= i * 1e-6;
      if (score > bestScore) { bestScore = score; best = b; }
    });
    if (!best) return false;
    const el = state.byId.get(best.id);
    if (!el) {
      // 分帧渲染还没轮到这一块：记下来，铺到它时再跳
      state.pendingScrollBlock = best.id;
      if (!state.rendering) render();
      return true;
    }
    scrollToEl(el);
    flashBlock(el);
    return true;
  }

  /** 跳过去之后闪一下，明确告诉用户「就是这一段」 */
  function flashBlock(el) {
    if (!el) return;
    el.classList.remove('rm-flash');
    void el.offsetWidth;           // 强制重排，连点同一段也要能重放
    el.classList.add('rm-flash');
    setTimeout(() => el.classList.remove('rm-flash'), 1400);
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
    window.addEventListener('resize', onResize);
    render();
  }

  function unmount() {
    cancelChunks();
    window.removeEventListener('resize', onResize);
    hideOriginal();
    state.pendingScrollPage = null;
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

    const align = $('rmAlign');
    if (align && align.dataset.bound !== '1') {
      align.dataset.bound = '1';
      align.addEventListener('change', () => {
        state.typo.align = ['body', 'all', 'left'].includes(align.value) ? align.value : 'body';
        applyTypography(); saveTypo();
      });
    }
    const bg = $('rmBg');
    if (bg && bg.dataset.bound !== '1') {
      bg.dataset.bound = '1';
      bg.addEventListener('change', () => {
        const color = $('rmBgColor');
        state.typo.bg = bg.value === 'custom' ? (color?.value || '#f8f2df') : bg.value;
        applyTypography(); saveTypo();
      });
    }
    const color = $('rmBgColor');
    if (color && color.dataset.bound !== '1') {
      color.dataset.bound = '1';
      color.addEventListener('input', () => {
        state.typo.bg = color.value;
        const bgSel = $('rmBg');
        if (bgSel) bgSel.value = 'custom';
        applyTypography(); saveTypo();
      });
    }
    const fit = $('rmAutoFit');
    if (fit && fit.dataset.bound !== '1') {
      fit.dataset.bound = '1';
      fit.addEventListener('change', () => {
        state.typo.autoFit = !!fit.checked;
        applyTypography(); saveTypo();
      });
    }
  }

  // 面板搬进对照精读 / 窗口缩放后，可用宽度变了，字号要跟着重算
  let resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; applyTypography(); });
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

  // ==================== 单个文本块的原文浮层（Ctrl/Cmd + 点击）====================
  let originalTimer = 0;
  function hideOriginal() {
    const pop = $('rmOriginalPop');
    if (pop) pop.classList.remove('show');
  }
  function showOriginal(block, x, y) {
    let pop = $('rmOriginalPop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'rmOriginalPop';
      pop.className = 'rm-original-pop';
      document.body.appendChild(pop);
    }
    // 原始 run 文本（未经装配，不补空格、不去连字符），按 PDF 行还原
    const raw = (block.lines || [])
      .map((l) => (l.runs || []).map((r) => String(r[2] || '')).join(''))
      .join('\n');
    pop.textContent = '';
    const head = document.createElement('div');
    head.className = 'rm-original-head';
    head.textContent = `原文块 ${block.id || ''} · 第 ${block.page || '?'} 页 · ${block.kind || 'text'}`;
    const body = document.createElement('pre');
    body.className = 'rm-original-body';
    body.textContent = raw || String(block._text || '');
    pop.append(head, body);
    const w = 380;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 12, x + 12))}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - 240, y + 12))}px`;
    pop.classList.add('show');
    clearTimeout(originalTimer);
    originalTimer = setTimeout(hideOriginal, 12000);
  }

  /**
   * 译文块 → 重排原文定位。对照精读的版面块带「页 + 页内顶部百分比」，
   * 换算成 PDF 纵坐标后，在这一页的重排文本块里挑纵向最接近的滚过去并闪一下。
   */
  function focusBlock(page, topPct) {
    const p = Number(page) || 0;
    const ps = state.hooks.pageSize?.(p);
    const h = Number(ps?.h || ps?.height) || 0;
    const y = h && Number.isFinite(Number(topPct)) ? h * (1 - Number(topPct) / 100) : null;
    let best = null;
    let bestD = Infinity;
    for (const b of state.blocks) {
      if (b.t !== 'text' || b.page !== p) continue;
      const cy = b.rect ? (b.rect[1] + b.rect[3]) / 2 : 0;
      const d = y == null ? 0 : Math.abs(cy - y);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) return false;
    const el = state.byId.get(best.id);
    if (!el) return false;
    scrollToEl(el);
    el.classList.remove('rm-focus');
    void el.offsetWidth;
    el.classList.add('rm-focus');
    setTimeout(() => el.classList.remove('rm-focus'), 1600);
    return true;
  }

  // 点击高亮/笔记图标 → 批注条目；Ctrl/Cmd 点击 → 原文浮层；
  // 普通点击段落 → 通知对照精读把译文定位到对应块。
  document.addEventListener('click', (e) => {
    const hit = e.target?.closest?.('.rm-hl, .rm-note');
    if (hit) {
      const ann = hit.dataset.ann;
      if (ann) state.hooks.onAnnotationClick?.(ann, e);
      return;
    }
    const el = e.target?.closest?.('.rm-block');
    if (!el || e.target?.closest?.('a, .rm-crop')) return;
    const block = state.blockByEl.get(el) || state.byId.get(el.dataset.id);
    if (!block) {
      const pop = $('rmOriginalPop');
      if (pop && !e.target?.closest?.('#rmOriginalPop')) hideOriginal();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      showOriginal(block, e.clientX, e.clientY);
      return;
    }
    hideOriginal();
    state.hooks.onBlockClick?.({
      blockId: block.id,
      page: block.page,
      text: block._text || '',
      kind: block.kind,
      rect: block.rect,
      parts: block.parts || null,
    });
  });

  window.PrReading = {
    configure(hooks) { Object.assign(state.hooks, hooks || {}); },
    setDoc,
    mount,
    unmount,
    render,
    appendBlocks,
    refreshHighlights,
    applyTypography,
    selection,
    anchor,
    currentPage,
    scrollToPage,
    scrollToBlock,
    scrollToSource,
    focusBlock,
    get doc() { return state.doc; },
    get typography() { return state.typo; },
    debug: () => ({
      blocks: state.blocks.length,
      text: state.blocks.filter((b) => b.t === 'text').length,
      crops: state.blocks.filter((b) => b.t === 'crop').length,
      chars: state.blocks.reduce((n, b) => n + (b._text ? b._text.length : 0), 0),
      page: state.page,
      rendered: state.renderIndex,
      rendering: state.rendering,
    }),
  };
})();
