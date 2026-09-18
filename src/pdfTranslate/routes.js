// routes.js —— 全文翻译的 HTTP 接口（挂到主 Express 应用上）
//
// 接口一览：
//   GET    /api/pdf-translate/settings      当前默认参数 + 引擎可用性 + 字体状态
//   POST   /api/pdf-translate/settings      保存默认参数
//   POST   /api/pdf-translate               创建作业（文献 id 或上传文件路径）
//   POST   /api/pdf-translate/upload        直接上传一个 PDF 来翻译
//   GET    /api/pdf-translate/jobs          历史 + 进行中的作业
//   GET    /api/pdf-translate/jobs/:id      单个作业状态
//   GET    /api/pdf-translate/jobs/:id/stream   SSE 实时进度
//   POST   /api/pdf-translate/jobs/:id/cancel
//   DELETE /api/pdf-translate/jobs/:id
//   POST   /api/pdf-translate/estimate      只解析不翻译，给出字数/请求数预估
//   POST   /api/pdf-translate/font/download 手动触发中文字体下载
//   POST   /api/pdf-translate/glossary/parse 术语表文本 → 结构化
//   GET    /translations/*                  成品 PDF 静态访问（供预览/下载）
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { PdfTranslateService, TARGET_LANGS, parseGlossary, parsePageRange, DEFAULT_PDF_TRANSLATE_OPTIONS } from './index.js';
import { describeFont, downloadCjkFont, platformFontHint } from './fonts.js';

/** 输出成品下拉项：value 可以是具体模式，也可以是 both / all 这类别名 */
const MODE_CHOICES = [
  { value: 'both', label: '单语译文版 + 双语对照版', hint: '默认：保留原版面，两种对照方式' },
  { value: 'all', label: '重排版 + 单语译文版 + 双语对照版', hint: '三种全出，重排版最适合连续阅读' },
  { value: 'reflow', label: '只要重排版', hint: '丢弃原版面，按阅读顺序重排成 A4 单栏（公式/图表原样保留）' },
  { value: 'mono', label: '只要单语译文版', hint: '保留原版面，原位覆盖成中文' },
  { value: 'dual', label: '只要双语对照版', hint: '左原文右译文，逐段对照精读' },
];

/** 译文观感档位（对应 fontMetrics.INK_TARGET） */
const FONT_WEIGHTS = [
  { value: 'regular', label: '常规', hint: '跟原文粗细接近，最轻' },
  { value: 'medium', label: '偏清晰（推荐）', hint: '比常规略重，小字号下不发灰' },
  { value: 'bold', label: '加粗', hint: '整体加粗，屏幕阅读最清晰' },
];

const FONT_FAMILIES = [
  { value: 'auto', label: '跟随原文（推荐）', hint: '原文正文是衬线体就用宋体系，是无衬线体就用黑体系' },
  { value: 'sans', label: '黑体系（微软雅黑 / 苹方 / Noto Sans）' },
  { value: 'serif', label: '宋体系（宋体 / 宋体-简 / Noto Serif）' },
];

export function registerPdfTranslateRoutes(app, deps) {
  const {
    store, getUploadDir, upload, fixFileName,
    defaultOptions = {},
  } = deps;

  const service = new PdfTranslateService({
    getSettings: () => store.getSettings(),
    getDataDir: () => store.getDataDir(),
    getUploadDir,
  });
  service.maxConcurrent = 1;

  // ---------- 成品文件静态访问 ----------
  app.use('/translations', (req, res, next) => {
    const dir = service.translationsDir();
    if (!fs.existsSync(dir)) { res.status(404).end(); return; }
    express.static(dir, {
      setHeaders: (res2) => {
        res2.setHeader('Content-Type', 'application/pdf');
        // 允许前端 iframe 内联预览
        res2.setHeader('Content-Disposition', 'inline');
      },
    })(req, res, next);
  });

  // ---------- 设置 ----------
  function settingsPayload() {
    const settings = store.getSettings();
    const opts = { ...defaultOptions, ...(settings.pdfTranslate || {}) };
    const llmReady = !!(settings.modelProfiles || []).some((p) => String(p.apiKey || '').trim())
      || !!String(settings.apiKey || '').trim();
    const font = describeFont({
      dataDir: store.getDataDir(),
      explicitPath: opts.fontPath || '',
      bundledDir: path.join(process.cwd(), 'assets', 'fonts'),
      family: opts.fontFamily === 'serif' ? 'serif' : 'sans',
    });
    return {
      options: opts,
      targetLangs: TARGET_LANGS,
      // 输出成品的选择项（含别名 both / all）与每种成品的名字，前端只渲染不下判断
      modes: MODE_CHOICES,
      fontFamilies: FONT_FAMILIES,
      fontWeights: FONT_WEIGHTS,
      limits: { concurrency: { min: 1, max: 16, def: DEFAULT_PDF_TRANSLATE_OPTIONS.concurrency }, fontSize: { min: 0, max: 24 } },
      engine: {
        translateProvider: settings.translateProvider || 'siliconflow',
        llmReady,
        deeplReady: !!String(settings.deeplKey || '').trim(),
        deeplEndpoint: settings.deeplEndpoint || '',
        activeModel: settings.model || '',
        profiles: (settings.modelProfiles || []).map((p) => ({ id: p.id, label: p.label || p.model, model: p.model, hasKey: !!String(p.apiKey || '').trim() })),
      },
      font: { ...font, hint: platformFontHint() },
      cache: { entries: service.cache.size },
    };
  }

  app.get('/api/pdf-translate/settings', (_req, res) => {
    try { res.json(settingsPayload()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/pdf-translate/settings', (req, res) => {
    const cur = store.getSettings();
    const incoming = req.body || {};
    const next = { ...(cur.pdfTranslate || {}) };
    for (const [k, v] of Object.entries(incoming)) {
      if (k === 'glossary' && typeof v === 'string') next.glossary = parseGlossary(v);
      else next[k] = v;
    }
    const saved = store.saveSettings({ ...cur, pdfTranslate: next });
    res.json({ ok: true, options: { ...defaultOptions, ...(saved.pdfTranslate || {}) } });
  });

  // ---------- 术语表解析 ----------
  app.post('/api/pdf-translate/glossary/parse', (req, res) => {
    const terms = parseGlossary(req.body?.text || '');
    res.json({ terms, count: terms.length });
  });

  // ---------- 字体 ----------
  app.post('/api/pdf-translate/font/download', async (_req, res) => {
    try {
      const font = await downloadCjkFont({ dataDir: store.getDataDir() });
      service._fontCache = font;
      res.json({ ok: true, font: describeFont({ dataDir: store.getDataDir() }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 预估 ----------
  app.post('/api/pdf-translate/estimate', async (req, res) => {
    const filePath = resolveSourceFile(req.body, { store, getUploadDir });
    if (filePath.error) return res.status(400).json({ error: filePath.error });
    try {
      const result = await service.estimate({ filePath: filePath.path, options: req.body?.options });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 作业 ----------
  app.get('/api/pdf-translate/jobs', (_req, res) => res.json(service.list()));

  app.get('/api/pdf-translate/jobs/:id', (req, res) => {
    const job = service.get(req.params.id);
    if (!job) return res.status(404).json({ error: '作业不存在' });
    res.json(job);
  });

  app.post('/api/pdf-translate/jobs', (req, res) => {
    const resolved = resolveSourceFile(req.body, { store, getUploadDir });
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    try {
      const job = service.start({
        filePath: resolved.path,
        fileName: resolved.name,
        literatureId: req.body?.literatureId || null,
        options: req.body?.options,
      });
      res.json(job);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const reTranslateUpload = upload ? upload.single('file') : null;
  if (reTranslateUpload) {
    app.post('/api/pdf-translate/upload', reTranslateUpload, (req, res) => {
      if (!req.file) return res.status(400).json({ error: '没有收到文件' });
      const name = fixFileName ? fixFileName(req.file.originalname) : req.file.originalname;
      if (!/\.pdf$/i.test(name)) return res.status(400).json({ error: '只支持 PDF 文件' });
      try {
        const job = service.start({ filePath: req.file.path, fileName: name, options: req.body?.options });
        res.json(job);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  app.post('/api/pdf-translate/jobs/:id/cancel', (req, res) => {
    res.json(service.cancel(req.params.id));
  });

  app.delete('/api/pdf-translate/jobs/:id', (req, res) => {
    res.json(service.remove(req.params.id));
  });

  // ---------- SSE 实时进度 ----------
  app.get('/api/pdf-translate/jobs/:id/stream', (req, res) => {
    const id = req.params.id;
    if (!service.get(id)) return res.status(404).json({ error: '作业不存在' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (_) { /* 客户端已断开 */ }
    };
    send('snapshot', service.get(id));

    const onUpdate = (job) => {
      if (job.id !== id) return;
      send('update', job);
      if (['done', 'failed', 'cancelled'].includes(job.status)) cleanup();
    };
    const heartbeat = setInterval(() => send('ping', { t: Date.now() }), 15000);
    const cleanup = () => {
      clearInterval(heartbeat);
      service.off('update', onUpdate);
      try { res.end(); } catch (_) { /* ignore */ }
    };
    service.on('update', onUpdate);
    req.on('close', cleanup);
  });

  // ---------- 删除成品文件 ----------
  app.delete('/api/pdf-translate/jobs/:id/outputs', (req, res) => {
    const job = service.get(req.params.id);
    if (!job) return res.status(404).json({ error: '作业不存在' });
    const dir = service.jobDir(req.params.id);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return service;
}

/** 把请求里的「文献 id / 文件路径 / fileName」统一解析成本地绝对路径 */
function resolveSourceFile(body, { store, getUploadDir }) {
  const uploadDir = getUploadDir ? getUploadDir() : null;

  if (body?.literatureId) {
    const item = store.listLiterature().find((x) => x.id === body.literatureId);
    if (!item) return { error: '找不到该文献' };
    if (!item.filePath || !fs.existsSync(item.filePath)) return { error: '该文献没有 PDF 附件，或附件已丢失' };
    return { path: item.filePath, name: item.originalName || item.filename || 'paper.pdf' };
  }

  if (body?.fileName) {
    const safe = path.basename(String(body.fileName));
    const full = path.join(uploadDir || '', safe);
    if (!fs.existsSync(full)) return { error: '找不到指定的上传文件：' + safe };
    return { path: full, name: safe };
  }

  if (body?.filePath) {
    const full = path.resolve(String(body.filePath));
    if (!fs.existsSync(full)) return { error: '文件不存在：' + full };
    if (!/\.pdf$/i.test(full)) return { error: '只支持 PDF 文件' };
    return { path: full, name: path.basename(full) };
  }

  return { error: '缺少 literatureId / fileName / filePath' };
}

export { parsePageRange };
