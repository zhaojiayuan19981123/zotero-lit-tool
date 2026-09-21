// translate.js —— 划词翻译入口
//
// 引擎清单与各服务实现统一放在 src/translateProviders.js（划词/全文共用）；
// 这里只保留「大模型翻译」路径与对外分发。新增翻译服务请改 translateProviders.js。

import { getSettings } from './store.js';
import { resolveActive } from './modelCatalog.js';
import { translateWithProvider, translateProviderLabel, __test__ as providerTest } from './translateProviders.js';

/** 调用当前激活的大模型做翻译（OpenAI 兼容 chat completions）。 */
function textFromCompletion(data) {
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((x) => typeof x === 'string' ? x : (x?.text || '')).join('').trim();
  return '';
}

function compatibleMessages(system, user, profile) {
  if (profile?.systemPromptMode === 'user') {
    return [{ role: 'user', content: `【任务要求】\n${system}\n\n【待翻译文本】\n${user}` }];
  }
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

async function translateViaLLM(text, settings, target) {
  const profile = resolveActive(settings);
  if (!profile) throw new Error('未配置可用 AI 模型：请在 AI 设置中选择模型；自定义本地服务可不填密钥，但必须填写 Base URL 和模型名');
  if (!profile.baseURL || !profile.model) throw new Error('当前 AI 模型缺少 Base URL 或模型名称，请在 AI 设置中补全');
  const targetName = target === 'en' ? '英文' : '简体中文';
  const system = `你是一名专业的学术翻译助手。请把用户输入的文本翻译成${targetName}。只输出翻译结果，不要任何解释、不要引号、不要保留原文。`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  const headers = { 'Content-Type': 'application/json' };
  if (profile.authMode !== 'none' && profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
  try {
    let res = await fetch(profile.baseURL + '/chat/completions', {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ model: profile.model, temperature: 0.2, stream: false, messages: compatibleMessages(system, text, profile) }),
    });
    // 一些本地 OpenAI 兼容服务不接受 system role。仅在该类错误时安全退化为用户消息模式。
    if (!res.ok && profile.systemPromptMode === 'auto') {
      const detail = await res.text().catch(() => '');
      if (/system.*(?:role|message)|(?:role|message).*system|unsupported.*system/i.test(detail)) {
        res = await fetch(profile.baseURL + '/chat/completions', {
          method: 'POST', headers, signal: controller.signal,
          body: JSON.stringify({ model: profile.model, temperature: 0.2, stream: false, messages: compatibleMessages(system, text, { ...profile, systemPromptMode: 'user' }) }),
        });
      } else {
        throw new Error(`AI 翻译接口返回 ${res.status}: ${detail.slice(0, 300)}`);
      }
    }
    if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`AI 翻译接口返回 ${res.status}: ${body.slice(0, 300)}`); }
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error(`AI 翻译返回的不是有效 JSON：${raw.slice(0, 160) || '空响应'}`); }
    const result = textFromCompletion(data);
    if (!result) throw new Error('AI 翻译未返回有效内容。请在 AI 设置中重新测试该模型，或改用非流式兼容模式');
    return result;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('AI 翻译请求超时（90 秒）。请检查本地模型服务是否正在运行、模型是否已加载，或降低并发');
    throw e;
  } finally { clearTimeout(timer); }
}

/** 划词翻译主入口 */
export async function translate(text, settings, opts = {}) {
  const s = settings || getSettings();
  const t = (text || '').trim();
  const target = opts.target === 'en' ? 'en' : 'zh';
  if (!t) return '';
  const provider = s.translateProvider || 'siliconflow';
  // 历史字段 siliconflow 实际表示“使用当前激活的 AI 模型”，不再只读旧的 baseURL/apiKey/model，
  // 从而避免切换多模型后翻译仍悄悄走旧配置。
  if (provider === 'siliconflow') return translateViaLLM(t, s, target);
  if (provider === 'deepl' && !s.deeplKey && !s.deeplEndpoint) {
    throw new Error('未配置 DeepL API Key，请在设置中填写');
  }
  return translateWithProvider(provider, t, s, target);
}

export { translateProviderLabel };
export const __test__ = providerTest;
