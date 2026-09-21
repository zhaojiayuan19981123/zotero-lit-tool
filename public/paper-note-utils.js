/**
 * paper-note-utils.js —— 笔记模式（三栏）的纯逻辑工具集
 *
 * 与 app.js 分离的原因：这里全是不依赖 DOM / 网络的纯函数，便于用 node:test 直接覆盖。
 * 全项目约定见 public/pdf-reader-utils.js（同样挂在 window 上、同样可测）。
 */
(() => {
  'use strict';

  // ---------- 三栏比例（0.4 : 0.2 : 0.4） ----------
  const DEFAULT_PANES = { left: 0.4, mid: 0.2, right: 0.4 };
  // 任何一栏都不允许被拖到看不见
  const MIN_PANE_RATIO = 0.12;
  const MIN_PANE_PX = 180;

  /** 把任意输入归一化成 {left,mid,right} 且三者之和为 1 */
  function normalizePanes(input) {
    const src = input && typeof input === 'object' ? input : {};
    let left = Number(src.left);
    let mid = Number(src.mid);
    let right = Number(src.right);
    if (!Number.isFinite(left) || left <= 0) left = DEFAULT_PANES.left;
    if (!Number.isFinite(mid) || mid <= 0) mid = DEFAULT_PANES.mid;
    if (!Number.isFinite(right) || right <= 0) right = DEFAULT_PANES.right;
    const sum = left + mid + right;
    if (!sum) return { ...DEFAULT_PANES };
    return { left: left / sum, mid: mid / sum, right: right / sum };
  }

  /**
   * 拖动分隔条后重算三栏比例。
   * @param {'left'|'right'} handle 被拖动的是哪根分隔条
   * @param {number} deltaPx 位移像素（右为正）
   * @param {number} containerPx 容器总宽
   * @param {{left,mid,right}} current 当前比例
   */
  function resizePanes(handle, deltaPx, containerPx, current) {
    const cur = normalizePanes(current);
    const total = Number(containerPx) || 0;
    if (total <= 0) return cur;
    const delta = (Number(deltaPx) || 0) / total;
    // 每栏的像素下限换算成比例下限，保证窄容器下也不会把某一栏压没
    const floor = Math.max(MIN_PANE_RATIO, MIN_PANE_PX / total);

    let { left, mid, right } = cur;
    if (handle === 'left') {
      // 动的是 左｜中 之间的分隔条：left 与 mid 此消彼长，right 不变
      const pair = left + mid;
      let nextLeft = left + delta;
      nextLeft = Math.min(pair - floor, Math.max(floor, nextLeft));
      left = nextLeft;
      mid = pair - left;
    } else {
      // 动的是 中｜右 之间的分隔条：mid 与 right 此消彼长，left 不变
      const pair = mid + right;
      let nextRight = right - delta;
      nextRight = Math.min(pair - floor, Math.max(floor, nextRight));
      right = nextRight;
      mid = pair - right;
    }
    // 兜底：若 right（或 left）本身已小于下限，优先保住它
    if (right < floor) { mid = Math.max(floor, mid - (floor - right)); right = floor; }
    if (left < floor) { mid = Math.max(floor, mid - (floor - left)); left = floor; }

    return normalizePanes({ left, mid, right });
  }

  /** 比例 → 百分比字符串，用于 flex-basis */
  function paneFlex(ratio) {
    const n = Number(ratio);
    const pct = Number.isFinite(n) && n > 0 ? n * 100 : 0;
    return pct.toFixed(4) + '%';
  }

  // ---------- 笔记 ↔ 思维导图互转 ----------
  /** 取节点的纯文本（库里的 text 是富文本 HTML，需剥标签） */
  function nodeText(node) {
    const raw = node && node.data && node.data.text != null ? String(node.data.text) : '';
    return stripHtml(raw);
  }

  function stripHtml(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  let uidSeq = 0;
  function nextUid() {
    uidSeq += 1;
    return 'pn-' + Date.now().toString(36) + '-' + uidSeq.toString(36);
  }

  /**
   * Markdown 大纲 → 思维导图数据。
   * 规则：`#` 标题按层级成父子；`-`/`*`/`+`/数字列表按缩进成父子；
   * 普通段落挂到当前最近的标题下。第一条内容若没有标题，则作为中心主题。
   */
  function mdToMindmap(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const roots = [];       // 顶层节点（通常只有一个 = 中心主题）
    const stack = [];       // [{level, node}] 标题栈；level 为 # 的数量
    const listStack = [];   // [{indent, node}] 列表栈
    let docTitle = '';
    let inFence = false;    // 是否处于 ``` 代码块内部（内部内容一律不成节点）

    const pushRoot = (node) => { roots.push(node); };
    /** 标题只能挂到标题栈，绝不能挂到列表节点下 */
    const attachHeading = (node) => {
      if (stack.length) { stack[stack.length - 1].node.children.push(node); return; }
      pushRoot(node);
    };
    const mk = (text) => ({ data: { text, uid: nextUid() }, children: [] });

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');

      // 代码围栏：标记行与块内所有内容都不作为节点
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;

      if (!line.trim()) continue;

      // 表格 / 引用块：不作为节点，跳过避免噪音
      if (/^\s*\|/.test(line)) continue;
      if (/^\s*>/.test(line)) continue;

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        const text = heading[2].trim();
        if (!text) continue;
        const node = mk(text);
        if (!docTitle && level === 1 && !roots.length) {
          // 第一个一级标题直接作为中心主题
          docTitle = text;
          pushRoot(node);
          stack.length = 0;
        } else {
          // 先按层级把栈弹到正确的父级，再挂节点（顺序不能颠倒）
          while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
          attachHeading(node);
        }
        stack.push({ level, node });
        listStack.length = 0;
        continue;
      }

      const item = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (item) {
        const indent = item[1].replace(/\t/g, '  ').length;
        let text = item[2].trim();
        // 去掉常见 Markdown 行内强调，保留纯文字
        text = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
        if (!text) continue;
        const node = mk(text);
        while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop();
        if (listStack.length) listStack[listStack.length - 1].node.children.push(node);
        else if (stack.length) stack[stack.length - 1].node.children.push(node);
        else if (roots.length) roots[0].children.push(node);
        else pushRoot(node);
        listStack.push({ indent, node });
        continue;
      }

      // 普通段落：作为当前标题下的一个子节点（过长则截断，避免节点巨大）
      let text = line.trim()
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1');
      if (!text || /^[-=_]{3,}$/.test(text)) continue;
      if (text.length > 120) text = text.slice(0, 120) + '…';
      listStack.length = 0;
      const node = mk(text);
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else if (roots.length) roots[0].children.push(node);
      else pushRoot(node);
    }

    if (!roots.length) return null;
    // 若第一个根不是文档标题且后面还有根，说明没识别到中心主题，造一个
    if (roots.length === 1) return roots[0];
    const synthetic = { data: { text: docTitle || '笔记大纲', uid: nextUid() }, children: roots };
    return synthetic;
  }

  /** 思维导图数据 → Markdown 大纲（缩进列表） */
  function mindmapToMd(root) {
    if (!root || typeof root !== 'object') return '';
    const lines = [];
    const walk = (node, depth) => {
      const text = nodeText(node);
      const children = Array.isArray(node.children) ? node.children : [];
      if (depth === 0) {
        // 中心主题作为一级标题
        lines.push('# ' + (text || '中心主题'), '');
      } else {
        lines.push('  '.repeat(depth - 1) + '- ' + (text || '(未命名)'));
      }
      children.forEach((c) => walk(c, depth + 1));
      if (depth === 0 && children.length) lines.push('');
    };
    walk(root, 0);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 统计思维导图节点总数（含中心主题） */
  function countNodes(node) {
    if (!node || typeof node !== 'object') return 0;
    const children = Array.isArray(node.children) ? node.children : [];
    return 1 + children.reduce((sum, c) => sum + countNodes(c), 0);
  }

  /** 把一段「原文 + 译文」整理成可插入笔记的 Markdown 片段 */
  function buildNoteSnippet(source, translation, opts = {}) {
    const src = String(source || '').trim();
    const trans = String(translation || '').trim();
    if (!src && !trans) return '';
    const quoted = src
      ? src.split(/\r?\n/).map((l) => '> ' + l).join('\n')
      : '> （无原文）';
    const out = [quoted];
    if (trans) out.push('', trans);
    if (opts.heading) out.unshift('### ' + String(opts.heading).trim(), '');
    return out.join('\n');
  }

  /**
   * 把片段插入到已有文本的 [start,end) 处，并在需要时补换行。
   * 返回 {text, cursor} —— cursor 是插入后光标应处的位置。
   */
  function insertSnippet(existing, snippet, start, end) {
    const base = String(existing || '');
    const s = Math.max(0, Math.min(Number(start) || 0, base.length));
    const e = Math.max(s, Math.min(Number(end) || s, base.length));
    const before = base.slice(0, s);
    const after = base.slice(e);
    const ins = String(snippet || '');
    // 保证与前后内容之间有换行分隔
    const needLead = before && !/\n\s*$/.test(before) ? '\n\n' : '';
    const needTail = after && !/^\s*\n/.test(after) ? '\n\n' : '';
    const text = before + needLead + ins + needTail + after;
    const cursor = s + needLead.length + ins.length;
    return { text, cursor };
  }

  /** 笔记内容是否算「空」（两种视图都空才提示未填写） */
  function isNoteEmpty(note) {
    const md = String(note?.md || '').trim();
    if (md) return false;
    const root = note?.mindmap;
    if (root && countNodes(root) > 1) return false;
    if (root && nodeText(root)) return false;
    return true;
  }

  window.PaperNoteUtils = {
    DEFAULT_PANES,
    MIN_PANE_RATIO,
    MIN_PANE_PX,
    normalizePanes,
    resizePanes,
    paneFlex,
    stripHtml,
    nodeText,
    nextUid,
    mdToMindmap,
    mindmapToMd,
    countNodes,
    buildNoteSnippet,
    insertSnippet,
    isNoteEmpty,
  };
})();
