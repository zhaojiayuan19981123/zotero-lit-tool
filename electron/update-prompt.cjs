// update-prompt.cjs —— 「要不要提醒用户更新、用哪种方式提醒」的判定逻辑。
//
// 抽成纯函数的原因：这里是「同一个版本只提醒一次」的唯一闸门，靠静态断言或
// 手动点界面都不足以覆盖，抽出来就能直接把判定表逐条跑一遍。
// 主进程（electron/main.cjs）只负责取参数与执行副作用（弹卡片 / 发系统通知 / 落盘）。

'use strict';

const PROMPT_SKIP = 'skip';     // 不提醒
const PROMPT_IN_APP = 'in-app'; // 页面还看得见 -> 弹页面内卡片，等用户回执
const PROMPT_SYSTEM = 'system'; // 窗口在后台 -> 发系统通知，并直接记为已提醒

/**
 * @param {object} input
 * @param {string} input.version        本次发现的可用版本号（来自更新清单）
 * @param {string} input.promptedVersion 已经提醒过的版本号（跨启动持久化）
 * @param {boolean} input.pageVisible    页面是否可见且未最小化
 * @returns {'skip'|'in-app'|'system'}
 */
function shouldPrompt({ version, promptedVersion, pageVisible } = {}) {
  const next = String(version || '').trim();
  // 版本号都拿不到，说明这次检查结果不可信，宁可不提醒
  if (!next) return PROMPT_SKIP;
  // ★ 同一个版本只提醒一次：已经提醒过这个版本，之后无论查多少次都不再打扰
  if (String(promptedVersion || '').trim() === next) return PROMPT_SKIP;
  return pageVisible ? PROMPT_IN_APP : PROMPT_SYSTEM;
}

module.exports = { shouldPrompt, PROMPT_SKIP, PROMPT_IN_APP, PROMPT_SYSTEM };
