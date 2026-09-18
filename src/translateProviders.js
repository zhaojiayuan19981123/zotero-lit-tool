// translateProviders.js —— 非大模型翻译服务的统一实现层
//
// 划词翻译（src/translate.js）与全文翻译（src/pdfTranslate/engines.js）共用这里，
// 避免两处各写一套请求细节。大模型（LLM）路径不在这里：它依赖模型配置中心，由各自模块实现。
//
// 每个服务都是 (text, settings, target) => 译文，target 为 'zh' | 'en'。
// 免密钥服务标注 needsKey: false，供前端设置面板决定是否展示密钥输入框。

import crypto from 'node:crypto';

// ==================== 通用小工具 ====================

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

async function readErrorBody(res) {
  const body = await res.text().catch(() => '');
  return body.slice(0, 200);
}

// ==================== DeepL ====================

function officialDeepLEndpoint(key) {
  return String(key || '').trim().endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
}

/**
 * DeepL 官方 API 自 2025 年起要求 Authorization: DeepL-Auth-Key。
 * 自定义 DeepLX 端点不是官方协议，保留旧的 form 请求以兼容常见 DeepLX 部署。
 */
async function viaDeepL(text, settings, target) {
  const key = String(settings.deeplKey || '').trim();
  const customEndpoint = String(settings.deeplEndpoint || '').trim();
  const targetLang = target === 'en' ? 'EN-US' : 'ZH-HANS';

  if (customEndpoint) {
    const params = new URLSearchParams({ text, target_lang: targetLang });
    if (key) params.set('auth_key', key);
    const res = await fetch(customEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
    });
    if (!res.ok) throw new Error(`自定义 DeepL/DeepLX 端点返回 ${res.status}: ${await readErrorBody(res)}`);
    const data = await res.json();
    return (data?.translations?.[0]?.text || data?.data || data?.text || '').trim();
  }

  const res = await fetch(officialDeepLEndpoint(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key}` },
    body: JSON.stringify({ text: [text], target_lang: targetLang }),
  });
  if (!res.ok) throw new Error(`DeepL 返回 ${res.status}: ${await readErrorBody(res)}`);
  const data = await res.json();
  return (data?.translations?.[0]?.text || '').trim();
}

// ==================== 火山翻译 ====================

// 火山网页版（translate.volcengine.com）的语言代号
const VOLC_WEB_LANG = { zh: 'zh', 'zh-tw': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it' };

/** 火山翻译 · 网页版公开接口（免密钥，适合划词/轻量场景） */
async function viaVolcWeb(text, settings, target) {
  const targetLang = VOLC_WEB_LANG[target] || 'zh';
  const sourceLang = target === 'en' ? 'zh' : 'en';
  const res = await fetch('https://translate.volcengine.com/crx/translate/v1/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_language: sourceLang, target_language: targetLang, text }),
  });
  if (!res.ok) throw new Error(`火山网页翻译返回 ${res.status}: ${await readErrorBody(res)}`);
  const data = await res.json();
  const out = (data?.translation || data?.data?.translation || '').trim();
  if (!out) throw new Error('火山网页翻译返回内容无法解析');
  return out;
}

// 火山引擎机器翻译 API 的语言代号
const VOLC_API_LANG = { zh: 'zh', 'zh-tw': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it' };

/**
 * 火山引擎机器翻译 API（TranslateText, Version=2020-06-01，V4 签名）。
 * settings.volcKey = "AccessKeyId#SecretAccessKey"，settings.volcRegion 默认 cn-north-1。
 * 支持一次传多段文本（texts），批量走 TextList，省签名次数。
 */
async function viaVolcApiBatch(texts, settings, target) {
  const raw = String(settings.volcKey || '').trim();
  const [ak, sk] = raw.split('#');
  if (!ak || !sk) throw new Error('火山引擎翻译需要 AccessKeyId#SecretAccessKey，请在设置中按 AK#SK 格式填写');
  const region = String(settings.volcRegion || '').trim() || 'cn-north-1';
  const service = 'translate';
  const host = 'open.volcengineapi.com';
  const query = 'Action=TranslateText&Version=2020-06-01';

  const body = JSON.stringify({
    TargetLanguage: VOLC_API_LANG[target] || 'zh',
    TextList: texts,
  });

  const xDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = xDate.slice(0, 8);
  const contentSha256 = sha256Hex(body);
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalHeaders =
    `content-type:application/json\nhost:${host}\nx-content-sha256:${contentSha256}\nx-date:${xDate}\n`;
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, contentSha256].join('\n');
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(sk, shortDate);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}/?${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: host,
      'X-Date': xDate,
      'X-Content-Sha256': contentSha256,
      Authorization: authorization,
    },
    body,
  });
  const rawText = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`火山引擎翻译返回 ${res.status}: ${rawText.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(rawText); } catch (_) { throw new Error('火山引擎翻译返回内容无法解析'); }
  if (data?.ResponseMetadata?.Error) {
    const err = data.ResponseMetadata.Error;
    const e = new Error(`火山引擎翻译错误 ${err.Code || ''}: ${err.Message || ''}`);
    if (err.Code === 'FlowLimitExceeded' || /limit/i.test(String(err.Code))) e.retryable = true;
    throw e;
  }
  const list = data?.TranslationList;
  if (!Array.isArray(list)) throw new Error('火山引擎翻译返回内容无法解析');
  return texts.map((t, i) => String(list[i]?.Translation || '').trim() || t);
}

function volcApiSingle(text, settings, target) {
  return viaVolcApiBatch([text], settings, target).then((out) => out[0]);
}

// ==================== 有道 ====================

const YOUDAO_LANG = { zh: 'zh-CHS', 'zh-tw': 'zh-CHT', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it' };
const youdaoLang = (l) => YOUDAO_LANG[l] || 'zh-CHS';

/** 有道翻译 · 网页版公开端点（免密钥） */
async function viaYoudaoWeb(text, settings, target) {
  const targetLang = youdaoLang(target);
  const sourceLang = target === 'en' ? 'zh-CHS' : 'en';
  const params = new URLSearchParams({ from: sourceLang, to: targetLang, q: text });
  const res = await fetch('https://aidemo.youdao.com/trans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`有道网页翻译返回 ${res.status}: ${await readErrorBody(res)}`);
  const data = await res.json();
  if (data?.errorCode && String(data.errorCode) !== '0') throw new Error(`有道网页翻译错误码 ${data.errorCode}`);
  const list = data?.translation;
  if (!Array.isArray(list) || !list.length) throw new Error('有道网页翻译返回内容无法解析');
  return list.join('\n').trim();
}

// 有道智云 v3 签名的防长度泄露截断规则
export function youdaoTruncate(q) {
  const len = q.length;
  if (len <= 20) return q;
  return q.substring(0, 10) + len + q.substring(len - 10, len);
}

/**
 * 有道智云文本翻译（sign v3）。
 * settings.youdaoKey = "应用ID#应用密钥"，settings.youdaoVocabId 可选。
 */
async function viaYoudaoApi(text, settings, target) {
  const raw = String(settings.youdaoKey || '').trim();
  const [appKey, appSecret] = raw.split('#');
  if (!appKey || !appSecret) throw new Error('有道智云翻译需要 应用ID#应用密钥，请在设置中按该格式填写');
  const vocabId = String(settings.youdaoVocabId || '').trim();
  const targetLang = youdaoLang(target);
  const sourceLang = target === 'en' ? 'zh-CHS' : 'en';
  const salt = crypto.randomUUID();
  const curtime = Math.round(Date.now() / 1000);
  const sign = sha256Hex(appKey + youdaoTruncate(text) + salt + curtime + appSecret);

  const params = new URLSearchParams({
    q: text, appKey, salt, from: sourceLang, to: targetLang, sign, signType: 'v3', curtime: String(curtime),
  });
  if (vocabId) params.set('vocabId', vocabId);

  const res = await fetch('https://openapi.youdao.com/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`有道智云返回 ${res.status}: ${await readErrorBody(res)}`);
  const data = await res.json();
  if (String(data?.errorCode) !== '0') throw new Error(`有道智云错误码 ${data?.errorCode || '未知'}`);
  const list = data?.translation;
  if (!Array.isArray(list) || !list.length) throw new Error('有道智云返回内容无法解析');
  return list.join('').trim();
}

// ==================== 百度 ====================

const BAIDU_LANG = { zh: 'zh', 'zh-tw': 'cht', en: 'en', ja: 'jp', ko: 'kor', fr: 'fra', de: 'de', es: 'spa', ru: 'ru', pt: 'pt', it: 'it' };

/** 百度翻译开放平台（通用文本翻译）。settings.baiduKey = "AppID#密钥"。 */
async function viaBaidu(text, settings, target) {
  const raw = String(settings.baiduKey || '').trim();
  const [appid, key] = raw.split('#');
  if (!appid || !key) throw new Error('百度翻译需要 AppID#密钥，请在设置中按该格式填写');
  const targetLang = BAIDU_LANG[target] || 'zh';
  const sourceLang = target === 'en' ? 'zh' : 'en';
  const salt = String(Date.now());
  const sign = crypto.createHash('md5').update(appid + text + salt + key, 'utf8').digest('hex');

  const params = new URLSearchParams({ q: text, appid, from: sourceLang, to: targetLang, salt, sign });
  const res = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`百度翻译返回 ${res.status}: ${await readErrorBody(res)}`);
  const data = await res.json();
  if (data?.error_code) throw new Error(`百度翻译错误码 ${data.error_code}: ${data.error_msg || ''}`);
  const list = data?.trans_result;
  if (!Array.isArray(list) || !list.length) throw new Error('百度翻译返回内容无法解析');
  return list.map((r) => r.dst || '').join('').trim();
}

// ==================== 腾讯云 ====================

const TENCENT_LANG = { zh: 'zh', 'zh-tw': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it' };

/** 腾讯云文本翻译（TextTranslate，TC3-HMAC-SHA256 签名）。settings.tencentKey = "SecretId#SecretKey"。 */
async function viaTencent(text, settings, target) {
  const raw = String(settings.tencentKey || '').trim();
  const [secretId, secretKey] = raw.split('#');
  if (!secretId || !secretKey) throw new Error('腾讯云翻译需要 SecretId#SecretKey，请在设置中按该格式填写');
  const region = String(settings.tencentRegion || '').trim() || 'ap-shanghai';
  const host = 'tmt.tencentcloudapi.com';
  const targetLang = TENCENT_LANG[target] || 'zh';
  const sourceLang = target === 'en' ? 'zh' : 'en';

  const payload = JSON.stringify({ SourceText: text, Source: sourceLang, Target: targetLang, ProjectId: 0 });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(payload)].join('\n');
  const credentialScope = `${date}/tmt/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(`TC3${secretKey}`, date);
  const kService = hmacSha256(hmacSha256(kDate, 'tmt'), 'tc3_request');
  const signature = crypto.createHmac('sha256', kService).update(stringToSign, 'utf8').digest('hex');
  const authorization =
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      Authorization: authorization,
      'X-TC-Action': 'TextTranslate',
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': '2018-03-21',
      'X-TC-Region': region,
    },
    body: payload,
  });
  const rawText = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`腾讯云翻译返回 ${res.status}: ${rawText.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(rawText); } catch (_) { throw new Error('腾讯云翻译返回内容无法解析'); }
  const resp = data?.Response;
  if (resp?.Error) throw new Error(`腾讯云翻译错误 ${resp.Error.Code || ''}: ${resp.Error.Message || ''}`);
  const out = resp?.TargetText || '';
  if (!out) throw new Error('腾讯云翻译返回内容为空');
  return String(out).trim();
}

// ==================== 免费接口（MyMemory） ====================

async function viaFree(text, settings, target) {
  const pair = target === 'en' ? 'zh-CN|en' : 'en|zh-CN';
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + pair;
  const res = await fetch(url, { headers: { 'User-Agent': 'SciTerminal/1.0' } });
  if (!res.ok) throw new Error('免费翻译接口返回 ' + res.status);
  const data = await res.json();
  if (data?.responseStatus !== 200 && data?.responseStatus !== '200') throw new Error('免费翻译失败：' + (data?.responseDetails || '未知错误'));
  return (data?.responseData?.translatedText || '').trim();
}

// ==================== 服务登记与分发 ====================

/** 划词/全文翻译共用引擎清单（前端设置面板的数据源） */
export const TRANSLATE_PROVIDERS = [
  { id: 'siliconflow', label: '硅基流动 DeepSeek（用上方 API Key）', needsKey: false },
  { id: 'deepl', label: 'DeepL（需单独 Key）', needsKey: true },
  { id: 'volcweb', label: '火山翻译 · 网页版（免密钥）', needsKey: false },
  { id: 'youdaoweb', label: '有道翻译 · 网页版（免密钥）', needsKey: false },
  { id: 'volcapi', label: '火山引擎机器翻译（需 AccessKey）', needsKey: true },
  { id: 'youdaoapi', label: '有道智云翻译（需 应用ID/密钥）', needsKey: true },
  { id: 'baidu', label: '百度翻译开放平台（需 AppID/密钥）', needsKey: true },
  { id: 'tencent', label: '腾讯云机器翻译（需 SecretId/Key）', needsKey: true },
  { id: 'free', label: '免费接口（MyMemory，无需密钥）', needsKey: false },
];

export function translateProviderLabel(id) {
  return (TRANSLATE_PROVIDERS.find((p) => p.id === id) || {}).label || id || '';
}

/** 除 LLM 外全部支持的引擎 id（全文翻译 createEngine 用） */
export const NON_LLM_PROVIDERS = new Set(TRANSLATE_PROVIDERS.map((p) => p.id).filter((id) => id !== 'siliconflow'));

/** 单段翻译入口：providerId → 对应服务 */
export async function translateWithProvider(providerId, text, settings, target) {
  switch (providerId) {
    case 'deepl': return viaDeepL(text, settings, target);
    case 'volcweb': return viaVolcWeb(text, settings, target);
    case 'volcapi': return volcApiSingle(text, settings, target);
    case 'youdaoweb': return viaYoudaoWeb(text, settings, target);
    case 'youdaoapi': return viaYoudaoApi(text, settings, target);
    case 'baidu': return viaBaidu(text, settings, target);
    case 'tencent': return viaTencent(text, settings, target);
    case 'free': return viaFree(text, settings, target);
    default: throw new Error(`未知翻译服务：${providerId}`);
  }
}

/** 火山引擎批量接口（全文翻译用；其余服务由引擎层逐段调用） */
export async function translateBatchWithProvider(providerId, texts, settings, target) {
  if (providerId === 'volcapi') return viaVolcApiBatch(texts, settings, target);
  const out = [];
  for (const t of texts) out.push(await translateWithProvider(providerId, t, settings, target));
  return out;
}

export const __test__ = {
  officialDeepLEndpoint,
  hmacSha256,
  sha256Hex,
  youdaoTruncate,
};
