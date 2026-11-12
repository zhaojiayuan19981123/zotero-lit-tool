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

// ==================== 译文两种样式（版面还原 / 文本重排） ====================

test('译文栏两种样式：切换按钮齐备，两个渲染容器各就各位', () => {
  const styles = [...html.matchAll(/data-cmpstyle="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(styles.sort(), ['flow', 'page'], '译文栏必须同时提供「版面还原」与「文本重排」两种样式');
  // page 用 #cmpTransFlow（CmpPages 的宿主），flow 用 #cmpTransHtml（连续文本流）
  assert.match(html, /class="cmp-flow ctp-scroll" id="cmpTransFlow"/, '#cmpTransFlow 必须仍是 ctp 滚动容器');
  assert.match(html, /class="cmp-flow cmp-flow-html" id="cmpTransHtml"/, '缺少文本重排容器 #cmpTransHtml');
  // 谁显示由 data-style 决定，切换时不用动 DOM 结构
  assert.match(css, /\[data-style="flow"\] #cmpTransFlow\s*\{\s*display:\s*none !important/, '切到文本重排时必须藏掉版面还原那一栏');
  assert.match(css, /\[data-style="page"\] #cmpTransHtml\s*\{\s*display:\s*none !important/, '切到版面还原时必须藏掉文本重排那一栏');
});

test('译文两种样式共用一套选中 / 定位 / 单块刷新', () => {
  // 两种样式的块选择器都要能命中（回归时最容易只改一边）
  const fn = appJs.match(/function transBlockEl\(id\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(fn, '找不到 transBlockEl()');
  assert.match(fn[1], /cmp-block\[data-block-id/, 'transBlockEl 要能命中文本重排的块');
  assert.match(fn[1], /ctp-block\[data-id/, 'transBlockEl 要能命中版面还原的块');
  // 定位：版面还原走 CmpPages.focus，文本重排自己滚
  assert.match(appJs, /function cmpFocusTrans\(id\)/, '缺少 cmpFocusTrans()：两种样式的定位方式不同');
  assert.match(appJs, /window\.CmpPages\?\.focus\(id, \{ flash: false \}\)/, 'cmpFocusTrans 应当把版面还原交给 CmpPages.focus');
  // 点译文栏 / 点原文段落都要走同一条 cmpSelectBlock
  assert.match(appJs, /cmpEl\('cmpTransHtml'\)\?\.addEventListener\('click'/, '文本重排的块也要能点（点段落 → 原文定位）');
  // 单块翻译完成后两种样式都要刷新
  assert.match(appJs, /function cmpRefreshHtmlBlock\(b\)/, '缺少 cmpRefreshHtmlBlock()：单段翻译后文本重排不会更新');
  assert.match(appJs, /window\.CmpPages\?\.refreshBlock\(b\.id\);[\s\S]{0,200}cmpRefreshHtmlBlock\(b\)/, '单段翻译完成后要同时刷新两种样式');
  // renderCmp 必须把数据同时喂给两个渲染器
  const rc = appJs.match(/function renderCmp\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(rc, '找不到 renderCmp()');
  assert.match(rc[1], /window\.CmpPages\?\.setBlocks\(blocks\)/, 'renderCmp 要把块交给版面还原');
  assert.match(rc[1], /renderCmpHtml\(blocks\)/, 'renderCmp 要把块交给文本重排');
  assert.match(appJs, /const CMP_STYLE_KEY = 'sciterminal\.cmpTransStyle'/, '译文样式的选择要能记住');
});

// ==================== 字体与字号统一 ====================

test('译文只有一套字体：西文 Times New Roman + 中文宋体', () => {
  const fam = cmpJs.match(/const SERIF = "([^"]+)"/);
  assert.ok(fam, 'cmp-pages.js 里找不到统一的字体族常量 SERIF');
  // 顺序很重要：Times New Roman 不含汉字，必须排在宋体前面，否则英文会变成宋体的样子
  const tnr = fam[1].indexOf('Times New Roman');
  const sim = fam[1].indexOf('SimSun');
  assert.ok(tnr >= 0, 'SERIF 必须包含 Times New Roman（西文）');
  assert.ok(sim >= 0, 'SERIF 必须包含 SimSun（中文宋体）');
  assert.ok(tnr < sim, 'Times New Roman 必须排在 SimSun 前面');
  // 标题与正文共用同一族（旧版标题走黑体，是「字体不统一」的来源）
  assert.ok(!/'PingFang SC'/.test(cmpJs), '译文层不能再出现 PingFang 之类无衬线回退');
  assert.match(cmpJs, /textEl\.style\.fontFamily = SERIF/, '落笔时必须用统一的 SERIF');
  // 文本重排那一栏也用同一套字，两种样式看起来才是一份文档
  assert.match(css, /\.cmp-block-text\s*\{[^}]*font-family:\s*'Times New Roman',\s*SimSun/, '文本重排的正文也要用宋体 + Times');
});

test('译文页字号：每页一个基准，最多往下两档，不再一块一个值', () => {
  assert.match(cmpJs, /function pickBase\(jobs\)/, '缺少 pickBase()：本页基准字号要按「字数加权中位数」定');
  // 加权：小字块（作者单位 / 脚注）不能把整页基准拖到最低档
  const pb = cmpJs.match(/function pickBase\(jobs\)\s*\{([\s\S]*?)\n  \}/)[1];
  assert.match(pb, /Math\.min\(400, j\.len \|\| 1\)/, 'pickBase 必须按字数加权');
  assert.match(pb, /BASE_LO, BASE_HI/, '基准字号必须夹在可读区间内');
  // 降档只有 0.5px 一档、最多三档
  const as = cmpJs.match(/function applySize\(j, base\)\s*\{([\s\S]*?)\n  \}/)[1];
  assert.match(as, /step < 3/, '降档最多三档（base / base-0.5 / base-1）');
  assert.match(as, /fs - step \* 0\.5/, '降档步长必须是 0.5px');
  assert.ok(!/toFixed\(2\)/.test(as), '不能再出现二分出来的任意字号（6.69px 那种），那正是「字号不统一」');
  // 先长高后降档：长高只多吃留白，降档会破坏统一
  assert.match(as, /growTo\(/, 'applySize 必须先尝试长高');
});

// ==================== 译文页缩放 ====================

test('译文页支持 Ctrl + 滚轮缩放，且缩放后仍读得下去', () => {
  assert.match(cmpJs, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/, '译文页必须监听 wheel（Ctrl + 滚轮）');
  const wheel = cmpJs.match(/function onWheel\(e\)\s*\{([\s\S]*?)\n  \}/)[1];
  assert.match(wheel, /!e\.ctrlKey && !e\.metaKey.*return/, '只在按住 Ctrl / ⌘ 时缩放，否则会抢掉正常滚动');
  assert.match(wheel, /e\.preventDefault\(\)/, '必须 preventDefault，否会触发整个应用缩放');
  assert.match(cmpJs, /function setZoom\(z\)/, '缺少 setZoom()');
  assert.match(cmpJs, /ZOOM_LO, ZOOM_HI/, '缩放要夹在合理区间内');
  // 缩放要按「选中的那一块」做锚点，免得缩一次就跳回页首
  assert.match(cmpJs, /function refit\(\)[\s\S]{0,400}anchor/, '缩放重铺必须带锚点块');
  // 放大后要能横向滚到右边（align-items:center 会把左边缘滚没了）
  assert.match(css, /\.cmp-flow\.ctp-scroll\s*\{[^}]*align-items:\s*flex-start/, '页面比容器宽时必须用 flex-start + margin auto，否则左边滚不到');
  assert.match(css, /\.ctp-page\s*\{[^}]*margin:\s*0 auto/, '页面要自己居中，滚动容器的 align-items 只负责溢出方向');
  // 百分比回显
  assert.match(html, /id="cmpTransZoom"/, '缺少缩放百分比回显（点一下回到适应宽度）');
  assert.match(appJs, /onZoom: \(z\) => setCmpZoomLabel\(z\)/, 'CmpPages 缩放变化要回显到界面');
});

// ==================== 目录抽屉 / 三栏 ====================

test('大纲改成抽屉：不占列，展开时盖在原文栏上', () => {
  assert.match(css, /\.cmp-outline\s*\{[^}]*position:\s*absolute/, '大纲必须是抽屉（绝对定位），不再占一列');
  assert.match(css, /\.cmp-outline\s*\{[^}]*transform:\s*translateX\(-10\d%\)/, '抽屉默认要收在屏幕外');
  assert.match(css, /\.pr-cmp-mode\[data-drawer="on"\] \.cmp-outline\s*\{\s*transform:\s*none/, '展开态要能滑回来');
  assert.match(html, /id="cmpDrawerMask"/, '抽屉要有遮罩（点空白处收起）');
  assert.match(html, /id="cmpOutlineToggle"/, '工具条上要有大纲开关');
  assert.match(appJs, /function toggleCmpDrawer\(force\)/, '缺少 toggleCmpDrawer()');
  // 抽屉不再可拖宽
  assert.ok(!/data-cmpresize="outline"/.test(html), '大纲已是抽屉，不该再有拖宽分隔条');
  assert.match(css, /\[data-cmpresize="outline"\]\s*\{\s*display:\s*none/, '大纲的分隔条要藏掉');
});

test('三栏宽度必须铺满：flex-grow 要归一到 1', () => {
  const fn = appJs.match(/function applyCmpRatios\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(fn, '找不到 applyCmpRatios()');
  assert.match(fn[1], /const panes = \['src', 'trans', 'assist'\]/, '参与分配的是原文 / 译文 / 助读三栏（大纲是抽屉）');
  assert.match(fn[1], /\/ sum\) \* 1000/, 'flex-grow 之和必须归一到 1，否则右边会空出一条');
});

// ==================== 解析结果打印：紧凑排版 ====================

test('解析结果打印稿：不能再用 pre-wrap（Markdown 的换行会变成大片空行）', () => {
  const v = css.match(/\.pd-sec-v\s*\{([^}]*)\}/);
  assert.ok(v, 'style.css 缺少 .pd-sec-v');
  assert.match(v[1], /white-space:\s*normal/, '.pd-sec-v 必须是 normal：marked 输出的块间换行在 pre-wrap 下会画成真空行');
  assert.ok(!/white-space:\s*pre-wrap/.test(v[1]), '.pd-sec-v 不能回到 pre-wrap');
});

test('解析结果打印稿：节允许跨页，只有标题 / 表格 / 代码块不拆', () => {
  const sec = css.match(/\.pd-sec\s*\{([^}]*)\}/);
  assert.ok(sec, 'style.css 缺少 .pd-sec');
  assert.ok(!/break-inside:\s*avoid/.test(sec[1]), '整节 break-inside:avoid 会让上一页留半页空白');
  assert.match(css, /\.pd-sec-h\s*\{[^}]*break-after:\s*avoid/, '节标题不能单独留在页底');
  assert.match(css, /\.pd-sec-v table|\.pd-sec-v tr,/, '表格要有不拆行的规则');
  assert.match(css, /@media print\s*\{\s*\.print-doc\s*\{\s*padding:\s*0/, '打印时页边距交给 @page，稿子不再叠一层内边距');
});

test('解析结果里「关键词」只出现一次（基本信息与独立一节不再重复）', () => {
  const fn = appJs.match(/function analysisSections\(it\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(fn, '找不到 analysisSections()');
  assert.ok(!/\['关键词', it\.keywords\]/.test(fn[1]), '基本信息里不能再列关键词：它会与「关键词」一节重复');
  assert.match(fn[1], /pd-facts/, '基本信息要用 .pd-facts 的紧凑两栏排版');
  assert.ok(/\.pd-fact\b/.test(css), 'style.css 缺少 .pd-fact 样式');
});
