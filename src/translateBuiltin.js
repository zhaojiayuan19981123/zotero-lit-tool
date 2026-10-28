// translateBuiltin.js —— 「内置翻译模型（免费）」引擎
//
// 起因（2026-10 用户反馈）：划词 / 全文翻译「太不准了」，希望有一个**免费、快、准**的
// 翻译大模型作为可选引擎。
//
// 为什么单独做一条引擎，而不是让用户自己挑一个模型配置：
//   1) 翻译和问答的取舍完全不同 —— 问答要「想得深」，翻译要「快、稳、术语一致」。
//      拿对话用的推理大模型去翻几百段，既慢又贵（每段都要思考几千 token）。
//   2) 用户并不想为了翻译再配一套 Key。所以这里默认复用**已有的硅基流动 Key**
//      （模型配置里任意一条 siliconflow 配置），模型固定用翻译够用的小模型，
//      这类模型在硅基流动长期有免费额度，翻全文也不花钱。
//   3) 免费模型的具体清单会变（下架 / 改名 / 取消免费），所以这里按候选列表逐个尝试，
//      第一个能用的记住，下次直接用 —— 不把「哪个模型免费」写死成常量。
//
// 与「大模型 · 某配置」的区别只在「用哪个模型 + 关掉思考」，提示词与占位符保护
// 完全复用 src/pdfTranslate/engines.js 那一套（术语表、公式、引用编号都原样保留）。

import { thinkingPayload } from './thinkingMode.js';

/**
 * 免费 / 低价翻译模型候选（按「翻译质量 × 速度 × 是否免费」排序）。
 * 注意：这里只写「候选」，不保证一定免费；真正可用性靠 404/403 时自动换下一个来兜底。
 */
export const BUILTIN_MODEL_CANDIDATES = [
  'Qwen/Qwen3-8B',            // 硅基流动：翻译质量稳、延迟低，实测最合适
  'Qwen/Qwen3-4B',
  'Qwen/Qwen2.5-7B-Instruct',
  'THUDM/glm-4-9b-chat',
];

// 进程内记住「这次哪个候选真的能用」，避免每次翻译都从第一个开始试错
let chosenByKey = new Map();

export function resetBuiltinCache() {
  chosenByKey = new Map();
}

/** 从模型配置里找一条 siliconflow 的 Key（内置翻译复用，不需要用户再填一次） */
function siliconflowKeyFrom(settings) {
  const profiles = Array.isArray(settings?.modelProfiles) ? settings.modelProfiles : [];
  const isSf = (p) => /siliconflow/i.test(String(p?.provider || '')) || /siliconflow\.cn/i.test(String(p?.baseURL || ''));
  const active = profiles.find((p) => p.id === settings?.activeProfileId && isSf(p) && String(p.apiKey || '').trim());
  if (active) return active;
  return profiles.find((p) => isSf(p) && String(p.apiKey || '').trim()) || null;
}

/**
 * 解析出「内置翻译模型」要用的调用配置。
 * 优先用户显式配置（translateBuiltinKey / translateBuiltinBaseURL），否则复用硅基流动那条。
 * 拿不到 Key 时抛出可直接展示给用户的中文提示。
 */
export function resolveBuiltinProfile(settings) {
  const s = settings || {};
  const ownKey = String(s.translateBuiltinKey || '').trim();
  const sf = siliconflowKeyFrom(s);
  const apiKey = ownKey || String(sf?.apiKey || '').trim();
  const baseURL = String(s.translateBuiltinBaseURL || '').trim()
    || String(sf?.baseURL || '').trim()
    || 'https://api.siliconflow.cn/v1';
  if (!apiKey) {
    throw new Error('内置翻译模型需要一次授权：请在「AI 设置」里添加一条硅基流动的模型配置（免费注册即可，'
      + '内置翻译会自动复用它），或在「翻译设置」里单独填写内置翻译的 API Key');
  }
  const base = baseURL.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses)$/i, '');
  const configured = String(s.translateBuiltinModel || '').trim();
  const cached = chosenByKey.get(base) || '';
  const model = configured || cached || BUILTIN_MODEL_CANDIDATES[0];
  return {
    id: 'builtin-translate',
    label: `内置翻译模型 · ${model}`,
    provider: /siliconflow/i.test(base) ? 'siliconflow' : 'custom',
    providerName: /siliconflow/i.test(base) ? '硅基流动 SiliconFlow' : '自定义服务',
    baseURL: base,
    apiKey,
    model,
    authMode: 'auto',
    systemPromptMode: 'auto',
    streamMode: 'nonstream',
    apiFormat: 'chat',
    vision: false,
  };
}

/** 学术翻译的系统提示词（划词单段用；全文分批走 engines.js 的 buildLlmPrompt） */
export function builtinSystemPrompt(targetLabel, { glossaryHint = '' } = {}) {
  return [
    `你是学术论文翻译专家，把用户给出的英文（或其它语言）学术文本翻译成${targetLabel}。`,
    '',
    '【硬性要求】',
    '1. 只输出译文本身：不要解释、不要注释、不要「译文：」前缀、不要引号包裹、不要重复原文；',
    '2. 术语按学科通用译法，同一术语在同一篇论文里必须始终用同一个译法；',
    '3. 数学公式、变量名、希腊字母、上下标、LaTeX 片段原样保留；',
    '4. 数字、百分比、单位、p 值、置信区间（p < 0.05、95% CI、n = 128）原样保留；',
    '5. 文内引用与编号（[12]、[3-5]、(Smith et al., 2020)）原样保留；',
    '6. 形如 [[T1]]、[[1]] 的占位符原样保留，位置不能变；',
    '7. 缩写、模型名、数据集名、软件名（CNN、BERT、GPT-4、ImageNet）保留原文；',
    '8. 保留原文的论证结构与限定语（样本、条件、边界），不增删信息、不合并句子到影响原意；',
    '9. 已经是目标语言的片段原样返回，不要改写。',
    '',
    '【风格】规范学术书面语，句子完整通顺，不要口语化、不要成语堆砌、不要意译成「更好听」的说法。',
    glossaryHint ? `\n【术语表】以下术语必须按给定译法翻译：\n${glossaryHint}` : '',
  ].filter((x) => x !== '').join('\n');
}

/**
 * 单段翻译（划词面板 / 对照精读的「点段落即译」）。
 * 失败时：模型不存在 / 无权限 → 自动换下一个候选并记住；其它错误原样抛出。
 */
export async function translateWithBuiltin(text, settings, target, { glossaryHint = '', signal } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const targetLabel = target === 'en' ? '英文' : '简体中文';
  const profile = resolveBuiltinProfile(settings);
  const base = profile.baseURL;
  const candidates = [...new Set([profile.model, ...BUILTIN_MODEL_CANDIDATES])];
  let lastErr = null;

  for (const model of candidates) {
    const body = {
      model,
      temperature: 0.1,
      max_tokens: Math.min(4096, Math.max(512, Math.ceil(raw.length * 1.6))),
      stream: false,
      messages: [
        { role: 'system', content: builtinSystemPrompt(targetLabel, { glossaryHint }) },
        { role: 'user', content: raw },
      ],
      // 翻译不需要思考：这类参数在各家的写法见 src/thinkingMode.js，不认的话下面会重试一次
      ...thinkingPayload({ provider: profile.provider, model }, 'off'),
    };
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new Error('内置翻译模型连接失败：' + (e?.message || e));
    }

    if (res.ok) {
      const data = await res.json().catch(() => null);
      const content = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!content) throw new Error('内置翻译模型没有返回译文，请稍后重试或换用其它翻译引擎');
      chosenByKey.set(base, model);
      return cleanupTranslation(content);
    }

    const detail = await res.text().catch(() => '');
    lastErr = new Error(`内置翻译模型（${model}）返回 ${res.status}: ${detail.slice(0, 200)}`);
    // 只有「模型不存在 / 无权限 / 该模型下线」才换候选；限流与超时换模型也一样会失败
    const switchable = [400, 403, 404, 422].includes(res.status)
      && /model|不存在|not\s*found|no\s*permission|not\s*exist|invalid/i.test(detail);
    if (!switchable) break;
  }
  throw lastErr || new Error('内置翻译模型不可用，请改用其它翻译引擎');
}

/** 清掉模型偶尔加上的引号 / 「译文：」前缀 / 代码块围栏 */
export function cleanupTranslation(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  t = t.replace(/^(?:译文|翻译|translation)\s*[:：]\s*/i, '').trim();
  if (/^["“'][\s\S]*["”']$/.test(t) && t.length > 2) t = t.slice(1, -1).trim();
  return t;
}
