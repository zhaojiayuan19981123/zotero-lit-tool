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

test('栏底断句 + 下一栏小写续写 → 接成一段（双栏排版里一句话跨栏很常见）', () => {
  const doc = docOf([page(1, [
    block('body', [line('hosts of live demonstrations might invite a group of', { x: 50, y: 120, size: 10, w: 230 })], { column: 0 }),
    block('body', [line('or demonstrators might invite customers to privately view', { x: 306, y: 700, size: 10, w: 230 })], { column: 1 }),
  ], { columns: [{ x0: 50, x1: 290 }, { x0: 306, x1: 545 }] })]);
  assert.equal(doc.blocks.length, 1, '跨栏的同一句要合成一块');
  assert.equal(doc.blocks[0].lines.length, 2);
});

test('栏底以句号结尾 → 不跨栏接续', () => {
  const doc = docOf([page(1, [
    block('body', [line('This paragraph ends properly.', { x: 50, y: 120, size: 10, w: 230 })], { column: 0 }),
    block('body', [line('or demonstrators might invite customers', { x: 306, y: 700, size: 10, w: 230 })], { column: 1 }),
  ], { columns: [{ x0: 50, x1: 290 }, { x0: 306, x1: 545 }] })]);
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

// ---------------- 脚注归位 ----------------
//
// 用户最直接的抱怨是「脚注插在正文中间，一句话被切成两截」。脚注必须：
//   ① 不参与正文排序；② 排在本页正文之后；③ 第一段带一条分隔线（Zotero 也是这么标的）。

test('页底部小字脚注排到本页正文之后，并带分隔线', () => {
  const body = paraBlock(['There are many different ways to enable employees', 'to express their concerns'], { top: 700 });
  // 首页左下角那种作者单位 / 通讯邮箱：字号小于正文，内容像脚注
  const note = block('body', [line('christine.ringler@ua.edu, Culverhouse College of Business', { x: 50, y: 100, size: 8, w: 240 })]);
  const doc = docOf([page(1, [body, note])]);
  const kinds = doc.blocks.map((b) => b.kind || 'body');
  assert.deepEqual(kinds, ['body', 'footnote'], '脚注要排在正文之后，不能插在句子中间');
  assert.equal(doc.blocks[1].sep, true, '本页第一段脚注带分隔线');
  assert.equal(doc.stats.footnotes, 1);
});

test('分栏且整栏是小字时，该栏整栏判为脚注（Springer 首页那种）', () => {
  const bodyLines = [
    line('The process mindset literature suggests that', { x: 50, y: 700, size: 10, w: 250 }),
    line('demonstrations work through the process itself', { x: 50, y: 686, size: 10, w: 250 }),
  ];
  const leftCol = [
    block('body', [line('ORIGINAL EMPIRICAL RESEARCH', { x: 50, y: 780, size: 7, w: 200 })], { column: 0 }),
    block('body', [line('Christine Ringler is an assistant professor', { x: 50, y: 200, size: 7, w: 240 })], { column: 0 }),
    block('body', [line('at the University of Alabama, Tuscaloosa', { x: 50, y: 188, size: 7, w: 240 })], { column: 0 }),
  ];
  const rightCol = [block('body', bodyLines, { column: 1 })];
  const doc = docOf([page(1, [...leftCol, ...rightCol], { columns: [{ x0: 50, x1: 300 }, { x0: 320, x1: 550 }] })]);
  const notes = doc.blocks.filter((b) => b.kind === 'footnote');
  assert.ok(notes.length >= 2, '整栏小字应全部判为脚注');
  const prose = doc.blocks.find((b) => b.kind !== 'footnote' && b.kind !== 'kicker');
  assert.match(prose.lines[0].runs.map((r) => r[2]).join(' '), /process mindset/, '正文不能混进作者单位');
});

// ---------------- 标题识别 ----------------

test('非粗体的节名（Abstract / Introduction）识别成标题，且与正文同字号时是 h2', () => {
  const doc = docOf([page(1, [
    block('body', [line('Abstract', { y: 760, size: 10, w: 60 })]),
    paraBlock(['Product demonstrations are powerful promotional tools.'], { top: 730 }),
    block('body', [line('Introduction', { y: 660, size: 10, w: 80 })]),
    paraBlock(['Product demonstrations have been evolving'], { top: 630 }),
  ])]);
  const heads = doc.blocks.filter((b) => b.level > 0);
  assert.equal(heads.length, 2, '两行节名都应成为标题');
  assert.deepEqual(heads.map((b) => b.level), [2, 2], '与正文同字号的节标题固定 h2，不能掉到 h5');
});

test('编号小节「3.1 Sample」识别成标题，句末带句号的正文句子不会', () => {
  const doc = docOf([page(1, [
    block('body', [line('3.1 Sample', { y: 760, size: 11, w: 70 })]),
    paraBlock(['We surveyed 412 consumers across three studies.'], { top: 730 }),
    block('body', [line('2020 was a difficult year for retail.', { y: 660, size: 10, w: 240 })]),
  ])]);
  const heads = doc.blocks.filter((b) => b.level > 0).map((b) => textsOf(b).join(''));
  assert.deepEqual(heads, ['3.1 Sample']);
});

test('全大写的栏目行 → kicker，不当作正文句子', () => {
  const doc = docOf([page(1, [
    block('body', [line('ORIGINAL EMPIRICAL RESEARCH', { y: 770, size: 9, w: 210 })]),
    paraBlock(['Demonstrations are everywhere in retail.'], { top: 730 }),
  ])]);
  assert.equal(doc.blocks[0].kind, 'kicker');
  assert.equal(doc.blocks[0].level, 0, 'kicker 不参与标题分级');
});

test('粗体作者行 → authors（被大间隙切开的另一半也归为 authors，而不是小节标题）', () => {
  const doc = docOf([page(1, [
    block('heading', [line('Christine Ringler· Nancy J. Sirianni· Joann Peck', { x: 50, y: 700, size: 10, w: 300 })], { bold: true }),
    block('heading', [line('Anders Gustafsson', { x: 380, y: 700, size: 10, w: 120 })], { bold: true }),
    paraBlock(['Product demonstrations are powerful promotional tools'], { top: 660 }),
  ])]);
  const authors = doc.blocks.filter((b) => b.kind === 'authors');
  assert.equal(authors.length, 1, '两半应合成一行 authors');
  const text = authors[0].lines.flatMap((l) => l.runs.map((r) => r[2])).join(' ');
  assert.match(text, /Christine Ringler/);
  assert.match(text, /Anders Gustafsson/);
  assert.equal(doc.blocks.filter((b) => b.level > 0).length, 0, '作者行不是标题');
});

// ---------------- 附录 ----------------

test('附录里的量表条目不会被当成小节标题（整段附录变一片加粗）', () => {
  const doc = docOf([page(1, [
    block('heading', [line('Appendix 1 Scales', { y: 700, size: 12, w: 120 })]),
    block('heading', [line('1. I become angry when my options are limited', { y: 676, size: 10, w: 300 })]),
    block('heading', [line('2. I could picture myself in the scenario', { y: 661, size: 10, w: 300 })]),
    block('heading', [line('3. I was mentally involved while watching', { y: 646, size: 10, w: 300 })]),
    block('heading', [line('Appendix 2 Measures', { y: 620, size: 12, w: 140 })]),
  ])]);
  const heads = doc.blocks.filter((b) => b.level > 0).map((b) => textsOf(b).join(''));
  assert.deepEqual(heads, ['Appendix 1 Scales', 'Appendix 2 Measures'],
    '同字号/更大的才是附录小节标题，条目要当正文');
});

test('正文里的编号小节（3.1 Sample）不受附录规则影响', () => {
  const doc = docOf([page(1, [
    block('body', [line('3.1 Sample', { y: 760, size: 12, w: 70 })]),
    paraBlock(['We surveyed 412 consumers across three studies.'], { top: 730 }),
  ])]);
  assert.equal(doc.blocks[0].level > 0, true);
});

// ---------------- 整页图形兜底 ----------------

test('整页图形（描边画的框架图，只有几个零散标签）按整页裁图保留，不让这页消失', () => {
  const doc = docOf([page(1, [
    block('body', [line('A label inside the diagram', { y: 300, size: 9, w: 120 })]),
  ], { rawItems: 120 })]);
  const crops = doc.blocks.filter((b) => b.t === 'crop');
  assert.equal(crops.length, 1, '应该补一张整页裁图');
  assert.equal(crops[0].full, true);
});

test('正常正文页不会平白多出一张整页裁图', () => {
  const doc = docOf([page(1, [
    paraBlock([
      'Product demonstrations are powerful promotional tools which can vary in how they present',
      'information to consumers, and the process mindset literature suggests that the effect runs',
      'through the process of imagining the product in use rather than through the outcome alone.',
    ]),
  ], { rawItems: 120 })]);
  assert.equal(doc.blocks.filter((b) => b.t === 'crop').length, 0);
});

// ---------------- 链接（重排后仍可点） ----------------

test('链接注记把片段切开，run 带 url，拼回去仍是原句', () => {
  const text = 'see https://example.org/paper for details';
  const x = 50;
  const w = 200;
  const size = 10;
  const perChar = w / text.length;
  // 只给 URL 那一段挂链接注记（x/w 与真实字符位置对齐）
  const from = text.indexOf('https');
  const to = text.indexOf(' for');
  const link = {
    x0: x + from * perChar,
    x1: x + to * perChar,
    y0: 690, y1: 702,
    url: 'https://example.org/paper',
  };
  const lineObj = line(text, { x, y: 695, size, w });
  lineObj.items = [{ text, x, w, y: 695, size }];
  const p = page(1, [block('body', [lineObj])], { links: [link] });
  const doc = docOf([p]);
  const runs = doc.blocks[0].lines[0].runs;
  assert.equal(runs.map((r) => r[2]).join(''), text, '切段不能丢字或改字');
  const linked = runs.filter((r) => r.length >= 5 && r[4]);
  assert.equal(linked.length, 1, '只有 URL 那一段带链接');
  assert.equal(linked[0][4], 'https://example.org/paper');
  assert.equal(linked[0][2], 'https://example.org/paper', '链接文字被完整切出来');
});

test('没有链接注记时 run 保持三元组（不凭空多出字段）', () => {
  const doc = docOf([page(1, [paraBlock(['plain body text without any anchors'])])]);
  for (const r of doc.blocks[0].lines[0].runs) assert.equal(r.length, 3);
});

// ---------------- 出版商封面 / 跨栏断句 ----------------

test('期刊封面：刊眉与出版商徽记不进重排，论文标题保留', () => {
  const p = page(1, [
    block('body', [line('InternationalJournalofProductionEconomics', { y: 780, size: 16 })]),
    block('body', [line('journal homepage: www.elsevier.com/locate/ije', { y: 760, size: 9 })]),
    block('title', [line('Information fusion in consumer complaints', { y: 720, size: 18 })]),
  ], { images: [{ x0: 40, y0: 120, x1: 560, y1: 700 }] });
  const doc = docOf([p]);
  const text = doc.blocks.filter((b) => b.t === 'text').flatMap(textsOf).join(' ');
  assert.match(text, /Information fusion in consumer complaints/, '论文标题必须留下');
  assert.ok(!text.includes('elsevier') && !text.includes('InternationalJournalof'), '刊眉要剔除');
  assert.equal(doc.blocks.filter((b) => b.t === 'crop').length, 0, '出版商徽记不该裁成插图');
});

test('带图注的真插图不会因为面积大被当成封面装饰', () => {
  const p = page(2, [
    paraBlock(['a normal body paragraph with plenty of words in this page']),
    block('caption', [line('Figure 3. The proposed framework', { y: 300, size: 9 })]),
  ], { images: [{ x0: 40, y0: 330, x1: 560, y1: 700 }] });
  const doc = docOf([p]);
  assert.ok(doc.blocks.some((b) => b.t === 'crop'), '论文插图要保留');
});

test('跨页断句：连字符自动接合，并记录译文回分比例', () => {
  const p1 = page(1, [block('body', [line('we observe a con-', { y: 700, size: 10, w: 180 })])]);
  const p2 = page(2, [block('body', [line('stantly evolving patterns', { y: 700, size: 10, w: 220 })])]);
  const doc = docOf([p1, p2]);
  assert.equal(doc.blocks.length, 1, '两截要拼成同一个段落');
  const b = doc.blocks[0];
  assert.equal(b.parts.length, 2, '要记下两处来源');
  assert.equal(b.parts[0].page, 1);
  assert.equal(b.parts[1].page, 2);
  assert.ok(Math.abs(b.parts.reduce((n, p) => n + p.ratio, 0) - 1) < 0.001);
  assert.ok(textsOf(b).join('').includes('constantly'), '跨页断词要接合');
});

// ---------------- 出版商装饰剔除 ----------------

test('Elsevier 首页：刊头刊名 / 刊眉 / 版权行 / 页眉卷期行都不进重排，只从论文标题开始', () => {
  const p = page(1, [
    block('body', [line('Tourism Management 110 (2025) 105182', { y: 780, size: 9, w: 220 })]),
    block('body', [line('Contents lists available at ScienceDirect', { y: 762, size: 8, w: 260 })]),
    block('title', [line('Tourism Management', { y: 744, size: 13, w: 170 })]),
    block('body', [line('journal homepage: www.elsevier.com/locate/tourman', { y: 720, size: 9, w: 300 })]),
    block('title', [line('AI-infused video marketing: a study', { y: 690, size: 16, w: 460 })]),
    paraBlock(['Generative AI has become ubiquitous in tourism research.'], { top: 640 }),
    block('body', [line('0261-5177/© 2025 Elsevier Ltd. All rights reserved.', { y: 60, size: 7, w: 300 })]),
  ]);
  const doc = docOf([p]);
  const all = doc.blocks.flatMap(textsOf).join(' ');
  assert.ok(!/elsevier|ScienceDirect|journal homepage|rights reserved|Tourism Management 110/.test(all), `装饰内容漏进来了：${all}`);
  assert.ok(doc.blocks[0].lines[0].runs[0][2].startsWith('AI-infused'), '第一个块必须是论文标题');
});

test('INFORMS 封面页（下载信息 + 版权条款）整页跳过，不把 boilerplate 插进正文', () => {
  const cover = page(1, [
    block('title', [line('Organization Science', { y: 760, size: 16, w: 240 })]),
    block('body', [line('This article was downloaded by: [10.0.0.1]', { y: 700, size: 8, w: 300 })]),
    block('body', [line('Publication details, including instructions for authors', { y: 660, size: 8, w: 340 })]),
    block('body', [line('Full terms and conditions of use: https://pubsonline.informs.org/terms', { y: 620, size: 8, w: 400 })]),
    block('body', [line('To cite this article: Shrestha et al. (2020)', { y: 580, size: 8, w: 300 })]),
  ]);
  const body = page(2, [
    block('title', [line('Algorithm Supported Induction for Building Theory', { y: 700, size: 16, w: 480 })]),
    paraBlock(['Across many fields of social science, machine learning is used.'], { top: 640 }),
  ]);
  const doc = docOf([cover, body]);
  const all = doc.blocks.flatMap(textsOf).join(' ');
  assert.ok(!/downloaded by|Publication details|Full terms|To cite this article/.test(all), `封面页没跳过：${all}`);
  assert.equal(doc.blocks[0].page, 2, '阅读流应从第 2 页开始');
  assert.ok(doc.warnings.some((w) => /出版商信息页/.test(w)), '要给出跳过提示');
});

test('正文段落里的 URL 不被当成出版商装饰', () => {
  const p = page(1, [paraBlock([
    'The dataset is documented at https://example.org/paper and can be downloaded',
    'from the project homepage after registration.',
  ], { top: 600 })]);
  const doc = docOf([p]);
  assert.equal(doc.blocks.length, 1);
  assert.ok(textsOf(doc.blocks[0]).join('').includes('example.org'), '带 URL 的正文必须保留');
});

test('大字号全大写刊名 masthead 剔除，小字号全大写栏目行（kicker）保留', () => {
  const p = page(1, [
    block('body', [line('ORGANIZATION SCIENCE', { y: 780, size: 12, w: 260 })]),
    block('body', [line('ORIGINAL EMPIRICAL RESEARCH', { y: 755, size: 7, w: 200 })]),
    block('title', [line('A Real Paper Title', { y: 700, size: 16, w: 300 })]),
    paraBlock(['Body text that should survive the filter.'], { top: 650 }),
  ]);
  const doc = docOf([p]);
  const all = doc.blocks.flatMap(textsOf).join(' ');
  assert.ok(!all.includes('ORGANIZATION SCIENCE'), '刊名 masthead 应剔除');
  assert.ok(all.includes('ORIGINAL EMPIRICAL RESEARCH'), 'kicker 不是刊名，要保留');
  assert.ok(all.includes('A Real Paper Title'));
});
