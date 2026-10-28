// thinkingMode.js —— 各家的「思考（reasoning）」开关写法，集中在这里
//
// 为什么要单独抽一层：
//   · 同一个语义在不同网关上是不同参数名，而且写法互不兼容 —— 硅基流动认
//     enable_thinking / thinking_budget，智谱 GLM-4.5 认 thinking:{type}，
//     本地 vLLM 走 chat_template_kwargs，DeepSeek 官方的 reasoner 根本不让你关。
//   · 把「关思考」写死进 payload 的风险很大：不认识该参数的上游会直接 400，
//     表现为「昨天还能解析，今天所有文献都报参数错误」。所以这里只**给出候选参数**，
//     真正的兜底（400 就把这些参数摘掉重发一次）在调用方做。
//
// 用在哪：
//   · 文献解析（src/aiExtractor.js callLLM）：一律 off —— 结构化抽取不需要长思考，
//     实测关掉后同一篇论文的字段输出时间从 60~120 秒降到 10~30 秒。
//   · AI 助读 / 论文对话：默认 auto（跟随模型），用户可切「快速模式」= off；
//     想看到思考过程就用 on，前端会把 reasoning_content 折叠展示出来。

export const THINKING_MODES = ['auto', 'off', 'on'];

export function normalizeThinkingMode(value) {
  const v = String(value || '').trim().toLowerCase();
  // 兼容前端可能传来的布尔 / 中文
  if (v === 'true' || v === '1' || v === 'on' || v === 'think' || v === 'enabled') return 'on';
  if (v === 'false' || v === '0' || v === 'off' || v === 'disabled' || v === 'fast') return 'off';
  return 'auto';
}

/** 开关思考时会写进 payload 的键（400 兜底时要按这份名单摘掉） */
export const THINKING_KEYS = ['enable_thinking', 'thinking_budget', 'thinking', 'chat_template_kwargs', 'reasoning_effort'];

/** 模型名里带这些片段的，通常是「默认就思考」的推理模型 */
const REASONING_NAME = /(^|[/:_-])(r1|qwq|qvq|reasoner|reasoning|thinking|deepseek-v4(?![-\w]*flash)|o[1-4](-|$))/i;

/**
 * 这个模型大概会不会思考。只用于界面提示与默认值判断，**不参与**「要不要发参数」的决策
 * （发不发只看用户选的模式与供应商）。
 */
export function modelMayThink(profile) {
  const model = String(profile?.model || '');
  if (!model) return false;
  if (REASONING_NAME.test(model)) return true;
  // Qwen3 / GLM-4.5+ / Kimi-K2 等混合模型：默认带思考，可用参数关掉
  return /qwen3|glm-4\.[5-9]|glm-z1|kimi-k2|minimax-m/i.test(model);
}

/**
 * 生成「思考模式」对应的上游参数。
 * @param {object} profile 解析后的模型配置（含 provider / model）
 * @param {'auto'|'off'|'on'} mode
 * @param {{budget?:number}} [opts] budget：思考预算（token），0 表示不限
 * @returns {object} 要合并进 chat/completions 请求体的字段（auto 时为空对象）
 */
export function thinkingPayload(profile, mode, opts = {}) {
  const m = normalizeThinkingMode(mode);
  if (m === 'auto') return {};
  const on = m === 'on';
  const budget = Number(opts.budget);
  const hasBudget = Number.isFinite(budget) && budget > 0;

  switch (String(profile?.provider || '')) {
    case 'siliconflow':
      // 硅基流动：enable_thinking 对混合模型生效；thinking_budget 限制思考长度
      return on
        ? { enable_thinking: true, ...(hasBudget ? { thinking_budget: budget } : {}) }
        : { enable_thinking: false, thinking_budget: 0 };
    case 'zhipu':
      // 智谱 GLM-4.5 起用 thinking.{type}；关掉就是 disabled
      return { thinking: { type: on ? 'enabled' : 'disabled' } };
    case 'qwen':
      // 阿里云百炼兼容模式：enable_thinking（qwen3 系列）
      return { enable_thinking: on };
    case 'deepseek':
      // 官方：deepseek-chat 本来不思考，reasoner 不提供关闭开关 —— 两种模式都不加参数，
      // 免得上游对未知字段报错。
      return {};
    case 'moonshot':
      return on ? {} : { thinking: { type: 'disabled' } };
    default:
      // 自定义 / 本地（Ollama、vLLM、One-API）：两种写法各来一份，无效就靠 400 兜底摘掉
      return on
        ? { enable_thinking: true }
        : { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } };
  }
}

/** 把思考参数合并进 payload（不改原对象）；auto 模式原样返回，避免无意义的浅拷贝 */
export function withThinking(payload, profile, mode, opts = {}) {
  const extras = thinkingPayload(profile, mode, opts);
  if (!Object.keys(extras).length) return payload;
  return { ...payload, ...extras };
}

/** 从 payload 里摘掉思考相关字段（400 兜底重发用） */
export function stripThinking(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  for (const k of THINKING_KEYS) delete out[k];
  return out;
}

/**
 * 上游报错是否像是「不认识这些思考参数」。
 * 只在 400/422 且文本里出现参数类关键词时才成立 —— 别把「模型不存在」也当参数问题。
 */
export function looksLikeThinkingParamError(status, detail) {
  const code = Number(status);
  if (code !== 400 && code !== 422) return false;
  const text = String(detail || '');
  if (!/thinking|reasoning|budget|chat_template|extra|unknown|unexpected|invalid|unsupported/i.test(text)) return false;
  return /param|field|argument|value|key|property|unrecognized|extra/i.test(text);
}
