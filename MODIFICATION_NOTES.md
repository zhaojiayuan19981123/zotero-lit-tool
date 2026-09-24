## v1.19.0：新增「学位论文阅读」——长文档检索增强问答 + 章节书签栏（2026-09-24）

方案文档见 `docs/学位论文阅读-方案.md`（含用户拍板的四个决定：进度自动算 / 评级手点 /
支持分类 / 做对比阅读与关联大论文）。核心命题：**学位论文动辄十几万字，整本塞不进模型**，
所以必须「先定位、再回答」。

### 一、新增文件（后端）

- **`src/thesisPdf.js`** —— 用 `unpdf` 按页取文本 + 读内嵌书签。
  - `readThesisPdf(file)` → `{ pages:[{page,text}], totalPages, charCount }`；
  - `readOutline(file)` → pdf.js `getDocumentProxy().getOutline()`，把 `dest` 解析成**真实页码**
    （`getPageIndex(ref)` 拿到的是 0 基，返回时要 +1）。
  > 踩坑：早期版本对 `dest` 的形态做了「对象 / 引用」两分支判断，但两个分支写法完全一样 ——
  > 其实是同一个调用，删掉多余分支。
- **`src/thesisOutline.js`** —— 章节识别，**三级兜底**：内嵌书签 → 目录页 → 标题正则。
  - 产出 `[{title, page, level, endPage, children}]` 的目录树 + `source` 说明用了哪一级；
  - `toTree()` 建树，`chapterAt(items, page)` 按页取所属章节（书签栏高亮与「你在第几章」都靠它）；
  - 「我的书签」与自动目录**共用同一份数据**，所以书签栏只有一个渲染路径。
  > 踩坑：目录页识别阈值一开始偏严（要求连续多行都像目录项），真实的跨页目录常常只有几行，
  > 会漏掉；改成「出现『目录/Contents』字样即可开闸，之后按 4 分阈值计」。另外 `chapterAt`
  > 对超出总页数的入参**返回最后一个章节**而不是 null（UI 上显示最后一章比显示「无」更有用）。
- **`src/thesisIndex.js`** —— 分块 + 中文 2-gram BM25，**零新依赖、纯本地**。
  - 按章节切 **700 字**块（带 80 字重叠），`tokenize()` 中文按 2-gram、拉丁按词；
  - 纯停用字组成的 bigram（「的了」「是在」）丢弃；**2–6 字的短词整块再保留一份**，
    提升术语精确命中的权重；
  - `search(index, query, {topK})` 返回带页码与章节的命中段。
  > 为什么不上向量库：中文 2-gram BM25 对「找章节、找概念、找原话」这类高频问法足够，
  > 且不联网、不花钱、不需要额外依赖；embedding 钩子预留但默认关闭。
- **`src/thesisContext.js`** —— 长上下文的组装核心。
  - 送进模型的是四块：**档案卡 + 章节目录树（带页码）+ 当前位置章节正文 + BM25 命中段**，
    再加最近 8 轮对话；
  - 预算三档 `20k / 40k / 80k` 字，`stats` 回传「送了多少字、命中几段」给前端显示；
  - `buildTaskPrompt()` 生成**本章速读 / 综述条目 / 答辩演练**三种任务提示词；
    `buildCompareMessages()` 生成对比阅读的提示词；
  - 提示词强制引用格式 **【章节标题 · p.页码】**，并要求「检索不到就直说没检索到」。
  > 踩坑：`isLocalQuery()` 最初写的是「这段」，而用户实际会说「这**一**段」，指代词漏判 →
  > 局部提问会走全文检索。已补全「这一页 / 这一节 / 这本」等说法。
- **`src/thesisFields.js`** —— 字段清单：`THESIS_AI_FIELDS`（AI 读前 3 页填的 17 个）、
  `THESIS_USER_FIELDS`（只由用户写的 `myThoughts` / `referenceValue`），以及抽取提示词。
- **`src/thesisStore.js`** —— 独立数据文件 `theses.json` + 分类 + 索引缓存 + 素材库 + 大论文信息。
  - **`PATCH_WHITELIST`**：白名单外的字段一律丢弃（`filePath` / `status` 这类只能服务端维护）。
  - `patchThesis` 对 `bookmarks` 做结构校验（只留合法 `{id,page,note}`，页码取整、备注限 300 字）。
  - `deleteThesis` 连带清索引与素材摘录。
- **`src/thesisRoutes.js`**（通过 `registerThesisRoutes(app, ctx)` 注册，server.js 只加一行）——
  `/api/theses` 系列共 30 条路由：记录增删改查、分类、附件上传、前 3 页解析、批量解析、
  建索引、章节树、按页取文、问答（SSE）、速读 / 综述 / 答辩（SSE）、对比阅读（SSE）、
  素材库、大论文信息、统计。

### 二、新增文件（前端）

- **`public/thesis.css`** —— 表格页 + 阅读器 + 书签栏 + 弹窗的独立样式，复用既有主题变量。
- **`public/thesis.js`**（IIFE，对外只暴露 `window.ThesisView = { mount, open }`）——
  - **表格页**：10 列默认显示，其余进「▦ 字段配置」；星级评分手点、进度条自动算、
    就地编辑标题/作者/学校/我的思考/参考价值；分类筛选条、搜索、排序、批量解析 / 批量删除 / 批量改分类。
  - **阅读器**：`pr` 那套阅读器**完全没有复用**（paper 模式零改动），这里是独立实现；
    - 左侧书签栏（章节树 + 页码 + 滚动自动高亮 + 我的书签 + 搜索 + 添加）；
    - 右侧只有**「解析结果」与「AI 对话」两个页签** —— 按要求不做划词/全文翻译；
    - 笔记模式三栏「原文 ｜ AI 对话 ｜ 笔记」，`/api/paper-notes/:id` 与文献中心共用存储；
    - 划词浮条三动作：用这段提问 / 加入素材库 / 追加到笔记；
    - `【… · p.N】` 渲染成 `span.src[data-page]`，点击跳页。
  - **写作支撑**：素材库抽屉（导出 Markdown）、章节速读 / 综述条目 / 答辩演练、
    对比阅读（勾 2–5 篇 + 导出）、我的大论文。

### 三、接线改动

- `public/index.html`：左侧「研究工作」下新增 `data-view="thesis"` 导航项；
  新增 `<section id="viewThesis">` 挂载点（内容由 `buildDom()` 生成）；
  引入 `thesis.css` / `thesis.js`。
- `public/app.js`：`switchView` 的视图映射加 `thesis: 'viewThesis'`；
  主区加 `.main-area.th-mode`（表格内部滚动）；`v === 'thesis'` 时调 `window.ThesisView.mount()`。
- `server.js`：`import { registerThesisRoutes }`，在 `createApp` 内（`upload` 作用域里）注册。
  > 踩坑：第一次把注册代码插到了 `createApp` 之外，`upload` 未定义直接抛错；`upload` 是
  > `createApp` 内的局部变量，必须插在作用域里。

### 四、本轮修掉的真问题（都补了回归测试或 E2E 断言）

| 问题 | 根因 | 后果 |
| --- | --- | --- |
| 加书签点了没反应 | `bookmarks` 没进 `PATCH_WHITELIST` | PATCH 被**静默丢弃**，界面毫无反馈 |
| 「回到上次读到的位置」失效 | `buildPages()` 清空容器 → `scrollTop` 归零 → 触发一次 `scroll`，此时 `R.doc` 已是新文档但 `R.pageH` 还是旧值，页码被算成 1 并覆盖真实位置 | 每次重开都回到第 1 页 |
| 笔记可能丢字 | 笔记保存与阅读位置记录**共用 `R.saveTimer`** | 滚动会把防抖中的笔记保存取消掉 |
| 从素材库跳进阅读器拿不到记录 | 缺 `GET /api/theses/:id`（落到前端兜底，返回网页首页） | 打不开论文 |
| 删除论文留下孤儿数据 | 笔记 / 对话没跟着删 | 数据文件里堆永远看不到的记录 |
| 素材库导出的是空文件 | `#thqExport` 绑了**两个** click 处理函数，第一个下载空内容 | 导出的 md 是空的 |
| 加书签用了 `window.prompt` | Electron 渲染进程**禁用 prompt**（调用直接抛错） | 打包版点「加书签」会炸 |

两条修法的要点：

1. **位置记录**：`buildPages()` 开头把 `R.pageH` 归零 —— `currentVisiblePage()` 里本来就有
   「`pageH` 为 0 就直接返回当前页码」的兜底，于是重建期间不再误判；`scroll` 监听再加一道
   `if (!R.doc) return`（关闭阅读器时容器隐藏也会触发一次 scroll）。
2. **定时器**：笔记改用独立的 `R.noteTimer`；`closeReader()` 里 `clearTimeout(noteTimer)` +
   `saveNote()` + `saveReadPos(true)`，把两个防抖队列都落盘。

### 五、测试

- 新增单测：`thesis-outline`（章节识别，含越界与英文标题形态）、`thesis-index`（分词 / BM25 / 排序）、
  `thesis-context`（预算裁剪 / 局部提问 / 任务提示词）、`thesis-store`（白名单 + 书签校验 + 分类 + 统计）、
  `thesis-http`（**真实 PDF**：上传 → 解析前 3 页 → 建索引 → 章节树 → 问答上下文 → 对比阅读 →
  单条读取 → 书签与阅读位置 → 删除连带清理）。
- 全量单测 **341/341**（v1.18.0 为 278，本轮 +63）。
- `verify-thesis.mjs`（新增，**真机 Chromium + 真实 HTTP + 真实 PDF**）**67/67**。
- 既有回归：`verify-features.mjs` **75/75**、`verify-router-panel.mjs` **52/52**，无回退。

## v1.18.0：修「能用的模型被判成用不了」+ 新增本地 OpenAI 兼容端口与出站代理 + 精简 AI 设置界面（2026-09-24）

### 一、根因：推理模型被「30 秒写死超时」误判成不可用

用户反馈「好几条模型还是用不了」。用 curl 逐条打到上游实测后确认：**模型本身都是好的**，
是判定方式错了 —— 测速走的是**非流式**，等整段回答；而 `gpt-5.x` / `o` 系列这类**推理模型**
要先「想」很久才吐字（实测非流式 > 80 秒、流式首字节 41 秒），原 `/api/models/test` 与
`/api/router/probe` 都写死 `timeoutMs: 30000`，于是一条好模型被判成超时。

修法两条腿：**判定方式**换成流式首字判定；**超时**从写死改成可配。

### 二、新增文件

- **`src/streamProbe.js`** —— 流式首字判定。
  - `judgePayloadText(text, { contentType, partial })` 判断一段上游内容属于
    SSE / JSON / 网页 / 空；**`partial` 时若「看不出结论」返回 `{ok:false, error:''}`**
    让调用方继续读，而不是把「还没读全」误判成失败（这是最容易写错的一处）。
  - `readFirstPayload(up, { timeoutMs })` 读到**第一个有效数据块**就返回并 `reader.cancel()`，
    不再等整段回答。
- **`src/proxiedFetch.js`** —— 零依赖 HTTP 代理（CONNECT 隧道）。
  - `proxiedFetch(url, init, { proxyUrl, timeoutMs })`：`proxyUrl` 为空时**纯透传原生 fetch**；
    非空时自己用 `node:http` 发 CONNECT、`node:tls` 握手，再把 node 响应包成标准 `Response`
    （`Readable.toWeb`），从而和既有 `readLLMResponse` 完全兼容。
  - **https 目标一律做隧道，不限定端口**（早期按 443/8443 白名单写过一版，会漏掉自建网关端口）。
  - `probeProxy()` 只关心「能不能连通」：401/404 也算通。
- **`src/outboundProxy.js`** —— 代理配置与自动探测。三模式 `auto` / `always` / `off`；
  `DEFAULT_PROXY_CANDIDATES` 按常见度排序（10809 / 7890 / 10808 / 1080 / 2080 / 8889 / 20171）；
  `ensureDetected()` 带 TTL 缓存 + `detecting` 并发去重；`shouldRetryWithProxy()` **只认网络层错误**
  （超时不重试 —— 上游慢，换代理没用，只会让用户多等一倍）；`proxyForRequest()` 里 **`off` 优先级最高**，
  其次是手填 `url`。
  > 踩坑：`ensureDetected` 里 `lastDetectAt` 一开始记的是 `Date.now()`，而 TTL 判断用的是**注入的** `now`，
  > 两把时钟不一致导致单测里缓存永不命中。改成 `state.lastDetectAt = now`。
- **`src/localGateway.js`** —— 本地 OpenAI 兼容端口的 HTTP 管道。
  - `normalizeGatewayConfig` 里 **`host` 恒定 `127.0.0.1`、不可配**（不暴露到局域网，避免被人白用 Key）。
  - `normalizeMessages`：`content` 支持字符串与 `[{type:'text',text}]` 分片数组（很多客户端这么发）、
    丢弃空内容消息（空 content 会让 Responses API 直接报参数非法）、`developer` 降级为 `system`、`tool` 跳过。
  - `pickProfileByModel`：模型名 / 配置 id / 显示名 / 带厂商前缀（`openai/gpt-5.6`）都能认。
  - `createChunkWriter` 输出标准 `chat.completion.chunk`，`finish()` 后由调用方 `done()`，
    中途出错也能补一个 error 事件再收尾。
  - 该模块**只做管道**（路由 / CORS / 解析 / 错误形状），「怎么调模型」由注入的 `handleChat` 决定 ——
    于是能脱离 `server.js` 单测。

### 三、改动（`server.js`）

- `src/modelRouter.js`：`ROUTER_LIMITS.timeoutSeconds = [10, 900]`，`DEFAULT_ROUTER_CONFIG.timeoutSeconds = 120`，
  新增 `requestTimeoutMs(config)` 统一换算成毫秒。
- 新增 `currentRequestTimeoutMs()`：从 `settings.modelRouter` 读超时预算；
  `fetchModelCompletionOnce` 的 `timeoutMs` 默认 0 → 用它。超时错误文案改为**提示去高级设置调大超时**
  （而不是干巴巴一句「超时」）。
- 新增 `modelFetch(url, init)`：直连优先，**直连出现网络层错误时**才走探测到的本地代理重试一次；
  `fetchModelCompletionOnce` 内的 `fetch(...)` 全部换成它。
- `/api/router/probe` 重写为**流式首字判定**：`stream:true` + `readFirstPayload`，拿到首块即
  `reader.cancel()` / `abort()`；返回里带上 `firstChunk` 与 `timeoutMs`。仍然**不计入**熔断与用量统计。
- `/api/models/test` 两处写死的 `timeoutMs: 30000` 删除（改用默认预算）。
- 新增路由：`GET /api/proxy/status`、`POST /api/proxy/detect`、`GET /api/gateway/status`、`POST /api/gateway/restart`。
- 流式输出抽了一层 **sink**：`pipeLLMStream(up, sink, ...)` + `resSink(res)`，
  于是 `streamModelResponse(..., { sink })` 既能写 `res`，也能写本地端口的 SSE chunk。
- 新增 `gatewayChat()`：`model` 命中某条配置就用它作主供应商，否则用激活模型；`stream:true` → 标准 SSE chunk，
  `stream:false` → 标准 `chat.completion`；**故障转移完全复用 `streamModelResponse` / `fetchModelCompletion`**，
  决策逻辑一行都没复制。
  > 踩坑（集成测试抓出来的真 bug）：`fetchModelCompletion` 返回的是**请求句柄** `{ up, cancel, abort }`，
  > 真正响应在 `.up` 上。这里一开始直接当成 `Response` 用，导致非流式调用永远 502
  > （`up.text is not a function`）。单测覆盖不到，只有真起端口 + 真 fetch 才能发现。
- `startServer` 新增 `startGateway = false`（**默认不启**，避免测试/多实例抢 15721；
  桌面版 `electron/main.cjs` 与 CLI 显式传 `true`）。
- `/api/settings` POST 归一化 `outboundProxy` / `localGateway` 并即时生效（改代理触发重探、改端口触发重启）。

### 四、修掉两个隐形问题

1. **失败的尝试不释放超时定时器**（`fetchModelCompletion` 路由版）：
   每次尝试都会 `setTimeout(…, budgetMs)`（默认 120 秒，最大 900 秒），换下一家时没清掉，
   失败几次就留几个「到点 abort」的定时器，进程/桌面端要干等它到期。
   修法：循环开头把**上一轮失败留下的句柄** `cancel()` + `abort()`，只保留**最后一份**给调用方读错误详情
   （`endpointFailureMessage` 要用）。用 `scripts/probe-failover-exit.mjs` 把 `timeoutSeconds` 设成 600
   做回归：修之前进程被拖 20 秒以上，修之后 1.7 秒自行退出。
2. **出站代理已关 / 已手填地址时仍去探测**：`startServer` 的后台探测会挨个连七、八个候选端口（各带超时），
   白等十几秒。现在这两种情况下直接跳过；启动定时器也补了 `unref()`。
   （面板上的「重新检测」仍然**一定真探** —— 那是用户在问「我本机到底有没有可用代理」，跳过等于骗他。）

### 五、改动（前端 `public/index.html` / `style.css` / `app.js`）

- **默认只留两块**：`🧩 已配置的模型`（新增 `#btnMlCheckup`「🔌 一键体检」+ `#mlCheckupResult`）
  与新增的 `🌐 本地端口` 区块（`#gwEnabled` / `#gwPort` / `#btnGwApply` / `#btnGwCopy` / `#gwStatus` / `#gwBaseURL`）。
- **两段式看图 + 模型路由整块移进 `<details id="advSettings">`（默认折叠）**，
  并与新的「请求与网络」（`#rtTimeoutSeconds` + 出站代理 `#pxMode` / `#pxUrl` / `#btnPxDetect` / `#pxTried`）同处其中。
  底部按钮改为「保存高级设置」，一次保存路由 + 代理 + 网关三组配置。
- 删除旧的 `#btnRtProbe` / `#rtProbeResult`（被「一键体检」取代）。
- `app.js`：`probeRouter` 改读新按钮/容器并**先把所有模型列成「测试中」**（用户能立刻看到在干什么）；
  新增 `loadGatewayStatus` / `renderGateway` / `applyGateway` / `loadProxyStatus` / `renderProxy` /
  `saveProxyConfig` / `detectProxyNow`。

### 六、测试

- 单元测试 **278 项全绿**（v1.17.0 基线 224，本轮新增 54）：
  `test/stream-probe.test.mjs` 11、`test/outbound-proxy.test.mjs` 19（含真实 CONNECT 隧道，自签证书）、
  `test/local-gateway.test.mjs` 21、`test/local-gateway-e2e.test.mjs` 2（真起端口 + 真 fetch + 真故障转移）、
  `test/router-timeout-leak.test.mjs` 1（子进程判据）。
- 既有浏览器功能回归 **75 项全绿**，无回退。
- 真机端到端 `verify-router-panel.mjs` 从 36 项扩到 **52 项全绿**，新增覆盖：
  默认精简 + 高级折叠、一键体检逐条结论、本地端口真的在监听、**页面里跨域直接调用该端口能拿到内容**
  （顺带验证 CORS 与 `OPTIONS` 预检）、`/v1/models` 给出的名字填回去能被认出来。
- 写测试时的两个坑（已固化）：
  - `server.close()` 会等 keep-alive 空闲连接到期（默认 5 秒），几个 mock 上游叠起来白等二十秒 →
    `close()` 里补 `closeAllConnections?.()`。
  - `fetch` 默认复用连接，容易在「服务端已关」时报 `fetch failed` → 统一带 `Connection: close`。

### 七、说明

- 判定方式的改动**只影响判定**，没有改动任何既有 AI 调用路径的对外行为；模型配置无需重填。
- 本地端口默认开启但**只绑回环**；默认端口 15721，可改，关掉即释放，被占用时面板会明确指出并建议换端口。

## v1.17.0：新增「模型路由」（多条模型配置互为备份 + 故障转移 + 熔断 + 用量面板）（2026-09-24）

### 一、为什么做

借鉴 [cc-switch](https://github.com/farion1231/cc-switch) 的「路由服务」思路。此前本应用**一个时刻只认一条模型配置**，
那条中转一旦抽风（429 / 5xx / 超时 / 网关返回网页首页），所有 AI 功能一起挂，且用户只能手动去设置里换配置。
本版把**已保存的多条模型配置**组织成一条优先级队列，请求失败自动往后换，把「手动救火」变成「自动兜底」。

### 二、新增文件：`src/modelRouter.js`（路由内核，纯函数）

只做**决策与记账**，不碰网络；**所有时间点由参数 `now` 注入**，熔断状态机才能在单测里被精确验证、不靠 sleep。

- 熔断状态机三态：`closed`（正常）/ `open`（熔断中）/ `halfOpen`（半开试探）；
  连续失败达 `failThreshold` **或** 错误率超 `errorRate`（且请求数 ≥ `minRequests`）即触发熔断；
  冷却 `openSeconds` 后转半开，连续成功 `recoverSuccess` 次恢复 `closed`。
- `planCandidates()`：主供应商在前，备用按 `queue` 顺序；熔断中的跳过并计 `skipped`；
  **全部熔断时 `forced:true` 仍按序强制尝试**（宁可试一次，也不要直接对用户报「全部不可用」）。
- 视觉对齐：主供应商需要看图（vision）时，备用里只保留支持视觉的，避免「换了一家却看不了图」。
- `DEFAULT_ROUTER_CONFIG`：`enabled:true`、`failover:true`、`queue:[]`、`retryPerProvider:0`、`logLimit:200`、
  `breaker:{ failThreshold:4, recoverSuccess:2, openSeconds:60, errorRate:60, minRequests:10 }`。
  **队列为空时行为与「不开路由」完全一致**（只有主供应商一个候选），统计与健康面板立即开始工作。
- `clampInt()`：`null / undefined / 空串 / 非数值文本` 一律**回落默认值**，而不是被 `Number()` 悄悄变成 `0`
  （`null → 0` 会让「恢复成功阈值」变成 1，与默认不符）。这是本轮单测抓到的一个真实缺陷。
- `ensureId()`：给「临时配置」（如 `POST /api/models/test` 传来的、没有 id 的配置）补一个稳定 id，
  否则它会在候选规划阶段被当成「不在配置表里」而过滤掉。

### 三、改动（`server.js`）

1. 原 `fetchModelCompletion` / `streamModelResponse` 拆成两层：
   - `fetchModelCompletionOnce` / `streamModelResponseOnce` —— **单条配置**版本（原逻辑原样保留）；
   - `fetchModelCompletion` / `streamModelResponse` —— **路由**版本，先 `planCandidates()` 再逐家尝试。
   **对外签名不变**（`streamModelResponse(am, {...}, res)`），全站调用点零改动。
2. **换供应商时用那家自己的 model 名**（`bodyForCandidate()`），不会把 A 家的模型名发给 B 家。
3. **流式故障转移的硬约束**：一旦已向客户端写出 token，就**不再换供应商**（SSE 响应体已经开始输出），
   只在「还没吐字」时切换；既有的「流式失败 → 退非流式重试」兜底保持原样。
4. 失败时报错**逐家列出原因**（`up._litProviderFailures`），而不是只抛最后一家。
5. 新增接口：
   - `GET  /api/router/status` —— 配置 + 实时统计（总请求 / 成功率 / 活跃连接 / 运行时间 / 每家健康 / 日志）
   - `POST /api/router/config` —— 保存配置，**即时生效**
   - `POST /api/router/reset` —— 重置统计（可选保留熔断状态）
   - `POST /api/router/probe` —— 批量测速，**不计入熔断**（纯探测）
6. `/api/settings` POST 增加 `modelRouter` 归一化；`routerProfileList` 列出全部配置（未填 Key 的标 `hasKey:false`）。

### 四、改动（前端 `public/index.html` / `style.css` / `app.js`）

设置面板新增「模型路由」区块：总开关、自动故障转移开关、**状态卡片**（总请求 / 成功率 / 活跃连接 / 运行时间）、
**故障转移队列**（加 / 删 / 上移下移）、**熔断与重试参数**（折叠）、**各供应商健康列表**（标「主模型 / 备用 N」、
请求数 / 成功 / 失败 / 成功率 / 最近耗时 / 最近错误）、**请求日志**（折叠，最近 200 条）。
弹窗打开时自动加载并每 4 秒刷新，**关闭弹窗自动停表**。

### 五、测试

- 新增 `test/model-router.test.mjs`（**33 条**）：熔断三态迁移、连续失败 / 错误率两条触发路径、
  半开恢复、`forced` 强制尝试、队列规划与视觉过滤、配置钳制（含 `null` 回落）、重置语义等。
- 新增 `test/router-failover-http.test.mjs`（**2 条** HTTP 集成）：mock 上游验证
  「主 500 → 自动切备用并返回备用内容」「熔断生效且失败原因逐条列出」「关掉开关退化为单供应商」。
- 单元测试 **224/224 全绿**（189 + 35）。
- **变异验证**：改坏 `canUse()` 捕获 **6 条**断言，改坏错误率分支捕获 **1 条** —— 确认熔断断言非空。
- **真机端到端**（`verify-router-panel.mjs`，真实 Chromium + 真实 HTTP + mock 上游）**36/36 全绿**：
  面板渲染 / 队列与熔断参数回填 / 主 500 自动切备用并如实返回内容 / 统计与日志反映转移 / 队列增删与落库 /
  关闭开关后不再切换且如实报错 / 重置归零 / 全程无 JS 报错。
- 既有浏览器功能回归 **75/75 无回退**。

### 六、说明

- 路由**只服务本应用**，不对外暴露本地代理端口。
- 默认配置**不需要用户做任何事**：不填队列 = 只用主模型（与升级前一致）；想用故障转移，把备用模型加进队列即可。

---

## v1.16.5：修「论文对话第二轮起报 400」（Responses 入参角色感知 + 端点失败原因不再被顶掉）（2026-09-24）

### 一、根因：assistant 消息被写成了 `input_text`

- 走 Responses API 的模型要求 assistant 只能用 **`output_text`**（或纯字符串）；旧代码对所有角色一律用 `input_text`。
- 于是**上一轮的回答**成为非法入参 → 报错 `param: input[1].content[0]`，症状固定是「第一轮通、第二轮挂」。
- 旧代码在端点之间重试时用宽正则换端点，**把第一个端点的真实报错丢掉**，用户看到的是第二个端点的参数校验错误。

### 二、改动（`server.js`）

1. **`responsesInput()` 角色感知**：
   - assistant → 优先 `output_text` 片段，或**纯字符串**（兼容面最广）；
   - user / system → `input_text`；
   - 用 `assistantStyle`（`RESPONSES_ASSISTANT_TEXT` / `RESPONSES_ASSISTANT_OUTPUT_TEXT`）表达两种写法；
   - 上游若报「不支持该 content part」（`isResponsesPartError`），自动 `flipAssistantStyle` **换另一种写法重试一次**。
2. **端点尝试与失败汇总重写**：
   - `buildEndpointAttempts()` 按 `apiFormat`（auto 时 chat→responses）+ Base URL 前缀组合出候选端点；
   - `fetchModelCompletion()` 逐个尝试，**每个端点的失败都进 `failures`**；
   - `describeEndpointFailures()` 汇总输出：`路径 → HTTP 状态：明细`，一条不丢；
   - 只有「端点不对」（含网关首页那种 **HTML 响应**）才继续换端点，其它错误立刻停手保留真实原因；
   - `isHtmlResponse()` 识别「状态码 200 但返回的是网页」→ 提示 Base URL 可能少写 `/v1`。
3. **Base URL 归一化**：`catalog.normalizeBaseURL()` 配合端点前缀推导，覆盖「少写 /v1 返回网关首页」的情况。
4. **空内容消息丢弃**：`content` 为空字符串 / 空数组的历史消息不再进入 `input`。
5. **失败兜底不破坏流式回退**：失败明细挂到 `up._litErrorText`，由上层决定「流式失败→非流式」「每端点原因汇总」，不再改变既有回退语义。

### 三、改动（`public/app.js`）

- 论文对话与主 AI 助手两处错误文案：去掉重复的 `请求失败：` 前缀（前端与后端各加过一次）。

### 四、测试

- 新增 `test/responses-api-compat.test.mjs`（6 条）：mock 上游，覆盖
  「assistant 必须是 output_text / 纯字符串」「不支持的 part 自动换写法」「Base URL 少 /v1 时识别网页响应并重试」
  「空内容消息被丢弃」「多端点失败原因全部列出」。
- 单元测试 **189/189**；变异验证：回退成旧写法 → 恰好 3 条失败，报错即 `input[1].content[0]`。
- 真机对照（本机真实 8 条配置 + 2 条显式 `/responses`）：**改前 5/10 失败 → 改后 10/10 成功**
  （脚本 `C:\Users\zjy1998\.workbuddy\zotero-lit-e2e\verify-paper-chat-400.mjs`）。
- 浏览器功能回归 **75/75**。

---

## v1.16.4：修思维导图滚轮缩放方向 + 修「复制译文粘贴成一坨 JSON」（2026-09-23）

### 一、Ctrl + 滚轮：下滑缩小、上滑放大

- `public/app.js` 的 `renderPnMind()` 里 `mousewheelZoomActionReverse` 由 `false` 改为 **`true`**。
- ★ 这个选项名与行为**是反的**，改之前请先读 `public/vendor/simple-mind-map/INTEGRATION_NOTES.md` 第 10 条：
  库源码是 `mousewheelZoomActionReverse ? this.enlarge() : this.narrow()`，作用在「滚轮向上 / 向左」这一支上，
  而且**默认值就是 `true`**。上一版显式写 `false`，等于把默认行为反了过来，于是「Ctrl+下滑」变成了放大。
- 实测对照（真实 Chromium + `page.mouse.wheel`）：`false` → 下滑 154→185px（放大）；`true` → 下滑缩小、上滑放大。
- `mousewheelAction: 'move'` 保持不变：不按 Ctrl 平移、按住 Ctrl 缩放（不按 Ctrl 不会误缩放）。

### 二、粘贴译文变成 `{"simpleMindMap":true,…}`

**复现路径**：在导图画布内选中节点（按过 Ctrl+C）→ 到中栏复制译文 → 回导图双击节点进编辑 → Ctrl+V，
节点文字里出现整段 JSON（用户截图的现象）。

**根因（真实浏览器复现 + 读库源码确认）**：

1. 库 `copy()` 在画布内 Ctrl+C 时用 `createSmmFormatData()` + `setDataToClipboard()`，
   把 `{"simpleMindMap":true,"data":[…]}` 写进剪贴板的 **text/plain**；
2. 库对**普通**文本编辑框有兜底（`textEditNode` 的 paste 里 `checkSmmFormatData` + `getTextFromHtml`），
   但**富文本（RichText / quill）编辑框这条路径没有**：quill 的 `Clipboard.convert()` 在
   「没有 html、只有 text」时直接 `delta.insert(text)`，不经过 smm 注册的 matcher → 整段 JSON 进节点。

**修法**：

- `public/paper-note-utils.js` 新增两个**纯函数**（便于单测）：
  - `smmClipboardToPlainText(raw)`：识别导图数据并抽出纯文字（前序遍历，含多层）；不是导图数据返回 `null`（放行默认粘贴）；
  - `appendMindmapChild(root, targetUid, text)`：返回**新树**（不修改入参），找不到目标 uid 时挂到根节点，保证「点了总有反应」。
- `public/app.js`：
  - 在 **`document` 捕获阶段**拦 paste：命中导图编辑框（`.smm-richtext-node-edit-wrap / .smm-node-edit-wrap / .ql-editor`）
    且内容为导图数据时，`preventDefault` + `stopPropagation`，改用 `document.execCommand('insertText')` 写入；
    ★ 必须走 execCommand（会派发标准的 beforeinput/input），直接改 innerHTML 会被 quill 回滚；
    ★ 编辑框是 `appendChild` 到 `document.body` 的（或 `customInnerElsAppendTo`），**不在 `#pnMindHost` 里**，
      所以监听导图容器拦不到，必须挂 document；
  - 新增 `pnInsertTranslationToMind()`：把译文作为新节点挂到当前选中节点下。`setData` 之后**选中新节点必须在
    `render(cb)` 回调里做** —— 否则 `renderer.nodeList` 里还是上一轮的节点对象，会把库的选中态弄乱
    （实测症状：之后点节点没反应、F2 进不了编辑、Ctrl+V 失效）；
  - 中栏 `#pnSendToNote` 按钮改为**跟随右栏视图**：Markdown 视图是「→ 加入笔记」，导图视图自动变「→ 加入导图」。

### 三、测试

- `test/paper-note-utils.test.mjs` 新增 12 项：导图数据的识别与抽取（富文本标签剥离、多层遍历、畸形 JSON、
  空文字、`data` 不是数组…）、追加子节点的边界（uid 找不到回落根节点、纯函数不改入参、新 uid 唯一、非法输入返回 null）。
- 单元测试 **183/183**；做了**变异验证**（去掉 `!parsed.simpleMindMap` 判断 → 恰好 1 条断言报错，确认非空断言）；
  真实浏览器 E2E **25/25**（脚本 `C:\Users\zjy1998\.workbuddy\zotero-lit-e2e\verify-pn-mind-paste.mjs`）；
  原有功能回归 **75/75**。

### 四、写验证脚本时踩到的坑（已同步进 INTEGRATION_NOTES 第 13 条）

- 点击**已激活**的节点是 toggle（会取消激活）→ 点完要检查 `.smm-node.active` 数量，必要时补点；
- 提交编辑后旧编辑框会以 `display:none` 留在 DOM 里 → 要按 `getBoundingClientRect().width > 0` 过滤出可见的那个；
- 节点文字变长后框会变宽，自己算中心点可能落到可视区外 → 交给 Playwright 的 `locator.click()` 处理可见性最稳。

---

## v1.16.3：更新消息推送（后台自动检查 + 发现新版本时提醒，同一版本只弹一次）（2026-09-23）

本版新增：应用在后台定期检查 GitHub 上的新版本，发现更新后主动提醒，且**同一个版本只提醒一次**。

### 一、提醒的触发与方式

- **启动后 4 秒**查一次，之后**每 6 小时**查一次（`electron/main.cjs` 的 `scheduleAutoUpdateChecks` / `runAutoUpdateCheck`），全程静默，失败不打扰用户；
  后台检查失败时会把 `phase` 复位为 `idle`，避免用户在弹窗里看到一条来路不明的「检查失败」。
- 发现新版本时，按窗口状态**二选一**提醒，不会两种一起弹：
  - 窗口可见且未最小化 → 置 `pendingPrompt` 并**主动叫醒页面**，右上角浮出提醒卡片；
  - 窗口在后台 → 发**系统通知**（点击把窗口叫到前台），并立即记为已提醒。

### 二、为什么「只弹一次」放在主进程

- 判定抽成纯函数 `electron/update-prompt.cjs`：`shouldPrompt({ version, promptedVersion, pageVisible })` → `skip | in-app | system`。抽出来的目的就是**能单测**（判定表见 `test/update-notification.test.mjs`）。
- 「已提醒版本」持久化在 `userData/app-config.json` 的 `updatePromptedVersion`：
  **不用 `localStorage`** —— 后端端口是随机分配的（`startServer({ port: 0 })`），页面 origin 每次启动都变，`localStorage` 实际留不住；放主进程侧也不会污染用户数据目录与备份。
- 提醒过才算数：前台走「页面弹卡片 → 用户关闭 → `POST /api/update/prompt-ack` → `markPrompted()` 落盘」，保证**真的弹到了**才记账；后台走系统通知，发出即记账。

### 三、页面侧

- `public/index.html` 新增 `#updateNotify` 卡片（右上角，`z-index: 90`，低于弹窗 100）：显示新版本号 + 「查看更新」/「以后再说」/「×」。
- `public/app.js`：
  - `maybeShowUpdateNotify(status)` 的三重闸门：必须 `status.supported`、`phase === 'available'` 且**主进程置位 `pendingPrompt`**、并且本次运行没弹过该版本；
  - 首屏让位 2.5s 再浮出，避免和新手引导、首屏渲染抢注意力；
  - `closeUpdateNotify(openModal)`：三条关闭路径都回执一次；点「查看更新」额外打开原更新弹窗（含 Release 正文与「下载更新」）；
  - 暴露 `window.__updateStatusTick()`：主进程发现新版本后直接调用它让页面刷新状态，无需刷新页面 —— 没有 preload/IPC 通道也能做到「推送」。

### 四、服务端

`server.js` 新增 `POST /api/update/prompt-ack`：只接受字符串版本号（其余收敛为空串），转交 `updateService.ackPrompt(version)`；浏览器模式下返回 409（与其它 `/api/update/*` 动作一致）。

### 五、测试

- 单元测试 **171 项全绿**（新增 14 项）：
  - 判定表 4 项（同版本不重复弹、更高版本再弹一次、版本号缺失不提醒、前台/后台分流）；
  - 回执接口 2 项（带版本号转发、浏览器模式 409、非法类型收敛为空串）；
  - 接线断言 8 项（后台定时、落盘键名、系统通知与 `focus()`、叫醒钩子、卡片存在与层级、页面三重闸门）。
- **变异验证**：拆掉判定函数里的同版本闸门 → 2 条失败；拆掉页面侧 `pendingPrompt` 判断 → 1 条失败；拆掉主进程的 `scheduleAutoUpdateChecks()` → 1 条失败。恢复后 171/171。
- 真实浏览器端到端 **22 项断言全绿**（`~/.workbuddy/zotero-lit-e2e/verify-update-notify.mjs`）：用代理扮演主进程（返回真实字段、记录回执），验证首次弹出、查看更新、重开不再弹、运行中被叫醒即弹、出现 v1.16.4 再弹、无更新不弹，全程无 JS 报错。

### 六、边界

- 仅安装后的 Windows 桌面版具备自动更新与提醒（`updateSupported = app.isPackaged && process.platform === 'win32'`）；macOS 自动更新需 Apple 签名，仍走手动下载 DMG。
- 浏览器开发模式下 `/api/update/status` 返回 `supported:false`，页面不弹卡片。

## v1.16.2：应用图标背景改为透明（修掉深色任务栏上的白方块）（2026-09-23）

本版只修一处：图标的背景本来是**不透明白**，在深色表面上（Windows 任务栏 / 开始菜单 / 桌面快捷方式、macOS Dock、安装程序界面）会显出一块白方块。

### 一、根因：生成脚本把设计稿的透明通道丢掉了

设计稿（`D:\desktop\icon-256.png`）本身**就是透明背景**的 —— 它是带透明索引的调色板 PNG，四角像素为 `(255, 255, 255, 0)`。问题出在 `build/make-icons.py`：

1. `content_bbox()` 用 `img.convert("RGB")` 找图形范围。`convert("RGB")` 会**丢掉 alpha**，透明背景被读成纯白 —— 包围盒碰巧还对（白色本来就要裁掉），但透明信息从这里就没了；
2. `square_crop()` 用 `Image.new("RGBA", size, (255, 255, 255, 255))` 建**不透明白**画布，再用 `canvas.paste(src, box, src)` 合成。`paste` 会把传入的 mask 乘到**每一个通道**（包括 alpha 通道）上，于是半透明边缘的 alpha 变成 a² —— 边缘变暗；
3. 最终所有产物 alpha 恒为 255，背景全白。

### 二、改法（`build/make-icons.py`）

```python
# 1) 有透明通道就以 alpha 为准，不透明白底的设计稿仍走「非白」判定
if has_alpha_content(rgba):
    mask = rgba.split()[3].point(lambda v: 255 if v > ALPHA_TOL else 0)
    bbox = mask.getbbox()

# 2) 目标区域完全落在源图内就直接 crop；需要外扩则用全透明画布
if left >= 0 and top >= 0 and right <= w and bottom <= h:
    return src.crop((left, top, right, bottom))
canvas = Image.new("RGBA", (right - left, bottom - top), (0, 0, 0, 0))
canvas.alpha_composite(src, (-left, -top))   # ★ 不能用 paste(..., mask=src)
```

并新增 `check_transparent()` 自检：产物必须是 RGBA、四角 alpha 必须为 0，否则脚本**直接报错退出**（退出码 2），不再静默产出白底图标。

### 三、产物

| 文件 | 说明 | 修复后 |
|---|---|---|
| `build/icon.png` | 1024×1024 通用 | alpha (0,255)，四角 0 |
| `build/icon.ico` | Windows 多尺寸（7 帧） | 每帧为带 alpha 的内嵌 PNG |
| `build/icon.icns` | macOS | RGBA |
| `build/icon-256.png` | 预览 / 安装器 | 四角 0 |
| `public/favicon.png` | 标签页 + 界面左上角 logo | 四角 0 |
| `electron/icon.png` | 运行时窗口 / 任务栏 | 四角 0 |

### 四、回归防护

- **新增 `test/app-icons.test.mjs`**：不依赖 Pillow，直接解析 PNG 字节校验 ——
  4 个 PNG 产物必须是 RGBA 且左上角 alpha 为 0；`.ico` 的每个尺寸帧必须是带 alpha 的内嵌 PNG（16px 帧因透明内边距不足一个像素，容差 32）；并守住生成脚本里「全透明画布 + `alpha_composite`」这两处关键写法。
- **验证过该测试确实能抓到旧产物**：把 v1.16.1 的白底 favicon 放回去，2 条断言立即失败。
- 真实浏览器端到端脚本（`verify-features.mjs`）第 1 节同步增加透明度断言。

> 注：界面左上角 logo 位于 `.topbar`（`var(--surface)`，浅色主题下是白底），白底图标在那里反而不明显；真正会露白的是**深色表面** —— 任务栏 / Dock / 暗色主题 / 安装程序界面。

---

## v1.16.1：修正「导入笔记」落点（改为 Markdown 笔记，可新建）+ 根治 Release 正文为空（2026-09-23）

本版只做两件事：改一处导入行为，并把发布流水线上反复出现的「空正文」问题从根上修掉。

### 一、「📥 导入笔记」改为写入「Markdown 笔记」，并支持新建

**问题**：主 AI 助手里的「📥 导入笔记」会弹出「导入到哪篇文献的笔记？」，把回答写进**某篇文献的笔记**（`PUT /api/paper-notes/:litId`）。但该入口的本意是把 AI 结论沉淀成**可独立查阅、可继续编辑、可导出 PDF / Markdown** 的笔记；这类结论往往不属于某一篇文献，混进文献笔记后也很难再整理。

**改法**（全部在 `public/app.js`）：

- `chatImportToNote()` 重写：落点由 `paper-notes` 改为独立的 Markdown 笔记库 `/api/markdown-notes`；
- 新增 `askMarkdownNoteTarget()`：弹窗顶部固定「＋ 新建一篇笔记」，下方是已有笔记列表（可搜索），点击即确定为追加目标；
- 新增 `createMarkdownNoteFromAnswer()`：新建笔记，`title` 由提问生成（`AI 问答 · <提问前 24 字>`），`content` 是带时间与提问的 Markdown 片段，`sourceName` 记为「AI 助手」；
- 新增 `appendToMarkdownNote()`：`PATCH /api/markdown-notes/:id`，把片段追加到已有笔记末尾，原有内容不动；
- 新增 `buildAnswerNoteTitle()` / `refreshMarkdownNotesAfterImport()`。后者只在笔记模块**已经载入过**时刷新界面 —— 若未载入就顺手 `markdownNotes.unshift()`，会把「未载入」误标成已载入，导致之后打开模块只看得见这一篇（`loadMarkdownNotes` 会被跳过）；
- 笔记库为空时不弹框直接新建；导入前若正在编辑别的笔记，先 `saveActiveMarkdownNote()` 落盘，避免被随后的重渲染覆盖；
- 删除已无用的 `askPaperForNote()` / `ensureLiteratureLoaded()` / `literatureCache`；
- 论文阅读器里的「📥 导入笔记」**行为不变**，仍写入当前这篇论文的笔记（`appendToPaperNote()` 保留）；
- `public/style.css` 新增 `.note-pick-new` 样式，弹窗文案由「文献」改为「笔记」。

### 二、根治 Release 说明正文为空（`.github/workflows/release.yml`）

**问题**：从 v1.12 起每个版本的 Release 正文都是空的，一直靠事后调 API 手工 PATCH 补写。

**根因**（本次从 CI 日志里拿到确凿证据）：

```
⚠️ Failed to read body_path ".github/release-body.md" (ENOENT). Falling back to 'body' input.
```

发版作业只 `actions/download-artifact` 下载构建产物，**从未检出源码**，因此 `body_path` 指向的文件在工作区里根本不存在。`softprops/action-gh-release` 对此**只打一条 warning 就继续执行**，于是静默发出空正文的 Release。此前把它归因于 `generate_release_notes` 覆盖 `body_path`，方向不对。

**改法**：

- `release` 作业新增 `actions/checkout@v4`（在下载产物之前）；
- 新增「Verify release notes file」步骤：`.github/release-body.md` 缺失或为空则 `exit 1`，宁可让流水线失败，也不再发空正文；
- 更正 workflow 内注释与 `test/mail-update-features.test.mjs` 里关于 `generate_release_notes` 的旧结论。

### 三、测试

- 单元测试 **148 → 150 项全绿**（新增两条：`release` 作业必须检出源码并校验正文非空；导入笔记的落点与「新建」入口必须存在）；
- 真实浏览器端到端 **70 项断言全绿**。第 4 节由 5 条改写扩为 12 条，其中最关键的一条是回归守卫：**导入不会写进文献笔记**（断言 `paper-notes.md` 前后完全一致）。

> 经验：**「动作只 warning 不报错」的配置错误最阴**。`body_path` 读不到文件只打 warning，
> 所以流水线一路绿灯、Release 照样发布，问题只在人去看 Release 页面时才暴露。凡是用到
> `body_path` 这类「读文件」的配置，都值得额外加一条显式的存在性校验。

---

## v1.16.0：导图样式面板（XMind 级）+ 顶刊 DOI 批量导出 + AI 回答导入笔记 + 邮件一键翻译 + 应用图标（2026-09-23）

六项功能落地。**其中三项在自查阶段被真实浏览器验证揪出了缺陷并当场修掉**（含一个会让导图连线与子节点直接渲染不出来的严重问题），详见第六节。

### 一、思维导图样式面板（笔记模式 → 思维导图 → 🎨 样式）

对标 XMind 的右侧样式栏，改完即时生效、随笔记持久化：

| 分组 | 可选值 |
| --- | --- |
| 结构 | 14 种（思维导图 / 逻辑结构 / 向左逻辑 / 目录组织 / 组织结构 / 时间轴×3 / 竖向时间轴×3 / 鱼骨×2 / 向右鱼骨×2） |
| 配色方案 | 9 套（经典绿 / 海洋蓝 / 活力橙 / 紫罗兰 / 森林 / 玫瑰 / 商务灰 / 极简黑白 / 暗夜），带色卡预览 |
| 背景颜色 | 8 个预设 + 自定义取色器（含「跟随配色」） |
| 全局字体 / 字号 | 7 种字体；12~32px |
| 分支线 | 粗细 5 档；样式曲线 / 直线；🌈 彩虹分支开关 |

- 结构走 `setLayout`，其余走 `setThemeConfig`——都是库的公开 API。
- 新增 `mindStyle` 字段随笔记落盘（`PUT /api/paper-notes/:litId`），刷新/重启后样式仍在；老笔记没有该字段 → 回落默认样式，向后兼容。

### 二、顶刊 DOI 批量导出

- 文章卡片可勾选，「导出 DOI」优先导出**已选**，未选则导出当前列表全部；
- 导出弹窗三选一：**纯 DOI 列表（.txt）** / **RIS（.ris，Zotero·EndNote 可直接导入）** / **BibTeX（.bib）**；
- 另有「📋 复制 DOI」按行复制到剪贴板；
- 文件名 `顶刊DOI-YYYYMMDD.<ext>`；
- 无 DOI 的文章自动跳过并在弹窗里提示数量。

### 三、AI 回答一键导入 Markdown 笔记

- 主 AI 助手（🤖）与论文 AI 对话（阅读器 → AI 对话）的每条回答下都有「📥 导入笔记」；
- 写入片段带**来源与时间**，并附上最近一次提问，便于日后回看：
  ```markdown
  ## AI 回答 · <文献标题>

  > 时间：2026-09-23 20:10
  > 提问：这篇论文的主要贡献是什么？

  <回答正文>
  ```
- 主助手侧：文献库只有一篇时直接写入，多篇时弹「导入到哪篇文献的笔记」选择框（可搜索）；
- 导入只追加 Markdown，不动导图数据与样式。

> 注：主助手侧的落点已在 **v1.16.1** 修正 —— 改为写入独立的「Markdown 笔记」并支持新建笔记，不再写入文献笔记；论文阅读器里的入口保持不变。详见本文件顶部的 v1.16.1 说明。

### 四、邮件一键翻译

- 邮件详情操作区新增「🈯 一键翻译」，正文上方渲出译文区块，支持复制与关闭；
- 取正文优先用纯文本，只有 HTML 时先剥 `<style>/<script>` 再取文字；单次上限 6000 字符（超出提示「只翻译了前一部分」）；
- 译文只对当前这封生效，切邮件自动失效，避免串号；
- 复用「划词翻译」的翻译源与目标语言设置。

### 五、应用图标

- 由设计稿自动生成全套：`build/icon.png`(1024) / `icon.ico`(7 个尺寸) / `icon.icns` / `icon-256.png` / `public/favicon.png`(64) / `electron/icon.png`(256)；
- 关键处理：**自动裁掉设计稿四周的大片白底并补成正方形**（不裁的话图标在任务栏里会显得极小），再留 4% 内边距避免贴边；
- 生成脚本 `build/make-icons.py` 取代了过期的 `make-icns.py`（后者已被删除，`MACOS_BUILD.md` 同步更新）。

### 六、排查中发现并修掉的真实缺陷

**1）`mindStyle` 根本存不进服务端（最隐蔽）**
`PUT /api/paper-notes/:litId` 里用白名单拼 `patch`，只收 `md` 与 `mindmap`，前端传的 `mindStyle` 被**静默丢弃**，且 GET 也不返回该字段。症状是「改完样式当场生效、一刷新全没了」。
→ 白名单补上 `mindStyle`（只接受普通对象，数组/字符串等脏值返回 400），GET 一并返回。

**2）主题配置把节点样式传成了 JSON 字符串 → 连线和子节点渲染不出来**
`buildMindThemeConfig` 里写的是 `root: JSON.stringify({...})`。而库的默认主题（源码 `defaultTheme`）中 `root`/`second`/`node` 都是**普通对象**，`setThemeConfig` 会拿它与默认主题深度合并、渲染器再从 `themeConfig[节点类型]` 上读 `fillColor`/`fontSize`。传字符串的后果是整级样式被替换成字符串，取到的字段全是 `undefined`：
```
<path> attribute d: Expected number, "…5.5,394.90625 C NaN,394.90625 Na…"
Error: this.rx(...).ry is not a function
```
表现为**只有根节点画得出来、分支线坐标 NaN、子节点全丢**。
→ 改为传对象；同时收紧为「只覆盖字体/字号/底色/字色」，不再强行给所有节点加粗（免得抹平默认主题里根节点粗体、其余常规的差异）。

> 复盘：这个 bug 之所以能通过单测，是因为当时**写了一条把错误行为固化下来的测试**——
> `assert.equal(typeof cfg.root, 'string')` 外加 `JSON.parse(cfg.root)`，把「实现细节」当成「契约」断言了。
> 已把该测试改为断言对象契约，并补充「不强行改字重」等新断言。

**3）样式面板 4 个下拉框的 option 值全是 `[object Object]`**
```js
// 错：extra 缺省是 {}，而 ({}).valueOf 是 Object.prototype 上的函数（不是 undefined），恒为真
const v = extra.valueOf ? extra.valueOf(it) : it.value;
```
下拉既显示不出当前值，用户选完也读不到真实值——**四个控件等于全废**。
→ 删掉这个没人用的 `extra` 参数，直接取 `it.value`。

**4）「最新文章」页没有批量工具条 → 最需要导出 DOI 的列表反而没入口**
DOI 导出按钮挂在 `tjBulkToolbar` 上，而它只被「收藏」「历史记录」两个页签渲染；最常用的「最新文章」（180 篇）既无工具条、卡片也不可选。
→ 「最新文章」页也挂上工具条并让卡片可选；工具条按列表类型决定是否显示破坏性操作（该页只做选择与导出）。

**5）切到不支持曲线的结构时仍下发 `curve` → 连线坐标 NaN**
库对分支线样式有结构限制（`curve` 仅支持逻辑结构/思维导图/竖向时间轴）。用户在思维导图下选了曲线，再切到鱼骨图就会带着非法值渲染。
→ 新增 `effectiveLineStyle(layout, lineStyle)` 兜底：不支持就退回直线（全结构可用），切回支持的结构时用户的曲线选择自动恢复。

### 测试

- 单测：`node --test` → **148 通过 / 0 失败**（新增 6 条：主题配置的对象契约、不越权改字重、线型结构限制兜底、DOI 导出格式等）。
- 真实浏览器端到端（Playwright + 真实 HTTP + 真实下载 + 真实 PDF）：**60 项断言全绿**，覆盖
  样式面板 14 项、论文对话导入 4 项、主助手导入 2 项、DOI 导出 15 项（含 txt/ris/bib 内容与文件名、已选过滤与滚动位置保持）、邮件翻译 5 项、图标 7 项、无 JS 运行时错误 1 项。
  验证脚本保存在仓库外 `~/.workbuddy/zotero-lit-e2e/verify-features.mjs`。

---

## v1.15.1：彻底修掉导图节点框裁字（真实缺陷）

v1.15.0 的「导图框自适应」只做了一半：**框会变了，但长标题仍会被裁掉最后几个字**。本版按源码取证重做夹取逻辑，根因已定位并修掉。

### 现象

一篇论文标题「打破常规：视觉非典型性如何影响品牌生成图」在导图根节点上被**裁切**——框的右边界切在文字中间，最后一个字显示不全。

### 根因（已读 simple-mind-map 源码 + Chromium 实测双向取证）

三个条件叠加，缺一不可：

1. **节点宽度被 hard-clamp 到 `textAutoWrapWidth`**（库源码）：
   ```js
   width = Math.min(Math.ceil(width) + 1, textAutoWrapWidth);
   ```
   即该值是**内容区宽度**，节点框最多只能这么宽。
2. **换行判定用真实渲染字体、比较符是 `<=`**（库源码）：
   ```js
   if (measureText(text, this.style).width <= maxWidth) { 收进本行 }
   ```
   汉字在默认主题（微软雅黑 16px / bold）下宽度**正好等于 fontSize，没有小数余量**——实测 20 个汉字 = **320.0px** 整。
3. **旧代码的余量被上界吃掉**：
   ```js
   // v1.15.0（错）
   const hardMax = Math.max(160, Math.min(320, Math.round(hostW * 0.8))); // 恒为 320
   ```
   20 字标题算出 `320 + 2 = 322`，被 `Math.min(322, 320)` 截成 **320**，恰等于实测宽度 320.0，比较符又是 `<=`。于是**任何亚像素取整都会把最后一个字挤到下一行或被裁掉**。上界恒为 320 是致命点。

### 修复

- `paper-note-utils.js`：
  - 新增常量 `MIND_WRAP_HARD_CAP = 620`、`MIND_WRAP_SLACK = 6`；
  - **夹取顺序纠正**：余量只在「需求未超上界」时保留，贴到上界时改为返回「需求本身的夹取结果」而不是「需求+余量」——保证**余量永不被 `Math.min` 吃掉**，同时也绝不欠给（永不返回小于需求的值）。
- `app.js`：
  - `pnFitWrapWidth` 上界从硬编码 320 放开到「右栏真实宽度 - 40，上限 620，下限 240」；
  - 新增 `schedulePnWrapWidth()`（160ms 节流）：拖动分隔条时等手停下再重排；
  - 建实例后 **60ms / 260ms 两轮补校**（库首次渲染是异步的，首屏就必须不裁字）；
  - `data_change`、窗口 `resize`、分隔条 `pointermove` 均触发重算。

### 实测（真实 UI 链路：上传 PDF → 点「阅读 PDF」→ 笔记模式 → 思维导图）

| 标题 | 文字需求 | 节点框实际 | 行数 | 文字完整 |
| --- | --- | --- | --- | --- |
| 打破常规：视觉非典型性如何影响品牌生成图（20 字） | 320.0px | **355px** | 1 行 | ✅ |
| AI辅助经管类学术文献精读与知识沉淀一体化科研终端系统设计与实现路径研究（36 字） | 561.4px | **597px** | 1 行 | ✅ |

判据是「渲染出的文字去空白后与原文**全等**」+「框宽 ≥ 文字需求宽度」，两条同时满足。修复前 20 字标题 wrap 恒为 320（= 需求，零余量）→ 裁字；修复后为 326（有 6px 余量）→ 完整。

### 顺带

- 新增 6 个针对本次根因的回归单测（零余量、上界吃掉余量、上界放开后仍有约束、长短标题差异、常量导出、多子树取最长行），测试总数 **113 → 119**，全绿。

---

## v1.15.0：导图框自适应 + 滚轮改为平移、划词翻译修复、AI 对话读解析全文、全文翻译提速（2026-09-22）

本版集中修掉 v1.14.0 上线后用户实测反馈的 5 个问题，其中 3 个是真实缺陷。

### 一、思维导图节点框随字数自适应（真实缺陷）

- **现象**：节点框宽度固定，长标题被塞在同一个宽度里显示不全，短标题又空撑一大片。
- **根因**：`simple-mind-map` 的 `textAutoWrapWidth`（默认 **500**）是「达到该宽度就换行」的**全局阈值**，无法逐节点设置。库内两条测量路径行为不同：富文本节点按 `el.style.maxWidth = textAutoWrapWidth + 'px'` 量真实内容宽度并按需换行；纯文本节点直接 `width = Math.min(Math.ceil(width), maxWidth)` 把宽度**钳到 500**，于是长文字被压进固定宽度。
- **修复**：新增纯逻辑函数 `paper-note-utils.js` 的 `charWidth` / `estimateTextWidth` / `idealNodeTextWidth` / `fitMindmapWrapWidth` —— 扫描全树取「最长一行」估算所需宽度，夹在 `[96, 320]`（上限再按右栏宽度 80% 收一次），据此动态设置 `textAutoWrapWidth`；`data_change` 时重算，文字变长变短框都跟着变。
- **实测**：29 字 → 350×49（2 行）；43 字 → 350×68（3 行）；修复前固定 500 → 530×49 且文字显示不全。

### 二、导图滚轮行为对齐 XMind：默认平移，Ctrl 才缩放（真实缺陷）

- **现象**：在长导图里想上下翻看，一滚滚轮就缩放，很难受。
- **根因**：`mousewheelAction: 'zoom'` 让滚轮**无条件**缩放。
- **修复**：改为 `'move'`。库内判定是 `mousewheelAction === 'zoom' || e.ctrlKey || e.metaKey`，所以 `'move'` 恰好等于「不按修饰键走画布平移、按住 Ctrl/⌘ 照样缩放」，正是用户要的行为；另设 `mousewheelMoveStep: 100`。提示条补上「滚轮上下平移，Ctrl+滚轮缩放」。

### 三、笔记模式划词翻译失效（真实缺陷）

- **现象**：进入笔记模式后，在 PDF 上划词不再触发翻译。
- **根因**：`document.addEventListener('mouseup')` 里有一道 `if (pn.on && !findPageWrap(document.activeElement)) return;` 守卫。选中 PDF 文字时 `document.activeElement` 常常仍停在 `<body>`（或先前聚焦过的输入框）上，守卫直接把事件吞掉。而 `captureSelection()` 本身**已经**用 `findPageWrap(sel.anchorNode)` 判定过「选区是否落在 `.pr-page-wrap` 里」，这道守卫纯属多余且有害。
- **修复**：删掉该守卫，只依赖 `captureSelection()` 的返回值为准。

### 四、论文 AI 对话改为基于「解析结果（全文）」回答（真实缺陷）

- **现象**：AI 对话只看得到标题/作者/摘要等结构化字段，问论文里的具体内容答不上来。
- **根因**：`buildPaperContext()` 原先只拼 `items` 的结构化字段，**不含解析全文**。
- **修复**：
  - 新增 `ensurePrFullText(litId)`：从 `GET /api/pdf-translate/jobs` 取该文献最新的 `status==='done'` 作业，优先选 `outputs[].kind==='md'`（全文翻译产出的 Markdown 译文），`fetch` 其 URL 作为解析全文；剥离 `crop:` 图片占位；超 60000 字符时保留开头 75% + 结尾 25%；按文献 id 缓存到 `pr.fullTextCache`。
  - `sendPrChat()` 在发请求前 `await ensurePrFullText()`，`buildPaperContext()` 追加「【论文正文（解析全文）】」段；正文仍在解析中时明确提示「本次回答可能不够完整」。
  - 新增 `paperRecord(litId)`（`items.find` 失败时回落 `pr.meta` 快照），避免切文献后取不到记录。

### 五、全文翻译提速：视觉识别与翻译改为流水线并行

- **现象**：开启「视觉模型识别版面」后全文翻译明显偏慢。
- **根因**：旧实现是「**全部页识别完 → 才开始翻译**」。两段用的是两套不同模型与配额，串行跑总耗时 = 视觉 + 翻译，白白浪费一半墙钟；且视觉并发只有 `min(4, 并发/3)`，30 页论文光识别就要排 8 个波次。
- **修复**：
  - **生产者-消费者流水线**：`runVisionStage` 新增 `onPageDone` 回调，识别完**一页**就立刻把该页文本段投递给翻译器。关键是**投递即返回、不 await** —— 若 await，视觉 worker 会阻塞到该批翻译跑完才去认下一页，等于把两段重新变回串行。译文统一汇进同一个 `map`（id 全局唯一），所以产出与「全识别完再翻译」完全一致，只是时间轴重叠。
  - **攒批**：`translateSegments` 的自适应池每次调用都从「上限的 1/4」爬坡，一页一页投递反而更慢。故设 1200 字 / 8 段 / 400ms 三个阈值攒批后再真发，既保留重叠又让并发正常爬坡、请求次数不爆。
  - **视觉并发放宽**：`visionConcurrency()` 由 `max(1, min(4, round(并发/3)))` 改为 `max(2, min(6, ceil(并发/2)))`，默认 8 路并发时视觉从 3 路提到 4 路、16 路时从 4 路提到 6 路（仍留限流安全网：被限流时自适应池会自动减半）。
  - **进度显示**：总段数在识别过程中不断增长，改为「已完成/当前已知」；新增「PDF 共 N 页，本次处理 M 页（是否限定页码范围）」日志，便于排查「怎么只翻了一页」。
- **实测**：模拟 20 页（视觉 4 路 × 120ms、翻译 4 页/批 × 300ms）总耗时 **2289ms → 1048ms，提速 2.18x**；真实 HTTP 全链路 8 页作业中，**首次翻译 @2655ms 早于末次视觉 @2919ms**，重叠成立。

### 六、视觉模型职责收窄：只做「看图识字」，翻译一律交给翻译模型

- **需求**：视觉模型只管识别文字，译文必须走系统默认翻译模型 / 划词设置里选的翻译服务。
- **修复**：把「绝对不要翻译」从「转录要求」的一条提到**铁律级别**（第 3 条）并给出正误示例（英文照抄正确、译成中文错误）。原因：一旦模型顺手翻译，`collectVisionSegments` 收集到的就是中文，`isAlreadyTarget()` 会判「已是目标语言」而整段跳过翻译 —— 译文看着正常，但术语表、翻译缓存、`showOriginal` 等既有设施全部失效。代码路径本来就是 `collectVisionSegments → translateSegments(engine)`，本次把边界写死并在提示词层面强约束。

### 七、顺带修复：重新上传 PDF 附件会抹掉已填标题（排查中发现）

- `POST/DELETE /api/literature/:id/attachment` 里 `for (const key of FIELDS) updated[key] = ''` 会把含 `title` 的字段全清空（`FIELDS` 来自 `src/aiExtractor.js` 的 `COMMON_FIELDS`）。换附件意味着「这一篇的内容要重解析」本该清空解析字段，但 title 常是用户手填/从别处导入的，不该因为重新挂个 PDF 就丢 —— 否则笔记模式导图根节点退化成文件名、AI 对话上下文丢标题。已用 `keepTitle` 在上传与删除两处保留 title。

### 测试

- 单测 **110 → 113 passed / 0 failed**：新增 `visionPaperPrompt` 职责边界（3 例）、`visionConcurrency` 边界与单调性、逐页投递与全量投递结果等价性。
- 真实浏览器端到端：滚轮行为 **5/5**、视觉翻译流水线 **13/13**、v1.14.0 功能回归 **11/11**（导图框自适应 / 划词翻译 / AI 对话含解析全文）。

---

## v1.14.0：三栏笔记模式（Markdown + XMind 级思维导图）+ 论文对话持久化（2026-09-22）

### 一、三栏笔记模式（阅读器工具栏「📓 笔记模式」）

- **全新的阅读姿态**，不再是「划词弹面板」，而是一条完整的精读工作流：
  - **左栏 = 原文 / 全文翻译**：内部分段切换「原文 PDF」与「全文翻译」，复用同一份 PDF 渲染结果（把 `#prPages` 搬进左栏，不重复渲染两份 PDF），全文翻译的 Markdown 译文直接在此阅读。
  - **中栏 = 划词翻译**：在左栏选中文字即自动填充并翻译；也可手动输入、`Ctrl/Cmd+Enter` 触发；支持一键「→ 加入笔记」把原文+译文送进右栏，以及复制译文。
  - **右栏 = 笔记**：Markdown 与思维导图是**同一份笔记的两种视图**，用页签切换。
- **比例默认 0.4 : 0.2 : 0.4**，两根分隔条可自由拖拽，觉得窄随时拉宽；比例写入 `localStorage['pnPanes']`，下次打开保持一致。窄屏（≤900px）自动改为纵向堆叠。
- **Markdown 笔记**：编辑 / 预览双模式，支持标题、列表、表格、公式、图片；`Tab` 键在编辑器内插入缩进而非跳焦点。
- **粘贴图片**：Markdown 编辑器内直接 `Ctrl+V` 粘贴或拖入图片，自动插入 `![alt](dataURL)`。

### 二、XMind 级思维导图（内置 `simple-mind-map`，MIT）

- 选型：采用 **simple-mind-map（思绪思维导图）** UMD 构建，全部 21 个插件随包自动注册，无需 `usePlugin`；已 vendor 到 `public/vendor/simple-mind-map/`（含 LICENSE）。
- **交互与快捷键对齐 XMind**：`Tab` 子主题、`Enter` 同级、`Shift+Tab` 父主题、`Insert` 子主题、`F2`/双击改文字、`Delete`/`Backspace` 删除、方向键切换节点、`Ctrl+Z/Y` 撤销重做、`Ctrl+滚轮` 缩放。工具栏另提供「＋子主题 / ＋同级 / 删除 / 适应 / 缩放 / 导出」按钮，选中节点缺失时自动回落到中心主题，不会「点了没反应」。
- **导出 `.xmind`**：走 `doExportXMind.xmind(data, name)` 产出标准 `.xmind`（实为 zip，内部含 `content.json`），可直接用 XMind 打开继续编辑；同时支持导出 PNG。
- **节点支持图片**：在导图画布内 `Ctrl+V` 粘贴图片即插入当前选中节点的图片（`node.setImage`，dataURL 内联）。
- **两种视图双向同步**：Markdown → 导图按标题层级 / 列表缩进自动成树（跳过代码块、表格、引用，剥离行内强调）；导图 → Markdown 回写成缩进列表，切换视图不丢结构。

### 三、论文 AI 对话持久化

- 对话记录按文献持久化到 `paper-chats.json`：退出应用、刷新页面、切换文献再回来都能看到历史，不再「一关就没」。
- 新增「🗑 清除记录」按钮（无记录时禁用），清除前弹确认，**只删当前这篇论文**的记录，其它论文不受影响。
- 服务端清洗写入内容：最多保留 200 条、只接受 `user`/`assistant` 两种角色（`system` 提示词与非法条目一律不入库）、图片最多 8 张、过滤空消息。

### 四、数据与接口

- 新增两个数据文件 `paper-notes.json`（笔记，按文献存 `md` + `mindmap` 两种视图）与 `paper-chats.json`（对话），随 `ALL_DATA_FILES` 自动纳入备份 / 导出 / 目录切换。
- 新增 6 个端点：`GET/PUT/DELETE /api/paper-notes/:litId`、`GET/PUT/DELETE /api/paper-chat/:litId`。笔记 PUT 为**部分更新**语义——只传 `mindmap` 不会清掉 `md`，反之亦然。
- 笔记自动保存：编辑后节流 800ms 落盘，右上角显示「保存中… / 已保存 / 保存失败」；切换文献与关闭笔记模式前强制 flush，`beforeunload` 再用 `sendBeacon` 兜底。

### 五、实现要点与验证

- 纯逻辑抽到 `public/paper-note-utils.js`（三栏比例计算与像素下限、Markdown↔导图互转、片段插入与光标定位、空态判定），用 `vm.runInNewContext` 单测覆盖。
- 修复一个会导致「导图空白」的真实缺陷：`simple-mind-map` 在容器宽高为 0 时直接抛错（`容器元素el的宽高不能为0`）。现改为容器无尺寸时暂缓实例化并置 `mindPending`，用短间隔轮询等容器量出尺寸再建——不依赖 `requestAnimationFrame`（后台标签页会被节流甚至不触发）。
- 验证：`node --check` 全部通过；`node --test`：**102 passed / 0 failed**（新增 `test/paper-note-utils.test.mjs`、`test/paper-notes-store.test.mjs`）。
- 真实浏览器端到端（Playwright + Chromium，造真 PDF → 注册文献 → 开阅读器 → 点笔记模式）**22/22 通过**：PDF 在左栏渲染 2 页、比例 0.40:0.20:0.39、Markdown 自动保存、切导图由 Markdown 生成 `我的笔记 → 方法 → 对比学习 / 配对摘要`、`Tab` 键成功新增子节点、导出 `.xmind` 为 7933 字节合法 zip 且含 `content.json`、退出笔记模式 PDF 归位、重进后笔记仍在、整页刷新后笔记与对话均还在、清除记录生效、全程无 JS 报错。

### 六、发布与 CI

- 提交 `6c9ee29`（16 files, +16768/-10）→ CI run `35634391693` **success**；tag `v1.14.0` 指向该提交。
- Release「一站式科研终端 v1.14.0」(id 393171812) 6 个资产齐全：`zotero-lit-tool-setup-1.14.0.exe`(96.4MB) + `.blockmap` + `latest.yml` + `SHA256SUMS.txt` + macos arm64/x64 dmg(115.9/120.5MB)。
- **顺带修掉一个发布配置缺陷**：`.github/workflows/release.yml` 的 Release 正文原先内联在 `body:` 里、内容停在 v1.11.0，导致 v1.12/v1.13 发出来的 Release 正文是**空的**。现改为独立文件 `.github/release-body.md` + `body_path:` 引用，后续每个版本只需更新该文件。注意 `test/mail-update-features.test.mjs` 里有断言 workflow 正文的用例，已同步改为断言 `body_path` 路径并读独立文件（不再硬编码版本号）。
- 被取代的旧 CI run `35633463875`（commit `a5ab2ab`）长期卡在 in_progress，已通过 API 取消，避免回写覆盖同名 Release。

## v1.13.0：目录化 Markdown 译文 + 模型切换（2026-09-21）

- **全文翻译改为「按论文目录结构」输出**：不再把视觉识别出的块平铺，而是先归并成层级树，固定输出骨架 `一级标题 → 文章信息 → 摘要 → 第一章 → 小节 …→ 参考文献`。所有标题渲染为 `## 1 引言` 形式，下一行附 `> 原文：Introduction` 原文对照，便于核对译名。
- **文章信息自动精简**：剔除 ISSN / DOI / 邮箱 / 裸链接 / 版权（©、Copyright、All rights reserved）/ 开放获取声明（Creative Commons、Licensed under）/ 收稿出版日期（Received…Published）/ 卷期号（Vol.、Issue）等噪音，只保留真正有信息量的元数据。
- **图和表一律不再输出**：提示词层（不再转录 Figure/Table/图注/表注）+ 组装层（FIG/TABLE/CAP 直接丢弃并计入 `stats.dropped`）+ 文本层（表格与插图 crop 跳过）三重过滤。公式仍保留（`[FORMULA]` 原文透传）。
- **修复「识别不出标题写了什么」**：根因是截图分辨率不足导致标题只输出编号。截图宽度由 1400px 提升到 **2200px**（≈200 DPI，scale 上限 3.2、JPEG 质量 0.92、先填白底避免 PDF 透明区变黑）；视觉提示词新增两条铁律，明确「标题必须完整、只写编号等于没识别出来」并附正误对照示例。视觉请求 `max_tokens` 由 8192 提到 16384，避免高分辨率下后半页被截断。
- **修复参考文献重复与序号重复**：视觉模型把 References 标成普通一级标题时，会额外多出一个空的「## 参考文献」标题；同时转录已保留的原文序号会被再叠加一次（`[1] [1]`）。现在标题级判定与序号判定都做了兼容：已有序号沿用、无序号才按顺序补。
- **封面/无编号章节自动补号**：Introduction/引言 等无编号首章按出现顺序补 1、2…；Abstract / 关键词 / 参考文献 不占章节号。
- **所有 AI 对话支持切换模型**：AI 助手、论文对话、灵感孵化、审稿意见生成、审稿翻译、笔记整理、顶刊分析 7 个入口都新增模型选择器，可在「设置」中已配置（且已填密钥）的模型间切换，选择按功能域分别记忆；切换后立即弹 toast 提示「已切换模型：XXX」（与 Codex 体验一致）。
- 模型切换为 **单次请求覆盖**：只影响当前这次请求，不改动全局激活模型；所选模型被删除或未填密钥时给出明确错误提示，不会静默降级。
- 新增 `GET /api/models/choices` 返回可用模型清单；服务端 7 个 AI 端点统一支持 `profileId` 覆盖参数。
- 验证：`node --check` 全部通过；`node --test`：**72 passed / 0 failed**；运行时冒烟确认 `/api/models/choices` 列表、无效 `profileId` 报错、缺省回落全局模型提示均正确。

## v1.12.0：全文翻译 Markdown 重排版 + 视觉模型识别 + 翻译源选择（2026-09-21）

- 全文翻译新增 **Markdown 译文**输出模式并设为默认：按标题/段落/图注/表格/公式重建文档结构，产出干净的 `.md` 文件（`<原名>-译文.md`），告别旧重排版 PDF 的拥挤布局。
- 阅读器内新增 **译文查看器**：全文翻译完成后工具栏出现「📑 查看译文」，在阅读器内直接阅读 Markdown 译文，可随时「✕ 关闭译文」或切换「对照原文」回到原 PDF 页面，译文中的插图以原 PDF 对应区域裁剪图还原。
- 全文翻译支持 **视觉模型识别版面**（可选开关）：前端逐页渲染截图（最多 60 页）交给视觉模型转录为结构化标记，再对文本段走既有翻译管线（术语表/缓存/自适应并发全保留），版面还原效果显著优于纯文本层解析；未开启或个别页识别失败时自动回退文本层解析，绝不中断任务。
- 划词翻译面板新增 **翻译源选择**：可在「自动」、各翻译服务与指定 LLM 模型配置之间切换，选择会被记忆；服务端 `/api/translate` 与 `/api/translate/sources` 支持 `provider` / `profileId` 覆盖。
- 老用户一次性迁移：此前全文翻译模式为「双栏对照」的默认设置自动迁移为 Markdown 模式（明确手动选择过其他模式的用户不受影响）。
- 翻译产物下载链接按扩展名返回正确的 Content-Type（`.md` → `text/markdown`），浏览器可直接预览。
- 新增 `src/pdfTranslate/markdown.js` 模块（结构化标记解析、Markdown 组装、视觉块与文本层兜底）；测试新增 `test/pdf-translate-markdown.test.mjs`。
- 验证：`node --check` 全部通过；`node --test`：**70 passed / 0 failed**；运行时冒烟确认 `/api/translate/sources`、设置迁移（mode=md）、翻译源覆盖（`provider:volcweb` 实译返回）均正常。

## v1.11.0：稳定版科研终端（2026-09-21）

- 顶刊追踪 AI 分析记录持久化，支持查看历史并一键保存为 Markdown 笔记；大上下文先压缩再分析。
- AI 助手支持 PDF 上传阅读、提取文本，并可从本地知识库多选 Markdown 笔记、灵感孵化、研究记录、论文进度和收藏顶刊文章。
- 修复 `openChatKnowledgePicker` 等前端缺失定义导致初始化中断的问题；该问题会连带使顶刊、邮箱等后续事件绑定失效。
- 模型兼容层支持 Chat Completions / Responses API 自动切换、system role 降级和非流式兜底；翻译和聊天均使用当前激活模型配置。
- 邮箱当前文件夹支持一键全部已读；更新检查会展示 Release 正文或内置的 v1.11.0 变更清单。
- 保持稳定数据目录和备份机制，不删除用户已有记录或个性化配置。

## v1.10.1：顶刊知识工作流与模型兼容性（2026-09-20）

- 顶刊追踪：新增文章收藏、收藏批量取消、历史记录批量软删除、批选 AI 分析、发表日期和新增订阅的同日补推去重。
- AI 助手：收藏顶刊文章纳入本地知识库；明确限制为元数据/摘要级证据，防止把摘要误作全文证据。
- 模型兼容：统一规范 Base URL，防止重复拼接 `/chat/completions`；支持自定义本地服务无密钥模式、鉴权方式、SSE/非流式模式与 system-role 降级。
- 模型测试改为真实能力验证（system + 非流式 + 流式），非流式可用但流式不可用时明确提示并自动兼容。
- LLM 翻译改为读取当前激活的多模型 profile，新增 90 秒超时和有效返回校验。

# 本次修改说明（2026-09-18）

## 1. DeepL 划词翻译

- 官方 DeepL API 改用 `Authorization: DeepL-Auth-Key <API key>` 和 JSON 请求体，修复 403「Missing Authorization header」。
- 密钥以 `:fx` 结尾时自动使用 Free 端点；其他密钥自动使用 Pro 端点。
- 修复目标语言未实际传递的问题：中文为 `ZH-HANS`，英文为 `EN-US`。
- 自定义 DeepLX 端点保留表单协议兼容模式；它不是官方 DeepL API，行为取决于部署实现。

## 2. 灵感孵化布局

- 工作区采用稳定的 flex 高度链，避免内容高度反向撑开窗口。
- 灵感页改为「固定工具栏 + 卡片区独立滚动」，底部不再随页面整体滑走。

## 3. easyScholar 期刊等级

- 保留原有文献中心、模拟审稿等位置的 easyScholar 期刊等级查询能力；该能力并不依赖已移除的外文文献检索页。

## 验证

安装锁定依赖后，已运行完整测试：**33 passed / 0 failed**。

运行：

```bash
npm ci
npm test
npm start
```

## 5. PDF 阅读器：拼接翻译与单页旋转

- 划词翻译面板新增「拼接模式」与「清空」：启用后连续选取的文字会累计到同一原文框，并以合并文本重新发起一次翻译，因此译文是连贯的一段而非两条孤立结果。
- 英文片段会保留必要空格；中文片段不会被强行插入空格；重复点击浮动工具栏的「翻译」不会重复追加同一选区。
- 阅读器工具栏新增「↶ 左转 / 右转 ↷」，仅旋转当前页、仅在当前阅读会话生效，不改写原 PDF 文件。
- 旋转使用 PDF.js viewport 原生坐标变换，而非 CSS `transform`；文本选区、缩放、高亮、下划线和笔记的坐标会随当前页方向重映射。
- 旋转或缩放期间会丢弃已过期的异步渲染结果，避免旧渲染覆盖新方向的页面。

## 本轮验证

- 已运行 `node --test`：**32 passed / 0 failed**（移除外文文献检索的专用测试后）。
- `npm test` 在部分 Windows 环境可能会因系统级 npm cache 目录无写权限而报 `EPERM`；本轮用等价的 Node 内置测试命令绕开该环境权限问题，项目测试本身通过。

## 6. v1.8.0：灵感孵化布局与翻译服务

- 灵感孵化页的右侧长条是卡片区域的浏览器滚动条，而不是业务进度。此前滚动容器在视图内预留了滚动条沟槽，视觉上像一条无来源的进度条；本次移除了该沟槽，并把灵感页固定为「工具栏 + 剩余高度卡片区」的受限 flex 布局。
- 卡片不足一屏时不再预留右侧滚动条空轨道；卡片溢出时仍只在卡片区滚动，页面外壳和窗口底部不会跟着滑动或留白。
- 设置 → 划词翻译新增并可直接选择：**火山翻译 · 网页版（免密钥）**、**有道翻译 · 网页版（免密钥）**。
- 另外保留/接入了适合持久化生产使用的官方服务：火山引擎机器翻译、有道智云、百度翻译开放平台、腾讯云机器翻译；这些官方 API 需要各自的账号密钥。
- 风险：火山/有道“网页版”是免密钥网页端点，并非承诺兼容性的第三方官方 API；可能因上游改版、限流、网络策略而临时失效。需要稳定性或全文批量翻译时，优先选 DeepL 或上述官方云 API。

## v1.8.0 验证

- `node --check src/translate.js`
- `node --check src/translateProviders.js`
- `node --check public/app.js`
- `node --test`：**43 passed / 0 failed**。
- 通过本地浏览器实际检查灵感页：窗口/页面外壳高度未溢出，`#viewIdeas` 与工作区底部对齐，滚动归属为 `#ideaCards`。
## v1.8.1：全文翻译版面误判修复（2026-09-19）

- 修复结构化摘要/长句栏被误判为“表格”的问题。此前开启“表格保留原文”时，可能只翻译左侧短标签，却把右侧正文留成英文，形成截图中的中英文错位。
- 收紧真正表格的识别条件：连续长句、标点完整的正文块不再因为文字片段的固定 x 坐标被跳过；短单元格且稳定列位置的表格仍保持原样。
- 改善两行标题/大字号换行的段落合并，避免标题被拆成多个翻译块后逐行回写，造成中文碎片插入英文标题。
- 这次问题不是“视觉模型没有识别出段落”：截图显示 PDF 文本层已经被识别，主要是版面分类/段落合并的启发式误判。暂不默认调用视觉模型，避免把公式、表格和英文正文重新 OCR 后产生幻觉或坐标漂移。扫描型 PDF 若没有文本层，仍应先 OCR；后续可再增加可选的视觉复核模式。

## v1.8.1 验证

- `npm test`：**45 passed / 0 failed**。
- 新增结构化摘要不应被表格保护规则跳过、真实短单元格表格仍应保留的回归测试。

## v1.9.0：UTD 24 顶刊追踪（2026-09-20）

- 新增左侧栏「顶刊追踪」与 24 本 UTD 期刊目录；可逐本多选、分组全选、全选 24 本，或应用营销、企业管理、技术经济 / 管理科学、旅游（交叉）、会计、金融、信息系统、运营与供应链预设。
- 文章同步使用 Crossref 公开元数据 API，按 ISSN 并发限制为 3 的方式同步，展示并持久化：题目、作者、作者单位（提供时）、摘要、期刊、卷期页、DOI、原文页链接及发表日期。不会抓取或分发付费全文。
- 新增本地签到与投递队列：签到后每本订阅期刊最多领取 5 篇未曾投递过的文章；新文章优先，不足 5 篇如实提示缺口，不用旧文章重复填充。已领取文章长期累计，页面提供连续签到和月度打卡日历。
- 增加“翻译题目与摘要”，复用既有翻译服务配置并把结果写入本地缓存。
- 说明：这是本地客户端功能，应用未运行或电脑关机时不能保证云端定时采集/系统推送；要实现该能力仍需账号、云端数据库、定时任务和通知服务。

## v1.9.0 验证

- `npm test`：**50 passed / 0 failed**。
- 已在本地浏览器打开「顶刊追踪」，检查侧栏入口、UTD 24 期刊管理、方向预设、多选框、文章卡片入口、签到/累计/日历视图与响应式布局。