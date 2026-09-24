// 回归：失败的那次供应商尝试必须释放自己的超时定时器。
//
// 背景：非流式路由里每次尝试都会挂一个「到点就 abort」的 Timeout（时长 = 设置里的
// timeoutSeconds，默认 120 秒）。失败后换下一家时如果不把它清掉，功能上完全看不出问题，
// 但事件循环里就一直挂着那个定时器 —— 进程要干等它到期才肯退出，
// 桌面端每失败一次就多一个这样的定时器。
//
// 这个泄漏没法在同一个进程里断言（定时器不会暴露给人看），
// 所以交给子进程：scripts/probe-failover-exit.mjs 用 600 秒的超时预算跑一次故障转移，
// 跑完就结束 —— 「它能不能及时自己退出」就是判据。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const probe = path.join(repoRoot, 'scripts', 'probe-failover-exit.mjs');

// 正常情况子进程约 1.5~3 秒收工；一旦泄漏，它会被拖住整整 600 秒。给足余量即可。
const BUDGET_MS = 30000;

test('故障转移后没有残留的超时定时器（进程能自行退出）', async () => {
  const started = Date.now();
  const child = spawn(process.execPath, [probe], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const timer = setTimeout(() => child.kill('SIGKILL'), BUDGET_MS);
  const result = await new Promise((resolve) => {
    child.on('error', (e) => resolve({ code: -1, signal: null, error: e.message }));
    child.on('exit', (code, signal) => resolve({ code, signal, error: '' }));
  });
  clearTimeout(timer);

  const elapsed = Date.now() - started;
  assert.ok(!result.error, `子进程启动失败：${result.error}`);
  assert.equal(result.code, 0,
    `探针没能正常跑完（code=${result.code} signal=${result.signal}）：\n${stdout}\n${stderr}`);
  assert.ok(elapsed < BUDGET_MS,
    `探针跑了 ${elapsed}ms 还没退出 —— 说明失败的那次尝试留下了超时定时器，进程被它拖住了`);
});
