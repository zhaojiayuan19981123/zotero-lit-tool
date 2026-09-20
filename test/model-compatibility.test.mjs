import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('模型连通性测试与实际聊天同时验证 system、无鉴权、本地完整 endpoint 与非流式回退', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-model-compat-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const received = [];
  const llm = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    received.push({ headers: req.headers, body, url: req.url });
    // 模拟常见本地服务：拒绝 system role，也不支持 SSE，但支持普通 JSON。
    if (body.messages?.some((message) => message.role === 'system')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'system role is unsupported' } }));
    }
    if (body.stream) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'stream is unsupported' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '本地模型回复正常' } }] }));
  });

  let appServer;
  try {
    const llmBaseUrl = await listen(llm);
    const fullEndpoint = `${llmBaseUrl}/v1/chat/completions`;
    store.configure({ dataDir });
    store.saveSettings({
      aiProvider: 'custom', _modelMigrated: true, activeProfileId: 'local',
      modelProfiles: [{
        id: 'local', label: 'Local', provider: 'custom', baseURL: fullEndpoint,
        apiKey: '', model: 'mock-local', streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none',
        visionOverride: 'no', createdAt: new Date().toISOString(),
      }],
    });
    const { app } = createApp({ uploadDir });
    const appBaseUrl = await listen(appServer = createServer(app));

    const tested = await fetch(`${appBaseUrl}/api/models/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', baseURL: fullEndpoint, apiKey: '', model: 'mock-local', streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none' }),
    });
    assert.equal(tested.status, 200);
    const testResult = await tested.json();
    assert.equal(testResult.ok, true);
    assert.equal(testResult.mode, 'nonstream');
    assert.equal(testResult.normalizedBaseURL, `${llmBaseUrl}/v1`);

    const created = await fetch(`${appBaseUrl}/api/chat/conversations`, { method: 'POST' });
    const conversation = await created.json();
    const chat = await fetch(`${appBaseUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id, content: '测试本地模型' }),
    });
    assert.equal(chat.status, 200);
    const stream = await chat.text();
    assert.match(stream, /本地模型回复正常/);
    assert.ok(received.length >= 5);
    assert.ok(received.every((item) => item.url === '/v1/chat/completions'));
    assert.ok(received.every((item) => !item.headers.authorization));
    assert.ok(received.some((item) => item.body.messages?.every((message) => message.role !== 'system')));
  } finally {
    if (appServer) await close(appServer);
    await close(llm);
    await rm(root, { recursive: true, force: true });
  }
});
