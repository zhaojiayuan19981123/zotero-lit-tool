// pdfParser.js —— PDF 文本提取（对外入口）
//
// 真正的实现在 pdfTextCore.js（纯函数，不碰线程），这里负责「在哪个线程跑」：
//   ① 默认丢给 worker 线程池：pdf.js 抽取一篇长论文会长时间占满 CPU，
//      留在主线程会把 HTTP 请求（包括解析进度查询）全部堵住；
//   ② 线程池不可用（受限环境）或线程自身报错时，退回主线程同步抽取。
//      性能差一点，但功能不能因为优化而丢失。
//
// 注意：业务错误（加密、扫描件、文件损坏）会带 pdfParseError 标记，
// 这类错误不再回退重试 —— 同一份坏文件跑两遍只会让用户多等一次。
export { extractPdfTextOffThread, shutdownPdfTextPool, pdfTextPoolStatus } from './pdfTextPool.js';
import { extractPdfTextInline } from './pdfTextCore.js';
import { extractPdfTextOffThread } from './pdfTextPool.js';

/**
 * 读取 PDF 文件并提取纯文本（自动选择线程）
 * @param {string} filePath 本地 PDF 路径
 * @returns {Promise<{text: string, numPages: number, info: object}>}
 * @throws {Error} 带中文提示的错误信息
 */
export async function extractPdfText(filePath) {
  try {
    return await extractPdfTextOffThread(filePath);
  } catch (e) {
    if (e && e.pdfParseError) throw e;
    // 线程池层面的问题（起不来 / 进程异常退出）：退回主线程再试一次
    return extractPdfTextInline(filePath);
  }
}
