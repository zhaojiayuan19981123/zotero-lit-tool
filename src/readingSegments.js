/**
 * 对照精读的「断句 / 回分」工具。
 *
 * 版面分析会把一句话在栏底或页尾切断（"…view the demonstration together," +
 * "or demonstrators might invite…"），翻译引擎若分别收到这两截，译文自然是两段
 * 前言不搭后语。正确做法是：先把被截断的片段拼成完整句子（连字符自动接合）
 * 一次送翻译，再按各片段的原文长度比例把译文分回原处。
 *
 * 这里只做纯文本处理，不依赖 DOM / 网络，方便单测覆盖。
 */

/** 把被分栏 / 换页截断的片段拼成完整句子，并返回每截的回分权重。 */
export function joinSplitSentence(parts) {
  const list = (Array.isArray(parts) ? parts : [])
    .map((p) => ({ text: String(p?.text ?? ''), page: p?.page ?? 0, col: p?.col ?? -1 }))
    .filter((p) => p.text.trim());
  if (!list.length) return { text: '', parts: [], weights: [] };

  let joined = '';
  for (const p of list) {
    if (!joined) { joined = p.text.trim(); continue; }
    const tail = joined.slice(-24);
    const head = p.text.trimStart();
    // 英文断词连字符：`con-` + `stantly` → `constantly`
    if (/[A-Za-z]-$/.test(tail) && /^[a-z]/.test(head)) {
      joined = joined.slice(0, -1) + head;
    } else if (/[\u3000-\u9fff\uff00-\uffef]$/.test(tail) || /^[\u3000-\u9fff\uff00-\uffef,.;:!?）)\]】》」』]/.test(head)) {
      // 中文或行首标点：直接接，不补空格
      joined += head;
    } else {
      joined += ' ' + head;
    }
  }

  // 权重按「接合前」各片段的字符数算，连字符少的那 1 个字符忽略不计
  const chars = list.map((p) => p.text.trim().replace(/\s+/g, ' ').length);
  const total = chars.reduce((a, b) => a + b, 0) || 1;
  const out = list.map((p, i) => ({
    page: p.page,
    col: p.col,
    chars: chars[i],
    ratio: Math.round((chars[i] / total) * 10000) / 10000,
  }));
  return { text: joined, parts: out, weights: out.map((p) => p.ratio) };
}

/** 把 token 序列按累计长度切成 n 段，切点尽量落在词边界 / 标点后。 */
function tokensOf(text) {
  const hasCjk = /[\u3000-\u9fff]/.test(text);
  if (hasCjk) {
    // 中文按字切，但把连续的 ASCII 单词当作一个 token，避免把英文术语劈开
    return String(text).match(/[\u3000-\u9fff\uff00-\uffef]|[A-Za-z0-9]+|[^\s]/g) || [];
  }
  return String(text).match(/\S+\s*|\s+/g) || [];
}

/**
 * 按权重把整段译文分回 n 处。
 * 中文按字符比例、英文按词边界切；切点优先落在句读后面，绝不切破一个单词。
 * 返回长度恒等于 weights.length 的数组，空权重段也返回空串而不是 undefined。
 */
export function splitTranslation(text, weights) {
  const w = (Array.isArray(weights) ? weights : []).map((x) => Math.max(0, Number(x) || 0));
  const src = String(text ?? '');
  if (!w.length) return [];
  if (w.length === 1) return [src];
  const sum = w.reduce((a, b) => a + b, 0);
  if (!sum) return w.map(() => '');
  const norm = w.map((x) => x / sum);
  const tokens = tokensOf(src);
  if (!tokens.length) return w.map(() => '');

  const lengths = tokens.map((t) => t.length);
  const out = [];
  let at = 0;
  for (let i = 0; i < norm.length; i++) {
    if (i === norm.length - 1) { out.push(tokens.slice(at).join('').trim()); break; }
    if (norm[i] <= 0) { out.push(''); continue; }   // 零权重段不吞掉译文

    // 当前段应分到「剩余译文 × 本段权重 / 剩余权重」个字符
    const restWeight = norm.slice(i).reduce((a, b) => a + b, 0) || 1;
    const restChars = lengths.slice(at).reduce((a, b) => a + b, 0);
    const target = restChars * (norm[i] / restWeight);
    let used = 0;
    let end = at;
    while (end < tokens.length && used < target) { used += lengths[end]; end++; }
    // 切点若落在句子中间，尽量退到最近的句读后
    if (end < tokens.length) {
      for (let k = end - 1; k > at && end - k <= 6; k--) {
        if (/[.!?。！？；;]$/.test(tokens[k].trim())) { end = k + 1; break; }
      }
    }
    out.push(tokens.slice(at, Math.max(end, at + (i < norm.length - 1 ? 1 : 0))).join('').trim());
    at = end;
    if (at >= tokens.length) { out.push(...w.slice(i + 1).map(() => '')); break; }
  }
  while (out.length < w.length) out.push('');
  return out;
}

/** 中英文混排的句子切分：用于「逐句配对」的显示，不用于发请求。 */
export function splitSentences(text) {
  const src = String(text ?? '').trim();
  if (!src) return [];
  const chunks = src.split(/(?<=[.!?。！？；;])\s+|(?<=[。！？])\s*/).filter((s) => s.trim());
  return chunks.length ? chunks.map((s) => s.trim()) : [src];
}

/**
 * 逐句配对：原文句与译文句按顺序一一对应。
 * 译文句数少于原文时，按字符比例把译文句分配到最近的原文句；多出来的原文句
 * 拿到空串，前端照常显示原文（不会因为免费引擎少翻一句就整段错位）。
 */
export function pairSentences(source, translation) {
  const src = splitSentences(source);
  const tr = splitSentences(translation);
  if (!src.length) return [];
  if (tr.length === src.length) return src.map((s, i) => ({ source: s, translation: tr[i] }));
  if (!tr.length) return src.map((s) => ({ source: s, translation: '' }));
  const weights = src.map((s) => s.length || 1);
  const spread = splitTranslation(tr.join(' '), weights);
  return src.map((s, i) => ({ source: s, translation: spread[i] || '' }));
}
