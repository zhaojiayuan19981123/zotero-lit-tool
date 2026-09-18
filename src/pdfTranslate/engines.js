// engines.js —— 全文翻译的翻译引擎层
//
// 两个引擎，对外暴露同一套接口：
//   · llm   ：任意 OpenAI 兼容 Chat Completions 服务（硅基流动 / DeepSeek / 智谱 / Qwen /
//             OpenAI / Ollama …）。复用应用里已经配置好的「模型配置中心」，用户不必再填一遍 Key。
//   · deepl ：DeepL 官方 API（含 Free/Pro 端点自动判定），以及 DeepLX 自建端点。
//
// 全文翻译和划词翻译的差别在于「量」：一篇论文有几百个段落。所以这一层实现的不是
// 「调一次接口」，而是工业化的一整套：
//   1) 多段合并成批（一次请求翻十几段，省 token / 省配额、也给了模型上下文）
//   2) 并发池 + 指数退避重试 + DeepL 的最小请求间隔限流
//   3) 磁盘缓存（按引擎+模型+语言对+文本 做键），重复内容只翻一次，重跑任务几乎不花钱
//   4) 术语表保护：术语先替换成 [[T1]] 占位符，翻完再还原，保证全文术语一致
//   5) 版面结构保护：公式、数字、单位、引文编号的占位符原样透传

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as catalog from '../modelCatalog.js';
import { cjkRatio } from './layout.js';

// ==================== 目标语言 ====================

export const TARGET_LANGS = [
  { id: 'zh', label: '简体中文', deepl: 'ZH-HANS', prompt: '简体中文', deeplLegacy: 'ZH' },
  { id: 'zh-tw', label: '繁体中文', deepl: 'ZH-HANT', prompt: '繁体中文' },
  { id: 'en', label: 'English', deepl: 'EN-US', prompt: 'English' },
  { id: 'ja', label: '日本語', deepl: 'JA', prompt: '日本語' },
  { id: 'ko', label: '한국어', deepl: 'KO', prompt: '한국어' },
  { id: 'de', label: 'Deutsch', deepl: 'DE', prompt: 'Deutsch' },
  { id: 'fr', label: 'Français', deepl: 'FR', prompt: 'Français' },
  { id: 'es', label: 'Español', deepl: 'ES', prompt: 'Español' },
  { id: 'ru', label: 'Русский', deepl: 'RU', prompt: 'Русский' },
  { id: 'pt', label: 'Português', deepl: 'PT-BR', prompt: 'Português' },
  { id: 'it', label: 'Italiano', deepl: 'IT', prompt: 'Italiano' },
];

export function targetLangInfo(id) {
  return TARGET_LANGS.find((t) => t.id === id) || TARGET_LANGS[0];
}

const DEEPL_SOURCE = {
  en: 'EN', zh: 'ZH', 'zh-tw': 'ZH', ja: 'JA', ko: 'KO', de: 'DE', fr: 'FR',
  es: 'ES', ru: 'RU', pt: 'PT', it: 'IT', auto: null,
};

// ==================== 工具 ====================

function abortError() {
  const e = new Error('任务已取消');
  e.name = 'AbortError';
  return e;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** 把用户取消信号与服务端超时信号合并成一个（老运行时没有 AbortSignal.any 时退回原信号） */
export function combineSignals(signal, timeoutMs) {
  if (!(timeoutMs > 0)) return signal;
  const timer = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
  if (!timer) return signal;
  if (!signal) return timer;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timer]);
  // 兜底：手动转发一次（只关心「任一触发即中止」）
  const ctrl = new AbortController();
  const forward = () => ctrl.abort();
  signal.addEventListener?.('abort', forward, { once: true });
  timer.addEventListener?.('abort', forward, { once: true });
  return ctrl.signal;
}

/**
 * 自适应并发池 —— 「大模型翻译慢」的主要解法。
 *
 * 为什么不用固定并发：
 *   固定并发有两个坑。设小了慢（大模型一次往返十几秒，串行翻几百段要等很久）；
 *   设大了会被供应商按 QPS 掐——一撞 429，重试的指数退避又让整体更慢，
 *   等于自己给自己降速。而且不同供应商、不同账号档位的限流阈值差别很大，
 *   没法用一个写死的数字通吃。
 *
 * 做法（窗口滑动式）：
 *   1) 保守起步（上限的 1/4，至少 2 路），先把请求发出去；
 *   2) 一轮全部顺利 → 并发翻倍（1.5 倍递增，很快打满）；
 *   3) 一旦出现限流（429/5xx/超时）→ 立即减半，并暂停提速，等连续两轮干净再涨；
 *   4) 上限仍由用户设置封顶，所以「自适应」只会在用户给的范围内加速，不会失控。
 *
 * worker 需要返回 { throttled?, failed? } 供本函数判断快慢；返回别的值也能跑，
 * 只是拿不到自适应反馈（会一路涨到上限）。
 *
 * @param {Array} items
 * @param {(item:any, index:number)=>Promise<{throttled?:number, failed?:number}|any>} worker
 * @param {object} opts
 * @param {number} [opts.concurrency=8] 用户设定的并发上限
 * @param {AbortSignal} [opts.signal]
 * @param {(limit:number, why:'ramp'|'throttled')=>void} [opts.onAdjust]
 */
export async function runAdaptivePool(items, worker, { concurrency = 8, signal, onAdjust } = {}) {
  const total = items.length;
  const results = new Array(total);
  if (!total) return { results, startLimit: 0, peakConcurrency: 0, endLimit: 0 };

  const maxLimit = Math.max(1, Math.min(concurrency || 1, total));
  let limit = Math.max(1, Math.min(maxLimit, Math.max(2, Math.ceil(maxLimit / 4))));
  const startLimit = limit;
  let cursor = 0;
  let cleanWaves = 0;
  let rampPaused = false;
  let peak = limit;

  while (cursor < total) {
    if (signal?.aborted) throw abortError();
    const start = cursor;
    const wave = items.slice(start, start + limit);
    cursor += wave.length;

    const settled = await Promise.all(wave.map((item, i) => Promise.resolve()
      .then(() => worker(item, start + i))
      .then(
        (r) => ({ ok: true, r }),
        (e) => {
          if (e?.name === 'AbortError') throw e;
          return { ok: false, e };
        },
      )));

    let throttled = 0;
    let failed = 0;
    settled.forEach((s, i) => {
      if (!s.ok) { failed++; return; }
      results[start + i] = s.r;
      const r = s.r;
      if (r && typeof r === 'object') {
        throttled += Number(r.throttled) || 0;
        failed += Number(r.failed) || 0;
      }
    });

    if (signal?.aborted) throw abortError();

    if (throttled > 0) {
      // 被限流：立刻减半，把速度让出来，同时暂停提速等供应商缓过来
      const next = Math.max(1, Math.floor(limit / 2));
      if (next !== limit) onAdjust?.(next, 'throttled');
      limit = next;
      cleanWaves = 0;
      rampPaused = true;
    } else if (failed === 0) {
      cleanWaves++;
      if (cleanWaves >= (rampPaused ? 2 : 1) && limit < maxLimit) {
        const next = Math.min(maxLimit, limit + Math.max(1, Math.ceil(limit / 2)));
        limit = next;
        cleanWaves = 0;
        rampPaused = false;
        onAdjust?.(limit, 'ramp');
      }
    } else {
      cleanWaves = 0;
      rampPaused = true;
    }
    peak = Math.max(peak, limit);
  }

  return { results, startLimit, peakConcurrency: peak, endLimit: limit };
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errText(e) {
  return (e && (e.message || String(e))) || '未知错误';
}

/**
 * 这个错误是不是「被限流 / 服务端临时故障」？
 * 自适应并发靠它决定要不要降速：这类错误说明「发得太快了」，不是请求本身有问题。
 * 判定同时看 HTTP 状态（引擎层会挂到 e.status 上）与错误文本（网络层抛出的裸错误没有状态码）。
 */
export function isThrottleError(e) {
  const s = Number(e?.status);
  if (s === 429 || (s >= 500 && s < 600)) return true;
  if (e?.name === 'TimeoutError') return true;
  return /429|rate.?limit|too many requests|timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up|temporarily unavailable|服务繁忙/i.test(errText(e));
}

// ==================== 术语表 ====================

/**
 * 术语表保护：把术语替换成 [[T1]] 占位符。
 * 相比「在提示词里要求模型用某个译法」，占位符是硬约束——模型改不动它，
 * 翻完再还原，术语 100% 一致。DeepL 这种不支持提示词的引擎也能享受同一套术语表。
 */
export function protectGlossary(text, terms) {
  if (!terms?.length) return { text, hits: [] };
  const sorted = terms
    .filter((t) => t && t.source && t.target)
    .slice()
    .sort((a, b) => b.source.length - a.source.length);
  const hits = [];
  let out = String(text);
  for (const term of sorted) {
    const re = new RegExp(`(?<![\\w\\u4e00-\\u9fff])${escapeRegExp(term.source)}(?![\\w\\u4e00-\\u9fff])`, 'gi');
    if (!re.test(out)) continue;
    const token = `[[T${hits.length + 1}]]`;
    out = out.replace(re, () => token);
    hits.push({ token, target: term.target });
  }
  return { text: out, hits };
}

export function restoreGlossary(text, hits) {
  if (!hits?.length) return text;
  let out = String(text);
  for (const h of hits) out = out.split(h.token).join(h.target);
  return out;
}

/** 解析术语表文本：每行「原文<TAB/=>/,/=→>译文」，也接受 CSV 两列 */
export function parseGlossary(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(.*?)\s*(?:\t|=>|=|,|，|:|：|\s{2,})\s*(.+)$/);
    if (!m) continue;
    const source = m[1].trim();
    const target = m[2].trim();
    if (source && target && source !== target) out.push({ source, target });
  }
  return out;
}

// ==================== 缓存 ====================

/**
 * 译文磁盘缓存。键 = 引擎 + 模型 + 语言对 + 原文，值 = 译文。
 * 论文里重复出现的句子（表格标题、章节名、常见的 "et al." 段落）命中率不低，
 * 更关键的是「同一个任务重跑」「换输出模式重跑」时几乎零成本。
 */
export class TranslationCache {
  constructor(file, { maxEntries = 60000 } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.dirty = false;
    this.hits = 0;
    this.misses = 0;
    this.timer = null;
    this.load();
  }

  static key(...parts) {
    return sha1(parts.join('\u0001'));
  }

  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      const entries = Array.isArray(raw?.entries) ? raw.entries : [];
      for (const [k, v] of entries) this.map.set(k, v);
    } catch (e) {
      console.warn('[pdfTranslate] 缓存读取失败，已忽略：', e.message);
    }
  }

  get(key) {
    const v = this.map.get(key);
    if (v === undefined) { this.misses++; return undefined; }
    this.hits++;
    // LRU：命中后挪到末尾
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key, value) {
    this.map.set(key, value);
    this.dirty = true;
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 2500);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      // 只保留最近使用的 80%，控制文件体积
      const entries = [...this.map.entries()].slice(-Math.floor(this.maxEntries * 0.8));
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }), 'utf-8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.warn('[pdfTranslate] 缓存写入失败：', e.message);
    }
  }

  get size() { return this.map.size; }
}

// ==================== 重试 ====================

async function withRetry(fn, { attempts = 3, baseDelay = 900, signal, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (e?.name === 'AbortError' || signal?.aborted) throw e;
      if (e?.retryable === false) throw e;
      if (i === attempts - 1) break;
      const delay = Math.min(20000, baseDelay * 2 ** i) + Math.floor(Math.random() * 400);
      onRetry?.(e, i + 1, delay);
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}

// ==================== 大模型引擎 ====================

const SEG_MARK = (n) => `@@${n}@@`;

export function buildLlmPrompt({ targetLabel, glossaryHint, extraRules }) {
  return [
    '你是一个学术论文全文翻译引擎，负责把学术论文按段落翻译成' + targetLabel + '。',
    '',
    '【输出格式】输入由若干片段组成，每段以 @@编号@@ 单独一行开头。',
    '你必须原样保留这些编号标记（@@1@@、@@2@@ …）并独占一行，片段数量、顺序都不能变。',
    '只输出编号和译文，不要任何解释、前言、总结或 markdown 代码块。',
    '',
    '【必须原样保留、不得翻译或改动的内容】',
    '1. 数学公式、变量名、希腊字母、上下标、LaTeX 片段；',
    '2. 数字、百分比、单位、p 值、区间（如 95% CI、p < 0.05、n = 128）；',
    '3. 文内引用与编号（如 [12]、[3-5]、(Smith et al., 2020)）；',
    '4. 形如 [[T1]]、[[1]] 的占位符；',
    '5. 缩写、模型名、数据集名、基因名、软件名（如 CNN、BERT、GPT-4、ImageNet、SPSS）；',
    '6. 网址、DOI、邮箱、代码片段。',
    '',
    '【翻译风格】',
    '- 使用规范的学术书面语，术语前后一致，避免口语化与成语堆砌；',
    '- 保持原文的论证语气与逻辑连接词，不要增删信息、不要合并或拆分句子结构到影响原意；',
    '- 段落里若出现「作者观点—证据—结论」结构，译文保持同样顺序；',
    '- 不要翻译已经属于目标语言的内容，原样返回。',
    glossaryHint ? `\n【术语表】以下术语必须按给定译法翻译：\n${glossaryHint}` : '',
    extraRules ? `\n【补充要求】${extraRules}` : '',
  ].filter((s) => s !== '').join('\n');
}

/** 把若干片段拼成一次请求的正文 */
export function formatSegments(segments) {
  return segments.map((s, i) => `${SEG_MARK(i + 1)}\n${s}`).join('\n\n');
}

/**
 * 解析模型返回的分段结果。对模型的「不听话」要有容错：
 * 编号可能被包成 **@@1@@** 或 ## @@1@@，数量可能对不上。
 */
export function parseSegments(raw, expected) {
  const text = String(raw || '')
    .replace(/^\s*```[a-zA-Z]*\s*/m, '')
    .replace(/\s*```\s*$/m, '');
  const re = /(?:^|\n)\s*[*#>\s]*@@\s*(\d+)\s*@@\s*[*:：]?\s*/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ n: Number(m[1]), index: m.index, end: re.lastIndex });
  if (!marks.length) {
    // 完全没编号：只有一段时直接当译文用，多段则视为解析失败
    return expected === 1 ? [text.trim()] : null;
  }
  const out = new Array(expected).fill(null);
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].end;
    const stop = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(start, stop).trim();
    const n = marks[i].n;
    if (n >= 1 && n <= expected && out[n - 1] === null) out[n - 1] = body;
  }
  return out.some((v) => v === null) ? null : out;
}

export function createLlmEngine({ settings, profileId, options = {}, onLog }) {
  const profile = profileId
    ? catalog.resolveProfile((settings.modelProfiles || []).find((p) => p.id === profileId))
    : catalog.resolveActive(settings);
  if (!profile) {
    throw new Error('没有可用的大模型配置，请先在「设置 → 模型配置」中填写 Base URL 与 API Key');
  }
  const target = targetLangInfo(options.targetLang);
  const url = `${profile.baseURL}/chat/completions`;
  const systemPrompt = buildLlmPrompt({
    targetLabel: target.prompt,
    glossaryHint: options.glossaryHint || '',
    extraRules: options.extraRules || '',
  });
  const maxTokens = Math.max(1024, Math.min(8192, options.maxTokens || 4096));
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
  // 单次请求超时。默认 5 分钟：长批次在慢模型/推理模型上确实会跑几分钟，
  // 但「没有上限」的危险更大——一个挂死的连接会把整条自适应并发波次拖住不动。
  const timeoutMs = Number(options.requestTimeoutMs) > 0 ? Number(options.requestTimeoutMs) : 300000;

  return {
    id: 'llm',
    label: `大模型 · ${profile.model}`,
    batchLimits: {
      maxChars: Math.max(600, Math.min(6000, options.batchChars || 2600)),
      maxItems: Math.max(1, Math.min(40, options.batchItems || 12)),
    },
    describe() {
      return { kind: 'llm', model: profile.model, baseURL: profile.baseURL, provider: profile.providerName };
    },
    /**
     * 一次请求翻译若干片段，返回顺序一致的译文数组。
     * 失败时抛出的错误带 retryable 标记，交给上层重试。
     */
    async translateBatch(texts, { signal } = {}) {
      const body = {
        model: profile.model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: formatSegments(texts) },
        ],
        stream: false,
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${profile.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combineSignals(signal, timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const e = new Error(`大模型接口返回 ${res.status}：${detail.slice(0, 300)}`);
        e.status = res.status; // 供自适应并发判断是不是被限流
        if (res.status === 401 || res.status === 403) e.retryable = false;
        if (res.status === 400 && /max_tokens|too large|context/i.test(detail)) e.retryable = false;
        throw e;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('大模型没有返回内容' + (data?.error?.message ? `：${data.error.message}` : ''));
      const parsed = parseSegments(content, texts.length);
      if (!parsed) {
        const e = new Error('大模型返回的分段编号与请求不一致，已重试');
        e.raw = String(content).slice(0, 400);
        throw e;
      }
      // 偶尔模型会「顺手」把占位符丢了，或返回空段：空段用原文兜底，避免整页缺字
      return parsed.map((t, i) => (t && t.trim() ? t.trim() : texts[i]));
    },
  };
}

// ==================== DeepL 引擎 ====================

function deepLEndpoint(settings) {
  const custom = String(settings.deeplEndpoint || '').trim();
  if (custom) return { url: custom, mode: /deeplx|1188/i.test(custom) ? 'deeplx' : 'official' };
  const key = String(settings.deeplKey || '');
  const free = key.endsWith(':fx');
  return {
    url: free ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate',
    mode: 'official',
    free,
  };
}

export function createDeepLEngine({ settings, options = {}, onLog }) {
  const key = String(settings.deeplKey || '').trim();
  const endpoint = deepLEndpoint(settings);
  if (endpoint.mode === 'official' && !key) {
    throw new Error('未配置 DeepL API Key，请在「设置 → 划词翻译 / 全文翻译」中填写');
  }
  const target = targetLangInfo(options.targetLang);
  const sourceLang = options.sourceLang && options.sourceLang !== 'auto' ? DEEPL_SOURCE[options.sourceLang] : null;
  const minInterval = Math.max(0, options.minIntervalMs ?? 120);
  // DeepL 单次往返通常几秒，给 2 分钟上限足够，挂死时也能尽快让并发池换下一批
  const timeoutMs = Number(options.requestTimeoutMs) > 0 ? Number(options.requestTimeoutMs) : 120000;
  let lastCall = 0;
  let useLegacyZh = false; // 老账号不支持 ZH-HANS，遇到 400 自动回退到 ZH

  const throttle = async (signal) => {
    const wait = lastCall + minInterval - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastCall = Date.now();
  };

  return {
    id: 'deepl',
    label: endpoint.mode === 'deeplx' ? 'DeepL（自建 DeepLX）' : 'DeepL API',
    batchLimits: {
      maxChars: 4000,
      maxItems: 25,
    },
    describe() {
      return { kind: 'deepl', mode: endpoint.mode, endpoint: endpoint.url };
    },
    async translateBatch(texts, { signal } = {}) {
      await throttle(signal);
      const targetCode = useLegacyZh && target.deeplLegacy ? target.deeplLegacy : target.deepl;

      if (endpoint.mode === 'deeplx') {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: texts,
            source_lang: sourceLang || 'auto',
            target_lang: target.deeplLegacy || 'ZH',
          }),
          signal: combineSignals(signal, timeoutMs),
        });
        if (!res.ok) {
          const e = new Error(`DeepLX 返回 ${res.status}`);
          e.status = res.status;
          if (res.status === 429) e.retryable = false;
          throw e;
        }
        const data = await res.json();
        if (Array.isArray(data?.translations)) {
          const out = texts.map((t, i) => data.translations[i]?.text?.trim() || t);
          return out;
        }
        if (typeof data?.data === 'string') {
          return texts.length === 1 ? [data.data.trim()] : null;
        }
        throw new Error('DeepLX 返回内容无法解析');
      }

      const params = new URLSearchParams();
      for (const t of texts) params.append('text', t);
      params.append('target_lang', targetCode);
      if (sourceLang) params.append('source_lang', sourceLang);
      params.append('preserve_formatting', '1');
      if (options.formality && DEEPL_FORMALITY_LANGS.has(options.targetLang)) {
        params.append('formality', options.formality);
      }
      if (options.deeplContext) params.append('context', String(options.deeplContext).slice(0, 1000));

      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `DeepL-Auth-Key ${key}`,
        },
        body: params.toString(),
        signal: combineSignals(signal, timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const e = new Error(`DeepL 返回 ${res.status}：${detail.slice(0, 200)}`);
        e.status = res.status;
        if (res.status === 400 && /target_lang/i.test(detail) && target.deeplLegacy && !useLegacyZh) {
          useLegacyZh = true; // 回退后由重试逻辑再试一次
          e.message = 'DeepL 不支持 ZH-HANS，已回退到 ZH 重试';
        } else if (res.status === 401 || res.status === 403) {
          e.retryable = false;
          e.message = 'DeepL 鉴权失败：请检查 Key 是否正确，以及 Free 版 Key（以 :fx 结尾）是否用在了免费端点';
        } else if (res.status === 456) {
          e.retryable = false;
          e.message = 'DeepL 配额已用完（456），请等待下个计费周期或更换 Key';
        } else if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after')) || 5;
          await sleep(Math.min(30000, retryAfter * 1000), signal);
        } else if (res.status === 413) {
          e.message = 'DeepL 单次请求过大（413），将拆分后重试';
        }
        throw e;
      }
      const data = await res.json();
      const list = data?.translations;
      if (!Array.isArray(list)) throw new Error('DeepL 返回内容无法解析');
      return texts.map((t, i) => (list[i]?.text || '').trim() || t);
    },
  };
}

// ==================== 对外统一入口 ====================

export function createEngine({ engine = 'auto', settings, options = {}, onLog }) {
  const kind = engine === 'auto' ? (settings.translateProvider === 'deepl' ? 'deepl' : 'llm') : engine;
  if (kind === 'deepl') return createDeepLEngine({ settings, options, onLog });
  return createLlmEngine({ settings, profileId: options.profileId, options, onLog });
}

/** 判断文本是否本身就是目标语言（已经是中文的段落不必再翻一遍） */
export function isAlreadyTarget(text, targetLang) {
  if (targetLang === 'zh' || targetLang === 'zh-tw') return cjkRatio(text) > 0.62;
  return false;
}

/**
 * 批量翻译一组片段（全文翻译的主循环）。
 * @param {object} args
 * @param {Array<{id:string,text:string}>} args.segments
 * @param {object} args.engine createEngine 的返回值
 * @param {TranslationCache} [args.cache]
 * @param {Array<{source:string,target:string}>} [args.glossary]
 * @param {number} [args.concurrency=8] 并发上限（自适应池会在 1/4 起步、逐步逼近这个上限）
 * @param {(p:object)=>void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{map: Map<string,string>, failures: Array, stats: object}>}
 */
export async function translateSegments(args) {
  const {
    segments, engine, cache, glossary = [], concurrency = 8,
    onProgress, onLog, signal, targetLang = 'zh',
  } = args;

  const stats = {
    requests: 0, retries: 0, cacheHits: 0, fallbacks: 0, chars: 0, failed: 0,
    // 并发自适应的观测值：起手几路、峰值几路、撞了几次限流
    throttled: 0, concurrencyRequested: concurrency, peakConcurrency: 0,
  };
  const map = new Map();
  const failures = [];

  // 1) 去重：同一段文字只翻一次
  const unique = new Map(); // key: 原文 -> {text, ids[], glossary hits}
  for (const seg of segments) {
    const text = String(seg.text || '').trim();
    if (!text) { map.set(seg.id, ''); continue; }
    if (isAlreadyTarget(text, targetLang)) {
      map.set(seg.id, seg.text);
      stats.fallbacks++;
      continue;
    }
    if (!unique.has(text)) unique.set(text, { text, ids: [], hits: [] });
    unique.get(text).ids.push(seg.id);
  }

  // 2) 术语表占位符保护 + 缓存查询
  const engineTag = `${engine.id}:${engine.describe?.().model || engine.describe?.().mode || ''}:${targetLang}:${args.sourceLang || 'auto'}:${sha1(JSON.stringify(glossary))}`;
  const pending = [];
  for (const item of unique.values()) {
    const protectedText = glossary.length ? protectGlossary(item.text, glossary) : { text: item.text, hits: [] };
    item.hits = protectedText.hits;
    item.payload = protectedText.text;
    const key = TranslationCache.key(engineTag, item.payload);
    const cached = cache?.get(key);
    if (cached != null) {
      item.result = cached;
      stats.cacheHits++;
    } else {
      item.cacheKey = key;
      pending.push(item);
    }
  }

  onLog?.(`共 ${segments.length} 段，去重后 ${unique.size} 段唯一文本，缓存命中 ${stats.cacheHits} 段，待翻译 ${pending.length} 段`);
  stats.chars = pending.reduce((n, it) => n + it.payload.length, 0);

  // 3) 组批
  const limits = engine.batchLimits || { maxChars: 2500, maxItems: 12 };
  const batches = [];
  let cur = [];
  let curChars = 0;
  for (const item of pending) {
    const len = item.payload.length;
    if (cur.length && (curChars + len > limits.maxChars || cur.length >= limits.maxItems)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(item);
    curChars += len;
  }
  if (cur.length) batches.push(cur);

  let completedChars = 0;
  const totalChars = Math.max(1, stats.chars);
  let completedSegments = 0;

  // 4) 自适应并发翻译（批次级重试；批次彻底失败后降级为逐段重试，尽量少丢内容）
  let rampLogs = 0;
  const poolStat = await runAdaptivePool(batches, async (batch) => {
    if (signal?.aborted) throw abortError();
    const texts = batch.map((it) => it.payload);
    let throttled = 0;
    let batchFailed = 0;
    try {
      const out = await withRetry(
        () => {
          stats.requests++;
          return engine.translateBatch(texts, { signal });
        },
        {
          attempts: 3,
          signal,
          onRetry: (e, attempt, delay) => {
            stats.retries++;
            if (isThrottleError(e)) stats.throttled++;
            onLog?.(`批次翻译失败（第 ${attempt} 次重试，${Math.round(delay / 100) / 10}s 后）：${errText(e)}`);
          },
        },
      );
      out.forEach((t, i) => { batch[i].result = t; });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      if (isThrottleError(e)) throttled++;
      onLog?.(`批次失败，降级为逐段翻译：${errText(e)}`);
      for (const item of batch) {
        try {
          const [t] = await engine.translateBatch([item.payload], { signal });
          item.result = t;
        } catch (e2) {
          item.error = errText(e2);
          stats.failed++;
          batchFailed++;
        }
      }
    }
    for (const it of batch) {
      completedSegments++;
      completedChars += it.payload.length;
      onProgress?.({
        stage: 'translate',
        percent: Math.min(99, Math.round((completedChars / totalChars) * 100)),
        done: completedSegments,
        total: pending.length,
      });
    }
    return { throttled, failed: batchFailed };
  }, {
    concurrency,
    signal,
    onAdjust: (limit, why) => {
      stats.peakConcurrency = Math.max(stats.peakConcurrency || 1, limit);
      if (rampLogs < 8) {
        rampLogs++;
        onLog?.(why === 'throttled'
          ? `接口限流，并发降到 ${limit} 路继续`
          : `传输顺畅，并发提到 ${limit} 路`);
      }
    },
  });

  stats.concurrencyRequested = concurrency;
  stats.concurrencyStart = poolStat.startLimit;
  stats.peakConcurrency = Math.max(stats.peakConcurrency || 1, poolStat.peakConcurrency);
  if (stats.requests > 0) {
    onLog?.(`并发 ${stats.concurrencyStart} → 峰值 ${stats.peakConcurrency} 路（上限 ${concurrency}），共 ${stats.requests} 次接口请求`
      + (stats.throttled ? `，其中 ${stats.throttled} 次被限流` : ''));
  }

  // 5) 还原术语表并把结果映射回每个片段
  for (const item of unique.values()) {
    let text = item.result;
    if (text == null) {
      stats.fallbacks++;
      failures.push({ ids: item.ids, error: item.error || '翻译失败，已保留原文' });
      text = item.text;
    }
    if (item.hits?.length) text = restoreGlossary(text, item.hits);
    if (item.cacheKey && item.result != null) cache?.set(item.cacheKey, item.result);
    for (const id of item.ids) map.set(id, text);
  }

  cache?.flush();
  return { map, failures, stats };
}
