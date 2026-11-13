// translate-fragment-bold.test.mjs —— 「译文里的省略号」与「原文加粗 → 译文加粗」
//
// 两件事都来自用户的同一张截图：
//   ① 译文里出现「……」，甚至出现「（原文不完整，但按要求翻译到此）」这种说明；
//   ② 原文加粗的假设（H10. / H11.）在译文里变成普通正文，读者看不出作者的强调。
//
// ① 的根因是 PDF 的段落在页面底部被切开、两半各自送翻，模型看到半句话就补省略号；
//    另一种是输出被 max_tokens 截断，末尾几段只出来半句。这里的断言分三层：
//    · polishTranslation 只清掉「原文没有的」省略号与元话语，句中/原文自带的必须保留；
//    · 译文清洗既作用于新翻出来的，也作用于缓存命中的（老缓存里已经存了脏文本）；
//    · 版面块的字重从 PDF 字体名扫出来，标题类不再靠 kind 猜。
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { polishTranslation } from '../src/pdfTranslate/engines.js';
import { layoutFromManifest, buildAlignOutput } from '../src/layoutTranslate.js';
import { computeBoldByBlock } from '../src/layoutBold.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- ① 省略号 / 元话语清洗 ----------

test('译文末尾凭空多出的「……」会被清掉（原文没有省略号）', () => {
  const src = 'However, both alternatives fell short of';
  assert.equal(polishTranslation(src, '然而，两种替代方案均未……'), '然而，两种替代方案均未');
  assert.equal(polishTranslation(src, '然而，两种替代方案均未...'), '然而，两种替代方案均未');
});

test('原文自己以省略号结尾时，译文的省略号必须保留', () => {
  const src = 'The remaining items were dropped, etc…';
  assert.equal(polishTranslation(src, '其余条目被舍弃，等等……'), '其余条目被舍弃，等等……');
});

test('模型对残缺原文的自我说明会被删掉', () => {
  const out = polishTranslation(
    'determined motivations for sustainable food choice to b',
    '决定性的动机使可持续食物选择更……（原文不完整，但按要求翻译到此）',
  );
  assert.equal(out, '决定性的动机使可持续食物选择更');
  assert.ok(!/原文不完整/.test(out));
});

test('句中的省略号是原文本来就有的（引用省略），不能被当成尾巴删掉', () => {
  const out = polishTranslation('The authors (2019) reported … and later revised it.', '作者（2019）报告了……随后又做了修正。');
  assert.equal(out, '作者（2019）报告了……随后又做了修正。');
});

test('清洗后为空时退回原译文，不能把这一块变成空白', () => {
  assert.equal(polishTranslation('abc', '……'), '……');
  assert.equal(polishTranslation('abc', ''), '');
});

// ---------- ② 版面块的字重 ----------

/** 造一页 PDF：一行粗体、一行常规，位置固定，方便按归一化坐标造块 */
async function makeBoldPdf() {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('H10. Perceived consumer effectiveness moderates the association', {
    x: 60, y: 700, size: 12, font: bold,
  });
  page.drawText('A prompt that switches the cart before checkout is a green default', {
    x: 60, y: 600, size: 12, font: regular,
  });
  return Buffer.from(await doc.save());
}

test('从 PDF 字体名判出「这一块原文是加粗的」（不依赖 label）', async () => {
  const bytes = await makeBoldPdf();
  // 归一化坐标：左上原点。y=700 的基线落在第一块（0.02~0.14），y=600 落在第二块（0.14~0.30）
  const manifest = {
    pages: 1,
    blocks: [
      { id: 'p1-b1', page: 1, label: 'text', order: 1, bounds: { x: 0.05, y: 0.02, width: 0.9, height: 0.12 }, text: 'H10…' },
      { id: 'p1-b2', page: 1, label: 'text', order: 2, bounds: { x: 0.05, y: 0.14, width: 0.9, height: 0.16 }, text: 'A prompt…' },
    ],
  };
  const map = await computeBoldByBlock(bytes, manifest);
  assert.equal(map.get('p1-b1'), true, '粗体那一行应判为加粗');
  assert.equal(map.get('p1-b2'), false, '常规那一行不该判为加粗');
});

test('字重写进版面块，并随对照数据一起交给前端', () => {
  const manifest = {
    pages: 1,
    blocks: [
      { id: 'p1-b1', page: 1, label: 'text', order: 1, bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 }, text: 'H10. xxx' },
      { id: 'p1-b2', page: 1, label: 'paragraph_title', order: 2, bounds: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 }, text: '2.1 Sub' },
    ],
  };
  const boldByBlock = new Map([['p1-b1', true]]);
  const lay = layoutFromManifest(manifest, { boldByBlock });
  const align = buildAlignOutput(lay);
  const byId = new Map(align.blocks.map((b) => [b.id, b]));
  assert.equal(byId.get('p1-b1').bold, true, '粗体块要带 bold=true');
  assert.equal(byId.get('p1-b2').bold, false, '未标注的块是 false，不是 undefined');
});

// ---------- ③ 前端兜底清洗（历史译文） ----------

test('前端显示前也会清洗历史译文里的省略号与元话语', () => {
  const context = { window: {}, localStorage: { getItem: () => null, setItem: () => {} } };
  context.self = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/compare-utils.js'), 'utf8'), context, {
    filename: 'compare-utils.js',
  });
  const clean = context.window.CompareUtils.cleanTranslation;
  assert.equal(clean('both alternatives fell short of', '两种方案均未……'), '两种方案均未');
  assert.equal(clean('keep the ellipsis…', '保留省略号……'), '保留省略号……');
  assert.ok(!/原文不完整/.test(clean('fragment', '半句……（原文不完整）')));
  // 逐句配对的 HTML 也走同一条清洗，否则切到「逐句」又会冒出省略号
  const html = context.window.CompareUtils.translationHtml('both alternatives fell short of', '两种方案均未……');
  assert.ok(!html.includes('……'));
});
