import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';

import { translate } from '../src/translate.js';
import {
  TRANSLATE_PROVIDERS, NON_LLM_PROVIDERS, translateProviderLabel, translateWithProvider, translateBatchWithProvider,
} from '../src/translateProviders.js';

test('DeepL 官方请求使用 DeepL-Auth-Key、JSON body，并按 target 传语言', async () => {
  const oldFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ translations: [{ text: 'translated' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await translate('hello', { translateProvider: 'deepl', deeplKey: 'key:fx' }, { target: 'en' });
    assert.equal(result, 'translated');
    assert.equal(seen[0].url, 'https://api-free.deepl.com/v2/translate');
    assert.equal(seen[0].opts.headers.Authorization, 'DeepL-Auth-Key key:fx');
    assert.equal(seen[0].opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(seen[0].opts.body), { text: ['hello'], target_lang: 'EN-US' });
  } finally { global.fetch = oldFetch; }
});

test('DeepL 非 Free key 自动走 Pro 端点，自定义 DeepLX 保持兼容请求', async () => {
  const oldFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ translations: [{ text: '译文' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await translate('text', { translateProvider: 'deepl', deeplKey: 'pro-key' });
    assert.equal(seen[0].url, 'https://api.deepl.com/v2/translate');
    await translate('text', { translateProvider: 'deepl', deeplKey: 'custom-key', deeplEndpoint: 'http://127.0.0.1:1188/translate' });
    assert.equal(seen[1].url, 'http://127.0.0.1:1188/translate');
    assert.match(seen[1].opts.body, /auth_key=custom-key/);
  } finally { global.fetch = oldFetch; }
});

test('选 DeepL 但未配 Key 时给出明确错误', async () => {
  await assert.rejects(translate('hello', { translateProvider: 'deepl' }), /未配置 DeepL API Key/);
});

// ==================== 火山/有道网页版（免密钥） ====================

test('火山网页翻译：POST 官方 crx 端点并解析 translation 字段', async () => {
  const oldFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ translation: '你好世界' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const out = await translate('hello world', { translateProvider: 'volcweb' });
    assert.equal(out, '你好世界');
    assert.equal(seen[0].url, 'https://translate.volcengine.com/crx/translate/v1/');
    const body = JSON.parse(seen[0].opts.body);
    assert.deepEqual(body, { source_language: 'en', target_language: 'zh', text: 'hello world' });
    // 译向英文时源语言切换为中文
    await translate('你好', { translateProvider: 'volcweb' }, { target: 'en' });
    assert.equal(JSON.parse(seen[1].opts.body).target_language, 'en');
    assert.equal(JSON.parse(seen[1].opts.body).source_language, 'zh');
  } finally { global.fetch = oldFetch; }
});

test('有道网页翻译：POST aidemo 端点并用换行拼接多条译文', async () => {
  const oldFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ errorCode: '0', translation: ['第一段', '第二段'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const out = await translate('some text', { translateProvider: 'youdaoweb' });
    assert.equal(out, '第一段\n第二段');
    assert.equal(seen[0].url, 'https://aidemo.youdao.com/trans');
    const params = new URLSearchParams(seen[0].opts.body);
    assert.equal(params.get('q'), 'some text');
    assert.equal(params.get('from'), 'en');
    assert.equal(params.get('to'), 'zh-CHS');
  } finally { global.fetch = oldFetch; }
});

// ==================== 需密钥服务：签名与参数 ====================

test('百度翻译：MD5 签名 = md5(appid+q+salt+key)', async () => {
  const oldFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ from: 'en', to: 'zh', trans_result: [{ src: 'hi', dst: '嗨' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const out = await translate('hi', { translateProvider: 'baidu', baiduKey: '20260101#mysecret' });
    assert.equal(out, '嗨');
    assert.equal(seen[0].url, 'https://fanyi-api.baidu.com/api/trans/vip/translate');
    const p = new URLSearchParams(seen[0].opts.body);
    assert.equal(p.get('appid'), '20260101');
    const expectSign = crypto.createHash('md5').update('20260101' + 'hi' + p.get('salt') + 'mysecret', 'utf8').digest('hex');
    assert.equal(p.get('sign'), expectSign);
  } finally { global.fetch = oldFetch; }
});

test('有道智云：sign v3 = sha256(appKey+truncate(q)+salt+curtime+密钥)', async () => {
  const oldFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ errorCode: '0', translation: ['译文'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const q = 'a'.repeat(25); // 长度 > 20，验证截断规则参与签名
    const out = await translate(q, { translateProvider: 'youdaoapi', youdaoKey: 'myapp#mysecret' });
    assert.equal(out, '译文');
    assert.equal(seen[0].url, 'https://openapi.youdao.com/api');
    const p = new URLSearchParams(seen[0].opts.body);
    assert.equal(p.get('appKey'), 'myapp');
    assert.equal(p.get('signType'), 'v3');
    const truncated = q.substring(0, 10) + q.length + q.substring(q.length - 10, q.length);
    const expectSign = crypto.createHash('sha256').update('myapp' + truncated + p.get('salt') + p.get('curtime') + 'mysecret', 'utf8').digest('hex');
    assert.equal(p.get('sign'), expectSign);
  } finally { global.fetch = oldFetch; }
});

test('youdaoTruncate 单元：≤20 原样返回，>20 取首尾各 10 字符夹长度', async () => {
  const { __test__ } = await import('../src/translateProviders.js');
  const short = 'short';
  assert.equal(__test__.youdaoTruncate(short), short);
  const q = '0123456789abcdefghij0123456789'; // 长度 30
  assert.equal(__test__.youdaoTruncate(q), '0123456789' + '30' + '0123456789');
});

test('火山引擎 API：V4 签名头齐全，TextList 批量保持顺序', async () => {
  const oldFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ TranslationList: [{ Translation: '一' }, { Translation: '二' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const out = await translateBatchWithProvider('volcapi', ['a', 'b'], { volcKey: 'ak#sk' }, 'zh');
    assert.deepEqual(out, ['一', '二']);
    assert.equal(seen[0].url, 'https://open.volcengineapi.com/?Action=TranslateText&Version=2020-06-01');
    const h = seen[0].opts.headers;
    assert.match(h.Authorization, /^HMAC-SHA256 Credential=ak\//);
    assert.match(h.Authorization, /SignedHeaders=content-type;host;x-content-sha256;x-date/);
    assert.ok(h['X-Date'] && h['X-Content-Sha256']);
    assert.deepEqual(JSON.parse(seen[0].opts.body).TextList, ['a', 'b']);
  } finally { global.fetch = oldFetch; }
});

test('腾讯云翻译：TC3 签名头齐全并解析 TargetText', async () => {
  const oldFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ Response: { TargetText: '你好' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const out = await translate('hello', { translateProvider: 'tencent', tencentKey: 'id#key' });
    assert.equal(out, '你好');
    const h = seen[0].opts.headers;
    assert.match(h.Authorization, /^TC3-HMAC-SHA256 Credential=id\//);
    assert.equal(h['X-TC-Action'], 'TextTranslate');
    assert.equal(h['X-TC-Region'], 'ap-shanghai');
  } finally { global.fetch = oldFetch; }
});

test('密钥缺失时各服务给出格式提示错误', async () => {
  await assert.rejects(translate('x', { translateProvider: 'volcapi' }), /AccessKeyId#SecretAccessKey/);
  await assert.rejects(translate('x', { translateProvider: 'youdaoapi' }), /应用ID#应用密钥/);
  await assert.rejects(translate('x', { translateProvider: 'baidu' }), /AppID#密钥/);
  await assert.rejects(translate('x', { translateProvider: 'tencent' }), /SecretId#SecretKey/);
  await assert.rejects(translate('x', { translateProvider: 'nosuch' }), /未知翻译服务/);
});

test('服务清单元数据：9 项、标签可查、NON_LLM 不含 LLM', () => {
  assert.equal(TRANSLATE_PROVIDERS.length, 9);
  assert.equal(translateProviderLabel('volcweb'), '火山翻译 · 网页版（免密钥）');
  assert.equal(translateProviderLabel('youdaoweb'), '有道翻译 · 网页版（免密钥）');
  assert.ok(!NON_LLM_PROVIDERS.has('siliconflow'));
  for (const id of ['deepl', 'volcweb', 'youdaoweb', 'volcapi', 'youdaoapi', 'baidu', 'tencent', 'free']) {
    assert.ok(NON_LLM_PROVIDERS.has(id), id + ' 应在 NON_LLM_PROVIDERS 中');
  }
});



test('大模型翻译使用当前激活 profile，并清理误填的完整 chat/completions 地址', async () => {
  const oldFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ choices: [{ message: { content: '激活模型译文' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const out = await translate('hello', {
      translateProvider: 'siliconflow', aiProvider: 'custom', activeProfileId: 'local', modelProfiles: [
        { id: 'old', provider: 'custom', baseURL: 'https://old.example/v1', apiKey: 'old-key', model: 'old-model' },
        { id: 'local', provider: 'custom', baseURL: 'http://127.0.0.1:11434/v1/chat/completions', apiKey: '', model: 'qwen-local', authMode: 'none', systemPromptMode: 'user' },
      ],
    });
    assert.equal(out, '激活模型译文');
    assert.equal(seen[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(seen[0].opts.headers.Authorization, undefined);
    const body = JSON.parse(seen[0].opts.body);
    assert.equal(body.model, 'qwen-local');
    assert.equal(body.messages.length, 1);
    assert.match(body.messages[0].content, /任务要求/);
  } finally { global.fetch = oldFetch; }
});
