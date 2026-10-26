// pdfTextPool.js —— PDF 文本抽取的 worker 线程池
//
// 为什么需要：pdf.js 抽取一篇 150 页学位论文要几秒到十几秒，而且几乎全程占着
// CPU 不给事件循环让路。原来它跑在主线程，解析期间所有 HTTP 请求（包括读取进度
// 的 /api/parse/progress）都要排队到抽完才能响应 —— 进度条因此形同虚设。
// 挪到 worker 线程后，主线程空出来服务请求，同时多篇 PDF 能真正并行抽取。
//
// 设计取舍：
//   · 池子上限默认 4（最多 6）：AI 解析默认 6 路并行，前面几篇会同时进入「抽正文」阶段，
//     只给 2 个线程的话它们要排队，等于把并行的好处浪费在第一阶段；4 个线程在 8 核机器上
//     既吃得下并发，又不会互相抢核到反而变慢（8 核以下会自动降到更小的值）；
//   · 空闲 60 秒自动回收，不常驻占内存；
//   · 单篇 4 分钟超时：扫描件/损坏文件可能把 pdf.js 卡死，超时就杀掉这个线程重开；
//   · 线程起不来（某些打包环境限制 worker）时由调用方退回主线程，功能绝不因此丢失。
import os from 'node:os';
import { Worker } from 'node:worker_threads';

const CPU_COUNT = (os.cpus() || []).length || 2;
const MAX_WORKERS = Math.max(1, Math.min(6, parseInt(process.env.PDF_TEXT_WORKERS, 10) || Math.min(4, Math.max(2, CPU_COUNT - 1))));
const JOB_TIMEOUT_MS = Math.max(30000, parseInt(process.env.PDF_TEXT_TIMEOUT_MS, 10) || 240000);
const IDLE_TTL_MS = 60000;

const idle = [];              // 空闲 worker 队列
const busy = new Map();       // worker -> { resolve, reject, timer }
const queue = [];             // 待处理任务
let jobSeq = 0;
let disabled = false;         // 线程池不可用时置 true，后续直接走主线程

const idleTimers = new Map();

function scheduleIdleCleanup(w) {
  clearTimeout(idleTimers.get(w));
  const timer = setTimeout(() => {
    idleTimers.delete(w);
    const i = idle.indexOf(w);
    if (i >= 0) idle.splice(i, 1);
    try { w.terminate(); } catch (_) { /* ignore */ }
  }, IDLE_TTL_MS);
  // 回收定时器不该拉着进程不让退出（Electron 关窗、单测收尾都会因此多等一分钟）
  if (typeof timer.unref === 'function') timer.unref();
  idleTimers.set(w, timer);
}

function settle(worker, err, data) {
  const job = busy.get(worker);
  if (!job) return false;
  clearTimeout(job.timer);
  busy.delete(worker);
  if (err) job.reject(err); else job.resolve(data);
  return true;
}

function dropWorker(worker) {
  const i = idle.indexOf(worker);
  if (i >= 0) idle.splice(i, 1);
  clearTimeout(idleTimers.get(worker));
  idleTimers.delete(worker);
  try { worker.terminate(); } catch (_) { /* ignore */ }
}

function createWorker() {
  const worker = new Worker(new URL('./pdfTextWorker.js', import.meta.url));
  worker.on('message', (msg) => {
    if (!msg) return;
    if (msg.ok) {
      settle(worker, null, msg.data);
      idle.push(worker);
      scheduleIdleCleanup(worker);
    } else {
      // 业务错误：把消息原样交给调用方（不回退，否则等于对同一份坏文件再跑一遍）
      const err = new Error(msg.error || 'PDF 文本抽取失败');
      err.pdfParseError = true;
      settle(worker, err);
      idle.push(worker);
      scheduleIdleCleanup(worker);
    }
    pump();
  });
  const onFail = (e) => {
    const err = e instanceof Error ? e : new Error(String(e));
    const hadJob = settle(worker, err);
    dropWorker(worker);
    // 线程级故障：本次任务已经失败，让调用方退回主线程重试；池子继续可用
    if (hadJob) pump();
  };
  worker.on('error', onFail);
  worker.on('exit', (code) => {
    if (code !== 0) onFail(new Error(`PDF 抽取线程异常退出（code ${code}）`));
    else dropWorker(worker);
  });
  // 不让空闲线程拖住进程退出（Electron 关闭时尤其明显）
  if (typeof worker.unref === 'function') worker.unref();
  return worker;
}

function start(worker, job) {
  const timer = setTimeout(() => {
    const pending = busy.get(worker);
    if (!pending) return;
    busy.delete(worker);
    const err = new Error('PDF 文本抽取超时，已放弃这篇（可稍后重试或检查文件是否损坏）');
    err.pdfParseError = true;
    pending.reject(err);
    dropWorker(worker);
    pump();
  }, JOB_TIMEOUT_MS);
  busy.set(worker, { resolve: job.resolve, reject: job.reject, timer });
  try {
    worker.postMessage({ id: job.id, filePath: job.filePath });
  } catch (e) {
    clearTimeout(timer);
    busy.delete(worker);
    dropWorker(worker);
    job.reject(e);
  }
}

function pump() {
  while (queue.length) {
    let worker = idle.pop();
    if (!worker) {
      if (idle.length + busy.size >= MAX_WORKERS) return;
      try {
        worker = createWorker();
      } catch (e) {
        disabled = true;
        const rest = queue.splice(0, queue.length);
        for (const job of rest) job.reject(e);
        return;
      }
    } else {
      clearTimeout(idleTimers.get(worker));
      idleTimers.delete(worker);
    }
    const job = queue.shift();
    start(worker, job);
  }
}

/**
 * 在线程池里抽一段 PDF 的文本。
 * 返回的 Promise 只在「线程级故障」或「业务错误」时 reject；两种情况用 err.pdfParseError 区分。
 */
export function extractPdfTextOffThread(filePath) {
  if (disabled || process.env.PDF_TEXT_INPROCESS === '1') {
    return Promise.reject(Object.assign(new Error('PDF 抽取线程池不可用'), { pdfPoolDisabled: true }));
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: (jobSeq += 1), filePath, resolve, reject });
    pump();
  });
}

/** 进程退出/测试收尾时主动清空线程池 */
export async function shutdownPdfTextPool() {
  const all = [...idle, ...busy.keys()];
  idle.length = 0;
  busy.clear();
  for (const t of idleTimers.values()) clearTimeout(t);
  idleTimers.clear();
  await Promise.all(all.map((w) => w.terminate().catch(() => {})));
}

/** 供单测/诊断查看池子状态 */
export function pdfTextPoolStatus() {
  return { max: MAX_WORKERS, idle: idle.length, busy: busy.size, queued: queue.length, disabled, timeoutMs: JOB_TIMEOUT_MS };
}
