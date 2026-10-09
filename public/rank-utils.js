/* rank-utils.js —— 期刊等级标签的配色（纯逻辑，无 DOM 依赖，便于单测）
 *
 * 配色口径：
 *   正红 red    ：最高档 —— 中科院/新锐 的 Top、ABS 4*、FMS T1、CSSCI、UTD24
 *   淡红 pink   ：次高档 —— SSCI Q1 / 中科院·新锐 1 区
 *   黄   yellow ：SSCI Q2 / 中科院·新锐 2 区 / ABS 4 / FMS T2
 *   蓝   blue   ：SSCI Q3 / 中科院·新锐 3 区 / ABS 3 / FMS T3
 *   绿   green  ：SSCI Q4 / 中科院·新锐 4 区 / ABS 2
 *   灰   gray   ：其余（ABS 1、否定取值、认不出的写法、空值兜底）
 *
 * 为什么要做「先解析档位、再按体系上色」：
 * easyScholar 的 officialRank.all 各家写法并不统一，同一个概念有数字区、
 * 字母档、Q 分位三种写法。若按字符串硬匹配，数据源一改写法配色就全丢。
 *
 *   sciUp        "经济学4区" / "1区" / "1区Top"
 *   xr | xrTop   "A+" / "A" / "1区" / "Top"
 *   ssci         "Q1" … "Q4"
 *   ajg(ABS)     "4*"、"4"、"3"、"2"、"1"（偶尔给星号或字母写法）
 *   fms          "T1"、"T2"、"T3"（部分数据集给字母写法）
 *   cssci        "CSSCI" / "CSSCI扩展版"
 *   utd24        "UTD24" / "是" / "否"
 */
(() => {
  'use strict';

  /** 允许的色档（白名单，避免拼进 class 名时被注入） */
  const TONES = Object.freeze(['red', 'pink', 'yellow', 'blue', 'green', 'gray']);

  /** 1~4 档的通用配色：SSCI Q1-4、中科院/新锐 1-4 区 */
  const TIER_TONES = Object.freeze(['pink', 'yellow', 'blue', 'green']);

  /** 字母档 → 档位序号（A+/A 并列第一档） */
  const LETTER_TIERS = new Map([['A+', 1], ['A', 1], ['B', 2], ['C', 3], ['D', 4], ['E', 5]]);

  /** 各体系专属的「取值 → 色档」表（写法与通用档位不一致的才写在这里） */
  const ABS_TONES = Object.freeze({
    '4*': 'red', 4: 'yellow', 3: 'blue', 2: 'green', 1: 'gray',
    'A*': 'red', A: 'yellow', B: 'blue', C: 'green',
  });
  const FMS_TONES = Object.freeze({
    T1: 'red', T2: 'yellow', T3: 'blue', T4: 'green',
    A: 'red', B: 'yellow', C: 'blue', D: 'green',
  });

  /** 否定/空值写法：这些取值代表「不在该列表里」，一律灰 */
  const NEGATIVE = /^(否|无|不是|no|false|-|—|–|\/|n\/a|na)$/i;

  /**
   * 把取值解析成 1 起的档位序号；认不出返回 0。
   * 支持 Q1-Q5、1区-5区、T1-T5、A+/A/B/C/D/E。
   * @param {string} value 等级取值，如 "Q1" / "经济学4区" / "A+"
   * @returns {number} 档位序号（0 = 无法解析）
   */
  function tierOf(value) {
    const v = String(value == null ? '' : value).trim().toUpperCase();
    if (!v) return 0;
    let m = v.match(/Q\s*([1-5])/);            // Q1 / Q 1
    if (m) return Number(m[1]);
    m = v.match(/([1-5])\s*区/);               // 1区 / 经济学4区
    if (m) return Number(m[1]);
    m = v.match(/^T\s*([1-5])$/);              // T1（FMS）
    if (m) return Number(m[1]);
    if (LETTER_TIERS.has(v)) return LETTER_TIERS.get(v);  // A+ / A / B …
    return 0;
  }

  /**
   * 给一条期刊等级算色档。
   * @param {string} label 体系名（中科院分区 / 新锐分区 / ABS / UTD24 / SSCI / FMS / CSSCI）
   * @param {string} value 该体系的取值
   * @returns {string} 色档：red | pink | yellow | blue | green | gray
   */
  function rankSystemTone(label, value) {
    const lab = String(label == null ? '' : label).trim();
    const raw = String(value == null ? '' : value).trim();
    if (!raw || NEGATIVE.test(raw)) return 'gray';

    // 任何体系：取值里出现 Top 一律按最高档（中科院 "1区Top"、新锐 "Top"）
    if (/top/i.test(raw)) return 'red';

    switch (lab) {
      case 'CSSCI':
        // 扩展版是 CSSCI 体系里的次一档，用淡红区分，主库用正红
        return /扩展/.test(raw) ? 'pink' : 'red';
      case 'UTD24':
        return 'red';
      case 'ABS':
        return ABS_TONES[raw.toUpperCase()] || 'gray';
      case 'FMS':
        return FMS_TONES[raw.toUpperCase()] || 'gray';
      case 'SSCI':
      case '中科院分区':
      case '新锐分区': {
        const t = tierOf(raw);
        return t >= 1 && t <= 4 ? TIER_TONES[t - 1] : 'gray';
      }
      default:
        return 'gray';
    }
  }

  window.RankUtils = Object.freeze({
    TONES,
    TIER_TONES,
    tierOf,
    rankSystemTone,
  });
})();
