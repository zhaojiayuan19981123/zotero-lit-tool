// reader-window.test.mjs —— PDF 阅读器「窗口化渲染 + 内存回收」的结构性回归测试
//
// 背景：阅读器原来把「进过视口的页」全部留在 DOM 里不回收。实测一份 60 页文字论文
// 滚完一遍后：60 个 canvas 共 5700 万像素位图（约 217MB）、文本层 6.8 万个 span、
// 7.1 万个 DOM 节点 —— 而且永不释放。表现就是「越读越卡、内存越用越多、滚不动」。
//
// 现在的策略（本测试守着这些不变量）：
//   · 只画视口前后 RENDER_MARGIN 内的页；离开 RELEASE_MARGIN 就退回占位符
//   · 回收时把 canvas 宽高置 0（立刻交还位图）+ 调 page.cleanup() 释放 pdf.js 算子列表
//   · 画布分辨率受 dpr 上限与单页像素预算双重约束（放大到 400% 不会吃掉上百 MB）
//   · 关阅读器 / 换篇时 doc.destroy()，不再只把引用置 null
//   · 滚动定位用缓存偏移 + 二分 + rAF 节流，不再每帧遍历所有页读 offsetTop
//   · 滚动停下补一次视口页（渲染被中途放弃时观察器不会再触发，会卡占位符）
//
// 这些逻辑都长在 DOM 事件与 canvas 上，单测跑不了真渲染，所以这里做源码级不变量断言，
// 真浏览器行为由 C:/Users/zjy1998/.workbuddy/zotero-lit-e2e/verify-reader-window.mjs 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const appJs = read('public/app.js');
const css = read('public/style.css');
const blocksJs = read('public/reader-blocks.js');

/** 从源码里抠出一个函数体（按花括号配平），找不到就返回空串 */
function fnBody(name) {
  const start = appJs.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const braceStart = appJs.indexOf('{', appJs.indexOf(')', start));
  if (braceStart < 0) return '';
  let depth = 0;
  for (let i = braceStart; i < appJs.length; i++) {
    const ch = appJs[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return appJs.slice(braceStart + 1, i);
    }
  }
  return '';
}

/** 读取一个 PR_* 常量的数值 */
function constNum(name) {
  const m = appJs.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)`));
  return m ? Number(m[1]) : NaN;
}

test('渲染窗口与回收窗口的关系：回收窗口必须远大于渲染窗口', () => {
  const render = constNum('PR_RENDER_MARGIN');
  const release = constNum('PR_RELEASE_MARGIN');
  const max = constNum('PR_MAX_RENDERED');
  assert.ok(Number.isFinite(render) && render > 0, 'PR_RENDER_MARGIN 应存在且为正');
  assert.ok(Number.isFinite(release) && release > render * 2,
    `回收窗口(${release}) 要明显大于渲染窗口(${render})，否则来回小幅滚动会反复重画`);
  assert.ok(Number.isFinite(max) && max >= 3 && max <= 12,
    `同时存在的页数上限(${max}) 应是个位数级别`);
});

test('两个观察器：一个负责「近了就画」，一个负责「远了就收」', () => {
  const body = fnBody('buildPlaceholders');
  assert.match(body, /pr\.observer\s*=\s*new IntersectionObserver/, '应有渲染观察器');
  assert.match(body, /pr\.releaseObserver\s*=\s*new IntersectionObserver/, '应有回收观察器');
  // 渲染用 PR_RENDER_MARGIN、回收用 PR_RELEASE_MARGIN，不能写成同一个数
  assert.match(body, /rootMargin:\s*`\$\{PR_RENDER_MARGIN\}px 0px`/);
  assert.match(body, /rootMargin:\s*`\$\{PR_RELEASE_MARGIN\}px 0px`/);
  // 两个观察器都要 observe 到每一页
  assert.match(body, /pr\.observer\.observe\(w\)/);
  assert.match(body, /pr\.releaseObserver\.observe\(w\)/);
  // 重建容器时必须断开旧观察器，不然旧回调会作用到已经被丢弃的节点上
  assert.match(body, /pr\.observer\.disconnect\(\)/);
  assert.match(body, /pr\.releaseObserver\.disconnect\(\)/);
});

test('回收一页：位图立刻交还、页面退回占位符、pdf.js 页对象 cleanup', () => {
  const body = fnBody('releasePage');
  assert.ok(body, '应有 releasePage');
  // 正在渲染的页不能收（会与在途的 render 打架）
  assert.match(body, /dataset\.rendering\s*===\s*'1'/, '必须挡住在渲染中的页');
  // 宽高置 0 是「立刻交还位图」的关键，只 removeChild 要等 GC
  assert.match(body, /c\.width\s*=\s*0/, 'canvas 宽应置 0');
  assert.match(body, /c\.height\s*=\s*0/, 'canvas 高应置 0');
  // 退回占位符，但 wrap 尺寸不变 → 滚动位置不跳
  assert.match(body, /pr-placeholder/, '应重新挂上占位符');
  // pdf.js 的 PDFPageProxy 攒着算子列表，必须 cleanup
  assert.match(body, /\.cleanup\(\)/, '应调用 page.cleanup() 释放算子列表');
  assert.match(body, /pr\.rendered\.delete\(pageNum\)/, '应从已渲染集合移除');
});

test('画布分辨率受 dpr 上限与单页像素预算约束', () => {
  const body = fnBody('renderPageInto');
  assert.match(String(constNum('PR_CANVAS_PIXEL_BUDGET')), /^[0-9]+$/, '应定义像素预算常量');
  assert.match(body, /PR_CANVAS_PIXEL_BUDGET/, '渲染时必须用像素预算反推 dpr');
  // dpr 上限 2：4K 屏 3x 时按 2x 画已经是肉眼无损，再多只是白烧显存
  assert.match(body, /Math\.min\(window\.devicePixelRatio \|\| 1,\s*2\b/,
    'dpr 应被 2 封顶');
});

test('渲染并发有闸门：跨页跳转不会让十几页同时开画', () => {
  const body = fnBody('renderPageInto');
  assert.match(body, /pr\.rendered\.size\s*>=\s*PR_MAX_RENDERED\)\s*pruneRenderedPages\(\)/,
    '开画前先回收远处的页腾位置');
  assert.match(body, /PR_MAX_RENDERED\s*\+\s*4/, '排不下时要有余量判断');
  assert.match(body, /setTimeout\(\(\)\s*=>\s*renderPageInto/, '排不下要稍后自愈重试，不能直接放弃');
  assert.match(body, /finally\s*\{[\s\S]*dataset\.rendering/, 'rendering 标记必须在 finally 里清掉');
});

test('走远了就不再画：getPage 回来时重新确认距离', () => {
  const body = fnBody('renderPageInto');
  const afterGetPage = body.slice(body.indexOf('getPage(pageNum)'));
  assert.match(afterGetPage, /pageDistanceFromViewport\(wrap\)\s*>\s*PR_RELEASE_MARGIN/,
    'getPage 是异步的，回来时要重新判断用户是否已翻走');
});

test('关闭阅读器 / 换篇要真正销毁文档，而不是只置 null', () => {
  const destroy = fnBody('destroyPdfDoc');
  assert.ok(destroy, '应有 destroyPdfDoc');
  assert.match(destroy, /doc\.destroy\(\)/, 'PDFDocumentProxy 必须 destroy，否则 worker 侧文档与页缓存不释放');
  assert.match(fnBody('closePdfReader'), /destroyPdfDoc\(\)/, '关阅读器要走 destroyPdfDoc');
  const load = fnBody('loadPdfDocument');
  const idxDestroy = load.indexOf('destroyPdfDoc()');
  const idxGet = load.indexOf('getDocument(');
  assert.ok(idxDestroy >= 0 && idxGet >= 0 && idxDestroy < idxGet,
    '换篇时应先销毁上一份文档，再取新文档');
});

test('打开文档时并发取页尺寸，而不是一页一页串行 await', () => {
  const body = fnBody('fetchPageSizes');
  assert.ok(body, '应有 fetchPageSizes');
  assert.match(body, /Promise\.all/, '必须并发，串行取 200 页光这一步就要好几秒');
  assert.match(body, /\.cleanup\(\)/, '只取尺寸不留引用，取完就 cleanup');
  assert.match(fnBody('loadPdfDocument'), /await fetchPageSizes\(doc\)/);
});

test('滚动定位：缓存偏移 + 二分 + rAF 节流，不再每帧遍历所有页', () => {
  const body = fnBody('updateCurrentPage');
  assert.ok(body, '应有 updateCurrentPage');
  assert.match(body, /requestAnimationFrame/, '应合并到一帧里做一次');
  assert.match(body, /pr\.pageOffsets/, '应使用缓存的页偏移');
  // 二分查找的标志：lo/hi 指针
  assert.match(body, /while\s*\(lo\s*<=\s*hi\)/, '偏移查找应是二分，不是线性扫描');
  // 命门：不能在滚动回调里 querySelectorAll + 逐页读 offsetTop
  assert.doesNotMatch(body, /querySelectorAll/, '滚动回调里不能再遍历 DOM');
  assert.doesNotMatch(body, /offsetTop/, '滚动回调里不能再逐页读 offsetTop（强制回流）');
});

test('滚动停下后补一次视口页，避免卡在占位符', () => {
  const repair = fnBody('repairViewportPages');
  assert.ok(repair, '应有 repairViewportPages');
  assert.match(repair, /pr\.rendered\.has\(pageNum\)/, '只补没画的页');
  assert.match(repair, /renderPageInto\(/, '补画要复用同一个渲染入口');
  assert.match(repair, /sort\(/, '按离视口中心近的优先');
  // 必须由滚动回调触发，否则「渲染被中途放弃」的页永远补不回来
  assert.match(fnBody('updateCurrentPage'), /scheduleViewportRepair\(\)/,
    '滚动回调里应调 scheduleViewportRepair');
  assert.match(fnBody('scheduleViewportRepair'), /setTimeout\(repairViewportPages/);
});

test('缩放重排时同样回收位图并让偏移缓存失效', () => {
  const body = fnBody('rescaleAllPages');
  assert.match(body, /pr\.pageOffsets\s*=\s*null/, '尺度变了，偏移缓存必须作废');
  assert.match(body, /c\.width\s*=\s*0/, '已渲染页清空前要释放位图');
  assert.match(body, /\.cleanup\(\)/, '页对象也要 cleanup');
});

test('CSS：页面盒做布局/样式隔离，滚动容器不把滚动链传给外层', () => {
  const wrapRule = css.match(/\.pr-page-wrap\s*\{[^}]*\}/);
  assert.ok(wrapRule, '应有 .pr-page-wrap 规则');
  assert.match(wrapRule[0], /contain:\s*layout style/,
    '每页尺寸固定，应做 contain 隔离，否则一页重画会连累整条长列表重排');
  // 刻意不加 paint：块高亮徽标要压在页边线上
  assert.doesNotMatch(wrapRule[0], /contain:[^;]*paint/, '不要加 paint 隔离（会裁掉徽标）');
  const pagesRule = css.match(/\.pr-pages\s*\{[^}]*\}/);
  assert.ok(pagesRule, '应有 .pr-pages 规则');
  assert.match(pagesRule[0], /overscroll-behavior:\s*contain/, '滚到底不应把滚动传给外层');
});

test('版面块悬停判选不再每帧序列化整个选区', () => {
  assert.match(blocksJs, /function hasSelection\(\)/);
  // getSelection().toString() 要把选区文本全拼出来，pointermove 每帧调一次纯属浪费
  assert.doesNotMatch(blocksJs, /getSelection\(\)\?\.toString\(\)/,
    '不要用 toString() 判断有无选区，用 isCollapsed');
  assert.match(blocksJs, /isCollapsed/, '应基于 isCollapsed 判断');
});

test('自动版面解析要等阅读区安静下来才启动', () => {
  // 版面解析是 67MB 模型 + 单页约 1.6s 推理、峰值内存约 800MB 的重活。
  // 打开即抢跑会正好撞上「第一屏渲染 + 用户开始拖动」，一进阅读器就卡。
  const idle = fnBody('waitReaderIdle');
  assert.ok(idle, '应有 waitReaderIdle');
  assert.match(idle, /quietMs/, '应有静默阈值');
  assert.match(idle, /capMs/, '应有等待上限，不能因为用户一直滚动就永不解析');
  const pipe = fnBody('autoCmpPipeline');
  const iIdle = pipe.indexOf('waitReaderIdle()');
  const iStart = pipe.indexOf('startLayoutParse()');
  assert.ok(iIdle >= 0, '自动管线应调用 waitReaderIdle');
  assert.ok(iStart >= 0 && iIdle < iStart, 'waitReaderIdle 必须在 startLayoutParse 之前');
  // 「用户在滚动」这个信号来自滚动回调
  assert.match(fnBody('updateCurrentPage'), /pr\.lastScrollAt\s*=\s*Date\.now\(\)/,
    '滚动回调要记录最近滚动时间');
});
