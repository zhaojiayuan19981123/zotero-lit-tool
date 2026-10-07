// zip.test.mjs —— 自带 ZIP 打包（store 方式）的单测
//
// 「导出成果（含附件）」靠的就是它，所以不能只测「函数没抛错」：
// 要把打包出来的字节**按 ZIP 规范解回来**，逐条核对文件名、CRC、大小与内容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { createZip, crc32, sanitizeZipName, uniqueName } from '../src/zip.js';

/** 极简 ZIP 读取器：只认 store（不压缩）条目，用来独立校验我们写出的字节 */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, '找不到 EOCD 结尾记录');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(cdOffset + cdSize, eocd, '中央目录应当紧邻结尾记录');

  const entries = [];
  for (let i = 0; i < total; i += 1) {
    assert.equal(buf.readUInt32LE(cdOffset), 0x02014b50, '中央目录签名不对');
    const flags = buf.readUInt16LE(cdOffset + 8);
    const method = buf.readUInt16LE(cdOffset + 10);
    const crc = buf.readUInt32LE(cdOffset + 16);
    const csize = buf.readUInt32LE(cdOffset + 20);
    const usize = buf.readUInt32LE(cdOffset + 24);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.slice(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8');

    // 本地头
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, '本地头签名不对');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + csize);
    assert.equal(crc32(data), crc, `${name} 的 CRC 对不上`);
    assert.equal(usize, csize, 'store 方式下两个大小应相等');
    assert.equal(method, 0, '必须是 store（不压缩）');
    assert.equal(flags & 0x0800, 0x0800, '通用标志位要标记 UTF-8 文件名');

    entries.push({ name, data: data.toString('utf8'), crc });
    cdOffset += 46 + nameLen;
  }
  return entries;
}

test('打包 → 解包：文件名、内容、CRC 全部对得上', () => {
  const zip = createZip([
    { name: '成果清单.csv', data: Buffer.from('名称,年份\n论文A,2024', 'utf8') },
    { name: '论文_平台生态/meta.json', data: Buffer.from(JSON.stringify({ title: '平台生态' }), 'utf8') },
    { name: '论文_平台生态/正文_终稿.pdf', data: Buffer.from('%PDF-1.7 fake', 'utf8') },
  ]);
  const out = readZip(zip);
  assert.deepEqual(out.map((e) => e.name), [
    '成果清单.csv', '论文_平台生态/meta.json', '论文_平台生态/正文_终稿.pdf',
  ]);
  assert.equal(out[0].data, '名称,年份\n论文A,2024');
  assert.equal(JSON.parse(out[1].data).title, '平台生态');
  assert.equal(out[2].data, '%PDF-1.7 fake');
});

test('空内容与二进制内容都能打包，且 CRC 与标准实现一致', () => {
  const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80]);
  const zip = createZip([
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'bin.dat', data: bin },
  ]);
  const out = readZip(zip);
  assert.equal(out[0].data, '');
  assert.equal(out[0].crc, crc32(Buffer.alloc(0)));
  assert.equal(out[1].crc, crc32(bin));

  // 和我们自写的查表法对齐一个已知值（"123456789" 的标准 CRC32 = 0xCBF43926）
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  // 与 zlib 的实现对齐，防止查表法写错却「自洽」（自己写自己读，永远对得上）。
  // zlib.crc32 要 Node 22.2+，低版本上就跳过这一条。
  if (typeof zlib.crc32 === 'function') {
    assert.equal(crc32(Buffer.from('hello 世界', 'utf8')), zlib.crc32(Buffer.from('hello 世界', 'utf8')));
  }
});

test('文件名安全：剥掉绝对路径与 ..，非法字符替换掉', () => {
  assert.equal(sanitizeZipName('/etc/passwd'), 'etc/passwd');
  assert.equal(sanitizeZipName('../../逃逸.pdf'), '逃逸.pdf');
  assert.equal(sanitizeZipName('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(sanitizeZipName('a:b*c?.txt'), 'a_b_c_.txt');
  assert.equal(sanitizeZipName(''), 'file');
  assert.equal(sanitizeZipName('   '), 'file');
});

test('同名附件自动加序号，不会出现两条同名条目', () => {
  const used = new Set();
  assert.equal(uniqueName('正文_论文.pdf', used), '正文_论文.pdf');
  assert.equal(uniqueName('正文_论文.pdf', used), '正文_论文(2).pdf');
  assert.equal(uniqueName('正文_论文.pdf', used), '正文_论文(3).pdf');
  const again = new Set();
  assert.equal(uniqueName('没有扩展名', again), '没有扩展名');
  assert.equal(uniqueName('没有扩展名', again), '没有扩展名(2)');
});

test('目录名不受文件名去重影响（导出多条成果时各占一个文件夹）', () => {
  const used = new Set();
  assert.equal(uniqueName('论文_同名的论文', used), '论文_同名的论文');
  assert.equal(uniqueName('论文_同名的论文', used), '论文_同名的论文(2)');
  const zip = createZip([{ name: 'x/y.txt', data: 'z' }]);
  assert.equal(readZip(zip)[0].name, 'x/y.txt');
});
