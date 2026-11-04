// reading-layout-signals.test.mjs —— 分栏三信号 / 旋转文字 / 悬挂缩进的单测
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectColumnSplit, gutterCandidates, columnStartClusters, evaluateColumnSplit,
  groupIntoLines, buildBlocks,
} from '../src/pdfTranslate/analyze.js';

const PAGE = { x0: 0, y0: 0, x1: 600, y1: 800, width: 600, height: 800 };
const BODY = 'a sufficiently long line of running text in this column';

/** 造一行（groupIntoLines 的输出形态） */
function row(x0, x1, baseline, extra = {}) {
  return {
    text: BODY, x0, x1, baseline, spread: false, size: 10,
    top: baseline + 8, bottom: baseline - 2,
    bold: false, italic: false, serif: true,
    items: [{ text: BODY, x: x0, w: x1 - x0 }],
    ...extra,
  };
}

/** 双栏页：左右基线故意错开 6pt，右栏起点稳定，左栏行尾参差 */
function twoColumnLines(count = 18, { ragged = false, crossTitle = false } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const y = 740 - i * 12;
    out.push(row(50, ragged ? 270 + (i % 4) * 3 : 285, y));
    out.push(row(315, ragged ? 530 + (i % 3) * 4 : 550, y - 6));
  }
  if (crossTitle) {
    // 横跨整页的标题 / 摘要行：不该把空白通道填满，也不该被拦腰分到两栏
    out.push(row(50, 552, 770, { text: 'A FULL WIDTH TITLE ACROSS BOTH COLUMNS' }));
    out.push(row(50, 552, 758, { text: 'Abstract words spanning the entire page width here' }));
  }
  return out;
}

test('三类信号共同判定双栏，且左右基线不齐时仍成立', () => {
  const lines = twoColumnLines(18, { ragged: true, crossTitle: true });
  const split = detectColumnSplit(lines, PAGE);
  assert.ok(split !== null, '必须判出双栏');
  assert.ok(split > 260 && split < 340, `栏缝应落在页面中间，实际 ${split}`);
  // 三类信号都能单独给出证据
  const body = lines.filter((l) => !l.spread && (l.x1 - l.x0) < PAGE.width * 0.62);
  assert.ok(gutterCandidates(body, PAGE).length >= 1, '空白通道信号');
  assert.ok(columnStartClusters(body, PAGE.width).length >= 2, '栏起始位置信号');
  const ev = evaluateColumnSplit(split, body, PAGE, columnStartClusters(body, PAGE.width));
  assert.ok(ev && ev.signals.vote > 0, '行的投票信号');
  assert.ok(ev.signals.gutter > 0);
  assert.ok(ev.signals.start > 0);
});

test('宽标题横跨整页时不被当成另一栏，双栏仍然判得出', () => {
  const lines = twoColumnLines(18, { crossTitle: true });
  const split = detectColumnSplit(lines, PAGE);
  assert.ok(split !== null);
  assert.ok(split > 260 && split < 340);
});

test('单栏页不会被误判成双栏', () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(row(50, 550, 740 - i * 12));
  assert.equal(detectColumnSplit(lines, PAGE), null);
});

test('旋转排版的文字不参与聚行（arXiv 页边竖排编号）', () => {
  const item = (text, angle, x, y, w = 80) => ({
    text, angle, x, y, w, size: 10, ascent: 0.82, descent: -0.22,
    bold: false, italic: false, serif: true, family: 'serif', eol: false,
  });
  const lines = groupIntoLines([
    item('arXiv:2401.01234v2 [cs.LG] 3 Jan 2024', Math.PI / 2, 12, 400),
    item('a normal horizontal line of running text', 0, 60, 700, 220),
    item('another normal horizontal line of text', 0, 60, 688, 210),
  ], { maxGapEm: 1.2 });
  const joined = lines.map((l) => l.text).join(' ');
  assert.ok(joined.includes('normal horizontal'));
  assert.ok(!joined.includes('arXiv'), '旋转文字不应进入横排行');
});

test('编号列表的悬挂缩进不会被误判成新段落', () => {
  const mk = (text, x0, y) => ({
    text, x0, x1: 540, top: y + 10, bottom: y, baseline: y + 2, size: 10,
    spread: false, bold: false, italic: false, serif: true, items: [],
  });
  const lines = [
    mk('1. First item of the numbered list starts here', 50, 700),
    mk('continuation line indented under the marker', 70, 686),
    mk('still the same numbered item continues', 70, 672),
    mk('2. Second item starts a new block', 50, 658),
  ];
  const blocks = buildBlocks(lines, PAGE, 'L');
  assert.equal(blocks.length, 2, `应合并为 2 个列表项，实际 ${blocks.length}`);
  assert.equal(blocks[0].lines.length, 3, '第一项的 3 行要连在一起');
  assert.equal(blocks[1].lines.length, 1);
});
