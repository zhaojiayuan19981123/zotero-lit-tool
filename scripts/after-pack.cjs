/**
 * 打包后清理：把「不是运行时需要」的东西从产物里删掉。
 *
 * 为什么需要它 —— 两件事，都是真踩过的：
 *
 * 1) **绝不能把本机的 `data/` 与 `uploads/` 打进安装包。**
 *    `build.files` 那份白名单在实测里并没有约束到 app 目录本身：
 *    看 `dist/builder-debug.yml` 就知道，app 目录实际是按「什么都打」的默认规则打的
 *    （`firstOrDefaultFilePatterns` 里只有默认规则，自定义的那几条只落到了
 *    `nodeModuleFilePatterns` 上）。于是**本机打包**时，开发者自己的
 *    `data/literature.json`、`conversations.json`、`settings.json`、`paper-chats.json`
 *    和 `uploads/` 里的 PDF 会被一起塞进安装包发出去。
 *    CI 上一直没暴露，是因为 `data/` `uploads/` 都被 .gitignore 排除、根本没检出。
 *
 * 2) **不能把 `test/` 打进安装包。** 它会带来一种非常迷惑的假失败：
 *    仓库里 `npm test` 就是 `node --test`（无参自动发现），它会连
 *    `dist/win-unpacked/resources/app/test/**` 一起扫进去。那份副本的 package.json
 *    没有 `build` 字段、目录里也没有 `build/icon.png`，于是「图标背景透明」
 *    「打包排除规则」这些用例在**错误的根目录**下必然失败 ——
 *    代码明明是好的，却报出 7 项失败把真实结果盖住。
 *
 * 这里用 `afterPack` 而不是往 `build.files` 里加 `!test/**`，就是因为 afterPack 是
 * **确定性**的：它在「应用目录已经拷完、NSIS / DMG 还没开始压」之间执行，
 * 删掉什么就是什么，不受匹配规则语义变化的影响（加 `!test/**` 实测无效）。
 *
 * 安全护栏见下面 assertLooksLikePackedApp()：只有在确认这是**产物的 app 目录**
 * （里面有 server.js 与 public/）之后才会动手删，避免误伤源码目录。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 运行时不需要的顶层目录。 */
const DROP_DIRS = ['data', 'uploads', 'test', 'docs', 'scripts', '.npm-cache'];

/** 运行时不需要的顶层文件（保留 LICENSE，许可证要跟着分发）。 */
const DROP_FILES = ['README.md', 'MODIFICATION_NOTES.md', 'MACOS_BUILD.md'];

/** 产物里 app 目录的位置：Windows/Linux 在 resources/app，macOS 在 .app/Contents/Resources/app。 */
function resolveAppDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const product = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${product}.app`, 'Contents', 'Resources', 'app');
  }
  return path.join(context.appOutDir, 'resources', 'app');
}

/**
 * 确认这确实是「拷出来的那份 app」，而不是源码目录。
 * 判据：目录存在，且同时有 server.js 与 public/ —— 源码目录也满足这两条，
 * 所以再加一条「必须在 appOutDir 之内」，两道一起构成护栏。
 */
function assertLooksLikePackedApp(appDir, appOutDir) {
  const outAbs = path.resolve(appOutDir);
  const appAbs = path.resolve(appDir);
  const rel = path.relative(outAbs, appAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`[after-pack] 拒绝操作：${appAbs} 不在产物目录 ${outAbs} 之内`);
  }
  for (const probe of ['server.js', 'public', 'electron']) {
    if (!fs.existsSync(path.join(appAbs, probe))) {
      throw new Error(`[after-pack] 拒绝操作：${appAbs} 里没有 ${probe}，不像是打包产物`);
    }
  }
  return appAbs;
}

/** 删一个条目，返回它占的体积（KB），便于在日志里看出省了多少。 */
function drop(target) {
  let sizeKb = 0;
  try {
    sizeKb = Math.round(dirSizeKb(target));
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    throw new Error(`[after-pack] 删除 ${target} 失败：${e.message}`);
  }
  return sizeKb;
}

function dirSizeKb(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return st.size / 1024;
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    total += dirSizeKb(path.join(target, entry.name));
  }
  return total;
}

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  let appDir;
  try {
    appDir = assertLooksLikePackedApp(resolveAppDir(context), appOutDir);
  } catch (e) {
    // 找不到 app 目录（例如以后改用 asar）时不要静默跳过 —— 那等于把
    // 「本机 data/ 会不会被打进去」重新变成一个没人知道的问题。
    throw e;
  }

  const removed = [];
  for (const name of DROP_DIRS) {
    const target = path.join(appDir, name);
    if (!fs.existsSync(target)) continue;
    removed.push(`${name}/ (${drop(target)} KB)`);
  }
  for (const name of DROP_FILES) {
    const target = path.join(appDir, name);
    if (!fs.existsSync(target)) continue;
    removed.push(`${name} (${drop(target)} KB)`);
  }

  const kept = fs.readdirSync(appDir).sort().join(', ');
  console.log(`[after-pack] 已从产物里移除：${removed.length ? removed.join('、') : '（无）'}`);
  console.log(`[after-pack] 产物 app 目录保留：${kept}`);
};
