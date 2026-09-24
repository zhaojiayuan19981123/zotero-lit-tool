// thesisContext.js —— 检索 + 上下文组装 + 各类任务的提示词（纯函数，可单测）
//
// 学位论文问答的关键不在「把全文塞进去」，而在于**每次都精确挑出该看的那几段**。
// 四段式上下文：
//   ① system：角色 + 引用规则 + 论文档案卡 + 章节目录树（建立全局观）
//   ② 当前位置：我在哪一页、哪一章，附该处正文（回答「这段说什么」的兜底）
//   ③ 检索命中：BM25 top-8 段，每段带【章节 · p.页码】
//   ④ 最近 8 轮对话
// 预算 20k / 40k / 80k 三档可调 —— 把「上下文过长」变成可控参数而不是黑箱。

import { search, chunksOfChapter } from './thesisIndex.js';
import { chapterAt, outlineToText } from './thesisOutline.js';

export const CONTEXT_PRESETS = [
  { key: 'lean', label: '精简', chars: 20000 },
  { key: 'standard', label: '标准', chars: 40000 },
  { key: 'rich', label: '充裕', chars: 80000 },
];

export function normalizeBudget(value, fallback = 40000) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 6000) return Math.min(200000, Math.round(n));
  return fallback;
}

// ---------------- 中文数字 / 章节定位 ----------------

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字转阿拉伯数字（支持 一 ~ 九十九） */
export function cnToNumber(input) {
  const t = String(input || '').trim();
  if (!t) return NaN;
  if (/^\d+$/.test(t)) return Number(t);
  let section = 0;
  let num = 0;
  for (const ch of t) {
    if (ch === '十') { section += (num || 1) * 10; num = 0; }
    else if (ch === '百') { section += (num || 1) * 100; num = 0; }
    else if (ch in CN_DIGITS) num = CN_DIGITS[ch];
  }
  return section + num || NaN;
}

/** 从章节标题里取出顶层编号（「第三章 研究设计」→ 3，「3.1 假设」→ 3） */
export function chapterNumber(title) {
  const t = String(title || '').trim();
  const cn = t.match(/^第\s*([0-9〇零一二三四五六七八九十百]+)\s*[章篇]/);
  if (cn) return cnToNumber(cn[1]);
  const ar = t.match(/^(\d+)/);
  if (ar) return Number(ar[1]);
  return NaN;
}

const NAMED_SECTIONS = ['摘要', '绪论', '导论', '文献综述', '理论基础', '研究方法', '研究设计',
  '研究假设', '实证分析', '数据分析', '结论', '参考文献', '致谢', '附录', '创新点'];

/** 问题里明确点名了某一章 / 某一节 → 直接定位（比 BM25 更可靠） */
export function matchChapterInQuery(query, outline) {
  const q = String(query || '');
  if (!q || !Array.isArray(outline) || !outline.length) return null;

  const cn = q.match(/第\s*([0-9〇零一二三四五六七八九十百]+)\s*[章篇]/);
  if (cn) {
    const want = cnToNumber(cn[1]);
    if (Number.isFinite(want)) {
      const hit = outline.find((it) => chapterNumber(it.title) === want) || null;
      if (hit) return hit;
    }
  }

  const sec = q.match(/(?:^|[^\d.])(\d+(?:\.\d+){1,3})(?![\d.])/);
  if (sec) {
    const key = sec[1];
    const hit = outline.find((it) => it.title.replace(/\s+/g, '').startsWith(key)) || null;
    if (hit) return hit;
  }

  for (const name of NAMED_SECTIONS) {
    if (q.includes(name)) {
      const hit = outline.find((it) => it.title.includes(name));
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------- 检索 ----------------

/** 命中段 → 带出处的文本块 */
export function formatHit(chunk) {
  if (!chunk) return '';
  const where = chunk.chapterTitle ? `${chunk.chapterTitle} · p.${chunk.page}` : `p.${chunk.page}`;
  return `【${where}】\n${chunk.text}`;
}

/** 位置型提问（「这段」「这里」「上文」）需要把当前页附近的正文也带上 */
export function isLocalQuery(query) {
  // 注意「这一段」里「这」和「段」中间还有字，不能只写「这段」
  return /(这一?段|这一?页|这一?句|这一?块|这里|此处|上面|上文|刚才|当前|本节|此节)/.test(String(query || ''));
}

/**
 * 取与提问最相关的段落
 * 三条来源叠加、按块去重：
 *   ① 问题点名了章节 → 该章整章优先（首/尾/中均匀取样）
 *   ② BM25 top-k
 *   ③ 位置型提问 → 当前页附近的块
 */
export function retrieve({ index, outline = [], query = '', currentPage = 1, topK = 8 } = {}) {
  if (!index?.chunks?.length) return [];
  const out = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || seen.has(c.i)) return;
    seen.add(c.i);
    out.push(c);
  };

  const named = matchChapterInQuery(query, outline);
  if (named) for (const c of chunksOfChapter(index, named.id, { limit: 4 })) push(c);

  for (const h of search(index, query, { topK })) push(h.chunk);

  if (isLocalQuery(query)) {
    const page = Number(currentPage) || 1;
    for (const c of index.chunks.filter((x) => Math.abs(x.page - page) <= 1).slice(0, 3)) push(c);
  }

  return out.slice(0, topK);
}

// ---------------- 上下文组装 ----------------

function oneLine(value) {
  return String(value || '').replace(/\s*\n+\s*/g, '；').trim();
}

/**
 * 档案卡：让模型先掌握全局，再回答细节。
 *
 * 只有 5 个书目字段（标题/作者/学校/学位类型/年份）—— 正文内容一律靠检索命中段提供，
 * 不在这里摘要。曾经这里堆过 17 个字段，结果是模型拿着「自行总结出的一段话」当真，
 * 反而更容易编造；现在宁可只给硬事实。
 */
export function buildProfileCard(record) {
  const g = (k) => String(record?.[k] || '').trim();
  const rows = [
    ['标题', oneLine(g('title'))], ['作者', oneLine(g('authors'))], ['学校', oneLine(g('school'))],
    ['学位类型', oneLine(g('degreeType'))], ['年份', oneLine(g('year'))],
  ].filter(([, v]) => v);
  return rows.map(([k, v]) => `- ${k}：${v}`).join('\n');
}

/** 当前位置：把「用户读到哪」讲清楚，并附该处正文 */
export function buildHereSection({ outline = [], index = null, currentPage = 1, attachSection = true, maxChars = 6000 } = {}) {
  const page = Math.max(1, Number(currentPage) || 1);
  const chapter = chapterAt(outline, page);
  const head = chapter
    ? `用户当前正在阅读第 ${page} 页，位于《${chapter.title}》（该章为第 ${chapter.page}–${chapter.endPage} 页）。`
    : `用户当前正在阅读第 ${page} 页。`;
  if (!attachSection || !index?.chunks?.length) return head;
  // 「附上本节正文」是可关的开关：关了就不带正文，省预算
  const near = index.chunks.filter((c) => c.page >= page - 2 && c.page <= page + 2);
  if (!near.length) return head;
  let text = near.map((c) => `（p.${c.page}）${c.text}`).join('\n\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return `${head}\n\n以下是该位置附近的正文：\n${text}`;
}

export function buildSystemPrompt({ record, outline = [], bigPaper = null, lang = '简体中文' } = {}) {
  const parts = [
    '你是一位学术阅读助手，正在帮助用户精读一篇**学位论文**，并支持用户撰写自己的学位论文。',
    '',
    '【回答要求】',
    '1. 只依据下面提供的论文内容回答，**不要编造**论文里没有的内容。',
    '2. 每次引用论文内容，都要在句末标注出处，格式固定为：【章节标题 · p.页码】，例如：【第三章 研究设计 · p.47】。',
    '3. 如果给出的内容里找不到答案，直接说明「正文里没检索到相关内容」，并指出可能需要翻到哪一章，**不要猜测**。',
    `4. 用${lang}回答，简洁但信息完整；涉及方法、数据、结论时尽量引用原文的关键表述。`,
    '5. 如果问题与用户自己的学位论文写作有关，结合「用户的大论文情况」给出可操作的建议。',
  ];
  const card = buildProfileCard(record);
  if (card) parts.push('', '【论文档案卡】', card);
  const toc = outlineToText(outline, { maxItems: 80 });
  if (toc) parts.push('', '【章节目录（带页码）】', toc);
  const bp = bigPaperSection(bigPaper);
  if (bp) parts.push('', '【用户的大论文情况】', bp);
  return parts.join('\n');
}

/** 关联大论文：问答时带上「我的大论文框架 + 当前阶段」 */
export function bigPaperSection(bigPaper) {
  if (!bigPaper || typeof bigPaper !== 'object') return '';
  const rows = [
    bigPaper.title ? `- 题目：${oneLine(bigPaper.title)}` : '',
    bigPaper.stage ? `- 当前阶段：${oneLine(bigPaper.stage)}` : '',
    bigPaper.framework ? `- 框架：\n${String(bigPaper.framework).trim()}` : '',
    bigPaper.notes ? `- 备注：${oneLine(bigPaper.notes)}` : '',
  ].filter(Boolean);
  return rows.join('\n');
}

/** 历史对话按「最近优先」裁剪到指定字符预算 */
export function trimHistory(history, capChars) {
  const list = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  const out = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const len = list[i].content.length;
    if (used + len > capChars && out.length) break;
    out.unshift({ role: list[i].role, content: list[i].content });
    used += len;
    if (out.length >= 16) break; // 最多 8 轮
  }
  return out;
}

/**
 * 组装一次问答的全部 messages（含预算裁剪）
 * 返回 stats 供界面显示「本次用了多少上下文」，让预算可见。
 */
export function assembleChatMessages({
  record, outline = [], index = null, query = '', currentPage = 1,
  history = [], budgetChars = 40000, attachSection = true, bigPaper = null,
  lang = '简体中文', topK = 8,
} = {}) {
  const budget = normalizeBudget(budgetChars);
  const system = buildSystemPrompt({ record, outline, bigPaper, lang });
  const here = buildHereSection({ outline, index, currentPage, attachSection });
  const hits = retrieve({ index, outline, query, currentPage, topK });

  let hitText = hits.map(formatHit).filter(Boolean).join('\n\n');
  const fixed = system.length + here.length + String(query || '').length + 600;
  const remain = Math.max(4000, budget - fixed);
  const hitCap = Math.round(remain * 0.62);
  let truncated = false;
  if (hitText.length > hitCap) {
    hitText = `${hitText.slice(0, hitCap)}\n…（相关片段已按上下文预算截断）`;
    truncated = true;
  }

  const histCap = Math.max(1500, remain - Math.min(hitText.length, hitCap));
  const recent = trimHistory(history, histCap);

  const body = [
    here,
    hitText
      ? `以下是与你问题最相关的论文片段（按相关度排序，请优先依据它们回答）：\n\n${hitText}`
      : '（本次没有检索到相关片段，请据此如实回答）',
    `【我的问题】\n${query}`,
  ].join('\n\n');

  const messages = [{ role: 'system', content: system }, ...recent, { role: 'user', content: body }];
  const usedChars = messages.reduce((a, m) => a + String(m.content || '').length, 0);
  return {
    messages,
    stats: {
      usedChars,
      budgetChars: budget,
      hitCount: hits.length,
      hitPages: hits.map((c) => c.page),
      sectionTitle: chapterAt(outline, currentPage)?.title || '',
      historyRounds: Math.ceil(recent.length / 2),
      truncated,
    },
  };
}

// ---------------- 各类生成任务 ----------------

export const TASK_LABELS = {
  'chapter-digest': '章节速读',
  'review-entry': '综述条目',
  'defense': '答辩问答演练',
};

function chapterScope({ outline, index, chapterId, currentPage }) {
  const chapter = (Array.isArray(outline) ? outline : []).find((c) => c.id === chapterId)
    || chapterAt(outline, currentPage);
  if (!chapter || !index?.chunks?.length) return { chapter, text: '' };
  const blocks = index.chunks.filter((c) => c.chapterId === chapter.id);
  const list = blocks.length ? blocks : index.chunks.filter((c) => c.page >= chapter.page && c.page <= chapter.endPage);
  const text = list.map((c) => `（p.${c.page}）${c.text}`).join('\n\n').slice(0, 24000);
  return { chapter, text };
}

export function buildTaskPrompt(task, { record, outline = [], index = null, chapterId = '', currentPage = 1, bigPaper = null, lang = '简体中文' } = {}) {
  const { chapter, text } = chapterScope({ outline, index, chapterId, currentPage });
  const card = buildProfileCard(record);
  const toc = outlineToText(outline, { maxItems: 60 });
  const head = [
    '你是一位学术阅读助手，正在帮助用户精读一篇**学位论文**。',
    `用${lang}输出，观点必须来自下面的原文，引用处按【章节标题 · p.页码】标注。`,
    card ? `\n【论文档案卡】\n${card}` : '',
    toc ? `\n【章节目录】\n${toc}` : '',
  ].filter(Boolean).join('\n');

  if (task === 'chapter-digest') {
    const rule = [
      '请针对下面这一章生成「章节速读」，四个小节标题固定如下：',
      '## 这一章在做什么',
      '## 用了什么方法/数据',
      '## 得出了什么结论',
      '## 对我的论文有什么启示',
      '',
      '要求：每节 2-4 句，具体、可引用；最后一节必须结合「用户的大论文情况」（若有）给出可操作建议。',
      chapter ? `本章为：《${chapter.title}》（第 ${chapter.page}–${chapter.endPage} 页）。` : '',
    ].filter(Boolean).join('\n');
    const bp = bigPaperSection(bigPaper);
    return { system: head, user: [rule, bp ? `【用户的大论文情况】\n${bp}` : '', text ? `【本章正文】\n${text}` : '（没有取到本章正文）'].filter(Boolean).join('\n\n') };
  }

  if (task === 'review-entry') {
    const rule = [
      '请把这篇学位论文压缩成一段**文献综述可直接使用的结构化条目**，小标题固定如下：',
      '## 研究对象',
      '## 理论基础',
      '## 研究方法与数据',
      '## 主要结论',
      '## 局限与可借鉴之处',
      '',
      '要求：每节 1-3 句；最后另起一行给出「## 综述引用句」，写 2-3 句可直接放进文献综述的学术表述（含作者与年份）。',
    ].join('\n');
    return { system: head, user: [rule, text ? `【正文摘录】\n${text}` : '（没有取到正文）'].join('\n\n') };
  }

  if (task === 'defense') {
    const rule = [
      '请模拟答辩委员会，从这篇学位论文出 **10 个答辩问题**（按可能被追问的程度从高到低），',
      '每题下面给出「参考要点」，要点要写明依据的章节与页码，格式：【章节标题 · p.页码】。',
      '问题要覆盖：研究问题的合理性、理论选择、方法适用性、数据与样本、结论的稳健性、创新点的说服力、局限。',
      '',
      '输出用有序列表，每题格式：',
      '1. **问题**',
      '   - 参考要点：…（【第三章 · p.47】）',
    ].join('\n');
    return { system: head, user: [rule, text ? `【正文摘录】\n${text}` : '（没有取到正文）'].join('\n\n') };
  }

  throw new Error('未知的生成任务：' + task);
}

/** 对比阅读：2–5 篇 → 对比表（写综述的刚需） */
export function buildCompareMessages(records = [], { lang = '简体中文', perPaperChars = 6000 } = {}) {
  const list = (Array.isArray(records) ? records : []).slice(0, 5);
  const system = [
    '你是一位学术写作助手，擅长把多篇学位论文横向对齐成对比表。',
    `用${lang}输出。只依据用户提供的论文信息，信息缺失就写「未提及」，**不要编造**。`,
  ].join('\n');

  const blocks = list.map((r, i) => {
    const card = buildProfileCard(r);
    return `### 文献 ${i + 1}${r?.year ? `（${r.year}）` : ''}\n${card || '（该篇尚未解析出字段）'}`;
  });

  const user = [
    `请对下面 ${list.length} 篇学位论文做**对比阅读**，输出一张 Markdown 表格，列为：`,
    '`维度 | ' + list.map((_, i) => `文献${i + 1}`).join(' | ') + '`',
    '行为：研究对象 / 理论基础 / 研究方法 / 数据与样本 / 主要结论 / 创新点 / 局限。',
    '',
    '表格之后，再给出一节「## 综述可用表述」，用 3-5 句学术语言概括这批研究的共性与分歧，可直接放进文献综述。',
    '',
    blocks.join('\n\n').slice(0, perPaperChars * list.length),
  ].join('\n');

  return { system, user };
}
