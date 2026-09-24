// thesisOutline.js —— 学位论文章节识别（纯函数，可单测）
//
// 三级兜底，按可靠性从高到低：
//   ① PDF 内嵌书签（bookmark）：最准，几乎零成本
//   ② 目录页解析（toc）：找「目录」页，解析 “1.1 研究背景 …… 12” 这类行
//   ③ 标题正则启发式（heading）：第X章 / 1.1 / 固定节名（摘要、参考文献、致谢…）
// 三者都拿不到时退化为「每 10 页一块」（fallback），保证书签栏永远有东西可用。
//
// 产出 items: [{ id, title, level, page, endPage, children? }]
//   · 是阅读器左侧书签栏的数据源
//   · 也是检索时给每段标注章节归属的依据
// 一份数据两用 —— 这是本模块的价值所在。

const CN_DIGITS = '零〇一二三四五六七八九十百千';

// 固定节名（学位论文里几乎必然出现，且不适合被当成普通正文行）
const FIXED_SECTIONS = [
  '摘\\s*要', 'abstract', '绪\\s*论', '导\\s*论', '引\\s*言', '前\\s*言',
  '文献综述', '文献回顾', '相关(理论|研究|文献)', '理论基础', '概念界定',
  '研究设计', '研究(方法|方案|假设|框架|问题|意义|内容)', '研究现状',
  '实证(分析|研究|检验)', '数据分析', '结果(与)?讨论', '结果(与)?分析', '讨论',
  '研究结论', '结论(与展望|与启示|与建议)?', '总结(与展望)?',
  '参考文献', '致\\s*谢', '附\\s*录', '攻读(学位|博士|硕士)期间',
  '学位论文(独创性|使用授权)声明', '独创性声明',
];

const FIXED_RE = new RegExp(`^((${FIXED_SECTIONS.join('|')}))(\\s|$|[：:、.．])`, 'i');
const CHAPTER_RE = new RegExp(`^第\\s*[0-9${CN_DIGITS}]{1,6}\\s*[章篇部分讲]`);
const NUM_HEADING_RE = /^(\d+(?:[.．]\d+)*)\s*[、.．]?\s*\S/;
const CN_NUM_HEADING_RE = new RegExp(`^[${CN_DIGITS}]{1,4}\\s*[、.．]\\s*\\S`);
const FIG_TABLE_RE = /^(图|表|fig(ure)?|table|chart)\s*[\d一二三四五六七八九十]/i;
// 英文 / 双语的学位论文不少：Chapter 1、Appendix A、References 这些也要认得
const EN_SECTION_RE = /^(chapter|section|part|appendix|introduction|conclusion|references|bibliography|acknowledge?ments?)\b/i;
const EN_CHAPTER_RE = /^(chapter|part|appendix)\s*[\dIVXivx]+/i;

/** 清理标题：统一空白、去掉点线与行尾页码、截断 */
export function cleanTitle(raw) {
  let s = String(raw || '')
    .replace(/[\u3000\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[\s.·…．・]{2,}\s*[0-9]{1,4}\s*$/, '').trim(); // 点线 + 页码
  s = s.replace(/[\s.·…．・]{3,}$/, '').trim();                  // 只有点线
  s = s.replace(/[\s.·…．・]+\s*[0-9]{1,4}$/, '').trim();        // 纯空格 + 页码
  return s.slice(0, 120);
}

/** 由标题形态判断层级（1 = 章，2 = 节，3 = 小节…） */
export function detectLevel(title) {
  const t = String(title || '').trim();
  if (!t) return 1;
  if (CHAPTER_RE.test(t)) return 1;
  if (FIXED_RE.test(t)) return 1;
  if (EN_CHAPTER_RE.test(t)) return 1;
  if (/^(references|bibliography|acknowledge?ments?|introduction|conclusion)\b/i.test(t)) return 1;
  const m = t.match(/^(\d+(?:[.．]\d+)*)/);
  if (m) {
    const depth = m[1].split(/[.．]/).filter(Boolean).length;
    return Math.max(1, Math.min(4, depth));
  }
  if (CN_NUM_HEADING_RE.test(t)) return 2;
  return 2;
}

/** 这一行像不像章节标题（用于过滤正文噪音） */
export function looksLikeHeading(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 90) return false;
  if (/[。！？；;]$/.test(s)) return false;           // 句号结尾 → 是正文
  if (FIG_TABLE_RE.test(s)) return false;            // 图表目录不算章节
  if (CHAPTER_RE.test(s)) return true;
  if (FIXED_RE.test(s)) return true;
  if (EN_SECTION_RE.test(s)) return true;
  if (NUM_HEADING_RE.test(s)) return true;
  if (CN_NUM_HEADING_RE.test(s)) return true;
  return false;
}

// ---------------- ① 内嵌书签 ----------------

/** pdf.js outline（已解析好 page）→ 扁平条目 */
export function flattenBookmarks(nodes, level = 1, out = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const title = cleanTitle(node?.title);
    const page = Number(node?.page) > 0 ? Math.round(Number(node.page)) : 0;
    if (title && page) out.push({ title, page, level: Math.max(1, Math.min(4, level)) });
    if (Array.isArray(node?.items) && node.items.length) flattenBookmarks(node.items, level + 1, out);
  }
  return out;
}

// ---------------- ② 目录页 ----------------

/** 一行是否像目录条目（标题 + 点线/空隙 + 页码） */
function isTocLine(line) {
  const s = String(line || '').trim();
  if (!s || s.length > 120) return false;
  if (/[.·…．・]{2,}\s*\d{1,4}\s*$/.test(s)) return true;
  if (/\s{2,}\d{1,4}\s*$/.test(s)) return true;
  return false;
}

/** 统计一页里像目录条目的行数 */
export function tocLineScore(text) {
  let n = 0;
  for (const line of String(text || '').split('\n')) if (isTocLine(line)) n += 1;
  return n;
}

/** 找出目录页（可能是连续几页）；一旦离开目录就不再往回找 */
export function findTocPages(pages, { maxScan = 40 } = {}) {
  const limit = Math.min(pages.length, maxScan);
  const out = [];
  let started = false;
  for (let i = 0; i < limit; i += 1) {
    const text = String(pages[i]?.text || '');
    const hasWord = /^\s*(目\s*录|contents)\s*$/im.test(text);
    const score = tocLineScore(text);
    if (hasWord || (started && score >= 3)) {
      out.push(pages[i].page);
      started = true;
      continue;
    }
    if (started) break;
  }
  return out;
}

/** 解析目录页文本 → 条目 */
export function parseTocEntries(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || line.length > 120) continue;
    if (/^(目\s*录|contents)$/i.test(line)) continue;
    const m = line.match(/^(.{2,100}?)[\s.·…．・]*(\d{1,4})\s*$/);
    if (!m) continue;
    const title = cleanTitle(m[1]);
    const page = Number(m[2]);
    if (!title || !(page > 0)) continue;
    if (!looksLikeHeading(title)) continue;
    out.push({ title, page, level: detectLevel(title) });
  }
  return out;
}

// ---------------- ③ 标题正则启发式 ----------------

/** 每页只看开头几行（章节标题通常在页首），命中即取第一个 */
export function guessHeadings(pages, { skipPages = new Set(), leadLines = 10 } = {}) {
  const out = [];
  for (const p of pages) {
    if (skipPages.has(p.page)) continue;
    const lines = String(p.text || '')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, leadLines);
    for (const line of lines) {
      if (line.length > 60) continue;
      if (/[，,、]$/.test(line)) continue;
      if (!looksLikeHeading(line)) continue;
      out.push({ title: cleanTitle(line), page: p.page, level: detectLevel(line) });
      break; // 每页只取一个
    }
  }
  return out;
}

// ---------------- 组装 ----------------

function fallbackChunks(total, size = 10) {
  const out = [];
  for (let p = 1; p <= total; p += size) {
    const end = Math.min(total, p + size - 1);
    out.push({ title: `第 ${p}–${end} 页`, page: p, level: 1 });
  }
  return out;
}

/** 清理 + 夹紧页码 + 去重 + 按页排序（保持同页内的原始顺序） */
export function normalizeEntries(entries, totalPages) {
  const total = Math.max(1, Number(totalPages) || 1);
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const title = cleanTitle(e?.title);
    if (!title) continue;
    let page = Math.round(Number(e?.page) || 0);
    if (!(page >= 1)) continue;
    if (page > total) page = total; // 目录页码偶尔会超出（页脚计数差异），夹回最后一页而不是丢弃
    const key = `${title}@${page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, page, level: Math.max(1, Math.min(4, Number(e?.level) || 1)), _i: out.length });
  }
  // 按页稳定排序；同页保持录入顺序
  return out.sort((a, b) => (a.page - b.page) || (a._i - b._i)).map(({ _i, ...rest }) => rest);
}

function isAscending(items) {
  for (let i = 1; i < items.length; i += 1) if (items[i].page < items[i - 1].page) return false;
  return true;
}

/** 计算 endPage 并补上稳定 id */
export function finalizeOutline(items, totalPages) {
  const total = Math.max(1, Number(totalPages) || 1);
  const sorted = [...items].sort((a, b) => a.page - b.page);
  return sorted.map((it, i) => {
    const next = sorted[i + 1];
    const endPage = next ? Math.max(it.page, next.page - 1) : total;
    return { id: `c${i + 1}`, title: it.title, level: it.level, page: it.page, endPage };
  });
}

/**
 * 章节识别主入口
 * @param {{pages?:{page:number,text:string}[], bookmarks?:{title,page,level}[], totalPages?:number}} input
 */
export function buildOutline({ pages = [], bookmarks = [], totalPages = 0 } = {}) {
  const total = Math.max(1, Number(totalPages) || pages.length || 1);
  let items = [];
  let source = '';

  const bm = normalizeEntries(bookmarks, total);
  if (bm.length >= 3) { items = bm; source = 'bookmark'; }

  if (!items.length && pages.length) {
    const tocPages = findTocPages(pages);
    if (tocPages.length) {
      const byPage = new Map(pages.map((p) => [p.page, p.text]));
      const text = tocPages.map((n) => byPage.get(n) || '').join('\n');
      const toc = normalizeEntries(parseTocEntries(text), total);
      if (toc.length >= 4 && isAscending(toc)) { items = toc; source = 'toc'; }
    }
  }

  if (!items.length && pages.length) {
    const skip = new Set(findTocPages(pages));
    const hs = normalizeEntries(guessHeadings(pages, { skipPages: skip }), total);
    // 启发式难免有噪音，要求至少 3 条且整体递增才敢用
    if (hs.length >= 3 && isAscending(hs)) { items = hs; source = 'heading'; }
  }

  if (!items.length) { items = fallbackChunks(total); source = 'fallback'; }

  const finalized = finalizeOutline(items, total);
  return { items: finalized, source, totalPages: total, tree: toTree(finalized) };
}

/** 扁平条目 → 嵌套树（按 level 缩进） */
export function toTree(items) {
  const roots = [];
  const stack = [];
  for (const it of items) {
    const node = { ...it, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

/** 给定页码，返回所在的最深章节 */
export function chapterAt(items, page) {
  const n = Number(page) || 1;
  let best = null;
  for (const it of items) {
    if (it.page <= n && n <= it.endPage) {
      if (!best || it.level > best.level) best = it;
    }
  }
  return best || items[0] || null;
}

/** 目录树 → 提示词用的纯文本（带页码，喂给模型建立全局观） */
export function outlineToText(items, { maxItems = 80 } = {}) {
  return (Array.isArray(items) ? items : [])
    .slice(0, maxItems)
    .map((it) => `${'  '.repeat(Math.max(0, (it.level || 1) - 1))}- ${it.title}（p.${it.page}）`)
    .join('\n');
}

/** 与上次相比章节结构是否变了（变了才需要重建索引） */
export function outlineSignature(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => `${it.level}:${it.title}@${it.page}`)
    .join('|');
}
