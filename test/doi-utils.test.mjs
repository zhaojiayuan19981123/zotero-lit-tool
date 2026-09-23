import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'public', 'doi-utils.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context, { filename: 'doi-utils.js' });
const D = context.window.DoiUtils;

const paper = (over = {}) => ({
  id: 'a1',
  title: 'Visual Atypicality and Brand Generated Images',
  authors: ['Zhang, San', 'Li, Si'],
  journal: 'Journal of Marketing',
  year: '2024',
  doi: '10.1000/abc.123',
  ...over,
});

// ---------- normalizeDoi ----------

test('normalizeDoi 剥掉 URL 与 doi: 前缀', () => {
  assert.equal(D.normalizeDoi('10.1000/xyz'), '10.1000/xyz');
  assert.equal(D.normalizeDoi('doi:10.1000/xyz'), '10.1000/xyz');
  assert.equal(D.normalizeDoi('DOI: 10.1000/xyz'), '10.1000/xyz');
  assert.equal(D.normalizeDoi('https://doi.org/10.1000/xyz'), '10.1000/xyz');
  assert.equal(D.normalizeDoi('http://dx.doi.org/10.1000/xyz'), '10.1000/xyz');
  assert.equal(D.normalizeDoi('https://doi.org/10.1000/xyz.'), '10.1000/xyz');
  assert.equal(D.normalizeDoi('  10.1000/xyz  '), '10.1000/xyz');
});

test('normalizeDoi 对空值/占位值返回空串而不是抛错', () => {
  for (const v of [null, undefined, '', '   ', 0, '0', '暂无', 'N/A', '-']) {
    assert.equal(D.normalizeDoi(v), '', `输入 ${JSON.stringify(v)} 应归一化为空`);
  }
});

test('normalizeDoi 只接受规范形态（挡掉占位值混入导出）', () => {
  assert.equal(D.normalizeDoi('10.1000/xyz'), '10.1000/xyz');
  assert.equal(D.normalizeDoi('10.1287/mnsc.2024.12345'), '10.1287/mnsc.2024.12345');
  assert.equal(D.normalizeDoi('not-a-doi'), '', '不是 10.xxxx/ 形态的不算 DOI');
  assert.equal(D.normalizeDoi('N/A'), '', 'N/A 虽然含斜杠但不是 DOI');
  assert.equal(D.normalizeDoi('10.1000'), '', '没有后缀也不算 DOI');
});

// ---------- buildDoiList ----------

test('buildDoiList 每行一个 DOI，并跳过没有 DOI 的条目', () => {
  const list = [
    paper({ doi: '10.1/a' }),
    paper({ id: 'a2', doi: '' }),
    paper({ id: 'a3', doi: 'https://doi.org/10.1/c' }),
  ];
  assert.equal(D.buildDoiList(list), '10.1/a\n10.1/c');
});

test('buildDoiList 全都没有 DOI 时返回空串（而不是空白行）', () => {
  assert.equal(D.buildDoiList([paper({ doi: null }), paper({ doi: '' })]), '');
  assert.equal(D.buildDoiList([paper({ doi: '暂无' })]), '', '占位值不应被当成 DOI');
  assert.equal(D.buildDoiList([]), '');
  assert.equal(D.buildDoiList(null), '');
});

// ---------- doiStats ----------

test('doiStats 正确统计有/缺失数量', () => {
  const list = [paper({ doi: '10.1/a' }), paper({ doi: '' }), paper({ doi: '10.1/c' })];
  // 跨 realm（vm 沙箱）对象用 deepStrictEqual 会因原型不同而失败，逐字段比
  const s = D.doiStats(list);
  assert.equal(s.total, 3);
  assert.equal(s.withDoi, 2);
  assert.equal(s.missing, 1);

  const empty = D.doiStats([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.withDoi, 0);
  assert.equal(empty.missing, 0);

  const nil = D.doiStats(null);
  assert.equal(nil.total, 0);
  assert.equal(nil.withDoi, 0);
  assert.equal(nil.missing, 0);
});

// ---------- RIS ----------

test('buildRis 生成合法 RIS 块（TY 开头、ER 结尾）', () => {
  const out = D.buildRis([paper()]);
  // 输出末尾有一个换行，split 后最后一项是空串，故取倒数第二行
  const lines = out.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
  assert.equal(lines[0], 'TY  - JOUR');
  assert.ok(out.includes('TI  - Visual Atypicality and Brand Generated Images'));
  assert.ok(out.includes('AU  - Zhang, San'));
  assert.ok(out.includes('AU  - Li, Si'));
  assert.ok(out.includes('JO  - Journal of Marketing'));
  assert.ok(out.includes('PY  - 2024'));
  assert.ok(out.includes('DO  - 10.1000/abc.123'));
  // 注意：RIS 的结束行是 'ER  - '（带尾空格），所以别对整段先 trim 再比
  assert.equal(lines[lines.length - 1], 'ER  - ');
});

test('buildRis 把正文里的换行折成空格，不破坏「一行一字段」', () => {
  const out = D.buildRis([paper({ title: '第一行\n第二行', abstract: 'a\n\nb' })]);
  assert.ok(out.includes('TI  - 第一行 第二行'), out);
  assert.ok(!/\nTI  - 第一行\n/.test(out));
});

test('buildRis 缺 DOI 的条目仍然导出（只是没有 DO 行）', () => {
  const out = D.buildRis([paper({ doi: '' })]);
  assert.ok(out.includes('TY  - JOUR'));
  assert.ok(!out.includes('DO  - '));
});

test('buildRis 多条之间用空行分隔', () => {
  const out = D.buildRis([paper({ doi: '10.1/a' }), paper({ id: 'b', title: 'Second', doi: '10.1/b' })]);
  assert.equal(out.split('ER  - ').length - 1, 2, '应有两条 ER');
  assert.ok(/\n\n/.test(out), '两条之间应有空行');
});

// ---------- BibTeX ----------

test('buildBibtex 生成 @article 且字段完整', () => {
  const out = D.buildBibtex([paper()]);
  assert.ok(out.startsWith('@article{'));
  assert.ok(out.includes('title = {Visual Atypicality and Brand Generated Images}'));
  assert.ok(out.includes('author = {Zhang, San and Li, Si}'));
  assert.ok(out.includes('journal = {Journal of Marketing}'));
  assert.ok(out.includes('year = {2024}'));
  assert.ok(out.includes('doi = {10.1000/abc.123}'));
  assert.ok(out.trim().endsWith('}'));
});

test('buildBibtex 的 cite key 含姓氏与年份，且重名会自动加后缀', () => {
  const out = D.buildBibtex([paper(), paper()]);
  const keys = [...out.matchAll(/@article\{([^,]+),/g)].map((m) => m[1]);
  assert.equal(keys.length, 2);
  assert.ok(keys[0].includes('zhang'), keys[0]);
  assert.ok(keys[0].includes('2024'), keys[0]);
  assert.notEqual(keys[0], keys[1], '重复条目必须去重，否则 .bib 不可用');
  assert.equal(keys[1], keys[0] + 'b');
});

test('buildBibtex 转义花括号，避免破坏 BibTeX 结构', () => {
  const out = D.buildBibtex([paper({ title: 'A {weird} title' })]);
  assert.ok(out.includes('title = {A \\{weird\\} title}'), out);
});

// ---------- buildExport ----------

test('buildExport 按格式返回对应后缀，未知格式回落 txt', () => {
  assert.equal(D.buildExport([paper()], 'ris').ext, 'ris');
  assert.equal(D.buildExport([paper()], 'bib').ext, 'bib');
  assert.equal(D.buildExport([paper()], 'txt').ext, 'txt');
  assert.equal(D.buildExport([paper()], 'nonsense').ext, 'txt');
  assert.equal(D.buildExport([paper()], undefined).ext, 'txt');
});

test('buildExport 的内容与直接调用对应 builder 一致', () => {
  const list = [paper()];
  assert.equal(D.buildExport(list, 'ris').content, D.buildRis(list));
  assert.equal(D.buildExport(list, 'bib').content, D.buildBibtex(list));
  assert.equal(D.buildExport(list, 'txt').content, D.buildDoiList(list));
});
