// achievementRoutes.js —— 科研成果管理（科研人员自己的成果）的全部 HTTP 接口
//
// 与学位论文阅读同样集中在一个模块里注册：server.js 只需 registerAchievementRoutes(app, ctx)，
// 既不动既有结构，也让功能边界清清楚楚。
//
// 依赖由 ctx 注入（上传目录、文件名修复、模型调用、SSE、系统打开文件的能力），
// 避免本模块 import server.js 造成循环依赖。

import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import mammoth from 'mammoth';

import * as achievementStore from './achievementStore.js';
import {
  CATEGORIES, CATEGORY_KEYS, COLUMNS, DETAIL_GROUPS, FIELD_LABELS, FILE_KINDS,
  PROGRESS_STATUSES, STAGE_LABELS, ALL_TEXT_FIELDS,
  appHintFor, extOf, isPreviewable,
  buildParsePrompt, buildSearchReportPrompt, normalizeFields, sanitizeYear, sanitizePercent,
} from './achievementFields.js';
import { extractPdfText } from './pdfParser.js';
import { extractByRules } from './ruleExtractor.js';
import { createZip, uniqueName, sanitizeZipName } from './zip.js';

/** 一次解析最多喂给模型多少字符（文献中心同样量级，够抽出书目与要点） */
const MAX_PARSE_CHARS = 20000;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').slice(0, 10));
}

function text(v, max = 60000) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).filter(Boolean).join(', ').slice(0, max);
  if (typeof v === 'object') return '';
  return String(v).slice(0, max);
}

/** 安全文件名：去掉路径分隔符与 Windows 非法字符（导出时用） */
function safeStem(name, fallback = '未命名') {
  const raw = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (raw || fallback).slice(0, 80);
}

export function registerAchievementRoutes(app, ctx) {
  const {
    store, getUploadDir, fixFileName,
    openPath, openWith, revealFile,
    resolveRequestModel, fetchModelCompletion, readLLMResponse,
  } = ctx;

  // 成果附件允许**任意格式**（纸质证明的扫描件、代码、数据、压缩包都得能放进来），
  // 所以这里不复用那个「只收 PDF」的 upload，而是自己建一个 storage。
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, getUploadDir()),
    filename: (_req, file, cb) => {
      const fixed = fixFileName(file.originalname);
      const safe = fixed.replace(/[\\/:*?"<>|\s]+/g, '_').slice(-90) || 'file';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
    },
  });
  const uploadAny = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

  const view = (record) => (record ? achievementStore.publicRecord(record) : record);
  const modelError = (e) => String(e?.message || '调用模型失败');

  // ==================== 元信息（前端与本模块共用一份字段定义） ====================

  app.get('/api/achievements/meta', (_req, res) => {
    res.json({
      categories: CATEGORIES,
      stageLabels: STAGE_LABELS,
      fileKinds: FILE_KINDS,
      columns: COLUMNS,
      detailGroups: DETAIL_GROUPS,
      fieldLabels: FIELD_LABELS,
      progressStatuses: PROGRESS_STATUSES,
      defaultFolder: { id: achievementStore.DEFAULT_FOLDER_ID, name: achievementStore.DEFAULT_FOLDER_NAME },
      editableFields: [...ALL_TEXT_FIELDS],
    });
  });

  // ==================== 记录 ====================

  app.get('/api/achievements', (_req, res) => {
    res.json({
      items: achievementStore.listAchievements().map(view),
      folders: achievementStore.listFoldersWithDefault(),
      summary: achievementStore.summary(),
    });
  });

  // 导出元数据（CSV / JSON）—— 必须放在 /api/achievements/:id **之前**！
  // Express 是按注册顺序匹配的，放在后面的话 "export" 会被当成一个成果 id，
  // 结果永远 404。下面这个顺序就是被这个坑咬过一次之后定下来的。
  app.get('/api/achievements/export', (req, res) => {
    const category = CATEGORY_KEYS.includes(req.query?.category) ? req.query.category : '';
    let items = achievementStore.listAchievements();
    if (category) items = items.filter((it) => it.category === category);
    if (req.query?.format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="achievements.json"');
      return res.send(JSON.stringify(items.map(view), null, 2));
    }
    const csv = exportRows(items).map((r) => r.map(csvEscape).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="achievements.csv"');
    res.send('\uFEFF' + csv);
  });

  app.get('/api/achievements/:id', (req, res) => {
    const item = achievementStore.getAchievement(req.params.id);
    if (!item) return res.status(404).json({ error: '成果不存在' });
    res.json(view(item));
  });

  app.post('/api/achievements', (req, res) => {
    const folderId = text(req.body?.folderId, 60).trim();
    if (folderId && !achievementStore.listFolders().some((f) => f.id === folderId)) {
      return res.status(400).json({ error: '目标文件夹不存在，可能已被删除' });
    }
    const record = achievementStore.blankAchievement({
      category: CATEGORY_KEYS.includes(req.body?.category) ? req.body.category : 'paper',
      stage: req.body?.stage === 'working' ? 'working' : 'done',
      // 没指定文件夹 → 落在「数据文件夹」，不会出现「新建完找不到」的记录
      folderId: folderId || achievementStore.DEFAULT_FOLDER_ID,
      title: text(req.body?.title, 300),
    });
    res.json(view(achievementStore.upsertAchievement(record)));
  });

  app.patch('/api/achievements/:id', (req, res) => {
    const item = achievementStore.getAchievement(req.params.id);
    if (!item) return res.status(404).json({ error: '成果不存在' });
    const body = { ...(req.body || {}) };
    // 阶段是枚举，别让前端塞进别的东西
    if ('stage' in body) body.stage = body.stage === 'working' ? 'working' : 'done';
    if ('year' in body) body.year = sanitizeYear(body.year);
    if ('progressStatus' in body && body.progressStatus && !PROGRESS_STATUSES.includes(body.progressStatus)) {
      return res.status(400).json({ error: '进度状态不在允许的取值范围内' });
    }
    if ('folderId' in body) {
      const fid = text(body.folderId, 60).trim();
      if (fid && !achievementStore.listFolders().some((f) => f.id === fid)) {
        return res.status(400).json({ error: '目标文件夹不存在，可能已被删除' });
      }
      body.folderId = fid;
    }
    const updated = achievementStore.patchAchievement(req.params.id, body);
    if (!updated) return res.status(404).json({ error: '成果不存在' });
    res.json(view(updated));
  });

  app.delete('/api/achievements/:id', (req, res) => {
    const out = achievementStore.deleteAchievement(req.params.id);
    for (const p of out.files) { try { fs.unlinkSync(p); } catch (_) { /* 文件可能已被手动删除 */ } }
    res.json({ ok: true, removed: out.removed });
  });

  app.post('/api/achievements/batch-delete', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let removed = 0;
    for (const id of ids) {
      const out = achievementStore.deleteAchievement(id);
      for (const p of out.files) { try { fs.unlinkSync(p); } catch (_) { /* ignore */ } }
      if (out.removed) removed += 1;
    }
    res.json({ ok: true, removed });
  });

  /** 批量改文件夹 / 批量改阶段 */
  app.post('/api/achievements/batch-update', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const patch = {};
    if ('folderId' in (req.body || {})) {
      const fid = text(req.body.folderId, 60).trim();
      if (fid && !achievementStore.listFolders().some((f) => f.id === fid)) {
        return res.status(400).json({ error: '目标文件夹不存在，可能已被删除' });
      }
      patch.folderId = fid;
    }
    if (req.body?.stage !== undefined) patch.stage = req.body.stage === 'working' ? 'working' : 'done';
    let updated = 0;
    for (const id of ids) {
      if (achievementStore.patchAchievement(id, patch)) updated += 1;
    }
    res.json({ ok: true, updated });
  });

  // ==================== 文件夹 ====================

  app.get('/api/achievement-folders', (_req, res) => res.json(achievementStore.listFoldersWithDefault()));

  app.post('/api/achievement-folders', (req, res) => {
    const name = text(req.body?.name, 60).trim();
    if (!name) return res.status(400).json({ error: '文件夹名不能为空' });
    if (name === achievementStore.DEFAULT_FOLDER_NAME) {
      return res.status(400).json({ error: `「${achievementStore.DEFAULT_FOLDER_NAME}」是系统默认文件夹，不需要新建` });
    }
    if (achievementStore.listFolders().some((f) => f.name === name)) {
      return res.status(400).json({ error: '已存在同名文件夹' });
    }
    const record = achievementStore.upsertFolder({ id: store.newId(), name, color: text(req.body?.color, 20) });
    res.json(record);
  });

  app.patch('/api/achievement-folders/:id', (req, res) => {
    const id = text(req.params.id, 60).trim();
    const item = achievementStore.listFolders().find((f) => f.id === id);
    if (!item) return res.status(404).json({ error: '文件夹不存在' });
    const name = text(req.body?.name, 60).trim();
    if (!name) return res.status(400).json({ error: '文件夹名不能为空' });
    if (name === achievementStore.DEFAULT_FOLDER_NAME) {
      return res.status(400).json({ error: `「${achievementStore.DEFAULT_FOLDER_NAME}」是系统默认文件夹，不能重名` });
    }
    if (achievementStore.listFolders().some((f) => f.id !== id && f.name === name)) {
      return res.status(400).json({ error: '已存在同名文件夹' });
    }
    res.json(achievementStore.upsertFolder({ ...item, name }));
  });

  app.delete('/api/achievement-folders/:id', (req, res) => {
    res.json({ ok: true, removed: achievementStore.deleteFolder(req.params.id) });
  });

  // ==================== 附件 ====================

  app.post('/api/achievements/:id/files', uploadAny.single('file'), (req, res) => {
    const item = achievementStore.getAchievement(req.params.id);
    if (!item) return res.status(404).json({ error: '成果不存在' });
    const f = req.file;
    if (!f) return res.status(400).json({ error: '未收到文件' });
    const originalName = fixFileName(f.originalname);
    const kind = FILE_KINDS.some((k) => k.key === req.body?.kind) ? req.body.kind : 'other';
    const updated = achievementStore.addFile(item.id, {
      id: store.newId(),
      kind,
      originalName,
      filename: f.filename,
      filePath: path.join(getUploadDir(), f.filename),
      fileSize: f.size,
      ext: extOf(originalName),
      appHint: appHintFor(originalName),
      addedAt: new Date().toISOString(),
    });
    res.json(view(updated));
  });

  app.delete('/api/achievements/:id/files/:fileId', (req, res) => {
    const out = achievementStore.removeFile(req.params.id, req.params.fileId);
    if (!out) return res.status(404).json({ error: '附件不存在' });
    try { fs.unlinkSync(out.removed.filePath); } catch (_) { /* 物理文件可能已不在 */ }
    res.json(view(out.record));
  });

  /** 取附件（内部用，顺便把「文件是否还在」检查掉） */
  function locate(req, res) {
    const found = achievementStore.findFile(req.params.id, req.params.fileId);
    if (!found) { res.status(404).json({ error: '附件不存在' }); return null; }
    const p = found.file.filePath;
    if (!p || !fs.existsSync(p)) {
      res.status(410).json({ error: '附件文件已丢失（可能被移动或删除），请重新上传' });
      return null;
    }
    return found;
  }

  /** 下载 / 导出单个附件（导出这些文件的最小单元） */
  app.get('/api/achievements/:id/files/:fileId/download', (req, res) => {
    const found = locate(req, res);
    if (!found) return;
    const { file } = found;
    const name = file.originalName || file.filename;
    res.setHeader('Content-Type', 'application/octet-stream');
    // 中文名要走 RFC 5987，否则部分浏览器会把文件名截成乱码
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeStem(name))}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.sendFile(path.resolve(file.filePath));
  });

  /** 在线预览（PDF / 图片 / 文本），点文件名时用 */
  app.get('/api/achievements/:id/files/:fileId/raw', (req, res) => {
    const found = locate(req, res);
    if (!found) return;
    res.sendFile(path.resolve(found.file.filePath));
  });

  /**
   * 打开附件。三种方式：
   *   mode=default（默认）→ 交给系统关联程序（docx→Word、pptx→PowerPoint、xlsx→Excel…）
   *   mode=pick           → 弹出「选择程序」，用户自己在电脑上挑一个程序打开（代码文件常用）
   *   mode=folder         → 在文件管理器里定位到这个文件
   * 桌面版由 Electron 注入能力；纯浏览器运行时返回明确提示 + 下载地址，而不是静默失败。
   */
  app.post('/api/achievements/:id/files/:fileId/open', async (req, res) => {
    const found = locate(req, res);
    if (!found) return;
    const { file } = found;
    const mode = ['pick', 'folder'].includes(req.body?.mode) ? req.body.mode : 'default';
    const downloadUrl = `/api/achievements/${encodeURIComponent(req.params.id)}/files/${encodeURIComponent(file.id)}/download`;
    const notSupported = (what) => res.status(409).json({
      error: `当前运行方式不支持${what}，请改用「下载」再用本地程序打开`,
      fallback: 'download', url: downloadUrl, previewable: isPreviewable(file.originalName),
    });

    if (mode === 'folder') {
      if (typeof revealFile !== 'function' && typeof openPath !== 'function') return notSupported('定位文件');
      try {
        if (typeof revealFile === 'function') { revealFile(file.filePath); return res.json({ ok: true, mode }); }
        const err = await openPath(path.dirname(file.filePath));
        if (err) return res.status(500).json({ error: `无法打开所在文件夹：${err}`, fallback: 'download', url: downloadUrl });
        return res.json({ ok: true, mode });
      } catch (e) {
        return res.status(500).json({ error: `无法打开所在文件夹：${modelError(e)}` });
      }
    }

    if (mode === 'pick') {
      if (typeof openWith !== 'function') return notSupported('选择程序打开');
      try {
        const out = await openWith(file.filePath);
        if (out?.canceled) return res.json({ ok: false, canceled: true });
        return res.json({ ok: true, mode, app: out?.app || '' });
      } catch (e) {
        return res.status(500).json({ error: `用所选程序打开失败：${modelError(e)}` });
      }
    }

    if (typeof openPath !== 'function') return notSupported('直接用系统程序打开');
    try {
      // Electron 的 shell.openPath 成功时 resolve('')，失败时 resolve(错误说明)
      const err = await openPath(file.filePath);
      if (err) {
        return res.status(500).json({
          error: `系统没有能打开该文件的程序（${err}）。可以试试「用其它程序打开」或先下载`,
          fallback: 'download', url: downloadUrl, canPick: typeof openWith === 'function',
        });
      }
      return res.json({ ok: true, mode, app: file.appHint || '' });
    } catch (e) {
      return res.status(500).json({ error: `打开失败：${modelError(e)}`, fallback: 'download', url: downloadUrl });
    }
  });

  // ==================== 字段识别（已出版发行的成果 / 检索报告） ====================

  /** PDF → 文本；DOCX → 文本（检索报告经常是 Word） */
  async function readAttachmentText(file) {
    const ext = extOf(file.originalName || file.filename);
    if (ext === 'docx') {
      const parsed = await mammoth.extractRawText({ path: file.filePath });
      const out = String(parsed.value || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (out.length < 40) throw new Error('无法从该 DOCX 提取有效文本，请确认不是空文档或受保护文档');
      return { text: out, numPages: 0, info: {} };
    }
    if (ext === 'pdf') return extractPdfText(file.filePath);
    throw new Error('字段识别只支持 PDF 或 DOCX；其它格式请手动填写，或先用其它程序另存为 PDF 再上传');
  }

  function pickParseTarget(item, source) {
    const files = item.files || [];
    if (source === 'searchReport') {
      return files.find((f) => f.kind === 'searchReport') || null;
    }
    return files.find((f) => f.kind === 'main')
      || files.find((f) => ['pdf', 'docx'].includes(extOf(f.originalName)))
      || files[0] || null;
  }

  /** 非流式调一次模型，返回文本；失败抛错（由调用方决定是否退规则解析） */
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
    const s = String(str || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(s); } catch (_) { /* 继续尝试 */ }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { /* 放弃 */ }
    }
    throw new Error('模型返回的内容无法解析为 JSON，请换一个模型再试');
  }

  async function parseAchievement(record, { settings, profileId, source = 'main' } = {}) {
    achievementStore.upsertAchievement({ ...record, status: 'parsing', error: '' });
    try {
      const target = pickParseTarget(record, source);
      if (!target) {
        throw new Error(source === 'searchReport'
          ? '还没有上传检索报告（PDF / DOCX），请先在附件区上传'
          : '还没有上传可识别的正文文件（PDF / DOCX）');
      }
      const { text: raw, info } = await readAttachmentText(target);
      const body = raw.slice(0, MAX_PARSE_CHARS);
      const lang = settings?.language === 'zh' ? '简体中文' : 'English';

      let fields = null;
      let method = '';
      let usedModel = '';
      const isReport = source === 'searchReport';
      try {
        const picked = resolveRequestModel?.(profileId);
        if (picked?.error) throw new Error(picked.error);
        const profile = picked.profile;
        const system = isReport ? buildSearchReportPrompt(lang) : buildParsePrompt(lang, record.category);
        const out = await callOnce(profile, {
          model: profile.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `${isReport ? '检索报告' : '成果全文'}内容如下：\n\n${body}` },
          ],
          temperature: 0.1,
          max_tokens: 2000,
        }, settings);
        fields = normalizeFields(parseJsonLoose(out));
        method = isReport ? 'ai-report' : 'ai';
        usedModel = profile.model;
      } catch (e) {
        // 没配 AI / 模型报错时退到规则解析 —— 文献中心也是这么兜底的，
        // 至少把标题、作者、年份、DOI、摘要抓出来，用户少填几个框
        console.error('[achievements] AI 识别失败，改用规则解析：', e.message);
        const ruled = normalizeFields(extractByRules(body, info || {}));
        if (!Object.values(ruled).some(Boolean)) throw e;
        fields = ruled;
        method = 'rule';
        usedModel = '';
      }

      // 只覆盖「有值」的字段：用户已经手填过的内容不被空值抹掉。
      // 另外把「结构/控制类」字段挡在外面 —— 模型幻觉出 folderId/tags 会把记录改乱。
      const BLOCKED = new Set(['folderId', 'tags', 'progressStatus', 'progressPercent', 'isDraft', 'stage']);
      const merged = {};
      for (const [k, v] of Object.entries(fields || {})) {
        if (BLOCKED.has(k)) continue;
        if (String(v || '').trim()) merged[k] = v;
      }
      if (!String(merged.title || '').trim()) {
        merged.title = record.title || safeStem(target.originalName, '未命名成果');
      }
      const updated = {
        ...achievementStore.getAchievement(record.id),
        ...merged,
        status: 'done',
        source: method,
        parseModel: usedModel,
        parsedAt: new Date().toISOString(),
        error: '',
      };
      achievementStore.upsertAchievement(updated);
      return { ...view(achievementStore.getAchievement(record.id)), fields: merged };
    } catch (e) {
      achievementStore.upsertAchievement({ ...achievementStore.getAchievement(record.id), status: 'error', error: modelError(e) });
      throw e;
    }
  }

  app.post('/api/achievements/:id/parse', async (req, res) => {
    const item = achievementStore.getAchievement(req.params.id);
    if (!item) return res.status(404).json({ error: '成果不存在' });
    try {
      const result = await parseAchievement(item, {
        settings: store.getSettings(),
        profileId: req.body?.profileId,
        source: req.body?.source === 'searchReport' ? 'searchReport' : 'main',
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: modelError(e) });
    }
  });

  /** 批量识别：并发 2，避免打爆限流 */
  app.post('/api/achievements/batch-parse', async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).slice(0, 200);
    const settings = store.getSettings();
    const queue = ids.map((id) => achievementStore.getAchievement(id)).filter(Boolean);
    const results = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (cursor < queue.length) {
        const i = cursor++;
        try {
          await parseAchievement(queue[i], { settings, profileId: req.body?.profileId });
          results[i] = { id: queue[i].id, status: 'done' };
        } catch (e) {
          results[i] = { id: queue[i].id, status: 'error', error: modelError(e) };
        }
      }
    });
    await Promise.all(workers);
    res.json({ results });
  });

  // ==================== 在投进度 / 草稿 ====================

  /** 推进度：写一条进度历史（同状态同说明不重复记，避免连点两下写两条） */
  app.post('/api/achievements/:id/progress', (req, res) => {
    const item = achievementStore.getAchievement(req.params.id);
    if (!item) return res.status(404).json({ error: '成果不存在' });
    const body = req.body || {};
    const status = PROGRESS_STATUSES.includes(body.status) ? body.status : item.progressStatus || '撰写中';
    const date = isDate(body.date) ? String(body.date).slice(0, 10) : todayIso();
    const note = text(body.note, 500);
    const history = [...(item.progressHistory || [])];
    const last = history[history.length - 1];
    if (!last || last.status !== status || (note && last.note !== note)) {
      history.push({ date, status, note });
    }
    const patch = {
      progressStatus: status,
      progressHistory: history.slice(-200),
      stage: 'working',
      isDraft: false,
    };
    if (note) patch.progressNote = note;
    if (isDate(body.submitDate)) patch.submitDate = String(body.submitDate).slice(0, 10);
    if (isDate(body.revisionDeadline)) patch.revisionDeadline = String(body.revisionDeadline).slice(0, 10);
    if (body.percent !== undefined && body.percent !== '') {
      patch.progressPercent = sanitizePercent(body.percent);
    }
    const updated = achievementStore.upsertAchievement({ ...item, ...patch });
    res.json(view(updated));
  });

  /** 保存草稿：字段没填完也先落盘，草稿会有明确标记，不会被误当成已定稿 */
  app.post('/api/achievements/:id/draft', (req, res) => {
    const item = achievementStore.getAchievement(req.params.id);
    if (!item) return res.status(404).json({ error: '成果不存在' });
    const body = { ...(req.body || {}) };
    delete body.patch;
    const patch = { ...(req.body?.patch || {}), ...body, isDraft: req.body?.isDraft !== false };
    if ('stage' in patch) patch.stage = patch.stage === 'working' ? 'working' : 'done';
    const updated = achievementStore.patchAchievement(item.id, patch);
    res.json(view(updated || item));
  });

  // ==================== 与「论文进度」集成 ====================

  /**
   * 把这条在投论文同步到「论文进度」（小论文 · 投稿管理）。
   * 已经同步过的记录再同步就是原地更新，不会在论文进度里堆出一串重复卡片。
   */
  app.post('/api/achievements/:id/sync-paper', (req, res) => {
    const item = achievementStore.getAchievement(req.params.id);
    if (!item) return res.status(404).json({ error: '成果不存在' });
    const now = new Date().toISOString();
    const status = PROGRESS_STATUSES.includes(item.progressStatus) ? item.progressStatus
      : (item.stage === 'done' ? '已见刊' : '撰写中');
    const list = (store.listPapers() || []).slice();
    let paper = item.paperId ? list.find((p) => p.id === item.paperId) : null;

    if (!paper) {
      paper = {
        id: store.newId(),
        kind: 'journal',
        title: item.title || '未命名成果论文',
        createdAt: now,
        updatedAt: now,
        journal: item.journal || '',
        rank: null,
        status,
        submitDate: isDate(item.submitDate) ? item.submitDate : '',
        revisionDeadline: isDate(item.revisionDeadline) ? item.revisionDeadline : '',
        projectId: null,
        backupJournals: '',
        notes: text(item.collectionNote, 2000),
        reviewTranslation: '',
        history: [{ status, date: isDate(item.submitDate) ? item.submitDate : todayIso(), note: '由「成果管理」同步创建' }],
        fromAchievement: item.id,
      };
      list.unshift(paper);
    } else {
      const history = Array.isArray(paper.history) ? paper.history.slice() : [];
      const last = history[history.length - 1];
      if (!last || last.status !== status) {
        history.push({ status, date: todayIso(), note: '由「成果管理」同步更新' });
      }
      paper = {
        ...paper,
        title: item.title || paper.title,
        journal: item.journal || paper.journal,
        status,
        submitDate: isDate(item.submitDate) ? item.submitDate : paper.submitDate,
        revisionDeadline: isDate(item.revisionDeadline) ? item.revisionDeadline : paper.revisionDeadline,
        notes: item.collectionNote || paper.notes,
        updatedAt: now,
        history: history.slice(-200),
        fromAchievement: item.id,
      };
      const idx = list.findIndex((p) => p.id === paper.id);
      list[idx] = paper;
    }

    store.savePapers(list);
    const updated = achievementStore.upsertAchievement({ ...item, paperId: paper.id, syncedAt: now });
    res.json({ ok: true, paper, achievement: view(updated) });
  });

  // ==================== 导出 ====================

  function exportRows(items) {
    const rows = [['类型', '名称', '阶段', '文件夹', '作者 / 完成人', '期刊 / 出版社', '年份',
      '卷', '期', '页码', 'DOI', '专利号', '证书编号', '项目编号', '当前进度', '附件数', '更新时间']];
    const folderName = (id) => (id
      ? (achievementStore.listFolders().find((f) => f.id === id)?.name || '未分类')
      : achievementStore.DEFAULT_FOLDER_NAME);
    const catLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label || key;
    for (const it of items) {
      rows.push([
        catLabel(it.category), it.title, it.stage === 'working' ? '进行中' : '已完成', folderName(it.folderId),
        it.authors, it.journal || it.publisher, it.year, it.volume, it.issue, it.pages, it.doi,
        it.patentNo, it.certNo, it.projectNo, it.progressStatus, String((it.files || []).length), it.updatedAt,
      ].map((v) => String(v ?? '')));
    }
    return rows;
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /**
   * 导出成果「连同附件」为一个 ZIP（用户说的「导出这些文件」）。
   * 每条成果一个文件夹：正文、检索报告、证明材料…都按原文件名放进去，附 meta.json 与清单.csv。
   * （纯元数据的 CSV/JSON 导出注册在文件上方，原因见那里的注释。）
   */
  app.post('/api/achievements/export-zip', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    const all = achievementStore.listAchievements();
    const items = ids.length ? all.filter((it) => ids.includes(it.id)) : all;
    if (!items.length) return res.status(400).json({ error: '没有可导出的成果' });

    const entries = [];
    const usedTop = new Set();
    const catLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label || key;
    const kindLabel = (key) => FILE_KINDS.find((k) => k.key === key)?.label || '附件';
    let missing = 0;

    for (const it of items) {
      const stem = sanitizeZipName(`${catLabel(it.category)}_${safeStem(it.title, '未命名成果')}`);
      const dir = uniqueName(stem, usedTop);
      const meta = { ...it, files: (it.files || []).map(({ filePath: _p, ...rest }) => rest) };
      delete meta.filePath;
      entries.push({ name: `${dir}/meta.json`, data: Buffer.from(JSON.stringify(meta, null, 2), 'utf8') });
      const used = new Set();
      for (const f of it.files || []) {
        if (!f.filePath || !fs.existsSync(f.filePath)) { missing += 1; continue; }
        const name = uniqueName(`${kindLabel(f.kind)}_${f.originalName || f.filename}`, used);
        try {
          entries.push({ name: `${dir}/${name}`, data: fs.readFileSync(f.filePath) });
        } catch (_) { missing += 1; }
      }
    }
    entries.push({ name: '成果清单.csv', data: Buffer.from('\uFEFF' + exportRows(items).map((r) => r.map(csvEscape).join(',')).join('\r\n'), 'utf8') });
    if (missing) {
      entries.push({ name: '导出说明.txt', data: Buffer.from(`有 ${missing} 个附件在磁盘上已不存在，未能打包。\n`, 'utf8') });
    }

    const zip = createZip(entries);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="achievements-${todayIso()}.zip"; filename*=UTF-8''${encodeURIComponent(`科研成果导出-${todayIso()}.zip`)}`);
    res.send(zip);
  });

  // SSE 暂未使用：解析是一次性返回的。保留注入位，后续要做「解析进度播报」时不必改 server.js。
}
