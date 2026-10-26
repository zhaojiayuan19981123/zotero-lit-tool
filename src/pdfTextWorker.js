// pdfTextWorker.js —— PDF 文本抽取的 worker 线程入口
//
// 只做一件事：收到 {id, filePath} 就在这个线程里抽文本，把结果或错误发回去。
// 放在独立线程/独立模块里是为了拿到真正并行：Node 的主线程被 pdf.js 占住时，
// HTTP 接口（尤其是 /api/parse/progress）依然能正常响应。
import { parentPort } from 'node:worker_threads';
import { extractPdfTextInline } from './pdfTextCore.js';

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg.filePath !== 'string') return;
  try {
    const data = await extractPdfTextInline(msg.filePath);
    parentPort.postMessage({ id: msg.id, ok: true, data });
  } catch (e) {
    // 解析失败（加密、扫描件、文件损坏）是「业务结果」，不是线程故障：
    // 调用方据此决定「直接报错」还是「退回主线程再试一次」。
    parentPort.postMessage({ id: msg.id, ok: false, error: (e && e.message) || String(e) });
  }
});
