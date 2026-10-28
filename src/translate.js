// translate.js —— 划词翻译入口
//
// 引擎清单与各服务实现统一放在 src/translateProviders.js（划词/全文共用）；
// 这里只保留「大模型翻译」路径与对外分发。新增翻译服务请改 translateProviders.js。

import { getSettings } from './store.js';
import { resolveActive, resolveProfile } from './modelCatalog.js';
import { translateWithProvider, translateProviderLabel, __test__ as providerTest } from './translateProviders.js';
import { translateWithBuiltin, builtinSystemPrompt } from './translateBuiltin.js';
import { thinkingPayload, stripThinking, postWithThinkingFallback } from './thinkingMode.js';

/** 调用当前激活的大模型做翻译（OpenAI 兼容 chat completions）。 */
function textFromCompletion(data) {
  const content = data?.output_text ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.text ?? data?.output?.flatMap?.((item) => item?.content || []).map?.((part) => part?.text || '').join('') ?? '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((x) => typeof x === 'string' ? x : (x?.text || '')).join('').trim();
  return '';
}
function baseURL(profile) { return String(profile.baseURL || '').trim().replace(/\/(?:chat\/completions|responses)$/i, '').replace(/\/+$/, ''); }
function responseInput(messages) { return messages.map((m) => ({ role: m.role, content: [{ type: 'input_text', text: String(m.content || '') }] })); }
function bodyFor(profile, messages, format) {
  if (format === 'responses') return { model: profile.model, input: responseInput(messages), max_output_tokens: 4096, stream: false };
  // 翻译不需要思考：推理模型默认会先想几千 token，既慢又容易把「思考」漏进译文。
  // 不认这些参数的上游会在下面按 400 重发一次（见 translateViaLLM 的 catch）。
  return {
    model: profile.model, temperature: 0.2, stream: false, messages,
    ...thinkingPayload({ provider: profile.provider, model: profile.model }, 'off'),
  };
}
function compatibleMessages(system, user, profile) {
  if (profile?.systemPromptMode === 'user') return [{ role: 'user', content: '【任务要求】\n' + system + '\n\n【待翻译文本】\n' + user }];
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}
async function translateViaLLM(text, settings, target, profileId, opts = {}) {
  // 划词面板可以指定用哪条模型配置当翻译源（llm:<profileId>）；不指定就用当前激活配置
  let profile;
  if (profileId) {
    const raw = (settings.modelProfiles || []).find((p) => p.id === profileId);
    if (!raw) throw new Error('所选翻译模型不存在或已被删除，请到划词翻译面板重新选择翻译源');
    profile = resolveProfile(raw);
  } else {
    profile = resolveActive(settings);
  }
  if (!profile) throw new Error('未配置可用 AI 模型：请在 AI 设置中选择模型；自定义本地服务可不填密钥，但必须填写 Base URL 和模型名');
  if (!profile.baseURL || !profile.model) throw new Error('当前 AI 模型缺少 Base URL 或模型名称，请在 AI 设置中补全');
  const targetName = target === 'en' ? '英文' : '简体中文';
  // 提示词与「内置翻译模型」共用一套：术语一致、公式/数字/引用占位符原样保留、只输出译文。
  // 翻译质量的大部分差异来自这里，而不是模型本身。
  const system = builtinSystemPrompt(targetName, { glossaryHint: opts?.glossaryHint || '' });
  const messages = compatibleMessages(system, text, profile);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90000);
  const headers = { 'Content-Type': 'application/json' }; if (profile.authMode !== 'none' && profile.apiKey) headers.Authorization = 'Bearer ' + profile.apiKey;
  const configured = ['auto', 'chat', 'responses'].includes(profile.apiFormat) ? profile.apiFormat : 'auto';
  const formats = configured === 'auto' ? ['chat', 'responses'] : [configured];
  try {
    let last = '';
    for (let i = 0; i < formats.length; i += 1) {
      const format = formats[i]; const endpoint = baseURL(profile) + (format === 'responses' ? '/responses' : '/chat/completions');
      const send = (payload) => fetch(endpoint, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(payload) });
      // 思考参数被上游拒（400/422）时会自动摘掉重发一次，避免「翻译整个不可用」
      let { res, thinkingRejected } = await postWithThinkingFallback(send, bodyFor(profile, messages, format));
      if (!res.ok && profile.systemPromptMode === 'auto') {
        const detail = await res.clone().text().catch(() => '');
        if (/system.*(?:role|message)|(?:role|message).*system|unsupported.*system/i.test(detail)) {
          const flattened = [{ role: 'user', content: '【任务要求】\n' + system + '\n\n【待翻译文本】\n' + text }];
          // 已经确认这个上游不认思考参数，就别在第二次请求里又发一遍
          const payload = bodyFor(profile, flattened, format);
          res = await send(thinkingRejected ? stripThinking(payload) : payload);
        }
      }
      if (res.ok) { const raw = await res.text(); let data; try { data = JSON.parse(raw); } catch (_) { throw new Error('AI 翻译返回的不是有效 JSON：' + (raw.slice(0, 160) || '空响应')); } const result = textFromCompletion(data); if (!result) throw new Error('AI 翻译未返回有效内容。请在 AI 设置中重新测试该模型，或改用非流式兼容模式'); return result; }
      last = await res.text().catch(() => '');
      if (i === formats.length - 1 || ![404, 405, 415, 422].includes(res.status)) throw new Error('AI 翻译接口返回 ' + res.status + ': ' + last.slice(0, 300));
    }
    throw new Error('AI 翻译接口不可用：' + last.slice(0, 300));
  } catch (e) { if (e?.name === 'AbortError') throw new Error('AI 翻译请求超时（90 秒）。请检查本地模型服务是否正在运行、模型是否已加载，或降低并发'); throw e; } finally { clearTimeout(timer); }
}

/** 划词翻译主入口。opts.provider / opts.profileId 可临时覆盖全局设置的翻译源 */
export async function translate(text, settings, opts = {}) {
  const s = settings || getSettings();
  const t = (text || '').trim();
  const target = opts.target === 'en' ? 'en' : 'zh';
  if (!t) return '';
  const provider = opts.provider || s.translateProvider || 'siliconflow';
  // 历史字段 siliconflow 实际表示“使用当前激活的 AI 模型”，不再只读旧的 baseURL/apiKey/model，
  // 从而避免切换多模型后翻译仍悄悄走旧配置。
  // 内置翻译模型：固定的免费小模型 + 学术翻译提示词，比「当前激活的大模型」更快更省，
  // 也比网页版机器翻译准（术语、公式、引用编号都按论文规则保护）。
  if (provider === 'builtin') {
    return translateWithBuiltin(t, s, target, { signal: opts.signal, glossaryHint: opts.glossaryHint });
  }
  if (provider === 'siliconflow') return translateViaLLM(t, s, target, opts.profileId, opts);
  if (provider === 'deepl' && !s.deeplKey && !s.deeplEndpoint) {
    throw new Error('未配置 DeepL API Key，请在设置中填写');
  }
  return translateWithProvider(provider, t, s, target);
}

export { translateProviderLabel };
export const __test__ = providerTest;
