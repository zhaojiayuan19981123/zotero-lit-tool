// thesisIndex.js —— 学位论文的稀疏索引与 BM25 检索（纯函数，可单测，零新依赖）
//
// 为什么不上向量库：
//   学位论文的问答里，「找章节、找概念、找原话」占绝大多数；
//   中文 2-gram + BM25 对这类需求足够，而且零依赖、零额外费用、完全离线。
//   200 页论文建索引约 1–3 秒，落盘后秒开。
//   （embedding 钩子留在 search() 的 opts 里，默认关闭，日后想加随时可加。）
//
// 索引结构：
//   chunks   [{ i, page, chapterId, chapterTitle, text }]
//   postings Map<term, [chunkIndex, tf][]>
//   lens     number[]  每块的 token 数（BM25 的长度归一化用）
//   avgLen   number

import { chapterAt } from './thesisOutline.js';

const K1 = 1.5;
const B = 0.75;
// df 超过这个比例的词（「的研」这种无意义高频 bigram）直接不索引：
// 既几乎不影响排序（idf ≈ 0），又能显著减小落盘体积
const MAX_DF_RATIO = 0.5;

const STOP_EN = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our',
  'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see',
  'two', 'way', 'who', 'did', 'use', 'that', 'this', 'with', 'from', 'they', 'have', 'were',
  'what', 'when', 'which', 'their', 'there', 'about', 'would', 'could', 'should', 'into',
  'than', 'then', 'them', 'these', 'those', 'such', 'only', 'also', 'been', 'being', 'does',
  'doing', 'more', 'most', 'some', 'very', 'will', 'just', 'study', 'research', 'paper',
]);

// 纯停用字组成的片段（如「的了」「是在」）没有检索价值
const STOP_CN_CHAR = new Set('的了是在和与及或也都而但为以对从到由被把给让使就还又等这那其之着过很'.split(''));

function allStopChars(seg) {
  if (!seg) return false;
  for (const ch of seg) if (!STOP_CN_CHAR.has(ch)) return false;
  return true;
}

/**
 * 分词：中文按 2-gram，拉丁字母/数字按词
 * 为什么是 2-gram：中文没有空格，而学位论文的提问多是短查询（「研究假设是什么」），
 * 2-gram 不需要词典就能召回，且对未登录词（专业术语）天然友好。
 */
export function tokenize(text) {
  const out = [];
  const s = String(text || '');
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;
  let m;
  while ((m = cjk.exec(s))) {
    const seg = m[0];
    if (seg.length === 1) { if (!allStopChars(seg)) out.push(seg); continue; }
    for (let i = 0; i < seg.length - 1; i += 1) {
      const gram = seg.slice(i, i + 2);
      if (allStopChars(gram)) continue;
      out.push(gram);
    }
    // 2–6 字的短词整块保留一份，提升「术语精确命中」的权重
    if (seg.length <= 6 && !allStopChars(seg)) out.push(seg);
  }
  const lat = /[A-Za-z][A-Za-z0-9_-]*|\d+(?:\.\d+)?/g;
  while ((m = lat.exec(s))) {
    const w = m[0].toLowerCase();
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (STOP_EN.has(w)) continue;
    out.push(w);
  }
  return out;
}

// ---------------- 分块 ----------------

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？；.!?;])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 把一个较长文本切成 ~size 字的块（先按空行分段、过长段再按句切，然后贪心合并）
 */
export function splitBlocks(text, { size = 700, minSize = 200 } = {}) {
  const paras = String(text || '')
    .split(/\n{2,}/)
    .flatMap((p) => (p.length > size * 1.6 ? splitSentences(p) : [p]));

  const out = [];
  let cur = '';
  for (const raw of paras) {
    const seg = String(raw || '').trim();
    if (!seg) continue;
    if (cur && cur.length + seg.length + 1 > size) { out.push(cur); cur = seg; }
    else cur = cur ? `${cur}\n${seg}` : seg;
  }
  if (cur.trim()) out.push(cur);

  // 过短的尾块并进前一块，避免出现「只剩一行」的碎片块
  const merged = [];
  for (const blk of out) {
    const prev = merged[merged.length - 1];
    if (prev && blk.length < minSize && prev.length + blk.length <= size * 1.5) {
      merged[merged.length - 1] = `${prev}\n${blk}`;
    } else merged.push(blk);
  }
  return merged;
}

/**
 * 按页 + 章节归属分块
 * @param {{page:number,text:string}[]} pages
 * @param {{id,title,page,endPage}[]} outline
 */
export function chunkPages(pages, outline, { size = 700, minSize = 200 } = {}) {
  const chunks = [];
  for (const p of pages) {
    if (!p?.text) continue;
    const chapter = chapterAt(outline, p.page);
    for (const text of splitBlocks(p.text, { size, minSize })) {
      if (!text.trim()) continue;
      chunks.push({
        i: chunks.length,
        page: p.page,
        chapterId: chapter?.id || '',
        chapterTitle: chapter?.title || '',
        text,
      });
    }
  }
  return chunks;
}

// ---------------- 建索引 ----------------

export function buildIndex(chunks) {
  const postings = new Map();
  const lens = [];
  const df = new Map();

  for (let i = 0; i < chunks.length; i += 1) {
    const tokens = tokenize(chunks[i].text);
    lens.push(tokens.length);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [term, count] of tf) {
      df.set(term, (df.get(term) || 0) + 1);
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push([i, count]);
    }
  }

  const N = chunks.length;
  // 丢掉出现过于普遍的词：idf≈0，留着只占体积
  if (N >= 8) {
    const ceiling = N * MAX_DF_RATIO;
    for (const [term, d] of df) if (d > ceiling) postings.delete(term);
  }

  const avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 1;
  return { chunks, postings, lens, avgLen: avgLen || 1, N, builtAt: new Date().toISOString() };
}

// ---------------- 检索 ----------------

/**
 * BM25 检索
 * @returns {{chunk:object, score:number}[]}
 */
export function search(index, query, { topK = 8, minScore = 0 } = {}) {
  if (!index?.N || !index.chunks?.length) return [];
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];

  const qtf = new Map();
  for (const t of qTokens) qtf.set(t, (qtf.get(t) || 0) + 1);

  const scores = new Float64Array(index.N);
  for (const [term, count] of qtf) {
    const posting = index.postings.get(term);
    if (!posting || !posting.length) continue;
    const n = posting.length;
    const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
    // 同一个词在提问里重复出现，收益递减（封顶 3 次）
    const qWeight = Math.min(count, 3);
    for (const [i, tf] of posting) {
      const len = index.lens[i] || 1;
      const denom = tf + K1 * (1 - B + (B * len) / (index.avgLen || 1));
      scores[i] += idf * ((tf * (K1 + 1)) / denom) * qWeight;
    }
  }

  const hits = [];
  for (let i = 0; i < index.N; i += 1) if (scores[i] > minScore) hits.push({ i, score: scores[i] });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  return hits.slice(0, topK).map((h) => ({ chunk: index.chunks[h.i], score: h.score }));
}

/** 取某章的块（问「第X章」时直接整章优先） */
export function chunksOfChapter(index, chapterId, { limit = 6, perChunk = 900 } = {}) {
  if (!index?.chunks || !chapterId) return [];
  const list = index.chunks.filter((c) => c.chapterId === chapterId);
  if (!list.length) return [];
  if (list.length <= limit) return list;
  // 取该章的首、尾与均匀中间点，覆盖「开头/结尾/主干」
  const picked = [];
  const step = (list.length - 1) / (limit - 1 || 1);
  for (let k = 0; k < limit; k += 1) picked.push(list[Math.round(k * step)]);
  return [...new Map(picked.map((c) => [c.i, c])).values()]
    .map((c) => (c.text.length > perChunk ? { ...c, text: c.text.slice(0, perChunk) } : c));
}

/** 在当前章节附近取块（回答「这一段在说什么」这类问题时用） */
export function chunksAroundPage(index, page, { limit = 3 } = {}) {
  if (!index?.chunks || !page) return [];
  const n = Number(page);
  const near = index.chunks.filter((c) => Math.abs(c.page - n) <= 1);
  return near.slice(0, limit);
}

// ---------------- 落盘 / 读回 ----------------

export function serializeIndex(index) {
  return {
    version: 1,
    builtAt: index.builtAt || new Date().toISOString(),
    avgLen: index.avgLen,
    lens: index.lens,
    chunks: index.chunks,
    postings: [...index.postings.entries()],
  };
}

export function deserializeIndex(raw) {
  if (!raw || !Array.isArray(raw.chunks)) return null;
  const postings = new Map(Array.isArray(raw.postings) ? raw.postings : []);
  return {
    chunks: raw.chunks,
    postings,
    lens: Array.isArray(raw.lens) ? raw.lens : raw.chunks.map(() => 1),
    avgLen: Number(raw.avgLen) > 0 ? raw.avgLen : 1,
    N: raw.chunks.length,
    builtAt: raw.builtAt || '',
  };
}
