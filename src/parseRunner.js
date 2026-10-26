// parseRunner.js —— 批量 AI 解析执行器（有限并发 + 单篇看门狗 + 失败隔离）
//
// 为什么需要它：v1.29 的批量解析是 `Promise.all` 套一个游标循环，三个坑都表现成
// 「这篇文献一直卡在解析中」：
//
//   ① 单篇没有时限。LLM 请求用的是裸 fetch，没有 AbortSignal —— 上游半死不活
//      （连接建起来但不返回、公司网关吞包、代理挂着）时 Promise 永不 settle。
//      这一篇永远停在 parsing，整批永远不结束，进度浮层永远转圈。
//   ② 一个 task 抛错就整批停。`Promise.all` 遇到第一个 reject 立即向外抛，
//      游标里剩下排队的篇目再也不会被取出来 —— 它们的状态就停在 queued/parsing。
//   ③ 没有退出清场。status='parsing' 是要落盘的，用户杀掉进程/应用崩溃之后，
//      这条记录在库里永远是 parsing，而「解析全部」又明确跳过 parsing，
//      于是它再也没机会被重跑 —— 这是「一直卡着」最顽固的一种。
//
// 这里把「并发池 + 单篇总时限 + 失败不外溢」做成一个通用执行器，三个解析入口共用。
// 约定：runParseBatch **永远不 reject**，逐篇在结果里标 ok / error / timedOut，
// 调用方只需要看结果，不需要再包 try/catch。

import { randomUUID } from 'node:crypto';

/** 并发度上下限：4~8 是实测甜点（LLM 是 IO 等待，6 路并行能把一整批的墙上时间压到 1/4） */
export const PARSE_CONCURRENCY_MIN = 1;
export const PARSE_CONCURRENCY_MAX = 8;
export const PARSE_CONCURRENCY_DEFAULT = 6;

/** 单篇默认预算：AI 单次超时（默认 180 秒）+ 正文抽取 / 查期刊等级的余量 */
const DEFAULT_ITEM_TIMEOUT_MS = 6 * 60 * 1000;
const MIN_ITEM_TIMEOUT_MS = 60 * 1000;
const MAX_ITEM_TIMEOUT_MS = 30 * 60 * 1000;

export class ParseTimeoutError extends Error {
  constructor(ms) {
    super(`单篇解析超过 ${Math.max(1, Math.round(ms / 60000))} 分钟仍未完成，已中止（其他篇不受影响）`);
    this.name = 'ParseTimeoutError';
    this.code = 'PARSE_TIMEOUT';
    this.timeoutMs = ms;
  }
}

/** 把任意并发参数收进 [1, 8]，非法值退回默认 */
export function clampParseConcurrency(value, fallback = PARSE_CONCURRENCY_DEFAULT) {
  const asNum = typeof value === 'string' ? parseInt(value, 10) : value;
  if (!Number.isFinite(asNum) || asNum <= 0) {
    const fb = Number.isFinite(fallback) && fallback > 0 ? fallback : PARSE_CONCURRENCY_DEFAULT;
    return Math.min(PARSE_CONCURRENCY_MAX, Math.max(PARSE_CONCURRENCY_MIN, Math.round(fb)));
  }
  return Math.min(PARSE_CONCURRENCY_MAX, Math.max(PARSE_CONCURRENCY_MIN, Math.round(asNum)));
}

/**
 * 单篇预算解析。
 * - 显式传参（服务端按「AI 超时 + 余量」算好的值）只做安全夹 [200ms, 30min]，
 *   这样单测可以把预算压到几百毫秒而不用真等 6 分钟；
 * - 环境变量 / 默认值走更严格的 [1min, 30min]，免得有人把 PARSE_ITEM_TIMEOUT_MS
 *   误配成 3 秒，导致所有正常文献都被判超时。
 */
export function resolveItemTimeoutMs(explicit) {
  const asNum = Number(explicit);
  if (Number.isFinite(asNum) && asNum > 0) {
    return Math.min(MAX_ITEM_TIMEOUT_MS, Math.max(200, Math.round(asNum)));
  }
  const fromEnv = parseInt(process.env.PARSE_ITEM_TIMEOUT_MS, 10);
  const raw = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_ITEM_TIMEOUT_MS;
  return Math.min(MAX_ITEM_TIMEOUT_MS, Math.max(MIN_ITEM_TIMEOUT_MS, Math.round(raw)));
}

// ---------- 正在解析的记录登记处 ----------
// 进程内唯一可信的「此刻真的在跑」名单。库里 status==='parsing' 只说明「上次开始过」，
// 进程重启/超时放弃之后它会骗人，所以判断「要不要跳过」一律以这个集合为准。
const activeIds = new Set();

export function isParseActive(id) {
  return activeIds.has(String(id));
}

export function activeParseCount() {
  return activeIds.size;
}

export function activeParseIds() {
  return [...activeIds];
}

/** 仅测试/切数据目录使用：清空登记表 */
export function resetActiveParses() {
  activeIds.clear();
}

/**
 * 单篇作业句柄：交给 worker（parseRecord）用来「知道自己还有没有资格继续」。
 * - signal：传给 fetch / 下游可中断的调用，超时时真正掐断连接；
 * - assertLive()：在每个 await 之后调用，已超时就抛 ParseTimeoutError，
 *   避免「已经判定超时、界面上标成失败」之后后台又把结果写回库里。
 */
export function createParseJob(id, timeoutMs) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const job = {
    id: String(id),
    timeoutMs,
    signal: controller.signal,
    startedAt,
    expired: false,
    get elapsedMs() { return Date.now() - startedAt; },
    assertLive() {
      if (job.expired || controller.signal.aborted) throw new ParseTimeoutError(timeoutMs);
    },
    abort() {
      if (job.expired) return;
      job.expired = true;
      try { controller.abort(new ParseTimeoutError(timeoutMs)); } catch (_) { /* 老运行时忽略 */ }
    },
  };
  return job;
}

/**
 * 批量执行：并发跑 worker(item, job)，每篇独立计时，失败/超时都不影响其他篇。
 *
 * @param {Array<object>} items 待处理条目（要求有唯一 id）
 * @param {(item:object, job:object)=>Promise<any>} worker 单篇处理函数
 * @param {object} [opts]
 * @param {number} [opts.concurrency] 并发度（1~8，默认 6）
 * @param {number} [opts.itemTimeoutMs] 单篇预算
 * @param {(item:object)=>void} [opts.onItemStart] 开始一篇（用于登记 / 上报进度）
 * @param {(outcome:object)=>void} [opts.onItemDone] 一篇结束（成功或失败）
 * @returns {Promise<{results:Array<object>, concurrency:number, itemTimeoutMs:number, elapsedMs:number, ok:number, failed:number, timedOut:number}>}
 */
export async function runParseBatch(items, worker, opts = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const concurrency = clampParseConcurrency(opts.concurrency);
  const itemTimeoutMs = resolveItemTimeoutMs(opts.itemTimeoutMs);
  const results = new Array(list.length);
  const startedAll = Date.now();
  let cursor = 0;

  async function runOne(item, index) {
    const id = String(item?.id ?? `idx-${index}`);
    const job = createParseJob(id, itemTimeoutMs);
    const startedAt = Date.now();
    let timer = null;
    let timeoutReject = null;

    // 看门狗：到点就 abort（掐断 fetch）+ 让 Promise.race 立刻结束，
    // 不等那个可能永远不返回的底层 Promise。
    const watchdog = new Promise((_, reject) => {
      timeoutReject = reject;
      timer = setTimeout(() => {
        job.abort();
        reject(new ParseTimeoutError(itemTimeoutMs));
      }, itemTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    let outcome;
    try {
      try { opts.onItemStart?.(item); } catch (_) { /* 进度上报失败不能影响解析 */ }
      const value = await Promise.race([
        Promise.resolve().then(() => worker(item, job)),
        watchdog,
      ]);
      outcome = { item, ok: true, value, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      // 失败/超时之后一律掐断：底层的 fetch 不该继续占着连接和配额
      job.abort();
      outcome = {
        item,
        ok: false,
        error,
        timedOut: error instanceof ParseTimeoutError || error?.code === 'PARSE_TIMEOUT',
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
      timeoutReject = null; // 别留着闭包引用，长批次下会攒住整批任务对象
    }
    results[index] = outcome;
    try { opts.onItemDone?.(outcome); } catch (_) { /* 收尾上报同样不阻塞别人 */ }
    // 收尾后才从登记表里摘掉：期间重复点击/重复批次会被 isParseActive 挡住
    activeIds.delete(id);
    return outcome;
  }

  const runnerCount = Math.min(concurrency, list.length);
  // 整批先"占位"再开跑：排队中（还没轮到）的篇目也算「本轮已认领」。
  // 不然用户连着点两次「解析全部」时，第二批会把第一批还在排队的篇目当成"没人在跑"
  // 再跑一遍 —— 同一篇被两个批次并行写，AI 白花钱、字段互相覆盖。
  for (const it of list) {
    const id = it?.id == null ? '' : String(it.id);
    if (id) activeIds.add(id);
  }
  const runners = Array.from({ length: runnerCount }, async () => {
    while (cursor < list.length) {
      const index = cursor++;
      await runOne(list[index], index);
    }
  });
  // runOne 自己吞掉所有异常，这里等的是「队列排空」，不会因为单篇失败提前退出
  await Promise.all(runners);

  const finished = results.filter(Boolean);
  return {
    results: finished,
    concurrency,
    itemTimeoutMs,
    elapsedMs: Date.now() - startedAll,
    ok: finished.filter((r) => r.ok).length,
    failed: finished.filter((r) => !r.ok).length,
    timedOut: finished.filter((r) => r.timedOut).length,
  };
}

// ---------- 僵尸 parsing 的识别 ----------

export const PARSE_INTERRUPTED_MESSAGE = '上次解析被中断（应用退出 / 请求断开 / 超时未收尾），可重新解析这篇';

/**
 * 从记录列表里挑出「库里写着 parsing、但此刻没人在跑」的僵尸记录。
 * 纯函数，便于直接单测。
 *
 * @param {Array<object>} records 文献记录
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.maxAgeMs] 未带 parseStartedAt 的老记录按「未知开始时间」处理
 * @param {(id:string)=>boolean} [opts.isActive]
 * @param {boolean} [opts.all] 进程刚起来时用 true：内存里必然是空的，全部视为中断
 * @returns {Array<object>} 需要重置为 error 的记录
 */
export function pickStaleParsing(records, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0 ? opts.maxAgeMs : DEFAULT_ITEM_TIMEOUT_MS;
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : isParseActive;
  const all = opts.all === true;
  return (Array.isArray(records) ? records : []).filter((it) => {
    if (!it || it.status !== 'parsing') return false;
    if (isActive(it.id)) return false;             // 真的在跑，别动
    if (all) return true;
    const started = it.parseStartedAt ? Date.parse(it.parseStartedAt) : 0;
    if (!started || Number.isNaN(started)) return true; // 老版本留下的，没有开始时间，必然是僵尸
    return now - started > maxAgeMs;
  });
}

/** 给记录生成一个不会重复的解析批次号（用于日志排查 / 前端忽略旧快照） */
export function newParseRunId() {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
