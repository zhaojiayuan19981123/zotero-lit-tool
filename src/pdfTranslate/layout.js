// layout.js —— 译文排版内核：中英混排断行、避头尾、文本框内自适应字号
//
// 为什么不能直接用 \n 切分或让 PDF 库自己换行：
//   PDF 里没有「自动换行」这件事，每一行的位置都得自己算。学术论文原文的行宽/行高
//   是固定的，译文（中文）与原文（英文）的字宽特征完全不同（中文近似等宽方块字，
//   英文单词不可断开），所以必须自己实现一套测量 + 断行 + 缩放算法，才能让译文
//   落在原文的文本框里而不压到图、公式、下一页。
//
// 三个关键点：
//   1) 断行单位：CJK 单字可任意断；拉丁词 + 尾随标点是一个整体不可断；数字/单位、
//      DOI、URL、引文编号等属于「不可断短语」。
//   2) 避头尾（禁则处理）：句读标点不能落在行首，开引号/开括号不能落在行尾。
//   3) 缩放策略：在 [minScale*maxSize, maxSize] 之间二分搜索最大可容纳字号；
//      若最小字号仍放不下，则压缩行距；再放不下就标记 overflow 交给上层决定外扩。

/** CJK 及相关全角标点区间（可逐字断行） */
const CJK_RE = /[\u1100-\u11ff\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u31f0-\u31ff\u3200-\u32ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe1f\ufe30-\ufe4f\uff00-\uffef]/;

/** 不能出现在行首的字符（避头）：句读、收尾括号、引号、百分号等 */
const NO_LINE_START = '\uff0c\u3002\u3001\uff1b\uff1a\uff1f\uff01\uff09\u3011\u300b\u300d\u300f\u201d\u2019\u3009'
  + '\uff05\u2030\u2103\u00b0\u00b7\u2026\u2014\uff5e'
  + '!?,.;:)]}>%';
/** 不能出现在行尾的字符（避尾）：开引号、开括号 */
const NO_LINE_END = '\uff08\u3010\u300a\u300c\u300e\u201c\u2018\u3008([{';
/** 不可断的短语模式：数字+单位、DOI、URL、邮箱、引文编号、LaTeX 命令 */
const ATOM_PATTERNS = [
  /^https?:\/\/\S+$/i,
  /^[\w.+-]+@[\w-]+\.[\w.]+$/,
  /^10\.\d{4,9}\/\S+$/,
  /^\[\d+(?:[-,–]\s*\d+)*\]$/,
  /^\(?[A-Z][a-z]+\s+et\s+al\.?\)?$/,
  /^\\[a-zA-Z]+/,
  /^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/,
];

export function isCjkChar(ch) {
  return CJK_RE.test(ch);
}

/** 字符串里 CJK 字符的占比，用于判断该用哪种断行策略 */
export function cjkRatio(text) {
  const chars = Array.from(String(text || '')).filter((c) => c.trim());
  if (!chars.length) return 0;
  let n = 0;
  for (const c of chars) if (isCjkChar(c)) n++;
  return n / chars.length;
}

/**
 * 把整段文本切成断行单位。
 * @returns {Array<{text: string, cjk: boolean, space: boolean}>}
 */
export function tokenize(text) {
  const tokens = [];
  let latin = '';
  let latinStart = 0;
  const pushLatin = (end) => {
    if (!latin) return;
    tokens.push({ text: latin, cjk: false, space: false, start: latinStart, end });
    latin = '';
  };
  const chars = Array.from(String(text ?? ''));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (isCjkChar(ch)) {
      pushLatin(i);
      tokens.push({ text: ch, cjk: true, space: false, start: i, end: i + 1 });
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u00a0' || ch === '\u3000') {
      pushLatin(i);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.space) prev.end = i + 1;
      else tokens.push({ text: ' ', cjk: false, space: true, start: i, end: i + 1 });
    } else {
      if (!latin) latinStart = i;
      latin += ch;
    }
  }
  pushLatin(chars.length);
  // 把「拉丁词 + 紧邻的尾随标点」合并成不可断短语，并把已知原子模式整体保护
  return mergeAtoms(tokens);
}

function mergeAtoms(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.space || tk.cjk) { out.push(tk); continue; }
    // 拉丁词：向后吸收紧邻的标点（不吸空白），形成不可断单元
    let text = tk.text;
    let end = tk.end;
    let j = i + 1;
    while (j < tokens.length && !tokens[j].cjk && !tokens[j].space && /^[^\w\s]$|^["')\]}.,;:!?%]+$/.test(tokens[j].text)) {
      text += tokens[j].text;
      end = tokens[j].end;
      j++;
    }
    const isAtom = ATOM_PATTERNS.some((re) => re.test(text));
    out.push({ text, cjk: false, space: false, start: tk.start, end, atom: isAtom });
    i = j - 1;
  }
  return out;
}

/** 逐字符硬切（URL / 无空格长串）。重排模式也要用它处理首行缩进后的第一行。 */
export function hardSplit(text, measureFn, maxWidth) {
  const chars = Array.from(text);
  const parts = [];
  let cur = '';
  for (const ch of chars) {
    const next = cur + ch;
    if (cur && measureFn(next) > maxWidth + 0.01) {
      parts.push(cur);
      cur = ch;
    } else {
      cur = next;
    }
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [''];
}

/**
 * 断行主函数。
 * @param {string} text 待排文本
 * @param {(s: string) => number} measureFn 单行宽度测量函数
 * @param {number} maxWidth 目标行宽（pt）
 * @returns {string[]} 行数组
 */
export function wrapText(text, measureFn, maxWidth) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (!(maxWidth > 0)) return [clean];
  const tokens = tokenize(clean);
  const lines = [];
  let cur = '';
  let curW = 0;
  let space = false;

  const breakLine = () => {
    if (cur !== '') lines.push(cur);
    cur = '';
    curW = 0;
    space = false;
  };

  for (const tk of tokens) {
    if (tk.space) { if (cur !== '') space = true; continue; }
    const piece = space ? ' ' + tk.text : tk.text;
    const pw = measureFn(piece);

    if (cur !== '' && curW + pw > maxWidth + 0.01) breakLine();

    if (cur === '' && pw > maxWidth + 0.01 && Array.from(tk.text).length > 1) {
      const parts = hardSplit(tk.text, measureFn, maxWidth);
      for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i]);
      cur = parts[parts.length - 1];
      curW = measureFn(cur);
      space = false;
      continue;
    }
    cur += piece;
    curW += pw;
    space = false;
  }
  breakLine();
  return applyLineBreakRules(lines);
}

/**
 * 避头尾：把落错位置的标点挪回/挪走。
 * 允许行宽轻微超限——这是中文排版的常规做法（禁止标点落行首的优先级高于严格等宽）。
 */
export function applyLineBreakRules(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (!out.length) { out.push(line); continue; }

    const first = Array.from(line)[0];
    if (first && NO_LINE_START.includes(first)) {
      out[out.length - 1] += first;
      const rest = Array.from(line).slice(1).join('');
      if (rest) out.push(rest);
      continue;
    }
    const prev = out[out.length - 1];
    const prevChars = Array.from(prev);
    const last = prevChars[prevChars.length - 1];
    if (last && NO_LINE_END.includes(last) && prevChars.length > 1) {
      out[out.length - 1] = prevChars.slice(0, -1).join('');
      out.push(last + line);
      continue;
    }
    out.push(line);
  }
  return out.filter((l) => l !== '');
}

/** 行宽测量（取最大行宽） */
export function maxLineWidth(lines, measureFn) {
  let m = 0;
  for (const l of lines) m = Math.max(m, measureFn(l));
  return m;
}

/**
 * 在固定文本框内为译文挑选字号。
 * @param {object} opts
 * @param {string} opts.text 译文
 * @param {(s: string, size: number) => number} opts.measure 测量函数（按字号）
 * @param {number} opts.boxWidth 可用行宽（pt）
 * @param {number} opts.boxHeight 可用高度（pt）
 * @param {number} opts.maxSize 期望字号（通常取原文正文字号）
 * @param {number} [opts.minScale=0.62] 允许缩小的最小比例
 * @param {number} [opts.lineHeightRatio=1.26] 行距 / 字号
 * @param {boolean} [opts.singleLine=false] 原文只有一行（标题类），尽量保持单行
 * @returns {{size:number, lines:string[], lineHeight:number, height:number, width:number, overflow:boolean}}
 */
export function fitText(opts) {
  const {
    text, measure, boxWidth, boxHeight, maxSize,
    minScale = 0.62, lineHeightRatio = 1.26, singleLine = false,
  } = opts;

  const minSize = Math.max(3.2, maxSize * minScale);
  const widthTolerance = singleLine ? Math.max(0.5, boxWidth * 0.04) : 0.6;

  const layoutAt = (size, ratio = lineHeightRatio) => {
    const m = (s) => measure(s, size);
    const lines = wrapText(text, m, boxWidth + widthTolerance);
    const width = maxLineWidth(lines, m);
    const lineHeight = size * ratio;
    const height = lines.length * lineHeight;
    const fits = height <= boxHeight + 0.6 && width <= boxWidth + widthTolerance + 0.6;
    return { size, lines, lineHeight, height, width, fits };
  };

  let best = null;
  let lo = minSize;
  let hi = maxSize;
  for (let step = 0; step < 14 && hi - lo > 0.04; step++) {
    const mid = (lo + hi) / 2;
    const cand = layoutAt(mid);
    if (cand.fits) { best = cand; lo = mid; } else { hi = mid; }
  }
  let result = best || layoutAt(minSize);

  // 最小字号仍放不下：先压行距（保持字号，观感比缩小字号更好）
  if (!result.fits) {
    for (let ratio = lineHeightRatio; ratio >= 1.02; ratio -= 0.04) {
      const cand = layoutAt(result.size, ratio);
      if (cand.fits) return { ...cand, overflow: false };
    }
  }
  return { ...result, overflow: !result.fits };
}

/** 文本清洗：去掉 PDF 里常见的软连字符、控制字符与零宽字符 */
export function sanitizeForPdf(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 合并被连字符断开的英文单词（原文换行处 "transla-\ntion" -> "translation"）。
 * 这是译文质量的关键细节：把断词还原后再送去翻译，模型才不会把半个词当成一个词。
 */
export function dehyphenate(text) {
  return String(text ?? '')
    .replace(/([A-Za-z]{2,})[-\u2010\u2011]\s*\n\s*([a-z]{2,})/g, '$1$2')
    .replace(/([A-Za-z]{2,})-\s+([a-z]{2,})/g, '$1$2');
}
