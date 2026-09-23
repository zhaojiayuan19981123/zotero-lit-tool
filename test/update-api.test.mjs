import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';

async function withServer(updateService, run) {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'sciterminal-update-test-'));
  const { app } = createApp({ uploadDir, updateService });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(uploadDir, { recursive: true, force: true });
  }
}

test('desktop update routes delegate to the injected update service', async () => {
  const calls = [];
  const snapshots = {
    status: { supported: true, currentVersion: '1.4.0', phase: 'available', availableVersion: '1.5.0' },
    check: { supported: true, currentVersion: '1.4.0', phase: 'checking' },
    download: { supported: true, currentVersion: '1.4.0', phase: 'downloading', percent: 12.5 },
    install: { supported: true, currentVersion: '1.4.0', phase: 'downloaded', percent: 100 },
  };
  const updateService = {
    getStatus: () => snapshots.status,
    check: async () => { calls.push('check'); return snapshots.check; },
    download: async () => { calls.push('download'); return snapshots.download; },
    install: () => { calls.push('install'); return snapshots.install; },
  };

  await withServer(updateService, async (baseUrl) => {
    const status = await fetch(`${baseUrl}/api/update/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), snapshots.status);

    for (const action of ['check', 'download', 'install']) {
      const response = await fetch(`${baseUrl}/api/update/${action}`, { method: 'POST' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), snapshots[action]);
    }
  });

  assert.deepEqual(calls, ['check', 'download', 'install']);
});

test('browser mode exposes status but rejects update actions', async () => {
  await withServer(null, async (baseUrl) => {
    const status = await fetch(`${baseUrl}/api/update/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      supported: false,
      currentVersion: '',
      phase: 'unsupported',
      availableVersion: '',
      releaseName: '',
      releaseNotes: '',
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      error: '自动更新仅在安装后的 Windows 桌面版中可用',
    });

    for (const action of ['check', 'download', 'install']) {
      const response = await fetch(`${baseUrl}/api/update/${action}`, { method: 'POST' });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /桌面版/);
    }
  });
});

test('update action failures are returned as conflict responses', async () => {
  const updateService = {
    getStatus: () => ({ supported: true, currentVersion: '1.4.0', phase: 'error' }),
    check: async () => { throw new Error('GitHub 暂时不可用'); },
  };

  await withServer(updateService, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/update/check`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'GitHub 暂时不可用' });
  });
});

test('prompt acknowledgement is forwarded to the update service with the version', async () => {
  const acked = [];
  const snapshot = { supported: true, currentVersion: '1.16.2', phase: 'available', availableVersion: '1.16.3' };
  const updateService = {
    getStatus: () => snapshot,
    ackPrompt: async (version) => {
      acked.push(version);
      return { ...snapshot, promptedVersion: version, pendingPrompt: false };
    },
  };

  await withServer(updateService, async (baseUrl) => {
    const post = (body) => fetch(`${baseUrl}/api/update/prompt-ack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const ok = await post({ version: '1.16.3' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      ...snapshot, promptedVersion: '1.16.3', pendingPrompt: false,
    });

    // 不带版本号：交给主进程用「当前可用版本」兜底
    assert.equal((await post({})).status, 200);
    // 版本号类型不对：必须被收敛成空串，不能把对象透传进主进程
    assert.equal((await post({ version: { evil: true } })).status, 200);
  });

  assert.deepEqual(acked, ['1.16.3', '', '']);
});

test('prompt acknowledgement is rejected in browser mode', async () => {
  await withServer(null, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/update/prompt-ack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '1.16.3' }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /桌面版/);
  });
});
