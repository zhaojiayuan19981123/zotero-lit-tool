import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from './server.js';
import * as store from './src/store.js';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL('C:/Users/zjy1998/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs').href);

const root = path.resolve('./_vision_ui_test_data');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const appServer = (await startServer({ port: 0, dataDir: root })).server;
const base = `http://127.0.0.1:${appServer.address().port}`;
const models = [
  'moonshotai/Kimi-K2.7-Code',
  'Qwen/Qwen3.8-27B',
  'Pro/moonshotai/Kimi-K2.6',
  'zai-org/GLM-4.5V',
  'Qwen/Qwen3.6-35B-A3B',
];
await fetch(base + '/api/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    aiProvider: 'siliconflow',
    onboarded: true,
    modelProfiles: [
      { id: 'text', label: 'DeepSeek 文本', provider: 'siliconflow', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'text-key', model: 'deepseek-ai/DeepSeek-V4-Flash', visionOverride: 'auto' },
      { id: 'vision', label: 'GLM 看图', provider: 'siliconflow', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'vision-key', model: 'zai-org/GLM-4.5V', visionOverride: 'auto' },
      { id: 'custom', label: '自定义看图', provider: 'siliconflow', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'custom-key', model: 'vendor/custom-vision', visionOverride: 'yes' },
    ],
    activeProfileId: 'text',
    visionProfileId: 'vision',
  }),
});

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.goto(base + '/', { waitUntil: 'networkidle' });
console.log('boot diagnostics', JSON.stringify({
  settingsButtons: await page.locator('#btnSettings').count(),
  settingsVisible: await page.locator('#btnSettings').isVisible().catch(() => false),
  onboardingVisible: await page.locator('#onboarding').isVisible().catch(() => false),
  pageErrors,
}, null, 2));
await page.locator('#btnSettings').click();
await page.locator('#settingsModal:not(.hidden)').waitFor();

assert.equal(await page.locator('#mlVisionOverride').count(), 1);
assert.equal(await page.locator('#setVisionProfile').inputValue(), 'vision');
await page.locator('[data-mledit="vision"]').click();
const chipText = await page.locator('#mlModelChips').innerText();
console.log('siliconflow chips', chipText);
assert.equal(chipText.includes('Kimi-K2.7-Code'), true);
assert.equal(chipText.includes('Qwen3.8-27B'), true);
assert.equal(chipText.includes('Kimi-K2.6 Pro'), true);
assert.equal(chipText.includes('GLM-4.5V'), true);
assert.equal(chipText.includes('Qwen3.6-35B-A3B'), true);

await page.locator('[data-mledit="custom"]').click();
assert.equal(await page.locator('#mlVisionOverride').inputValue(), 'yes');
const customLabel = await page.locator('#mlList').innerText();
assert.equal(customLabel.includes('看图 · 手动'), true);
await page.locator('#mlVisionOverride').selectOption('no');
await page.locator('#btnMlSave').click();
await page.waitForTimeout(250);
const saved = await (await fetch(base + '/api/settings')).json();
assert.equal(saved.modelProfiles.find((p) => p.id === 'custom').visionOverride, 'no');

await page.locator('[data-mledit="vision"]').click();
await page.locator('#mlVisionOverride').selectOption('yes');
await page.locator('#btnMlSave').click();
await page.waitForTimeout(250);
const savedAgain = await (await fetch(base + '/api/settings')).json();
assert.equal(savedAgain.modelProfiles.find((p) => p.id === 'vision').visionOverride, 'yes');

await page.screenshot({ path: path.resolve('./_vision_ui_test.png'), fullPage: false });
console.log(JSON.stringify({
  settingsModal: true,
  visionSelector: await page.locator('#setVisionProfile').inputValue(),
  newVisionChips: 5,
  manualOverrideRoundTrip: true,
}, null, 2));

await browser.close();
appServer.close();
fs.rmSync(root, { recursive: true, force: true });
