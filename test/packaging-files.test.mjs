/**
 * 打包排除规则不得误伤版面解析的运行时依赖。
 *
 * 背景（v1.22.0 真实事故）：用户安装后点「版面解析」必然失败，界面只显示
 *   ERR_INTERNAL_ASSERTION: Code: ERR_MODULE_NOT_FOUND;
 *   The provided arguments length (2) does not match the required ones (3).
 *
 * 根因是 build.files 里的 `!node_modules/**\/canvas/**` —— 本意只想排掉 node-canvas，
 * 但 `**\/canvas/**` 会匹配**任意一层**名为 canvas 的目录，于是把
 * `node_modules/@napi-rs/canvas/**` 一起删掉了：目录还在、package.json 与入口文件全空。
 * 子进程静态 `import "@napi-rs/canvas"` 时解析失败；而 Node 在 legacyMainResolve 里
 * 构造 ERR_MODULE_NOT_FOUND 时撞上自身的参数个数校验 bug，最终只抛出一句内部断言，
 * 把「找不到模块」这个真实原因完全掩盖掉了。
 *
 * 这条测试把「排除规则不许命中运行时依赖的入口文件」固化下来，
 * 同时确认 node-canvas 与各平台无关的原生二进制仍按原意被排除。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build || {};

/** 拼出某个平台最终生效的排除规则（全局 files + 平台级叠加）。 */
function excludesFor(platform) {
  const all = [
    ...(build.files || []),
    ...(build[platform]?.files || []),
  ];
  return all.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
}

/** 命中该相对路径的所有排除规则。 */
const hits = (rel, platform) => excludesFor(platform).filter((p) => minimatch(rel, p));

/**
 * 版面解析子进程启动阶段就会解析的文件：
 * - `@napi-rs/canvas` / `onnxruntime-node` 是静态 import，缺任一直接崩在解析阶段；
 * - `pdfjs-dist` 有顶层 `require.resolve('pdfjs-dist/package.json')` + 动态 import legacy 构建；
 * - 原生二进制是这两个包真正生效的前提。
 */
const COMMON_ENTRIES = [
  'node_modules/@napi-rs/canvas/package.json',
  'node_modules/@napi-rs/canvas/index.js',
  'node_modules/@napi-rs/canvas/js-binding.js',
  'node_modules/@napi-rs/canvas/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
  'node_modules/onnxruntime-node/package.json',
  'node_modules/onnxruntime-node/dist/index.js',
  'node_modules/pdfjs-dist/package.json',
  'node_modules/pdfjs-dist/build/pdf.mjs',
  'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'processor/dist/main.mjs',
  'processor/dist/models/model.onnx',
];

/** 各平台自己的那份 onnxruntime 原生绑定。 */
const PLATFORM_ENTRIES = {
  win: ['node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node'],
  mac: ['node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node'],
};

for (const platform of ['win', 'mac']) {
  test(`[${platform}] 打包排除规则不排除版面解析的运行时依赖`, () => {
    const entries = [...COMMON_ENTRIES, ...PLATFORM_ENTRIES[platform]];
    const broken = entries.map((rel) => ({ rel, hits: hits(rel, platform) })).filter((x) => x.hits.length);
    assert.deepEqual(
      broken,
      [],
      '以下运行时依赖会被打包排除规则剔除，安装后版面解析必然崩溃：\n' +
        broken.map((x) => `  ${x.rel}  <- ${x.hits.join(' , ')}`).join('\n'),
    );
  });
}

test('node-canvas 仍被排除（原意不能丢）', () => {
  // node-canvas 是重原生构建，本项目用 @napi-rs/canvas 取代它，必须继续排除
  for (const rel of [
    'node_modules/canvas/package.json',
    'node_modules/canvas/build/Release/canvas.node',
    'node_modules/foo/node_modules/canvas/package.json',
  ]) {
    assert.ok(hits(rel, 'win').length > 0, `${rel} 应当被排除，但目前不会被排除`);
  }
});

test('不能用 **/canvas/** 这种会误伤 @napi-rs/canvas 的写法', () => {
  // 直接钉住事故形态：任何一条排除规则只要把带 @ 作用域的 canvas 包也命中，就是错的
  for (const platform of ['win', 'mac']) {
    assert.equal(
      hits('node_modules/@napi-rs/canvas/package.json', platform).length,
      0,
      `[${platform}] 排除规则命中了 @napi-rs/canvas —— 这正是 v1.22.0 版面解析崩溃的成因`,
    );
  }
});

test('各平台不该带上其他平台的原生二进制', () => {
  assert.ok(
    hits('node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node', 'mac').length > 0,
    'macOS 包应当排除 Windows 的 onnxruntime 二进制',
  );
  assert.ok(
    hits('node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node', 'win').length > 0,
    'Windows 包应当排除 macOS 的 onnxruntime 二进制',
  );
});
