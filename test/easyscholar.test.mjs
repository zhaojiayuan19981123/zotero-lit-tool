// easyscholar.test.mjs —— 期刊等级筛选（formatRank）纯函数测试
//
// 覆盖点：
//   1) 七类等级（中科院分区 / 新锐分区 / ABS / UTD24 / SSCI / FMS / CSSCI）都能保留
//   2) 新增的 FMS、CSSCI 确实进入结果（本次需求）
//   3) 白名单外的等级（北大核心、CCF、影响因子等）一律丢弃
//   4) xrTop 优先于 xr，不会出现两个「新锐分区」
//   5) 空值跳过；全空时返回含七类的占位文案
//   6) 结构异常（data 缺失 / officialRank 缺失）不抛错
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRank } from '../src/easyscholar.js';

/** 按 easyScholar 真实返回形状造数据：formatRank 收的是 data 字段 */
function payload(all) {
  return { officialRank: { all } };
}

test('七类等级齐全时按固定顺序全部保留', () => {
  const f = formatRank(payload({
    sciUp: '经济学4区',
    xrTop: 'A+',
    ajg: '2',
    utd24: 'UTD24',
    ssci: 'Q3',
    fms: 'C',
    cssci: 'CSSCI',
  }));
  assert.deepEqual(f.items, [
    { label: '中科院分区', value: '经济学4区' },
    { label: '新锐分区', value: 'A+' },
    { label: 'ABS', value: '2' },
    { label: 'UTD24', value: 'UTD24' },
    { label: 'SSCI', value: 'Q3' },
    { label: 'FMS', value: 'C' },
    { label: 'CSSCI', value: 'CSSCI' },
  ]);
});

test('新增的 FMS 与 CSSCI 能单独进入结果', () => {
  const f = formatRank(payload({ fms: 'A', cssci: 'CSSCI扩展版' }));
  assert.deepEqual(f.items, [
    { label: 'FMS', value: 'A' },
    { label: 'CSSCI', value: 'CSSCI扩展版' },
  ]);
  assert.equal(f.summary, 'FMS A  ·  CSSCI CSSCI扩展版');
});

test('白名单外的等级被丢弃（北大核心 / CCF / 影响因子 / CSCD 等）', () => {
  const f = formatRank(payload({
    pku: '是', ccf: 'A', sciif: '3.21', sciif5: '4.02', cscd: '是', jci: '0.63',
    fms: 'B',
  }));
  assert.deepEqual(f.items, [{ label: 'FMS', value: 'B' }]);
});

test('xrTop 优先于 xr，不会出现两个「新锐分区」', () => {
  const f = formatRank(payload({ xr: 'A', xrTop: 'A+' }));
  const xr = f.items.filter((i) => i.label === '新锐分区');
  assert.equal(xr.length, 1);
  assert.equal(xr[0].value, 'A+');
});

test('只有 xr 时仍展示新锐分区', () => {
  const f = formatRank(payload({ xr: 'A' }));
  assert.deepEqual(f.items, [{ label: '新锐分区', value: 'A' }]);
});

test('空字符串与 null 被跳过', () => {
  const f = formatRank(payload({ sciUp: '', ssci: null, fms: 'B', cssci: undefined }));
  assert.deepEqual(f.items, [{ label: 'FMS', value: 'B' }]);
});

test('非字符串取值统一转成字符串（数值型等级不会丢）', () => {
  const f = formatRank(payload({ ajg: 2, utd24: 1 }));
  assert.deepEqual(f.items, [
    { label: 'ABS', value: '2' },
    { label: 'UTD24', value: '1' },
  ]);
});

test('summary 用 · 分隔各等级', () => {
  const f = formatRank(payload({ sciUp: '1区', fms: 'C' }));
  assert.equal(f.summary, '中科院分区 1区  ·  FMS C');
});

test('全无收录时返回含七类的占位文案（非空，避免被当成「未查询」重复请求）', () => {
  const f = formatRank(payload({ pku: '是', ccf: 'A' }));
  assert.equal(f.items.length, 0);
  assert.equal(f.summary, '未收录于中科院/新锐/ABS/UTD24/SSCI/FMS/CSSCI 分区');
});

test('data 为 undefined / officialRank 缺失时不抛错', () => {
  for (const bad of [undefined, null, {}, { officialRank: null }, { officialRank: {} }]) {
    const f = formatRank(bad);
    assert.equal(f.items.length, 0);
    assert.ok(f.summary.includes('未收录'), 'summary 应为占位文案');
  }
});
