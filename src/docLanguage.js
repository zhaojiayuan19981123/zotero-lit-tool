// docLanguage.js —— 判断一篇文献的正文主要是什么语言
//
// 为什么需要：整篇翻译是给「读不懂原文」准备的。中文（以及日韩）文献自己就能读，
// 整篇翻一遍纯属浪费 —— 要跑版面识别、要逐段调模型、要探测并嵌入 CJK 字体，
// 一篇几十页的论文能白烧几分钟。所以打开中文文献时不该自动进翻译流水线，
// 「整篇翻译」这个入口也不必递到用户面前。
//
// 判据用「汉字占比」，不用模型判断：
//   · 确定性、零成本、可单测；
//   · 不用联网、不依赖模型配置（用户可能根本没配大模型，而那时翻译本来也跑不了）。
//
// 与 pdfTranslate/layout.js 的 cjkRatio 的区别：那个是给断行用的，把日文假名、
// 韩文、全角标点都算作 CJK，分母是「所有非空白字符」。这里只关心「是不是中文正文」，
// 因此只数汉字，分母只算「汉字 + 拉丁字母」——否则英文论文里的公式、数字、标点
// 会把比例搅乱（实测一篇英文论文用 layout 的算法能到 0.15，用这里的算法是 0.00x）。
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u3007]/;
const LATIN_RE = /[A-Za-z\u00c0-\u02af\u0370-\u03ff\u0400-\u04ff]/;

/** 低于这个量认为"没抽到像样的正文"（扫描件、纯公式附件），不下结论 */
const MIN_LETTERS = 200;
/** 长文采样：均匀切 N 段，每段大小 = sampleSize / N */
const SAMPLE_WINDOWS = 20;

function countLetters(text) {
  let han = 0;
  let latin = 0;
  for (const ch of text) {
    if (HAN_RE.test(ch)) han += 1;
    else if (LATIN_RE.test(ch)) latin += 1;
  }
  return { han, latin };
}

/**
 * 判定一篇文献的正文语言。
 * @param {string} text PDF 抽出的正文
 * @param {{sampleSize?:number, windows?:number}} [opts]
 * @returns {{lang:'zh'|'other'|'unknown', ratio:number, globalRatio:number, han:number, latin:number, sampled:number, windows:number}}
 *   lang: 'zh' 中文为主 | 'other' 非中文 | 'unknown' 样本不足，无法判断（此时调用方按"不是中文"处理，
 *   宁可多给一次翻译入口，也不要因为判断不出来就把功能藏掉）
 */
export function detectDocLanguage(text, opts = {}) {
  const sampleSize = Number(opts.sampleSize) > 0 ? Number(opts.sampleSize) : 40000;
  const windowCount = Math.max(1, Number(opts.windows) > 0 ? Math.round(Number(opts.windows)) : SAMPLE_WINDOWS);
  const raw = String(text || '');
  if (!raw.trim()) {
    return { lang: 'unknown', ratio: 0, globalRatio: 0, han: 0, latin: 0, sampled: 0, windows: 0 };
  }

  // 长文：在全篇**均匀**取 N 个小窗口，而不是只取头/中/尾三段。
  // 头中尾各 1/3 的取法看似公平，实际对「英文封面 + 中文正文 + 英文参考文献」这种结构
  // 极不友好 —— 头尾各占 1/3，中文正文只剩 1/3，占比被系统性压低。均匀取样才不偏。
  const winSize = Math.floor(sampleSize / windowCount);
  const samples = [];
  if (raw.length <= sampleSize || winSize < 200) {
    samples.push(raw);
  } else {
    for (let i = 0; i < windowCount; i += 1) {
      const center = Math.floor((i + 0.5) * (raw.length / windowCount));
      const start = Math.max(0, Math.min(raw.length - winSize, center - Math.floor(winSize / 2)));
      samples.push(raw.slice(start, start + winSize));
    }
  }

  const totals = { han: 0, latin: 0 };
  const ratios = [];
  for (const part of samples) {
    const { han, latin } = countLetters(part);
    totals.han += han;
    totals.latin += latin;
    if (han + latin >= MIN_LETTERS / 4) ratios.push(han / (han + latin));
  }
  const letters = totals.han + totals.latin;
  const globalRatio = letters ? totals.han / letters : 0;
  if (letters < MIN_LETTERS) {
    return {
      lang: 'unknown', ratio: globalRatio, globalRatio,
      han: totals.han, latin: totals.latin, sampled: samples.reduce((a, s) => a + s.length, 0), windows: samples.length,
    };
  }

  // 用「各窗口占比的中位数」而不是全局占比：中文期刊论文常带大段英文摘要与英文参考
  // 文献，全局占比会被拉低；分窗口取中位数，只要**过半窗口**是中文就算中文，
  // 对这类"局部外文"天然免疫；反过来，英文论文里夹一两段中文引文也拉不动中位数。
  ratios.sort((a, b) => a - b);
  const useMedian = ratios.length >= 5;
  const median = useMedian ? ratios[Math.floor(ratios.length / 2)] : globalRatio;

  // 阈值 0.35。实测：中文期刊论文的正文窗口普遍在 0.85 以上（夹英文术语也够）；
  // 纯英文论文的窗口几乎都是 0。0.35 让两边都留足余量。
  return {
    lang: median >= 0.35 ? 'zh' : 'other',
    ratio: Number(median.toFixed(4)),
    globalRatio: Number(globalRatio.toFixed(4)),
    han: totals.han,
    latin: totals.latin,
    sampled: samples.reduce((a, s) => a + s.length, 0),
    windows: ratios.length,
  };
}

/** 便捷判断：只有明确判定为中文才返回 true（unknown 一律当"不是中文"，避免误伤功能） */
export function isChineseDoc(info) {
  return !!info && info.lang === 'zh';
}

/**
 * 「这篇要不要跳过整篇翻译」的判定 —— 全文翻译接口用它做最后一道拦截。
 * 只有「正文是中文」且「目标语言也是中文」时才跳过：中文文献翻成英文是合理需求，
 * 不能一起拦掉。
 * @param {object} record 文献记录（读 docLang）
 * @param {string} targetLang 目标语言（'zh' / 'zh-tw' / 'en' …）
 */
export function shouldSkipFullTranslate(record, targetLang) {
  const lang = String(targetLang || 'zh').toLowerCase();
  if (lang !== 'zh' && lang !== 'zh-tw') return false;
  return !!record && record.docLang === 'zh';
}
