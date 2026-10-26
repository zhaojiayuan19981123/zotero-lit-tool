// pdf-text-pool.test.mjs —— PDF 文本抽取走 worker 线程，且回退路径可用
//
// 为什么要有这组测试：解析进度能不能显示，取决于主线程有没有被 pdf.js 占住。
// 一旦有人把抽取改回主线程（或者把回退逻辑删掉），进度条就会在解析期间「卡住不动」，
// 而功能测试全都还会绿 —— 所以这里直接盯住「这条链路上线程池确实被用到了」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractPdfText } from '../src/pdfParser.js';
import { pdfTextPoolStatus, shutdownPdfTextPool } from '../src/pdfTextPool.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zlt-pdf-'));

/** 手搓一个最小可用 PDF（含 xref，pdf.js 才能正确解析文字层） */
function makePdf(lines) {
  const content = `BT /F1 12 Tf 20 260 Td 16 TL ${lines.map((l, i) => `${i ? 'T* ' : ''}(${l}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return out;
}

const PDF = path.join(TMP, 'sample.pdf');
fs.writeFileSync(PDF, makePdf([
  'Thread pool extraction works',
  'This page carries enough text to pass the',
  'scanned-pdf guard, which needs forty chars.',
]), 'latin1');

test.after(async () => {
  await shutdownPdfTextPool();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

test('线程池：抽文本走 worker，池子里确实有线程被用起来', async () => {
  const r = await extractPdfText(PDF);
  assert.equal(r.numPages, 1);
  assert.match(r.text, /Thread pool extraction works/);
  const st = pdfTextPoolStatus();
  assert.ok(st.max >= 1);
  // 走完一轮后至少留下一个空闲线程 —— 说明这次是线程池干的活，不是主线程兜底
  assert.ok(st.idle + st.busy >= 1, `应在线程池里完成，实际池状态 ${JSON.stringify(st)}`);
  assert.equal(st.disabled, false);
});

test('回退：强制主线程（PDF_TEXT_INPROCESS=1）也能抽出同样的结果', async () => {
  const prev = process.env.PDF_TEXT_INPROCESS;
  process.env.PDF_TEXT_INPROCESS = '1';
  try {
    const r = await extractPdfText(PDF);
    assert.match(r.text, /Thread pool extraction works/);
  } finally {
    if (prev === undefined) delete process.env.PDF_TEXT_INPROCESS; else process.env.PDF_TEXT_INPROCESS = prev;
  }
});

test('业务错误：非 PDF 直接报错，不在主线程重试一遍', async () => {
  const bad = path.join(TMP, 'not-a-pdf.pdf');
  fs.writeFileSync(bad, 'this is definitely not a pdf', 'utf8');
  await assert.rejects(() => extractPdfText(bad), /不是有效的 PDF/);
});

test('业务错误：空文件给出明确中文提示', async () => {
  const empty = path.join(TMP, 'empty.pdf');
  fs.writeFileSync(empty, '', 'utf8');
  await assert.rejects(() => extractPdfText(empty), /文件为空/);
});
