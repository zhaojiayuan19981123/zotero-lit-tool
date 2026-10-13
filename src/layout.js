// layout.js —— PDF 版面解析作业
//
// 版面解析（把每页切成标题/正文/图表/表格/公式区域）跑在**独立子进程**里，
// 而不是主服务进程内，原因有三：
//   1. onnxruntime 是原生模块，推理瞬间峰值内存实测 ~800MB，放主进程会把
//      整个应用的内存曲线一起顶上去；
//   2. 原生推理崩了只死子进程，主服务照常跑；
//   3. 这与上游 reader 的架构一致，后续升级 rebuild 成本最低。
//
// 子进程入口是 processor/dist/main.mjs，逐页往 stdout 打 JSON 进度行。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataDir } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR_DIR = path.join(__dirname, '..', 'processor');
const ENTRY = path.join(PROCESSOR_DIR, 'dist', 'main.mjs');

/** 同一时刻只解析一篇：单页推理 ~1.6s、峰值内存 ~800MB，并发只会互相拖慢 */
const MAX_CONCURRENCY = 1;

/** 解析结果的结构版本；结构变了就 +1，前端据此丢弃旧结果 */
export const LAYOUT_SCHEMA = 1;

const jobs = new Map();      // id -> 作业状态
const listeners = new Map(); // id -> Set<fn>
const pending = [];          // 等待队列（元素为 { id })
let running = 0;
let activeChild = null;

// ---------- 路径 ----------

export function layoutDir(id) {
  return path.join(getDataDir(), 'layout', String(id));
}

export function manifestPath(id) {
  return path.join(layoutDir(id), 'manifest.json');
}

/** 找随包分发的模型文件（dist/models/*.onnx）。找不到返回 null。 */
export function findModel() {
  const dir = path.join(PROCESSOR_DIR, 'dist', 'models');
  try {
    const file = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith('.onnx'));
    return file ? path.join(dir, file) : null;
  } catch (_) {
    return null;
  }
}

/**
 * 版面解析是否可用。缺 dist 或缺模型都算不可用 —— 让调用方拿到明确原因，
 * 而不是等子进程报一堆栈。
 */
export function availability() {
  if (!fs.existsSync(ENTRY)) {
    return { ok: false, reason: '缺少版面解析程序（processor/dist/main.mjs），请重新安装应用' };
  }
  const model = findModel();
  if (!model) {
    return { ok: false, reason: '缺少版面模型（processor/dist/models/*.onnx），请重新安装应用' };
  }
  const missingPkgs = missingRuntimePackages();
  if (missingPkgs.length) {
    return {
      ok: false,
      reason: `安装包不完整：缺少版面解析运行库（${missingPkgs.join('、')}），请重新下载安装包覆盖安装`,
    };
  }
  if (!hasNativeRuntime()) {
    return {
      ok: false,
      reason: `当前平台（${process.platform}-${process.arch}）没有可用的版面推理运行时，该功能在此平台上不可用`,
    };
  }
  return { ok: true, model };
}

/**
 * 子进程**启动时就会解析**的运行时依赖（静态 import + 顶层 require.resolve）。
 * 任何一项缺失，子进程都会在解析阶段直接崩掉。
 *
 * 为什么不能只查原生二进制：v1.22.0 踩过一次 —— 打包规则 `!node_modules/**\/canvas/**`
 * 想排掉 node-canvas，却连坐把 `@napi-rs/canvas` 的 package.json 与入口文件一起删了，
 * 目录还在、内容全空。子进程崩在 `legacyMainResolve`，而 Node 构造
 * ERR_MODULE_NOT_FOUND 时撞上自己的参数个数校验 bug，最终只吐出一句
 * `ERR_INTERNAL_ASSERTION: Code: ERR_MODULE_NOT_FOUND; ...`，
 * 完全看不出真实原因。所以这里照 Node 的解析方式逐个确认入口文件真实存在。
 */
const RUNTIME_PACKAGES = [
  { name: '@napi-rs/canvas', extra: [] },
  { name: 'onnxruntime-node', extra: [] },
  // pdfjs-dist 走的是子路径：require.resolve('pdfjs-dist/package.json') + 动态 import legacy 构建
  { name: 'pdfjs-dist', extra: ['legacy/build/pdf.mjs'] },
];

function missingRuntimePackages() {
  const root = path.join(__dirname, '..', 'node_modules');
  const missing = [];
  for (const { name, extra } of RUNTIME_PACKAGES) {
    const dir = path.join(root, name);
    let entry;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      entry = pkg.main || 'index.js';
    } catch (_) {
      missing.push(name); // package.json 不在 —— 正是 v1.22.0 那种「空目录」
      continue;
    }
    if ([entry, ...extra].some((rel) => !fs.existsSync(path.join(dir, rel)))) missing.push(name);
  }
  return missing;
}


/**
 * onnxruntime 的原生绑定是按平台分发的，先确认本平台那一份在不在。
 * 不这样做的话，缺运行时的平台要等子进程起来才炸，报错信息也会变成一堆栈。
 */
function hasNativeRuntime() {
  const base = path.join(
    __dirname, '..', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6',
    process.platform, process.arch,
  );
  try {
    return fs.readdirSync(base).some((n) => n.endsWith('.node'));
  } catch (_) {
    return false;
  }
}

// ---------- 结果读取 ----------

/** 读已落盘的解析结果；没有或结构不符返回 null。 */
export function readManifest(id) {
  try {
    const raw = fs.readFileSync(manifestPath(id), 'utf8');
    const data = JSON.parse(raw);
    if (data?.schemaVersion !== LAYOUT_SCHEMA || !Array.isArray(data.blocks)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

export function hasLayout(id) {
  return !!readManifest(id);
}

export function removeLayout(id) {
  cancel(id);
  try {
    fs.rmSync(layoutDir(id), { recursive: true, force: true });
  } catch (_) { /* 目录本来就不在 */ }
}

// ---------- 作业状态 ----------

function emit(id, payload) {
  const set = listeners.get(id);
  if (!set) return;
  const data = { id, ...payload };
  for (const fn of set) {
    try { fn(data); } catch (_) { /* 订阅方自己出错不影响作业 */ }
  }
}

export function subscribe(id, fn) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(fn);
  return () => {
    const set = listeners.get(id);
    if (!set) return;
    set.delete(fn);
    if (!set.size) listeners.delete(id);
  };
}

/** 当前状态：内存里的作业优先，其次看有没有已落盘的结果。 */
export function status(id) {
  const job = jobs.get(id);
  const manifest = readManifest(id);
  if (job) {
    const out = {
      state: job.state, page: job.page || 0, pages: job.pages || 0,
      error: job.error || null, startedAt: job.startedAt || null, elapsedMs: job.elapsedMs || 0,
    };
    // 作业刚跑完时（内存里还有记录）也要顺带把结果给出去，否则前端拿到 done
    // 却还得再发一次请求才知道结果在哪。
    if (job.state === 'done' && manifest) out.manifest = manifest;
    if (job.state === 'error') jobs.delete(id); // 错误状态读一次就够，别占内存
    return out;
  }
  if (manifest) {
    return { state: 'done', page: manifest.pages || 0, pages: manifest.pages || 0, error: null, manifest };
  }
  return { state: 'none', page: 0, pages: 0, error: null };
}

function setJob(id, patch) {
  const job = jobs.get(id) || { id, state: 'queued', page: 0, pages: 0, error: null };
  Object.assign(job, patch);
  jobs.set(id, job);
  emit(id, { state: job.state, page: job.page, pages: job.pages, error: job.error, elapsedMs: job.elapsedMs });
  return job;
}

// ---------- 调度 ----------

/**
 * 启动一次解析。
 * @param {string} id 文献记录 id（同时作为输出目录名）
 * @param {string} pdfPath PDF 绝对路径
 * @param {{force?:boolean, fromPage?:number, toPage?:number}} [opts]
 */
export function start(id, pdfPath, opts = {}) {
  const avail = availability();
  if (!avail.ok) return { ok: false, error: avail.reason };
  if (!pdfPath || !fs.existsSync(pdfPath)) return { ok: false, error: '找不到该文献的 PDF 文件' };

  const existing = jobs.get(id);
  if (existing && (existing.state === 'running' || existing.state === 'queued')) {
    return { ok: true, already: true };
  }
  if (!opts.force && hasLayout(id)) return { ok: true, cached: true };

  setJob(id, { state: 'queued', page: 0, pages: 0, error: null, startedAt: Date.now(), elapsedMs: 0, pdfPath, opts });
  pending.push(id);
  pump();
  return { ok: true };
}

function pump() {
  while (running < MAX_CONCURRENCY && pending.length) {
    const id = pending.shift();
    const job = jobs.get(id);
    if (!job) continue;
    running += 1;
    runOne(job).catch(() => {}).finally(() => {
      running -= 1;
      pump();
    });
  }
}

async function runOne(job) {
  const id = job.id;
  const avail = availability();
  const dir = layoutDir(id);
  // processor 要求输出目录为空，否则拒绝写（避免覆盖用户修订稿）
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    setJob(id, { state: 'error', error: '无法创建解析目录：' + e.message });
    return;
  }

  const args = [ENTRY, '--input', job.pdfPath, '--output', dir, '--model', avail.model];
  if (Number.isInteger(job.opts?.fromPage)) args.push('--from-page', String(job.opts.fromPage));
  if (Number.isInteger(job.opts?.toPage)) args.push('--to-page', String(job.opts.toPage));

  // Electron 里 process.execPath 是 electron.exe，必须用 ELECTRON_RUN_AS_NODE 让它当纯 Node 跑；
  // 开发/CI 下（node server.js）execPath 本来就是 node，什么都不用加。
  const env = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

  setJob(id, { state: 'running', page: 0, pages: 0, error: null });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      setJob(id, { state: 'error', error: '无法启动版面解析进程：' + e.message });
      return resolve();
    }
    job.child = child;
    activeChild = child;

    let tail = '';
    const onLine = (line) => {
      const text = line.trim();
      if (!text) return;
      let msg;
      try { msg = JSON.parse(text); } catch (_) { tail = (tail + ' ' + text).slice(-2000); return; }
      if (msg.event === 'page') {
        setJob(id, { page: msg.page || 0, pages: msg.total || 0 });
      } else if (msg.event === 'done') {
        setJob(id, { pages: msg.pages || 0, elapsedMs: msg.elapsedMilliseconds || 0 });
      }
    };
    // processor 的 stdout 是「一行一个 JSON」，但管道的分片不保证按行，必须自己缓冲拼接。
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    child.stderr.on('data', (chunk) => { tail = (tail + chunk.toString('utf8')).slice(-2000); });

    child.on('error', (e) => {
      job.child = null;
      activeChild = null;
      setJob(id, { state: 'error', error: '版面解析进程启动失败：' + e.message });
      resolve();
    });

    child.on('close', (code) => {
      job.child = null;
      activeChild = null;
      if (job.cancelled) {
        jobs.delete(id);
        emit(id, { state: 'none', page: 0, pages: 0, error: null });
        return resolve();
      }
      const manifest = readManifest(id);
      if (code === 0 && manifest) {
        setJob(id, { state: 'done', page: manifest.pages || 0, pages: manifest.pages || 0 });
      } else {
        const detail = (tail || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        setJob(id, { state: 'error', error: detail || `版面解析失败（退出码 ${code}）` });
      }
      resolve();
    });
  });
}

/** 取消正在排队/运行的任务 */
export function cancel(id) {
  const queued = pending.indexOf(id);
  if (queued >= 0) {
    pending.splice(queued, 1);
    jobs.delete(id);
    emit(id, { state: 'none', page: 0, pages: 0, error: null });
    return true;
  }
  const job = jobs.get(id);
  if (job && job.child) {
    job.cancelled = true;
    try { job.child.kill(); } catch (_) { /* 进程可能刚退出 */ }
    return true;
  }
  return false;
}

/** 进程退出前收尾，避免留下孤儿子进程（Windows 上父进程退出不会带走子进程） */
export function shutdown() {
  for (const job of jobs.values()) {
    if (job.child) { try { job.child.kill(); } catch (_) { /* ignore */ } }
  }
  if (activeChild) {
    try { activeChild.kill(); } catch (_) { /* ignore */ }
  }
}

process.once('exit', shutdown);
process.once('SIGINT', () => { shutdown(); process.exit(0); });
process.once('SIGTERM', () => { shutdown(); process.exit(0); });

/** 已解析块的静态资源根目录（供 express.static 用） */
export function assetsDir(id) {
  return path.join(layoutDir(id), 'assets');
}
