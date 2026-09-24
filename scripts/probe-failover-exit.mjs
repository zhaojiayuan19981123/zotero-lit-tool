// 回归探针：跑一次「主供应商失败 → 自动切备用」，做完就自然结束进程。
//
// 为什么需要它：非流式路由里，**失败的**那次尝试如果没释放自己的超时定时器，
// 就会在事件循环里挂着一个「到点就 abort」的 Timeout（时长 = 设置里的 timeoutSeconds，
// 默认 120 秒、最大可调到 900 秒）。功能上完全看不出问题，进程却要干等它到期才肯退出。
// 所以这里把 timeoutSeconds 故意设得很大：**进程能不能及时自己退出**就是泄漏的判据。
//
// 由 test/router-timeout-leak.test.mjs 以子进程方式调用；文件名不匹配测试命名约定，
// 所以 `node --test` 不会把它当成测试文件（它的位置也不在 test/ 里）。
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startServer } from '../server.js';
import * as store from '../src/store.js';

const LEAK_WINDOW_SECONDS = 600;   // 一旦泄漏，进程至少被拖 600 秒

async function startMock(handler) {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* 把请求体读完即可 */ }
    handler(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function close(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

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

const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-leak-'));
const dataDir = path.join(root, 'data');

// 主供应商：永远 500 —— 失败的那一次尝试，正是泄漏点
const bad = await startMock((res) => {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: '主供应商挂了' } }));
});
// 备用：正常 JSON
const good = await startMock((res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '备用给出的回答' } }] }));
});

let handle = null;
let failed = false;
try {
  const gwPort = await pickFreePort();
  store.configure({ dataDir });
  store.saveSettings({
    aiProvider: 'custom',
    _modelMigrated: true,
    activeProfileId: 'p1',
    outboundProxy: { mode: 'off' },
    localGateway: { enabled: true, port: gwPort },
    modelRouter: {
      enabled: true,
      failover: true,
      queue: ['p2'],
      timeoutSeconds: LEAK_WINDOW_SECONDS,
    },
    modelProfiles: [
      {
        id: 'p1', label: '主供应商', provider: 'custom', baseURL: `${bad.base}/v1/chat/completions`,
        apiKey: '', model: 'mock-primary', streamMode: 'nonstream', systemPromptMode: 'auto',
        authMode: 'none', visionOverride: 'no', createdAt: new Date().toISOString(),
      },
      {
        id: 'p2', label: '备用供应商', provider: 'custom', baseURL: `${good.base}/v1/chat/completions`,
        apiKey: '', model: 'mock-backup', streamMode: 'nonstream', systemPromptMode: 'auto',
        authMode: 'none', visionOverride: 'no', createdAt: new Date().toISOString(),
      },
    ],
  });

  handle = await startServer({ dataDir, uploadDir: path.join(root, 'uploads'), port: 0, startGateway: true });

  // 非流式入口：主 500 → 切备用（失败的 p1 会在路由里留下一个句柄）
  const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-primary', stream: false, messages: [{ role: 'user', content: '你好' }] }),
  });
  const body = await res.text();
  if (res.status !== 200 || !body.includes('备用给出的回答')) {
    console.error('探针前置条件不成立：', res.status, body.slice(0, 200));
    failed = true;
  }
} finally {
  if (handle) {
    await handle.stopGateway();
    await close(handle.server);
  }
  await close(bad.server);
  await close(good.server);
  await rm(root, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
else console.log('探针完成，等待进程自行退出');
