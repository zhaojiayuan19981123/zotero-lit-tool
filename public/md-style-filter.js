/**
 * md-style-filter.js —— Markdown 渲染后的**内联 style 白名单**
 *
 * 背景：AI 回答、笔记预览、解析结果都把 marked → KaTeX 的 HTML 交给 DOMPurify 清洗。
 * DOMPurify 本身不拦 style，所以这里用 uponSanitizeAttribute 钩子自己过一道：
 * 只放行「字体 / 字号 / 对齐 / 颜色」这类排版意图明确的声明，防止模型输出或粘贴内容
 * 用 position:fixed、background:url(...) 之类搞事情。
 *
 * ★ 但 KaTeX 的公式排版**全靠内联 style**：
 *   · `.vlist` 用 height / top / vertical-align 把上下标、分子分母摆到正确高度；
 *   · 分式的分数线是 border-bottom-width 画出来的；
 *   · 根号、\rule 之类还会用到 padding-left / min-width / width。
 *   这些声明一旦被白名单当垃圾清掉，公式不会报错，只会**叠成一团**：
 *   上下标糊在基线上、分式塌成一行、行内公式压到相邻行 —— 线上表现就是
 *   「AI 回答里的公式乱成一坨」。所以公式子树（.katex / .katex-display 内部）
 *   额外放行一组**排版专用属性**，且值只认长度（em/px/%/纯数字）与 position: relative，
 *   url()、expression()、position: fixed 之类依旧过不了闸。
 *
 * 与 app.js 分离的原因：全是纯函数、不碰 DOM，便于 test/md-style-filter.test.mjs
 * 直接拿**真实 KaTeX 输出**做回归（约定见 public/paper-note-utils.js）。
 */
(() => {
  'use strict';

  // 通用白名单：写法刻意收紧到「一眼能看出意图」的程度
  const BASE_DECL = /^(?:font-family\s*:\s*[\w\s,"'-]+|font-size\s*:\s*\d{1,2}(?:\.\d+)?(?:px|pt|em|rem|%)|text-align\s*:\s*(?:left|center|right|justify)|background-color\s*:\s*(?:#[0-9a-f]{3,8}|[a-z]+)|color\s*:\s*(?:#[0-9a-f]{3,8}|[a-z]+))$/i;

  // 公式排版专用属性（KaTeX 0.16 实际用到的全集，多一个都不放）
  const MATH_PROP = /^(?:height|width|min-width|max-width|top|bottom|left|right|margin-left|margin-right|margin-top|margin-bottom|padding-left|padding-right|vertical-align|border-top-width|border-bottom-width|border-left-width|border-right-width)$/;
  // 值只允许长度/数字：0.55em、-3.2634em、1.02em、12px、50%
  const MATH_LEN = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|px|pt|pc|cm|mm|in|%)?$/i;

  /** 是否属于「公式排版」可放行的声明（position 只认 relative） */
  function isMathLayoutDecl(part) {
    if (/^position\s*:\s*relative$/i.test(part)) return true;
    const m = /^([a-z-]+)\s*:\s*(.+)$/i.exec(part);
    return !!m && MATH_PROP.test(m[1].toLowerCase()) && MATH_LEN.test(m[2].trim());
  }

  /**
   * 过滤一条 style 属性值。
   * @param {string} value   形如 "height:1.3383em;vertical-align:-0.2935em;"
   * @param {boolean} inMath 该节点是否位于 .katex / .katex-display 子树内
   * @returns {string} 通过白名单的声明（分号 + 空格连接），可能为空串
   */
  function filterStyle(value, inMath) {
    const parts = String(value ?? '').split(';').map((part) => part.trim()).filter(Boolean);
    const kept = parts.filter((part) => BASE_DECL.test(part) || (inMath && isMathLayoutDecl(part)));
    return kept.join('; ');
  }

  window.MdStyleFilter = { filterStyle };
})();
