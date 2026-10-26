// parse-http.test.mjs —— 批量解析的 HTTP 级端到端测试（真服务 + 真 PDF + mock 上游）
//
// 直接验证用户报的那个故障：「有的文献一直卡在解析中」。
// 三件事必须在真实链路上成立：
//   ① 一次提交多篇时，上游确实同时收到多个请求（并发 4~8），而不是一篇一篇排队；
//   ② 库里本来写着 parsing、但其实没人在跑的僵尸记录，重新点解析能被重新接上；
//   ③ 进程重启后残留的 parsing，列表接口会把它收回成「中断」状态，而不是永远转圈。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function makePdf(lines) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    const page = doc.addPage([595, 842]);
    page.drawText(line, { x: 40, y: 780, size: 11, font, lineHeight: 16 });
  }
  return Buffer.from(await doc.save());
}

const AI_FIELDS = {
  title: '平台治理与价值共创：一个实证研究',
  authors: '张三, 李四',
  journal: '管理世界',
  year: '2024',
  doi: '10.1234/mwt.2024.001',
  keywords: '平台治理；价值共创',
  abstract: '本文研究平台治理如何影响价值共创。',
  researchQuestion: '平台治理机制如何影响多方主体的价值共创行为？',
  researchObject: '12 家平台企业的 320 份问卷',
  coreFindings: '治理强度与价值共创呈倒 U 形关系。',
  mechanism: '信任与知识共享的中介作用。',
  boundaryConditions: '在竞争强度高的行业更显著。',
  method: '问卷调查 + 结构方程模型',
  researchDesign: '横截面问卷，分层抽样',
  constructs: '平台治理、信任、知识共享、价值共创',
  criticalThinking: '横截面数据难以排除反向因果。',
  reviewUse: '可作为「平台治理」这一支的实证证据。',
  researchGap: '缺乏纵向数据。',
};

/** mock 上游：记录同时在途的请求数（用来验证「真的并发」），每个请求延迟 responseDelayMs */
function mockUpstream({ responseDelayMs = 120 } = {}) {
  const state = { inflight: 0, peak: 0, total: 0 };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    state.inflight += 1;
    state.total += 1;
    state.peak = Math.max(state.peak, state.inflight);
    await new Promise((r) => setTimeout(r, responseDelayMs));
    state.inflight -= 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(AI_FIELDS) } }] }));
  });
  return { server, state };
}

test('批量解析：一次提交 6 篇真的并发跑，且全部写完字段', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parse-http-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const { server: upstream, state } = mockUpstream();
  const appServers = [];
  await mkdir(uploadDir, { recursive: true });
  try {
    const upstreamBase = await listen(upstream);
    store.configure({ dataDir });
    store.saveSettings({
      aiProvider: 'openai',
      apiKey: 'test-key',
      baseURL: `${upstreamBase}/v1`,
      model: 'mock-model',
      language: 'zh',
    });

    const pdf = await makePdf(['Platform governance and value co-creation: an empirical study']);
    const ids = [];
    for (let i = 0; i < 6; i += 1) {
      const filePath = path.join(uploadDir, `paper-${i}.pdf`);
      await writeFile(filePath, pdf);
      const record = {
        id: `lit-${i}`,
        title: `测试文献 ${i}`,
        filePath,
        filename: `paper-${i}.pdf`,
        originalName: `paper-${i}.pdf`,
        fileKind: 'pdf',
        docType: 'empirical',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      store.upsertLiterature(record);
      ids.push(record.id);
    }

    const { app } = createApp({ uploadDir });
    const httpServer = createServer(app);
    appServers.push(httpServer);
    const base = await listen(httpServer);

    const t0 = Date.now();
    const res = await fetch(`${base}/api/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ ids }),
    });
    const body = await res.json();
    const cost = Date.now() - t0;

    assert.equal(res.status, 200);
    assert.equal(body.failed, 0, `不该有失败的篇目：${JSON.stringify(body.results?.map((r) => r.error))}`);
    assert.equal(body.results.length, 6);
    // ④ 并发：6 篇 × 120ms，串行至少要 720ms；并发跑应该在 500ms 内完成
    assert.ok(state.peak >= 3, `上游同时只收到 ${state.peak} 个请求，并发没生效`);
    assert.ok(cost < 900, `整批耗时 ${cost}ms，看起来还是串行`);

    // 字段真的写进去了（并发不能靠丢数据换速度）
    for (const it of store.listLiterature()) {
      assert.equal(it.status, 'done', `${it.id} 状态应为 done，实际 ${it.status}`);
      assert.equal(it.journal, '管理世界', '期刊要洗干净后写进记录');
      assert.equal(it.year, '2024');
      assert.equal(it.doi, '10.1234/mwt.2024.001');
      assert.ok(it.coreFindings.length > 0);
      assert.equal(it.parseStartedAt, null, '结束后必须清掉开始时间，否则会被误判成僵尸');
    }

    // 进度快照：这一轮作业有并发度 > 1，且已经收尾
    const snap = await (await fetch(`${base}/api/parse/progress`, { headers: { Connection: 'close' } })).json();
    assert.equal(snap.running, false);
    assert.equal(snap.total, 6);
    assert.equal(snap.done, 6);
    assert.ok(snap.concurrency > 1, '进度快照要带上并发度，前端才能显示「正在并行 N 篇」');
  } finally {
    await close(upstream);
    for (const s of appServers) await close(s);
  }
});

test('僵尸记录：库里写着 parsing 但没人在跑的，重新解析能接上；重启后的残留会被收回', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parse-zombie-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const { server: upstream } = mockUpstream({ responseDelayMs: 20 });
  const appServers = [];
  await mkdir(uploadDir, { recursive: true });
  try {
    const upstreamBase = await listen(upstream);
    store.configure({ dataDir });
    store.saveSettings({ aiProvider: 'openai', apiKey: 'k', baseURL: `${upstreamBase}/v1`, model: 'm', language: 'zh' });

    const pdf = await makePdf(['Platform governance and value co-creation: an empirical study of trust']);
    const mk = async (id, extra) => {
      const filePath = path.join(uploadDir, `${id}.pdf`);
      await writeFile(filePath, pdf);
      store.upsertLiterature({
        id, title: id, filePath, filename: `${id}.pdf`, originalName: `${id}.pdf`,
        fileKind: 'pdf', docType: 'empirical', status: 'pending', createdAt: new Date().toISOString(), ...extra,
      });
    };

    // 刚被「卡住」的：开始时间很新，但进程里没有任何作业 —— 重跑时不应该被跳过
    await mk('stuck-fresh', { status: 'parsing', parseStartedAt: new Date().toISOString() });
    // 很久以前残留的：应该被自动收回成「中断」
    await mk('stuck-old', { status: 'parsing', parseStartedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString() });

    const { app } = createApp({ uploadDir });
    const httpServer = createServer(app);
    appServers.push(httpServer);
    const base = await listen(httpServer);

    // ① 老残留：列表接口读一次就被收回，绝不能再显示「解析中」
    const listed = await (await fetch(`${base}/api/literature`, { headers: { Connection: 'close' } })).json();
    const oldOne = listed.find((it) => it.id === 'stuck-old');
    assert.equal(oldOne.status, 'error');
    assert.match(oldOne.error, /中断/);

    // ② 卡住的记录点「解析选中」能重新跑起来（老实现会把它当成 parsing 直接跳过）
    const parseRes = await fetch(`${base}/api/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ ids: ['stuck-fresh'] }),
    });
    const parsed = await parseRes.json();
    assert.equal(parsed.results.length, 1, '卡住的记录必须被重新纳入本次解析，而不是被跳过');
    assert.equal(store.getLiterature('stuck-fresh').status, 'done', `实际错误：${store.getLiterature('stuck-fresh').error}`);

    // ③ 批量重新解析也一样：只跳过真正在跑的
    const reRes = await fetch(`${base}/api/literature/batch-reparse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ ids: ['stuck-old'] }),
    });
    const reBody = await reRes.json();
    assert.equal(reBody.total, 1);
    assert.equal(store.getLiterature('stuck-old').status, 'done');
  } finally {
    await close(upstream);
    for (const s of appServers) await close(s);
  }
});
