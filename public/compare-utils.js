/**
 * 对照精读的配对 / 缓存工具（纯前端，无依赖）。
 *
 * 两条硬规则：
 *  1) 逐句配对只是**显示**粒度，请求永远按整段（或整组拼接后的段落）发，
 *     否则免费引擎会被上千次句级请求拖垮甚至限流；
 *  2) 译文缓存在本地 localStorage，再次打开同一篇不用重新请求。
 */
(function () {
  'use strict';

  const CACHE_KEY = 'sciterminal.cmpTransCache';
  const PAIR_KEY = 'sciterminal.cmpPairMode';
  const MAX_ENTRIES = 3000;

  let cache = null;
  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; }
    catch (_) { cache = {}; }
    return cache;
  }
  function persist() {
    const keys = Object.keys(cache || {});
    // 简单 LRU：超上限就丢掉最早写入的一批（对象键顺序即写入顺序）
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[k];
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) { /* ignore */ }
    } else {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) { /* ignore */ }
    }
  }

  function hash(text) {
    // FNV-1a，够短够稳，不需要异步 crypto
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36) + '-' + text.length.toString(36);
  }

  function cacheKey(text, target, provider, profileId) {
    return hash([String(text || '').trim(), target || 'zh', provider || '', profileId || ''].join('\u0001'));
  }
  function cacheGet(text, target, provider, profileId) {
    return load()[cacheKey(text, target, provider, profileId)] || '';
  }
  function cacheSet(text, target, provider, profileId, translation) {
    if (!translation) return;
    load()[cacheKey(text, target, provider, profileId)] = String(translation);
    persist();
  }

  let pairMode = 'para';
  try {
    const m = localStorage.getItem(PAIR_KEY);
    if (m === 'sentence') pairMode = m;
  } catch (_) { /* ignore */ }
  function getPairMode() { return pairMode; }
  function setPairMode(m) {
    pairMode = m === 'sentence' ? 'sentence' : 'para';
    try { localStorage.setItem(PAIR_KEY, pairMode); } catch (_) { /* ignore */ }
  }

  const SENT_END = /[.!?。！？；;]["'”’）)\]]?\s*$/;
  const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

  /**
   * 把被分栏 / 换页切开的相邻块拼成完整句子，返回每块的回分权重。
   * 英文断词连字符自动接合（con- + stantly → constantly）。
   */
  function joinParts(parts) {
    const list = (Array.isArray(parts) ? parts : [])
      .map((p) => ({ id: p.id, text: String(p?.text || '').trim() }))
      .filter((p) => p.text);
    if (!list.length) return { text: '', items: [], weights: [] };
    let joined = '';
    for (const p of list) {
      if (!joined) { joined = p.text; continue; }
      if (/[A-Za-z]-$/.test(joined) && /^[a-z]/.test(p.text)) joined = joined.slice(0, -1) + p.text;
      else if (CJK.test(joined.slice(-1)) || CJK.test(p.text[0]) || /^[,.!?;:，。！？；：）)\]】》」』]/.test(p.text)) joined += p.text;
      else joined += ' ' + p.text;
    }
    const chars = list.map((p) => p.text.replace(/\s+/g, ' ').length);
    const total = chars.reduce((a, b) => a + b, 0) || 1;
    const items = list.map((p, i) => ({ id: p.id, chars: chars[i], ratio: chars[i] / total }));
    return { text: joined, items, weights: items.map((x) => x.ratio) };
  }

  /** 相邻块是否属于同一句（栏底 / 页尾被截断）。 */
  function isSplitPair(a, b) {
    const ta = String(a?.text || '').trim();
    const tb = String(b?.text || '').trim();
    if (!ta || !tb) return false;
    if (SENT_END.test(ta) && !/[A-Za-z]-$/.test(ta)) return false;
    if (/^[A-Z0-9]/.test(tb) && !CJK.test(tb[0])) return false;
    const pa = Number(a?.page) || 0;
    const pb = Number(b?.page) || 0;
    return pb === pa || pb === pa + 1;
  }

  /** 在按阅读顺序排列的块里，找出所有被截断的连续组（每组 2~4 块）。 */
  function splitGroups(blocks) {
    const groups = [];
    let cur = [];
    const flush = () => {
      if (cur.length >= 2) groups.push(cur.map((b) => b.id));
      cur = [];
    };
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (!b?.translatable || b.kind === 'heading' || b.kind === 'title') { flush(); continue; }
      const prev = cur[cur.length - 1];
      if (prev && isSplitPair(prev, b) && cur.length < 4) cur.push(b);
      else { flush(); cur = [b]; }
    }
    flush();
    return groups;
  }

  /** 按权重把整段译文分回各块（中文按字、英文按词边界，不切破单词）。 */
  function splitByWeights(text, weights) {
    const w = (Array.isArray(weights) ? weights : []).map((x) => Math.max(0, Number(x) || 0));
    const src = String(text || '');
    if (!w.length) return [];
    if (w.length === 1) return [src];
    const sum = w.reduce((a, b) => a + b, 0);
    if (!sum) return w.map(() => '');
    const norm = w.map((x) => x / sum);
    const cjk = CJK.test(src);
    const tokens = src.match(cjk ? /[\u3000-\u9fff\uff00-\uffef]|[A-Za-z0-9]+|[^\s]/g : /\S+\s*|\s+/g) || [];
    if (!tokens.length) return w.map(() => '');
    const len = tokens.map((t) => t.length);
    const out = [];
    let at = 0;
    for (let i = 0; i < norm.length; i++) {
      if (i === norm.length - 1) { out.push(tokens.slice(at).join('').trim()); break; }
      if (norm[i] <= 0) { out.push(''); continue; }   // 零权重段不吞掉译文
      const restWeight = norm.slice(i).reduce((a, b) => a + b, 0) || 1;
      const restChars = len.slice(at).reduce((a, b) => a + b, 0);
      const target = restChars * (norm[i] / restWeight);
      let used = 0;
      let end = at;
      while (end < tokens.length && used < target) { used += len[end]; end++; }
      if (end < tokens.length) {
        for (let k = end - 1; k > at && end - k <= 6; k--) {
          if (/[.!?。！？；;]$/.test(tokens[k].trim())) { end = k + 1; break; }
        }
      }
      out.push(tokens.slice(at, Math.max(end, at + 1)).join('').trim());
      at = end;
      if (at >= tokens.length) { out.push(...w.slice(i + 1).map(() => '')); break; }
    }
    while (out.length < w.length) out.push('');
    return out;
  }

  function splitSentences(text) {
    const src = String(text || '').trim();
    if (!src) return [];
    const out = src.split(/(?<=[.!?。！？；;])\s+|(?<=[。！？])\s*/).filter((s) => s.trim());
    return out.length ? out.map((s) => s.trim()) : [src];
  }

  /** 逐句配对：原文句 ↔ 译文句。译文句数不等时按权重摊分，不额外发请求。 */
  function pairSentences(source, translation) {
    const src = splitSentences(source);
    const tr = splitSentences(translation);
    if (!src.length) return [];
    if (tr.length === src.length) return src.map((s, i) => ({ source: s, translation: tr[i] }));
    const weights = src.map((s) => s.length || 1);
    const spread = splitByWeights(tr.join(' '), weights);
    return src.map((s, i) => ({ source: s, translation: spread[i] || '' }));
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** 模型对「半截原文」的自我说明，例如「（原文不完整，但按要求翻译到此）」 */
  const META_NOTE = /[（(][^（）()]{0,40}(?:原文不完整|原文片段|原文内容不全|此处省略|以下省略|后略|翻译到此|未能完整|内容不完整)[^（）()]{0,40}[）)]/g;
  const TAIL_ELLIPSIS = /\s*(?:…+|\.{3,}|。{2,})\s*$/;

  /**
   * 显示前清洗译文（与服务端 engines.polishTranslation 同一口径，这里是兜底）。
   *
   * 为什么前端还要再做一次：PDF 段落常在页面底部被切断，模型拿到半句话时会补一个
   * 「……」或写一行「（原文不完整）」。服务端已经不再产生这种文本，但**历史译文**
   * 早就存进了对照数据与本地缓存，不清洗就会一直显示给用户。
   *
   * 原则：原文没有的省略号，译文也不该有；说明性文字一律去掉。
   */
  function cleanTranslation(source, translation) {
    let text = String(translation == null ? '' : translation);
    if (!text.trim()) return '';
    const src = String(source == null ? '' : source);
    text = text.replace(META_NOTE, '');
    if (!/(?:…+|\.{3,}|。{2,})\s*$/.test(src)) text = text.replace(TAIL_ELLIPSIS, '');
    if (!/^\s*(?:…+|\.{3,})/.test(src)) text = text.replace(/^\s*(?:…+|\.{3,})\s*/, '');
    return text.replace(/[ \t]{2,}/g, ' ').trim() || String(translation).trim();
  }

  /** 译文块内容：逐段 = 一整段；逐句 = 原文句在上、译文句在下，一一并列。 */
  function translationHtml(source, translation) {
    const tr = cleanTranslation(source, translation);
    if (!tr) return '';
    if (getPairMode() !== 'sentence') return `<div class="cmp-block-text">${esc(tr)}</div>`;
    const pairs = pairSentences(source, tr);
    return `<div class="cmp-block-text cmp-pairs">${pairs.map((p) => `<div class="cmp-pair"><div class="cmp-pair-src">${esc(p.source)}</div><div class="cmp-pair-tr">${esc(p.translation)}</div></div>`).join('')}</div>`;
  }

  /** 对照笔记：按当前配对粒度导出 Markdown（原文引用 + 译文）。 */
  function buildNote(blocks, mode, title) {
    const m = mode === 'sentence' ? 'sentence' : 'para';
    const out = [`# ${title || '对照精读笔记'}`, '', `> 配对方式：${m === 'sentence' ? '逐句' : '逐段'}`, ''];
    for (const b of Array.isArray(blocks) ? blocks : []) {
      const src = String(b.text || '').trim();
      const tr = String(b.translation || '').trim();
      if (!src && !tr) continue;
      out.push(`## 第 ${b.page || '?'} 页 · ${b.kind || '正文'}`, '');
      if (m === 'sentence') {
        for (const p of pairSentences(src, tr)) {
          out.push('> ' + p.source.replace(/\n/g, '\n> '), '', p.translation, '');
        }
      } else {
        out.push('> ' + src.replace(/\n/g, '\n> '), '', tr || '（未翻译）', '');
      }
    }
    return out.join('\n');
  }

  window.CompareUtils = {
    cacheGet, cacheSet, cacheKey, getPairMode, setPairMode,
    joinParts, isSplitPair, splitGroups, splitByWeights,
    splitSentences, pairSentences, translationHtml, buildNote, esc, cleanTranslation,
  };
})();
