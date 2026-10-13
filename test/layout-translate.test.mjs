// layout-translate.test.mjs —— 「版面解析 → 全文翻译」适配层的回归测试
//
// 这一层是把 processor 的 manifest.json 转成 analyzePdf 的结构，让翻译管线原样复用。
// 出问题的表现会很隐蔽：译文看着有内容，但对照错位、标题层级全平、或者图表被当正文翻译。
// 所以把映射规则、排序、开关、容错都钉在测试里。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  layoutFromManifest, buildMarkdownFromManifest, buildAlignOutput, ruleOfLabel, headingDepth,
} from '../src/layoutTranslate.js';

/** 一份覆盖各种 label 的最小 manifest */
function sampleManifest() {
  return {
    schemaVersion: 1,
    pages: 2,
    model: { name: 'PP-DocLayoutV3-FP16' },
    blocks: [
      { id: 'p1-b1', page: 1, order: 1, label: 'doc_title', bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 }, text: 'A Study of Trust' },
      { id: 'p1-b2', page: 1, order: 2, label: 'header', bounds: { x: 0, y: 0, width: 1, height: 0.03 }, text: 'Journal XX 104468' },
      { id: 'p1-b3', page: 1, order: 3, label: 'number', bounds: { x: 0.9, y: 0.95, width: 0.05, height: 0.02 }, text: '1' },
      { id: 'p1-b4', page: 1, order: 4, label: 'paragraph_title', bounds: { x: 0.1, y: 0.2, width: 0.5, height: 0.03 }, text: '1 Introduction' },
      { id: 'p1-b5', page: 1, order: 5, label: 'text', bounds: { x: 0.1, y: 0.25, width: 0.8, height: 0.2 }, text: 'Trust matters a lot.' },
      { id: 'p1-b6', page: 1, order: 6, label: 'chart', bounds: { x: 0.1, y: 0.5, width: 0.8, height: 0.3 }, text: 'Figure 1 scatter', image: 'assets/p1-b6.png' },
      { id: 'p2-b1', page: 2, order: 2, label: 'paragraph_title', bounds: { x: 0.1, y: 0.1, width: 0.6, height: 0.03 }, text: '2.1 Detail' },
      { id: 'p2-b2', page: 2, order: 1, label: 'reference_content', bounds: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 }, text: 'Koh & Sundar (2010)' },
    ],
  };
}

test('适配层：装饰块被剔除，语义块映射到正确的 kind', () => {
  const layout = layoutFromManifest(sampleManifest());
  const all = layout.pages.flatMap((p) => p.blocks);
  const labels = all.map((b) => b.label);

  assert.ok(!labels.includes('header'), '页眉应被剔除');
  assert.ok(!labels.includes('number'), '页码应被剔除');

  const byId = new Map(all.map((b) => [b.id, b]));
  assert.equal(byId.get('p1-b1').kind, 'title');
  assert.equal(byId.get('p1-b4').kind, 'heading');
  assert.equal(byId.get('p1-b5').kind, 'body');
  assert.equal(byId.get('p1-b6').kind, 'figure');
  assert.equal(byId.get('p2-b2').kind, 'reference');
});

test('适配层：图表与公式不翻译，正文与标题翻译', () => {
  const layout = layoutFromManifest(sampleManifest());
  const byId = new Map(layout.pages.flatMap((p) => p.blocks).map((b) => [b.id, b]));
  assert.equal(byId.get('p1-b1').translatable, true);
  assert.equal(byId.get('p1-b4').translatable, true);
  assert.equal(byId.get('p1-b5').translatable, true);
  assert.equal(byId.get('p1-b6').translatable, false, '图表内容是图形，不该送去翻译');
});

test('适配层：块自带 page 与归一化坐标（前端对照要用）', () => {
  const layout = layoutFromManifest(sampleManifest());
  const b = layout.pages[0].blocks.find((x) => x.id === 'p1-b5');
  assert.equal(b.page, 1);
  assert.equal(b.nx, 0.1);
  assert.equal(b.ny, 0.25);
  assert.equal(b.nw, 0.8);
  assert.equal(b.nh, 0.2);
  // 缺页尺寸时，绝对坐标退化为归一化值（不丢信息，也不误导）
  assert.equal(b.x0, 0.1);
});

test('适配层：按 order 排序，而不是数组下标', () => {
  const layout = layoutFromManifest(sampleManifest());
  const p2 = layout.pages.find((p) => p.index === 2);
  // 数组里 reference_content 在前、paragraph_title 在后，但 order 相反
  assert.equal(p2.blocks[0].id, 'p2-b2', 'order=1 的块应排在前面');
  assert.equal(p2.blocks[1].id, 'p2-b1');
});

test('适配层：参考文献默认不翻，打开开关后翻', () => {
  const off = layoutFromManifest(sampleManifest(), { translateReferences: false });
  const on = layoutFromManifest(sampleManifest(), { translateReferences: true });
  const refOff = off.pages.flatMap((p) => p.blocks).find((b) => b.id === 'p2-b2');
  const refOn = on.pages.flatMap((p) => p.blocks).find((b) => b.id === 'p2-b2');
  assert.equal(refOff.translatable, false);
  assert.equal(refOn.translatable, true);
  assert.ok(on.stats.translatableBlocks > off.stats.translatableBlocks);
});

test('适配层：缺 page 的块被跳过；未知标签按正文兜底（不丢内容）', () => {
  const layout = layoutFromManifest({
    pages: 1,
    blocks: [
      { id: 'x1', page: 1, label: 'text', bounds: { x: 0, y: 0, width: 1, height: 0.1 }, text: 'A' },
      { id: 'x2', label: 'text', text: '没有 page 字段' },
      { id: 'x3', page: 1, label: '未来才有的新标签', bounds: { x: 0, y: 0.2, width: 1, height: 0.1 }, text: 'B' },
    ],
  });
  const ids = layout.pages.flatMap((p) => p.blocks).map((b) => b.id);
  assert.deepEqual(ids, ['x1', 'x3']);
  const unknown = layout.pages[0].blocks.find((b) => b.id === 'x3');
  assert.equal(unknown.kind, 'body');
  assert.equal(unknown.translatable, true, '未知标签宁可当正文翻，也不要丢内容');
});

test('标题层级：按编号的点号层数推断（论文标题占 H1，章节整体下移一级）', () => {
  assert.equal(headingDepth('1 Introduction', 'paragraph_title'), 2);
  assert.equal(headingDepth('2.1 AI products', 'paragraph_title'), 3);
  assert.equal(headingDepth('2.1.1 Sub section', 'paragraph_title'), 4);
  assert.equal(headingDepth('ABSTRACT', 'paragraph_title'), 2, '无编号的段落标题给默认二级');
  assert.equal(headingDepth('A Study of Trust', 'doc_title'), 1, '论文标题是 H1');
});

test('标签订阅表：关键词义的判定', () => {
  assert.deepEqual(ruleOfLabel('text'), { kind: 'body', translatable: true });
  assert.deepEqual(ruleOfLabel('chart'), { kind: 'figure', translatable: false });
  assert.equal(ruleOfLabel('footer'), null, '页脚应被丢弃');
  assert.equal(ruleOfLabel('seal'), null, '印章应被丢弃');
});

test('Markdown：标题成形、正文成段、图表丢弃、文献条目成列表', () => {
  const layout = layoutFromManifest(sampleManifest(), { translateReferences: true });
  const md = buildMarkdownFromManifest(layout.pages);

  assert.match(md.markdown, /^# A Study of Trust$/m);
  assert.match(md.markdown, /^## 1 Introduction$/m);
  assert.match(md.markdown, /^### 2\.1 Detail$/m);
  assert.match(md.markdown, /Trust matters a lot\./);
  assert.ok(!md.markdown.includes('Figure 1 scatter'), '图表应被丢弃');
  assert.match(md.markdown, /^- Koh & Sundar \(2010\)$/m, '文献条目应成列表项');
});

test('Markdown：译文优先于原文（有 translation 时用它）', () => {
  const layout = layoutFromManifest(sampleManifest());
  const b = layout.pages[0].blocks.find((x) => x.id === 'p1-b5');
  b.translation = '信任非常重要。';
  const md = buildMarkdownFromManifest(layout.pages);
  assert.match(md.markdown, /信任非常重要。/);
  assert.ok(!md.markdown.includes('Trust matters a lot.'), '有译文时不再输出原文');
});

test('对照数据：逐块给出原文/译文/坐标/裁图，供左右同步使用', () => {
  const layout = layoutFromManifest(sampleManifest());
  layout.pages[0].blocks.find((x) => x.id === 'p1-b5').translation = '信任非常重要。';
  const align = buildAlignOutput(layout, { literatureId: 'lit-1', targetLang: 'zh' });

  assert.equal(align.schemaVersion, 1);
  assert.equal(align.literatureId, 'lit-1');
  assert.equal(align.pages, 2);

  const body = align.blocks.find((b) => b.id === 'p1-b5');
  assert.equal(body.text, 'Trust matters a lot.');
  assert.equal(body.translation, '信任非常重要。');
  assert.equal(body.page, 1);
  assert.equal(body.x, 0.1);
  assert.equal(body.width, 0.8);

  const chart = align.blocks.find((b) => b.id === 'p1-b6');
  assert.equal(chart.image, 'assets/p1-b6.png', '图表要带裁图路径，前端/AI 都要用');
  assert.equal(chart.translation, '', '图表没有译文');

  assert.equal(align.translatedBlocks, 1);
});

test('对照数据：原文译文都空且无裁图的块被过滤（不产生空占位）', () => {
  const layout = layoutFromManifest({
    pages: 1,
    blocks: [
      { id: 'a', page: 1, label: 'text', bounds: { x: 0, y: 0, width: 1, height: 0.1 }, text: '' },
      { id: 'b', page: 1, label: 'text', bounds: { x: 0, y: 0.2, width: 1, height: 0.1 }, text: '有内容' },
    ],
  });
  const align = buildAlignOutput(layout);
  assert.deepEqual(align.blocks.map((b) => b.id), ['b']);
});

test('统计口径：可译块数与字符数一致', () => {
  const layout = layoutFromManifest(sampleManifest(), { translateReferences: true });
  const all = layout.pages.flatMap((p) => p.blocks);
  const expected = all.filter((b) => b.translatable).reduce((n, b) => n + b.text.length, 0);
  assert.equal(layout.stats.chars, expected);
  assert.equal(layout.stats.translatableBlocks, all.filter((b) => b.translatable).length);
  assert.equal(layout.source, 'manifest');
});

test('空 manifest 不炸：返回 0 页 0 块', () => {
  const layout = layoutFromManifest({ blocks: [] });
  assert.equal(layout.pages.length, 0);
  assert.equal(layout.stats.blocks, 0);
  assert.equal(layout.stats.translatableBlocks, 0);
  const md = buildMarkdownFromManifest(layout.pages);
  assert.equal(md.markdown, '');
});
