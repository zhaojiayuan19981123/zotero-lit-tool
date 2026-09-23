// Responses API 兼容性回归测试
//
// 背景（2026-09-24 用户报障）：在「论文阅读 → 与 AI 对话」里，第一轮问得通，第二轮开始报
//   AI 接口返回 400：{"code":"invalid_request","param":"input[1].content[0]", ...}
// 根因：切到 /responses 端点时，历史里的 assistant 消息被写成了 input_text part，
// 而上游要求 assistant 只能用 output_text（或纯字符串）。input[1] 指向的正是「上一轮回答」。
//
// 这里的 mock 上游严格复刻那个校验，用来证明：
//   1) 旧写法确实会被拒（防止测试变成「永远为真」）；
//   2) 修复后带历史的多轮对话在 /responses 上能正常作答；
//   3) 端点自动切换 / 补 /v1 / 失败原因汇总这些兜底行为都还在。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';

const ASSISTANT_PART_ERROR = {
  error: {
    code: 'invalid_request',
    message: "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'.",
    param: 'input[1].content[0]',
    type: 'invalid_request_error',
  },
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** 可编程的假上游：routes 的 key 是完整路径，value 为 (body) => {status, contentType, body} */
function mockUpstream(routes) {
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) { /* 非 JSON 请求体按空处理 */ }
    received.push({ url: req.url, body });
    const handler = routes[req.url];
    const out = typeof handler === 'function' ? handler(body) : handler;
    if (!out) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'no such route: ' + req.url } }));
    }
    res.writeHead(out.status || 200, { 'Content-Type': out.contentType || 'application/json' });
    return res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
  });
  return { server, received };
}

/** Responses 端点的合法成功响应（SSE 事件流，形状与官方一致） */
function responsesStream(text) {
  return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`
    + `data: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`
    + 'data: [DONE]\n\n';
}

/** 复刻严格网关的校验：assistant 项的 content part 不允许出现 input_text */
function rejectAssistantInputText(body) {
  const items = Array.isArray(body.input) ? body.input : [];
  const index = items.findIndex((item) => item?.role === 'assistant'
    && Array.isArray(item.content)
    && item.content.some((part) => part?.type === 'input_text'));
  if (index < 0) return null;
  return { status: 400, body: { error: { ...ASSISTANT_PART_ERROR.error, param: `input[${index}].content[0]` } } };
}

async function withApp(profile, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-responses-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  let appServer = null;
  try {
    store.configure({ dataDir });
    store.saveSettings({
      aiProvider: 'custom',
      _modelMigrated: true,
      activeProfileId: 'target',
      modelProfiles: [{
        id: 'target', label: 'Target', provider: 'custom', baseURL: profile.baseURL,
        apiKey: '', model: profile.model || 'mock-model',
        streamMode: profile.streamMode || 'auto',
        systemPromptMode: 'auto', authMode: 'none',
        apiFormat: profile.apiFormat || 'auto',
        visionOverride: 'no', createdAt: new Date().toISOString(),
      }],
    });
    const { app } = createApp({ uploadDir });
    const base = await listen(appServer = createServer(app));
    await run(base);
  } finally {
    if (appServer) await close(appServer);
    await rm(root, { recursive: true, force: true });
  }
}

/** 发一轮对话，返回 SSE 原文 */
async function paperChat(baseUrl, messages) {
  const res = await fetch(`${baseUrl}/api/paper-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, profileId: 'target' }),
  });
  return { status: res.status, text: await res.text() };
}

const HISTORY_MESSAGES = [
  { role: 'system', content: '你是科研助理。' },
  { role: 'assistant', content: '上一轮我回答了摘要里的方法。' },
  { role: 'assistant', content: '' }, // 空内容历史：应被丢弃，不能变成空 input_text
  { role: 'user', content: '作者提出的核心方法是什么？' },
];

test('mock 上游会拒绝「assistant 用 input_text」：确保后续断言不是永远成立', async () => {
  const { server, received } = mockUpstream({
    '/v1/responses': (body) => rejectAssistantInputText(body) || { status: 200, body: { ok: true } },
  });
  try {
    const base = await listen(server);
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: '你好' }] },
          { role: 'assistant', content: [{ type: 'input_text', text: '旧写法' }] },
        ],
        stream: false,
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error.param, 'input[1].content[0]');
    assert.equal(received.length, 1);
    // 换成上游要求的写法就应该通过
    const ok = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: '你好' }] },
          { role: 'assistant', content: '新写法' },
        ],
        stream: false,
      }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await close(server);
  }
});

test('responses 端点：带历史的多轮对话不再被 400，且 assistant 历史不用 input_text', async () => {
  const { server, received } = mockUpstream({
    '/v1/responses': (body) => rejectAssistantInputText(body) || {
      status: 200, contentType: 'text/event-stream', body: responsesStream('核心方法是分层注意力。'),
    },
  });
  try {
    const base = await listen(server);
    await withApp({ baseURL: `${base}/v1`, apiFormat: 'responses' }, async (appBase) => {
      const { status, text } = await paperChat(appBase, HISTORY_MESSAGES);
      assert.equal(status, 200);
      assert.match(text, /核心方法是分层注意力。/, '应拿到模型回答：' + text.slice(0, 200));
      assert.doesNotMatch(text, /invalid_request|content\[0\]/, '不应再出现参数校验错误：' + text.slice(0, 200));

      assert.ok(received.length >= 1);
      const input = received[0].body.input;
      assert.ok(Array.isArray(input) && input.length >= 3, JSON.stringify(input));
      const assistant = input.filter((item) => item.role === 'assistant');
      assert.ok(assistant.length >= 1, 'assistant 历史应被保留：' + JSON.stringify(input));
      for (const item of assistant) {
        const parts = Array.isArray(item.content) ? item.content : [];
        assert.ok(!parts.some((part) => part.type === 'input_text'),
          'assistant 的 part 不能是 input_text：' + JSON.stringify(item));
      }
      // 空内容的历史消息不能发出去（空 input_text 同样非法）
      const flat = JSON.stringify(input);
      assert.doesNotMatch(flat, /"type":"input_text","text":""/, '不应出现空文本 part：' + flat);
      assert.equal(input.filter((item) => item.role === 'assistant').length, 1, '空内容历史应被丢弃');
      assert.equal(received[0].body.messages, undefined, 'responses 请求体不应带 messages 字段');
      assert.ok(received[0].body.max_output_tokens > 0);
    });
  } finally {
    await close(server);
  }
});

test('auto 模式：chat 端点 404 时自动切到 responses 并成功', async () => {
  const { server, received } = mockUpstream({
    '/v1/chat/completions': { status: 404, body: { error: { message: 'Not Found' } } },
    '/v1/responses': (body) => rejectAssistantInputText(body) || {
      status: 200, contentType: 'text/event-stream', body: responsesStream('已切换到 responses 端点。'),
    },
  });
  try {
    const base = await listen(server);
    await withApp({ baseURL: `${base}/v1`, apiFormat: 'auto' }, async (appBase) => {
      const { text } = await paperChat(appBase, HISTORY_MESSAGES);
      assert.match(text, /已切换到 responses 端点。/);
      const urls = received.map((item) => item.url);
      assert.ok(urls.includes('/v1/chat/completions'), '应先尝试 chat 端点：' + urls.join(','));
      assert.ok(urls.includes('/v1/responses'), '应回退到 responses 端点：' + urls.join(','));
    });
  } finally {
    await close(server);
  }
});

test('auto 模式：上游提示改用 responses、且只收 output_text 时，自动换 part 写法成功', async () => {
  const { server, received } = mockUpstream({
    '/v1/chat/completions': {
      status: 400,
      body: { error: { message: 'This model is not supported on /chat/completions, please use /responses' } },
    },
    // 这个假上游更严格：连 assistant 的纯字符串都不收，只认 output_text
    '/v1/responses': (body) => {
      const items = Array.isArray(body.input) ? body.input : [];
      const bad = items.findIndex((item) => item?.role === 'assistant'
        && (typeof item.content === 'string'
          || (Array.isArray(item.content) && item.content.some((part) => part?.type === 'input_text'))));
      if (bad >= 0) {
        return {
          status: 400,
          body: {
            error: {
              code: 'invalid_request',
              message: "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'.",
              param: `input[${bad}].content[0]`,
              type: 'invalid_request_error',
            },
          },
        };
      }
      return { status: 200, contentType: 'text/event-stream', body: responsesStream('换写法后成功。') };
    },
  });
  try {
    const base = await listen(server);
    await withApp({ baseURL: `${base}/v1`, apiFormat: 'auto' }, async (appBase) => {
      const { text } = await paperChat(appBase, HISTORY_MESSAGES);
      assert.match(text, /换写法后成功。/);
      const responsesCalls = received.filter((item) => item.url === '/v1/responses');
      assert.ok(responsesCalls.length >= 2, '应重试一次换 part 写法：' + responsesCalls.length);
      const last = responsesCalls[responsesCalls.length - 1].body.input;
      const assistant = last.find((item) => item.role === 'assistant');
      assert.ok(assistant.content.some((part) => part.type === 'output_text'), JSON.stringify(assistant));
    });
  } finally {
    await close(server);
  }
});

test('auto 模式：Base URL 少写 /v1 时，自动补 /v1 重试（而不是把网关首页当回答）', async () => {
  const { server, received } = mockUpstream({
    '/chat/completions': { status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body>网关首页</body></html>' },
    '/v1/chat/completions': { status: 200, body: { choices: [{ message: { content: '补 /v1 后正常回答。' } }] } },
  });
  try {
    const base = await listen(server);
    await withApp({ baseURL: base, apiFormat: 'auto' }, async (appBase) => {
      const { text } = await paperChat(appBase, HISTORY_MESSAGES);
      assert.match(text, /补 \/v1 后正常回答。/);
      assert.doesNotMatch(text, /网关首页/, '不应把网页内容当成模型回答');
      assert.ok(received.some((item) => item.url === '/v1/chat/completions'), received.map((i) => i.url).join(','));
    });
  } finally {
    await close(server);
  }
});

test('所有端点都失败时，错误信息列出每个端点及各自原因', async () => {
  const { server } = mockUpstream({
    '/v1/chat/completions': { status: 404, body: { error: { message: 'no route' } } },
    '/v1/responses': { status: 500, body: { error: { message: 'upstream boom' } } },
  });
  try {
    const base = await listen(server);
    await withApp({ baseURL: `${base}/v1`, apiFormat: 'auto' }, async (appBase) => {
      const { text } = await paperChat(appBase, HISTORY_MESSAGES);
      assert.match(text, /AI 接口调用失败（已尝试 2 个端点）/);
      assert.match(text, /chat\/completions → HTTP 404/);
      assert.match(text, /responses → HTTP 500/);
      assert.match(text, /upstream boom/, '第二个端点的真实原因也要保留');
    });
  } finally {
    await close(server);
  }
});
