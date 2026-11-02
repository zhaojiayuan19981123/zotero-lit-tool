// reading-ai.test.mjs —— 「AI 精修」补丁层（src/readingAi.js）的单测
//
// 这一层是模型输出与结构树之间唯一的闸门：模型只准回答「改类别 / 改层级 / 合并相邻块」，
// 正文一个字都不交给它写。所以这里测的不是「模型准不准」（那由 e2e 看实际 PDF 效果），
// 而是「模型说错话时会不会把文档弄坏」——
//   · 标题被说成脚注 → 拒绝
//   · 不相邻的两块被要求合并 → 拒绝（否则会把相隔十页的段落缝在一起）
//   · 正文文字被改动 → 不可能（补丁里没有文本字段）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePatch, applyPatch } from '../src/readingAi.js';

/** 一个文字块（与 toReadingDoc 的节点同形，只保留这层用到的字段） */
function node(id, kind, { page = 1, level = 0, text = 'body text', y = 100 } = {}) {
  return {
    id,
    t: 'text',
    kind,
    level,
    page,
    size: 10,
    rect: [50, y, 300, y + 10],
    lines: [{ p: page, x0: 50, x1: 300, y0: y, y1: y + 10, s: 10, runs: [[50, 250, text, 0]] }],
    _text: text,
  };
}

function docOf(blocks, stats = {}) {
  return {
    v: 3,
    blocks,
    stats: { blocks: blocks.length, headings: 0, footnotes: 0, ...stats },
  };
}

const words = (b) => b.lines.flatMap((l) => (l.runs || []).map((r) => r[2])).join(' ');

// ---------------- parsePatch ----------------

test('parsePatch：从寒暄 + ```json 包裹里抠出 JSON', () => {
  const p = parsePatch('好的，我分析完了：\n```json\n{"footnotes":[3],"headings":[[5,2]],"joins":[[7,8]]}\n```\n以上。');
  assert.deepEqual(p.footnotes, ['3']);
  assert.deepEqual(p.headings, [['5', 2]]);
  assert.deepEqual(p.joins, [['7', '8']]);
});

test('parsePatch：层级被夹到 1..3，形状不对的条目被丢掉', () => {
  const p = parsePatch('{"headings":[[1,0],[2,9],["x"],null],"joins":[["5"],["6","7","8"]]}');
  assert.deepEqual(p.headings, [['1', 1], ['2', 3]]);
  assert.deepEqual(p.joins, [['6', '7']]);
});

test('parsePatch：完全不是 JSON 时返回 null（调用方据此判定这一批失败）', () => {
  assert.equal(parsePatch('抱歉，我无法完成这个任务。'), null);
  assert.equal(parsePatch(''), null);
  assert.equal(parsePatch('{ 这里不是 json }'), null);
});

// ---------------- applyPatch：脚注 ----------------

test('被模型指认为脚注的块移到本页正文之后，正文顺序不变', () => {
  const blocks = [
    node('r1', 'body', { text: 'first paragraph', y: 700 }),
    node('r2', 'body', { text: 'Christine Ringler, University of Alabama', y: 300 }),
    node('r3', 'body', { text: 'second paragraph', y: 660 }),
  ];
  const doc = docOf(blocks);
  const { summary } = applyPatch(doc, [{ footnotes: ['r2'], headings: [], joins: [] }]);
  assert.equal(summary.footnotes, 1);
  assert.deepEqual(doc.blocks.map((b) => b.kind), ['body', 'body', 'footnote']);
  assert.deepEqual(doc.blocks.map(words), ['first paragraph', 'second paragraph', 'Christine Ringler, University of Alabama']);
  assert.equal(doc.stats.footnotes, 1);
});

test('标题 / 图注不会被改成脚注（模型偶尔把小字图注列进来）', () => {
  const blocks = [
    node('r1', 'heading', { level: 2, text: 'Introduction' }),
    node('r2', 'caption', { text: 'Figure 1. A small caption' }),
    node('r3', 'body', { text: 'real prose' }),
  ];
  const doc = docOf(blocks);
  const { summary } = applyPatch(doc, [{ footnotes: ['r1', 'r2'], headings: [], joins: [] }]);
  assert.equal(summary.footnotes, 0);
  assert.deepEqual(doc.blocks.map((b) => b.kind), ['heading', 'caption', 'body']);
  assert.equal(doc.blocks[0].level, 2, '标题层级不能被这次补丁抹掉');
});

test('脚注只落到所属那一页的末尾，不会跑到别的页去', () => {
  const blocks = [
    node('r1', 'body', { page: 1, text: 'p1 a' }),
    node('r2', 'body', { page: 1, text: 'p1 note like', y: 200 }),
    node('r3', 'body', { page: 1, text: 'p1 b' }),
    node('r4', 'body', { page: 2, text: 'p2 a' }),
    node('r5', 'body', { page: 2, text: 'p2 b' }),
  ];
  const doc = docOf(blocks);
  applyPatch(doc, [{ footnotes: ['r2'], headings: [], joins: [] }]);
  assert.deepEqual(doc.blocks.map((b) => b.page), [1, 1, 1, 2, 2]);
  assert.deepEqual(doc.blocks.map((b) => b.kind || 'body'), ['body', 'body', 'footnote', 'body', 'body']);
});

// ---------------- applyPatch：标题 ----------------

test('被指认为标题的块改 kind + level，超过三行的块不认（那是正文段落）', () => {
  const short = node('r1', 'body', { text: 'Abstract' });
  const long = node('r2', 'body', { text: 'a whole paragraph' });
  long.lines = [1, 2, 3, 4].map((i) => ({ p: 1, x0: 50, x1: 300, y0: 700 - i * 12, y1: 710 - i * 12, s: 10, runs: [[50, 250, `line ${i}`]] }));
  const doc = docOf([short, long]);
  const { summary } = applyPatch(doc, [{ footnotes: [], headings: [['r1', 2], ['r2', 2]], joins: [] }]);
  assert.equal(summary.headings, 1);
  assert.equal(doc.blocks[0].level, 2);
  assert.equal(doc.blocks[0].kind, 'heading');
  assert.equal(doc.blocks[1].level, 0, '四行的块不当标题');
  assert.equal(doc.stats.headings, 1);
});

test('已经是该层级的标题不重复计数', () => {
  const doc = docOf([node('r1', 'heading', { level: 2, text: 'Method' })]);
  const { summary } = applyPatch(doc, [{ footnotes: [], headings: [['r1', 2]], joins: [] }]);
  assert.equal(summary.headings, 0);
});

// ---------------- applyPatch：合并 ----------------

test('相邻两块按模型要求合并成一段，rect 取并集，文字一字不丢', () => {
  const a = node('r1', 'body', { text: 'the first half of a sentence', y: 700 });
  const b = node('r2', 'body', { text: 'and the second half of it', y: 640 });
  const doc = docOf([a, b]);
  const { summary } = applyPatch(doc, [{ footnotes: [], headings: [], joins: [['r1', 'r2']] }]);
  assert.equal(summary.joins, 1);
  assert.equal(doc.blocks.length, 1);
  assert.equal(words(doc.blocks[0]), 'the first half of a sentence and the second half of it');
  assert.deepEqual(doc.blocks[0].rect, [50, 640, 300, 710]);
  assert.equal(doc.stats.blocks, 1);
});

test('不相邻的两块要求合并 → 拒绝（防止把相隔很远的段落缝在一起）', () => {
  const doc = docOf([
    node('r1', 'body', { text: 'one' }),
    node('r2', 'body', { text: 'two' }),
    node('r3', 'body', { text: 'three' }),
  ]);
  const { summary } = applyPatch(doc, [{ footnotes: [], headings: [], joins: [['r1', 'r3']] }]);
  assert.equal(summary.joins, 0);
  assert.equal(doc.blocks.length, 3);
});

test('标题 / 脚注不参与合并；同一块被合并两次也不会重复搬行', () => {
  const doc = docOf([
    node('r1', 'heading', { level: 2, text: 'Method' }),
    node('r2', 'body', { text: 'body one' }),
    node('r3', 'body', { text: 'body two' }),
  ]);
  const { summary } = applyPatch(doc, [{ footnotes: [], headings: [], joins: [['r1', 'r2'], ['r2', 'r3'], ['r2', 'r3']] }]);
  assert.equal(summary.joins, 1, '只有 r2→r3 这一次合法');
  assert.equal(doc.blocks.length, 2);
  assert.equal(words(doc.blocks[0]), 'Method');
  assert.equal(words(doc.blocks[1]), 'body one body two');
});

test('模型编造的 id 一律忽略，文档原样返回', () => {
  const doc = docOf([node('r1', 'body', { text: 'only block' })]);
  const { summary } = applyPatch(doc, [
    { footnotes: ['r99'], headings: [['r98', 1]], joins: [['r97', 'r96']] },
  ]);
  assert.deepEqual(summary, { footnotes: 0, headings: 0, joins: 0 });
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].kind, 'body');
});

test('应用后块 id 重新连续编号（前端按 id 建索引）', () => {
  const doc = docOf([
    node('r1', 'body'),
    node('r2', 'body'),
    node('r3', 'body'),
  ]);
  applyPatch(doc, [{ footnotes: [], headings: [], joins: [['r1', 'r2']] }]);
  assert.deepEqual(doc.blocks.map((b) => b.id), ['r1', 'r2']);
});
