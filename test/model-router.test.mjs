// 模型路由（故障转移 + 熔断 + 用量统计）的单元测试
// 熔断状态机的时间点全部由 now 注入，因此这里不 sleep、可精确断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CIRCUIT, DEFAULT_ROUTER_CONFIG, ROUTER_LIMITS,
  normalizeRouterConfig, normalizeBreaker, readRouterConfig,
  createRouterState, applyRouterConfig, getProviderState,
  canUse, noteSuccess, noteFailure, providerHealth,
  planCandidates, classifyFailure, shouldFailover,
  noteRequestStart, noteRequestEnd, noteFailover, recordLog,
  successRateOf, snapshot, resetRouterState,
} from '../src/modelRouter.js';

const P = (id, vision = false, label = id) => ({ id, label, model: 'm-' + id, providerName: 'test', vision });

test('配置：缺省值可直接开箱，队列为空时只有主供应商', () => {
  const c = normalizeRouterConfig(undefined);
  assert.equal(c.enabled, DEFAULT_ROUTER_CONFIG.enabled);
  assert.equal(c.failover, true);
  assert.deepEqual(c.queue, []);
  assert.equal(c.retryPerProvider, 0);
  assert.equal(c.logLimit, DEFAULT_ROUTER_CONFIG.logLimit);
  assert.deepEqual(c.breaker, DEFAULT_ROUTER_CONFIG.breaker);
});

test('配置：数值一律钳制到合法范围，非法值回落默认', () => {
  const c = normalizeRouterConfig({
    retryPerProvider: 99,
    logLimit: 3,
    breaker: { failThreshold: 0, recoverSuccess: 100, openSeconds: -5, errorRate: 999, minRequests: 1 },
  });
  assert.equal(c.retryPerProvider, ROUTER_LIMITS.retryPerProvider[1]);
  assert.equal(c.logLimit, ROUTER_LIMITS.logLimit[0]);
  assert.equal(c.breaker.failThreshold, 1);
  assert.equal(c.breaker.recoverSuccess, 10);
  assert.equal(c.breaker.openSeconds, 0);
  assert.equal(c.breaker.errorRate, 100);
  assert.equal(c.breaker.minRequests, 5);

  const bad = normalizeBreaker({ failThreshold: 'abc', recoverSuccess: null, openSeconds: NaN, errorRate: undefined, minRequests: {} });
  assert.deepEqual(bad, DEFAULT_ROUTER_CONFIG.breaker, '非数值应回落默认，而不是变成 0/NaN');
});

test('配置：队列去重保序、丢弃空值、超长截断', () => {
  const c = normalizeRouterConfig({ queue: ['a', '', 'b', 'a', null, '  c  ', 'b'] });
  assert.deepEqual(c.queue, ['a', 'b', 'c']);

  const many = normalizeRouterConfig({ queue: Array.from({ length: 40 }, (_, i) => 'p' + i) });
  assert.equal(many.queue.length, ROUTER_LIMITS.queue);
  assert.equal(many.queue[0], 'p0');
  assert.equal(many.queue.at(-1), 'p' + (ROUTER_LIMITS.queue - 1));
});

test('配置：readRouterConfig 从 settings 取，applyRouterConfig 运行中改配置', () => {
  assert.deepEqual(readRouterConfig({ modelRouter: { queue: ['x'] } }).queue, ['x']);
  const state = createRouterState({ queue: ['a'] });
  applyRouterConfig(state, { queue: ['b', 'c'], enabled: false });
  assert.deepEqual(state.config.queue, ['b', 'c']);
  assert.equal(state.config.enabled, false);
});

// ---------------- 候选队列 ----------------

test('候选：队列为空时只尝试主供应商', () => {
  const state = createRouterState({ queue: [] });
  const r = planCandidates({ preferred: P('main'), resolveById: () => null, state, now: 0 });
  assert.deepEqual(r.candidates.map((x) => x.id), ['main']);
  assert.equal(r.forced, false);
});

test('候选：主供应商在前，备用按队列顺序，重复项只出现一次', () => {
  const byId = { a: P('a'), b: P('b') };
  // 队列里故意把主供应商也写进去，模拟用户在主界面顺手加的
  const state = createRouterState({ queue: ['a', 'b'] });
  const r = planCandidates({ preferred: P('a'), resolveById: (id) => byId[id] || null, state, now: 0 });
  assert.deepEqual(r.candidates.map((x) => x.id), ['a', 'b']);
});

test('候选：关闭自动故障转移时忽略队列', () => {
  const byId = { a: P('a'), b: P('b') };
  const state = createRouterState({ failover: false, queue: ['b'] });
  const r = planCandidates({ preferred: P('a'), resolveById: (id) => byId[id], state, now: 0 });
  assert.deepEqual(r.candidates.map((x) => x.id), ['a']);
});

test('候选：关闭总开关时也只尝试主供应商', () => {
  const state = createRouterState({ enabled: false, queue: ['b'] });
  const r = planCandidates({ preferred: P('a'), resolveById: () => P('b'), state, now: 0 });
  assert.deepEqual(r.candidates.map((x) => x.id), ['a']);
});

test('候选：主供应商要看图时，纯文本备用会被剔除（换过去等于答非所问）', () => {
  const byId = { text: P('text', false), eye: P('eye', true) };
  const state = createRouterState({ queue: ['text', 'eye'] });
  const r = planCandidates({ preferred: P('main', true), resolveById: (id) => byId[id], state, now: 0 });
  assert.deepEqual(r.candidates.map((x) => x.id), ['main', 'eye']);
});

test('候选：主供应商是纯文本时，视觉备用仍可用（视觉模型也能处理文字）', () => {
  const byId = { eye: P('eye', true) };
  const state = createRouterState({ queue: ['eye'] });
  const r = planCandidates({ preferred: P('main', false), resolveById: (id) => byId[id], state, now: 0 });
  assert.deepEqual(r.candidates.map((x) => x.id), ['main', 'eye']);
});

test('候选：无 Key / 已删除的备用被跳过', () => {
  const state = createRouterState({ queue: ['gone', 'b'] });
  const r = planCandidates({ preferred: P('a'), resolveById: (id) => (id === 'b' ? P('b') : null), state, now: 0 });
  assert.deepEqual(r.candidates.map((x) => x.id), ['a', 'b']);
});

test('候选：熔断中的供应商被跳过，并计入 skipped', () => {
  const byId = { a: P('a'), b: P('b'), c: P('c') };
  const state = createRouterState({ queue: ['b', 'c'] });
  const now = 1_000_000;
  // 让 b 熔断（连续失败 4 次达到默认阈值）
  for (let i = 0; i < 4; i += 1) noteFailure(state, 'b', { status: 500 }, now);
  const r = planCandidates({ preferred: P('a'), resolveById: (id) => byId[id], state, now });
  assert.deepEqual(r.candidates.map((x) => x.id), ['a', 'c']);
  assert.equal(r.skipped, 1);
  assert.equal(r.forced, false);
});

test('候选：全部熔断时 forced=true 且仍按原顺序尝试（宁可试一把，也不把错误藏起来）', () => {
  const state = createRouterState({ queue: [] });
  const now = 5_000_000;
  for (let i = 0; i < 4; i += 1) noteFailure(state, 'only', { status: 503 }, now);
  assert.equal(getProviderState(state, 'only').circuit, CIRCUIT.OPEN);
  const r = planCandidates({ preferred: P('only'), resolveById: () => null, state, now });
  assert.deepEqual(r.candidates.map((x) => x.id), ['only']);
  assert.equal(r.forced, true, '单供应商场景下熔断不能把请求直接拦死');
});

test('候选：主供应商缺失（未配置）时，备用仍可顶上', () => {
  const state = createRouterState({ queue: ['b'] });
  const r = planCandidates({ preferred: null, resolveById: () => P('b'), state, now: 0 });
  assert.deepEqual(r.candidates.map((x) => x.id), ['b']);
});

test('候选：没有 id 的临时配置（「测试连接」传进来的那份）也能作为主供应商', () => {
  const state = createRouterState({ queue: [] });
  // /api/models/test 这类接口直接拿请求体拼一份配置，它没有 id
  const temp = { label: '临时配置', model: 'mock-local', vision: false };
  const r = planCandidates({ preferred: temp, resolveById: () => null, state, now: 0 });
  assert.equal(r.candidates.length, 1, '不能因为没有 id 就把主供应商丢掉');
  assert.ok(r.candidates[0].id, '应当补出一个稳定 id 供统计与熔断使用');
  assert.equal(r.candidates[0].model, 'mock-local');
});

test('候选：主供应商与备用都拿不到时返回空候选（交由上层报「未配置模型」）', () => {
  const state = createRouterState({ queue: ['gone'] });
  const r = planCandidates({ preferred: null, resolveById: () => null, state, now: 0 });
  assert.deepEqual(r.candidates, []);
  assert.equal(r.forced, false);
});

// ---------------- 熔断状态机 ----------------

test('熔断：连续失败达到阈值 → 开启；冷却期内不可用；冷却到点转半开并放行', () => {
  const state = createRouterState({ breaker: { failThreshold: 3, openSeconds: 30 } });
  const t0 = 10_000;
  noteFailure(state, 'p', { status: 500 }, t0);
  assert.equal(getProviderState(state, 'p').circuit, CIRCUIT.CLOSED, '未到阈值不应熔断');
  noteFailure(state, 'p', { status: 500 }, t0 + 1);
  noteFailure(state, 'p', { status: 500 }, t0 + 2);
  const p = getProviderState(state, 'p');
  assert.equal(p.circuit, CIRCUIT.OPEN);
  assert.equal(p.openUntil, t0 + 2 + 30_000);

  assert.equal(canUse(state, 'p', t0 + 2 + 29_999), false, '冷却期内应跳过');
  assert.equal(p.circuit, CIRCUIT.OPEN, '冷却期内不应提前转半开');
  assert.equal(canUse(state, 'p', t0 + 2 + 30_000), true, '冷却到点应转为半开并放行试探');
  assert.equal(p.circuit, CIRCUIT.HALF_OPEN);
});

test('熔断：半开状态下成功够次数 → 关闭并清零失败计数', () => {
  const state = createRouterState({ breaker: { failThreshold: 2, recoverSuccess: 2, openSeconds: 10 } });
  const t0 = 0;
  noteFailure(state, 'p', { status: 500 }, t0);
  noteFailure(state, 'p', { status: 500 }, t0);
  const p = getProviderState(state, 'p');
  assert.equal(p.circuit, CIRCUIT.OPEN);

  const afterCool = 10_001;
  assert.equal(canUse(state, 'p', afterCool), true);
  assert.equal(p.circuit, CIRCUIT.HALF_OPEN);

  noteSuccess(state, 'p', {}, afterCool);
  assert.equal(p.circuit, CIRCUIT.HALF_OPEN, '恢复成功次数不足，仍应保持半开');
  assert.equal(p.consecutiveFailures, 0, '任意一次成功都应清零连续失败');

  noteSuccess(state, 'p', {}, afterCool + 1);
  assert.equal(p.circuit, CIRCUIT.CLOSED, '达到恢复阈值应关闭熔断');
  assert.equal(p.halfOpenSuccesses, 0);
});

test('熔断：半开状态下再失败 → 立刻重新开启（并重置冷却窗口）', () => {
  const state = createRouterState({ breaker: { failThreshold: 5, openSeconds: 20 } });
  const t0 = 0;
  for (let i = 0; i < 5; i += 1) noteFailure(state, 'p', { status: 500 }, t0);
  const p = getProviderState(state, 'p');
  assert.equal(p.circuit, CIRCUIT.OPEN);

  const cool = 20_001;
  assert.equal(canUse(state, 'p', cool), true);
  assert.equal(p.circuit, CIRCUIT.HALF_OPEN);

  // 半开时只失败一次（远不到连续 5 次阈值）也必须重新熔断
  noteFailure(state, 'p', { status: 503 }, cool);
  assert.equal(p.circuit, CIRCUIT.OPEN);
  assert.equal(p.openUntil, cool + 20_000, '冷却窗口应从这次失败重新计算');
});

test('熔断：错误率达标也会开启（即使连续失败次数不够）', () => {
  const state = createRouterState({
    breaker: { failThreshold: 20, errorRate: 60, minRequests: 10, openSeconds: 30 },
  });
  const now = 0;
  // 3 次成功 + 7 次失败 = 70% 错误率，连续失败 7 次（<20），但错误率已超 60%
  for (let i = 0; i < 3; i += 1) noteSuccess(state, 'p', {}, now);
  for (let i = 0; i < 6; i += 1) noteFailure(state, 'p', { status: 500 }, now);
  assert.equal(getProviderState(state, 'p').circuit, CIRCUIT.CLOSED, '未达最小请求数前不该用错误率判定');
  noteFailure(state, 'p', { status: 500 }, now);
  assert.equal(getProviderState(state, 'p').circuit, CIRCUIT.OPEN, '错误率 70% ≥ 60% 应熔断');
});

test('熔断：openSeconds=0 表示冷却立即结束，下一次就放行试探', () => {
  const state = createRouterState({ breaker: { failThreshold: 1, openSeconds: 0 } });
  noteFailure(state, 'p', { status: 500 }, 1000);
  assert.equal(getProviderState(state, 'p').circuit, CIRCUIT.OPEN);
  assert.equal(canUse(state, 'p', 1000), true, '冷却 0 秒应当即转为半开');
  assert.equal(getProviderState(state, 'p').circuit, CIRCUIT.HALF_OPEN);
});

test('健康徽章：健康 / 警告 / 熔断 三态', () => {
  const state = createRouterState({ breaker: { failThreshold: 3 } });
  const p = getProviderState(state, 'p');
  assert.equal(providerHealth(p), 'ok');
  noteFailure(state, 'p', { status: 500 }, 0);
  assert.equal(providerHealth(p), 'warn', '有失败但未熔断 → 警告');
  noteFailure(state, 'p', { status: 500 }, 0);
  noteFailure(state, 'p', { status: 500 }, 0);
  assert.equal(providerHealth(p), 'open', '已熔断 → 红');
  noteSuccess(state, 'p', {}, 0);
  assert.equal(providerHealth(p), 'ok', '成功后应立即恢复健康');
});

// ---------------- 失败分类 ----------------

test('失败分类：状态码映射到可读性质', () => {
  const cases = [
    [{ status: 401 }, 'auth'],
    [{ status: 403 }, 'auth'],
    [{ status: 404 }, 'endpoint'],
    [{ status: 405 }, 'endpoint'],
    [{ status: 501 }, 'endpoint'],
    [{ status: 408 }, 'timeout'],
    [{ status: 429 }, 'rate-limit'],
    [{ status: 500 }, 'server'],
    [{ status: 502 }, 'server'],
    [{ status: 400 }, 'param'],
    [{ status: 422 }, 'param'],
    [{ status: 0 }, 'network'],
    [{ status: 418 }, 'unknown'],
    [{ status: 200, html: true }, 'html'],
    [{ timeout: true }, 'timeout'],
    [{ aborted: true }, 'aborted'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(classifyFailure(input), expected, JSON.stringify(input));
  }
  assert.equal(classifyFailure({ aborted: true, status: 500 }), 'aborted', '中止优先于状态码');
  assert.equal(classifyFailure({ html: true, status: 200 }), 'html', '网页响应要单独识别（状态码是 200）');
});

test('失败分类：客户端中止与本地配置问题不触发故障转移', () => {
  assert.equal(shouldFailover({ kind: 'aborted' }), false);
  assert.equal(shouldFailover({ aborted: true }), false);
  assert.equal(shouldFailover({ kind: 'config' }), false);
  for (const kind of ['timeout', 'server', 'rate-limit', 'auth', 'param', 'html', 'network', 'endpoint', 'unknown']) {
    assert.equal(shouldFailover({ kind }), true, kind + ' 应当允许换下一家');
  }
});

// ---------------- 统计与日志 ----------------

test('统计：活跃连接随请求进出增减，且不会减成负数', () => {
  const state = createRouterState();
  const a = noteRequestStart(state, 0);
  const b = noteRequestStart(state, 0);
  assert.equal(state.activeConnections, 2);
  assert.equal(state.totalRequests, 2);
  noteRequestEnd(state, a, { ok: true });
  assert.equal(state.activeConnections, 1);
  noteRequestEnd(state, b, { ok: false, error: 'boom' });
  assert.equal(state.activeConnections, 0);
  noteRequestEnd(state, {}, { ok: false });
  assert.equal(state.activeConnections, 0, '多减一次也不能变负');
  assert.equal(state.successRequests, 1);
  assert.equal(state.failRequests, 2);
});

test('统计：成功率按「用户请求」算（一次请求内部换过家也只算一次）', () => {
  const state = createRouterState();
  for (let i = 0; i < 3; i += 1) {
    const ctx = noteRequestStart(state);
    noteRequestEnd(state, ctx, { ok: i !== 2 });
  }
  assert.equal(successRateOf(state), 66.7);
  assert.equal(snapshot(state, { now: state.startedAt + 1000 }).successRate, 66.7);
});

test('统计：没有请求时成功率为 null（前端显示 —，而不是 0%）', () => {
  const state = createRouterState();
  assert.equal(successRateOf(state), null);
  assert.equal(snapshot(state).successRate, null);
});

test('统计：切换次数单独累计', () => {
  const state = createRouterState();
  noteFailover(state);
  noteFailover(state);
  assert.equal(state.failovers, 2);
  assert.equal(snapshot(state).failovers, 2);
});

test('日志：超过上限时丢最旧的，快照里最新的在最前', () => {
  const state = createRouterState({ logLimit: 20 });
  for (let i = 0; i < 25; i += 1) recordLog(state, { profileId: 'p', ok: true, n: i }, i);
  assert.equal(state.logs.length, 20);
  assert.equal(state.logs[0].n, 5, '应丢弃最旧的 5 条');
  const snap = snapshot(state);
  assert.equal(snap.logs.length, 20);
  assert.equal(snap.logs[0].n, 24, '快照里最新一条在最前，便于直接渲染');
});

test('快照：包含没被请求过的供应商（面板要能列出全部候选供勾选）', () => {
  const state = createRouterState();
  noteSuccess(state, 'a', {}, 0);
  const snap = snapshot(state, { profiles: [P('a'), P('b', false, '备用B')], now: 5 });
  const ids = snap.providers.map((p) => p.id);
  assert.deepEqual(ids, ['a', 'b']);
  const b = snap.providers.find((x) => x.id === 'b');
  assert.equal(b.label, '备用B');
  assert.equal(b.requests, 0);
  assert.equal(b.successRate, null);
  assert.equal(b.health, 'ok');
});

test('快照：已删除的供应商仍显示（否则请求日志里的名字会莫名消失）', () => {
  const state = createRouterState();
  noteFailure(state, 'gone', { status: 500, message: 'x' }, 0);
  const snap = snapshot(state, { profiles: [], now: 1 });
  assert.equal(snap.providers.length, 1);
  assert.equal(snap.providers[0].id, 'gone');
  assert.match(snap.providers[0].label, /已删除/);
});

test('快照：单个供应商的成功率与最近错误都带出去', () => {
  const state = createRouterState();
  noteSuccess(state, 'a', { latencyMs: 120 }, 0);
  noteFailure(state, 'a', { status: 429, message: '限流了', kind: 'rate-limit', latencyMs: 30 }, 1);
  const a = snapshot(state, { now: 2 }).providers[0];
  assert.equal(a.requests, 2);
  assert.equal(a.successRate, 50);
  assert.equal(a.lastStatus, 429);
  assert.equal(a.lastKind, 'rate-limit');
  assert.equal(a.lastError, '限流了');
  assert.equal(a.lastLatencyMs, 30);
  assert.equal(a.consecutiveFailures, 1);
  assert.equal(a.health, 'warn');
});

test('重置：默认连熔断一起清；keepBreakers 时保留熔断状态', () => {
  const state = createRouterState({ breaker: { failThreshold: 1 } });
  noteRequestStart(state);
  noteFailure(state, 'p', { status: 500 }, 0);
  assert.equal(getProviderState(state, 'p').circuit, CIRCUIT.OPEN);
  resetRouterState(state, { now: 999 });
  assert.equal(state.totalRequests, 0);
  assert.equal(state.activeConnections, 0);
  assert.equal(state.logs.length, 0);
  assert.equal(state.startedAt, 999);
  assert.equal(getProviderState(state, 'p').circuit, CIRCUIT.CLOSED, '默认应把熔断也复位');

  noteFailure(state, 'p', { status: 500 }, 0);
  resetRouterState(state, { keepBreakers: true });
  assert.equal(getProviderState(state, 'p').circuit, CIRCUIT.OPEN, 'keepBreakers 时熔断状态保留');
  assert.equal(getProviderState(state, 'p').requests, 0, '但计数要清零');
});
