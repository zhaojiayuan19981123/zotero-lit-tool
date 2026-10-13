// epub-reader.js —— EPUB 阅读内核（对 epub.js 的封装）
//
// 设计目标：与现有 PDF 阅读器**共用同一个阅读器外壳**（#pdfReader 浮层 + 右侧划词翻译/笔记面板），
// 只把「正文渲染」这一层换成 EPUB 引擎。所以本模块只负责这几件事：
//   打开/销毁 · 阅读样式（字号/行距/字体/主题）· 翻页方式 · 章节跳转 · 目录 · 阅读位置 · 批注挂载 · 全文搜索
// 其余（划词翻译、AI 解析、笔记、持久化、UI 绑定）全部由 app.js 复用既有实现，避免两套逻辑打架。
//
// 外部依赖：vendor/jszip/jszip.min.js（epub.js 把 JSZip 当外部依赖）、vendor/epubjs/epub.min.js
// EPUB 里的脚本与远程资源一律不执行/不加载（allowScriptedContent: false + 内容钩子清理）。

(() => {
  'use strict';

  // 三套阅读主题，注入到 epub.js 的 iframe 内部
  const THEMES = {
    light: { label: '浅色', bg: '#ffffff', fg: '#17231f', link: '#176b87' },
    sepia: { label: '米黄', bg: '#f6efe3', fg: '#4a3c28', link: '#8a6b32' },
    dark: { label: '深色', bg: '#15201e', fg: '#dfe9e4', link: '#65bfd0' },
  };
  const THEME_ORDER = ['light', 'sepia', 'dark'];

  const FONT_STACKS = {
    '': '', // 跟随原书
    serif: '"Songti SC", "SimSun", "Noto Serif CJK SC", Georgia, serif',
    sans: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif',
  };

  const DEFAULT_SETTINGS = {
    fontSize: 100, // 百分比，相对原书字号
    lineHeight: 1.6,
    fontFamily: '',
    theme: 'light',
    flow: 'paginated', // paginated 分页翻页 | scrolled 连续滚动
  };

  const state = {
    book: null,
    rendition: null,
    container: null,
    recordId: null,
    toc: [],
    tocFlat: [],
    settings: { ...DEFAULT_SETTINGS },
    hooks: {},
    highlights: new Map(), // cfi -> { type, color }
    location: { href: '', cfi: null, percentage: null, chapterIndex: 0, chapterTotal: 0 },
    locationsReady: false,
    destroyed: true,
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function lib() {
    const ePub = window.ePub;
    if (!ePub) throw new Error('EPUB 内核未加载：public/vendor/epubjs/epub.min.js');
    return ePub;
  }

  function isOpen() {
    return !state.destroyed && !!state.rendition;
  }

  // ==================== 目录 ====================

  /** 把 epub.js 的嵌套 nav.toc 拍平成 [{label, href, depth}]，并保留层级用于缩进 */
  function flattenToc(items, depth, out) {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item) continue;
      out.push({
        label: String(item.label || '').trim() || '未命名章节',
        href: item.href || '',
        depth: depth,
      });
      if (Array.isArray(item.subitems) && item.subitems.length) flattenToc(item.subitems, depth + 1, out);
    }
    return out;
  }

  function getToc() {
    return state.tocFlat;
  }

  /** 当前章节在目录里的下标；按 href 去掉锚点后匹配 */
  function currentChapterIndex(href) {
    const clean = (h) => String(h || '').split('#')[0];
    const target = clean(href);
    if (!target) return -1;
    return state.tocFlat.findIndex((t) => clean(t.href) === target);
  }

  // ==================== 样式 ====================

  function themeRules() {
    const t = THEMES[state.settings.theme] || THEMES.light;
    const stack = FONT_STACKS[state.settings.fontFamily] || '';
    const body = {
      'background': `${t.bg} !important`,
      'color': `${t.fg} !important`,
      'line-height': `${state.settings.lineHeight} !important`,
      'padding': '0 8px !important',
    };
    // 只有用户显式选了字体才覆盖，否则保留出版社排版
    if (stack) body['font-family'] = `${stack} !important`;
    return {
      'body': body,
      'p, li, blockquote, dd, dt, td, th': { 'line-height': 'inherit !important' },
      'img, svg, video': { 'max-width': '100% !important', 'height': 'auto !important' },
      'a, a:visited': { 'color': `${t.link} !important` },
      // 有些书用固定色印刷，深色主题下会看不见，这里强制继承
      'h1, h2, h3, h4, h5, h6': { 'color': 'inherit !important' },
      '::selection': { 'background': 'rgba(23,107,135,.28) !important' },
    };
  }

  /** 把当前主题/字号/行距/字体注入所有已渲染的 iframe */
  function applyStyles() {
    const r = state.rendition;
    if (!r || !r.themes) return;
    try {
      r.themes.register('app-reader', themeRules());
      r.themes.select('app-reader');
      r.themes.fontSize(`${state.settings.fontSize}%`);
    } catch (_) { /* 主题注入失败不该打断阅读 */ }
  }

  function getSettings() {
    return { ...state.settings };
  }

  function setSettings(patch) {
    const next = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch && key in patch) next[key] = patch[key];
    }
    if (!Object.keys(next).length) return getSettings();
    state.settings = { ...state.settings, ...next };
    state.settings.fontSize = clamp(Number(state.settings.fontSize) || 100, 60, 300);
    state.settings.lineHeight = clamp(Number(state.settings.lineHeight) || 1.6, 1.2, 2.4);
    if (!FONT_STACKS[state.settings.fontFamily] && state.settings.fontFamily !== '') state.settings.fontFamily = '';
    if (!THEMES[state.settings.theme]) state.settings.theme = 'light';
    if (state.settings.flow !== 'scrolled') state.settings.flow = 'paginated';

    const r = state.rendition;
    if (r && isOpen()) {
      if ('flow' in next) {
        try { r.flow(state.settings.flow); } catch (_) { /* ignore */ }
      }
      applyStyles();
    }
    return getSettings();
  }

  /** 循环切换主题：浅色 → 米黄 → 深色 → 浅色 */
  function cycleTheme() {
    const idx = THEME_ORDER.indexOf(state.settings.theme);
    const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length] || 'light';
    setSettings({ theme: next });
    return state.settings.theme;
  }

  // ==================== 打开 / 销毁 ====================

  /**
   * @param {{url:string, container:HTMLElement, recordId?:string, startCfi?:string, settings?:object,
   *          hooks?:{onLocation?:Function, onSelection?:Function, onTocReady?:Function, onRendered?:Function, onError?:Function}}} opts
   */
  async function open(opts) {
    const o = opts || {};
    if (!o.url || !o.container) throw new Error('open() 需要 url 与 container');
    await close();

    const provided = o.settings || {};
    // 只接受显式给到的值：展开 undefined 会把默认偏好一起覆盖掉
    const cleanSettings = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (provided[key] !== undefined && provided[key] !== null) cleanSettings[key] = provided[key];
    }
    state.settings = { ...DEFAULT_SETTINGS, ...cleanSettings };
    state.hooks = o.hooks || {};
    state.recordId = o.recordId || null;
    state.container = o.container;
    state.highlights.clear();
    state.locationsReady = false;
    state.location = { href: '', cfi: null, percentage: null, chapterIndex: 0, chapterTotal: 0 };
    state.destroyed = false;

    const book = lib()(o.url);
    state.book = book;

    // 目录（book.ready 后 navigation 才可用；单独 catch，目录失败不影响阅读）
    book.loaded.navigation.then((nav) => {
      state.toc = (nav && nav.toc) || [];
      state.tocFlat = flattenToc(state.toc, 0, []);
      state.location.chapterTotal = state.tocFlat.length;
      if (typeof state.hooks.onTocReady === 'function') state.hooks.onTocReady(state.tocFlat);
    }).catch(() => {
      state.tocFlat = [];
      if (typeof state.hooks.onTocReady === 'function') state.hooks.onTocReady([]);
    });

    await book.ready;

    const rendition = book.renderTo(o.container, {
      width: '100%',
      height: '100%',
      flow: state.settings.flow,
      spread: 'auto',
      allowScriptedContent: false,
    });
    state.rendition = rendition;

    // 每个章节 iframe 渲染好之后：补注入样式 + 清理活动内容
    rendition.on('rendered', () => {
      applyStyles();
      if (typeof state.hooks.onRendered === 'function') state.hooks.onRendered();
    });

    // 注入内容钩子：拦住 EPUB 内部的外链跳转与脚本（安全边界）
    if (rendition.hooks && rendition.hooks.content) {
      rendition.hooks.content.register((contents) => {
        try {
          const doc = contents.document;
          doc.addEventListener('click', (e) => {
            const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a) return;
            const href = a.getAttribute('href') || '';
            if (/^https?:/i.test(href)) { e.preventDefault(); e.stopPropagation(); }
          }, true);
        } catch (_) { /* ignore */ }
      });
    }

    // 选中文字 → 交给 app.js 走既有的划词翻译链路
    // 注意：选区矩形是相对 iframe 的坐标，必须加上 iframe 的偏移才是主文档坐标，
    // 否则浮出来的划词工具条会飞到错误的位置。
    rendition.on('selected', (cfiRange, contents) => {
      if (!contents) return;
      let text = '';
      let rects = [];
      try {
        const selection = contents.window.getSelection();
        text = selection.toString();
        if (selection && selection.rangeCount) {
          const frame = contents.document.defaultView.frameElement;
          const offset = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
          rects = [...selection.getRangeAt(0).getClientRects()]
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => ({
              left: r.left + offset.left, top: r.top + offset.top,
              right: r.right + offset.left, bottom: r.bottom + offset.top,
              width: r.width, height: r.height,
            }));
        }
      } catch (_) { /* ignore */ }
      if (!String(text || '').trim()) return;
      if (typeof state.hooks.onSelection === 'function') {
        state.hooks.onSelection({ text: text, cfi: cfiRange, clientRects: rects });
      }
    });

    // 位置变化 → 记录进度（章节 + 百分比）并通知外部
    rendition.on('relocated', (loc) => {
      if (!loc || !loc.start) return;
      const href = loc.start.href || '';
      const idx = currentChapterIndex(href);
      state.location.href = href;
      state.location.cfi = loc.start.cfi || null;
      state.location.chapterIndex = idx >= 0 ? idx : state.location.chapterIndex;
      if (loc.start.percentage !== undefined && loc.start.percentage !== null) {
        state.location.percentage = Math.round(loc.start.percentage * 100);
      }
      if (typeof state.hooks.onLocation === 'function') state.hooks.onLocation({ ...state.location });
    });

    rendition.on('displayError', (err) => {
      if (typeof state.hooks.onError === 'function') state.hooks.onError(err);
    });

    applyStyles();
    await rendition.display(o.startCfi || undefined);

    // 重新挂上一本文献已有的批注（在 display 之后，避免早于首个 iframe）
    if (Array.isArray(o.annotations)) {
      for (const ann of o.annotations) attachAnnotation(ann);
    }

    // 进度百分比需要预先索引全文，大书要几秒：放后台跑，不阻塞首屏
    book.locations.generate(1600).then(() => {
      state.locationsReady = true;
      if (typeof state.hooks.onLocation === 'function' && state.location.cfi) {
        try {
          const pct = Math.round(book.locations.percentageFromCfi(state.location.cfi) * 100);
          if (Number.isFinite(pct)) {
            state.location.percentage = pct;
            state.hooks.onLocation({ ...state.location });
          }
        } catch (_) { /* ignore */ }
      }
    }).catch(() => { /* 生成失败就只显示章节序号 */ });

    return true;
  }

  async function close() {
    const r = state.rendition;
    const b = state.book;
    state.destroyed = true;
    state.rendition = null;
    state.book = null;
    state.container = null;
    state.toc = [];
    state.tocFlat = [];
    state.highlights.clear();
    state.hooks = {};
    // destroy 会连带移除插入的 iframe/容器；每一步单独兜底，避免一处报错留下残骸
    if (r) { try { r.destroy(); } catch (_) { /* ignore */ } }
    if (b) { try { b.destroy(); } catch (_) { /* ignore */ } }
    return true;
  }

  // ==================== 导航 ====================

  function goTo(target) {
    if (!isOpen() || !target) return false;
    try { state.rendition.display(target); return true; } catch (_) { return false; }
  }

  function goToChapter(index) {
    const item = state.tocFlat[index];
    if (!item) return false;
    return goTo(item.href);
  }

  function stepChapter(delta) {
    if (!isOpen() || !state.tocFlat.length) return false;
    const current = currentChapterIndex(state.location.href);
    const base = current >= 0 ? current : 0;
    const next = clamp(base + delta, 0, state.tocFlat.length - 1);
    if (next === base && current >= 0) return false;
    return goToChapter(next);
  }

  /** 下一页 / 上一页（epub.js 的 prev/next 会跨章节） */
  function pagePrev() {
    if (!isOpen()) return false;
    try { state.rendition.prev(); return true; } catch (_) { return false; }
  }

  function pageNext() {
    if (!isOpen()) return false;
    try { state.rendition.next(); return true; } catch (_) { return false; }
  }

  function currentCfi() {
    return state.location.cfi || null;
  }

  function getLocation() {
    return { ...state.location };
  }

  /**
   * 当前章节的纯文字（供「总结本章」用）。
   * 取 rendition 当前已渲染的 contents —— 分页模式下就是屏幕上的这一章（含跨栏的整章），
   * 不需要把整本书都解析一遍，代价可控。限长避免超长章节撑爆上下文。
   */
  function currentChapterText(limit = 8000) {
    if (!isOpen()) return '';
    let text = '';
    try {
      const contents = (state.rendition.getContents && state.rendition.getContents()) || [];
      for (const c of contents) {
        try {
          const doc = c && c.document;
          if (!doc || !doc.body) continue;
          const t = doc.body.innerText || doc.body.textContent || '';
          if (t) text += (text ? '\n' : '') + t;
        } catch (_) { /* 单节读取失败跳过 */ }
      }
    } catch (_) { /* ignore */ }
    return text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
  }

  /** 当前章节名（目录里已定位到的那一条，取不到就给「正文」） */
  function currentChapterLabel() {
    const item = state.tocFlat[state.location.chapterIndex];
    return (item && item.label) || '正文';
  }

  // ==================== 批注 ====================

  const HIGHLIGHT_FILL = {
    yellow: '#ffe08a', green: '#b5e6b5', blue: '#a8d4f5', pink: '#f7b8d0',
  };
  // 我们的批注类型 → epub.js 的注解类型（epub.js 把「文字批注」叫 mark）
  const KIND_TO_EPUB = { highlight: 'highlight', underline: 'underline', note: 'mark' };

  function kindOf(ann) {
    const t = ann && ann.type;
    return (t === 'underline' || t === 'note') ? t : 'highlight';
  }

  /**
   * 挂一条批注。ann.cfi 是 EPUB 定位（与 PDF 的 page+rect 并列，互不干扰）。
   * @param {{id:string, cfi:string, type:'highlight'|'underline'|'note', color:string}} ann
   */
  function attachAnnotation(ann) {
    if (!isOpen() || !ann || !ann.cfi) return false;
    const kind = kindOf(ann);
    const color = HIGHLIGHT_FILL[ann.color] || HIGHLIGHT_FILL.yellow;
    const key = `${kind}|${ann.cfi}`;
    if (state.highlights.has(key)) return true;
    try {
      const api = state.rendition.annotations;
      const data = { id: ann.id || '' };
      if (kind === 'underline') {
        api.underline(ann.cfi, data, null, 'ep-underline',
          { 'stroke': color, 'stroke-opacity': '1', 'stroke-width': '2' });
      } else if (kind === 'note') {
        // 文字批注没有颜色可选，统一用琥珀色波浪线标出位置，正文里一眼能看到
        api.mark(ann.cfi, data, null, 'ep-note',
          { 'fill': '#e8a213', 'fill-opacity': '0.34' });
      } else {
        api.highlight(ann.cfi, data, null, 'ep-highlight',
          { 'fill': color, 'fill-opacity': '0.42', 'mix-blend-mode': 'multiply' });
      }
      state.highlights.set(key, { kind: kind, color: color });
      return true;
    } catch (_) {
      return false;
    }
  }

  function detachAnnotation(ann) {
    if (!isOpen() || !ann || !ann.cfi) return false;
    const kind = kindOf(ann);
    try {
      state.rendition.annotations.remove(ann.cfi, KIND_TO_EPUB[kind]);
      state.highlights.delete(`${kind}|${ann.cfi}`);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 切篇时把所有已挂批注卸掉（关闭/换书时 epub.js 会随 rendition 一起销毁） */
  function detachAll() {
    for (const key of [...state.highlights.keys()]) {
      const sep = key.indexOf('|');
      const kind = key.slice(0, sep);
      const cfi = key.slice(sep + 1);
      try { state.rendition && state.rendition.annotations.remove(cfi, KIND_TO_EPUB[kind]); } catch (_) { /* ignore */ }
    }
    state.highlights.clear();
  }

  // ==================== 全文搜索 ====================

  /**
   * 遍历 spine 的每一节取正文做字符串匹配。
   * 命中给出「章节 + 上下文片段」，点击跳转到该章节。
   * （epub.js 自带的 book.search 对部分书不稳定，这里用可控实现，代价是无法精确跳到段内。）
   * @returns {Promise<Array<{chapterIndex:number, label:string, href:string, excerpt:string}>>}
   */
  async function search(keyword, onProgress) {
    const q = String(keyword || '').trim();
    if (!isOpen() || !q) return [];
    const book = state.book;
    const hits = [];
    const needle = q.toLowerCase();
    const sections = [];
    try {
      book.spine.each((section) => { if (section && section.href) sections.push(section); });
    } catch (_) { return []; }

    let done = 0;
    for (const section of sections) {
      done += 1;
      try {
        await section.load(book.load.bind(book));
        const text = String(section.contents ? section.contents.textContent : '').replace(/\s+/g, ' ').trim();
        let from = 0;
        let guard = 0;
        while (guard < 20) {
          const at = text.toLowerCase().indexOf(needle, from);
          if (at < 0) break;
          hits.push({
            chapterIndex: currentChapterIndex(section.href),
            label: chapterLabelOf(section.href),
            href: section.href,
            excerpt: text.slice(Math.max(0, at - 60), Math.min(text.length, at + needle.length + 90)),
          });
          from = at + needle.length;
          guard += 1;
        }
        section.unload();
      } catch (_) { /* 单节解析失败跳过 */ }
      if (typeof onProgress === 'function') onProgress(done, sections.length);
    }
    return hits;
  }

  function chapterLabelOf(href) {
    const clean = (h) => String(h || '').split('#')[0];
    const hit = state.tocFlat.find((t) => clean(t.href) === clean(href));
    return hit ? hit.label : '正文';
  }

  // ==================== 对外接口 ====================

  window.EpubReader = Object.freeze({
    open,
    close,
    isOpen,
    getToc,
    getSettings,
    setSettings,
    cycleTheme,
    goTo,
    goToChapter,
    stepChapter,
    pagePrev,
    pageNext,
    currentCfi,
    getLocation,
    currentChapterText,
    currentChapterLabel,
    attachAnnotation,
    detachAnnotation,
    detachAll,
    search,
    THEMES,
    THEME_ORDER,
    HIGHLIGHT_FILL,
  });
})();
