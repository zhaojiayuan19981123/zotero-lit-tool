'use strict';

// 更新源的纯逻辑：不依赖 Electron，可在单测里直接跑。
//
// electron-updater 的 generic provider 会请求 <目录>/latest.yml，再把 yml 里的
// 相对文件名（安装包 / .blockmap）拼到同一个目录。因此镜像只需要是一个静态目录，
// 与 GitHub Release 放同一组文件即可，校验和差量更新逻辑完全不用改。
//
// 源配置分两层：
//   · 发布者级：electron/update-sources.json 的 mirrorUrl，打包时写进安装包；
//   · 用户级：app-config.json 的 updateSourceMode / updateMirrorUrl，设置里可改。
// 用户级 mirrorUrl 非空时覆盖发布者默认值，留空表示沿用发布者默认值。

const MODES = ['auto', 'official'];
const MAX_URL_LENGTH = 2048;

function normalizeMode(value, fallback = 'auto') {
  const mode = String(value || '').trim().toLowerCase();
  return MODES.includes(mode) ? mode : fallback;
}

function isLoopbackHost(host) {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(String(host || ''));
}

// 只接受 https 目录 URL；本机回环地址额外允许 http，方便本地起 mock 服务验证。
// 拒绝 userinfo / query / hash / 路径穿越，避免把不可信地址塞给更新器。
function normalizeMirrorUrl(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > MAX_URL_LENGTH) return '';
  // new URL() 会把 /../ 自动规范化掉，所以路径穿越必须在解析前用原始串判断。
  if (/(^|\/)\.\.(\/|$)/.test(value)) return '';
  let url;
  try { url = new URL(value); } catch (_) { return ''; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) return '';
  if (!url.hostname || url.username || url.password || url.search || url.hash) return '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function mirrorLabel(url) {
  try { return `镜像 · ${new URL(url).host}`; } catch (_) { return '自定义镜像'; }
}

// 从持久化的 app-config 解析出规范配置。invalidMirror 用于让接口拒绝明显写错的地址，
// 而不是静默地把用户填的镜像丢掉。
// 同时接受持久化的原始键（updateSourceMode / updateMirrorUrl）与解析后的
// 规范键（mode / mirrorUrl / builtinMirrorUrl），保证对解析结果再解析是幂等的。
// buildCandidates() 拿到的正是解析结果，若只认原始键，自定义镜像会被静默丢掉。
function parseUpdateSourceConfig(raw = {}, builtinMirrorUrl = '') {
  const customRaw = String(raw.updateMirrorUrl ?? raw.mirrorUrl ?? '').trim();
  const custom = normalizeMirrorUrl(customRaw);
  const builtinRaw = raw.builtinMirrorUrl ?? builtinMirrorUrl;
  return {
    mode: normalizeMode(raw.updateSourceMode ?? raw.mode),
    mirrorUrl: custom,
    builtinMirrorUrl: normalizeMirrorUrl(builtinRaw),
    invalidMirror: Boolean(customRaw) && !custom,
  };
}

function effectiveMirrorUrl(config) {
  const parsed = parseUpdateSourceConfig(config, config.builtinMirrorUrl);
  return parsed.mirrorUrl || parsed.builtinMirrorUrl || '';
}

const OFFICIAL_CANDIDATE = Object.freeze({
  id: 'github',
  label: 'GitHub 官方',
  feed: null, // null = 恢复 electron-updater 打包内默认的 GitHub provider
  url: '',
});

// 返回按优先级排列的候选源。未配置镜像或选了「仅官方」时只有一个候选，
// 行为与 v1.39.0 完全一致；配置镜像后为 [镜像, 官方]，官方永远兜底。
function buildCandidates(config) {
  const parsed = parseUpdateSourceConfig(config, config.builtinMirrorUrl);
  const mirrorUrl = parsed.mirrorUrl || parsed.builtinMirrorUrl || '';
  if (parsed.mode === 'official' || !mirrorUrl) return [OFFICIAL_CANDIDATE];
  return [
    { id: 'mirror', label: mirrorLabel(mirrorUrl), feed: mirrorUrl, url: mirrorUrl },
    OFFICIAL_CANDIDATE,
  ];
}

// 下载失败回退时，把已经确认可用的源挪到队首，避免重复走慢的那条路。
function prioritize(candidates, activeId) {
  const index = candidates.findIndex((candidate) => candidate.id === activeId);
  if (index <= 0) return candidates.slice();
  return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}

module.exports = {
  MODES,
  OFFICIAL_CANDIDATE,
  normalizeMode,
  normalizeMirrorUrl,
  parseUpdateSourceConfig,
  effectiveMirrorUrl,
  buildCandidates,
  prioritize,
  mirrorLabel,
};
