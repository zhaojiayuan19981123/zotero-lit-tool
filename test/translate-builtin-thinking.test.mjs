// translate-builtin-thinking.test.mjs —— 内置翻译模型遇到「思考参数不合法」的 400 时，
// 必须自动摘掉这些参数重发，而不是把 400 直接抛给用户。
//
// 起因（2026-10-29 用户反馈）：
//   内置翻译模型（Qwen/Qwen3-8B）返回 400:
//   {"code":20015,"message":"Value error, `thinking_budget` must be greater than 0."}
// 根因是「关思考」时同时发了 thinking_budget: 0（硅基流动要求 > 0），已从源头修掉；
// 这里钉住的是**第二道防线**：万一别的网关/别的模型也嫌弃这些参数，翻译功能不能整个不可用。
import assert from 'node:assert/strict';
import test from 'node:test';

import { translateWithBuiltin, resetBuiltinCache, BUILTIN_MODEL_CANDIDATES } from '../src/translateBuiltin.js';

const SILICONFLOW_400 = '{"code":20015,"message":"Value error, `thinking_budget` must be greater than 0.","data":null}';

const settings = {
  modelProfiles: [
    { id: 'sf', provider: 'siliconflow', baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'sk-test', model: 'Qwen/Qwen3-8B' },
  ],
  activeProfileId: 'sf',
};

/** 记录每次请求体，并按脚本返回响应 */
function stubFetch(script) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const res = script(calls.length, body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      clone() { return { text: async () => res.text || '' }; },
      text: async () => res.text || '',
      json: async () => JSON.parse(res.text || '{}'),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const okBody = (text) => JSON.stringify({ choices: [{ message: { content: text } }] });

test('内置翻译：先被 400 打回（thinking_budget 非法），摘掉参数重发后成功', async () => {
  resetBuiltinCache();
  const stub = stubFetch((n) => (n === 1 ? { status: 400, text: SILICONFLOW_400 } : { status: 200, text: okBody('译文内容') }));
  try {
    const out = await translateWithBuiltin('Hello world.', settings, 'zh');
    assert.equal(out, '译文内容');
    assert.equal(stub.calls.length, 2, '应当重发一次');
    // 第一次：按 thinkingPayload 正常发（这里已经是修好的写法，不含 thinking_budget:0）
    assert.equal(stub.calls[0].body.model, BUILTIN_MODEL_CANDIDATES[0]);
    // 第二次：思考参数一个都不能留
    for (const k of ['enable_thinking', 'thinking_budget', 'thinking', 'chat_template_kwargs', 'reasoning_effort']) {
      assert.equal(k in stub.calls[1].body, false, `第二次请求不该再带 ${k}`);
    }
    // 业务字段不能被动
    assert.equal(stub.calls[1].body.model, stub.calls[0].body.model);
    assert.equal(stub.calls[1].body.messages.length, 2);
  } finally {
    stub.restore();
  }
});

test('内置翻译：同一个端点被拒过一次后，后续请求不再白发思考参数', async () => {
  resetBuiltinCache();
  let phase = 0;
  const stub = stubFetch((n) => {
    // 第 1 次 400 → 第 2 次成功（这一次学会了「这个端点不认思考参数」）
    if (n === 1) return { status: 400, text: SILICONFLOW_400 };
    phase = n;
    return { status: 200, text: okBody('第二段译文') };
  });
  try {
    await translateWithBuiltin('First.', settings, 'zh');
    const afterFirst = stub.calls.length;
    assert.equal(afterFirst, 2);
    await translateWithBuiltin('Second.', settings, 'zh');
    assert.equal(stub.calls.length, 3, '第二次翻译只该打一次上游');
    assert.equal('enable_thinking' in stub.calls[2].body, false, '已经知道不认，就别再发');
    assert.equal(phase, 3);
  } finally {
    stub.restore();
  }
});

test('内置翻译：与思考参数无关的 400 不重发（别把真错误掩盖成"重试"）', async () => {
  resetBuiltinCache();
  const stub = stubFetch(() => ({ status: 400, text: '{"message":"messages is required"}' }));
  try {
    await assert.rejects(() => translateWithBuiltin('Hi.', settings, 'zh'), /返回 400/);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});
