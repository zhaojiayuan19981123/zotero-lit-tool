// rank-utils.test.mjs —— 期刊等级配色（rankSystemTone）纯函数测试 + 前端接线一致性
//
// 覆盖点：
//   1) 六大体系按用户口径上色：正红 / 淡红 / 黄 / 蓝 / 绿 / 灰
//   2) 各家写法差异（Q1-4 / 1-4区 / A+ABCD / T1-T3 / 4*）都能落到同一档位
//   3) Top 与 CSSCI 走最高档；CSSCI扩展版次一档
//   4) 否定取值、认不出的写法、空值 → 灰（兜底）
//   5) 返回值恒在白名单内（要拼进 class 名，不能有意外字符）
//   6) 所有出现期刊等级的位置都接上了同一套渲染（静态核对，防漏改）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'public', 'rank-utils.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context, { filename: 'rank-utils.js' });
const { rankSystemTone, tierOf, TONES } = context.window.RankUtils;

test('SSCI 按 Q1-Q4 依次为 淡红 / 黄 / 蓝 / 绿', () => {
  assert.equal(rankSystemTone('SSCI', 'Q1'), 'pink');
  assert.equal(rankSystemTone('SSCI', 'Q2'), 'yellow');
  assert.equal(rankSystemTone('SSCI', 'Q3'), 'blue');
  assert.equal(rankSystemTone('SSCI', 'Q4'), 'green');
});

test('中科院分区：1-4 区同 SSCI 口径，带 Top 的走正红', () => {
  assert.equal(rankSystemTone('中科院分区', '经济学1区'), 'pink');
  assert.equal(rankSystemTone('中科院分区', '2区'), 'yellow');
  assert.equal(rankSystemTone('中科院分区', '3区'), 'blue');
  assert.equal(rankSystemTone('中科院分区', '4区'), 'green');
  assert.equal(rankSystemTone('中科院分区', '1区Top'), 'red');
  assert.equal(rankSystemTone('中科院分区', 'TOP'), 'red');
});

test('新锐分区：1-4 区同口径，字母档 A+/A/B/C/D 等价 1~4 档', () => {
  assert.equal(rankSystemTone('新锐分区', '1区'), 'pink');
  assert.equal(rankSystemTone('新锐分区', '4区'), 'green');
  assert.equal(rankSystemTone('新锐分区', 'A+'), 'pink');
  assert.equal(rankSystemTone('新锐分区', 'A'), 'pink');
  assert.equal(rankSystemTone('新锐分区', 'B'), 'yellow');
  assert.equal(rankSystemTone('新锐分区', 'C'), 'blue');
  assert.equal(rankSystemTone('新锐分区', 'D'), 'green');
  assert.equal(rankSystemTone('新锐分区', 'Top'), 'red');
});

test('ABS：4*→正红，4/3/2/1 → 黄/蓝/绿/灰', () => {
  assert.equal(rankSystemTone('ABS', '4*'), 'red');
  assert.equal(rankSystemTone('ABS', '4'), 'yellow');
  assert.equal(rankSystemTone('ABS', '3'), 'blue');
  assert.equal(rankSystemTone('ABS', '2'), 'green');
  assert.equal(rankSystemTone('ABS', '1'), 'gray');
  // 少数数据集给 A*/A/B/C 写法，语义与 4*/4/3/2 对应
  assert.equal(rankSystemTone('ABS', 'A*'), 'red');
  assert.equal(rankSystemTone('ABS', 'B'), 'blue');
});

test('FMS：T1/T2/T3 → 正红/黄/蓝；字母写法 A/B/C/D 同样可识别', () => {
  assert.equal(rankSystemTone('FMS', 'T1'), 'red');
  assert.equal(rankSystemTone('FMS', 'T2'), 'yellow');
  assert.equal(rankSystemTone('FMS', 'T3'), 'blue');
  assert.equal(rankSystemTone('FMS', 'C'), 'blue');
  assert.equal(rankSystemTone('FMS', 'A'), 'red');
});

test('CSSCI 走正红，扩展版次一档（淡红）', () => {
  assert.equal(rankSystemTone('CSSCI', 'CSSCI'), 'red');
  assert.equal(rankSystemTone('CSSCI', 'CSSCI扩展版'), 'pink');
});

test('UTD24 走正红；取值为否定写法时按灰处理', () => {
  assert.equal(rankSystemTone('UTD24', 'UTD24'), 'red');
  assert.equal(rankSystemTone('UTD24', '是'), 'red');
  assert.equal(rankSystemTone('UTD24', '否'), 'gray');
  assert.equal(rankSystemTone('CSSCI', '否'), 'gray');
});

test('认不出的体系 / 认不出的取值 / 空值一律灰（兜底不报错）', () => {
  assert.equal(rankSystemTone('北大核心', '是'), 'gray');
  assert.equal(rankSystemTone('中科院分区', '未收录'), 'gray');
  assert.equal(rankSystemTone('SSCI', 'Q9'), 'gray');
  assert.equal(rankSystemTone('SSCI', ''), 'gray');
  assert.equal(rankSystemTone('SSCI', null), 'gray');
  assert.equal(rankSystemTone(undefined, undefined), 'gray');
});

test('返回值恒为白名单内的色档（要拼进 class 名，不能有异常字符）', () => {
  const labels = ['中科院分区', '新锐分区', 'ABS', 'UTD24', 'SSCI', 'FMS', 'CSSCI', '未知体系'];
  const values = ['Q1', '1区', '4*', 'T2', 'A+', 'CSSCI', 'Top', '否', '', '<img>', '1区" onload=x'];
  for (const label of labels) {
    for (const value of values) {
      assert.ok(TONES.includes(rankSystemTone(label, value)), `${label}/${value} 返回了白名单外的色档`);
    }
  }
});

test('tierOf 能解析四种写法，认不出返回 0', () => {
  assert.equal(tierOf('Q2'), 2);
  assert.equal(tierOf('经济学4区'), 4);
  assert.equal(tierOf('T3'), 3);
  assert.equal(tierOf('a+'), 1);
  assert.equal(tierOf('4*'), 0);
  assert.equal(tierOf(''), 0);
});

test('前端接线：配色脚本先于 app.js 加载，等级标签渲染统一走 rankChips', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

  assert.ok(html.includes('<script src="rank-utils.js"></script>'), 'index.html 应加载 rank-utils.js');
  assert.ok(
    html.indexOf('rank-utils.js') < html.indexOf('src="app.js"'),
    'rank-utils.js 必须排在 app.js 之前，否则 rankChips 拿不到配色函数',
  );

  // chip 上真的拼了色档类名，且取样自 RankUtils
  assert.match(app, /rank-chip rank-chip-\$\{tone\}/);
  assert.match(app, /window\.RankUtils\.rankSystemTone/);

  // 各处展示点都接上 rankChips：文献表格/抽屉、审稿页、小论文卡片与弹窗
  assert.match(app, /body = `<div class="clamp rank-cell"[^`]*\$\{rankChips\(it\.journalRankDetail\)\}/);
  assert.match(app, /\$\('reviewRank'\)\.innerHTML = rankChips\(active\.journalRankDetail\)/);
  assert.match(app, /box\.innerHTML = rankChips\(rank\.items\)/);
  assert.match(app, /\$\('paperRankChips'\)\.innerHTML = rank\.items\?\.length\s*\n?\s*\? rankChips\(rank\.items\)/);

  // 六个色档都要有样式，否则标签会退化成无色底
  for (const tone of ['red', 'pink', 'yellow', 'blue', 'green', 'gray']) {
    assert.ok(css.includes(`.rank-chip-${tone} `), `style.css 缺少 .rank-chip-${tone}`);
  }
});
