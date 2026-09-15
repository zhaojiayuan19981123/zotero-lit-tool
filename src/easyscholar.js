// easyscholar.js —— easyScholar 期刊等级查询（免登录开放接口）
// 文档：https://www.easyscholar.cc/open/getPublicationRank
// 注意：每秒最多 2 次请求，需限速；publicationName 需 encodeURIComponent

// 附录1：官方数据集缩写 → 中文名（完整映射，供参考）
const RANK_LABELS = {
  swufe: '西南财经大学', cufe: '中央财经大学', uibe: '对外经济贸易大学',
  sdufe: '山东财经大学', xdu: '西安电子科技大学', swjtu: '西南交通大学',
  ruc: '中国人民大学', xmu: '厦门大学', sjtu: '上海交通大学', fdu: '复旦大学',
  hhu: '河海大学', pku: '北大核心', scu: '四川大学', cqu: '重庆大学',
  nju: '南京大学', xju: '新疆大学', cug: '中国地质大学', ccf: '中国计算机学会',
  cju: '长江大学', zju: '浙江大学', zhongguokejihexin: '中国科技核心期刊',
  fms: 'FMS', utd24: 'UTD24', eii: 'EI检索', cssci: '南大核心',
  sciUpSmall: '中科院升级版小类', sciUpTop: '中科院升级版Top', cpu: '中国药科大学',
  xr: '新锐学术', xrWarn: '新锐学术预警', xrTop: '新锐学术Top', xrSmall: '新锐学术小类',
  sciif: 'SCI影响因子', sci: 'SCI分区', ssci: 'SSCI分区', jci: 'JCI指数',
  sciif5: 'SCI五年影响因子', sciwarn: '中科院预警', sciBase: 'SCI基础版',
  sciUp: 'SCI升级版', ajg: 'ABS期刊指南', ft50: 'FT50', cscd: '中国科学引文数据库',
  ahci: 'A&HCI', esi: 'ESI学科分类',
};

// 只保留这 4 类期刊等级（用户要求）
// sciUp→中科院分区, xrTop/xr→新锐分区, ajg→ABS分区, ssci→SSCI分区
const KEEP_RANKS = [
  { key: 'sciUp', label: '中科院分区' },
  { key: 'xrTop', label: '新锐分区' },
  { key: 'xr', label: '新锐分区' },
  { key: 'ajg', label: 'ABS' },
  { key: 'ssci', label: 'SSCI' },
];

const RANK_LEVEL_KEYS = ['', 'oneRankText', 'twoRankText', 'threeRankText', 'fourRankText', 'fiveRankText'];

// ---------- 限速器（全局，每秒最多 2 次 → 550ms 间隔） ----------
let lastRequestAt = 0;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 查询期刊等级
 * @param {string} publicationName 期刊名称
 * @param {string} secretKey easyScholar SecretKey
 * @returns {Promise<object>} 原始返回的 JSON
 */
export async function queryPublicationRank(publicationName, secretKey) {
  const url = 'https://www.easyscholar.cc/open/getPublicationRank'
    + '?secretKey=' + encodeURIComponent(secretKey)
    + '&publicationName=' + encodeURIComponent(publicationName);

  const now = Date.now();
  const wait = Math.max(0, lastRequestAt + 550 - now);
  lastRequestAt = now + wait;
  if (wait > 0) await sleep(wait);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'SciTerminal/1.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('easyScholar 请求失败 HTTP ' + res.status);
  return res.json();
}

/**
 * 把 easyScholar 返回结果格式化为易读的结构（仅保留 4 类等级）
 * @param {object} data 返回的 data 字段
 * @returns {{summary: string, items: Array<{label:string, value:string}>}}
 */
export function formatRank(data) {
  const items = [];
  const all = data?.officialRank?.all || {};

  for (const { key, label } of KEEP_RANKS) {
    if (items.some((i) => i.label === label)) continue; // xrTop 优先于 xr，避免重复
    const val = all[key];
    if (val == null || val === '') continue;
    items.push({ label, value: String(val) });
  }

  return {
    summary: items.map((i) => `${i.label} ${i.value}`).join('  ·  '),
    items,
  };
}
