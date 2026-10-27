// lit-file-rename.test.mjs —— PDF 文件名与「定位到磁盘」两件事
//
// 用户的两条要求：
//   ① 点 PDF 链接应该「链接到文件保存位置」，而不是又在浏览器里读一遍上传副本；
//   ② 上传后自动用大模型解析出的标题给 PDF 重命名，方便分享。
//
// 这里既测纯函数（标题 → 合法文件名、改名时的冲突/保护规则），也测真实 HTTP 链路：
// 真 PDF + mock 上游 → 解析完磁盘上的文件名应该就是标题；reveal 接口在有无系统能力时
// 分别给出 200 / 409+兜底 URL，而不是静默失败。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp, sanitizeFileStem, renamePdfFileToTitle } from '../server.js';
import * as store from '../src/store.js';
import { shutdownPdfTextPool } from '../src/pdfTextPool.js';

// 真实解析会拉起 PDF 抽取线程；收尾时把它们关掉，免得测试进程多等一轮空闲回收
test.after(async () => { await shutdownPdfTextPool(); });

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

const TITLE = '平台治理对用户价值共创的影响：一项追踪研究';

const AI_FIELDS = {
  title: TITLE,
  authors: '张三, 李四', journal: '管理世界', year: '2024', doi: '10.1234/mwt.2024.001',
  keywords: '平台治理；价值共创', abstract: '摘要',
  researchQuestion: '问题', researchObject: '样本', coreFindings: '结论',
  mechanism: '机制', boundaryConditions: '边界', method: '方法', researchDesign: '设计',
  constructs: '构念', criticalThinking: '批判', reviewUse: '用途', researchGap: '空白',
};

function mockUpstream(fields = AI_FIELDS) {
  return createServer(async (req, res) => {
    for await (const _ of req) { /* 读完 */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fields) } }] }));
  });
}

// ---------- 纯函数：标题 → 文件名 ----------
test('文件名净化：去掉 Windows 禁用字符与结尾的点，保留中文', () => {
  assert.equal(sanitizeFileStem('平台治理/用户参与: 一个"实证"研究?'), '平台治理 用户参与 一个 实证 研究');
  assert.equal(sanitizeFileStem('  多  空格   合并  '), '多 空格 合并');
  assert.equal(sanitizeFileStem('标题以点结尾...'), '标题以点结尾');
  assert.equal(sanitizeFileStem('a\\b*c<d>e|f'), 'a b c d e f');
  assert.ok(sanitizeFileStem('长'.repeat(200)).length <= 80, '超长标题要截断');
  assert.equal(sanitizeFileStem(''), '');
  // Windows 保留设备名，直接当文件名会创建失败
  assert.equal(sanitizeFileStem('CON'), '_CON');
});

test('改名：把随机文件名换成标题，且不动别的文件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ren-'));
  const src = path.join(dir, '1790263659210_lfovhv.pdf');
  await writeFile(src, '%PDF-1.4 fake');
  const out = renamePdfFileToTitle({ id: 'x', fileKind: 'pdf', filePath: src, title: TITLE });
  assert.ok(out, '应该改名成功');
  assert.equal(out.filename, `${TITLE}.pdf`);
  assert.equal(out.filePath, path.join(dir, `${TITLE}.pdf`));
  assert.deepEqual(await readdir(dir), [`${TITLE}.pdf`], '旧文件应当已经被改名而不是复制');
  // 再跑一次：已经是标题名 → 不动
  assert.equal(renamePdfFileToTitle({ id: 'x', fileKind: 'pdf', filePath: out.filePath, title: TITLE }), null);
});

test('改名守则：同名加序号、太短的标题不改、非 PDF 不改、文件不在不改', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ren-'));
  const a = path.join(dir, 'aaa.pdf');
  const b = path.join(dir, 'bbb.pdf');
  await writeFile(a, 'a');
  await writeFile(b, 'b');
  const first = renamePdfFileToTitle({ fileKind: 'pdf', filePath: a, title: TITLE });
  assert.equal(first.filename, `${TITLE}.pdf`);
  const second = renamePdfFileToTitle({ fileKind: 'pdf', filePath: b, title: TITLE });
  assert.equal(second.filename, `${TITLE} (2).pdf`, '同名文件不能互相覆盖');

  assert.equal(renamePdfFileToTitle({ fileKind: 'pdf', filePath: b, title: '研究' }), null, '太短的标题不值得改');
  assert.equal(renamePdfFileToTitle({ fileKind: 'epub', filePath: b, title: TITLE }), null, 'EPUB 不动');
  assert.equal(renamePdfFileToTitle({ fileKind: 'pdf', filePath: path.join(dir, 'nope.pdf'), title: TITLE }), null);
});

// ---------- HTTP：上传 → 解析 → 磁盘文件名 = 标题 ----------
test('解析完成后 PDF 在磁盘上就叫「标题.pdf」，记录里的文件名同步更新', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lit-rename-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  const upstream = mockUpstream();
  const servers = [];
  try {
    const upstreamBase = await listen(upstream);
    store.configure({ dataDir });
    store.saveSettings({ aiProvider: 'openai', apiKey: 'k', baseURL: `${upstreamBase}/v1`, model: 'm', language: 'zh' });

    const oldName = '1790263659210_lfovhv.pdf';
    const filePath = path.join(uploadDir, oldName);
    await writeFile(filePath, await makePdf(['Platform governance and value co-creation']));
    store.upsertLiterature({
      id: 'lit-rename', title: '未命名文献', originalName: oldName, filename: oldName, filePath,
      fileKind: 'pdf', docType: 'empirical', status: 'pending', createdAt: new Date().toISOString(),
    });

    const { app } = createApp({ uploadDir });
    const httpServer = createServer(app);
    servers.push(httpServer);
    const base = await listen(httpServer);

    const res = await fetch(`${base}/api/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ ids: ['lit-rename'] }),
    });
    assert.equal(res.status, 200);

    const rec = store.getLiterature('lit-rename');
    assert.equal(rec.status, 'done', `解析应成功：${rec.error}`);
    assert.equal(rec.filename, `${TITLE}.pdf`, '记录里的文件名要换成标题');
    assert.equal(rec.originalName, `${TITLE}.pdf`, '界面上显示的名字也要跟着变');
    assert.equal(rec.originalUploadName, oldName, '原始上传名要留档（提示里会用）');
    assert.equal(rec.filePath, path.join(uploadDir, `${TITLE}.pdf`));

    const files = await readdir(uploadDir);
    assert.deepEqual(files, [`${TITLE}.pdf`], '磁盘上应该只剩改名后的文件');
    assert.ok((await stat(path.join(uploadDir, `${TITLE}.pdf`))).size > 0);
  } finally {
    await close(upstream);
    for (const s of servers) await close(s);
  }
});

// ---------- HTTP：点链接 = 定位到磁盘 ----------
test('reveal：桌面版调用系统「在文件夹中显示并选中」', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lit-reveal-'));
  const uploadDir = path.join(root, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  store.configure({ dataDir: path.join(root, 'data') });

  const fileName = '论文.pdf';
  const filePath = path.join(uploadDir, fileName);
  await writeFile(filePath, 'x');
  store.upsertLiterature({
    id: 'lit-reveal', title: '论文', originalName: fileName, filename: fileName, filePath,
    fileKind: 'pdf', docType: 'empirical', status: 'done',
  });

  const revealed = [];
  const { app } = createApp({ uploadDir, revealFile: (p) => revealed.push(p) });
  const httpServer = createServer(app);
  try {
    const base = await listen(httpServer);
    const r = await fetch(`${base}/api/literature/lit-reveal/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ mode: 'folder' }),
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.mode, 'folder');
    assert.deepEqual(revealed, [filePath], '应该把磁盘路径交给系统，而不是返回一个 /uploads/ 链接');
  } finally {
    await close(httpServer);
  }
});

test('reveal：纯浏览器运行没有系统能力时，给 409 + 可用的兜底地址', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lit-reveal2-'));
  const uploadDir = path.join(root, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  store.configure({ dataDir: path.join(root, 'data') });

  const fileName = 'browser.pdf';
  const filePath = path.join(uploadDir, fileName);
  await writeFile(filePath, 'x');
  store.upsertLiterature({
    id: 'lit-reveal2', title: 'b', originalName: fileName, filename: fileName, filePath,
    fileKind: 'pdf', docType: 'empirical', status: 'done',
  });

  const { app } = createApp({ uploadDir });   // 不注入 openPath / revealFile
  const httpServer = createServer(app);
  try {
    const base = await listen(httpServer);
    const r = await fetch(`${base}/api/literature/lit-reveal2/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ mode: 'folder' }),
    });
    const body = await r.json();
    assert.equal(r.status, 409);
    assert.equal(body.fallback, 'url');
    assert.ok(String(body.url).startsWith('/uploads/'), '至少要给出能打开文件的地址');
  } finally {
    await close(httpServer);
  }
});

test('reveal：文件被移走时明确说找不到，而不是给个坏链接', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lit-reveal3-'));
  const uploadDir = path.join(root, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  store.configure({ dataDir: path.join(root, 'data') });
  store.upsertLiterature({
    id: 'lit-gone', title: 'g', originalName: 'gone.pdf', filename: 'gone.pdf',
    filePath: path.join(uploadDir, 'gone.pdf'), fileKind: 'pdf', docType: 'empirical', status: 'done',
  });

  const { app } = createApp({ uploadDir, revealFile: () => {} });
  const httpServer = createServer(app);
  try {
    const base = await listen(httpServer);
    const r = await fetch(`${base}/api/literature/lit-gone/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /找不到/);
  } finally {
    await close(httpServer);
  }
});
