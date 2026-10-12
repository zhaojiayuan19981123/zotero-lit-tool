/* thesis-import-utils.js —— 学位论文「避免重复导入」的纯逻辑（无 DOM，便于单测）
 *
 * 为什么单独一个文件：判定规则要在导入前跑一遍（前端先拦一道，避免白传几十 MB），
 * 服务端 POST /api/theses 也要用同一套规则兜底。规则本身很小但很容易写错，
 * 抽成纯函数后可以直接用单测把边界钉死。
 *
 * 判据（与 src/thesisStore.js 的 findDuplicateThesis 保持一致）：
 *   1) 内容指纹（sha256）一致 —— 最可靠。两边都有指纹时**只看指纹**，不再比体积/文件名。
 *   2) 老记录还没有指纹（本版本之前导入的）—— 退回「体积相同 + 文件名归一化后相同」。
 *      两个条件同时满足几乎只可能是同一个文件；只满足其一会误伤，所以两条都要。
 *   3) 带指纹的记录不参与第 2 条兜底 —— 否则「同一份 PDF 改个名字重导」会因为库里
 *      找不到同名旧记录而放行，反而漏判。
 *
 * 对外接口（挂在 window.ThesisImportUtils）：
 *   isPdfName(name)                     —— 是不是 PDF（按扩展名，大小写不敏感）
 *   normalizeName(name)                 —— 文件名归一化（大小写 / 空格 / 下划线 / 连字符）
 *   sha256Hex(data)                     —— 内容指纹（十六进制）；环境不支持时返回 ''
 *   matchExisting(record, candidate)    —— 单条比中返回 'hash' | 'name-size'，没中返回 ''
 *   partitionDuplicates(existing, list) —— 把待导入文件分成 { dupes, fresh }
 */
(() => {
  'use strict';

  /** 是不是 PDF 文件（只看扩展名，用户改过后缀也认） */
  function isPdfName(name) {
    return /\.pdf$/i.test(String(name == null ? '' : name).trim());
  }

  /**
   * 文件名归一化：判断「是不是同一个文件」时，大小写、空格、下划线、连字符的差异都不该算数。
   * 只做字符级归一，不去扩展名 —— 「a.pdf」与「a.docx」不是同一个东西。
   */
  function normalizeName(name) {
    return String(name == null ? '' : name)
      .trim()
      .toLowerCase()
      .replace(/[\s_\-]+/g, '');
  }

  /**
   * 算内容指纹（sha256 十六进制）。
   * 环境没有 WebCrypto（极少见，例如非安全上下文）或数据不可用时返回空串，
   * 调用方会退回「体积 + 文件名」判据 —— 去重弱一点，但绝不能因此让导入失败。
   * @param {ArrayBuffer|ArrayBufferView} data
   * @returns {Promise<string>}
   */
  async function sha256Hex(data) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle || !data) return '';
    let buf = null;
    // 注意：这里刻意不用 `data instanceof ArrayBuffer` —— 跨 realm（iframe / 沙箱 / 单测的 vm）
    // 传进来的 ArrayBuffer 不认本 realm 的构造函数，会被误判成「不是二进制」而静默降级。
    // 改用 `Object.prototype.toString` 的品牌标签判定，跨 realm 也认。
    if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') buf = data;
    else if (ArrayBuffer.isView(data)) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (!buf) return '';
    try {
      const digest = await subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return '';
    }
  }

  /**
   * 单条比较：candidate 是不是「已经躺在 record 里」的那个文件。
   * @param {object} record 库中已有记录（{ fileHash, fileSize, originalName }）
   * @param {{hash?:string, fileHash?:string, size?:number, fileSize?:number, name?:string, originalName?:string}} candidate
   * @returns {''|'hash'|'name-size'} 命中原因；'' 表示不是同一个文件
   */
  function matchExisting(record, candidate) {
    const rec = record || {};
    const hash = String(candidate?.hash ?? candidate?.fileHash ?? '').trim().toLowerCase();
    const size = Math.max(0, Number(candidate?.size ?? candidate?.fileSize) || 0);
    const name = normalizeName(candidate?.name ?? candidate?.originalName);
    if (!hash && !(size > 0 && name)) return '';

    const recHash = String(rec.fileHash || '').trim().toLowerCase();
    if (hash && recHash) return hash === recHash ? 'hash' : '';
    if (recHash) return '';   // 库里这条有指纹、这次没算出来 → 不下结论，交给别的记录比
    const recSize = Math.max(0, Number(rec.fileSize) || 0);
    if (size > 0 && recSize === size && name && normalizeName(rec.originalName) === name) return 'name-size';
    return '';
  }

  /**
   * 把一批待导入文件分成「已在库中」与「可以导入」两类。
   * @param {Array<object>} existing 库中已有记录
   * @param {Array<object>} candidates 待导入文件（{name, size, hash}）
   * @returns {{dupes: Array<{candidate:object, match:{record:object, reason:string}}>, fresh: Array<object>}}
   */
  function partitionDuplicates(existing, candidates) {
    const dupes = [];
    const fresh = [];
    for (const candidate of candidates || []) {
      const records = existing || [];
      let matched = null;
      for (const rec of records) {
        const reason = matchExisting(rec, candidate);
        if (reason) { matched = { record: rec, reason }; break; }
      }
      if (matched) dupes.push({ candidate, match: matched });
      else fresh.push(candidate);
    }
    return { dupes, fresh };
  }

  window.ThesisImportUtils = Object.freeze({
    isPdfName, normalizeName, sha256Hex, matchExisting, partitionDuplicates,
  });
})();
