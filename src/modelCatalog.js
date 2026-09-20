// modelCatalog.js —— 多模型配置中心
// 设计目标：
//   1) AI 设置里可以保存「两个以上」的模型配置，每条含 供应商 / Base URL / API Key / 模型名；
//   2) 任意时刻有且仅有一个「激活模型」，所有 AI 能力（文献解析、AI 助手、论文对话、
//      划词翻译、审稿意见翻译）统一读它，行为可预期；
//   3) 主界面顶部可一键切换激活模型（按供应商分组的下拉面板）。

// ---------- 服务商预设：新增服务商只需在这里加一项 ----------
// baseURL 一律写到 /v1 为止（不含 /chat/completions），与历史配置保持一致。
export const PROVIDERS = [
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    keyHint: 'sk-...（硅基流动控制台获取）',
    keyURL: 'https://cloud.siliconflow.cn/account/ak',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash', vision: false, note: '默认，快且便宜' },
      { id: 'deepseek-ai/DeepSeek-V4', name: 'DeepSeek-V4', vision: false },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', name: 'Qwen3-235B-A22B', vision: false },
      // 视觉模型清单：按用户当前可用的 SiliconFlow 模型更新（2026-09）
      { id: 'moonshotai/Kimi-K2.7-Code', name: 'Kimi-K2.7-Code', vision: true, note: '支持看图' },
      { id: 'Qwen/Qwen3.8-27B', name: 'Qwen3.8-27B', vision: true, note: '支持看图' },
      { id: 'Pro/moonshotai/Kimi-K2.6', name: 'Kimi-K2.6 Pro', vision: true, note: '支持看图' },
      { id: 'zai-org/GLM-4.5V', name: 'GLM-4.5V', vision: true, note: '支持看图' },
      { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen3.6-35B-A3B', vision: true, note: '支持看图' },
      { id: 'moonshotai/Kimi-K2-Instruct', name: 'Kimi-K2-Instruct', vision: false },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com/v1',
    keyHint: 'sk-...（platform.deepseek.com 获取）',
    keyURL: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-chat', name: 'deepseek-chat（V3 通用）', vision: false },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner（R1 推理）', vision: false },
    ],
  },
  {
    id: 'qwen',
    name: '阿里云百炼（通义千问）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyHint: 'sk-...（阿里云百炼控制台获取）',
    keyURL: 'https://bailian.console.aliyun.com/',
    models: [
      { id: 'qwen-plus', name: 'qwen-plus', vision: false },
      { id: 'qwen-max', name: 'qwen-max', vision: false },
      { id: 'qwen-vl-max', name: 'qwen-vl-max', vision: true, note: '支持看图' },
      { id: 'qwen-vl-plus', name: 'qwen-vl-plus', vision: true, note: '支持看图' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 AI（GLM）',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    keyHint: '在智谱开放平台获取',
    keyURL: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-4-plus', name: 'glm-4-plus', vision: false },
      { id: 'glm-4-flash', name: 'glm-4-flash（免费额度）', vision: false },
      { id: 'glm-4v-plus', name: 'glm-4v-plus', vision: true, note: '支持看图' },
    ],
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    keyHint: 'sk-...（platform.moonshot.cn 获取）',
    keyURL: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      { id: 'kimi-k2-0905-preview', name: 'kimi-k2-0905-preview', vision: false },
      { id: 'moonshot-v1-128k', name: 'moonshot-v1-128k', vision: false },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    keyHint: 'sk-...（platform.openai.com 获取）',
    keyURL: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini', vision: true, note: '支持看图' },
      { id: 'gpt-4o', name: 'gpt-4o', vision: true, note: '支持看图' },
      { id: 'gpt-4.1-mini', name: 'gpt-4.1-mini', vision: true, note: '支持看图' },
    ],
  },
  {
    id: 'custom',
    name: '自定义 / 本地部署',
    baseURL: '',
    keyHint: '兼容 OpenAI 格式即可（Ollama、vLLM、One-API 中转等）',
    keyURL: '',
    models: [],
  },
];

const PROVIDER_MAP = new Map(PROVIDERS.map((p) => [p.id, p]));

export const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';

export function getProvider(id) {
  return PROVIDER_MAP.get(String(id || '')) || null;
}

export function providerName(id) {
  return getProvider(id)?.name || '自定义';
}

// 已知模型是否支持图片输入。目录里没有的模型返回 null（未知）。
export function modelSupportsVision(provider, model) {
  const p = getProvider(provider);
  if (!p) return null;
  const m = p.models.find((x) => x.id === model);
  return m ? !!m.vision : null;
}

// 每条模型配置都允许覆盖目录判断：
// auto = 按目录判断；yes = 强制视为视觉模型；no = 强制视为纯文本模型。
export function normalizeVisionOverride(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  const v = String(value ?? '').trim().toLowerCase();
  if (['yes', 'true', '1', 'vision', 'supported'].includes(v)) return 'yes';
  if (['no', 'false', '0', 'text', 'unsupported'].includes(v)) return 'no';
  return 'auto';
}

export function resolveVisionCapability(profile) {
  if (!profile) return null;
  const raw = Object.prototype.hasOwnProperty.call(profile, 'visionOverride')
    ? profile.visionOverride
    : (Object.prototype.hasOwnProperty.call(profile, 'visionMode')
      ? profile.visionMode
      : (typeof profile.vision === 'boolean' ? profile.vision : 'auto'));
  const mode = normalizeVisionOverride(raw);
  if (mode === 'yes') return true;
  if (mode === 'no') return false;
  return modelSupportsVision(profile.provider, profile.model);
}

export function visionModeLabel(value) {
  const mode = normalizeVisionOverride(value);
  if (mode === 'yes') return '支持图片';
  if (mode === 'no') return '不支持图片';
  return '自动判断';
}

export function modelDisplayName(provider, model) {
  const p = getProvider(provider);
  const m = p?.models.find((x) => x.id === model);
  return m?.name || model || '';
}

// ---------- 唯一 id ----------
export function newProfileId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 用户常把完整的 /chat/completions 地址粘贴到 Base URL。内部统一保存成 API 根地址，
// 后续调用只拼接一次 /chat/completions，避免测试可用、实际请求却变成双重路径。
export function normalizeBaseURL(value) {
  let base = String(value || '').trim().replace(/\s+/g, '').replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/i, '');
  return base.replace(/\/+$/, '');
}

export function normalizeStreamMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['auto', 'stream', 'nonstream'].includes(mode) ? mode : 'auto';
}

export function normalizeSystemPromptMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['auto', 'system', 'user'].includes(mode) ? mode : 'auto';
}

export function normalizeAuthMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['auto', 'bearer', 'none'].includes(mode) ? mode : 'auto';
}

// ---------- 迁移：把老的单模型设置转成 profiles ----------
// 老字段：aiProvider / baseURL / apiKey / model
// 新字段：modelProfiles[] / activeProfileId
export function migrateSettings(settings) {
  const s = settings || {};
  if (!Array.isArray(s.modelProfiles)) s.modelProfiles = [];

  // 老配置是唯一数据源：有 key 或明确选了某个服务商时才迁移
  const legacyProvider = String(s.aiProvider || '').trim();
  const hasLegacy = (legacyProvider && legacyProvider !== 'none')
    || !!(s.apiKey || '').trim() || !!(s.baseURL || '').trim();

  const alreadyMigrated = !!s._modelMigrated;
  if (!s.modelProfiles.length && hasLegacy && !alreadyMigrated) {
    const provider = PROVIDER_MAP.has(legacyProvider) ? legacyProvider
      : (String(s.baseURL || '').includes('siliconflow') ? 'siliconflow' : 'custom');
    s.modelProfiles.push({
      id: newProfileId(),
      label: provider === 'siliconflow' ? 'DeepSeek（默认）' : providerName(provider),
      provider,
      baseURL: normalizeBaseURL(s.baseURL || getProvider(provider)?.baseURL || ''),
      apiKey: s.apiKey || '',
      model: (s.model || '').trim() || (provider === 'siliconflow' ? DEFAULT_MODEL : ''),
      streamMode: 'auto',
      systemPromptMode: 'auto',
      authMode: 'auto',
      createdAt: new Date().toISOString(),
    });
    s.activeProfileId = s.modelProfiles[0].id;
  }
  s._modelMigrated = true;

  // 兜底：一个都没有（全新用户）
  if (!s.modelProfiles.length) {
    s.modelProfiles.push({
      id: newProfileId(),
      label: '硅基流动 · DeepSeek',
      provider: 'siliconflow',
      baseURL: DEFAULT_BASE_URL,
      apiKey: '',
      model: DEFAULT_MODEL,
      streamMode: 'auto',
      systemPromptMode: 'auto',
      authMode: 'auto',
      createdAt: new Date().toISOString(),
    });
    s.activeProfileId = s.modelProfiles[0].id;
  }

  // 清洗：保证每条都有 id / 合法 provider，且 id 唯一
  const seen = new Set();
  s.modelProfiles = s.modelProfiles.filter((p) => p && typeof p === 'object').map((p) => {
    let id = String(p.id || '').trim();
    if (!id || seen.has(id)) id = newProfileId();
    seen.add(id);
    const provider = PROVIDER_MAP.has(p.provider) ? p.provider : 'custom';
    return {
      id,
      label: String(p.label || '').trim() || modelDisplayName(provider, p.model) || providerName(provider),
      provider,
      baseURL: normalizeBaseURL(p.baseURL || getProvider(provider)?.baseURL || ''),
      apiKey: String(p.apiKey || ''),
      model: String(p.model || '').trim(),
      // auto：先尝试 SSE，失败时自动退回普通 JSON；本地/兼容网关可手动指定。
      streamMode: normalizeStreamMode(p.streamMode),
      // auto：优先标准 system role；少数本地服务拒绝时改为把系统指令并入用户消息。
      systemPromptMode: normalizeSystemPromptMode(p.systemPromptMode),
      // 自定义本地服务可能不需要认证；auto 有 Key 时发送 Bearer，无 Key 时不发送。
      authMode: normalizeAuthMode(p.authMode),
      // 旧配置没有该字段，保留为 auto；用户可在编辑器里明确覆盖。
      visionOverride: normalizeVisionOverride(
        Object.prototype.hasOwnProperty.call(p, 'visionOverride') ? p.visionOverride
          : (Object.prototype.hasOwnProperty.call(p, 'visionMode') ? p.visionMode
            : (typeof p.vision === 'boolean' ? p.vision : 'auto')),
      ),
      createdAt: p.createdAt || new Date().toISOString(),
    };
  }).slice(0, 20); // 最多 20 条，避免配置文件被写爆

  // 激活项必须存在；旧的 aiProvider==='none'（用户主动关 AI）也要尊重
  if (!s.modelProfiles.some((p) => p.id === s.activeProfileId)) {
    s.activeProfileId = s.modelProfiles[0]?.id || '';
  }
  return s;
}

// ---------- 解析出「当前生效」的模型配置 ----------
// 返回 null 表示：用户没配好（无 key）或主动关闭了 AI（aiProvider === 'none'）
export function resolveActive(settings) {
  const s = migrateSettings(settings);
  if (s.aiProvider === 'none') return null;
  const p = s.modelProfiles.find((x) => x.id === s.activeProfileId) || s.modelProfiles[0];
  if (!p || (!String(p.apiKey || '').trim() && p.provider !== 'custom')) return null;
  return describeProfile(p);
}

// 把「任意一条」profile 解析成调用上游所需的标准结构（不限于当前激活的那条）。
// 用于「两段式看图」里指定的视觉模型：它不是 active，但同样需要 baseURL/apiKey/model。
// 未填 Key 时返回 null，调用方据此提示用户。
export function resolveProfile(profile) {
  if (!profile) return null;
  const s = migrateSettings({ modelProfiles: [profile], activeProfileId: profile.id, _modelMigrated: true });
  const p = s.modelProfiles.find((x) => x.id === profile.id) || s.modelProfiles[0];
  if (!p || (!String(p.apiKey || '').trim() && p.provider !== 'custom')) return null;
  return describeProfile(p);
}

function describeProfile(p) {
  return {
    id: p.id,
    label: p.label,
    provider: p.provider,
    providerName: providerName(p.provider),
    baseURL: normalizeBaseURL(p.baseURL || getProvider(p.provider)?.baseURL || DEFAULT_BASE_URL),
    apiKey: p.apiKey,
    model: p.model || DEFAULT_MODEL,
    streamMode: normalizeStreamMode(p.streamMode),
    systemPromptMode: normalizeSystemPromptMode(p.systemPromptMode),
    authMode: normalizeAuthMode(p.authMode),
    vision: resolveVisionCapability(p),
    visionOverride: normalizeVisionOverride(p.visionOverride),
  };
}

// ---------- 回写：把激活模型的字段同步到老字段 ----------
// 保证任何还在读 settings.baseURL / settings.model 的老代码路径不跑偏
export function syncLegacyFields(settings) {
  const s = migrateSettings(settings);
  const p = s.modelProfiles.find((x) => x.id === s.activeProfileId) || s.modelProfiles[0];
  if (p) {
    s.aiProvider = p.provider;
    s.baseURL = normalizeBaseURL(p.baseURL || getProvider(p.provider)?.baseURL || DEFAULT_BASE_URL);
    s.apiKey = p.apiKey || '';
    s.model = p.model || DEFAULT_MODEL;
  }
  return s;
}

// 供前端渲染「供应商 → 模型」选择面板
export function catalogForClient() {
  return PROVIDERS.map((p) => ({
    id: p.id, name: p.name, baseURL: p.baseURL, keyHint: p.keyHint, keyURL: p.keyURL,
    models: p.models.map((m) => ({ id: m.id, name: m.name, vision: !!m.vision, note: m.note || '' })),
  }));
}
