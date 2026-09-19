// analyze.js —— PDF 版面分析：把 PDF 拆成「可翻译的文本块」+「必须保护的区域」
//
// 这是整套全文翻译的地基。pdf2zh 之所以能做到「译文替换原文且版式不乱」，靠的就是
// 先把 PDF 解析成结构化的版面元素（段落 / 标题 / 公式 / 图表 / 页眉页脚），再逐个
// 替换。这里用 pdf.js 实现同一件事：
//
//   1) getTextContent() 拿到每个文字片段的坐标、字号、字体；
//   2) 按基线聚成「行」，再按行距/缩进/字号变化聚成「段（block）」，并处理分栏与通栏；
//   3) getOperatorList() 拿到矢量图元与位图的变换矩阵，得到「填充矩形」和「图片区域」，
//      前者用来取原文底色（覆盖时不能把彩底涂白），后者用来避免压图；
//   4) 用启发式规则识别公式、表格、页码、页眉页脚、参考文献等「不该翻译/不必翻译」的内容。
//
// 坐标系约定：全流程使用 pdf.js 的用户空间坐标（原点左下、y 向上、未旋转），
// 和 pdf-lib 的绘图坐标系一致，避免来回换算出错。

import { dehyphenate, sanitizeForPdf } from './layout.js';
import { toUint8Array } from './util.js';

// ==================== pdf.js 模块与 OPS 枚举 ====================
// 不同 pdf.js 版本的算子编号不同，所以不硬编码常量，而是把编号反查成算子名再判断。
let pdfjsModule = null;

async function loadPdfJs() {
  if (pdfjsModule !== null) return pdfjsModule;
  const specs = ['pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist/build/pdf.mjs', 'unpdf'];
  for (const spec of specs) {
    try {
      const m = await import(spec);
      if (m?.OPS) { pdfjsModule = m; return m; }
    } catch (_) { /* 换下一个候选 */ }
  }
  try {
    const m = await import('unpdf');
    if (typeof m?.getResolvedPDFJS === 'function') {
      const resolved = await m.getResolvedPDFJS();
      if (resolved?.OPS) { pdfjsModule = resolved; return resolved; }
    }
  } catch (_) { /* ignore */ }
  pdfjsModule = false;
  return false;
}

function opNameMap(OPS) {
  const map = new Map();
  for (const [k, v] of Object.entries(OPS)) {
    if (typeof v === 'number') map.set(v, k);
  }
  return map;
}

// ==================== 主入口 ====================

/**
 * 解析 PDF 版面。
 * @param {Uint8Array|Buffer} bytes PDF 字节
 * @param {object} [options]
 * @param {number} [options.maxPages=0] 只解析前 N 页（0 = 全部）
 * @param {number[]} [options.pageNumbers] 只解析指定页（1 起，优先级高于 maxPages）
 * @param {AbortSignal} [options.signal]
 * @param {(p: object) => void} [options.onProgress]
 * @param {boolean} [options.keepFormulas=true] 保留公式不翻译
 * @param {boolean} [options.keepTables=true] 保留表格不翻译
 * @param {boolean} [options.translateReferences=false] 是否翻译参考文献
 * @returns {Promise<object>} 版面结构
 */
export async function analyzePdf(bytes, options = {}) {
  const {
    maxPages = 0, pageNumbers = null, signal, onProgress,
    keepFormulas = true, keepTables = true, translateReferences = false,
  } = options;

  const { getDocumentProxy } = await import('unpdf');
  // copy=true：pdf.js 会 transfer 掉这块 buffer，而调用方后面还要拿同一份字节来渲染
  const data = toUint8Array(bytes, { copy: true });
  const doc = await getDocumentProxy(data);
  const totalPages = doc.numPages;
  const targets = Array.isArray(pageNumbers) && pageNumbers.length
    ? pageNumbers.filter((n) => n >= 1 && n <= totalPages)
    : Array.from({ length: maxPages > 0 ? Math.min(maxPages, totalPages) : totalPages }, (_, i) => i + 1);

  const pdfjs = await loadPdfJs();
  const names = pdfjs?.OPS ? opNameMap(pdfjs.OPS) : null;

  const pages = [];
  for (let idx = 0; idx < targets.length; idx++) {
    if (signal?.aborted) throw makeAbortError();
    const i = targets[idx];
    const page = await doc.getPage(i);
    const view = page.view || [0, 0, 612, 792];
    const pageInfo = {
      index: i,
      x0: view[0], y0: view[1], x1: view[2], y1: view[3],
      width: Math.abs(view[2] - view[0]),
      height: Math.abs(view[3] - view[1]),
      rotate: page.rotate || 0,
      blocks: [],
      images: [],
      fills: [],
      columns: [],
    };

    let textContent = { items: [], styles: {} };
    try {
      textContent = await page.getTextContent({ includeMarkedContent: false });
    } catch (e) {
      pageInfo.error = '文本层解析失败：' + (e?.message || e);
    }

    const items = collectItems(textContent);
    // 先定栏，再分行——顺序很重要：左右两栏的行常常共用同一条基线，
    // 如果先按基线聚行，一行的左半（栏 1）与右半（栏 2）会被拼成一句话。
    // 第一遍用「紧间隙」聚行，把跨栏的两段文字拆开，专门用来找栏间距；
    // 第二遍在确定好的栏内用「宽间隙」聚行，保证行内公式等宽间隙不会误拆。
    const probeLines = groupIntoLines(items, { maxGapEm: 2 });
    const split = detectColumnSplit(probeLines, pageInfo);
    const buckets = bucketItems(items, split, pageInfo);
    const columnBlocks = [];
    for (const [key, bucketLines] of buckets) {
      if (!bucketLines.length) continue;
      const lines = groupIntoLines(bucketLines, { maxGapEm: 6 });
      if (!lines.length) continue;
      columnBlocks.push(...buildBlocks(lines, pageInfo, key));
    }
    pageInfo.columns = split ? [{ index: 0, x0: pageInfo.x0, x1: split }, { index: 1, x0: split, x1: pageInfo.x1 }] : [];
    // 按阅读顺序（自上而下、同高从左到右）编号，便于前端展示与人工排查
    columnBlocks.sort((a, b) => (b.y1 - a.y1) || (a.x0 - b.x0));
    columnBlocks.forEach((b, i) => { b.index = i; b.id = `p${pageInfo.index}-b${i}`; });
    pageInfo.blocks = columnBlocks;
    pageInfo.rawItems = items.length;

    const regions = await extractRegions(page, names);
    pageInfo.images = regions.images;
    pageInfo.fills = regions.fills;

    pages.push(pageInfo);
    onProgress?.({ stage: 'analyze', page: i, total: targets.length, percent: Math.round(((idx + 1) / targets.length) * 100) });
    try { page.cleanup?.(); } catch (_) { /* ignore */ }
  }

  markRepeatingFurniture(pages);
  classifyAndMeasure(pages, { keepFormulas, keepTables, translateReferences });
  computeColumnGeometry(pages);

  const blocks = pages.flatMap((p) => p.blocks);
  const translatable = blocks.filter((b) => b.translatable);

  // 全篇正文字号：各页取中位数，避免个别页排版不同把整体带偏。重排模式与
  // 「字号跟随原文」都以它为基准。
  const pageSizes = pages.map((p) => p.bodySize).filter((n) => n > 0).sort((a, b) => a - b);
  const bodySize = pageSizes.length ? pageSizes[Math.floor(pageSizes.length / 2)] : 10;

  // 全篇正文是衬线体还是无衬线体：只让「够长的正文块」投票，样本太少就判为未知，
  // 交给用户设置决定（宁可不说，也不要把整篇选错字体族）。
  const serifVotes = blocks
    .filter((b) => b.kind === 'body' && b.text.length >= 40 && b.serif != null)
    .map((b) => b.serif);
  const bodySerif = serifVotes.length >= 3
    ? serifVotes.filter(Boolean).length * 2 > serifVotes.length
    : null;

  return {
    totalPages,
    analyzedPages: pages.length,
    pages,
    stats: {
      pages: pages.length,
      totalPages,
      blocks: blocks.length,
      translatableBlocks: translatable.length,
      skippedBlocks: blocks.length - translatable.length,
      chars: translatable.reduce((n, b) => n + b.text.length, 0),
      estimatedTokens: Math.ceil(translatable.reduce((n, b) => n + b.text.length, 0) / 2.2),
      images: pages.reduce((n, p) => n + p.images.length, 0),
      bodySize,
      bodySerif,
      headings: blocks.filter((b) => b.kind === 'title' || b.kind === 'heading').length,
    },
  };
}

function makeAbortError() {
  const e = new Error('任务已取消');
  e.name = 'AbortError';
  return e;
}

// ==================== 字体族（衬线 / 无衬线）====================
//
// 用途：译文的观感要跟原文正文一致——原文正文字是衬线体（Times / 宋体类），
// 译文就该用宋体族的黑体替代；是 sans（Helvetica / Arial），就用黑体。
//
// 依据两级：pdf.js 的 style.fontFamily 会给出通用族名（serif / sans-serif / monospace），
// 拿不到时退回按字体名（BaseFont）的关键词猜。两者都拿不到就返回 null（未知），
// 由调用方按「未知不计票」处理，避免把整篇判错。
const SERIF_HINTS = /(?:times|serif|song|sung|ming|mincho|georgia|garamond|palatino|baskerville|charter|century|book\s*antiqua|cmr\d*|computer\s*modern|nimbusrom|liberation\s*serif|dejavu\s*serif|st\s*song|simsun|nsimsun|droid\s*serif|notoserif|source\s*han\s*serif)/i;
const SANS_HINTS = /(?:helvetica|arial|sans|gothic|grotesk|verdana|tahoma|calibri|roboto|open\s*sans|lato|nimbus\s*san|liberation\s*sans|dejavu\s*sans|droid\s*sans|futura|gill|optima|candara|segoe|pingfang|hiragino|yahei|heiti|heit|notosans|source\s*han\s*sans|symbol|dingbat)/i;

/**
 * 推断字体是否衬线体。
 * @returns {boolean|null} null 表示判断不出来
 */
export function inferSerif(genericFamily, fontName) {
  const fam = String(genericFamily || '').toLowerCase();
  if (fam.includes('serif')) return true;
  if (fam.includes('sans')) return false;
  if (fam.includes('monospace')) return false;
  const name = String(fontName || '');
  if (SERIF_HINTS.test(name)) return true;
  if (SANS_HINTS.test(name)) return false;
  return null;
}

function majorityBool(values) {
  let yes = 0;
  let no = 0;
  for (const v of values) {
    if (v === true) yes++;
    else if (v === false) no++;
  }
  if (!yes && !no) return null;
  return yes > no;
}

// ==================== 文字片段 → 行 ====================

function collectItems(textContent) {
  const styles = textContent.styles || {};
  const out = [];
  for (const it of textContent.items || []) {
    if (!it || typeof it.str !== 'string') continue;
    if (!it.str.trim()) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const size = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || 10;
    const style = styles[it.fontName] || {};
    const family = String(style.fontFamily || '');
    const fname = String(it.fontName || '');
    const angle = Math.atan2(tr[1], tr[0]);
    out.push({
      text: it.str,
      x: tr[4],
      y: tr[5],
      w: typeof it.width === 'number' ? it.width : 0,
      size,
      angle,
      eol: !!it.hasEOL,
      family,
      ascent: typeof style.ascent === 'number' ? style.ascent : 0.82,
      descent: typeof style.descent === 'number' ? style.descent : -0.22,
      bold: /bold|black|heavy|semibold|demi|medi/i.test(family + ' ' + fname),
      italic: /italic|oblique/i.test(family + ' ' + fname),
      serif: inferSerif(family, fname),
    });
  }
  return out;
}

/**
 * 按基线把片段聚成行（忽略旋转文本）。
 * @param {Array} items 文字片段
 * @param {{maxGapEm?: number}} [opts] maxGapEm：允许片段与当前行右端相隔多少个字宽
 *   仍算同一行。用于分栏探测时取小值（把跨栏的两段文字拆开），聚正文时取大值。
 */
function groupIntoLines(items, opts = {}) {
  const maxGapEm = opts.maxGapEm ?? 6;
  const sorted = items
    .filter((it) => Math.abs(it.angle) < 0.02)
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const raw = [];
  let active = [];
  for (const it of sorted) {
    active = active.filter((l) => Math.abs(l.baseline - it.y) < Math.max(5, l.size * 0.85));
    let target = null;
    let best = Infinity;
    for (const l of active) {
      const dist = Math.abs(l.baseline - it.y);
      const tol = Math.max(1.1, Math.max(l.size, it.size) * 0.34);
      const maxRight = l.x1 + Math.max(l.size, it.size) * maxGapEm;
      if (it.x < l.x0 - l.size * 1.2 || it.x > maxRight) continue;
      // 同一行的判定有两个入口：
      //   1) 基线接近（普通文字）；
      //   2) 「上下标/嵌套小字号」——字号明显更小、纵向落在宿主行的行盒内、横向紧邻。
      // 没有第 2 条的话，行内公式的下标（如 d_k）会各自变成一段，
      // 把整段正文切成一地碎片，段落合并彻底失效。
      const sameBaseline = dist <= tol;
      const isSub = !sameBaseline
        && it.size <= l.size * 0.82
        && it.y >= l.spanBottom - l.size * 0.5
        && it.y <= l.spanTop + l.size * 0.15
        && it.x <= l.x1 + l.size * 1.6;
      if (!sameBaseline && !isSub) continue;
      if (dist < best) { best = dist; target = l; }
    }
    if (!target) {
      target = {
        baseline: it.y,
        size: it.size,
        x0: it.x,
        x1: it.x + it.w,
        spanBottom: it.y - it.size * 0.25,
        spanTop: it.y + it.size * 0.9,
        items: [],
      };
      active.push(target);
      raw.push(target);
    }
    target.items.push(it);
    target.size = Math.max(target.size, it.size);
    target.x0 = Math.min(target.x0, it.x);
    target.x1 = Math.max(target.x1, it.x + it.w);
    target.spanBottom = Math.min(target.spanBottom, it.y - it.size * 0.25);
    target.spanTop = Math.max(target.spanTop, it.y + it.size * 0.9);
  }

  const lines = [];
  for (const l of raw) {
    const its = l.items.slice().sort((a, b) => a.x - b.x);
    const sizes = its.map((i) => i.size).sort((a, b) => a - b);
    const size = sizes[Math.floor(sizes.length / 2)];
    // 加权字号：字符数多的片段更能代表这一行的观感
    let weightSum = 0;
    let sizeSum = 0;
    for (const i of its) { const w = i.text.trim().length || 1; weightSum += w; sizeSum += i.size * w; }
    const weightSize = weightSum ? sizeSum / weightSum : size;
    const ascent = Math.max(...its.map((i) => i.ascent ?? 0.82));
    const descent = Math.min(...its.map((i) => i.descent ?? -0.22));
    const text = assembleLine(its, weightSize);
    if (!text.trim()) continue;
    // 「松散行」：同一行内的片段之间有多个巨大空隙（作者名并排、表格行、目录条目、
    // 独立公式）。这种行往往一行里塞了多个互不相干的单元格，不能和上下行合并成段落。
    // 只数「超大间隙」的个数而不是最大间隙，是为了避免行内公式（分式、根号）造成的
    // 单个宽间隙被误判。
    let bigGaps = 0;
    let maxGap = 0;
    for (let k = 1; k < its.length; k++) {
      const g = its[k].x - (its[k - 1].x + its[k - 1].w);
      if (g > weightSize * 2.6) bigGaps++;
      maxGap = Math.max(maxGap, g);
    }
    const spread = its.length >= 3 && (bigGaps >= 2 || maxGap > weightSize * 6);
    lines.push({
      text,
      items: its,
      spread,
      baseline: l.baseline,
      x0: Math.min(...its.map((i) => i.x)),
      x1: Math.max(...its.map((i) => i.x + i.w)),
      size: weightSize,
      ascent,
      descent,
      top: l.baseline + ascent * weightSize,
      bottom: l.baseline + descent * weightSize,
      bold: its.filter((i) => i.bold).length >= its.length / 2,
      italic: its.filter((i) => i.italic).length >= its.length / 2,
      serif: majorityBool(its.map((i) => i.serif)),
    });
  }
  lines.sort((a, b) => (b.baseline - a.baseline) || (a.x0 - b.x0));
  return lines;
}

/** 同一行内按水平间隙补空格（pdf.js 有时会把单词拆成多个片段） */
function assembleLine(items, size) {
  let text = '';
  let prevEnd = null;
  for (const it of items) {
    if (prevEnd !== null) {
      const gap = it.x - prevEnd;
      const needSpace = gap > size * 0.22
        && !/\s$/.test(text)
        && !/^\s/.test(it.text);
      if (needSpace) text += ' ';
    }
    text += it.text;
    prevEnd = it.x + it.w;
  }
  return text.replace(/\s+/g, ' ').trim();
}

// ==================== 行 → 段（含分栏识别） ====================

/**
 * 找分栏位置（栏间距 gutter）。
 *
 * 思路：双栏排版的「指纹」是——大量行的右边界都停在同一条竖线上（左栏右沿），
 * 同时大量行的左边界都从同一条竖线上开始（右栏左沿），两条竖线间隔 5~50pt。
 * 于是把行的左右边界分别聚类，再找满足这个关系的竖线对。
 *
 * 为什么不用「投影空白带」这种更直观的做法：跨栏的大图、跨栏图注、图内并排标签
 * 都会横穿栏间距，用整行或片段做投影都会把 gutter 填满，双栏页反而识别不出来。
 */
function detectColumnSplit(lines, page) {
  if (page.width < 200) return null;
  const body = lines.filter((l) => !l.spread
    && l.text.replace(/\s/g, '').length >= 12
    && (l.x1 - l.x0) > page.width * 0.12);
  if (body.length < 10) return null;

  const rights = clusterEdges(body.map((l) => l.x1));
  const lefts = clusterEdges(body.map((l) => l.x0));
  if (!rights.length || !lefts.length) return null;

  let best = null;
  for (const r of rights) {
    for (const l of lefts) {
      const gap = l.value - r.value;
      if (gap < 5 || gap > 50) continue;
      const split = (r.value + l.value) / 2;
      if (split < page.x0 + page.width * 0.3 || split > page.x0 + page.width * 0.7) continue;
      const support = Math.min(r.count, l.count);
      if (support < 4) continue;
      const score = support * 10 - gap;
      if (!best || score > best.score) best = { score, split };
    }
  }
  if (!best) return null;

  // 复核：拆分后左右两侧都要有足够多的行，并且纵向铺得够开
  const left = body.filter((l) => (l.x0 + l.x1) / 2 < best.split);
  const right = body.filter((l) => (l.x0 + l.x1) / 2 >= best.split);
  const minLines = Math.max(4, body.length * 0.15);
  if (left.length < minLines || right.length < minLines) return null;
  const coverage = (list) => {
    const ys = list.map((l) => l.baseline);
    return (Math.max(...ys) - Math.min(...ys)) / page.height;
  };
  if (coverage(left) < 0.3 || coverage(right) < 0.3) return null;
  return best.split;
}

/** 一维聚类：把相近的数值聚成一簇，返回出现次数 >= 2 的簇 */
function clusterEdges(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last.max <= 4) {
      last.max = v;
      last.sum += v;
      last.count++;
      last.value = last.sum / last.count;
    } else {
      clusters.push({ min: v, max: v, sum: v, count: 1, value: v });
    }
  }
  return clusters.filter((c) => c.count >= 2);
}

/** 把片段按栏分桶；横跨栏间距的片段单独归入 span 桶（跨栏标题、跨栏图表） */
function bucketItems(items, split, page) {
  if (!split) return [['S', items]];
  const left = [];
  const right = [];
  const cross = [];
  for (const it of items) {
    if (it.x < split - 1 && it.x + it.w > split + 1) { cross.push(it); continue; }
    ((it.x + it.w / 2) < split ? left : right).push(it);
  }
  return [['L', left], ['R', right], ['S', cross]];
}

/** 把同一栏（或跨栏桶）的行合并成段落 */
function buildBlocks(lines, page, bucketKey) {
  if (!lines.length) return [];
  // 关键一步：把本栏的行再按「左右边界」聚成若干文本区（text region），
  // 结果直接写在每行的 line.region 上。
  // 一页里往往并存好几套宽度：居中页眉、正文栏、脚注、跨栏表格。
  // 判定「上一行是否排满（=段落结束）」必须拿它所属文本区的右边界做参照，
  // 用整页或整栏边界都会误判，把每个自然行都当成独立段落。
  clusterRegions(lines);
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    const line = { ...l };
    if (!cur || !canMerge(cur, line)) {
      if (cur) blocks.push(finalizeBlock(cur, bucketKey));
      cur = { lines: [line], region: l.region };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur) blocks.push(finalizeBlock(cur, bucketKey));
  return blocks;
}

function bucketInfo(bucketKey) {
  if (bucketKey === 'L') return { column: 0, span: false };
  if (bucketKey === 'R') return { column: 1, span: false };
  return { column: -1, span: true };
}

/**
 * 把一栏内的行按左右边界聚成文本区，并给每行打上 region 标记。
 * x0/x1 取分位数而非极值：既能容纳「末行偏短」，又不会被个别超宽行带偏。
 */
function clusterRegions(lines) {
  const regions = [];
  const sorted = lines.slice().sort((a, b) => (a.x0 - b.x0) || (a.x1 - b.x1));
  for (const l of sorted) {
    let best = null;
    let bestScore = Infinity;
    for (const r of regions) {
      const dx0 = Math.abs(l.x0 - r.x0);
      const dx1 = Math.abs(l.x1 - r.x1);
      if (dx0 > 6 + r.medSize * 0.6) continue;
      if (dx1 > 14 + r.medSize * 1.4) continue;
      const score = dx0 + dx1 * 0.5;
      if (score < bestScore) { bestScore = score; best = r; }
    }
    if (!best) {
      best = { lines: [], x0: l.x0, x1: l.x1, medSize: l.size };
      regions.push(best);
    }
    best.lines.push(l);
    best.x0 = percentile(best.lines.map((x) => x.x0), 0.1);
    best.x1 = percentile(best.lines.map((x) => x.x1), 0.9);
    best.medSize = medianOf(best.lines.map((x) => x.size));
    l.region = best;
  }
  // 只出现一次的行（孤立标题、页眉等）缺少统计意义，横向借用最近的邻居当参照
  for (const l of sorted) {
    const r = l.region;
    if (!r || r.lines.length > 1) continue;
    let nearest = null;
    let dist = Infinity;
    for (const other of regions) {
      if (other === r) continue;
      const overlap = Math.min(r.x1, other.x1) - Math.max(r.x0, other.x0);
      const gap = overlap >= 0 ? 0 : -overlap;
      if (gap > 60) continue;
      const d = gap + Math.abs(other.medSize - r.medSize) * 3;
      if (d < dist) { dist = d; nearest = other; }
    }
    if (nearest) {
      r.x0 = Math.min(r.x0, nearest.x0);
      r.x1 = Math.max(r.x1, nearest.x1);
    }
  }
  return regions;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

function canMerge(block, line) {
  const prev = block.lines[block.lines.length - 1];
  const why = (r) => {
    if (process.env.PDFTR_DEBUG) {
      console.log(`  ✗ 不合段 [${r}] prev={y${prev.bottom.toFixed(1)}~${prev.top.toFixed(1)} x${prev.x0.toFixed(1)}~${prev.x1.toFixed(1)} spread:${prev.spread} "${prev.text.slice(0, 40)}"}`
        + ` cur={y${line.bottom.toFixed(1)}~${line.top.toFixed(1)} x${line.x0.toFixed(1)}~${line.x1.toFixed(1)} spread:${line.spread} "${line.text.slice(0, 40)}"}`
        + ` region=(${block.region?.x0?.toFixed(1)},${block.region?.x1?.toFixed(1)})`);
    }
    return false;
  };
  // 松散行自成一个块：它内部是并排的多个单元格，合并进段落只会把多列内容搅在一起
  if (prev.spread || line.spread) return why('spread');
  const sizeRatio = line.size / prev.size;
  if (sizeRatio > 1.2 || sizeRatio < 0.84) return why('字号突变 ' + sizeRatio.toFixed(2));
  const gap = prev.bottom - line.top;
  if (gap < -0.45 * prev.size) return why('纵向重叠');
  const lineHeight = Math.max(prev.size, line.size) * 1.3;
  // 行距阈值：段内行距通常 ≈1.2em，段间会明显变大
  if (gap > lineHeight * 0.42) return why('行距过大 ' + gap.toFixed(1) + '>' + (lineHeight * 0.42).toFixed(1));
  // 水平方向必须属于同一栏：x 区间要有实质重叠（防止把左右两栏的行接在一起）
  const overlap = Math.min(prev.x1, line.x1) - Math.max(prev.x0, line.x0);
  const minWidth = Math.min(prev.x1 - prev.x0, line.x1 - line.x0);
  if (minWidth > 4 && overlap < minWidth * 0.25) return why('水平不重叠');
  // 本行明显比上一行更缩进 → 这是新段落的段首缩进
  const region = block.region;
  const right = region ? region.x1 : prev.x1;
  const indentStep = Math.max(3, prev.size * 0.6);
  if (line.x0 - prev.x0 > indentStep) return why('段首缩进');
  // 标题经常是两行换行，而且第一行天然不排满。若两行左边界、字号和字形
  // 都一致，应视为同一个标题块；否则会把标题拆成多个翻译请求，译文逐行回写
  // 后就会出现截图中那种“中文碎片插进英文标题/摘要”的错位效果。
  const sameStart = Math.abs(line.x0 - prev.x0) <= Math.max(2, prev.size * 0.45);
  const styleMatch = line.bold === prev.bold && line.italic === prev.italic
    && Math.abs(sizeRatio - 1) <= 0.12;
  const headingContinuation = block.lines.length < 3
    && sameStart && styleMatch
    // 标题可能不是 bold 字体文件，因此同时用字号兜底；12pt 是保守阈值，
    // 正文常见 8–11pt，不会把普通段落的短行大量误合并。
    && (prev.bold || line.bold || Math.min(prev.size, line.size) >= 12)
    && !isListItemStart(line.text);
  if (!headingContinuation) {
    // 上一行没排满（离文本区右边界还有一大截）说明段落已结束
    const shortTol = Math.max(prev.size * 1.6, (right - (region?.x0 ?? prev.x0)) * 0.05);
    if ((right - prev.x1) > shortTol) return why(`上行为短行 ${(right - prev.x1).toFixed(1)}>${shortTol.toFixed(1)}`);
  }
  // 字体风格突变（加粗小标题）另起一段
  if (line.bold !== prev.bold && line.size > prev.size) return why('字重变化');
  if (isListItemStart(line.text)) return why('列表项起首');
  return true;
}

function isListItemStart(text) {
  return /^(\d{1,3}[.)]\s|[(（]\d{1,3}[)）]\s|[•·▪◦●○■□\-–—]\s)/.test(String(text || ''));
}

function finalizeBlock(group, bucketKey) {
  const lines = group.lines;
  const text = joinLines(lines);
  const size = weightedSize(lines);
  const lineHeight = medianOf(
    lines.slice(1).map((l, i) => Math.abs(lines[i].baseline - l.baseline)).filter((v) => v > 0.5),
  ) || size * 1.25;
  const x0 = Math.min(...lines.map((l) => l.x0));
  const x1 = Math.max(...lines.map((l) => l.x1));
  const y1 = Math.max(...lines.map((l) => l.top));
  const y0 = Math.min(...lines.map((l) => l.bottom));
  const region = group.region || { x0, x1 };
  const colX0 = region.x0;
  const colX1 = Math.max(region.x1, x1);
  const align = detectAlign(lines, region, size);
  const info = bucketInfo(bucketKey);

  return {
    id: '',
    index: 0,
    column: info.column,
    span: info.span,
    colX0,
    colX1,
    colWidth: Math.max(1, colX1 - colX0),
    lines,
    lineCount: lines.length,
    text,
    rawText: lines.map((l) => l.text).join(' '),
    x0, x1, y0, y1,
    width: x1 - x0,
    height: y1 - y0,
    size,
    lineHeight,
    align,
    bold: lines.filter((l) => l.bold).length * 2 > lines.length,
    italic: lines.filter((l) => l.italic).length * 2 > lines.length,
    serif: majorityBool(lines.map((l) => l.serif)),
    baselineTop: lines[0].baseline,
    kind: 'body',
    translatable: true,
    reason: '',
    bg: { r: 1, g: 1, b: 1 },
    textColor: { r: 0, g: 0, b: 0 },
    expandUp: 0,
    expandDown: 0,
    translation: null,
  };
}

/**
 * 对齐方式判断。这里只区分「居中」和「左对齐」两种：
 * 渲染时不做两端对齐拉伸，所以 justify 与 left 的视觉效果一致，不必细分。
 * 判断依据是块相对于所属文本区是否两侧都留了明显的空白。
 */
function detectAlign(lines, region, size) {
  const width = Math.max(1, region.x1 - region.x0);
  const center = (region.x0 + region.x1) / 2;
  const everyLineCentered = lines.every((l) => Math.abs((l.x0 + l.x1) / 2 - center) < Math.max(size * 2, width * 0.05));
  if (!everyLineCentered) return 'left';
  const minInset = Math.min(
    ...lines.map((l) => Math.min(l.x0 - region.x0, region.x1 - l.x1)),
  );
  return minInset > size * 1.2 ? 'center' : 'left';
}

function weightedSize(lines) {
  let w = 0;
  let s = 0;
  for (const l of lines) {
    const n = l.text.replace(/\s/g, '').length || 1;
    w += n;
    s += l.size * n;
  }
  return w ? s / w : (lines[0]?.size || 10);
}

function joinLines(lines) {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    if (i === 0) { out = t; continue; }
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t; // 行尾连字符断词
    else if (/[\u3000-\u9fff\uff00-\uffef]$/.test(out) || /^[\u3000-\u9fff\uff00-\uffef]/.test(t)) out += t;
    else out += ' ' + t;
  }
  return sanitizeForPdf(out);
}

function medianOf(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ==================== 图元区域（图片 / 填充矩形） ====================

async function extractRegions(page, names) {
  const images = [];
  const fills = [];
  if (!names) return { images, fills };
  let opList;
  try {
    opList = await page.getOperatorList();
  } catch (_) {
    return { images, fills };
  }
  const { fnArray, argsArray } = opList;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let fillColor = { r: 0, g: 0, b: 0 };
  let pathBox = null;

  for (let i = 0; i < fnArray.length; i++) {
    const name = names.get(fnArray[i]);
    if (!name) continue;
    const args = argsArray[i];
    switch (name) {
      case 'save': stack.push(ctm.slice()); break;
      case 'restore': ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case 'transform': if (Array.isArray(args) && args.length >= 6) ctm = mulMatrix(ctm, args); break;
      case 'paintFormXObjectBegin':
        stack.push(ctm.slice());
        if (Array.isArray(args?.[0])) ctm = mulMatrix(ctm, args[0]);
        break;
      case 'paintFormXObjectEnd': ctm = stack.pop() || ctm; break;
      case 'setFillRGBColor': fillColor = hexToRgb(args?.[0]); break;
      case 'setFillGray': fillColor = { r: args?.[0] ?? 0, g: args?.[0] ?? 0, b: args?.[0] ?? 0 }; break;
      case 'setFillCMYKColor': {
        const [c, m, y, k] = args || [0, 0, 0, 0];
        fillColor = { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) };
        break;
      }
      case 'constructPath':
        // pdf.js v3+ 第三个参数是路径包围盒 [minX,minY,maxX,maxY]
        pathBox = Array.isArray(args?.[2]) && args[2].length === 4 ? args[2] : null;
        break;
      case 'shadingFill': {
        const box = applyBoxToCtm([0, 0, 1, 1], ctm);
        if (box) fills.push({ ...box, color: fillColor, kind: 'shading' });
        break;
      }
      default: {
        if (/paintImage|paintJpegXObject|paintSolidColorImageMask/i.test(name)) {
          const box = applyBoxToCtm([0, 0, 1, 1], ctm);
          if (box && (box.x1 - box.x0) * (box.y1 - box.y0) >= 100) images.push(box);
        } else if (/fill/i.test(name) && pathBox) {
          const box = applyBoxToCtm(pathBox, ctm);
          if (box && (box.x1 - box.x0) * (box.y1 - box.y0) >= 4) {
            fills.push({ ...box, color: fillColor, kind: 'fill' });
          }
          pathBox = null;
        }
        break;
      }
    }
  }
  return { images, fills };
}

function mulMatrix(c, m) {
  // PDF 的 cm 语义：CTM_new = M × CTM_old（行向量约定，点按 p·CTM 变换）。
  // 入参顺序为 (当前 CTM, 新增矩阵)，与 pdf.js 内部 Util.transform(ctm, m) 等价。
  return [
    m[0] * c[0] + m[1] * c[2],
    m[0] * c[1] + m[1] * c[3],
    m[2] * c[0] + m[3] * c[2],
    m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4],
    m[4] * c[1] + m[5] * c[3] + c[5],
  ];
}

function applyBoxToCtm(box, m) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [minX, minY, maxX, maxY] = box.map(Number);
  if ([minX, minY, maxX, maxY].some((v) => !Number.isFinite(v))) return null;
  const [a, b, c, d, e, f] = m;
  const pts = [[minX, minY], [minX, maxY], [maxX, minY], [maxX, maxY]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (!Number.isFinite(x0) || !Number.isFinite(y1)) return null;
  return { x0, y0, x1, y1 };
}

function hexToRgb(hex) {
  const n = Number(hex) || 0;
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

// ==================== 页眉页脚等重复元素 ====================

function markRepeatingFurniture(pages) {
  if (pages.length < 2) return;
  const counts = new Map();
  const keysByBlock = new Map();
  for (const p of pages) {
    for (const b of p.blocks) {
      if (!inMarginBand(b, p)) continue;
      const key = normalizeFurniture(b.text);
      if (!key) continue;
      keysByBlock.set(b, key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.34));
  for (const [b, key] of keysByBlock) {
    if (counts.get(key) >= threshold) {
      b.kind = 'furniture';
      b.translatable = false;
      b.reason = '页眉页脚/页码等重复元素';
    }
  }
}

function inMarginBand(b, page) {
  return b.y1 > page.y0 + page.height * 0.93 || b.y0 < page.y0 + page.height * 0.065;
}

function normalizeFurniture(text) {
  const t = String(text || '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > 90) return '';
  return t;
}

// ==================== 分类与底色 ====================

const MATH_CHARS = new Set(Array.from('=≈≠≡≤≥≪≫±∓×÷⋅∑∏∫√∞∂∈∉∀∃∅∇⊂⊆∪∩→←↔⇒⇔⟨⟩⌈⌉⌊⌋αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ'));
const NUMERIC_ONLY = /^[\s\d.,;:%()\[\]{}+\-–—/×*<>=≈≤≥±°′″²³·&|'"_~^\\]+$/;
const URL_LIKE = /^(https?:\/\/|www\.|doi\s*:?\s*10\.|10\.\d{4,9}\/)/i;
const EMAIL_LIKE = /^[\w.+-]+@[\w-]+\.[\w.]+$/;

function mathScore(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return 0;
  let n = 0;
  for (const ch of t) if (MATH_CHARS.has(ch)) n++;
  return n / t.length;
}

function variableRatio(text) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return 0;
  let v = 0;
  for (const tk of tokens) {
    if (/^[A-Za-z]$/.test(tk) || /^[A-Za-z][_^]/.test(tk) || /^[A-Za-z]_{?[a-z0-9]+}?$/.test(tk)) v++;
  }
  return v / tokens.length;
}

function looksLikeTable(block) {
  if (block.lineCount < 2 || block.lines.length < 2) return false;

  // 论文首页经常把 ABSTRACT 做成「左侧小标签 + 右侧长句」的结构化摘要。
  // 这种版式在 PDF 文本层里看起来也像一个有固定列的表格，但它不是表格：
  // 如果按表格跳过，结果就会出现“左边的标签被翻译、右边的英文段落仍保留”
  // 的错位页面（这是全文翻译最容易被误判的一类）。
  // 先排除明显的连续 prose，再判断真正的表格网格。
  const proseLines = block.lines.filter((line) => {
    const t = String(line.text || '').trim();
    return t.length >= 34
      && /[A-Za-z\u4e00-\u9fff]{3,}/.test(t)
      && /[.,;:!?，。；：！？]/.test(t);
  });
  const proseChars = block.lines.reduce((n, line) => n + String(line.text || '').replace(/\s/g, '').length, 0);
  const proseRatio = proseLines.length / Math.max(1, block.lines.length);
  const avgLineChars = proseChars / Math.max(1, block.lines.length);
  if (proseLines.length >= 2 && (proseRatio >= 0.45 || avgLineChars >= 42)) return false;

  const counts = block.lines.map((l) => l.items.length);
  const med = medianOf(counts);
  if (med < 3) return false;
  const buckets = new Map();
  for (const l of block.lines) {
    const seen = new Set();
    for (const it of l.items) {
      const key = Math.round(it.x / 3) * 3;
      if (seen.has(key)) continue;
      seen.add(key);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
  }
  let aligned = 0;
  for (const [, n] of buckets) if (n >= 2) aligned++;
  // 真表格通常至少有 3 个稳定列，而且每行的短单元格较多；
  // 这里提高“稳定列”门槛，避免把正文/结构化摘要误伤。
  return aligned >= 3 && aligned >= block.lines.length * 0.6
    && block.lines.filter((l) => String(l.text || '').trim().length < 34).length >= 2;
}

function findReferenceStart(blocks) {
  return blocks.find((b) => isReferenceHeading(b));
}

function isReferenceHeading(b) {
  return b.lineCount <= 2
    && b.text.length < 60
    && /^(references|reference list|bibliography|works cited|literature cited|参考文献|引用文献)\s*[:：]?$/i.test(b.text.trim());
}

function classifyAndMeasure(pages, opts) {
  for (const page of pages) {
    const bodySize = dominantBodySize(page.blocks);
    page.bodySize = bodySize;
    let inRefs = false;

    for (const b of page.blocks) {
      b.translation = null;
      const text = b.text.trim();
      b.tableLike = looksLikeTable(b);

      // 底色：取「包含该块且面积最小」的填充矩形颜色，没有则白底
      const bg = pickBackground(b, page);
      b.bg = bg.color;
      b.bgLuminance = 0.299 * bg.color.r + 0.587 * bg.color.g + 0.114 * bg.color.b;
      b.textColor = b.bgLuminance > 0.55 ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 };

      if (b.kind === 'furniture') continue;

      // 块已按自上而下排序：一旦遇到「参考文献」小标题，其后的块都视作条目
      if (!opts.translateReferences && inRefs) {
        b.kind = 'reference';
        b.translatable = false;
        b.reason = '参考文献（默认保留原样）';
        continue;
      }

      const verdict = classifyBlock(b, { bodySize, inRefs, opts });
      b.kind = verdict.kind;
      b.translatable = verdict.translatable;
      b.reason = verdict.reason;

      if (!opts.translateReferences && isReferenceHeading(b)) inRefs = true;
    }

    for (const b of page.blocks) {
      const space = verticalSpace(b, page);
      b.expandUp = space.up;
      b.expandDown = space.down;
    }
  }
}

function dominantBodySize(blocks) {
  const weight = new Map();
  for (const b of blocks) {
    if (b.lineCount < 2 && b.text.length < 60) continue;
    const key = Math.round(b.size * 2) / 2;
    weight.set(key, (weight.get(key) || 0) + b.text.length);
  }
  let best = 10;
  let bestN = -1;
  for (const [size, n] of weight) if (n > bestN) { bestN = n; best = size; }
  return best;
}

function classifyBlock(b, ctx) {
  const text = b.text.trim();
  const { bodySize, inRefs, opts } = ctx;

  if (text.replace(/\s/g, '').length < 2) return skip('内容过短');
  // 没有实质文字（脚注标记 ∗†‡、纯符号、公式碎片）——翻译它们只会污染版面
  if ((text.match(/[A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length < 2) {
    return skip('无实质文字');
  }
  // 公式碎片：短且完全没有元音（QK、dk、√. 这类变量/算子残片）
  if (text.length <= 8 && !/[aeiouy]/i.test(text)) return skip('公式残片');
  if (NUMERIC_ONLY.test(text)) return skip('纯数字/符号');
  if (URL_LIKE.test(text) && text.length < 200) return skip('链接或 DOI');
  if (EMAIL_LIKE.test(text)) return skip('邮箱地址');
  if (/^fig(?:ure)?\.?\s*\d+[a-z]?[.:]?\s*$/i.test(text) && text.length < 12) return skip('图号');

  if (opts.keepFormulas && isFormulaLike(b, text)) return skip('公式或数学排版');
  if (opts.keepTables && b.tableLike) return skip('表格（默认保留原样）');
  if (inRefs) return skip('参考文献（默认保留原样）');

  const isHeading = b.lineCount <= 3
    && text.length < 180
    && (b.size >= bodySize * 1.12 || (b.bold && b.size >= bodySize * 0.98));
  if (isHeading) {
    return { kind: b.size >= bodySize * 1.35 ? 'title' : 'heading', translatable: true, reason: '' };
  }
  const caption = /^(fig(?:ure)?|table|tab\.|图|表|scheme|algorithm)\s*\.?\s*\d+/i.test(text);
  return { kind: caption ? 'caption' : 'body', translatable: true, reason: '' };
}

function skip(reason) {
  return { kind: 'formula', translatable: false, reason };
}

function isFormulaLike(b, text) {
  if (/^\(\s*\d{1,3}[a-z]?\s*\)$/.test(text)) return true; // 公式编号
  // 带编号的编号式公式行：以 (12) 结尾且含等号/关系符，几乎不可能是普通句子
  if (/\(\s*\d{1,3}[a-z]?\s*\)\s*$/.test(text) && /[=≈≠≤≥∑∫∏√]/.test(text)) return true;
  if (text.length > 420) return false;
  const ms = mathScore(text);
  if (ms >= 0.14) return true;
  if (ms >= 0.06 && variableRatio(text) >= 0.28) return true;
  if (b.lineCount <= 2 && variableRatio(text) >= 0.34 && text.length < 80) return true;
  return false;
}

function pickBackground(block, page) {
  const pageArea = page.width * page.height;
  let best = null;
  let fallback = null;
  for (const f of page.fills) {
    if (!(f.x0 <= block.x0 + 1 && f.x1 >= block.x1 - 1 && f.y0 <= block.y0 + 1 && f.y1 >= block.y1 - 1)) continue;
    const area = (f.x1 - f.x0) * (f.y1 - f.y0);
    if (area > pageArea * 0.9) {
      if (!fallback) fallback = { color: f.color, area };
      continue;
    }
    if (!best || area < best.area) best = { color: f.color, area };
  }
  return best || fallback || { color: { r: 1, g: 1, b: 1 }, area: pageArea };
}

/** 计算块上下可外扩的空白（避免译文扩张时压到邻块） */
function verticalSpace(block, page) {
  const margin = Math.max(2, block.size * 0.35);
  let upLimit = page.y1 - block.y1;
  let downLimit = block.y0 - page.y0;
  const hOverlap = (b) => Math.min(b.x1, block.x1) - Math.max(b.x0, block.x0) > Math.min(b.width, block.width) * 0.25;
  for (const other of page.blocks) {
    if (other === block || !hOverlap(other)) continue;
    if (other.y0 >= block.y1) upLimit = Math.min(upLimit, other.y0 - block.y1);
    else if (other.y1 <= block.y0) downLimit = Math.min(downLimit, block.y0 - other.y1);
  }
  for (const img of page.images) {
    const hImg = Math.min(img.x1, block.x1) - Math.max(img.x0, block.x0) > Math.min(img.x1 - img.x0, block.width) * 0.25;
    if (!hImg) continue;
    if (img.y0 >= block.y1) upLimit = Math.min(upLimit, img.y0 - block.y1);
    else if (img.y1 <= block.y0) downLimit = Math.min(downLimit, block.y0 - img.y1);
  }
  const cap = block.size * 1.6;
  return {
    up: Math.max(0, Math.min(Math.max(0, upLimit - margin), cap)),
    down: Math.max(0, Math.min(Math.max(0, downLimit - margin), cap)),
  };
}

function computeColumnGeometry(pages) {
  // 分栏右边界已经在建段时逐列确定（colX1），这里只做兜底：
  // 某些页面（例如整页一张大表）没有可用的列信息，就用本块最右侧作为换行宽度参考。
  for (const page of pages) {
    for (const b of page.blocks) {
      if (!Number.isFinite(b.colX1) || b.colX1 <= b.x0) {
        b.colX1 = Math.max(...b.lines.map((l) => l.x1), b.x1);
      }
    }
  }
}

export { mathScore, looksLikeTable, dehyphenate };
