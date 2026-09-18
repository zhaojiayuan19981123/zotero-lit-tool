// translate.js —— 划词翻译入口
//
// 引擎清单与各服务实现统一放在 src/translateProviders.js（划词/全文共用）；
// 这里只保留「大模型翻译」路径与对外分发。新增翻译服务请改 translateProviders.js。

import { getSettings } from './store.js';
import { translateWithProvider, translateProviderLabel, __test__ as providerTest } from './translateProviders.js';

/** 调用硅基流动 DeepSeek 做翻译（OpenAI 兼容 chat completions） */
async function translateViaLLM(text, settings, target) {
  const url = (settings.baseURL || '').replace(/\/+$/, '') + '/chat/completions';
  const targetName = target === 'en' ? '英文' : '简体中文';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model || 'deepseek-ai/DeepSeek-V4-Flash', temperature: 0.2,
      messages: [
        { role: 'system', content: `你是一名专业的学术翻译助手。请把用户输入的文本翻译成${targetName}。只输出翻译结果，不要任何解释、不要引号、不要保留原文。` },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`翻译接口返回 ${res.status}: ${body.slice(0, 200)}`); }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

/** 划词翻译主入口 */
export async function translate(text, settings, opts = {}) {
  const s = settings || getSettings();
  const t = (text || '').trim();
  const target = opts.target === 'en' ? 'en' : 'zh';
  if (!t) return '';
  const provider = s.translateProvider || 'siliconflow';
  if (provider === 'siliconflow') {
    if (!s.apiKey) throw new Error('未配置硅基流动 API Key，请在设置中填写');
    return translateViaLLM(t, s, target);
  }
  if (provider === 'deepl' && !s.deeplKey && !s.deeplEndpoint) {
    throw new Error('未配置 DeepL API Key，请在设置中填写');
  }
  return translateWithProvider(provider, t, s, target);
}

export { translateProviderLabel };
export const __test__ = providerTest;
