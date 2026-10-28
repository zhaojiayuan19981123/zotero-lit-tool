// lib-search.test.mjs —— 文献搜索（全字段 / 模糊 / 相关性）纯函数测试 + 前端接线核对
//
// 背景：侧边栏那个搜索框原来只做「把几列拼成字符串再 includes」——只搜得到表格里
// 显示的字段、打错一个字母就零结果、顺序还跟"默认排序"走。1.33 把它搬进表格工具栏
// 并重写为「全字段 + 模糊 + 相关性」，逻辑抽到 public/lib-search.js 便于单测。
//
// 覆盖点：
//   1) 全字段：三类文库的专属字段（消融实验 / 我的思考 / 数据泄漏…）都在搜索范围内
//   2) 模糊：换位、漏字、错字都能命中，但不相关的长文本不会被硬凑成命中
//   3) 相关性：标题命中排在摘要命中之前；多词必须全部命中（AND）
//   4) 有搜索词时相关性是主序，用户选的那个排序只作同分次序；无搜索词时行为不变
//   5) 高亮区间合并、转义、<mark> 包裹
//   6) 接线：index.html 加载 lib-search.js、搜索框在工具栏里、侧边栏那个已移除
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const context = { window: {} };
vm.runInNewContext(read('public/lib-search.js'), context, { filename: 'lib-search.js' });
const Search = context.window.LibSearch;

const html = read('public/index.html');
const appJs = read('public/app.js');

/** 一条"算法类"文献：字段名取自真实的 TYPE_FIELDS.algorithm */
const paper = (over = {}) => ({
  id: 'lit-1',
  docType: 'algorithm',
  title: 'Attention Is All You Need',
  authors: 'Ashish Vaswani, Noam Shazeer',
  year: 2017,
  keywords: 'Transformer; 注意力机制; 序列建模',
  journal: 'NeurIPS',
  doi: '10.5555/3295222',
  abstract: '我们提出一种全新的简单网络结构 Transformer，完全基于注意力机制。',
  researchQuestion: '能否只用注意力机制替代循环结构？',
  scienceQuestion: '序列建模中的长程依赖为何难以学习？',
  coreFindings: '自注意力可以在常数路径长度内建模任意位置依赖。',
  researchDesign: '在 WMT 翻译任务上与 RNN/CNN 基线对比。',
  criticalThinking: '缺少对低资源语言的分析。',
  reviewUse: '可作为综述中"注意力范式"一节的奠基文献。',
  experimentalDesign: '消融多头数量、位置编码方式。',
  ablationDesign: '去掉多头、替换为固定位置编码后看 BLEU 变化。',
  researchGap: '没有讨论推理成本。',
  dataset: 'WMT 2014 EN-DE',
  metrics: 'BLEU',
  researchField: '自然语言处理',
  myThoughts: '对数据泄漏的检查值得借鉴。',
  filePath: 'D:/secret/path/attention.pdf',
  collectionId: 'col-9',
  ...over,
});

/**
 * 只含给定字段的最小记录。
 * 相关性测试必须用它：上面 paper() 的默认数据里到处是"注意力/Transformer"，
 * 拿它做对照会让两边都命中，测出来的差异根本不是权重造成的。
 */
const only = (fields) => ({ docType: 'algorithm', ...fields });

/**
 * vm 里 new 出来的数组属于另一个 realm，deepStrictEqual 会因为"原型不是同一个 Array"
 * 而报 "Values have same structure but are not reference-equal"。展开一层转成本 realm 的数组。
 */
const plain = (arr) => [...arr].map((x) => (Array.isArray(x) ? [...x] : x));
/** 只取 id 列表，顺便完成 realm 转换 */
const ids = (list) => [...list].map((x) => x.id);

// ==================== 1) 全字段 ====================

test('搜索覆盖全部字段：算法类专属字段与自定义备注都能搜到', () => {
  for (const kw of ['消融', 'BLEU', '自然语言处理', '数据泄漏', '奠基文献', '长程依赖', '常数路径']) {
    const hits = Search.rank([paper()], kw);
    assert.equal(hits.length, 1, `关键词「${kw}」应该命中（说明该字段没进搜索范围）`);
  }
});

test('搜索范围不含 id / 本地路径 / 分类 id（搜到也没意义，还容易误命中）', () => {
  for (const kw of ['lit-1', 'secret', 'col-9', 'attention.pdf']) {
    assert.equal(Search.rank([paper()], kw).length, 0, `「${kw}」不该命中：它在排除名单里`);
  }
  assert.deepEqual(
    [...Search.SKIP_KEYS].sort(),
    ['collectionId', 'coverPath', 'filePath', 'id', 'journalRankDetail', 'pdfPath', 'thumbPath'].sort(),
  );
});

test('数组字段（标签）也能搜', () => {
  const item = paper({ tags: ['注意力', 'Transformer'] });
  assert.equal(Search.rank([item], '注意力').length, 1);
});

test('数字字段（年份）按原样可命中', () => {
  assert.equal(Search.rank([paper()], '2017').length, 1);
});

// ==================== 2) 模糊 ====================

test('命中强度分级：整段相等 > 前缀 > 词首 > 词中', () => {
  assert.equal(Search.hit('transformer', 'transformer'), 2);
  assert.equal(Search.hit('transformer architecture', 'transformer'), 1.6);
  assert.equal(Search.hit('the transformer model', 'transformer'), 1.35);
  assert.equal(Search.hit('multitransformerx', 'transformer'), 1);
  assert.equal(Search.hit('transformer', 'diffusion'), 0);
});

test('拼写容错：换位 / 漏字 / 错字都能命中（transfromer、tranformer、transfomer）', () => {
  const item = only({ id: 'a', title: 'x transformer' });
  for (const typo of ['transfromer', 'tranformer', 'transfomer']) {
    assert.equal(Search.rank([item], typo).length, 1, `「${typo}」应通过容错命中`);
  }
});

test('3 个字符以下的词不做容错，避免「ai」把一切都捞出来', () => {
  assert.equal(Search.hit('zzz', 'ai'), 0);
  assert.equal(Search.hit('aXXi', 'ai'), 0);
});

test('容错不吃不相干的文本：毫不相干的摘要不会硬凑成命中', () => {
  const unrelated = only({ id: 'b', title: '扩散模型综述', abstract: '本文讨论扩散过程与去噪得分匹配。' });
  assert.equal(Search.rank([unrelated], 'attention').length, 0);
  assert.equal(Search.rank([unrelated], 'transformer').length, 0);
});

// ==================== 3) 相关性 ====================

test('标题命中排在摘要命中之前（摘要长，随便出现一个词不该顶到第一行）', () => {
  const inTitle = only({ id: 'a', title: '注意力机制综述' });
  const inAbstract = only({ id: 'b', title: '别的题目', abstract: '本文顺带提到注意力机制。' });
  assert.deepEqual(ids(Search.rank([inAbstract, inTitle], '注意力')), ['a', 'b']);
});

test('多个关键词必须全部命中（AND）：只含其中一个的文献被排除', () => {
  const both = only({ id: 'both', title: '注意力机制的可解释性' });
  const onlyOne = only({ id: 'one', title: '注意力机制综述' });
  assert.deepEqual(ids(Search.rank([onlyOne, both], '注意力 可解释')), ['both']);
});

test('整句在标题里完整出现时额外加分（多词查询更认"就是这篇"）', () => {
  const exact = only({ id: 'exact', title: '注意力 机制研究' });
  const spread = only({ id: 'spread', title: '注意力：另一种机制的对比' });
  assert.equal(Search.rank([spread, exact], '注意力 机制')[0].id, 'exact');
});

test('字段权重方向正确：标题(12) > 关键词(9) > 摘要(1.5)', () => {
  const title = only({ id: 'title', title: 'Transformer 变体综述' });
  const kw = only({ id: 'kw', title: '别的题目', keywords: 'Transformer' });
  const abs = only({ id: 'abs', title: '别的题目', abstract: 'Transformer 在这里只是一笔带过。' });
  assert.deepEqual(ids(Search.rank([abs, kw, title], 'transformer')), ['title', 'kw', 'abs']);
  assert.ok(Search.score(title, ['transformer']) > Search.score(kw, ['transformer']));
  assert.ok(Search.score(kw, ['transformer']) > Search.score(abs, ['transformer']));
});

// ==================== 4) 排序主序 / 兼容原有排序 ====================

test('有搜索词时以相关性为主序，传入的 cmp 只作同分次序', () => {
  const a = only({ id: 'a', title: '注意力机制', year: 2020 });
  const b = only({ id: 'b', title: '注意力机制', year: 2015 });
  const byYearAsc = (x, y) => x.year - y.year;
  // 同分 → 用 cmp（升序年份）
  assert.deepEqual(ids(Search.rank([a, b], '注意力', byYearAsc)), ['b', 'a']);
  // 不同分 → 相关性优先，cmp 不能把低分的顶上来
  const strong = only({ id: 'strong', title: '注意力', year: 2001 });
  const weak = only({ id: 'weak', title: '无关题目', abstract: '注意力' });
  assert.deepEqual(ids(Search.rank([weak, strong], '注意力', byYearAsc)), ['strong', 'weak']);
});

test('没有搜索词时完全沿用原有排序（不改变非搜索场景的行为）', () => {
  const a = paper({ id: 'a', year: 2020 });
  const b = paper({ id: 'b', year: 2015 });
  assert.deepEqual(ids(Search.rank([a, b], '', (x, y) => x.year - y.year)), ['b', 'a']);
  assert.deepEqual(ids(Search.rank([a, b], '   ', (x, y) => y.year - x.year)), ['a', 'b']);
});

test('不匹配的文献被过滤掉，空查询原样返回全部', () => {
  const items = [only({ id: 'a', title: '注意力机制' }), only({ id: 'b', title: '扩散模型' })];
  assert.equal(Search.rank(items, 'transformer').length, 0);
  assert.equal(Search.rank(items, '').length, 2);
  assert.equal(Search.rank(items, '').length, 2);
  assert.equal(Search.rank(null, 'x').length, 0);
});

// ==================== 5) 高亮 ====================

test('高亮区间会合并重叠/相邻片段，返回 [start, end)', () => {
  assert.deepEqual(plain(Search.highlightRanges('attention attention', ['attention'])), [[0, 9], [10, 19]]);
  // 相邻（注意力|机制）合并成一段，避免一个词被切成两个 <mark>
  assert.deepEqual(plain(Search.highlightRanges('注意力机制', ['注意力', '机制'])), [[0, 5]]);
  // 不相邻的分开
  assert.deepEqual(plain(Search.highlightRanges('注意力和机制', ['注意力', '机制'])), [[0, 3], [4, 6]]);
  assert.deepEqual(plain(Search.highlightRanges('abc', ['zzz'])), []);
});

test('高亮 HTML 会转义原文并包 <mark>（不能把用户数据当 HTML 拼进去）', () => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const out = Search.highlight('a<b>attention</b>', ['attention'], esc);
  assert.equal(out, 'a&lt;b&gt;<mark class="kw">attention</mark>&lt;/b&gt;');
  // 没有关键词时就是纯转义，和以前 esc() 的效果一致
  assert.equal(Search.highlight('a<b>', [], esc), 'a&lt;b&gt;');
});

// ==================== 6) 接线 ====================

test('index.html 在 app.js 之前加载 lib-search.js', () => {
  const lib = html.indexOf('<script src="lib-search.js"></script>');
  const app = html.indexOf('<script src="app.js"></script>');
  assert.ok(lib > 0, 'index.html 应加载 lib-search.js');
  assert.ok(app > lib, 'lib-search.js 必须排在 app.js 之前（app.js 启动时就要用）');
});

test('搜索框长在文献表格工具栏里（原侧边栏那个已移除）', () => {
  assert.match(html, /id="libSearchInput"/);
  assert.match(html, /id="libSearchClear"/);
  assert.match(html, /id="libSearchCount"/);
  // 侧边栏搜索框必须彻底删掉，否则会出现两个输入框抢同一份过滤状态
  assert.doesNotMatch(html, /side-search/);
  assert.doesNotMatch(html, /sideSearchInput/);
  assert.doesNotMatch(appJs, /sideSearchInput/);
  const toolbar = html.slice(html.indexOf('<div class="toolbar">'), html.indexOf('<div id="fieldsPop"'));
  assert.match(toolbar, /id="libSearchInput"/, '搜索框应位于 .toolbar 内');
});

test('app.js 用 LibSearch 排序，且高亮接在表格单元格上', () => {
  assert.match(appJs, /window\.LibSearch/);
  assert.match(appJs, /Search\.rank\(list, q, cmp\)/);
  assert.match(appJs, /Search\.highlight\(text, activeTokens, esc\)/);
  // 标题列与普通文本列都要高亮
  assert.ok(appJs.includes('${highlight(v) || '), '标题单元格应使用高亮');
  assert.ok(appJs.includes('${highlight(v)}</div>'), '普通文本单元格应使用高亮');
});
