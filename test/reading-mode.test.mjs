// reading-mode.test.mjs —— 阅读模式结构树（src/readingMode.js）的单测
//
// 这里只测**纯函数**：给一份手写的 analysis（和 analyzePdf 的输出同形），断言结构树
// 该收的收、该拼的拼、该留的留。真机渲染由 e2e-reading.mjs 负责，两边不重复。
//
// 重点盯四类回归：
//   · 页眉页脚 / 边栏小字漏进正文（阅读模式的第一观感就靠这条）
//   · 一句话被切成好几段（同页碎片 + 跨页接续）
//   · 表格被打散成「#Huawei# / 395 99 / 0.99 0.11」（必须整块裁图）
//   · 图注出现两次（裁图 figcaption 一次 + 文字块一次）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toReadingDoc, vectorFigures, READING_SCHEMA } from '../src/readingMode.js';

// ---------------- 构造工具（与 analyzePdf 的输出保持同形） ----------------

const PW = 600;
const PH = 800;

/** 一行：x0/x1/bottom/top + items（片段） */
function line(text, { x = 50, y = 700, size = 10, w } = {}) {
  const width = w ?? Math.max(4, text.length * size * 0.5);
  return {
    text,
    x0: x,
    x1: x + width,
    bottom: y,
    top: y + size,
    size,
    items: [{ text, x, w: width }],
  };
}

function block(kind, lines, extra = {}) {
  const x0 = Math.min(...lines.map((l) => l.x0));
  const x1 = Math.max(...lines.map((l) => l.x1));
  const y0 = Math.min(...lines.map((l) => l.bottom));
  const y1 = Math.max(...lines.map((l) => l.top));
  return {
    kind,
    x0, y0, x1, y1,
    width: x1 - x0,
    height: y1 - y0,
    size: lines[0]?.size || 10,
    lineHeight: 12,
    align: 'left',
    bold: false,
    lines,
    lineCount: lines.length,
    text: lines.map((l) => l.text).join(' '),
    ...extra,
  };
}

function page(index, blocks, extra = {}) {
  return {
    index,
    width: PW,
    height: PH,
    x0: 0,
    y0: 0,
    x1: PW,
    y1: PH,
    blocks,
    images: [],
    fills: [],
    columns: [],
    ...extra,
  };
}

/** 一段正文（多行，行尾顶到右边距） */
function paraBlock(texts, { x = 50, top = 700, size = 10, lead = 14 } = {}) {
  return block('body', texts.map((t, i) => line(t, { x, y: top - i * lead, size, w: 550 - x })));
}

function docOf(pages, stats = {}) {
  return toReadingDoc({ pages, totalPages: pages.length, stats: { bodySize: 10, ...stats } });
}

const textsOf = (b) => b.lines.flatMap((l) => l.runs.map((r) => r[2]));

// ---------------- 页眉页脚 ----------------

test('页眉页脚 / 右侧边栏小字被剔除，正文不受影响', () => {
  const pages = [1, 2, 3].map((i) => page(i, [
    block('body', [line('Journal of Two Column Studies, Vol. 12, No. 3', { y: 780, size: 8 })]),
    paraBlock([`Body paragraph ${i} line one continues here`, 'and the second line of the same paragraph']),
    block('heading', [line('Internet Research', { x: 500, y: 600, size: 7, w: 60 })]),
    block('body', [line('Downloaded from https://example.org/a/1 by guest', { y: 20, size: 7 })]),
    block('body', [line(String(1200 + i), { x: 290, y: 8, size: 8, w: 6 })]),
  ]));
  const doc = docOf(pages);
  const all = doc.blocks.filter((b) => b.t === 'text').flatMap(textsOf).join(' | ');
  assert.ok(!/Journal of Two Column Studies/.test(all), '页眉应该被剔除');
  assert.ok(!/Downloaded from/.test(all), '页脚应该被剔除');
  assert.ok(!/Internet Research/.test(all), '右侧 running head 应该被剔除');
  assert.ok(!/120[0-9]/.test(all), '纯页码应该被剔除');
  assert.equal(doc.blocks.filter((b) => b.t === 'text').length, 3, '三页各剩一段正文');
});

test('单页文档不做跨页重复判定（否则首页页眉会被误删）', () => {
  const doc = docOf([page(1, [
    block('body', [line('A header looking line at the very top', { y: 782, size: 8 })]),
    paraBlock(['Body text that should always survive']),
  ])]);
  assert.equal(doc.blocks.length, 2);
});

// ---------------- 同页碎片拼接 ----------------

test('上一行顶到右边距 + 下一块小写续写 → 拼成一段', () => {
  const doc = docOf([page(1, [
    paraBlock(['the reading mode reconstructs the flow so that each column is'], { top: 700 }),
    block('body', [line('consumed completely before the next one begins', { y: 686 })]),
  ])]);
  assert.equal(doc.blocks.length, 1, '两块应合成一块');
  assert.equal(doc.blocks[0].lines.length, 2);
});

test('上一行没顶到右边距且下一块大写开头 → 不合并', () => {
  const doc = docOf([page(1, [
    block('body', [line('a short line ends here.', { y: 700, w: 200 })]),
    block('body', [line('Another paragraph starts.', { y: 686 })]),
  ])]);
  assert.equal(doc.blocks.length, 2, '这是两个段落，不能粘在一起');
});

test('多行段落最后一行没顶到右边距、下一块大写开头 → 不合并', () => {
  const doc = docOf([page(1, [
    block('body', [
      line('the first line fills the whole measure nicely', { y: 714, w: 500 }),
      line('the last line is short.', { y: 700, w: 180 }),
    ]),
    block('body', [line('Another paragraph starts here', { y: 686 })]),
  ])]);
  assert.equal(doc.blocks.length, 2);
});

test('不同字号 / 不同 kind 的相邻块不合并', () => {
  const doc = docOf([page(1, [
    paraBlock(['a body line that reaches the right margin for sure'], { top: 700, size: 10 }),
    block('caption', [line('figure 1 something', { y: 686, size: 8 })]),
  ])]);
  assert.equal(doc.blocks.length, 2);
});

// ---------------- 跨页接续 ----------------

test('跨页段落接续：上页话没说完 + 下页贴页首小写开头', () => {
  const doc = docOf([
    page(1, [paraBlock(['the flow is rebuilt column by column and the reader', 'keeps going without noticing the page break'])], { blocksAlt: true }),
    page(2, [block('body', [line('continues on the next page with lowercase text', { y: 700 })])]),
  ]);
  assert.equal(doc.blocks.length, 1, '跨页的同一段应合成一块');
  assert.equal(doc.blocks[0].lines.length, 3);
  assert.deepEqual([...new Set(doc.blocks[0].lines.map((l) => l.p))], [1, 2], '行应来自两页');
});

test('上页以句号结尾 → 不跨页接续', () => {
  const doc = docOf([
    page(1, [block('body', [line('This paragraph ends properly.', { y: 700, w: 550 })])]),
    page(2, [block('body', [line('another paragraph begins here', { y: 700 })])]),
  ]);
  assert.equal(doc.blocks.length, 2);
});

// ---------------- 表格区 ----------------

test('被拆成一格一块的表格 → 收回成一张整块裁图', () => {
  const cells = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      cells.push(block('body', [line(`c${r}${c}`, { x: 60 + c * 120, y: 560 - r * 16, size: 8, w: 70 })]));
    }
  }
  const doc = docOf([page(1, cells)]);
  const crops = doc.blocks.filter((b) => b.t === 'crop');
  assert.equal(crops.length, 1, '应合成一张表格裁图');
  assert.equal(crops[0].k, 'table');
  assert.equal(doc.blocks.filter((b) => b.t === 'text').length, 0, '单元格不应再排成正文');
  assert.equal(doc.stats.tables, 1);
});

// ---------------- 图注去重 ----------------

test('图注被裁图吞掉后不再单独排一遍（不能出现两次）', () => {
  const cells = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      cells.push(block('body', [line(`cell${r}${c}`, { x: 60 + c * 120, y: 560 - r * 16, size: 8, w: 70 })]));
    }
  }
  const caption = block('caption', [line('Table 1. Frequency analysis of brand hashtags', { x: 60, y: 620, size: 8, w: 300 })]);
  const doc = docOf([page(1, [...cells, caption])]);
  const crops = doc.blocks.filter((b) => b.t === 'crop');
  assert.equal(crops.length, 1);
  assert.match(crops[0].caption, /Table 1\./, '图注应该挂到裁图节点上');
  const textBlocks = doc.blocks.filter((b) => b.t === 'text');
  assert.equal(textBlocks.length, 0, '图注不能再作为一个文字块出现');
});

// ---------------- 矢量插图 ----------------

test('矢量柱状图被识别成插图区域', () => {
  const bars = [46, 78, 60, 96].map((h, i) => ({
    x0: 100 + i * 44, y0: 250, x1: 130 + i * 44, y1: 250 + h,
    color: { r: 0.3, g: 0.4, b: 0.7 },
  }));
  const p = page(1, [paraBlock(['body text above the chart'])], { fills: bars });
  const rects = vectorFigures(p, p.blocks);
  assert.equal(rects.length, 1);
  assert.ok(rects[0][2] - rects[0][0] > 150 && rects[0][3] - rects[0][1] > 60);
});

test('单个色块 / 被文字盖住的底纹不会被当成插图', () => {
  const single = page(1, [], {
    fills: [{ x0: 100, y0: 250, x1: 400, y1: 340, color: { r: 0.9, g: 0.93, b: 0.98 } }],
  });
  assert.deepEqual(vectorFigures(single, []), [], '单个色块多半是提示框');

  const covered = page(1, [paraBlock(['a long paragraph covering the tint', 'second line of it', 'third line of it'], { top: 330 })], {
    fills: [100, 160, 220].map((x) => ({ x0: x, y0: 290, x1: x + 50, y1: 340, color: { r: 0.85, g: 0.85, b: 0.9 } })),
  });
  assert.deepEqual(vectorFigures(covered, covered.blocks), [], '底纹在文字下面，不是插图');
});

test('近白色填充（页底色）不算插图', () => {
  const p = page(1, [], {
    fills: [0, 1, 2].map((i) => ({ x0: 100 + i * 40, y0: 250, x1: 130 + i * 40, y1: 340, color: { r: 1, g: 1, b: 1 } })),
  });
  assert.deepEqual(vectorFigures(p, []), []);
});

// ---------------- 兜底与结构 ----------------

test('没有文字层的页面按整页裁图保留，并给出 warning', () => {
  // 扫描页常见形态：整页墨迹全是路径 / 图形操作，pdf.js 探不到文字层也探不到图像 XObject
  const doc = docOf([page(1, [], { rawItems: 12 })]);
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].t, 'crop');
  assert.equal(doc.blocks[0].full, true);
  assert.equal(doc.stats.emptyPages, 1);
  assert.match(doc.warnings[0], /第 1 页/);
});

test('整页都是图像（扫描件）→ 按图像裁图保留，不丢页', () => {
  const doc = docOf([page(1, [], { images: [{ x0: 0, y0: 0, x1: PW, y1: PH }] })]);
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].t, 'crop');
  assert.equal(doc.blocks[0].k, 'figure');
});

test('结构树带版本号、块 id 连续、标题分级正确', () => {
  const doc = docOf([
    page(1, [
      block('title', [line('A Paper Title', { y: 760, size: 18, w: 300 })]),
      block('heading', [line('1. Introduction', { y: 720, size: 12, w: 150 })]),
      block('heading', [line('1.1 Sub section', { y: 690, size: 10.5, w: 150 })]),
      paraBlock(['body text goes here and continues'], { top: 640 }),
    ]),
  ]);
  assert.equal(doc.v, READING_SCHEMA);
  assert.deepEqual(doc.blocks.map((b) => b.id), ['r1', 'r2', 'r3', 'r4']);
  assert.equal(doc.blocks[0].level, 1, 'title → h1');
  assert.ok(doc.blocks[1].level >= 2, 'heading → h2 及以下');
  assert.ok(doc.blocks[2].level > doc.blocks[1].level, '小字号标题级别更低');
  assert.equal(doc.blocks[3].level, 0, '正文不分级');
  assert.equal(doc.stats.headings, 3);
  assert.equal(doc.stats.paragraphs, 1);
});

test('块的 rect 是 [x0,y0,x1,y1]，行几何完整（前端靠它反推坐标）', () => {
  const doc = docOf([page(1, [paraBlock(['first line of the paragraph', 'second line follows'])])]);
  const b = doc.blocks[0];
  assert.equal(b.rect.length, 4);
  assert.ok(b.rect[0] < b.rect[2] && b.rect[1] < b.rect[3]);
  for (const l of b.lines) {
    assert.equal(l.p, 1);
    assert.ok(l.y1 > l.y0, '行盒 top > bottom');
    assert.ok(l.x1 > l.x0);
    for (const r of l.runs) {
      assert.equal(r.length, 3, 'run 是 [x, w, text]');
      assert.ok(typeof r[0] === 'number' && typeof r[1] === 'number' && typeof r[2] === 'string');
      assert.ok(r[1] > 0, '片段宽度必须为正，否则前端插值算不出字符框');
    }
  }
});

test('空文档 / 缺字段不抛错', () => {
  assert.doesNotThrow(() => toReadingDoc({}));
  assert.equal(toReadingDoc({}).blocks.length, 0);
  assert.equal(toReadingDoc({ pages: [page(1, [])] }).blocks.length, 0);
});
