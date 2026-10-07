// achievement-reader.test.mjs —— 「成果管理里的论文，在终端内阅读 + 翻译」
//
// 这条链路把两个原本独立的模块接了起来：成果管理的附件（自己的 PDF）
// → 全文翻译服务（原本只认文献库 literatureId）。
// 守护三类容易被改坏、而且坏了不容易发现的东西：
//
//   1) 来源解析：成果附件（achievementId + fileId）必须被翻译服务认出来；
//      但绝不能变成「前端能指哪打哪」的任意路径读取口子。
//   2) 安全边界：成果附件的磁盘文件名 / 绝对路径不向前端暴露（阅读与翻译都不需要）。
//   3) 前端接线：阅读器「按来源收敛面板」用到的选择器必须真的存在于 index.html，
//      否则面板会静默隐藏失败 —— 这个项目历史上踩过同类坑（id 写错、事件没绑上）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';
import * as achievementStore from '../src/achievementStore.js';
import { PdfTranslateService } from '../src/pdfTranslate/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}
async function makePdf(pages) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    let y = 780;
    for (const line of lines) { page.drawText(line, { x: 40, y, size: 11, font, lineHeight: 16 }); y -= 16; }
  }
  return Buffer.from(await doc.save());
}

// ==================== 1. 作业记住「成果来源」 ====================

test('翻译作业记录成果来源（achievementId + fileId），供前端筛出这一篇的历史', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pt-src-'));
  try {
    const svc = new PdfTranslateService({
      getSettings: () => ({}),
      getDataDir: () => dataDir,
      getUploadDir: () => dataDir,
    });
    const job = svc.start({
      filePath: path.join(dataDir, 'x.pdf'),
      fileName: 'digital-transformation-paper.pdf',
      achievementId: 'ach-1',
      fileId: 'file-9',
      options: {},
    });
    assert.equal(job.achievementId, 'ach-1', '作业必须记住成果 id，否则翻译历史筛不出来');
    assert.equal(job.fileId, 'file-9');
    assert.equal(job.literatureId, null, '成果来源不该被误标成文献');
    // 列表接口（前端据此渲染「本篇的翻译记录」）也要带上
    const listed = svc.list().find((j) => j.id === job.id);
    assert.equal(listed?.achievementId, 'ach-1');
    assert.equal(listed?.fileId, 'file-9');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('不给成果来源时保持为空（文献中心 / 直接上传 PDF 的老路径不受影响）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pt-src-'));
  try {
    const svc = new PdfTranslateService({
      getSettings: () => ({}),
      getDataDir: () => dataDir,
      getUploadDir: () => dataDir,
    });
    const lit = svc.start({ filePath: path.join(dataDir, 'a.pdf'), literatureId: 'lit-1', options: {} });
    assert.equal(lit.literatureId, 'lit-1');
    assert.equal(lit.achievementId, null);
    assert.equal(lit.fileId, null);

    const plain = svc.start({ filePath: path.join(dataDir, 'b.pdf'), options: {} });
    assert.equal(plain.literatureId, null);
    assert.equal(plain.achievementId, null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ==================== 2. 安全边界：不向前端暴露磁盘路径 ====================

test('成果附件对外只给展示信息，不给磁盘文件名与绝对路径', () => {
  const pub = achievementStore.publicFile({
    id: 'f1', kind: 'main', originalName: 'paper.pdf', filename: '1790014813318_lz8uxo_paper.pdf',
    filePath: 'C:/secret/uploads/1790014813318_lz8uxo_paper.pdf', fileSize: 1234, ext: 'pdf', appHint: 'PDF 阅读器',
  });
  assert.equal(pub.id, 'f1');
  assert.equal(pub.originalName, 'paper.pdf');
  assert.equal(pub.ext, 'pdf');
  // 这三样一旦外泄，前端就能拼出任意路径去读本机文件 —— 必须剥掉
  assert.equal(pub.filename, undefined, '不能暴露磁盘文件名');
  assert.equal(pub.filePath, undefined, '不能暴露绝对路径');
  assert.ok(!JSON.stringify(pub).includes('secret'), '序列化后也不能漏出路径片段');
});

// ==================== 3. 前端接线：选择器必须真的存在 ====================

test('阅读器「按来源收敛面板」用到的元素都真的在 index.html 里', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // applyReaderMode 里逐一点名的（缺失会导致面板静默隐藏失败 / 藏不住）
  for (const id of ['prLitOnly', 'prTabAnalysis', 'prTabChat', 'prColorTools', 'prToggleNote', 'prSelectionToolbar']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里缺少 #${id}（阅读器面板收敛会失效）`);
  }
  // 划词工具条里「写文献库」的三个动作必须带 data-litonly 标记，否则成果论文下藏不掉
  const bar = html.slice(html.indexOf('id="prSelectionToolbar"'));
  const marked = [...bar.slice(0, bar.indexOf('</div>')).matchAll(/data-sel="(\w+)"[^>]*data-litonly|data-litonly[^>]*data-sel="(\w+)"/g)]
    .map((m) => m[1] || m[2]).sort();
  assert.deepEqual(marked, ['highlight', 'note', 'underline'],
    '高亮 / 下划线 / 笔记 会写回文献库，必须标记 data-litonly 以便在成果论文下隐藏');
  assert.ok(/data-sel="translate"/.test(bar), '划词翻译必须保留');
});

// ==================== 4. HTTP：成果附件真的能进翻译流水线 ====================

test('成果附件（achievementId + fileId）能被翻译服务解析出正文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ach-reader-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  let server;
  try {
    store.configure({ dataDir });
    store.saveSettings({ aiProvider: 'custom', _modelMigrated: true, modelProfiles: [] });

    const { app } = createApp({ uploadDir });
    server = createServer(app);
    const base = await listen(server);

    // 建一条成果
    const created = await (await fetch(`${base}/api/achievements`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'paper', stage: 'done', title: 'Digital Transformation Paper' }),
    })).json();

    // 挂一份真实的多页英文 PDF
    const pdf = await makePdf([
      ['Digital Transformation and Corporate Innovation Performance', 'Abstract. This paper investigates how digital transformation affects innovation.'],
      ['1. Introduction', 'The diffusion of digital technologies has reshaped how firms organize innovation.', 'We construct a firm-year panel from listed firms.'],
    ]);
    const fd = new FormData();
    fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'paper.pdf');
    fd.append('kind', 'main');
    const up = await (await fetch(`${base}/api/achievements/${created.id}/files`, { method: 'POST', body: fd })).json();
    const fileId = up.files[0].id;

    // 附件对外不含磁盘路径（安全边界）
    assert.equal(up.files[0].filePath, undefined);
    assert.equal(up.files[0].filename, undefined);

    // 预估：只解析版面，不需要模型 Key —— 正好用来验证「来源接通」
    const est = await fetch(`${base}/api/pdf-translate/estimate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ achievementId: created.id, fileId, options: {} }),
    });
    const estBody = await est.json();
    assert.equal(est.status, 200, `成果附件应能进翻译流水线：${JSON.stringify(estBody)}`);
    assert.ok(Number(estBody.blocks) > 0, `应解析出段落，实际 blocks=${estBody.blocks}`);
    assert.ok(Number(estBody.totalPages) >= 2, `应识别出多页，实际 ${estBody.totalPages}`);
  } finally {
    if (server) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('来源解析的拒绝路径：不存在的成果 / 非 PDF / 缺 fileId 都明确报错，不当成本地任意路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ach-reader-bad-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  let server;
  try {
    store.configure({ dataDir });
    store.saveSettings({ aiProvider: 'custom', _modelMigrated: true, modelProfiles: [] });
    const { app } = createApp({ uploadDir });
    server = createServer(app);
    const base = await listen(server);

    const est = (body) => fetch(`${base}/api/pdf-translate/estimate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    // 不存在的成果附件
    const r1 = await est({ achievementId: 'nope', fileId: 'nope', options: {} });
    assert.equal(r1.status, 400);
    assert.match((await r1.json()).error, /找不到/);

    // 只给 achievementId 不给 fileId → 视为来源不明（而不是猜一个文件）
    const r2 = await est({ achievementId: 'nope', options: {} });
    assert.equal(r2.status, 400);
    assert.match((await r2.json()).error, /缺少/);

    // 附件不是 PDF
    const created = await (await fetch(`${base}/api/achievements`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'paper', stage: 'done', title: '带 txt 的成果' }),
    })).json();
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('not a pdf')], { type: 'text/plain' }), 'notes.txt');
    fd.append('kind', 'other');
    const up = await (await fetch(`${base}/api/achievements/${created.id}/files`, { method: 'POST', body: fd })).json();
    const r3 = await est({ achievementId: created.id, fileId: up.files[0].id, options: {} });
    assert.equal(r3.status, 400);
    assert.match((await r3.json()).error, /只支持 PDF/);

    // 同时带成果与文献时，成果优先（最具体的来源先判断，避免被误当成文献记录）
    const r4 = await est({ achievementId: 'nope', fileId: 'nope', literatureId: 'lit-x', options: {} });
    assert.equal(r4.status, 400);
    assert.match((await r4.json()).error, /找不到该成果附件/, '成果来源应优先于文献来源被解析');
  } finally {
    if (server) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

// ==================== 5. 前端源码接线检查（wiring） ====================

test('成果管理里只有 PDF 附件才会出现「阅读」入口', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'achievements.js'), 'utf8');
  assert.ok(/data-fread=/.test(js), '附件行应有阅读按钮的渲染');
  assert.ok(/isPdfFile\(f\)/.test(js), '阅读按钮必须按 isPdfFile 收窄（非 PDF 进不了 pdf.js 阅读器）');
  assert.ok(/window\.__openReaderExternal/.test(js), '应通过阅读器暴露的入口打开（复用文献中心那一套）');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(/window\.__openReaderExternal =/.test(app), 'app.js 必须真的暴露 __openReaderExternal');
  assert.ok(/kind: 'achievement'/.test(app), '打开时要把来源标成 achievement');
  // 成果来源必须走 achievementId + fileId（不是向前端要磁盘路径）
  assert.ok(/achievementId: pr\.source\.achievementId, fileId: pr\.source\.fileId/.test(app),
    '全文翻译要按 achievementId + fileId 交给服务端解析');
  assert.ok(!/ftSourceBody[\s\S]{0,400}?filePath/.test(app), '前端不应自己拼磁盘路径');
});
