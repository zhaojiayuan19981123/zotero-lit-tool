// worldlib-download.test.mjs —— 世图下载助手：中转页解析与直链抓取
//
// 用户报的那个故障：「这种链接会下载失败」：
//   …/submit_ajax.ashx?action=getdownfile&path=:8123/upload/doifiles/10.1016/xxx-main.pdf
// 真因是**判断 PDF 的方式错了**：老代码看整条 URL 是不是以 .pdf 结尾，而这条中转链接
// 的查询串里正好带着 …-main.pdf，于是收到 200 的 HTML 跳转页后仍认定"这就是 PDF"，
// 魔数校验失败 → 用户看到「下载内容不是有效的 PDF 文件」。
//
// 这组测试把真实链路搬进本地 mock：
//   ① 中转页（HTML）→ 从中解析出真直链 → 下载到 PDF；
//   ② path=:PORT/… 这种「空主机 + 端口」的写法要能自己补全主机名；
//   ③ HTML 里的 &amp; 必须还原，否则带进请求会 400；
//   ④ 直接返回 PDF 的地址照常能下；
//   ⑤ 声明是 PDF 但内容不是 → 明确报错，且不留半条记录。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('% 世界图书中转页测试用的假 PDF\n'),
  Buffer.alloc(2048, 0x20),
]);

const TITLE = '10.1016/j.omega.2026.000001';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

/** 起一个 mock 站：handler 收到的请求由各用例自定义 */
async function mockSite(handler) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* 读完 */ }
    try { await handler(req, res); } catch (e) { res.writeHead(500).end(String(e)); }
  });
  const base = await listen(server);
  return { server, base };
}

function pdfResponse(res) {
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(PDF_BYTES.length) });
  res.end(PDF_BYTES);
}
function htmlResponse(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function newApp() {
  const root = await mkdtemp(path.join(tmpdir(), 'wl-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  store.configure({ dataDir });
  const { app } = createApp({ uploadDir });
  const server = createServer(app);
  const base = await listen(server);
  return { base, server, uploadDir };
}

function postDownload(base, url, extra = {}) {
  return fetch(`${base}/api/worldlib/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ title: TITLE, url, ...extra }),
  });
}

test('中转页 → 真直链：链接本身以 .pdf 结尾但返回 HTML，也要接着走下去', async () => {
  const { server: fileSrv, base: fileBase } = await mockSite((req, res) => {
    if (/MAIN\.PDF/i.test(req.url)) return pdfResponse(res);
    res.writeHead(404).end('nope');
  });
  const ashx = await mockSite((req, res) => htmlResponse(res, `<!DOCTYPE html><html><body>
    <p>${fileBase}/UPLOAD/DOIFILES/10.1016/1-S2.0-S0278431926000216-MAIN.PDF?token=abc</p>
    <a href='${fileBase}/UPLOAD/DOIFILES/10.1016/1-S2.0-S0278431926000216-MAIN.PDF?token=abc'>文件下载</a>
  </body></html>`));
  const { base, server, uploadDir } = await newApp();
  try {
    // 注意：这条 URL 整串也以 .pdf 结尾 —— 正是老代码翻车的地方
    const url = `${ashx.base}/tools/submit_ajax.ashx?action=getdownfile&path=:8123/upload/doifiles/10.1016/1-s2.0-S0278431926000216-main.pdf`;
    const r = await postDownload(base, url);
    const body = await r.json();
    assert.equal(r.status, 200, `应下载成功，实际：${JSON.stringify(body)}`);
    assert.equal(body.record.fileSize, PDF_BYTES.length);

    const files = await readdir(uploadDir);
    assert.equal(files.length, 1);
    const onDisk = await readFile(path.join(uploadDir, files[0]));
    assert.equal(onDisk.subarray(0, 5).toString(), '%PDF-', '落盘的必须是真 PDF');
    assert.equal(store.getLiterature(body.record.id).source, 'worldlib');
  } finally {
    await close(ashx.server); await close(fileSrv); await close(server);
  }
});

test('path=:PORT/… 的空主机写法：自动补上站点主机名再抓', async () => {
  // 文件站与中转站同一个主机，只是端口不同 —— 这正是世图那种写法
  const { server: fileSrv, base: fileBase } = await mockSite((req, res) => {
    if (/^\/upload\/doifiles\//i.test(req.url)) return pdfResponse(res);
    res.writeHead(404).end('nope');
  });
  const filePort = new URL(fileBase).port;
  const ashx = await mockSite((req, res) => htmlResponse(res, '<html><body>没有链接，只有一句说明</body></html>'));
  const { base, server } = await newApp();
  try {
    const url = `${ashx.base}/tools/submit_ajax.ashx?action=getdownfile&path=:${filePort}/upload/doifiles/10.1016/x.pdf`;
    const r = await postDownload(base, url);
    const body = await r.json();
    assert.equal(r.status, 200, `应靠 path 里的端口补出地址，实际：${JSON.stringify(body)}`);
    assert.equal(body.record.fileSize, PDF_BYTES.length);
  } finally {
    await close(ashx.server); await close(fileSrv); await close(server);
  }
});

test('中转页里的 &amp; 要还原，否则带进请求会 400', async () => {
  let seen = '';
  const { server: fileSrv, base: fileBase } = await mockSite((req, res) => {
    seen = req.url || '';
    const u = new URL(req.url, fileBase);
    if (u.searchParams.get('token') === 'abc' && u.searchParams.get('f') === '1') return pdfResponse(res);
    res.writeHead(400).end('bad token');
  });
  const ashx = await mockSite((req, res) => htmlResponse(res,
    `<html><body><a href='${fileBase}/get?f=1&amp;token=abc'>文件下载</a></body></html>`));
  const { base, server } = await newApp();
  try {
    const r = await postDownload(base, `${ashx.base}/tools/submit_ajax.ashx?action=getdownfile&path=:1/x.pdf`);
    const body = await r.json();
    assert.equal(r.status, 200, `应下载成功，实际：${JSON.stringify(body)}（请求到的是 ${seen}）`);
    assert.match(seen, /token=abc/);
    assert.ok(!seen.includes('&amp;'), '请求里不该出现 &amp;');
  } finally {
    await close(ashx.server); await close(fileSrv); await close(server);
  }
});

test('本来就是直链：直接落盘，不用中转', async () => {
  const { server: fileSrv, base: fileBase } = await mockSite((req, res) => pdfResponse(res));
  const { base, server, uploadDir } = await newApp();
  try {
    const r = await postDownload(base, `${fileBase}/papers/abc.pdf`);
    const body = await r.json();
    assert.equal(r.status, 200);
    const files = await readdir(uploadDir);
    assert.ok((await stat(path.join(uploadDir, files[0]))).size === PDF_BYTES.length);
  } finally {
    await close(fileSrv); await close(server);
  }
});

test('声明是 PDF、内容却不是 → 明确报错，且不留半条记录', async () => {
  const { server: badSrv, base: badBase } = await mockSite((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end('<html>登录页</html>');
  });
  const { base, server, uploadDir } = await newApp();
  try {
    const r = await postDownload(base, `${badBase}/x.pdf`);
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.match(body.error, /不是有效文件|有效文件/);
    assert.equal((await readdir(uploadDir)).length, 0, '失败时不该留下文件');
    assert.equal(store.listLiterature().length, 0, '失败时不该留下记录');
  } finally {
    await close(badSrv); await close(server);
  }
});

test('中转页里没有可用地址 → 说清楚是"没找到"，而不是"不是 PDF"', async () => {
  const { server: srv, base } = await mockSite((req, res) => htmlResponse(res, '<html><body>链接已失效</body></html>'));
  const { base: appBase, server } = await newApp();
  try {
    const r = await postDownload(appBase, `${base}/tools/submit_ajax.ashx?action=getdownfile&path=:9/upload/a.pdf`);
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.match(body.error, /没能从中转页/);
    assert.match(body.error, /失效|登录/);
  } finally {
    await close(srv); await close(server);
  }
});

test('上游 404 / 连接被拒：错误信息点出地址与原因', async () => {
  const { server: srv, base } = await mockSite((req, res) => res.writeHead(404).end('gone'));
  const { base: appBase, server } = await newApp();
  try {
    const r = await postDownload(appBase, `${base}/missing.pdf`);
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /404|响应 HTTP/);
  } finally {
    await close(srv); await close(server);
  }

  // 连一个明显没人监听的端口（同机高位端口）
  const dead = await mockSite(() => {});
  const deadBase = dead.base;
  await close(dead.server);
  const app2 = await newApp();
  try {
    const r = await postDownload(app2.base, `${deadBase}/x.pdf`);
    assert.equal(r.status, 502);
    const msg = (await r.json()).error;
    assert.match(msg, /拒绝连接|无法|超时|中断/, `错误信息应说明原因，实际：${msg}`);
  } finally {
    await close(app2.server);
  }
});

test('同名/同 DOI 已存在 → 409，带 duplicate 标记（前端据此提示"重新导入"）', async () => {
  const { server: fileSrv, base: fileBase } = await mockSite((req, res) => pdfResponse(res));
  const { base, server } = await newApp();
  try {
    const first = await postDownload(base, `${fileBase}/a.pdf`);
    assert.equal(first.status, 200);
    const second = await postDownload(base, `${fileBase}/a.pdf`);
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.equal(body.duplicate, true);
    // overwrite=true 时允许覆盖重导
    const third = await postDownload(base, `${fileBase}/a.pdf`, { overwrite: true });
    assert.equal(third.status, 200);
    assert.equal(store.listLiterature().length, 1, '覆盖导入不该产生两条记录');
  } finally {
    await close(fileSrv); await close(server);
  }
});
