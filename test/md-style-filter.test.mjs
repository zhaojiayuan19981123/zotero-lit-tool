// md-style-filter.test.mjs —— Markdown 内联 style 白名单（public/md-style-filter.js）
//
// 这一层的存在理由很具体：**KaTeX 的公式排版靠内联 style**。
// 白名单把 height / top / vertical-align / border-bottom-width 当垃圾清掉，
// 公式不会报错、也不会缺字，只会上下标糊成一团、分式塌成一行 ——
// 用户看到的就是「AI 回答里的公式乱成一坨」（v1.38.0 的线上现象）。
//
// 所以这里不测「正则写得对不对」，而是直接拿**真实 KaTeX 输出**过一遍白名单：
//   · 公式里出现的每一条 style 声明都必须活下来（漏一条就说明排版要塌）；
//   · 公式外面的同类声明必须被拦（不能因为修 bug 把闸门整体放开）；
//   · url() / expression() / position:fixed 这类危险声明在公式里也得拦。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 在 vm 里搭一个最小浏览器环境：window + KaTeX + 白名单模块 */
function loadHarness() {
  const context = { window: {} };
  context.self = context.window;
  vm.createContext(context);
  vm.runInContext(read('public/vendor/katex/katex.min.js'), context, { filename: 'katex.min.js' });
  vm.runInContext(read('public/md-style-filter.js'), context, { filename: 'md-style-filter.js' });
  const katex = context.window.katex || context.katex;
  return { katex, filter: context.window.MdStyleFilter.filterStyle };
}

const { katex, filter } = loadHarness();

// 覆盖 AI 回答里真正常见的写法：分式、上下标、求和与上下限、根号、重音、矩阵、\rule
const SAMPLES = [
  '\\hat\\beta_{\\text{ON}}^{(s)}',
  '\\frac{0.8+0.7+0.4+0.3}{4}=0.55',
  '\\bar y=\\frac{1}{n}\\sum_i y_i',
  '\\sum_{k=1}^{N}\\frac{1}{k}',
  '\\sqrt{x^2+y^2}',
  '\\hat\\beta_0', '\\bar x', '\\pm 0.20', 'N=25',
  '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}',
  '\\overbrace{x+y}^{n}', '\\underbrace{a+b}_{2}',
  '\\left(\\frac{a}{b}\\right)', '\\int_0^1 x\\,dx',
  '\\overset{?}{=}', '\\xrightarrow{n\\to\\infty}',
];

test('KaTeX 渲染出的每一条内联 style 都能通过白名单', () => {
  const norm = (s) => s.split(';').map((x) => x.trim()).filter(Boolean).join(';');
  let checked = 0;
  for (const tex of SAMPLES) {
    for (const displayMode of [false, true]) {
      const html = katex.renderToString(tex, { throwOnError: false, displayMode });
      for (const m of html.matchAll(/style="([^"]*)"/g)) {
        const decl = m[1];
        // KaTeX 在矩阵等环境里会吐 style="false" 这种没有冒号的残值，丢掉是对的
        if (!decl.includes(':')) continue;
        assert.equal(
          norm(filter(decl, true)), norm(decl),
          `公式 ${tex} 的 style 被白名单削掉了：${decl}`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked > 50, `样本太少（${checked} 条），说明 KaTeX 没渲染出预期结构`);
});

test('白名单确实放行了分式/上下标的关键属性', () => {
  // 这四条少任何一条，公式就会「看起来像公式、其实全叠在一起」
  for (const decl of [
    'height:1.3383em',
    'vertical-align:-0.2935em',
    'top:-3.2634em',
    'border-bottom-width:0.04em',
  ]) {
    assert.equal(filter(decl, true), decl, `${decl} 必须放行`);
  }
});

test('公式子树之外不放行排版属性（用户粘贴的 style 仍然受限）', () => {
  for (const decl of ['height:1.3383em', 'top:-3em', 'position:relative', 'border-bottom-width:0.04em']) {
    assert.equal(filter(decl, false), '', `${decl} 不该在公式外被保留`);
  }
  // 通用排版意图（字号 / 对齐 / 颜色）照旧放行
  assert.equal(filter('font-size:14px', false), 'font-size:14px');
  assert.equal(filter('text-align:center', false), 'text-align:center');
  assert.equal(filter('color:red', false), 'color:red');
});

test('危险声明即使出现在公式里也拦得住', () => {
  const bad = [
    'background:url(http://evil/x.png)',
    'position:fixed',
    'top:expression(alert(1))',
    'height:calc(100vh)',
  ];
  for (const decl of bad) {
    const kept = filter(decl, true);
    assert.equal(kept, '', `${decl} 不应通过白名单`);
  }
  // 混合串里只留合法的那条（危险的那条被摘掉，不等于整串丢弃）
  assert.equal(filter('height:1em;background:url(http://evil/x.png)', true), 'height:1em');
  assert.equal(filter('width:9999px;top:expression(1)', true), 'width:9999px');
});

test('空值与异常输入不抛错', () => {
  assert.equal(filter('', true), '');
  assert.equal(filter(null, true), '');
  assert.equal(filter(undefined, false), '');
  assert.equal(filter(';;;', true), '');
});

test('app.js 的清洗钩子接到这个白名单上，且公式子树按 .katex 判定', () => {
  const app = read('public/app.js');
  assert.match(app, /window\.MdStyleFilter\.filterStyle\(data\.attrValue, inMath\)/);
  assert.match(app, /closest\('\.katex, \.katex-display'\)/);
  // index.html 必须在 app.js 之前引入，否则钩子拿到的是 undefined（样式会被整体丢掉）
  const html = read('public/index.html');
  assert.ok(html.indexOf('md-style-filter.js') < html.indexOf('src="app.js"'), 'md-style-filter.js 必须先于 app.js 加载');
});
