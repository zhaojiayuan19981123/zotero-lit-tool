// thesis-store.test.mjs —— 学位论文数据层的单测
//
// 重点是「数据不串、不丢」：分类删除不能连带删论文、删论文要清干净孤儿引用、
// 白名单之外的字段不能被写进来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.js';
import * as thesisStore from '../src/thesisStore.js';
import { THESIS_AI_FIELDS, THESIS_USER_FIELDS, THESIS_REMOVED_FIELDS } from '../src/thesisFields.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thesis-store-'));
store.configure({ dataDir: dir });

test('blankThesis 把 AI 字段与用户字段都初始化成空串', () => {
  const rec = thesisStore.blankThesis();
  assert.ok(rec.id);
  assert.equal(rec.status, 'pending');
  assert.equal(rec.collectionId, '');
  assert.equal(rec.indexStatus, 'none');
  for (const f of THESIS_AI_FIELDS) assert.equal(rec[f], '', `${f} 应该是空串`);
  for (const f of THESIS_USER_FIELDS) assert.equal(rec[f], '', `${f} 应该是空串`);
});

test('upsertThesis 新建放最前，更新保留原顺序', () => {
  const a = thesisStore.upsertThesis(thesisStore.blankThesis({ title: 'A' }));
  const b = thesisStore.upsertThesis(thesisStore.blankThesis({ title: 'B' }));
  assert.deepEqual(thesisStore.listTheses().map((x) => x.title), ['B', 'A']);
  thesisStore.upsertThesis({ ...a, title: 'A2' });
  assert.deepEqual(thesisStore.listTheses().map((x) => x.title), ['B', 'A2'], '更新不该把记录顶到最前');
  assert.equal(thesisStore.getThesis(b.id).title, 'B');
  assert.equal(thesisStore.getThesis('不存在'), null);
});

test('patchThesis 只认白名单字段', () => {
  const rec = thesisStore.upsertThesis(thesisStore.blankThesis({ title: '白名单' }));
  const out = thesisStore.patchThesis(rec.id, {
    myThoughts: '我的想法',
    rating: '5',
    readPage: 30,
    __hacked: 'x',
    filePath: '/etc/passwd',
    status: 'done',
  });
  assert.equal(out.myThoughts, '我的想法');
  assert.equal(out.rating, '5');
  assert.equal(out.readPage, 30);
  assert.equal(out.__hacked, undefined);
  assert.equal(out.filePath, '', 'filePath 不在白名单里，不能被前端改');
  assert.equal(out.status, 'pending', 'status 要由服务端维护');
  assert.equal(thesisStore.patchThesis('不存在', { rating: '1' }), null);
});

test('progressOf 按实际页码自动算，用户手改优先', () => {
  const rec = thesisStore.blankThesis({ numPages: 200, readPage: 0 });
  assert.equal(thesisStore.progressOf(rec).label, '未阅读');
  assert.equal(thesisStore.progressOf(rec).percent, 0);

  assert.equal(thesisStore.progressOf({ ...rec, readPage: 40 }).label, '阅读中');
  assert.equal(thesisStore.progressOf({ ...rec, readPage: 40 }).percent, 20);
  assert.equal(thesisStore.progressOf({ ...rec, readPage: 195 }).label, '已阅读');
  assert.equal(thesisStore.progressOf({ ...rec, readPage: 500 }).percent, 100, '进度封顶 100');

  // 手改的标签优先于自动判定（用户说读完了就算读完了）
  assert.equal(thesisStore.progressOf({ ...rec, readPage: 10, progressManual: '已阅读' }).label, '已阅读');
  // 没有页数信息时，读过一点就算「阅读中」
  assert.equal(thesisStore.progressOf({ numPages: 0, readPage: 5 }).label, '阅读中');
});

test('分类：新建、改名、删除后论文回到未分类（不连带删论文）', () => {
  const col = thesisStore.upsertCollection({ id: store.newId(), name: '数字营销' });
  assert.equal(thesisStore.listCollections().length, 1);

  const rec = thesisStore.upsertThesis(thesisStore.blankThesis({ title: '归类论文', collectionId: col.id }));
  thesisStore.upsertCollection({ ...col, name: '营销与消费者行为' });
  assert.equal(thesisStore.listCollections()[0].name, '营销与消费者行为');

  assert.equal(thesisStore.deleteCollection(col.id), true);
  assert.equal(thesisStore.listCollections().length, 0);
  assert.equal(thesisStore.getThesis(rec.id).collectionId, '', '论文还在，只是回到未分类');
  assert.ok(thesisStore.getThesis(rec.id));
  assert.equal(thesisStore.deleteCollection('不存在'), false);
});

test('素材库：新增、改批注、删除', () => {
  const rec = thesisStore.upsertThesis(thesisStore.blankThesis({ title: '素材论文' }));
  const q = thesisStore.upsertQuote({
    id: store.newId(), thesisId: rec.id, thesisTitle: '素材论文',
    chapterTitle: '第三章', page: 47, text: '沉浸体验显著提升购买意愿。',
  });
  assert.equal(thesisStore.listQuotes().length, 1);
  thesisStore.upsertQuote({ ...q, note: '可用于第四章假设' });
  assert.equal(thesisStore.listQuotes()[0].note, '可用于第四章假设');
  assert.equal(thesisStore.deleteQuote(q.id), true);
  assert.equal(thesisStore.listQuotes().length, 0);
  assert.equal(thesisStore.deleteQuote(q.id), false);
});

test('删除论文会连带清掉它的素材摘录（不留孤儿引用）', () => {
  const rec = thesisStore.upsertThesis(thesisStore.blankThesis({ title: '待删论文' }));
  const other = thesisStore.upsertThesis(thesisStore.blankThesis({ title: '保留论文' }));
  thesisStore.upsertQuote({ id: store.newId(), thesisId: rec.id, text: '要被清掉' });
  thesisStore.upsertQuote({ id: store.newId(), thesisId: other.id, text: '要留下' });

  assert.equal(thesisStore.deleteThesis(rec.id), true);
  const left = thesisStore.listQuotes();
  assert.equal(left.length, 1);
  assert.equal(left[0].text, '要留下');
  assert.equal(thesisStore.deleteThesis(rec.id), false, '重复删除返回 false');
});

test('大论文信息保存并做长度限制', () => {
  const saved = thesisStore.saveBigPaper({ title: '我的大论文', stage: '第三章', framework: '1 绪论', notes: 'x' });
  assert.equal(saved.title, '我的大论文');
  assert.equal(thesisStore.getBigPaper().stage, '第三章');
  const long = thesisStore.saveBigPaper({ framework: '字'.repeat(99999) });
  assert.ok(long.framework.length <= 30000);
});

test('章节索引缓存的读写与清理', () => {
  const id = 'idx-test';
  thesisStore.writeIndex(id, { version: 2, outline: [], index: { chunks: [] } });
  assert.ok(thesisStore.readIndex(id));
  assert.equal(thesisStore.readIndex(id).version, 2);
  assert.equal(thesisStore.removeIndex(id), true);
  assert.equal(thesisStore.readIndex(id), null);
  assert.equal(thesisStore.removeIndex(id), false);
  assert.equal(thesisStore.readIndex('从未写过'), null);
});

test('summary 汇总阅读进度、索引与素材数量', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'thesis-sum-'));
  store.configure({ dataDir: fresh });
  thesisStore.upsertThesis(thesisStore.blankThesis({ title: 'A', numPages: 100, readPage: 0 }));
  thesisStore.upsertThesis(thesisStore.blankThesis({ title: 'B', numPages: 100, readPage: 50, indexStatus: 'ready' }));
  thesisStore.upsertThesis(thesisStore.blankThesis({ title: 'C', numPages: 100, readPage: 99 }));
  thesisStore.upsertQuote({ id: store.newId(), text: '摘要一条' });
  const s = thesisStore.summary();
  assert.equal(s.total, 3);
  assert.equal(s.byProgress['未阅读'], 1);
  assert.equal(s.byProgress['阅读中'], 1);
  assert.equal(s.byProgress['已阅读'], 1);
  assert.equal(s.indexed, 1);
  assert.equal(s.pages, 300);
  assert.equal(s.quotes, 1);
});

test('书签：能通过 patchThesis 存下来，并过滤掉结构不对的项', () => {
  const rec = thesisStore.upsertThesis(thesisStore.blankThesis({ title: '书签' }));
  assert.deepEqual(rec.bookmarks, [], '新记录要自带空书签数组');

  // 这里踩过坑：bookmarks 漏进白名单 → PATCH 被静默丢弃，点「加书签」看着像没反应
  const out = thesisStore.patchThesis(rec.id, {
    bookmarks: [
      { id: 'b1', page: 12, note: '重点章节' },
      { id: '', page: 3, note: '没有 id，丢弃' },
      { id: 'b2', page: '7.6', note: 'x'.repeat(500) },
      'not-an-object',
    ],
  });
  assert.equal(out.bookmarks.length, 2, '结构不对的项要被过滤掉');
  assert.deepEqual(out.bookmarks[0], { id: 'b1', page: 12, note: '重点章节' });
  assert.equal(out.bookmarks[1].page, 8, '页码取整');
  assert.equal(out.bookmarks[1].note.length, 300, '备注限长，别把数据文件撑爆');
  assert.equal(thesisStore.getThesis(rec.id).bookmarks.length, 2, '要真的落盘，而不只是返回值好看');
});

test('字段瘦身：AI 只留 5 个书目前提字段，废弃字段全部清掉', () => {
  // 上一个用例把数据目录切走了，这里切回本文件自己的目录
  store.configure({ dataDir: dir });
  assert.deepEqual(THESIS_AI_FIELDS, ['title', 'authors', 'school', 'degreeType', 'year']);
  assert.ok(THESIS_REMOVED_FIELDS.includes('summary'), '旧的总结类字段应进了废弃清单');
  assert.ok(THESIS_REMOVED_FIELDS.includes('suggestedRating'), 'AI 建议评级不再产出');

  // 模拟一份 v1.19.x 的老数据：夹带着 17 个已废弃字段
  const legacy = {
    ...thesisStore.blankThesis({ title: '老数据' }),
    major: '企业管理', supervisor: '李四', keywords: '短视频；沉浸',
    summary: '本文研究了……', theory: '计划行为理论', method: '问卷调查',
    limitation: '单国样本', structure: '第一章 绪论', dataOpen: '未公开',
    suggestedRating: '4', ratingReason: '设计规范',
  };
  // upsert 内部就会剥掉（读的时候也剥）
  const saved = thesisStore.upsertThesis(legacy);
  for (const f of THESIS_REMOVED_FIELDS) {
    assert.equal(saved[f], undefined, `${f} 不该被写进记录`);
    assert.equal(thesisStore.getThesis(saved.id)[f], undefined, `${f} 不该出现在读出来的记录里`);
  }
  // 用户手写的字段与 5 个 AI 字段必须原样保留
  assert.equal(saved.title, '老数据');
  assert.equal(saved.myThoughts, '');

  // 直接改数据文件塞回废弃字段 → pruneRemovedFields 要能一次性清干净
  const file = path.join(dir, 'theses.json');
  const db = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const target = db.items.find((x) => x.id === saved.id);
  target.summary = '手动塞回来的脏字段';
  target.suggestedRating = '5';
  fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf-8');
  assert.equal(thesisStore.listTheses().find((x) => x.id === saved.id).summary, undefined, '读的时候就要剥掉');
  thesisStore.pruneRemovedFields();
  const after = JSON.parse(fs.readFileSync(file, 'utf-8')).items.find((x) => x.id === saved.id);
  assert.equal(after.summary, undefined, 'prune 之后文件里也不该再有');
  assert.equal(after.suggestedRating, undefined);
  assert.equal(after.title, '老数据', '清理不能误伤正常字段');
});
