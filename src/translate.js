// translate.js —— 划词翻译：支持硅基流动 DeepSeek / DeepL / 免费接口
import { getSettings } from './store.js';

/**
 * 调用硅基流动 DeepSeek 做翻译（OpenAI 兼容 chat completions）
 */
async function translateViaLLM(text, settings) {
  const url = (settings.baseURL || '').replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model || 'deepseek-ai/DeepSeek-V4-Flash',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: '你是一名专业的学术翻译助手。请把用户输入的文本翻译成简体中文。只输出翻译结果，不要任何解释、不要引号、不要保留原文。如果原文已是中文，则润色为通顺的中文。',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`翻译接口返回 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

/**
 * 调用 DeepL 翻译
 */
async function translateViaDeepL(text, settings) {
  const key = settings.deeplKey;
  const url = 'https://api-free.deepl.com/v2/translate';
  const params = new URLSearchParams({
    auth_key: key,
    text,
    target_lang: 'ZH',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepL 返回 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.translations?.[0]?.text || '').trim();
}

/**
 * 调用免费翻译接口（MyMemory，无需密钥）
 */
async function translateViaFree(text) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|zh-CN';
  const res = await fetch(url, { headers: { 'User-Agent': 'SciTerminal/1.0' } });
  if (!res.ok) throw new Error('免费翻译接口返回 ' + res.status);
  const data = await res.json();
  if (data?.responseStatus !== 200 && data?.responseStatus !== '200') {
    throw new Error('免费翻译失败：' + (data?.responseDetails || '未知错误'));
  }
  return (data?.responseData?.translatedText || '').trim();
}

/**
 * 划词翻译主入口
 * @param {string} text 待翻译文本
 * @param {object} settings 设置（可省略，用已存设置）
 */
export async function translate(text, settings, opts = {}) {
  const s = settings || getSettings();
  const t = (text || '').trim();
  const target = opts.target === 'en' ? 'en' : 'zh';
  if (!t) return '';

  switch (s.translateProvider) {
    case 'deepl': {
      if (!s.deeplKey) throw new Error('未配置 DeepL API Key，请在设置中填写');
      return translateViaDeepL(t, s, target);
    }
    case 'free':
      return translateViaFree(t, target);
    case 'siliconflow':
    default: {
      if (!s.apiKey) throw new Error('未配置硅基流动 API Key，请在设置中填写');
      return translateViaLLM(t, s, target);
    }
  }
}
