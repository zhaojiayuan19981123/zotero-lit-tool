// thesis-import-utils.test.mjs —— 学位论文「避免重复导入」判定规则的纯函数测试 + 前端接线
//
// 覆盖点：
//   1) 指纹（sha256）优先：两边都有指纹时只看指纹，换名字也认得出来
//   2) 老记录没有指纹 → 退回「体积 + 文件名」，但两个条件必须同时满足
//   3) 归一化：大小写、空格、下划线、连字符的差异不算「不同的文件」
//   4) 边界：两边都没指纹且体积为 0 / 缺文件名 → 不下结论（宁可漏判，不能误拦）
//   5) partitionDuplicates 正确分流，且同一记录只匹配一次
//   6) 前端接线：脚本先于 thesis.js 加载、导入流程真的用了这套规则；服务端有同一套兜底
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'public', 'thesis-import-utils.js'), 'utf8');
const context = { window: {}, crypto: webcrypto };
vm.runInNewContext(source, context, { filename: 'thesis-import-utils.js' });
const { isPdfName, normalizeName, sha256Hex, matchExisting, partitionDuplicates } = context.window.ThesisImportUtils;

test('isPdfName 只看扩展名，大小写不敏感', () => {
  assert.equal(isPdfName('论文.PDF'), true);
  assert.equal(isPdfName('a.pdf'), true);
  assert.equal(isPdfName('a.docx'), false);
  assert.equal(isPdfName(''), false);
  assert.equal(isPdfName(null), false);
});

test('normalizeName 抹掉大小写 / 空格 / 下划线 / 连字符，但保留扩展名', () => {
  assert.equal(normalizeName(' 短视频 研究.PDF '), '短视频研究.pdf');
  assert.equal(normalizeName('短视频_研究.PDF'), '短视频研究.pdf');
  assert.equal(normalizeName('短视频-研究.pdf'), '短视频研究.pdf');
  assert.equal(normalizeName('A B.pdf'), normalizeName('a_b.pdf'));
  assert.notEqual(normalizeName('a.pdf'), normalizeName('a.docx'), '不能把扩展名也抹掉');
});

test('sha256Hex 算出的就是标准 sha256（"abc" 的已知向量）', async () => {
  const data = new TextEncoder().encode('abc');
  assert.equal(
    await sha256Hex(data),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  // ArrayBuffer 与 TypedArray（带偏移）都要支持
  assert.equal(await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]).buffer), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const padded = new Uint8Array(10);
  padded.set(new TextEncoder().encode('abc'), 3);
  const view = new Uint8Array(padded.buffer, 3, 3);
  assert.equal(await sha256Hex(view), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256Hex 在不支持 WebCrypto / 数据不可用时返回空串（去重降级，不抛错）', async () => {
  const bare = { window: {} };
  vm.runInNewContext(source, bare, { filename: 'thesis-import-utils.js' });
  assert.equal(await bare.window.ThesisImportUtils.sha256Hex(new Uint8Array([1, 2, 3])), '');
  assert.equal(await sha256Hex(null), '');
  assert.equal(await sha256Hex('不是二进制'), '');
});

test('指纹优先：两边都有指纹时只看指纹，文件名不同也照样认出来', () => {
  const rec = { id: 'a', fileHash: 'HASH1', fileSize: 999, originalName: '原名.pdf' };
  assert.equal(matchExisting(rec, { hash: 'hash1', size: 1, name: '换了名字.pdf' }), 'hash', '指纹要大小写不敏感');
  assert.equal(matchExisting(rec, { hash: 'HASH2', size: 999, name: '原名.pdf' }), '', '指纹不同就是不重复，不管名字体积多像');
});

test('老记录没有指纹：退回「体积 + 文件名」，两个条件缺一不可', () => {
  const legacy = { id: 'a', fileHash: '', fileSize: 12345, originalName: '论文终稿.pdf' };
  assert.equal(matchExisting(legacy, { hash: '', size: 12345, name: '论文 终稿.PDF' }), 'name-size', '归一化后同名 + 同体积 → 判重复');
  assert.equal(matchExisting(legacy, { hash: '', size: 999, name: '论文终稿.pdf' }), '', '体积不同 → 不判重复');
  assert.equal(matchExisting(legacy, { hash: '', size: 12345, name: '另一篇.pdf' }), '', '文件名不同 → 不判重复');
});

test('库里那条有指纹、这次没算出来 → 不下结论（宁可漏判，不能误拦）', () => {
  const rec = { id: 'a', fileHash: 'HASH1', fileSize: 12345, originalName: '论文终稿.pdf' };
  assert.equal(matchExisting(rec, { hash: '', size: 12345, name: '论文终稿.pdf' }), '');
  assert.equal(matchExisting(rec, { hash: '', size: 0, name: '论文终稿.pdf' }), '');
});

test('缺体积或缺文件名时不下结论，空候选直接返回不重复', () => {
  assert.equal(matchExisting({ fileSize: 0, originalName: '' }, {}), '');
  assert.equal(matchExisting({}, { hash: '', size: 0, name: '' }), '');
  assert.equal(matchExisting(null, null), '');
});

test('partitionDuplicates 正确分流，命中的带上匹配原因与记录', () => {
  const existing = [
    { id: 'x', fileHash: 'AAA', fileSize: 10, originalName: '已导入.pdf' },
    { id: 'y', fileHash: '', fileSize: 20, originalName: '老记录.pdf' },
  ];
  const candidates = [
    { name: '已导入.pdf', size: 10, hash: 'aaa' },     // 指纹命中
    { name: '老 记录.PDF', size: 20, hash: '' },        // 老记录退回体积+文件名
    { name: '全新的.pdf', size: 30, hash: 'BBB' },      // 可以导入
  ];
  const { dupes, fresh } = partitionDuplicates(existing, candidates);
  // 注意：模块跑在 vm 沙箱里，返回的数组是「另一个 realm」的对象，deepEqual 连原型一起比会失败；
  // 用展开语法把它们搬回本 realm 再比。
  assert.deepEqual([...dupes].map((d) => [d.candidate.name, d.match.reason, d.match.record.id]), [
    ['已导入.pdf', 'hash', 'x'],
    ['老 记录.PDF', 'name-size', 'y'],
  ]);
  assert.deepEqual([...fresh].map((c) => c.name), ['全新的.pdf']);
});

test('partitionDuplicates 对空输入与空库都不抛错', () => {
  const empty = partitionDuplicates([], []);
  assert.equal(empty.dupes.length, 0);
  assert.equal(empty.fresh.length, 0);
  const nulls = partitionDuplicates(null, null);
  assert.equal(nulls.dupes.length, 0);
  assert.equal(nulls.fresh.length, 0);
  const one = partitionDuplicates([], [{ name: 'a.pdf', size: 1, hash: 'H' }]);
  assert.equal(one.fresh.length, 1);
  assert.equal(one.dupes.length, 0);
});

test('前端接线：脚本先于 thesis.js 加载，导入流程与服务端用的是同一套规则', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const thesis = fs.readFileSync(path.join(ROOT, 'public', 'thesis.js'), 'utf8');
  const routes = fs.readFileSync(path.join(ROOT, 'src', 'thesisRoutes.js'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src', 'thesisStore.js'), 'utf8');

  assert.ok(html.includes('<script src="thesis-import-utils.js"></script>'), 'index.html 应加载 thesis-import-utils.js');
  assert.ok(
    html.indexOf('thesis-import-utils.js') < html.indexOf('src="thesis.js"'),
    'thesis-import-utils.js 必须排在 thesis.js 之前，否则 IIFE 取不到规则',
  );

  // 导入流程真的用上了：算指纹 → 分流 → 服务端 allowDuplicate 只在用户选了「仍然导入」时才传
  assert.match(thesis, /importUtils\.sha256Hex\(/);
  assert.match(thesis, /importUtils\.partitionDuplicates\(S\.items, cands\)/);
  assert.match(thesis, /allowDuplicate: targets === cands/);
  assert.match(thesis, /await refresh\(\);\s*\n\s*const \{ dupes, fresh \}/);

  // 服务端兜底：POST /api/theses 用 findDuplicateThesis 拦一道（前端被绕过也收不进重复）
  assert.match(routes, /thesisStore\.findDuplicateThesis\(candidate\)/);
  assert.match(routes, /status\(409\)/);
  assert.match(routes, /await sha256File\(f\.path\)/, '指纹要由服务端从落盘文件算，不信前端传的值');
  assert.match(storeSrc, /export function findDuplicateThesis/);
  assert.match(storeSrc, /export function normalizeFileName/);
});
