// doc-language.test.mjs —— 「中文文献不需要整篇翻译」的判定与拦截
//
// 判据是服务端读 PDF 正文数汉字占比（src/docLanguage.js），结果缓存在文献记录的 docLang 上：
//   · 判定要稳：中文期刊论文夹着英文摘要 / 英文参考文献时不能被判成英文；
//     英文论文里引两句中文也不能被判成中文；
//   · 判不出来（扫描件、样本太少）要给 unknown，前端按"不是中文"处理 ——
//     宁可多给一次翻译入口，也不能因为判断不出来把功能藏掉；
//   · 拦截只发生在「正文中文 + 目标语言中文」这一种组合：中文翻英文是真需求，不能一起拦。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';
import { detectDocLanguage, isChineseDoc, shouldSkipFullTranslate } from '../src/docLanguage.js';
import { shutdownPdfTextPool } from '../src/pdfTextPool.js';

test.after(async () => { await shutdownPdfTextPool(); });

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

const ZH_BODY = '平台治理机制如何影响用户的价值共创行为？本文基于三个省级行政区的问卷数据，'
  + '采用结构方程模型进行检验。研究发现，规则透明度显著提升参与意愿，而惩罚强度的作用依赖信任水平。'
  + '进一步的分析表明，知识共享在其中起到部分中介作用。';

const EN_BODY = 'This paper examines how platform governance shapes value co-creation. '
  + 'Using survey data from three provinces, we estimate a structural equation model. '
  + 'We find that rule transparency significantly increases participation intention, '
  + 'while the effect of punishment severity depends on trust.';

test('中文正文判为 zh', () => {
  const r = detectDocLanguage(ZH_BODY.repeat(4));
  assert.equal(r.lang, 'zh');
  assert.ok(r.ratio > 0.5, `汉字占比应很高，实际 ${r.ratio}`);
});

test('英文正文判为 other', () => {
  const r = detectDocLanguage(EN_BODY.repeat(4));
  assert.equal(r.lang, 'other');
  assert.ok(r.ratio < 0.05);
});

test('中文论文挂英文摘要与英文参考文献，仍然判为 zh', () => {
  // 真实中文期刊论文：正文中文占大头，摘要和参考文献是英文（约三分之一篇幅）
  const mixed = ZH_BODY.repeat(60) + '\n\nAbstract: ' + EN_BODY.repeat(4) + '\n\nReferences\n' + EN_BODY.repeat(8);
  const r = detectDocLanguage(mixed);
  assert.equal(r.lang, 'zh', `中英混排的实证论文不能判成英文（median=${r.ratio} global=${r.globalRatio}）`);
});

test('英文论文里引了几句中文，不该判成中文', () => {
  const mixed = EN_BODY.repeat(10) + '\n该量表源自中文文献。';
  const r = detectDocLanguage(mixed);
  assert.equal(r.lang, 'other');
});

test('样本太少 → unknown（扫描件 / 空文本，不下结论）', () => {
  assert.equal(detectDocLanguage('').lang, 'unknown');
  assert.equal(detectDocLanguage('平台治理').lang, 'unknown');
  assert.equal(detectDocLanguage('short english text').lang, 'unknown');
  assert.equal(isChineseDoc(detectDocLanguage('')), false, 'unknown 不该被当成中文');
});

test('超长正文按全篇均匀窗口采样：只读开头会判错，均匀取就不会', () => {
  // 结构：约 26k 英文（封面/目录/英文摘要）→ 约 21k 中文正文 → 约 13k 英文参考文献
  // 只读开头 13k 看到的是纯英文；全篇均匀取 20 个窗口就能把中段的中文带进来。
  const en = EN_BODY.repeat(120);
  const zh = ZH_BODY.repeat(500);
  const text = en + zh + EN_BODY.repeat(60);
  const headOnly = detectDocLanguage(text.slice(0, 13000), { sampleSize: 13000 });
  assert.equal(headOnly.lang, 'other', '前提：只读开头确实是英文');
  const r = detectDocLanguage(text);
  assert.ok(r.sampled <= 40000 + 10, `采样长度应受控，实际 ${r.sampled}`);
  assert.equal(r.lang, 'zh', `中段的中文不能被采样漏掉（median=${r.ratio}, windows=${r.windows}）`);
});

test('拦截规则：只有「正文中文 + 目标中文」才跳过整篇翻译', () => {
  const zh = { docLang: 'zh' };
  assert.equal(shouldSkipFullTranslate(zh, 'zh'), true);
  assert.equal(shouldSkipFullTranslate(zh, 'zh-tw'), true);
  assert.equal(shouldSkipFullTranslate(zh, 'en'), false, '中文翻英文是真需求，不能拦');
  assert.equal(shouldSkipFullTranslate({ docLang: 'other' }, 'zh'), false);
  assert.equal(shouldSkipFullTranslate({ docLang: 'unknown' }, 'zh'), false);
  assert.equal(shouldSkipFullTranslate(null, 'zh'), false);
  assert.equal(shouldSkipFullTranslate(zh, undefined), true, '目标语言默认是中文');
});

// ---------- HTTP：接口与拦截真的生效 ----------
test('GET /language：已有 docLang 直接返回缓存，不再抽 PDF', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doclang-'));
  const uploadDir = path.join(root, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  store.configure({ dataDir: path.join(root, 'data') });
  store.upsertLiterature({
    id: 'lang-cached', title: '中文文献', fileKind: 'pdf', docType: 'empirical', status: 'done',
    docLang: 'zh', docLangRatio: 0.92,
    // 故意给一个不存在的路径：走缓存就不该去读文件
    filePath: path.join(uploadDir, 'nope.pdf'), filename: 'nope.pdf', originalName: 'nope.pdf',
  });

  const { app } = createApp({ uploadDir });
  const httpServer = createServer(app);
  try {
    const base = await listen(httpServer);
    const r = await (await fetch(`${base}/api/literature/lang-cached/language`, { headers: { Connection: 'close' } })).json();
    assert.equal(r.lang, 'zh');
    assert.equal(r.cached, true);
    assert.equal(r.ratio, 0.92);
  } finally { await close(httpServer); }
});

test('GET /language：没有 docLang 时真读一次 PDF 并写回记录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doclang2-'));
  const uploadDir = path.join(root, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  store.configure({ dataDir: path.join(root, 'data') });

  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 6; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText('This paper studies how platform governance shapes value co-creation.', { x: 40, y: 780, size: 11, font });
    page.drawText('We use survey data and estimate a structural equation model.', { x: 40, y: 760, size: 11, font });
  }
  const fileName = 'english.pdf';
  const filePath = path.join(uploadDir, fileName);
  await writeFile(filePath, Buffer.from(await doc.save()));
  store.upsertLiterature({
    id: 'lang-live', title: 'English paper', fileKind: 'pdf', docType: 'empirical', status: 'done',
    filePath, filename: fileName, originalName: fileName,
  });

  const { app } = createApp({ uploadDir });
  const httpServer = createServer(app);
  try {
    const base = await listen(httpServer);
    const r = await (await fetch(`${base}/api/literature/lang-live/language`, { headers: { Connection: 'close' } })).json();
    assert.equal(r.lang, 'other', `英文 PDF 应判成 other，实际 ${r.lang}`);
    assert.equal(r.cached, false);
    const rec = store.getLiterature('lang-live');
    assert.equal(rec.docLang, 'other', '判定结果要缓存回记录，避免每次都抽一遍 PDF');
  } finally { await close(httpServer); }
});

test('全文翻译接口：中文文献翻中文会被 409 拦下，并带上 skipped 标记', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doclang3-'));
  const uploadDir = path.join(root, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  store.configure({ dataDir: path.join(root, 'data') });

  const fileName = 'zh.pdf';
  const filePath = path.join(uploadDir, fileName);
  await writeFile(filePath, 'x');
  store.upsertLiterature({
    id: 'lang-guard', title: '中文论文', fileKind: 'pdf', docType: 'empirical', status: 'done',
    docLang: 'zh', filePath, filename: fileName, originalName: fileName,
  });

  const { app } = createApp({ uploadDir });
  const httpServer = createServer(app);
  try {
    const base = await listen(httpServer);
    const res = await fetch(`${base}/api/pdf-translate/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ literatureId: 'lang-guard', options: { targetLang: 'zh', mode: 'md' } }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.skipped, true);
    assert.equal(body.reason, 'chinese-doc');
    assert.match(body.error, /中文/);
    // 不该留下任何作业
    const jobs = await (await fetch(`${base}/api/pdf-translate/jobs`, { headers: { Connection: 'close' } })).json();
    assert.equal((jobs || []).filter((j) => j.literatureId === 'lang-guard').length, 0);
  } finally { await close(httpServer); }
});
