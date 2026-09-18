// index.js —— 全文翻译作业编排：解析 → 翻译 → 渲染 → 落盘
//
// 对外只暴露一个 PdfTranslateService：它管理作业队列（同时只跑一个，避免把用户的
// API 配额打爆）、维护进度事件、把历史记录写进数据目录，并把成品文件放到
// <数据目录>/translations/<jobId>/ 下供前端预览与下载。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { analyzePdf } from './analyze.js';
import { renderTranslatedPdf } from './render.js';
import { renderReflowPdf } from './reflow.js';
import {
  createEngine, translateSegments, TranslationCache, parseGlossary, TARGET_LANGS, targetLangInfo,
} from './engines.js';
import { resolveCjkFont, downloadCjkFont, describeFont, defaultBundledFontDir, platformFontHint } from './fonts.js';
import { toUint8Array } from './util.js';

export { TARGET_LANGS, parseGlossary, describeFont, downloadCjkFont, platformFontHint };

const MAX_LOGS = 400;
const HISTORY_LIMIT = 60;

export const DEFAULT_PDF_TRANSLATE_OPTIONS = {
  engine: 'auto',          // auto(跟随划词设置) | llm | deepl
  profileId: '',           // 指定用哪条模型配置（空 = 当前激活）
  targetLang: 'zh',
  sourceLang: 'auto',
  mode: 'both',            // mono | dual | reflow | both(单语+双语) | all(三种全出)
  pageRange: '',           // 例如 "1-5,8,12-"；空 = 全部
  concurrency: 8,          // 并发上限（自适应池从这里的一半以下起步，顺利就逐步逼近这个值）
  requestTimeoutMs: 300000, // 单次接口请求超时（毫秒）。挂死的连接不能拖住整条并发波次
  batchChars: 2600,
  batchItems: 12,
  temperature: 0.2,
  keepFormulas: true,
  keepTables: true,
  translateReferences: false,
  glossary: [],            // [{source,target}]
  extraRules: '',
  minFontScale: 0.62,
  lineHeightRatio: 1.26,
  widthFill: 0.985,
  fontPath: '',
  // ---- 译文观感 ----
  fontWeight: 'medium',    // regular(常规) | medium(偏清晰，默认) | bold(加粗)
  fontFamily: 'auto',      // auto(跟随原文正文衬线与否) | sans | serif
  fontSize: 0,             // 0 = 跟随原文字号；>0 = 全篇统一到该 pt
  respectBold: true,       // 原文加粗处（标题/强调）自动用更重的档位
  // ---- 重排模式 ----
  reflowKeepFigures: true, // 公式/表格/插图裁下来贴到重排文档里
  reflowIndent: true,      // 正文段落首行缩进两字
};

/** 解析页码范围："1-5,8,12-" → [1,2,3,4,5,8,12..total] */
export function parsePageRange(range, totalPages) {
  const s = String(range || '').trim();
  if (!s) return null;
  const out = new Set();
  for (const part of s.split(/[,，;；\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)?\s*[-–~]\s*(\d+)?$/);
    if (m) {
      const from = m[1] ? Number(m[1]) : 1;
      const to = m[2] ? Number(m[2]) : totalPages;
      for (let i = Math.max(1, from); i <= Math.min(totalPages, to); i++) out.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= totalPages) out.add(n);
    }
  }
  const list = [...out].sort((a, b) => a - b);
  return list.length ? list : null;
}

function safeStem(name, fallback = 'paper') {
  const stem = String(name || '')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 90);
  return stem || fallback;
}

function normalizeOptions(raw, settings) {
  const base = { ...DEFAULT_PDF_TRANSLATE_OPTIONS, ...(settings?.pdfTranslate || {}) };
  const merged = { ...base };
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === undefined || v === null || v === '') continue;
    merged[k] = v;
  }
  merged.concurrency = Math.max(1, Math.min(16, Number(merged.concurrency) || 8));
  merged.requestTimeoutMs = Math.max(0, Math.min(900000, Number(merged.requestTimeoutMs) || 300000));
  merged.batchChars = Math.max(400, Math.min(8000, Number(merged.batchChars) || 2600));
  merged.batchItems = Math.max(1, Math.min(40, Number(merged.batchItems) || 12));
  merged.minFontScale = Math.max(0.4, Math.min(1, Number(merged.minFontScale) || 0.62));
  merged.lineHeightRatio = Math.max(1.02, Math.min(1.8, Number(merged.lineHeightRatio) || 1.26));
  merged.widthFill = Math.max(0.8, Math.min(1.1, Number(merged.widthFill) || 0.985));
  merged.fontSize = Math.max(0, Math.min(24, Number(merged.fontSize) || 0));
  if (!Array.isArray(merged.glossary)) merged.glossary = parseGlossary(merged.glossary);
  if (!MODES.includes(merged.mode)) merged.mode = 'both';
  if (!['auto', 'llm', 'deepl'].includes(merged.engine)) merged.engine = 'auto';
  if (!['regular', 'medium', 'bold'].includes(merged.fontWeight)) merged.fontWeight = 'medium';
  if (!['auto', 'sans', 'serif'].includes(merged.fontFamily)) merged.fontFamily = 'auto';
  if (!TARGET_LANGS.some((t) => t.id === merged.targetLang)) merged.targetLang = 'zh';
  return merged;
}

/** 输出模式 → 实际要渲染的成品列表（别名统一在这里展开，别处只认具体模式） */
export const MODES = ['mono', 'dual', 'reflow', 'both', 'all'];

export function resolveModes(mode) {
  switch (mode) {
    case 'mono': case 'dual': case 'reflow': return [mode];
    case 'all': return ['reflow', 'mono', 'dual'];
    case 'both':
    default: return ['mono', 'dual'];
  }
}

/** 成品类型 → 文件名后缀与中文名 */
export const OUTPUT_META = {
  mono: { suffix: '-译文', label: '单语译文版', desc: '保留原版面，原位覆盖成中文' },
  dual: { suffix: '-对照', label: '双语对照版', desc: '左原文右译文，逐段对照精读' },
  reflow: { suffix: '-重排', label: '重排版', desc: '丢弃原版面，按阅读顺序重排成 A4 单栏' },
};

export class PdfTranslateService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {() => object} deps.getSettings
   * @param {() => string} deps.getDataDir
   * @param {() => string} [deps.getUploadDir]
   */
  constructor(deps) {
    super();
    this.deps = deps;
    this.jobs = new Map();
    this.running = new Set();
    this.maxConcurrent = 1;
    this.cache = new TranslationCache(path.join(deps.getDataDir(), 'pdf-translate-cache.json'));
    this._fontCache = null;
  }

  // ---------- 目录 ----------

  translationsDir() {
    return path.join(this.deps.getDataDir(), 'translations');
  }

  jobDir(jobId) {
    return path.join(this.translationsDir(), jobId);
  }

  // ---------- 字体 ----------

  fontInfo(family = 'sans') {
    const settings = this.deps.getSettings();
    return describeFont({
      dataDir: this.deps.getDataDir(),
      explicitPath: settings?.pdfTranslate?.fontPath || settings?.pdfFontPath || '',
      bundledDir: defaultBundledFontDir(process.cwd()),
      family,
    });
  }

  /**
   * 解析本次渲染要用的字体「档位对」：常规档 + 加粗档。
   *
   * 为什么成对解析：译文里有标题、也有原文加粗的强调句。能拿到真正的加粗字体
   * （微软雅黑 Bold / 苹方 Semibold 之类）时观感最好；拿不到就让 bold = null，
   * 渲染层会用「描边合成加粗」补上（见 fontMetrics.planStroke）——总之不会没有加粗。
   *
   * @param {'sans'|'serif'} [family='sans'] 目标家族（auto 时由原文正文推断后传入）
   * @param {(m:string)=>void} [onLog]
   */
  async ensureFonts(family = 'sans', onLog) {
    const settings = this.deps.getSettings();
    const explicitPath = settings?.pdfTranslate?.fontPath || settings?.pdfFontPath || '';
    const cacheKey = `${explicitPath}\u0001${family}`;
    if (this._fontCache && this._fontCache.cacheKey === cacheKey) return this._fontCache;

    const probe = (bold) => resolveCjkFont({
      dataDir: this.deps.getDataDir(),
      explicitPath,
      bundledDir: defaultBundledFontDir(process.cwd()),
      family,
      bold,
    });

    let regular = probe(false);
    if (!regular) {
      onLog?.('本地没有找到中文字体，正在自动下载 Noto Sans SC…');
      await downloadCjkFont({
        dataDir: this.deps.getDataDir(),
        onProgress: (p) => onLog?.(p.message),
      });
      // 下载源都是黑体（sans）。若本次要宋体，再探一次——探不到就退回黑体，
      // 有字形总比没有强。
      regular = probe(false);
      if (!regular) throw new Error('中文字体准备失败：下载完成但仍无法解析出可用字体');
    }

    // 加粗档：降级链可能把「同一条常规字体」又还回来，那样不算真加粗，
    // 直接置 null 交给描边合成，避免白嵌一份重复字体把文件撑大。
    let bold = probe(true);
    if (bold && regular && bold.path === regular.path && bold.label === regular.label) bold = null;

    const entry = {
      cacheKey,
      family,
      regular,
      bold,
      // 兼容旧调用方（ensureFont 时代按 .bytes/.label 取值）
      bytes: regular.bytes,
      label: regular.label,
      source: regular.source,
      path: regular.path,
      variable: regular.variable,
      defaultWeight: regular.defaultWeight,
      thin: regular.thin,
    };
    this._fontCache = entry;
    return entry;
  }

  // ---------- 作业列表 ----------

  history() {
    try {
      const file = path.join(this.deps.getDataDir(), 'pdf-translations.json');
      if (!fs.existsSync(file)) return [];
      const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  saveHistory() {
    try {
      const file = path.join(this.deps.getDataDir(), 'pdf-translations.json');
      const running = [...this.jobs.values()].map((j) => this.publicView(j));
      const past = this.history().filter((h) => !this.jobs.has(h.id));
      const merged = [...running, ...past]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, HISTORY_LIMIT);
      fs.mkdirSync(this.deps.getDataDir(), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(merged, null, 2), 'utf-8');
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.warn('[pdfTranslate] 历史记录写入失败：', e.message);
    }
  }

  list() {
    const running = [...this.jobs.values()].map((j) => this.publicView(j));
    const merged = new Map();
    for (const h of this.history()) merged.set(h.id, h);
    for (const r of running) merged.set(r.id, r);
    return [...merged.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  get(id) {
    const job = this.jobs.get(id);
    if (job) return this.publicView(job);
    return this.history().find((h) => h.id === id) || null;
  }

  /** 内存 job → 可序列化视图（去掉 AbortController 等） */
  publicView(job) {
    const { controller, ...rest } = job;
    void controller;
    return rest;
  }

  log(job, message) {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
    job.logs.push(line);
    if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
    this.emit('update', this.publicView(job));
  }

  setStage(job, stage, percent, message) {
    job.stage = stage;
    if (typeof percent === 'number') job.percent = percent;
    if (message) job.message = message;
    this.emit('update', this.publicView(job));
  }

  // ---------- 启动 / 取消 ----------

  /**
   * 创建一个翻译作业。
   * @param {object} params
   * @param {string} params.filePath 本地 PDF 绝对路径
   * @param {string} [params.fileName]
   * @param {string} [params.literatureId]
   * @param {object} [params.options]
   */
  start(params) {
    const settings = this.deps.getSettings();
    const options = normalizeOptions(params.options, settings);
    const job = {
      id: 't' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      literatureId: params.literatureId || null,
      filePath: params.filePath,
      fileName: params.fileName || path.basename(params.filePath || ''),
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: '排队中',
      logs: [],
      options,
      engineLabel: '',
      outputs: [],
      stats: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.emit('update', this.publicView(job));
    this.saveHistory();
    this.pump();
    return this.publicView(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: '作业不存在或已结束' };
    job.status = 'cancelled';
    job.message = '正在取消…';
    try { job.controller.abort(); } catch (_) { /* ignore */ }
    this.emit('update', this.publicView(job));
    return { ok: true };
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (job && job.status === 'running') return { ok: false, error: '作业正在运行，请先取消' };
    this.jobs.delete(id);
    try {
      const dir = this.jobDir(id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
    const rest = this.history().filter((h) => h.id !== id);
    try {
      const file = path.join(this.deps.getDataDir(), 'pdf-translations.json');
      fs.writeFileSync(file, JSON.stringify(rest, null, 2), 'utf-8');
    } catch (_) { /* ignore */ }
    return { ok: true };
  }

  pump() {
    if (this.running.size >= this.maxConcurrent) return;
    const next = [...this.jobs.values()].find((j) => j.status === 'queued' && !this.running.has(j.id));
    if (!next) return;
    this.running.add(next.id);
    this.run(next)
      .catch((e) => {
        next.status = 'failed';
        next.error = e?.message || String(e);
        next.message = '翻译失败：' + next.error;
        if (e?.name === 'AbortError') {
          next.status = 'cancelled';
          next.message = '已取消';
        }
        this.log(next, next.message);
      })
      .finally(() => {
        next.finishedAt = new Date().toISOString();
        this.running.delete(next.id);
        this.emit('update', this.publicView(next));
        this.saveHistory();
        this.pump();
      });
  }

  // ---------- 主流程 ----------

  async run(job) {
    const { signal } = job.controller;
    const options = job.options;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.log(job, `开始翻译：${job.fileName}`);

    if (!job.filePath || !fs.existsSync(job.filePath)) {
      throw new Error('找不到原始 PDF 文件，可能已被移动或删除');
    }
    const sourceBytes = fs.readFileSync(job.filePath);

    // 1) 版面分析（先探测总页数，才能解析页码范围）
    //
    // 顺序说明：分析必须排在字体之前。字号/字体族都要「跟随原文」，而这两项只有
    // 分析完才知道（stats.bodySize / stats.bodySerif）。分析本身不依赖字体，可以放心前置。
    this.setStage(job, 'analyze', 1, '正在解析 PDF 版面');
    const probe = await probePageCount(sourceBytes);
    const pageNumbers = parsePageRange(options.pageRange, probe);
    if (pageNumbers) this.log(job, `页码范围：${pageNumbers.length} 页（共 ${probe} 页）`);

    const layout = await analyzePdf(sourceBytes, {
      pageNumbers,
      signal,
      keepFormulas: options.keepFormulas,
      keepTables: options.keepTables,
      translateReferences: options.translateReferences,
      onProgress: (p) => this.setStage(job, 'analyze', 1 + Math.round(p.percent * 0.26), `解析版面 ${p.page}/${p.total}`),
    });
    job.stats = { ...layout.stats };
    this.log(job, `版面解析完成：${layout.stats.pages} 页 / ${layout.stats.blocks} 个文本块，其中可翻译 ${layout.stats.translatableBlocks} 个（约 ${layout.stats.chars} 字）`);
    this.log(job, `正文基准字号 ${layout.stats.bodySize} pt，字形 ${layout.stats.bodySerif == null ? '族别未知' : (layout.stats.bodySerif ? '衬线体（宋体系）' : '无衬线体（黑体系）')}`);
    if (!layout.stats.translatableBlocks) {
      throw new Error('没有找到可翻译的文本内容。该 PDF 可能是纯扫描图片版，请先用 OCR 处理后再翻译');
    }

    // 2) 字体：家族跟随原文正文（auto），并尽量同时拿到真正的加粗档
    const family = options.fontFamily === 'auto'
      ? (layout.stats.bodySerif ? 'serif' : 'sans')
      : options.fontFamily;
    this.setStage(job, 'font', 29, '准备中文字体');
    const fonts = await this.ensureFonts(family, (m) => this.log(job, m));
    this.log(job, `译文正文字体：${fonts.regular.label}（${fonts.regular.source}`
      + `，${(fonts.regular.bytes.length / 1024 / 1024).toFixed(1)} MB）`
      + (fonts.bold ? `；加粗档：${fonts.bold.label}` : '；无独立加粗字体，加粗由描边合成'));
    if (options.fontFamily === 'auto') {
      this.log(job, `字体家族跟随原文：${family === 'serif' ? '衬线（宋体系）' : '无衬线（黑体系）'}`);
    }
    if (fonts.regular.thin) {
      this.log(job, `提示：${fonts.regular.label} 默认字重 ${Math.round(fonts.regular.defaultWeight)} 偏细，已自动用描边补足到目标粗细`);
    }

    // 3) 翻译
    const engine = createEngine({
      engine: options.engine,
      settings: this.deps.getSettings(),
      options: {
        ...options,
        glossaryHint: options.glossary.length
          ? options.glossary.slice(0, 200).map((g) => `${g.source} → ${g.target}`).join('\n')
          : '',
      },
      onLog: (m) => this.log(job, m),
    });
    job.engineLabel = engine.label;
    this.log(job, `翻译引擎：${engine.label}；目标语言：${targetLangInfo(options.targetLang).label}`);
    this.setStage(job, 'translate', 32, '正在翻译');

    const segments = [];
    for (const page of layout.pages) {
      for (const block of page.blocks) {
        if (!block.translatable) continue;
        segments.push({ id: block.id, text: block.text, block });
      }
    }

    const { map, failures, stats } = await translateSegments({
      segments,
      engine,
      cache: this.cache,
      glossary: options.glossary,
      concurrency: options.concurrency,
      targetLang: options.targetLang,
      sourceLang: options.sourceLang,
      signal,
      onLog: (m) => this.log(job, m),
      onProgress: (p) => this.setStage(job, 'translate', 32 + Math.round(p.percent * 0.52), `正在翻译 ${p.done}/${p.total} 段`),
    });
    job.stats.translate = stats;
    if (failures.length) {
      this.log(job, `${failures.length} 段翻译失败，已保留原文（错误示例：${failures[0].error}）`);
    }

    let translated = 0;
    for (const page of layout.pages) {
      for (const block of page.blocks) {
        if (!block.translatable) continue;
        const t = map.get(block.id);
        if (t) { block.translation = t; translated++; }
      }
    }
    this.log(job, `翻译完成，共写入 ${translated} 段译文`);

    // 4) 渲染
    const outDir = this.jobDir(job.id);
    fs.mkdirSync(outDir, { recursive: true });
    const stem = safeStem(job.fileName);
    // 「both / all」这类别名在这里展开成具体成品列表，下面只认具体模式
    const modes = resolveModes(options.mode);

    // 观感参数：单语/双语/重排三种成品共用同一套，保证同一篇论文三种成品粗细一致
    const look = {
      fontWeight: options.fontWeight,
      fontSize: options.fontSize,
      respectBold: options.respectBold,
    };

    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i];
      if (signal.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });
      const meta = OUTPUT_META[mode] || OUTPUT_META.mono;
      // 渲染阶段占 86 → 99 这 13 个点，按成品数量均分
      const base = 86 + Math.round((i / modes.length) * 13);
      const span = Math.max(1, Math.round(13 / modes.length));
      this.setStage(job, 'render', base, `正在生成${meta.label}`);

      const common = {
        sourceBytes,
        pages: layout.pages,
        fontBytes: fonts.regular.bytes,
        boldFontBytes: fonts.bold?.bytes,
        signal,
      };
      const { bytes, report } = mode === 'reflow'
        ? await renderReflowPdf({
          ...common,
          options: {
            ...look,
            // 重排的正文基准字号：0 = 由 reflow 按原文正文自动放大（A4 单栏比论文窄栏宽得多）
            reflowKeepFigures: options.reflowKeepFigures,
            reflowIndent: options.reflowIndent,
          },
          onProgress: (p) => this.setStage(job, 'render', base + Math.round(p.percent * span / 100), `正在重排 ${p.percent}%`),
        })
        : await renderTranslatedPdf({
          ...common,
          mode,
          options: {
            ...look,
            minFontScale: options.minFontScale,
            lineHeightRatio: options.lineHeightRatio,
            widthFill: options.widthFill,
          },
          onProgress: (p) => this.setStage(job, 'render', base + Math.round(p.percent * span / 100), `生成 PDF ${p.page} 页`),
        });

      const fileName = `${stem}${meta.suffix}.pdf`;
      const filePath = path.join(outDir, fileName);
      fs.writeFileSync(filePath, bytes);
      job.outputs.push({
        kind: mode,
        label: meta.label,
        fileName,
        filePath,
        relPath: `${job.id}/${fileName}`,
        url: `/translations/${encodeURIComponent(job.id)}/${encodeURIComponent(fileName)}`,
        size: bytes.length,
        pages: report.pages,
        blocks: report.translatedBlocks,
        overflowBlocks: report.overflowBlocks,
      });
      const extra = mode === 'reflow'
        ? `${report.translatedBlocks} 段译文，${report.figures || 0} 张插图 / ${report.formulas || 0} 个公式 / ${report.tables || 0} 张表格按原样保留`
        : `${report.translatedBlocks} 段译文${report.overflowBlocks ? `，${report.overflowBlocks} 段文字较密已自动缩小字号` : ''}`;
      this.log(job, `已生成${meta.label}：${fileName}（${(bytes.length / 1024 / 1024).toFixed(2)} MB，${extra}）`);
    }

    job.stats.outputs = job.outputs.length;
    job.stats.modes = modes;
    job.stats.overflowBlocks = job.outputs.reduce((n, o) => n + (o.overflowBlocks || 0), 0);
    job.status = 'done';
    this.setStage(job, 'done', 100, '翻译完成');
    this.log(job, '全部完成');
  }

  // ---------- 预估 ----------

  /**
   * 只解析、不翻译：给前端一个「要翻多少字、大概多久」的预估。
   */
  async estimate({ filePath, options }) {
    const opts = normalizeOptions(options, this.deps.getSettings());
    const bytes = fs.readFileSync(filePath);
    const total = await probePageCount(bytes);
    const pageNumbers = parsePageRange(opts.pageRange, total);
    const layout = await analyzePdf(bytes, {
      pageNumbers,
      keepFormulas: opts.keepFormulas,
      keepTables: opts.keepTables,
      translateReferences: opts.translateReferences,
    });
    const perRequest = Math.max(opts.batchChars, 400);
    const requests = Math.ceil(layout.stats.chars / perRequest);
    return {
      totalPages: total,
      selectedPages: pageNumbers ? pageNumbers.length : total,
      blocks: layout.stats.translatableBlocks,
      chars: layout.stats.chars,
      requests,
      engine: opts.engine,
      targetLang: opts.targetLang,
      // 让前端「预估」也能预告这次会出几种成品、用什么字体族
      modes: resolveModes(opts.mode),
      outputs: resolveModes(opts.mode).map((m) => ({ kind: m, ...OUTPUT_META[m] })),
      bodySize: layout.stats.bodySize,
      bodySerif: layout.stats.bodySerif,
      fontFamily: opts.fontFamily === 'auto'
        ? (layout.stats.bodySerif ? 'serif' : 'sans')
        : opts.fontFamily,
      concurrency: opts.concurrency,
    };
  }
}

let probeModule = null;
async function probePageCount(bytes) {
  if (!probeModule) probeModule = await import('unpdf');
  // 同样要 copy：探测页数只是顺路看一眼，不能把调用方的原始字节 detach 掉
  const doc = await probeModule.getDocumentProxy(toUint8Array(bytes, { copy: true }));
  const n = doc.numPages;
  try { doc.destroy?.(); } catch (_) { /* ignore */ }
  return n;
}
