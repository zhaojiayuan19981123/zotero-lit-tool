// render.js —— 把译文写回 PDF
//
// 输出两种成品（对应 pdf2zh 的 mono / dual）：
//   · mono（单语译文版）：在原页面上「覆盖原文 + 写译文」，页面数、页面尺寸完全不变，
//     公式、图、表格、页眉页脚、参考文献位置都不动。这是最常用的成品。
//   · dual（双语对照版）：每页宽度翻倍，左半页用 pdf-lib 的 embedPdf 原样嵌入原始页面，
//     右半页是重排后的译文。适合精读时左右对照。
//
// 关键技术点：
//   1) 覆盖原文不能无脑涂白。论文里常有底纹表格、彩色提示框、深色标题条，
//      所以底色取自 analyze 阶段从图元里采样到的填充色；底色偏暗时译文字色自动转白。
//   2) 坐标系统一用 PDF 用户空间（原点左下、未旋转）。pdf.js 的文本坐标、图元变换矩阵
//      与 pdf-lib 的绘图指令都在同一套用户空间里，因此不需要任何偏移换算，
//      带 /Rotate 的页面在单语模式下天然正确。
//   3) 双语模式必须重新摆放嵌入页：embedPdf 拿到的是「未旋转的原始内容」，
//      带 /Rotate 的页面要按旋转角做一次刚体变换才能和阅读器里看到的方向一致。

import {
  PDFDocument, rgb, degrees,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fitText, sanitizeForPdf } from './layout.js';
import { toUint8Array } from './util.js';
import { buildStrokeTable } from './fontMetrics.js';
import { toRgb, drawLines as paintLines } from './paint.js';

const DEFAULT_OPTIONS = {
  coverOriginal: true,      // 单语模式是否覆盖原文
  fontSizeScale: 1,         // 统一次号缩放
  fontSize: 0,              // 绝对字号覆盖（pt）；0 = 跟随原文
  fontWeight: 'medium',     // 译文观感档位：regular | medium | bold
  respectBold: true,        // 原文加粗的块（标题/强调）用更重的档位
  minFontScale: 0.62,       // 最小可缩小到的比例
  lineHeightRatio: 1.26,    // 行距 / 字号
  widthFill: 0.985,         // 可用行宽相对列宽的比例
  drawDivider: true,        // 双语模式是否画中缝分隔线
};

/** 观感档位排序，用于取「原文更重时用更重的档」 */
const WEIGHT_RANK = { regular: 0, medium: 1, bold: 2 };
const rankToWeight = ['regular', 'medium', 'bold'];

/**
 * 该块应该用哪个观感档位
 */
function weightForBlock(block, opts) {
  const base = WEIGHT_RANK[opts.fontWeight] ?? WEIGHT_RANK.medium;
  const fromSource = opts.respectBold && block.bold ? WEIGHT_RANK.bold : 0;
  return rankToWeight[Math.max(base, fromSource)];
}

function abortError() {
  return Object.assign(new Error('任务已取消'), { name: 'AbortError' });
}

/**
 * 渲染译文 PDF。
 * @param {object} args
 * @param {Buffer|Uint8Array} args.sourceBytes 原始 PDF 字节
 * @param {Array} args.pages analyzePdf 返回的 pages（block.translation 已是译文）
 * @param {Buffer} args.fontBytes 中文字体（常规档，单一 sfnt）
 * @param {Buffer} [args.boldFontBytes] 中文字体加粗档。缺省时用常规档 + 描边合成加粗
 * @param {'mono'|'dual'} [args.mode='mono']
 * @param {object} [args.options]
 * @param {(p:object)=>void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{bytes: Buffer, report: object}>}
 */
export async function renderTranslatedPdf(args) {
  const {
    sourceBytes, pages, fontBytes, boldFontBytes, mode = 'mono', options = {}, onProgress, signal,
  } = args;
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const src = toUint8Array(sourceBytes);
  const report = { mode, pages: 0, translatedBlocks: 0, overflowBlocks: 0, boldBlocks: 0 };

  const doc = mode === 'dual'
    ? await PDFDocument.create()
    : await PDFDocument.load(src, { ignoreEncryption: true, updateMetadata: false });
  doc.registerFontkit(fontkit);
  const regularFont = await doc.embedFont(fontBytes, { subset: true });
  // 有独立加粗字体就嵌它，否则加粗全靠描边合成（仍然只画一次文字）
  const hasRealBold = !!boldFontBytes && boldFontBytes.length > 0
    && Buffer.compare(Buffer.from(fontBytes), Buffer.from(boldFontBytes)) !== 0;
  const boldFont = hasRealBold ? await doc.embedFont(boldFontBytes, { subset: true }) : regularFont;
  const strokes = {
    regular: buildStrokeTable(fontBytes),
    bold: buildStrokeTable(hasRealBold ? boldFontBytes : fontBytes),
  };
  report.hasRealBoldFont = hasRealBold;
  report.strokes = strokes;
  try { doc.setProducer('SciTerminal PDF Translate'); } catch (_) { /* 某些加密源不允许 */ }

  const ctx = {
    fonts: { regular: regularFont, bold: boldFont }, strokes, opts, report,
  };

  if (mode === 'dual') {
    await renderDual({ doc, src, pages, ctx, onProgress, signal });
  } else {
    renderMono({ doc, pages, ctx, onProgress, signal });
  }

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes: Buffer.from(bytes), report };
}

// ---------- 单语：原地替换 ----------

function renderMono({ doc, pages, ctx, onProgress, signal }) {
  const { report } = ctx;
  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) throw abortError();
    const pageInfo = pages[i];
    const plans = buildPlans(pageInfo, ctx, { noCover: false });
    if (plans.length) {
      const page = doc.getPage(pageInfo.index - 1);
      drawPlans(page, plans, 0, ctx);
    }
    report.pages++;
    report.translatedBlocks += plans.length;
    report.overflowBlocks += plans.filter((p) => p.overflow).length;
    report.boldBlocks += plans.filter((p) => p.weight === 'bold').length;
    onProgress?.({
      stage: 'render', mode: 'mono', page: pageInfo.index,
      percent: Math.round(((i + 1) / pages.length) * 100),
    });
  }
}

// ---------- 双语：左原文 / 右译文 ----------

async function renderDual({ doc, src, pages, ctx, onProgress, signal }) {
  const { opts, report } = ctx;
  const embedded = await doc.embedPdf(src, pages.map((p) => p.index - 1));
  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) throw abortError();
    const pageInfo = pages[i];
    const [dw, dh] = displaySize(pageInfo);
    const page = doc.addPage([dw * 2, dh]);

    placeEmbedded(page, embedded[i], pageInfo, 0, 0);
    page.drawRectangle({ x: dw, y: 0, width: dw, height: dh, color: rgb(1, 1, 1) });
    if (opts.drawDivider) {
      page.drawLine({
        start: { x: dw, y: 0 },
        end: { x: dw, y: dh },
        thickness: 0.6,
        color: rgb(0.75, 0.75, 0.75),
      });
    }

    const plans = buildPlans(pageInfo, ctx, { noCover: true });
    drawPlans(page, plans, dw, ctx);

    report.pages++;
    report.translatedBlocks += plans.length;
    report.overflowBlocks += plans.filter((p) => p.overflow).length;
    report.boldBlocks += plans.filter((p) => p.weight === 'bold').length;
    onProgress?.({
      stage: 'render', mode: 'dual', page: pageInfo.index,
      percent: Math.round(((i + 1) / pages.length) * 100),
    });
  }
}

function buildPlans(pageInfo, ctx, { noCover = false } = {}) {
  const plans = [];
  for (const block of pageInfo.blocks) {
    if (!block.translatable) continue;
    const text = block.translation;
    if (!text || !String(text).trim()) continue;
    const plan = planBlock(block, text, ctx, noCover);
    if (plan) plans.push(plan);
  }
  return plans;
}

/**
 * 规划一个块的绘制参数：覆盖矩形 + 译文的每一行坐标。
 * 断行必须用「真正会被嵌入的字体」来测量，所以这一步只能放在渲染阶段做。
 */
function planBlock(block, text, ctx, noCover) {
  const { fonts, strokes, opts } = ctx;
  const clean = sanitizeForPdf(text);
  if (!clean) return null;

  const colRight = Math.max(block.colX1 || block.x1, block.x0 + 8);
  const colLeft = Number.isFinite(block.colX0) ? Math.min(block.colX0, block.x0) : block.x0;
  // 左对齐块：从块左边界起排，换行宽度一直用到栏右边界。
  // 居中块（论文标题、Abstract、居中图注）：文本框要对称地架在「栏中心」上——
  // 若沿用块自身的 x0 当文本框左边界，短译文（如 Abstract→摘要）会被块的左边界
  // 拽到偏右的位置，明显偏离原文中心。
  const fullWidth = Math.max(8, (colRight - colLeft) * opts.widthFill);
  const centered = block.align === 'center';
  const boxLeft = centered ? (colLeft + colRight) / 2 - fullWidth / 2 : block.x0;
  const boxWidth = fullWidth;

  // 观感档位：原文加粗（标题/强调）时自动升到加粗档，其余按设置档位
  const weight = weightForBlock(block, opts);
  const fontKey = weight === 'bold' ? 'bold' : 'regular';
  const font = fonts[fontKey];
  const strokeEm = strokes[fontKey][weight] || 0;
  const measure = (s, size) => safeWidth(font, s, size);
  // 字号：显式指定优先，否则跟随原文字号（再乘缩放系数）
  const maxSize = opts.fontSize > 0 ? opts.fontSize : block.size * opts.fontSizeScale;

  // 三档尝试：原始文本框 → 向上借一点空白 → 上下都借（避免译文比原文长时被截断）
  const up = block.expandUp || 0;
  const down = block.expandDown || 0;
  const attempts = [
    { up: 0, down: 0 },
    { up: up * 0.75, down: 0 },
    { up, down: down * 0.6 },
  ];

  let fit = null;
  let used = attempts[0];
  for (const attempt of attempts) {
    fit = fitText({
      text: clean,
      measure,
      boxWidth,
      boxHeight: block.height + attempt.up + attempt.down,
      maxSize,
      minScale: opts.minFontScale,
      lineHeightRatio: opts.lineHeightRatio,
      singleLine: block.lineCount <= 1,
    });
    used = attempt;
    if (!fit.overflow) break;
  }

  const top = block.y1 + used.up;
  const ascent = Math.max(0.6, Math.min(1.15, block.lines[0]?.ascent ?? 0.85));
  const lines = fit.lines.map((t, i) => ({
    text: t,
    width: measure(t, fit.size),
    y: top - ascent * fit.size - i * fit.lineHeight,
  }));

  const plan = {
    id: block.id,
    kind: block.kind,
    size: fit.size,
    lineHeight: fit.lineHeight,
    lines,
    align: block.align,
    textColor: block.textColor,
    overflow: fit.overflow,
    weight,
    fontKey,
    strokeEm,
    box: {
      x0: boxLeft,
      x1: boxLeft + boxWidth,
      top,
      bottom: top - (block.height + used.up + used.down),
    },
  };

  if (!noCover && opts.coverOriginal) {
    // 覆盖矩形按「行盒」精确算：用 ascent/descent 得到的上下边界再各留一点余量，
    // 既能盖住反锯齿边缘，又不会吃到相邻行的字。
    const padY = Math.min(1.3, block.size * 0.12);
    plan.cover = {
      x: block.x0 - 0.6,
      y: block.y0 - padY,
      width: (block.x1 - block.x0) + 1.2,
      height: (block.y1 - block.y0) + padY * 2,
    };
    plan.bg = block.bg;
  }
  return plan;
}

function drawPlans(page, plans, offsetX, ctx) {
  const { fonts, opts } = ctx;
  for (const plan of plans) {
    if (plan.cover && opts.coverOriginal) {
      page.drawRectangle({
        x: plan.cover.x + offsetX,
        y: plan.cover.y,
        width: plan.cover.width,
        height: plan.cover.height,
        color: toRgb(plan.bg, { r: 1, g: 1, b: 1 }),
      });
    }
    const font = fonts[plan.fontKey];
    const lines = plan.lines.map((line) => {
      let x = plan.box.x0;
      if (plan.align === 'center') x = plan.box.x0 + Math.max(0, (plan.box.x1 - plan.box.x0 - line.width) / 2);
      else if (plan.align === 'right') x = plan.box.x1 - line.width;
      return { text: line.text, x: x + offsetX, y: line.y };
    });
    paintLines({ page, lines, font, size: plan.size, color: plan.textColor, strokeEm: plan.strokeEm });
  }
}

function safeWidth(font, text, size) {
  try {
    const w = font.widthOfTextAtSize(text, size);
    if (Number.isFinite(w) && w >= 0) return w;
  } catch (_) { /* 落到下面的估算 */ }
  let w = 0;
  for (const ch of text) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.5;
  return w;
}

/** 页面在阅读器里的显示尺寸（考虑 /Rotate） */
function displaySize(pageInfo) {
  const rot = ((pageInfo.rotate || 0) % 360 + 360) % 360;
  return rot === 90 || rot === 270
    ? [pageInfo.height, pageInfo.width]
    : [pageInfo.width, pageInfo.height];
}

/**
 * 把嵌入页摆到容器页上，正确处理 /Rotate。
 * 以 90° 为例：内容点 (u,v) 应出现在显示位 (v, mw-u)，
 * 即「先绕原点旋转 -90°、再平移 (0, mw)」。pdf-lib 的 drawPage 的 rotate 参数
 * 是在平移之后作用于对象坐标系，且正数为逆时针，所以此处传 270°。
 * （该结论由 test/pdf-translate.test.mjs 里对旋转页的坐标回归用例守护。）
 */
function placeEmbedded(page, embedded, pageInfo, originX, originY) {
  const rot = ((pageInfo.rotate || 0) % 360 + 360) % 360;
  const { width: mw, height: mh } = pageInfo;
  const base = { width: mw, height: mh };
  if (rot === 90) {
    page.drawPage(embedded, { x: originX, y: originY + mw, rotate: degrees(270), ...base });
  } else if (rot === 180) {
    page.drawPage(embedded, { x: originX + mw, y: originY + mh, rotate: degrees(180), ...base });
  } else if (rot === 270) {
    page.drawPage(embedded, { x: originX + mh, y: originY, rotate: degrees(90), ...base });
  } else {
    page.drawPage(embedded, { x: originX, y: originY, ...base });
  }
}
