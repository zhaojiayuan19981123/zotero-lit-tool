import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = require('../electron/update-source.cjs');
const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const builtin = JSON.parse(fs.readFileSync(new URL('../electron/update-sources.json', import.meta.url), 'utf8'));

const CDN = 'https://cdn.example.com/worlex/releases/latest/';
const COS = 'https://bucket.cos.ap-shanghai.myqcloud.com/worlex/releases/latest/';

test('更新源模式只接受 auto / official，未知值回退 auto', () => {
  assert.equal(source.normalizeMode('auto'), 'auto');
  assert.equal(source.normalizeMode('OFFICIAL'), 'official');
  assert.equal(source.normalizeMode(''), 'auto');
  assert.equal(source.normalizeMode('nonsense'), 'auto');
  assert.equal(source.normalizeMode(undefined, 'official'), 'official');
});

test('镜像地址只接受 https 目录 URL，并规范化结尾斜杠', () => {
  assert.equal(source.normalizeMirrorUrl(CDN), CDN);
  assert.equal(source.normalizeMirrorUrl('https://cdn.example.com/worlex/releases/latest'), CDN);
  assert.equal(source.normalizeMirrorUrl(COS), COS);
  assert.equal(source.normalizeMirrorUrl(''), '');
  assert.equal(source.normalizeMirrorUrl('not a url'), '');
  assert.equal(source.normalizeMirrorUrl('ftp://cdn.example.com/x/'), '');
  assert.equal(source.normalizeMirrorUrl('http://cdn.example.com/x/'), '');
  assert.equal(source.normalizeMirrorUrl('https://user:pass@cdn.example.com/x/'), '');
  assert.equal(source.normalizeMirrorUrl('https://cdn.example.com/x/?token=1'), '');
  assert.equal(source.normalizeMirrorUrl('https://cdn.example.com/x/#frag'), '');
  assert.equal(source.normalizeMirrorUrl('https://cdn.example.com/../secret/'), '');
  assert.equal(source.normalizeMirrorUrl('https://' + 'a'.repeat(3000) + '.com/x/'), '');
  // 本机回环允许 http，便于本地起 mock 服务验证同步链路
  assert.match(source.normalizeMirrorUrl('http://127.0.0.1:8765/mirror/'), /^http:\/\/127\.0\.0\.1:8765\/mirror\/$/);
});

test('自定义镜像覆盖发布者内置地址，非法地址会被标记出来', () => {
  const cfg = source.parseUpdateSourceConfig({ updateSourceMode: 'official', updateMirrorUrl: CDN }, COS);
  assert.equal(cfg.mode, 'official');
  assert.equal(cfg.mirrorUrl, CDN);
  assert.equal(cfg.builtinMirrorUrl, COS);
  assert.equal(cfg.invalidMirror, false);
  assert.equal(source.effectiveMirrorUrl(cfg), CDN);

  const bad = source.parseUpdateSourceConfig({ updateMirrorUrl: 'javascript:alert(1)' }, '');
  assert.equal(bad.mirrorUrl, '');
  assert.equal(bad.invalidMirror, true);
  assert.equal(source.effectiveMirrorUrl({ mirrorUrl: '', builtinMirrorUrl: COS }), COS);
});

test('未配置镜像或选「仅官方」时只有一个候选，行为与旧版一致', () => {
  assert.deepEqual(source.buildCandidates({ mode: 'auto', mirrorUrl: '', builtinMirrorUrl: '' }),
    [source.OFFICIAL_CANDIDATE]);
  assert.deepEqual(source.buildCandidates({ mode: 'official', mirrorUrl: '', builtinMirrorUrl: CDN }),
    [source.OFFICIAL_CANDIDATE]);
  const single = source.buildCandidates({ mode: 'auto', mirrorUrl: '', builtinMirrorUrl: '' })[0];
  assert.equal(single.feed, null, 'feed 为 null 表示恢复打包内默认的 GitHub provider');
});

test('配置镜像后候选为 [镜像, GitHub 官方]，官方永远兜底', () => {
  const candidates = source.buildCandidates({ mode: 'auto', mirrorUrl: '', builtinMirrorUrl: CDN });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].id, 'mirror');
  assert.equal(candidates[0].feed, CDN);
  assert.equal(candidates[0].label, '镜像 · cdn.example.com');
  assert.equal(candidates[1].id, 'github');
  assert.equal(candidates[1].feed, null);
  // 用户自定义地址优先于发布者内置地址
  const custom = source.buildCandidates({ mode: 'auto', mirrorUrl: COS, builtinMirrorUrl: CDN });
  assert.equal(custom[0].feed, COS);
});

test('下载失败回退时把当前源挪到队首，且不改动原数组', () => {
  const candidates = source.buildCandidates({ mode: 'auto', mirrorUrl: '', builtinMirrorUrl: CDN });
  const reordered = source.prioritize(candidates, 'github');
  assert.equal(reordered[0].id, 'github');
  assert.equal(reordered[1].id, 'mirror');
  assert.equal(candidates[0].id, 'mirror', '原数组顺序不能被破坏');
  assert.deepEqual(source.prioritize(candidates, 'unknown'), candidates);
  assert.deepEqual(source.prioritize(candidates, 'mirror')[0].id, 'mirror');
});

test('发布者默认镜像默认为空，保证 v1.39.0 用户的更新行为不变', () => {
  assert.equal(builtin.mirrorUrl, '');
});

test('主进程、后端、页面与 CI 都接上了更新源', () => {
  assert.match(main, /require\('\.\/update-source\.cjs'\)/);
  assert.match(main, /async function probeSources/);
  assert.match(main, /provider: 'generic'/);
  assert.match(main, /autoUpdater\.clientPromise = null/);
  assert.match(main, /getSources\(\)/);
  assert.match(main, /setSource\(payload/);
  assert.match(main, /probeQuiet/);
  assert.match(server, /app\.get\('\/api\/update\/source'/);
  assert.match(server, /app\.post\('\/api\/update\/source'/);
  assert.match(app, /async function loadUpdateSource/);
  assert.match(app, /async function saveUpdateSource/);
  assert.match(html, /id="updateSourceMode"/);
  assert.match(html, /id="updateMirrorUrl"/);
  assert.match(html, /id="btnUpdateSourceSave"/);
  assert.match(workflow, /Sync update mirror/);
  assert.match(workflow, /scripts\/sync-release-mirror\.mjs/);
  assert.match(workflow, /continue-on-error: true/);
});
