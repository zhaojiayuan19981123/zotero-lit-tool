import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertComplete, buildObjectUrl, cacheControlFor, contentTypeFor,
  normalizePrefix, planFiles, signRequest, syncMirror,
} from '../scripts/sync-release-mirror.mjs';

const PREFIX = 'worlex/releases/latest/';
const FILES = [
  'worlex-setup-1.40.0.exe',
  'worlex-setup-1.40.0.exe.blockmap',
  'latest.yml',
  'worlex-1.40.0-macos-arm64.dmg',
  'worlex-1.40.0-macos-x64.dmg',
  'SHA256SUMS.txt',
];

function makeAssets() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worlex-mirror-'));
  for (const name of FILES) fs.writeFileSync(path.join(dir, name), `content:${name}`);
  fs.writeFileSync(path.join(dir, 'builder-debug.yml'), 'should be ignored');
  return dir;
}

function withServer(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method, url: req.url, headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });
  });
  return {
    received,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
    handler,
  };
}

test('目录前缀规范化并拒绝穿越路径', () => {
  assert.equal(normalizePrefix('worlex/releases/latest'), PREFIX);
  assert.equal(normalizePrefix('/worlex/releases/latest/'), PREFIX);
  assert.equal(normalizePrefix(''), PREFIX);
  assert.throws(() => normalizePrefix('../escape/'), /不合法/);
  assert.throws(() => normalizePrefix('worlex/../x/'), /不合法/);
});

test('缓存头：更新清单不缓存，带版本号的安装包长期强缓存', () => {
  assert.match(cacheControlFor('latest.yml'), /no-cache/);
  assert.match(cacheControlFor('worlex-setup-1.40.0.exe'), /immutable/);
  assert.match(cacheControlFor('worlex-setup-1.40.0.exe.blockmap'), /immutable/);
  assert.match(contentTypeFor('latest.yml'), /yaml/);
  assert.match(contentTypeFor('SHA256SUMS.txt'), /plain/);
  assert.match(contentTypeFor('worlex-1.40.0-macos-arm64.dmg'), /diskimage/);
  assert.equal(contentTypeFor('worlex-setup-1.40.0.exe'), 'application/octet-stream');
});

test('只挑 Release 更新所需文件，且 latest.yml 必须最后上传', () => {
  const plan = planFiles([...FILES, 'builder-debug.yml', 'random.zip'], PREFIX);
  assert.equal(plan.length, FILES.length);
  assert.equal(plan.at(-1).name, 'latest.yml', '清单指向新版本前必须先把安装包传完');
  assert.equal(plan[0].key, `${PREFIX}${plan[0].name}`);
  assert.ok(plan.every((item) => item.key.startsWith(PREFIX)));
  assert.doesNotThrow(() => assertComplete(plan));
});

test('缺少 Windows 三件套时拒绝同步，避免镜像变成不可用状态', () => {
  assert.throws(() => assertComplete(planFiles(FILES.filter((n) => n !== 'latest.yml'))), /latest\.yml/);
  assert.throws(() => assertComplete(planFiles(FILES.filter((n) => !n.endsWith('.exe')))), /安装包/);
  assert.throws(() => assertComplete(planFiles(FILES.filter((n) => !n.endsWith('.blockmap')))), /blockmap/);
});

test('对象 URL 同时支持 path-style 与 bucket 在主机名里的 COS 形态', () => {
  const pathStyle = buildObjectUrl('https://s3.example.com', 'worlex-bucket', `${PREFIX}latest.yml`);
  assert.equal(pathStyle.pathname, `/worlex-bucket/${PREFIX}latest.yml`);
  const cos = buildObjectUrl('https://worlex-bucket.cos.ap-shanghai.myqcloud.com', 'worlex-bucket', `${PREFIX}latest.yml`);
  assert.equal(cos.pathname, `/${PREFIX}latest.yml`);
  assert.throws(() => buildObjectUrl('file:///tmp', 'bucket', 'x'), /http\(s\)/);
});

test('SigV4 签名头格式正确且包含请求体哈希', () => {
  const url = buildObjectUrl('https://s3.example.com', 'worlex-bucket', `${PREFIX}latest.yml`);
  const body = Buffer.from('version: 1.40.0');
  const headers = signRequest({
    url, body, accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST', region: 'ap-shanghai',
    contentType: 'application/x-yaml; charset=utf-8', cacheControl: 'no-cache',
    now: new Date('2026-11-13T12:00:00.000Z'),
  });
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20261113\/ap-shanghai\/s3\/aws4_request/);
  assert.match(headers.authorization, /SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date/);
  assert.match(headers.authorization, /Signature=[0-9a-f]{64}$/);
  assert.equal(headers['x-amz-date'], '20261113T120000Z');
  assert.equal(headers['x-amz-content-sha256'], crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(headers['cache-control'], 'no-cache');
  assert.equal(headers.host, undefined, 'Host 交给 fetch 自动设置，避免重复头部');
});

test('dry-run 只列计划不产生任何请求；正式同步按正确顺序 PUT 到镜像目录', async () => {
  const dir = makeAssets();
  const server = withServer();
  const port = await server.listen();
  const endpoint = `http://127.0.0.1:${port}`;
  const common = {
    assetsDir: dir, endpoint, bucket: 'worlex-test', region: 'auto',
    accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST',
  };
  const logger = { log: () => {} };
  try {
    const dry = await syncMirror({ ...common, dryRun: true, logger });
    assert.equal(dry.uploaded.length, 0);
    assert.equal(server.received.length, 0);
    assert.equal(dry.plan.at(-1).name, 'latest.yml');

    const result = await syncMirror({ ...common, logger });
    assert.equal(server.received.length, result.plan.length);
    assert.equal(result.uploaded.length, result.plan.length);
    assert.ok(server.received.every((req) => req.method === 'PUT'));
    assert.ok(server.received.every((req) => req.url.includes(`/worlex-test/${PREFIX}`)));
    assert.ok(server.received.every((req) => String(req.headers.authorization || '').startsWith('AWS4-HMAC-SHA256')));
    assert.ok(server.received.every((req) => /^[0-9a-f]{64}$/.test(req.headers['x-amz-content-sha256'])));

    const last = server.received.at(-1);
    assert.match(last.url, /latest\.yml$/);
    assert.match(last.headers['cache-control'], /no-cache/);
    assert.equal(last.body, 'content:latest.yml');
    const installer = server.received.find((req) => req.url.endsWith('.exe'));
    assert.match(installer.headers['cache-control'], /immutable/);
    assert.equal(installer.body, 'content:worlex-setup-1.40.0.exe');
    assert.ok(server.received.some((req) => req.url.endsWith('.exe.blockmap')), '.blockmap 必须一起同步，差量更新才有效');
    assert.equal(result.clientBase, `${endpoint}/worlex-test/${PREFIX}`);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('上传失败时立即报错，并且不会继续把 latest.yml 推上去', async () => {
  const dir = makeAssets();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(503); res.end('service unavailable'); });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    await assert.rejects(
      () => syncMirror({
        assetsDir: dir, endpoint: `http://127.0.0.1:${port}`, bucket: 'worlex-test', region: 'auto',
        accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST', logger: { log: () => {} },
      }),
      /HTTP 503/,
    );
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
