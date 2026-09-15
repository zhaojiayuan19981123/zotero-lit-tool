// pdfParser.js —— PDF 文本提取，负责校验文件、提取文本、归一化
import fs from 'node:fs';
import { extractText } from 'unpdf';

/**
 * 读取 PDF 文件并提取纯文本
 * @param {string} filePath 本地 PDF 路径
 * @returns {Promise<{text: string, numPages: number, info: object}>}
 * @throws {Error} 带中文提示的错误信息
 */
export async function extractPdfText(filePath) {
  const buf = fs.readFileSync(filePath);

  // 1. 文件非空校验
  if (!buf || buf.length === 0) {
    throw new Error('文件为空，无法解析');
  }

  // 2. 校验 PDF 魔数（%PDF）
  const header = buf.slice(0, 1024).toString('latin1');
  if (!header.includes('%PDF')) {
    throw new Error('不是有效的 PDF 文件（缺少 %PDF 文件头），请确认上传的是 PDF');
  }

  // 3. 提取文本（unpdf 基于现代 pdf.js，需传入 Uint8Array）
  let text, numPages = 0, meta = {};
  try {
    const result = await extractText(new Uint8Array(buf), { mergePages: true });
    text = Array.isArray(result.text) ? result.text.join('\n') : (result.text || '');
    numPages = result.totalPages || 0;
    try {
      meta = await extractMetadata(buf);
    } catch (_) { /* 元数据可选 */ }
  } catch (e) {
    const msg = e?.message || '未知错误';
    if (/password/i.test(msg)) {
      throw new Error('该 PDF 已加密，请先在阅读器中去除密码后再上传');
    }
    if (/invalid/i.test(msg) || /no pdf/i.test(msg) || /xref/i.test(msg)) {
      throw new Error('PDF 文件损坏或格式异常，无法解析，请重新导出 PDF 后重试');
    }
    throw new Error('PDF 解析失败：' + msg);
  }

  text = (text || '').trim();

  // 4. 扫描版 PDF 检测：文本过少，疑似纯图片扫描件
  if (text.length < 40) {
    throw new Error(
      '无法提取有效文本，该 PDF 可能是纯扫描图片版。请使用带 OCR 文字层的 PDF，或在阅读器中进行 OCR 后重试。'
    );
  }

  // 5. 文本归一化
  text = normalizeText(text);

  return {
    text,
    numPages,
    info: {
      title: meta.title || '',
      author: meta.author || '',
      creationDate: meta.creationDate || '',
    },
  };
}

// 提取 PDF 元信息（标题/作者/创建日期）
async function extractMetadata(buf) {
  const { getDocumentProxy } = await import('unpdf');
  try {
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const md = await doc.getMetadata();
    const info = md?.info || {};
    return {
      title: info.Title || '',
      author: info.Author || '',
      creationDate: info.CreationDate || '',
    };
  } catch (_) {
    return {};
  }
}

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n') // 统一换行
    .replace(/[ \t]+/g, ' ') // 合并空白
    .replace(/-\n(?=[a-z])/g, '') // 去掉行尾连字符断词
    .replace(/\n{3,}/g, '\n\n') // 限制连续空行
    .trim();
}
