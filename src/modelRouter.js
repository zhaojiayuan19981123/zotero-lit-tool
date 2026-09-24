// modelRouter.js —— 模型路由：故障转移 + 熔断 + 用量统计
//
// 背景（借鉴 cc-switch 的「路由服务」思路，适配到本应用）：
//   本应用此前「一个时刻只用一条模型配置」，那条中转抽风（429 / 5xx / 超时 / 网关返回网页）
//   整个 AI 功能就一起失败。这里把已保存的多条模型配置组织成一条**优先级队列**：
//   请求先发主供应商，失败就按顺序换下一家，连续失败的供应商进入**熔断**、
//   冷却期过后再半开试探恢复；全过程记录用量，供「模型路由」面板展示。
//
// 设计原则：
//   1) 全部时间点通过参数 now 注入 —— 熔断状态机才能在单测里被精确验证，不靠 sleep；
//   2) 只做决策与记账，不碰网络 —— 发请求的事留在 server.js；
//   3) 默认配置下行为与「不开路由」完全一致：队列为空时只有主供应商一个候选。

export const CIRCUIT = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'halfOpen' };

// 面板上用来提示输入范围的上下界（前后端共用同一份，避免两边写不一致）
export const ROUTER_LIMITS = {
  failThreshold: [1, 20],
  recoverSuccess: [1, 10],
  openSeconds: [0, 300],
  errorRate: [0, 100],
  minRequests: [5, 100],
  retryPerProvider: [0, 10],
  logLimit: [20, 1000],
  queue: 20,
};

export const DEFAULT_ROUTER_CONFIG = {
  // 默认开启：队列为空时等价于「只用主供应商」，但用量统计与健康面板立即开始工作。
  enabled: true,
  // 自动故障转移：失败时按队列换下一家（关闭则只记录失败、不切换）
  failover: true,
  // 备用供应商的 profileId，按顺序尝试；主供应商不在此列表里（它是「当前激活/本次指定」的那条）
  queue: [],
  // 同一供应商失败后的额外重试次数（0 = 失败直接换下一家；同一条内部的端点回退由 server.js 负责）
  retryPerProvider: 0,
  // 请求日志条数上限
  logLimit: 200,
  breaker: {
    failThreshold: 4,   // 连续失败多少次触发熔断
    recoverSuccess: 2,  // 半开状态下成功多少次后恢复
    openSeconds: 60,    // 熔断后多久允许半开试探
    errorRate: 60,      // 错误率超过该值（%）也触发熔断
    minRequests: 10,    // 计算错误率前的最小请求数
  },
};

// 数值一律钳制到合法范围。null / undefined / 空串 / 非数值文本都视为「用户没填」→ 回落默认，
// 而不是被 Number() 悄悄变成 0（null → 0 会让「恢复成功阈值」变成 1，与默认值不符）。
function clampInt(value, [min, max], fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeBreaker(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_ROUTER_CONFIG.breaker;
  return {
    failThreshold: clampInt(b.failThreshold, ROUTER_LIMITS.failThreshold, d.failThreshold),
    recoverSuccess: clampInt(b.recoverSuccess, ROUTER_LIMITS.recoverSuccess, d.recoverSuccess),
    openSeconds: clampInt(b.openSeconds, ROUTER_LIMITS.openSeconds, d.openSeconds),
    errorRate: clampInt(b.errorRate, ROUTER_LIMITS.errorRate, d.errorRate),
    minRequests: clampInt(b.minRequests, ROUTER_LIMITS.minRequests, d.minRequests),
  };
}

export function normalizeRouterConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rawQueue = Array.isArray(r.queue) ? r.queue : [];
  const seen = new Set();
  const queue = [];
  for (const item of rawQueue) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    queue.push(id);
    if (queue.length >= ROUTER_LIMITS.queue) break;
  }
  const d = DEFAULT_ROUTER_CONFIG;
  return {
    enabled: r.enabled === undefined ? d.enabled : !!r.enabled,
    failover: r.failover === undefined ? d.failover : !!r.failover,
    queue,
    retryPerProvider: clampInt(r.retryPerProvider, ROUTER_LIMITS.retryPerProvider, d.retryPerProvider),
    logLimit: clampInt(r.logLimit, ROUTER_LIMITS.logLimit, d.logLimit),
    breaker: normalizeBreaker(r.breaker),
  };
}

/** 从 settings 里读路由配置（settings.modelRouter 缺省时用默认值） */
export function readRouterConfig(settings) {
  return normalizeRouterConfig(settings?.modelRouter);
}

// ---------------- 运行时状态（内存，随进程生命周期） ----------------

export function createRouterState(config = DEFAULT_ROUTER_CONFIG) {
  return {
    config: normalizeRouterConfig(config),
    startedAt: Date.now(),
    totalRequests: 0,      // 路由处理过的「用户请求」数（一次请求内部可能试过多家供应商）
    successRequests: 0,
    failRequests: 0,
    activeConnections: 0,  // 正在处理中的请求数
    failovers: 0,          // 累计切换次数
    providers: new Map(),  // profileId -> 供应商状态
    logs: [],
  };
}

/** 配置可能在运行中被用户改（设置保存后调用） */
export function applyRouterConfig(state, config) {
  state.config = normalizeRouterConfig(config);
  return state.config;
}

function blankProvider() {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    circuit: CIRCUIT.CLOSED,
    openUntil: 0,
    halfOpenSuccesses: 0,
    lastError: '',
    lastLatencyMs: 0,
    lastAt: 0,
  };
}

export function getProviderState(state, id) {
  const key = String(id || '');
  if (!state.providers.has(key)) state.providers.set(key, blankProvider());
  return state.providers.get(key);
}

function openCircuit(p, breaker, now) {
  p.circuit = CIRCUIT.OPEN;
  p.openUntil = now + breaker.openSeconds * 1000;
  p.halfOpenSuccesses = 0;
}

/**
 * 这家现在能不能用。
 * - 关闭：可用
 * - 开启且冷却已到：转「半开」并放行（这次请求就是试探）
 * - 开启且还在冷却：不可用
 * - 半开：放行（成功则计一次恢复，失败则重新开启）
 */
export function canUse(state, id, now = Date.now()) {
  const p = getProviderState(state, id);
  if (p.circuit === CIRCUIT.OPEN) {
    if (now >= p.openUntil) {
      p.circuit = CIRCUIT.HALF_OPEN;
      p.halfOpenSuccesses = 0;
      return true;
    }
    return false;
  }
  return true;
}

export function noteSuccess(state, id, { latencyMs = 0 } = {}, now = Date.now()) {
  const p = getProviderState(state, id);
  p.requests += 1;
  p.successes += 1;
  p.consecutiveFailures = 0;
  p.lastError = '';
  p.lastLatencyMs = Math.max(0, Math.round(Number(latencyMs) || 0));
  p.lastAt = now;
  if (p.circuit === CIRCUIT.HALF_OPEN) {
    p.halfOpenSuccesses += 1;
    if (p.halfOpenSuccesses >= state.config.breaker.recoverSuccess) {
      p.circuit = CIRCUIT.CLOSED;
      p.halfOpenSuccesses = 0;
    }
  } else if (p.circuit === CIRCUIT.OPEN) {
    // 正常流程里不会调用熔断中的供应商；走到这里说明是「全部熔断、强制尝试」那一支，
    // 而这次调用真的成功了 —— 这是它可用的直接证据，直接恢复正常，别继续挂着红灯。
    p.circuit = CIRCUIT.CLOSED;
    p.halfOpenSuccesses = 0;
  }
  return p.circuit;
}

export function noteFailure(state, id, { status = 0, message = '', latencyMs = 0, kind = '' } = {}, now = Date.now()) {
  const p = getProviderState(state, id);
  const breaker = state.config.breaker;
  const wasHalfOpen = p.circuit === CIRCUIT.HALF_OPEN;
  p.requests += 1;
  p.failures += 1;
  p.consecutiveFailures += 1;
  p.lastError = String(message || '').slice(0, 300);
  p.lastLatencyMs = Math.max(0, Math.round(Number(latencyMs) || 0));
  p.lastAt = now;
  p.lastStatus = Number(status) || 0;
  p.lastKind = String(kind || '');
  const errorRate = p.requests >= breaker.minRequests ? (p.failures / p.requests) * 100 : 0;
  const tripped = wasHalfOpen
    || p.consecutiveFailures >= breaker.failThreshold
    || (p.requests >= breaker.minRequests && errorRate >= breaker.errorRate);
  if (tripped) openCircuit(p, breaker, now);
  return p.circuit;
}

export function providerHealth(p) {
  if (!p) return 'ok';
  if (p.circuit === CIRCUIT.OPEN) return 'open';
  if (p.circuit === CIRCUIT.HALF_OPEN) return 'halfOpen';
  if (p.consecutiveFailures > 0) return 'warn';
  return 'ok';
}

// ---------------- 候选队列规划 ----------------

/**
 * 候选必须有稳定 id：调用方（如「测试连接」接口）可能传一份临时拼出来的配置，它没有 id。
 * 没有 id 就不能作为统计/熔断的键，这里按 label/model 补一个，保证后续记账不丢。
 */
function ensureId(profile) {
  if (!profile) return null;
  if (profile.id) return profile;
  const id = String(profile.label || profile.model || '').trim();
  return { ...profile, id: id ? 'anon:' + id : 'anon:unnamed' };
}

/**
 * 规划这次请求要按顺序尝试哪些供应商。
 *
 * @param {object}   preferred   主供应商（本次指定 / 全局激活的那条，已 describeProfile 过）
 * @param {Function} resolveById profileId -> 已解析的 profile（无 Key / 已删除返回 null）
 * @returns {{candidates: object[], forced: boolean, skipped: number}}
 *   forced=true 表示所有候选都在熔断中，此时仍按原顺序尝试（宁可试一把，也别把错误藏起来）
 */
export function planCandidates({ preferred, resolveById, state, now = Date.now() }) {
  const config = state.config;
  const ordered = [];
  const seen = new Set();
  const push = (raw) => {
    const p = ensureId(raw);
    if (p && p.id && !seen.has(p.id)) { seen.add(p.id); ordered.push(p); }
  };
  push(preferred);
  const main = preferred ? ensureId(preferred) : null;
  if (config.enabled && config.failover) {
    for (const id of config.queue) push(resolveById ? resolveById(id) : null);
  }
  // 视觉对齐：主供应商需要看图时，备用也必须是视觉模型（否则换过去等于答非所问）
  const needVision = main?.vision === true;
  const eligible = needVision ? ordered.filter((p) => p.vision === true) : ordered;
  const usable = eligible.filter((p) => canUse(state, p.id, now));
  if (usable.length) return { candidates: usable, forced: false, skipped: eligible.length - usable.length };
  return { candidates: eligible, forced: eligible.length > 0, skipped: 0 };
}

// ---------------- 失败分类 ----------------

/**
 * 判断一次失败属于什么性质，便于日志可读、也便于将来按类型定制策略。
 * 注意：这里刻意**不**把 400 参数错误排除在故障转移之外 ——
 * 各家中转对同一份报文宽容度不同（如 assistant 是否接受 output_text），
 * 换一家往往就能过；真要是我们自己的报文写错了，最终错误里会把每家的原因都列出来。
 */
export function classifyFailure({ status = 0, message = '', html = false, aborted = false, timeout = false } = {}) {
  if (aborted) return 'aborted';
  if (timeout) return 'timeout';
  if (html) return 'html';
  const code = Number(status) || 0;
  if (code === 401 || code === 403) return 'auth';
  if (code === 404 || code === 405 || code === 415 || code === 501) return 'endpoint';
  if (code === 408) return 'timeout';
  if (code === 429) return 'rate-limit';
  if (code >= 500) return 'server';
  if (code === 400 || code === 422) return 'param';
  if (!code) return 'network';
  return 'unknown';
}

/** 哪些失败值得换下一家。客户端主动中止、以及本地配置问题不换。 */
export function shouldFailover({ kind = '', aborted = false } = {}) {
  if (aborted) return false;
  if (kind === 'aborted' || kind === 'config') return false;
  return true;
}

// ---------------- 记账：请求、日志、快照 ----------------

export function noteRequestStart(state, now = Date.now()) {
  state.totalRequests += 1;
  state.activeConnections += 1;
  return { startedAt: now, failovers: 0, tries: [] };
}

export function noteRequestEnd(state, ctx, { ok, error = '' } = {}) {
  state.activeConnections = Math.max(0, state.activeConnections - 1);
  if (ok) state.successRequests += 1;
  else state.failRequests += 1;
  return { ok: !!ok, error: String(error || ''), failovers: ctx?.failovers || 0 };
}

export function noteFailover(state) {
  state.failovers += 1;
}

export function recordLog(state, entry, now = Date.now()) {
  const limit = state.config.logLimit;
  state.logs.push({ at: new Date(now).toISOString(), ...entry });
  if (state.logs.length > limit) state.logs.splice(0, state.logs.length - limit);
}

export function successRateOf(state) {
  if (!state.totalRequests) return null;
  return Number(((state.successRequests / state.totalRequests) * 100).toFixed(1));
}

/**
 * 给「模型路由」面板用的快照。
 * @param {object[]} profiles 当前设置里的全部模型配置（用于展示没被请求过的供应商）
 */
export function snapshot(state, { profiles = [], now = Date.now() } = {}) {
  const known = new Map();
  for (const p of profiles) known.set(String(p.id), { id: p.id, label: p.label, model: p.model, providerName: p.providerName });
  for (const [id, st] of state.providers) {
    if (!known.has(id)) {
      known.set(id, { id, label: st.lastLabel || '（已删除的模型）', model: '', providerName: '' });
    }
  }
  const providers = [...known.values()].map((meta) => {
    const st = state.providers.get(String(meta.id)) || blankProvider();
    const rate = st.requests ? Number(((st.successes / st.requests) * 100).toFixed(1)) : null;
    return {
      ...meta,
      requests: st.requests,
      successes: st.successes,
      failures: st.failures,
      successRate: rate,
      consecutiveFailures: st.consecutiveFailures,
      circuit: st.circuit,
      health: providerHealth(st),
      openUntil: st.openUntil || 0,
      lastError: st.lastError || '',
      lastStatus: st.lastStatus || 0,
      lastKind: st.lastKind || '',
      lastLatencyMs: st.lastLatencyMs || 0,
      lastAt: st.lastAt || 0,
    };
  });
  return {
    startedAt: state.startedAt,
    uptimeMs: Math.max(0, now - state.startedAt),
    totalRequests: state.totalRequests,
    successRequests: state.successRequests,
    failRequests: state.failRequests,
    activeConnections: state.activeConnections,
    failovers: state.failovers,
    successRate: successRateOf(state),
    config: state.config,
    providers,
    logs: state.logs.slice(-state.config.logLimit).reverse(),
  };
}

/** 重置统计。计数与日志一律清空；keepBreakers=true 时额外保留熔断状态。 */
export function resetRouterState(state, { keepBreakers = false, now = Date.now() } = {}) {
  state.startedAt = now;
  state.totalRequests = 0;
  state.successRequests = 0;
  state.failRequests = 0;
  state.activeConnections = 0;
  state.failovers = 0;
  state.logs = [];
  for (const p of state.providers.values()) {
    p.requests = 0;
    p.successes = 0;
    p.failures = 0;
    p.consecutiveFailures = 0;
    p.lastError = '';
    p.lastStatus = 0;
    p.lastKind = '';
    p.lastLatencyMs = 0;
    if (!keepBreakers) {
      p.circuit = CIRCUIT.CLOSED;
      p.openUntil = 0;
      p.halfOpenSuccesses = 0;
    }
  }
  return state;
}
