(() => {
  'use strict';

  function normalizeRotation(degrees) {
    const numeric = Number(degrees) || 0;
    return ((numeric % 360) + 360) % 360;
  }

  function rotationSwapsDimensions(degrees) {
    const normalized = normalizeRotation(degrees);
    return normalized === 90 || normalized === 270;
  }

  function getDisplaySize(size, extraRotation = 0) {
    const width = Number(size?.w) || 0;
    const height = Number(size?.h) || 0;
    return rotationSwapsDimensions(extraRotation) ? { w: height, h: width } : { w: width, h: height };
  }

  function toDisplayRect(rect, size, extraRotation = 0) {
    const [x1, y1, x2, y2] = rect;
    const width = Number(size?.w) || 0;
    const height = Number(size?.h) || 0;
    switch (normalizeRotation(extraRotation)) {
      case 90: return { x1: height - y2, y1: x1, x2: height - y1, y2: x2 };
      case 180: return { x1: width - x2, y1: height - y2, x2: width - x1, y2: height - y1 };
      case 270: return { x1: y1, y1: width - x2, x2: y2, y2: width - x1 };
      default: return { x1, y1, x2, y2 };
    }
  }

  function toCanonicalRect(rect, size, extraRotation = 0) {
    const { x1, y1, x2, y2 } = rect;
    const width = Number(size?.w) || 0;
    const height = Number(size?.h) || 0;
    switch (normalizeRotation(extraRotation)) {
      case 90: return { x1: y1, y1: height - x2, x2: y2, y2: height - x1 };
      case 180: return { x1: width - x2, y1: height - y2, x2: width - x1, y2: height - y1 };
      case 270: return { x1: width - y2, y1: x1, x2: width - y1, y2: x2 };
      default: return { x1, y1, x2, y2 };
    }
  }

  function joinSelectionText(previous, next) {
    const left = String(previous || '').replace(/\s+/g, ' ').trim();
    const right = String(next || '').replace(/\s+/g, ' ').trim();
    if (!left) return right;
    if (!right) return left;
    // English fragments need a separator even when the earlier fragment ends in punctuation.
    // A trailing hyphen is deliberately kept for PDF line-break hyphenation.
    const bothContainLatinOrDigits = /[A-Za-z0-9]/.test(left) && /[A-Za-z0-9]/.test(right);
    return bothContainLatinOrDigits && !/[-‐‑]$/.test(left) ? `${left} ${right}` : `${left}${right}`;
  }

  function selectionKey(selection) {
    if (!selection) return '';
    const rects = (selection.rects || []).map((rect) => [rect.x1, rect.y1, rect.x2, rect.y2]
      .map((value) => Number(value || 0).toFixed(2)).join(',')).join(';');
    return `${selection.pageNum || ''}|${String(selection.text || '').trim()}|${rects}`;
  }

  function multiplyTransforms(left, right) {
    return [
      left[0] * right[0] + left[2] * right[1],
      left[1] * right[0] + left[3] * right[1],
      left[0] * right[2] + left[2] * right[3],
      left[1] * right[2] + left[3] * right[3],
      left[0] * right[4] + left[2] * right[5] + left[4],
      left[1] * right[4] + left[3] * right[5] + left[5],
    ];
  }

  // ==================== 论文正文的分段检索 ====================
  //
  // AI 对话要结合论文正文，但对话接口是无状态的：每轮都得重发全部 messages。
  // 若把整篇全文挂在 system 上，聊 N 轮就等于发 N 遍全文，token 随轮次线性放大。
  // 这里的做法是「本地切段 + 按提问检索」，每轮只送相关片段（全局性问题走压缩全文兜底）。
  // 全部为纯函数，便于单测覆盖。

  /**
   * Markdown 全文 → 检索单元。
   * 标题 / 列表项独占一段（它们是天然的语义边界），正文合并到 minChars 以上再断开，
   * 避免碎片过多导致打分被噪声主导。
   * @param {string} text Markdown 全文
   * @param {number} [minChars=240] 正文段落的最小合并长度
   * @returns {string[]}
   */
  function splitContextSegments(text, minChars = 240) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
    const source = String(text || '');
    if (!source) return out;
    for (const chunk of source.split(/\n{2,}/)) {
      const t = chunk.trim();
      if (!t) continue;
      if (/^#{1,6}\s/.test(t) || /^[-*]\s/.test(t)) { flush(); out.push(t); continue; }
      buf = buf ? buf + '\n' + t : t;
      if (buf.length >= minChars) flush();
    }
    flush();
    return out;
  }

  /**
   * 提问 → 检索词。
   * 英文/数字按单词切；中文按 2-gram 滑窗切（不引入分词依赖，中英混排也稳定）。
   * @param {string} query
   * @returns {string[]}
   */
  function contextQueryTokens(query) {
    const s = String(query || '');
    const toks = new Set();
    for (const w of s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []) toks.add(w);
    for (const chunk of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      for (let i = 0; i + 2 <= chunk.length; i++) toks.add(chunk.slice(i, i + 2));
    }
    return [...toks];
  }

  /**
   * 按相关性挑出片段。
   * 打分 = 词命中次数之和（≥4 字符的词权重翻倍）× 标题加权 ÷ √段落长度。
   * 除以长度是为了避免「一个大段落因为长而命中多」霸榜。
   *
   * @param {string[]} segments splitContextSegments 的结果
   * @param {string} query 用户提问
   * @param {{maxChars?:number, minPicked?:number, maxPicked?:number}} [opts]
   * @returns {{text:string, indexes:number[], score:number}} 命中不足时 text 为空串
   */
  function pickContextSegments(segments, query, opts = {}) {
    const segs = Array.isArray(segments) ? segments : [];
    const maxChars = Number(opts.maxChars) || 9000;
    const minPicked = Number(opts.minPicked) || 3;
    const maxPicked = Number(opts.maxPicked) || 12;
    const empty = { text: '', indexes: [], score: 0 };
    if (!segs.length) return empty;
    const toks = contextQueryTokens(query);
    if (!toks.length) return empty;

    const scored = [];
    for (let i = 0; i < segs.length; i++) {
      const text = String(segs[i] || '');
      if (!text) continue;
      const low = text.toLowerCase();
      let score = 0;
      for (const t of toks) {
        let at = low.indexOf(t);
        let hits = 0;
        while (at >= 0 && hits < 6) { hits++; at = low.indexOf(t, at + t.length); }
        if (hits) score += hits * (t.length >= 4 ? 2 : 1);
      }
      if (score <= 0) continue;
      if (/^#{1,6}\s/.test(text)) score *= 1.6;
      scored.push({ i, text, raw: score, score: score / Math.sqrt(Math.max(80, text.length)) });
    }
    if (!scored.length) return empty;
    scored.sort((a, b) => b.score - a.score);

    const picked = [];
    let chars = 0;
    let total = 0;
    for (const x of scored) {
      if (picked.length >= maxPicked) break;
      if (picked.length >= minPicked && chars >= maxChars) break;
      if (chars + x.text.length > maxChars && picked.length >= minPicked) break;
      picked.push(x);
      chars += x.text.length;
      total += x.raw;
    }
    // 命中太少说明这个问题与正文关联弱，交给调用方走「压缩全文」兜底
    if (picked.length < minPicked) return empty;
    picked.sort((a, b) => a.i - b.i);   // 还原原文顺序，模型更容易理解
    return { text: picked.map((x) => x.text).join('\n\n'), indexes: picked.map((x) => x.i), score: total };
  }

  /**
   * 压缩版全文：保留开头 headRatio 与结尾，中间省略。
   * 用于「总结全文」这类必须看整体的提问。
   * @param {string} text
   * @param {number} [maxChars=16000]
   * @param {number} [headRatio=0.72]
   */
  function condenseContextText(text, maxChars = 16000, headRatio = 0.72) {
    const s = String(text || '');
    if (!s) return '';
    if (s.length <= maxChars) return s;
    const head = Math.floor(maxChars * headRatio);
    return s.slice(0, head) + '\n\n……（中间内容略）……\n\n' + s.slice(-(maxChars - head));
  }

  /** 是否是「必须看整篇」的全局性问题 */
  function needsWholePaper(query) {
    const RE = /总结|概括|概述|综述|全文|整体|全局|主要(内容|观点|结论|贡献)|讲了什么|说了什么|介绍一下|梳理|summary|overview|whole|entire|main\s+(point|idea|contribution)/i;
    return RE.test(String(query || ''));
  }

  window.PdfReaderUtils = Object.freeze({
    normalizeRotation,
    rotationSwapsDimensions,
    getDisplaySize,
    toDisplayRect,
    toCanonicalRect,
    joinSelectionText,
    selectionKey,
    multiplyTransforms,
    splitContextSegments,
    contextQueryTokens,
    pickContextSegments,
    condenseContextText,
    needsWholePaper,
  });
})();
