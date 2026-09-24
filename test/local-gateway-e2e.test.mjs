// 本地 OpenAI 兼容端口的 HTTP 级集成测试。
//
// 单测（test/local-gateway.test.mjs）验证的是网关自己的管道逻辑（路由 / CORS / 形状），
// 这里跑的是**真实链路**：真起一个监听端口、用真 fetch 打 /v1/chat/completions，
// 看它是否真的复用了本应用的「多模型队列 + 故障转移」—— 也就是用户要的
// 「让别的软件填 http://127.0.0.1:15721 就能用上我配好的模型」这件事到底通不通。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startServer } from '../server.js';
import * as store from '../src/store.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
    // 不清掉空闲的 keep-alive 连接的话，server.close() 要等默认 5 秒 keepAliveTimeout 才收尾 ——
    // 几个 mock 上游加起来能让这个文件白等二十秒。
    server.closeAllConnections?.();
  });
}

/** 带上 Connection: close：undici 的 keep-alive 复用会让「服务端已关」变成偶发的 fetch failed */
function req(url, init = {}) {
  return fetch(url, { ...init, headers: { Connection: 'close', ...(init.headers || {}) } });
}

function postJson(url, body) {
  return req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockUpstream(handler) {
  return createServer(async (r, res) => {
    let raw = '';
    for await (const chunk of r) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
    handler(body, res, r);
  });
}

/** 答复固定的上游：按请求体的 stream 字段分别用 SSE / JSON 回 */
function answeringUpstream(text, hits) {
  return mockUpstream((body, res) => {
    hits?.push(body);
    if (body.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 切成两段发，顺便验证网关是把上游的多个 delta 原样转发、而不是攒成一段
      for (const part of [text.slice(0, 2), text.slice(2)]) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: part } }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
}

/** 从我们吐出的标准 SSE 里取出拼接后的文本，顺带把 chunk 也返回 */
function parseSse(body) {
  const chunks = [];
  let done = false;
  for (const line of String(body).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') { done = true; continue; }
    try { chunks.push(JSON.parse(payload)); } catch (_) { /* 忽略非 JSON 帧 */ }
  }
  return {
    chunks,
    done,
    text: chunks.map((c) => c?.choices?.[0]?.delta?.content || '').join(''),
  };
}

/** 在 [20000, 60000) 里挑一个能真正 listen 成功的端口，避免和真实运行的 15721 撞车 */
async function pickFreePort() {
  for (let i = 0; i < 20; i++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const probe = createServer();
    const ok = await new Promise((resolve) => {
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) { await close(probe); return port; }
  }
  throw new Error('找不到空闲端口');
}

async function waitForGateway(base, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await (await req(`${base}/api/gateway/status`)).json();
    if (!!last?.running === expected) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

function baseSettings(port) {
  return {
    aiProvider: 'custom',
    _modelMigrated: true,
    activeProfileId: 'p1',
    // 关掉出站代理：这一段测的是本地端口，不要让它去探真实的 10809 / 7890（测试要保持自洽）
    outboundProxy: { mode: 'off' },
    localGateway: { enabled: true, port },
    modelRouter: {
      enabled: true,
      failover: true,
      queue: ['p2'],
      timeoutSeconds: 20,
      breaker: { failThreshold: 3, openSeconds: 60, minRequests: 10, errorRate: 90 },
    },
  };
}

test('本地端口：别的软件用 127.0.0.1:<port>/v1 就能复用本应用的模型与故障转移', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-gateway-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');

  const hits = { primary: [], backup: [], bad: [] };
  const primary = answeringUpstream('主供应商的回答', hits.primary);
  const backup = answeringUpstream('备用供应商的回答', hits.backup);
  const bad = mockUpstream((body, res) => {
    hits.bad.push(body);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '主供应商挂了' } }));
  });

  let handle = null;
  let badBase = '';
  try {
    const primaryBase = await listen(primary);
    const backupBase = await listen(backup);
    badBase = await listen(bad);

    store.configure({ dataDir });
    const port = await pickFreePort();
    store.saveSettings({
      ...baseSettings(port),
      modelProfiles: [
        {
          id: 'p1', label: '主供应商', provider: 'custom',
          baseURL: `${primaryBase}/v1/chat/completions`, apiKey: '', model: 'mock-primary',
          streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'p2', label: '备用供应商', provider: 'custom',
          baseURL: `${backupBase}/v1/chat/completions`, apiKey: '', model: 'mock-backup',
          streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    handle = await startServer({ dataDir, uploadDir, port: 0, startGateway: true });
    const base = `http://127.0.0.1:${handle.port}`;
    const gw = `http://127.0.0.1:${port}`;

    const status = handle.gateway.status();
    assert.equal(status.running, true, `本地端口应当在 ${port} 上监听（实际错误：${status.error}）`);
    assert.equal(status.host, '127.0.0.1', '只绑回环，绝不暴露到局域网');
    assert.equal(status.baseURL, `http://127.0.0.1:${port}/v1`);

    // ---------- ① 健康检查与模型列表：调用方（各种客户端）先探活用 ----------
    const health = await req(`${gw}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const models = await (await req(`${gw}/v1/models`)).json();
    assert.equal(models.object, 'list');
    assert.equal(models.data.length, 2);
    // id 必须是「客户端该填回 model 字段的那个名字」，也就是真实模型名 —— 这是 OpenAI 的约定
    assert.deepEqual(models.data.map((m) => m.id).sort(), ['mock-backup', 'mock-primary'],
      '应当把已配置的模型都列出来，客户端才能选');
    const p1Model = models.data.find((m) => m.id === 'mock-primary');
    assert.equal(p1Model.profileId, 'p1', '同时要带上配置 id，便于用户对照设置界面');
    assert.equal(p1Model.label, '主供应商');

    // ---------- ② 浏览器里的客户端会先发预检 ----------
    const preflight = await req(`${gw}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

    // ---------- ③ 非流式：不带 model → 用「当前激活模型」 ----------
    const plainRes = await postJson(`${gw}/v1/chat/completions`, {
      messages: [{ role: 'user', content: '你好' }],
    });
    assert.equal(plainRes.status, 200);
    const plain = await plainRes.json();
    assert.equal(plain.object, 'chat.completion');
    assert.equal(plain.choices[0].message.role, 'assistant');
    assert.equal(plain.choices[0].message.content, '主供应商的回答');
    assert.equal(plain.choices[0].finish_reason, 'stop');
    assert.equal(plain.model, 'mock-primary', '没指定 model 时用激活模型，回包也要如实标注');
    assert.match(plain.id, /^chatcmpl-/);
    assert.equal(hits.primary.length, 1, '上游只该被调一次');
    assert.equal(hits.backup.length, 0);

    // ---------- ③b 把 /v1/models 里给出的名字填回 model —— 客户端「选模型」靠这条 ----------
    const picked = await (await postJson(`${gw}/v1/chat/completions`, {
      model: p1Model.id, messages: [{ role: 'user', content: '按列表里的名字点一次' }],
    })).json();
    assert.equal(picked.model, 'mock-primary', '列表里的名字必须能被认出来，否则选模型就是摆设');
    assert.equal(picked.choices[0].message.content, '主供应商的回答');
    assert.equal(hits.primary.length, 2);

    // ---------- ④ 流式 + model 指定：应当选中那一条配置，并且不去打扰别人 ----------
    const primaryBeforeStream = hits.primary.length;
    const backupHitsBefore = hits.backup.length;
    const streamRes = await postJson(`${gw}/v1/chat/completions`, {
      model: 'mock-backup',
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: '说点什么' }] }],
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type') || '', /text\/event-stream/);
    const sse = parseSse(await streamRes.text());
    assert.equal(sse.text, '备用供应商的回答');
    assert.equal(sse.done, true, '流式输出必须以 data: [DONE] 收尾，否则客户端会一直等');
    assert.equal(sse.chunks[0].object, 'chat.completion.chunk');
    assert.equal(sse.chunks[0].model, 'mock-backup');
    assert.equal(hits.backup.length, backupHitsBefore + 1, 'model 命中哪条就用哪条做主供应商');
    assert.equal(hits.primary.length, primaryBeforeStream, '指定了备用就不该再去问主供应商');
    // 分片数组形式的 content 也要能被归一化成文本（很多客户端这么发）
    assert.equal(hits.backup.at(-1).messages.at(-1).content, '说点什么');

    // 本地端口的请求也要计入路由用量 —— 它不是「旁路」，用的是同一套记账
    const st1 = await (await req(`${base}/api/router/status`)).json();
    assert.equal(st1.totalRequests, 3, '本地端口的请求也要计入路由统计');

    // ---------- ⑤ 主供应商 500 → 自动切备用（这才是把这里做成端口的意义） ----------
    const s = store.getSettings();
    s.modelProfiles = s.modelProfiles.map((p) => (p.id === 'p1'
      ? { ...p, baseURL: `${badBase}/v1/chat/completions` }
      : p));
    store.saveSettings(s);
    const badHitsBefore = hits.bad.length;
    const failoverHitsBefore = hits.backup.length;

    const failover = await postJson(`${gw}/v1/chat/completions`, {
      messages: [{ role: 'user', content: '再问一次' }],
    });
    assert.equal(failover.status, 200, '主供应商挂了也不该把错误甩给调用方');
    const fo = await failover.json();
    assert.equal(fo.choices[0].message.content, '备用供应商的回答', '应当由备用供应商给出回答');
    assert.ok(hits.bad.length > badHitsBefore, '坏掉的主供应商应当真的被尝试过');
    assert.equal(hits.backup.length, failoverHitsBefore + 1, '应当自动切到备用');

    const st2 = await (await req(`${base}/api/router/status`)).json();
    assert.ok(st2.failovers >= 1, '故障转移次数要如实记录');
    assert.equal(st2.providers.find((x) => x.id === 'p1').failures, 1);
    assert.equal(st2.providers.find((x) => x.id === 'p2').successes, 2);

    // ---------- ⑥ 参数不合法 / 未知路径：给 OpenAI 形状的错误，客户端才好提示 ----------
    const noMessages = await postJson(`${gw}/v1/chat/completions`, { model: 'mock-primary', messages: [] });
    assert.equal(noMessages.status, 400);
    assert.match((await noMessages.json()).error.message, /messages/);

    const badJson = await req(`${gw}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{不是 JSON',
    });
    assert.equal(badJson.status, 400);
    assert.match((await badJson.json()).error.message, /JSON/);

    const notFound = await req(`${gw}/v1/nope`);
    assert.equal(notFound.status, 404);
    assert.match((await notFound.json()).error.message, /未知接口/);

    // 老式补全接口的别名也要能用（很多工具还在打这个）
    const legacy = await postJson(`${gw}/v1/completions`, {
      messages: [{ role: 'user', content: '老接口' }],
    });
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).choices[0].message.content, '备用供应商的回答');
  } finally {
    if (handle) {
      await handle.stopGateway();
      await close(handle.server);
    }
    await close(primary);
    await close(backup);
    await close(bad);
    await rm(root, { recursive: true, force: true });
  }
});

test('本地端口：开关与端口改动能通过设置接口即时生效', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-gateway-toggle-'));
  const dataDir = path.join(root, 'data');
  const hits = { primary: [] };
  const primary = answeringUpstream('ok', hits.primary);

  let handle = null;
  try {
    const primaryBase = await listen(primary);
    store.configure({ dataDir });
    const port = await pickFreePort();
    store.saveSettings({
      ...baseSettings(port),
      // 先关掉：没开的时候绝不能占用端口
      localGateway: { enabled: false, port },
      modelProfiles: [{
        id: 'p1', label: '唯一供应商', provider: 'custom',
        baseURL: `${primaryBase}/v1/chat/completions`, apiKey: '', model: 'mock-primary',
        streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no',
        createdAt: new Date().toISOString(),
      }],
    });

    handle = await startServer({ dataDir, uploadDir: path.join(root, 'uploads'), port: 0, startGateway: true });
    const base = `http://127.0.0.1:${handle.port}`;

    let status = handle.gateway.status();
    assert.equal(status.running, false, '关掉开关时不应监听');
    assert.equal(status.baseURL, '');
    await assert.rejects(() => req(`http://127.0.0.1:${port}/health`), '关掉后端口应当连不上');

    // 打开开关 → 端口起来
    await postJson(`${base}/api/settings`, { localGateway: { enabled: true, port } });
    status = await waitForGateway(base, true);
    assert.equal(status.running, true, `打开开关后应当监听（实际：${status.error}）`);
    assert.equal(status.actualPort, port);
    assert.equal((await (await req(`http://127.0.0.1:${port}/health`)).json()).ok, true);

    // 换端口 → 旧的让出来、新的接上
    const port2 = await pickFreePort();
    await postJson(`${base}/api/settings`, { localGateway: { enabled: true, port: port2 } });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && handle.gateway.status().actualPort !== port2) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(handle.gateway.status().actualPort, port2, '改端口后应当搬到新端口');
    assert.equal((await (await req(`http://127.0.0.1:${port2}/health`)).json()).ok, true);

    // 关掉 → 新端口也释放
    await postJson(`${base}/api/settings`, { localGateway: { enabled: false, port: port2 } });
    status = await waitForGateway(base, false);
    assert.equal(status.running, false);
    await assert.rejects(() => req(`http://127.0.0.1:${port2}/health`), '关掉后端口应当连不上');
  } finally {
    if (handle) {
      await handle.stopGateway();
      await close(handle.server);
    }
    await close(primary);
    await rm(root, { recursive: true, force: true });
  }
});
