/**
 * reader-blocks.js —— PDF 版面块叠加层
 *
 * 版面解析（processor 子进程）会把每一页切成一个个「块」：标题 / 正文 / 图表 / 表格 / 公式…
 * 每个块带归一化坐标（0~1，相对**未旋转**的页面）和类型标签。本模块负责：
 *   - 把块按当前页面的显示尺寸（含缩放与旋转）铺到页面上；
 *   - 鼠标悬停时高亮整块并显示类型徽标（像 reader 那样「整块可点」，
 *     而不是让用户去猜一个图表图片的边界在哪）；
 *   - 点击时把块的上下文（文字 / 裁图）交给外部 hooks 去处理（AI 解释、转 LaTeX、看原图）。
 *
 * 设计约束：正文可划词是第一优先级。所以本层的容器与块都是 pointer-events:none，
 * 事件监听挂在 #prPages 上做坐标命中 —— 绝不遮挡 textLayer 的选区。
 */
(function () {
  'use strict';

  /** 类型标签的中文名（与 processor/layout.ts 的 labels 一一对应） */
  const LABELS = {
    doc_title: '大标题', paragraph_title: '小节标题', text: '正文', abstract: '摘要',
    chart: '图表', image: '图片', table: '表格', display_formula: '公式', inline_formula: '行内公式',
    formula_number: '公式编号', figure_title: '图题', algorithm: '算法',
    reference: '参考文献', reference_content: '文献条目',
    footnote: '脚注', vision_footnote: '脚注图', header: '页眉', footer: '页脚',
    header_image: '页眉图', footer_image: '页脚图', number: '编号', seal: '印章',
    aside_text: '旁注', vertical_text: '竖排文字', content: '正文',
  };

  /** 这些是排版装饰，悬停高亮只会碍事，直接跳过 */
  const DECOR = new Set(['header', 'footer', 'header_image', 'footer_image', 'seal', 'number', 'formula_number']);

  /** 带裁图的块（可以放大原图 / 送 AI 看图） */
  const ASSET = new Set(['chart', 'image', 'table', 'display_formula', 'inline_formula', 'header_image', 'footer_image']);

  const state = {
    recordId: null,
    manifest: null,
    byPage: new Map(),   // page -> Block[]（已按面积升序，命中取最小块）
    enabled: false,
    activeId: null,
    hoverEl: null,
    hoverWrap: null,
    badgeEl: null,
    pending: false,
    point: null,
    /** 外部注入：几何查询 + 交互回调 */
    hooks: {},
  };

  function $(id) { return document.getElementById(id); }
  /** 坐标工具（pdf-reader-utils.js 暴露在 window.PdfReaderUtils 上）。
   *  这里懒取：脚本顺序万一变了也不会在加载期就崩。 */
  function U() { return window.PdfReaderUtils; }
  function blocksFor(page) { return state.byPage.get(page) || []; }
  function labelOf(b) { return LABELS[b.label] || b.label || '区域'; }
  function isAsset(b) { return ASSET.has(b.label) && !!b.image; }

  // ---------- 几何 ----------

  /**
   * 块的归一化坐标（未旋转）→ 页面上显示用的百分比。
   * 页面被用户旋转过时，必须先把坐标转到「显示坐标系」，否则框会歪。
   */
  function toPercent(b, geo) {
    const { w, h, rotation } = geo;
    const raw = [b.x * w, b.y * h, (b.x + b.width) * w, (b.y + b.height) * h];
    const r = U().toDisplayRect(raw, { w, h }, rotation);
    const disp = U().getDisplaySize({ w, h }, rotation);
    if (!disp.w || !disp.h) return null;
    return {
      left: (r.x1 / disp.w) * 100,
      top: (r.y1 / disp.h) * 100,
      width: ((r.x2 - r.x1) / disp.w) * 100,
      height: ((r.y2 - r.y1) / disp.h) * 100,
    };
  }

  /** 鼠标位置（相对页面）→ 未旋转坐标系下的归一化点 */
  function toCanonicalPoint(clientX, clientY, wrap, geo) {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    const disp = U().getDisplaySize({ w: geo.w, h: geo.h }, geo.rotation);
    // 坑：这两个工具函数的入参形态不一致 —— toDisplayRect 收数组 [x1,y1,x2,y2]，
    // toCanonicalRect 收对象 {x1,y1,x2,y2}。传错不会抛错，只会静默算出 NaN，
    // 表现出来就是「悬停永远命不中」。
    const can = U().toCanonicalRect(
      { x1: nx * disp.w, y1: ny * disp.h, x2: nx * disp.w, y2: ny * disp.h },
      { w: geo.w, h: geo.h },
      geo.rotation,
    );
    if (!geo.w || !geo.h) return null;
    return { x: can.x1 / geo.w, y: can.y1 / geo.h };
  }

  // ---------- 命中 ----------

  function hit(page, x, y) {
    const list = blocksFor(page);
    let best = null;
    for (const b of list) {
      if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height) continue;
      // 嵌套时取最小的那个（比如公式在表格里）
      if (!best || b.width * b.height < best.width * best.height) best = b;
    }
    return best;
  }

  // ---------- 绘制 ----------

  function ensureHoverNodes() {
    if (!state.hoverEl) {
      const el = document.createElement('div');
      el.className = 'pr-block-hover';
      el.setAttribute('aria-hidden', 'true');
      state.hoverEl = el;
    }
    if (!state.badgeEl) {
      const b = document.createElement('div');
      b.className = 'pr-block-badge';
      b.setAttribute('aria-hidden', 'true');
      state.badgeEl = b;
    }
  }

  function hideHover() {
    state.activeId = null;
    state.point = null;
    // 顺手把命中结果也清掉。否则「先悬停 A 块，再点到空白处」时 activeBlock 还是 A，
    // 点击就会拿着上一块的上下文去响应（打开不相干的预览）。
    state.activeBlock = null;
    if (state.hoverEl?.parentElement) state.hoverEl.remove();
    if (state.badgeEl?.parentElement) state.badgeEl.remove();
    state.hoverWrap = null;
  }

  function paintHover(block, wrap, geo) {
    const p = toPercent(block, geo);
    if (!p) return;
    ensureHoverNodes();
    const el = state.hoverEl;
    el.dataset.kind = isAsset(block) ? 'asset' : 'text';
    el.style.left = p.left + '%';
    el.style.top = p.top + '%';
    el.style.width = p.width + '%';
    el.style.height = p.height + '%';
    if (el.parentElement !== wrap) wrap.appendChild(el);

    const badge = state.badgeEl;
    badge.textContent = labelOf(block);
    badge.dataset.kind = isAsset(block) ? 'asset' : 'text';
    // 徽标贴在块的左上角；块太靠顶部时改为压在块内，避免被页面裁掉
    const nearTop = p.top < 3;
    badge.style.left = p.left + '%';
    badge.style.top = nearTop ? `calc(${p.top}% + 2px)` : `calc(${p.top}% - 20px)`;
    if (badge.parentElement !== wrap) wrap.appendChild(badge);
  }

  // ---------- 事件 ----------

  function handleMove(event) {
    if (!state.enabled || !state.manifest) return;
    // 正在划词或拖着鼠标：让路给选区，不显示块高亮
    if (event.buttons || (window.getSelection()?.toString().trim())) {
      if (state.activeId) hideHover();
      return;
    }
    const host = $('prPages');
    if (!host) return;
    const wrap = event.target?.closest?.('.pr-page-wrap');
    if (!wrap || !host.contains(wrap)) {
      if (state.activeId) hideHover();
      return;
    }
    // 刻意不用 requestAnimationFrame 节流：命中判定只是几次算术，开销可忽略；
    // 而 rAF 在后台标签 / 无头环境里可能不触发，会让悬停高亮间歇性失灵。
    applyPoint(wrap, event.clientX, event.clientY);
  }

  function applyPoint(wrap, clientX, clientY) {
    const page = parseInt(wrap.dataset.page, 10);
    const geo = state.hooks.geometry?.(page);
    if (!geo || !geo.w || !geo.h) return hideHover();
    const pt = toCanonicalPoint(clientX, clientY, wrap, geo);
    if (!pt) return hideHover();
    const block = hit(page, pt.x, pt.y);
    if (!block || DECOR.has(block.label)) return hideHover();
    const id = `${block.page}:${block.id}`;
    if (id === state.activeId && state.hoverWrap === wrap) return;
    state.activeId = id;
    state.hoverWrap = wrap;
    state.activeBlock = block;
    paintHover(block, wrap, geo);
    state.hooks.onHover?.(block);
  }

  function handleLeave() {
    if (state.activeId) hideHover();
  }

  function handleClick(event) {
    if (!state.enabled) return;
    // 点在链接 / 按钮 / 输入框上时不抢事件
    if (event.target?.closest?.('a, button, input, textarea, select, [role="button"]')) return;
    // 刚划完词（有选区）说明用户不是想点块 —— 划词永远优先
    if (window.getSelection()?.toString().trim()) return;
    const host = $('prPages');
    const wrap = event.target?.closest?.('.pr-page-wrap');
    if (!host || !wrap || !host.contains(wrap)) return;
    // 触屏或快速点击时 hover 可能还没跑，这里按坐标现算一次
    applyPoint(wrap, event.clientX, event.clientY);
    const block = state.activeBlock;
    if (!block) return;
    // onPick 由调用方注入：对照精读用它做「点原文哪里，译文就跳到哪」，
    // 那时正文块也要能点。没注入 onPick 时保持原行为 —— 只有带裁图的块
    // （图表 / 表格 / 公式）响应点击，正文块留给划词。
    if (state.hooks.onPick) {
      event.preventDefault();
      event.stopPropagation();
      state.hooks.onPick(block, { asset: isAsset(block), label: labelOf(block) });
      return;
    }
    // 只有带裁图的块响应点击；正文块交给划词，不抢交互
    if (!isAsset(block)) return;
    event.preventDefault();
    event.stopPropagation();
    state.hooks.onActivate?.(block, { asset: true, label: labelOf(block) });
  }

  function handleScroll() {
    if (state.activeId) hideHover();
  }

  // ---------- 对外接口 ----------

  /** 装载一篇文献的解析结果；传 null 表示清空 */
  function setManifest(recordId, manifest) {
    state.recordId = recordId || null;
    state.manifest = manifest || null;
    state.byPage.clear();
    hideHover();
    state.activeBlock = null;
    if (manifest?.blocks?.length) {
      for (const b of manifest.blocks) {
        if (!Number.isFinite(b?.page) || !b?.bounds) continue;
        const flat = {
          id: b.id, page: b.page, label: b.label, text: b.text || '', image: b.image || '',
          x: b.bounds.x, y: b.bounds.y, width: b.bounds.width, height: b.bounds.height,
        };
        if (!state.byPage.has(flat.page)) state.byPage.set(flat.page, []);
        state.byPage.get(flat.page).push(flat);
      }
    }
    state.enabled = state.byPage.size > 0;
    if (!state.enabled) hideHover();
    state.hooks.onChange?.(state.enabled);
  }

  function clear() { setManifest(null, null); }

  function setEnabled(on) { state.enabled = !!on && state.byPage.size > 0; }

  function isEnabled() { return state.enabled; }

  function getBlock(id, page) {
    for (const b of blocksFor(page)) if (b.id === id) return b;
    return null;
  }

  /** 块在页面上的显示矩形（百分比），供外部定位（如「跳到该块」） */
  function blockPercent(block) {
    const geo = state.hooks.geometry?.(block.page);
    if (!geo) return null;
    return toPercent(block, geo);
  }

  function bind() {
    const host = $('prPages');
    if (!host || host.dataset.blocksBound === '1') return;
    host.dataset.blocksBound = '1';
    host.addEventListener('pointermove', handleMove, { passive: true });
    host.addEventListener('pointerleave', handleLeave, { passive: true });
    host.addEventListener('click', handleClick, true);
    host.addEventListener('scroll', handleScroll, { passive: true });
  }

  /** 排查用：当前装载状态摘要（不含大对象），便于在控制台确认「为什么没命中」 */
  function debug() {
    return {
      enabled: state.enabled,
      hasManifest: !!state.manifest,
      pageCount: state.byPage.size,
      counts: Object.fromEntries([...state.byPage.entries()].map(([p, l]) => [p, l.length])),
      activeId: state.activeId,
      geometryHook: typeof state.hooks.geometry,
    };
  }

  /** 排查用：给定页面与「未旋转」归一化坐标，返回会命中的块 */
  function hitAt(page, x, y) {
    const b = hit(page, x, y);
    return b ? { id: b.id, label: b.label, x: b.x, y: b.y, width: b.width, height: b.height } : null;
  }

  window.PrBlocks = {
    bind, setManifest, clear, setEnabled, isEnabled, getBlock, blockPercent, debug, hitAt,
    labels: LABELS,
    setHooks(hooks) { Object.assign(state.hooks, hooks || {}); },
    hideHover,
  };
})();
