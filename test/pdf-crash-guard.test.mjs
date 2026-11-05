// pdf-crash-guard.test.mjs —— 阅读 / 解析 PDF 时的压缩流噪声不该拖垮进程
//
// 背景：某些 PDF 的 FlateDecode 流在结束标记后面还挂着垃圾字节，node:zlib 会在自己的
// 回调里抛 ERR_TRAILING_JUNK_AFTER_STREAM_END。这个抛出点在 pdf.js 的 try/catch 之外，
// 于是成为「未处理的 Promise 拒绝」；Node 默认据此结束进程 —— 用户只要把同一篇论文
// 再打开一次（对照精读一次、阅读模式一次），后端就没了。
//
// 修法是 installPdfCrashGuard()：只对 zlib 这一类放行（记一次警告），其余仍按默认抛出。
//
// 这里守两条线：
//   1) 保护**只由进程入口安装**。导入 server.js 本身不能装监听器 —— 装了的话
//      `node --test` 的子进程里，测试运行器对未处理拒绝的归属会被打断，整轮测试
//      可能被 process.exit 直接杀掉（v1.37.0 第一次 CI 就是这么红的）。
//   2) 装好之后，zlib 尾部冗余不会让进程退出。
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Windows 下动态 import 绝对路径必须是 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const SERVER = pathToFileURL(path.join(ROOT, 'server.js')).href;

const runChild = (code) => execFileSync(process.execPath, ['--input-type=module', '-e', code], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
});

test('导入 server.js 不会偷偷装 unhandledRejection 监听（只在入口装）', () => {
  const out = runChild(`
    const before = process.listenerCount('unhandledRejection');
    const m = await import(${JSON.stringify(SERVER)});
    process.stdout.write(JSON.stringify({
      before,
      after: process.listenerCount('unhandledRejection'),
      exported: typeof m.installPdfCrashGuard,
    }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.exported, 'function', '入口需要能显式安装这道保护');
  assert.equal(r.after, r.before, '模块加载期不该改变全局监听器数量');
});

test('装上保护后，压缩流尾部冗余只记一次警告、进程继续跑', () => {
  const out = runChild(`
    const { installPdfCrashGuard } = await import(${JSON.stringify(SERVER)});
    installPdfCrashGuard();
    const n1 = process.listenerCount('unhandledRejection');
    installPdfCrashGuard();          // 重复调用不该重复安装
    const junk = Object.assign(new Error('Trailing junk'), { code: 'ERR_TRAILING_JUNK_AFTER_STREAM_END' });
    Promise.reject(junk);
    Promise.reject(junk);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        once: n1,
        twice: process.listenerCount('unhandledRejection'),
        alive: true,
      }));
      process.exit(0);
    }, 150);
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.once, 1, '只装一个监听器');
  assert.equal(r.twice, 1, '重复调用是幂等的');
  assert.equal(r.alive, true, 'zlib 尾部冗余不该结束进程');
});
