import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { startServer } from './server.js';
import * as catalog from './src/modelCatalog.js';
import * as store from './src/store.js';

const root = path.resolve('./_vision_override_test_data');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const expectedVision = [
  'moonshotai/Kimi-K2.7-Code',
  'Qwen/Qwen3.8-27B',
  'Pro/moonshotai/Kimi-K2.6',
  'zai-org/GLM-4.5V',
  'Qwen/Qwen3.6-35B-A3B',
];
const silicon = catalog.getProvider('siliconflow');
for (const id of expectedVision) {
  assert.equal(catalog.modelSupportsVision('siliconflow', id), true, `${id} should be cataloged as vision`);
}
assert.equal(catalog.modelSupportsVision('siliconflow', 'Qwen/Qwen2.5-VL-72B-Instruct'), null, 'retired model should be unknown');
assert.equal(catalog.resolveVisionCapability({ provider: 'siliconflow', model: 'vendor/unknown', visionOverride: 'yes' }), true);
assert.equal(catalog.resolveVisionCapability({ provider: 'siliconflow', model: 'vendor/unknown', visionOverride: 'no' }), false);
assert.equal(catalog.resolveVisionCapability({ provider: 'siliconflow', model: 'vendor/unknown', visionOverride: 'auto' }), null);
assert.equal(catalog.resolveVisionCapability({ provider: 'siliconflow', model: expectedVision[0], visionOverride: 'no' }), false);
assert.equal(catalog.resolveVisionCapability({ provider: 'siliconflow', model: expectedVision[0], visionOverride: 'yes' }), true);

const seen = { vision: [], text: [] };
function fakeUpstream(kind, responseText) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404); res.end(); return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    seen[kind].push(body);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      for (const piece of ['最终', '答案']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: responseText } }] }));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const visionUp = await fakeUpstream('vision', '图中有一条上升曲线，横轴为时间。');
const textUp = await fakeUpstream('text', '文本回答');
const vBase = `http://127.0.0.1:${visionUp.address().port}/v1`;
const tBase = `http://127.0.0.1:${textUp.address().port}/v1`;
const appServer = (await startServer({ port: 0, dataDir: root })).server;
const base = `http://127.0.0.1:${appServer.address().port}`;

async function jsonApi(endpoint, options = {}) {
  const response = await fetch(base + endpoint, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${endpoint} failed: ${JSON.stringify(data)}`);
  return data;
}

await jsonApi('/api/settings', {
  method: 'POST',
  body: JSON.stringify({
    aiProvider: 'siliconflow',
    modelProfiles: [
      { id: 'text', label: 'DeepSeek 文本', provider: 'siliconflow', baseURL: tBase, apiKey: 'text-key', model: 'deepseek-ai/DeepSeek-V4-Flash', visionOverride: 'auto' },
      { id: 'vision', label: 'Qwen3.8 看图', provider: 'siliconflow', baseURL: vBase, apiKey: 'vision-key', model: 'Qwen/Qwen3.8-27B', visionOverride: 'auto' },
    ],
    activeProfileId: 'text',
    visionProfileId: 'vision',
  }),
});
const models = await jsonApi('/api/models');
assert.equal(models.active.vision, false);
assert.equal(models.activeVision.id, 'vision');
const clientModels = models.providers.find((p) => p.id === 'siliconflow').models;
for (const id of expectedVision) assert.equal(clientModels.find((m) => m.id === id)?.vision, true, `${id} missing from client catalog`);

const image = 'data:image/png;base64,aGVsbG8=';
const paperResponse = await fetch(base + '/api/paper-chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [
    { role: 'system', content: '只回答论文问题' },
    { role: 'user', content: [{ type: 'text', text: '请判断图表趋势' }, { type: 'image_url', image_url: { url: image } }] },
  ] }),
});
assert.equal(paperResponse.headers.get('content-type')?.includes('text/event-stream'), true);
const paperText = await paperResponse.text();
const events = [...paperText.matchAll(/^data: (.+)$/gm)].map((m) => m[1]).filter((x) => x !== '[DONE]').map((x) => JSON.parse(x));
assert.deepEqual(events.filter((x) => x.stage).map((x) => x.stage), ['vision', 'answer']);
assert.equal(seen.vision.length, 1);
assert.equal(seen.text.length, 1);
assert.equal(seen.vision[0].messages[1].content.some((p) => p.type === 'image_url'), true);
assert.equal(JSON.stringify(seen.text[0]).includes('image_url'), false, 'text model must not receive image_url after handoff');
assert.equal(JSON.stringify(seen.text[0]).includes('图中有一条上升曲线'), true, 'text model must receive the vision transcript');
assert.equal(events.some((x) => x.delta === '最终'), true);

// 手动 yes：未知模型也可直接接收图片，不走两段式。
await jsonApi('/api/settings', {
  method: 'POST',
  body: JSON.stringify({
    modelProfiles: [
      { id: 'text', label: '自定义视觉模型', provider: 'siliconflow', baseURL: tBase, apiKey: 'text-key', model: 'vendor/custom-vision', visionOverride: 'yes' },
      { id: 'vision', label: 'Qwen3.8 看图', provider: 'siliconflow', baseURL: vBase, apiKey: 'vision-key', model: 'Qwen/Qwen3.8-27B', visionOverride: 'auto' },
    ],
    activeProfileId: 'text',
    visionProfileId: 'vision',
    aiProvider: 'siliconflow',
  }),
});
seen.vision.length = 0; seen.text.length = 0;
const directResponse = await fetch(base + '/api/paper-chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: '直接看图' }, { type: 'image_url', image_url: { url: image } }] }] }),
});
const directText = await directResponse.text();
const directEvents = [...directText.matchAll(/^data: (.+)$/gm)].map((m) => m[1]).filter((x) => x !== '[DONE]').map((x) => JSON.parse(x));
assert.equal(directEvents.some((x) => x.stage === 'vision'), false);
assert.equal(seen.vision.length, 0);
assert.equal(seen.text.length, 1);
assert.equal(seen.text[0].messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')), true);

// 手动 no：即使目录标为视觉模型，也强制走两段式。
await jsonApi('/api/settings', {
  method: 'POST',
  body: JSON.stringify({
    modelProfiles: [
      { id: 'text', label: '强制文字模型', provider: 'siliconflow', baseURL: tBase, apiKey: 'text-key', model: 'zai-org/GLM-4.5V', visionOverride: 'no' },
      { id: 'vision', label: 'Qwen3.8 看图', provider: 'siliconflow', baseURL: vBase, apiKey: 'vision-key', model: 'Qwen/Qwen3.8-27B', visionOverride: 'auto' },
    ],
    activeProfileId: 'text',
    visionProfileId: 'vision',
    aiProvider: 'siliconflow',
  }),
});
seen.vision.length = 0; seen.text.length = 0;
const forcedTextResponse = await fetch(base + '/api/paper-chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: '强制转述' }, { type: 'image_url', image_url: { url: image } }] }] }),
});
const forcedText = await forcedTextResponse.text();
const forcedEvents = [...forcedText.matchAll(/^data: (.+)$/gm)].map((m) => m[1]).filter((x) => x !== '[DONE]').map((x) => JSON.parse(x));
assert.deepEqual(forcedEvents.filter((x) => x.stage).map((x) => x.stage), ['vision', 'answer']);
assert.equal(seen.vision.length, 1);
assert.equal(seen.text.length, 1);
assert.equal(JSON.stringify(seen.text[0]).includes('image_url'), false);

console.log(JSON.stringify({
  catalogVisionModels: expectedVision.length,
  migratedProviderModels: silicon.models.length,
  twoStage: { visionCalls: 1, textCalls: 1, imageStripped: true },
  manualOverride: { unknownModelDirectVision: true },
}, null, 2));

for (const server of [appServer, visionUp, textUp]) server.close();
fs.rmSync(root, { recursive: true, force: true });
