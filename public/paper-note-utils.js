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

  // ---------- 导图节点框自适应 ----------
  // ★ 这里的设计约束来自 simple-mind-map 库的实现（已读源码确认，改动前请先看）：
  //
  //   1) 节点宽度被 hard-clamp 到 textAutoWrapWidth：
  //        width = Math.min(Math.ceil(width) + 1, textAutoWrapWidth)
  //      所以 textAutoWrapWidth 是**内容区宽度**，节点框实际宽度 = 该值 + 左右内边距。
  //      给多宽，节点框就最多能有多宽；给窄了 → 文字被挤成多行甚至显示不全。
  //
  //   2) 纯文本节点的换行判定是「逐字累加后用真实字体 measureText」：
  //        if (measureText(text).width <= maxWidth) 收进本行，否则换行
  //      用的是**渲染字体（默认主题是 微软雅黑 16px）的真实宽度**，且比较符是 <=。
  //      汉字在微软雅黑下正好等于 fontSize（实测 20 字 = 320.0px），没有小数余量。
  //
  //   3) 因此「估算值」必须留出明确余量，而且这个余量**不能被上界截掉**。
  //      之前版本把上界硬编码成 320（Math.min(320, ...)），
  //      结果 20 字标题算出 320+2=322 → 被截成 320 → 恰等于实测宽度 320.0，
  //      比较符又是 <=，任何亚像素取整都会让最后一个字掉到下一行 / 被裁掉。
  //      这就是「框还是显示不全字」的根因。
  //
  // 结论：上界要放开到「右栏大部分宽度」，并保证余量生效。
  /** 换行阈值的全局上限（内容区宽度）。放开到 620，避免长标题被强行压窄。 */
  const MIND_WRAP_HARD_CAP = 620;
  /** 每行末尾保留的余量（px）：抵消真实字体的亚像素宽度与 getBoundingClientRect 取整。 */
  const MIND_WRAP_SLACK = 6;

  /**
   * 估算一个字符的显示宽度（px @ fontSize）。
   * 中日韩字符与全角标点按 1 个字宽算，ASCII 按约 0.55 算，其余按 0.8。
   * ★ 汉字在微软雅黑下实测就是 fontSize（无小数），这里保持一致，
   *   余量统一交给 MIND_WRAP_SLACK，不要在这里偷偷打折。
   */
  function charWidth(ch, fontSize) {
    const code = ch.codePointAt(0);
    const isFull =
      (code >= 0x2e80 && code <= 0x9fff) ||   // CJK 部首 ~ 统一汉字
      (code >= 0xf900 && code <= 0xfaff) ||   // 兼容汉字
      (code >= 0xff00 && code <= 0xff60) ||   // 全角形式
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x3000 && code <= 0x303f);     // CJK 标点
    if (isFull) return fontSize;
    if (code <= 0x7f) return fontSize * 0.55;
    return fontSize * 0.8;
  }

  /** 单行文本的估算宽度 */
  function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const ch of String(text || '')) w += charWidth(ch, fontSize);
    return w;
  }

  /**
   * 按最长一行算节点文本所需的理想宽度（内容区宽度，不含内边距）。
   * 用于给库的 textAutoWrapWidth 定一个「够放下最长行、但不会太离谱」的值，
   * 这样短文字的框会收紧、长文字会换行把框撑高，而不是把字挤出框外。
   */
  function idealNodeTextWidth(text, opts = {}) {
    const fontSize = Number(opts.fontSize) || 16;
    const min = Number(opts.minWidth) > 0 ? Number(opts.minWidth) : 96;
    const max = Number(opts.maxWidth) > 0 ? Number(opts.maxWidth) : MIND_WRAP_HARD_CAP;
    const lines = String(text || '').split(/\r?\n/);
    let longest = 0;
    for (const line of lines) {
      longest = Math.max(longest, estimateTextWidth(line, fontSize));
    }
    if (!longest) return min;
    // 余量必须在夹取之前加、且夹取只作用于「需求」而不是「需求+余量」，
    // 否则一旦贴到上界，余量就会被 Math.min 吃掉（旧代码的 bug）。
    const want = Math.ceil(longest) + MIND_WRAP_SLACK;
    if (want <= max) return Math.max(want, min);
    // 需求本身超过上界：允许换行，此时上界就是最终宽度。
    return Math.min(Math.max(Math.ceil(longest), min), max);
  }

  /**
   * 扫描整棵导图，取所有节点里「最宽的一行」来决定统一换行宽度。
   * 统一值是必要的：库的 textAutoWrapWidth 是全局配置，无法逐节点设置。
   * 因此取最大值 —— 保证最长的那个节点不被挤，其余节点盒子宽一点无妨。
   */
  function fitMindmapWrapWidth(root, opts = {}) {
    const max = Number(opts.maxWidth) > 0 ? Number(opts.maxWidth) : MIND_WRAP_HARD_CAP;
    const min = Number(opts.minWidth) > 0 ? Number(opts.minWidth) : 96;
    const fontSize = Number(opts.fontSize) || 16;
    let longest = 0;
    const walk = (n) => {
      const t = nodeText(n);
      for (const line of t.split(/\r?\n/)) {
        longest = Math.max(longest, estimateTextWidth(line, fontSize));
      }
      (Array.isArray(n?.children) ? n.children : []).forEach(walk);
    };
    if (root) walk(root);
    if (!longest) return min;
    // 同 idealNodeTextWidth：余量先加、且不参与与上界的夹取，
    // 否则贴边时余量会被吃光，导致「刚好差一点点」的裁字。
    const want = Math.ceil(longest) + MIND_WRAP_SLACK;
    if (want <= max) return Math.max(want, min);
    return Math.min(Math.max(Math.ceil(longest), min), max);
  }

  // ============================================================
  // 导图样式系统（对齐 XMind：结构 / 配色方案 / 背景 / 字体 / 分支线 / 彩虹分支）
  // 参考实现来自 simple-mind-map 的 theme config，字段名与库一致，
  // 由 app.js 转成 mm.setThemeConfig() 的入参。
  // ============================================================

  /** 结构（布局）。value 直接用库的 layout 名，已核对 MindMap.constants.layoutList。 */
  const MIND_LAYOUTS = [
    { value: 'mindMap', name: '思维导图', group: '思维导图' },
    { value: 'logicalStructure', name: '逻辑结构图', group: '逻辑图' },
    { value: 'logicalStructureLeft', name: '向左逻辑结构图', group: '逻辑图' },
    { value: 'catalogOrganization', name: '目录组织图', group: '逻辑图' },
    { value: 'organizationStructure', name: '组织结构图', group: '逻辑图' },
    { value: 'timeline', name: '时间轴', group: '时间轴' },
    { value: 'timeline2', name: '时间轴 2', group: '时间轴' },
    { value: 'verticalTimeline', name: '竖向时间轴', group: '时间轴' },
    { value: 'verticalTimeline2', name: '竖向时间轴 2', group: '时间轴' },
    { value: 'verticalTimeline3', name: '竖向时间轴 3', group: '时间轴' },
    { value: 'fishbone', name: '鱼骨图', group: '鱼骨图' },
    { value: 'fishbone2', name: '鱼骨图 2', group: '鱼骨图' },
    { value: 'rightFishbone', name: '向右鱼骨图', group: '鱼骨图' },
    { value: 'rightFishbone2', name: '向右鱼骨图 2', group: '鱼骨图' },
  ];

  /** 全局字体候选（前两项是 Windows/macOS 都稳妥的中文字体） */
  const MIND_FONTS = [
    { value: '微软雅黑, Microsoft YaHei', name: '微软雅黑' },
    { value: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif', name: '苹方 / 黑体' },
    { value: 'SimSun, "宋体", serif', name: '宋体' },
    { value: 'KaiTi, "楷体", serif', name: '楷体' },
    { value: 'Arial, Helvetica, sans-serif', name: 'Arial' },
    { value: '"Times New Roman", Times, serif', name: 'Times New Roman' },
    { value: 'Consolas, "Courier New", monospace', name: '等宽 Consolas' },
  ];

  /** 分支线粗细候选 */
  const MIND_LINE_WIDTHS = [
    { value: 1, name: '细' },
    { value: 2, name: '默认' },
    { value: 3, name: '中' },
    { value: 4, name: '粗' },
    { value: 6, name: '特粗' },
  ];

  /** 分支线走线方式 */
  const MIND_LINE_STYLES = [
    { value: 'curve', name: '曲线' },
    { value: 'straight', name: '直线' },
  ];

  /**
   * 配色方案（对标 XMind 的「配色方案」）。
   * 每个方案给出：主色（分支线/根节点）、各级节点底色与字色。
   * 字段与库的 themeConfig 一致，便于直接下发。
   */
  const MIND_COLOR_SCHEMES = [
    {
      id: 'classic', name: '经典绿', swatch: ['#549688', '#ffffff', '#8ac6bb'],
      lineColor: '#549688',
      root: { fillColor: '#549688', color: '#ffffff' },
      second: { fillColor: '#ffffff', color: '#565656' },
      node: { fillColor: 'transparent', color: '#6b6b6b' },
    },
    {
      id: 'ocean', name: '海洋蓝', swatch: ['#2b7fd4', '#ffffff', '#7fb6ea'],
      lineColor: '#2b7fd4',
      root: { fillColor: '#2b7fd4', color: '#ffffff' },
      second: { fillColor: '#eaf3fd', color: '#1b4f80' },
      node: { fillColor: 'transparent', color: '#3c5a75' },
    },
    {
      id: 'sunset', name: '活力橙', swatch: ['#e8792b', '#ffffff', '#f6b183'],
      lineColor: '#e8792b',
      root: { fillColor: '#e8792b', color: '#ffffff' },
      second: { fillColor: '#fdf1e7', color: '#8a4413' },
      node: { fillColor: 'transparent', color: '#7a5233' },
    },
    {
      id: 'violet', name: '紫罗兰', swatch: ['#7a5cd6', '#ffffff', '#b8a4ec'],
      lineColor: '#7a5cd6',
      root: { fillColor: '#7a5cd6', color: '#ffffff' },
      second: { fillColor: '#f1ecfd', color: '#4a2f92' },
      node: { fillColor: 'transparent', color: '#5b4a80' },
    },
    {
      id: 'forest', name: '森林', swatch: ['#2f7d54', '#ffffff', '#84bda0'],
      lineColor: '#2f7d54',
      root: { fillColor: '#2f7d54', color: '#ffffff' },
      second: { fillColor: '#e9f4ee', color: '#1d5136' },
      node: { fillColor: 'transparent', color: '#406653' },
    },
    {
      id: 'rose', name: '玫瑰', swatch: ['#d64572', '#ffffff', '#ef9ab4'],
      lineColor: '#d64572',
      root: { fillColor: '#d64572', color: '#ffffff' },
      second: { fillColor: '#fdecf1', color: '#8d1f42' },
      node: { fillColor: 'transparent', color: '#7c4557' },
    },
    {
      id: 'slate', name: '商务灰', swatch: ['#45526b', '#ffffff', '#93a0b8'],
      lineColor: '#45526b',
      root: { fillColor: '#45526b', color: '#ffffff' },
      second: { fillColor: '#eef1f6', color: '#2b3446' },
      node: { fillColor: 'transparent', color: '#5a6478' },
    },
    {
      id: 'mono', name: '极简黑白', swatch: ['#333333', '#ffffff', '#9e9e9e'],
      lineColor: '#333333',
      root: { fillColor: '#333333', color: '#ffffff' },
      second: { fillColor: '#f2f2f2', color: '#222222' },
      node: { fillColor: 'transparent', color: '#555555' },
    },
    {
      id: 'dark', name: '暗夜', swatch: ['#1f2430', '#dfe4ee', '#5b6c8a'],
      lineColor: '#7c8ba1',
      background: '#1f2430',
      root: { fillColor: '#3a4250', color: '#ffffff' },
      second: { fillColor: '#2b3242', color: '#dfe4ee' },
      node: { fillColor: 'transparent', color: '#c3cad8' },
    },
  ];

  /** 深色背景的方案需要配套深色画布，这里集中给出，避免每个方案都写一遍 */
  const MIND_DARK_BG = '#1f2430';

  /**
   * 库对「分支线样式」有结构限制（见库内 defaultTheme 注释）：
   *   curve  仅支持 logicalStructure / mindMap / verticalTimeline
   *   direct 仅支持 logicalStructure / mindMap / organizationStructure / verticalTimeline
   * 在不支持的结构上用了这两者，连线坐标会算不出来（表现为 path 的 d 出现 NaN）。
   * 这里做一层回落：不支持就退成直线（straight，全结构可用）。
   */
  const MIND_CURVE_LAYOUTS = ['logicalStructure', 'mindMap', 'verticalTimeline'];
  const MIND_DIRECT_LAYOUTS = ['logicalStructure', 'mindMap', 'organizationStructure', 'verticalTimeline'];

  function effectiveLineStyle(layout, lineStyle) {
    if (lineStyle === 'curve' && !MIND_CURVE_LAYOUTS.includes(layout)) return 'straight';
    if (lineStyle === 'direct' && !MIND_DIRECT_LAYOUTS.includes(layout)) return 'straight';
    return lineStyle;
  }

  /**
   * 默认样式。空值表示「跟当前配色方案走」，方便用户只改其中一项。
   */
  function defaultMindStyle() {
    return {
      layout: 'mindMap',
      scheme: 'classic',
      backgroundColor: '',        // 空 = 用配色方案/库默认
      fontFamily: '微软雅黑, Microsoft YaHei',
      fontSize: 16,
      lineWidth: 2,
      lineStyle: 'curve',
      rainbow: false,
    };
  }

  /** 取配色方案（找不到时回落第一个） */
  function mindScheme(id) {
    return MIND_COLOR_SCHEMES.find((s) => s.id === id) || MIND_COLOR_SCHEMES[0];
  }

  /** 归一化样式对象：补齐缺省字段、丢弃非法值 */
  function normalizeMindStyle(raw) {
    const base = defaultMindStyle();
    const s = raw && typeof raw === 'object' ? raw : {};
    const out = { ...base };
    if (MIND_LAYOUTS.some((l) => l.value === s.layout)) out.layout = s.layout;
    if (MIND_COLOR_SCHEMES.some((c) => c.id === s.scheme)) out.scheme = s.scheme;
    if (typeof s.backgroundColor === 'string') out.backgroundColor = s.backgroundColor;
    if (MIND_FONTS.some((f) => f.value === s.fontFamily)) out.fontFamily = s.fontFamily;
    const fs = Number(s.fontSize);
    if (Number.isFinite(fs) && fs >= 10 && fs <= 40) out.fontSize = Math.round(fs);
    const lw = Number(s.lineWidth);
    if (Number.isFinite(lw) && lw >= 1 && lw <= 10) out.lineWidth = Math.round(lw);
    if (MIND_LINE_STYLES.some((l) => l.value === s.lineStyle)) out.lineStyle = s.lineStyle;
    out.rainbow = !!s.rainbow;
    return out;
  }

  /**
   * 把「我们的样式对象」翻译成 simple-mind-map 的 themeConfig。
   * 注意：库只认它自己的字段名，这里做一层映射，UI 层就不用关心库的命名。
   *
   * ★ 为什么 root / second / node 必须是**普通对象**而不是 JSON 字符串：
   *   库的默认主题（源码里的 `defaultTheme`）中这三项就是对象，`setThemeConfig`
   *   会把它与默认主题做深度合并，渲染器再从 `themeConfig[节点类型]` 上读
   *   fillColor / fontSize 等字段。
   *   若这里传 `JSON.stringify(...)`，深度合并的结果会把整级样式替换成**字符串**，
   *   后续 `style.fillColor` 全取到 undefined → 分支线路径算出 NaN、
   *   子节点直接渲染不出来（已用真实浏览器复现并修复，勿再改回字符串）。
   */
  function buildMindThemeConfig(style) {
    const s = normalizeMindStyle(style);
    const scheme = mindScheme(s.scheme);
    const font = s.fontFamily;

    // 只覆盖我们真正要控制的三项：字体、字号、以及配色带来的底色/字色。
    // 其余（内边距、圆角、边框…）一律留给库的默认主题，避免把默认观感改掉。
    const nodeStyle = (src) => {
      const out = {};
      if (font) out.fontFamily = font;
      if (Number.isFinite(s.fontSize)) out.fontSize = s.fontSize;
      if (src.fillColor) out.fillColor = src.fillColor;
      if (src.color) out.color = src.color;
      return out;
    };

    const cfg = {
      lineColor: scheme.lineColor,
      lineWidth: s.lineWidth,
      // 结构不支持所选线型时回落，避免连线坐标算出 NaN
      lineStyle: effectiveLineStyle(s.layout, s.lineStyle),
      root: nodeStyle(scheme.root || {}),
      second: nodeStyle(scheme.second || {}),
      node: nodeStyle(scheme.node || {}),
    };
    // 背景：用户显式设过就用用户的，否则用配色方案自带的（如暗夜）
    const bg = s.backgroundColor || scheme.background || '';
    if (bg) cfg.backgroundColor = bg;
    return cfg;
  }

  /** 每个配色方案在按钮上的预览色（用于渲染小色卡） */
  function schemeSwatch(id) {
    return mindScheme(id).swatch || ['#549688', '#ffffff', '#8ac6bb'];
  }

  window.PaperNoteUtils = {
    DEFAULT_PANES,
    MIN_PANE_RATIO,
    MIN_PANE_PX,
    MIND_WRAP_HARD_CAP,
    MIND_WRAP_SLACK,
    MIND_LAYOUTS,
    MIND_FONTS,
    MIND_LINE_WIDTHS,
    MIND_LINE_STYLES,
    MIND_COLOR_SCHEMES,
    MIND_DARK_BG,
    defaultMindStyle,
    normalizeMindStyle,
    mindScheme,
    buildMindThemeConfig,
    effectiveLineStyle,
    schemeSwatch,
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
    charWidth,
    estimateTextWidth,
    idealNodeTextWidth,
    fitMindmapWrapWidth,
  };
})();
