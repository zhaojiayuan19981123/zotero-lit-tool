// util.js —— 全文翻译模块的公共小工具

/**
 * 把各种二进制输入统一成「货真价实的 Uint8Array」。
 *
 * 为什么需要这个：Node 的 Buffer 是 Uint8Array 的子类，但 pdf.js 内部会显式拒绝
 * Buffer（抛 "Please provide binary data as `Uint8Array`, rather than `Buffer`"），
 * 所以 `bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)` 这种常见写法在
 * Buffer 上会失效——必须主动转成基于同一块内存的 Uint8Array 视图。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|ArrayBufferView|string} input
 * @param {{copy?: boolean}} [options] copy=true 时返回一块独立的副本。
 *
 * ⚠️ 什么时候必须 copy：pdf.js 的 getDocumentProxy 会把传入的 ArrayBuffer
 * **transfer 走（detach）**。默认实现返回的是「同一块内存的视图」，一旦把它交给
 * pdf.js，调用方手里那份字节（无论是 Buffer 还是 Uint8Array）底层 buffer 也会
 * 一起变成 detached，之后再拿去渲染就会炸
 * "Cannot perform Construct on a detached ArrayBuffer"。
 * 因此凡是「同一份字节要被多个阶段复用」的场景（先解析版面、后渲染成品），
 * 喂给 pdf.js 的那一份必须 copy=true。
 */
export function toUint8Array(input, options = {}) {
  const view = asBinaryView(input);
  if (!options.copy) return view;
  // Uint8Array.prototype.slice 会分配一块新的 ArrayBuffer，得到真正独立的副本
  return view.slice();
}

function asBinaryView(input) {
  if (!input) return new Uint8Array(0);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return new Uint8Array(Buffer.from(input, 'base64'));
  throw new Error('无法识别的二进制输入类型');
}

export function abortError(message = '任务已取消') {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
