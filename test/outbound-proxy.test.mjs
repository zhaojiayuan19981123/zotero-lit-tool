// 出站代理的单测：
//  1) outboundProxy.js 的配置归一化 / 探测 / 缓存 / 决策（纯逻辑，probe 注入，不碰网络）
//  2) proxiedFetch.js 的 CONNECT 隧道（真实起一个本地 CONNECT 代理 + 本地 HTTPS 目标）
//
// 说明：隧道测试用的是**测试自签证书**，所以这里显式关掉 Node 的证书校验
// （NODE_TLS_REJECT_UNAUTHORIZED=0）。本测试要验的是「隧道通不通、头有没有带过去」，
// 不是证书校验本身 —— 生产代码里不做这个让步。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';

import {
  PROXY_MODE, DEFAULT_PROXY_CANDIDATES, DEFAULT_PROBE_TARGETS, normalizeProxyConfig, readProxyConfig,
  detectProxy, ensureDetected, createProxyState, proxyForRequest, shouldRetryWithProxy, proxySnapshot,
} from '../src/outboundProxy.js';
import { proxiedFetch, probeProxy } from '../src/proxiedFetch.js';

// ---- 测试自签证书（CN=127.0.0.1，含 IP SAN），仅用于本地测试 ----
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDa/OY6vYsAEeHc
tiqbKtULPNYR4PHLTGcSTYAIh2LME7kgxTwxGjVZWualz16XAYD9+XJKOHv7ncfj
HGOTESgPvLxS6gZfmJU+uW5JrTjzCqtekI46wZTnx6/RQsl/zGtD4/A+cu+z/+7n
JLW827qDtjNLvyZW6OrWuzpu9h/k6vBZmLmU3wURZQ0Jk57jcAlQGVqUDC/NDbqw
ADQENh4Rwedz06f6J33AoXqPHRCp1qcbp3dzXmx8QEW82MtoCedxhVC8jmuuhRbR
3ITZ93Sg76iZ7w419gKEJ+btRRHTlisguL7atTf1PsXNKSZPHH2ZaccteXcVpiDb
t/HNHsbtAgMBAAECggEAI+5rk1dO46HLgsS0HHYsczXV9SSI3//nCJqFR8D5Hb2d
umoKbI8dkk4HOs0Z+uKBCQshLNr0Qu6aYeIiV3rw7RYde2hRR+W4FUzlMvsUdVJ6
mF9VKwBg36AE8evItqqyrfbMUF7ZBFqZ1zzPgg+2nI5sf8D7ODbq83VQiuzhAlUZ
YRMzHhhEopJTtz00okdQE+CSDHjFkBzyrQz5rm3dP4OX8rlzEYAAk7l/BDN6etsa
dgQYM4UvgSoXbd71eOC/lqD4On4mrp+ceYoRlx0Smf75qGo2pYIeg3kReeNnWSgs
vZ87I7lNUp50WJpftZYLsxwZuSSh7i19qM+XsodBsQKBgQD83vQH8EBTA4cIVp7W
H+kMwWE/UwgVFNADnZSoqjafuXjfeDju7LqII4JQKH03DlpTJzgytOV4jy+TGWdC
Vrt0FtcrXMw450kwQrDWLBe7rdLxmJThP90d3efy9GdklwUJLdFImxIaBB3eQ9ts
pQNpuFbWRNLzezkVLKcisAYEkQKBgQDdspxzwySUSaKQ6EkCdbdXbGFeSW4XWpEy
01ESWBYhKYPE8P610OCd5HHuFnSNmi+rKX4c4gG6Xu4/SKEcat5ACquaIRWPOzCQ
9uVIXYWxLNRvE2ac+o3/gddlG9vYCilZeJXw/EJuP/tYGu+rUmNGyUcnOuHl9ZuS
6TOjXCNanQKBgDmXVaDROPUvInvlrns5/UvoZwuTD44tlUqdgxP+4D30cfEDYoQX
6kvDOpSjBBGb9Tpm/keeJ30Tr1QjPv8+3aaM5Sh9FA4JrwOMzNWaaTVXW2mmxJGg
h+2bco5E159zPbRfeQC+QJsoQN00Oy89Tc+wKibWuey2LcQCzXX6/QPhAoGBALiN
IyhK3nyC/81ZUM23aLRiCHwQ7JCMWCrTNr3qjiF1Cbg8VgzMoO9PaHgmQUhPfjci
B1XL3lxjAjm0IEojvHfbahaYS/Y786X5ocyn7c8b3ovIvrcW7HYyhDgrBMvHSbyt
YUSG+lYE9RrW8YTQxMv8ajsCDWL9HlEhyFbJMLURAoGBAMngXNG0TyfX9irQbCjb
wAKKqIIFunWMFLtVLaBrdDatyBKszZMdBCBLXJkyG0bzm/PC+Nr99J21rsjgVa9J
BSa756nf9dkinhHPQCNzYhY0hRqcEsB1Op+4K5tjLbdVhhnJ2zmoPpU9sPn9RWAB
4mgLhCZawuRB4NsFo46IAodv
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUGbkSExLq3Qoo1sLI6eG1f9rgl4EwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDkyNDA5MDQ1OVoXDTM2MDky
MTA5MDQ1OVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2vzmOr2LABHh3LYqmyrVCzzWEeDxy0xnEk2ACIdizBO5
IMU8MRo1WVrmpc9elwGA/flySjh7+53H4xxjkxEoD7y8UuoGX5iVPrluSa048wqr
XpCOOsGU58ev0ULJf8xrQ+PwPnLvs//u5yS1vNu6g7YzS78mVujq1rs6bvYf5Orw
WZi5lN8FEWUNCZOe43AJUBlalAwvzQ26sAA0BDYeEcHnc9On+id9wKF6jx0Qqdan
G6d3c15sfEBFvNjLaAnncYVQvI5rroUW0dyE2fd0oO+ome8ONfYChCfm7UUR05Yr
ILi+2rU39T7FzSkmTxx9mWnHLXl3FaYg27fxzR7G7QIDAQABo28wbTAdBgNVHQ4E
FgQUQCxyuKfJ6fKOc6OWA3aDTic+xtMwHwYDVR0jBBgwFoAUQCxyuKfJ6fKOc6OW
A3aDTic+xtMwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAFzVU1BdGpZoRVnl7bnG91+ukIkYCsnr
RhBu7ybbmuo2QzNv2o68tGV+Vf1nyS/3d/YXeGKb5pbJdRVKUo4sYM+Eqt8ozEmJ
g23aLwAWV5Qif2U5le9wVY4OtN+tjlsFLHfhUUpO5nn8aJeH+309+paKr0zioFwG
xwLdlYc6N0r3kHycmGlvGxwOU2Z0otJVfCMndBYhN01DsWxv0JfN7eapxHeiHDvW
WJhIZkt+V6fg6IJ2EALQS/ZB7e7AQ9IzkFaXQu+rx1eypSA3GMhRAjXPt5X8ZXUb
g2tVr4Ff+JH7PRDSd/RgZxQwj0mktQzwGpn0dETCl9XElvfcv62fNPw=
-----END CERTIFICATE-----`;

// ---------------- A. 纯逻辑 ----------------

test('配置：默认是 auto（直连优先，不无脑走代理）', () => {
  const cfg = normalizeProxyConfig(undefined);
  assert.equal(cfg.mode, PROXY_MODE.AUTO);
  assert.equal(cfg.url, '');
  assert.equal(cfg.detectMinutes, 10);
});

test('配置：非法模式回落 auto，探测间隔被钳制到 1~240 分钟', () => {
  assert.equal(normalizeProxyConfig({ mode: '瞎写' }).mode, PROXY_MODE.AUTO);
  assert.equal(normalizeProxyConfig({ mode: 'off' }).mode, PROXY_MODE.OFF);
  assert.equal(normalizeProxyConfig({ detectMinutes: 0 }).detectMinutes, 1);
  assert.equal(normalizeProxyConfig({ detectMinutes: 99999 }).detectMinutes, 240);
  assert.equal(normalizeProxyConfig({ detectMinutes: 15 }).detectMinutes, 15);
  assert.equal(normalizeProxyConfig({ url: '  http://127.0.0.1:7890  ' }).url, 'http://127.0.0.1:7890');
});

test('决策：auto 模式下不给「直连」附代理（失败后才换）', () => {
  const state = createProxyState();
  state.detectedUrl = 'http://127.0.0.1:10809';
  assert.equal(proxyForRequest(normalizeProxyConfig({ mode: 'auto' }), state), '');
});

test('决策：always 用探测到的地址；off 永远直连（哪怕填了地址）；手填地址优先于自动探测', () => {
  const state = createProxyState();
  state.detectedUrl = 'http://127.0.0.1:10809';
  assert.equal(proxyForRequest(normalizeProxyConfig({ mode: 'always' }), state), 'http://127.0.0.1:10809');
  // always + 手填地址 → 用手填的
  assert.equal(
    proxyForRequest(normalizeProxyConfig({ mode: 'always', url: 'http://127.0.0.1:7890' }), state),
    'http://127.0.0.1:7890',
  );
  // off 是「明确不要代理」，优先级最高：即使地址栏里还留着旧值也不走代理
  assert.equal(proxyForRequest(normalizeProxyConfig({ mode: 'off' }), state), '');
  assert.equal(
    proxyForRequest(normalizeProxyConfig({ mode: 'off', url: 'http://127.0.0.1:7890' }), state),
    '',
  );
});

test('决策：always 但还没探到可用端口时不硬走代理', () => {
  assert.equal(proxyForRequest(normalizeProxyConfig({ mode: 'always' }), createProxyState()), '');
});

test('重试判定：网络层错误才换代理，超时与业务错误不换', () => {
  const auto = normalizeProxyConfig({ mode: 'auto' });
  assert.equal(shouldRetryWithProxy(new TypeError('fetch failed'), auto), true);
  assert.equal(shouldRetryWithProxy(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(shouldRetryWithProxy(new Error('socket hang up'), auto), true);
  assert.equal(shouldRetryWithProxy(new Error('unable to verify the first certificate'), auto), true);
  // 超时不是网络不通，换代理只会让用户多等一倍
  const abort = new Error('aborted'); abort.name = 'AbortError';
  assert.equal(shouldRetryWithProxy(abort, auto), false);
  assert.equal(shouldRetryWithProxy(new Error('AI 接口返回 500'), auto), false);
  // 非 auto 模式不做「失败后换代理」这套
  assert.equal(shouldRetryWithProxy(new TypeError('fetch failed'), normalizeProxyConfig({ mode: 'off' })), false);
  assert.equal(shouldRetryWithProxy(new TypeError('fetch failed'), normalizeProxyConfig({ mode: 'always' })), false);
});

test('探测：命中第一个可用候选就停手，并逐项记录结果', async () => {
  const calls = [];
  const probe = async (url) => {
    calls.push(url);
    return { ok: url === DEFAULT_PROXY_CANDIDATES[1], status: 204 };
  };
  const r = await detectProxy({ candidates: DEFAULT_PROXY_CANDIDATES, probe });
  assert.equal(r.url, DEFAULT_PROXY_CANDIDATES[1]);
  assert.deepEqual(r.tried.map((t) => t.ok), [false, true]);
  // 命中的是第 2 个候选：第 3 个及以后的候选一次都不该被探
  assert.ok(!calls.includes(DEFAULT_PROXY_CANDIDATES[2]), '命中后不该继续探后面的候选');
  assert.equal(calls.length, DEFAULT_PROBE_TARGETS.length + 1,
    '第 1 个候选要把所有探测目标都试完（都没通），第 2 个候选一次就通');
});

test('探测：一个都没探到时返回空地址，且不抛异常', async () => {
  const r = await detectProxy({ candidates: ['http://127.0.0.1:1'], probe: async () => ({ ok: false, error: '连不上' }) });
  assert.equal(r.url, '');
  assert.equal(r.tried.length, 1);
  assert.equal(r.tried[0].error, '连不上');
});

test('探测缓存：TTL 内不重复探测，force 时强制重探', async () => {
  const state = createProxyState();
  const cfg = normalizeProxyConfig({ detectMinutes: 10 });
  let probes = 0;
  const probe = async () => { probes += 1; return { ok: true, status: 200 }; };
  const candidates = ['http://127.0.0.1:10809'];

  const first = await ensureDetected(state, cfg, { probe, candidates, now: 1_000_000 });
  assert.equal(first.cached, false);
  assert.equal(probes, 1);

  const second = await ensureDetected(state, cfg, { probe, candidates, now: 1_000_000 + 60_000 });
  assert.equal(second.cached, true, '10 分钟内应当命中缓存');
  assert.equal(probes, 1);

  await ensureDetected(state, cfg, { probe, candidates, now: 1_000_000 + 11 * 60_000 });
  assert.equal(probes, 2, '超过 TTL 应重探');

  await ensureDetected(state, cfg, { probe, candidates, now: 1_000_000 + 11 * 60_000 + 1000, force: true });
  assert.equal(probes, 3, 'force 应无视缓存');
});

test('探测缓存：并发调用共享同一次探测（不重复打端口）', async () => {
  const state = createProxyState();
  const cfg = normalizeProxyConfig({});
  let probes = 0;
  const probe = async () => { probes += 1; await new Promise((r) => setTimeout(r, 30)); return { ok: true, status: 200 }; };
  await Promise.all([
    ensureDetected(state, cfg, { probe, candidates: ['http://127.0.0.1:10809'] }),
    ensureDetected(state, cfg, { probe, candidates: ['http://127.0.0.1:10809'] }),
    ensureDetected(state, cfg, { probe, candidates: ['http://127.0.0.1:10809'] }),
  ]);
  assert.equal(probes, 1);
});

test('快照：给面板的字段齐全（含候选列表与逐项探测结果）', () => {
  const state = createProxyState();
  state.detectedUrl = 'http://127.0.0.1:10809';
  state.tried = [{ url: 'http://127.0.0.1:10809', ok: true, error: '' }];
  const snap = proxySnapshot(state, normalizeProxyConfig({ mode: 'auto' }));
  assert.equal(snap.mode, 'auto');
  assert.equal(snap.detectedUrl, 'http://127.0.0.1:10809');
  assert.equal(snap.activeUrl, '', 'auto 模式下「当前出口」是直连');
  assert.ok(snap.candidates.length > 0);
  assert.equal(snap.tried.length, 1);
});

test('读配置：settings 里没有 outboundProxy 时用默认值', () => {
  assert.equal(readProxyConfig({}).mode, 'auto');
  assert.equal(readProxyConfig({ outboundProxy: { mode: 'always' } }).mode, 'always');
});

// ---------------- B. CONNECT 隧道（真实网络） ----------------

/** 起一个真的会转发 CONNECT 的本地 HTTP 代理 */
async function startConnectProxy() {
  const seen = [];
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end('only CONNECT'); });
  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = String(req.url).split(':');
    seen.push(req.url);
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const kill = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('error', kill);
    clientSocket.on('error', kill);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port, seen };
}

/** 起一个本地 HTTPS 目标，原样回报收到的路径与鉴权头 */
async function startTlsTarget() {
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const out = JSON.stringify({
        path: req.url, method: req.method, auth: req.headers.authorization || '', body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

test('proxiedFetch：走 CONNECT 隧道能真正取到内容，且请求头原样送达', async () => {
  const proxy = await startConnectProxy();
  const target = await startTlsTarget();
  try {
    const url = `https://127.0.0.1:${target.port}/v1/chat/completions?x=1`;
    const up = await proxiedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'demo' }),
    }, { proxyUrl: `http://127.0.0.1:${proxy.port}` });

    assert.equal(up.status, 200);
    const data = await up.json();
    assert.equal(data.path, '/v1/chat/completions?x=1');
    assert.equal(data.method, 'POST');
    assert.equal(data.auth, 'Bearer test-key');
    assert.equal(data.body, '{"model":"demo"}');
    assert.equal(proxy.seen.length, 1, '应当恰好建立一条隧道');
    assert.equal(proxy.seen[0], `127.0.0.1:${target.port}`);
  } finally {
    proxy.server.close(); target.server.close();
  }
});

test('proxiedFetch：返回的是标准 Response（.ok / .text() / body.getReader 都能用）', async () => {
  const proxy = await startConnectProxy();
  const target = await startTlsTarget();
  try {
    const up = await proxiedFetch(`https://127.0.0.1:${target.port}/ping`, {}, { proxyUrl: `http://127.0.0.1:${proxy.port}` });
    assert.equal(up.ok, true);
    assert.ok(up.headers.get('content-type').includes('application/json'));
    assert.ok(up.body && typeof up.body.getReader === 'function');
    await up.body.cancel();   // 不读完就取消，不应抛错
  } finally {
    proxy.server.close(); target.server.close();
  }
});

test('proxiedFetch：proxyUrl 为空 = 纯透传（等价原生 fetch，不碰代理）', async () => {
  const proxy = await startConnectProxy();
  const target = await startTlsTarget();
  try {
    const up = await proxiedFetch(`https://127.0.0.1:${target.port}/direct`, {});
    assert.equal(up.status, 200);
    assert.equal(proxy.seen.length, 0, '直连时不该经过代理');
  } finally {
    proxy.server.close(); target.server.close();
  }
});

test('proxiedFetch：http 目标不走隧道，交回原生 fetch', async () => {
  const plain = http.createServer((_req, res) => { res.writeHead(200); res.end('plain'); });
  plain.listen(0, '127.0.0.1');
  await once(plain, 'listening');
  const proxy = await startConnectProxy();
  try {
    const up = await proxiedFetch(`http://127.0.0.1:${plain.address().port}/x`, {}, { proxyUrl: `http://127.0.0.1:${proxy.port}` });
    assert.equal(await up.text(), 'plain');
    assert.equal(proxy.seen.length, 0);
  } finally {
    plain.close(); proxy.server.close();
  }
});

test('proxiedFetch：代理拒绝 CONNECT 时给出可读的错误', async () => {
  const refusing = http.createServer();
  refusing.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  });
  refusing.listen(0, '127.0.0.1');
  await once(refusing, 'listening');
  try {
    await assert.rejects(
      () => proxiedFetch('https://example.com/', {}, { proxyUrl: `http://127.0.0.1:${refusing.address().port}` }),
      /代理拒绝建立隧道/,
    );
  } finally {
    refusing.close();
  }
});

test('proxiedFetch：代理端口没人监听时抛错（供上层决定是否换家/换代理）', async () => {
  // 先拿一个空闲端口再关掉，确保没人监听
  const tmp = net.createServer(); tmp.listen(0, '127.0.0.1'); await once(tmp, 'listening');
  const deadPort = tmp.address().port; await new Promise((r) => tmp.close(r));
  await assert.rejects(() => proxiedFetch('https://example.com/', {}, { proxyUrl: `http://127.0.0.1:${deadPort}` }));
});

test('probeProxy：隧道通就算可用（不要求状态码是 2xx）；端口没人监听则不可用', async () => {
  const proxy = await startConnectProxy();
  const target = await startTlsTarget();
  try {
    const ok = await probeProxy(`http://127.0.0.1:${proxy.port}`, `https://127.0.0.1:${target.port}/`);
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);

    const tmp = net.createServer(); tmp.listen(0, '127.0.0.1'); await once(tmp, 'listening');
    const deadPort = tmp.address().port; await new Promise((r) => tmp.close(r));
    const bad = await probeProxy(`http://127.0.0.1:${deadPort}`, `https://127.0.0.1:${target.port}/`, { timeoutMs: 2000 });
    assert.equal(bad.ok, false);
    assert.ok(bad.error);
  } finally {
    proxy.server.close(); target.server.close();
  }
});
