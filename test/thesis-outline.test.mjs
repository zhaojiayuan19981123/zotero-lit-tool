// thesis-outline.test.mjs —— 学位论文章节识别的单测
//
// 这是「长上下文」的地基：章节树既是书签栏，也是检索时标页码的依据，
// 识别错了会让回答里的出处全都不准，所以三级兜底每条都要有一条测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanTitle, detectLevel, looksLikeHeading, flattenBookmarks, tocLineScore,
  findTocPages, parseTocEntries, guessHeadings, normalizeEntries, finalizeOutline,
  buildOutline, toTree, chapterAt, outlineToText, outlineSignature,
} from '../src/thesisOutline.js';

test('cleanTitle 去掉点线、行尾页码与多余空白', () => {
  assert.equal(cleanTitle('第一章  绪论 ......... 1'), '第一章 绪论');
  assert.equal(cleanTitle('1.1 研究背景 …… 3'), '1.1 研究背景');
  assert.equal(cleanTitle('  摘要   '), '摘要');
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle(null), '');
  // 标题里的数字是内容，不能被当成页码剥掉
  assert.equal(cleanTitle('3.2 计划行为理论'), '3.2 计划行为理论');
});

test('detectLevel 按形态判层级', () => {
  assert.equal(detectLevel('第三章 研究设计'), 1);
  assert.equal(detectLevel('参考文献'), 1);
  assert.equal(detectLevel('Abstract'), 1);
  assert.equal(detectLevel('3.1 研究假设'), 2);
  assert.equal(detectLevel('3.1.2 变量测量'), 3);
  assert.equal(detectLevel('3.1.2.1 量表来源'), 4);
});

test('looksLikeHeading 过滤正文噪音', () => {
  assert.equal(looksLikeHeading('第二章 文献综述'), true);
  assert.equal(looksLikeHeading('本研究采用问卷调查法收集数据。'), false); // 句号结尾
  assert.equal(looksLikeHeading('图 3-1 研究模型'), false);              // 图表目录
  assert.equal(looksLikeHeading('表 4.2 描述性统计'), false);
});

test('flattenBookmarks 展开嵌套书签并记录层级', () => {
  const flat = flattenBookmarks([
    {
      title: '第一章 绪论', page: 1,
      items: [
        { title: '1.1 研究背景', page: 2, items: [{ title: '1.1.1 问题提出', page: 3 }] },
        { title: '1.2 研究意义', page: 4 },
      ],
    },
    { title: '第二章 文献综述', page: 10 },
  ]);
  assert.deepEqual(flat.map((x) => [x.title, x.page, x.level]), [
    ['第一章 绪论', 1, 1], ['1.1 研究背景', 2, 2], ['1.1.1 问题提出', 3, 3],
    ['1.2 研究意义', 4, 2], ['第二章 文献综述', 10, 1],
  ]);
});

test('flattenBookmarks 跳过没有页码的节点但不丢它的子节点', () => {
  const flat = flattenBookmarks([
    { title: '无页码分组', page: null, items: [{ title: '第一章 绪论', page: 5 }] },
  ]);
  assert.deepEqual(flat.map((x) => x.title), ['第一章 绪论']);
});

test('tocLineScore 只数带页码的目录行', () => {
  const text = [
    '目录',
    '第一章 绪论 .............. 1',
    '1.1 研究背景 .............. 2',
    '本研究采用问卷调查法。',
  ].join('\n');
  assert.equal(tocLineScore(text), 2);
});

test('findTocPages 找到目录页并能跨页', () => {
  const pages = [
    { page: 1, text: '北京大学硕士学位论文' },
    { page: 2, text: '目 录\n第一章 绪论 ....... 1\n1.1 研究背景 ....... 2\n1.2 研究意义 ....... 4\n第二章 文献综述 ....... 10' },
    { page: 3, text: '2.1 计划行为理论 ....... 12\n2.2 感知价值 ....... 15\n第三章 研究设计 ....... 20' },
    { page: 4, text: '第三章 研究设计\n本研究采用问卷调研。' },
  ];
  assert.deepEqual(findTocPages(pages), [2, 3]);
});

test('parseTocEntries 解析目录行并丢掉正文噪音', () => {
  const entries = parseTocEntries([
    '第一章 绪论 ................ 1',
    '1.1 研究背景 ................ 2',
    '本文认为短视频的沉浸感会影响购买意愿。 12', // 句号结尾 → 噪音
    '图 2-1 研究模型 ............. 18',          // 图表目录 → 不要
    '参考文献 ................... 88',
  ].join('\n'));
  assert.deepEqual(entries.map((e) => [e.title, e.page, e.level]), [
    ['第一章 绪论', 1, 1], ['1.1 研究背景', 2, 2], ['参考文献', 88, 1],
  ]);
});

test('guessHeadings 从每页页首取标题', () => {
  const pages = [
    { page: 1, text: '北京大学硕士学位论文\n第一章 绪论\n本研究关注……' },
    { page: 5, text: '这是一段普通的正文，没有任何标题。' },
    { page: 9, text: '第二章 文献综述\n已有研究主要分为两支……' },
  ];
  const hs = guessHeadings(pages);
  assert.deepEqual(hs.map((h) => [h.title, h.page]), [['第一章 绪论', 1], ['第二章 文献综述', 9]]);
});

test('guessHeadings 跳过目录页（否则目录会被当成正文标题）', () => {
  const pages = [{ page: 2, text: '目录\n第一章 绪论 ...... 1\n1.1 研究背景 ...... 2' }];
  assert.equal(guessHeadings(pages, { skipPages: new Set([2]) }).length, 0);
});

test('normalizeEntries 夹紧越界页码并去重', () => {
  const out = normalizeEntries([
    { title: '超界章', page: 999, level: 1 },
    { title: '第一章 绪论', page: 1, level: 1 },
    { title: '第一章 绪论', page: 1, level: 1 },
  ], 50);
  assert.equal(out.length, 2);
  assert.equal(out[0].page, 1);
  assert.equal(out[1].page, 50); // 999 夹到最后一页，而不是丢掉
});

test('finalizeOutline 计算 endPage 并给出稳定 id', () => {
  const out = finalizeOutline([
    { title: '第一章', page: 1, level: 1 },
    { title: '第二章', page: 20, level: 1 },
    { title: '第三章', page: 40, level: 1 },
  ], 60);
  assert.deepEqual(out.map((x) => [x.id, x.page, x.endPage]), [
    ['c1', 1, 19], ['c2', 20, 39], ['c3', 40, 60],
  ]);
});

test('buildOutline 优先级：内嵌书签 > 目录页 > 标题启发式 > 每10页兜底', () => {
  const pages = [
    { page: 1, text: '目 录\n第一章 绪论 ....... 1\n1.1 研究背景 ....... 2\n1.2 研究意义 ....... 3\n第二章 文献综述 ....... 8' },
    { page: 2, text: '第一章 绪论\n正文……' },
  ];
  const bookmarks = [
    { title: '第一章 绪论', page: 1, level: 1 },
    { title: '1.1 研究背景', page: 2, level: 2 },
    { title: '第二章 文献综述', page: 8, level: 1 },
  ];
  assert.equal(buildOutline({ pages, bookmarks, totalPages: 40 }).source, 'bookmark');
  // 书签不足 3 条时退到目录页
  assert.equal(buildOutline({ pages, bookmarks: [bookmarks[0]], totalPages: 40 }).source, 'toc');
  // 没有书签也没有目录页 → 标题启发式
  const noToc = [
    { page: 1, text: '第一章 绪论\n正文' },
    { page: 6, text: '第二章 文献综述\n正文' },
    { page: 12, text: '第三章 研究设计\n正文' },
  ];
  assert.equal(buildOutline({ pages: noToc, bookmarks: [], totalPages: 30 }).source, 'heading');
  // 什么都没有 → 每 10 页一块，保证书签栏不空
  const flat = buildOutline({ pages: [{ page: 1, text: '只有正文' }], bookmarks: [], totalPages: 25 });
  assert.equal(flat.source, 'fallback');
  assert.deepEqual(flat.items.map((x) => [x.page, x.endPage]), [[1, 10], [11, 20], [21, 25]]);
});

test('toTree 按 level 嵌套', () => {
  const items = finalizeOutline([
    { title: '第一章 绪论', page: 1, level: 1 },
    { title: '1.1 研究背景', page: 2, level: 2 },
    { title: '1.1.1 问题提出', page: 3, level: 3 },
    { title: '1.2 研究意义', page: 5, level: 2 },
    { title: '第二章 文献综述', page: 10, level: 1 },
  ], 30);
  const tree = toTree(items);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].children[0].children.length, 1);
  assert.equal(tree[0].children[0].children[0].title, '1.1.1 问题提出');
});

test('chapterAt 命中页码所在的最深章节，并处理边界', () => {
  const items = finalizeOutline([
    { title: '第一章 绪论', page: 1, level: 1 },
    { title: '1.1 研究背景', page: 2, level: 2 },
    { title: '第二章 文献综述', page: 10, level: 1 },
  ], 30);
  assert.equal(chapterAt(items, 1).title, '第一章 绪论');
  assert.equal(chapterAt(items, 3).title, '1.1 研究背景', '落在子章节里要取更深的那个');
  assert.equal(chapterAt(items, 9).title, '1.1 研究背景');
  assert.equal(chapterAt(items, 10).title, '第二章 文献综述');
  assert.equal(chapterAt(items, 30).title, '第二章 文献综述', '最后一章要覆盖到末页');
  // 页码越界不该发生（前端传的是真实页号），但要兜住而不是抛错
  assert.equal(chapterAt(items, 999)?.title, '第一章 绪论', '越界时回落到第一条');
});

test('outlineToText 输出带页码的缩进目录', () => {
  const items = finalizeOutline([
    { title: '第一章 绪论', page: 1, level: 1 },
    { title: '1.1 研究背景', page: 2, level: 2 },
  ], 30);
  const text = outlineToText(items);
  assert.match(text, /- 第一章 绪论（p\.1）/);
  assert.match(text, /  - 1\.1 研究背景（p\.2）/);
});

test('outlineSignature 在结构变化时变化（决定索引要不要重建）', () => {
  const a = finalizeOutline([{ title: '第一章', page: 1, level: 1 }], 10);
  const b = finalizeOutline([{ title: '第一章', page: 1, level: 1 }, { title: '第二章', page: 5, level: 1 }], 10);
  assert.notEqual(outlineSignature(a), outlineSignature(b));
  assert.equal(outlineSignature(a), outlineSignature(finalizeOutline([{ title: '第一章', page: 1, level: 1 }], 10)));
});
