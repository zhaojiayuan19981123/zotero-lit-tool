// paint.js —— 文字绘制原语：色值归一、合成加粗（描边）、按行绘制
//
// 抽出来是因为有两条完全不同的渲染路径都要用同一套「观感」逻辑：
//   · render.js —— 在原始页面上原位覆盖（保留版面）
//   · reflow.js —— 生成全新的单栏文档（doc2x 式重排）
// 两边的字形选择与描边补偿必须一致，否则同一篇论文在两种成品里粗细不同。
import {
  pushGraphicsState, popGraphicsState, setLineWidth, setTextRenderingMode, TextRenderingMode, rgb,
} from 'pdf-lib';

export function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function toRgb(c, fallback) {
  const v = c || fallback;
  return rgb(clamp01(v.r), clamp01(v.g), clamp01(v.b));
}

/**
 * 在回调期间把文字切换成「填充 + 描边」（PDF 的 Tr 2 渲染模式），用于合成加粗。
 *
 * 为什么用描边而不是「画两遍错开一点」：Tr 2 是 PDF 原生特性，文字流里仍然只有
 * 一份字——复制粘贴、全文检索、无障碍读取都不受影响。画两遍会把文本复制成两份，
 * 用户一复制就露馅。
 *
 * 注意：Tr 与线宽 w 属于图形状态，BT/ET 不会重置它们，所以 pushGraphicsState/
 * popGraphicsState 包住整段 drawText 即可生效；回调里若画矩形等非文字图元，
 * 它们有自己的填充/描边参数，不受影响。
 */
export function withTextStroke(page, strokeEm, size, fn) {
  if (!(strokeEm > 0) || !(size > 0)) { fn(); return; }
  page.pushOperators(
    pushGraphicsState(),
    setLineWidth(strokeEm * size),
    setTextRenderingMode(TextRenderingMode.FillAndOutline),
  );
  try {
    fn();
  } finally {
    page.pushOperators(popGraphicsState());
  }
}

/**
 * 按行绘制一段文字。
 * @param {object} args
 * @param {import('pdf-lib').PDFPage} args.page
 * @param {Array<{text:string,x:number,y:number}>} args.lines 已算好坐标的行
 * @param {import('pdf-lib').PDFFont} args.font
 * @param {number} args.size 字号
 * @param {object} [args.color] {r,g,b}
 * @param {number} [args.strokeEm] 合成加粗的描边宽度（em）
 */
export function drawLines({ page, lines, font, size, color, strokeEm = 0 }) {
  if (!lines?.length) return;
  const rgbColor = toRgb(color, { r: 0, g: 0, b: 0 });
  withTextStroke(page, strokeEm, size, () => {
    for (const line of lines) {
      if (!line.text) continue;
      page.drawText(line.text, { x: line.x, y: line.y, size, font, color: rgbColor });
    }
  });
}
