/* lib-search.js —— 文献搜索的匹配与打分（纯逻辑，无 DOM 依赖，便于单测）
 *
 * 背景：原来侧边栏那个搜索框只做「把几个列拼成一个字符串再 includes」——
 *   ① 只搜得到表格里**显示**的字段，摘要、我的思考、研究空白这些搜不到；
 *   ② 是死板的子串匹配，打错一个字母（transfromer）就一条都搜不出来；
 *   ③ 结果顺序还跟着"默认排序"走，命中得最狠的那篇可能排在第 20 行。
 * 这里把它重写为「全字段 + 模糊 + 相关性」三件事，逻辑集中在纯函数里，单测直接覆盖。
 *
 * 调用方（public/app.js）只负责取输入框的值、传进来、拿回排好序的数组。
 *
 *   LibSearch.tokens(q)                 关键词切分（空格分词，全部小写）
 *   LibSearch.fields(item)              记录 → [[字段名, 小写文本], …]（覆盖全部字段）
 *   LibSearch.hit(text, token)          命中强度 0~2
 *   LibSearch.score(item, tokens)       相关性得分，0 表示不匹配
 *   LibSearch.rank(list, q, cmp)        过滤 + 按相关性排序（cmp 作为同分次序）
 *   LibSearch.highlightRanges(text, ts) 命中区间（合并后），供 <mark> 高亮
 */

(() => {
  'use strict';

  /* 「所有字段」不做白名单：直接遍历记录上的每个字符串/数字属性，
   * 实证/模型/算法三类文库的专属字段、我的思考、研究空白、数据集……全都自动在范围内，
   * 以后再加字段也不用回来改。只排除下面这些"不可能是关键词"的值。 */
  const SKIP_KEYS = Object.freeze([
    'id', 'filePath', 'pdfPath', 'coverPath', 'thumbPath',
    'collectionId', 'journalRankDetail',
  ]);
  const SKIP = new Set(SKIP_KEYS);

  /* 字段权重：标题/关键词/作者这类"一眼定位"的字段给高权重；
   * 摘要、背景这类长文本给低权重 —— 否则一篇长文随便出现一个词就顶到第一行。
   * （和以前"只按列顺序排"相比，这里才是"相关性"的真正含义） */
  const WEIGHTS = Object.freeze({
    title: 12, keywords: 9, authors: 8, journal: 6, doi: 5, year: 3,
    researchQuestion: 5, scienceQuestion: 5, coreFindings: 5, mechanism: 4,
    researchDesign: 4, researchGap: 4, experimentalDesign: 4, dataset: 4, researchField: 4,
    innovation: 3, reviewUse: 3, criticalThinking: 3, ablationDesign: 3, metrics: 3,
    summary: 2.5, model: 2.5, method: 2.5, results: 2, background: 1.5, abstract: 1.5,
    paramDiscussion: 2, readingProgress: 0.5, status: 0,
  });
  const DEFAULT_WEIGHT = 1;

  /** 关键词切分：空格分词、统一小写（中英文混排都能用） */
  function tokens(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return q.split(/\s+/).filter(Boolean);
  }

  /** 记录 → 可搜索字段列表；数组字段（如标签）按空格拼接，对象字段跳过 */
  function fields(item) {
    const out = [];
    if (!item || typeof item !== 'object') return out;
    for (const key of Object.keys(item)) {
      if (SKIP.has(key)) continue;
      const v = item[key];
      if (typeof v === 'string') { if (v) out.push([key, v.toLowerCase()]); }
      else if (typeof v === 'number') out.push([key, String(v)]);
      else if (Array.isArray(v)) {
        const s = v.filter((x) => typeof x === 'string' || typeof x === 'number').join(' ');
        if (s) out.push([key, s.toLowerCase()]);
      }
    }
    return out;
  }

  /** 词边界：命中紧跟在分隔符后面，比命中在词中间更相关（"learning" vs "machine learning"） */
  const BOUNDARY = /[\s\-_/（(,，.。:：;；、"'“”‘’\[\]【】]/;

  /**
   * 有界编辑距离（只算「替换 / 增删」两类）。
   * 两个词长度差超过 maxDist 时直接判定超限，省掉绝大部分计算。
   */
  function withinEdit(a, b, maxDist) {
    if (Math.abs(a.length - b.length) > maxDist) return false;
    const prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1) prev[j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > maxDist) return false;   // 整行都超限，后面不可能再降回来
      for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
    }
    return prev[b.length] <= maxDist;
  }

  /**
   * 拼写容错：在文本里找有没有「和关键词只差一两个字符」的片段。
   * 以关键词首字符为锚点逐位试，长度在 ±maxDist 内滑动 —— 这样
   * transfromer（f/r 换位）、tranformer（漏字）、transfomer 都能捞到。
   * 只对 4 字符以上的词开放（否则 3 个字符也能"差一个"，等于没过滤）；
   * 距离上限按词长放宽：4~7 字符容 1 处，8 字符以上容 2 处。
   */
  function fuzzyIn(text, token) {
    const n = token.length;
    if (n < 4) return 0;
    const maxDist = n >= 8 ? 2 : 1;
    const first = token[0];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== first) continue;
      for (let len = n - maxDist; len <= n + maxDist; len += 1) {
        if (i + len > text.length) break;
        if (withinEdit(text.slice(i, i + len), token, maxDist)) return 0.3;
      }
    }
    return 0;
  }

  /**
   * 命中强度：
   *   2    字段整体等于关键词（搜 "Transformer" 命中标题就叫 Transformer 的那篇）
   *   1.6  前缀命中
   *   1.35 词首命中
   *   1    词中片段命中
   *   0.3  拼写容错命中（换位 / 漏字 / 错字，见 fuzzyIn）
   *   0    不命中
   */
  function hit(text, token) {
    if (!text || !token) return 0;
    const at = text.indexOf(token);
    if (at >= 0) {
      if (text.length === token.length) return 2;
      if (at === 0) return 1.6;
      return BOUNDARY.test(text[at - 1] || '') ? 1.35 : 1;
    }
    return fuzzyIn(text, token);
  }

  /**
   * 相关性得分。多个关键词时要求**每个词都命中**（AND）：
   * 搜「注意力 机制」时，只含「机制」的文献不该占满整页。
   * 整句（去空格）在标题里完整出现时额外加分 —— 那基本就是用户要找的那篇。
   */
  function score(item, tokenList) {
    if (!tokenList || !tokenList.length) return 0;
    const list = fields(item);
    let total = 0;
    for (const token of tokenList) {
      let best = 0;
      for (let i = 0; i < list.length; i += 1) {
        // 对象里的键名固定来自本地数据，这里只做查表，不做字符串拼接
        const w = WEIGHTS[list[i][0]] === undefined ? DEFAULT_WEIGHT : WEIGHTS[list[i][0]];
        if (w <= 0) continue;
        const s = hit(list[i][1], token) * w;
        if (s > best) best = s;
      }
      if (best <= 0) return 0;
      total += best;
    }
    const phrase = tokenList.length > 1 ? tokenList.join('') : '';
    if (phrase.length >= 3) {
      if (String(item.title || '').toLowerCase().includes(phrase)) total += 12;
      else if (String(item.keywords || '').toLowerCase().includes(phrase)) total += 6;
    }
    return total;
  }

  /**
   * 过滤 + 排序。有搜索词时**以相关性为主序**，`cmp` 只在同分时决定次序
   * （否则用户看到的顺序还是"默认排序"，叫相关性排序就名不副实了）。
   * cmp 省略时同分保持原顺序（sort 在现代 V8 上是稳定排序）。
   */
  function rank(list, query, cmp) {
    const tokenList = tokens(query);
    const source = Array.isArray(list) ? list : [];
    if (!tokenList.length) {
      const copy = source.slice();
      if (typeof cmp === 'function') copy.sort(cmp);
      return copy;
    }
    const scored = [];
    for (const item of source) {
      const s = score(item, tokenList);
      if (s > 0) scored.push({ item, s });
    }
    scored.sort((a, b) => (b.s - a.s) || (typeof cmp === 'function' ? cmp(a.item, b.item) : 0));
    return scored.map((x) => x.item);
  }

  /**
   * 命中区间（合并重叠/相邻），供界面把关键词包成 <mark>。
   * 只标**子串**命中 —— 拼写容错那种"差不多但不一样"的片段标出来反而像乱码。
   */
  function highlightRanges(text, tokenList, limit = 40) {
    const raw = String(text || '');
    if (!raw || !tokenList || !tokenList.length) return [];
    const lower = raw.toLowerCase();
    const spans = [];
    for (const t of tokenList) {
      if (!t) continue;
      let from = 0;
      while (spans.length < limit) {
        const at = lower.indexOf(t, from);
        if (at < 0) break;
        spans.push([at, at + t.length]);
        from = at + t.length;
      }
    }
    if (!spans.length) return [];
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    return merged;
  }

  /**
   * 生成高亮 HTML。escape 由调用方注入（app.js 的 esc），
   * 这样本文件不依赖 DOM、也不用复制一份转义规则。
   */
  function highlight(text, tokenList, escape) {
    const raw = String(text === undefined || text === null ? '' : text);
    const esc = typeof escape === 'function' ? escape : (s) => s;
    const ranges = highlightRanges(raw, tokenList);
    if (!ranges.length) return esc(raw);
    let out = '';
    let cursor = 0;
    for (const [s, e] of ranges) {
      out += esc(raw.slice(cursor, s)) + '<mark class="kw">' + esc(raw.slice(s, e)) + '</mark>';
      cursor = e;
    }
    return out + esc(raw.slice(cursor));
  }

  const api = { SKIP_KEYS, WEIGHTS, DEFAULT_WEIGHT, tokens, fields, hit, score, rank, highlightRanges, highlight };
  if (typeof window !== 'undefined') window.LibSearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
