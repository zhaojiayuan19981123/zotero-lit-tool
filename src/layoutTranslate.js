// layoutTranslate.js —— 把「版面解析」的结果直接接到「全文翻译」管线上
//
// ============================ 为什么要这个文件 ============================
//
// 本项目有两条**互相独立**的版面理解链路：
//
//   A. 版面解析（processor 子进程 / 深度学习模型 PP-DocLayoutV3）
//      产出 manifest.json：每个块带 label（标题/正文/图表/公式…）、confidence、
//      order（阅读顺序）、bounds（归一化坐标）、text（识别文字）、image（裁图）。
//
//   B. 全文翻译（src/pdfTranslate）内部的 analyzePdf（pdf.js 文本层 + 启发式）
//      产出 pages[].blocks[]：整条翻译管线（术语表 / 缓存 / 自适应并发 / 渲染）
//      全部建立在它之上。
//
// 用户要在阅读器里做「左边原文、右边译文」的**逐段对照**，并且点原文哪里、
// 译文就同步到哪里。这要求翻译必须**按块产出**、且块的切分要稳定可对齐。
//
// A 的块天然带页码与阅读顺序，切分比 B 的启发式更适合当对照单元；扫描件更是
// 只有 A 才有文字（B 完全没有文本层，直接翻不了）。所以这里做一件事：
//
//      **把 A 的 manifest 翻译成 B 的数据结构，让翻译管线零改动地跑在 A 上。**
//
// 顺带产出「逐块对齐数据」（原文 + 译文 + 页码 + 类型 + 坐标 + 裁图），
// 这是前端左右对照与同步滚动的唯一数据源。
//
// ============================ 为什么 Markdown 单独组装 ============================
//
// 文本层路径的 buildMarkdownFromLayout 依赖「字号 / 分栏 / 首行缩进」等启发式来
// 猜标题层级。而 manifest 里 label 已经**由模型直接给出**了类型（doc_title /
// paragraph_title / text / abstract …），猜出来的层级不可能比它更准。
// 因此版面路径自己组装 Markdown，直接用 label 定层级，不再走启发式。

import fs from 'node:fs';
import path from 'node:path';

/** 版面块的结构版本，与 src/layout.js 的 LAYOUT_SCHEMA 保持一致 */
export const MANIFEST_SCHEMA = 1;

/**
 * PP-DocLayoutV3 的 label → 翻译管线认识的 kind + 是否翻译。
 *
 * kind 的取值刻意沿用 analyzePdf 的既有词汇（title / heading / body / caption /
 * reference / formula / figure / table / furniture / footnote），这样：
 *   - 下游 `block.translatable` 的判断逻辑完全不用改；
 *   - 将来若要复用 buildElements 等函数，语义也对得上。
 */
const LABEL_RULES = {
  doc_title: { kind: 'title', translatable: true },
  paragraph_title: { kind: 'heading', translatable: true },
  text: { kind: 'body', translatable: true },
  content: { kind: 'body', translatable: true },
  abstract: { kind: 'body', translatable: true },
  footnote: { kind: 'footnote', translatable: true },
  vision_footnote: { kind: 'footnote', translatable: true },
  figure_title: { kind: 'caption', translatable: true },

  // 参考文献条目：默认不翻。与文本层路径的 translateReferences 语义保持一致
  // （用户在全文翻译面板上勾了「翻译参考文献」才会翻）。
  reference: { kind: 'reference', translatable: false },
  reference_content: { kind: 'reference', translatable: false },

  // 图表 / 公式 / 算法：内容是图形，翻译没有意义，原样保留。
  // 前端会把裁图连同全文上下文交给视觉模型解读（见 AI 助读）。
  chart: { kind: 'figure', translatable: false },
  image: { kind: 'figure', translatable: false },
  algorithm: { kind: 'figure', translatable: false },
  table: { kind: 'table', translatable: false },
  display_formula: { kind: 'formula', translatable: false },
  inline_formula: { kind: 'formula', translatable: false },
  formula_number: { kind: 'formula', translatable: false },
};

/**
 * 纯排版装饰：完全不进对照流。
 *
 * 为什么直接丢而不是标成 furniture：正文流里保留页眉页脚 / 页码 / 印章只会
 * 在左右对照时反复出现同样的「Journal of ... 104468」「8」「©」这类噪声，
 * 把真正要读的段落挤散。页眉页脚在页面视图里本来就看得见，不必重复。
 */
const DROP_LABELS = new Set([
  'header', 'footer', 'header_image', 'footer_image',
  'number', 'seal', 'aside_text',
]);

/**
 * 单个 label 的语义规则。
 * @returns {{kind:string, translatable:boolean}|null} null = 丢弃
 */
export function ruleOfLabel(label) {
  const key = String(label || '').trim();
  if (Object.prototype.hasOwnProperty.call(LABEL_RULES, key)) return LABEL_RULES[key];
  if (DROP_LABELS.has(key)) return null;
  // 未知标签（模型升级后可能出现新标签）：按正文处理。
  // 宁可多翻一句，也不要把内容整块丢掉 —— 用户看不到丢失比看到多余严重得多。
  return { kind: 'body', translatable: true };
}

/**
 * 标题级别：用编号的点号层数推层级。
 *
 * 经管类论文的标题几乎都是「1 Introduction」「2.1 AI products」「2.1.1 xxx」
 * 这种编号，层数天然对应 Markdown 的 # 数量。没有编号时按 label 给默认层。
 *
 * @param {string} text 标题文字
 * @param {string} label 原始 label
 * @returns {number} 1..4
 */
export function headingDepth(text, label) {
  const s = String(text || '').trim();
  // 匹配开头的编号：1 / 1.2 / 1.2.3 / Ⅰ. / A. 等
  const m = s.match(/^(\d+(?:\.\d+)*)\b/);
  if (m) {
    const depth = m[1].split('.').length;   // 1→1, 1.2→2, 1.2.3→3
    // 论文标题（doc_title）已经占了 H1，章节标题因此整体下移一级：
    // 「1 Introduction」→ H2、「2.1 Motivation」→ H3。这样左侧大纲的层级
    // 才和论文真实结构一致，而不是把每一章都顶成 H1。
    return Math.max(2, Math.min(4, depth + 1));
  }
  if (String(label || '') === 'doc_title') return 1;
  if (String(label || '') === 'paragraph_title') return 2;
  return 2;
}

/**
 * 把 manifest 转成 analyzePdf 兼容的 layout 结构。
 *
 * @param {object} manifest  processor 产出的 manifest.json
 * @param {object} [options]
 * @param {boolean} [options.translateReferences=false] 参考文献是否也翻译
 * @param {object}  [options.pageSizes] 可选 { [page]: {width,height} }，用于把
 *        归一化坐标还原成 pt。对照阅读只需要归一化坐标，因此缺省时用 1×1，
 *        这样 x0/y0/x1/y1 就退化成归一化值本身（不丢信息、也不误导）。
 * @returns {object} { totalPages, analyzedPages, pages, stats, source:'manifest' }
 */
export function layoutFromManifest(manifest, options = {}) {
  const { translateReferences = false, pageSizes = null } = options;
  const rawBlocks = Array.isArray(manifest?.blocks) ? manifest.blocks : [];

  // 1) 按页分组，同时过滤掉装饰块
  const byPage = new Map();
  for (const b of rawBlocks) {
    const page = Number(b?.page);
    if (!Number.isFinite(page) || page < 1) continue;
    const rule = ruleOfLabel(b.label);
    if (!rule) continue;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(b);
  }

  // 2) 逐页组装
  const pages = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = byPage.get(page).slice();
    // order 是模型给出的阅读顺序；缺失时退回数组下标，保证排序稳定
    list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

    const size = (pageSizes && pageSizes[page]) || { width: 1, height: 1 };
    const blocks = list.map((b, i) => {
      const rule = ruleOfLabel(b.label);
      const translatable = rule.translatable
        || (rule.kind === 'reference' && !!translateReferences);
      const bd = b.bounds || {};
      const nx = Number(bd.x) || 0;
      const ny = Number(bd.y) || 0;
      const nw = Number(bd.width) || 0;
      const nh = Number(bd.height) || 0;
      return {
        // id 沿用 manifest 的（形如 p1-b17），前端左右对照靠它做锚点
        id: b.id || `p${page}-b${i}`,
        index: i,
        // 块自己也带页码：前端直接在块上用，不必回头查 page 对象
        page,
        kind: rule.kind,
        label: b.label || '',              // 原始标签：前端要显示中文名、徽标配色
        text: String(b.text || ''),
        translatable,
        confidence: Number(b.confidence) || 0,
        image: b.image || '',              // 裁图相对路径（assets/xxx.png）
        caption: b.caption || '',
        // 归一化坐标（0~1）：对照阅读直接按比例铺，不依赖页面物理尺寸
        nx, ny, nw, nh,
        // 兼容翻译管线的绝对坐标字段（有页尺寸时才有意义）
        x0: nx * size.width,
        y0: ny * size.height,
        x1: (nx + nw) * size.width,
        y1: (ny + nh) * size.height,
        size: 0,
        bold: false,
        serif: null,
      };
    });

    pages.push({
      index: page,
      page,
      x0: 0,
      y0: 0,
      width: size.width,
      height: size.height,
      rotate: 0,
      blocks,
      images: [],
      fills: [],
      columns: [],
    });
  }

  const all = pages.flatMap((p) => p.blocks);
  const translatableBlocks = all.filter((b) => b.translatable);
  const ch = translatableBlocks.reduce((n, b) => n + b.text.length, 0);

  return {
    totalPages: Number(manifest?.pages) || pages.length,
    analyzedPages: pages.length,
    pages,
    source: 'manifest',
    model: manifest?.model?.name || '',
    stats: {
      pages: pages.length,
      totalPages: Number(manifest?.pages) || pages.length,
      blocks: all.length,
      translatableBlocks: translatableBlocks.length,
      skippedBlocks: all.length - translatableBlocks.length,
      chars: ch,
      estimatedTokens: Math.ceil(ch / 2.2),
      images: all.filter((b) => b.image).length,
      // 版面模型不给字号/字形，这两项交给用户设置决定
      bodySize: 10,
      bodySerif: null,
      headings: all.filter((b) => b.kind === 'title' || b.kind === 'heading').length,
    },
  };
}

/**
 * 按 label 直接组装 Markdown 译文（不走字号启发式）。
 *
 * 约定与文本层路径一致：译文落在 block.translation，缺译文时退回原文
 * （用户在只识别不翻译的场景下仍能看到全文）。
 *
 * @param {Array} pages layoutFromManifest 产出的 pages
 * @returns {{markdown:string, stats:object}}
 */
export function buildMarkdownFromManifest(pages) {
  const out = [];
  const stats = { text: 0, headings: 0, figures: 0, formulas: 0, tables: 0 };
  let firstTitleSeen = false;

  for (const page of pages || []) {
    for (const b of page.blocks || []) {
      const body = String(b.translation || b.text || '').replace(/\s+/g, ' ').trim();

      // 图表 / 表格：Markdown 里不放（与视觉路径一致，用户明确要求「图和表都不要」）
      if (b.kind === 'figure' || b.kind === 'table') { stats.figures += b.kind === 'figure' ? 1 : 0; stats.tables += b.kind === 'table' ? 1 : 0; continue; }
      // 公式：保留原文（版面模型给的是图形，文本层拿不到 LaTeX，用识别出的文字兜底）
      if (b.kind === 'formula') {
        stats.formulas++;
        if (body) out.push('', '$$', body, '$$', '');
        continue;
      }
      if (!body) continue;

      if (b.kind === 'title') {
        // 同一篇里模型偶尔把页眉的大标题重复认出来，去重后只留一个 H1
        if (firstTitleSeen) continue;
        firstTitleSeen = true;
        out.push(`# ${body}`, '');
        stats.headings++;
      } else if (b.kind === 'heading') {
        const depth = headingDepth(body, b.label);
        out.push(`${'#'.repeat(depth)} ${body}`, '');
        stats.headings++;
      } else if (b.kind === 'caption') {
        out.push(`*${body}*`, '');
      } else if (b.kind === 'reference') {
        out.push(`- ${body}`);
      } else {
        out.push(body, '');
        stats.text++;
      }
    }
  }

  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown: markdown ? markdown + '\n' : '', stats: { ...stats, text: stats.text, crops: 0 } };
}

/**
 * 生成「逐块对齐数据」—— 前端左右对照与同步滚动的唯一数据源。
 *
 * 只导出可翻译 / 可展示的块，并保留归一化坐标与裁图，让前端不必再读 manifest。
 *
 * @param {object} layout layoutFromManifest 的返回值
 * @param {object} [meta] 附加元信息（文献 id、标题、目标语言等）
 */
export function buildAlignOutput(layout, meta = {}) {
  const blocks = [];
  for (const page of layout?.pages || []) {
    for (const b of page.blocks || []) {
      const text = String(b.text || '').trim();
      const translation = String(b.translation || '').trim();
      // 两边都空的块没有任何展示价值（例如模型认出的空图片块）
      if (!text && !translation && !b.image) continue;
      blocks.push({
        id: b.id,
        page: page.index,
        kind: b.kind,
        label: b.label,
        text,
        translation,
        // 归一化坐标：前端按容器宽度百分比铺，天然适配任意缩放
        x: b.nx, y: b.ny, width: b.nw, height: b.nh,
        image: b.image || '',
        caption: b.caption || '',
        translatable: !!b.translatable,
      });
    }
  }
  return {
    schemaVersion: 1,
    source: 'manifest',
    model: layout?.model || '',
    pages: layout?.stats?.pages || 0,
    translatedBlocks: blocks.filter((b) => b.translation).length,
    totalBlocks: blocks.length,
    ...meta,
    blocks,
  };
}

/**
 * 读某篇文献的版面解析结果。
 *
 * 直接读磁盘而不是从请求里传：manifest 动辄几十上百 KB，塞进请求体或历史 JSON
 * 都不合适；而且解析结果本来就按文献 id 落在 <dataDir>/layout/<id>/ 下。
 *
 * @returns {object|null} 解析结果；不存在或结构不符返回 null
 */
export function readManifestFor(dataDir, literatureId) {
  if (!dataDir || !literatureId) return null;
  const file = path.join(dataDir, 'layout', String(literatureId), 'manifest.json');
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.schemaVersion !== MANIFEST_SCHEMA || !Array.isArray(data.blocks)) return null;
    return data;
  } catch (_) {
    return null;
  }
}
