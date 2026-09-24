// 模型路由（故障转移）的 HTTP 级集成测试。
// 单测覆盖的是状态机本身；这里跑真实链路：mock 两个上游，一个坏一个好，
// 看 /api/paper-chat 是否真的会自动切到备用，以及熔断与统计是否如实反映。
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
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** 从我们的 SSE 输出里取出拼接后的正文（只认 delta 帧） */
function sseText(body) {
  return String(body).split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== '[DONE]')
    .map((payload) => { try { return JSON.parse(payload).delta || ''; } catch (_) { return ''; } })
    .join('');
}

/** 从 SSE 输出里取出 error 帧 */
function sseError(body) {
  const frames = String(body).split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== '[DONE]');
  for (const frame of frames) {
    try {
      const parsed = JSON.parse(frame);
      if (parsed?.error) return String(parsed.error);
    } catch (_) { /* ignore */ }
  }
  return '';
}

function mockUpstream(handler) {
  return createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
    handler(body, res, req);
  });
}

const OK_BODY = { choices: [{ message: { content: '普通回复' } }] };

test('模型路由：主供应商失败自动切到备用、熔断生效、失败原因逐条列出', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-router-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');

  const hits = { primary: [], backup: [] };
  // 主供应商：永远 500
  const primary = mockUpstream((body, res) => {
    hits.primary.push(body);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '主供应商挂了' } }));
  });
  // 备用供应商：SSE 正常返回
  const backup = mockUpstream((body, res) => {
    hits.backup.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '备用给出的回答' } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });

  let appServer;
  try {
    const primaryBase = await listen(primary);
    const backupBase = await listen(backup);

    store.configure({ dataDir });
    store.saveSettings({
      aiProvider: 'custom',
      _modelMigrated: true,
      activeProfileId: 'p1',
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
      modelRouter: {
        enabled: true,
        failover: true,
        queue: ['p2'],
        breaker: { failThreshold: 2, openSeconds: 120, minRequests: 10, errorRate: 90 },
      },
    });

    const { app } = createApp({ uploadDir });
    appServer = createServer(app);
    const base = await listen(appServer);

    const chat = async () => {
      const r = await fetch(`${base}/api/paper-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
      });
      return { status: r.status, body: await r.text() };
    };
    const status = async () => (await fetch(`${base}/api/router/status`)).json();

    // ---------- ① 主供应商 500 → 自动切到备用 ----------
    const first = await chat();
    assert.equal(first.status, 200);
    assert.equal(sseText(first.body), '备用给出的回答', '第 1 次请求应当由备用供应商产出内容');
    // 主供应商会被调 2 次：streamMode=auto 下先试流式、失败后按既有逻辑再退一次非流式，
    // 两次都 500 之后才轮到备用。所以这里只断言「确实试过」。
    assert.ok(hits.primary.length >= 1, '主供应商应当被尝试过');
    assert.equal(hits.backup.length, 1, '备用供应商应当被启用');
    assert.equal(hits.backup[0].model, 'mock-backup', '换家时必须把模型名换成那家自己的，而不是沿用主供应商的模型名');

    const s1 = await status();
    assert.equal(s1.totalRequests, 1);
    assert.equal(s1.failovers, 1, '应当记录一次故障转移');
    assert.equal(s1.successRate, 100, '用户视角这次请求是成功的');
    const p1 = s1.providers.find((x) => x.id === 'p1');
    const p2 = s1.providers.find((x) => x.id === 'p2');
    assert.equal(p1.failures, 1);
    assert.equal(p1.health, 'warn', '失败 1 次但未到阈值 → 黄灯');
    assert.equal(p2.successes, 1);
    assert.equal(p2.health, 'ok');

    // ---------- ② 再失败一次 → 主供应商熔断，之后被跳过 ----------
    const second = await chat();
    assert.equal(sseText(second.body), '备用给出的回答');
    const s2 = await status();
    const p1After = s2.providers.find((x) => x.id === 'p1');
    assert.equal(p1After.circuit, 'open', '连续失败达到阈值应当熔断');
    assert.equal(p1After.health, 'open');
    assert.equal(s2.failovers, 2);

    const primaryHitsBefore = hits.primary.length;
    const third = await chat();
    assert.equal(sseText(third.body), '备用给出的回答');
    assert.equal(hits.primary.length, primaryHitsBefore, '熔断中的供应商不应再被请求');
    const s3 = await status();
    assert.equal(s3.providers.find((x) => x.id === 'p2').successes, 3);

    // ---------- ③ 队列清空、唯一的供应商还在熔断中 → 仍强制尝试它，并给出真实原因 ----------
    // 设计取舍：熔断的意义在于「跳过它、换别人」，只剩一家时把请求直接拦死只会把错误藏起来。
    await fetch(`${base}/api/router/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: [] }),
    });
    const primaryHitsBeforeClear = hits.primary.length;
    const cleared = await chat();
    assert.ok(hits.primary.length > primaryHitsBeforeClear,
      '唯一的供应商即便处于熔断中也要试一把，而不是把请求直接拦死');
    assert.match(sseError(cleared.body), /AI 接口返回 500/, '应当给出上游的真实状态码');
    assert.match(sseError(cleared.body), /主供应商挂了/, '应当给出上游的真实错误内容');

    // ---------- ④ 全部失败 → 错误里把每条配置的原因都列出来 ----------
    // 先把熔断与统计复位，保证两家都会被真的尝试
    await fetch(`${base}/api/router/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    // 备用也换成坏的上游
    const badBackup = mockUpstream((body, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '备用也挂了' } }));
    });
    const badBackupBase = await listen(badBackup);
    try {
      const s = store.getSettings();
      s.modelProfiles = s.modelProfiles.map((p) => (p.id === 'p2'
        ? { ...p, baseURL: `${badBackupBase}/v1/chat/completions` }
        : p));
      s.modelRouter = { ...s.modelRouter, queue: ['p2'], breaker: { failThreshold: 1, openSeconds: 0, minRequests: 10, errorRate: 90 } };
      store.saveSettings(s);

      const failed = await chat();
      const error = sseError(failed.body);
      assert.match(error, /请求失败/, '失败时应通过 SSE 的 error 帧告知前端');
      assert.match(error, /主供应商/, '错误里应当出现主供应商的名字');
      assert.match(error, /备用供应商/, '错误里应当出现备用供应商的名字（否则用户不知道试过谁）');
      assert.match(error, /已尝试 2 条模型配置/, '应当说明尝试了几条配置');

      const s4 = await status();
      assert.ok(s4.failRequests >= 1, '失败的请求要计入失败数');
      assert.ok(s4.successRate < 100);
    } finally {
      await close(badBackup);
    }

    // ---------- ⑤ 重置统计：熔断与计数一起归零 ----------
    await fetch(`${base}/api/router/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const cleared2 = await status();
    assert.equal(cleared2.totalRequests, 0);
    assert.equal(cleared2.activeConnections, 0, '重置后不应残留「活跃连接」');
    assert.equal(cleared2.logs.length, 0);
    assert.equal(cleared2.providers.find((x) => x.id === 'p1').circuit, 'closed');

    // ---------- ⑥ 探测接口：坏的上游报错、好的上游给出耗时 ----------
    const probe = await (await fetch(`${base}/api/router/probe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })).json();
    const byId = Object.fromEntries(probe.results.map((x) => [x.id, x]));
    assert.equal(byId.p1.ok, false);
    assert.match(byId.p1.error, /500|失败/);
    assert.equal(byId.p2.ok, false, '此时备用指向的也是坏上游');
    assert.ok(probe.results.length === 2, '应当把设置里的每条配置都测一遍');

    // 探测不应该计入熔断统计
    const afterProbe = await status();
    assert.equal(afterProbe.totalRequests, 0, '手动测速不应污染路由的用量统计');
  } finally {
    if (appServer) await close(appServer);
    await close(primary);
    await close(backup);
    await rm(root, { recursive: true, force: true });
  }
});

test('模型路由：关闭总开关后行为与从前一致（只用主供应商）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-router-off-'));
  const hits = { primary: [], backup: [] };
  const primary = mockUpstream((body, res) => {
    hits.primary.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(OK_BODY));
  });
  const backup = mockUpstream((body, res) => {
    hits.backup.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(OK_BODY));
  });

  let appServer;
  try {
    const primaryBase = await listen(primary);
    const backupBase = await listen(backup);
    store.configure({ dataDir: path.join(root, 'data') });
    store.saveSettings({
      aiProvider: 'custom',
      _modelMigrated: true,
      activeProfileId: 'p1',
      modelProfiles: [
        { id: 'p1', label: '主供应商', provider: 'custom', baseURL: `${primaryBase}/v1/chat/completions`, apiKey: '', model: 'mock-primary', streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no', createdAt: new Date().toISOString() },
        { id: 'p2', label: '备用供应商', provider: 'custom', baseURL: `${backupBase}/v1/chat/completions`, apiKey: '', model: 'mock-backup', streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no', createdAt: new Date().toISOString() },
      ],
      modelRouter: { enabled: false, failover: true, queue: ['p2'] },
    });
    const { app } = createApp({ uploadDir: path.join(root, 'uploads') });
    appServer = createServer(app);
    const base = await listen(appServer);

    const r = await fetch(`${base}/api/paper-chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    const body = await r.text();
    assert.equal(sseText(body), '普通回复');
    assert.equal(hits.backup.length, 0, '关闭路由后不应把请求发给备用供应商');
  } finally {
    if (appServer) await close(appServer);
    await close(primary);
    await close(backup);
    await rm(root, { recursive: true, force: true });
  }
});
