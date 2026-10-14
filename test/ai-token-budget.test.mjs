// ai-token-budget.test.mjs —— AI 相关调用的 token 消耗回归
//
// 背景：这个应用「token 消耗快」的三个来源 ——
//   ① AI 对话每轮把整篇论文全文重新塞进 system（无状态接口必须重发 messages）；
//   ② 整篇翻译的批次失败后「全量逐段重发」，每段都带完整 system prompt；
//   ③ 全文缓存上限过大（6 万字符）。
// 这里既做「接线断言」（改回去就红），也做「真实行为断言」（拆批重试的请求数）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { translateSegments } from '../src/pdfTranslate/engines.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- ① 翻译批次失败：二分拆批，而不是全量逐段重发 ----------

/**
 * 造假引擎：批次里只要含坏标记就整批失败，并标 retryable=false。
 * 这样 withRetry 不进入退避等待，测试保持秒级。
 */
function makeEngine({ badToken = 'BAD' } = {}) {
  const calls = [];
  return {
    calls,
    engine: {
      id: 'fake',
      label: '假引擎',
      batchLimits: { maxChars: 1e9, maxItems: 1e9 }, // 全部段落进同一批
      describe: () => ({ kind: 'fake' }),
      async translateBatch(texts) {
        calls.push(texts.length);
        if (texts.some((t) => String(t).includes(badToken))) {
          throw Object.assign(new Error('整批失败'), { retryable: false });
        }
        return texts.map((t) => `[译]${t}`);
      },
    },
  };
}

const sentence = (i) => `Sentence number ${i} about asset pricing.`;

test('批次顺利时只发一次请求，全部段落都有译文', async () => {
  const { engine, calls } = makeEngine();
  const segments = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, text: sentence(i) }));
  const { map, failures } = await translateSegments({ segments, engine, concurrency: 1 });
  assert.equal(calls.length, 1);
  assert.equal(failures.length, 0);
  for (const s of segments) assert.equal(map.get(s.id), `[译]${s.text}`);
});

test('批次失败时二分拆批，请求数是 O(log N) 而不是「整批 + 每段一次」', async () => {
  const { engine, calls } = makeEngine();
  const segments = Array.from({ length: 12 }, (_, i) => ({
    id: `s${i}`,
    text: i === 1 ? 'This sentence contains BAD content.' : sentence(i),
  }));
  const { map, failures, stats } = await translateSegments({ segments, engine, concurrency: 1 });

  // 只有坏段判失败，其余全部拿到译文
  assert.equal(failures.length, 1);
  assert.deepEqual([...failures[0].ids], ['s1']);
  assert.equal(map.get('s1'), segments[1].text);   // 失败段回落原文
  for (const s of segments.filter((x) => x.id !== 's1')) {
    assert.equal(map.get(s.id), `[译]${s.text}`);
  }

  // 旧实现是「1 次整批 + 12 次单段」= 13 次；拆批后应显著更少
  assert.ok(calls.length <= 10, `期望拆批后请求数 ≤10，实际 ${calls.length}（${calls.join(',')}）`);
  const singles = calls.filter((n) => n === 1).length;
  assert.ok(singles <= 4, `单段请求应很少，实际 ${singles} 次（${calls.join(',')}）`);
  assert.equal(stats.requests, calls.length);
  assert.equal(stats.failed, 1);
});

test('只有一段且失败时直接判失败并回落原文，不会无限拆批', async () => {
  const { engine, calls } = makeEngine();
  const segments = [{ id: 'only', text: 'Contains BAD token.' }];
  const { map, failures } = await translateSegments({ segments, engine, concurrency: 1 });
  assert.equal(calls.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(map.get('only'), segments[0].text);
});

// ---------- ② 接线断言：改回「每轮灌全文 / 自动翻译烧 token」就红 ----------

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('AI 对话按本轮提问检索正文片段，不再每轮重发整篇全文', () => {
  const app = readSrc('public/app.js');
  assert.match(app, /buildPaperContext\(text\)/, 'sendPrChat 应把本轮提问传给 buildPaperContext');
  assert.match(app, /const PR_CTX_CACHE_LIMIT = 30000;/, '全文缓存上限应为 3 万字符');
  assert.match(app, /const PR_CTX_INJECT_MAX = 16000;/, '单轮注入上限应受控');
  assert.match(app, /pdfReaderUtils\.pickContextSegments/, '应走按需检索');
  assert.match(app, /pdfReaderUtils\.condenseContextText/, '全局性问题应走压缩全文兜底');
  // 服务端单条消息截断在 20000 字符，注入上限必须留在其内，否则尾部会被静默丢弃
  assert.ok(16000 < 20000);
});

test('检索用到的纯函数都在可单测的 utils 模块里导出', () => {
  const source = readSrc('public/pdf-reader-utils.js');
  const context = { window: {} };
  vm.runInNewContext(source, context, { filename: 'pdf-reader-utils.js' });
  const utils = context.window.PdfReaderUtils;
  for (const fn of ['splitContextSegments', 'contextQueryTokens', 'pickContextSegments', 'condenseContextText', 'needsWholePaper']) {
    assert.equal(typeof utils[fn], 'function', `PdfReaderUtils.${fn} 应已导出`);
  }
});

test('自动整篇翻译默认使用免密钥的火山网页版，不消耗大模型 token', () => {
  const app = readSrc('public/app.js');
  assert.match(app, /const CMP_AUTO_ENGINE = 'volcweb';/);
  assert.match(app, /startCmpTranslate\(\{ auto: true \}\);?/, '自动管线应显式按 auto 模式启动翻译');
  assert.match(app, /window\.__cmpAutoEngine \|\| CMP_AUTO_ENGINE/, 'auto 模式应取火山网页版（可被调试钩子覆盖）');
  // 启动面板里也要能看到这个选项（手动选得到）
  assert.match(app, /value="volcweb"/);
});

test('服务端 engine 白名单放行传统翻译服务（volcweb 不被重置成 auto）', () => {
  const src = readSrc('src/pdfTranslate/index.js');
  assert.match(src, /import \{ NON_LLM_PROVIDERS \} from '\.\.\/translateProviders\.js';/);
  assert.match(src, /NON_LLM_PROVIDERS\.has\(merged\.engine\)/, 'normalizeOptions 应放行传统服务 id');
});

test('翻译失败的重试策略是拆批，不是逐段全量重发', () => {
  const src = readSrc('src/pdfTranslate/engines.js');
  assert.match(src, /const runBatch = async \(items, depth\)/, '应存在递归拆批函数');
  assert.match(src, /拆成 \$\{mid\} \+ \$\{items\.length - mid\} 段重试/);
  assert.doesNotMatch(src, /降级为逐段翻译/, '旧的「全量逐段重发」应已移除');
});

// ---------- ③ 接线断言：自动管线不抢用户已经进入的笔记模式 ----------

test('自动管线在用户已进入笔记模式时不抢界面', () => {
  const app = readSrc('public/app.js');
  // 两条「自动进入对照精读」的入口都要先让位：
  //   · 作业完成回调（subscribeCmpJob.onDone）
  //   · 打开文献就有译文时的快进分支（autoCmpPipeline ①）
  assert.match(app, /用户在自动管线跑完之前已经自己进了「笔记模式」→ 不抢界面/,
    '作业完成回调应让位给已开启的笔记模式');
  assert.match(app, /用户已经在笔记模式里（或刚切过去）→ 不抢界面/,
    '快进分支应让位给已开启的笔记模式');
  // 手动入口不受影响：openCmpMode 里仍然会关掉笔记模式，让「📖 对照精读」按钮照旧可用
  assert.match(app, /if \(pn\.on\) \{ try \{ await closePnNoteMode\(\); \}/,
    '手动进入对照精读仍应能接管（关掉笔记模式）');
});
