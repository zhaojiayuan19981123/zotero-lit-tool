// readingAi.js —— 用已配置的模型（多为本地部署）对重排结果做一次「版面精修」
//
// 为什么需要这一步：规则引擎能处理的只是**几何**证据（字号、位置、栏距、粗体），
// 而论文版面里有一类东西只有语义能判：哪一行是脚注、哪一段是章节标题、
// 被分页切开的两个块是不是同一句话。这些恰好是大模型很擅长、规则很难写好的判断。
//
// 设计原则：**只在原文结构上打补丁，不重新生成正文**。
// 模型只回答「哪些块的类别要改、哪些块要并进上一块」，正文一个字都不交给它写 ——
// 这样既不会改写原意，也不会因为模型胡说而丢字。补丁应用后写进缓存，
// 同一篇 PDF 只跑一次；下次打开直接就是精修后的结果。

import {
  thinkingPayload, postWithThinkingFallback,
} from './thinkingMode.js';
import * as catalog from './modelCatalog.js';

/** 一次请求送多少个块：本地模型 4k 上下文也能吃下，块再多就要拆批 */
const BATCH = 90;
/** 最多跑几批（约 1000 块）。超长文档到这里就停，剩下的保持规则结果 */
const MAX_BATCHES = 12;

const SYSTEM_PROMPT = [
  '你是学术论文的版面分析助手。用户会给你一组从 PDF 里抽取出来的文本块，按当前阅读顺序编号。',
  '你的任务是找出三类错误，只输出 JSON，不要任何解释：',
  '1) footnotes：其实是脚注 / 作者单位 / 通讯邮箱 / 基金信息的块编号；',
  '2) headings：其实是章节标题的块，给出层级（1 = 一级小节如 Introduction，2 = 二级如 3.1 Sample）；',
  '3) joins：相邻两块本该是同一自然段（被分页或分栏切断），用 [前一块编号, 后一块编号] 表示。',
  '判断依据是文字内容与语气的连贯性，不要凭编号顺序猜。',
  '输出格式示例：{"footnotes":[12,13],"headings":[[5,1]],"joins":[[20,21]]}',
  '没有发现就输出 {"footnotes":[],"headings":[],"joins":[]}。',
].join('\n');

/** 块 → 一行紧凑描述，尽量少 token：编号|类型|字号|首 90 字 */
function describeBlock(node) {
  const text = (node.lines || [])
    .map((l) => (l.runs || []).map((r) => r[2]).join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const kind = node.level > 0 ? `h${node.level}` : (node.kind || 'body');
  return `${node.id}|${kind}|${Math.round(node.size || 0)}|${text.slice(0, 90)}`;
}

/**
 * 调一次模型，返回 { footnotes:Set, headings:Map, joins:Array }。
 * 任何异常都往外抛，由调用方决定是否降级（精修失败不能让阅读模式不可用）。
 */
async function askOnce(profile, batch, signal) {
  const payload = {
    model: profile.model,
    temperature: 0,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: batch.map(describeBlock).join('\n') },
    ],
    ...thinkingPayload({ provider: profile.provider, model: profile.model }, 'off'),
  };
  const url = profile.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const { res } = await postWithThinkingFallback((body) => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  }), payload);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`模型接口返回 ${res.status}：${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = String(data?.choices?.[0]?.message?.content || '');
  const patch = parsePatch(content);
  if (!patch) throw new Error('模型返回的不是预期的 JSON');
  return patch;
}

/** 从模型输出里抠出 JSON（有些模型爱套 ```json 代码块或先寒暄一句） */
export function parsePatch(content) {
  const s = String(content || '').trim();
  if (!s) return null;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj = null;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const ids = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x)).filter(Boolean) : []);
  const footnotes = ids(obj.footnotes);
  const headings = Array.isArray(obj.headings)
    ? obj.headings
      .filter((h) => Array.isArray(h) && h.length >= 2)
      .map(([id, lvl]) => [String(id), Math.min(3, Math.max(1, Number(lvl) || 1))])
    : [];
  const joins = Array.isArray(obj.joins)
    ? obj.joins.filter((j) => Array.isArray(j) && j.length >= 2).map(([a, b]) => [String(a), String(b)])
    : [];
  return { footnotes, headings, joins };
}

/**
 * 应用补丁：只改 kind / level / 合并相邻块，正文内容不动。
 * @returns {{doc:object, summary:{footnotes:number,headings:number,joins:number}}}
 */
export function applyPatch(doc, patches) {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const drop = new Set();
  let nFoot = 0;
  let nHead = 0;
  let nJoin = 0;

  for (const p of patches) {
    for (const id of p.footnotes) {
      const b = byId.get(id);
      if (!b || b.t !== 'text') continue;
      if (b.kind === 'footnote') continue;
      // 标题 / 图注不可能是脚注，模型偶尔会把小字的图注列进来
      if (b.level > 0 || b.kind === 'caption') continue;
      b.kind = 'footnote';
      nFoot++;
    }
    for (const [id, lvl] of p.headings) {
      const b = byId.get(id);
      if (!b || b.t !== 'text' || b.kind === 'footnote') continue;
      // 已经在正文段里被并进去的块不再当标题
      if ((b.lines || []).length > 3) continue;
      if (b.level === lvl) continue;
      b.kind = 'heading';
      b.level = lvl;
      nHead++;
    }
    for (const [ia, ib] of p.joins) {
      const a = byId.get(ia);
      const b = byId.get(ib);
      if (!a || !b || a === b || drop.has(b.id) || drop.has(a.id)) continue;
      if (a.t !== 'text' || b.t !== 'text') continue;
      if (a.kind === 'footnote' || b.kind === 'footnote') continue;
      if (a.level > 0 || b.level > 0) continue;
      // 只允许「后一块紧跟在前一块之后」的合并，防止模型乱连
      const ia2 = blocks.indexOf(a);
      const ib2 = blocks.indexOf(b);
      if (ib2 !== ia2 + 1) continue;
      a.lines.push(...(b.lines || []));
      const [ax0, ay0, ax1, ay1] = a.rect;
      const [bx0, by0, bx1, by1] = b.rect;
      a.rect = [Math.min(ax0, bx0), Math.min(ay0, by0), Math.max(ax1, bx1), Math.max(ay1, by1)];
      drop.add(b.id);
      nJoin++;
    }
  }

  let out = blocks.filter((b) => !drop.has(b.id));
  // 新判出来的脚注还要挪到本页末尾 —— 只改 kind 不挪位置的话，它依旧插在正文中间
  out = moveFootnotesToPageEnd(out);
  out.forEach((b, i) => { b.id = `r${i + 1}`; });
  doc.blocks = out;
  if (doc.stats) {
    doc.stats.blocks = out.length;
    doc.stats.headings = out.filter((b) => b.t === 'text' && b.level > 0).length;
    doc.stats.footnotes = out.filter((b) => b.kind === 'footnote').length;
  }
  return { doc, summary: { footnotes: nFoot, headings: nHead, joins: nJoin } };
}

/** 把脚注块移到它所在那一页的最后（正文之后） */
function moveFootnotesToPageEnd(blocks) {
  const out = [];
  let pending = [];
  const flush = () => { if (pending.length) { out.push(...pending); pending = []; } };
  let curPage = null;
  for (const b of blocks) {
    if (b.kind === 'footnote') {
      pending.push(b);
      continue;
    }
    const page = b.page ?? null;
    if (curPage !== null && page !== curPage && pending.length) {
      // 换页了：上一页的脚注先落地，再排这一页的正文
      out.push(...pending);
      pending = [];
    }
    curPage = page;
    out.push(b);
  }
  flush();
  return out;
}

/**
 * 对一篇文档跑精修。分批送模型，逐批应用，任何一批失败只影响那一批。
 * @param {object} doc 阅读模式结构树
 * @param {object} settings 应用设置（用来解析当前激活的模型）
 * @param {{signal?:AbortSignal, onProgress?:Function}} [opts]
 */
export async function refineReadingDoc(doc, settings, opts = {}) {
  const profile = catalog.resolveActive(settings);
  if (!profile) {
    const e = new Error('还没有配置可用的模型，AI 精修需要先在设置里选一个模型');
    e.code = 'NO_MODEL';
    throw e;
  }
  const blocks = (doc.blocks || []).filter((b) => b.t === 'text' && (b.lines || []).length);
  if (blocks.length < 4) return { doc, summary: { footnotes: 0, headings: 0, joins: 0 }, model: profile.label || profile.model };

  const batches = [];
  for (let i = 0; i < blocks.length; i += BATCH) {
    batches.push(blocks.slice(i, i + BATCH));
    if (batches.length >= MAX_BATCHES) break;
  }

  const patches = [];
  let done = 0;
  for (const batch of batches) {
    try {
      patches.push(await askOnce(profile, batch, opts.signal));
    } catch (e) {
      // 单批失败不算灾难：其余批次照常，最后按已拿到的补丁应用
      if (e?.name === 'AbortError') throw e;
    }
    done += 1;
    opts.onProgress?.({ batch: done, total: batches.length });
  }
  if (!patches.length) {
    const e = new Error('模型没有返回可用的结果');
    e.code = 'AI_EMPTY';
    throw e;
  }
  const { doc: next, summary } = applyPatch(doc, patches);
  next.ai = {
    model: profile.model,
    label: profile.label || '',
    at: new Date().toISOString(),
    ...summary,
  };
  return { doc: next, summary, model: profile.label || profile.model };
}
