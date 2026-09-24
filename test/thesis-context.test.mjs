// thesis-context.test.mjs —— 检索与上下文组装（长上下文方案的核心）单测
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cnToNumber, chapterNumber, matchChapterInQuery, isLocalQuery, retrieve, formatHit,
  buildProfileCard, buildHereSection, buildSystemPrompt, bigPaperSection, trimHistory,
  assembleChatMessages, buildTaskPrompt, buildCompareMessages, normalizeBudget, CONTEXT_PRESETS,
} from '../src/thesisContext.js';
import { buildIndex, chunkPages } from '../src/thesisIndex.js';
import { finalizeOutline } from '../src/thesisOutline.js';

const OUTLINE = finalizeOutline([
  { title: '第一章 绪论', page: 1, level: 1 },
  { title: '第二章 文献综述', page: 5, level: 1 },
  { title: '第三章 研究设计', page: 9, level: 1 },
], 12);

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

const INDEX = buildIndex(chunkPages(PAGES, OUTLINE));

const RECORD = {
  title: '短视频平台对消费者购买意愿的影响研究',
  authors: '张三',
  school: '某某大学',
  degreeType: '硕士',
  year: '2024',
  major: '企业管理',
  supervisor: '李四',
  keywords: '短视频；购买意愿；感知价值',
  summary: '本文以短视频平台为对象，检验沉浸体验对购买意愿的作用机制。',
  method: '问卷调查',
  conclusion: '- 沉浸体验显著正向影响购买意愿',
  innovation: '- 引入感知价值作为中介',
  myThoughts: '这个中介模型可以用在我的第四章',
  // 用户字段不该出现在档案卡里（模型不需要，也避免被改写）
  referenceValue: '高',
};

test('cnToNumber 支持中文数字与阿拉伯数字', () => {
  assert.equal(cnToNumber('三'), 3);
  assert.equal(cnToNumber('十'), 10);
  assert.equal(cnToNumber('十二'), 12);
  assert.equal(cnToNumber('二十三'), 23);
  assert.equal(cnToNumber('4'), 4);
  assert.ok(Number.isNaN(cnToNumber('')));
});

test('chapterNumber 从标题取顶层编号', () => {
  assert.equal(chapterNumber('第三章 研究设计'), 3);
  assert.equal(chapterNumber('第 3 章 研究设计'), 3);
  assert.equal(chapterNumber('3.1 研究假设'), 3);
  assert.equal(chapterNumber('参考文献'), NaN);
});

test('matchChapterInQuery 能听出「第几章」「几节」「固定节名」', () => {
  assert.equal(matchChapterInQuery('第三章讲了什么', OUTLINE)?.title, '第三章 研究设计');
  assert.equal(matchChapterInQuery('第二章说了啥', OUTLINE)?.title, '第二章 文献综述');
  assert.equal(matchChapterInQuery('文献综述里有哪些理论', OUTLINE)?.title, '第二章 文献综述');
  assert.equal(matchChapterInQuery('随便问问天气', OUTLINE), null);
});

test('isLocalQuery 识别「这一段」这类位置型提问', () => {
  assert.equal(isLocalQuery('这一段是什么意思'), true);
  assert.equal(isLocalQuery('当前这页讲了什么'), true);
  assert.equal(isLocalQuery('全文用了什么方法'), false);
});

test('retrieve 优先按点名的章节取整章内容', () => {
  const hits = retrieve({ index: INDEX, outline: OUTLINE, query: '第三章用了什么研究方法', currentPage: 1 });
  const pages = hits.map((h) => h.page);
  assert.ok(pages.includes(9), '第三章的内容要被带进来');
  assert.ok(pages.includes(10));
  // 点名的章节排在 BM25 结果之前 —— 模型读到的顺序就是推荐顺序
  assert.equal(pages[0], 9);
});

test('retrieve 普通提问走 BM25 并带上命中页', () => {
  const hits = retrieve({ index: INDEX, outline: OUTLINE, query: '计划行为理论是谁提出的', currentPage: 1 });
  assert.equal(hits[0].page, 5);
});

test('retrieve 位置型提问会把当前页附近的正文补进来', () => {
  const hits = retrieve({ index: INDEX, outline: OUTLINE, query: '这段说的是什么意思', currentPage: 9 });
  assert.ok(hits.some((h) => h.page === 9));
});

test('formatHit 输出固定格式的出处标记', () => {
  assert.equal(
    formatHit({ chapterTitle: '第三章 研究设计', page: 9, text: '正文' }),
    '【第三章 研究设计 · p.9】\n正文',
  );
  assert.equal(formatHit({ chapterTitle: '', page: 3, text: '正文' }), '【p.3】\n正文');
  assert.equal(formatHit(null), '');
});

test('normalizeBudget 兜住异常值', () => {
  assert.equal(normalizeBudget(20000), 20000);
  assert.equal(normalizeBudget('40000'), 40000);
  assert.equal(normalizeBudget(100), 40000, '太小 → 回落默认');
  assert.equal(normalizeBudget(999999), 200000, '过大 → 夹到上限');
  assert.equal(normalizeBudget(undefined), 40000);
  assert.equal(CONTEXT_PRESETS.length, 3);
});

test('buildProfileCard 只给 5 个硬字段，且不含用户手写字段', () => {
  const card = buildProfileCard(RECORD);
  assert.match(card, /- 标题：短视频平台对消费者购买意愿的影响研究/);
  assert.match(card, /- 学校：某某大学/);
  assert.match(card, /- 学位类型：硕士/);
  assert.match(card, /- 年份：2024/);
  assert.equal(card.includes('我的思考'), false, '用户手写字段不进档案卡');
  assert.equal(card.includes('参考价值'), false);
  // v1.20.0 起不再把「自行总结出的一段话」当真喂给模型 —— 正文内容一律靠检索命中段
  assert.equal(card.includes('研究方法'), false, '方法/结论这类内容不再进档案卡');
  assert.equal(card.split('\n').length, 5, '档案卡只应有 5 行');
});

test('bigPaperSection 拼出大论文的框架与阶段', () => {
  const text = bigPaperSection({ title: '我的大论文', stage: '第三章', framework: '1 绪论\n2 综述' });
  assert.match(text, /- 题目：我的大论文/);
  assert.match(text, /- 当前阶段：第三章/);
  assert.match(text, /1 绪论/);
  assert.equal(bigPaperSection(null), '');
});

test('buildSystemPrompt 含引用规则、档案卡与章节目录', () => {
  const sys = buildSystemPrompt({ record: RECORD, outline: OUTLINE });
  assert.match(sys, /【章节标题 · p\.页码】/);
  assert.match(sys, /不要编造/);
  assert.match(sys, /【论文档案卡】/);
  assert.match(sys, /【章节目录（带页码）】/);
  assert.match(sys, /第一章 绪论（p\.1）/);
});

test('buildHereSection 说清「你在第几页、哪一章」', () => {
  const here = buildHereSection({ outline: OUTLINE, index: INDEX, currentPage: 9 });
  assert.match(here, /第 9 页/);
  assert.match(here, /第三章 研究设计/);
  assert.match(here, /p\.9/, '要附上该处正文，方便回答「这段说什么」');
  // 关掉开关就不带正文，省预算
  const off = buildHereSection({ outline: OUTLINE, index: INDEX, currentPage: 9, attachSection: false });
  assert.equal(off.includes('p.9'), false);
});

test('trimHistory 从最近往前留，超出预算就截', () => {
  const history = [
    { role: 'user', content: '一'.repeat(5000) },
    { role: 'assistant', content: '二'.repeat(5000) },
    { role: 'user', content: '最近的问题' },
    { role: 'assistant', content: '最近的回答' },
  ];
  const kept = trimHistory(history, 2000);
  assert.equal(kept.length, 2, '只留下装得下的最近两轮');
  assert.equal(kept[1].content, '最近的回答');
  assert.deepEqual(trimHistory([], 1000), []);
  assert.deepEqual(trimHistory(null, 1000), []);
});

test('assembleChatMessages 组装出 system + 历史 + 本次提问，并报告上下文用量', () => {
  const { messages, stats } = assembleChatMessages({
    record: RECORD, outline: OUTLINE, index: INDEX,
    query: '第三章用了什么研究方法', currentPage: 9,
    history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好，请问想了解什么' }],
    budgetChars: 40000,
  });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[messages.length - 1].role, 'user');
  assert.equal(messages.length, 4, 'system + 1 轮历史 + 本次提问');
  assert.match(messages[messages.length - 1].content, /【我的问题】/);
  assert.match(messages[messages.length - 1].content, /第三章用了什么研究方法/);
  assert.ok(stats.hitCount > 0);
  assert.ok(stats.hitPages.length > 0);
  assert.equal(stats.sectionTitle, '第三章 研究设计');
  assert.equal(stats.budgetChars, 40000);
  assert.ok(stats.usedChars > 0 && stats.usedChars < 40000, '不能超预算');
});

test('assembleChatMessages 在预算很紧时截断命中段落而不是无限膨胀', () => {
  const fat = PAGES.map((p) => ({ ...p, text: p.text.repeat(40) }));
  const fatIndex = buildIndex(chunkPages(fat, OUTLINE));
  const { messages, stats } = assembleChatMessages({
    record: RECORD, outline: OUTLINE, index: fatIndex,
    query: '计划行为理论', currentPage: 5, budgetChars: 8000,
  });
  assert.ok(stats.usedChars < 20000, '预算 8000 时不能塞进几万字');
  assert.match(messages[messages.length - 1].content, /已按上下文预算截断/);
});

test('assembleChatMessages 在没有索引时也能降级回答（不抛错）', () => {
  const { messages, stats } = assembleChatMessages({
    record: RECORD, outline: [], index: null, query: '这篇讲了什么', currentPage: 1,
  });
  assert.match(messages[messages.length - 1].content, /没有检索到相关片段/);
  assert.equal(stats.hitCount, 0);
});

test('buildTaskPrompt 三个任务都产出可用的 system / user', () => {
  for (const task of ['chapter-digest', 'review-entry', 'defense']) {
    const { system, user } = buildTaskPrompt(task, {
      record: RECORD, outline: OUTLINE, index: INDEX, chapterId: 'c3', currentPage: 9,
      bigPaper: { title: '我的大论文', stage: '第三章' },
    });
    assert.ok(system.length > 50, `${task} 的 system 太短`);
    assert.ok(user.length > 50, `${task} 的 user 太短`);
  }
  const digest = buildTaskPrompt('chapter-digest', { record: RECORD, outline: OUTLINE, index: INDEX, chapterId: 'c3' });
  assert.match(digest.user, /对我的论文有什么启示/);
  assert.match(digest.user, /第三章 研究设计/);
  const defense = buildTaskPrompt('defense', { record: RECORD, outline: OUTLINE, index: INDEX, chapterId: 'c3' });
  assert.match(defense.user, /10 个答辩问题/);
  assert.throws(() => buildTaskPrompt('不存在的任务', {}), /未知的生成任务/);
});

test('buildCompareMessages 把多篇论文摆成一张对比表', () => {
  const { system, user } = buildCompareMessages([RECORD, { ...RECORD, title: '第二篇', year: '2023' }]);
  assert.match(system, /对比表/);
  assert.match(user, /文献 1/);
  assert.match(user, /文献 2/);
  assert.match(user, /研究对象 \/ 理论基础/);
  assert.match(user, /综述可用表述/);
  // 超过 5 篇只取前 5
  const many = buildCompareMessages(Array.from({ length: 9 }, (_, i) => ({ ...RECORD, title: `第${i}篇` })));
  assert.equal((many.user.match(/### 文献/g) || []).length, 5);
});
