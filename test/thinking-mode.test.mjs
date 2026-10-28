// thinking-mode.test.mjs —— 「思考（reasoning）」开关的参数写法
//
// 为什么单独测：关思考能让文献解析从 60~120 秒降到 10~30 秒，但各家参数名不同、
// 而且不认识该参数的上游会直接 400。这个开关既要有用，又不能把整条链路搞挂，
// 所以「写什么参数」与「什么时候该摘掉」都必须钉住。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeThinkingMode, thinkingPayload, withThinking, stripThinking,
  looksLikeThinkingParamError, modelMayThink, THINKING_KEYS,
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

test('硅基流动：关思考 = enable_thinking:false + budget 0；开思考 = true', () => {
  const p = { provider: 'siliconflow', model: 'Qwen/Qwen3-8B' };
  assert.deepEqual(thinkingPayload(p, 'off'), { enable_thinking: false, thinking_budget: 0 });
  assert.deepEqual(thinkingPayload(p, 'on'), { enable_thinking: true });
  assert.deepEqual(thinkingPayload(p, 'on', { budget: 512 }), { enable_thinking: true, thinking_budget: 512 });
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
