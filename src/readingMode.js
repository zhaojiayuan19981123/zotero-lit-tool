// readingMode.js —— 阅读模式（Reading Mode）：把 PDF 还原成一棵可重排的结构树
//
// 目标与 Zotero 10 的 Reading Mode 一致：不再显示「一张固定版面的图画」，而是把正文
// 理解成带语义的文档树，交给浏览器按普通 HTML 重排 —— 双栏变单栏、字号行距随用户调、
// 页眉页脚剔除、图表公式原位裁图保留。
//
// 实现路线刻意**不引入新的 ONNX 模型**：复用全文翻译已有的 analyzePdf（pdf.js 文本层 +
// 规则的栏切分/分块/分类），产出同样的块级结构，只是把「行 + 片段」的几何也一起留下来。
// 这一层几何是双向同步的地基：有了每行每段的 x/y 范围，重排视图里的选区才能反推回
// 原始 PDF 的矩形，PDF 里的高亮也才能在重排视图里按字符区间还原。
//
// 与 Zotero 的差异（有意为之）：
//   · 不做逐字符坐标，而是「片段级坐标 + 片段内按字符数线性插值」。片段通常就是
//     一个单词或一小段字，插值误差在 1~2px 量级，够标注用，数据量却小一个数量级。
//   · 版面语义来自规则而不是神经网络，扫描件没有文字层时直接判为不可重排（不 OCR）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { analyzePdf, mathScore } from './pdfTranslate/analyze.js';
import { readingOrder } from './pdfTranslate/reflow.js';
import { getDataDir } from './store.js';

/** 结构版本；结构变了就 +1，旧缓存自动失效 */
export const READING_SCHEMA = 1;

/** 单篇分析结果的缓存目录（按「路径 + 大小 + mtime + 结构版本」做键） */
export function readingCacheDir() {
  return path.join(getDataDir(), 'reading');
}

/** 一页里参与重排的文字块最小尺寸（pt），比这更小的多半是污渍/角标 */
const MIN_TEXT_W = 6;
const MIN_TEXT_H = 4;
/** 裁图（图表 / 公式）的最小面积（pt²）：太小的直接丢弃，不占版面 */
const MIN_CROP_AREA = 420;
/** 页面插图的最小面积（pt²），比正文块更严格 —— 图标、分隔线不值得单独占位 */
const MIN_FIGURE_AREA = 2200;

const TEXT_KINDS = new Set(['title', 'heading', 'caption', 'body', 'reference', 'abstract']);

/** 正文块是否可重排（其余块走裁图） */
function isTextBlock(b) {
  if (!b || !b.lines?.length) return false;
  if (b.kind === 'furniture') return false;
  // analyze 把表格归到 kind='formula'，用 tableLike 区分；表格一律裁图保留原样
  if (b.tableLike) return false;
  if (b.kind === 'formula') {
    // 「公式」这一档里混着不少被规则跳过的正文碎块（"et al." / 单独的 doi 行 /
    // 短标题）。判断依据是「字母占比高且几乎不含数学符号」——这类宁可重排，
    // 也不要把一行字裁成图片：裁图不可选、不可搜，还会让段落断成两截。
    const t = String(b.text || '').trim();
    const letters = (t.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length;
    return t.length >= 6 && letters / t.length > 0.6 && mathScore(t) < 0.06;
  }
  return TEXT_KINDS.has(b.kind);
}

/** 该块是否适合裁图保留（表格 / 公式 / 无法重排的碎块） */
function isCropBlock(b) {
  if (!b || b.kind === 'furniture') return false;
  if (isTextBlock(b)) return false;
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  if (w < 12 || h < 6) return false;
  if (w * h < MIN_CROP_AREA) return false;
  return b.kind === 'formula' || !!b.tableLike;
}

function round(v, n = 1) {
  const p = 10 ** n;
  return Math.round(v * p) / p;
}

function rectOf(b) {
  return [round(b.x0), round(b.y0), round(b.x1), round(b.y1)];
}

/** 两矩形重叠面积占较小者比例 */
function overlapRatio(a, b, threshold = 0.55) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return false;
  const inter = w * h;
  const smaller = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return smaller > 0 && inter / smaller > threshold;
}

/**
 * 标题定级：全篇按字号去重降序，最大一档 → 1（h1 之外的大标题），依次 2/3/4。
 * 与 reflow.js 的 assignHeadingLevels 保持同一套映射，避免「同一篇论文在
 * 重排译文和阅读模式里标题级数不一样」。
 */
function makeLevelFn(pages) {
  const sizes = new Set();
  for (const page of pages) {
    for (const b of page.blocks || []) {
      if (b.kind === 'heading') sizes.add(round(b.size * 2) / 2);
    }
  }
  const ranked = [...sizes].sort((a, b) => b - a);
  return (b) => {
    if (b.kind === 'title') return 1;
    if (b.kind === 'heading') {
      const i = ranked.indexOf(round(b.size * 2) / 2);
      return Math.min(Math.max(i, 0), 3) + 2;
    }
    return 0;
  };
}

/**
 * 行 → 紧凑结构。
 * runs 里每个片段是 [x, w, text]：x/w 是该片段在原始页面上的左边界与宽度（pt），
 * text 是这一段的原文。前端按同样的规则把这些片段拼成一行（gap 大于 0.22em 补空格），
 * 于是「第几个字符 → 落在哪个片段 → 片段内第几个字 → x 位置」这条链是精确可算的。
 *
 * 顺手按**行**再滤一次页面右缘的窄行：竖排刊名（running head）常被 analyze 归进
 * 正文块的行里，块级判定看不见它，结果刊名会被插进正文句子中间。
 */
function packLines(block, page, stamps) {
  const pageNum = page.index;
  const W = page.width || 0;
  const left = page.x0 ?? 0;
  // 行内噪音片段：压在右侧（> 0.78 页宽）的窄片段，且要么是跨页固定元素，
  // 要么是「Received / Accepted / Downloaded…」这类出版社固定文案。
  // 两者都只在右缘生效，正文行尾的普通单词不会被误伤。
  const isNoiseRun = (it) => {
    const t = String(it.text || '').trim();
    if (!t || !W) return false;
    const x = it.x - left;
    const w = it.w ?? 0;
    if (x <= W * 0.78 || w >= W * 0.22) return false;
    if (t.length <= 40 && stamps?.has(`${normText(t)}@${Math.round((x / W) * 20)}`)) return true;
    return MARGIN_TEXT.test(t);
  };
  const out = [];
  for (const line of block.lines || []) {
    if (W && line.x0 > left + W * 0.78 && line.x1 - line.x0 < W * 0.22) continue;
    const runs = [];
    for (const it of line.items || []) {
      const text = String(it.text ?? '');
      if (!text) continue;
      if (isNoiseRun(it)) continue;
      runs.push([round(it.x, 2), round(it.w ?? 0, 2), text]);
    }
    if (!runs.length) continue;
    out.push({
      p: pageNum,
      x0: round(line.x0, 2),
      x1: round(line.x1, 2),
      y0: round(line.bottom, 2),
      y1: round(line.top, 2),
      s: round(line.size, 2),
      runs,
    });
  }
  return out;
}

/** 文字块 → 结构树节点 */
function textNode(block, level, page, stamps) {
  return {
    t: 'text',
    kind: TEXT_KINDS.has(block.kind) ? block.kind : 'body',
    level: level || 0,
    page: page.index,
    rect: rectOf(block),
    align: block.align === 'center' ? 'center' : 'left',
    bold: !!block.bold,
    size: round(block.size, 1),
    lines: packLines(block, page, stamps),
  };
}

/**
 * 裁图节点。图注若与块重叠（图题的块通常紧贴图下方）就并入，前端渲染成 <figcaption>。
 */
function cropNode({ page, rect, kind, caption }) {
  return {
    t: 'crop',
    k: kind,
    page,
    rect,
    caption: String(caption || '').slice(0, 300),
  };
}

/**
 * 页面插图该插在第几位：找阅读顺序里第一个「排在它之后」的块。
 * 与 reflow.js 的 cropOrder 同一思路（先比栏号，同栏再比纵坐标），否则右栏的图
 * 会被拽到左栏中间去。
 */
function cropRank(rect, ordered, columns) {
  const mid = columns?.length === 2 ? columns[0].x1 : null;
  const col = mid && (rect[0] + rect[2]) / 2 > mid ? 1 : 0;
  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i];
    const bc = b.column ?? 0;
    if (bc > col || (bc === col && b.y1 <= rect[3])) return i;
  }
  return ordered.length;
}

/** 同页上紧随其后的图注块（"Figure 3 ..." / "表 2 ..."），用来给裁图配说明 */
function findCaption(node, blocks, pageHeight) {
  const [x0, y0, x1, y1] = node.rect;
  const center = (x0 + x1) / 2;
  let best = null;
  for (const b of blocks) {
    if (b.kind !== 'caption') continue;
    const text = String(b.text || '').trim();
    if (!/^(fig(?:ure)?|table|tab\.|图|表|scheme|algorithm)\s*\.?\s*\d+/i.test(text)) continue;
    const gap = Math.min(Math.abs(b.y0 - y1), Math.abs(y0 - b.y1));
    if (gap > pageHeight * 0.12) continue;
    if (center < b.x0 - 40 || center > b.x1 + 40) continue;
    if (!best || gap < best.gap) best = { gap, text, block: b };
  }
  return best;
}

/** 结束符判断：同页碎片拼接与跨页接续都只对「话没说完」的块生效 */
const SENTENCE_END = /[.!?。！？：:；;…]["'”’）)\]]?\s*$/;
const CJK_START = /^[\u3000-\u9fff\uff00-\uffef]/;

/** 块的最后一行结尾 / 第一行开头（用片段原文，不依赖前端装配的文本） */
function tailText(node) {
  const line = node.lines?.[node.lines.length - 1];
  const run = line?.runs?.[line.runs.length - 1];
  return String(run?.[2] || '').trimEnd();
}

function headText(node) {
  const run = node.lines?.[0]?.runs?.[0];
  return String(run?.[2] || '').trimStart();
}

/**
 * 同一页里被切开的同一个块：标题跨行、段落被行内公式或大间隙打断时，analyze 会
 * 把它切成两个块。阅读模式下这些碎片必须拼回去，否则一句话会被拆成两段显示。
 *
 * 三条判据，按可信度从高到低：
 *   1. 居中块（标题）被字体切换切成两半 —— 中心线对得上就合并；
 *   2. 语义续写：上一块没句末标点、下一块用小写/中文/括号开头；
 *   3. 排版被截断的直接证据：上一块是多行段落，且最后一行顶到了右边距。
 *
 * 单行块之间刻意保守：一个单行块的「右边距」就是它自己的行尾，无法自证被截断，
 * 只靠语义判断，免把「……ends here.」和「Another paragraph」粘成一段。
 */
function shouldJoinAdjacent(prev, next) {
  if (prev.t !== 'text' || next.t !== 'text') return false;
  if (prev.level !== next.level) return false;
  if (prev.kind !== next.kind) return false;
  if (Math.abs(prev.size - next.size) > Math.max(1, prev.size * 0.1)) return false;
  const gap = prev.rect[1] - next.rect[3];
  if (gap < -3 || gap > Math.max(4, prev.size * 0.75)) return false;
  const centered = (prev.align === 'center' || next.align === 'center')
    && Math.abs((prev.rect[0] + prev.rect[2]) - (next.rect[0] + next.rect[2])) < 24;
  const sameX = Math.abs(prev.rect[0] - next.rect[0]) < Math.max(6, prev.size * 1.2);
  if (!centered && !sameX) return false;
  if (centered) return true;
  const continues = !SENTENCE_END.test(tailText(prev))
    && /^[a-z\u4e00-\u9fff(（[“"]/.test(headText(next));
  if (continues) return true;
  const lastLine = prev.lines[prev.lines.length - 1];
  return prev.lines.length > 1 && lastLine.x1 >= prev.rect[2] - Math.max(6, prev.size * 1.4);
}

/** 把一页里相邻的同款碎片拼回一个块（见 shouldJoinAdjacent） */
function joinAdjacent(nodes) {
  const out = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev && shouldJoinAdjacent(prev, node)) {
      mergeNodes(prev, node);
      continue;
    }
    out.push(node);
  }
  return out;
}
// ==================== 页眉页脚 / 边栏小字 ====================

/**
 * analyze 的重复判定要求「文字归一化后完全一致」——对含 URL、下载时间、DOI 的页脚
 * 经常失效（每页被截断的位置不同，归一化后仍是不同的串）。阅读模式再补一层判定：
 *   · 位于页面上下 9% 的边带里，且（在多页上重复出现 / 文字像页眉页脚 / 是纯页码）
 *   · 位于页面左右窄边带里的窄块 —— 期刊 running head（常常是竖排的）、审稿日期
 *   · 短而窄、且跨页重复的块 —— 压在正文右沿的刊名
 * 命中就标成 furniture，后续所有环节（重排、裁图、大纲）都不会再看见它。
 *
 * MARGIN_TEXT 收的是「出版社固定文案」：下载出处、收稿日期、版权行、卷期页码。
 * 这些都是阅读模式的噪音，留着只会让正文开头多出一堆与论文无关的字。
 */
const MARGIN_TEXT = /^(?:downloaded\s+from|this\s+article|the\s+current\s+issue\s+and\s+full\s+text\s+archive|contents\s+lists\s+available\s+at|journal\s+homepage|available\s+online\s+at|https?:\/\/|www\.|doi[\s:.]|e?-?issn|received\b|revised\b|accepted\b|published\b|available\s+online|©|copyright\b|all\s+rights\s+reserved|vol\.\s*\d|no\.\s*\d|pp\.\s*\d|\d{1,4}$)/i;

function markMarginalia(pages) {
  if (pages.length < 2) return;
  const norm = (t) => String(t || '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const seen = new Map();
  for (const page of pages) {
    for (const b of page.blocks || []) {
      if (b.kind === 'furniture') continue;
      const key = norm(b.text);
      if (!key || key.length > 120) continue;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(page.index);
    }
  }
  const repeatMin = Math.max(2, Math.ceil(pages.length * 0.34));
  for (const page of pages) {
    const top = page.y1 ?? page.height;
    const left = page.x0 ?? 0;
    for (const b of page.blocks || []) {
      if (b.kind === 'furniture') continue;
      const key = norm(b.text);
      const repeated = !!key && (seen.get(key)?.size || 0) >= repeatMin;
      const inBand = b.y1 > top - page.height * 0.09 || b.y0 < left + page.height * 0.09;
      // 页面左右两条窄边带（各 12% 页宽）里的窄块 = 期刊 running head / 侧边栏。
      // 这里**不看高度**：Emerald 这类期刊的刊名是竖排的，包围盒又高又窄，
      // 一旦按「矮」筛选就会漏掉，最后表现为刊名被插进正文句子中间。
      const narrow = (b.x1 - b.x0) < page.width * 0.22;
      const thinSide = narrow && (b.x1 < left + page.width * 0.14 || b.x0 > left + page.width * 0.78);
      const looksMargin = inBand && MARGIN_TEXT.test(String(b.text || '').trim());
      if ((inBand && repeated) || looksMargin || thinSide) {
        b.kind = 'furniture';
        b.translatable = false;
        b.reason = '页眉页脚/边栏小字（阅读模式剔除）';
      }
    }
  }
}

/** 文字归一化：数字统一成 #，用来判「跨页重复」 */
function normText(t) {
  return String(t || '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 跨页重复且**位置固定**的片段（刊名、页码、页脚）。这些片段常常不是独立块，而是被
 * pdf.js 塞进了正文行里，块级判定看不见；所以在片段级再收一张表，供 packLines 剔除。
 *
 * 必须同时看「文字 + 横向位置」：正文里也会出现 "Internet Research"（期刊参考文献里
 * 就有），位置不同就不能删。
 */
function collectStamps(pages) {
  const seen = new Map();
  for (const page of pages) {
    const W = page.width || 1;
    const left = page.x0 ?? 0;
    for (const b of page.blocks || []) {
      for (const line of b.lines || []) {
        for (const it of line.items || []) {
          const t = String(it.text || '').trim();
          // 只认「压在页面右侧固定位置」的短串：正文行首在 0.2 页宽附近、右栏行首在
          // 0.5 页宽附近，都进不了 0.78 这条线；含空格 + 8~40 字则排除零散单词。
          if (t.length < 8 || t.length > 40) continue;
          if (!/\s/.test(t)) continue;
          if (it.x - left < W * 0.78) continue;
          const key = `${normText(t)}@${Math.round(((it.x - left) / W) * 20)}`;
          if (!seen.has(key)) seen.set(key, new Set());
          seen.get(key).add(page.index);
        }
      }
    }
  }
  const min = Math.max(3, Math.ceil(pages.length * 0.3));
  const out = new Set();
  for (const [key, pagesSeen] of seen) if (pagesSeen.size >= min) out.add(key);
  return out;
}

// ==================== 表格区回收 ====================

/**
 * 把「被拆成一格一块的表格」重新收成一张图。
 *
 * analyze 的表格判定是按块做的：如果 pdf.js 的文本层把每个单元格都拆成了独立小块，
 * 单看任何一块都不像表格，结果整张表会被重排成一长串「#Huawei# / 395 99 / 0.99 0.11」，
 * 完全没法读。这里按**版面证据**把它们收回去：
 *   · 同一行内至少 3 块、横向铺开超过页宽的 30% → 这一行是网格行
 *   · 连续 3 行以上都是网格行 → 判定为表格区，取外包矩形整块裁图
 * 表格按要求「保留原样」，裁成图反而是最忠实的呈现（行列关系一点都不丢）。
 */
function collapseTableZones(page) {
  const blocks = page.blocks || [];
  const w = page.width || 1;
  const cells = blocks.filter((b) => b.kind !== 'furniture'
    && String(b.text || '').trim().length <= 60
    && (b.y1 - b.y0) <= 32);
  if (cells.length < 9) return;

  // 1) 聚成行（纵向中心接近）
  const rows = [];
  for (const b of cells.slice().sort((a, z) => z.y1 - a.y1)) {
    const c = (b.y0 + b.y1) / 2;
    const row = rows.find((r) => Math.abs(r.center - c) <= Math.max(3, (b.y1 - b.y0) * 0.6));
    if (row) {
      row.items.push(b);
      row.min = Math.min(row.min, c);
      row.center = (row.min + Math.max(...row.items.map((i) => (i.y0 + i.y1) / 2))) / 2;
    } else {
      rows.push({ center: c, min: c, items: [b] });
    }
  }
  for (const row of rows) {
    row.grid = row.items.length >= 3
      && (Math.max(...row.items.map((i) => i.x1)) - Math.min(...row.items.map((i) => i.x0))) > w * 0.3;
    row.y1 = Math.max(...row.items.map((i) => i.y1));
    row.y0 = Math.min(...row.items.map((i) => i.y0));
  }
  rows.sort((a, z) => z.y1 - a.y1);

  // 2) 连续网格行（允许中间夹一行没对齐的）→ 表格区
  const zones = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) zones.push(run);
    run = [];
  };
  for (const row of rows) {
    if (row.grid) { run.push(row); continue; }
    if (run.length && row.items.length >= 2) { run.push(row); continue; } // 容忍一行
    flush();
  }
  flush();
  if (!zones.length) return;

  const consumed = new Set();
  for (const zone of zones) {
    const inZone = zone.flatMap((r) => r.items);
    const x0 = Math.min(...inZone.map((i) => i.x0));
    const x1 = Math.max(...inZone.map((i) => i.x1));
    const y0 = Math.min(...inZone.map((i) => i.y0));
    const y1 = Math.max(...inZone.map((i) => i.y1));
    // 表格区里被单独切出来的小块（比如跨格的长标题）一并吞掉
    for (const b of blocks) {
      if (b.kind === 'furniture' || consumed.has(b)) continue;
      const cx = (b.x0 + b.x1) / 2;
      const cy = (b.y0 + b.y1) / 2;
      if (cx > x0 - 4 && cx < x1 + 4 && cy > y0 - 4 && cy < y1 + 4) consumed.add(b);
    }
    inZone.forEach((b) => consumed.add(b));
    zone.rect = [x0, y0, x1, y1];
  }

  // 3) 用合成块替换掉被吞掉的原始块
  const synth = zones.map((zone, i) => ({
    id: `p${page.index}-tbl${i + 1}`,
    index: 0,
    column: -1,
    span: 0,
    colX0: zone.rect[0],
    colX1: zone.rect[2],
    colWidth: zone.rect[2] - zone.rect[0],
    lines: [],
    lineCount: 0,
    text: '',
    rawText: '',
    x0: zone.rect[0], y0: zone.rect[1], x1: zone.rect[2], y1: zone.rect[3],
    width: zone.rect[2] - zone.rect[0],
    height: zone.rect[3] - zone.rect[1],
    size: 8,
    lineHeight: 9,
    align: 'left',
    bold: false,
    kind: 'formula',
    tableLike: true,
    translatable: false,
    reason: '表格区（阅读模式整块裁图）',
  }));
  page.blocks = [...blocks.filter((b) => !consumed.has(b)), ...synth];
}

// ==================== 矢量插图 ====================

/** 两矩形外扩 tol 后是否相交 */
function nearBox(a, b, tol) {
  return a[0] <= b[2] + tol && b[0] <= a[2] + tol && a[1] <= b[3] + tol && b[1] <= a[3] + tol;
}

/** 两矩形相交面积 */
function interArea(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * 矢量插图区域：论文里的图表大多是用路径画的（柱形、折线、坐标系），不会出现在
 * pdf.js 的图像 XObject 里。只认 page.images 的话，这类图在重排视图里会整张消失，
 * 只剩图内那几个标签文字 —— 比原页还难读。
 *
 * 做法：把页面上「不像底纹的彩色填充块」按邻近关系聚簇，簇够大、够高、块够多就
 * 当成一张插图整块裁图。判据刻意收得很紧，宁可漏判也不要把表头底色、摘要框、
 * 强调横条当成插图：
 *   · 至少 3 个填充块（单个色块多半是表头或提示框）
 *   · 高度 ≥ 页高 3%、宽度 ≥ 页宽 10%（细长的多是表格线、页边装饰）
 *   · 面积 ≥ 页面 0.8%（小色块是项目符号、强调标记）
 *   · 簇内一半以上面积被文字占着 —— 那是底纹，不是插图
 */
export function vectorFigures(page, textBlocks) {
  const W = page.width;
  const H = page.height;
  if (!W || !H) return [];
  const pageArea = W * H;
  const boxes = [];
  for (const f of page.fills || []) {
    const w = f.x1 - f.x0;
    const h = f.y1 - f.y0;
    if (w < 6 || h < 6) continue;
    if (w * h > pageArea * 0.6) continue;
    const c = f.color || {};
    if ((c.r ?? 0) > 0.94 && (c.g ?? 0) > 0.94 && (c.b ?? 0) > 0.94) continue;
    boxes.push([f.x0, f.y0, f.x1, f.y1]);
  }
  if (boxes.length < 3) return [];

  // 邻近合并：柱图的柱子之间有十几个 pt 的空隙，容差按页宽取（约 3.5%），
  // 反复吞并相交的框直到簇数不再下降
  const tol = Math.max(8, W * 0.035);
  let clusters = boxes.map((b) => ({ box: b.slice(), n: 1, area: (b[2] - b[0]) * (b[3] - b[1]) }));
  for (let pass = 0; pass < 8; pass++) {
    const out = [];
    for (const c of clusters) {
      const hit = out.find((o) => nearBox(o.box, c.box, tol));
      if (hit) {
        hit.box = [
          Math.min(hit.box[0], c.box[0]), Math.min(hit.box[1], c.box[1]),
          Math.max(hit.box[2], c.box[2]), Math.max(hit.box[3], c.box[3]),
        ];
        hit.n += c.n;
        hit.area += c.area;
      } else out.push(c);
    }
    if (out.length === clusters.length) break;
    clusters = out;
  }

  const textRects = textBlocks.map(rectOf);
  const minArea = Math.max(3000, pageArea * 0.008);
  const out = [];
  for (const c of clusters) {
    const [x0, y0, x1, y1] = c.box;
    const w = x1 - x0;
    const h = y1 - y0;
    if (c.n < 3) continue;
    if (h < H * 0.03 || w < W * 0.1) continue;
    if (w * h < minArea) continue;
    // 填充块把包围盒铺满了（> 60%）的，是「一块块拼起来的版面」——表头底色、
    // 提示框、分栏色带；真实图表的填充只占包围盒的一小半。
    const cover = c.area / (w * h);
    if (cover > 0.6) continue;
    const ink = textRects.reduce((n, t) => n + interArea(t, c.box), 0);
    if (ink > w * h * 0.5) continue;
    out.push([round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)]);
  }
  return out;
}

/** 块中心是否落在矩形内（矢量图里的坐标轴标签、图例文字） */
function centerIn(block, box) {
  const cx = (block.x0 + block.x1) / 2;
  const cy = (block.y0 + block.y1) / 2;
  return cx > box[0] && cx < box[2] && cy > box[1] && cy < box[3];
}

/**
 * 跨页 / 跨栏的段落接续：论文里一个自然段常被分页切断，阅读模式下应该是一段。
 *
 * 判据刻意保守 —— 只合并「上一页最后一块 + 下一页第一块」，且要求：
 *   · 两块都是正文（不是标题 / 图注 / 参考文献）
 *   · 上一块结尾没有句末标点，下一块以小写字母或中文开头
 *   · 两块字号接近
 * 宁可少合并，也不要把两个不相干的段落粘在一起。
 */
function canContinue(prev, next, pageTop) {
  if (!prev || !next) return false;
  if (prev.t !== 'text' || next.t !== 'text') return false;
  if (prev.kind !== 'body' || next.kind !== 'body') return false;
  if (Math.abs(prev.size - next.size) > Math.max(1.5, prev.size * 0.12)) return false;
  const prevText = lastRunText(prev);
  const nextText = firstRunText(next);
  if (!prevText || !nextText) return false;
  if (SENTENCE_END.test(prevText)) return false;
  if (/[A-Z0-9]/.test(nextText[0]) && !CJK_START.test(nextText[0])) return false;
  // 下一页的第一块必须真的贴着页首（否则中间还隔着图表/标题，不该直接接上）
  const firstLine = next.lines[0];
  if (pageTop && firstLine && firstLine.y1 < pageTop - 60) return false;
  return true;
}

function lastRunText(node) {
  const line = node.lines?.[node.lines.length - 1];
  if (!line?.runs?.length) return '';
  return String(line.runs[line.runs.length - 1][2] || '').trimEnd();
}

function firstRunText(node) {
  const run = node.lines?.[0]?.runs?.[0];
  return String(run?.[2] || '').trimStart();
}

function mergeNodes(prev, next) {
  prev.lines.push(...next.lines);
  const [ax0, ay0, ax1, ay1] = prev.rect;
  const [bx0, by0, bx1, by1] = next.rect;
  prev.rect = [Math.min(ax0, bx0), Math.min(ay0, by0), Math.max(ax1, bx1), Math.max(ay1, by1)];
  return prev;
}

/**
 * analyzePdf 的版面结构 → 阅读模式文档树。
 *
 * 纯函数（不碰文件系统、不读 PDF），测试可以直接喂构造的 pages 进来断言。
 * @returns {{v:number,pages:number,blocks:object[],stats:object,warnings:string[]}}
 */
export function toReadingDoc(analysis) {
  const pages = Array.isArray(analysis?.pages) ? analysis.pages : [];
  const totalPages = analysis?.totalPages || pages.length;
  markMarginalia(pages);
  const levelOf = makeLevelFn(pages);
  const stamps = collectStamps(pages);
  const blocks = [];
  const warnings = [];
  const pageTops = new Map();
  for (const page of pages) pageTops.set(page.index, (page.y1 ?? page.height) - (page.height || 0) * 0.08);

  const stats = { text: 0, figures: 0, tables: 0, formulas: 0, chars: 0, emptyPages: 0 };

  for (const page of pages) {
    collapseTableZones(page);
    const pageBlocks = (page.blocks || []).filter((b) => b && b.kind !== 'furniture');
    const ordered = readingOrder(page);
    const rankOf = new Map(ordered.map((b, i) => [b, i]));
    const items = [];
    const cropRects = [];
    const textRects = [];

    // 1) 裁图候选：表格碎块 / 图像 XObject / 矢量插图。
    //    先集中收集再统一判定，是因为「图注」要跟着裁图一起处理 —— 图注的文字
    //    由裁图节点的 <figcaption> 呈现，若同时再排一遍文字块，图注会重复出现一次。
    const cands = [];
    for (const b of ordered) {
      if (isTextBlock(b) || !isCropBlock(b)) continue;
      cands.push({ rect: rectOf(b), kind: b.tableLike ? 'table' : 'formula', block: b });
    }
    for (const img of page.images || []) {
      const rect = [img.x0, img.y0, img.x1, img.y1];
      if ((rect[2] - rect[0]) * (rect[3] - rect[1]) < MIN_FIGURE_AREA) continue;
      cands.push({ rect, kind: 'figure', block: null });
    }
    for (const rect of vectorFigures(page, ordered.filter(isTextBlock))) {
      cands.push({ rect, kind: 'figure', block: null, vector: true });
    }

    const accepted = [];
    for (const cand of cands) {
      if (accepted.some((a) => overlapRatio(a.rect, cand.rect))) continue;
      // 图像 XObject 常被当作页底色块铺在文字下面：与正文高度重叠的不算插图。
      // 矢量插图区由 vectorFigures 自己按「簇内文字占比」判过，不再重复挡。
      if (cand.kind === 'figure' && !cand.vector
        && ordered.some((b) => isTextBlock(b) && overlapRatio(rectOf(b), cand.rect, 0.3))) continue;
      accepted.push(cand);
    }

    // 图注归位：被裁图「吃掉」的图注块不再单独排成一行文字
    const consumed = new Set();
    for (const cand of accepted) {
      const cap = findCaption({ rect: cand.rect }, pageBlocks, page.height);
      cand.caption = String(cap?.text || '').slice(0, 300);
      if (cap?.block) consumed.add(cap.block);
    }

    for (const cand of accepted) {
      const node = cropNode({
        page: page.index,
        rect: cand.rect.map((v) => round(v, 2)),
        kind: cand.kind,
        caption: cand.caption,
      });
      cropRects.push(node.rect);
      // 裁图排在「它本该出现的位置」：表格/公式用它自己的阅读顺序名次（这样被吃掉的
      // 图注不会把它拽到上一栏去），插图用 cropRank 现算。
      const rank = cand.block ? (rankOf.get(cand.block) ?? 0) : cropRank(cand.rect, ordered, page.columns);
      items.push({ rank, y: cand.rect[3], seq: items.length, el: node });
      if (cand.kind === 'table') stats.tables++;
      else if (cand.kind === 'formula') stats.formulas++;
      else stats.figures++;
    }

    // 2) 文字块：可重排的走文本，其余（表格 / 公式 / 碎块）走裁图
    for (const b of ordered) {
      if (!isTextBlock(b)) continue;
      if (b.x1 - b.x0 < MIN_TEXT_W || b.y1 - b.y0 < MIN_TEXT_H) continue;
      if (consumed.has(b)) continue;
      // 落在插图里的短文字（坐标轴标签、图例）已经画在裁图里了，再排一遍就是重复
      if (cropRects.some((r) => centerIn(b, r))) continue;
      const node = textNode(b, levelOf(b), page, stamps);
      if (!node.lines.length) continue;
      textRects.push(node.rect);
      items.push({ rank: rankOf.get(b) ?? 0, y: b.y1, seq: items.length, el: node });
      stats.text++;
      stats.chars += node.lines.reduce(
        (n, l) => n + l.runs.reduce((m, r) => m + r[2].length, 0), 0);
    }

    if (!items.length) {
      // 整页都没有可重排的内容：扫描页、整页插图（大图 / 大表）。重排救不了它，
      // 但也不能让这一页在阅读视图里凭空消失 —— 整页裁一张图放进去，内容不丢。
      const hasVisual = (page.images || []).length > 0 || (page.rawItems || 0) > 0;
      if (hasVisual) {
        const full = [
          round((page.x0 ?? 0) + 1, 2),
          round((page.y0 ?? 0) + 1, 2),
          round((page.x1 ?? page.width) - 1, 2),
          round((page.y1 ?? page.height) - 1, 2),
        ];
        blocks.push({ t: 'crop', k: 'figure', page: page.index, rect: full, caption: '', full: true, _pageEnd: true });
        stats.figures++;
        stats.emptyPages++;
        warnings.push(`第 ${page.index} 页没有可重排的正文（扫描页 / 整页插图），已按原页裁图保留。`);
      }
      continue;
    }

    // 3) 页内排序：阅读顺序名次优先，同名义次再按纵向从上到下
    items.sort((a, b) => (a.rank - b.rank) || (b.y - a.y) || (a.seq - b.seq));
    const pageNodes = joinAdjacent(items.map((i) => i.el)).map((n) => ({ ...n, _pageEnd: false }));
    pageNodes[pageNodes.length - 1]._pageEnd = true;
    blocks.push(...pageNodes);
  }

  // 4) 跨页段落接续
  const merged = [];
  for (const cur of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && prev._pageEnd === true && canContinue(prev, cur, pageTops.get(cur.page))) {
      mergeNodes(prev, cur);
      prev._pageEnd = cur._pageEnd === true;
      continue;
    }
    merged.push(cur);
  }
  for (const b of merged) delete b._pageEnd;

  // 5) 编号与稳定 id（前端拿它做定位锚点）
  merged.forEach((b, i) => { b.id = `r${i + 1}`; });

  return {
    v: READING_SCHEMA,
    pages: totalPages,
    analyzedPages: pages.length,
    // 正文基准字号 / 是否衬线：排版控件的「跟随原文」用它，避免整篇字体选错
    bodySize: analysis?.stats?.bodySize || 10,
    bodySerif: analysis?.stats?.bodySerif ?? null,
    blocks: merged,
    stats: {
      ...stats,
      blocks: merged.length,
      headings: merged.filter((b) => b.t === 'text' && b.level > 0).length,
      paragraphs: merged.filter((b) => b.t === 'text' && b.level === 0).length,
    },
    warnings: [...new Set(warnings)].slice(0, 12),
  };
}

// ==================== 缓存 ====================

function cacheKey(filePath) {
  let st = null;
  try { st = fs.statSync(filePath); } catch (_) { return null; }
  const raw = `${path.resolve(filePath)}|${st.size}|${Math.round(st.mtimeMs)}|${READING_SCHEMA}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

function cachePath(key) {
  return path.join(readingCacheDir(), key + '.json');
}

/** 读缓存；结构版本不符或文件被替换过都算未命中 */
export function readCachedDoc(filePath) {
  const key = cacheKey(filePath);
  if (!key) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cachePath(key), 'utf8'));
    if (data?.v !== READING_SCHEMA || !Array.isArray(data.blocks)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function writeCacheFile(file, doc) {
  try {
    fs.mkdirSync(readingCacheDir(), { recursive: true });
    fs.writeFileSync(file + '.part', JSON.stringify(doc), 'utf8');
    fs.renameSync(file + '.part', file);
  } catch (_) { /* 缓存写不进去不影响本次阅读 */ }
}

/** 按「页区间」切出来的那份结构树，单独存一个文件（不覆盖整篇缓存） */
function partCachePath(key, from, to) {
  return path.join(readingCacheDir(), `${key}--p${from}-${to || 'end'}.json`);
}

/** 同一篇正在分析时复用同一个 Promise，避免用户连点两下跑两遍 */
const running = new Map();

/**
 * 正在分析的进度：cacheKey → { page, total, percent, startedAt }。
 * 前端在等待期间轮询它，把「转圈」换成「正在排版 37/84 页」——
 * 能不能秒开是缓存决定的，但等待期间有没有真实反馈，取决于这里。
 */
const progress = new Map();

/** 查询某篇的分析进度；没有在跑就返回 null（前端据此判断能不能显示进度条） */
export function getReadingProgress(filePath) {
  const key = cacheKey(filePath);
  if (!key) return null;
  const p = progress.get(key);
  if (!p) return null;
  return { page: p.page, total: p.total, percent: p.percent, elapsedMs: Date.now() - p.startedAt };
}

/**
 * 生成（或读缓存）某篇 PDF 的阅读模式文档树。
 *
 * 支持「只算一段页」：`{ fromPage, toPage }`。这是首屏速度的关键 ——
 * 一篇 84 页的论文整篇分析要 1.7 秒，而前 12 页只要 ~0.25 秒。
 * 前端因此可以先拿到前 12 页立刻显示，剩下的在后台接着补（见 app.js 的续拉逻辑）。
 *
 * 缓存分两层：
 *   · 整篇缓存（<key>.json）：一次整篇分析之后，之后无论要整篇还是要分段都直接命中；
 *   · 分段缓存（<key>--p1-12.json）：只算过一段时存这里，第二次打开同一段仍是秒开。
 *
 * @param {string} filePath PDF 绝对路径
 * @param {{force?:boolean, fromPage?:number, toPage?:number}} [opts]
 */
export async function buildReadingDoc(filePath, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    const e = new Error('找不到该文献的 PDF 文件');
    e.code = 'ENOENT_PDF';
    throw e;
  }
  // 整篇缓存优先级最高：有了它，分段请求也直接给整篇（前端会一次拿全，不再续拉）
  if (!opts.force) {
    const cached = readCachedDoc(filePath);
    if (cached) return { doc: cached, cached: true };
  }
  const from = Math.max(1, Math.floor(Number(opts.fromPage) || 1));
  const to = Math.max(0, Math.floor(Number(opts.toPage) || 0));
  const partial = to > 0 || from > 1;
  const key = cacheKey(filePath) || path.resolve(filePath);
  const slot = partial ? `${key}--p${from}-${to || 'end'}` : key;

  if (running.has(slot)) {
    const doc = await running.get(slot);
    return { doc, cached: true };
  }
  if (partial && !opts.force) {
    try {
      const data = JSON.parse(fs.readFileSync(partCachePath(key, from, to), 'utf8'));
      if (data?.v === READING_SCHEMA && Array.isArray(data.blocks)) return { doc: data, cached: true };
    } catch (_) { /* 没缓存就算一遍 */ }
  }

  const task = (async () => {
    progress.set(key, { page: partial ? from - 1 : 0, total: 0, percent: 0, startedAt: Date.now() });
    try {
      const bytes = await fs.promises.readFile(filePath);
      const analysis = await analyzePdf(bytes, {
        ...(partial ? { fromPage: from, toPage: to } : {}),
        onProgress: (p) => {
          const cur = progress.get(key);
          if (!cur) return;
          cur.page = p?.page || 0;
          cur.total = p?.total || 0;
          cur.percent = p?.percent || 0;
        },
      });
      const doc = toReadingDoc(analysis);
      doc.source = {
        name: path.basename(filePath),
        bytes: bytes.byteLength,
        generatedAt: new Date().toISOString(),
      };
      if (partial) {
        const pages = Array.isArray(analysis.pages) ? analysis.pages : [];
        const firstPage = pages[0]?.index || from;
        const lastPage = pages[pages.length - 1]?.index || to || analysis.totalPages;
        doc.part = { from: firstPage, to: lastPage, total: analysis.totalPages };
      }
      const whole = !doc.part || (doc.part.from <= 1 && doc.part.to >= doc.part.total);
      if (whole) writeCacheFile(cachePath(key), doc);
      else writeCacheFile(partCachePath(key, from, to), doc);
      return doc;
    } finally {
      progress.delete(key);
    }
  })();
  running.set(slot, task);
  try {
    const doc = await task;
    return { doc, cached: false };
  } finally {
    running.delete(slot);
  }
}

/** 清掉某篇的缓存（PDF 被替换 / 用户手动重排时用） */
export function dropCachedDoc(filePath) {
  const key = cacheKey(filePath);
  if (!key) return false;
  try { fs.rmSync(cachePath(key), { force: true }); return true; } catch (_) { return false; }
}

/** 首屏先算多少页。12 页足够铺满几屏，也足够让页眉页脚的「跨页重复」判定有样本 */
export const FIRST_PAGES = 12;

// ==================== HTTP 接口 ====================

/**
 * 挂到主 Express 应用：
 *   POST /api/reading/doc   { literatureId | achievementId+fileId | fileName | filePath, force }
 *        → { doc, cached }（首次分析需要几秒，前端显示进度提示）
 *   POST /api/reading/drop  { ...同上的定位字段 } → 清缓存
 *
 * 只服务本机阅读器，一律同步返回；不引入作业队列 —— 分析一篇 60 页论文
 * 通常 2~4 秒，比「建作业 → 轮询 → 取结果」的往返更省事。
 */
export function registerReadingRoutes(app, deps) {
  const { store, getUploadDir, resolveAchievementFile } = deps || {};

  function resolve(body) {
    const uploadDir = getUploadDir ? getUploadDir() : null;
    if (body?.achievementId && body?.fileId) {
      if (typeof resolveAchievementFile !== 'function') return { error: '当前版本不支持阅读成果附件' };
      const found = resolveAchievementFile(body.achievementId, body.fileId);
      if (!found) return { error: '找不到该成果附件，或附件文件已丢失' };
      return { path: found.path, name: found.name || path.basename(found.path) };
    }
    if (body?.literatureId) {
      const item = store.listLiterature().find((x) => x.id === body.literatureId);
      if (!item) return { error: '找不到该文献' };
      if (!item.filePath || !fs.existsSync(item.filePath)) return { error: '该文献没有 PDF 附件，或附件已丢失' };
      return { path: item.filePath, name: item.originalName || item.filename || 'paper.pdf' };
    }
    if (body?.fileName) {
      const safe = path.basename(String(body.fileName));
      const full = path.join(uploadDir || '', safe);
      if (!fs.existsSync(full)) return { error: '找不到指定的上传文件：' + safe };
      return { path: full, name: safe };
    }
    return { error: '缺少 literatureId / achievementId+fileId / fileName' };
  }

  app.post('/api/reading/doc', async (req, res) => {
    const found = resolve(req.body);
    if (found.error) return res.status(400).json({ error: found.error });
    if (!/\.pdf$/i.test(found.path)) return res.status(400).json({ error: '阅读模式目前只支持 PDF' });
    const started = Date.now();
    try {
      const fromPage = Number(req.body?.fromPage) || 0;
      const toPage = Number(req.body?.toPage) || 0;
      const { doc, cached } = await buildReadingDoc(found.path, {
        force: !!req.body?.force,
        ...(fromPage || toPage ? { fromPage: fromPage || 1, toPage } : {}),
      });
      // 整篇都没有文字层（纯扫描件）：明确告诉前端「这个模式救不了」，别让它显示空白
      if (!doc.blocks.length) {
        return res.status(422).json({
          error: '这篇 PDF 没有可提取的文字层（多半是扫描件），阅读模式无法重排；已保留原文视图',
          code: 'NO_TEXT_LAYER',
          doc,
        });
      }
      // more=true 时前端会接着拉下一页段（第一段已经能读了，不必等整篇）
      const more = !!(doc.part && doc.part.to < doc.part.total);
      res.json({
        doc, cached, more,
        part: doc.part || null,
        totalPages: doc.part?.total || doc.pages || null,
        elapsedMs: Date.now() - started,
        name: found.name,
      });
    } catch (e) {
      res.status(500).json({ error: '阅读模式分析失败：' + (e?.message || e) });
    }
  });

  /**
   * 预热：打开 PDF 后调用一次。
   * 只算**首屏那一段**（12 页，约 0.25 秒）——整篇要 1.7 秒，预热若算整篇会跟 PDF 渲染
   * 抢 CPU、还赶不上用户点按钮；算首段则几乎必定赶得上，剩下的由点击后的续拉补完。
   */
  app.post('/api/reading/warm', async (req, res) => {
    const found = resolve(req.body);
    if (found.error || !/\.pdf$/i.test(found.path)) return res.json({ ok: false });
    try {
      const { doc, cached } = await buildReadingDoc(found.path, { force: false, fromPage: 1, toPage: FIRST_PAGES });
      res.json({ ok: true, cached, blocks: doc.blocks.length });
    } catch (e) {
      res.json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** 分析进度：前端在等待 /api/reading/doc 期间轮询，用来显示「正在排版 x/N 页」 */
  app.post('/api/reading/progress', (req, res) => {
    const found = resolve(req.body);
    if (found.error) return res.json({ running: false });
    const p = getReadingProgress(found.path);
    res.json(p ? { running: true, ...p } : { running: false });
  });

  app.post('/api/reading/drop', (req, res) => {
    const found = resolve(req.body);
    if (found.error) return res.status(400).json({ error: found.error });
    res.json({ ok: dropCachedDoc(found.path) });
  });
}
