// parseProgress.js —— AI 解析进度追踪（内存态）
//
// 为什么需要它：解析接口是「同步返回」的 —— 前端发起 POST 之后要等整批跑完才拿到响应，
// 中间几十秒到几分钟里界面只有一个「开始解析…」的提示，用户不知道现在跑到第几篇、
// 卡在哪一步。断网、模型超时、单篇卡住都无法区分。
//
// 做法：解析链路每推进一步就打一个点（读正文 → 调模型 → 查期刊等级 → 写库），
// 前端在 POST 还挂着的时候平行轮询 GET /api/parse/progress 取快照，画出真实进度。
// 桌面版是单用户单进程，只需要跟踪「当前这一轮」作业，不必做多任务队列。

/** 阶段 → 中文标签（前端直接用，避免两边各写一份翻译） */
export const PARSE_STAGE_LABEL = {
  queued: '排队中',
  extract: '读取 PDF 正文',
  ai: 'AI 解析中',
  rank: '核对期刊等级',
  save: '写入记录',
  done: '已完成',
  error: '解析失败',
};

/** 阶段顺序，用于「总进度」这种带权重的展示（后续可扩展成阶段级进度条） */
export const PARSE_STAGE_ORDER = ['queued', 'extract', 'ai', 'rank', 'save', 'done'];

const TITLE_MAX = 90;

function nowMs() {
  return Date.now();
}

function shortTitle(item) {
  const raw = String(item?.title || item?.fileName || item?.filePath || '').trim();
  const name = raw || '未命名文献';
  return name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX)}…` : name;
}

export function createParseTracker() {
  let job = null;

  function find(id) {
    return job ? job.items.find((it) => it.id === id) : null;
  }

  /**
   * 开一轮作业。
   * @param {Array<{id:string,title?:string,fileName?:string}>} items 本轮要解析的记录
   * @param {{label?:string, concurrency?:number}} opts label 是面板标题（例如「批量重新解析」），
   *   concurrency 是本轮并发度 —— 前端要显示「并行 6 篇」，否则用户看到一堆 queued
   *   会以为卡住了（其实是排队）。
   * @returns {string} jobId
   */
  function start(items, { label = 'AI 解析', concurrency = 1 } = {}) {
    const list = Array.isArray(items) ? items : [];
    job = {
      id: `parse-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      label,
      concurrency: Math.max(1, parseInt(concurrency, 10) || 1),
      total: list.length,
      done: 0,
      failed: 0,
      startedAt: nowMs(),
      finishedAt: null,
      items: list.map((it) => ({
        id: it.id,
        title: shortTitle(it),
        stage: 'queued',
        status: 'running',
        error: '',
        startedAt: null,
        finishedAt: null,
      })),
    };
    // 空作业直接标记结束，避免前端一直显示「解析中」
    if (!list.length) job.finishedAt = nowMs();
    return job.id;
  }

  /** 推进一步。已完成/已失败的记录不再改阶段（防止并发晚到的事件把状态改回去） */
  function setStage(id, stage) {
    const it = find(id);
    if (!it || it.status !== 'running') return;
    if (!PARSE_STAGE_LABEL[stage]) return;
    it.stage = stage;
    if (!it.startedAt) it.startedAt = nowMs();
  }

  /** 收尾：error 传空表示成功 */
  function finish(id, error) {
    const it = find(id);
    if (!it || it.status !== 'running') return;
    const failed = !!error;
    it.status = failed ? 'error' : 'done';
    it.stage = failed ? 'error' : 'done';
    it.error = failed ? String(error).slice(0, 240) : '';
    if (!it.startedAt) it.startedAt = nowMs();
    it.finishedAt = nowMs();
    job.done += 1;
    if (failed) job.failed += 1;
    if (job.done >= job.total) job.finishedAt = nowMs();
  }

  function snapshot() {
    if (!job) {
      return {
        jobId: null, label: '', running: false, total: 0, done: 0, failed: 0,
        pending: 0, percent: 0, elapsedMs: 0, concurrency: 0, current: null, active: [], items: [],
      };
    }
    const running = job.done < job.total;
    // 并行解析时同时有好几篇在跑，只回一篇（旧版的 current）会让「进行中 4 篇」
    // 看起来像「只有一篇在动」；active 是给前端画并行列表用的。
    const actives = job.items.filter((it) => it.status === 'running' && it.stage !== 'queued');
    const active = actives[0] || job.items.find((it) => it.status === 'running') || null;
    const stamp = nowMs();
    return {
      jobId: job.id,
      label: job.label,
      running,
      total: job.total,
      done: job.done,
      failed: job.failed,
      pending: Math.max(0, job.total - job.done),
      percent: job.total ? Math.round((job.done / job.total) * 100) : (running ? 0 : 100),
      concurrency: job.concurrency,
      startedAt: new Date(job.startedAt).toISOString(),
      elapsedMs: (job.finishedAt || stamp) - job.startedAt,
      current: active
        ? { id: active.id, title: active.title, stage: active.stage, stageLabel: PARSE_STAGE_LABEL[active.stage] }
        : null,
      active: actives.map((it) => ({
        id: it.id,
        title: it.title,
        stage: it.stage,
        stageLabel: PARSE_STAGE_LABEL[it.stage],
        elapsedMs: it.startedAt ? stamp - it.startedAt : 0,
      })),
      items: job.items.map((it) => ({
        id: it.id,
        title: it.title,
        stage: it.stage,
        stageLabel: PARSE_STAGE_LABEL[it.stage] || it.stage,
        status: it.status,
        error: it.error,
        elapsedMs: it.startedAt ? (it.finishedAt || stamp) - it.startedAt : 0,
      })),
    };
  }

  /** 仅测试/切数据目录时使用 */
  function reset() {
    job = null;
  }

  return { start, setStage, finish, snapshot, reset };
}
