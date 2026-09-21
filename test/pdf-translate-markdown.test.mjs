// pdf-translate-markdown.test.mjs —— Markdown 译文输出（文本层路径 + 视觉模型路径）的回归用例
//
// 守护点：
//   1) 输出模式：md 是一等公民（resolveModes / OUTPUT_META / 默认值）
//   2) 文本层路径：标题层级映射、段落、图表 crop 引用不能串
//   3) 视觉路径：标记解析的容错（漏闭合 / 无标记 / 未知标记）
//   4) 视觉组装：翻译回填、未译回退原文、[FIG] → analyze 图片区域的映射
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PDF_TRANSLATE_OPTIONS, MODES, OUTPUT_META, resolveModes, visionConcurrency,
} from '../src/pdfTranslate/index.js';
import {
  buildMarkdownFromLayout, elementsToMarkdown,
  parseVisionBlocks, collectVisionSegments, applyVisionTranslations,
  assembleVisionMarkdown, visionPageFallbackMarkdown, visionPaperPrompt,
} from '../src/pdfTranslate/markdown.js';

// ==================== fixture ====================

function mkBlock(over = {}) {
  return {
    id: 'b', text: '', rawText: '', translation: '', translatable: true,
    kind: 'body', size: 10, bold: false, italic: false, column: 0,
    x0: 50, y0: 600, x1: 500, y1: 620, tableLike: false,
    ...over,
  };
}

function mkPage(index, blocks, images = []) {
  return { index, rotate: 0, columns: [], blocks, images };
}

// ==================== 输出模式 ====================

test('md 是一等输出模式：默认值 / MODES / resolveModes / OUTPUT_META 全部认它', () => {
  assert.equal(DEFAULT_PDF_TRANSLATE_OPTIONS.mode, 'md');
  assert.ok(MODES.includes('md'));
  assert.deepEqual(resolveModes('md'), ['md']);
  // all 展开：Markdown 排最前（用户最终想看的那份）
  assert.deepEqual(resolveModes('all'), ['md', 'reflow', 'mono', 'dual']);
  assert.deepEqual(resolveModes('both'), ['mono', 'dual']);
  assert.equal(OUTPUT_META.md.suffix, '-译文');
  assert.ok(OUTPUT_META.md.label.includes('Markdown'));
});

// ==================== 文本层路径 ====================

test('buildMarkdownFromLayout：按论文目录结构输出（标题 → 章节 → 正文），图注不再保留', () => {
  const pages = [mkPage(0, [
    mkBlock({ id: 't', kind: 'title', size: 18, y1: 750, text: 'Paper Title', translation: '论文标题' }),
    mkBlock({ id: 'h', kind: 'heading', size: 14, y1: 700, text: '1 Introduction', translation: '1 引言' }),
    mkBlock({ id: 'p1', kind: 'body', size: 10, y1: 650, text: 'Body one.', translation: '正文一' }),
    mkBlock({ id: 'p2', kind: 'body', size: 10, y1: 600, text: 'Body two.', translation: '正文二' }),
    mkBlock({ id: 'cap', kind: 'caption', size: 9, y1: 550, text: 'Figure 1: demo', translation: '图 1：示例' }),
  ])];
  const { markdown, stats } = buildMarkdownFromLayout(pages);
  assert.ok(markdown.startsWith('# 论文标题'), '论文主标题应为 H1');
  assert.ok(markdown.includes('## 1 引言'), '一级章节标题为 H2');
  // 文本层拿不到原文（buildElements 已把 text 换成译文），因此不附「> 原文」
  assert.ok(!markdown.includes('> 原文：'), '文本层路径不附原文行（避免把译文重复一遍）');
  assert.ok(markdown.includes('正文一'));
  assert.ok(!markdown.includes('图 1：示例'), '用户口径：图表（含图注）一律不要');
  assert.ok(stats.dropped >= 1, '被丢弃的图表块应计数');
});

test('buildMarkdownFromLayout：文章信息保留、公式保留、图与表全部丢弃', () => {
  const pages = [mkPage(0, [
    mkBlock({ id: 'm', kind: 'body', size: 10, y1: 730, text: 'Journal of X, 2025. ISSN 1234-5678. DOI: 10.1/abc', translation: 'Journal of X, 2025. ISSN 1234-5678. DOI: 10.1/abc' }),
    mkBlock({ id: 'p', kind: 'body', size: 10, y1: 650, translation: '正文' }),
    // 不可译的公式块 → 保留（公式属于正文语义）
    mkBlock({ id: 'f', kind: 'formula', translatable: false, y1: 500, y0: 460, text: 'E=mc^2' }),
    // 参考文献与页眉（furniture）→ 直接丢弃
    mkBlock({ id: 'r', kind: 'reference', translatable: false, y1: 100, text: '[1] someone' }),
    mkBlock({ id: 'h', kind: 'furniture', translatable: false, y1: 790, text: 'header' }),
  ], [
    { x0: 320, y0: 250, x1: 520, y1: 400 },   // 插图区域：按用户要求不再插入
  ])];
  const { markdown, stats } = buildMarkdownFromLayout(pages);
  assert.ok(markdown.includes('E=mc^2'), '公式保留为 LaTeX 块');
  assert.ok(!markdown.includes('crop:'), '不再输出任何裁剪图引用');
  assert.ok(!markdown.includes('Someone') && !markdown.includes('someone'), '参考文献不应出现在 Markdown 里');
  assert.ok(!markdown.includes('header'), '页眉不应出现在 Markdown 里');
  assert.equal(stats.crops, 0);
});

test('elementsToMarkdown：译文缺失时回退原文', () => {
  const md = elementsToMarkdown([
    { type: 'text', level: 'body', text: '', sourceBold: false },
    { type: 'text', level: 'h2', text: '只有原文', sourceBold: false },
  ]);
  assert.ok(md.markdown.includes('## 只有原文'));
});

// ==================== 视觉路径：标记解析 ====================

test('parseVisionBlocks：标准标记逐一解析，多行 [P] 合并', () => {
  const raw = [
    '[TITLE] Deep Learning',
    '[H1] 1 Introduction',
    '[P] First paragraph line one',
    'continues here without marker',
    '[FIG] system architecture',
  ].join('\n');
  const blocks = parseVisionBlocks(raw);
  assert.deepEqual(blocks.map((b) => b.tag), ['TITLE', 'H1', 'P', 'FIG']);
  assert.equal(blocks[0].text, 'Deep Learning');
  assert.equal(blocks[2].text, 'First paragraph line one\ncontinues here without marker');
});

test('parseVisionBlocks：[/TABLE] / [/FORMULA] 闭合与漏闭合的容错', () => {
  const raw = [
    '[P] before table',
    '[TABLE]',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '[/TABLE]',
    '[FORMULA]',
    'E = mc^2',
    '[/FORMULA]',
    '[P] after',
  ].join('\n');
  const blocks = parseVisionBlocks(raw);
  assert.deepEqual(blocks.map((b) => b.tag), ['P', 'TABLE', 'FORMULA', 'P']);
  assert.equal(blocks[1].text, '| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(blocks[2].text, 'E = mc^2');

  // 漏写 [/TABLE]：下一个 [P] 出现时必须截断，不能吞掉后半页
  const leaky = ['[TABLE]', '| a | b |', '[P] next paragraph'].join('\n');
  const blocks2 = parseVisionBlocks(leaky);
  assert.deepEqual(blocks2.map((b) => b.tag), ['TABLE', 'P']);
});

test('parseVisionBlocks：整页无标记时兜底成一个大段落', () => {
  const blocks = parseVisionBlocks('just plain text\nsecond line');
  assert.deepEqual(blocks, [{ tag: 'P', text: 'just plain text\nsecond line' }]);
  assert.deepEqual(parseVisionBlocks('   '), []);
});

// ==================== 视觉路径：翻译与组装 ====================

test('collectVisionSegments：TABLE/FORMULA/FIG 不送翻译，REF 按开关决定', () => {
  const pages = [{
    page: 3,
    blocks: [
      { tag: 'H1', text: 'Method' },
      { tag: 'P', text: 'text' },
      { tag: 'TABLE', text: '| a |' },
      { tag: 'FORMULA', text: 'E=mc^2' },
      { tag: 'FIG', text: 'a diagram' },
      { tag: 'REF', text: '[1] ref' },
      { tag: 'META', text: 'Journal of X' },
      { tag: 'SEC', text: 'Abstract' },
      { tag: 'CAP', text: 'Figure 1' },
    ],
  }];
  const ids = (opts) => collectVisionSegments(pages, opts).map((s) => s.id);
  // TABLE/FORMULA/FIG 不送翻译（图表会被丢弃，公式原样保留）；META/SEC/CAP 要翻
  assert.deepEqual(ids({}), ['v3:0', 'v3:1', 'v3:6', 'v3:7', 'v3:8'], '默认不翻参考文献');
  assert.deepEqual(ids({ translateReferences: true }), ['v3:0', 'v3:1', 'v3:5', 'v3:6', 'v3:7', 'v3:8']);
});

test('assembleVisionMarkdown：按目录层级组装，回填 / 回退 / 丢弃图表', () => {
  const pages = [
    {
      page: 1,
      blocks: [
        { tag: 'TITLE', text: 'Full Paper Title', t: '完整论文标题' },
        { tag: 'META', text: 'Journal of X, 2025. ISSN 1111-2222. DOI: 10.1/xyz' },
        { tag: 'SEC', text: 'Abstract' },
        { tag: 'P', text: 'Abstract body here.', t: '这里是摘要正文。' },
        { tag: 'H1', text: '1 Introduction', t: '1 引言' },
        { tag: 'P', text: 'Intro paragraph.', t: '引言段落。' },
        { tag: 'H2', text: '1.1 Background', t: '1.1 研究背景' },
        { tag: 'P', text: 'untranslated paragraph' },
        { tag: 'FORMULA', text: '$$y=x$$' },
        { tag: 'TABLE', text: '| a | b |\n|---|---|\n| 1 | 2 |' },
        { tag: 'FIG', text: 'framework diagram' },
        { tag: 'CAP', text: 'Figure 1: model' },
        { tag: 'H1', text: '2 Method', t: '2 研究方法' },
        { tag: 'P', text: 'Method body.', t: '方法正文。' },
      ],
    },
  ];
  const segments = collectVisionSegments(pages);
  // 只回填部分块；[P] untranslated paragraph 不给译文 → 组装时回退原文
  const map = new Map([
    ['v1:0', '完整论文标题'],
    ['v1:3', '这里是摘要正文。'],
    ['v1:4', '1 引言'],
    ['v1:5', '引言段落。'],
    ['v1:6', '1.1 研究背景'],
    ['v1:12', '2 研究方法'],
    ['v1:13', '方法正文。'],
  ]);
  applyVisionTranslations(pages, segments, map);

  const { markdown, stats } = assembleVisionMarkdown(pages, null);
  assert.ok(markdown.startsWith('# 完整论文标题'), '主标题为 H1');
  assert.ok(markdown.includes('## 文章信息'), '含文章信息小节');
  assert.ok(!markdown.includes('ISSN') && !markdown.includes('DOI'), '文章信息里的 ISSN/DOI 被清理');
  assert.ok(markdown.includes('## 摘要'), '含摘要小节');
  assert.ok(markdown.includes('## 1 引言'), '一级章节 → h2');
  assert.ok(markdown.includes('### 1.1 研究背景'), '二级小节 → h3');
  assert.ok(markdown.includes('## 2 研究方法'), '第二章 → h2');
  assert.ok(markdown.includes('untranslated paragraph'), '未译块回退原文');
  assert.ok(markdown.includes('$$\ny=x\n$$'), '公式用 $$ 包裹保留');
  assert.ok(!markdown.includes('| a | b |'), '表格按要求丢弃');
  assert.ok(!markdown.includes('framework diagram'), '插图按要求丢弃');
  assert.ok(!markdown.includes('Figure 1: model'), '图注按要求丢弃');
  assert.ok(!markdown.includes('crop:'), '不再插入裁剪图');
  assert.equal(stats.crops, 0);
  assert.ok(stats.dropped >= 3, '被丢弃的图表块应计数');
});

test('assembleVisionMarkdown：参考文献标题被标成 H1 时不重复出标题，序号不重复', () => {
  const pages = [{
    page: 1,
    blocks: [
      { tag: 'H1', text: '1 Introduction', t: '1 引言' },
      { tag: 'P', text: 'body', t: '正文。' },
      // 视觉模型可能把 References 当成普通一级标题（而不是 [SEC]）
      { tag: 'H1', text: 'References', t: '参考文献' },
      { tag: 'REF', text: '[1] Smith, J. (2023). Visual branding. JMR.' },
      { tag: 'REF', text: '[2] Doe, A. (2024). Consumer reviews. JM.' },
    ],
  }];
  const { markdown } = assembleVisionMarkdown(pages, null);
  assert.equal(markdown.split('## 参考文献').length - 1, 1, '参考文献标题只出现一次');
  assert.ok(markdown.includes('[1] Smith'), '保留原文序号');
  assert.ok(markdown.includes('[2] Doe'), '保留第二条原文序号');
  assert.ok(!markdown.includes('[1] [1]'), '不重复叠加序号');
  assert.ok(!markdown.includes('[2] [2]'), '不重复叠加序号（第二条）');
});

test('assembleVisionMarkdown：参考文献没有序号时自动补号', () => {
  const pages = [{
    page: 1,
    blocks: [
      { tag: 'SEC', text: 'References' },
      { tag: 'REF', text: 'Smith, J. (2023). Visual branding. JMR.' },
      { tag: 'REF', text: 'Doe, A. (2024). Consumer reviews. JM.' },
    ],
  }];
  const { markdown } = assembleVisionMarkdown(pages, null);
  assert.ok(markdown.includes('[1] Smith'), '无序号时补 [1]');
  assert.ok(markdown.includes('[2] Doe'), '无序号时补 [2]');
  assert.equal(markdown.split('## 参考文献').length - 1, 1, '参考文献标题只出现一次');
});

test('assembleVisionMarkdown：无编号章节按出现顺序补号', () => {
  const pages = [{
    page: 1,
    blocks: [
      { tag: 'H1', text: 'Introduction', t: '引言' },
      { tag: 'P', text: 'a.', t: 'a。' },
      { tag: 'H1', text: 'Conclusion', t: '结论' },
      { tag: 'P', text: 'b.', t: 'b。' },
    ],
  }];
  const { markdown } = assembleVisionMarkdown(pages, null);
  assert.ok(markdown.includes('## 1 引言'), '无编号首章补 1');
  assert.ok(markdown.includes('## 2 结论'), '无编号次章补 2');
});

test('visionPageFallbackMarkdown：缺图页用文本层兜底（含译文）', () => {
  // y1 递减 = 视觉上从上到下（buildElements 按 y 排序，顺序不能写反）
  const page = mkPage(0, [
    mkBlock({ id: 't', kind: 'title', size: 18, y1: 760, translation: '兜底大标题' }),
    mkBlock({ id: 'h', kind: 'heading', size: 13, y1: 700, translation: '兜底标题' }),
    mkBlock({ id: 'p', kind: 'body', y1: 650, translation: '兜底正文' }),
  ]);
  const { markdown } = visionPageFallbackMarkdown(page);
  assert.ok(markdown.startsWith('# 兜底大标题'));
  assert.ok(markdown.includes('## 1 兜底标题'), '兜底页同样按目录层级输出');
  assert.ok(markdown.includes('兜底正文'));
  assert.equal(visionPageFallbackMarkdown(null).markdown, '');
});

test('visionPaperPrompt：强调标题必须完整、图表必须跳过', () => {
  const p1 = visionPaperPrompt({});
  for (const tag of ['[TITLE]', '[H1]', '[H2]', '[P]', '[FORMULA]', '[SEC]', '[META]']) {
    assert.ok(p1.includes(tag), `缺少标记 ${tag}`);
  }
  // 标题完整性的硬要求（否则目录全是「1」「2」这种空壳标题）
  assert.ok(p1.includes('标题必须完整'), '提示词必须强调标题完整性');
  assert.ok(p1.includes('不能只写章节编号'), '提示词必须禁止只输出编号');
  // 图表必须跳过
  assert.ok(p1.includes('图表一律跳过') || p1.includes('图表'), '提示词必须说明跳过图表');
  assert.ok(/不要输出 \[FIG\]/.test(p1), '提示词应明确不要 FIG/TABLE');
  // 参考文献开关
  assert.ok(/跳过/.test(p1), '默认提示应说明跳过参考文献');
  const p2 = visionPaperPrompt({ translateReferences: true });
  assert.ok(p2.includes('完整转录'), '开启后要求转录参考文献');
});

test('visionPaperPrompt：视觉模型只负责识字，翻译交给翻译模型（职责边界）', () => {
  // 需求：视觉模型不能顺手出译文，否则 collectVisionSegments 收到的是中文，
  // isAlreadyTarget() 会判定「已是目标语言」整段跳过翻译，术语表与缓存全部失效。
  const p = visionPaperPrompt({});

  // 1) 「不要翻译」必须是铁律级别（而不是埋在转录要求里容易被忽略）
  assert.ok(/三条铁律/.test(p), '「不要翻译」应提到铁律级别');
  assert.ok(/绝对不要翻译/.test(p), '必须显式禁止翻译');
  assert.ok(/看图识字/.test(p), '应说明职责是识字而非翻译');

  // 2) 要有清晰的正误示例：英文照抄正确、翻译成中文错误
  assert.ok(/正确：\[P\] .*[A-Za-z]/.test(p), '应给出「原样照抄」的正确示例');
  assert.ok(/错误：\[P\] .*[\u4e00-\u9fff]/.test(p), '应给出「翻译了」的错误示例');

  // 3) 转录要求里也要保留「保持原文语言」
  assert.ok(/保持原文语言/.test(p), '转录要求应保留「保持原文语言」');

  // 4) 不能出现任何「用视觉模型翻译」的措辞
  assert.ok(!/视觉模型.{0,6}翻译成/.test(p), '不应要求视觉模型直接产出译文');
});

test('visionConcurrency：比旧的「并发/3、上限 4」更宽，且始终在安全区间内', () => {
  // 旧公式：Math.max(1, Math.min(4, Math.round(c / 3)))
  const oldFormula = (c) => Math.max(1, Math.min(4, Math.round(c / 3)));

  // 典型档位应明显更快（这就是用户抱怨「太慢」的那一段）
  assert.ok(visionConcurrency(8) > oldFormula(8), '默认并发下视觉路数应增加');
  assert.ok(visionConcurrency(16) > oldFormula(16), '高并发下视觉路数应增加');

  // 边界与下限：不能为 0、不能超过上限 6
  assert.equal(visionConcurrency(1), 2, '极小配置也有 2 路（不低于旧实现的 1）');
  assert.ok(visionConcurrency(0) >= 1, '非法输入不能返回 0');
  assert.ok(visionConcurrency(undefined) >= 1, '缺省输入必须有值');
  assert.ok(visionConcurrency(999) <= 6, '再大也不超过 6 路（避免打爆视觉供应商）');

  // 单调不减：翻译并发越大，视觉并发不该反而变小
  let prev = 0;
  for (const c of [1, 2, 4, 6, 8, 10, 12, 16]) {
    const v = visionConcurrency(c);
    assert.ok(v >= prev, `并发 ${c} 时视觉路数不应回落`);
    prev = v;
  }
});

test('流水线投递：逐页投递的翻译结果与一次性全量投递完全一致', async () => {
  // 这是「边识别边翻译」的正确性保证：两段并行只是时间轴重叠，
  // 汇进 map 的结果必须与「全识别完再翻译」一模一样。
  const pages = [
    { page: 1, blocks: [
      { tag: 'TITLE', text: 'Deep Learning for Vision' },
      { tag: 'H1', text: '1 Introduction' },
      { tag: 'P', text: 'Neural networks learn representations.' },
    ] },
    { page: 2, blocks: [
      { tag: 'P', text: 'We propose a novel architecture.' },
      { tag: 'REF', text: '[1] LeCun, Y. (1998).' },
      { tag: 'FORMULA', text: 'E = mc^2' },
    ] },
  ];
  const opts = { translateReferences: true };

  // 路径 A：一次性收集所有页
  const allAtOnce = collectVisionSegments(pages, opts);

  // 路径 B：逐页收集后拼接（模拟流水线一页一页投递）
  const perPage = [];
  for (const pg of pages) perPage.push(...collectVisionSegments([pg], opts));

  assert.deepStrictEqual(
    perPage.map((s) => s.id).sort(),
    allAtOnce.map((s) => s.id).sort(),
    '逐页投递与全量投递应产生完全相同的段 id 集合',
  );
  assert.deepStrictEqual(
    perPage.map((s) => `${s.id}|${s.text}`).sort(),
    allAtOnce.map((s) => `${s.id}|${s.text}`).sort(),
    '逐页投递与全量投递应产生完全相同的段内容',
  );

  // 回填到同一份页面数据后，两种路径结果必须一致（TITLE/H1/P 有译文，FORMULA 透传）
  const tMap = new Map(allAtOnce.map((s) => [s.id, `T-${s.id}`]));
  const a = JSON.parse(JSON.stringify(pages));
  const b = JSON.parse(JSON.stringify(pages));
  applyVisionTranslations(a, allAtOnce, tMap);
  applyVisionTranslations(b, perPage, tMap);
  assert.deepStrictEqual(a, b, '两种投递路径的回填结果必须一致');
  assert.equal(a[0].blocks[0].t, 'T-v1:0');
  assert.equal(a[1].blocks[2].t, undefined, 'FORMULA 不参与翻译，不应被回填');
});

