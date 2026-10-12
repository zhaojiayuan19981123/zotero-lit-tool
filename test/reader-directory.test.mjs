// reader-directory.test.mjs —— 两个阅读器里的「论文目录」（就地换文献）接线检查
//
// 纯前端交互，逻辑都在 DOM 事件里，单测跑不了真实点击（那部分交给浏览器 E2E）。
// 这里把「结构 / 关键调用」钉死，防止以后重构时把入口删掉或忘了接上：
//   1) 文献中心：#prDirToggle / #prDir 结构在、点条目走 openPdfReader、结果来源要收起目录
//   2) 学位论文：左侧栏两个页签、#thrPaperList 结构在、点条目走 openReader
//   3) 切换前必须先拆掉上一篇的阅读现场（销毁 pdf 文档 + 落盘笔记与阅读位置）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('public/index.html');
const app = read('public/app.js');
const thesis = read('public/thesis.js');
const styleCss = read('public/style.css');
const thesisCss = read('public/thesis.css');

test('文献中心：阅读器里有「目录」按钮与抽屉的结构', () => {
  assert.match(html, /id="prDirToggle"/, '要有「📚 目录」按钮');
  assert.match(html, /id="prDir"[\s\S]{0,400}id="prDirList"/, '抽屉里要有列表容器');
  assert.match(html, /id="prDirSearch"/, '要有搜索框（文献多了要能过滤）');
  // 抽屉在 .pr-body 里、.pr-main 之前 —— 排在左侧才像「目录」
  const body = html.indexOf('<div class="pr-body">');
  const dir = html.indexOf('id="prDir"');
  const main = html.indexOf('<div class="pr-main">');
  assert.ok(body < dir && dir < main, '目录抽屉应位于 .pr-body 内、.pr-main 之前');
});

test('文献中心：目录由文献列表生成，点条目直接换篇（不返回列表）', () => {
  assert.match(app, /function prDirEntries\(\)/, '要有按文库分组的条目生成');
  assert.match(app, /function renderPrDir\(\)/);
  assert.match(app, /function setPrDir\(on\)/);
  assert.match(app, /bindPrDir\(\);/, '初始化时要绑定');
  // 点条目 → 复用既有的 openPdfReader（就是列表里「阅读」走的那个入口）
  assert.match(app, /data-prdir-id/, '条目上要带文献 id');
  assert.match(app, /await openPdfReader\(id\);\s*\n\s*renderPrDir\(\);/, '切完要重新高亮');
  // 只列有 PDF 的：没有附件的点开也读不了
  assert.match(app, /items\.filter\(\(i\) => \(i\.docType \|\| 'empirical'\) === type && i\.filename\)/);
});

test('文献中心：成果附件阅读时不显示文献目录（否则会浮出一份不相干的列表）', () => {
  assert.match(app, /show\(\$\('prDirToggle'\), lit\);/);
  assert.match(app, /if \(!lit\) setPrDir\(false\);/);
});

test('学位论文：左侧栏有「章节 / 论文」两个页签与论文列表结构', () => {
  // 这个阅读器的 DOM 是 JS 里现搭的（buildReaderDom），不在 index.html 里
  assert.match(thesis, /id="thrOutSeg"/);
  assert.match(thesis, /data-thrpanel="outline"/);
  assert.match(thesis, /data-thrpanel="papers"/);
  assert.match(thesis, /id="thrPaperList"/);
  assert.match(thesis, /id="thrPaperSearch"/);
});

test('学位论文：目录由 /api/theses 的列表生成，点条目就地切篇', () => {
  assert.match(thesis, /function setReaderPane\(name\)/);
  assert.match(thesis, /function renderReaderDir\(\)/);
  assert.match(thesis, /S\.items\.filter\(\(it\) => it\.filename\)/, '只列有 PDF 的论文');
  assert.match(thesis, /data-paper-id/);
  assert.match(thesis, /await openReader\(id\);\s*\n\s*renderReaderDir\(\);/, '切完要重新高亮');
  assert.match(thesis, /if \(!id \|\| id === R\.id\) return;/, '点当前这篇不该白重载一遍');
});

test('学位论文：切篇前先拆掉上一篇（销毁文档 + 落盘笔记与阅读位置）', () => {
  assert.match(thesis, /function teardownReaderBody\(\)/);
  assert.match(thesis, /function teardownReaderBody\(\)[\s\S]*?R\.doc\?\.destroy\?\.\(\);/, '要销毁旧 pdf 文档，否则反复切篇会累积内存');
  assert.match(thesis, /function teardownReaderBody\(\)[\s\S]*?saveNote\(\)[\s\S]*?saveReadPos\(true\)/, '切之前要把没落盘的笔记 / 阅读位置写下去');
  assert.match(thesis, /if \(R\.id && R\.id !== id\) teardownReaderBody\(\);/, 'openReader 切到另一篇时要先拆');
  assert.match(thesis, /function closeReader\(\) \{\s*\n\s*teardownReaderBody\(\);/, '关阅读器复用同一段拆解，别各写一遍');
});

test('样式：两个目录都有可用的样式（否则会退化成挤在一起的白条）', () => {
  for (const sel of ['.pr-dir ', '.pr-dir-item', '.pr-dir-item.active', '.pr-dir-group']) {
    assert.ok(styleCss.includes(sel), `style.css 缺少 ${sel}`);
  }
  for (const sel of ['.thr-out-seg', '.thr-out-seg-btn.active', '.thr-paper-item', '.thr-paper-item.active']) {
    assert.ok(thesisCss.includes(sel), `thesis.css 缺少 ${sel}`);
  }
});

// ---------------------------------------------------------------------------
// 回归：能「就地换篇」之后，所有「请求发出去、响应才回来」的落盘都必须先在发请求时
// 把「哪一篇」锁住。否则响应回来时 R.id / pr.recordId 已经换成新的一篇，
// 再拿它去 findIndex 就会把上一篇的记录整条盖到新一篇头上 —— 库里的记录被写坏
// （浏览器 E2E 真的抓到过：目录里少一篇、另一篇重复，对应记录被同名记录覆盖）。
test('学位论文：落盘前先锁住 id，不出现「响应回来才认人」的写法', () => {
  // 全文件不得再出现 x.id === R.id（findIndex 时按当时的 R.id 认人）
  assert.doesNotMatch(thesis, /x\.id === R\.id/, 'findIndex 必须用发请求时锁住的 id，不能用当时的 R.id');

  // saveReadPos：id / page 都要在发请求前取好
  assert.match(thesis, /function saveReadPos\(immediate\)[\s\S]*?const id = R\.id;/,
    'saveReadPos 要先把 id 锁住');
  assert.match(thesis, /function saveReadPos\(immediate\)[\s\S]*?const page = R\.page;/,
    '页码也要一起锁住，否则会写上新一篇的页码');
  assert.match(thesis, /api\(`\/api\/theses\/\$\{id\}`, \{ method: 'PATCH', body: \{ readPage: page, lastPage: page \} \}\)/,
    '请求要用锁住的 id / page');
  assert.match(thesis, /const idx = S\.items\.findIndex\(\(x\) => x\.id === id\);\s*\n\s*if \(idx >= 0 && updated\) S\.items\[idx\] = \{ \.\.\.S\.items\[idx\], \.\.\.updated \};/,
    '写回要用锁住的 id');

  // 另外三处同类落盘（加书签 / 删书签 / 保存字段）
  assert.match(thesis, /async function addBookmark\(\)[\s\S]*?const id = R\.id;/, 'addBookmark 要先锁 id');
  assert.match(thesis, /async function saveField\(field, value\)[\s\S]*?const id = R\.id;/, 'saveField 要先锁 id');
  assert.match(thesis, /async function saveField\(field, value\)[\s\S]*?await patchItem\(id, patch\)/, 'patchItem 要用锁住的 id');
});

test('学位论文：切篇期间的过期响应不能污染当前这篇的章节 / 对话 / 摘录 / 笔记状态', () => {
  for (const fn of ['loadOutline', 'loadChatHistory', 'ensureNote']) {
    assert.match(thesis, new RegExp(`async function ${fn}\\([^)]*\\)[\\s\\S]*?const id = R\\.id;`), `${fn} 要锁 id`);
    assert.match(thesis, new RegExp(`async function ${fn}\\([^)]*\\)[\\s\\S]*?if \\(R\\.id !== id\\) return;`), `${fn} 要在 await 之后确认还是同一篇`);
  }
  assert.match(thesis, /async function loadQuotes\(\)[\s\S]*?const id = R\.id;/);
  assert.match(thesis, /async function loadQuotes\(\)[\s\S]*?if \(R\.id !== id\) return;/);
});

test('文献中心：注释与「我的思考」的落盘同样先锁 id', () => {
  assert.match(app, /async function saveAnnotations\(anns\)[\s\S]*?const litId = pr\.recordId;/, '要先锁 litId');
  assert.match(app, /async function saveAnnotations\(anns\)[\s\S]*?items\.findIndex\(\(x\) => x\.id === litId\)/, '写回要用锁住的 litId');
  assert.match(app, /const litId = pr\.recordId;\s*\/\/ 同上：切篇后再读 pr\.recordId 会认错人/,
    '「我的思考」保存也要锁 litId');
  assert.doesNotMatch(app, /items\.findIndex\(\(x\) => x\.id === pr\.recordId\)/,
    '不得再出现「响应回来才读 pr.recordId」的写法');
});
