#!/usr/bin/env node
// 把 GitHub Release 的同一批产物同步到国内对象存储，为 electron-updater 提供镜像源。
//
// 零新增依赖：用 Node 内置的 crypto 实现 AWS SigV4，用内置 fetch 做 PUT。
// 腾讯云 COS / 阿里云 OSS / Cloudflare R2 / 七牛等 S3 兼容服务都能用。
//
// 镜像只需是一个静态目录：generic provider 会请求 <目录>/latest.yml，再把 yml 里的
// 相对文件名（安装包、.blockmap）拼到同一目录，sha512 校验与差量下载逻辑完全不变。
//
// 关键顺序：latest.yml **最后**上传。否则会出现「清单已指向新版本、安装包还没传完」
// 的中间态，用户恰好在这几秒检查更新就会下载到 404。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_PREFIX = 'worlex/releases/latest/';
const MANAGED_FILES = [
  /^latest\.yml$/,
  /^worlex-setup-[\w.-]+\.exe$/,
  /^worlex-setup-[\w.-]+\.exe\.blockmap$/,
  /^worlex-[\w.-]*-macos-(arm64|x64)\.dmg$/,
  /^SHA256SUMS\.txt$/,
];
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function normalizePrefix(prefix = DEFAULT_PREFIX) {
  let value = String(prefix || DEFAULT_PREFIX).trim();
  if (!value.endsWith('/')) value += '/';
  if (value.startsWith('/')) value = value.slice(1);
  // 去掉结尾斜杠产生的空段，再逐段校验，避免把合法前缀误判成非法。
  const parts = value.replace(/\/$/, '').split('/');
  if (!value || value.includes('..') || !parts.every((part) => SAFE_NAME.test(part))) {
    throw new Error(`镜像目录前缀不合法：${prefix}`);
  }
  return value;
}

export function cacheControlFor(name) {
  // 更新清单绝不能被 CDN 缓存，否则用户会一直看到旧版本；
  // 安装包文件名带版本号，可以长期强缓存，CDN 命中率也更高。
  return name === 'latest.yml' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable';
}

export function contentTypeFor(name) {
  if (name.endsWith('.yml')) return 'application/x-yaml; charset=utf-8';
  if (name.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage';
  return 'application/octet-stream';
}

// 返回按上传顺序排列的清单，latest.yml 永远在最后。
export function planFiles(names, prefix = DEFAULT_PREFIX) {
  const cleanPrefix = normalizePrefix(prefix);
  const picked = [...new Set(names)].filter((name) => SAFE_NAME.test(name) && MANAGED_FILES.some((re) => re.test(name)));
  picked.sort((a, b) => {
    const rank = (n) => (n === 'latest.yml' ? 1 : 0);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return picked.map((name) => ({
    name,
    key: `${cleanPrefix}${name}`,
    cacheControl: cacheControlFor(name),
    contentType: contentTypeFor(name),
  }));
}

// Windows 自动更新三件套缺一不可：缺 blockmap 会退化成全量下载，缺 yml 则完全发现不了版本。
export function assertComplete(plan) {
  const names = plan.map((item) => item.name);
  if (!names.includes('latest.yml')) throw new Error('缺少 latest.yml，拒绝同步镜像');
  if (!names.some((name) => name.endsWith('.exe'))) throw new Error('缺少 Windows 安装包，拒绝同步镜像');
  if (!names.some((name) => name.endsWith('.exe.blockmap'))) throw new Error('缺少 .exe.blockmap，差量更新会失效，拒绝同步镜像');
  if (plan.at(-1)?.name !== 'latest.yml') throw new Error('latest.yml 必须最后上传');
}

// path-style 与 virtual-host 两种形态都支持：endpoint 的主机名若已含 bucket，
// 就不再拼一段 /bucket（COS 默认域名正是这种形态）。
export function buildObjectUrl(endpoint, bucket, key) {
  const base = new URL(String(endpoint));
  if (!/^https?:$/.test(base.protocol)) throw new Error(`镜像 endpoint 必须是 http(s)：${endpoint}`);
  const hostHasBucket = base.hostname === bucket || base.hostname.startsWith(`${bucket}.`);
  const objectPath = `${hostHasBucket ? '' : `/${bucket}`}/${String(key).replace(/^\//, '')}`;
  const result = new URL(objectPath, base.origin);
  result.search = base.search;
  return result;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonicalUri(pathname) {
  return pathname.split('/').map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch (_) { /* 保持原样 */ }
    return encodeURIComponent(decoded).replace(/%2F/g, '/');
  }).join('/');
}

// 生成 SigV4 签名头。返回的对象可直接作为 fetch 的 headers（host 由 fetch 自动设置）。
export function signRequest({
  url, body, accessKeyId, secretAccessKey, region,
  contentType, cacheControl, now = new Date(),
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261113T120000Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers = {
    host: url.host,
    'cache-control': cacheControl,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((key) => `${key}:${String(headers[key]).trim()}\n`).join('');
  const canonicalRequest = [
    'PUT', canonicalUri(url.pathname), url.search.replace(/^\?/, ''),
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(Buffer.from(canonicalRequest, 'utf-8')),
  ].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf-8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const { host, ...requestHeaders } = headers;
  return { ...requestHeaders, authorization };
}

async function putObject(url, body, item, config) {
  const headers = signRequest({
    url, body, contentType: item.contentType, cacheControl: item.cacheControl,
    accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region,
  });
  const response = await fetch(url, { method: 'PUT', headers, body });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 400);
    throw new Error(`上传 ${item.name} 失败：HTTP ${response.status} ${detail}`);
  }
}

export async function syncMirror(config = {}) {
  const {
    assetsDir = 'release-assets', prefix = DEFAULT_PREFIX, endpoint, bucket,
    region = 'auto', accessKeyId, secretAccessKey, dryRun = false,
    publicBaseUrl = '', logger = console,
  } = config;
  const names = fs.readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => entry.name);
  const plan = planFiles(names, prefix);
  assertComplete(plan);

  if (dryRun) {
    logger.log(`[镜像] dry-run：将同步 ${plan.length} 个文件，顺序如下`);
    for (const item of plan) logger.log(`  ${item.key}  (${item.cacheControl})`);
    return { plan, uploaded: [] };
  }

  for (const key of ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']) {
    if (!config[key]) throw new Error(`缺少镜像配置 ${key}，无法同步`);
  }
  const uploaded = [];
  for (const item of plan) {
    const body = fs.readFileSync(path.join(assetsDir, item.name));
    await putObject(buildObjectUrl(endpoint, bucket, item.key), body, item, {
      accessKeyId, secretAccessKey, region,
    });
    uploaded.push(item.name);
    logger.log(`[镜像] 已上传 ${item.key}（${(body.length / 1024 / 1024).toFixed(1)} MB）`);
  }
  const clientBase = publicBaseUrl || (() => {
    const root = buildObjectUrl(endpoint, bucket, normalizePrefix(prefix));
    root.pathname = root.pathname.replace(/\/$/, '');
    return `${root.origin}${root.pathname}/`;
  })();
  logger.log(`[镜像] 同步完成。客户端应填写的更新源目录：${clientBase}`);
  logger.log('[镜像] 把上面这个地址填进 electron/update-sources.json 的 mirrorUrl（发布者默认），');
  logger.log('[镜像] 或由用户在「应用更新 → 更新下载源」里自行填写。');
  return { plan, uploaded, clientBase };
}

function envConfig(args) {
  const assetsIndex = args.indexOf('--assets');
  return {
    assetsDir: assetsIndex >= 0 ? args[assetsIndex + 1] : (process.env.MIRROR_ASSETS_DIR || 'release-assets'),
    endpoint: process.env.MIRROR_ENDPOINT,
    bucket: process.env.MIRROR_BUCKET,
    region: process.env.MIRROR_REGION || 'auto',
    accessKeyId: process.env.MIRROR_ACCESS_KEY_ID,
    secretAccessKey: process.env.MIRROR_SECRET_ACCESS_KEY,
    prefix: process.env.MIRROR_PREFIX || DEFAULT_PREFIX,
    publicBaseUrl: process.env.MIRROR_PUBLIC_BASE_URL || '',
    dryRun: args.includes('--dry-run'),
  };
}

async function main() {
  const config = envConfig(process.argv.slice(2));
  const result = await syncMirror(config);
  if (config.dryRun) return result;
  console.log(`[镜像] 共上传 ${result.uploaded.length} 个文件`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[镜像] 同步失败：${error.message}`);
    process.exitCode = 1;
  });
}
