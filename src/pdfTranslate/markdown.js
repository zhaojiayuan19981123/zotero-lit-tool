// markdown.js —— 全文翻译的 Markdown 译文输出
//
// 两条路径产出同一种产物（一篇 Markdown）：
//   1) 文本层路径：复用 reflow.buildElements 的「阅读顺序元素流」，把文字元素映射成
//      Markdown 标题/段落，把公式/表格/插图映射成 crop: 图片引用（客户端从原 PDF
//      画布实时裁剪渲染，不重新生成图片文件）。
//   2) 视觉模型路径：视觉模型逐页识别版面 → 输出结构化标记块（[TITLE]/[H1]/[P]/…），
//      文本段复用 translateSegments 翻译，表格/公式原样透传，[FIG] 映射回 analyze
//      探测到的图片区域。
//
// crop 引用格式：crop:p{1 起始页号}:{x0}:{y0}:{x1}:{y1}（PDF 用户空间坐标，左下原点）。
import { buildElements } from './reflow.js';

/** 文字层级 → Markdown 映射（返回 null 表示按普通段落处理） */
const LEVEL_PREFIX = { title: '# ', h2: '## ', h3: '### ', h4: '#### ', h5: '#### ' };

function cropRef(el) {
  const r = el.rect || {};
  const n = (v) => Math.round((Number(v) || 0) * 10) / 10;
  return `crop:p${(el.pageIndex || 0) + 1}:${n(r.x0)}:${n(r.y0)}:${n(r.x1)}:${n(r.y1)}`;
}

/**
 * 把 buildElements 产出的元素流转成 Markdown 文本。
 * 单独导出是为了视觉路径的「缺图页兜底」也能复用同一套映射规则。
 */
export function elementsToMarkdown(elements) {
  const lines = [];
  let textCount = 0;
  let cropCount = 0;
  for (const el of elements || []) {
    if (el.type === 'text') {
      const text = String(el.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      textCount++;
      const prefix = LEVEL_PREFIX[el.level] || '';
      if (prefix) {
        lines.push(`${prefix}${text}`, '');
      } else if (el.level === 'caption') {
        lines.push(`*${text}*`, '');
      } else {
        lines.push(text, '');
      }
    } else if (el.type === 'crop') {
      cropCount++;
      const caption = String(el.caption || '').trim();
      lines.push(`![${caption}](${cropRef(el)})`, '');
    }
  }
  return { markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), textCount, cropCount };
}

/**
 * 文本层路径：版面分析结果 → Markdown 译文。
 * @param {Array} pages analyzePdf 的 layout.pages
 * @param {object} [opts] reflowKeepFigures 等开关
 */
export function buildMarkdownFromLayout(pages, opts = {}) {
  const { elements, stats } = buildElements(pages || [], {
    reflowKeepFigures: opts.reflowKeepFigures !== false,
  });
  const { markdown, textCount, cropCount } = elementsToMarkdown(elements);
  return {
    markdown: markdown ? markdown + '\n' : '',
    stats: { ...stats, text: textCount, crops: cropCount },
  };
}

// ==================== 视觉模型路径 ====================

/**
 * 视觉识别提示词：让视觉模型把一页论文版面「转录」成结构化标记文本。
 * 只提取、不翻译——翻译复用统一的分段翻译管线（术语表/缓存/并发自适应都在那边）。
 * 表格用 GFM 原样输出、公式用 LaTeX 原样输出，后续组装时透传，不再过翻译。
 */
export function visionPaperPrompt({ translateReferences = false } = {}) {
  return [
    '你是专业的学术版面转录员。请把这张论文页面图「转录」成结构化文本，供后续翻译使用。规则：',
    '',
    '## 输出标记（每个标记独占一行，标记后跟内容）',
    '[TITLE] 论文主标题（仅首页出现一次）',
    '[H1] 一级章节标题（如 1 Introduction）',
    '[H2] 二级小节标题（如 2.1 Method）',
    '[H3] 三级及更深的标题',
    '[P] 正文段落（一段一个 [P]，可跨多行续写）',
    '[CAP] 图表标题（Figure 1: ... / Table 2: ...）',
    '[TABLE] 与 [/TABLE] 之间输出完整 GFM 表格（| 分隔、第二行为 |---| 对齐行），保留原数值',
    '[FORMULA] 与 [/FORMULA] 之间输出该公式的 LaTeX 源码（不带 $ 符号），独立公式逐个转录',
    '[FIG] 插图（一行简述图里是什么，例如「系统架构图，包含三个模块」）',
    '[REF] 参考文献条目（每条一个 [REF]）',
    '',
    '## 要求',
    '1. 严格按页面上的视觉阅读顺序（单栏从上到下；双栏先左栏后右栏）输出；',
    '2. 只转录页面真实存在的内容，不要推测、不要补充、不要翻译；',
    '3. 数学公式内联在段落里时用 LaTeX 写在 [P] 文本中（如 $x^2$）；独立成行的公式用 [FORMULA]；',
    '4. 表格必须完整还原行列结构，单元格文本逐字保留；',
    '5. 页眉、页脚、页码、版权行、审稿痕迹一律忽略；',
    '6. 看不清的文字用 [?] 标记而不是编造；',
    '7. 不要输出任何解释、开场白或标记体系说明。',
    translateReferences ? '8. 参考文献部分需要完整转录（[REF] 逐条）。' : '8. 参考文献部分（References）整个跳过，不要转录。',
  ].join('\n');
}

const VISION_TAGS = new Set(['TITLE', 'H1', 'H2', 'H3', 'H4', 'P', 'CAP', 'TABLE', 'FORMULA', 'FIG', 'REF']);

/**
 * 解析视觉模型输出的标记文本 → 块数组 [{tag, text}]。
 * 解析规则：一行以 [TAG] 开头即开启新块；内容为后续行直到下一个标记行；
 * [TABLE]/[FORMULA] 额外支持 [/TABLE] / [/FORMULA] 显式闭合（内容里出现 [P] 之类时也不会截断表格）。
 * 容错：未知标记当作普通文本并入上一个块；完全没有标记时整页按一个大段落处理。
 */
export function parseVisionBlocks(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let cur = null; // { tag, lines }
  let openTag = null; // TABLE/FORMULA 的显式闭合状态

  const push = () => {
    if (!cur) return;
    const text = cur.lines.join('\n').trim();
    if (text) blocks.push({ tag: cur.tag, text });
    cur = null;
    openTag = null;
  };

  for (const line of lines) {
    // 显式闭合：[/TABLE] / [/FORMULA]（[A-Z0-9] 开头的标记正则匹配不到它，必须先判）
    if (openTag && /^\s*\[\/(TABLE|FORMULA)\]\s*$/i.test(line)) {
      push();
      continue;
    }
    const m = /^\s*\[([A-Z0-9]{1,8})\]\s?(.*)$/.exec(line);
    if (m) {
      const tag = m[1];
      if (tag === 'TABLE' || tag === 'FORMULA') {
        push();
        cur = { tag, lines: [] };
        openTag = tag;
        continue;
      }
      if (openTag && !VISION_TAGS.has(tag)) {
        // 表格/公式内部形如 [xxx] 的行（大概率是内容），原样保留
        cur.lines.push(line);
        continue;
      }
      if (VISION_TAGS.has(tag)) {
        // openTag 未闭合但出现了下一个内容标记：模型忘了写 [/TABLE]，
        // 宁可在这里截断，也不能把后半页全部吞进表格
        push();
        cur = { tag, lines: m[2] ? [m[2]] : [] };
        continue;
      }
    }
    if (cur) cur.lines.push(line);
  }
  push();

  // 整页没有任何标记：按一个段落兜底，内容不至于整页丢失
  if (!blocks.length) {
    const text = lines.join('\n').trim();
    if (text) blocks.push({ tag: 'P', text });
  }
  return blocks;
}

/** 视觉路径里需要送翻译的标记（TABLE/FORMULA/FIG 原样透传） */
const VISION_TRANSLATABLE = new Set(['TITLE', 'H1', 'H2', 'H3', 'H4', 'P', 'CAP']);

/**
 * 收集视觉块里要翻译的片段。id 规则：v{页号}:{块序号}，回填时按 id 反查。
 */
export function collectVisionSegments(pageBlocks, { translateReferences = false } = {}) {
  const segments = [];
  for (const pg of pageBlocks || []) {
    (pg.blocks || []).forEach((b, i) => {
      const translatable = VISION_TRANSLATABLE.has(b.tag)
        || (b.tag === 'REF' && translateReferences === true);
      const text = String(b.text || '').trim();
      if (!translatable || !text) return;
      segments.push({ id: `v${pg.page}:${i}`, text });
    });
  }
  return segments;
}

/** 把翻译结果回填到视觉块（b.t = 译文；失败/未译的块保持 undefined，组装时回退原文） */
export function applyVisionTranslations(pageBlocks, segments, map) {
  const byPage = new Map((pageBlocks || []).map((p) => [String(p.page), p]));
  for (const seg of segments || []) {
    const t = map?.get?.(seg.id);
    if (t == null) continue;
    const m = /^v(\d+):(\d+)$/.exec(seg.id);
    if (!m) continue;
    const block = byPage.get(m[1])?.blocks?.[Number(m[2])];
    if (block) block.t = t;
  }
}

/** 每页可用图片区域表：页号(1起始) → [{x0,y0,x1,y1}]，与 buildElements 用同一套过滤 */
function figureRectMap(layoutPages) {
  const map = new Map();
  for (const page of layoutPages || []) {
    const rects = (page.images || [])
      .filter((img) => (img.x1 - img.x0) * (img.y1 - img.y0) >= 2200)
      .map((img) => ({ x0: img.x0 - 1.5, y0: img.y0 - 1.5, x1: img.x1 + 1.5, y1: img.y1 + 1.5 }));
    if (rects.length) map.set((page.index || 0) + 1, rects);
  }
  return map;
}

function mdEscapeCaption(s) {
  return String(s || '').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * 视觉路径组装：块数组 → Markdown。
 * @param {Array} pageBlocks [{page, blocks:[{tag,text,t?}]}]
 * @param {Array|null} layoutPages analyze 的页面（用于 [FIG] → crop 引用；可为 null）
 */
export function assembleVisionMarkdown(pageBlocks, layoutPages) {
  const figMap = figureRectMap(layoutPages);
  const figCounters = new Map();
  const lines = [];
  let textCount = 0;
  let cropCount = 0;

  for (const pg of pageBlocks || []) {
    for (const b of pg.blocks || []) {
      // 译文优先；没译上的块回退原文（与全文翻译「失败保留原文」的口径一致）
      const translated = String(b.t ?? '').trim();
      const text = translated || String(b.text || '').trim();
      switch (b.tag) {
        case 'TITLE':
        case 'H1': case 'H2': case 'H3': case 'H4': case 'P': case 'CAP': case 'REF': {
          if (!text) break;
          textCount++;
          if (b.tag === 'TITLE') lines.push(`# ${text}`, '');
          else if (b.tag === 'H1') lines.push(`## ${text}`, '');
          else if (b.tag === 'H2') lines.push(`### ${text}`, '');
          else if (b.tag === 'H3' || b.tag === 'H4') lines.push(`#### ${text}`, '');
          else if (b.tag === 'CAP') lines.push(`*${text}*`, '');
          else lines.push(text, '');
          break;
        }
        case 'TABLE': {
          const rows = String(b.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
          if (rows.length) { lines.push(...rows, ''); textCount++; }
          break;
        }
        case 'FORMULA': {
          const latex = String(b.text || '').trim().replace(/^\$\$|\$\$$/g, '').trim();
          if (latex) { lines.push('$$', latex, '$$', ''); textCount++; }
          break;
        }
        case 'FIG': {
          const rects = figMap.get(pg.page) || [];
          const idx = figCounters.get(pg.page) || 0;
          figCounters.set(pg.page, idx + 1);
          const caption = mdEscapeCaption(text || '插图');
          if (idx < rects.length) {
            const r = rects[idx];
            const n = (v) => Math.round(v * 10) / 10;
            lines.push(`![${caption}](crop:p${pg.page}:${n(r.x0)}:${n(r.y0)}:${n(r.x1)}:${n(r.y1)})`, '');
            cropCount++;
          } else {
            lines.push(`*（图：${caption}）*`, '');
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown: markdown ? markdown + '\n' : '', stats: { text: textCount, crops: cropCount } };
}

/** 视觉模式里缺图页的兜底：这一页直接走文本层转 Markdown（译文已回填在 block.translation） */
export function visionPageFallbackMarkdown(layoutPage, opts = {}) {
  if (!layoutPage) return { markdown: '', textCount: 0, cropCount: 0 };
  const { elements } = buildElements([layoutPage], { reflowKeepFigures: opts.reflowKeepFigures !== false });
  return elementsToMarkdown(elements);
}
