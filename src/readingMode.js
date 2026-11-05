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
import { readManifestFor } from './layoutTranslate.js';
import { getDataDir } from './store.js';
import { refineReadingDoc } from './readingAi.js';

/** 结构版本；结构变了就 +1，旧缓存自动失效 */
export const READING_SCHEMA = 6;

/** 片段样式位（写进结构树的 run 第 4 位，前端据此出 <b>/<i>） */
const STYLE_BOLD = 1;
const STYLE_ITALIC = 2;

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

const TEXT_KINDS = new Set(['title', 'heading', 'caption', 'body', 'reference', 'abstract', 'footnote', 'authors', 'kicker']);

/**
 * 允许居中的块类型。
 *
 * analyzePdf 的 detectAlign 是「每一行的中心都和区域中心对齐」就算居中 —— 两端对齐的
 * 正文段恰好满足：前几行顶满整栏，中心自然重合，只有最后一行短，于是整段被判成居中。
 * 重排后那段文字前几行看着是「两端对齐」，最后一行却浮在中间，非常刺眼。
 * 所以居中只留给真正会居中的类型（大标题、作者行、kicker、图注），正文一律左对齐。
 *
 * 图注还要再收一道：期刊里的图注往往是「Figure 8. 后面跟三五句说明」，在版面上
 * 是左对齐/两端对齐的长段，只有图题那种一行短句才居中。所以超过一行量的图注
 * 一律按左对齐处理 —— 见 captionMayCenter()。
 */
const CENTER_OK = new Set(['title', 'authors', 'kicker', 'caption']);

/** 图注居中的字数上限（约一行半）：超过就当正文段处理 */
const CAPTION_CENTER_MAX = 90;

function captionMayCenter(raw, lineCount = 1) {
  const t = String(raw || '').trim();
  if (!t) return false;               // 拿不到文字就别赌，左对齐最安全
  if (lineCount > 1) return false;    // 多行 = 段落式图注，期刊上也是左对齐
  return t.length <= CAPTION_CENTER_MAX;
}

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
    // URL / DOI / ORCID 行：斜杠和数字多，字母占比天然偏低，但它们是可读文字。
    // 裁成图片会把一行链接放大成整栏宽的截图（ORCID 就是三行巨字）。
    if (/(?:https?:\/\/|www\.|doi\.org|orcid\.org)/i.test(t)) return true;
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
function makeLevelFn(pages, bodySize) {
  const sizes = new Set();
  for (const page of pages) {
    for (const b of page.blocks || []) {
      if (b.kind === 'heading') sizes.add(round(b.size * 2) / 2);
    }
  }
  const ranked = [...sizes].sort((a, b) => b - a);
  const base = Number(bodySize) || 0;
  return (b) => {
    if (b.kind === 'title') return 1;
    if (b.kind === 'heading') {
      // 与正文同字号的节标题（Abstract / Method 这类靠字重区分的）不该因为字号最小
      // 被排到 h5：它们的层级是「一级小节」，按 h2 显示才和纸面观感一致。
      if (base && b.size <= base * 1.02) return 2;
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
      const flags = (it.bold ? STYLE_BOLD : 0) | (it.italic ? STYLE_ITALIC : 0);
      for (const r of splitRunsByLinks(it, flags, page.links)) runs.push(r);
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

/**
 * 按链接注记把片段切小 —— 链接要精确到「哪几个字可点」，就不能整段挂同一个 URL。
 * 字符宽度按片段等分离散（pdf.js 的 item 已是同一字体的连续文字，等宽近似足够准），
 * 切点落在字符边界上，误差最多一个字。
 *
 * run 的格式：[x, w, text, styleFlags, url?]，url 只在有链接时才出现。
 */
function splitRunsByLinks(it, flags, links) {
  const s = String(it.text ?? '');
  const x = Number(it.x) || 0;
  const w = Number(it.w) || 0;
  const base = flags ? [round(x, 2), round(w, 2), s, flags] : [round(x, 2), round(w, 2), s];
  if (!links?.length || !w || !s) return [base];
  const size = Number(it.size) || 10;
  const yLo = (Number(it.y) || 0) - size * 0.35;
  const yHi = (Number(it.y) || 0) + size * 0.95;
  const hits = links.filter((l) => l.y1 > yLo && l.y0 < yHi && l.x1 > x + 0.5 && l.x0 < x + w - 0.5);
  if (!hits.length) return [base];
  const bounds = new Set([x, x + w]);
  for (const h of hits) {
    bounds.add(Math.max(x, Math.min(x + w, h.x0)));
    bounds.add(Math.max(x, Math.min(x + w, h.x1)));
  }
  const xs = [...bounds].sort((a, b) => a - b);
  const perChar = w / s.length;
  const out = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    if (b - a < 0.2) continue;
    const from = Math.max(0, Math.min(s.length, Math.round((a - x) / perChar)));
    const to = Math.max(from, Math.min(s.length, Math.round((b - x) / perChar)));
    const piece = s.slice(from, to);
    if (!piece) continue;
    const mid = (a + b) / 2;
    const link = hits.find((h) => mid >= h.x0 - 0.2 && mid <= h.x1 + 0.2);
    out.push(link
      ? [round(a, 2), round(b - a, 2), piece, flags, link.url]
      : [round(a, 2), round(b - a, 2), piece, flags].slice(0, flags ? 4 : 3));
  }
  return out.length ? out : [base];
}

/**
 * 块的原始文字（用于「这段有多长」这类判断）。
 * analyzePdf 的块是 `lines[].items[].text`，结构树里的节点才是 `lines[].runs[]`；
 * 两条都兜住，否则拿到空串会把「很长的图注」误判成短标题（曾经就这么漏了 1427 字的一段）。
 */
function blockText(block) {
  if (typeof block?.text === 'string' && block.text) return block.text;
  return (block?.lines || []).map((l) => {
    if (Array.isArray(l.items)) return l.items.map((it) => String(it.text ?? '')).join('');
    return (l.runs || []).map((r) => r[2]).join('');
  }).join(' ');
}

/** 文字块 → 结构树节点 */
function textNode(block, level, page, stamps) {
  const kind = TEXT_KINDS.has(block.kind) ? block.kind : 'body';
  const center = block.align === 'center' && CENTER_OK.has(kind)
    && (kind !== 'caption' || captionMayCenter(blockText(block), (block.lines || []).length));
  return {
    t: 'text',
    kind,
    level: level || 0,
    page: page.index,
    rect: rectOf(block),
    align: center ? 'center' : 'left',
    bold: !!block.bold,
    col: Number.isFinite(block.column) ? block.column : -1,
    size: round(block.size, 1),
    lines: packLines(block, page, stamps),
  };
}

/**
 * 裁图节点。图注若与块重叠（图题的块通常紧贴图下方）就并入，前端渲染成 <figcaption>。
 */
function cropNode({ page, rect, kind, caption, size }) {
  const node = {
    t: 'crop',
    k: kind,
    page,
    rect,
    caption: String(caption || '').slice(0, 300),
  };
  // 原始字号的 pt 值：前端据此把裁图按「和正文同样的比例」呈现，
  // 而不是不管多大都拉满整栏（小公式被放大成巨幅、半截公式更显突兀）。
  const s = Number(size);
  if (Number.isFinite(s) && s > 0) node.size = round(s, 1);
  return node;
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

// ==================== 公式 / 图表整块归并 ====================
//
// pdf.js 的文本层常把一个**显示公式拆成好几块**：
//     "PS=" | "αT +βC +γN +δP +εV + εL +θF +ϑS" | "(1)"
// 甚至把括号、上下标、分式线各自成块。逐块裁图的结果是：小的碎片够不到最小面积被丢掉，
// 剩下的半截公式再被等比拉到整栏宽 —— 于是「公式只显示了一半，还特别大」。
// Zotero 的阅读模式里公式是完整的一张图，这里按版面几何把同一条公式的碎片并成一个
// 矩形再裁，并吸收公式编号、分数线这类矢量填充块。

const EQUATION_NO = /^\(\s*\d{1,3}[a-z]?\s*\)$/;

function unionRect(a, b) {
  return [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]),
    Math.max(a[2], b[2]), Math.max(a[3], b[3]),
  ];
}

/** 两矩形中心点是否分处两栏（用于阻止左右栏的公式被并到一起） */
function acrossColumns(a, b, page) {
  const cols = page.columns || [];
  if (cols.length !== 2) return false;
  const mid = (cols[0].x1 + cols[1].x0) / 2;
  const ca = (a[0] + a[2]) / 2;
  const cb = (b[0] + b[2]) / 2;
  return (ca < mid) !== (cb < mid);
}

/**
 * 两块公式碎片是否属于同一条公式。
 * 判据：同一基线带（纵向重叠或中心接近），且横向距离不超过一个合理字距；
 * 另外允许「上下叠放的分子/分母」——横向大幅重叠、纵向只差一点点。
 */
function sameEquation(a, b, base, page) {
  const A = a.rect;
  const B = b.rect;
  const ah = A[3] - A[1];
  const bh = B[3] - B[1];
  if (ah <= 0 || bh <= 0) return false;
  const overlapY = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
  const vRatio = overlapY / Math.max(1, Math.min(ah, bh));
  const sameBand = vRatio >= 0.3
    || Math.abs((A[1] + A[3]) / 2 - (B[1] + B[3]) / 2) <= Math.max(3, Math.min(ah, bh) * 0.75);
  const overlapX = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
  const xRatio = overlapX / Math.max(1, Math.min(A[2] - A[0], B[2] - B[0]));
  const gapY = Math.max(A[1], B[1]) - Math.min(A[3], B[3]);
  const stacked = xRatio >= 0.5 && gapY <= Math.max(2, base * 0.35);
  if (!sameBand && !stacked) return false;
  const gapX = Math.max(A[0], B[0]) - Math.min(A[2], B[2]);
  // 公式编号（(1) / (12a)）常右对齐在栏边，和公式主体隔着一大片空白，距离放宽
  const numbered = EQUATION_NO.test(a.text || '') || EQUATION_NO.test(b.text || '');
  if (gapX > (numbered ? base * 16 : base * 6)) return false;
  if (acrossColumns(A, B, page) && gapX > base * 1.2) return false;   // 左右栏各自的公式不能并
  return true;
}

/**
 * 把一页里的公式碎片并成若干「整条公式」区域。
 * 返回 [{ rect, blocks, text, size }]，面积过小的组直接丢弃（多半是角标、运算符残片）。
 */
function groupEquationParts(parts, page, bodySize) {
  if (!parts.length) return [];
  const base = Number(bodySize) || 10;
  let groups = parts.map((p) => ({
    rect: p.rect.slice(), blocks: [p.block], text: p.text || '', size: p.block.size || base,
  }));
  for (let pass = 0; pass < 6; pass++) {
    const out = [];
    for (const g of groups) {
      const hit = out.find((o) => sameEquation(o, g, base, page));
      if (hit) {
        hit.rect = unionRect(hit.rect, g.rect);
        hit.blocks.push(...g.blocks);
        hit.text = (hit.text + ' ' + g.text).trim();
        hit.size = Math.max(hit.size, g.size);
      } else out.push(g);
    }
    if (out.length === groups.length) break;
    groups = out;
  }
  return groups.filter((g) => {
    const w = g.rect[2] - g.rect[0];
    const h = g.rect[3] - g.rect[1];
    return w >= 10 && h >= 5 && w * h >= MIN_CROP_AREA;
  });
}

/**
 * 把裁图矩形吸收掉紧邻的矢量填充块：分式横线、根号、大括号在 PDF 里是填充路径，
 * 只按文字 bbox 裁会把它们切掉一截。只吃「面积不大、贴着矩形」的块，避免吞掉底纹。
 */
function growWithInk(rect, page, tol = 2.5) {
  const out = rect.slice();
  const area0 = Math.max(1, (out[2] - out[0]) * (out[3] - out[1]));
  for (const f of page.fills || []) {
    const fr = [f.x0, f.y0, f.x1, f.y1];
    const fw = fr[2] - fr[0];
    const fh = fr[3] - fr[1];
    if (fw < 1 || fh < 1) continue;
    if (fw * fh > area0 * 0.45) continue;                 // 大色块是底纹 / 表格底色
    if (!nearBox(out, fr, tol)) continue;
    out[0] = Math.min(out[0], fr[0]);
    out[1] = Math.min(out[1], fr[1]);
    out[2] = Math.max(out[2], fr[2]);
    out[3] = Math.max(out[3], fr[3]);
  }
  return out;
}

/** 裁图矩形统一加一点内边距并夹到页面内：斜体字尾、根号上划线常常压着 bbox */
function padRect(rect, pad, page) {
  const lo = [page.x0 ?? 0, page.y0 ?? 0, page.x1 ?? page.width, page.y1 ?? page.height];
  return [
    round(Math.max(lo[0], rect[0] - pad), 2),
    round(Math.max(lo[1], rect[1] - pad), 2),
    round(Math.min(lo[2], rect[2] + pad), 2),
    round(Math.min(lo[3], rect[3] + pad), 2),
  ];
}

/**
 * 图像 XObject 常被切成好几条（大图分片存储 / 扫描条带 / 图例单独一张图）。
 * 逐张裁图会只剩图的一部分，这里把相接或重叠的图块并成一个外接矩形。
 */
function mergeFigureTiles(cands, base) {
  const tiles = cands.filter((c) => c.kind === 'figure' && !c.vector && !c.block);
  if (tiles.length < 2) return cands;
  let groups = tiles.map((t) => ({ rect: t.rect.slice(), tiles: [t] }));
  const touchTol = Math.max(4, base * 1.2);
  for (let pass = 0; pass < 4; pass++) {
    const out = [];
    for (const g of groups) {
      const hit = out.find((o) => {
        const A = o.rect;
        const B = g.rect;
        const ovX = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
        const ovY = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
        const gapX = Math.max(A[0], B[0]) - Math.min(A[2], B[2]);
        const gapY = Math.max(A[1], B[1]) - Math.min(A[3], B[3]);
        if (ovX > 0 && ovY > 0) return true;                       // 直接重叠
        if (gapX <= touchTol && ovY > Math.min(A[3] - A[1], B[3] - B[1]) * 0.35) return true;
        if (gapY <= touchTol && ovX > Math.min(A[2] - A[0], B[2] - B[0]) * 0.35) return true;
        return false;
      });
      if (hit) {
        hit.rect = unionRect(hit.rect, g.rect);
        hit.tiles.push(...g.tiles);
      } else out.push(g);
    }
    if (out.length === groups.length) break;
    groups = out;
  }
  const merged = groups.map((g) => ({ rect: g.rect, kind: 'figure', blocks: g.tiles.map((t) => t.block) }));
  return [
    ...cands.filter((c) => !(c.kind === 'figure' && !c.vector && !c.block)),
    ...merged,
  ];
}

/**
 * 出版商 / 期刊封面的装饰内容。Zotero 的重排不显示这些，只从论文标题开始：
 * 页顶的刊名、"journal homepage: www.elsevier.com/locate/ije"、以及占半页的
 * 出版商徽记（大树、盾徽、期刊 logo）都不属于论文正文。
 *
 * 判据刻意保守，只碰「页顶 22% 区域内的装饰文字」与「面积 > 22% 页宽×页高、
 * 没有 Fig/Table 图注、本页文字又很少的大图」。带图注的真插图、正文页里的
 * 图表、封面以外的任何内容都不受影响。
 */
const PUBLISHER_DECOR = /journal\s*homepage|www\.|elsevier|sciencedirect|springer|wiley|taylor\s*&\s*francis|sagepub|issn|©|copyright|all\s+rights\s+reserved|available\s+online/i;

/**
 * 强判据：这些文案只会出现在出版商的刊眉 / 封面页 / 页脚版权行上，
 * 正文里绝不会整块出现，命中即剔除 —— 不限位置、不限长度。
 * PDF 常把刊眉抽成没有空格的驼峰串（journalhomepage:www…），匹配前先切开。
 */
const PUBLISHER_STRONG = [
  /this\s*article\s*was\s*downloaded\s*by/i,
  /publication\s*details,?\s*including\s*instructions/i,
  /full\s*terms\s*and\s*conditions\s*of\s*use/i,
  /^to\s*cite\s*this\s*article/i,
  /please\s*scroll\s*down\s*for\s*article/i,
  /contents\s*lists?\s*available\s*at\s*sciencedirect/i,
  /journal\s*homepage/i,
  /available\s*online\s*at\s*www\./i,
  /published\s*online\s*in\s*articles?\s*in\s*advance/i,
  /©\s*\d{4}/,
  /^\d{4}-\d{3}[\dXx]?\/©/,
  /all\s*rights\s*(are\s*)?reserved/i,
  // Elsevier 页眉「Tourism Management 110 (2025) 105182」
  /^[A-Z][^\n]{2,60}?\s\d{2,4}\s\(\d{4}\)\s[\dA-Za-z]+$/,
  // Springer 页眉「Journal of the Academy of Marketing Science (2024) 52:512–530」
  /^\S.{2,60}\s\(\d{4}\)\s\d+:\d+\s?[-–]\s?\d+/,
  // 整块只是一条 DOI 链接的（页脚版权行），不是正文
  /^https?:\/\/(dx\.)?doi\.org\/\S{5,90}$/i,
];

/** 封面 / 下载信息页的整页判据：两类以上固定文案同时出现 → 整页都是出版商的 */
const COVER_PAGE_FURNITURE = [
  /this\s*article\s*was\s*downloaded\s*by/i,
  /publication\s*details,?\s*including\s*instructions/i,
  /full\s*terms\s*and\s*conditions\s*of\s*use/i,
  /^to\s*cite\s*this\s*article/i,
  /please\s*scroll\s*down\s*for\s*article/i,
  /informs\.org/i,
];

/** 无空格驼峰串恢复空格后再匹配（journalhomepage:www → journal homepage: www） */
function splitCamel(t) {
  return String(t || '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function matchPublisherStrong(text) {
  const raw = String(text || '').trim();
  // 原文先试，再试驼峰切开后的形态：切开是为了救「journalhomepage:www…」这种
  // 无空格抽取，但会把 ScienceDirect 切坏，所以两种都要试
  return PUBLISHER_STRONG.some((re) => re.test(raw))
    || PUBLISHER_STRONG.some((re) => re.test(splitCamel(raw)));
}

/**
 * 弱判据（正文里出现 "https://example.org/paper" 很常见）：
 * 只认页顶 22% 刊眉带内、110 字以内的短行，或无空格驼峰的刊名。
 */
function isPublisherDecorText(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (matchPublisherStrong(raw)) return true;
  if (raw.length > 110) return false;
  if (PUBLISHER_DECOR.test(splitCamel(raw))) return true;
  // 刊名常被 PDF 抽成没有空格的驼峰串（InternationalJournalofProductionEconomics）
  return raw.length > 14 && !/\s/.test(raw) && /^[A-Z][A-Za-z]+[A-Z]/.test(raw);
}

function decorativeTextBlocks(page, pageBlocks, bodySize = 0) {
  const out = new Set();
  const H = page.height || 1;
  const weakBand = (page.y1 ?? H) - H * 0.22;
  const headBand = (page.y1 ?? H) - H * 0.14;
  const mastheadBand = (page.y1 ?? H) - H * 0.08;
  let journalName = '';
  // 页眉行常被 markMarginalia 标成 furniture，先从全量 blocks（含 furniture）提刊名
  for (const b of (page.blocks || [])) {
    const t = splitCamel(String(b.text || '').trim());
    const head = t.match(/^([A-Z][^\n]{2,60}?)\s\d{2,4}\s\(\d{4}\)\s[\dA-Za-z]+$/);
    if (head) journalName = head[1].trim().toLowerCase();
  }
  for (const b of pageBlocks) {
    const raw = String(b.text || '').trim();
    if (!raw) continue;
    // 字距拉开的栏目标签（Elsevier 的「A R T I C L E   I N F O」/「A B S T R A C T」）：
    // 语义上就是标签，重排里留着只会变成一行奇怪的碎字
    if (/^(?:[A-Z]\s+){3,}[A-Z]$/.test(raw)) { out.add(b); continue; }
    // 首页正文页顶的刊名 masthead（INFORMS 的 ORGANIZATION SCIENCE / MARKETING SCIENCE）：
    // 全大写、明显大于正文、只出现一次，跨页重复检测抓不到
    if (bodySize > 0 && raw.length <= 46
      && (b.y1 ?? 0) >= mastheadBand
      && (b.size || 0) >= bodySize * 1.05
      && /^[A-Z][A-Z\s&.'’-]*$/.test(raw)) { out.add(b); continue; }
    if (matchPublisherStrong(raw)) { out.add(b); continue; }
    if ((b.y1 ?? 0) >= weakBand && isPublisherDecorText(raw)) out.add(b);
  }
  // 刊头大字刊名（Elsevier banner 的 Tourism Management）：与页眉刊名同名、在页顶带内
  if (journalName) {
    for (const b of pageBlocks) {
      const raw = String(b.text || '').trim().replace(/\s+/g, ' ');
      if (!raw || raw.length > 70) continue;
      if ((b.y1 ?? 0) >= headBand && raw.toLowerCase() === journalName) out.add(b);
    }
  }
  return out;
}

/** 封面 / 下载信息页：两类以上固定文案 → 整页跳过（标题作者下一页还会再出现一遍） */
function isPublisherCoverPage(pageBlocks) {
  let hits = 0;
  for (const b of pageBlocks) {
    const t = splitCamel(String(b.text || '').trim());
    if (COVER_PAGE_FURNITURE.some((re) => re.test(t)) && ++hits >= 2) return true;
  }
  return false;
}

function isDecorativeFigure(cand, page, pageBlocks) {
  const W = page.width || 1;
  const H = page.height || 1;
  const area = (cand.rect[2] - cand.rect[0]) * (cand.rect[3] - cand.rect[1]);
  if (area < W * H * 0.22) return false;
  // 有图注的是论文里的真插图，不是封面徽记
  if (findCaption({ rect: cand.rect }, pageBlocks, H)?.text) return false;
  // 文字多的页是正文页，大图可能是图表，别误杀
  const chars = pageBlocks.reduce((n, b) => n + String(b.text || '').length, 0);
  return chars < 450;
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
  // 同一行被大间隙切开的左右两半（作者行里「·」两侧的大空白、并列机构名）：
  // 纵向重合、横向相接、而且同栏 —— 这种情况纵向 gap 是负的，下面的判据一律会拒，
  // 于是「Christine Ringler」和「· Nancy J. Sirianni…」会各自成段、各自加粗。
  const sameRow = Math.abs(prev.rect[3] - next.rect[3]) < Math.max(3, prev.size * 0.6);
  // 同栏、或者其中一块是跨栏碎片（col=-1）。两个不同栏（0 / 1）的块即使同一基线
  // 也绝不能合并 —— 那正是双栏页左右两栏并排的位置。
  const compatible = prev.col === next.col || prev.col === -1 || next.col === -1;
  if (sameRow && compatible && prev.rect[2] <= next.rect[0] + 2
    && next.rect[0] - prev.rect[2] < prev.size * 12) return true;
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

function markMarginalia(pages, bodySize) {
  if (pages.length < 2) return;
  const base = Number(bodySize) || 0;
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
      // 页眉 / 页脚的通用形态：压在页面最上（下）6% 的窄带里，而且比正文小。
      // 单靠「跨页重复」抓不住这类行 —— 刊名那行每页都带不同的页码和 DOI 尾巴，
      // 归一化之后不再是同一个串，于是首页的刊名就留在了正文开头。
      const edgeBand = b.y1 > top - page.height * 0.06 || b.y0 < left + page.height * 0.06;
      const smallish = base > 0 && (b.size || 0) < base * 0.98;
      const runningHead = edgeBand && smallish && (b.lines || []).length <= 2;
      if ((inBand && repeated) || looksMargin || thinSide || runningHead) {
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

// ==================== 脚注 / 作者单位 ====================
//
// 论文首页经常把作者单位、通讯邮箱、致谢性脚注排成一栏小字（Springer 就是整栏都是
// 脚注）。这些块如果不单独处理，会混进正文流：要么按阅读顺序插在正文中间，
// 要么被当成正文的一部分跟在段落后面。Zotero 的处理是把它们留在页面末尾。
//
// 判据用「字号明显小于正文」+「像脚注的内容」，两条都满足才动 —— 图注、公式编号
// 也是小字，但它们不该被搬到页尾。

const FOOTNOTE_MARK = /^(?:[*†‡§¶#]|\d{1,2}\s|\d{1,2}[.)]\s|[a-z][.)]\s)/;
const FOOTNOTE_HINT = /@|https?:\/\/|e-?mail\s|served as|editor for|corresponding author|通讯作者|邮箱|基金|资助|收稿日期/i;

/** 参考文献条目：作者, A. (2020)… / Retrieved … from … */
const REFERENCE_ENTRY = /^\(?[A-Z][A-Za-z'’-]+,\s*[A-Z]\.|\(\d{4}[a-z]?\)|Retrieved\s+\w+/;

/** 该块像不像脚注（只做内容判断，字号由调用方比） */
function looksLikeFootnote(b) {
  const t = String(b.text || '').trim();
  if (!t) return false;
  // 参考文献里全是邮箱式缩写、年份括号和网址，别被 FOOTNOTE_HINT 一网打尽
  if (REFERENCE_ENTRY.test(t) && t.length > 30) return false;
  if (t.length <= 240 && FOOTNOTE_HINT.test(t)) return true;
  if (t.length <= 160 && FOOTNOTE_MARK.test(t)) return true;
  return false;
}

/**
 * 标记脚注块。两个来源：
 *   1) 内容像脚注（邮箱 / 编辑 / 星号编号）且字号不超过正文 92%；
 *   2) 整栏都是小字（Springer 式首页的整栏作者单位）—— 这一栏整体判为脚注，
 *      否则整栏小字会排在正文前面，读起来像论文从作者单位开始。
 */
function markFootnotes(pages, bodySize) {
  const base = Number(bodySize) || 0;
  if (!base) return;
  for (const page of pages) {
    const blocks = (page.blocks || []).filter((b) => b && b.kind !== 'furniture');
    if (!blocks.length) continue;
    // 每栏的字号中位数：整栏小字 → 该栏是脚注区
    const byCol = new Map();
    for (const b of blocks) {
      const key = b.column ?? -1;
      if (!byCol.has(key)) byCol.set(key, []);
      byCol.get(key).push(b.size || 0);
    }
    const smallCols = new Set();
    if (byCol.size >= 2) {
      const medians = [...byCol.entries()].map(([k, arr]) => {
        const s = arr.slice().sort((x, y) => x - y);
        return [k, s[Math.floor(s.length / 2)]];
      });
      const maxMed = Math.max(...medians.map((m) => m[1]));
      for (const [k, med] of medians) {
        if (med <= base * 0.93 && med < maxMed * 0.96) smallCols.add(k);
      }
    }
    for (const b of blocks) {
      if (b.kind === 'heading' || b.kind === 'title' || b.kind === 'caption') continue;
      if (b.tableLike) continue;
      const size = b.size || 0;
      if (size > base * 0.93) continue;
      // 跨栏块（column 未定，如 Elsevier 首页的摘要）不属于任何「小字栏」：
      // 把它算进 smallCols 会把摘要整段当成脚注推到页末（摘要跑到正文后面）。
      const col = b.column ?? -1;
      const smallCol = col >= 0 && smallCols.has(col);
      // 只在小字栏、或页面下半部分里认脚注：正文字号偏小的期刊（参考文献比正文小一号）
      // 否则会把整段参考文献搬成脚注。
      const top = page.y1 ?? page.height;
      const lowerHalf = b.y1 < top - (page.height || 0) * 0.42;
      if (smallCol || (lowerHalf && looksLikeFootnote(b))) {
        b.kind = 'footnote';
        b.translatable = false;
        b.reason = '脚注 / 作者单位（阅读模式排到页末）';
      }
    }
  }
}

// ==================== 标题识别 ====================
//
// pdf.js 的 fontFamily 只有 serif / sans-serif，靠族名判不出字重；现在字重来自
// 真实字体名（见 analyze.js 的 setFont 处理），绝大多数节标题能直接认出来。
// 剩下两类要补：① 节标题不是粗体（部分期刊如此）；② 粗体的作者行被误判成标题。

const SECTION_LABEL = /^(?:abstract|a\s?b\s?s\s?t\s?r\s?a\s?c\s?t|keywords?|key\s?words|summary|introduction|background|related\s+work|literature\s+review|theoretical\s+(?:background|framework)|hypothes[ei]s|conceptual\s+(?:framework|model)|method(?:ology)?|materials?\s+and\s+methods?|research\s+design|data\s+and\s+(?:method|sample)s?|sample|measures?|procedure|results?|findings|discussion|conclusions?|limitations|implications|managerial\s+implications|future\s+research|acknowledge?ments?|references?|bibliography|appendix|摘要|关键词|引言|绪论|研究背景|文献综述|理论基础|研究假设|研究方法|研究设计|数据与方法|结果|讨论|结论|局限|启示|参考文献|致谢|附录)\s*[:：]?$/i;
const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+[\p{L}\p{Lu}]/u;
const AUTHOR_LIKE = /[·•·][^·•]{2,40}[·•]|,\s*[A-Z][a-z]+\s+[A-Z][a-z]+\s*(?:,|and|&)/;

/** 单行、够短、结尾不是句号 —— 标题的必要条件 */

function fixHeadings(pages, bodySize) {
  const base = Number(bodySize) || 0;
  for (const page of pages) {
    for (const b of page.blocks || []) {
      if (!b || b.kind === 'furniture') continue;
      const text = String(b.text || '').trim();
      if (!text) continue;
      if (b.kind === 'heading' || b.kind === 'title') {
        // 粗体的作者行 / 机构行：一行里用「·」或「and」并列多个名字，不是标题
        const single = (b.lines || []).length === 1;
        if (single && base && (b.size || 0) <= base * 1.06 && AUTHOR_LIKE.test(text) && text.length > 20) {
          b.kind = 'authors';
          continue;
        }
        // 粗体的整行句子（不是标题）：以句号结尾，或长度超过 90 字
        if (single && (/[.。]$/.test(text) || text.length > 110)) {
          b.kind = 'body';
        }
        continue;
      }
      if (!base || b.kind === 'footnote') continue;
      // 非粗体节标题：单独成行、短、命中节名表
      if ((b.lines || []).length === 1 && text.length <= 60 && SECTION_LABEL.test(text)) {
        b.kind = 'heading';
        continue;
      }
      // 全大写的短行（"ORIGINAL EMPIRICAL RESEARCH"）：栏目名 / 眉标，不是正文句子
      if ((b.lines || []).length === 1 && text.length <= 60 && /^[A-Z][A-Z0-9\s&/·-]{5,}$/.test(text)) {
        b.kind = 'kicker';
        continue;
      }
      // 「2 Method」/「3.1 Sample」式编号小节
      const m = text.match(NUMBERED_HEADING);
      if (m && text.length <= 90 && !/[.。]$/.test(text) && (b.lines || []).length <= 2) {
        b.kind = 'heading';
      }
    }
  }
  // 附录里的量表条目：「1. I become angry when my options are limited」这类编号条目
  // 会被版面分析判成小节标题，于是整段附录变成一片加粗大标题，一条正文都读不出来。
  // 判据不看「编号 + 长度」（正文章节「3.1 Sample」也是编号），看**上下文**：
  // 只要这一页出现了「Appendix / 附录」标题，从这一页起、到出现 References /
  // Declarations 为止，比附录标题还小的「标题」都只是条目。
  //
  // 按页判断、不按块数组顺序判断：两栏页的右栏块在数组里排在附录标题**之前**，
  // 按数组顺序做「进入/离开区间」会把整栏条目漏掉（实测右栏 16~20 号条目全部漏网）。
  const APPENDIX_START = /^(?:appendix|appendices|附录)\b/i;
  const APPENDIX_END = /^(?:references?|bibliography|declarations?|funding|acknowledge?ments?|参考文献|致谢|声明)\b/i;
  let inAppendix = false;
  let appendixTitleSize = 0;
  for (const page of pages) {
    const blocks = (page.blocks || []).filter((b) => b && b.kind !== 'furniture');
    if (!inAppendix) {
      const start = blocks.find((b) => (b.kind === 'heading' || b.kind === 'title')
        && APPENDIX_START.test(String(b.text || '').trim()));
      if (!start) continue;
      inAppendix = true;
      // 以附录标题自己的字号作基准 —— 不能用 bodySize：分段加载时后段只有参考文献，
      // 统计出来的 bodySize 是 8.5（参考文献字号），附录条目却是 10pt，比不了。
      appendixTitleSize = start.size || 0;
    }
    let ended = false;
    for (const b of blocks) {
      if (b.kind !== 'heading' && b.kind !== 'title') continue;
      const text = String(b.text || '').trim();
      if (!text) continue;
      if (text.length <= 60 && APPENDIX_END.test(text)) { ended = true; continue; }
      // 比附录标题还小的「标题」只是条目；同字号 / 更大的才可能是真的小节标题
      if (appendixTitleSize && (b.size || 0) < appendixTitleSize - 0.2) {
        b.kind = 'body';
        b.reason = '附录里的编号条目（阅读模式不当标题）';
      }
    }
    if (ended) inAppendix = false;
  }
  // 作者行的碎片归一：同一基线上的左右邻块（被大间隙切开的那半行）跟着标成 authors，
  // 否则「Christine Ringler」会被当成一个一级小节标题加粗显示。
  for (const page of pages) {
    const blocks = (page.blocks || []).filter((b) => b && b.kind !== 'furniture');
    for (const b of blocks) {
      if (b.kind !== 'authors') continue;
      for (const other of blocks) {
        if (other === b || other.kind !== 'heading') continue;
        if ((other.lines || []).length !== 1) continue;
        if (Math.abs((other.y1 || 0) - (b.y1 || 0)) > 2.5) continue;
        if (Math.abs((other.size || 0) - (b.size || 0)) > 1.2) continue;
        other.kind = 'authors';
      }
    }
  }
  // 有 kind 变化后重新定级 —— 调用方在 fixHeadings 之后才建 levelOf
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

  // 2.5) 区带按栏切开：只有「一侧明显是公式」时才切。
  //      双栏页里左右两栏的行常常恰好对齐，一个「表格区」的包围盒很容易横跨栏缝，
  //      右栏的公式就被并进左栏的表格裁图里（公式显示不出来的主要来源之一）。
  //      但真正的通栏大表（表 1 左半是对照组、右半是处理组）必须整张保留，
  //      所以判据不是「跨栏缝」而是「这一侧是不是一坨公式」：块少、块宽、全是公式。
  const splitByColumn = (rect, items) => {
    const cols = page.columns || [];
    if (cols.length !== 2) return [{ rect, items }];
    const mid = (cols[0].x1 + cols[1].x0) / 2;
    if (items.some((b) => b.x0 < mid - 4 && b.x1 > mid + 4)) return [{ rect, items }];
    const left = [];
    const right = [];
    for (const b of items) {
      const cx = (b.x0 + b.x1) / 2;
      (cx < mid ? left : right).push(b);
    }
    const colW = Math.max(1, cols[0].x1 - cols[0].x0);
    const formulaish = (list) => {
      if (!list.length) return false;
      const formulas = list.filter((b) => b.kind === 'formula').length;
      const wide = list.filter((b) => b.kind === 'formula' && (b.x1 - b.x0) > colW * 0.3).length;
      return formulas >= list.length * 0.6 && wide >= 1;
    };
    const box = (list) => [
      Math.min(...list.map((b) => b.x0)), Math.min(...list.map((b) => b.y0)),
      Math.max(...list.map((b) => b.x1)), Math.max(...list.map((b) => b.y1)),
    ];
    if (left.length < 3 || right.length < 3) {
      const keep = left.length >= right.length ? left : right;
      return keep.length >= 4 ? [{ rect: box(keep), items: keep }] : [{ rect, items }];
    }
    const lf = formulaish(left);
    const rf = formulaish(right);
    if (!lf && !rf) return [{ rect, items }];              // 通栏大表，整张保留
    if (rf && !lf) return [{ rect: box(left), items: left }];
    if (lf && !rf) return [{ rect: box(right), items: right }];
    return [{ rect: box(left), items: left }, { rect: box(right), items: right }];
  };

  const consumed = new Set();
  const flatZones = [];
  // 一块区域要真的「连续 3 行以上都是网格行」才算表格区。按栏切开后必须重算：
  // 右栏那种「一行公式 + 几行正文」的假网格只有 1 行，切开后就该被丢掉。
  const gridRowCount = (items) => {
    const rws = [];
    for (const b of items.slice().sort((a, z) => z.y1 - a.y1)) {
      const c = (b.y0 + b.y1) / 2;
      const r = rws.find((x) => Math.abs(x.center - c) <= Math.max(3, (b.y1 - b.y0) * 0.6));
      if (r) r.items.push(b);
      else rws.push({ center: c, items: [b] });
    }
    return rws.filter((r) => {
      if (r.items.length < 3) return false;
      const span = Math.max(...r.items.map((i) => i.x1)) - Math.min(...r.items.map((i) => i.x0));
      return span > w * 0.3;
    }).length;
  };
  for (const zone of zones) {
    const inZone = zone.flatMap((r) => r.items);
    const x0 = Math.min(...inZone.map((i) => i.x0));
    const x1 = Math.max(...inZone.map((i) => i.x1));
    const y0 = Math.min(...inZone.map((i) => i.y0));
    const y1 = Math.max(...inZone.map((i) => i.y1));
    for (const part of splitByColumn([x0, y0, x1, y1], inZone)) {
      if (gridRowCount(part.items) < 3) continue;
      // 表格区里被单独切出来的小块（比如跨格的长标题）一并吞掉
      for (const b of blocks) {
        if (b.kind === 'furniture' || consumed.has(b)) continue;
        const cx = (b.x0 + b.x1) / 2;
        const cy = (b.y0 + b.y1) / 2;
        if (cx > part.rect[0] - 4 && cx < part.rect[2] + 4
          && cy > part.rect[1] - 4 && cy < part.rect[3] + 4) consumed.add(b);
      }
      part.items.forEach((b) => consumed.add(b));
      flatZones.push(part.rect);
    }
  }

  // 3) 用合成块替换掉被吞掉的原始块
  const synth = flatZones.map((rect, i) => ({
    id: `p${page.index}-tbl${i + 1}`,
    index: 0,
    column: -1,
    span: 0,
    colX0: rect[0],
    colX1: rect[2],
    colWidth: rect[2] - rect[0],
    lines: [],
    lineCount: 0,
    text: '',
    rawText: '',
    x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3],
    width: rect[2] - rect[0],
    height: rect[3] - rect[1],
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

// ==================== 版面解析结果（manifest） ====================

/**
 * manifest 标签 → 阅读模式的裁图种类。
 *
 * 这是「先解析版面、再用版面结果重建阅读视图」的核心表：模型说是表格 / 公式 / 插图，
 * 这里就整块裁图，一个字的规则判断都不做。规则路径最大的问题正是「判不准」——
 * 表格被拆成一行行文字、一条四行的公式被拆成「图 + 字 + 图 + 字」，而模型给的是
 * 一整块区域。有解析结果时，以模型为准。
 */
const LAYOUT_ASSET_KIND = {
  table: 'table',
  algorithm: 'table',      // 算法伪码：行号与缩进只有原图能表达
  chart: 'figure',
  image: 'figure',
  display_formula: 'formula',
};

/** manifest 的归一化 bounds → 页内 pt 矩形（PDF 的 y 轴向上，归一化的是向下） */
function layoutRect(bounds, page) {
  const W = page.width || 1;
  const H = page.height || 1;
  const ox = page.x0 || 0;
  const oy = page.y0 || 0;
  const nx = Number(bounds?.x) || 0;
  const ny = Number(bounds?.y) || 0;
  const nw = Number(bounds?.width) || 0;
  const nh = Number(bounds?.height) || 0;
  return [
    ox + nx * W,
    oy + (1 - ny - nh) * H,
    ox + (nx + nw) * W,
    oy + (1 - ny) * H,
  ];
}

/**
 * 这一页由版面模型给出的「图表 / 表格 / 公式」区域。
 *
 * 公式常被框成好几段（一条写成三四行的模型公式），逐框裁还是碎图 ——
 * 同栏、纵向相邻的公式框先并成一张。
 */
function layoutAssetsForPage(layout, page) {
  const out = [];
  const numbers = [];
  for (const b of layout?.blocks || []) {
    if (Number(b.page) !== page.index) continue;
    // 公式编号 (1) 模型是单独一块。它自己既不够大也不该单独成图，先记下来，
    // 稍后并进它上面那条公式 —— 否则重排后编号凭空消失。
    if (b.label === 'formula_number') {
      const r = layoutRect(b.bounds, page);
      if (r[2] - r[0] >= 2 && r[3] - r[1] >= 2) numbers.push(r);
      continue;
    }
    const kind = LAYOUT_ASSET_KIND[b.label];
    if (!kind) continue;
    const rect = layoutRect(b.bounds, page);
    if (rect[2] - rect[0] < 6 || rect[3] - rect[1] < 4) continue;
    out.push({ rect, kind, label: b.label, text: String(b.text || '') });
  }
  // y 向上：先处理靠上的（rect[3] 大的）
  out.sort((a, b) => b.rect[3] - a.rect[3]);
  const merged = [];
  for (const item of out) {
    if (item.kind !== 'formula') { merged.push(item); continue; }
    const w = item.rect[2] - item.rect[0];
    const h = item.rect[3] - item.rect[1];
    const prev = merged.find((m) => m.kind === 'formula'
      && Math.min(m.rect[2], item.rect[2]) - Math.max(m.rect[0], item.rect[0]) > w * 0.5
      && m.rect[1] - item.rect[3] <= h * 1.2 + 6
      && m.rect[1] >= item.rect[3] - h);
    if (prev) { prev.rect = unionRect(prev.rect, item.rect); continue; }
    merged.push({ ...item });
  }
  // 公式编号贴回最近的那条公式（同一栏、编号在公式右侧或正下方）
  for (const num of numbers) {
    const hit = merged
      .filter((m) => m.kind === 'formula')
      .map((m) => ({
        m,
        gap: Math.max(0, m.rect[1] - num[3]),          // 编号在公式下方时为正
        overlap: Math.min(m.rect[2], num[2]) - Math.max(m.rect[0], num[0]),
      }))
      .filter((x) => x.overlap > 0 && x.gap < 14)
      .sort((a, b) => a.gap - b.gap)[0];
    if (hit) hit.m.rect = unionRect(hit.m.rect, num);
  }
  return merged;
}

/** a 是否把 b 整个包住（容差 2pt） */
function containsRect(a, b, tol = 2) {
  return a[0] <= b[0] + tol && a[1] <= b[1] + tol && a[2] >= b[2] - tol && a[3] >= b[3] - tol;
}

// ==================== 规则兜底：数字行表格 / 公式带 ====================

const NUM_TOKEN = /^[-−–—]?(?:\d+[.,]?\d*|\.\d+)%?$/;

/** 一行「标签 + 好几个数字」的表格行；不是这种就返回 null */
function numericRow(b) {
  const t = String(b.text || '').trim();
  if (!t || t.length > 90) return null;
  if ((b.y1 - b.y0) > 26) return null;                 // 多行块不是表格的一行
  const tokens = t.split(/\s+/);
  const nums = tokens.filter((x) => NUM_TOKEN.test(x)).length;
  const chars = t.replace(/\s/g, '');
  if (!chars.length) return null;
  const numChars = (chars.match(/[\d.,%−–-]/g) || []).length;
  if (nums < 3 || numChars / chars.length < 0.45) return null;
  return { nums };
}

/** 「像表格里的标签行」：短、没有句子尾巴、不是正文 */
function labelishRow(b) {
  const t = String(b.text || '').trim();
  if (!t || t.length > 40) return false;
  if (/[.。;；]$/.test(t) && t.split(/\s+/).length > 4) return false;
  if (b.kind === 'body' && t.split(/\s+/).length > 8) return false;
  return !(b.y1 - b.y0 > 26);
}

/**
 * 表格的第二道兜底：整行被抽成一块的「数字表」。
 *
 * collapseTableZones 认的是「一行里至少 3 个独立小块」，遇到 pdf.js 把每个单元格
 * 并成一个文本行的表（MSE 0.001 0.03 0.003 0.05 0.014 这种）就完全看不见 ——
 * 重排出来是一串孤零零的数字行，行列关系全丢。这里按「连续 3 行以上、每行 3 个以上
 * 数字」判成表格区，再向上向下把紧邻的标签行（LightGBM / RF / Tr Te …）一起圈进来。
 */
function collapseNumericTableZones(page, bodySize = 10) {
  const blocks = (page.blocks || []).filter((b) => b.kind !== 'furniture' && b.lines?.length);
  if (blocks.length < 3) return;
  const rows = blocks
    .map((b) => ({ b, info: numericRow(b) }))
    .filter((x) => x.info)
    .sort((a, z) => z.b.y1 - a.b.y1);
  if (rows.length < 3) return;

  const zones = [];
  let run = [];
  const flush = () => { if (run.length >= 3) zones.push(run.slice()); run = []; };
  for (const row of rows) {
    const last = run[run.length - 1];
    const gap = last ? last.b.y0 - row.b.y1 : 0;
    const overlap = last
      ? Math.min(last.b.x1, row.b.x1) - Math.max(last.b.x0, row.b.x0)
      : 1;
    const sameTable = last
      ? gap <= bodySize * 2.6 && gap > -bodySize * 3
        && overlap > Math.min(last.b.x1 - last.b.x0, row.b.x1 - row.b.x0) * 0.3
      : true;
    if (sameTable) run.push(row); else { flush(); run = [row]; }
  }
  flush();
  if (!zones.length) return;

  const consumed = new Set();
  const flat = [];
  for (const zone of zones) {
    let y1 = Math.max(...zone.map((r) => r.b.y1));
    let y0 = Math.min(...zone.map((r) => r.b.y0));
    let x0 = Math.min(...zone.map((r) => r.b.x0));
    let x1 = Math.max(...zone.map((r) => r.b.x1));
    const inZone = new Set(zone.map((r) => r.b));
    // 向上 / 向下把紧邻的标签行并进来（表头、模型名、Tr Te 这种列前缀）
    for (const dir of ['up', 'down']) {
      let edge = dir === 'up' ? y1 : y0;
      for (let guard = 0; guard < 12; guard++) {
        const next = blocks
          .filter((b) => !inZone.has(b) && !consumed.has(b) && labelishRow(b))
          .filter((b) => {
            const cy = (b.y0 + b.y1) / 2;
            if (dir === 'up' ? cy <= edge : cy >= edge) return false;
            const gap = dir === 'up' ? edge - b.y1 : b.y0 - edge;
            return gap <= bodySize * 2.4 && gap >= -bodySize * 1.2;
          })
          .filter((b) => Math.min(b.x1, x1) - Math.max(b.x0, x0) > 4)
          .sort((a, c) => (dir === 'up' ? a.y1 - c.y1 : c.y0 - a.y0))[0];
        if (!next) break;
        inZone.add(next);
        x0 = Math.min(x0, next.x0);
        x1 = Math.max(x1, next.x1);
        if (dir === 'up') { y1 = Math.max(y1, next.y1); edge = Math.min(edge, next.y0); }
        else { y0 = Math.min(y0, next.y0); edge = Math.max(edge, next.y1); }
      }
    }
    for (const b of inZone) consumed.add(b);
    flat.push([x0, y0, x1, y1]);
  }
  if (!flat.length) return;

  const synth = flat.map((rect, i) => syntheticZone(page, rect, i + 1, '数字表区（阅读模式整块裁图）'));
  page.blocks = [...(page.blocks || []).filter((b) => !consumed.has(b)), ...synth];
}

/** 表格 / 公式区域合成块（kind=formula + tableLike，走裁图路径） */
function syntheticZone(page, rect, n, reason, kind = 'formula') {
  return {
    id: `p${page.index}-tbl${n}`,
    index: 0,
    column: -1,
    span: 0,
    colX0: rect[0],
    colX1: rect[2],
    colWidth: rect[2] - rect[0],
    lines: [],
    lineCount: 0,
    text: '',
    rawText: '',
    x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3],
    width: rect[2] - rect[0],
    height: rect[3] - rect[1],
    size: 8,
    lineHeight: 9,
    align: 'left',
    bold: false,
    kind,
    tableLike: true,
    translatable: false,
    reason,
  };
}

const MATH_CHAR = /[=∑∏∫√±×÷≤≥≈≠∞∂∆∇α-ωΑ-Ω]/g;

/**
 * 这一行像公式而不是句子。
 *
 * 只在「单行、短」的块上用（见 formulaBands 的高度判据）：
 * 正文里提一句 β1 是常事，不能因为出现一个希腊字母就把整句裁成图。
 */
function looksMathText(t) {
  const raw = String(t || '').trim();
  if (raw.length < 4 || raw.length > 90) return false;
  const s = raw.replace(/\s+/g, '');
  // 以运算符 / 求和号开头的行一定是续行（"∑M + γm…"、"+ δpInteract…"），
  // 正常句子不会这么起头 —— 这条比比例判据可靠得多。
  if (/^[=+−\-∑∏∫√±<>≤≥]/.test(s)) return true;
  const math = (s.match(MATH_CHAR) || []).length;
  if (!math) return false;
  return math >= 3 || math / s.length >= 0.03;
}

/**
 * 公式带：把「一条写成好几行」的显示公式看成一整块。
 *
 * 纯规则路径最典型的破相就是本函数要解决的问题：四行的嵌套模型公式，中间两行被
 * analyze 判成 formula（→ 裁图），另两行因为字母多被判成 body（→ 排成文字），
 * 于是重排结果是「图、字、图、字」交替，∑ 和等号被切在两张图之间。
 * 做法：把公式块与「像公式的正文块」按栏、按纵向间距连成一条带，整条裁一张。
 */
function formulaBands(page, ordered, bodySize = 10) {
  // 2.2 倍行高：被换行拆开的公式行会有将近两行的框高，卡太紧会把它们漏在带外
  const lineH = Math.max(10, bodySize * 2.2);
  // 分栏边界：公式带绝不能跨栏缝 —— 左右两栏同一基线上的两条公式各是各的。
  const cols = page.columns || [];
  const mid = cols.length === 2 ? (cols[0].x1 + cols[1].x0) / 2 : null;
  const sideOf = (b) => {
    if (b.column === 0 || b.column === 1) return b.column;
    if (Number.isFinite(b.column) && b.column > 1) return 1;
    if (mid == null) return -1;
    return ((b.x0 + b.x1) / 2 < mid) ? 0 : 1;
  };
  const atoms = ordered.filter((b) => {
    if (b.kind === 'furniture' || b.tableLike || !b.lines?.length) return false;
    if (b.kind === 'formula') return true;
    // 只有「单行短块」才可能是公式里的续行；整段正文里出现一个 β 不算
    if ((b.y1 - b.y0) > lineH) return false;
    return TEXT_KINDS.has(b.kind) && looksMathText(b.text);
  });
  if (atoms.length < 2) return [];
  atoms.sort((a, b) => b.y1 - a.y1);
  const bands = [];
  let cur = [];
  for (const b of atoms) {
    const last = cur[cur.length - 1];
    const gap = last ? last.y0 - b.y1 : 0;
    const overlap = last ? Math.min(last.x1, b.x1) - Math.max(last.x0, b.x0) : 1;
    const narrow = last ? Math.min(last.x1 - last.x0, b.x1 - b.x0) : 1;
    // 只看「同一列」+「上下紧邻」：不比较 column 字段 —— 同一列里公式块与文字块的
    // column 经常一个是 -1、一个是 1，比了反而把一条公式拆成两段。
    // 同一行的两块（分子上的 "p=1" 和 "q=1" 分处左右）横向不重叠也是同一条公式
    const sameLine = !!last
      && Math.abs((last.y0 + last.y1) / 2 - (b.y0 + b.y1) / 2)
        < Math.min(last.y1 - last.y0, b.y1 - b.y0) * 0.8;
    const sameSide = !!last
      && (sideOf(last) < 0 || sideOf(b) < 0 || sideOf(last) === sideOf(b));
    const adjoining = last
      && sameSide
      && gap <= Math.max(18, bodySize * 2.2)
      && gap > -bodySize * 4
      && (overlap > narrow * 0.3 || sameLine);
    if (adjoining) cur.push(b);
    else { if (cur.length) bands.push(cur); cur = [b]; }
  }
  if (cur.length) bands.push(cur);

  const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);

  const out = [];
  for (const band of bands) {
    if (band.length < 2 || !band.some((b) => b.kind === 'formula')) continue;
    // 数字占比过半的一串「公式」其实是表格里的一列列数字（analyze 常把表体判成
    // formula）。这种不该按公式交付，按表格交付才和用户的预期一致。
    const chars = band.reduce((n, b) => n + String(b.text || '').replace(/\s/g, '').length, 0);
    const digits = band.reduce(
      (n, b) => n + (String(b.text || '').match(/[\d.,%]/g) || []).length, 0);
    const numeric = chars > 0 && digits / chars > 0.55;
    const item = {
      rect: band.reduce((r, b) => unionRect(r, rectOf(b)), rectOf(band[0])),
      blocks: band.slice(),
      size: Math.max(0, ...band.map((b) => Number(b.size) || 0)) || bodySize,
      kind: numeric ? 'table' : 'formula',
    };
    // 相邻两条带被判定切开、矩形却压在一起时并回一条，避免同一处出现两张叠着的图
    const hit = out.find((m) => {
      const w = Math.min(m.rect[2], item.rect[2]) - Math.max(m.rect[0], item.rect[0]);
      const h = Math.min(m.rect[3], item.rect[3]) - Math.max(m.rect[1], item.rect[1]);
      if (w <= 0 || h <= 0) return false;
      return (w * h) > Math.min(area(m.rect), area(item.rect)) * 0.2;
    });
    if (hit) {
      hit.rect = unionRect(hit.rect, item.rect);
      hit.blocks.push(...item.blocks);
      hit.size = Math.max(hit.size, item.size);
      continue;
    }
    out.push(item);
  }
  return out;
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

function nodeChars(node) {
  return (node.lines || []).reduce(
    (n, l) => n + (l.runs || []).reduce((m, r) => m + String(r[2] || '').length, 0), 0);
}

/** 结构树里一个文字节点的完整文本（行间补空格） */
function nodeText(node) {
  if (node.t !== 'text') return '';
  return (node.lines || []).map((l) => (l.runs || []).map((r) => String(r[2] || '')).join(''))
    .join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 跨栏 / 跨页断行处的连字符接合：`con-` + `stantly` → `constantly`。
 * 不在 run 层做的话，前端装配时按「片段间隙补空格」会拼成 `con- stantly`。
 */
function joinHyphen(prev, next) {
  const line = prev.lines?.[prev.lines.length - 1];
  const nextLine = next.lines?.[0];
  const tail = line?.runs?.[line.runs.length - 1];
  const head = nextLine?.runs?.[0];
  if (!tail || !head) return false;
  const a = String(tail[2] || '');
  const b = String(head[2] || '');
  if (!/[A-Za-z]-$/.test(a) || !/^[a-z]/.test(b)) return false;
  tail[2] = a.slice(0, -1) + b;
  nextLine.runs.shift();
  if (!nextLine.runs.length) next.lines.shift();
  return true;
}

/**
 * 合并两块文字。跨栏 / 跨页接续时额外记下每一截来自哪一页哪一栏、占多少字符：
 * 这就是「译文按原比例分回两处」所需的权重 —— 整句先拼好送翻译，拿到译文后
 * 按 parts 的 ratio 切开，分别回填到两个位置。
 */
function mergeNodes(prev, next, opts = {}) {
  const charsPrev = nodeChars(prev);
  const charsNext = nodeChars(next);
  joinHyphen(prev, next);
  if (opts.continuation) {
    const parts = prev.parts || [{ page: prev.page, col: prev.col ?? -1, chars: charsPrev }];
    const last = parts[parts.length - 1];
    if (last.page === next.page && last.col === (next.col ?? -1)) last.chars += charsNext;
    else parts.push({ page: next.page, col: next.col ?? -1, chars: charsNext });
    const total = parts.reduce((n, p) => n + p.chars, 0) || 1;
    for (const p of parts) p.ratio = round(p.chars / total, 4);
    prev.parts = parts;
  }
  prev.lines.push(...next.lines);
  const [ax0, ay0, ax1, ay1] = prev.rect;
  const [bx0, by0, bx1, by1] = next.rect;
  prev.rect = [Math.min(ax0, bx0), Math.min(ay0, by0), Math.max(ax1, bx1), Math.max(ay1, by1)];
  return prev;
}

/** 跳过页末的脚注，找最后一个正文节点 —— 跨页接续要从它往后接 */
function lastBodyNode(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const n = list[i];
    if (n.t === 'text' && n.kind !== 'footnote') return n;
    if (n.t === 'crop') return n;
  }
  return null;
}

// ==================== 首页版面顺序 ====================
//
// 版面解析出来的首页块顺序不一定等于「读者想读的顺序」：Elsevier 首页左侧是一条
// ARTICLE INFO 边栏（Keywords / DOI / 通讯作者），右边才是摘要；有的期刊把作者单位
// 放在摘要后面，还有的把 Highlights 排在标题前。Zotero 的阅读模式一律按
// 标题 → 作者 → 单位 → 摘要 → 关键词 → 正文 排，这里照做。
//
// 只调整「标题到 Introduction 之间」的这一小段，其余部分保持版面阅读顺序不动 ——
// 动得越少，越不会把正文顺序弄乱。

const ABSTRACT_LABEL = /^(?:a\s?b\s?s\s?t\s?r\s?a\s?c\s?t|abstract|摘\s*要)\s*[:：.．—–-]?$/i;
const KEYWORDS_LABEL = /^(?:key\s?words?|key\s?terms?|index\s+terms|关键词)\s*[:：]?/i;
const INTRO_LABEL = /^(?:\d{1,2}\.?\s*)?(?:introduction|引言|绪论|研究背景)\s*[:：]?$/i;
const AFFIL_LIKE = /(?:universit|college|school\s+of|department|institute|faculty|business\s+school|@[\w.-]+\.|学院|大学|研究院|系\s*$)/i;

/**
 * 首页前区重排。返回新数组，不修改输入。
 * 找不到论文标题（扫描件 / 结构异常）时原样返回，绝不凭空调整顺序。
 */
export function orderFrontMatter(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 4) return blocks;
  const start = blocks.findIndex((b) => b.t === 'text' && b.kind === 'title');
  if (start < 0) return blocks;

  // 窗口结束：第一个 Introduction 标题；没有就取「标题所在页 + 1 页」以内的 60 块
  let end = blocks.findIndex((b, i) => i > start && b.t === 'text'
    && b.kind === 'heading' && INTRO_LABEL.test(nodeText(b)));
  if (end < 0) {
    const firstPage = blocks[start].page;
    let i = start + 1;
    while (i < blocks.length && blocks[i].page <= firstPage + 1 && i - start <= 60) i++;
    end = i;
  }
  if (end <= start + 1) return blocks;

  const head = blocks.slice(0, start);
  const win = blocks.slice(start, end);
  const tail = blocks.slice(end);

  // 分档：0 标题 / 1 作者 / 2 单位 / 3 摘要小标题 / 4 摘要正文 / 5 关键词 / 6 其余
  const scored = win.map((b, i) => {
    const text = nodeText(b);
    let bucket = 6;
    if (b.t === 'text') {
      if (b.kind === 'title' || i === 0) bucket = 0;
      else if (isAuthorLine(b, text, i)) bucket = 1;
      else if (ABSTRACT_LABEL.test(text) && text.length <= 24) bucket = 3;
      else if (KEYWORDS_LABEL.test(text) && text.length <= 60) bucket = 5;
      else if (AFFIL_LIKE.test(text) && text.length < 240
        && (b.size || 0) <= (win[0].size || 12) * 1.02 && (b.size || 0) < 10) bucket = 2;
    }
    return { b, bucket, i };
  });

  // 没有「A B S T R A C T」小标题的期刊（Elsevier 的栏目名常被当成纯符号丢掉）：
  // 把「作者 / 单位之后、第一个节标题之前」的正文段落当作摘要。
  if (!scored.some((s) => s.bucket === 3)) {
    let started = false;
    for (const s of scored) {
      if (!started) {
        if (s.bucket <= 2) continue;                       // 标题 / 作者 / 单位 / 脚注
        if (s.b.t === 'text' && s.b.kind === 'body') { started = true; s.bucket = 4; continue; }
        break;                                             // 先碰到标题或图表：没有摘要段
      }
      if (s.b.t !== 'text' || s.b.kind !== 'body') break;
      s.bucket = 4;
    }
  } else {
    // 有摘要小标题时，标题之后、关键词之前的正文一律算摘要正文
    let seen = false;
    for (const s of scored) {
      if (s.bucket === 5) seen = false;
      if (s.bucket === 3) { seen = true; continue; }
      if (seen && s.bucket === 6 && s.b.kind === 'body') s.bucket = 4;
      if (seen && (s.b.kind === 'heading' || s.b.kind === 'kicker')) seen = false;
    }
  }

  // 作者行原来是「小节标题」：改成 authors，前端才不会按 h2 加粗放大
  for (const s of scored) {
    if (s.bucket === 1 && s.b.t === 'text' && s.b.kind !== 'authors') {
      s.b.kind = 'authors';
      s.b.level = 0;
    }
  }

  scored.sort((x, y) => (x.bucket - y.bucket) || (x.i - y.i));
  return [...head, ...scored.map((s) => s.b), ...tail];
}

/**
 * 作者行判定。`fixHeadings` 只能认出「一行里用 · 并列多个名字」的那种，
 * 英文期刊更常见的是「Fang Dong, Weijia Liu, Zhiqing Wang」：它会被判成小节标题，
 * 于是重排后跑到单位下面、甚至加粗成大标题。这里按「标题后不远处 + 逗号并排的人名」
 * 补一道判据。
 */
function isAuthorLine(b, text, idx) {
  if (b.kind === 'authors') return true;
  if (idx < 1 || idx > 8) return false;
  if (b.kind !== 'heading') return false;
  if (!text || text.length > 240 || /[.。]$/.test(text)) return false;
  const names = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+\b/g) || [];
  return names.length >= 1 && (/[,，]/.test(text) || /\band\b/.test(text));
}

/**
 * analyzePdf 的版面结构 → 阅读模式文档树。
 *
 * 纯函数（不碰文件系统、不读 PDF），测试可以直接喂构造的 pages 进来断言。
 *
 * @param {object} analysis analyzePdf 的结果
 * @param {{layout?:object}} [opts] layout = 版面解析的 manifest（有就优先用它的区域）
 * @returns {{v:number,pages:number,blocks:object[],stats:object,warnings:string[]}}
 */
export function toReadingDoc(analysis, opts = {}) {
  const layout = opts.layout && Array.isArray(opts.layout.blocks) ? opts.layout : null;
  const pages = Array.isArray(analysis?.pages) ? analysis.pages : [];
  const totalPages = analysis?.totalPages || pages.length;
  const bodySize = Number(analysis?.stats?.bodySize) || 0;
  markMarginalia(pages, bodySize);
  markFootnotes(pages, bodySize);
  fixHeadings(pages, bodySize);
  const levelOf = makeLevelFn(pages, bodySize);
  const stamps = collectStamps(pages);
  const blocks = [];
  const warnings = [];
  const pageTops = new Map();
  for (const page of pages) pageTops.set(page.index, (page.y1 ?? page.height) - (page.height || 0) * 0.08);

  const stats = { text: 0, figures: 0, tables: 0, formulas: 0, chars: 0, emptyPages: 0, footnotes: 0, layoutPages: 0 };

  for (const page of pages) {
    // 有版面解析结果的页：区域以模型为准，规则兜底（表格区 / 数字表）不再插手 ——
    // 规则是用来补模型缺席的，两套同时上只会互相抢区域。
    const layoutAssets = layout ? layoutAssetsForPage(layout, page) : null;
    const layoutCovered = !!layoutAssets && layoutAssets.length > 0;
    if (layoutCovered) stats.layoutPages++;
    if (!layoutCovered) {
      collapseTableZones(page);
      collapseNumericTableZones(page, bodySize || 10);
    }
    const pageBlocks = (page.blocks || []).filter((b) => b && b.kind !== 'furniture');
    // 出版商的封面 / 下载信息页（INFORMS 那种整页 "This article was downloaded by…"）：
    // 标题与作者在下一页还会完整出现一遍，整页跳过，免得 boilerplate 插进正文顺序里
    if (isPublisherCoverPage(pageBlocks)) {
      warnings.push(`第 ${page.index} 页是出版商信息页，已整体跳过。`);
      continue;
    }
    const ordered = readingOrder(page);
    const decorText = decorativeTextBlocks(page, pageBlocks, bodySize);
    const rankOf = new Map(ordered.map((b, i) => [b, i]));
    const items = [];
    const cropRects = [];
    const textRects = [];
    let decorativePage = false;

    // 1) 裁图候选：表格碎块 / 公式整块 / 图像 XObject / 矢量插图。
    //    先集中收集再统一判定，是因为「图注」要跟着裁图一起处理 —— 图注的文字
    //    由裁图节点的 <figcaption> 呈现，若同时再排一遍文字块，图注会重复出现一次。
    const cands = [];
    const consumed = new Set();
    // 0) 版面解析给出的区域：表格 / 公式 / 插图，一律整块裁图。
    //    这是「用版面解析结果重建阅读视图」的落点 —— 表格不再被摊成一行行文字，
    //    四行的公式也不再被拆成「图、字、图、字」。
    if (layoutCovered) {
      for (const a of layoutAssets) {
        // 表格 / 插图这里不加内边距：后面统一会 padRect(1)，加两次会多吃掉一圈邻居。
        // 公式则要吸收矢量墨迹（分数线、根号）再多留 1.5pt。
        const rect = a.kind === 'formula'
          ? padRect(growWithInk(a.rect, page), 1.5, page)
          : a.rect;
        cands.push({ rect, kind: a.kind, block: null, layout: true });
      }
    }
    for (const b of ordered) {
      // 表格伪块：整块保留（表格的行列关系只有原图能表达）
      if (b.kind !== 'formula' || !b.tableLike || isTextBlock(b) || !isCropBlock(b)) continue;
      if (layoutCovered && layoutAssets.some((a) => containsRect(a.rect, rectOf(b), 4))) continue;
      cands.push({ rect: rectOf(b), kind: 'table', block: b });
    }
    // 公式带：一条公式写成好几行时，中间几行会被判成正文（字母占比高）——
    // 单看每一块都「像文字」，连起来才是公式。整条带裁一张，这些块不再排成文字。
    // 必须先于「逐块公式」收集：否则逐块裁出来的小图会先占位，整条带的图因为
    // 重叠被 accepted 丢掉，而那几个文字块已经进了 consumed —— 结果是最难看的一种：
    // 文字消失、图也没有。
    if (!layoutCovered) {
      for (const band of formulaBands(page, ordered, bodySize || 10)) {
        const rect = padRect(growWithInk(band.rect, page), 1.5, page);
        const rank = Math.min(...band.blocks.map((b) => rankOf.get(b) ?? 0));
        cands.push({ rect, kind: band.kind || 'formula', rank, block: null, size: band.size });
        for (const b of band.blocks) consumed.add(b);
      }
    }
    const formulaParts = [];
    for (const b of ordered) {
      if (b.kind !== 'formula' || b.tableLike || isTextBlock(b)) continue;
      if (!b.lines?.length) continue;
      if (consumed.has(b)) continue;
      if (layoutCovered && layoutAssets.some((a) => containsRect(a.rect, rectOf(b), 4))) continue;
      formulaParts.push({ rect: rectOf(b), block: b, text: String(b.text || '').trim() });
    }
    for (const g of groupEquationParts(formulaParts, page, bodySize)) {
      const rect = padRect(growWithInk(g.rect, page), 1.5, page);
      const rank = Math.min(...g.blocks.map((b) => rankOf.get(b) ?? 0));
      cands.push({ rect, kind: 'formula', rank, block: null, size: g.size });
    }
    for (const img of page.images || []) {
      const rect = [img.x0, img.y0, img.x1, img.y1];
      if ((rect[2] - rect[0]) * (rect[3] - rect[1]) < MIN_FIGURE_AREA) continue;
      cands.push({ rect, kind: 'figure', block: null });
    }
    for (const rect of vectorFigures(page, ordered.filter(isTextBlock))) {
      cands.push({ rect, kind: 'figure', block: null, vector: true });
    }
    // 版面已判过是图表的区域：规则再算出来的小块（图里的一条柱子、一行坐标标签）
    // 都该被那张大图吸收，否则同一张图会被裁成「整图 + 几个碎片」。
    if (layoutCovered) {
      for (let i = cands.length - 1; i >= 0; i--) {
        const c = cands[i];
        if (c.layout) continue;
        if (layoutAssets.some((a) => containsRect(a.rect, c.rect, 4))) cands.splice(i, 1);
      }
    }
    // 分片存储的插图（大图切成几条、图例单独一张图）先并回整张
    cands.splice(0, cands.length, ...mergeFigureTiles(cands, bodySize));
    // 期刊封面 / 出版商徽记：只剔除「图像 XObject」这类装饰图，不动矢量框架图、
    // 表格伪块和带图注的真插图。前提是这一页真有出版商刊眉 —— 否则整页无文字的
    // 扫描件大图会被误当成封面丢掉。整页都是装饰的页，后面也不补整页裁图。
    const H = page.height || 1;
    const bannerBand = (page.y1 ?? H) - H * 0.18;
    if (decorText.size > 0) {
      for (let i = cands.length - 1; i >= 0; i--) {
        const c = cands[i];
        if (c.kind !== 'figure' || c.vector || c.block) continue;
        if (findCaption({ rect: c.rect }, pageBlocks, H)?.text) continue;
        // 有刊眉装饰文字的页：页顶 18% 带内、无图注的横幅图（期刊封面缩略图 / logo），
        // 或面积超过整页 22% 的大徽记，都是装饰。带图注、或在文字页中部的大图不动。
        const inBanner = c.rect[1] >= bannerBand && c.rect[3] <= (page.y1 ?? H);
        if (!inBanner && !isDecorativeFigure(c, page, pageBlocks)) continue;
        cands.splice(i, 1);
      }
      // 封面页既不该保留大徽记，也不该「兜底补一张整页裁图」把封面又放回来
      decorativePage = true;
    }

    const accepted = [];
    for (const cand of cands) {
      if (accepted.some((a) => overlapRatio(a.rect, cand.rect))) continue;
      // 图像 XObject 常被当作页底色块铺在文字下面：与正文高度重叠的不算插图。
      // 矢量插图区由 vectorFigures 自己按「簇内文字占比」判过，不再重复挡。
      if (cand.kind === 'figure' && !cand.vector && !cand.layout
        && ordered.some((b) => isTextBlock(b) && overlapRatio(rectOf(b), cand.rect, 0.3))) continue;
      accepted.push(cand);
    }

    // 图注归位：被裁图「吃掉」的图注块不再单独排成一行文字。
    // 一张图注只能归一张图 —— 同一页里上方插图和下方表格挨得近时，按「距离最近」
    // 贪心分配，否则表格会抢走上一张图的图注（figcaption 张冠李戴）。
    const pairs = [];
    for (const cand of accepted) {
      const cap = findCaption({ rect: cand.rect }, pageBlocks, page.height);
      if (cap) pairs.push({ cand, cap, gap: cap.gap });
    }
    pairs.sort((a, b) => a.gap - b.gap);
    for (const { cand, cap } of pairs) {
      if (consumed.has(cap.block)) continue;
      cand.caption = String(cap.text || '').slice(0, 300);
      consumed.add(cap.block);
    }

    for (const cand of accepted) {
      const rect = cand.kind === 'formula' ? cand.rect : padRect(cand.rect, 1, page);
      const node = cropNode({
        page: page.index,
        rect: rect.map((v) => round(v, 2)),
        kind: cand.kind,
        caption: cand.caption,
        size: cand.size,
      });
      cropRects.push(node.rect);
      // 裁图排在「它本该出现的位置」：表格/公式用它自己的阅读顺序名次（这样被吃掉的
      // 图注不会把它拽到上一栏去），插图用 cropRank 现算。
      const rank = Number.isFinite(cand.rank)
        ? cand.rank
        : (cand.block ? (rankOf.get(cand.block) ?? 0) : cropRank(cand.rect, ordered, page.columns));
      items.push({ rank, y: cand.rect[3], seq: items.length, el: node });
      if (cand.kind === 'table') stats.tables++;
      else if (cand.kind === 'formula') stats.formulas++;
      else stats.figures++;
    }

    // 2) 文字块：可重排的走文本，其余（表格 / 公式 / 碎块）走裁图。
    //    脚注单独收集：它们在本页正文之后统一追加，不能参与正文的排序与拼接。
    const noteNodes = [];
    for (const b of ordered) {
      if (!isTextBlock(b)) continue;
      if (decorText.has(b)) continue;              // 页顶刊名 / journal homepage
      if (b.x1 - b.x0 < MIN_TEXT_W || b.y1 - b.y0 < MIN_TEXT_H) continue;
      if (consumed.has(b)) continue;
      // 版面说是表格 / 公式 / 插图的区域：里面的字已经画在裁图里了。
      // 不拦这一步，表格就会被「裁一张图 + 旁边再摊一遍逐行文字」双重呈现。
      if (layoutCovered && layoutAssets.some((a) => centerIn(b, a.rect))) continue;
      // 落在插图里的短文字（坐标轴标签、图例）已经画在裁图里了，再排一遍就是重复
      if (cropRects.some((r) => centerIn(b, r))) continue;
      // 角标（作者单位编号 1 2 3、脚注星号）：几个 pt 的数字，裁成图毫无意义
      const plain = String(b.text || '').trim();
      if (plain.length <= 4 && (b.size || 0) < Math.max(6, bodySize * 0.72)) continue;
      const node = textNode(b, levelOf(b), page, stamps);
      if (!node.lines.length) continue;
      textRects.push(node.rect);
      if (b.kind === 'footnote') {
        // 每页第一段脚注带一条分隔线，和正文分开（Zotero 用一条细线做同样的标记）
        if (!noteNodes.length) node.sep = true;
        noteNodes.push(node);
        stats.footnotes++;
        continue;
      }
      items.push({ rank: rankOf.get(b) ?? 0, y: b.y1, seq: items.length, el: node });
      stats.text++;
      stats.chars += node.lines.reduce(
        (n, l) => n + l.runs.reduce((m, r) => m + r[2].length, 0), 0);
    }

    if (!items.length && !noteNodes.length) {
      // 整页都没有可重排的内容：扫描页、整页插图（大图 / 大表）。重排救不了它，
      // 但也不能让这一页在阅读视图里凭空消失 —— 整页裁一张图放进去，内容不丢。
      const hasVisual = ((page.images || []).length > 0 || (page.rawItems || 0) > 0)
        && !decorativePage;   // 纯封面 / 出版商页直接略过，重排里不该出现
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

    // 3) 页内排序：阅读顺序名次优先，同名义次再按纵向从上到下。
    //    脚注不参与排序，整页正文排完之后接在末尾（Zotero 也是这么放的）：
    //    脚注按阅读顺序本来就该在页末，混进正文只会把一句话切成两截。
    items.sort((a, b) => (a.rank - b.rank) || (b.y - a.y) || (a.seq - b.seq));
    const pageNodes = joinAdjacent([...items.map((i) => i.el), ...noteNodes])
      .map((n) => ({ ...n, _pageEnd: false }));
    // 跨页接续要看「最后一个正文块」，脚注在它之后
    const lastBody = [...pageNodes].reverse().find((n) => n.kind !== 'footnote');
    if (lastBody) lastBody._pageEnd = true;
    else pageNodes[pageNodes.length - 1]._pageEnd = true;
    // 栏间断句：双栏排版里一句话经常在栏底断开、下一栏接着写
    //（"…view the demonstration together," / "or demonstrators might invite…"）。
    // 给每一栏的最后一个正文块打上 _colEnd，让下面第 4 步的接续逻辑也能跨栏接上，
    // 否则用户看到的仍然是「一句话被拆成两段」。同栏后来的会覆盖前面的 → 拿到栏末那个。
    const lastInCol = new Map();
    for (const n of pageNodes) {
      if (n.t !== 'text' || n.kind === 'footnote') continue;
      lastInCol.set(n.col ?? -1, n);
    }
    for (const n of lastInCol.values()) n._colEnd = true;
    blocks.push(...pageNodes);

    // 3.5) 整页图形兜底：框架图 / 流程图这类图大多是用**描边**画的，进不了
    //      vectorFigures（它只认填充色块），页面上又只有几个零散标签字。
    //      这种页在此前只剩一行刊名，图整个丢掉。判据是「可重排的文字极少、
    //      但这一页的原始文字片段很多」，补一张整页裁图，宁可多看一张图也不丢内容。
    if (!decorativePage && pageNodes.length && (page.rawItems || 0) >= 30) {
      const chars = pageNodes.reduce((n, node) => n + (node.lines || []).reduce(
        (m, l) => m + l.runs.reduce((k, r) => k + r[2].length, 0), 0), 0);
      if (chars < 200 && !cropRects.length) {
        const full = [
          round((page.x0 ?? 0) + 1, 2),
          round((page.y0 ?? 0) + 1, 2),
          round((page.x1 ?? page.width) - 1, 2),
          round((page.y1 ?? page.height) - 1, 2),
        ];
        blocks.push({ t: 'crop', k: 'figure', page: page.index, rect: full, caption: '', full: true, _pageEnd: true });
        stats.figures++;
        warnings.push(`第 ${page.index} 页几乎全是整页图形（框架图 / 流程图），已按原页裁图保留。`);
      }
    }
  }

  // 4) 跨页 / 跨栏段落接续
  const merged = [];
  for (const cur of blocks) {
    const prev = lastBodyNode(merged);
    if (prev && (prev._pageEnd === true || prev._colEnd === true)
      && canContinue(prev, cur, pageTops.get(cur.page))) {
      mergeNodes(prev, cur, { continuation: true });
      prev._pageEnd = cur._pageEnd === true;
      prev._colEnd = cur._colEnd === true;
      continue;
    }
    merged.push(cur);
  }
  for (const b of merged) delete b._pageEnd;

  // 4.5) 首页前区按「标题 → 作者 → 单位 → 摘要 → 关键词」归位
  const orderedDocs = orderFrontMatter(merged);

  // 5) 编号与稳定 id（前端拿它做定位锚点）
  orderedDocs.forEach((b, i) => { b.id = `r${i + 1}`; });

  return {
    v: READING_SCHEMA,
    pages: totalPages,
    analyzedPages: pages.length,
    // 正文基准字号 / 是否衬线：排版控件的「跟随原文」用它，避免整篇字体选错
    bodySize: analysis?.stats?.bodySize || 10,
    bodySerif: analysis?.stats?.bodySerif ?? null,
    blocks: orderedDocs,
    stats: {
      ...stats,
      blocks: orderedDocs.length,
      headings: orderedDocs.filter((b) => b.t === 'text' && b.level > 0).length,
      paragraphs: orderedDocs.filter((b) => b.t === 'text' && b.level === 0).length,
    },
    warnings: [...new Set(warnings)].slice(0, 12),
  };
}

// ==================== 缓存 ====================

/** 不随版面解析结果变化的基键（清缓存时按它扫前缀） */
function baseKey(filePath) {
  let st = null;
  try { st = fs.statSync(filePath); } catch (_) { return null; }
  const raw = `${path.resolve(filePath)}|${st.size}|${Math.round(st.mtimeMs)}|${READING_SCHEMA}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

/**
 * 版面解析结果的指纹。
 *
 * 同一篇 PDF 在「解析前 / 解析后」是**两份不同的阅读稿**（后者表格公式是整块图），
 * 缓存必须分开存，否则用户解析完版面回到阅读模式还是旧的碎文字版本。
 */
function layoutSig(layout) {
  if (!layout) return 'nl';
  const raw = `${layout.inputSHA256 || ''}|${layout.blocks?.length || 0}|${layout.pages || 0}|${layout.schemaVersion || 0}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
}

function cacheKey(filePath, layout) {
  const base = baseKey(filePath);
  return base ? `${base}--${layoutSig(layout)}` : null;
}

function cachePath(key) {
  return path.join(readingCacheDir(), key + '.json');
}

/** 读缓存；结构版本不符或文件被替换过都算未命中 */
export function readCachedDoc(filePath, layout = null) {
  const key = cacheKey(filePath, layout);
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
  const key = baseKey(filePath);
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
 * @param {{force?:boolean, fromPage?:number, toPage?:number, layoutId?:string, layout?:object, dataDir?:string}} [opts]
 *        layoutId：文献 id，有版面解析结果时优先用它（表格 / 公式 / 插图按模型区域整块裁图）
 */
export async function buildReadingDoc(filePath, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    const e = new Error('找不到该文献的 PDF 文件');
    e.code = 'ENOENT_PDF';
    throw e;
  }
  // 版面解析结果：优先用显式传入的 manifest（测试），否则按文献 id 去数据目录读
  let layout = opts.layout && Array.isArray(opts.layout.blocks) ? opts.layout : null;
  if (!layout && opts.layoutId) {
    try { layout = readManifestFor(opts.dataDir || getDataDir(), opts.layoutId); } catch (_) { layout = null; }
  }
  // 整篇缓存优先级最高：有了它，分段请求也直接给整篇（前端会一次拿全，不再续拉）
  if (!opts.force) {
    const cached = readCachedDoc(filePath, layout);
    if (cached) return { doc: cached, cached: true };
  }
  const from = Math.max(1, Math.floor(Number(opts.fromPage) || 1));
  const to = Math.max(0, Math.floor(Number(opts.toPage) || 0));
  const partial = to > 0 || from > 1;
  const key = cacheKey(filePath, layout) || path.resolve(filePath);
  const slot = partial ? `${key}--p${from}-${to || 'end'}` : key;
  const progKey = baseKey(filePath) || key;

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
    progress.set(progKey, { page: partial ? from - 1 : 0, total: 0, percent: 0, startedAt: Date.now() });
    try {
      const bytes = await fs.promises.readFile(filePath);
      const analysis = await analyzePdf(bytes, {
        ...(partial ? { fromPage: from, toPage: to } : {}),
        onProgress: (p) => {
          const cur = progress.get(progKey);
          if (!cur) return;
          cur.page = p?.page || 0;
          cur.total = p?.total || 0;
          cur.percent = p?.percent || 0;
        },
      });
      const doc = toReadingDoc(analysis, { layout });
      doc.source = {
        name: path.basename(filePath),
        bytes: bytes.byteLength,
        generatedAt: new Date().toISOString(),
      };
      // 前端据此判断「这篇的表格 / 公式是不是按版面解析结果给的整块图」
      if (layout) doc.layout = { pages: Number(layout.pages) || 0, blocks: layout.blocks.length };
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
      progress.delete(progKey);
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

/**
 * 清掉某篇的缓存（PDF 被替换 / 用户手动重排 / 版面解析刚跑完时用）。
 * 一篇可能同时存在「无版面结果」与「有版面结果」两份稿，按基键前缀一并清掉。
 */
export function dropCachedDoc(filePath) {
  const base = baseKey(filePath);
  if (!base) return false;
  let ok = false;
  try {
    for (const name of fs.readdirSync(readingCacheDir())) {
      if (!name.startsWith(base)) continue;
      try { fs.rmSync(path.join(readingCacheDir(), name), { force: true }); ok = true; } catch (_) { /* 单个失败不影响其余 */ }
    }
  } catch (_) { /* 目录不存在 = 本来就没缓存 */ }
  return ok;
}

/** 某篇（含版面解析状态）的缓存文件键；外部写回精修结果时用 */
export function readingCacheKeyFor(filePath, layoutId) {
  let layout = null;
  if (layoutId) {
    try { layout = readManifestFor(getDataDir(), layoutId); } catch (_) { layout = null; }
  }
  return cacheKey(filePath, layout);
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
      // id 一并带出去：阅读稿要按它去找版面解析结果（<dataDir>/layout/<id>/manifest.json）
      return { path: item.filePath, name: item.originalName || item.filename || 'paper.pdf', id: item.id };
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
        layoutId: found.id,
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
      const { doc, cached } = await buildReadingDoc(found.path, { force: false, fromPage: 1, toPage: FIRST_PAGES, layoutId: found.id });
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

  /**
   * AI 精修：用当前配置的模型把「脚注 / 标题 / 断段」三类语义错误修一遍。
   * 结果写回缓存，同一篇 PDF 只跑一次；失败不影响已渲染的规则结果。
   */
  app.post('/api/reading/refine', async (req, res) => {
    const found = resolve(req.body);
    if (found.error) return res.status(400).json({ error: found.error });
    if (!/\.pdf$/i.test(found.path)) return res.status(400).json({ error: '阅读模式目前只支持 PDF' });
    try {
      const { doc } = await buildReadingDoc(found.path, { layoutId: found.id });
      if (doc.ai && !req.body?.force) {
        return res.json({ ok: true, cached: true, doc, summary: doc.ai, model: doc.ai.model || '' });
      }
      const settings = store?.getSettings ? store.getSettings() : {};
      const out = await refineReadingDoc(doc, settings, {});
      const key = readingCacheKeyFor(found.path, found.id);
      if (key) writeCacheFile(cachePath(key), out.doc);
      res.json({ ok: true, cached: false, doc: out.doc, summary: out.summary, model: out.model || '' });
    } catch (e) {
      const code = e?.code || 'AI_FAILED';
      const status = code === 'NO_MODEL' ? 400 : 500;
      res.status(status).json({ error: (code === 'NO_MODEL' ? '' : 'AI 精修失败：') + (e?.message || e), code });
    }
  });

  app.post('/api/reading/drop', (req, res) => {
    const found = resolve(req.body);
    if (found.error) return res.status(400).json({ error: found.error });
    res.json({ ok: dropCachedDoc(found.path) });
  });
}
