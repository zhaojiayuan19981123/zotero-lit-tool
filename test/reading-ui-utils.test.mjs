// reading-ui-utils.test.mjs —— 阅读热力 + 对照精读工具（浏览器 IIFE 的纯逻辑）
//
// 用最小 DOM / localStorage 替身加载 public/*.js，只验证不依赖真实页面的那部分：
// 前台判定、按页聚合、展示模式、译文本地缓存、断句组与回分、对照笔记。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.window = globalThis;
globalThis.document = {
  visibilityState: 'visible',
  hasFocus: () => true,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.fetch = async () => ({ ok: true });

const heat = await import('../public/reading-heat.js');
const cmp = await import('../public/compare-utils.js');
const H = globalThis.ReadingHeat;
const CU = globalThis.CompareUtils;

test('阅读热力：仅窗口前台时才计时', () => {
  assert.equal(H.isForeground(), true);
  document.visibilityState = 'hidden';
  assert.equal(H.isForeground(), false, '切到别的标签一律停表');
  document.visibilityState = 'visible';
  document.hasFocus = () => false;
  assert.equal(H.isForeground(), false, '窗口失焦也停表');
  document.hasFocus = () => true;
  assert.equal(H.isForeground(), true);
});

test('阅读热力：按页聚合、时长格式化、热力分档', () => {
  H.sync([{ id: 'L1', readingHeat: { pages: { 1: 90, 2: 12, 5: 700 }, total: 802, updatedAt: Date.now() } }]);
  assert.equal(H.total('L1'), 802);
  assert.equal(H.heatOf('L1').pages[5], 700);
  assert.equal(H.format(45), '45秒');
  assert.equal(H.format(125), '2分5秒');
  assert.ok(H.format(3700).startsWith('1小时'));
  assert.equal(H.level(0), 0);
  assert.ok(H.level(1000) > H.level(60));
});

test('阅读热力：服务端与本地离线缓存取较大值，不会被覆盖成 0', () => {
  H.sync([{ id: 'L2', readingHeat: { pages: { 1: 10 }, total: 10, updatedAt: 1 } }]);
  const h = H.heatOf('L2');
  h.pages[1] = 42;
  H.sync([{ id: 'L2', readingHeat: { pages: { 1: 10 }, total: 10, updatedAt: 2 } }]);
  assert.equal(H.heatOf('L2').pages[1], 42);
});

test('阅读热力：标题底色 / 独立成列两种展示可切换', () => {
  H.setMode('both');
  assert.ok(H.titleStyle('L1').includes('background'));
  assert.ok(H.cellHtml({ id: 'L1' }).includes('heat-bar'));
  H.setMode('column');
  assert.equal(H.titleStyle('L1'), '');
  H.setMode('title');
  assert.ok(H.titleStyle('L1').includes('background'));
  assert.ok(H.cellHtml({ id: 'L1' }).includes('heat-hidden'));
  H.setMode('both');
});

test('热力条按页着色，每一格都有页号提示', () => {
  const bar = H.barHtml('L1');
  assert.ok(bar.includes('heat-tick'));
  assert.ok(bar.includes('第 5 页'));
});

test('热力分档按「本篇最久的一页」相对着色：短时间阅读也有颜色', () => {
  // 只读了半分钟：原来一律落在最浅一档（整列看着是灰的）
  assert.ok(H.level(5, 5) >= 1, '有停留就至少上色');
  assert.equal(H.level(0, 5), 0, '没读过的一格保持空');
  // 同一篇里最久的一页一定是最热的红/橙档
  assert.equal(H.level(600, 600), 5);
  assert.ok(H.level(60, 600) >= 1 && H.level(60, 600) <= 3);
  // 但整篇只读了几秒时，别一上来就烧红
  assert.ok(H.level(3, 3) <= 2);
});

test('译文缓存在本地，重新加载模块后仍能命中', async () => {
  const text = 'the demonstration together, or demonstrators might invite';
  CU.cacheSet(text, 'zh', 'volcweb', '', '这次演示，或者演示者可能会邀请');
  assert.equal(CU.cacheGet(text, 'zh', 'volcweb', ''), '这次演示，或者演示者可能会邀请');
  const again = await import('../public/compare-utils.js?reload=1');
  assert.equal(globalThis.CompareUtils.cacheGet(text, 'zh', 'volcweb', ''),
    '这次演示，或者演示者可能会邀请', '再次打开这篇不用重新请求');
  assert.ok(again);
});

test('被截断的段落整组拼接，连字符自动接合，按原文长度回分', () => {
  const j = CU.joinParts([
    { id: 'a', text: 'We observe that the effect is con-' },
    { id: 'b', text: 'stantly present in both columns and pages' },
  ]);
  assert.match(j.text, /constantly/);
  assert.equal(j.items.length, 2);
  assert.ok(j.weights[0] < j.weights[1]);
  const back = CU.splitByWeights('我们观察到该效应在两栏和跨页中都持续存在并且十分明显。', j.weights);
  assert.equal(back.length, 2);
  assert.ok(back[1].length > back[0].length);
});

test('断句组识别：句末标点断开，栏底/页尾续写合组', () => {
  const blocks = [
    { id: 'a', text: 'We observe that the demonstration together,', page: 1, kind: 'body', translatable: true },
    { id: 'b', text: 'or demonstrators might invite more people to join.', page: 1, kind: 'body', translatable: true },
    { id: 'c', text: 'Another paragraph starts here and ends.', page: 2, kind: 'body', translatable: true },
    { id: 'd', text: '1. Introduction', page: 2, kind: 'heading', translatable: true },
  ];
  const groups = CU.splitGroups(blocks);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], ['a', 'b']);
});

test('逐句配对只改显示，导出笔记包含原文引用与译文', () => {
  CU.setPairMode('sentence');
  const html = CU.translationHtml('A. B.', '甲。乙。');
  assert.ok(html.includes('cmp-pair-src') && html.includes('cmp-pair-tr'));
  const note = CU.buildNote([{ page: 1, kind: 'body', text: 'A. B.', translation: '甲。乙。' }],
    CU.getPairMode(), '测试文献');
  assert.ok(note.includes('逐句'));
  assert.ok(note.includes('> A.') && note.includes('甲。'));
  CU.setPairMode('para');
  assert.ok(!CU.translationHtml('A. B.', '甲。乙。').includes('cmp-pair-src'));
});
