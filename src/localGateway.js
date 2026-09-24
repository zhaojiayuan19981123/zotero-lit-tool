// localGateway.js —— 本地「OpenAI 兼容」端口（默认 http://127.0.0.1:15721）。
//
// 需求背景（像 cc-switch 那样）：让**别的软件**也能用上本应用已经配好的多模型队列 + 故障转移。
// 只要把那个软件的 Base URL 填成 http://127.0.0.1:15721/v1 即可。
//
// 支持的接口（只绑 127.0.0.1，不对外网暴露）：
//   POST /v1/chat/completions   —— 支持 stream:true（标准 SSE chunk）与 stream:false（JSON）
//   POST /v1/completions        —— 同上（老式补全接口的别名，很多工具还在用）
//   GET  /v1/models             —— 列出已配置的模型
//   GET  /health                —— 健康检查
//
// 这个模块只做 HTTP 管道（路由 / CORS / 解析 / 错误形状），
// 「怎么调模型」由外部注入的 handleChat 决定 —— 于是它能脱离 server.js 单测。

import http from 'node:http';

export const DEFAULT_GATEWAY_CONFIG = {
  enabled: true,
  port: 15721,
  // 只绑本机回环：不暴露给局域网，避免被同网段的人白用你的 API Key
  host: '127.0.0.1',
};

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export function normalizeGatewayConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let port = Number(r.port);
  if (!Number.isFinite(port)) port = DEFAULT_GATEWAY_CONFIG.port;
  port = Math.min(65535, Math.max(1024, Math.round(port)));
  return {
    enabled: r.enabled === undefined ? DEFAULT_GATEWAY_CONFIG.enabled : !!r.enabled,
    port,
    host: DEFAULT_GATEWAY_CONFIG.host,   // 刻意不可配：永远只绑回环
  };
}

export function readGatewayConfig(settings) {
  return normalizeGatewayConfig(settings?.localGateway);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大（上限 16MB）'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** OpenAI 形状的错误 —— 这样调用方（各种客户端）能按习惯解析出来 */
function jsonError(res, status, message, type = 'invalid_request_error') {
  json(res, status, { error: { message, type, code: null, param: null } });
}

// ---------------- 纯函数：请求归一化与 OpenAI 形状构造（可单测） ----------------

const OPENAI_ROLES = new Set(['system', 'user', 'assistant', 'developer', 'tool']);

/**
 * 把调用方传来的 OpenAI messages 归一化成内部格式。
 * - content 允许是字符串，也允许是 [{type:'text',text}] 这种分片数组（很多客户端这么发）；
 * - 丢掉空内容的消息：空 content 会让 Responses API 直接报「参数非法」；
 * - developer 角色（OpenAI 新写法）统一降级成 system。
 */
export function normalizeMessages(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const m of list) {
    let role = String(m?.role || '').toLowerCase();
    if (!OPENAI_ROLES.has(role)) role = 'user';
    if (role === 'developer') role = 'system';
    if (role === 'tool') continue;   // 工具调用结果暂不支持，直接跳过而不是把非法内容塞给上游

    let content = m?.content;
    if (Array.isArray(content)) {
      content = content.map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') return part.text || '';
        return '';
      }).join('');
    }
    const text = typeof content === 'string' ? content : (content === null || content === undefined ? '' : String(content));
    if (!text.trim()) continue;
    out.push({ role, content: text });
  }
  return out;
}

/**
 * 按调用方传来的 model 名，从已配置模型里挑一条。
 * 支持三种写法：模型名本身、配置 id、配置的显示名（label）；也容忍带厂商前缀的写法（如 openai/gpt-5.6）。
 * 都没匹配上返回 null —— 由调用方回落到「当前激活模型」。
 */
export function pickProfileByModel(profiles, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const list = Array.isArray(profiles) ? profiles : [];
  const norm = (v) => String(v || '').trim().toLowerCase();
  return list.find((p) => norm(p?.model) === want)
    || list.find((p) => norm(p?.id) === want)
    || list.find((p) => norm(p?.label) === want)
    || list.find((p) => {
      const m = norm(p?.model);
      return m && (m.endsWith(`/${want}`) || want.endsWith(`/${m}`));
    })
    || null;
}

/** OpenAI 非流式响应体 */
export function buildChatCompletion({ id, model, content, created = Math.floor(Date.now() / 1000) }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * 生成一个「往 res 写标准 OpenAI SSE chunk」的写入器。
 * finish() 之后调用方应自己 end()，这样中途出错也能补一个 error 事件再收尾。
 */
export function createChunkWriter(res, { id, model, created = Math.floor(Date.now() / 1000) }) {
  let closed = false;
  const write = (obj) => {
    if (closed) return;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) { closed = true; }
  };
  return {
    delta(text) {
      if (!text) return;
      write({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
    },
    finish(reason = 'stop') {
      write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
    },
    error(message) {
      write({ error: { message: String(message || '调用模型失败'), type: 'api_error' } });
    },
    done() {
      if (closed) return;
      try { res.write('data: [DONE]\n\n'); res.end(); } catch (_) { /* 对端已断开 */ }
      closed = true;
    },
  };
}

export function createLocalGateway({ getConfig, handleChat, listModels, onEvent = () => {} }) {  let server = null;
  let runningConfig = null;
  let lastError = '';
  let startedAt = 0;

  function status() {
    const desired = normalizeGatewayConfig(getConfig());
    return {
      ...desired,
      running: !!server && server.listening,
      actualPort: server?.address()?.port || 0,
      startedAt,
      error: lastError,
      baseURL: server?.listening ? `http://127.0.0.1:${server.address().port}/v1` : '',
    };
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      const closing = server;
      server = null;
      runningConfig = null;
      closing.close(() => resolve());
      // 已在处理中的长连接（流式回答）不该把关闭卡住
      setTimeout(() => { try { closing.closeAllConnections?.(); } catch (_) {} }, 300).unref?.();
    });
  }

  function start() {
    const config = normalizeGatewayConfig(getConfig());
    return new Promise((resolve) => {
      if (!config.enabled) { resolve({ ok: false, disabled: true, config }); return; }
      const next = http.createServer((req, res) => { handleRequest(req, res); });
      next.on('error', (e) => {
        lastError = e?.code === 'EADDRINUSE'
          ? `端口 ${config.port} 已被占用（可能是另一个程序或本应用的另一个实例），换个端口或关掉它`
          : (e?.message || '本地端口启动失败');
        server = null;
        runningConfig = null;
        onEvent({ type: 'error', error: lastError });
        resolve({ ok: false, error: lastError, config });
      });
      next.listen(config.port, config.host, () => {
        server = next;
        runningConfig = config;
        lastError = '';
        startedAt = Date.now();
        onEvent({ type: 'listening', port: next.address().port });
        resolve({ ok: true, port: next.address().port, config });
      });
    });
  }

  /** 配置变了就重启（端口改动 / 开关切换） */
  async function sync() {
    const desired = normalizeGatewayConfig(getConfig());
    if (desired.enabled && runningConfig && runningConfig.port === desired.port && server?.listening) return status();
    if (!desired.enabled && !server) return status();
    await stop();
    if (!desired.enabled) { lastError = ''; return status(); }
    await start();
    return status();
  }

  function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    // 浏览器里跑的客户端（如某些网页版工具）会先发预检
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With, anthropic-version, anthropic-beta',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    if (path === '/health' && method === 'GET') {
      json(res, 200, { ok: true, service: 'zotero-lit-tool local gateway' });
      return;
    }

    if (path === '/v1/models' && method === 'GET') {
      let data = [];
      try {
        data = (listModels?.() || []).map((m) => ({
          id: m.model || m.id, object: 'model', created: 0, owned_by: m.providerName || m.provider || 'sciterminal',
          label: m.label || '', profileId: m.id,
        }));
      } catch (e) {
        jsonError(res, 500, e?.message || '列出模型失败', 'api_error');
        return;
      }
      json(res, 200, { object: 'list', data });
      return;
    }

    if ((path === '/v1/chat/completions' || path === '/v1/completions') && method === 'POST') {
      readBody(req)
        .then((raw) => {
          let body = {};
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch (_) { jsonError(res, 400, '请求体不是合法 JSON'); return; }
          }
          onEvent({ type: 'request', path, model: body?.model || '', stream: body?.stream === true });
          Promise.resolve(handleChat({ body, req, res, path })).catch((e) => {
            if (res.headersSent) { try { res.end(); } catch (_) {} return; }
            const status = e?.statusCode || 502;
            jsonError(res, status, e?.message || '调用模型失败', status === 400 ? 'invalid_request_error' : 'api_error');
          });
        })
        .catch((e) => jsonError(res, e?.statusCode || 500, e?.message || '读取请求失败'));
      return;
    }

    jsonError(res, 404, `未知接口 ${path}；本端口支持 POST /v1/chat/completions、GET /v1/models、GET /health`);
  }

  return { start, stop, sync, status, get server() { return server; } };
}
