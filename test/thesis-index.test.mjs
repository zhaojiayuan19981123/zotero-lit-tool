// thesis-index.test.mjs —— 分块、分词、BM25 检索的单测
//
// 索引层决定「AI 到底看到了论文的哪几段」，是长文档问答能不能答准的关键，
// 所以分词、召回、序列化往返都要钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize, splitBlocks, chunkPages, buildIndex, search, chunksOfChapter,
  serializeIndex, deserializeIndex,
} from '../src/thesisIndex.js';
import { finalizeOutline } from '../src/thesisOutline.js';

function makeOutline() {
  return finalizeOutline([
    { title: '第一章 绪论', page: 1, level: 1 },
    { title: '第二章 文献综述', page: 5, level: 1 },
    { title: '第三章 研究设计', page: 9, level: 1 },
  ], 12);
}

const PAGES = [
  { page: 1, text: '第一章 绪论\n本研究关注短视频平台的沉浸式体验与消费者购买意愿之间的关系。' },
  { page: 2, text: '研究问题包括三个子问题，分别涉及平台特性、用户感知与购买决策路径。' },
  { page: 5, text: '第二章 文献综述\n计划行为理论认为行为意向由态度、主观规范与知觉行为控制共同决定。' },
  { page: 6, text: '感知价值理论强调消费者对收益与成本的综合权衡过程。' },
  { page: 9, text: '第三章 研究设计\n本研究采用问卷调查法，有效样本量为 520 份，覆盖三个城市。' },
  { page: 10, text: '问卷包含 32 个测量题项，均采用李克特七点量表进行测量。' },
  { page: 11, text: '数据通过结构方程模型进行分析，使用 AMOS 软件完成估计。' },
  { page: 12, text: '本章小结：研究设计遵循实证研究的规范流程与检验标准。' },
];

function makeIndex() {
  const outline = makeOutline();
  return { outline, index: buildIndex(chunkPages(PAGES, outline)) };
}

test('tokenize 中文切 2-gram 并保留短词整块', () => {
  const tokens = tokenize('问卷调查');
  assert.ok(tokens.includes('问卷'));
  assert.ok(tokens.includes('卷调'));
  assert.ok(tokens.includes('调查'));
  assert.ok(tokens.includes('问卷调查'), '2-6 字的短词整块保留，提升术语精确命中');
});

test('tokenize 英文转小写并去停用词', () => {
  const tokens = tokenize('The AMOS Model and the SEM');
  assert.ok(tokens.includes('amos'));
  assert.ok(tokens.includes('model'));
  assert.ok(tokens.includes('sem'));
  assert.equal(tokens.includes('the'), false);
  assert.equal(tokens.includes('and'), false);
});

test('tokenize 丢掉纯停用字组成的 bigram', () => {
  // 「的研」不在停用字表里（研是实字），但「的了」应该被丢掉
  assert.equal(tokenize('的了').includes('的了'), false);
  assert.ok(tokenize('研究').includes('研究'));
});

test('splitBlocks 把长文本切到 ~size 字并合并碎片块', () => {
  const long = Array.from({ length: 30 }, (_, i) => `这是第${i}句用于填充长度的说明文字，保证总长度足够被切开。`).join('');
  const blocks = splitBlocks(long, { size: 300, minSize: 100 });
  assert.ok(blocks.length >= 2);
  for (const b of blocks.slice(0, -1)) assert.ok(b.length <= 300 * 1.5);
  // 尾块不该碎成一行
  assert.ok(blocks[blocks.length - 1].length >= 50);
});

test('chunkPages 给每块标上页码与所属章节', () => {
  const chunks = chunkPages(PAGES, makeOutline());
  assert.equal(chunks.length, PAGES.length, '每页一段文本 → 每页一个块');
  const p5 = chunks.find((c) => c.page === 5);
  assert.equal(p5.chapterTitle, '第二章 文献综述');
  const p9 = chunks.find((c) => c.page === 9);
  assert.equal(p9.chapterTitle, '第三章 研究设计');
});

test('buildIndex 产出倒排表与长度统计', () => {
  const { index } = makeIndex();
  assert.equal(index.N, PAGES.length);
  assert.equal(index.lens.length, PAGES.length);
  assert.ok(index.avgLen > 0);
  assert.ok(index.postings.size > 0);
});

test('search 中文提问能命中正确的那一页', () => {
  const { index } = makeIndex();
  const hits = search(index, '计划行为理论是什么', { topK: 3 });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].chunk.page, 5, '「计划行为理论」出现在第 5 页');

  const hits2 = search(index, '样本量是多少', { topK: 3 });
  assert.equal(hits2[0].chunk.page, 9);

  const hits3 = search(index, '沉浸式体验', { topK: 3 });
  assert.equal(hits3[0].chunk.page, 1);
});

test('search 对无关提问返回空或低分命中', () => {
  const { index } = makeIndex();
  assert.deepEqual(search(index, '量子纠缠与超导磁体', { topK: 3 }), []);
  assert.deepEqual(search(index, '', { topK: 3 }), []);
  assert.deepEqual(search(index, '   ', { topK: 3 }), []);
});

test('search 分数按相关度降序', () => {
  const { index } = makeIndex();
  const hits = search(index, '研究设计问卷', { topK: 8 });
  for (let i = 1; i < hits.length; i += 1) assert.ok(hits[i - 1].score >= hits[i].score);
});

test('buildIndex 丢弃 df 过高的词（idf≈0，只占体积）', () => {
  // 构造 10 个块，「研究」出现在每一块 → df=10，应被丢弃
  const chunks = Array.from({ length: 10 }, (_, i) => ({
    i, page: i + 1, chapterId: 'c1', chapterTitle: '章', text: `研究内容${i} 研究讨论 独特词${i}`,
  }));
  const idx = buildIndex(chunks);
  assert.equal(idx.postings.has('研究'), false);
  assert.ok(idx.postings.size > 0, '其它词要保留');
});

test('chunksOfChapter 取该章的首尾中取样，且全部属于该章', () => {
  const { index } = makeIndex();
  const list = chunksOfChapter(index, 'c2', { limit: 2 });
  assert.ok(list.length >= 1);
  for (const c of list) assert.equal(c.chapterId, 'c2');
  assert.equal(chunksOfChapter(index, '不存在的章').length, 0);
});

test('serializeIndex / deserializeIndex 往返后仍能检索', () => {
  const { index } = makeIndex();
  const round = deserializeIndex(JSON.parse(JSON.stringify(serializeIndex(index))));
  assert.ok(round);
  assert.equal(round.N, index.N);
  assert.equal(round.chunks.length, index.chunks.length);
  const hits = search(round, '计划行为理论', { topK: 1 });
  assert.equal(hits[0].chunk.page, 5, '落盘再读回，检索结果必须一致');
});

test('deserializeIndex 对脏数据返回 null 而不是崩溃', () => {
  assert.equal(deserializeIndex(null), null);
  assert.equal(deserializeIndex({}), null);
  assert.equal(deserializeIndex({ chunks: '不是数组' }), null);
});

test('空索引不炸', () => {
  const idx = buildIndex([]);
  assert.equal(idx.N, 0);
  assert.deepEqual(search(idx, '任何问题'), []);
  assert.deepEqual(chunksOfChapter(idx, 'c1'), []);
});
