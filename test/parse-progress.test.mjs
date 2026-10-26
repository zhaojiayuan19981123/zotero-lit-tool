// parse-progress.test.mjs —— AI 解析进度追踪 + 书目字段清洗
//
// 两件事以前都没人守：
//   ① 解析进度：接口是同步返回的，前端靠轮询拿进度。快照字段少了 / done 不递增 /
//      失败不计入，界面就会出现「一直 0/N」「结束了进度条不落地」这类假进度；
//   ② 期刊 / 年份 / DOI 是表格列，模型多写一句「（SSCI Q1，影响因子 6.9）」就会让
//      排序和查等级匹配不上 —— 所以入库前必须洗干净，且缺失时给空串而不是标签。
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createParseTracker, PARSE_STAGE_LABEL } from '../src/parseProgress.js';
import {
  buildPrompt, cleanDoi, cleanJournal, cleanYear, cleanAuthors, cleanTitle, cleanMetaFields,
} from '../src/aiExtractor.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const items = [
  { id: 'a', title: '论文甲' },
  { id: 'b', title: '论文乙' },
  { id: 'c', title: '论文丙' },
];

test('进度：开轮即统计总数，全部排队', () => {
  const t = createParseTracker();
  t.start(items, { label: '批量重新解析 · 3 篇' });
  const s = t.snapshot();
  assert.equal(s.running, true);
  assert.equal(s.total, 3);
  assert.equal(s.done, 0);
  assert.equal(s.percent, 0);
  assert.equal(s.label, '批量重新解析 · 3 篇');
  assert.deepEqual(s.items.map((x) => x.stage), ['queued', 'queued', 'queued']);
  assert.ok(s.items.every((x) => x.stageLabel === PARSE_STAGE_LABEL.queued));
});

test('进度：阶段推进 + 当前篇目 + 完成计数', () => {
  const t = createParseTracker();
  t.start(items);
  t.setStage('a', 'extract');
  let s = t.snapshot();
  assert.equal(s.current.id, 'a');
  assert.equal(s.current.stageLabel, PARSE_STAGE_LABEL.extract);

  t.setStage('a', 'ai');
  t.finish('a');
  s = t.snapshot();
  assert.equal(s.done, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.percent, 33);
  assert.equal(s.items[0].status, 'done');
  // 已经收尾的那篇不能再被晚到的 stage 事件改回去
  t.setStage('a', 'ai');
  assert.equal(t.snapshot().items[0].stage, 'done');
});

test('进度：失败要计入 failed，并带错误摘要', () => {
  const t = createParseTracker();
  t.start(items);
  t.finish('a', 'LLM 接口返回 429');
  t.finish('b');
  t.finish('c');
  const s = t.snapshot();
  assert.equal(s.running, false);
  assert.equal(s.done, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.percent, 100);
  assert.equal(s.items[0].status, 'error');
  assert.match(s.items[0].error, /429/);
  assert.ok(s.elapsedMs >= 0);
});

test('进度：重复收尾不会把完成数算两次（并发下迟早会遇到）', () => {
  const t = createParseTracker();
  t.start(items);
  t.finish('a');
  t.finish('a');
  t.finish('a', '又报错了');
  const s = t.snapshot();
  assert.equal(s.done, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.items[0].status, 'done');
});

test('进度：没有作业时快照是空态，不会让前端画出幽灵进度条', () => {
  const t = createParseTracker();
  const s = t.snapshot();
  assert.equal(s.running, false);
  assert.equal(s.total, 0);
  assert.equal(s.percent, 0);
  assert.deepEqual(s.items, []);
});

test('进度：超长标题截断，避免浮层被一篇长标题撑爆', () => {
  const t = createParseTracker();
  t.start([{ id: 'x', title: 'A'.repeat(300) }]);
  const title = t.snapshot().items[0].title;
  assert.ok(title.length <= 91, `标题应被截断，实际 ${title.length}`);
});

test('DOI：只留 10.xxxx/xxxxx 本体', () => {
  assert.equal(cleanDoi('DOI: https://doi.org/10.1007/s10551-023-05371-7.'), '10.1007/s10551-023-05371-7');
  assert.equal(cleanDoi('doi：10.1093/jcr/ucad012'), '10.1093/jcr/ucad012');
  assert.equal(cleanDoi('10.1016/j.jbusres.2023.113682'), '10.1016/j.jbusres.2023.113682');
  // arXiv 号、参考文献里别人的 DOI 都不该被当成它的 DOI
  assert.equal(cleanDoi('arXiv: 2301.12345'), '');
  assert.equal(cleanDoi('原文未报告'), '');
  assert.equal(cleanDoi(''), '');
});

test('年份：只留四位数字，多版本年份取第一个', () => {
  assert.equal(cleanYear('2023（在线优先），2024（正式出刊）'), '2023');
  assert.equal(cleanYear('2023年'), '2023');
  assert.equal(cleanYear('发表于 2019 年 6 月'), '2019');
  assert.equal(cleanYear('原文未报告'), '');
  assert.equal(cleanYear('19-20'), '');
});

test('期刊：去掉等级注释、卷期页、前缀与书名号', () => {
  assert.equal(cleanJournal('Journal of Business Ethics（SSCI Q1，影响因子 6.9，JCR 2023）'), 'Journal of Business Ethics');
  assert.equal(cleanJournal('《管理世界》'), '管理世界');
  assert.equal(cleanJournal('期刊：Nature Human Behaviour'), 'Nature Human Behaviour');
  assert.equal(cleanJournal('Journal of Marketing Research, 66(3), 123-145'), 'Journal of Marketing Research');
  assert.equal(cleanJournal('Science, Technology & Human Values, Vol. 45, No. 2'), 'Science, Technology & Human Values');
  // 括号里是刊名的通用缩写时保留，不要误伤
  assert.equal(cleanJournal('Academy of Management Journal (AMJ)'), 'Academy of Management Journal (AMJ)');
  assert.equal(cleanJournal('原文未报告'), '');
});

test('标题/作者：去前缀与包裹符号，但不动正文', () => {
  assert.equal(cleanTitle('标题：《平台治理研究：一个综述》'), '平台治理研究：一个综述');
  assert.equal(cleanAuthors('作者：张三、李四'), '张三、李四');
  assert.deepEqual(cleanMetaFields({ title: 'T', authors: '', journal: '原文未报告', year: '2023年', doi: '无', keywords: '关键词：平台经济' }), {
    title: 'T', authors: '', journal: '', year: '2023', doi: '', keywords: '平台经济',
  });
});

test('提示词：列字段要求「只给值本身」，并点明不要等级/卷期/前缀', () => {
  const p = buildPrompt('empirical', '简体中文');
  assert.match(p, /列字段/);
  assert.match(p, /只写期刊[\s\S]{0,80}名称本身/, '期刊要明确只写名称');
  assert.match(p, /四位数字年份/, '年份要明确只要四位数字');
  assert.match(p, /不要「DOI:」前缀/, 'DOI 要明确不要前缀');
  assert.match(p, /影响因子/, '要明确禁止把影响因子等注释写进期刊字段');
});
