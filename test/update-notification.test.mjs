// 更新提醒（新版本推送）的行为约束。
//
// 分两层：
//   1) 判定表 —— 「同一个版本只提醒一次」的唯一闸门是 update-prompt.cjs 里的纯函数，
//      直接把各种组合跑一遍（真单测，不是静态断言）；
//   2) 接线断言 —— 主进程是否真的定期后台检查、前台弹页面卡片 / 后台发系统通知、
//      页面是否弹一次就回执。这些跨进程行为没法在 Node 里跑，用静态断言守住关键写法。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { shouldPrompt, PROMPT_SKIP, PROMPT_IN_APP, PROMPT_SYSTEM } = require('../electron/update-prompt.cjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const mainCjs = read('electron/main.cjs');
const serverJs = read('server.js');
const appJs = read('public/app.js');
const indexHtml = read('public/index.html');
const styleCss = read('public/style.css');

// ---------- 1. 「同一个版本只提醒一次」判定表 ----------
test('发现新版本且没提醒过：前台弹页面卡片，后台发系统通知', () => {
  assert.equal(shouldPrompt({ version: '1.16.3', promptedVersion: '', pageVisible: true }), PROMPT_IN_APP);
  assert.equal(shouldPrompt({ version: '1.16.3', promptedVersion: '', pageVisible: false }), PROMPT_SYSTEM);
});

test('同一个版本只提醒一次：已提醒过就永远跳过', () => {
  // 无论查多少次、窗口是前台还是后台，同一个版本都不该再打扰用户
  for (const pageVisible of [true, false]) {
    assert.equal(shouldPrompt({ version: '1.16.3', promptedVersion: '1.16.3', pageVisible }), PROMPT_SKIP);
  }
});

test('出现更高的新版本时重新提醒一次（闸门按版本号走，不是一次性的）', () => {
  assert.equal(shouldPrompt({ version: '1.16.4', promptedVersion: '1.16.3', pageVisible: true }), PROMPT_IN_APP);
  assert.equal(shouldPrompt({ version: '1.17.0', promptedVersion: '1.16.3', pageVisible: false }), PROMPT_SYSTEM);
  // 提醒完之后又安静下来
  assert.equal(shouldPrompt({ version: '1.16.4', promptedVersion: '1.16.4', pageVisible: true }), PROMPT_SKIP);
});

test('版本号拿不到就不提醒（避免误报）', () => {
  assert.equal(shouldPrompt({ version: '', promptedVersion: '', pageVisible: true }), PROMPT_SKIP);
  assert.equal(shouldPrompt({ version: '   ', promptedVersion: '1.16.3', pageVisible: true }), PROMPT_SKIP);
  assert.equal(shouldPrompt({}), PROMPT_SKIP);
  assert.equal(shouldPrompt(), PROMPT_SKIP);
});

// ---------- 2. 主进程接线 ----------
test('主进程会在启动后与每 6 小时各做一次后台检查', () => {
  assert.match(mainCjs, /UPDATE_AUTO_CHECK_DELAY_MS\s*=\s*\d+\s*\*\s*1000/);
  assert.match(mainCjs, /UPDATE_AUTO_CHECK_INTERVAL_MS\s*=\s*6\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(mainCjs, /setTimeout\([\s\S]{0,60}runAutoUpdateCheck\(\);[\s\S]{0,30}\},\s*UPDATE_AUTO_CHECK_DELAY_MS\)/);
  assert.match(mainCjs, /setInterval\([\s\S]{0,60}runAutoUpdateCheck\(\);[\s\S]{0,30}\},\s*UPDATE_AUTO_CHECK_INTERVAL_MS\)/);
  assert.match(mainCjs, /scheduleAutoUpdateChecks\(\);/);
  // 后台检查失败不能把状态留成 error 去吓唬用户
  assert.match(mainCjs, /if \(updateState\.phase === 'error'\) Object\.assign\(updateState, \{ phase: 'idle', error: '' \}\)/);
});

test('提醒过就落盘，重启也不会再弹（持久化键 updatePromptedVersion）', () => {
  assert.match(mainCjs, /readAppConfig\(\)\.updatePromptedVersion/);
  assert.match(mainCjs, /writeAppConfig\(\{ updatePromptedVersion: v \}\)/);
  // 启动时把已提醒版本读回内存
  assert.match(mainCjs, /updateState\.promptedVersion = readPromptedVersion\(\)/);
  // 判定统一走纯函数，别在事件回调里各写一份 if
  assert.match(mainCjs, /const decision = shouldPrompt\(\{/);
  assert.match(mainCjs, /if \(decision === PROMPT_SKIP\) return;/);
});

test('窗口在后台走系统通知且直接记为已提醒', () => {
  assert.match(mainCjs, /new Notification\(\{/);
  assert.match(mainCjs, /notification\.show\(\)/);
  assert.match(mainCjs, /if \(showUpdateNotification\(info\)\) markPrompted\(version\)/);
  // 通知里点一下要把窗口叫到前台，否则用户找不到更新入口
  assert.match(mainCjs, /notification\.on\('click',[\s\S]{0,200}mainWindow\.focus\(\)/);
});

test('发现新版本时主动叫醒页面，不必等轮询', () => {
  assert.match(mainCjs, /executeJavaScript\('window\.__updateStatusTick[\s\S]{0,40}\)/);
  assert.match(appJs, /window\.__updateStatusTick = \(\) => loadUpdateStatus\(true\)/);
});

test('页面弹一次就回执，主进程的 ackPrompt 收到后才算已提醒', () => {
  assert.match(mainCjs, /ackPrompt\(version\) \{/);
  assert.match(mainCjs, /markPrompted\(v\);/);
  assert.match(serverJs, /app\.post\('\/api\/update\/prompt-ack'/);
  assert.match(serverJs, /updateService\.ackPrompt\(version\)/);
  // 只接受字符串版本号，别把任意对象透进主进程
  assert.match(serverJs, /typeof req\.body\?\.version === 'string'/);
});

// ---------- 3. 页面接线 ----------
test('页面有一张新版本提醒卡片，且接到回执链路上', () => {
  assert.match(indexHtml, /<aside id="updateNotify"/);
  assert.match(indexHtml, /id="updateNotifyVersion"/);
  assert.match(indexHtml, /data-update-notify="open"/);
  assert.match(indexHtml, /data-update-notify="dismiss"/);
  assert.match(styleCss, /\.update-notify \{/);
  // 卡片要在弹窗之下：弹窗 z-index 100，卡片必须更小
  const notifyZ = Number(/\.update-notify \{[\s\S]*?z-index:\s*(\d+)/.exec(styleCss)?.[1]);
  const modalZ = Number(/\.modal \{[\s\S]*?z-index:\s*(\d+)/.exec(styleCss)?.[1]);
  assert.ok(notifyZ && modalZ && notifyZ < modalZ, `卡片层级 ${notifyZ} 应低于弹窗 ${modalZ}`);
});

test('页面只在主进程说「该提醒」时弹，并记住本进程已弹过的版本', () => {
  // 必须同时满足：有可用版本 + 主进程置位 pendingPrompt + 本次运行还没弹过该版本
  assert.match(appJs, /if \(status\.phase !== 'available' \|\| !status\.availableVersion\) return;/);
  assert.match(appJs, /if \(!status\.pendingPrompt\) return;/);
  assert.match(appJs, /if \(updateNotifyShownFor === status\.availableVersion\) return;/);
  // 关闭/查看都会回执，保证「一次」不被绕过
  assert.match(appJs, /function closeUpdateNotify\(openModal = false\) \{[\s\S]{0,200}ackUpdatePrompt\(updateNotifyVersion\)/);
  assert.match(appJs, /api\('\/api\/update\/prompt-ack'/);
});

test('没有可更新能力的环境下不弹卡片（浏览器开发模式）', () => {
  assert.match(appJs, /function maybeShowUpdateNotify\(status\) \{\s*\n\s*if \(!status \|\| !status\.supported\) return;/);
});
