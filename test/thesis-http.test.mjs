// thesis-http.test.mjs —— 学位论文的 HTTP 级集成测试（真实 PDF + 真实链路 + mock 上游）
//
// 单测覆盖纯函数；这里验证「真 PDF 能不能被读成按页文本、目录页能不能被识别、
// 建索引的 SSE 流程、以及问答时送进模型的上下文里到底有什么」——
// 也就是长上下文方案在真实链路上是否成立。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';
import { readThesisPdf } from '../src/thesisPdf.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function close(server) {
  // 先掐掉 keep-alive 连接，否则 close() 会枯等到超时（历史上吃过这个亏）
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

function mockUpstream(handler) {
  return createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
    handler(body, res);
  });
}

function sseFrames(body) {
  return String(body).split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((p) => p && p !== '[DONE]')
    .map((p) => { try { return JSON.parse(p); } catch (_) { return null; } })
    .filter(Boolean);
}

const sseText = (body) => sseFrames(body).map((f) => f.delta || '').join('');
const firstError = (body) => (sseFrames(body).find((f) => f.error)?.error) || '';

// 12 页的英文 PDF：第 1 页是目录页，其余每页一句有区分度的内容。
// 用英文是因为 pdf-lib 的标准字体不含中文；中文章节识别已由 thesis-outline 的单测覆盖。
const PAGE_TEXTS = [
  'Contents\nChapter 1 Introduction ....... 3\nChapter 2 Literature Review ....... 4\nChapter 3 Research Design ....... 6\nChapter 4 Results ....... 8\nChapter 5 Conclusion ....... 10',
  'Abstract. This dissertation investigates the relationship between short video immersion and purchase intention in emerging markets.',
  'Introduction. The research question asks how immersion shapes purchase intention among young consumers.',
  'Literature Review. The theory of planned behavior is adopted as the theoretical framework of this study.',
  'Perceived value theory emphasizes the tradeoff between perceived benefits and perceived costs.',
  'Research Design. A questionnaire survey was administered and 520 valid responses were collected.',
  'The measurement items adopt a seven point Likert scale adapted from prior validated instruments.',
  'Results. Structural equation modeling with AMOS was used to estimate the proposed research model.',
  'The empirical results show that immersion significantly improves purchase intention.',
  'Conclusion. Theoretical contributions and practical implications for platform managers are discussed.',
  'Limitations include the single country sample and the cross sectional research design.',
  'References. Ackermann, J. (2020). Digital marketing revisited. Journal of Marketing Research.',
];

async function makePdf(pageTexts) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage([595, 842]);
    page.drawText(text, { x: 40, y: 780, size: 11, font, lineHeight: 16, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

test('读取真 PDF：能得到按页文本与总页数（章节索引的基础）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'thesis-pdf-'));
  try {
    const buf = await makePdf(PAGE_TEXTS);
    const { writeFile } = await import('node:fs/promises');
    const file = path.join(root, 'sample.pdf');
    await writeFile(file, buf);

    const pdf = await readThesisPdf(file);
    assert.equal(pdf.totalPages, 12);
    assert.equal(pdf.pages.length, 12);
    assert.ok(pdf.charCount > 500);
    assert.match(pdf.pages[0].text, /Contents/);
    assert.match(pdf.pages[7].text, /Structural equation modeling/);
    assert.match(pdf.pages[4].text, /Perceived value theory/);
    // 每页都要有自己的文本，不能整本挤在第一页
    assert.equal(pdf.pages.filter((p) => p.text.length > 20).length, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('学位论文全链路：上传 → 解析 → 建索引 → 书签栏 → 检索增强问答 → 对比阅读', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'thesis-http-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');

  const upstreamBodies = [];
  const upstream = mockUpstream((body, res) => {
    upstreamBodies.push(body);
    // 「读前 3 页抽字段」是非流式的 JSON 调用，用提示词特征区分
    if (JSON.stringify(body).includes('信息提取助手')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              title: '短视频沉浸体验对购买意愿的影响研究',
              authors: '张三', school: '某某大学', degreeType: '硕士', year: '2024',
              major: '企业管理', supervisor: '李四',
              keywords: '短视频；沉浸体验；购买意愿',
              abstractPoints: '- 检验沉浸体验对购买意愿的作用\n- 引入感知价值作为中介',
              summary: '本文以短视频平台为对象，检验沉浸体验影响购买意愿的机制。',
              researchQuestion: '- 沉浸体验是否提升购买意愿',
              theory: '计划行为理论', method: '问卷调查', dataSource: '520 份有效问卷',
              conclusion: '- 沉浸体验显著提升购买意愿',
              innovation: '- 引入感知价值中介',
              limitation: '单国样本', value: '可用于我的第四章',
              structure: '- 第一章 绪论\n- 第二章 文献综述',
              dataOpen: '未公开', suggestedRating: '4', ratingReason: '设计规范，样本量充足',
            }),
          },
        }],
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '依据【第三章 研究设计 · p.8】的回答。' } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });

  let appServer;
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
        streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no',
        createdAt: new Date().toISOString(),
      }],
      modelRouter: { enabled: true, failover: true, queue: [], breaker: { failThreshold: 3, openSeconds: 60 } },
    });

    const { app } = createApp({ uploadDir });
    appServer = createServer(app);
    const base = await listen(appServer);
    const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
    const post = (p, body) => fetch(base + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body || {}),
    });
    const patch = (p, body) => fetch(base + p, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body || {}),
    });
    const get = (p) => fetch(base + p, { headers: { Connection: 'close' } });

    // ---------- ① 新建 + 上传 PDF ----------
    const rec = await json(await post('/api/theses', { title: '' }));
    assert.ok(rec.id);

    const fd = new FormData();
    fd.append('file', new Blob([await makePdf(PAGE_TEXTS)], { type: 'application/pdf' }), 'thesis.pdf');
    const uploaded = await json(await fetch(`${base}/api/theses/${rec.id}/attachment`, { method: 'POST', body: fd }));
    assert.equal(uploaded.originalName, 'thesis.pdf');
    assert.equal(uploaded.numPages, 0, '上传时还没解析，页数待索引阶段补上');

    // ---------- ② AI 读前 3 页填字段 ----------
    const parsed = await json(await post(`/api/theses/${rec.id}/parse`, {}));
    assert.equal(parsed.status, 'done', 'parse 应成功：' + parsed.error);
    assert.equal(parsed.title, '短视频沉浸体验对购买意愿的影响研究');
    assert.equal(parsed.school, '某某大学');
    assert.equal(parsed.degreeType, '硕士');
    assert.equal(parsed.suggestedRating, '4');
    assert.equal(parsed.numPages, 12, '解析时会顺便读到页数');

    // 用户手写的两个字段必须原样保留（AI 绝不覆盖）
    const withUser = await json(await patch(`/api/theses/${rec.id}`, { myThoughts: '这个中介模型可以用', referenceValue: '高', rating: '5' }));
    assert.equal(withUser.myThoughts, '这个中介模型可以用');
    assert.equal(withUser.referenceValue, '高');
    assert.equal(withUser.rating, '5');
    // 再解析一次，用户字段不能被抹掉
    const reparsed = await json(await post(`/api/theses/${rec.id}/parse`, {}));
    assert.equal(reparsed.myThoughts, '这个中介模型可以用');
    assert.equal(reparsed.referenceValue, '高');

    // ---------- ③ 建索引（SSE，带进度） ----------
    const indexRes = await post(`/api/theses/${rec.id}/index`, {});
    const indexFrames = sseFrames(await indexRes.text());
    const done = indexFrames.find((f) => f.done);
    assert.ok(done, '建索引必须有一个 done 帧');
    assert.equal(done.totalPages, 12);
    assert.ok(done.chunks >= 12, '每页至少一块');
    assert.ok(done.chapters >= 5, '目录页能解析出 5 章');
    assert.equal(done.source, 'toc', '有目录页时应该用目录页作为章节来源');

    // ---------- ④ 书签栏 ----------
    const outline = await json(await get(`/api/theses/${rec.id}/outline`));
    assert.equal(outline.ready, true);
    assert.equal(outline.source, 'toc');
    assert.ok(outline.items.length >= 5);
    assert.match(outline.items[0].title, /Chapter 1/);
    assert.equal(outline.items[0].page, 3);
    assert.equal(outline.tree.length >= 1, true);

    // 点名的章节能定位到正确页码
    const forth = outline.items.find((x) => /Chapter 4/.test(x.title));
    assert.ok(forth);
    assert.equal(forth.page, 8);

    // ---------- ⑤ 阅读位置与进度（自动） ----------
    const progressed = await json(await patch(`/api/theses/${rec.id}`, { readPage: 8, lastPage: 8 }));
    assert.equal(progressed.progress.readPage, 8);
    assert.equal(progressed.progress.percent, 67);
    assert.equal(progressed.progress.label, '阅读中');
    // 往回改不应把进度拉低（进度是「读过的最大页码」）
    const back = await json(await patch(`/api/theses/${rec.id}`, { readPage: 3 }));
    assert.equal(back.progress.readPage, 8);

    // ---------- ⑥ 检索增强问答 ----------
    const before = upstreamBodies.length;
    const chatBody = await (await post(`/api/theses/${rec.id}/chat`, {
      query: 'structural equation modeling 是用什么软件估计的？',
      page: 8,
      budget: 20000,
      history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好，请问想了解这篇论文的什么？' }],
    })).text();
    assert.equal(firstError(chatBody), '');
    assert.match(sseText(chatBody), /p\.8/);

    const stats = sseFrames(chatBody).find((f) => f.stats)?.stats;
    assert.ok(stats, '要回报本次上下文用量');
    assert.ok(stats.hitCount > 0);
    assert.ok(stats.hitPages.includes(8), '应该检索到第 8 页：' + JSON.stringify(stats.hitPages));
    assert.equal(stats.budgetChars, 20000);
    assert.ok(stats.usedChars > 0 && stats.usedChars <= 20000, '用量不能超预算');

    // 真正送给模型的东西：system 里要有引用规则与章节目录，user 里要有命中的原文
    const sent = upstreamBodies[before];
    const system = String(sent.messages[0].content);
    const userMsg = String(sent.messages[sent.messages.length - 1].content);
    assert.match(system, /【章节标题 · p\.页码】/);
    assert.match(system, /【章节目录（带页码）】/);
    assert.match(system, /Chapter 1 Introduction/);
    assert.match(system, /短视频沉浸体验对购买意愿的影响研究/, '档案卡要带上已解析的字段');
    assert.match(userMsg, /Structural equation modeling with AMOS/, '命中的原文要真的送进去');
    assert.match(userMsg, /【我的问题】/);
    assert.match(userMsg, /第 8 页/, '要告诉模型用户读到哪');
    assert.equal(sent.messages.length >= 4, true, 'system + 历史 + 本次提问');

    // 素材库不在模型上下文里（用户手写字段不进提示词）
    assert.equal(userMsg.includes('这个中介模型可以用'), false);
    assert.equal(system.includes('这个中介模型可以用'), false);

    // ---------- ⑦ 章节速读 / 答辩题 ----------
    for (const task of ['chapter-digest', 'defense']) {
      const body = await (await post(`/api/theses/${rec.id}/summarize`, { task, chapterId: forth.id })).text();
      assert.equal(firstError(body), '', task);
      assert.match(sseText(body), /p\.8/);
    }
    const badTask = await post(`/api/theses/${rec.id}/summarize`, { task: '不存在的任务' });
    assert.equal(badTask.status, 400);

    // ---------- ⑧ 关联的大论文 ----------
    await fetch(`${base}/api/thesis-bigpaper`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ title: '我的大论文', stage: '第三章 研究设计', framework: '1 绪论\n2 综述' }),
    });
    const before2 = upstreamBodies.length;
    await (await post(`/api/theses/${rec.id}/chat`, { query: '这章的方法能不能用在我的第四章？', page: 8 })).text();
    const sent2 = String(upstreamBodies[before2].messages[0].content);
    assert.match(sent2, /【用户的大论文情况】/);
    assert.match(sent2, /第三章 研究设计/, '关联的大论文阶段要带进上下文');

    // ---------- ⑨ 对比阅读 ----------
    const rec2 = await json(await post('/api/theses', { title: '第二篇学位论文' }));
    await json(await patch(`/api/theses/${rec2.id}`, { theory: '资源基础观', method: '案例研究' }));
    const cmpBody = await (await post('/api/theses/compare', { ids: [rec.id, rec2.id] })).text();
    assert.equal(firstError(cmpBody), '');
    const titles = sseFrames(cmpBody).find((f) => f.titles)?.titles;
    assert.equal(titles.length, 2);
    assert.match(sseText(cmpBody), /p\.8/);
    assert.equal((await post('/api/theses/compare', { ids: [rec.id] })).status, 400, '少于 2 篇要拒绝');

    // ---------- ⑩ 素材库 ----------
    const quote = await json(await post('/api/thesis-quotes', {
      thesisId: rec.id, text: 'The empirical results show that immersion significantly improves purchase intention.',
      page: 9, chapterTitle: 'Chapter 4 Results', tags: ['购买意愿'],
    }));
    assert.equal(quote.thesisTitle, '短视频沉浸体验对购买意愿的影响研究');
    const md = await (await get('/api/thesis-quotes/export')).text();
    assert.match(md, /# 学位论文摘录素材库/);
    assert.match(md, /Chapter 4 Results · p\.9/);

    // ---------- ⑪ 分类 ----------
    const col = await json(await post('/api/thesis-collections', { name: '消费者行为' }));
    await json(await patch(`/api/theses/${rec.id}`, { collectionId: col.id }));
    const dup = await post('/api/thesis-collections', { name: '消费者行为' });
    assert.equal(dup.status, 400, '重名分类要拒绝');
    const listed = await json(await get('/api/theses'));
    assert.equal(listed.items.find((x) => x.id === rec.id).collectionId, col.id);
    assert.equal(listed.collections.length, 1);

    // ---------- ⑫ 单条读取、书签与阅读位置 ----------
    // 阅读器在没有列表上下文时（例如从素材库直接跳进来）靠单条接口取记录
    const one = await json(await get(`/api/theses/${rec.id}`));
    assert.equal(one.title, '短视频沉浸体验对购买意愿的影响研究');
    assert.equal((await get('/api/theses/根本没有这条')).status, 404);

    const bm = await json(await patch(`/api/theses/${rec.id}`, {
      bookmarks: [{ id: 'b1', page: 7, note: '方法这一节' }],
      readPage: 7, lastPage: 7,
    }));
    assert.equal(bm.bookmarks.length, 1, '书签要能存下来（白名单漏了它就会静默丢弃）');
    assert.equal(bm.bookmarks[0].note, '方法这一节');
    assert.equal(bm.lastPage, 7);
    const peakRead = Number(bm.readPage) || 0;
    // lastPage = 下次打开停在哪（可回退）；readPage = 读过的最大页（只许前进）
    const posBack = await json(await patch(`/api/theses/${rec.id}`, { readPage: 2, lastPage: 2 }));
    assert.equal(posBack.lastPage, 2, 'lastPage 允许回退，否则「回到上次位置」会被顶住');
    assert.equal(posBack.readPage, peakRead, 'readPage 不许倒退，否则阅读进度会缩水');

    // 阅读器写下的笔记 / 对话按论文 id 存，与文献中心共用同一套存储（零迁移）
    await fetch(`${base}/api/paper-notes/${rec.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ md: '# 我的笔记\n\n这一章很重要' }),
    });
    await fetch(`${base}/api/paper-chat/${rec.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '这篇的方法是什么' }] }),
    });
    assert.match((await json(await get(`/api/paper-notes/${rec.id}`))).md, /这一章很重要/);
    assert.equal((await json(await get(`/api/paper-chat/${rec.id}`))).messages.length, 1);

    // ---------- ⑬ 删除论文：连带清索引、素材摘录与阅读器留下的笔记/对话 ----------
    await json(await fetch(`${base}/api/theses/${rec.id}`, { method: 'DELETE', headers: { Connection: 'close' } }));
    const quotesLeft = await json(await get('/api/thesis-quotes'));
    assert.equal(quotesLeft.length, 0, '删论文要连带清掉它的摘录，不留孤儿引用');
    const afterRes = await get(`/api/theses/${rec.id}/outline`);
    assert.equal(afterRes.status, 404, '论文已删除，书签栏接口要如实返回 404');
    assert.equal(existsSync(path.join(dataDir, 'thesis-index', `${rec.id}.json`)), false, '索引缓存要一起清掉');
    assert.equal((await json(await get(`/api/paper-notes/${rec.id}`))).md, '', '笔记要一起清掉，不留孤儿数据');
    assert.equal((await json(await get(`/api/paper-chat/${rec.id}`))).messages.length, 0, '对话同理');
    assert.equal((await json(await get('/api/thesis-summary'))).total, 1, '只剩第二篇');
  } finally {
    if (appServer) await close(appServer);
    await close(upstream);
    await rm(root, { recursive: true, force: true });
  }
});
