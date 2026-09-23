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

// ---------- 节点宽度自适应 ----------

test('charWidth：中文按整字宽，ASCII 明显更窄', () => {
  const fs16 = U.charWidth('中', 16);
  const ascii = U.charWidth('a', 16);
  assert.equal(fs16, 16);
  assert.ok(ascii < fs16, 'ASCII 应比中文窄');
  assert.ok(ascii > 0);
  // 全角标点按整字宽
  assert.equal(U.charWidth('，', 16), 16);
});

test('estimateTextWidth 与字号成正比', () => {
  const w16 = U.estimateTextWidth('中文标题', 16);
  const w32 = U.estimateTextWidth('中文标题', 32);
  assert.ok(Math.abs(w32 - w16 * 2) < 0.001);
});

test('idealNodeTextWidth：短文字收紧、长文字触顶、永不为 0', () => {
  const opts = { fontSize: 16, minWidth: 96, maxWidth: 320 };
  // 极短：被下限托住，不会塌成一条线
  assert.equal(U.idealNodeTextWidth('结论', opts), 96);
  // 中等：按实际宽度走（2 字 * 16 + 2 = 34 → 仍被下限托住；4 字 → 66 也被托住）
  const mid = U.idealNodeTextWidth('这是一个十二字的标题内容', opts);
  assert.ok(mid > 96 && mid <= 320, `mid=${mid} 应落在 (96, 320]`);
  // 超长：被上限夹住，不会无限宽
  const long = U.idealNodeTextWidth('超'.repeat(200), opts);
  assert.equal(long, 320);
  // 空文本回落到下限
  assert.equal(U.idealNodeTextWidth('', opts), 96);
});

test('idealNodeTextWidth：多行取最长的一行', () => {
  const opts = { fontSize: 16, minWidth: 96, maxWidth: 320 };
  const short = U.idealNodeTextWidth('短\n也很短', opts);
  const wide = U.idealNodeTextWidth('这是一行明显更长的文字内容用来对比', opts);
  assert.ok(wide > short, '含长行的节点应算出更大宽度');
});

test('fitMindmapWrapWidth：取全图最宽的一行', () => {
  const tree = {
    data: { text: '根' },
    children: [
      { data: { text: '短' }, children: [] },
      { data: { text: '这是一个很长的子节点标题用来撑宽换行阈值' }, children: [
        { data: { text: '更深的节点' }, children: [] },
      ] },
    ],
  };
  const w = U.fitMindmapWrapWidth(tree, { fontSize: 16, minWidth: 96, maxWidth: 320 });
  assert.equal(w, 320, '最长行超过上限时应取上限');
  // 只含短文字时回落到下限，而不是硬撑着 320
  const narrow = U.fitMindmapWrapWidth({ data: { text: '短' }, children: [] }, { fontSize: 16, minWidth: 96, maxWidth: 320 });
  assert.equal(narrow, 96);
});

test('fitMindmapWrapWidth：空树/空文本返回下限，不返回 NaN', () => {
  for (const t of [null, undefined, {}, { data: { text: '' }, children: [] }]) {
    const w = U.fitMindmapWrapWidth(t, { fontSize: 16, minWidth: 96, maxWidth: 320 });
    assert.equal(typeof w, 'number');
    assert.ok(Number.isFinite(w) && w >= 96, `w=${w}`);
  }
});

test('节点文字里的 HTML 会被 nodeText 剥掉（不会把标签当正文渲染）', () => {
  assert.equal(U.nodeText({ data: { text: '<p>中心主题</p>' } }), '中心主题');
  assert.equal(U.nodeText({ data: { text: '<p>第一行</p><p>第二行</p>' } }), '第一行\n第二行');
  // 标签剥掉后算宽度，不能把 <p> 的长度也算进去
  const withTag = U.idealNodeTextWidth(U.nodeText({ data: { text: '<p>中心主题</p>' } }), { fontSize: 16, minWidth: 96, maxWidth: 320 });
  const plain = U.idealNodeTextWidth('中心主题', { fontSize: 16, minWidth: 96, maxWidth: 320 });
  assert.equal(withTag, plain);
});

// ---------- 导图节点框裁字回归（v1.15.1）----------
// 背景（库源码取证）：
//   simple-mind-map 会把节点宽度 hard-clamp 到 textAutoWrapWidth：
//     width = Math.min(Math.ceil(width) + 1, textAutoWrapWidth)
//   纯文本节点换行是拿**真实渲染字体**逐字 measureText 后与该值比较，比较符是 <=。
//   汉字在默认主题（微软雅黑 16px, bold）下宽度**正好等于 fontSize**，没有小数余量。
// 旧代码的 bug：上界被硬编码成 Math.min(320, ...)，20 个汉字算出 320+2=322 被截成 320，
//   恰好等于实测宽度 320.0，于是任何亚像素取整都会把最后一个字挤到下一行 / 裁掉。

test('余量不会被上界吃掉：需求恰好等于上限时仍不多给，但绝不欠给', () => {
  // 20 个汉字 @16px = 320px 需求（用真实用户标题，实测正好 20 字 / 320.0px）
  const t = '打破常规：视觉非典型性如何影响品牌生成图';
  assert.equal([...t].length, 20);
  const est = U.estimateTextWidth(t, 16);
  assert.equal(est, 320, '20 个汉字 @16px 必须正好估成 320');

  const atCap = U.fitMindmapWrapWidth({ data: { text: t }, children: [] }, { fontSize: 16, minWidth: 96, maxWidth: 320 });
  assert.ok(atCap >= est, `贴到上限时也不得小于需求（得到 ${atCap}，需求 ${est}）`);
});

test('上界放宽后必须留出余量，避免与真实字宽零间隙相撞', () => {
  const t = '打破常规：视觉非典型性如何影响品牌生成图';
  const est = U.estimateTextWidth(t, 16);
  // 上限充裕 → 必须比裸需求更大（留 MIND_WRAP_SLACK），否则贴死就会裁字
  const w = U.fitMindmapWrapWidth({ data: { text: t }, children: [] }, { fontSize: 16, minWidth: 96, maxWidth: 620 });
  assert.ok(w > est, `应留余量：wrap=${w} 应 > 需求 ${est}`);
  assert.ok(w <= 620, `不得超过上界：${w}`);
});

test('超长标题仍受上界约束（不能无限撑宽）', () => {
  const t = '这是一个非常长的标题用来验证节点框会不会把文字裁掉以及完整显示的边界行为';
  const w = U.fitMindmapWrapWidth({ data: { text: t }, children: [] }, { fontSize: 16, minWidth: 96, maxWidth: 620 });
  assert.ok(w <= 620, `超长也必须夹回上界，得到 ${w}`);
});

test('旧上界 320 与新上界 620 的差异：长标题不再被压到 320', () => {
  const t = 'AI辅助经管类学术文献精读与知识沉淀一体化科研终端系统设计与实现路径研究';
  const narrow = U.fitMindmapWrapWidth({ data: { text: t }, children: [] }, { fontSize: 16, minWidth: 96, maxWidth: 320 });
  const wide = U.fitMindmapWrapWidth({ data: { text: t }, children: [] }, { fontSize: 16, minWidth: 96, maxWidth: 620 });
  assert.equal(narrow, 320, '上界 320 时被压到 320（这就是旧的裁字现场）');
  assert.ok(wide > 320, `上界放开后应显著变宽，得到 ${wide}`);
  // 且放宽后必须不小于该标题的真实需求（实测 561.4px）
  assert.ok(wide >= 561, `应至少容纳实测需求 561.4px，得到 ${wide}`);
});

test('MIND_WRAP 常量已按预期导出', () => {
  assert.equal(U.MIND_WRAP_HARD_CAP, 620);
  assert.ok(U.MIND_WRAP_SLACK >= 4 && U.MIND_WRAP_SLACK <= 16, `余量应在合理区间，得到 ${U.MIND_WRAP_SLACK}`);
});

test('多子树时取全局最长行（不只根节点）', () => {
  const tree = {
    data: { text: '根' },
    children: [
      { data: { text: '短子节点' }, children: [] },
      { data: { text: '这是一个明显更长的子节点文案需要被考虑进来以撑宽换行阈值' }, children: [] },
    ],
  };
  const w = U.fitMindmapWrapWidth(tree, { fontSize: 16, minWidth: 96, maxWidth: 620 });
  const rootOnly = U.fitMindmapWrapWidth({ data: { text: '根' }, children: [] }, { fontSize: 16, minWidth: 96, maxWidth: 620 });
  assert.ok(w > rootOnly, '子节点的长文案必须参与计算');
});

// ---------- 导图样式系统（对标 XMind）----------

test('defaultMindStyle 给出可用的默认值', () => {
  const s = U.defaultMindStyle();
  assert.equal(s.layout, 'mindMap');
  assert.equal(s.scheme, 'classic');
  assert.equal(s.lineStyle, 'curve');
  assert.equal(s.rainbow, false);
  assert.ok(Number.isFinite(s.fontSize) && s.fontSize > 0);
});

test('MIND_LAYOUTS 的值与 simple-mind-map 的 layout 名一致', () => {
  // 这些是库 MindMap.constants.layoutList 里的 value，写错会导致 setLayout 静默失效
  const values = U.MIND_LAYOUTS.map((l) => l.value);
  for (const expected of ['mindMap', 'logicalStructure', 'catalogOrganization',
    'organizationStructure', 'timeline', 'fishbone', 'rightFishbone']) {
    assert.ok(values.includes(expected), `缺少布局 ${expected}`);
  }
  // 不应有重复项
  assert.equal(new Set(values).size, values.length);
});

test('normalizeMindStyle 归一化任意输入并补齐缺省', () => {
  const s = U.normalizeMindStyle(null);
  assert.equal(s.layout, 'mindMap');
  assert.equal(s.scheme, 'classic');

  // 非法值被丢弃、回落到默认，而不是把脏值传给库
  const bad = U.normalizeMindStyle({ layout: 'nope', scheme: 'nope', fontSize: 999, lineWidth: -3, lineStyle: 'x', rainbow: 'yes' });
  assert.equal(bad.layout, 'mindMap');
  assert.equal(bad.scheme, 'classic');
  assert.equal(bad.fontSize, 16, '越界字号应回落默认');
  assert.equal(bad.lineWidth, 2, '越界线宽应回落默认');
  assert.equal(bad.lineStyle, 'curve');
  assert.equal(bad.rainbow, true, 'truthy 值应转成布尔');
});

test('normalizeMindStyle 保留合法值', () => {
  const s = U.normalizeMindStyle({ layout: 'fishbone', scheme: 'ocean', fontSize: 22, lineWidth: 4, lineStyle: 'straight', rainbow: true, backgroundColor: '#123456' });
  assert.equal(s.layout, 'fishbone');
  assert.equal(s.scheme, 'ocean');
  assert.equal(s.fontSize, 22);
  assert.equal(s.lineWidth, 4);
  assert.equal(s.lineStyle, 'straight');
  assert.equal(s.rainbow, true);
  assert.equal(s.backgroundColor, '#123456');
});

test('mindScheme 找不到时回落第一个方案', () => {
  assert.equal(U.mindScheme('ocean').id, 'ocean');
  assert.equal(U.mindScheme('nope').id, U.MIND_COLOR_SCHEMES[0].id);
  assert.equal(U.mindScheme(undefined).id, U.MIND_COLOR_SCHEMES[0].id);
});

test('每个配色方案都有 id/name/swatch 与三级节点样式', () => {
  for (const s of U.MIND_COLOR_SCHEMES) {
    assert.ok(s.id && s.name, `方案缺少 id/name: ${JSON.stringify(s)}`);
    assert.equal(s.swatch.length, 3, `${s.id} 的 swatch 应为 3 色`);
    assert.ok(s.lineColor, `${s.id} 缺少 lineColor`);
    for (const level of ['root', 'second', 'node']) {
      assert.ok(s[level]?.fillColor !== undefined, `${s.id} 缺少 ${level}.fillColor`);
      assert.ok(s[level]?.color, `${s.id} 缺少 ${level}.color`);
    }
  }
  // id 不能重复，否则 UI 选中态会串
  const ids = U.MIND_COLOR_SCHEMES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('buildMindThemeConfig 产出库认识的字段，且节点样式是普通对象', () => {
  const cfg = U.buildMindThemeConfig({ scheme: 'classic', fontSize: 18, lineWidth: 3, lineStyle: 'straight', fontFamily: '微软雅黑, Microsoft YaHei' });
  assert.equal(cfg.lineWidth, 3);
  assert.equal(cfg.lineStyle, 'straight');
  assert.equal(cfg.lineColor, U.mindScheme('classic').lineColor);
  // ★ root/second/node 必须是**普通对象**：库的默认主题里它们就是对象，
  //   setThemeConfig 会与默认主题做深度合并；一旦传成 JSON 字符串，
  //   整级样式会被替换成字符串，渲染器取 fillColor/fontSize 全得 undefined，
  //   分支线坐标算出 NaN、子节点直接渲染不出来（真实浏览器里已复现过）。
  for (const k of ['root', 'second', 'node']) {
    assert.equal(typeof cfg[k], 'object', `${k} 必须是对象而非字符串`);
    assert.ok(!Array.isArray(cfg[k]), `${k} 不能是数组`);
    assert.equal(typeof cfg[k].fillColor, 'string', `${k} 应有 fillColor`);
    assert.equal(cfg[k].fontSize, 18, `${k} 的字号应跟随设置`);
    assert.equal(cfg[k].fontFamily, '微软雅黑, Microsoft YaHei');
  }
  // 对象必须先能被 JSON 序列化（样式要随笔记落盘），且内容与对象一致
  assert.equal(JSON.parse(JSON.stringify(cfg.root)).fillColor, cfg.root.fillColor);
});

test('buildMindThemeConfig 不强行改动字重等未指定的样式', () => {
  const cfg = U.buildMindThemeConfig({ scheme: 'classic' });
  // 默认主题里根节点是粗体、其余不是；我们不该把这个差异抹平
  assert.equal(cfg.root.fontWeight, undefined);
  assert.equal(cfg.node.fontWeight, undefined);
});

test('buildMindThemeConfig 的背景色：用户显式设置优先，否则用方案自带', () => {
  // 经典绿没有自带背景 → 不给 backgroundColor，交回库默认
  const a = U.buildMindThemeConfig({ scheme: 'classic', backgroundColor: '' });
  assert.equal(a.backgroundColor, undefined);

  // 暗夜方案自带深色背景
  const b = U.buildMindThemeConfig({ scheme: 'dark', backgroundColor: '' });
  assert.equal(b.backgroundColor, U.mindScheme('dark').background);

  // 用户显式设了背景 → 覆盖方案自带
  const c = U.buildMindThemeConfig({ scheme: 'dark', backgroundColor: '#ffffff' });
  assert.equal(c.backgroundColor, '#ffffff');
});

test('buildMindThemeConfig 对未归一化的输入也能工作', () => {
  const cfg = U.buildMindThemeConfig(null);
  assert.equal(cfg.lineStyle, 'curve'); // 默认结构是 mindMap，支持曲线
  assert.ok(cfg.root.color);
  assert.equal(typeof cfg.root, 'object');
});

// ---------- 分支线线型的结构限制 ----------

test('effectiveLineStyle：结构不支持曲线时回落为直线', () => {
  // 支持曲线的三种结构，原样保留
  for (const l of ['mindMap', 'logicalStructure', 'verticalTimeline']) {
    assert.equal(U.effectiveLineStyle(l, 'curve'), 'curve', `${l} 应支持曲线`);
  }
  // 不支持曲线的结构（如鱼骨图/组织结构图/时间轴），回落成直线，避免连线算出 NaN
  for (const l of ['fishbone', 'organizationStructure', 'timeline', 'catalogOrganization', 'rightFishbone']) {
    assert.equal(U.effectiveLineStyle(l, 'curve'), 'straight', `${l} 应回落为直线`);
  }
  // straight 全结构可用，永远原样返回
  for (const l of ['fishbone', 'mindMap', 'timeline']) {
    assert.equal(U.effectiveLineStyle(l, 'straight'), 'straight');
  }
});

test('buildMindThemeConfig：切到鱼骨图后 lineStyle 自动回落，不再下发 curve', () => {
  const cfg = U.buildMindThemeConfig({ layout: 'fishbone', lineStyle: 'curve' });
  assert.equal(cfg.lineStyle, 'straight');
  // 换回支持曲线的结构，用户的曲线选择要恢复
  const back = U.buildMindThemeConfig({ layout: 'mindMap', lineStyle: 'curve' });
  assert.equal(back.lineStyle, 'curve');
});

test('schemeSwatch 返回三项，未知方案回落第一套', () => {
  assert.equal(U.schemeSwatch('ocean').length, 3);
  // 跨 realm 数组不能直接 deepEqual，转成字符串比
  assert.equal(U.schemeSwatch('nope').join(','), U.MIND_COLOR_SCHEMES[0].swatch.join(','));
});

test('MIND_FONTS / MIND_LINE_WIDTHS / MIND_LINE_STYLES 结构完整', () => {
  for (const f of U.MIND_FONTS) assert.ok(f.value && f.name, `字体项不完整: ${JSON.stringify(f)}`);
  for (const w of U.MIND_LINE_WIDTHS) assert.ok(Number.isFinite(w.value) && w.name);
  // 跨 realm：用 join 比较，避免原型不同导致 deepStrictEqual 失败
  assert.equal(U.MIND_LINE_STYLES.map((s) => s.value).join(','), 'curve,straight');
});
