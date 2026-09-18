// reflow.js —— 重排模式：把论文还原成「单栏文本流」，生成全新的 PDF
//
// 与 mono / dual 的根本区别：
//   mono / dual 是「在原页面上动手脚」——译文必须塞进原文的文本框，遇到双栏、
//   窄栏、绕图排版时字会越挤越小，还得靠缩小字号硬塞，越读越累。
//   reflow 干脆**丢掉原版面**：按阅读顺序把内容抽成一条单栏流，用一套统一的
//   排版规则重排（A4 单栏、正文 10~12pt 按原文自动放大、行距 1.65、首行缩进 2 字、多级标题）。
//   这是 doc2x 那一类「版面还原（Layout Restoration）→ 单栏文本流」的做法。
//
// 保真策略（丢掉版面的同时尽量不丢内容）：
//   · 文字：全部译文，按 kind 分成 标题 / 多级小节 / 正文 / 图注 / 参考文献
//   · 公式、表格：这些是非译文内容，直接把**原文对应区域裁下来**贴回新文档
//     （pdf-lib 的 embedPage 支持按包围盒裁剪），既不丢公式，也不会被机翻糟蹋
//   · 插图：analyze 阶段探到的图片区域同样裁剪粘贴
//   · 页眉页脚：analyze 已用 markRepeatingFurniture 标为 furniture，这里直接丢弃
//
// 已知取舍：
//   · 带 /Rotate 的页面不做裁剪（坐标系要额外变换，横排论文里极少见），
//     改为留一行占位说明，避免贴歪
//   · 不保留双栏的并排关系、不保留环绕排版——这正是「重排」的代价
import { PDFDocument } from 'pdf-lib';
import { tokenize, applyLineBreakRules, hardSplit, sanitizeForPdf } from './layout.js';
import { toUint8Array } from './util.js';
import { drawLines } from './paint.js';
import { buildStrokeTable } from './fontMetrics.js';
import fontkit from '@pdf-lib/fontkit';

// A4（pt）
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = { top: 64, right: 56, bottom: 64, left: 56 };
const CONTENT_W = PAGE_W - MARGIN.left - MARGIN.right;

/** 裁下来的公式/插图最多放大到这个倍数（详见 placeCrop 注释） */
const MAX_CROP_UPSCALE = 2;

export const REFLOW_DEFAULTS = {
  reflowKeepFigures: true,  // 是否把公式/表格/插图裁下来贴回重排文档
  reflowIndent: true,       // 正文段落首行缩进两字
  reflowLineHeight: 1.65,   // 正文行距倍数
  reflowTitlePage: false,   // 是否给标题单独起一页
  respectBold: true,        // 原文加粗的段落（强调句等）也跟着加粗
  // 正文基准字号由 options.fontSize 控制：0 = 按原文正文自动放大（10~12pt），
  // >0 = 全篇统一到该 pt。这里不再另设一个 reflowFontSize，免得两个开关互相打架。
};

/**
 * 正文块的阅读顺序。
 *
 * analyze 里的排序是「自上而下、同高从左到右」，单栏页面没问题，但双栏页面会把
 * 左右两栏同一高度的段落交错在一起（左栏第 3 段 → 右栏第 3 段 → 左栏第 4 段…），
 * 直接拿来重排会读得前言不搭后语。
 *
 * 这里改用「栏带」切分：
 *   1) 判定通栏块（横向跨越页面中线，如大标题、通栏摘要、跨栏表格）
 *   2) 通栏块把页面切成若干横带
 *   3) 每条横带内部先排左栏（自上而下）再排右栏
 * 这套规则对单栏文档是恒等变换（只有一条带、没有栏序问题），所以可以统一使用。
 */
export function readingOrder(pageInfo) {
  const blocks = pageInfo.blocks.filter((b) => b.kind !== 'furniture');
  if (!blocks.length) return [];

  const cols = pageInfo.columns || [];
  const mid = cols.length === 2 ? cols[0].x1 : null;
  const spansAll = (b) => !mid || (b.x0 < mid - 4 && b.x1 > mid + 4);

  const byY = blocks.slice().sort((a, b) => (b.y1 - a.y1) || (a.x0 - b.x0));
  const bands = [];
  let cur = [];
  const flush = () => { if (cur.length) { bands.push(cur); cur = []; } };

  for (const b of byY) {
    if (spansAll(b)) {
      flush();
      bands.push([b]);          // 通栏块自成一带
    } else {
      cur.push(b);
    }
  }
  flush();

  const out = [];
  for (const band of bands) {
    band.sort((a, b) => (a.column - b.column) || (b.y1 - a.y1) || (a.x0 - b.x0));
    out.push(...band);
  }
  return out;
}

/**
 * 给标题类块定级：按字号去重降序 → h2/h3/h4/h5。
 *
 * 这里必须**只对 heading 定级，其余照 kind 原样映射**。曾经写成「查不到字号就归 h3」，
 * 结果正文（body）查不到字号，整篇论文都被当成 h3 标题渲染：全篇加粗、放大 1.16 倍、
 * 没有首行缩进——重排成品完全不能读。这个映射是重排排版的地基，改之前先想清楚。
 */
function assignHeadingLevels(pages) {
  const sizes = new Set();
  for (const p of pages) {
    for (const b of p.blocks) {
      if (b.kind === 'heading') sizes.add(Math.round(b.size * 2) / 2);
    }
  }
  const ranked = [...sizes].sort((a, b) => b - a);
  return (block) => {
    if (block.kind === 'title') return 'title';
    if (block.kind === 'heading') {
      const i = ranked.indexOf(Math.round(block.size * 2) / 2);
      // 字号最大的那档 → h2，依次往下；同档字号归同一级
      return ['h2', 'h3', 'h4', 'h5'][Math.min(Math.max(i, 0), 3)];
    }
    if (block.kind === 'caption') return 'caption';
    if (block.kind === 'reference') return 'ref';
    return 'body';
  };
}

/** 两个矩形是否高度重叠（用于去掉「图片区域」与「图注块」重复裁剪） */
function overlaps(a, b, threshold = 0.55) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return false;
  const inter = w * h;
  const smaller = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return smaller > 0 && inter / smaller > threshold;
}

/**
 * 把 analyze 结果整理成一条「元素流」：文字元素 + 裁剪元素，按阅读顺序排列。
 * 导出出来是为了可测试（测试可以直接断言顺序与元素构成，不用渲染）。
 */
export function buildElements(pages, opts = {}) {
  const levelOf = assignHeadingLevels(pages);
  const elements = [];
  const stats = { text: 0, headings: 0, figures: 0, formulas: 0, tables: 0, skippedRotated: 0 };

  for (const page of pages) {
    const ordered = readingOrder(page);
    // 每个块在阅读顺序里的名次，就是它在重排文档里的位置。
    //
    // 这里刻意**不再按纵坐标排序**：readingOrder 已经把双栏拆成「左栏读完再读右栏」，
    // 一旦回头按 y 排，同高度的左右栏段落又会被交错回去（左3、右3、左4…），
    // 前面算的阅读顺序全白费。名次是唯一的排序依据，y 只在名次相同时做兜底。
    const rankOf = new Map();
    ordered.forEach((b, i) => rankOf.set(b, i));

    const textRects = ordered
      .filter((b) => b.translatable)
      .map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
    const rotated = ((page.rotate || 0) % 360 + 360) % 360 !== 0;
    const crops = [];

    // 1) 非译文的文字块（公式/表格/参考文献片段）：裁下来贴回，不丢内容
    for (const b of ordered) {
      if (b.translatable) continue;
      if (b.kind === 'furniture' || b.kind === 'reference') continue;
      if ((b.x1 - b.x0) < 12 || (b.y1 - b.y0) < 6) continue;
      const kind = b.tableLike ? 'tables' : 'formulas';
      crops.push({ kind, rect: padRect(b, 1.5), block: b });
    }
    // 2) 图片区域
    if (opts.reflowKeepFigures !== false) {
      for (const img of page.images || []) {
        // 面积过小的（图标、logo、公式小图）不值得单独占位
        if ((img.x1 - img.x0) * (img.y1 - img.y0) < 2200) continue;
        // 与已裁剪区域重复的跳过
        if (crops.some((c) => overlaps(c.rect, img))) continue;
        // 与正文块重叠的（当作底板/水印）跳过
        if (textRects.some((r) => overlaps(r, img, 0.3))) continue;
        crops.push({ kind: 'figures', rect: padRect(img, 1.5) });
      }
    }

    // 3) 文字与裁剪元素混进同一条流，按阅读顺序名次落位
    const items = [];
    for (const b of ordered) {
      if (!b.translatable) continue;
      const text = sanitizeForPdf(b.translation || b.text);
      if (!text) continue;
      items.push({ order: rankOf.get(b), y: b.y1, seq: items.length, el: { type: 'text', level: levelOf(b), text, sourceBold: !!b.bold, size: b.size } });
      stats.text++;
      if (levelOf(b) !== 'body' && levelOf(b) !== 'caption' && levelOf(b) !== 'ref') stats.headings++;
    }
    for (const c of crops) {
      if (rotated) { stats.skippedRotated++; continue; }
      items.push({
        order: cropOrder(c, ordered, rankOf, page),
        y: c.rect.y1,
        seq: items.length,
        el: {
          type: 'crop',
          pageIndex: page.index,
          rect: c.rect,
          caption: c.block ? sanitizeForPdf(c.block.text).slice(0, 120) : '',
          kind: c.kind,
        },
      });
      stats[c.kind] = (stats[c.kind] || 0) + 1;
    }

    items.sort((a, b) => (a.order - b.order) || (b.y - a.y) || (a.seq - b.seq));
    elements.push(...items.map((i) => i.el));
  }
  return { elements, stats };
}

/**
 * 裁剪元素该插在阅读顺序的哪个名次。
 *
 * 来自文字块的裁剪（公式/表格）直接用它自己块的名次——readingOrder 早就把它放对位置了。
 * 图片没有对应块，只能按「跟栏内块的先后关系」反推：找到阅读顺序里第一个排在它之后的块。
 * 判「之后」用与 readingOrder 同一套规则（先比栏号，同栏再比纵坐标），
 * 这样右栏的插图会落在「左栏读完、右栏开头」，而不是被拽到左栏中间去。
 */
function cropOrder(crop, ordered, rankOf, page) {
  if (crop.block && rankOf.has(crop.block)) return rankOf.get(crop.block);
  const cols = page.columns || [];
  const mid = cols.length === 2 ? cols[0].x1 : null;
  const col = mid && (crop.rect.x0 + crop.rect.x1) / 2 > mid ? 1 : 0;
  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i];
    if (b.column > col || (b.column === col && b.y1 <= crop.rect.y1)) return i;
  }
  return ordered.length;
}

function padRect(b, pad) {
  return {
    x0: b.x0 - pad,
    y0: b.y0 - pad,
    x1: b.x1 + pad,
    y1: b.y1 + pad,
  };
}

/** 按「首行缩进」排版一段文字：第一行可用宽度少一个缩进量，其余行用整宽 */
export function wrapFlow(text, measure, fullWidth, firstIndent = 0) {
  const clean = sanitizeForPdf(text);
  if (!clean) return [];
  if (!(fullWidth > 0)) return [clean];
  const tokens = tokenize(clean);
  const lines = [];
  let cur = '';
  let curW = 0;
  let space = false;
  let limit = Math.max(12, fullWidth - firstIndent);

  const breakLine = () => { if (cur !== '') lines.push(cur); cur = ''; curW = 0; space = false; limit = fullWidth; };
  for (const tk of tokens) {
    if (tk.space) { if (cur !== '') space = true; continue; }
    const piece = space ? ' ' + tk.text : tk.text;
    const pw = measure(piece);
    if (cur !== '' && curW + pw > limit + 0.01) breakLine();
    if (cur === '' && pw > limit + 0.01 && Array.from(tk.text).length > 1) {
      const parts = hardSplit(tk.text, measure, limit);
      for (let i = 0; i < parts.length - 1; i++) { lines.push(parts[i]); limit = fullWidth; }
      cur = parts[parts.length - 1];
      curW = measure(cur);
      space = false;
      continue;
    }
    cur += piece;
    curW += pw;
    space = false;
  }
  breakLine();
  return applyLineBreakRules(lines);
}

/** 各层级排版规格 */
function styleFor(level, base, opts) {
  const ref = {
    title: { mul: 1.72, lh: 1.4, before: 0, after: 0.95, align: 'center', weight: 'bold', indent: 0, color: { r: 0.06, g: 0.09, b: 0.13 } },
    h2: { mul: 1.32, lh: 1.4, before: 1.15, after: 0.5, align: 'left', weight: 'bold', indent: 0, color: { r: 0.08, g: 0.11, b: 0.16 } },
    h3: { mul: 1.16, lh: 1.4, before: 1.0, after: 0.42, align: 'left', weight: 'bold', indent: 0, color: { r: 0.1, g: 0.13, b: 0.18 } },
    h4: { mul: 1.06, lh: 1.45, before: 0.85, after: 0.36, align: 'left', weight: 'bold', indent: 0, color: { r: 0.12, g: 0.15, b: 0.2 } },
    h5: { mul: 1.0, lh: 1.45, before: 0.75, after: 0.32, align: 'left', weight: 'bold', indent: 0, color: { r: 0.14, g: 0.17, b: 0.22 } },
    body: { mul: 1, lh: opts.reflowLineHeight || 1.65, before: 0.5, after: 0, align: 'left', weight: 'regular', indent: opts.reflowIndent === false ? 0 : 2, color: { r: 0, g: 0, b: 0 } },
    caption: { mul: 0.88, lh: 1.45, before: 0.4, after: 0.7, align: 'left', weight: 'regular', indent: 0, color: { r: 0.32, g: 0.35, b: 0.4 } },
    ref: { mul: 0.92, lh: 1.5, before: 0.25, after: 0.25, align: 'left', weight: 'regular', indent: 0, color: { r: 0.15, g: 0.17, b: 0.2 } },
  }[level] || null;
  const s = ref || {
    mul: 1, lh: 1.6, before: 0.5, after: 0, align: 'left', weight: 'regular', indent: 0, color: { r: 0, g: 0, b: 0 },
  };
  return { ...s, size: base * s.mul };
}

/** 分页写流：负责「当前写到哪、什么时候翻页」 */
class FlowWriter {
  constructor(doc, fonts, strokes) {
    this.doc = doc;
    this.fonts = fonts;
    this.strokes = strokes;
    this.page = null;
    this.y = 0;
    this.pages = 0;
    this.contentH = PAGE_H - MARGIN.top - MARGIN.bottom;
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages++;
    this.y = PAGE_H - MARGIN.top;
    return this.page;
  }

  /** 保证当前页至少有 h 的剩余空间，不够就翻页。返回 true 表示刚翻过页 */
  ensure(h) {
    if (!this.page) { this.newPage(); return true; }
    if (this.y - h < MARGIN.bottom) { this.newPage(); return true; }
    return false;
  }

  space(h) {
    if (this.page && this.y - h < MARGIN.bottom) { this.newPage(); return; }
    this.y -= h;
  }

  /**
   * 写一段文字。逐行推进，行到页底自动翻页——这样长段落能跨页，
   * 而不是整段被推到下一页留一大片空白。
   */
  writeText({ text, style, font, strokeEm }) {
    const size = style.size;
    const lineHeight = size * style.lh;
    const indent = style.indent * size;
    const measure = (s) => {
      try {
        const w = font.widthOfTextAtSize(s, size);
        if (Number.isFinite(w) && w >= 0) return w;
      } catch (_) { /* 落到估算 */ }
      let w = 0;
      for (const ch of s) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.5;
      return w;
    };
    const lines = wrapFlow(text, measure, CONTENT_W, indent);
    if (!lines.length) return 0;

    // 段前距：只有当段首不在页面顶端时才真正生效，避免每页开头空一截
    const atTop = this.y >= PAGE_H - MARGIN.top - 0.5;
    if (style.before > 0 && !atTop) this.space(style.before * size);
    else this.ensure(lineHeight);

    const isNew = atTop && this.pages === 0;
    void isNew;

    let written = 0;
    for (const line of lines) {
      if (this.y - lineHeight < MARGIN.bottom) this.newPage();
      let x = MARGIN.left;
      const w = measure(line);
      if (style.align === 'center') x = MARGIN.left + Math.max(0, (CONTENT_W - w) / 2);
      else if (style.align === 'right') x = MARGIN.left + CONTENT_W - w;
      const baseline = this.y - size * 0.86;
      drawLines({
        page: this.page,
        lines: [{ text: line, x, y: baseline }],
        font,
        size,
        color: style.color,
        strokeEm,
      });
      this.y -= lineHeight;
      written++;
    }
    this.y -= (style.after || 0) * size;
    return written;
  }

  /** 贴一张裁剪区域，按内容宽度等比缩放 */
  placeCrop(embedded, rect, { caption, font, strokeEm, captionSize, color }) {
    const srcW = Math.max(1, rect.x1 - rect.x0);
    const srcH = Math.max(1, rect.y1 - rect.y0);
    // 放大要有上限。论文里大量「公式」其实是一个符号或一小段式子（裁出来才 20~40pt 宽），
    // 无条件拉到整栏宽会把它们拉成一整块巨型方块——一篇论文几十个公式就能把 15 页的
    // 文档撑到 45 页，而且视觉上喧宾夺主。所以最多放大 2 倍，宽的自然铺满栏宽。
    const w = Math.min(CONTENT_W, srcW * MAX_CROP_UPSCALE);
    let h = (srcH / srcW) * w;
    const maxH = this.contentH * 0.92;
    if (h > maxH) { h = maxH; }

    const box = h + 10 + (caption ? captionSize * 1.5 : 0);
    if (this.y - box < MARGIN.bottom) this.newPage();

    this.y -= 6;
    const x = MARGIN.left + Math.max(0, (CONTENT_W - w) / 2);
    this.page.drawPage(embedded, { x, y: this.y - h, width: w, height: h });
    this.y -= h + 6;

    if (caption) {
      const size = captionSize;
      const lines = wrapFlow(caption, (s) => {
        try { return font.widthOfTextAtSize(s, size); } catch (_) { return s.length * size * 0.9; }
      }, CONTENT_W * 0.86, 0);
      for (const line of lines.slice(0, 4)) {
        if (this.y - size * 1.4 < MARGIN.bottom) this.newPage();
        const lw = font.widthOfTextAtSize(line, size);
        drawLines({
          page: this.page,
          lines: [{ text: line, x: MARGIN.left + Math.max(0, (CONTENT_W - lw) / 2), y: this.y - size * 0.86 }],
          font,
          size,
          color,
          strokeEm: 0,
        });
        this.y -= size * 1.45;
      }
    }
    this.y -= 10;
  }
}

/**
 * 渲染重排版 PDF。
 * @param {object} args
 * @param {Buffer} args.sourceBytes 原始 PDF
 * @param {Array} args.pages analyzePdf 的 pages
 * @param {Buffer} args.fontBytes 中文字体（常规档）
 * @param {Buffer} [args.boldFontBytes] 中文字体加粗档
 * @param {object} [args.options]
 * @returns {Promise<{bytes:Buffer, report:object}>}
 */
export async function renderReflowPdf({
  sourceBytes, pages, fontBytes, boldFontBytes, options = {}, onProgress, signal,
}) {
  const opts = { ...REFLOW_DEFAULTS, ...options };
  const src = toUint8Array(sourceBytes);

  // 源文档实例，只用来取 PDFPage 做区域裁剪。独立 load 一份最稳：
  // pdf.js 在解析阶段会 detach 传入的 ArrayBuffer，拿原始字节重新解析一遍最干净。
  const srcDoc = await PDFDocument.load(src, { ignoreEncryption: true, updateMetadata: false });
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const regularFont = await doc.embedFont(fontBytes, { subset: true });
  const hasRealBold = !!boldFontBytes && boldFontBytes.length > 0
    && Buffer.compare(Buffer.from(fontBytes), Buffer.from(boldFontBytes)) !== 0;
  const boldFont = hasRealBold ? await doc.embedFont(boldFontBytes, { subset: true }) : regularFont;
  const fonts = { regular: regularFont, bold: boldFont };
  const strokes = {
    regular: buildStrokeTable(fontBytes),
    bold: buildStrokeTable(hasRealBold ? boldFontBytes : fontBytes),
  };

  const { elements, stats } = buildElements(pages, opts);
  const report = {
    mode: 'reflow',
    pages: 0,
    translatedBlocks: 0,
    overflowBlocks: 0,
    boldBlocks: 0,
    elements: elements.length,
    hasRealBoldFont: hasRealBold,
    strokes,
    ...stats,
  };

  // 正文基准字号：用户显式指定优先；否则按原文字号的 1.2 倍放大并夹到 10~12pt，
  // 因为 A4 单栏比论文的双栏/窄栏宽得多，照搬原字号会显得过于稀疏。
  const srcBody = pages[0]?.bodySize || 10;
  const baseSize = opts.fontSize > 0
    ? opts.fontSize
    : Math.max(10, Math.min(12, srcBody * 1.2));

  const writer = new FlowWriter(doc, fonts, strokes);
  const cropCache = new Map();
  let done = 0;
  const totalWeight = Math.max(1, elements.length);

  for (const el of elements) {
    if (signal?.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });

    if (el.type === 'text') {
      const style = styleFor(el.level, baseSize, opts);
      // 原文加粗（标题/强调）用加粗档，其余按设置档
      const wantBold = style.weight === 'bold' || (opts.respectBold !== false && el.sourceBold);
      const fontKey = wantBold ? 'bold' : 'regular';
      const font = fonts[fontKey] || fonts.regular;
      const strokeEm = (strokes[fontKey] || strokes.regular)[wantBold ? 'bold' : (opts.fontWeight || 'medium')] || 0;
      writer.writeText({ text: el.text, style, font, strokeEm });
      report.translatedBlocks++;
      if (wantBold) report.boldBlocks++;
    } else if (el.type === 'crop' && opts.reflowKeepFigures !== false) {
      const key = `${el.pageIndex}:${el.rect.x0.toFixed(1)},${el.rect.y0.toFixed(1)},${el.rect.x1.toFixed(1)},${el.rect.y1.toFixed(1)}`;
      let embedded = cropCache.get(key);
      if (embedded === undefined) {
        try {
          const srcPage = srcDoc.getPage(el.pageIndex - 1);
          // 注意：embedPage 必须调用**目标文档** doc 的方法。
          // pdf-lib 的 embedPages 会检测源页与目标文档的 context 是否一致，
          // 不一致时用 PDFObjectCopier 把页面对象深拷进目标文档（否则画出来是悬空引用）。
          embedded = await doc.embedPage(srcPage, {
            left: el.rect.x0, bottom: el.rect.y0, right: el.rect.x1, top: el.rect.y1,
          });
        } catch (e) {
          embedded = null;
          report.cropFailed = (report.cropFailed || 0) + 1;
          void e;
        }
        cropCache.set(key, embedded);
      }
      if (embedded) {
        writer.placeCrop(embedded, el.rect, {
          caption: el.caption,
          font: fonts.regular,
          strokeEm: 0,
          captionSize: baseSize * 0.88,
          color: { r: 0.32, g: 0.35, b: 0.4 },
        });
      }
    }

    done++;
    onProgress?.({ stage: 'render', mode: 'reflow', percent: Math.round((done / totalWeight) * 100) });
  }

  if (!writer.page) writer.newPage();
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  report.pages = writer.pages;
  report.baseSize = +baseSize.toFixed(2);
  return { bytes: Buffer.from(bytes), report };
}
