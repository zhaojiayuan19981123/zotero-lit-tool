// fontMetrics.js —— 字体「观感字重」度量：从字形轮廓算出墨量，据此定描边补偿量
//
// 为什么需要它：
//   同一个字号下，「清晰」与「发灰看不清」的区别就是笔画覆盖了多少面积（墨迹面积）。
//   而墨迹面积由字体自身的字重决定，各字体差别很大——实测（Noto Sans SC，em 归一化）：
//     wght=100  0.1398      wght=400  0.3029      wght=700  0.4653
//     微软雅黑 0.4137        黑体 0.3383           宋体 0.2552
//   可变字体的默认档常常是极细的（Noto Sans SC 默认 100、Noto Serif SC 默认 200），
//   pdf-lib 嵌入时只会取默认档，于是译文细到发灰。这就是「翻译过来的文字不清晰」的根因。
//
// 做法（不靠经验系数，靠几何）：
//   1) 取若干常用汉字，把字形轮廓的二次/三次贝塞尔离散成折线；
//   2) 用鞋带公式算轮廓包围的净面积 → 墨迹面积 ink（em²）；同时累加轮廓周长 perim（em）；
//   3) 给轮廓加一圈宽度 t 的外描边，面积增量 ≈ perim × t（对小 t 是一阶近似）；
//   4) 于是「还要补多少描边」= (目标墨量 - 当前墨量) / perim，直接解出来。
//
// 这样无论用户换成什么字体（黑体/宋体/楷体/自己丢进来的字体），都能得到一致的观感，
// 而不是靠一张写死的"哪个字体偏细"的表格。
import fontkit from '@pdf-lib/fontkit';

/** 采样字符：覆盖横竖撇捺与包围结构，避免个别字形的偏斜影响估计 */
const SAMPLE = '营销组合有效性演变研究实证优先方法价格品类分销核心工具探讨';

/** 渲染观感的目标墨量（em²），用本模块的 SAMPLE 采样集实测标定：
 *    Noto Sans VF(默认 Thin) 0.1215 · 宋体 0.1650 · 楷体 0.1504 · 等线 0.2173
 *    黑体 0.2667 · 微软雅黑 0.3064 · 等线 Bold 0.3271 · 微软雅黑 Bold 0.4888
 *  取值落在「黑体 ~ 微软雅黑」与「微软雅黑 ~ 微软雅黑 Bold」之间：
 *    regular 0.30 ≈ 黑体，正文干净可读（低于此值小字号会发灰）
 *    medium  0.36 ≈ 微软雅黑再略重一点，屏幕上最舒服（应用默认）
 *    bold    0.48 ≈ 微软雅黑 Bold，标题/原文加粗处
 */
export const INK_TARGET = {
  regular: 0.30,
  medium: 0.36,
  bold: 0.48,
};

let fontkitReady = false;

/** 把字形轮廓指令离散成折线；同时返回折线总周长 */
function flatten(commands) {
  const contours = [];
  let cur = null;
  let cx = 0;
  let cy = 0;
  let perim = 0;
  const push = (x, y) => {
    if (!cur) return;
    const [px, py] = cur[cur.length - 1];
    perim += Math.hypot(x - px, y - py);
    cur.push([x, y]);
  };
  for (const c of commands) {
    switch (c.command) {
      case 'moveTo':
        cur = [[c.args[0], c.args[1]]];
        contours.push(cur);
        cx = c.args[0]; cy = c.args[1];
        break;
      case 'lineTo':
        push(c.args[0], c.args[1]); cx = c.args[0]; cy = c.args[1];
        break;
      case 'quadraticCurveTo': {
        const [x1, y1, x, y] = c.args;
        for (let i = 1, N = 10; i <= N; i++) {
          const t = i / N, mt = 1 - t;
          push(mt * mt * cx + 2 * mt * t * x1 + t * t * x, mt * mt * cy + 2 * mt * t * y1 + t * t * y);
        }
        cx = x; cy = y;
        break;
      }
      case 'bezierCurveTo': {
        const [x1, y1, x2, y2, x, y] = c.args;
        for (let i = 1, N = 12; i <= N; i++) {
          const t = i / N, mt = 1 - t;
          push(mt ** 3 * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t ** 3 * x,
            mt ** 3 * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t ** 3 * y);
        }
        cx = x; cy = y;
        break;
      }
      default:
        break;
    }
  }
  return { contours, perim };
}

/** 鞋带公式累加净面积（em²）：方向相反的轮廓（字腔/内孔）会自动相减 */
function contourInk(contours, scale) {
  let ink = 0;
  for (const c of contours) {
    let a = 0;
    for (let i = 0; i < c.length; i++) {
      const [x1, y1] = c[i];
      const [x2, y2] = c[(i + 1) % c.length];
      a += x1 * y2 - x2 * y1;
    }
    ink += a / 2;
  }
  return Math.abs(ink) * scale * scale;
}

const cache = new Map(); // key: 字节长度+前 16 字节摘要 → metrics

/**
 * 度量一份字体（单一 sfnt 字节）的墨迹面积与轮廓周长。
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ink:number, perim:number, glyphs:number} | null}
 */
export function measureFontInk(bytes) {
  if (!bytes || bytes.length < 20000) return null;
  const key = `${bytes.length}:${Buffer.from(bytes.subarray(0, 16)).toString('hex')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let result = null;
  try {
    const font = fontkit.create(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    const upem = font.unitsPerEm || 1000;
    const scale = 1 / upem;
    let ink = 0;
    let perim = 0;
    let n = 0;
    for (const ch of SAMPLE) {
      let g;
      try { g = font.glyphForCodePoint(ch.codePointAt(0)); } catch (_) { continue; }
      if (!g || !g.id) continue;
      const path = g.path;
      if (!path || !path.commands?.length) continue;
      const { contours, perim: p } = flatten(path.commands);
      const a = contourInk(contours, scale);
      if (!(a > 0)) continue;
      ink += a;
      perim += p * scale;
      n++;
    }
    if (n >= 5 && perim > 0) {
      result = { ink: ink / n, perim: perim / n, glyphs: n };
    }
  } catch (e) {
    result = null;
    cache.set(key, null);
    void e;
  }
  cache.set(key, result);
  return result;
}

/**
 * 算出要达到目标观感还需要多宽的描边。
 *
 * 面积增量 ≈ 周长 × 描边宽度（一阶近似），所以 t = 缺口 / 周长。
 * 结果做上限保护：超过 0.035em 的描边会把笔画糊在一起，宁可保持细一点。
 *
 * @param {object} args
 * @param {Buffer} args.bytes 将被嵌入的字体字节
 * @param {'regular'|'medium'|'bold'} [args.weight='regular'] 目标观感档位
 * @returns {{strokeEm:number, ink:number|null, targetInk:number, reason:string}}
 */
export function planStroke({ bytes, weight = 'regular' }) {
  const targetInk = INK_TARGET[weight] ?? INK_TARGET.regular;
  const m = measureFontInk(bytes);
  if (!m) {
    // 测不出来就退回保守的固定补偿，比完全不加好
    return { strokeEm: targetInk > INK_TARGET.regular ? 0.018 : 0.006, ink: null, targetInk, reason: '字体度量失败，使用保守补偿' };
  }
  if (m.ink >= targetInk) {
    return { strokeEm: 0, ink: m.ink, targetInk, reason: '字体本身已达标' };
  }
  // 轮廓周长随「加粗后笔画变粗」会略增，但一阶近似足够；留 10% 余量避免多次迭代
  const t = ((targetInk - m.ink) / m.perim) * 0.9;
  return {
    strokeEm: Math.max(0, Math.min(0.035, t)),
    ink: m.ink,
    targetInk,
    reason: `墨量 ${m.ink.toFixed(4)} < 目标 ${targetInk}，补描边`,
  };
}

/** 供诊断/测试：清空度量缓存 */
export function clearFontMetricsCache() {
  cache.clear();
}

/**
 * 一次性算好一份字体在三个观感档位下各自需要的描边宽度。
 * render.js（原位覆盖）与 reflow.js（重排）共用，保证两种成品粗细一致。
 * @param {Buffer|Uint8Array} bytes
 * @returns {{regular:number, medium:number, bold:number}} 各档描边宽度（em）
 */
export function buildStrokeTable(bytes) {
  return {
    regular: planStroke({ bytes, weight: 'regular' }).strokeEm,
    medium: planStroke({ bytes, weight: 'medium' }).strokeEm,
    bold: planStroke({ bytes, weight: 'bold' }).strokeEm,
  };
}
