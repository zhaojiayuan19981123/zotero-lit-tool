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
 *
 * 与视觉路径保持同一套「目录化」口径：识别 h2/h3 标题、聚合摘要、丢弃图表。
 * buildElements 已把 title/h2/h3/body/caption/ref 分好级，这里把它当成视觉块复用
 * assembleVisionMarkdown，两条路径的成品结构完全一致。
 * @param {Array} pages analyzePdf 的 layout.pages
 * @param {object} [opts] reflowKeepFigures 等开关
 */
export function buildMarkdownFromLayout(pages, opts = {}) {
  const { elements } = buildElements(pages || [], {
    reflowKeepFigures: opts.reflowKeepFigures !== false,
  });
  // 文本层元素 → 视觉块标记（level 映射到 tag），再走同一套目录化组装
  const pageBlocks = [{ page: 1, blocks: [] }];
  const seenTitle = new Set();
  for (const el of elements || []) {
    if (el.type === 'crop') {
      // 公式块保留（公式属于正文语义）；表格与插图按用户要求丢弃。
      // 文本层拿不到公式的 LaTeX，用原文文本包成公式块，比整块消失好。
      const latex = String(el.text || el.caption || '').replace(/\s+/g, ' ').trim();
      if (el.kind === 'formulas' && latex) {
        pageBlocks[0].blocks.push({ tag: 'FORMULA', text: latex });
      }
      continue;
    }
    const raw = String(el.text || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const tag = el.level === 'title' ? 'TITLE'
      : el.level === 'h2' ? 'H1'
        : el.level === 'h3' ? 'H2'
          : el.level === 'h4' || el.level === 'h5' ? 'H3'
            : el.level === 'ref' ? 'REF'
              : el.level === 'caption' ? 'CAP'
                : 'P';
    if (tag === 'TITLE') {
      const key = raw.toLowerCase();
      if (seenTitle.has(key)) continue;
      seenTitle.add(key);
    }
    pageBlocks[0].blocks.push({ tag, text: raw });
  }
  // 无标题时用首段兜底当标题（避免成品没有 # 一级标题）。
  // 硬性要求：必须是页面**第一个**文本块，且不含期刊/版权信息——否则宁可没有 H1，
  // 也不能把正文首段或期刊信息行顶成「论文标题」（比缺标题更难排查）。
  const blocks0 = pageBlocks[0].blocks;
  if (!blocks0.some((b) => b.tag === 'TITLE') && blocks0.length) {
    const first = blocks0[0];
    const looksLikeInfo = /\b(ISSN|DOI|Vol\.?|Volume|Issue|Copyright|©)\b/i.test(first.text)
      || /^\s*(journal|proceedings|transactions)\b/i.test(first.text);
    if (first.tag === 'P' && first.text.length <= 200 && !looksLikeInfo) first.tag = 'TITLE';
  }
  // 文本层没有「原文」，标题下不附原文（showOriginal:false），否则会把译文重复一遍
  const { markdown, stats } = assembleVisionMarkdown(pageBlocks, null, { showOriginal: false });
  return {
    markdown,
    stats: { ...stats, text: stats.text, crops: 0 },
  };
}

// ==================== 视觉模型路径 ====================

/**
 * 视觉识别提示词：让视觉模型把一页论文版面「转录」成结构化标记文本。
 * 只提取、不翻译——翻译复用统一的分段翻译管线（术语表/缓存/并发自适应都在那边）。
 *
 * ★ 职责边界（用户明确要求，勿破坏）：
 *   视觉模型**只负责「看图识字」**——把版面转录成标记文本，一个字都不翻译；
 *   译文一律交给「系统默认翻译模型 / 用户在划词设置里选的翻译服务」来做。
 *   好处有三：① 视觉模型往往不是最擅长翻译的那个模型，强让它翻译会牺牲质量；
 *   ② 转录用原文能让术语表、翻译缓存、`isAlreadyTarget` 判定等既有设施全部生效；
 *   ③ 中途换翻译引擎不必重新跑一遍（很贵的）视觉识别。
 *
 * ★ 训练/实现要点（勿轻易改动，都是踩过坑的）：
 *   1) 标题必须「逐字完整」转录：早期版本模型只肯输出「1 Introduction」这类编号，
 *      把标题文字整个丢掉，导致目录全是空壳。现在对 [H1]/[H2] 反复强调必须带标题文字。
 *   2) 图表一律不转录（用户明确要求「图和表都不要」），省的 token 全部让给正文与标题。
 *   3) 公式仍用 LaTeX 原样保留（公式属于正文语义，不属于图表）。
 *   4) 「不要翻译」以前只写在「转录要求」第 2 条里，容易被长提示词淹没；现在提到
 *      铁律级别（第 3 条），并给出正误示例，因为一旦模型顺手翻译成中文，
 *      `collectVisionSegments` 收集到的就是中文，`isAlreadyTarget()` 会判定为
 *      「已经是目标语言」而整段跳过翻译——译文看着正常，术语表和缓存却全失效了。
 */
export function visionPaperPrompt({ translateReferences = false } = {}) {
  return [
    '你是专业的学术论文版面转录员。请把这张论文页面图「逐字转录」成结构化文本，供后续翻译使用。',
    '',
    '## 最重要的三条铁律（违反即视为任务失败）',
    '1) **标题必须完整**：转录 [H1]/[H2]/[H3] 时，必须写全标题文字本身，不能只写章节编号。',
    '   正确：[H1] 2 Literature Review and Hypotheses',
    '   正确：[H2] 2.1 Brand-generated visual non-typicality',
    '   错误：[H1] 2  ← 只有编号没有标题文字，等于没识别出来',
    '   即使标题很长、包含冒号/破折号/副标题，也必须一字不漏地写完。',
    '2) **图表一律跳过**：所有插图、照片、示意图、流程图、统计图、表格及其标题',
    '   （Figure 1 / Table 2 / 图注、表注）全部不要转录，一个字也不要输出。',
    '3) **绝对不要翻译**：你的任务只是「看图识字」，把页面上的文字照抄下来，',
    '   保持原有语言（英文就抄英文、中文就抄中文）。翻译由后续另一个模型完成。',
    '   正确：[P] Brand-generated visual non-typicality refers to the degree to which...',
    '   错误：[P] 品牌生成的视觉非典型性是指……  ← 翻译了，等于任务失败',
    '',
    '## 输出标记（每个标记独占一行，标记后紧跟内容）',
    '[TITLE] 论文主标题（仅首页出现一次，完整原文）',
    '[H1] 一级章节标题：必须含编号 + 完整标题文字',
    '[H2] 二级小节标题：必须含编号 + 完整标题文字',
    '[H3] 三级及更深的标题：同样必须完整',
    '[P] 正文段落（一段一个 [P]；同一段的多行文字合并进同一个 [P]）',
    '[META] 非正文的作者/单位/期刊/收录信息（如 Journal of Marketing, 2025; Authors: ...）',
    '[FORMULA] 与 [/FORMULA] 之间输出该独立公式的 LaTeX 源码（不带 $ 符号）',
    '[SEC] 章节名标记：遇到 "Abstract"/"Keywords"/"References"/"Appendix"/"Introduction"',
    '      这类无编号章节名时用它（[SEC] Abstract、[SEC] References）',
    '[REF] 参考文献条目（每条一个 [REF]，按开头的序号/作者原样转录）',
    '',
    '## 转录要求',
    '1. 严格按视觉阅读顺序：单栏从上到下；双栏先通栏块，再左栏从上到下，然后右栏从上到下；',
    '2. 只转录页面真实存在的内容，不要推测、不要补充、绝对不要翻译（保持原文语言）；',
    '3. 数学公式内联在段落里时用 LaTeX 写在 [P] 文本中（如 $x^2$）；独立成行的公式用 [FORMULA]；',
    '4. 页眉、页脚、页码、版权行、投稿日期、审稿痕迹、脚注一律忽略；',
    '5. 摘要正文用 [P] 转录（摘要标题用 [SEC] Abstract）；关键词若独立成行，用 [P] 转录；',
    '6. 看不清的文字用 [?] 标记而不是编造；标题看不清也要尽力识别，不要直接省略标题；',
    '7. 不要输出任何解释、开场白、markdown 代码块或标记体系说明，直接输出转录结果；',
    '8. 不要输出 [FIG] / [TABLE] / [CAP] ——本任务明确不要图表。',
    translateReferences
      ? '9. 参考文献部分需完整转录（每条一个 [REF]）。'
      : '9. 参考文献部分（References 之后的所有条目）整个跳过，连 [REF] 都不要输出。',
  ].join('\n');
}

const VISION_TAGS = new Set(['TITLE', 'H1', 'H2', 'H3', 'H4', 'P', 'CAP', 'TABLE', 'FORMULA', 'FIG', 'REF', 'META', 'SEC']);

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

/** 视觉路径里需要送翻译的标记（FORMULA 原样透传；FIG/TABLE 已不再产生） */
const VISION_TRANSLATABLE = new Set(['TITLE', 'H1', 'H2', 'H3', 'H4', 'P', 'CAP', 'META', 'SEC']);

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

/** 每页可用图片区域表（已弃用：目录化排版不再插入裁剪图，保留仅供外部兼容引用） */
export function figureRectMap(layoutPages) {
  const map = new Map();
  for (const page of layoutPages || []) {
    const rects = (page.images || [])
      .filter((img) => (img.x1 - img.x0) * (img.y1 - img.y0) >= 2200)
      .map((img) => ({ x0: img.x0 - 1.5, y0: img.y0 - 1.5, x1: img.x1 + 1.5, y1: img.y1 + 1.5 }));
    if (rects.length) map.set((page.index || 0) + 1, rects);
  }
  return map;
}

// ==================== 目录化组装（用户要求的最终排版口径）====================
//
// 用户口径：「按照论文目录进行展示，分为文章信息（不重要的信息删除）、摘要、第一章、
// 第二章、各个标题分别对应，图和表都不要」。
//
// 因此组装不再是「把视觉块平铺」而是先归并成层级树：
//   # 论文标题（译文 + 原文）
//   ## 文章信息        ← [META]，清理掉 ISSN/DOI/版权/投稿日期等冗余
//   ## 摘要            ← [SEC] Abstract + 紧随的正文段
//   ## 1 引言          ← [H1]（层1 直接做 h2）
//   ### 1.1 研究背景   ← [H2]（层2 做 h3）
//   #### 1.1.1 ...     ← [H3]（层3 做 h4）
// 图和表彻底丢弃（提示词已让模型不输出，这里再做一层防御性过滤）。

/** 文章信息里需要剔除的冗余片段（期刊收录信息、版权、投稿日期等） */
const META_NOISE = [
  /ISSN[\s:：-]*[\dXx-]+/gi,
  /DOI[\s:：]\s*\S+/gi,
  /\b(?:https?:\/\/)?(?:dx\.)?doi\.org\/\S+/gi,
  /\bhttps?:\/\/\S+/gi,          // 单独出现的裸链接最后处理，避免把 DOI 里的域名先吃掉
  /\bwww\.\S+/gi,
  /©[^。;；]*/g,
  /\(c\)\s*\d{4}[^。;；]*/gi,
  /Copyright[^。;；]*/gi,
  /All rights reserved\.?/gi,
  /This is an open access article[^。;；]*/gi,
  /Creative Commons[^。;；]*/gi,
  /Licensed under[^。;；]*/gi,
  /(?:Received|Revised|Accepted|Published|Available online)[^。;；\d]*\d{4}[^。;；]*/gi,
  /\b\d{4}年\d{1,2}月\d{1,2}日[^。]*在线(?:出版|提供)[^。]*/g,
  /\b(?:Vol\.?|Volume)\s*\d+[^。;；]*/gi,
  /\bIssue\s*\d+[^。;；]*/gi,
];

/** 清理文章信息文本：去掉版权/DOI/链接等冗余，保留作者、单位、期刊、年份 */
function cleanMetaText(s) {
  let out = String(s || '');
  for (const re of META_NOISE) out = out.replace(re, ' ');
  return out
    .split(/\n+/)
    .map((line) => line
      .replace(/\s*[|｜]\s*$/gm, '')
      .replace(/\s*[,，;；、]\s*(?=[,，;；、]|$)/g, '')  // 清掉孤立分隔符（删字段后残留）
      .replace(/\(\s*\)|（\s*）/g, '')
      .replace(/\.\s*\./g, '.')           // 删正文后留下的连续句点
      .replace(/\s{2,}/g, ' ')
      .replace(/[\s.,，、;；:：.。]+$/g, '')  // 行尾分隔符／句点（DOI 被删后常留一个 "."）
      .replace(/^[\s,，、;；:：.。]+/g, '')
      .trim())
    .filter((l) => l && !/^[.。,，;；:：\-—·|\s]+$/.test(l))
    .join('\n')
    .trim();
}

/** 章节名归一：Abstract / 摘要 / Keywords / References 等 */
function normalizeSectionName(s) {
  return String(s || '').replace(/^\s*\d+(?:\.\d+)*\.?\s*/, '').trim().toLowerCase();
}

const ABSTRACT_NAMES = new Set(['abstract', '摘要', 'a b s t r a c t', 'summary']);
const KEYWORD_NAMES = new Set(['keywords', 'key words', '关键词', '关键字']);
const REF_NAMES = new Set(['references', 'reference', 'bibliography', '参考文献', '文献']);

/**
 * 是否为「序言章」——即不该占用正文章节号的标题。
 * 只认摘要/关键词这类前置内容；**Introduction/引言要占用 1 号**（论文里它就是第 1 章），
 * 早期把 introduction 也算作序言，导致第一章永远缺号。
 */
function isPreludeHeading(text) {
  const t = normalizeSectionName(text);
  return ABSTRACT_NAMES.has(t) || KEYWORD_NAMES.has(t) || REF_NAMES.has(t);
}

/** 从标题文本里抽章节号，返回 {num, text}；num 形如 '3.1' */
function splitHeadingNumber(text) {
  const m = /^\s*(\d+(?:\.\d+)*)\.?\s+(.*)$/.exec(String(text || '').trim());
  if (m) return { num: m[1], text: m[2].trim() };
  const m2 = /^\s*(\d+(?:\.\d+)*)\.?\s*$/.exec(String(text || '').trim());
  if (m2) return { num: m2[1], text: '' };
  return { num: '', text: String(text || '').trim() };
}

/** 标题行渲染：`## 1 译文标题`，并在下一行用小字给出原文标题 */
function headingLine(level, text, original, { showOriginal = true } = {}) {
  const hashes = '#'.repeat(level);
  const body = String(text || '').trim();
  const orig = String(original || '').trim();
  const out = [`${hashes} ${body}`];
  // 译文与原文不同才附原文，避免中英混排时重复啰嗦。
  // 视觉路径里 b.text 是原文、b.t 是译文，两者天然不同；
  // 文本层路径里 buildElements 已经把 text 换成了译文，此时由调用方传入 showOriginal:false。
  if (showOriginal && orig && orig.replace(/\s+/g, ' ') !== body.replace(/\s+/g, ' ')) {
    out.push('', `> 原文：${orig}`);
  }
  return out;
}

/**
 * 视觉路径组装（目录化）：块数组 → 按论文结构的 Markdown。
 *
 * @param {Array} pageBlocks [{page, blocks:[{tag,text,t?}]}]
 * @param {Array|null} layoutPages 保留参数以兼容旧调用（目录化后不再用图区）
 * @param {object} [opts]
 * @param {boolean} [opts.showOriginal=true] 标题下是否附原文。
 *   视觉路径为 true（text=原文、t=译文）；文本层路径必须为 false——buildElements
 *   已把 text 换成译文，再附一次「原文」等于把译文重复一遍。
 */
export function assembleVisionMarkdown(pageBlocks, layoutPages, opts = {}) {
  void layoutPages; // 目录化排版不再插入任何裁剪图
  const showOriginal = opts.showOriginal !== false;
  const all = [];
  for (const pg of pageBlocks || []) {
    for (const b of pg.blocks || []) {
      const translated = String(b.t ?? '').trim();
      all.push({ tag: b.tag, text: String(b.text || '').trim(), out: translated || String(b.text || '').trim() });
    }
  }

  const stats = { text: 0, crops: 0, dropped: 0 };
  const lines = [];
  let titleWritten = false;
  const metaParts = [];
  const abstractParts = [];
  const keywordsParts = [];
  const refParts = [];
  /** 正文章节序列：[{ level, num, text, orig, body:[], children:[] }] 用扁平栈管理 */
  const outline = [];
  let stack = []; // 当前路径上的章节栈
  let inAbstract = false;
  let inRefs = false;

  const pushBody = (node, text) => { if (node) node.body.push(text); };
  const currentSection = () => (stack.length ? stack[stack.length - 1] : null);

  for (const b of all) {
    switch (b.tag) {
      case 'TITLE': {
        if (titleWritten || !b.out) break;
        titleWritten = true;
        lines.push(`# ${b.out}`, '');
        if (b.text && b.text.replace(/\s+/g, ' ') !== b.out.replace(/\s+/g, ' ')) {
          lines.push(`> 原文标题：${b.text}`, '');
        }
        stats.text++;
        break;
      }
      case 'META': {
        if (b.out) metaParts.push(b.out);
        break;
      }
      case 'SEC': {
        // 用「原文」判定章节类型更可靠：译文里 "Abstract" 可能被译成「摘要」，
        // 而 [SEC] Keywords 这类标记名常常原样保留、不翻译。
        const norm = normalizeSectionName(b.text) || normalizeSectionName(b.out);
        if (ABSTRACT_NAMES.has(norm)) { inAbstract = true; inRefs = false; keywordsParts.push('__abs__'); }
        else if (REF_NAMES.has(norm)) { inAbstract = false; inRefs = true; }
        else if (KEYWORD_NAMES.has(norm)) {
          inAbstract = false; inRefs = false;
          // 只记「关键词」这个小标题本身，内容由紧随的 [P] 提供
          keywordsParts.push('__kw__');
        } else {
          // 其它无编号章节名（如 Appendix）当作一级标题
          inAbstract = false; inRefs = false;
          const node = { level: 1, num: '', text: b.out, orig: b.text, body: [] };
          outline.push(node); stack = [node];
        }
        stats.text++;
        break;
      }
      case 'H1': case 'H2': case 'H3': case 'H4': {
        inAbstract = false;
        // 参考文献标题也可能被视觉模型标成 [H1]/[H2]（而不是 [SEC]）：
        // 不能当成普通章节，否则会多出一个空的「## 参考文献」标题。
        const normH = normalizeSectionName(b.text) || normalizeSectionName(b.out);
        if (REF_NAMES.has(normH)) { inRefs = true; stats.text++; break; }
        // 编号优先从「原文」抽（译文里的编号可能被翻成"1 引言"这类，也可能没保留）
        const parsedOut = splitHeadingNumber(b.out);
        const parsedOrig = splitHeadingNumber(b.text);
        const num = parsedOrig.num || parsedOut.num || '';
        const textOut = parsedOut.text || b.out;
        const level = b.tag === 'H1' ? 1 : b.tag === 'H2' ? 2 : 3;
        const node = { level, num, text: textOut, orig: parsedOrig.text || b.text, body: [] };
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        outline.push(node);
        stack = [...stack, node];
        if (inRefs) { inRefs = false; }
        stats.text++;
        break;
      }
      case 'P': {
        if (!b.out) break;
        stats.text++;
        // 关键词小节：标题之后的正文段就是关键词内容（去掉 "Keywords:"/"关键词：" 前缀）
        if (keywordsParts.includes('__kw__') && !keywordsParts.includes('__kw_filled__')) {
          keywordsParts.push('__kw_filled__');
          keywordsParts.push(String(b.out).replace(/^\s*(keywords?|key words|关键词|关键字)\s*[:：]?\s*/i, '').trim());
          break;
        }
        if (inAbstract) { abstractParts.push(b.out); break; }
        if (inRefs) { refParts.push(b.out); break; }
        const node = currentSection();
        if (node) pushBody(node, b.out);
        else metaParts.push(b.out); // 标题之前的零散正文（首页眉首信息等）
        break;
      }
      case 'REF': {
        if (b.out) refParts.push(b.out);
        stats.text++;
        break;
      }
      case 'FORMULA': {
        // 公式保留（属于正文语义），但只放在章节体内
        const latex = String(b.text || '').trim().replace(/^\$\$|\$\$$/g, '').trim();
        if (!latex) break;
        stats.text++;
        const node = currentSection();
        const block = ['$$', latex, '$$'].join('\n');
        if (node) node.body.push(block);
        else abstractParts.push(block);
        break;
      }
      // 图表一律丢弃（提示词已不产生，这里防御性兜底）
      case 'FIG': case 'TABLE': case 'CAP':
        stats.dropped++;
        break;
      default:
        if (b.out) {
          const node = currentSection();
          if (node) node.body.push(b.out); else metaParts.push(b.out);
        }
        break;
    }
  }

  // ---- 按目录顺序拼装 ----
  const metaText = cleanMetaText(metaParts.join('\n'));
  if (metaText) { lines.push('## 文章信息', '', metaText, ''); }

  if (abstractParts.length) {
    lines.push('## 摘要', '', abstractParts.join('\n\n'), '');
  }
  if (keywordsParts.length) {
    // keywordsParts 结构：[flag..., 内容]：__abs__/__kw__/__kw_filled__ 都是标记
    const kw = cleanMetaText(
      keywordsParts.filter((x) => !x.startsWith('__')).join('；'),
    );
    if (kw) lines.push(`**关键词：**${kw}`, '');
  }

  let chapterNo = 0;
  for (const node of outline) {
    // 一级标题没有编号时补顺序号（只有明确的序言章才不占号）
    let num = node.num;
    if (!num && node.level === 1) {
      if (isPreludeHeading(node.text)) { num = ''; } else { chapterNo++; num = String(chapterNo); }
    }
    const headingText = num ? `${num} ${node.text || '(未命名章节)'}` : (node.text || '(未命名章节)');
    const mdLevel = Math.min(4, node.level + 1);
    lines.push(...headingLine(mdLevel, headingText, node.orig, { showOriginal }), '');
    if (node.body.length) lines.push(node.body.join('\n\n'), '');
  }

  if (refParts.length) {
    lines.push('## 参考文献', '');
    refParts.forEach((r, i) => {
      const clean = String(r).replace(/\s+/g, ' ').trim();
      if (!clean) return;
      // 转录时通常已保留原文序号（"[1] Smith…"）。已有序号就沿用，避免出现「[1] [1]」。
      const hasNumber = /^\[?\s*\d{1,3}\s*[\].)]/.test(clean);
      lines.push(hasNumber ? clean : `[${i + 1}] ${clean}`, '');
    });
  }

  const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown: markdown ? markdown + '\n' : '', stats };
}

/**
 * 视觉模式里缺图页的兜底：这一页直接走文本层转 Markdown（译文已回填在 block.translation）。
 * 与主线一致使用目录化组装，保证兜底页与视觉页的排版风格统一。
 */
export function visionPageFallbackMarkdown(layoutPage, opts = {}) {
  if (!layoutPage) return { markdown: '', textCount: 0, cropCount: 0 };
  const r = buildMarkdownFromLayout([layoutPage], opts);
  return { markdown: r.markdown, textCount: r.stats.text, cropCount: 0 };
}
