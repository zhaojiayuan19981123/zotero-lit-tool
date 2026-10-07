// proxiedFetch.js —— 让 AI 请求能走本地 HTTP 代理（v2rayN / Clash / sing-box 这类软件）。
//
// 为什么不用现成库：Node 的 fetch（undici）不认 HTTP 代理，要用代理得引入 undici 的 ProxyAgent
// 或 http(s)-proxy-agent，多一个依赖；而我们要的场景很单一（https 上游 + 本地 http 代理），
// 自己用 node:http 的 CONNECT 隧道 + node:tls 握手就够，零依赖、可控。
//
// 关键设计：**proxyUrl 为空时是纯透传**（直接调原生 fetch）——
// 于是「不用代理」这条路径的行为与加这个功能之前完全一致，不会引入回归。
//
// 用法：
//   const up = await proxiedFetch(url, { method, headers, body, signal }, { proxyUrl });

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/**
 * 建一个「先 CONNECT 到代理、再在被授予的 socket 上做 TLS」的 https.Agent。
 * 每个请求单独建隧道（keepAlive: false）：AI 请求频率低，简单可靠优先。
 */
function tunnelAgent(proxy, { timeoutMs = 0 } = {}) {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 16 });
  agent.createConnection = (options, callback) => {
    const targetHost = options.host;
    const targetPort = options.port || 443;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; callback(err); } };

    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}`, 'Proxy-Connection': 'keep-alive' },
      agent: false,
    });
    if (timeoutMs > 0) connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error('连接代理超时')));

    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`代理拒绝建立隧道（HTTP ${res.statusCode}）`));
        return;
      }
      if (settled) { socket.destroy(); return; }
      const secure = tls.connect(
        { socket, servername: options.servername || targetHost },
        () => { if (!settled) { settled = true; callback(null, secure); } },
      );
      secure.once('error', fail);
    });
    connectReq.once('error', fail);
    connectReq.end();
  };
  return agent;
}

function headersFromNode(rawHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) { for (const v of value) headers.append(key, String(v)); }
    else if (key.toLowerCase() !== 'set-cookie') headers.set(key, String(value));
  }
  return headers;
}

function bodyToBuffer(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(String(body));
}

/**
 * 把 node 的 IncomingMessage 接成标准 ReadableStream（带背压）。
 *
 * ★ 刻意**不用** `Readable.toWeb(nodeRes)`：Node 20 的适配层在「流已经被销毁」之后
 *   收尾时，会对着已经 close 的 controller 再调一次 close()，抛
 *   `TypeError [ERR_INVALID_STATE]: Invalid state: Controller is already closed`
 *   （栈顶是 `internal/webstreams/adapters.js` 的 `IncomingMessage.onclose`）。
 *   这个异常发生在微任务里、**逃出了 `body.cancel()` 的 try/catch** → 变成
 *   uncaughtException，把整个测试进程判负 —— CI 的 Windows 作业（Node 20.19.0）就是这么红的。
 *   Node 22 时序不同，多数情况侥幸不触发，所以「本地全绿」骗过了一轮。
 *
 * 这里自己接线：所有收尾都过 finish()，用 `done` 闸门保证**只收尾一次**，二次收尾直接忽略。
 * 背压靠 `desiredSize`：缓冲满了 pause 上游，消费者 read 触发 pull 时再 resume。
 */
function nodeStreamToWeb(nodeRes) {
  let controller = null;
  let done = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    try { if (err) controller.error(err); else controller.close(); } catch (_) { /* 已收尾，忽略 */ }
  };
  return new ReadableStream({
    start(c) {
      controller = c;
      nodeRes.on('data', (chunk) => {
        if (done) return;
        try {
          controller.enqueue(chunk);
        } catch (_) {
          // 消费者已经取消：别再读了（cancel 里已经 destroy 过，这里兜底）
          done = true;
          try { nodeRes.destroy(); } catch (_) { /* ignore */ }
          return;
        }
        const size = controller.desiredSize;
        if (size !== null && size <= 0) nodeRes.pause();
      });
      nodeRes.on('end', () => finish(null));
      nodeRes.on('error', (e) => finish(e));
      // 'close' 会在 end / abort / destroy 之后再触发一次；done 闸门保证幂等
      nodeRes.on('close', () => finish(null));
    },
    pull() {
      if (!done) nodeRes.resume();
    },
    cancel() {
      done = true;
      try { nodeRes.destroy(); } catch (_) { /* ignore */ }
    },
  }, { highWaterMark: 16 });
}

/**
 * 把 node 的 IncomingMessage 包成标准 Response，使 readLLMResponse / .text() / .body.getReader() 都能用。
 */
function toResponse(nodeRes) {
  const status = Number(nodeRes.statusCode) || 500;
  const headers = headersFromNode(nodeRes.headers);
  // 204 / 205 / 304 不允许带 body
  if (status === 204 || status === 205 || status === 304) {
    nodeRes.resume();
    return new Response(null, { status, statusText: nodeRes.statusMessage, headers });
  }
  return new Response(nodeStreamToWeb(nodeRes), { status, statusText: nodeRes.statusMessage, headers });
}

/**
 * 带代理的 fetch：https 目标走 CONNECT 隧道，其它情况原样交给原生 fetch。
 *
 * @param {string} url
 * @param {object} init              与 fetch 的 init 同形（method / headers / body / signal）
 * @param {object} options
 * @param {string} options.proxyUrl  形如 http://127.0.0.1:10809；空则纯透传
 * @param {number} options.timeoutMs 建立隧道与首包的整体预算（0 = 不限，由调用方的 AbortSignal 管）
 * @returns {Promise<Response>}
 */
export async function proxiedFetch(url, init = {}, { proxyUrl = '', timeoutMs = 0 } = {}) {
  const proxy = String(proxyUrl || '').trim();
  if (!proxy) return fetch(url, init);

  let target;
  let proxyUrlObj;
  try {
    target = new URL(url);
    proxyUrlObj = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
  } catch (_) {
    return fetch(url, init);   // 地址解析不了就交回原生 fetch，让它报原本的错
  }
  const isHttps = target.protocol === 'https:';
  // 只给 https 目标做隧道（AI 上游清一色是 https）；http 目标或非 http 代理（如 socks）交回原生 fetch。
  // 刻意**不限制端口**：自建网关用 8443 / 9443 这类端口的很常见。
  if (!isHttps || !/^https?:$/.test(proxyUrlObj.protocol)) {
    return fetch(url, init);
  }

  const agent = tunnelAgent(proxyUrlObj, { timeoutMs });
  return await new Promise((resolve, reject) => {
    const req = https.request({
      host: target.hostname,
      port: target.port ? Number(target.port) : 443,
      path: `${target.pathname}${target.search}`,
      method: (init.method || 'GET').toUpperCase(),
      headers: init.headers || {},
      agent,
    }, (nodeRes) => {
      try { resolve(toResponse(nodeRes)); } catch (e) { reject(e); }
    });

    const signal = init.signal;
    const onAbort = () => {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      req.destroy(err);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.once('error', (e) => {
      if (signal) signal.removeEventListener?.('abort', onAbort);
      reject(e);
    });
    req.once('close', () => { if (signal) signal.removeEventListener?.('abort', onAbort); });
    req.end(bodyToBuffer(init.body));
  });
}

/**
 * 探测一个地址是否为可用的 HTTP 代理：走它请求一个 https 目标，能拿到任意 HTTP 响应就算通。
 * 不关心状态码（401/404 都说明隧道通了），只关心「能不能建立连接并收到响应」。
 *
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function probeProxy(proxyUrl, targetUrl, { timeoutMs = 6000 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const up = await proxiedFetch(targetUrl, { method: 'GET', signal: controller.signal }, { proxyUrl, timeoutMs });
      const status = up.status;
      try { await up.body?.cancel?.(); } catch (_) { /* ignore */ }
      return { ok: true, status };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? '探测超时' : (e?.message || String(e)) };
  }
}
