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
import { readThesisPdf, readThesisHead } from '../src/thesisPdf.js';

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

test('readThesisHead 只读前 n 页，但仍然给出总页数（解析提速的关键）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'thesis-head-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const file = path.join(root, 'sample.pdf');
    await writeFile(file, await makePdf(PAGE_TEXTS));

    const head = await readThesisHead(file, 3);
    assert.equal(head.pages.length, 3, '只要前 3 页的正文');
    assert.equal(head.totalPages, 12, '总页数必须照样准确（表格里的「N 页」要用）');
    assert.match(head.pages[0].text, /Contents/);
    // 第 4 页以后的内容不该出现在结果里 —— 不整本提取文本正是提速的来源
    assert.equal(head.pages.some((p) => /Structural equation modeling/.test(p.text)), false);
    // 只读 3 页 → 字符数远小于整本
    const full = await readThesisPdf(file);
    assert.ok(head.charCount < full.charCount, '前 3 页的字符数必然小于整本');

    const one = await readThesisHead(file, 1);
    assert.equal(one.pages.length, 1);
    assert.equal(one.totalPages, 12);
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
    // 「读封面抽字段」是非流式的 JSON 调用，用提示词特征区分。
    // 走视觉链路时 messages 里会有 image_url，走文本兜底时没有 —— 两条路都返回同一份 JSON。
    const raw = JSON.stringify(body);
    if (raw.includes('信息提取助手')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              title: '《短视频沉浸体验对购买意愿的影响研究》',
              authors: '作者：张三',
              // 故意带上封面页眉，验证后端会把「硕士学位论文」这类后缀剥掉
              school: '某某大学硕士学位论文',
              degreeType: '硕士研究生',
              year: '2024年',
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
      visionProfileId: 'p2',
      modelProfiles: [
        {
          id: 'p1', label: '模拟文本供应商', provider: 'custom',
          baseURL: `${upstreamBase}/v1/chat/completions`, apiKey: '', model: 'mock-model',
          streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no',
          createdAt: new Date().toISOString(),
        },
        {
          // 视觉模型：resolveVisionModel 要求「填了 Key + 被判定支持图片」，
          // 所以这里必须给 apiKey（authMode 是 none，值本身不会被校验）
          id: 'p2', label: '模拟视觉供应商', provider: 'custom',
          baseURL: `${upstreamBase}/v1/chat/completions`, apiKey: 'test-key', model: 'mock-vision',
          streamMode: 'auto', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'yes',
          createdAt: new Date().toISOString(),
        },
      ],
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

    // ---------- ② AI 读封面填字段 ----------
    // 2a）不带图片 → 走「文本前 3 页」兜底
    const textOnly = await json(await post(`/api/theses/${rec.id}/parse`, {}));
    assert.equal(textOnly.status, 'done', '文本兜底解析应成功：' + textOnly.error);
    assert.equal(textOnly.source, 'text', '没传图片时应该走文本路径');
    assert.equal(textOnly.numPages, 12, '解析时会顺便读到总页数');
    // 归一化：书名号、字段名前缀、「硕士学位论文」页眉、「2024年」都要被收拾干净
    assert.equal(textOnly.title, '短视频沉浸体验对购买意愿的影响研究');
    assert.equal(textOnly.authors, '张三');
    assert.equal(textOnly.school, '某某大学');
    assert.equal(textOnly.degreeType, '硕士');
    assert.equal(textOnly.year, '2024');

    // 2b）带图片 → 优先走视觉模型，且请求体里必须真的有 image_url
    const before2a = upstreamBodies.length;
    const parsed = await json(await post(`/api/theses/${rec.id}/parse`, {
      pages: [
        { page: 1, image: 'data:image/jpeg;base64,/9j/AAAA' },
        { page: 2, image: 'data:image/jpeg;base64,/9j/BBBB' },
      ],
    }));
    assert.equal(parsed.status, 'done', '视觉解析应成功：' + parsed.error);
    assert.equal(parsed.source, 'vision', '配了视觉模型且传了图片，就该走看图');
    assert.equal(parsed.parseModel, 'mock-vision', '要用视觉模型，而不是普通文本模型');
    const visionSent = upstreamBodies.slice(before2a).find((b) => JSON.stringify(b).includes('信息提取助手'));
    assert.ok(visionSent, '要真的发出解析请求');
    const parts = visionSent.messages[1].content;
    assert.ok(Array.isArray(parts), '视觉请求的 user content 应该是数组（OpenAI 多模态格式）');
    const imgParts = parts.filter((p) => p.type === 'image_url');
    assert.equal(imgParts.length, 2, '两张页面图都要带上');
    assert.ok(imgParts[0].image_url.url.startsWith('data:image/jpeg;base64,'), '图片要用 dataURL 直接内嵌');
    assert.ok(parts.some((p) => p.type === 'text'), '除图片外还要有一段文字说明页码顺序');

    // 2c）脏图片（不是 data:image 前缀）应被忽略而不是让解析炸掉 —— 前端截图失败时会退化成文本路径
    const junk = await json(await post(`/api/theses/${rec.id}/parse`, { pages: [{ page: 1, image: 'oops' }] }));
    assert.equal(junk.status, 'done', '脏图片应被忽略而不是报错');
    assert.equal(junk.source, 'text', '图片全被忽略后只能走文本兜底');

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
    await json(await patch(`/api/theses/${rec2.id}`, { school: '另一所大学', degreeType: '博士' }));
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
