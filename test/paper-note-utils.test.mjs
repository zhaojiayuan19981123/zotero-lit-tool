import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const utilSource = fs.readFileSync(path.join(ROOT, 'public', 'paper-note-utils.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(utilSource, context, { filename: 'paper-note-utils.js' });
const U = context.window.PaperNoteUtils;
// 跨 realm（vm 沙箱）数组用 deepStrictEqual 会因原型不同而失败，统一转成本地数组再比
const texts = (nodes) => Array.from(nodes, (n) => U.nodeText(n));

// ---------- 三栏比例 ----------

test('默认三栏比例是 0.4 : 0.2 : 0.4', () => {
  const p = U.normalizePanes(null);
  assert.equal(Number(p.left.toFixed(4)), 0.4);
  assert.equal(Number(p.mid.toFixed(4)), 0.2);
  assert.equal(Number(p.right.toFixed(4)), 0.4);
});

test('normalizePanes 归一化任意输入且始终和为 1', () => {
  const p = U.normalizePanes({ left: 2, mid: 1, right: 1 });
  assert.equal(Number(p.left.toFixed(4)), 0.5);
  assert.equal(Number(p.mid.toFixed(4)), 0.25);
  assert.equal(Number(p.right.toFixed(4)), 0.25);
  assert.equal(Number((p.left + p.mid + p.right).toFixed(10)), 1);

  // 非法值回落到默认比例
  const bad = U.normalizePanes({ left: 'x', mid: -1, right: 0 });
  assert.equal(Number(bad.left.toFixed(4)), 0.4);
  assert.equal(Number(bad.mid.toFixed(4)), 0.2);
  assert.equal(Number(bad.right.toFixed(4)), 0.4);
});

test('拖动左分隔条时只有 left 与 mid 此消彼长，right 不变', () => {
  const start = { left: 0.4, mid: 0.2, right: 0.4 };
  const moved = U.resizePanes('left', 100, 1000, start);
  assert.ok(moved.left > start.left, 'left 应随右移变大');
  assert.ok(moved.mid < start.mid, 'mid 应随右移变小');
  assert.equal(Number(moved.right.toFixed(6)), 0.4, 'right 必须保持不变');
  assert.equal(Number((moved.left + moved.mid).toFixed(6)), 0.6, 'left+mid 守恒');
});

test('拖动右分隔条时只有 mid 与 right 此消彼长，left 不变', () => {
  const start = { left: 0.4, mid: 0.2, right: 0.4 };
  const moved = U.resizePanes('right', 100, 1000, start);
  assert.ok(moved.right < start.right, 'right 应随右移变小');
  assert.ok(moved.mid > start.mid, 'mid 应随右移变大');
  assert.equal(Number(moved.left.toFixed(6)), 0.4, 'left 必须保持不变');
  assert.equal(Number((moved.mid + moved.right).toFixed(6)), 0.6, 'mid+right 守恒');
});

test('极端拖拽下三栏都不会被压到看不见', () => {
  let panes = { left: 0.4, mid: 0.2, right: 0.4 };
  // 往一边猛拽 20 次
  for (let i = 0; i < 20; i += 1) panes = U.resizePanes('left', 500, 1000, panes);
  assert.ok(panes.mid >= U.MIN_PANE_RATIO - 1e-6, 'mid 不应小于最小比例');
  assert.ok(panes.left > 0 && panes.right > 0);
  // 再往反方向猛拽
  for (let i = 0; i < 40; i += 1) panes = U.resizePanes('right', 500, 1000, panes);
  assert.ok(panes.right >= U.MIN_PANE_RATIO - 1e-6, 'right 不应小于最小比例');
  assert.equal(Number((panes.left + panes.mid + panes.right).toFixed(6)), 1);
});

test('窄容器下用像素下限换算比例，栏宽不会被压到 0', () => {
  const panes = U.resizePanes('left', 9999, 600, { left: 0.4, mid: 0.2, right: 0.4 });
  // 600px 容器下，180px 下限 = 0.3 比例
  assert.ok(panes.mid * 600 >= U.MIN_PANE_PX - 1, 'mid 至少保留 180px');
  assert.equal(Number((panes.left + panes.mid + panes.right).toFixed(6)), 1);
});

test('容器宽度非法时原样返回当前比例', () => {
  const cur = { left: 0.5, mid: 0.25, right: 0.25 };
  const out = U.resizePanes('left', 100, 0, cur);
  assert.equal(Number(out.left.toFixed(4)), 0.5);
});

test('paneFlex 输出可用于 flex-basis 的百分比', () => {
  assert.equal(U.paneFlex(0.4), '40.0000%');
  assert.equal(U.paneFlex(0.2), '20.0000%');
  assert.equal(U.paneFlex(0), '0.0000%');
  assert.equal(U.paneFlex('bad'), '0.0000%');
});

// ---------- 富文本 / 纯文本 ----------

test('stripHtml 剥掉标签并保留换行语义', () => {
  assert.equal(U.stripHtml('<p>中心主题</p>'), '中心主题');
  assert.equal(U.stripHtml('第一行<br/>第二行'), '第一行\n第二行');
  assert.equal(U.stripHtml('<div>a</div><div>b</div>'), 'a\nb');
  assert.equal(U.stripHtml('&lt;tag&gt; &amp; &quot;q&quot;'), '<tag> & "q"');
  assert.equal(U.stripHtml('<b>粗</b>体'), '粗体');
});

test('nodeText 从库节点里取出纯文本', () => {
  assert.equal(U.nodeText({ data: { text: '<p>研究问题</p>' } }), '研究问题');
  assert.equal(U.nodeText({ data: {} }), '');
  assert.equal(U.nodeText(null), '');
});

// ---------- Markdown ↔ 思维导图 ----------

test('Markdown 大纲转思维导图：一级标题作中心主题，子标题成子节点', () => {
  const md = ['# 论文笔记', '## 方法', '- 数据集', '- 模型', '## 结论', '- 有效'].join('\n');
  const root = U.mdToMindmap(md);
  assert.ok(root, '应产出根节点');
  assert.equal(U.nodeText(root), '论文笔记');
  const labels = texts(root.children);
  assert.deepEqual(labels, ['方法', '结论']);
  assert.deepEqual(texts(root.children[0].children), ['数据集', '模型']);
  assert.equal(U.countNodes(root), 6);
});

test('Markdown 列表按缩进形成父子层级', () => {
  const md = ['# 主题', '- 一级', '  - 二级', '    - 三级', '- 另一个一级'].join('\n');
  const root = U.mdToMindmap(md);
  assert.equal(U.nodeText(root), '主题');
  assert.equal(root.children.length, 2);
  const first = root.children[0];
  assert.equal(U.nodeText(first), '一级');
  assert.equal(U.nodeText(first.children[0]), '二级');
  assert.equal(U.nodeText(first.children[0].children[0]), '三级');
  assert.equal(U.nodeText(root.children[1]), '另一个一级');
});

test('Markdown 转导图会跳过代码块、表格与引用块', () => {
  const md = ['# T', '```js', 'const a = 1;', '```', '| a | b |', '> 引用不该成节点', '- 保留'].join('\n');
  const root = U.mdToMindmap(md);
  assert.deepEqual(texts(root.children), ['保留']);
});

test('Markdown 转导图会剥掉行内强调符号', () => {
  const md = ['# T', '- **重点**内容', '- `code`片段'].join('\n');
  const root = U.mdToMindmap(md);
  assert.deepEqual(texts(root.children), ['重点内容', 'code片段']);
});

test('空 Markdown 转导图返回 null', () => {
  assert.equal(U.mdToMindmap(''), null);
  assert.equal(U.mdToMindmap('   \n\n  '), null);
  assert.equal(U.mdToMindmap(null), null);
});

test('思维导图转 Markdown：中心主题成一级标题，其余成缩进列表', () => {
  const tree = {
    data: { text: '<p>中心主题</p>' },
    children: [
      { data: { text: '分支A' }, children: [{ data: { text: '叶子A1' } }] },
      { data: { text: '分支B' }, children: [] },
    ],
  };
  const md = U.mindmapToMd(tree);
  assert.match(md, /^# 中心主题/);
  assert.match(md, /^- 分支A/m);
  assert.match(md, /^ {2}- 叶子A1/m);
  assert.match(md, /^- 分支B/m);
});

test('Markdown → 导图 → Markdown 往返保住标题与层级', () => {
  const md = ['# 我的笔记', '## 摘要', '- 要点一', '- 要点二', '## 方法'].join('\n');
  const roundTrip = U.mindmapToMd(U.mdToMindmap(md));
  assert.match(roundTrip, /^# 我的笔记/);
  assert.match(roundTrip, /^- 摘要/m);
  assert.match(roundTrip, /^ {2}- 要点一/m);
  assert.match(roundTrip, /^ {2}- 要点二/m);
  assert.match(roundTrip, /^- 方法/m);
});

test('mindmapToMd / countNodes 对空输入安全', () => {
  assert.equal(U.mindmapToMd(null), '');
  assert.equal(U.countNodes(null), 0);
  assert.equal(U.countNodes({ data: { text: 'x' } }), 1);
});

// ---------- 片段插入 ----------

test('buildNoteSnippet 把原文转成引用块、译文紧随其后', () => {
  const s = U.buildNoteSnippet('multi modal', '多模态');
  assert.match(s, /^> multi modal/);
  assert.match(s, /\n\n多模态/);
  assert.equal(U.buildNoteSnippet('', ''), '');
});

test('buildNoteSnippet 支持多行原文与自定义标题', () => {
  const s = U.buildNoteSnippet('第一行\n第二行', '译文', { heading: '片段 1' });
  assert.match(s, /^### 片段 1/);
  assert.match(s, /> 第一行\n> 第二行/);
});

test('insertSnippet 插入到空笔记时不加多余换行', () => {
  const { text, cursor } = U.insertSnippet('', '甲', 0, 0);
  assert.equal(text, '甲');
  assert.equal(cursor, 1);
});

test('insertSnippet 在光标处插入并在前后补换行', () => {
  const res = U.insertSnippet('前面', '插入', 2, 2);
  assert.equal(res.text, '前面\n\n插入');
  assert.equal(res.cursor, res.text.length, '光标应落在插入内容之后');
});

test('insertSnippet 替换选区', () => {
  const res = U.insertSnippet('删除我', '新内容', 0, 3);
  assert.equal(res.text, '新内容');
  assert.equal(res.cursor, 3);
});

test('insertSnippet 越界索引会被夹紧', () => {
  const res = U.insertSnippet('abc', 'X', 99, 200);
  assert.ok(res.text.startsWith('abc'));
  assert.ok(res.cursor <= res.text.length);
});

test('已有内容以换行结尾时不重复补空行', () => {
  const res = U.insertSnippet('第一段\n\n', '第二段', 5, 5);
  assert.equal(res.text, '第一段\n\n第二段');
});

// ---------- 空态判断 ----------

test('isNoteEmpty：两种视图都空才算空', () => {
  assert.equal(U.isNoteEmpty({}), true);
  assert.equal(U.isNoteEmpty({ md: '   ' }), true);
  assert.equal(U.isNoteEmpty({ md: '有内容' }), false);
  assert.equal(U.isNoteEmpty({ mindmap: { data: { text: '只有标题' }, children: [] } }), false);
  assert.equal(
    U.isNoteEmpty({ mindmap: { data: { text: '' }, children: [{ data: { text: '子' } }] } }),
    false
  );
});
