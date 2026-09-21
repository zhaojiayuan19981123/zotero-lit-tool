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
  buildMarkdownFromLayout, parseVisionBlocks, visionPaperPrompt,
  collectVisionSegments, applyVisionTranslations, assembleVisionMarkdown, visionPageFallbackMarkdown,
} from './markdown.js';
import {
  createEngine, translateSegments, TranslationCache, parseGlossary, TARGET_LANGS, targetLangInfo, runAdaptivePool,
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
  mode: 'md',              // md | mono | dual | reflow | both(单语+双语) | all(三种全出)
  vision: false,           // Markdown 译文用视觉模型识别版面（版面还原更好，逐页截图送视觉模型）
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

/**
 * 视觉识别的并发路数。
 *
 * 以前是 `Math.round(concurrency / 3)` 且硬顶 4 路。这个值偏保守：视觉请求是
 * 「一张图 + 一页转录」，单次响应体量远小于一个翻译批次，且用的是视觉模型配额、
 * 和翻译模型互不争抢。论文动辄 20~40 页时，4 路意味着要跑 5~10 个波次，
 * 用户反馈的「太慢」很大一部分就出在这里。
 *
 * 现在按翻译并发的 1/2 起步、上限 6：既明显提速，又不会把视觉供应商打到限流
 * （真被限流时 runAdaptivePool 会自己减半降速，是安全网）。
 */
export function visionConcurrency(translateConcurrency) {
  const n = Number(translateConcurrency) || 8;
  return Math.max(2, Math.min(6, Math.ceil(n / 2)));
}

/** 页面截图入参清洗：只留页号与 dataURL，最多 120 页，防呆不防饿 */
const MAX_PAGE_IMAGES = 120;
function sanitizePageImages(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const it of list.slice(0, MAX_PAGE_IMAGES)) {
    const page = Number(it?.page);
    const image = String(it?.image || '');
    if (Number.isFinite(page) && page >= 1 && image.startsWith('data:image/')) {
      out.push({ page: Math.floor(page), image });
    }
  }
  return out.length ? out : null;
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
  if (!MODES.includes(merged.mode)) merged.mode = 'md';
  merged.vision = merged.vision === true;
  if (!['auto', 'llm', 'deepl'].includes(merged.engine)) merged.engine = 'auto';
  if (!['regular', 'medium', 'bold'].includes(merged.fontWeight)) merged.fontWeight = 'medium';
  if (!['auto', 'sans', 'serif'].includes(merged.fontFamily)) merged.fontFamily = 'auto';
  if (!TARGET_LANGS.some((t) => t.id === merged.targetLang)) merged.targetLang = 'zh';
  return merged;
}

/** 输出模式 → 实际要渲染的成品列表（别名统一在这里展开，别处只认具体模式） */
export const MODES = ['md', 'mono', 'dual', 'reflow', 'both', 'all'];

export function resolveModes(mode) {
  switch (mode) {
    case 'md': case 'mono': case 'dual': case 'reflow': return [mode];
    case 'all': return ['md', 'reflow', 'mono', 'dual'];
    case 'both':
    default: return ['mono', 'dual'];
  }
}

/** 成品类型 → 文件名后缀与中文名 */
export const OUTPUT_META = {
  md: { suffix: '-译文', label: 'Markdown 译文', desc: '重排为 Markdown，公式 / 表格原样保留，可在阅读器内与原文 PDF 对照' },
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

  /** 内存 job → 可序列化视图（去掉 AbortController 与逐页截图；截图体积太大，不能进 SSE/历史） */
  publicView(job) {
    const { controller, pageImages, ...rest } = job;
    void controller;
    void pageImages;
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
   * @param {Array<{page:number,image:string}>} [params.pageImages]
   *   视觉识别用的逐页截图（dataURL，由前端从原 PDF 渲染）。只在 vision 模式下使用；
   *   缺页时该页自动回退文本层。内存里保留，不进历史 JSON（体积太大）。
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
      pageImages: sanitizePageImages(params.pageImages),
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

    // 0) 本次要出哪些成品。md 不需要字体与 PDF 渲染；视觉识别只作用于 md 成品。
    const modes = resolveModes(options.mode);
    const useVision = options.vision && modes.includes('md');
    const needPdfRender = modes.some((m) => m !== 'md');

    // 进度锚点：视觉模式多一个识别阶段，翻译段整体后移
    const ANALYZE_END = useVision ? 20 : 27;
    const VISION_START = ANALYZE_END + 2;
    const VISION_END = 44;
    const TRANSLATE_START = useVision ? 46 : 32;

    // 1) 版面分析（先探测总页数，才能解析页码范围）
    //
    // 顺序说明：分析必须排在字体之前。字号/字体族都要「跟随原文」，而这两项只有
    // 分析完才知道（stats.bodySize / stats.bodySerif）。分析本身不依赖字体，可以放心前置。
    this.setStage(job, 'analyze', 1, '正在解析 PDF 版面');
    const probe = await probePageCount(sourceBytes);
    const pageNumbers = parsePageRange(options.pageRange, probe);
    // 把「这份 PDF 到底有多少页、这次翻哪些页」写进日志。排查「怎么只翻了一页」
    // 时这是第一手信息（常见原因：填了页码范围、或附件其实只有一页）。
    this.log(job, `PDF 共 ${probe} 页，本次处理 ${pageNumbers ? pageNumbers.length : probe} 页`
      + (pageNumbers ? `（页码范围：${options.pageRange}）` : '（未限定页码范围）'));

    let layout = null;
    try {
      layout = await analyzePdf(sourceBytes, {
        pageNumbers,
        signal,
        keepFormulas: options.keepFormulas,
        keepTables: options.keepTables,
        translateReferences: options.translateReferences,
        onProgress: (p) => this.setStage(job, 'analyze', 1 + Math.round(p.percent * (ANALYZE_END - 1)), `解析版面 ${p.page}/${p.total}`),
      });
      job.stats = { ...layout.stats };
      this.log(job, `版面解析完成：${layout.stats.pages} 页 / ${layout.stats.blocks} 个文本块，其中可翻译 ${layout.stats.translatableBlocks} 个（约 ${layout.stats.chars} 字）`);
      this.log(job, `正文基准字号 ${layout.stats.bodySize} pt，字形 ${layout.stats.bodySerif == null ? '族别未知' : (layout.stats.bodySerif ? '衬线体（宋体系）' : '无衬线体（黑体系）')}`);
    } catch (e) {
      // 视觉模式不依赖文本层（扫描版也能翻）；其余情况照旧抛出
      if (!useVision) throw e;
      this.log(job, `版面解析失败（${e.message}）。视觉识别模式将继续使用页面图像工作`);
    }
    if (!layout?.stats?.translatableBlocks && !useVision) {
      throw new Error('没有找到可翻译的文本内容。该 PDF 可能是纯扫描图片版，请先用 OCR 处理后再翻译，或在输出 Markdown 译文时勾选「视觉模型识别版面」');
    }

    // 2) 字体：家族跟随原文正文（auto），并尽量同时拿到真正的加粗档。
    //    只出 Markdown 时不需要嵌字体，跳过下载与解析，起跑更快。
    let fonts = null;
    if (needPdfRender) {
      const family = options.fontFamily === 'auto'
        ? (layout?.stats?.bodySerif ? 'serif' : 'sans')
        : options.fontFamily;
      this.setStage(job, 'font', TRANSLATE_START - 3, '准备中文字体');
      fonts = await this.ensureFonts(family, (m) => this.log(job, m));
      this.log(job, `译文正文字体：${fonts.regular.label}（${fonts.regular.source}`
        + `，${(fonts.regular.bytes.length / 1024 / 1024).toFixed(1)} MB）`
        + (fonts.bold ? `；加粗档：${fonts.bold.label}` : '；无独立加粗字体，加粗由描边合成'));
      if (options.fontFamily === 'auto') {
        this.log(job, `字体家族跟随原文：${family === 'serif' ? '衬线（宋体系）' : '无衬线（黑体系）'}`);
      }
      if (fonts.regular.thin) {
        this.log(job, `提示：${fonts.regular.label} 默认字重 ${Math.round(fonts.regular.defaultWeight)} 偏细，已自动用描边补足到目标粗细`);
      }
    }

    // 3+4) 视觉识别 与 翻译 —— 流水线并行
    //
    // ★ 为什么要把这两步揉在一起（用户反馈「全文翻译有点太慢」）：
    //   旧实现是「第 3 步：全部页识别完 → 第 4 步：才开始翻译」。这两步用的是两套
    //   不同模型、不同配额，串行跑时总耗时 = 视觉耗时 + 翻译耗时，白白浪费一半墙钟。
    //   更糟的是视觉识别本身并发只有 4 路，30 页论文光识别就得排 8 个波次，
    //   翻译阶段则全程闲着。
    //
    //   现在改成生产者-消费者流水线：识别阶段每完成一页就把该页的文本段立刻投递给
    //   翻译器，翻译器在后台按自己的并发节奏持续消费。两段同时在飞，
    //   总耗时从 (V + T) 降到 max(V, T)（理想情况），页数越多收益越大。
    //
    //   正确性保证：翻译结果统一写进同一个 `map`（id 全局唯一：视觉段 v{页}:{序}、
    //   文本层段 block.id），所以「边识别边翻译」和「全识别完再翻译」的产出完全一致，
    //   只是时间轴上重叠了。文本层兜底页（识别失败/缺图）在识别阶段结束时一次性补投。
    let visionPages = null; // 仅视觉路径下由 runVisionStage 填充
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
    this.setStage(job, 'translate', TRANSLATE_START, '正在翻译');

    // 流水线共用的累积容器：视觉段按页收、文本层兜底段最后收，最后一起结算
    const segments = [];
    let visionSegments = [];

    // 翻译进度显示：总段数在识别过程中不断增长，所以用「已完成/当前已知」表示。
    // 每次 feedTranslate 是一次独立的 translateSegments 调用，它的 onProgress 里
    // done 从 0 重新计数，因此这里按「本批被投递的段数」单独跟踪，再累加进全局。
    let transDone = 0;
    let transTotal = 0;
    const bumpTransProgress = () => {
      const span = 84 - TRANSLATE_START;
      const pct = transTotal ? Math.min(99, Math.round((transDone / transTotal) * 100)) : 0;
      this.setStage(job, 'translate', TRANSLATE_START + Math.round(pct * span / 100),
        transTotal ? `正在翻译 ${transDone}/${transTotal} 段` : '正在翻译');
    };

    // 结果累积（跨批次合并）：map 按 id 汇总，failures 追加，stats 累加。
    // 必须声明在 feedTranslate 之前 —— feedTranslate 的 .then 里要用到它。
    const mergedMap = new Map();
    const mergedFailures = [];
    const mergedStats = { requests: 0, retries: 0, cacheHits: 0, fallbacks: 0, chars: 0, failed: 0, throttled: 0, peakConcurrency: 0 };
    const absorb = (out) => {
      if (!out) return;
      for (const [k, v] of out.map) mergedMap.set(k, v);
      mergedFailures.push(...(out.failures || []));
      for (const k of Object.keys(mergedStats)) {
        if (typeof out.stats?.[k] === 'number') {
          mergedStats[k] = (k === 'peakConcurrency')
            ? Math.max(mergedStats[k], out.stats[k])
            : mergedStats[k] + out.stats[k];
        }
      }
      if (out.stats?.concurrencyStart != null) mergedStats.concurrencyStart = out.stats.concurrencyStart;
      if (out.stats?.concurrencyRequested != null) mergedStats.concurrencyRequested = out.stats.concurrencyRequested;
    };

    /**
     * 把一批新收集到的段送去翻译（流水线里的「投递」动作）。
     *
     * ★ 这里是并行的关键，容易写错：调用方（视觉识别的 worker）**不能 await 本函数**。
     *   如果 await，视觉 worker 就会一直阻塞到这批翻译跑完才去认下一页 —— 等于两段
     *   重新变回串行，只是把顺序换了一下。正确做法是「投递即返回」，把 Promise 收进
     *   inFlight 列表，最后统一 await。这样视觉 worker 立刻去处理下一页，
     *   翻译在后台按自己的并发节奏跑，两段真正同时在飞。
     *
     * ★ 另一个坑：translateSegments 内部的自适应池每次调用都从「上限的 1/4」起跑。
     *   如果一页一页地投递（30 页 = 30 次调用），每次都要重新爬坡，反而比一次全量
     *   更慢。所以这里做了「攒批」：把陆续投进来的段先攒着，攒够 COALESCE_CHARS /
     *   COALESCE_ITEMS 或等待超过 COALESCE_MS 再真发一次 translateSegments。
     *   这样既保留了流水线重叠，又让自适应并发能正常爬坡、请求次数也不会爆。
     */
    const COALESCE_CHARS = 1200;
    const COALESCE_ITEMS = 8;
    const COALESCE_MS = 400;
    const inFlight = [];
    let pendingSegs = [];
    let pendingChars = 0;
    let flushTimer = null;

    const flushPending = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!pendingSegs.length) return null;
      const batchSegs = pendingSegs;
      pendingSegs = [];
      pendingChars = 0;
      return dispatchTranslate(batchSegs);
    };

    const dispatchTranslate = (newSegments) => {
      const base = transTotal;
      transTotal += newSegments.length;
      bumpTransProgress();
      const p = translateSegments({
        segments: newSegments,
        engine,
        cache: this.cache,
        glossary: options.glossary,
        concurrency: options.concurrency,
        targetLang: options.targetLang,
        sourceLang: options.sourceLang,
        signal,
        onLog: (m) => this.log(job, m),
        // 单批内部的 done 是「本批已完成段数」（从 0 起算），换成全局计数即可
        onProgress: (pr) => {
          transDone = Math.max(transDone, base + Math.max(0, Number(pr.done) || 0));
          bumpTransProgress();
        },
      }).then((out) => {        absorb(out);
        transDone = Math.max(transDone, base + newSegments.length);
        bumpTransProgress();
        return out;
      });
      // 投递出去的批次失败不应该炸掉整条流水线：真实错误已由 translateSegments
      // 内部记进 failures（失败的段会回退成原文），这里只做记录，不再向上抛。
      if (typeof p.catch === 'function') p.catch((e) => this.log(job, `一批翻译未完成：${e.message}`));
      inFlight.push(p);
      return p;
    };

    /** 投递入口：攒批后择机真发；返回 null 表示「已收下，稍后一起发」 */
    const feedTranslate = (newSegments) => {
      if (!newSegments.length) return null;
      segments.push(...newSegments);
      pendingSegs.push(...newSegments);
      pendingChars += newSegments.reduce((n, s) => n + String(s.text || '').length, 0);
      if (pendingChars >= COALESCE_CHARS || pendingSegs.length >= COALESCE_ITEMS) {
        return flushPending();
      }
      // 还没攒够：挂个短定时器，别让最后几段干等下一批
      if (!flushTimer) flushTimer = setTimeout(() => { try { flushPending(); } catch (_) { /* ignore */ } }, COALESCE_MS);
      return null;
    };
    /** 等所有在飞的翻译批次结束（含尚未刷出的攒批） */
    const drainTranslate = async () => {
      flushPending();
      while (inFlight.length) {
        const batch = inFlight.splice(0, inFlight.length);
        await Promise.all(batch);
      }
    };

    let missingLayoutPages = [];

    if (useVision) {
      // 逐页流水线：识别完一页立刻投递该页文本段（不 await，见 feedTranslate 注释）
      visionPages = await this.runVisionStage(job, {
        pageNumbers, totalPages: probe, signal, options,
        progressStart: VISION_START, progressEnd: VISION_END,
        onPageDone: (_pageNo, page) => {
          if (page.missing) return; // 失败页留给文本层兜底，阶段末尾统一投递
          const segs = collectVisionSegments([page], { translateReferences: options.translateReferences });
          visionSegments.push(...segs);
          feedTranslate(segs);
        },
      });

      // 识别失败/缺图的页：用文本层兜底（这些页的文本段也要翻译）
      for (const pg of visionPages) {
        if (!pg.missing) continue;
        const lp = (layout?.pages || []).find((p) => (p.index || 0) + 1 === pg.page);
        if (lp) missingLayoutPages.push(lp);
      }
      if (missingLayoutPages.length) {
        this.log(job, `${missingLayoutPages.length} 页将由文本层兜底（视觉识别不可用或页面截图缺失）`);
      }
      const tailSegs = [];
      for (const page of missingLayoutPages) {
        for (const block of page.blocks) {
          if (!block.translatable) continue;
          tailSegs.push({ id: block.id, text: block.text, block });
        }
      }
      feedTranslate(tailSegs);
    } else {
      // 纯文本层路径：没有识别阶段可重叠，一次性投递
      const allSegs = [];
      for (const page of (layout?.pages || [])) {
        for (const block of page.blocks) {
          if (!block.translatable) continue;
          allSegs.push({ id: block.id, text: block.text, block });
        }
      }
      feedTranslate(allSegs);
    }

    // 流水线收尾：等所有在飞的翻译批次落地，再往下走渲染
    await drainTranslate();

    if (!segments.length) {
      throw new Error('没有收集到可翻译的文本。若开启了视觉识别，请确认从阅读器内发起翻译（需要页面截图），或关闭视觉识别后重试');
    }

    const map = mergedMap;
    const failures = mergedFailures;
    const stats = mergedStats;
    // 同一段原文在多个批次中出现时，去重缓存同样生效（cache 是跨批共用的），
    // 这里只把各批的 cacheHits 累加，可能略高于「全量去重」的理论值，属可接受的估算。
    job.stats = job.stats || {};
    job.stats.translate = stats;
    if (failures.length) {
      this.log(job, `${failures.length} 段翻译失败，已保留原文（错误示例：${failures[0].error}）`);
    }

    let translated = 0;
    const textLayerPages = useVision ? missingLayoutPages : (layout?.pages || []);
    for (const page of textLayerPages) {
      for (const block of page.blocks) {
        if (!block.translatable) continue;
        const t = map.get(block.id);
        if (t) { block.translation = t; translated++; }
      }
    }
    if (useVision) {
      applyVisionTranslations(visionPages, visionSegments, map);
      translated = visionSegments.filter((s) => map.get(s.id)).length + translated;
    }
    this.log(job, `翻译完成，共写入 ${translated} 段译文`);

    // 5) 渲染
    const outDir = this.jobDir(job.id);
    fs.mkdirSync(outDir, { recursive: true });
    const stem = safeStem(job.fileName);

    // Markdown 译文只需组装一次（视觉路径 / 文本层路径二选一）
    let mdResult = null;
    if (modes.includes('md')) {
      this.setStage(job, 'render', 86, '正在生成 Markdown 译文');
      mdResult = useVision
        ? this.assembleVisionMarkdownOutput(visionPages, missingLayoutPages, layout, options)
        : buildMarkdownFromLayout(layout?.pages || [], { reflowKeepFigures: options.reflowKeepFigures });
      if (!mdResult.markdown.trim()) {
        throw new Error('Markdown 译文组装结果为空，请检查该 PDF 是否有可识别内容');
      }
    }

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

      if (mode === 'md') {
        const fileName = `${stem}${meta.suffix}.md`;
        const filePath = path.join(outDir, fileName);
        fs.writeFileSync(filePath, mdResult.markdown, 'utf-8');
        const bytes = Buffer.byteLength(mdResult.markdown, 'utf-8');
        job.outputs.push({
          kind: 'md',
          label: meta.label,
          fileName,
          filePath,
          relPath: `${job.id}/${fileName}`,
          url: `/translations/${encodeURIComponent(job.id)}/${encodeURIComponent(fileName)}`,
          size: bytes,
          pages: layout?.stats?.pages || (visionPages?.length || 0),
          blocks: mdResult.stats.text,
          overflowBlocks: 0,
          crops: mdResult.stats.crops,
          vision: useVision,
        });
        this.log(job, `已生成${meta.label}：${fileName}（${(bytes / 1024).toFixed(1)} KB，${mdResult.stats.text} 段译文，公式/表格/插图 ${mdResult.stats.crops} 处按原样保留${useVision ? '，视觉模型识别版面' : ''}）`);
        continue;
      }

      const common = {
        sourceBytes,
        pages: layout?.pages || [],
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

  /**
   * 视觉识别阶段：逐页把前端截图交给视觉模型，转录成结构化标记块。
   * 单页失败不炸任务：该页标记 missing，稍后用文本层兜底。
   *
   * ★ 职责边界（用户明确要求）：视觉模型**只做「看图识字」**——把版面转录成文本，
   *   一个字都不翻译。翻译统一交给下面第 4) 步的分段翻译管线（默认翻译模型 / 划词
   *   设置里选的翻译服务），这样视觉模型换掉、或只换翻译引擎时，识别结果都能复用。
   *
   * ★ 并行（用户反馈「有点太慢」）：
   *   以前是「全部页识别完 → 才开始翻译」，两个阶段严格串行，总耗时 ≈ 视觉 + 翻译。
   *   但这两段用的是**两套不同的模型与配额**，串行跑等于白白浪费一半墙钟时间。
   *   现在改成**流水线**（见 runPipelinedVisionTranslate）：识别一页就立刻把该页的
   *   文本段塞进翻译队列，识别与翻译同时在飞，总耗时 ≈ max(视觉, 翻译) 而不是两者之和。
   *   同时视觉并发也从「翻译并发的 1/3、上限 4」放宽到上限 6 —— 视觉请求是单张
   *   图片、单页转录，比翻译批次更轻，原本的 4 路在论文页数多时明显是瓶颈。
   *
   * @param {(pageNo:number, page:object)=>void|Promise<void>} [onPageDone]
   *   每页识别完成（或判定 missing）后回调，用于流水线里即时触发该页的翻译。
   */
  async runVisionStage(job, { pageNumbers, totalPages, signal, options, progressStart, progressEnd, onPageDone }) {
    const targets = pageNumbers || Array.from({ length: totalPages || 0 }, (_, i) => i + 1);
    if (!targets.length) throw new Error('没有可识别的页面');
    const images = new Map((job.pageImages || []).map((p) => [p.page, p.image]));
    if (!images.size) {
      this.log(job, '本次没有收到页面截图（请从阅读器内发起全文翻译），全部页面将用文本层兜底');
      return targets.map((n) => ({ page: n, blocks: [], missing: true }));
    }
    const visionLabel = this.deps.visionInfo?.().model || '已配置的视觉模型';
    const concurrency = visionConcurrency(options.concurrency);
    this.log(job, `视觉识别：${targets.length} 页，视觉模型「${visionLabel}」，逐页转录版面（${concurrency} 路并发）`);
    this.setStage(job, 'vision', progressStart, '视觉模型识别版面');

    const prompt = visionPaperPrompt({ translateReferences: options.translateReferences });
    const results = new Map();
    let done = 0;
    await runAdaptivePool(targets, async (pageNo) => {
      if (signal.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });
      const image = images.get(pageNo);
      let page;
      if (!image) {
        page = { page: pageNo, blocks: [], missing: true };
        this.log(job, `第 ${pageNo} 页缺少页面截图，该页将用文本层兜底`);
      } else {
        try {
          const { text } = await this.deps.visionComplete({
            image,
            prompt,
            timeoutMs: Math.max(30000, Math.min(options.requestTimeoutMs || 120000, 240000)),
          });
          const blocks = parseVisionBlocks(text);
          if (!blocks.length) throw new Error('视觉模型没有返回可用内容');
          page = { page: pageNo, blocks };
        } catch (e) {
          page = { page: pageNo, blocks: [], missing: true };
          this.log(job, `第 ${pageNo} 页视觉识别失败：${e.message}，该页将用文本层兜底`);
        }
      }
      results.set(pageNo, page);
      done++;
      this.setStage(job, 'vision', progressStart + Math.round((done / targets.length) * (progressEnd - progressStart)), `视觉识别 ${done}/${targets.length} 页`);
      // 流水线关键点：识别完一页就立刻交给下游翻译，不等其余页
      if (onPageDone) await onPageDone(pageNo, page);
    }, { concurrency, signal });
    const pages = targets.map((n) => results.get(n) || { page: n, blocks: [], missing: true });
    const ok = pages.filter((p) => !p.missing).length;
    this.log(job, `视觉识别完成：成功 ${ok} 页 / 共 ${pages.length} 页`);
    return pages;
  }

  /** 视觉路径的 Markdown 组装：识别成功的页用视觉块，缺图页用文本层兜底 */
  assembleVisionMarkdownOutput(visionPages, missingLayoutPages, layout, options) {
    const missingByPage = new Map(missingLayoutPages.map((p) => [(p.index || 0) + 1, p]));
    const layoutPages = layout?.pages || null;
    const chunks = [];
    const stats = { text: 0, crops: 0 };
    for (const pg of visionPages || []) {
      const fallbackPage = pg.missing ? missingByPage.get(pg.page) : null;
      if (fallbackPage) {
        const r = visionPageFallbackMarkdown(fallbackPage, { reflowKeepFigures: options.reflowKeepFigures !== false });
        chunks.push(r.markdown);
        stats.text += r.textCount;
        stats.crops += r.cropCount;
      } else {
        const r = assembleVisionMarkdown([pg], layoutPages);
        chunks.push(r.markdown);
        stats.text += r.stats.text;
        stats.crops += r.stats.crops;
      }
    }
    const markdown = chunks.filter((c) => c && c.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { markdown: markdown ? markdown + '\n' : '', stats };
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
