// zip.js —— 极简 ZIP 打包（store 方式，不压缩）
//
// 为什么要自己写：
//   「导出成果（含附件）」需要把若干个附件打成一个 zip 交给用户。
//   项目里没有 archiver / jszip 之类的依赖，而为了这一个功能去加一个新依赖，
//   会牵动 package-lock、安装包体积与 CI 构建时间 —— 不划算。
//   ZIP 的 store（不压缩）格式本身非常简单：本地头 + 数据 + 中央目录 + 结尾记录，
//   自己写 80 行就够，而且不压缩反而让「导出」变快（论文 PDF 本来就是压缩过的）。
//
// 兼容性：使用 UTF-8 文件名（通用标志位 0x0800），Windows 资源管理器 / macOS 归档工具 /
//   7-Zip / bsdtar 都能正常解出中文名。

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** JS Date → DOS 时间/日期（ZIP 头里用的老格式；1980 年之前会被夹到 1980-01-01） */
function dosDateTime(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * 把若干条目打成一个 zip 缓冲区。
 * @param {Array<{name: string, data: Buffer|Uint8Array|string, date?: Date}>} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.name)
    .map((e) => ({
      name: sanitizeZipName(e.name),
      data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8'),
      date: e.date || new Date(),
    }));

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of list) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    local.writeUInt16LE(20, 4);           // 解压所需版本
    local.writeUInt16LE(0x0800, 6);       // 通用标志位：文件名是 UTF-8
    local.writeUInt16LE(0, 8);            // 压缩方式：0 = 不压缩
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // 压缩后大小
    local.writeUInt32LE(entry.data.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);                 // 扩展字段长度
    locals.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);  // 中央目录签名
    central.writeUInt16LE(20, 4);          // 制作版本
    central.writeUInt16LE(20, 6);          // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);          // 压缩方式
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // 扩展字段
    central.writeUInt16LE(0, 32);          // 注释
    central.writeUInt16LE(0, 34);          // 起始磁盘号
    central.writeUInt16LE(0, 36);          // 内部属性
    central.writeUInt32LE(0, 38);          // 外部属性
    central.writeUInt32LE(offset, 42);     // 本地头偏移
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + entry.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);        // 结尾记录签名
  end.writeUInt16LE(0, 4);                 // 当前磁盘号
  end.writeUInt16LE(0, 6);                 // 中央目录起始磁盘号
  end.writeUInt16LE(list.length, 8);       // 本磁盘条目数
  end.writeUInt16LE(list.length, 10);      // 总条目数
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);           // 中央目录偏移
  end.writeUInt16LE(0, 20);                // 注释长度

  return Buffer.concat([...locals, centralBuf, end]);
}

/** ZIP 里不允许出现绝对路径与 ..，否则解压时可能写到目标目录外面去 */
export function sanitizeZipName(name) {
  const cleaned = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .trim();
  return cleaned || 'file';
}

/** 同名文件自动加 (2) (3)…，避免 zip 里两条同名条目 */
export function uniqueName(name, used) {
  const taken = used instanceof Set ? used : new Set();
  const raw = sanitizeZipName(name);
  if (!taken.has(raw)) { taken.add(raw); return raw; }
  const dot = raw.lastIndexOf('.');
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot) : '';
  let i = 2;
  while (taken.has(`${stem}(${i})${ext}`)) i += 1;
  const out = `${stem}(${i})${ext}`;
  taken.add(out);
  return out;
}
