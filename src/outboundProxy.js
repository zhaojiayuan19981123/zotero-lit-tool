// outboundProxy.js —— 「出站代理」配置与自动探测。
//
// 需求背景：有些上游（OpenAI 系、或某些中转）直连不通，本机上却已经跑着 v2rayN / Clash /
// sing-box 这类软件在 10809 / 7890 等端口提供 HTTP 代理。手动去填地址太麻烦，所以默认自动探测。
//
// ★ 关键设计取舍：**默认（auto）是「直连优先，连不上才走代理」**，而不是「一律走代理」。
//   原因：用户同时配着国内中转（siliconflow、火山 ark 等），把国内流量也塞进代理会变慢甚至失败。
//   只有直连**出现网络层错误**时才自动改用本地代理重试一次。
//
// 三种模式：
//   auto   —— 直连优先；直连遇到网络错误时自动改用探测到的本地代理重试一次（默认）
//   always —— 所有 AI 请求都走代理（地址为空则自动探测）
//   off    —— 从不使用代理
//
// 全部时间点从外部传入（now / 注入 probe 函数），方便单测不碰真实网络。

export const PROXY_MODE = { AUTO: 'auto', ALWAYS: 'always', OFF: 'off' };

/** 常见的本地代理端口，按「最可能」到「较少见」排序 */
export const DEFAULT_PROXY_CANDIDATES = [
  'http://127.0.0.1:10809',   // v2rayN / sing-box 的 HTTP 端口
  'http://127.0.0.1:7890',    // Clash / Clash Verge / mihomo
  'http://127.0.0.1:10808',   // v2rayN 的 SOCKS 端口（部分配置 HTTP 也开在这）
  'http://127.0.0.1:1080',    // 通用 
  'http://127.0.0.1:2080',    // v2rayN 旧版默认
  'http://127.0.0.1:8889',    // 其它常见
  'http://127.0.0.1:20171',   // 其它常见
];

/** 探测代理是否可用时访问的目标：走代理能通、不走代理通常不通 */
export const DEFAULT_PROBE_TARGETS = [
  'https://www.google.com/generate_204',
  'https://api.openai.com/v1/models',
];

export const DEFAULT_PROXY_CONFIG = {
  mode: PROXY_MODE.AUTO,
  url: '',                    // 非空 = 用这个地址（不再自动探测）
  detectMinutes: 10,          // 探测结果缓存多久（分钟）
};

const MODES = new Set(Object.values(PROXY_MODE));

export function normalizeProxyConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.has(String(r.mode)) ? String(r.mode) : DEFAULT_PROXY_CONFIG.mode;
  const url = String(r.url || '').trim();
  let detectMinutes = Number(r.detectMinutes);
  if (!Number.isFinite(detectMinutes)) detectMinutes = DEFAULT_PROXY_CONFIG.detectMinutes;
  detectMinutes = Math.min(240, Math.max(1, Math.round(detectMinutes)));
  return { mode, url, detectMinutes };
}

/** 读 settings 里的出站代理配置 */
export function readProxyConfig(settings) {
  return normalizeProxyConfig(settings?.outboundProxy);
}

// ---------------- 运行时状态与探测 ----------------

export function createProxyState() {
  return {
    detectedUrl: '',      // 探测命中的代理地址（'' = 没探到）
    lastDetectAt: 0,      // 上次探测完成时间
    tried: [],            // 上次探测的逐项结果，供面板展示
    detecting: null,      // 进行中的探测 Promise（避免并发重复探测）
  };
}

/**
 * 依次探测候选代理，返回第一个可用的。
 *
 * @param {object} options
 * @param {string[]} options.candidates
 * @param {string[]} options.targets
 * @param {(url: string, target: string, opts: object) => Promise<{ok:boolean,error?:string,status?:number}>} options.probe
 * @param {number} options.timeoutMs
 * @returns {Promise<{url: string, tried: Array<{url:string, ok:boolean, error:string}>}>}
 */
export async function detectProxy({ candidates, targets, probe, timeoutMs = 6000 } = {}) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : DEFAULT_PROXY_CANDIDATES;
  const targetList = Array.isArray(targets) && targets.length ? targets : DEFAULT_PROBE_TARGETS;
  const tried = [];
  for (const url of list) {
    let last = null;
    let ok = false;
    for (const target of targetList) {
      last = await probe(url, target, { timeoutMs });
      if (last?.ok) { ok = true; break; }
    }
    tried.push({ url, ok, error: ok ? '' : (last?.error || '连不上') });
    if (ok) return { url, tried };
  }
  return { url: '', tried };
}

/**
 * 确保「已探测过」，并在需要时重新探测。
 * 并发调用共享同一次探测（detecting 去重），避免同时冒出好几轮探测。
 *
 * @param {object} state   createProxyState() 的状态对象
 * @param {object} config  normalizeProxyConfig 的结果
 * @param {object} options { probe, candidates, targets, timeoutMs, now, force }
 */
export async function ensureDetected(state, config, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = (config?.detectMinutes ?? DEFAULT_PROXY_CONFIG.detectMinutes) * 60 * 1000;
  const fresh = state.lastDetectAt > 0 && (now - state.lastDetectAt) < ttlMs;
  if (fresh && !options.force) return { url: state.detectedUrl, tried: state.tried, cached: true };
  if (state.detecting) return await state.detecting;

  const task = (async () => {
    const result = await detectProxy({
      candidates: options.candidates,
      targets: options.targets,
      probe: options.probe,
      timeoutMs: options.timeoutMs,
    });
    state.detectedUrl = result.url;
    state.tried = result.tried;
    // 记「注入的 now」而不是 Date.now()：TTL 判断用的也是注入的 now，
    // 两边必须同一把时钟，否则单测里没法控制缓存过期（生产环境 now 默认就是 Date.now()）。
    state.lastDetectAt = now;
    state.detecting = null;
    return { ...result, cached: false };
  })();
  state.detecting = task;
  try {
    return await task;
  } catch (e) {
    state.detecting = null;
    throw e;
  }
}

/**
 * 决定「这次请求该走哪个代理」。
 *
 * @returns {string}  '' 表示直连
 */
export function proxyForRequest(config, state) {
  const cfg = config || DEFAULT_PROXY_CONFIG;
  if (cfg.mode === PROXY_MODE.OFF) return '';
  if (cfg.url) return cfg.url;                                   // 手填地址优先
  if (cfg.mode === PROXY_MODE.ALWAYS) return state?.detectedUrl || '';
  return '';   // auto：默认先直连，失败了再由调用方改用 state.detectedUrl 重试
}

/**
 * 判断一个异常是否值得「改用代理再试一次」。
 * 只认网络层错误（连不上 / 被重置 / DNS / 证书 / socket 断开）—— 
 * 超时不在此列：那是上游慢，换代理通常没用，只会让用户多等一倍。
 */
export function shouldRetryWithProxy(error, config) {
  const cfg = config || DEFAULT_PROXY_CONFIG;
  if (cfg.mode !== PROXY_MODE.AUTO) return false;
  const name = String(error?.name || '');
  if (name === 'AbortError') return false;
  const text = `${error?.message || ''} ${error?.cause?.code || ''} ${error?.cause?.message || ''} ${error?.code || ''}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|other side closed|premature close|certificate|SSL|TLS|self.signed|unable to verify/i.test(text);
}

/** 面板要展示的状态快照 */
export function proxySnapshot(state, config) {
  const cfg = config || DEFAULT_PROXY_CONFIG;
  return {
    mode: cfg.mode,
    url: cfg.url,
    detectMinutes: cfg.detectMinutes,
    activeUrl: proxyForRequest(cfg, state),
    detectedUrl: state?.detectedUrl || '',
    lastDetectAt: state?.lastDetectAt || 0,
    tried: (state?.tried || []).map((t) => ({ ...t })),
    candidates: DEFAULT_PROXY_CANDIDATES.slice(),
  };
}
