// streamProbe.js —— 判断「上游到底有没有正常回话」，用于「一键体检」。
//
// 为什么不能用原来的做法（发 stream:false 的小请求，等整段 JSON）：
//   推理模型（gpt-5.x 这类）会先思考再输出，非流式要等**整段回答**生成完才返回。
//   实测 mellowing / gpt-6-astra 非流式 81.9 秒、mellowing / gpt-5.6-terra 流式首字节 41.1 秒。
//   于是「30 秒超时」把三条明明能用的模型全判成了不可用。
//
// 现在的判据：发流式请求，**拿到第一个有效数据块就算通过**（推理模型的首字通常快得多），
// 然后立刻断开，不必等整段回答。非 SSE（上游忽略 stream 参数直接返回 JSON）也照样支持。
//
// 这个模块刻意不碰网络框架：只处理「一段文本能不能判定为有效载荷」，
// 以及「从一个 Response 里读到第一个有效载荷」，方便单测直接喂字符串。

/**
 * 判断一段（可能是分片的）响应文本是否已经能确认「上游正常」。
 *
 * @param {string} text        累积到的文本
 * @param {object} options
 * @param {string} options.contentType  响应头的 content-type（小写即可）
 * @param {boolean} options.partial     是否只是「目前读到的片段」（true 时，读不出结论就返回 ok:false / error:''，让调用方继续读）
 * @returns {{ok: boolean, error: string, sample: string}}
 */
export function judgePayloadText(text, { contentType = '', partial = false } = {}) {
  const raw = String(text || '');
  const trimmed = raw.trim();
  const ct = String(contentType || '').toLowerCase();
  const undecided = { ok: false, error: '', sample: '' };

  // 网关首页那种「状态码 200 但返回网页」——最常见的误判来源
  if (/^</.test(trimmed)) {
    return { ok: false, error: '返回的是网页而不是模型响应（Base URL 可能少写了 /v1）', sample: '' };
  }
  if (!trimmed) return partial ? undecided : { ok: false, error: '上游没有返回任何内容', sample: '' };

  // ① SSE：出现 data: 且载荷能解析出对象，就算通过
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let data;
    try { data = JSON.parse(payload); } catch (_) { continue; }   // JSON 被分片了，等下一块
    if (data?.error) return { ok: false, error: errorText(data.error), sample: '' };
    return { ok: true, error: '', sample: payload.slice(0, 160) };
  }

  // ② 非 SSE：整段 JSON（上游忽略 stream 参数时会走这里）
  if (ct.includes('application/json') || /^[{[]/.test(trimmed)) {
    let data;
    try { data = JSON.parse(trimmed); } catch (_) {
      return partial ? undecided : { ok: false, error: '返回的不是有效 JSON（可能被截断）', sample: trimmed.slice(0, 160) };
    }
    if (data?.error) return { ok: false, error: errorText(data.error), sample: '' };
    return { ok: true, error: '', sample: trimmed.slice(0, 160) };
  }

  if (partial) return undecided;
  return { ok: false, error: `无法识别的响应：${trimmed.slice(0, 160)}`, sample: '' };
}

function errorText(error) {
  if (typeof error === 'string') return error;
  return error?.message || '模型返回错误';
}

/**
 * 从一个 Response 里读到「第一个有效载荷」就返回，并主动断流（不等整段回答）。
 *
 * @param {Response} up            上游响应（已确认 ok 且不是网页）
 * @param {object}   options
 * @param {number}   options.timeoutMs  单独给「读响应」的预算，超时返回 timedOut:true
 * @returns {Promise<{ok: boolean, error: string, sample: string, timedOut: boolean}>}
 */
export async function readFirstPayload(up, { timeoutMs = 20000 } = {}) {
  const contentType = String(up?.headers?.get?.('content-type') || '').toLowerCase();
  const reader = up?.body?.getReader?.();

  if (!reader) {
    // 没有可读流（有的实现会把 body 设成 null）：退回一次性读全文
    const text = await Promise.resolve(up?.text ? up.text() : '').catch(() => '');
    const verdict = judgePayloadText(text, { contentType });
    return { ...verdict, timedOut: false };
  }

  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, error: '', sample: '', timedOut: true };
      const chunk = await withDeadline(reader.read(), remaining);
      if (chunk === TIMEOUT) return { ok: false, error: '', sample: '', timedOut: true };
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const verdict = judgePayloadText(buf, { contentType, partial: true });
      if (verdict.ok) return { ...verdict, timedOut: false };
      if (buf.length > 262144) buf = buf.slice(-8192);   // 别无限攒缓冲
    }
  } catch (e) {
    // 上游中途断开：如果有已读到的内容就交给最终判定，否则算读取失败
    if (!buf) return { ok: false, error: `读取响应失败：${e?.message || e}`, sample: '', timedOut: false };
  } finally {
    try { reader.cancel?.(); } catch (_) { /* ignore */ }
  }
  const verdict = judgePayloadText(buf, { contentType });
  return { ...verdict, timedOut: false };
}

const TIMEOUT = Symbol('timeout');

function withDeadline(promise, ms) {
  let timer = null;
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms); }),
  ]);
}
