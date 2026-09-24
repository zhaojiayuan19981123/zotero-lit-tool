// 本地 OpenAI 兼容端口的单测。
// 纯函数部分直接断言；HTTP 部分真的起一个服务、真的用 fetch 打过去，
// 用假的 handleChat 顶替模型调用 —— 这里要验的是「管道的形状对不对」（协议、CORS、错误形状、端口占用），
// 至于「怎么调模型」由 server.js 的集成测试负责。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  DEFAULT_GATEWAY_CONFIG, normalizeGatewayConfig, readGatewayConfig,
  normalizeMessages, pickProfileByModel, buildChatCompletion, createChunkWriter, createLocalGateway,
} from '../src/localGateway.js';

// ---------------- A. 纯函数 ----------------

test('配置：默认开启、端口 15721、只绑回环', () => {
  const cfg = normalizeGatewayConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.port, 15721);
  assert.equal(cfg.host, '127.0.0.1');
});

test('配置：端口被钳制到合法范围，非法值回落默认', () => {
  assert.equal(normalizeGatewayConfig({ port: 80 }).port, 1024);
  assert.equal(normalizeGatewayConfig({ port: 99999 }).port, 65535);
  assert.equal(normalizeGatewayConfig({ port: 'abc' }).port, DEFAULT_GATEWAY_CONFIG.port);
  assert.equal(normalizeGatewayConfig({ port: 18080 }).port, 18080);
  assert.equal(normalizeGatewayConfig({ enabled: false }).enabled, false);
});

test('配置：host 不可被改（永远只绑回环，防误暴露到局域网）', () => {
  assert.equal(normalizeGatewayConfig({ host: '0.0.0.0' }).host, '127.0.0.1');
});

test('消息归一化：content 支持字符串与分片数组两种写法', () => {
  const msgs = normalizeMessages([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'text', text: '并回答' }] },
  ]);
  assert.deepEqual(msgs, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '看这张图并回答' },
  ]);
});

test('消息归一化：丢掉空内容（空 content 会让 Responses API 直接报参数非法）', () => {
  const msgs = normalizeMessages([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '' },
    { role: 'user', content: [] },
    { role: 'assistant', content: '在的' },
  ]);
  assert.deepEqual(msgs.map((m) => m.content), ['你好', '在的']);
});

test('消息归一化：developer 降级为 system；未知角色当 user；tool 消息跳过', () => {
  const msgs = normalizeMessages([
    { role: 'developer', content: '规则' },
    { role: 'tool', content: '工具结果' },
    { role: '奇怪角色', content: '内容' },
  ]);
  assert.deepEqual(msgs, [
    { role: 'system', content: '规则' },
    { role: 'user', content: '内容' },
  ]);
});

test('选模型：模型名 / id / 显示名 / 带厂商前缀都能命中，都不中返回 null', () => {
  const profiles = [
    { id: 'p1', label: '主供应商', model: 'gpt-5.6-terra' },
    { id: 'p2', label: '备用一号', model: 'deepseek-ai/DeepSeek-V4-Flash' },
  ];
  assert.equal(pickProfileByModel(profiles, 'gpt-5.6-terra').id, 'p1');
  assert.equal(pickProfileByModel(profiles, 'GPT-5.6-TERRA').id, 'p1', '大小写不敏感');
  assert.equal(pickProfileByModel(profiles, 'p2').id, 'p2');
  assert.equal(pickProfileByModel(profiles, '备用一号').id, 'p2');
  assert.equal(pickProfileByModel(profiles, 'deepseek-v4-flash').id, 'p2', '容忍带厂商前缀的写法');
  assert.equal(pickProfileByModel(profiles, '不存在的模型'), null);
  assert.equal(pickProfileByModel(profiles, ''), null);
});

test('响应体构造：是标准 chat.completion 形状', () => {
  const body = buildChatCompletion({ id: 'chatcmpl-x', model: 'demo', content: '你好', created: 123 });
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.id, 'chatcmpl-x');
  assert.equal(body.created, 123);
  assert.deepEqual(body.choices[0].message, { role: 'assistant', content: '你好' });
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.ok(body.usage);
});

test('SSE chunk 写入器：delta / finish / done 都是标准 OpenAI 形状', () => {
  const written = [];
  const res = { write: (s) => written.push(s), end: () => written.push('__END__') };
  const w = createChunkWriter(res, { id: 'chatcmpl-y', model: 'demo', created: 7 });
  w.delta('你');
  w.delta('好');
  w.delta('');        // 空 delta 不该产生事件
  w.finish('stop');
  w.done();

  const events = written
    .filter((s) => s !== '__END__' && !s.includes('[DONE]'))
    .map((s) => JSON.parse(s.replace(/^data: /, '')));
  assert.equal(events.length, 3);
  assert.equal(events[0].object, 'chat.completion.chunk');
  assert.equal(events[0].choices[0].delta.content, '你');
  assert.equal(events[1].choices[0].delta.content, '好');
  assert.equal(events[2].choices[0].finish_reason, 'stop');
  assert.equal(written[written.length - 2], 'data: [DONE]\n\n');
  assert.equal(written[written.length - 1], '__END__');
});

test('SSE chunk 写入器：对端断开后不再抛错', () => {
  let boom = false;
  const res = { write: () => { boom = true; throw new Error('socket closed'); }, end: () => {} };
  const w = createChunkWriter(res, { id: 'x', model: 'demo' });
  assert.doesNotThrow(() => { w.delta('a'); w.delta('b'); w.done(); });
  assert.equal(boom, true);
});

// ---------------- B. 真的起服务 ----------------

/**
 * 测试内的请求一律强制 Connection: close。
 * 原因：undici（Node 的 fetch）默认复用 keep-alive 连接，而每个用例都会新起并关停一个服务，
 * 端口又会被系统回收复用 —— 复用到的可能正是上一轮已经关掉的 server 留下的 socket，
 * 于是偶发 "fetch failed"。强制关闭连接可以让每个用例都用全新连接，消除这种互相干扰。
 */
function req(url, init = {}) {
  return fetch(url, { ...init, headers: { ...(init.headers || {}), connection: 'close' } });
}

async function startGateway({ handleChat, listModels, port = 0, config = {} } = {}) {
  const cfg = { enabled: true, port, ...config };
  const gw = createLocalGateway({
    getConfig: () => cfg,
    handleChat: handleChat || (async () => {}),
    listModels: listModels || (() => []),
  });
  const r = await gw.start();
  return { gw, cfg, result: r, base: r.ok ? `http://127.0.0.1:${r.port}` : '' };
}

test('HTTP：GET /health 返回 200；未知路径返回 404 且是 OpenAI 形状的错误', async () => {
  const { gw, base } = await startGateway();
  try {
    const health = await req(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const nope = await req(`${base}/v1/embeddings`);
    assert.equal(nope.status, 404);
    const err = await nope.json();
    assert.ok(err.error && err.error.message.includes('/v1/chat/completions'));
  } finally { await gw.stop(); }
});

test('HTTP：GET /v1/models 列出已配置模型', async () => {
  const { gw, base } = await startGateway({
    listModels: () => [{ id: 'p1', label: '主供应商', model: 'gpt-5.6-terra', providerName: '自定义' }],
  });
  try {
    const j = await (await req(`${base}/v1/models`)).json();
    assert.equal(j.object, 'list');
    assert.equal(j.data.length, 1);
    assert.equal(j.data[0].id, 'gpt-5.6-terra');
    assert.equal(j.data[0].object, 'model');
  } finally { await gw.stop(); }
});

test('HTTP：非流式对话原样透传请求体、返回 chat.completion', async () => {
  let seen = null;
  const { gw, base } = await startGateway({
    handleChat: async ({ body, res }) => {
      seen = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildChatCompletion({ id: 'chatcmpl-t', model: body.model, content: '收到' })));
    },
  });
  try {
    const r = await req(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.choices[0].message.content, '收到');
    assert.equal(seen.model, 'demo');
    assert.equal(seen.stream, undefined, '未显式要求就不该带 stream');
  } finally { await gw.stop(); }
});

test('HTTP：流式对话产出标准 SSE chunk，并以 [DONE] 收尾', async () => {
  const { gw, base } = await startGateway({
    handleChat: async ({ body, res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const w = createChunkWriter(res, { id: 'chatcmpl-s', model: body.model });
      w.delta('流');
      w.delta('式');
      w.finish('stop');
      w.done();
    },
  });
  try {
    const r = await req(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'demo', stream: true, messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const text = await r.text();
    assert.ok(text.includes('"内容"') === false);
    assert.ok(text.includes('data: [DONE]'));
    const events = text.split('\n\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)));
    assert.equal(events.map((e) => e.choices[0].delta.content).filter(Boolean).join(''), '流式');
  } finally { await gw.stop(); }
});

test('HTTP：调用方断开时不应让服务端崩溃（流会被取消）', async () => {
  const { gw, base } = await startGateway({
    handleChat: async ({ res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 慢慢写，模拟长回答；客户端会在中途断开
      for (let i = 0; i < 50; i += 1) {
        if (res.writableEnded) return;
        try { res.write(`data: ${JSON.stringify({ i })}\n\n`); } catch (_) { return; }
        await new Promise((r) => setTimeout(r, 10));
      }
      try { res.end(); } catch (_) {}
    },
  });
  try {
    const ac = new AbortController();
    const p = req(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 60);
    await p.catch(() => {});
    // 服务还活着：还能正常响应
    const ok = await req(`${base}/health`);
    assert.equal(ok.status, 200);
  } finally { await gw.stop(); }
});

test('HTTP：handleChat 抛错 → 返回 OpenAI 形状的错误，且尊重 statusCode', async () => {
  const { gw, base } = await startGateway({
    handleChat: async () => {
      throw Object.assign(new Error('本应用还没有可用的模型配置'), { statusCode: 400 });
    },
  });
  try {
    const r = await req(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error.type, 'invalid_request_error');
    assert.match(j.error.message, /没有可用的模型配置/);
  } finally { await gw.stop(); }
});

test('HTTP：请求体不是 JSON → 400', async () => {
  const { gw, base } = await startGateway();
  try {
    const r = await req(`${base}/v1/chat/completions`, { method: 'POST', body: '{不是JSON' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /JSON/);
  } finally { await gw.stop(); }
});

test('HTTP：浏览器预检（OPTIONS）返回 204 与 CORS 头', async () => {
  const { gw, base } = await startGateway();
  try {
    const r = await req(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
  } finally { await gw.stop(); }
});

test('端口被占用：如实报错但不抛异常，主服务不受影响', async () => {
  const squatter = http.createServer();
  squatter.listen(0, '127.0.0.1');
  await once(squatter, 'listening');
  const takenPort = squatter.address().port;
  try {
    const { gw, result } = await startGateway({ port: takenPort });
    assert.equal(result.ok, false);
    assert.match(result.error, /已被占用/);
    const st = gw.status();
    assert.equal(st.running, false);
    assert.match(st.error, /已被占用/);
  } finally {
    await new Promise((r) => squatter.close(r));
  }
});

test('开关与端口变更：sync 会按需启停', async () => {
  const cfg = { enabled: false, port: 0 };
  const gw = createLocalGateway({ getConfig: () => cfg, handleChat: async () => {}, listModels: () => [] });
  try {
    await gw.sync();
    assert.equal(gw.status().running, false, '关着的时候不该监听');

    // 换成固定端口再开
    const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const freePort = probe.address().port; await new Promise((r) => probe.close(r));

    cfg.enabled = true; cfg.port = freePort;
    await gw.sync();
    assert.equal(gw.status().running, true);
    assert.equal(gw.status().actualPort, freePort);

    cfg.enabled = false;
    await gw.sync();
    assert.equal(gw.status().running, false);
  } finally { await gw.stop(); }
});

test('读配置：settings 里没有 localGateway 时用默认值', () => {
  assert.equal(readGatewayConfig({}).port, 15721);
  assert.equal(readGatewayConfig({ localGateway: { port: 18080, enabled: false } }).enabled, false);
});
