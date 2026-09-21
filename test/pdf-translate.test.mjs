// pdf-translate.test.mjs —— 全文翻译（PDF）的核心回归用例
//
// 这些用例守护的是「改一个地方，另一处悄悄坏掉」的几类问题：
//   1) 译文观感：可变字体默认档极细 → 必须靠描边补足；静态字体够粗 → 不能多补
//   2) 输出模式：both / all 这类别名的展开规则（前端下拉、作业编排、成品命名都靠它）
//   3) 重排：阅读顺序（双栏不能交错）、首行缩进、页眉页脚必须丢掉
//   4) 并发池：顺畅要提速、限流要立刻降速（「大模型翻译慢」的解法是否真的生效）
//   5) 前端静态一致：JS 里 ftEl('xxx') 引用的每个 id 必须真的在 index.html 里，
//      否则面板会静默失灵（历史上就踩过一次：事件没绑定，点了没反应）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveModes, MODES, OUTPUT_META, parsePageRange } from '../src/pdfTranslate/index.js';
import { looksLikeTable } from '../src/pdfTranslate/analyze.js';
import { planStroke, INK_TARGET } from '../src/pdfTranslate/fontMetrics.js';
import { isTtc, extractTtcFont } from '../src/pdfTranslate/fonts.js';
import { runAdaptivePool, isThrottleError } from '../src/pdfTranslate/engines.js';
import { readingOrder, wrapFlow, buildElements, renderReflowPdf } from '../src/pdfTranslate/reflow.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');


// ==================== 版面误判：结构化摘要不能当成表格 ====================

test('结构化摘要的长句列不应被表格保护规则跳过', () => {
  const lines = Array.from({ length: 5 }, (_, row) => ({
    text: row === 0
      ? 'Short video sharing platforms have rapidly expanded the online content market.'
      : 'Users consumption behavior is dynamic and exhibits fine-grained temporal dependencies.',
    items: [
      { x: 300, text: row === 0 ? 'Short video sharing platforms' : 'Users consumption behavior' },
      { x: 430, text: 'have rapidly expanded the online content market.' },
      { x: 560, text: 'and exhibits fine-grained temporal dependencies.' },
    ],
  }));
  assert.equal(looksLikeTable({ lineCount: lines.length, lines }), false);
});

test('短单元格且列位置稳定的块仍可识别为表格', () => {
  const lines = Array.from({ length: 4 }, (_, row) => ({
    text: `A${row} B${row} C${row}`,
    items: [{ x: 100, text: `A${row}` }, { x: 180, text: `B${row}` }, { x: 260, text: `C${row}` }],
  }));
  assert.equal(looksLikeTable({ lineCount: lines.length, lines }), true);
});

// ==================== 输出模式 ====================

test('resolveModes：别名展开成具体成品列表', () => {
  assert.deepEqual(resolveModes('md'), ['md']);
  assert.deepEqual(resolveModes('mono'), ['mono']);
  assert.deepEqual(resolveModes('dual'), ['dual']);
  assert.deepEqual(resolveModes('reflow'), ['reflow']);
  assert.deepEqual(resolveModes('both'), ['mono', 'dual']);
  // 四种全出时 Markdown 排在最前——它是用户最终想看的那一份
  assert.deepEqual(resolveModes('all'), ['md', 'reflow', 'mono', 'dual']);
  // 未知值退回默认（v1.12 起默认 Markdown 译文），绝不返回空数组（否则一个都不生成）
  assert.deepEqual(resolveModes('???'), ['mono', 'dual']);
  assert.deepEqual(resolveModes(undefined), ['mono', 'dual']);
});

test('每种具体成品都有文件名后缀与中文名', () => {
  for (const m of MODES) {
    if (m === 'both' || m === 'all') continue;
    assert.ok(OUTPUT_META[m], `${m} 缺少 OUTPUT_META`);
    assert.match(OUTPUT_META[m].suffix, /^-/);
    assert.ok(OUTPUT_META[m].label);
  }
});

test('parsePageRange：支持区间、单页与开区间', () => {
  assert.deepEqual(parsePageRange('1-3,5', 10), [1, 2, 3, 5]);
  assert.deepEqual(parsePageRange('8-', 10), [8, 9, 10]);
  assert.deepEqual(parsePageRange('-2', 10), [1, 2]);
  assert.equal(parsePageRange('', 10), null);
  assert.equal(parsePageRange('99', 10), null);
});

// ==================== 字重（「译文发灰看不清」的根因回归） ====================

/** 取一个系统里真实存在的字体用于度量；找不到就返回 null 让用例跳过 */
function findFont(candidates) {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function loadSfnt(file) {
  const buf = fs.readFileSync(file);
  return isTtc(buf) ? extractTtcFont(buf, 0) : buf;
}

const WIN_FONTS = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
const MSYH = findFont([path.join(WIN_FONTS, 'msyh.ttc')]);
const NOTO_VF = findFont([
  path.join(WIN_FONTS, 'NotoSansSC-VF.ttf'),
  path.join(process.env.APPDATA || '', 'zotero-lit-tool', 'fonts', 'NotoSansSC-VF.ttf'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'zotero-lit-tool', 'fonts', 'NotoSansSC-VF.ttf'),
]);

test('静态中文字体（微软雅黑）本身达标 → 不加多余描边', { skip: !MSYH }, () => {
  const bytes = loadSfnt(MSYH);
  const regular = planStroke({ bytes, weight: 'regular' });
  assert.ok(regular.ink > INK_TARGET.regular, `雅黑墨量 ${regular.ink} 应高于常规目标`);
  assert.equal(regular.strokeEm, 0, '已达标的字体不应再补描边');

  // 加粗档目标更重，此时才需要补
  const bold = planStroke({ bytes, weight: 'bold' });
  assert.ok(bold.strokeEm >= 0 && bold.strokeEm <= 0.035);
});

test('可变字体默认档偏细（Noto Sans SC VF）→ 必须补描边', { skip: !NOTO_VF }, () => {
  const bytes = loadSfnt(NOTO_VF);
  const medium = planStroke({ bytes, weight: 'medium' });
  assert.ok(medium.ink < INK_TARGET.medium, `VF 默认档墨量 ${medium.ink} 应低于目标`);
  assert.ok(medium.strokeEm > 0, '偏细字体必须补描边，否则译文发灰');

  const bold = planStroke({ bytes, weight: 'bold' });
  assert.ok(bold.strokeEm >= medium.strokeEm, '目标越重，描边不该更小');
  // 上限保护：描边过宽会把笔画糊在一起
  assert.ok(bold.strokeEm <= 0.035);
});

test('planStroke：拿不到度量时也给保守补偿，不返回 undefined', () => {
  const out = planStroke({ bytes: Buffer.alloc(10), weight: 'medium' });
  assert.ok(Number.isFinite(out.strokeEm) && out.strokeEm > 0);
  assert.equal(out.ink, null);
});

// ==================== 自适应并发 ====================

test('并发池：一路顺畅时逐步提速到上限', async () => {
  const items = Array.from({ length: 40 }, (_, i) => i);
  const trace = [];
  const stat = await runAdaptivePool(items, async () => ({ throttled: 0, failed: 0 }), {
    concurrency: 8,
    onAdjust: (l) => trace.push(l),
  });
  assert.equal(stat.peakConcurrency, 8, '应能爬满用户设的上限');
  assert.ok(trace.length >= 1, '提速过程应上报');
  assert.ok(trace[trace.length - 1] === 8);
});

test('并发池：撞限流立刻减半，不会硬顶着上限猛冲', async () => {
  const items = Array.from({ length: 24 }, (_, i) => i);
  const stat = await runAdaptivePool(items, async () => ({ throttled: 1, failed: 0 }), { concurrency: 8 });
  assert.ok(stat.endLimit < stat.startLimit, `限流后并发应下降（${stat.startLimit} → ${stat.endLimit}）`);
});

test('并发池：单点失败不拖垮整池，结果按下标对齐', async () => {
  const { results } = await runAdaptivePool([1, 2, 3, 4], async (i) => {
    if (i === 3) throw new Error('boom');
    return { v: i };
  }, { concurrency: 4 });
  assert.equal(results[0].v, 1);
  assert.equal(results[2], undefined, '抛错的那一项（值为 3）留空，但其余必须就位');
  assert.equal(results[3].v, 4);
});

test('并发池：空列表与并发 1 的边界', async () => {
  const stat = await runAdaptivePool([], async () => ({}), { concurrency: 8 });
  assert.equal(stat.peakConcurrency, 0);
  const one = await runAdaptivePool([1, 2], async (i) => ({ v: i }), { concurrency: 1 });
  assert.equal(one.results[1].v, 2);
});

test('isThrottleError：识别限流 / 超时 / 网络抖动，不误伤 400', () => {
  assert.equal(isThrottleError({ status: 429 }), true);
  assert.equal(isThrottleError({ status: 503 }), true);
  assert.equal(isThrottleError({ name: 'TimeoutError' }), true);
  assert.equal(isThrottleError(new Error('socket hang up')), true);
  assert.equal(isThrottleError({ status: 400 }), false);
  assert.equal(isThrottleError({ status: 401 }), false);
});

// ==================== 重排 ====================

/** 造一个双栏页面：左右栏各 3 段 + 一个通栏大标题 + 一个页眉 */
function twoColumnPage() {
  const block = (id, kind, x0, x1, y1, extra = {}) => ({
    id, kind, x0, x1, colX0: x0, colX1: x1,
    y0: y1 - 20, y1, width: x1 - x0, height: 20,
    column: x0 < 300 ? 0 : 1, lines: [{ ascent: 0.85 }], lineCount: 2,
    size: 10, text: `text-${id}`, align: 'left',
    // 页眉页脚在真实分析结果里一定是 translatable=false 的家具块
    translatable: kind !== 'furniture',
    textColor: { r: 0, g: 0, b: 0 }, bg: null,
    expandUp: 0, expandDown: 0, bold: false, serif: false,
    ...extra,
  });
  return {
    index: 1,
    rotate: 0,
    width: 595,
    height: 842,
    bodySize: 10,
    columns: [{ index: 0, x0: 60, x1: 295 }, { index: 1, x0: 300, x1: 535 }],
    images: [],
    blocks: [
      block('hdr', 'furniture', 60, 535, 810),
      block('title', 'title', 60, 535, 760),   // 通栏
      block('L1', 'body', 60, 295, 700),
      block('R1', 'body', 300, 535, 700),
      block('L2', 'body', 60, 295, 660),
      block('R2', 'body', 300, 535, 660),
      block('L3', 'body', 60, 295, 620),
      block('R3', 'body', 300, 535, 620),
    ],
  };
}

test('阅读顺序：双栏页面先左栏自上而下，再右栏，通栏标题排最前', () => {
  const order = readingOrder(twoColumnPage()).map((b) => b.id);
  assert.deepEqual(order, ['title', 'L1', 'L2', 'L3', 'R1', 'R2', 'R3']);
  // 关键回归：左右栏同高度的段落绝不能交错
  assert.ok(order.indexOf('L3') < order.indexOf('R1'), '左栏末段必须早于右栏首段');
});

test('重排元素流：丢掉页眉页脚，译好的文字按顺序入流', () => {
  const page = twoColumnPage();
  for (const b of page.blocks) b.translation = `T-${b.id}`;
  const { elements, stats } = buildElements([page], {});
  const ids = elements.filter((e) => e.type === 'text').map((e) => e.text);
  assert.ok(!ids.some((t) => t.includes('hdr')), '页眉（furniture）不该进入重排文档');
  assert.equal(ids[0], 'T-title');
  assert.ok(ids.indexOf('T-L3') < ids.indexOf('T-R1'));
  assert.equal(stats.text, 7);
});

test('重排元素流：非译文的公式块被裁下来贴回，不丢内容', () => {
  const page = twoColumnPage();
  for (const b of page.blocks) b.translation = `T-${b.id}`;
  // 造一个「不可翻译的公式块」
  page.blocks.push({
    id: 'eq1', kind: 'formula', x0: 100, x1: 400, y0: 400, y1: 460,
    colX0: 100, colX1: 400, width: 300, height: 60, column: -1,
    lines: [{ ascent: 0.85 }], lineCount: 1, size: 10, text: 'E=mc^2',
    translatable: false, align: 'center', textColor: null, bg: null,
    expandUp: 0, expandDown: 0, bold: false, serif: false, tableLike: false,
  });
  const { elements, stats } = buildElements([page], {});
  const crops = elements.filter((e) => e.type === 'crop');
  assert.equal(crops.length, 1);
  assert.equal(crops[0].kind, 'formulas');
  assert.equal(stats.formulas, 1);
  // 裁剪矩形要带一点外扩，避免把公式边缘切掉
  assert.ok(crops[0].rect.x0 < 100 && crops[0].rect.x1 > 400);
});

test('重排元素流：右栏插图落在左栏之后，不被拽回左栏中间', () => {
  const page = twoColumnPage();
  for (const b of page.blocks) b.translation = `T-${b.id}`;
  // 右栏顶部的一张插图（与任何文字块都不重叠，避免被当成水印丢掉）
  page.images.push({ x0: 300, x1: 535, y0: 700, y1: 730 });
  const { elements, stats } = buildElements([page], {});
  const idx = (t) => elements.findIndex((e) => e.type === 'text' && e.text === t);
  const figAt = elements.findIndex((e) => e.type === 'crop' && e.kind === 'figures');
  assert.equal(stats.figures, 1);
  assert.ok(figAt > -1, '右栏插图应被裁下来保留');
  // 关键：按纵坐标它会排在 L2 / L3 之前，正确做法是等左栏三段落读完
  assert.ok(figAt > idx('T-L3'), '插图必须排在左栏末段之后');
  assert.ok(figAt < idx('T-R1'), '插图应落在右栏开头');
});

// ---- 条目层级：重排排版的地基（曾经把整篇正文都当成 h3 标题渲染） ----

/** 造一个只有各类 kind 的单栏页，用来断言 kind → level 的映射 */
function kindsPage() {
  const mk = (id, kind, size, y) => ({
    id, kind, x0: 60, x1: 535, colX0: 60, colX1: 535, y0: y - 20, y1: y,
    width: 475, height: 20, column: 0, lines: [{ ascent: 0.85 }], lineCount: 1,
    size, text: `text-${id}`, translatable: true, align: 'left',
    textColor: { r: 0, g: 0, b: 0 }, bg: null, expandUp: 0, expandDown: 0,
    bold: false, serif: false,
  });
  return {
    index: 1,
    rotate: 0,
    width: 595,
    height: 842,
    bodySize: 10,
    columns: [],
    images: [],
    blocks: [
      mk('t', 'title', 18, 800),
      mk('h1', 'heading', 14, 760),
      mk('h2', 'heading', 12, 720),
      mk('b1', 'body', 10, 680),
      mk('b2', 'body', 10, 640),
      mk('cap', 'caption', 9, 600),
      mk('ref', 'reference', 9, 560),
    ],
  };
}

test('条目层级：正文是 body，只有 heading 才升成 h2/h3（回归：曾全篇变标题）', () => {
  const page = kindsPage();
  for (const b of page.blocks) b.translation = b.text;
  const { elements } = buildElements([page], {});
  const levelOf = new Map(elements.filter((e) => e.type === 'text').map((e) => [e.text, e.level]));
  assert.equal(levelOf.get('text-t'), 'title');
  assert.equal(levelOf.get('text-h1'), 'h2', '字号最大的 heading 是 h2');
  assert.equal(levelOf.get('text-h2'), 'h3', '次一级 heading 是 h3');
  assert.equal(levelOf.get('text-b1'), 'body', '正文必须是 body');
  assert.equal(levelOf.get('text-b2'), 'body');
  assert.equal(levelOf.get('text-cap'), 'caption', '图注要降一号、转灰');
  assert.equal(levelOf.get('text-ref'), 'ref');
  // 全篇只应有两个标题级元素（title + 2 个 heading 中的 heading 计数规则见 stats）
  assert.ok(![...levelOf.values()].filter((v) => /^h[2-5]$/.test(v)).includes('body'));
});

test('wrapFlow：首行缩进只影响第一行', () => {
  const measure = (s) => s.length * 10; // 每字 10 宽，方便断言
  const text = '一二三四五六七八九十';
  const noIndent = wrapFlow(text, measure, 40, 0);
  const indented = wrapFlow(text, measure, 40, 10);
  assert.equal(noIndent[0].length, 4, '无缩进时首行放满 4 字');
  assert.equal(indented[0].length, 3, '缩进一个字的宽度后，首行只能放 3 字');
  // 首行之后的每一行都要恢复满宽（缩进不能一路带下去）；末行天然不满，不参与断言
  for (const line of indented.slice(1, -1)) assert.equal(line.length, 4, `「${line}」应恢复满宽`);
  // 全文一字不丢
  assert.equal(indented.join(''), text);
});

// ==================== 端到端：真渲染一张重排 PDF ====================
//
// 这条用例是「层级映射」那道 bug 的守门人：整篇正文被当成 h3 时，正文会走加粗档，
// 而真加粗字体（微软雅黑 Bold）本身已达标、描边为 0，于是内容流里一个 Tr 都没有。
// 只断言元素层级还不够——必须真的渲染一遍、看内容流里的算子。

const BOLD_MSYH = findFont([path.join(WIN_FONTS, 'msyhbd.ttc')]);

test('端到端：重排正文字必须走常规档，内容流里要有描边算子（Tr 2）', { skip: !MSYH || !BOLD_MSYH }, async () => {
  const { PDFDocument, StandardFonts, PDFRawStream, PDFArray, PDFRef, decodePDFRawStream } = await import('pdf-lib');
  const { analyzePdf } = await import('../src/pdfTranslate/analyze.js');

  // 造一份最小英文源 PDF（单栏 4 段，足够触发一次真实分析）
  const src = await PDFDocument.create();
  const helv = await src.embedFont(StandardFonts.Helvetica);
  const sp = src.addPage([595, 842]);
  const lines = [
    'Abstract This study examines marketing mix effectiveness across emerging markets.',
    'We use a large panel of firm level observations and a difference in differences design.',
    'Introduction The literature has long debated how price and promotion interact.',
    'We find robust positive effects of distribution breadth on category performance.',
  ];
  lines.forEach((t, i) => sp.drawText(t, { x: 60, y: 720 - i * 26, size: 10, font: helv }));
  const srcBytes = Buffer.from(await src.save());

  const layout = await analyzePdf(srcBytes, { keepFormulas: true, keepTables: true });
  let n = 0;
  for (const p of layout.pages) {
    for (const b of p.blocks) {
      if (!b.translatable) continue;
      b.translation = `第${n + 1}段占位译文，用来验证重排后的字体档位与描边。`;
      n++;
    }
  }
  assert.ok(n >= 3, `源 PDF 应解析出至少 3 个可译块，实际 ${n}`);

  const { bytes, report } = await renderReflowPdf({
    sourceBytes: srcBytes,
    pages: layout.pages,
    fontBytes: loadSfnt(MSYH),
    boldFontBytes: loadSfnt(BOLD_MSYH),
    options: { fontWeight: 'medium', respectBold: true },
  });
  assert.ok(report.translatedBlocks >= n - 1, `只写入 ${report.translatedBlocks}/${n} 段译文`);

  // 统计内容流里的算子
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let ops = '';
  for (let i = 0; i < doc.getPageCount(); i++) {
    const contents = doc.getPage(i).node.Contents();
    if (!contents) continue;
    const list = contents instanceof PDFArray ? contents.asArray() : [contents];
    for (const raw of list) {
      const s = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (s instanceof PDFRawStream) ops += Buffer.from(decodePDFRawStream(s).decode()).toString('latin1');
    }
  }
  assert.ok((ops.match(/\bBT\b/g) || []).length > 0, '内容流里应该有文字');
  assert.ok((ops.match(/2\s+Tr/g) || []).length > 0,
    '正文应带描边加粗算子；一个都没有说明正文被误当成标题、走了真加粗字体（层级映射坏了）');
  assert.ok(/[\d.]+\s+w(?![a-zA-Z])/.test(ops), '描边必须同时设置线宽，否则 Tr 2 没有实际效果');
});

/**
 * 旋转页几何回归。
 *
 * 带 /Rotate 的页面是这条链路里最容易出错的地方：pdf.js 报的文本坐标、pdf-lib 的
 * 绘图指令都在**未旋转**的用户空间里，而 embedPdf 拿到的也是未旋转内容，
 * 所以双语模式必须按旋转角做一次刚体变换才能和阅读器里看到的方向一致。
 * render.js 的 placeEmbedded() 注释里写着「该结论由本文件守护」——这条用例就是它。
 */
test('旋转页：双语成品画布尺寸按「显示尺寸」翻倍，且不抛错', { skip: !MSYH }, async () => {
  const { PDFDocument, StandardFonts, degrees } = await import('pdf-lib');
  const { analyzePdf } = await import('../src/pdfTranslate/analyze.js');
  const { renderTranslatedPdf } = await import('../src/pdfTranslate/render.js');

  for (const rot of [0, 90, 180, 270]) {
    const src = await PDFDocument.create();
    const helv = await src.embedFont(StandardFonts.Helvetica);
    const page = src.addPage([400, 600]);
    page.setRotation(degrees(rot));
    page.drawText('Rotated page body text used for the geometry regression test here.', {
      x: 40, y: 480, size: 11, font: helv,
    });
    const srcBytes = Buffer.from(await src.save());

    const layout = await analyzePdf(srcBytes, { keepFormulas: true, keepTables: true });
    const info = layout.pages[0];
    assert.equal(info.rotate, rot, `/Rotate ${rot} 没被解析出来`);
    let n = 0;
    for (const b of info.blocks) if (b.translatable) { b.translation = '旋转页译文占位。'; n++; }
    assert.ok(n >= 1, `/Rotate ${rot} 应至少解析出一个可译块`);

    const { bytes, report } = await renderTranslatedPdf({
      sourceBytes: srcBytes,
      pages: layout.pages,
      fontBytes: loadSfnt(MSYH),
      mode: 'dual',
      options: { fontWeight: 'medium' },
    });
    const out = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const { width: w, height: h } = out.getPage(0).getSize();
    // displaySize：90/270 时宽高互换；双语页宽 = 显示宽 × 2
    const dw = rot === 90 || rot === 270 ? 600 : 400;
    const dh = rot === 90 || rot === 270 ? 400 : 600;
    assert.ok(Math.abs(w - dw * 2) < 0.5, `/Rotate ${rot} 双语页宽应为 ${dw * 2}，实际 ${w}`);
    assert.ok(Math.abs(h - dh) < 0.5, `/Rotate ${rot} 双语页高应为 ${dh}，实际 ${h}`);
    assert.equal(report.pages, 1);
  }
});

// ==================== 前端静态一致性 ====================

test('前端：app.js 引用的每个 ft 元素 id 都必须存在于 index.html', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  const ids = new Set();
  for (const m of js.matchAll(/ftEl\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
  assert.ok(ids.size >= 10, `只解析到 ${ids.size} 个 id，正则可能失效了`);
  const missing = [...ids].filter((id) => !new RegExp(`id=["']${id}["']`).test(html));
  assert.deepEqual(missing, [], `这些 id 在 index.html 里找不到：${missing.join(', ')}`);
});

test('前端：输出成品下拉必须覆盖服务端认可的所有模式', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  const select = html.match(/<select id="ftMode"[\s\S]*?<\/select>/);
  assert.ok(select, 'index.html 里找不到 ftMode 下拉');
  const values = [...select[0].matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  for (const m of MODES) {
    assert.ok(values.includes(m), `ftMode 缺少模式 ${m}`);
  }
  // 这三种成品都要有中文短名，否则历史记录里会显示英文 key
  for (const k of ['mono', 'dual', 'reflow']) {
    assert.ok(js.includes(`'${k}'`) || js.includes(`${k}:`), `app.js 缺少 ${k} 的展示名`);
  }
});

test('前端：新增的观感控件（字体族 / 字重 / 字号 / 并发）都在表单里', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  for (const id of ['ftFontFamily', 'ftFontWeight', 'ftFontSize', 'ftConcurrency',
    'ftRespectBold', 'ftReflowKeepFigures', 'ftReflowIndent', 'ftSaveDefaults']) {
    assert.ok(new RegExp(`id=["']${id}["']`).test(html), `index.html 缺少控件 ${id}`);
  }
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');
  const opts = js.match(/function ftOptions\(\)[\s\S]*?\n  }/);
  assert.ok(opts, '找不到 ftOptions()');
  for (const key of ['fontFamily', 'fontWeight', 'fontSize', 'respectBold',
    'reflowKeepFigures', 'reflowIndent', 'concurrency']) {
    assert.ok(opts[0].includes(key), `ftOptions() 没有把 ${key} 提交给服务端`);
  }
});
