// thesisRoutes.js —— 学位论文阅读的全部 HTTP 接口
//
// 集中在一个模块里注册，server.js 只需要一行 registerThesisRoutes(app, ctx)。
// 这样既不动 server.js 的既有结构，也让这套功能的边界清清楚楚。
//
// 依赖由 ctx 注入（模型调用、SSE、上传目录、文件名修复都是主进程里已有的能力），
// 避免本模块反过来 import server.js 造成循环依赖。

import fs from 'node:fs';
import * as thesisStore from './thesisStore.js';
import * as thesisPdf from './thesisPdf.js';
import * as thesisOutline from './thesisOutline.js';
import * as thesisIndex from './thesisIndex.js';
import * as thesisContext from './thesisContext.js';
import * as thesisFields from './thesisFields.js';

// 索引缓存的指纹：附件换了（文件名或体积变了）就重建
function fingerprintOf(record) {
  return `${record?.filename || ''}:${record?.fileSize || 0}`;
}

function indexPayload(record, built) {
  return {
    version: 2,
    thesisId: record.id,
    fingerprint: fingerprintOf(record),
    builtAt: new Date().toISOString(),
    source: built.source,
    totalPages: built.totalPages,
    outline: Array.isArray(built.outline) ? built.outline : [],
    index: thesisIndex.serializeIndex(built.index),
  };
}

export function registerThesisRoutes(app, ctx) {
  const {
    upload, getUploadDir, fixFileName,
    resolveRequestModel, resolveVisionModel, fetchModelCompletion, streamModelResponse, readLLMResponse,
    sseStart, sseSend, sseEnd,
  } = ctx;

  const modelError = (e) => String(e?.message || '调用模型失败');
  const pickModel = (body) => {
    const picked = resolveRequestModel(body?.profileId);
    if (picked.error) throw Object.assign(new Error(picked.error), { statusCode: 400 });
    return picked.profile;
  };

  /**
   * 确保索引可用：命中缓存直接返回；否则现场构建并落盘。
   * 构建过慢会让「第一次提问」变慢，所以 onStage 会把每一步播报给前端。
   */
  async function ensureIndex(record, { force = false, onStage = null } = {}) {
    const say = (stage, message) => { try { onStage?.(stage, message); } catch (_) { /* ignore */ } };

    if (!record?.filePath) throw new Error('这篇论文还没有上传 PDF');
    if (!fs.existsSync(record.filePath)) throw new Error('PDF 文件已丢失，请重新上传附件');

    const cached = thesisStore.readIndex(record.id);
    if (!force && cached?.index && cached.fingerprint === fingerprintOf(record)) {
      const idx = thesisIndex.deserializeIndex(cached.index);
      if (idx) {
        say('cache', '已命中索引缓存');
        return { index: idx, outline: cached.outline || [], source: cached.source || '', totalPages: cached.totalPages || 0, cached: true };
      }
    }

    say('read', '正在读取 PDF 文本…');
    const pdf = await thesisPdf.readThesisPdf(record.filePath);
    if (!pdf.charCount || pdf.charCount < 200) {
      throw new Error('这篇 PDF 提取不到有效文字（可能是扫描件）。请使用带 OCR 文字层的 PDF 后重试。');
    }

    say('outline', '正在识别章节结构…');
    const outline = thesisOutline.buildOutline({
      pages: pdf.pages, bookmarks: pdf.bookmarks, totalPages: pdf.totalPages,
    });

    say('chunk', `正在分块（共 ${pdf.totalPages} 页）…`);
    const chunks = thesisIndex.chunkPages(pdf.pages, outline.items);

    say('index', `正在建立索引（${chunks.length} 段）…`);
    const index = thesisIndex.buildIndex(chunks);

    const built = { index, outline: outline.items, source: outline.source, totalPages: pdf.totalPages };
    try {
      thesisStore.writeIndex(record.id, indexPayload(record, built));
    } catch (e) {
      // 索引落盘失败不该让问答失败 —— 内存里已经有了，这次照样能回答
      console.error('[thesis] 索引落盘失败：', e.message);
    }
    thesisStore.upsertThesis({
      ...record,
      numPages: pdf.totalPages || record.numPages || 0,
      charCount: pdf.charCount,
      indexStatus: 'ready',
      indexError: '',
      indexedAt: new Date().toISOString(),
      outlineSource: outline.source,
      outlineCount: outline.items.length,
    });
    return { ...built, cached: false };
  }

  // ==================== 论文记录 ====================

  app.get('/api/theses', (_req, res) => {
    // 顺手做一次字段迁移（v1.20.0 把字段砍到 12 列），进程内只扫一次
    try { thesisStore.pruneRemovedFields(); } catch (_) { /* ignore */ }
    const items = thesisStore.listTheses().map((it) => ({
      ...it,
      progress: thesisStore.progressOf(it),
    }));
    res.json({
      items,
      collections: thesisStore.listCollections(),
      summary: thesisStore.summary(),
    });
  });

  // 单条：阅读器在没有列表上下文时（如从素材库直接跳进来）靠它取记录
  app.get('/api/theses/:id', (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    res.json({ ...item, progress: thesisStore.progressOf(item) });
  });

  app.post('/api/theses', (req, res) => {
    const record = thesisStore.blankThesis({
      collectionId: String(req.body?.collectionId || ''),
      title: String(req.body?.title || '').slice(0, 300),
    });
    thesisStore.upsertThesis(record);
    res.json(record);
  });

  app.patch('/api/theses/:id', (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    const patch = { ...(req.body || {}) };
    // 阅读进度是「读过的最大页码」，只许往前推（回退靠用户手改进度标签）
    if (patch.readPage != null) {
      const next = Math.max(0, Math.round(Number(patch.readPage) || 0));
      patch.readPage = Math.max(Number(item.readPage) || 0, next);
      if (patch.lastPage == null) patch.lastPage = Math.round(Number(patch.readPage)) || 1;
    }
    if (patch.lastPage != null) patch.lastPage = Math.max(1, Math.round(Number(patch.lastPage) || 1));
    const updated = thesisStore.patchThesis(req.params.id, patch);
    res.json({ ...updated, progress: thesisStore.progressOf(updated) });
  });

  /** 删论文时把它在阅读器里留下的笔记 / 对话一起清掉，避免留下永远看不到的孤儿数据 */
  function purgeReaderArtifacts(id) {
    try { ctx.store.deletePaperNote?.(id); } catch (_) { /* ignore */ }
    try { ctx.store.deletePaperChat?.(id); } catch (_) { /* ignore */ }
  }

  app.delete('/api/theses/:id', (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (item?.filePath) { try { fs.unlinkSync(item.filePath); } catch (_) { /* ignore */ } }
    purgeReaderArtifacts(req.params.id);
    res.json({ ok: true, removed: thesisStore.deleteThesis(req.params.id) });
  });

  app.post('/api/theses/batch-delete', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let removed = 0;
    for (const id of ids) {
      const item = thesisStore.getThesis(id);
      if (item?.filePath) { try { fs.unlinkSync(item.filePath); } catch (_) { /* ignore */ } }
      purgeReaderArtifacts(id);
      if (thesisStore.deleteThesis(id)) removed += 1;
    }
    res.json({ ok: true, removed });
  });

  /** 批量改分类 / 批量清进度标签 */
  app.post('/api/theses/batch-update', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const patch = req.body?.patch && typeof req.body.patch === 'object' ? req.body.patch : {};
    let updated = 0;
    for (const id of ids) {
      const item = thesisStore.getThesis(id);
      if (!item) continue;
      const next = thesisStore.patchThesis(id, patch);
      if (next) updated += 1;
    }
    res.json({ ok: true, updated });
  });

  // ==================== 附件 ====================

  app.post('/api/theses/:id/attachment', upload.single('file'), (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    const f = req.file;
    if (!f) return res.status(400).json({ error: '未收到 PDF 文件' });
    if (item.filePath) { try { fs.unlinkSync(item.filePath); } catch (_) { /* ignore */ } }
    const updated = {
      ...item,
      originalName: fixFileName(f.originalname),
      filename: f.filename,
      filePath: `${getUploadDir()}/${f.filename}`,
      fileSize: f.size,
      status: 'pending', error: '', source: '', parsedAt: '',
      numPages: 0, charCount: 0, readPage: 0, lastPage: 1,
      indexStatus: 'none', indexError: '', indexedAt: '', outlineSource: '', outlineCount: 0,
    };
    // 换附件意味着「内容变了」，AI 字段要重解析；但用户手写的两个字段必须留住
    for (const key of thesisFields.THESIS_AI_FIELDS) updated[key] = '';
    thesisStore.upsertThesis(updated);
    thesisStore.removeIndex(item.id); // 旧索引作废
    res.json(updated);
  });

  app.delete('/api/theses/:id/attachment', (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    if (item.filePath) { try { fs.unlinkSync(item.filePath); } catch (_) { /* ignore */ } }
    const updated = {
      ...item,
      originalName: '', filename: '', filePath: '', fileSize: 0,
      status: 'pending', error: '', source: '', parsedAt: '',
      numPages: 0, charCount: 0, readPage: 0, lastPage: 1,
      indexStatus: 'none', indexError: '', indexedAt: '', outlineSource: '', outlineCount: 0,
    };
    for (const key of thesisFields.THESIS_AI_FIELDS) updated[key] = '';
    thesisStore.upsertThesis(updated);
    thesisStore.removeIndex(item.id);
    res.json(updated);
  });

  // ==================== AI 解析（读前 3 页填字段） ====================

  /**
   * 解析「书目前提字段」。
   *
   * 两条路：
   *   A. **看图（首选）**：前端把前 3 页渲染成 JPEG 一起传上来，交给视觉模型。
   *      学位论文封面版式极杂（艺术字、竖排、印章、扫描件），纯文本层经常把校名读串行，
   *      甚至整页提不到字；看图最稳。
   *   B. **文本兜底**：没配视觉模型、或视觉调用失败时，只读前 3 页的文本层。
   *
   * 无论走哪条路，都**不再整本提取文本**（那是「解析慢」的根因）。
   */
  async function parseThesis(record, { settings, profileId, pages = null } = {}) {
    const current = record;
    thesisStore.upsertThesis({ ...current, status: 'parsing', error: '' });
    try {
      if (!current.filePath || !fs.existsSync(current.filePath)) throw new Error('还没有上传 PDF 附件');

      // 只读前 3 页：拿到页数/元信息，同时给文本兜底留一份正文
      const head = await thesisPdf.readThesisHead(current.filePath, 3);
      const headText = head.pages.map((p) => p.text).filter(Boolean).join('\n\n').slice(0, 12000);

      const images = (Array.isArray(pages) ? pages : [])
        .filter((p) => p && typeof p.image === 'string' && /^data:image\//.test(p.image))
        .slice(0, 4)
        .map((p) => String(p.image));

      const profile = pickModel({ profileId });
      const prompt = thesisFields.buildThesisParsePrompt(settings?.language === 'zh' ? '简体中文' : 'English');

      // ---- A. 看图 ----
      let raw = '';
      let method = '';
      let usedModel = profile.model;
      const vision = images.length ? resolveVisionModel?.(settings) : null;
      if (vision) {
        try {
          const content = [{ type: 'text', text: `以下依次是这篇学位论文的第 1 页起（共 ${images.length} 页）：` }];
          for (const img of images) content.push({ type: 'image_url', image_url: { url: img } });
          raw = await callOnce(vision, {
            model: vision.model,
            messages: [{ role: 'system', content: prompt }, { role: 'user', content }],
            temperature: 0.1,
            max_tokens: 1200,
          }, settings);
          method = 'vision';
          usedModel = vision.model;
        } catch (e) {
          // 视觉链路失败不该让整次解析失败：退回文本，并如实记下原因
          console.error('[thesis] 视觉解析失败，回退文本：', e.message);
          raw = '';
        }
      }

      // ---- B. 文本兜底 ----
      if (!raw) {
        if (!headText || headText.length < 60) {
          throw new Error('这篇 PDF 提不到有效文字（可能是扫描件）。请到「AI 设置 → 图像能力」为某个视觉模型开启图片支持后重新解析。');
        }
        raw = await callOnce(profile, {
          model: profile.model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: `以下是学位论文前 3 页的文本：\n\n${headText}` },
          ],
          temperature: 0.1,
          max_tokens: 1200,
        }, settings);
        method = 'text';
      }

      const parsed = parseJsonLoose(raw);
      const fields = thesisFields.normalizeThesisFields(parsed);
      // AI 拿不到的学校/学位类型，用规则兜底，不让字段空着
      if (!fields.school) fields.school = thesisFields.guessSchool(headText);
      if (!fields.degreeType) fields.degreeType = thesisFields.guessDegreeType(headText);

      const updated = {
        ...thesisStore.getThesis(current.id),
        ...fields,
        numPages: head.totalPages || current.numPages || 0,
        charCount: head.charCount,
        status: 'done',
        source: method,
        parseModel: usedModel,
        parsedAt: new Date().toISOString(),
        error: '',
      };
      thesisStore.upsertThesis(updated);
      return updated;
    } catch (e) {
      const failed = { ...thesisStore.getThesis(current.id), status: 'error', error: modelError(e) };
      thesisStore.upsertThesis(failed);
      return failed;
    }
  }

  /** 非流式调一次模型，返回文本；失败抛错（不带业务语义） */
  async function callOnce(profile, payload, settings) {
    const request = await fetchModelCompletion(profile, payload, { stream: false, settings });
    try {
      const up = request.up;
      if (!up.ok) {
        const detail = up._litErrorText ?? await up.text().catch(() => '');
        throw new Error(`模型返回 ${up.status}：${String(detail).slice(0, 300)}`);
      }
      return (await readLLMResponse(up)).full;
    } finally {
      request.cancel?.();
      request.abort?.();
    }
  }

  function parseJsonLoose(str) {
    let s = String(str || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(s); } catch (_) { /* 继续尝试 */ }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { /* 放弃 */ }
    }
    throw new Error('模型返回的内容无法解析为 JSON，请换一个模型再试');
  }

  app.post('/api/theses/:id/parse', async (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    try {
      const settings = ctx.store.getSettings();
      res.json(await parseThesis(item, {
        settings,
        profileId: req.body?.profileId,
        pages: req.body?.pages,
      }));
    } catch (e) {
      res.status(400).json({ error: modelError(e) });
    }
  });

  app.post('/api/theses/batch-parse', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const settings = ctx.store.getSettings();
    const limit = Math.max(1, Math.min(4, parseInt(req.body?.concurrency, 10) || 2));
    const queue = ids.map((id) => thesisStore.getThesis(id)).filter(Boolean);
    const results = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (cursor < queue.length) {
        const i = cursor++;
        results[i] = await parseThesis(queue[i], { settings, profileId: req.body?.profileId });
      }
    }));
    res.json({
      results: results.map((r) => ({ id: r.id, title: r.title, status: r.status, error: r.error })),
    });
  });

  // ==================== 章节索引 ====================

  /** 建索引（SSE 播报进度）；已缓存时立即返回 */
  app.post('/api/theses/:id/index', async (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    sseStart(res);
    try {
      const built = await ensureIndex(item, {
        force: req.body?.force === true,
        onStage: (stage, message) => sseSend(res, { stage, message }),
      });
      sseSend(res, {
        done: true,
        cached: built.cached,
        source: built.source,
        totalPages: built.totalPages,
        chapters: built.outline.length,
        chunks: built.index.chunks.length,
      });
    } catch (e) {
      thesisStore.upsertThesis({ ...item, indexStatus: 'error', indexError: modelError(e) });
      sseSend(res, { error: modelError(e) });
    }
    sseEnd(res);
  });

  app.get('/api/theses/:id/outline', async (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    const cached = thesisStore.readIndex(item.id);
    const fresh = cached?.fingerprint === fingerprintOf(item) ? cached : null;
    // 缓存文件可能是旧版本写的（结构不全），这里一律兜住，不让书签栏因为脏缓存整块挂掉
    const freshItems = Array.isArray(fresh?.outline) ? fresh.outline : [];
    if (req.query?.build === '1' && !freshItems.length) {
      try {
        const built = await ensureIndex(item);
        return res.json({
          id: item.id, ready: true, source: built.source, totalPages: built.totalPages,
          items: built.outline, tree: thesisOutline.toTree(built.outline),
        });
      } catch (e) {
        return res.status(400).json({ error: modelError(e), ready: false });
      }
    }
    res.json({
      id: item.id,
      ready: freshItems.length > 0,
      source: fresh?.source || item.outlineSource || '',
      totalPages: fresh?.totalPages || item.numPages || 0,
      items: freshItems,
      tree: thesisOutline.toTree(freshItems),
    });
  });

  /** 按页取文本（笔记模式、素材摘录用） */
  app.get('/api/theses/:id/pages', (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    const cached = thesisStore.readIndex(item.id);
    if (!cached?.index) return res.status(409).json({ error: '索引尚未建立，请先建立章节索引' });
    const idx = thesisIndex.deserializeIndex(cached.index);
    const from = Math.max(1, parseInt(req.query?.from, 10) || 1);
    const to = Math.max(from, parseInt(req.query?.to, 10) || from + 1);
    const pages = idx.chunks
      .filter((c) => c.page >= from && c.page <= to)
      .map((c) => ({ page: c.page, chapterTitle: c.chapterTitle, text: c.text }));
    res.json({ from, to, pages, totalPages: cached.totalPages || item.numPages || 0 });
  });

  // ==================== 检索增强问答 ====================

  app.post('/api/theses/:id/chat', async (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: '请输入你的问题' });
    if (query.length > 4000) return res.status(400).json({ error: '问题太长，请精简后再提问' });

    const settings = ctx.store.getSettings();
    sseStart(res);

    let profile;
    try { profile = pickModel(req.body); } catch (e) { sseSend(res, { error: modelError(e) }); return sseEnd(res); }

    try {
      const built = await ensureIndex(item, {
        onStage: (stage, message) => sseSend(res, { stage: 'index', stageName: stage, message }),
      });
      const history = Array.isArray(req.body?.history) ? req.body.history : [];
      const assembled = thesisContext.assembleChatMessages({
        record: thesisStore.getThesis(item.id) || item,
        outline: built.outline,
        index: built.index,
        query,
        currentPage: Number(req.body?.page) || item.lastPage || 1,
        history,
        budgetChars: req.body?.budget,
        attachSection: req.body?.attachSection !== false,
        bigPaper: thesisStore.getBigPaper(),
        settings,
      });
      sseSend(res, { stats: assembled.stats });
      const r = await streamModelResponse(profile, {
        model: profile.model,
        messages: assembled.messages,
        temperature: 0.3,
        max_tokens: 4096,
      }, res, { settings });
      if (!r.full && !r.aborted) sseSend(res, { error: 'AI 未返回有效内容。请到 AI 设置中重新测试此模型，或改用「仅非流式」兼容模式。' });
    } catch (e) {
      sseSend(res, { error: modelError(e) });
    }
    sseEnd(res);
  });

  /** 章节速读 / 综述条目 / 答辩问答演练 */
  app.post('/api/theses/:id/summarize', async (req, res) => {
    const item = thesisStore.getThesis(req.params.id);
    if (!item) return res.status(404).json({ error: '论文不存在' });
    const task = String(req.body?.task || '').trim();
    if (!thesisContext.TASK_LABELS[task]) return res.status(400).json({ error: '未知的生成任务' });

    const settings = ctx.store.getSettings();
    sseStart(res);
    let profile;
    try { profile = pickModel(req.body); } catch (e) { sseSend(res, { error: modelError(e) }); return sseEnd(res); }

    try {
      const built = await ensureIndex(item, {
        onStage: (stage, message) => sseSend(res, { stage: 'index', stageName: stage, message }),
      });
      const { system, user } = thesisContext.buildTaskPrompt(task, {
        record: thesisStore.getThesis(item.id) || item,
        outline: built.outline,
        index: built.index,
        chapterId: String(req.body?.chapterId || ''),
        currentPage: Number(req.body?.page) || item.lastPage || 1,
        bigPaper: thesisStore.getBigPaper(),
        settings,
      });
      sseSend(res, { task, label: thesisContext.TASK_LABELS[task] });
      const r = await streamModelResponse(profile, {
        model: profile.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.4,
        max_tokens: 4096,
      }, res, { settings });
      if (!r.full && !r.aborted) sseSend(res, { error: 'AI 未返回有效内容，请换一个模型再试。' });
    } catch (e) {
      sseSend(res, { error: modelError(e) });
    }
    sseEnd(res);
  });

  /** 对比阅读：2–5 篇 → 对比表 */
  app.post('/api/theses/compare', async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).slice(0, 5);
    if (ids.length < 2) return res.status(400).json({ error: '请至少选择 2 篇论文' });
    const records = ids.map((id) => thesisStore.getThesis(id)).filter(Boolean);
    if (records.length < 2) return res.status(400).json({ error: '选中的论文不存在' });

    const settings = ctx.store.getSettings();
    sseStart(res);
    let profile;
    try { profile = pickModel(req.body); } catch (e) { sseSend(res, { error: modelError(e) }); return sseEnd(res); }

    try {
      sseSend(res, { titles: records.map((r) => r.title || r.originalName || '未命名') });
      const { system, user } = thesisContext.buildCompareMessages(records, {
        lang: settings?.language === 'zh' ? '简体中文' : 'English',
      });
      const r = await streamModelResponse(profile, {
        model: profile.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.3,
        max_tokens: 4096,
      }, res, { settings });
      if (!r.full && !r.aborted) sseSend(res, { error: 'AI 未返回有效内容，请换一个模型再试。' });
    } catch (e) {
      sseSend(res, { error: modelError(e) });
    }
    sseEnd(res);
  });

  // ==================== 分类 ====================

  app.get('/api/thesis-collections', (_req, res) => res.json(thesisStore.listCollections()));

  app.post('/api/thesis-collections', (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: '分类名不能为空' });
    if (thesisStore.listCollections().some((c) => c.name === name)) {
      return res.status(400).json({ error: '已存在同名分类' });
    }
    const record = { id: ctx.store.newId(), name, color: String(req.body?.color || '').slice(0, 20) };
    thesisStore.upsertCollection(record);
    res.json(record);
  });

  app.patch('/api/thesis-collections/:id', (req, res) => {
    const list = thesisStore.listCollections();
    const item = list.find((c) => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: '分类不存在' });
    const name = String(req.body?.name || item.name).trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: '分类名不能为空' });
    const updated = { ...item, ...(req.body?.name ? { name } : {}), ...(req.body?.color != null ? { color: String(req.body.color).slice(0, 20) } : {}) };
    thesisStore.upsertCollection(updated);
    res.json(updated);
  });

  app.delete('/api/thesis-collections/:id', (req, res) => {
    res.json({ ok: true, removed: thesisStore.deleteCollection(req.params.id) });
  });

  // ==================== 摘录素材库 ====================

  app.get('/api/thesis-quotes', (req, res) => {
    let items = thesisStore.listQuotes();
    const thesisId = String(req.query?.thesisId || '');
    if (thesisId) items = items.filter((q) => q.thesisId === thesisId);
    res.json(items);
  });

  app.post('/api/thesis-quotes', (req, res) => {
    const body = req.body || {};
    const text = String(body.text || '').trim();
    if (!text) return res.status(400).json({ error: '摘录内容不能为空' });
    const thesis = thesisStore.getThesis(body.thesisId);
    const quote = {
      id: ctx.store.newId(),
      thesisId: String(body.thesisId || ''),
      thesisTitle: thesis?.title || thesis?.originalName || String(body.thesisTitle || ''),
      chapterTitle: String(body.chapterTitle || '').slice(0, 200),
      page: Math.max(0, Math.round(Number(body.page) || 0)),
      text: text.slice(0, 20000),
      note: String(body.note || '').slice(0, 2000),
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 10).map((t) => String(t).slice(0, 30)) : [],
      source: String(body.source || 'manual').slice(0, 20),
    };
    res.json(thesisStore.upsertQuote(quote));
  });

  app.patch('/api/thesis-quotes/:id', (req, res) => {
    const list = thesisStore.listQuotes();
    const item = list.find((q) => q.id === req.params.id);
    if (!item) return res.status(404).json({ error: '摘录不存在' });
    const patch = {};
    if (req.body?.note != null) patch.note = String(req.body.note).slice(0, 2000);
    if (Array.isArray(req.body?.tags)) patch.tags = req.body.tags.slice(0, 10).map((t) => String(t).slice(0, 30));
    res.json(thesisStore.upsertQuote({ ...item, ...patch }));
  });

  app.delete('/api/thesis-quotes/:id', (req, res) => {
    res.json({ ok: true, removed: thesisStore.deleteQuote(req.params.id) });
  });

  /** 导出素材库为 Markdown（按论文分组，带出处） */
  app.get('/api/thesis-quotes/export', (_req, res) => {
    const all = thesisStore.listQuotes();
    const groups = new Map();
    for (const q of all) {
      const key = q.thesisTitle || q.thesisId || '未命名';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(q);
    }
    const lines = ['# 学位论文摘录素材库', '', `导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
    for (const [title, list] of groups) {
      lines.push(`## ${title}`, '');
      for (const q of list) {
        const where = [q.chapterTitle, q.page ? `p.${q.page}` : ''].filter(Boolean).join(' · ');
        lines.push(`> ${q.text.replace(/\n+/g, ' ').trim()}`, '');
        if (where) lines.push(`—— ${where}`, '');
        if (q.note) lines.push(`我的批注：${q.note}`, '');
        if (Array.isArray(q.tags) && q.tags.length) lines.push(`标签：${q.tags.join('、')}`, '');
      }
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="thesis-quotes.md"');
    res.send(lines.join('\n'));
  });

  // ==================== 关联的大论文 ====================

  app.get('/api/thesis-bigpaper', (_req, res) => res.json(thesisStore.getBigPaper()));
  app.put('/api/thesis-bigpaper', (req, res) => res.json(thesisStore.saveBigPaper(req.body || {})));

  // ==================== 看板统计 ====================

  app.get('/api/thesis-summary', (_req, res) => res.json(thesisStore.summary()));
}
