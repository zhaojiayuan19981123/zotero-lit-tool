// parse-runner.test.mjs —— 批量解析执行器（并发 / 超时 / 失败隔离 / 僵尸回收）
//
// 这一组测试盯的是「文献一直卡在解析中」这个用户可见的故障，四个成因各一条：
//   ① 并发被写死成 1 或 2 —— 一批 20 篇要跑半小时，用户以为卡住了；
//   ② 某篇的 LLM 请求吊死 —— 没有看门狗，整批永远等下去；
//   ③ 某篇抛错 —— 老实现用 Promise.all，一 reject 后面排队的再也不会开始；
//   ④ 进程被杀 —— 库里留下 parsing，而「解析全部」又跳过 parsing，永久僵尸。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runParseBatch, clampParseConcurrency, resolveItemTimeoutMs, pickStaleParsing,
  createParseJob, isParseActive, ParseTimeoutError, PARSE_CONCURRENCY_MAX, PARSE_CONCURRENCY_DEFAULT,
} from '../src/parseRunner.js';
import { createParseTracker } from '../src/parseProgress.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('并发度：夹在 1~8，非法值退回默认 6', () => {
  assert.equal(clampParseConcurrency(undefined), PARSE_CONCURRENCY_DEFAULT);
  assert.equal(clampParseConcurrency(0), PARSE_CONCURRENCY_DEFAULT);
  assert.equal(clampParseConcurrency('abc'), PARSE_CONCURRENCY_DEFAULT);
  assert.equal(clampParseConcurrency(3), 3);
  assert.equal(clampParseConcurrency('5'), 5);
  assert.equal(clampParseConcurrency(99), PARSE_CONCURRENCY_MAX);
  assert.equal(clampParseConcurrency(-3), PARSE_CONCURRENCY_DEFAULT);
  // 默认必须落在用户要求的 4~8 之间
  assert.ok(PARSE_CONCURRENCY_DEFAULT >= 4 && PARSE_CONCURRENCY_DEFAULT <= 8);
});

test('并发确实并行：6 篇各 80ms，总耗时明显小于串行', async () => {
  let inflight = 0;
  let peak = 0;
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}` }));
  const t0 = Date.now();
  const batch = await runParseBatch(items, async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await sleep(80);
    inflight -= 1;
    return 'ok';
  }, { concurrency: 6 });
  const cost = Date.now() - t0;
  assert.equal(batch.ok, 6);
  assert.equal(peak, 6, `应该 6 篇同时在跑，实际峰值 ${peak}`);
  assert.ok(cost < 400, `并发没生效？耗时 ${cost}ms`);
});

test('并发上限生效：并发 2 时峰值不超过 2', async () => {
  let inflight = 0;
  let peak = 0;
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}` }));
  await runParseBatch(items, async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await sleep(30);
    inflight -= 1;
  }, { concurrency: 2 });
  assert.equal(peak, 2, `并发上限应被遵守，实际峰值 ${peak}`);
});

test('单篇吊死：看门狗到点收尾，其他篇照常完成，整批不 reject', async () => {
  const items = [{ id: 'slow' }, { id: 'fast1' }, { id: 'fast2' }];
  const batch = await runParseBatch(items, async (item, job) => {
    if (item.id === 'slow') {
      await sleep(1200);           // 模拟永不返回的 LLM 请求（比看门狗长即可）
      return 'never';
    }
    await sleep(10);
    job.assertLive();
    return 'ok';
  }, { concurrency: 3, itemTimeoutMs: 250 });

  assert.equal(batch.failed, 1);
  assert.equal(batch.timedOut, 1);
  assert.equal(batch.ok, 2);
  const slow = batch.results.find((r) => r.item.id === 'slow');
  assert.ok(slow.error instanceof ParseTimeoutError);
  assert.match(slow.error.message, /分钟|秒/);
});

test('单篇抛错不外溢：失败那篇标记 error，后面的任务继续跑完', async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}` }));
  const seen = [];
  const batch = await runParseBatch(items, async (item) => {
    seen.push(item.id);
    if (item.id === 'e1') throw new Error('LLM 接口返回 500: boom');
    await sleep(5);
    return 'ok';
  }, { concurrency: 2 });

  assert.equal(batch.results.length, 5, '五篇都要有结果，不能因为一篇失败就丢掉剩下的');
  assert.deepEqual(seen.sort(), items.map((i) => i.id).sort());
  const bad = batch.results.find((r) => r.item.id === 'e1');
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /500/);
});

test('作业句柄：abort 之后 assertLive 抛超时，后台不再继续写结果', async () => {
  const job = createParseJob('x', 250);
  job.assertLive();                 // 还没超时，正常
  job.abort();
  assert.throws(() => job.assertLive(), ParseTimeoutError);
  assert.equal(job.signal.aborted, true);
});

test('跑到一半的记录登记在册，结束（含失败）后自动摘掉', async () => {
  let duringFirst = null;
  await runParseBatch([{ id: 'reg1' }], async () => {
    duringFirst = isParseActive('reg1');
  }, { concurrency: 1 });
  assert.equal(duringFirst, true, '执行期间应被登记，否则僵尸回收会误杀它');
  assert.equal(isParseActive('reg1'), false, '结束后必须摘掉');

  await runParseBatch([{ id: 'reg2' }], async () => { throw new Error('失败也要摘掉'); }, { concurrency: 1 });
  assert.equal(isParseActive('reg2'), false);
});

test('空批次：立刻返回，不留下 running 的幽灵进度', async () => {
  const batch = await runParseBatch([], async () => 'x', { concurrency: 4 });
  assert.deepEqual(batch.results, []);
  assert.equal(batch.concurrency, 4);
});

test('僵尸识别：正在跑的不动，没有开始时间的老记录/超时的算僵尸', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  const records = [
    { id: 'running', status: 'parsing', parseStartedAt: '2026-10-26T11:59:59.000Z' },
    { id: 'fresh', status: 'parsing', parseStartedAt: '2026-10-26T11:59:00.000Z' },
    { id: 'zombie-old', status: 'parsing', parseStartedAt: '2026-10-26T11:30:00.000Z' },
    { id: 'zombie-legacy', status: 'parsing' },           // 老版本没有 parseStartedAt
    { id: 'done', status: 'done', parseStartedAt: '2026-10-26T09:00:00.000Z' },
    { id: 'error', status: 'error' },
  ];
  const stale = pickStaleParsing(records, { now, maxAgeMs: 6 * 60 * 1000, isActive: (id) => id === 'running' });
  assert.deepEqual(stale.map((r) => r.id), ['zombie-old', 'zombie-legacy']);
});

test('僵尸识别：进程刚启动时（all=true）所有 parsing 都回收，除了登记在跑的', () => {
  const records = [
    { id: 'a', status: 'parsing', parseStartedAt: new Date().toISOString() },
    { id: 'b', status: 'parsing' },
    { id: 'c', status: 'done' },
  ];
  const stale = pickStaleParsing(records, { all: true, isActive: (id) => id === 'b' });
  assert.deepEqual(stale.map((r) => r.id), ['a']);
});

test('进度快照：并行时给出 active 列表与并发数，前端才能显示「正在并行 N 篇」', () => {
  const t = createParseTracker();
  t.start([{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }, { id: 'c', title: '丙' }], { label: 'AI 解析 · 3 篇', concurrency: 3 });
  t.setStage('a', 'extract');
  t.setStage('b', 'ai');
  const s = t.snapshot();
  assert.equal(s.concurrency, 3);
  assert.equal(s.active.length, 2);
  assert.deepEqual(s.active.map((x) => x.id), ['a', 'b']);
  assert.equal(s.active[1].stageLabel, 'AI 解析中');
  assert.ok(s.active.every((x) => x.elapsedMs >= 0));
  assert.equal(s.current.id, 'a', 'current 继续保留第一篇进行中的，兼容旧前端');

  // 收尾的那篇要从 active 里消失，否则浮层会一直显示「并行 2 篇」
  t.finish('a');
  assert.equal(t.snapshot().active.length, 1);
});

test('单篇预算：显式小值可用于测试，环境变量不会低到秒级', () => {
  assert.equal(resolveItemTimeoutMs(250), 250);
  assert.ok(resolveItemTimeoutMs(undefined) >= 60 * 1000);
  assert.ok(resolveItemTimeoutMs(1) >= 200);
  assert.ok(resolveItemTimeoutMs(60 * 60 * 1000) <= 30 * 60 * 1000);
});
