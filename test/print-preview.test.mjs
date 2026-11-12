// print-preview.test.mjs —— 打印（原文 / 解析结果）与译文页渲染器的结构护栏
//
// 这两件事踩过的坑都是「改一处、悄悄坏另一处」，所以钉成测试：
//  · 原文打印曾经在打印区最上面插一行标题，把第一页往下推，最后一页被顶到
//    第二张纸上 —— 用户看到的就是「打印出来的版面被挤了」；
//  · 译文页的渲染器依赖 manifest 的块坐标，回归时最容易坏的是「保留块」集合
//    （图表 / 表格 / 公式必须原样留在页面上，不能盖中文）；
//  · 打印预览里「看到的就是打出来的」，靠的是同一个节点在两处之间搬家，
//    所以预览里必须有打印容器的落点，打印区必须能被 @media print 单独放出来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('public/index.html');
const appJs = read('public/app.js');
const css = read('public/style.css');
const cmpJs = read('public/cmp-pages.js');

test('打印预览：弹层骨架齐备，且挂在 index.html 里', () => {
  for (const id of ['ppOverlay', 'ppSeg', 'ppRange', 'ppRangeWrap', 'ppStatus', 'ppPaper', 'ppBody', 'ppClose', 'ppPrint']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `index.html 缺少打印预览元素 ${id}`);
  }
  // 两种文档：原文页 / 解析结果文稿
  const modes = [...html.matchAll(/data-ppmode="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(modes.sort(), ['analysis', 'pdf'], '打印预览必须同时提供「原文」与「解析结果」两种文档');
});

test('原文打印不再往打印区塞标题（标题会挤压版面）', () => {
  const fn = appJs.match(/async function printPdfPages\(pages\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(fn, 'app.js 里找不到 printPdfPages()');
  const body = fn[1];
  assert.ok(!/printHeader|print-title/.test(body), 'printPdfPages 不能再往打印区插入标题：标题会把整页往下挤');
  assert.ok(/box\.innerHTML = ''/.test(body), 'printPdfPages 必须先清空打印区');
  assert.ok(/print-page/.test(body), 'printPdfPages 应当只追加页面图片');
});

test('打印预览与打印走同一份节点：预览纸面 + @media print 单独放出打印区', () => {
  // 预览纸面
  assert.match(css, /\.prp-paper\s*\{[^}]*width:\s*703px/, '预览纸面应当按 A4 可打印宽度（703px）排版');
  assert.match(css, /\.prp-paper \.print-area\s*\{\s*display:\s*block/, '打印区搬进预览纸面后必须能显示出来');
  // 打印时只留打印区
  assert.match(css, /@media print\s*\{[\s\S]*?body > \*:not\(#litPrintArea\)\s*\{\s*display:\s*none !important/, '打印时必须把应用界面整体藏掉');
  // 预览里的「只铺了前 N 页」提示不该印出来
  assert.match(css, /\.prp-note\s*\{\s*display:\s*none !important/, 'prp-note 在打印时应当隐藏');
  // 打印完不能把预览内容清掉
  assert.match(appJs, /afterprint[\s\S]{0,120}if \(!pp\.on\) box\.innerHTML = ''/, '预览开着时 afterprint 不能清空打印区');
});

test('解析结果文稿：标题 + 分节正文 + 页脚，且与面板同一份字段口径', () => {
  assert.match(appJs, /function analysisSections\(it\)/, '缺少 analysisSections()：面板与打印必须共用同一份取值逻辑');
  // 面板本身也要走这个函数，不能各写一遍
  const panel = appJs.match(/function renderPrAnalysis\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(panel, '找不到 renderPrAnalysis()');
  assert.match(panel[1], /analysisSections\(it\)/, '解析结果面板必须复用 analysisSections()');
  const doc = appJs.match(/function ppBuildAnalysis\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(doc, '找不到 ppBuildAnalysis()');
  assert.match(doc[1], /print-doc/, '解析结果文稿要有独立的 .print-doc 容器');
  assert.match(doc[1], /pd-title/, '解析结果文稿要有标题');
  assert.match(doc[1], /pd-sec/, '解析结果文稿要分节');
  for (const cls of ['.print-doc', '.pd-title', '.pd-sec-h', '.pd-foot']) {
    assert.ok(css.includes(cls + ' ') || css.includes(cls + ','), `style.css 缺少打印文稿样式 ${cls}`);
  }
});

test('页码区间：打印与预览共用 parsePageRange，且预览有页数上限', () => {
  assert.match(appJs, /function parsePageRange\(text, total\)/, '缺少 parsePageRange()');
  assert.match(appJs, /const PP_PREVIEW_MAX = \d+/, '预览必须有页数上限，否则「全部」会一开窗就卡死');
  // 异步渲染回来时页码可能已经改了：这一张不能贴上去（曾出现「预览 1 页却有两张图」）
  assert.match(appJs, /if \(gen !== pp\.gen\) \{ canvas\.width = 0;[\s\S]{0,80}return; \}/, '渲染回来后必须再校验一次代数');
});

test('译文页渲染器：图表 / 表格 / 公式原样保留，不盖译文', () => {
  const keep = cmpJs.match(/const KEEP_KINDS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(keep, 'cmp-pages.js 里找不到 KEEP_KINDS');
  for (const k of ['figure', 'table', 'formula']) {
    assert.ok(keep[1].includes(`'${k}'`), `KEEP_KINDS 必须包含 ${k}：它要原样留在页面上`);
  }
  // 保留块不能有译文节点
  const build = cmpJs.match(/function buildBlockEl\([\s\S]*?\n  \}/);
  assert.ok(build, '找不到 buildBlockEl()');
  assert.match(build[0], /ctp-keep/, '保留块要打 ctp-keep 标记');
});

test('译文页渲染器：文档未就位时等它就位，而不是永远停在页码占位符上', () => {
  // 对照数据（本地 JSON）常常比 PDF 字节先到：那一轮渲染必然空转，必须有重试
  assert.match(cmpJs, /function scheduleDocRetry\(\)/, '缺少 scheduleDocRetry()：PDF 后到时会永远停在占位符上');
  assert.match(cmpJs, /if \(!state\.opts\.getDoc\?\.\(\)\) \{ scheduleDocRetry\(\); return; \}/, 'primeVisible 在文档未就位时应当挂重试');
  // 应用侧也要在 PDF 加载完成后补一版
  assert.match(appJs, /if \(cmp\.on\) \{\s*\n\s*window\.CmpPages\?\.refit\(\);/, 'PDF 加载完成后没有通知译文页重铺');
});

test('译文页渲染器：文字放不下时先在下块上沿之内长高，不叠字', () => {
  assert.match(cmpJs, /function growRoom\(/, '缺少 growRoom()：译文长高要有「不压下一块」的预算');
  assert.match(cmpJs, /function mergeOverlapping\(/, '缺少 mergeOverlapping()：互相盖住的碎块要并成一块');
  assert.match(cmpJs, /ctp-clip/, '长到预算上限仍放不下时应当截断并留标记');
  // break-word 而不是 anywhere：anywhere 会把 "ARTICLE INFO" 拆成 "ARTICLEINF / O"
  assert.match(css, /\.ctp-text\s*\{[^}]*overflow-wrap:\s*break-word/, '.ctp-text 必须用 break-word，否则英文标题会被拆在任意字符上');
});

test('译文页脚本已挂进 index.html，且带独立的调试快照', () => {
  assert.match(html, /<script src="cmp-pages\.js"><\/script>/, 'index.html 没有引入 cmp-pages.js');
  // 用一个独立沙箱跑一遍：只验证挂载出来的 API 面，不碰 DOM
  const sandbox = { window: {}, requestAnimationFrame: () => 0, CSS: { escape: (s) => s } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(cmpJs, sandbox);
  const api = sandbox.window.CmpPages;
  assert.ok(api, 'cmp-pages.js 没有把 CmpPages 挂到 window 上');
  for (const k of ['mount', 'setBlocks', 'setActive', 'focus', 'refreshBlock', 'setPending', 'setError', 'capture', 'refit', 'destroy', 'debug']) {
    assert.equal(typeof api[k], 'function', `CmpPages 缺少 ${k}()`);
  }
  // debug() 要能说清「为什么没渲染」：pages / blocks / lastError 缺一不可
  const snap = api.debug();
  for (const k of ['pages', 'blocks', 'rendered']) {
    assert.ok(k in snap, `CmpPages.debug() 缺少 ${k}`);
  }
});
