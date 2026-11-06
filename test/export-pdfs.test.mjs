// export-pdfs.test.mjs —— 「选中文献 → 导出 PDF」的 HTTP 级验收
//
// 用户场景：勾选几篇文献，把原文一次性下载下来发给别人。
// 一篇要直接给 PDF（浏览器另存为最自然），多篇要打成一个 zip（浏览器会拦截连环下载），
// 没有附件的记录要跳过而不是让整次导出失败。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

/** 极简 ZIP 读取（本项目导出用的是 store 方式，条目未压缩） */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, '导出结果不是 zip（找不到 EOCD）');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const flags = buf.readUInt16LE(off + 8);
    const nameLen = buf.readUInt16LE(off + 28);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const size = buf.readUInt32LE(local + 22);
    const data = buf.slice(local + 30 + lNameLen + lExtra, local + 30 + lNameLen + lExtra + size);
    out.push({ name, utf8: (flags & 0x800) !== 0, data });
    off += 46 + nameLen;
  }
  return out;
}

const PDF_BODY = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'zlt-export-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  await mkdir(dataDir, { recursive: true });
  await mkdir(uploadDir, { recursive: true });

  const files = {};
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
    files[name] = path.join(uploadDir, name);
    await writeFile(files[name], Buffer.concat([PDF_BODY, Buffer.from(name)]));
  }
  await writeFile(path.join(uploadDir, 'note.txt'), 'not a pdf');

  store.configure({ dataDir });
  const { app } = createApp({ uploadDir });
  const server = createServer(app);
  const base = await listen(server);
  t.after(async () => {
    await close(server);
    await rm(root, { recursive: true, force: true });
  });

  const add = (title, extra = {}) => {
    const item = { id: store.newId(), title, docType: 'empirical', status: 'done', ...extra };
    store.upsertLiterature(item);
    return item.id;
  };

  return { base, uploadDir, files, add };
}

function post(base, body) {
  return fetch(`${base}/api/literature/export-pdfs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('多篇 → 一个 zip，条目名用标题、内容就是原 PDF', async (t) => {
  const { base, files, add } = await setup(t);
  const id1 = add('第一篇 论文', { filePath: files['a.pdf'], filename: 'a.pdf', fileKind: 'pdf' });
  const id2 = add('Second Paper', { filePath: files['b.pdf'], filename: 'b.pdf', fileKind: 'pdf' });

  const res = await post(base, { ids: [id1, id2] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/zip/);
  assert.equal(res.headers.get('x-exported-count'), '2');

  const disp = res.headers.get('content-disposition') || '';
  assert.match(disp, /\.zip/);
  assert.ok(disp.includes(encodeURIComponent('文献原文-')), '下载名应是「文献原文-日期.zip」');

  const entries = readZip(Buffer.from(await res.arrayBuffer()));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.name), ['第一篇 论文.pdf', 'Second Paper.pdf']);
  assert.ok(entries.every((e) => e.utf8), '中文名要带 UTF-8 标志位，否则 Windows 解压会乱码');
  assert.ok(entries.every((e) => e.data.subarray(0, 4).toString() === '%PDF'), '条目内容必须是原 PDF 字节');
});

test('单篇 → 直接给 PDF（不是套一层 zip）', async (t) => {
  const { base, files, add } = await setup(t);
  const id = add('Only One', { filePath: files['a.pdf'], filename: 'a.pdf', fileKind: 'pdf' });

  const res = await post(base, { ids: [id] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/pdf/);
  const disp = res.headers.get('content-disposition') || '';
  assert.ok(disp.includes(encodeURIComponent('Only One.pdf')), `文件名应取标题：${disp}`);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.subarray(0, 4).toString(), '%PDF');
  assert.ok(body.subarray(4).toString().includes('a.pdf'), '内容应是那份附件本身');
});

test('同名标题自动去重（第二篇加 (2)），不会在 zip 里互相覆盖', async (t) => {
  const { base, files, add } = await setup(t);
  const same = '重复标题';
  const id1 = add(same, { filePath: files['a.pdf'], filename: 'a.pdf', fileKind: 'pdf' });
  const id2 = add(same, { filePath: files['b.pdf'], filename: 'b.pdf', fileKind: 'pdf' });

  const entries = readZip(Buffer.from(await (await post(base, { ids: [id1, id2] })).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['重复标题.pdf', '重复标题(2).pdf']);
});

test('缺附件 / 非 PDF / 已不存在的记录被跳过，其余照常导出', async (t) => {
  const { base, files, add } = await setup(t);
  const good = add('有附件', { filePath: files['a.pdf'], filename: 'a.pdf', fileKind: 'pdf' });
  const good2 = add('有附件二', { filePath: files['b.pdf'], filename: 'b.pdf', fileKind: 'pdf' });
  const noFile = add('没有附件');
  const gone = add('文件已删除', { filePath: path.join(path.dirname(files['a.pdf']), 'missing.pdf'), filename: 'missing.pdf', fileKind: 'pdf' });
  const txt = add('附件是 txt', { filePath: path.join(path.dirname(files['a.pdf']), 'note.txt'), filename: 'note.txt', fileKind: 'txt' });

  const res = await post(base, { ids: [good, good2, noFile, gone, txt, 'not-a-real-id'] });
  assert.equal(res.status, 200, '只要还有能导的，就不该整单失败');
  assert.equal(res.headers.get('x-exported-count'), '2');
  assert.equal(res.headers.get('x-skipped-count'), '3');
  assert.deepEqual(readZip(Buffer.from(await res.arrayBuffer())).map((e) => e.name), ['有附件.pdf', '有附件二.pdf']);
});

test('一篇都没有附件 / 没选任何文献时给出明确错误', async (t) => {
  const { base, add } = await setup(t);
  const empty = add('空记录');
  const r1 = await post(base, { ids: [empty] });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error, /PDF/);

  const r2 = await post(base, { ids: [] });
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).error, /没有选中/);
});
