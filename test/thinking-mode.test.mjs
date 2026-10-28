// thinking-mode.test.mjs —— 「思考（reasoning）」开关的参数写法
//
// 为什么单独测：关思考能让文献解析从 60~120 秒降到 10~30 秒，但各家参数名不同、
// 而且不认识该参数的上游会直接 400。这个开关既要有用，又不能把整条链路搞挂，
// 所以「写什么参数」与「什么时候该摘掉」都必须钉住。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeThinkingMode, thinkingPayload, withThinking, stripThinking,
  looksLikeThinkingParamError, modelMayThink, THINKING_KEYS, postWithThinkingFallback,
} from '../src/thinkingMode.js';

test('模式归一化：认得布尔、英文与常见的中文/别名', () => {
  assert.equal(normalizeThinkingMode('off'), 'off');
  assert.equal(normalizeThinkingMode('false'), 'off');
  assert.equal(normalizeThinkingMode('fast'), 'off');
  assert.equal(normalizeThinkingMode('on'), 'on');
  assert.equal(normalizeThinkingMode('true'), 'on');
  assert.equal(normalizeThinkingMode('auto'), 'auto');
  assert.equal(normalizeThinkingMode(''), 'auto');
  assert.equal(normalizeThinkingMode(undefined), 'auto');
});

test('auto 不加任何参数（跟着模型默认行为走，最稳）', () => {
  assert.deepEqual(thinkingPayload({ provider: 'siliconflow', model: 'Qwen/Qwen3-8B' }, 'auto'), {});
  assert.deepEqual(withThinking({ model: 'x', messages: [] }, { provider: 'zhipu' }, 'auto'), { model: 'x', messages: [] });
});

test('硅基流动：关思考只发 enable_thinking:false（不能带 thinking_budget:0）', () => {
  const p = { provider: 'siliconflow', model: 'Qwen/Qwen3-8B' };
  // ★ 回归：v1.33.0 内置翻译在 Qwen/Qwen3-8B 上直接 400 ——
  //   {"code":20015,"message":"Value error, `thinking_budget` must be greater than 0."}
  //   硅基流动对 thinking_budget 的校验是「必须 > 0」，关思考时发 0 必挂。
  assert.deepEqual(thinkingPayload(p, 'off'), { enable_thinking: false });
  assert.equal('thinking_budget' in thinkingPayload(p, 'off'), false, '关思考时不能带 thinking_budget');
  assert.deepEqual(thinkingPayload(p, 'on'), { enable_thinking: true });
  assert.deepEqual(thinkingPayload(p, 'on', { budget: 512 }), { enable_thinking: true, thinking_budget: 512 });
  // budget 传 0 / 负数 / 非数字都视为「不限」，不能变成非法值
  assert.deepEqual(thinkingPayload(p, 'on', { budget: 0 }), { enable_thinking: true });
  assert.deepEqual(thinkingPayload(p, 'on', { budget: -5 }), { enable_thinking: true });
  assert.deepEqual(thinkingPayload(p, 'on', { budget: 'abc' }), { enable_thinking: true });
});

test('智谱 GLM-4.5 用 thinking.{type}，DeepSeek 官方两种模式都不加字段', () => {
  assert.deepEqual(thinkingPayload({ provider: 'zhipu', model: 'glm-4.6' }, 'off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(thinkingPayload({ provider: 'zhipu', model: 'glm-4.6' }, 'on'), { thinking: { type: 'enabled' } });
  // deepseek-reasoner 本来就不允许关思考，硬塞参数只会换来 400
  assert.deepEqual(thinkingPayload({ provider: 'deepseek', model: 'deepseek-reasoner' }, 'off'), {});
  assert.deepEqual(thinkingPayload({ provider: 'deepseek', model: 'deepseek-chat' }, 'on'), {});
});

test('withThinking 不改原对象；stripThinking 能按名单摘干净', () => {
  const original = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const merged = withThinking(original, { provider: 'siliconflow' }, 'off');
  assert.equal(original.enable_thinking, undefined, '不能污染调用方的 payload');
  assert.equal(merged.enable_thinking, false);
  const stripped = stripThinking(merged);
  for (const k of THINKING_KEYS) assert.equal(stripped[k], undefined, `${k} 没被摘掉`);
  assert.deepEqual(stripped, original, '摘掉后应与原 payload 完全一致');
});

test('「不认参数」的判定：只认 400/422 且文本点名参数', () => {
  assert.ok(looksLikeThinkingParamError(400, '{"error":{"message":"invalid parameter: enable_thinking"}}'));
  assert.ok(looksLikeThinkingParamError(422, 'Unknown field: thinking_budget'));
  // 反例：模型不存在 / 鉴权失败 / 限流 都不是参数问题，摘掉重试也救不回来
  assert.ok(!looksLikeThinkingParamError(404, 'model not found'));
  assert.ok(!looksLikeThinkingParamError(401, 'invalid api key'));
  assert.ok(!looksLikeThinkingParamError(429, 'rate limit exceeded'));
  assert.ok(!looksLikeThinkingParamError(400, 'context length too long'));
});

test('模型名能大致判断是否「默认就会思考」', () => {
  assert.ok(modelMayThink({ model: 'deepseek-ai/DeepSeek-R1' }));
  assert.ok(modelMayThink({ model: 'Qwen/Qwen3-235B-A22B' }));
  assert.ok(!modelMayThink({ model: 'deepseek-ai/DeepSeek-V4-Flash' }));
  assert.ok(!modelMayThink({ model: '' }));
});

// ---------- postWithThinkingFallback：被 400 打回就摘掉参数重发一次 ----------

/** 造一个够用的假 Response（只实现本函数用到的 ok / status / clone().text()） */
function fakeRes(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() { return { text: async () => body }; },
    text: async () => body,
  };
}

test('请求成功时不重发（别平白多打一次上游）', async () => {
  const calls = [];
  const { res, retried, thinkingRejected } = await postWithThinkingFallback(
    async (p) => { calls.push(p); return fakeRes(200, '{"ok":1}'); },
    { model: 'm', enable_thinking: false },
  );
  assert.equal(calls.length, 1);
  assert.equal(res.status, 200);
  assert.equal(retried, false);
  assert.equal(thinkingRejected, false);
});

test('400 且点名思考参数 → 摘掉这些键重发，并报告 thinkingRejected', async () => {
  const calls = [];
  const { res, payload, retried, thinkingRejected } = await postWithThinkingFallback(
    async (p) => {
      calls.push({ ...p });
      return calls.length === 1
        ? fakeRes(400, '{"code":20015,"message":"Value error, `thinking_budget` must be greater than 0."}')
        : fakeRes(200, '{"choices":[]}');
    },
    { model: 'Qwen/Qwen3-8B', enable_thinking: false, thinking_budget: 0, messages: [] },
  );
  assert.equal(calls.length, 2, '应当重发一次');
  assert.equal(res.status, 200);
  assert.equal(retried, true);
  assert.equal(thinkingRejected, true);
  for (const k of THINKING_KEYS) assert.equal(payload[k], undefined, `${k} 应被摘掉`);
  assert.equal(payload.model, 'Qwen/Qwen3-8B', '业务字段不能动');
  assert.deepEqual(payload.messages, [], '业务字段不能动');
  assert.equal(calls[0].thinking_budget, 0, '第一次要发原样 payload');
  assert.equal('thinking_budget' in calls[1], false, '第二次不能再带思考参数');
});

test('400 但与思考参数无关（上下文超长）→ 不重发，原样返回', async () => {
  const calls = [];
  const { res, retried } = await postWithThinkingFallback(
    async (p) => { calls.push(p); return fakeRes(400, 'context length too long'); },
    { model: 'm', enable_thinking: false },
  );
  assert.equal(calls.length, 1);
  assert.equal(res.status, 400);
  assert.equal(retried, false);
});

test('payload 本来就没有思考参数 → 不重发（无从摘起）', async () => {
  const calls = [];
  const { retried } = await postWithThinkingFallback(
    async (p) => { calls.push(p); return fakeRes(400, 'invalid parameter: foo'); },
    { model: 'm', messages: [] },
  );
  assert.equal(calls.length, 1);
  assert.equal(retried, false);
});

test('重发后仍失败 → 只重发一次，把第二次的错误交回调用方', async () => {
  const calls = [];
  const { res, thinkingRejected } = await postWithThinkingFallback(
    async (p) => {
      calls.push(p);
      // 第一次：参数被嫌；第二次：真限流
      return calls.length === 1
        ? fakeRes(400, 'invalid parameter: thinking_budget')
        : fakeRes(429, 'rate limit exceeded');
    },
    { model: 'm', enable_thinking: false },
  );
  assert.equal(calls.length, 2, '不允许无限重试');
  assert.equal(res.status, 429, '应把摘掉参数后那次的结果交回调用方');
  assert.equal(thinkingRejected, true);
});
