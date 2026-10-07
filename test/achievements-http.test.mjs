// achievements-http.test.mjs —— 成果管理的 HTTP 级端到端测试（真实服务 + 真实文件 + mock 上游）
//
// 覆盖用户真正会走的路径：新建 → 上传（正文/检索报告/代码）→ 打开 / 导出 → 识别字段 →
// 在投进度与草稿 → 同步到论文进度 → 导出 ZIP。以及「没有系统能力时」必须给明确降级提示。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/** 极简 ZIP 读取（store 条目），用来独立校验「导出这些文件」真的把附件装进去了 */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, '导出结果不是 zip（找不到 EOCD）');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const nameLen = buf.readUInt16LE(off + 28);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const size = buf.readUInt32LE(local + 22);
    const data = buf.slice(local + 30 + lNameLen + lExtra, local + 30 + lNameLen + lExtra + size);
    out.push({ name, data: data.toString('utf8') });
    off += 46 + nameLen;
  }
  return out;
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

/** 上游 mock：识别请求回 JSON，其余回 SSE */
function mockUpstream(onBody) {
  return createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    onBody(raw);
    if (raw.includes('科研秘书')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              title: '平台生态系统的价值共创机制研究',
              authors: '张三, 李四',
              journal: '管理世界',
              year: '2024年',
              doi: 'https://doi.org/10.1234/mwt.2024.001',
              volume: '40', issue: '6', pages: '88-104',
              keywords: '平台生态；价值共创',
              abstract: '本文研究平台生态系统中多方主体如何共同创造价值。',
              __evil: '不应被写入',
            }),
          },
        }],
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
}

test('成果管理全链路：建档 → 附件 → 打开/导出 → 识别 → 进度草稿 → 同步论文进度 → 导出 ZIP', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ach-http-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const opened = [];
  const revealed = [];
  let sawParsePrompt = '';

  const upstream = mockUpstream((raw) => { if (raw.includes('科研秘书')) sawParsePrompt = raw; });
  const appServers = [];
  try {
    const upstreamBase = await listen(upstream);
    store.configure({ dataDir });
    store.saveSettings({
      aiProvider: 'custom',
      _modelMigrated: true,
      activeProfileId: 'p1',
      modelProfiles: [{
        id: 'p1', label: '模拟供应商', provider: 'custom',
        baseURL: `${upstreamBase}/v1/chat/completions`, apiKey: '', model: 'mock-model',
        streamMode: 'nonstream', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no',
        createdAt: new Date().toISOString(),
      }],
      modelRouter: { enabled: true, failover: false, queue: [], breaker: { failThreshold: 3, openSeconds: 60 } },
    });

    // 两个实例共用同一份数据目录：一个有系统打开能力（桌面版），一个没有（纯浏览器）
    const { app: appSys } = createApp({
      uploadDir,
      openPath: async (p) => { opened.push(p); return ''; },
      openWith: async (p) => { opened.push(`pick:${p}`); return { canceled: false, app: 'C:/Tools/Code.exe' }; },
      revealFile: (p) => { revealed.push(p); },
    });
    const { app: appBrowser } = createApp({ uploadDir });
    const sysServer = createServer(appSys);
    const browserServer = createServer(appBrowser);
    appServers.push(sysServer, browserServer);
    const base = await listen(sysServer);
    const baseNoSys = await listen(browserServer);

    const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
    const post = (p, body, host = base) => fetch(host + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body || {}),
    });
    const patch = (p, body, host = base) => fetch(host + p, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body || {}),
    });
    const get = (p, host = base) => fetch(host + p, { headers: { Connection: 'close' } });

    // ---------- ① 元信息：五类成果 + 列定义 ----------
    const meta = await json(await get('/api/achievements/meta'));
    assert.deepEqual(meta.categories.map((c) => c.key), ['paper', 'patent', 'certificate', 'textbook', 'project']);
    assert.ok(meta.columns.paper.length >= 6);
    assert.ok(meta.detailGroups.paper.length >= 3);
    assert.ok(meta.progressStatuses.includes('外审'));
    assert.equal(meta.defaultFolder.name, '数据文件夹');

    // ---------- ② 文件夹：新建 / 重名拒绝 / 与默认文件夹区分 ----------
    const folder = await json(await post('/api/achievement-folders', { name: '2026 投稿' }));
    assert.ok(folder.id);
    assert.equal((await post('/api/achievement-folders', { name: '2026 投稿' })).status, 400, '重名要拒绝');
    assert.equal((await post('/api/achievement-folders', { name: '数据文件夹' })).status, 400, '不能占用默认文件夹名');

    // ---------- ③ 建档：不指定文件夹 → 落到「数据文件夹」 ----------
    const blank = await json(await post('/api/achievements', { category: 'paper', title: '在投论文 A', stage: 'working' }));
    assert.equal(blank.folderId, '', '没指定文件夹的新成果必须落在数据文件夹');
    const inFolder = await json(await post('/api/achievements', { category: 'paper', title: '已发表论文 B', folderId: folder.id }));
    assert.equal(inFolder.folderId, folder.id);
    assert.equal((await post('/api/achievements', { category: 'paper', title: 'X', folderId: '不存在的夹子' })).status, 400);
    assert.equal((await post('/api/achievements', { category: '乱写', title: 'Y' })).status, 200, '未知类型回落成论文而不是报错');

    // ---------- ④ 附件：PDF 正文 + 检索报告 + 代码文件 ----------
    const pdfBuf = await makePdf([
      'Platform Ecosystem Value Co-creation Mechanisms',
      'Journal of Management 2024; DOI: 10.1234/jom.2024.001',
      'Abstract. This paper studies how multiple actors co-create value in platform ecosystems.',
    ]);
    const uploadPdf = async (id, name, body, kind) => {
      const fd = new FormData();
      fd.append('file', new Blob([body]), name);
      fd.append('kind', kind);
      return json(await fetch(`${base}/api/achievements/${id}/files`, { method: 'POST', body: fd }));
    };
    let rec = await uploadPdf(blank.id, '正文终稿.pdf', pdfBuf, 'main');
    assert.equal(rec.files.length, 1);
    assert.equal(rec.files[0].kind, 'main');
    assert.equal(rec.files[0].ext, 'pdf');
    assert.equal(rec.files[0].filePath, undefined, '接口不能把本地路径吐给前端');

    rec = await uploadPdf(blank.id, '检索报告.docx', Buffer.from('fake docx'), 'searchReport');
    assert.equal(rec.files.length, 2);
    rec = await uploadPdf(blank.id, 'analysis.py', Buffer.from('print("hi")'), 'code');
    assert.equal(rec.files.length, 3);
    assert.equal(rec.files[2].kind, 'code');
    assert.match(rec.files[2].appHint || '', /编辑器/, '代码文件要给出「通常用什么打开」的提示');
    const pdfFile = rec.files[0];
    const codeFile = rec.files[2];

    // 任意格式都要能传（成果管理不像文献中心那样只收 PDF）
    rec = await uploadPdf(blank.id, '结题证书.zip', Buffer.from('zipbytes'), 'other');
    assert.equal(rec.files.length, 4);

    // ---------- ⑤ 下载：字节一模一样 + 文件名带出去 ----------
    const dl = await get(`/api/achievements/${blank.id}/files/${pdfFile.id}/download`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition') || '', /attachment/);
    assert.equal(Buffer.compare(Buffer.from(await dl.arrayBuffer()), pdfBuf), 0, '下载内容必须与上传完全一致');

    // ---------- ⑥ 打开：桌面版走系统程序；纯浏览器版给明确降级 ----------
    const open1 = await json(await post(`/api/achievements/${blank.id}/files/${codeFile.id}/open`, { mode: 'default' }));
    assert.equal(open1.ok, true);
    assert.equal(opened.length, 1, '要把保存时的真实路径交给系统');
    assert.ok(opened[0].endsWith('.py'), '交给系统的应该是那个 py 文件');

    const open2 = await json(await post(`/api/achievements/${blank.id}/files/${codeFile.id}/open`, { mode: 'pick' }));
    assert.equal(open2.ok, true);
    assert.match(open2.app, /Code\.exe/, '要把用户选的程序回给前端');
    assert.match(opened[1], /^pick:/, '自选程序走的是另一条注入能力');

    const open3 = await json(await post(`/api/achievements/${blank.id}/files/${codeFile.id}/open`, { mode: 'folder' }));
    assert.equal(open3.ok, true);
    assert.equal(revealed.length, 1);

    const noSys = await fetch(`${baseNoSys}/api/achievements/${blank.id}/files/${codeFile.id}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ mode: 'default' }),
    });
    assert.equal(noSys.status, 409, '没有系统能力时要明确说不支持，而不是假装成功');
    const noSysBody = await json(noSys);
    assert.equal(noSysBody.fallback, 'download');
    assert.match(noSysBody.url, /download$/);

    // ---------- ⑦ 打开失败也要给降级：系统没有关联程序 ----------
    const { app: appBroken } = createApp({ uploadDir, openPath: async () => 'No application is associated with the specified file' });
    const brokenServer = createServer(appBroken);
    appServers.push(brokenServer);
    const baseBroken = await listen(brokenServer);
    const broken = await fetch(`${baseBroken}/api/achievements/${blank.id}/files/${codeFile.id}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ mode: 'default' }),
    });
    assert.equal(broken.status, 500);
    const brokenBody = await json(broken);
    assert.equal(brokenBody.canPick, false, '这个实例没注入「选择程序」，不该提示可以选程序');
    assert.match(brokenBody.error, /打开方式|其它程序|下载/);

    // ---------- ⑧ AI 识别字段 ----------
    const parsed = await json(await post(`/api/achievements/${blank.id}/parse`, { source: 'main', profileId: 'p1' }));
    assert.equal(parsed.status, 'done');
    assert.equal(parsed.source, 'ai');
    assert.equal(parsed.title, '平台生态系统的价值共创机制研究');
    assert.equal(parsed.year, '2024', '「2024年」要清洗成 2024');
    assert.equal(parsed.doi, '10.1234/mwt.2024.001', 'DOI 要去掉 doi.org 前缀');
    assert.equal(parsed.volume, '40');
    assert.equal(parsed.__evil, undefined, '模型幻觉出来的字段不能落库');
    assert.ok(sawParsePrompt.includes('科研秘书'), '要真的走了识别链路');
    assert.ok(parsed.parsedAt);

    // ---------- ⑨ 白名单：前端改不动 filePath / files ----------
    const hacked = await json(await patch(`/api/achievements/${blank.id}`, {
      title: '在投论文 A（改名）',
      filePath: '/etc/passwd',
      files: [{ id: 'evil', filePath: '/etc/passwd' }],
      status: 'done',
      id: 'hacked',
    }));
    assert.equal(hacked.title, '在投论文 A（改名）');
    assert.equal(hacked.filePath, undefined);
    assert.equal(hacked.files.length, 4, '附件清单不能被 PATCH 覆盖');
    assert.equal(hacked.id, blank.id, 'id 不能被改');
    assert.equal(hacked.status, 'done', 'status 只有识别流程会改，PATCH 改不动');
    // 非法的进度状态要明确拒绝，而不是静默写入
    const badStatus = await patch(`/api/achievements/${blank.id}`, { progressStatus: '不存在的状态' });
    assert.equal(badStatus.status, 400);
    assert.equal((await patch(`/api/achievements/${blank.id}`, { progressStatus: '外审' })).status, 200);

    // ---------- ⑩ 在投进度：记一笔 + 重复不重复记 ----------
    let withProgress = await json(await post(`/api/achievements/${blank.id}/progress`, {
      status: '投稿中', note: '投至《管理世界》', percent: 40, submitDate: '2026-01-15',
    }));
    assert.equal(withProgress.progressStatus, '投稿中');
    assert.equal(withProgress.progressPercent, '40');
    assert.equal(withProgress.submitDate, '2026-01-15');
    assert.equal(withProgress.progressHistory.length, 1);
    assert.equal(withProgress.stage, 'working', '记进度后阶段自动落到进行中');

    withProgress = await json(await post(`/api/achievements/${blank.id}/progress`, { status: '投稿中', note: '投至《管理世界》', percent: 40 }));
    assert.equal(withProgress.progressHistory.length, 1, '同状态同说明连点两下不该写两条历史');

    withProgress = await json(await post(`/api/achievements/${blank.id}/progress`, { status: '外审', note: '进入外审', percent: 60 }));
    assert.equal(withProgress.progressHistory.length, 2);
    assert.deepEqual(withProgress.progressHistory.map((h) => h.status), ['投稿中', '外审']);

    // ---------- ⑪ 保存草稿 ----------
    const draft = await json(await post(`/api/achievements/${blank.id}/draft`, { abstract: '草稿中的摘要…', progressNote: '资料还没补齐' }));
    assert.equal(draft.isDraft, true);
    assert.equal(draft.abstract, '草稿中的摘要…');
    assert.ok(draft.progressNote);
    const undraft = await json(await patch(`/api/achievements/${blank.id}`, { isDraft: false }));
    assert.equal(undraft.isDraft, false);

    // ---------- ⑫ 同步到论文进度：只创建一次，之后原地更新 ----------
    const synced = await json(await post(`/api/achievements/${blank.id}/sync-paper`, {}));
    assert.ok(synced.paper.id);
    assert.equal(synced.paper.status, '外审', '状态要跟着成果管理的进度走');
    assert.equal(synced.paper.submitDate, '2026-01-15');
    assert.equal(synced.paper.fromAchievement, blank.id);
    assert.ok(synced.achievement.paperId);
    const papers1 = await json(await get('/api/papers'));
    assert.equal(papers1.filter((p) => p.fromAchievement === blank.id).length, 1);

    await json(await post(`/api/achievements/${blank.id}/progress`, { status: '录用', note: '已录用', percent: 90 }));
    const synced2 = await json(await post(`/api/achievements/${blank.id}/sync-paper`, {}));
    assert.equal(synced2.paper.id, synced.paper.id, '重复同步要原地更新，不能堆出第二条');
    assert.equal(synced2.paper.status, '录用');
    const papers2 = await json(await get('/api/papers'));
    assert.equal(papers2.filter((p) => p.fromAchievement === blank.id).length, 1, '论文进度里不能出现重复卡片');

    // ---------- ⑬ 导出：元数据 CSV + 含附件的 ZIP ----------
    const csv = await get('/api/achievements/export');
    assert.equal(csv.status, 200);
    // BOM 必须查原始字节：fetch().text() 的 UTF-8 解码会把它吃掉
    const csvBytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...csvBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'CSV 要带 BOM，否则 Excel 打开中文乱码');
    const csvText = csvBytes.toString('utf8');
    assert.ok(csvText.includes('在投论文 A（改名）'));
    assert.ok(csvText.includes('2026 投稿'), '要能看出成果属于哪个文件夹');

    const zipRes = await fetch(`${base}/api/achievements/export-zip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ ids: [blank.id, inFolder.id] }),
    });
    assert.equal(zipRes.status, 200);
    const entries = readZip(Buffer.from(await zipRes.arrayBuffer()));
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('成果清单.csv'));
    assert.ok(names.includes('导出说明.txt') === false, '附件都在，不该出现「缺失」说明');
    const fileEntries = names.filter((n) => n.endsWith('.pdf') || n.endsWith('.py') || n.endsWith('.docx') || n.endsWith('.zip'));
    assert.equal(fileEntries.length, 4, `4 个附件都要打进 zip，实际：${names.join(' | ')}`);
    assert.ok(names.some((n) => n.includes('正文_正文终稿.pdf')), '附件要带类型前缀与原名');
    const metaEntry = entries.find((e) => e.name.endsWith('meta.json'));
    assert.ok(metaEntry, '每条成果要附一份 meta.json');
    assert.equal(JSON.parse(metaEntry.data).filePath, undefined, 'meta.json 里不能带本地路径');

    // ---------- ⑭ 删除：附件文件一并删掉 ----------
    const delRes = await json(await fetch(`${base}/api/achievements/${blank.id}`, { method: 'DELETE', headers: { Connection: 'close' } }));
    assert.equal(delRes.removed, true);
    assert.equal((await get(`/api/achievements/${blank.id}`)).status, 404);
    const afterDel = await json(await get(`/api/achievements/${blank.id}/files/${codeFile.id}/download`)).catch(() => null);
    assert.ok(afterDel === null || afterDel.error, '附件下载应该失败（记录与物理文件都没了）');
    const list = await json(await get('/api/achievements'));
    assert.equal(list.items.length, 2, '另外两条（文件夹里的 + 未知类型回落的）要留着');
    assert.equal(list.folders.find((f) => f.id === folder.id).count, 1);
    assert.equal(list.folders.find((f) => f.isDefault).count, 1, '默认文件夹里的那条也不该被误删');
  } finally {
    for (const s of appServers) await close(s).catch(() => {});
    await close(upstream).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('没有可用模型时：规则解析兜底，把标题/年份/DOI 先抓出来', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ach-rule-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  let server;
  try {
    store.configure({ dataDir });
    store.saveSettings({ aiProvider: 'none', activeProfileId: '', modelProfiles: [] });
    const { app } = createApp({ uploadDir });
    server = createServer(app);
    const base = await listen(server);
    const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

    const rec = await json(await fetch(`${base}/api/achievements`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'paper', title: '待识别' }),
    }));
    const pdf = await makePdf([
      'Platform Ecosystem Value Co-creation Mechanisms',
      'Journal of Management 2024; DOI: 10.1234/jom.2024.001',
      'Abstract. This paper studies how multiple actors co-create value in platform ecosystems through digital platforms.',
    ]);
    const fd = new FormData();
    fd.append('file', new Blob([pdf]), 'paper.pdf');
    fd.append('kind', 'main');
    await fetch(`${base}/api/achievements/${rec.id}/files`, { method: 'POST', body: fd });

    const parsed = await json(await fetch(`${base}/api/achievements/${rec.id}/parse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    }));
    assert.equal(parsed.status, 'done', `规则兜底应当成功：${parsed.error || ''}`);
    assert.equal(parsed.source, 'rule');
    assert.ok(parsed.title, '规则解析至少要抓到标题');
    assert.match(String(parsed.doi), /^10\.1234\//, 'DOI 要能抓出来');
    assert.match(String(parsed.year), /^(19|20)\d{2}$/, '年份要能抓出来');

    // 非 PDF / DOCX 的文件不做识别，要明确说清楚
    const fd2 = new FormData();
    fd2.append('file', new Blob([Buffer.from('x')]), 'note.txt');
    fd2.append('kind', 'main');
    const rec2 = await json(await fetch(`${base}/api/achievements`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '只有 txt' }),
    }));
    await fetch(`${base}/api/achievements/${rec2.id}/files`, { method: 'POST', body: fd2 });
    const bad = await fetch(`${base}/api/achievements/${rec2.id}/parse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
    assert.match((await json(bad)).error, /PDF|DOCX/);

    // 没有附件就说没有附件
    const rec3 = await json(await fetch(`${base}/api/achievements`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '空的' }),
    }));
    const none = await fetch(`${base}/api/achievements/${rec3.id}/parse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(none.status, 400);
    assert.match((await json(none)).error, /上传/);
  } finally {
    if (server) await close(server).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('数据目录迁移后，既有成果与文件夹仍然读得出来（不因换目录丢数据）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ach-move-'));
  const a = path.join(root, 'dir-a');
  const b = path.join(root, 'dir-b');
  const uploadDir = path.join(root, 'uploads');
  const servers = [];
  try {
    store.configure({ dataDir: a });
    const { app: app1 } = createApp({ uploadDir });
    const s1 = createServer(app1);
    servers.push(s1);
    const base1 = await listen(s1);
    const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
    await fetch(`${base1}/api/achievement-folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '基金材料' }),
    });
    await fetch(`${base1}/api/achievements`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'project', title: '国自科面上项目' }),
    });

    // 新目录：什么都不该有
    store.configure({ dataDir: b });
    const { app: app2 } = createApp({ uploadDir });
    const s2 = createServer(app2);
    servers.push(s2);
    const base2 = await listen(s2);
    const empty = await json(await fetch(`${base2}/api/achievements`));
    assert.equal(empty.items.length, 0);
    assert.equal(empty.folders.length, 1, '只有默认的「数据文件夹」');

    // 切回原目录：数据必须原封不动
    store.configure({ dataDir: a });
    const back = await json(await fetch(`${base2}/api/achievements`));
    assert.equal(back.items.length, 1);
    assert.equal(back.items[0].title, '国自科面上项目');
    assert.equal(back.folders.length, 2);
    assert.equal(back.folders[1].name, '基金材料');
  } finally {
    for (const s of servers) await close(s).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
