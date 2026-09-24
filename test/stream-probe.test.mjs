// 流式探活判定的单测：judgePayloadText / readFirstPayload
//
// 这两个函数是「一键体检」的核心判据。它们要能：
//  1) 认出正常 SSE、正常 JSON、以及「200 但返回网页」的网关首页；
//  2) 在**拿到第一个有效数据块时就收手**，不等整段回答 —— 这是慢推理模型不再被误判超时的关键。
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgePayloadText, readFirstPayload } from '../src/streamProbe.js';

const enc = new TextEncoder();

function sseResponse(chunks, { contentType = 'text/event-stream' } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': contentType } });
}

test('judgePayloadText：正常 SSE 的第一个数据块就判定通过', () => {
  const text = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\n';
  const v = judgePayloadText(text, { contentType: 'text/event-stream', partial: true });
  assert.equal(v.ok, true);
  assert.match(v.sample, /delta/);
});

test('judgePayloadText：跳过 [DONE] 与空载荷，不把结束标记当成有效内容', () => {
  const v = judgePayloadText('data: [DONE]\n\n', { contentType: 'text/event-stream', partial: true });
  assert.equal(v.ok, false);
  assert.equal(v.error, '');   // partial 下「还没看出结论」→ 让调用方继续读
});

test('judgePayloadText：JSON 被分片时先不下结论，拼完再通过', () => {
  const half = 'data: {"choices":[{"delta":{"cont';
  assert.equal(judgePayloadText(half, { contentType: 'text/event-stream', partial: true }).ok, false);
  const whole = half + 'ent":"好"}}]}\n\n';
  assert.equal(judgePayloadText(whole, { contentType: 'text/event-stream', partial: true }).ok, true);
});

test('judgePayloadText：上游报错要如实说出来（SSE 内嵌 error）', () => {
  const v = judgePayloadText('data: {"error":{"message":"模型不存在"}}\n\n', { contentType: 'text/event-stream', partial: true });
  assert.equal(v.ok, false);
  assert.equal(v.error, '模型不存在');
});

test('judgePayloadText：忽略 stream 参数、直接回 JSON 的网关也算通过', () => {
  const body = '{"choices":[{"message":{"content":"ok"}}]}';
  const v = judgePayloadText(body, { contentType: 'application/json' });
  assert.equal(v.ok, true);
});

test('judgePayloadText：200 但返回网页 → 提示 Base URL 可能少写 /v1', () => {
  const v = judgePayloadText('<!DOCTYPE html><html><body>gateway</body></html>', { contentType: 'text/html' });
  assert.equal(v.ok, false);
  assert.match(v.error, /少写了 \/v1|网页/);
});

test('judgePayloadText：空响应与无法识别的响应分别给不同提示', () => {
  assert.equal(judgePayloadText('', {}).ok, false);
  assert.match(judgePayloadText('', {}).error, /没有返回任何内容/);
  assert.match(judgePayloadText('随便一段文本', { contentType: 'text/plain' }).error, /无法识别/);
});

test('readFirstPayload：拿到第一个数据块就返回（不等整段回答）', async () => {
  // 流里先给一个有效块，之后永远不再 close —— 如果实现是「等整段」，这里必然超时
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"首"}}]}\n\n'));
    },
  });
  const up = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  const t0 = Date.now();
  const v = await readFirstPayload(up, { timeoutMs: 5000 });
  assert.equal(v.ok, true);
  assert.ok(Date.now() - t0 < 1000, '应当在首个块到达时立刻返回');
});

test('readFirstPayload：一直没内容 → timedOut', async () => {
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(enc.encode(': keep-alive\n\n')); },
  });
  const up = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  const v = await readFirstPayload(up, { timeoutMs: 250 });
  assert.equal(v.ok, false);
  assert.equal(v.timedOut, true);
});

test('readFirstPayload：没有可读流时退回读全文（兼容 body 为 null 的实现）', async () => {
  const fake = {
    headers: { get: () => 'application/json' },
    body: null,
    text: async () => '{"choices":[{"message":{"content":"ok"}}]}',
  };
  const v = await readFirstPayload(fake, { timeoutMs: 500 });
  assert.equal(v.ok, true);
});

test('readFirstPayload：流读完但没有有效内容 → 给明确错误而不是 timedOut', async () => {
  const up = sseResponse(['data: [DONE]\n\n']);
  const v = await readFirstPayload(up, { timeoutMs: 500 });
  assert.equal(v.ok, false);
  assert.equal(v.timedOut, false);
  assert.ok(v.error.length > 0);
});
