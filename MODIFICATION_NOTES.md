## v1.33.1：修内置翻译在 Qwen3 上必现 400（thinking_budget 不能为 0）+ 搜索框做出「一眼能认出」的样子（2026-10-29）

> 用户报了两个问题：
> ① 「内置翻译模型（Qwen/Qwen3-8B）返回 400:
>    {"code":20015,"message":"Value error, `thinking_budget` must be greater than 0."}」
> ② 「怎么没有见到搜索框」。

### 一、400 的根因：关思考时发了 `thinking_budget: 0`

`src/thinkingMode.js` 里硅基流动分支原来是：

```js
on ? { enable_thinking: true, ...(hasBudget ? { thinking_budget: budget } : {}) }
   : { enable_thinking: false, thinking_budget: 0 };
```

那个 `0` 的本意是「不限制思考长度」，但**硅基流动对 `thinking_budget` 的校验是「必须 > 0」**，
发 0 属于非法值，整个请求被 400 拒掉。翻译恰恰是「关思考」用得最狠的地方（要快），
所以内置翻译一调用就必然失败。

→ 改成关思考**只发 `enable_thinking: false`**，`thinking_budget` 整个键都不出现
（它只在开思考、限制思考长度时才有意义）。

这一处同时修好了三条链路，因为它们都调同一个 `thinkingPayload(..., 'off')`：
`src/translateBuiltin.js`（内置翻译）、`src/translate.js`（划词大模型翻译）、
`src/pdfTranslate/engines.js`（整篇翻译）。
文献解析（`src/aiExtractor.js`）本来也有同样的问题，只是 `server.js` 里那道
「400 就摘参数重发」的兜底把它盖住了 —— 属于「症状被兜底掩盖的真 bug」。

### 二、补上本该有的第二道防线：`postWithThinkingFallback`

`translateBuiltin.js` 的注释一直写着「不认的话下面会重试一次」，**实际并没有这段代码**；
`translate.js` 的注释也指向一个只在 `catch` 里处理 abort 的分支。这次把兜底真正做出来，
放在 `thinkingMode.js` 里给三条链路共用：

```js
export async function postWithThinkingFallback(doFetch, payload)
// → { res, payload, retried, thinkingRejected }
```

- 只有 **400 / 422 且文本点名参数**（`looksLikeThinkingParamError`）才摘；
- 摘掉 `THINKING_KEYS` 后用**同一份内容**重发**一次**（不允许无限重试）；
- 返回 `thinkingRejected`，调用方据此**记住这个端点以后别再发**（`translateBuiltin` 用
  `thinkingRejectedKeys` 集合按 `baseURL::model` 记忆，避免每翻一段都白挨一次 400）。
- 与参数无关的 400（如 `context length too long`）**不重发**，避免把真错误掩盖成"重试"。

### 三、「没见到搜索框」：它一直在，但长得不像搜索框

查证过程（先排除误报，再动手改）：
- 已安装应用是 1.33.0（注册表 + 进程启动时间 02:35，晚于安装时间 02:34）；
- 直接向**运行中的后端**（`127.0.0.1:58181`）取页面，返回 162148 字节、`libSearch` 出现 4 次
  —— 跑的就是新 HTML，不是旧缓存；
- 用真 Chromium 在 700 / 820 / 980 / 1100 / 1280 / 1440 / 1536 / 1600 / 1920 九种宽度下测量：
  `#libSearch` 全部 `inViewport: true`、未被遮挡（`elementFromPoint` 命中输入框本身）。

**真正的问题在观感**：`.lib-search` 原来是 `flex: 1 1 280px`，中等宽度下工具栏换行后它会
**一路撑满整行**，变成一条紧贴表头的浅色长条 —— 看起来像表头的一部分。
1280 宽时实测 `width: 968px`，1440 时 `1128px`。

→ 改法：
- `flex: 1 1 260px; min-width: 200px; max-width: 360px`，**宽度封顶**，就是一个搜索框的大小；
- 占位文字改成「搜索文献（全字段 · 容错）」，`title` 里写完整说明；
- 加 `<kbd class="lib-search-kbd">Ctrl K</kbd>`，并绑定 **Ctrl/⌘+K**：任意页面直接切到
  文献中心并聚焦搜索框（`view !== 'library'` 时先 `switchView('library')`）。
  聚焦或已有内容时这个提示会隐藏，把位置让给清除按钮。

### 四、测试

- `test/thinking-mode.test.mjs`：硅基流动关思考断言改为 `{ enable_thinking: false }`，
  并补「budget 传 0 / 负数 / 非数字都不能变成非法值」；新增 5 条 `postWithThinkingFallback`
  的行为用例（成功不重发 / 400 摘参数重发 / 无关 400 不重发 / 无思考键不重发 / 只重发一次）。
- 新增 `test/translate-builtin-thinking.test.mjs`（3 条）：用假 `fetch` 钉住
  「400 → 重发 → 成功」「被拒过的端点后续不再发」「无关 400 不重发」。
- `verify-lib-search.mjs` 增 3 项：宽度上限 200~400px、有放大镜图标 + `Ctrl K` 提示、
  `Ctrl+K` 能聚焦。合计 **19/19**。
- 全量 **580/580** × Node 20.10.0 + Node 22.22.2。

### 五、坑

- `test/thinking-mode.test.mjs` 里那条「重发后仍失败」的用例，最初让 stub 从**第一次**就返回 429，
  断言写的是「应重发一次」—— 但 429 不属于参数错误，压根不会触发重发。
  这类用例必须让**第一次**是被嫌参数、**第二次**才是真错误，否则测的是别的分支。
- `node --test` 全量偶尔会在约 333 条处卡死然后被 SIGTERM（Node 20 上遇到两次，
  Node 22 一次）。同一份代码换后台重跑就 20 秒跑完 —— 是残留进程抢资源，不是测试本身有问题。
  → 别急着怀疑新写的测试，先重跑一次；跑测试时别并发跑 Playwright。

## v1.33.0：阅读器可打印、AI 助读显示思考、内置免费翻译模型、三类文库字段扩充、搜索改全字段模糊（2026-10-28）

> 用户一轮提了五件事 + 一个界面调整：
> ① AI 助读要显示思考过程，而且太慢；② 翻译不准，想要一个免费的内置翻译大模型当可选引擎；
> ③ 文献解析调大模型时不要思考（提速）；④ 模型类文库补 6 个字段并新增「科学问题」，实证类也要；
> ⑤ 新增算法类文库（含 CCF 标注）；⑥ 阅读界面加打印，能调用系统打印机；
> ⑦ 把侧边栏的搜索框挪到文献表格工具栏，搜全字段、模糊匹配、按相关性排序。

### 一、阅读器打印（PDF / EPUB）

工具栏新增「打印」按钮（`#prPrint`），点开是自建的小对话框（页码范围 + 打印按钮），
确认后走系统打印对话框（`window.print()`），用户在里头选打印机 / 份数 / 双面。

- **PDF**：用 pdf.js 把所选页按 2 倍像素密度渲染成 JPEG，放进隐藏的 `#litPrintArea`，
  再 `@media print` 只显示这一块。这样打出来是"看到的样子"（含图片、公式、表格），
  而不是浏览器对 PDF 插件的默认排版。
- **页码范围**：支持 `1-3,5,8-` 这类写法（`parsePageRange`），越界自动夹到 [1, 总页数]；
  空白输入默认全部。
- **EPUB**：打印当前章节正文（`printEpubChapter`，走已渲染的 chapter HTML），
  不去拼整本书（几百页一次性排版会把内存打满）。
- **清理**：`afterprint` 里清空 `#litPrintArea` 并移除尺寸类 —— 图片是 dataURL，
  不清会把整份文档的位图一直留在内存里。
- 打印样式：`body > *:not(#litPrintArea) { display: none }`，并把页面边距归零、图片设为
  `width:100%`，避免右边缘被裁。

### 二、AI 助读：显示思考过程 + 变快

**显示**：以前 `reasoning_content`（硅基流动/DeepSeek 的思考流）被直接丢掉，用户只能干等。
现在服务端把思考增量单独走一条 SSE 通道（`{ reasoning: "…" }`），前端在回答上方折叠展示
（`prThinkHtml`，可展开/收起，边流边写）。

- `readLLMResponse` 增加 `onReasoning`，兼容 `delta.reasoning_content | reasoning | thinking`、
  非流式的 `message.reasoning_content`，以及 Responses API 的 `response.reasoning*.delta` 事件。
- 思考内容随消息一起存进历史（`m.reasoning`），重开对话框还能回看。

**变快**：三处同时下手。

- **思考开关**：工具栏加「思考：自动/快速/深思」按钮（`#btnPrChatThink`），
  默认 auto（跟随模型），选「快速」就是 `thinking: 'off'`。状态存 localStorage。
  服务端 `src/thinkingMode.js` 按供应商翻译成对应参数（硅基流动 `enable_thinking`、
  智谱 `thinking.type`、本地 vLLM `chat_template_kwargs`…），遇到 400/422 参数不支持
  会自动摘掉重发一次（`stripThinking` + `looksLikeThinkingParamError`），
  不会出现"开了加速反而全报参数错误"。
- **上下文瘦身**：注入的文献片段上限 9000 → 6000 字，单字段截断 900 → 600 字，
  对话历史 8 条 → 6 条。思考型模型的首 token 延迟与输入长度强相关，这一步收益最直接。
- **前端提示**：模型若可能思考（`modelMayThink`），接口会回 `mayThink`，按钮变成高亮态，
  提示"这个模型默认会思考，可切快速"。

### 三、内置翻译模型（免费，学术优化）

新增翻译引擎 `builtin`，排在翻译服务列表第一位：**不需要额外配 Key**，
复用用户已经配好的硅基流动 Key（或 `translateBuiltinKey`），跑小尺寸免费模型。

- 候选模型按优先级试：`Qwen/Qwen3-8B` → `Qwen3-4B` → `Qwen2.5-7B-Instruct` → `glm-4-9b-chat`，
  成功的那个记进缓存，之后直接用（不再每次探测）。
- **学术专用提示词**（`builtinSystemPrompt`）是这次"翻译变准"的关键：
  保留公式/数字/p 值/置信区间/引文编号/`[[T1]]` 占位符、缩写不译、术语前后一致、
  不解释不扩写、只输出译文。老的通用提示词会把 "we find" 翻成"我们发现"并顺手加解释。
- 翻译一律 `thinking off`（翻译不需要推理，开着只会更慢更贵）。
- 同一套提示词也给「当前激活的大模型」这条路径用（`translateViaLLM`），两条路口径一致。
- 全文翻译（`src/pdfTranslate/engines.js`）的引擎下拉也加了这一项。

### 四、文献解析默认不思考

结构化抽取（标题/作者/研究问题/核心结论…）不需要长链推理，开着思考只会把单篇耗时拉长。
`callLLM` 现在默认 `thinking: 'off'`，并提供自动降级（见上）。

实测同一篇 PDF：关思考前 60~120 秒，关思考后 10~30 秒（模型不同差异较大，但方向一致）。

### 五、文库类型：实证 / 模型 / 算法（新增）

- **实证类**新增 `scienceQuestion`（科学问题），排在研究问题之后。
- **模型类**补齐 7 个字段：研究问题、科学问题（新）、核心结论、作用机制、边界条件、
  研究设计、对文献综述有什么用。
- **算法类**（全新）：导入时间、作者、年份、关键词、研究问题、科学问题、核心结论、
  研究设计、批判性思考、对文献综述有什么用、标题、期刊/会议、DOI、摘要、实验设计、
  消融实验设计、我的思考、研究空白、数据集、评价指标、研究领域。
  - 「批判性思考」与「我的思考」分开：前者是作者/评审视角的局限，后者是用户自己的批注。
  - 「期刊/会议」列对算法类自动改标签（`colLabel`），提示词要求**CCF 会议必须标注等级**：
    `NeurIPS（CCF A）`、`ACL（CCF A）`，非 CCF 的会议不硬贴等级。
- 三处口径必须一致，且用测试锁住：
  `src/aiExtractor.js` 的 `TYPE_FIELDS`（后端提取顺序）↔ `public/app.js` 的 `TYPE_ORDER`
  （前端列顺序）↔ `normalizeDocType`（`algorithm|ccf|algo` 都归一成 `algorithm`）。
- 侧边栏新增「算法类文库」入口（拼图图标）。

### 六、搜索框从侧边栏迁到表格工具栏，并重写匹配逻辑

用户要求：挪到工具栏那块空白里，搜**所有字段**，支持**模糊**，**按相关性排序**。

- **位置**：`#libSearchInput` 放在工具栏行末，`flex:1 + margin-left:auto` ——
  一行放得下就吃掉右侧空白，放不下就整块折到下一行独占一行
  （而不是把"降序/行高"挤成半行）。侧边栏那个输入框连同 `--side-*` 样式一起删掉，
  避免两个输入框抢同一份过滤状态。
- **全字段**：不再维护"搜哪些列"的白名单，直接遍历记录上的每个字符串/数字/数组属性 ——
  三类文库的专属字段、我的思考、研究空白、数据集…自动都在范围内，以后加字段不用改代码。
  只排除 `id / filePath / pdfPath / coverPath / collectionId` 这类不可能是关键词的值。
- **模糊**：两级。① 子串命中，按"整段相等 > 前缀 > 词首 > 词中"分级；
  ② 拼写容错 —— 有界编辑距离（4~7 字符容 1 处差异，8 字符以上容 2 处），
  `transfromer`（换位）、`tranformer`（漏字）都能命中。
- **相关性**：`Σ(命中强度 × 字段权重)`，标题 12 / 关键词 9 / 作者 8 / 期刊 6 … 摘要 1.5。
  多个关键词是 **AND**（搜「注意力 机制」不会返回一堆只有"机制"的文献），
  整句在标题里完整出现再加 12 分。有搜索词时相关性是主序，用户选的排序只作同分次序。
- **可见反馈**：输入框内实时显示命中篇数；表格里命中的关键词 `<mark>` 高亮
  （只标子串命中，容错命中的字符是散开的，标出来像乱码）；空结果的提示与"文库是空的"区分开。
- 纯逻辑抽到 `public/lib-search.js`（无 DOM 依赖），用 `vm` 直接单测，
  `test/lib-search.test.mjs` 覆盖 20 条：全字段、容错、AND、权重方向、排序主序、
  realm 安全的断言、以及"侧边栏搜索框不许加回来"的接线检查。

### 七、实证类变量清单 + 全部 AI 字段改段落格式

用户补充要求：实证类要能直接看出「谁影响谁」，并且所有 AI 字段都要段落化。

- **新增五个变量字段**（各自独立，不是合成一个「变量」框）：
  `independentVar` 自变量 / `dependentVar` 因变量 / `moderatorVar` 调节变量 /
  `mediatorVar` 中介变量 / `controlVar` 控制变量，排在「构念」之后。
- **只要干净的变量名**：提示词里明确禁止解释含义、写研究假设、写结果与系数、
  写「自变量：」这类前缀、给编号；多个变量就多段，不许用逗号串成一行。
  调节变量只认「被实际检验」的、中介只认「被实际测量」的、控制只认「实际放进模型」的 ——
  否则模型会把分组样本、稳健性检验里出现过的变量统统塞进来。
- **构念字段重写**：从「定义 + 分析层次 + 论证角色」改成
  「中文名（英文原名）：测量方法 / 操作化」，一个构念一段，**除变量名与测量/操作化之外
  不写任何其它描述**；「概念—测量不匹配」这类判断挪到批判性思考里。
- **所有 AI 字段段落化**：段与段之间空一行、每段开头空两格（两个全角空格 U+3000）、
  不再用 `- ` 无序列表 / `1) 2) 3)` 编号 / Markdown 表格。
  变量清单类字段同样按段落给：一个变量一段。列字段（标题/作者/期刊/年份/DOI）例外，
  保持单行纯文本 —— 它们要进表格列。
- **渲染跟着改**：`mdLines` 原来对每行 `trim()`，会把首行缩进的全角空格当空白抹掉；
  改成只去行尾空白、按 trim 后是否为空过滤空行。详情卡片加了 `.md-annotatable p`
  的段间距（9px）与两端对齐，段落连排不再像被切碎。
- 表格单元格仍是「段落 → marked → 行高钳制」的预览：实测多段落能正常截断成「首段 + …」，
  完整内容在详情卡片里看。

### 八、顺手修掉的两个坑

- `fetchModelCompletionOnce` 里误写 `opts.thinking`（该函数没有 `opts`，只有解构出来的
  `thinking`），是个必现的 `ReferenceError` —— 会让**所有**大模型调用失败，
  并让整个测试套件从 18 秒退化到 14 分钟（每个用例都在等超时）。已改回 `thinking`。
- `public/style.css` 被 `cat >>` 追加时写到了文件开头（本机 shell 的 heredoc 有坑），
  已还原并改为用文件写入方式追加。

---

## v1.32.1：世图下载助手修好「中转链接一直提示不是 PDF」（2026-10-27）

> 用户反馈：`https://reseach1.worldlib.site/tools/submit_ajax.ashx?action=getdownfile&path=:8123/upload/doifiles/10.1016/1-s2.0-S0278431926000216-main.pdf`
> 这种链接下载失败，要求修复。

### 一、真因：用 URL 结尾判断「是不是 PDF」

老代码在 `downloadWorldlibPdf` 里是这样判的：

```js
if (ct.includes('pdf') || /\.pdf(\?|#|$)/i.test(r.url || cur)) { /* 当作 PDF 收下 */ }
```

世图的中转链接是 `…/submit_ajax.ashx?action=getdownfile&path=:8123/upload/…/xxx-main.pdf` ——
**整条 URL 正好以 `.pdf` 结尾**（`.pdf` 在查询参数里），于是收到 200 的 **HTML 中转页**后
仍被当成 PDF 收下，紧接着 `isPdfBuffer` 校验失败，用户看到
「下载内容不是有效的 PDF 文件」—— 一个和真实原因完全无关的错误。

实测那条链接返回的是 895 字节的 HTML，里面印着真地址：

```
<p>http://42.228.14.222:8123/UPLOAD/DOIFILES/10.1016/…-MAIN.PDF?token=…</p>
<a href='…'>文件下载</a>
```

### 二、改法

- **只看内容魔数**：抓下来先看前 64 字节有没有 `%PDF-`，是就收工；不是就按中转页处理。
  URL 结尾不再参与任何判断。
- **超时覆盖正文**：老实现 `fetch().finally(clearTimeout)` 在收到响应头时就清了定时器，
  正文卡住会永久挂着（用户只看到"一直在下载"）。现在统一走 `fetchBufferGuarded()`，
  120 秒预算覆盖到 `arrayBuffer()` 读完，并加了 300MB 体积上限。
- **中转页解析增强**（`extractPdfLink`）：
  - 认「文件下载」按钮、`href/src/data-url`、`location.href/open/replace`、
    `<meta http-equiv="refresh">`、JSON 里的 `url/fileUrl`、以及**页面里裸印的地址**；
  - **HTML 实体还原**（`&amp;` → `&`）—— 不还原就会带着 `&amp;` 去请求，对方直接 400；
  - 优先级：路径以 `.pdf` 结尾 > 路径/查询里带 download 类关键字 > 页面只剩一条外链时就用它；
  - **判断只看路径不看查询串**：中转接口的查询串里常带 `.pdf`，拿整串判断会自己指回自己；
  - 带 `skip` 参数防止原地打转。
- **补全「空主机 + 端口」的地址**：`path=:8123/upload/…` 是世图的内部写法（浏览器自动补当前主机，
  Node 里 `new URL()` 直接抛错）。新增 `repairPortOnlyUrl()`：拼成
  `https://<当前站点主机>:8123/upload/…` 再试一次 —— 这往往就是真文件地址。
- **错误信息说人话**（`describeDownloadError`）：域名解析失败 / 拒绝连接（多为校内网限制）/
  连接被中断 / 证书错误 / 超时，各自带上是哪个主机端口，而不是甩一句 `fetch failed`。
- 顺带：首跳就带上 `Referer`（世图会看），`isPdfBuffer` 允许前 64 字节内有 BOM。

### 三、验证

- `test/worldlib-download.test.mjs`（8 条，全本地 mock 站）：
  ① 中转页链接**本身以 .pdf 结尾但返回 HTML** → 解析出真直链并落盘（这条就是本次 bug 的回归用例）；
  ② `path=:PORT/…` 自动补主机名；③ `&amp;` 还原后对方才给文件；④ 真直链直下；
  ⑤ 声明 PDF 内容不是 → 明确报错且**不留文件也不留记录**；⑥ 找不到地址 → 报"没能从中转页"；
  ⑦ 404 / 连接被拒 → 错误里点出原因；⑧ 同名 409 + overwrite 覆盖不产生重复记录。
- 真实链接实测（本机，走真实世图站点）：
  - 用户给的中转链接 → `fileSize 5544164`，落盘文件头 `%PDF-1.7`；
  - 从该中转页解析出的直链 → 同样成功。
- 全量 **535 项** × Node 20.10.0 + Node 22.22.2 全绿；浏览器回归 75/75。

## v1.32.0：中文文献不再整篇翻译（自动判语种 + 三处入口一起收）（2026-10-27）

> 用户要求：「针对中文文献就不必要整篇翻译了」。

### 一、为什么不能靠"用户自己别点"

整篇翻译是给「读不懂原文」准备的。中文文献自己就能读，整篇翻一遍要跑版面识别、
逐段调用模型、探测并嵌入 CJK 字体，一篇几十页能白烧几分钟和一整笔 token。
更麻烦的是**自动管线**：打开文献就会自动「版面识别 → 整篇翻译 → 进对照精读」，
中文文献等于每次打开都白跑一轮。

### 二、判据：`src/docLanguage.js`（纯函数、零成本、可单测）

- 只数**汉字**，分母只算「汉字 + 拉丁字母」——不用 layout.js 的 `cjkRatio`（那个把
  日文假名 / 全角标点 / 韩文都算 CJK，是给断行用的），否则英文论文里的公式标点会把比例搅乱。
- **长文（>40k 字符）均匀取 20 个窗口**，每个窗口算占比后取**中位数**：
  - 头/中/尾各取 1/3 那种"看起来公平"的采法，对「英文封面 + 中文正文 + 英文参考文献」
    极不友好 —— 头尾各占 1/3，中文正文只剩 1/3，占比被系统性压低（实测把 57% 中文的
    文档判成英文）。均匀窗口才不偏。
  - 用中位数而不是全局占比：中文期刊论文常挂大段英文摘要与英文参考文献，全局占比会被
    拉到 0.2~0.4；只要**过半窗口**是中文就算中文，对这类"局部外文"天然免疫。
- 阈值 0.35；汉字+拉丁字母少于 200 个 → `unknown`（扫描件、纯公式），**调用方按"不是中文"处理**
  —— 宁可多给一次翻译入口，也不能因为判断不出来把功能藏掉。
- 判定结果缓存在文献记录上：`docLang` / `docLangRatio` / `docLangAt`。解析时顺手算（正文已在手上，
  零额外开销）；老记录或没解析过的记录由 `GET /api/literature/:id/language` 按需补判一次并缓存。

### 三、三处入口一起收

| 位置 | 中文文献时的行为 |
| --- | --- |
| 自动管线（打开文献即跑） | 直接停在普通阅读，工具条徽标提示「中文文献，无需整篇翻译」；**不**自动跑版面识别，更**不**起翻译作业 |
| 对照精读启动面板 | 顶部一条提示「这篇文献的正文以中文为主，不需要整篇翻译」；③ 步骤文案改为"不需要"（绿色）；「开始对照翻译」按钮隐藏；引擎 / 目标语言 / 页码范围 / 「参考文献也翻译」一并收起（它们只服务于整篇翻译） |
| 工具条入口 | 「整篇翻译」改名「对照结构」，title 说明原因；点开只能铺结构 / 读已有结果 |

- 服务端还有一道兜底：`POST /api/pdf-translate/jobs` 在「正文中文 + 目标语言中文」时返回
  `409 { skipped: true, reason: 'chinese-doc' }`，不会创建作业。**目标语言是外文时照常放行** ——
  中文文献翻成英文是真需求，不能一起拦掉（`shouldSkipFullTranslate()` 单测覆盖）。
- 段落级翻译（划词 / 点段落）完全不受影响：想查某个英文概念照旧选中就翻。

### 四、测试

- `test/doc-language.test.mjs`（10 条）：中文 / 英文 / 中英混排（带英文摘要与参考文献）/
  英文里夹中文引文 / 样本太少 → unknown / 超长文均匀采样（含"只读开头会判错"的对照）/
  拦截规则四象限 / 缓存命中不再抽 PDF / 无缓存时真读 PDF 并写回记录 / 409 拦截且不留作业。
- 全量 **527 项** × Node 20.10.0 + Node 22.22.2 全绿；浏览器回归 75/75；
  真机验证 `verify-zh-no-translate.mjs`：中文文献（真实 PDF 判定 ratio=1）面板出现提示条、
  按钮隐藏、点入口 0 次翻译请求；`docLang='other'` 的对照组按钮照旧存在。


## v1.31.0：PDF 链接指向磁盘文件（定位/打开）+ 解析后用 AI 标题自动重命名 PDF（2026-10-27）

> 用户要求：「当我点击 PDF 链接时，应该链接到文件保存位置，而不是文件上传位置，
> 而且当上传文件后，自动利用大模型解析的标题对 pdf 重命名，方便用户分享文件」。

### 一、点 PDF 文件名 = 去磁盘上找它

- 以前 `attachCell` 里是 `<a href="/uploads/xxx" target="_blank">`：点一下只是在浏览器里
  把上传副本再读一遍。文件到底躺在哪个目录、叫什么名字，用户完全不知道，也没法直接拖出去分享。
- 新增 `POST /api/literature/:id/reveal`（`mode: 'folder' | 'open'`）：
  - `folder`（表格里点文件名）→ Electron 注入的 `revealFile` → `shell.showItemInFolder`，
    资源管理器打开并**选中**这个文件；
  - `open`（详情卡片里的「原 PDF」）→ `openPath` 用系统默认程序打开，打不开就退回定位文件夹；
  - 纯浏览器运行（没注入系统能力）→ `409 + { fallback: 'url', url }`，前端退回新标签打开并
    明确告知「当前是浏览器运行方式」——不静默失败；
  - 文件被移走/删掉 → `404`「找不到这份 PDF（可能已被移动或删除），重新上传一份即可」。
- 前端 `revealLitFile(id, mode)`：`preventDefault` + `stopPropagation`（文件名在
  `.cell-attach[data-upload]` 里，不拦住会同时弹出上传框），成功弹「已在文件夹中定位并选中这个文件」。
- `href` 仍然保留 `/uploads/...`：中键/右键「另存为」这类浏览器原生行为不至于失灵。

### 二、解析完用 AI 标题给 PDF 改名

- 位置：`parseRecord` 写出字段之后立刻做（此时 title 已经在手上），失败也只是「没改名」，
  **绝不影响解析结果**（Windows 上文件被 PDF 阅读器/杀毒占用时 `rename` 会抛 EBUSY，这是常态）。
- 四条约束（都在 `renamePdfFileToTitle` / `sanitizeFileStem` 里）：
  1. **只认 AI 解析结果**（`result._source === 'ai'`）——规则兜底抽出来的"标题"往往就是 PDF
     第一行页眉，改成那样不如不改；
  2. 标题先洗成合法文件名：去掉 `\ / : * ? " < > |` 与控制字符、合并空白、去首尾点和空格、
     命中 Windows 保留名（CON/PRN/AUX/NUL/COM1…）加下划线、超长截到 80 字；少于 6 个字不改
     （「研究」「论文」这种名字比随机码更难认）；
  3. 只在原目录里改名，目标已存在就加 `(2)`、`(3)`…（不覆盖别人的文件，最多试到 50）；
  4. EPUB 不动（它有自己的目录结构，改文件名会影响阅读进度定位）。
- 记录同步更新：`filename` / `filePath` / `originalName` 换成新名字，**原始上传名存进
  `originalUploadName`**（文件名 tooltip 里会写「原名：…」），并记 `renamedAt`。
- 连带修掉：上传后 `ensureThumb` 原来用的是「上传那一刻的记录快照」，改名之后那个文件名已经
  404，缩略图会生成失败。现在统一用 `loadItems()` 之后的最新记录去生成。

### 三、测试

- `test/lit-file-rename.test.mjs`（7 条）：
  - 纯函数：禁用字符 / 空白合并 / 结尾点 / 保留名 / 超长截断；改名后磁盘上只剩新文件；
    同名加序号、短标题不改、EPUB 不改、文件不在不改；
  - HTTP：真 PDF + mock 上游 → 解析完记录 `filename === 标题.pdf`、`originalName` 同步、
    `originalUploadName` 留档、目录里旧文件消失；`reveal` 在有系统能力时把**磁盘路径**交给系统，
    无能力时给 409 + 兜底 URL，文件丢失时 404 且提示明确。
- `parse-http.test.mjs` 的并发断言从「墙上时间 <900ms」改成「上游在途峰值 ≥3 + 时间极宽松上限」：
  全量测试是多文件并行跑的，机器一忙墙上时间就从 400ms 飘到 1100ms，那是个会假红的判据。
- 顺带给两个会真跑解析的测试文件加 `test.after(() => shutdownPdfTextPool())`：
  不关 PDF 抽取线程的话，测试进程要多等一轮空闲回收（单个文件 22s → 1.8s）。
- 全量 **517 项**在 Node 20.10.0 / Node 22.22.2 各跑一遍全绿；浏览器回归 75/75；
  另加一轮真机验证（`verify-rename-reveal.mjs`）：点文件名 → 打的是 `POST /reveal` 且页面不跳走；
  解析完单元格显示「平台治理对用户价值共创的影响：一项追踪研究.pdf」，磁盘上就这一个文件。


## v1.30.0：解析不再卡死（单篇看门狗 + 僵尸回收）+ 默认 6 路并行 + 点任意单元格打开详情卡片（2026-10-26）

> 用户要求：「为什么有的文献会一直卡在解析中，优化解析逻辑，并行处理，一次处理 4-8 个，加速一些」+
> 「而且要求在用户点击任何字段时都可以弹出详情卡片」。

### 一、「一直卡在解析中」的三个真实成因（都不是"模型慢"）

先把现象拆开：v1.29 的界面能显示进度了，但有的文献会**永远停在"解析中"**，重启应用也不恢复。
查下来是三条独立的问题叠在一起：

1. **LLM 请求没有超时**。`aiExtractor.callLLM` 是裸 `fetch`，没有 `AbortSignal`、没有时限。
   上游半死不活（TCP 建起来但不返回、公司网关吞包、代理挂着）时 Promise 永不 settle，
   这一篇就永远停在 `parsing`，整批一起等 —— 用户看到的是"卡住"，实际是"请求吊死"。
2. **一篇抛错整批停**。批量解析是 `Promise.all` + 游标循环，第一个 reject 立刻向外抛，
   游标里剩下排队的篇目再也不会被取出来，状态永远停在 `queued/parsing`。
3. **僵尸记录没人收**。`status='parsing'` 是要落盘的；应用被强杀 / 崩溃之后，库里这条记录
   永远写着 `parsing`。而「解析全部」的过滤条件恰恰是 `status !== 'parsing'`，
   「批量重新解析」也跳过 `parsing` —— 于是**再也没有任何入口能重跑它**，
   界面上它就永久转圈。这是最顽固的一种，也是用户最常遇到的那种。

### 二、`src/parseRunner.js`：并发池 + 单篇看门狗 + 失败隔离

新增一个通用执行器，三个解析入口（`/api/parse`、`/api/literature/:id/parse`、
`/api/literature/batch-reparse`）共用同一套行为：

- `runParseBatch(items, worker, { concurrency, itemTimeoutMs })`，**永不 reject**；
  逐篇返回 `{ ok, value | error, timedOut, elapsedMs }`，调用方只看结果。
- 并发默认 **6**，夹在 1~8（`clampParseConcurrency`）。LLM 调用是 IO 等待，
  6 路并行把整批的墙上时间压到原来的 1/4 左右，又不会把上游限流打爆。
- 单篇预算 `itemTimeoutMs` = AI 单次超时（≥180 秒，用户「高级设置」里的大于它时以用户为准）+ 180 秒余量，
  默认 6 分钟，硬上限 30 分钟（`PARSE_ITEM_TIMEOUT_MS` 可调）。
- 到点不是"假装完成"，而是 `AbortController.abort()` **真掐断 HTTP 连接**，
  同时给单篇一个 `job` 句柄：`parseRecord` 在每个 `await` 之后调 `job.assertLive()`，
  已经判超时就抛错退出 —— 避免"界面已经标成超时失败，后台又把结果写回库里"这种鬼状态。
- 每篇独立 try/catch + 收尾后从「正在解析登记表」里摘掉；一篇失败/超时不影响其他篇。

### 三、请求层：超时 + 重试 + 期刊等级查询的硬时限

- `callLLM(settings, sys, user, { signal, timeoutMs })`：每次请求带 `AbortController`。
  默认 180 秒（`resolveAiTimeoutMs`，上限 10 分钟），超时给出人话：
  「AI 接口 180 秒无响应，已中止这篇（可在「AI 设置 → 高级设置」调大单次请求超时，或换一个更快的模型）」。
- **重试**：429 / 408 / 425 / 5xx / 网络层错误重试，最多 3 次尝试，退避 500ms、1000ms；
  **超时不重试**（已经白等了一个完整预算，再等一轮只会更难受，交给单篇看门狗统一收尾）。
- `queryPublicationRank` 加 **12 秒硬时限**。它以前也是裸 `fetch`：查等级吊死的话，
  前面 AI 已经跑出来的结果就落不了盘，记录会停在「核对期刊等级」这一格。
- `src/pdfTextPool.js` 空闲回收定时器 `unref()`：Electron 关窗、单测收尾不再多等 60 秒。

### 四、僵尸回收：以「进程内真实作业表」为准，而不是库里的 status

- 解析开始时写 `parseStartedAt`，结束（成功或失败）时清成 `null`。
- `reclaimStaleParsing()`：
  - **启动时** `all=true` —— 进程刚起来，内存作业表必然是空的，所有 `parsing` 都是残留；
  - **运行中**按 `parseStartedAt` 超过「单篇预算 + 90 秒」回收，挂在 `GET /api/literature` 上，
    前端每次刷新顺手清一次；
  - 收回时改成 `status:'error'` + 「上次解析被中断（应用退出 / 请求断开 / 超时未收尾），可重新解析这篇」。
- 三个解析入口都先回收一遍再过滤，且**"要不要跳过"改成看 `isParseActive(id)`**：
  库里写着 `parsing` 但进程里没人在跑的，这次照常重跑。这是"卡住之后能自救"的关键。
- 前端 8 分钟口径同样把这类记录标成「**解析中断**」（红徽章）而不是「解析中」，
  点「解析选中」会明确提示「其中 N 篇上次解析卡住了，这次会重新开始」。

### 五、并行度的另一头：PDF 抽取线程池

- `PDF_TEXT_WORKERS` 默认从 `min(2, CPU)` 提到 `min(4, CPU-1)`，上限 6。
  并行 6 篇解析时，前 6 篇会同时进入「抽正文」阶段，只给 2 个线程等于把并行的好处
  全浪费在第一阶段；4 个线程在 8 核机器上吃得下并发，又不会互相抢核。
- 实测（8 篇 100 页级 PDF、mock 上游每篇 1.2 秒、请求并发 6）：全链路约 15 秒完成，
  期间进度面板显示「正在并行解析 6 篇（并发 6）」，上游同时在途峰值 4~6。

### 六、顺手修掉的竞态：解析期间写的笔记不再被覆盖

`parseRecord` 收尾时原来用「批次开始那一刻的记录快照」覆盖写库，
并发解析跑几分钟的窗口里，用户改的「我的思考」、新加的划词标注会被一次解析全部抹掉。
现在收尾统一合并**此刻库里的记录**（`freshest()`），只覆盖 AI 该写的那批字段。

### 七、点任意字段都能弹出详情卡片

- 以前只有「标题」那一格能点开详情，点期刊 / 年份 / DOI 毫无反应，只能去行尾找 `⤢` 图标。
- 现在整行都是入口：`tbody` 里任意 `td`（含**空单元格**）点击都打开详情卡片；
  复选框、序号列不响应（它们表达"选中"），附件、阅读进度、评级、操作列保留各自交互。
- 打开后**滚动到被点的那一列对应的字段并闪一下**（`data-field-anchor` + `fieldFlash` 动画，
  1.5 秒回落透明，不留永久底色）：点「期刊」就停在期刊，「核心结论」就停在核心结论。
  为此详情卡片顶部补了一个「导入时间」概要（表格里有这列，卡片里原本没有对应位置）。
- `openDrawer(id, { field })` 透传字段名；`drawerFieldOf(col)` 负责「列 → 锚点」的映射。

### 八、新增测试

- `test/parse-runner.test.mjs`（12 条）：并发上限 / 真并行、单篇吊死不拖累其他篇、
  抛错不外溢、`abort` 后 `assertLive` 抛超时、登记表自动摘除、空批次、
  僵尸识别（在跑的 / 新的 / 过期的 / 没有开始时间的老记录 / `all` 模式）、
  进度快照的 `active` + `concurrency`、单篇预算的夹取规则。
- `test/parse-http.test.mjs`（2 条，真服务 + 真 PDF + mock 上游）：
  ① 一次提交 6 篇，上游同时在途峰值 ≥3、整批耗时 <900ms（串行至少 720ms）、
  6 篇字段全部写入且 `parseStartedAt` 清空、进度快照带 `concurrency > 1`；
  ② 库里写着 `parsing` 但没人在跑的记录，`/api/parse` 会重新纳入而不是跳过；
  40 分钟前的残留被 `GET /api/literature` 收回成「中断」；批量重新解析也能救活。
- 全量：**509 项全绿**（Node 20.10.0 与 Node 22.22.2 各跑一遍）；浏览器端两轮实机验证
  （点 9 个不同列 + 空单元格 + 复选框，8 篇并发解析的进度面板）全部通过。


## v1.29.0：解析进度可见（PDF 抽取移出主线程）+ 列字段净化 + 详情卡片划词标注（2026-10-26）

> 用户要求：「针对文献中心的解析功能，无论重新解析还是批量解析都要能够显示解析进度，
> 而且针对期刊、年份、DOI 等字段，要求返回干净的字段，不要其他内容」+
> 「同样，这个卡片中的内容也要支持高亮或者改变字体颜色标注」。

### 解析进度：先把「主线程被占死」这个真问题解决掉

- 现象：点重新解析后只有一句 toast，全程无反馈。
- 根因（实测）：`extractPdfText` 在主线程跑 pdf.js，一篇 150 页学位论文占 CPU 数秒到十几秒；
  期间请求 `/api/parse/progress` **耗时 10.5 秒**才返回 —— 光做进度接口没用，事件循环必须先空出来。
- `src/pdfTextCore.js`：把原 `pdfParser.js` 的纯实现抽出来（`extractPdfTextInline`）。
- `src/pdfTextWorker.js` + `src/pdfTextPool.js`：worker 线程池（`PDF_TEXT_WORKERS` 默认 min(2,CPU)，
  上限 3；空闲 60s 回收；单篇 240s 超时后 terminate 重开）。业务错误用 `err.pdfParseError` 标记，
  只有**线程级故障**才回退主线程重跑，同一份坏文件不会被跑两遍。
- `src/pdfParser.js`：缩成对外入口，先走线程池、失败回退主线程；`PDF_TEXT_INPROCESS=1` 可强制主线程。
- `src/parseProgress.js`：内存态作业槽（`start/setStage/finish/snapshot`），阶段
  `queued → extract → ai → rank → save → done|error`；`parseRecord(record, settings, docType, tracker)`
  每步打点，`done/failed/percent/current` 现算。重复 `finish` 不重复计数（并发晚到事件不会改回状态）。
- `server.js`：`/api/parse`、`/api/literature/:id/parse`、`/api/literature/batch-reparse` 三个入口
  共用同一个 tracker，新增 `GET /api/parse/progress`。
- 前端：`withParseProgress()` 包住阻塞的 POST，轮询 700ms；面板显示「操作标签 + 完成/总数 + 进度条 +
  当前篇目阶段 + 每篇一行」。上一轮作业的残留快照不画（否则会先闪一下"上次已完成"），
  结束后 1.8s 自动收起。
- 实测收益：同一批 3 篇学位论文 9.3s → 5.9s（线程池真并行），期间进度接口响应 2-5ms。

### 列字段净化：提示词 + 服务端确定性清洗

- 提示词里把 title/authors/journal/year/doi/keywords 单列为「列字段」，逐项写死禁止项。
- `aiExtractor.js` 新增 `cleanJournal / cleanYear / cleanDoi / cleanTitle / cleanAuthors /
  cleanKeywords / cleanMetaFields`，`normalizeResult()` 与规则兜底路径都过一遍。
- 取舍：**缺失返回空串**而不是「原文未报告」，因为列里显示标签比空值更像脏数据。
- 例：`Journal of Business Ethics（SSCI Q1，影响因子 6.9，JCR 2023）` → `Journal of Business Ethics`；
  `2023（在线优先），2024（正式出刊）` → `2023`；`DOI: https://doi.org/10.1007/s10551-023-05371-7.`
  → `10.1007/s10551-023-05371-7`。

### 详情卡片划词标注

- 渲染：`<div class="md">` → `<div class="md md-annotatable" data-field="…">`，渲染后
  `applyFieldAnnotations(it)` 贴回标记。
- 定位：`{ target:'field', field, start, end, quote, kind:'highlight'|'text', color }`，
  偏移按容器 `textContent` 计；原句对不上时全文 `indexOf(quote)` 重定位，再找不到就跳过。
- 包裹：不能用 `range.surroundContents`（跨 `<li>/<p>` 会抛 InvalidStateError），
  改为按文本节点切分逐段包 `<mark>`，`textContent` 长度不变 → 偏移可复用。
- 工具条 `#annoToolbar`：4 底色 + 4 字色 + 清除；`mousedown` preventDefault 保住选区；
  滚动/关抽屉/切文献自动收起。存储走 `PATCH /api/literature/:id { annotations }`，
  `server.js` 里对 `target:'field'` 的条目夹住数值范围。
- 兼容：`filteredAnnotations()` 过滤掉 `target:'field'`，阅读器「笔记与高亮」不会出现「第 undefined 页」；
  EPUB 的 `attachAnnotation` 本来就会在无 `cfi` 时返回 false。

### 测试

- `test/parse-progress.test.mjs`（11 项）：进度计数/阶段/失败/重复收尾/空态/长标题截断，
  以及清洗函数与提示词要求。
- `test/pdf-text-pool.test.mjs`（4 项）：手搓最小 PDF 走线程池（断言池里确实有线程被用起来，
  防止有人把抽取改回主线程）、`PDF_TEXT_INPROCESS=1` 回退可出同样结果、非 PDF 与空文件的报错。
- 全量 `node --test`：Node 22 / Node 20 各 **495/495**；浏览器全量回归 **75/75**，0 JS 错误。

## v1.28.0：侧边栏尺度统一 + 实证类字段体系重做（2026-10-26）

> 用户要求：「优化侧边栏，保留内容、配色与交互沿用现有样式，统一字号、圆角和间距，
> 同级面板圆角一致，侧栏两侧留白一致，图标略小于文字，图文间距保持一致，每行放得下文字和
> 上下留白，点击区域也要足够大；组间比组内更松，间距遵循统一规则」+
> 「修改文献中心的字段（实证类 20 个字段，含研究问题 / 研究对象 / 核心结论 / 作用机制 /
> 边界条件与异质性 / 对综述有什么用 / 研究空白）；同时修改相应提示词，我的思考同样要由用户
> 自己填写」+「完成直接发布」。

### 侧边栏：把散落的尺寸收成一套变量

- 之前：字号 14 / 13 / 12.5 / 11 / 10.5 五种，圆角 7 / 8 / 10 三种，行高 31.5px，
  组内间距 1px、组间靠 `.nav-section-label` 的 13px 内边距凑出来，图标 17px 比 13px 文字还显眼。
- 现在：`.sidebar` 上定义 `--side-pad-x: 12px`、`--side-radius: var(--radius)`（10px，与
  `.card` 等同级面板一致）、`--side-font: 13px`、`--side-icon: 15px`、`--side-gap: 10px`、
  `--side-row-h: 34px`、`--side-space-in: 3px`、`--side-space-out: 12px`；
  `.profile-card` / `.side-search` / `.nav-item` / `.nav-section-label` / `.side-foot` /
  `.side-icon-btn` 全部改引用变量，配色与交互（hover / active / 指示条动画）一字未动。
- 组内间距改用 `.nav-item + .nav-item { margin-top }` 而不是 `flex gap`：`gap` 会把「分组标题↔
  第一行」也算一份，5 个分组白吃 20px。改完导航总高度 673px → 674px，行高却从 31.5 涨到 34。
- `.nav-item` **不能**加 `overflow: hidden`（会裁掉 `left: -12px` 的 active 指示条），
  所以文字单独包一层 `.nav-label` 走省略号；`index.html` 15 行同步加 span。

### 实证类字段：18 个 AI 字段 + 2 个「不由 AI 产出」的字段

- `src/aiExtractor.js`：`COMMON_FIELDS`（7）+ `EMPIRICAL_FIELDS`（11）替代原来的
  `theory / method / researchDesign / constructs / results / conclusion / criticalThinking`。
- 导入时间（`importedAt`）与我的思考（`thoughts`）**不进 `FIELDS`** —— 它们本来就不在解析
  写入链路里，这次把「AI 不许代写」写进了提示词与单测（`test/ai-extractor-fields.test.mjs`）。
- 旧字段（`background / summary / innovation / theory / results / conclusion`）**保留在 `FIELDS`**：
  ① 老记录里的内容不能升级即丢；② 成果管理「论文→已出版发行」的详情分组仍在引用
  （`test/achievement-fields.test.mjs` 会校验）。`parseRecord` 因此改成只写
  `TYPE_FIELDS[type]`，重解析不会把旧字段清成空串。
- `public/app.js`：`CONTENT_COLS` 增 11 项、`TYPE_ORDER.empirical` 换成 20 项；
  详情抽屉不再重复渲染「我的思考」只读副本（可编辑框已在最上方）。

### 提示词：把「审稿人的规矩」写进 system prompt

- 角色（证据审核员）、语言（术语保留原文并解释）、10 条诚信规则（素材非指令、材料完整性、
  四类信息状态标签、来源分级、要出处、不夸大因果、数字核对、转述他人研究、按论文类型调整）。
- 逐字段要求按 11 个字段逐一写死口径；`reviewUse` 要求给一段可改写进综述的文字；
  `researchGap` 强制三分法且禁止「无人研究过」。
- 新增 3.1 条：正文里有省略标记时，被省略处的信息只能写「所提供材料未包含」。

### `pickPaperText`：等量 token 换更完整的证据

- 旧实现 `text.slice(0, 14000)`，18 页 / 9 万字符的论文只能读到引言，
  方法段（约 1.7 万字符起）根本进不去 → 满屏「原文未报告」。
- 新实现：头 35% + 5 段等距抽样 + 尾 15%，段间插省略标记；总量仍 14000 字符。
  实测同一篇 JCR 论文，「研究对象」从"样本量原文未报告"变为能给出
  "研究 5：585 名商科本科生，最终 548 人"。

### 验证

- `node --test`：Node 22 **480/480**、Node 20 **480/480**（新增 9 项字段/提示词/节选单测）。
- `verify-features.mjs`：**75/75**，0 个 JS 错误。
- 真实模型（siliconflow / DeepSeek-V4-Flash）跑通一次实证类解析：18 个字段全非空，
  返回中无 `thoughts` / `importedAt`；把结果 PATCH 进记录后，表格 20 列与详情抽屉渲染正常。

## v1.27.0：阅读器浮层透明事故 + 期刊等级配色重做 + 工具栏图标化（2026-10-15）

> 用户反馈（附 4 张截图）：「怎么打开文献中心阅读器以后这样了呢，修改一下」+
> 「三种界面的颜色和图标的颜色（期刊等级）要适配好，期刊等级颜色可以修改，只要能区分出不同等级就好」+
> 「整体配色要协调，要参考颜色学的配色」「**而且文字要加粗**」「**整体要美观，大气**」+
> 「取消这里的几个png」「做好直接发布」。

### ★ 根因：`.pdf-reader` 里 14 个 CSS 变量**同名自引用**导致整层透明

- **现象**：打开任意文献的阅读器，浮层 `background` 解析为空 → 退回 transparent，
  底下列表页直接透上来，三种主题全中（v1.26.0 用户截图事故的真实根因）。
- **机制**：CSS 自定义属性在**元素自身作用域内先解析**，`--bg: var(--bg)` 于是指向自己 →
  形成循环依赖 → 该变量在 computed-value 阶段被判 **invalid（IACVT）** →
  `background: var(--bg)` 落到 `unset`（即透明）。**不是** 继承来的值被覆盖，而是整条链断掉。
- **溯源**：这段映射自 v1.25.0 就在，26 行声明里有 **14 个**是纯自引用；
  v1.26.0 的配色改动把它触发显形（此前 `--bg` 恰好等于默认值，看不出差别）。
- **修法**：删掉 14 个纯自引用，只保留「真正换值」的映射（`--primary: var(--text)` 等）。
  并在块首加警示注释：**凡是「与主题同名」的变量，一律别在 `.pdf-reader` 里重复声明。**
  实测三主题 `--bg` 解析为 `#f2f2f7` / `#000000` / `#f4ede0`。
- **定位工具**：`verify-cssvar-cycle.mjs`（正则扫 `--x: var(--x)` 同形声明）、
  `verify-reader-themes.mjs`（三主题下读 `getComputedStyle` 实际解析值）。

### `setLayoutBtn` 把 HTML 当文字画在按钮上（用户说的「几个 png」）

- `btn.textContent = label` 而调用方传 `` `${ico('puzzle')}版面 ${n}` `` →
  `<svg …><use …/></svg>` 被**转义成纯文本**直接渲染在按钮上。
- 修法：函数内只维护一个 `.plb-text` span 写文字，图标由 HTML 固定承担；
  4 处调用改传纯文本（`版面 ${n}` / `解析中 ${p}/${t}`）。
  另清掉 4 处同类泄漏（`pxStatus`、`maTestResult` 等用 `textContent` 拼 `ico()`）。

### 期刊等级 6 档配色重做（`public/style.css`）

- 旧实现：gray 档 `background: var(--muted)` —— **把文字色当背景色**，对比度 **1.19:1**。
- 新实现：新增 `--rank-<tone>` / `--rank-<tone>-bg` 两组变量 × 三主题（共 36 个值），
  统一「柔底 + 饱和字」胶囊样式，取消实心色块（实心块深色下白字压亮红仅 3.41:1）。
- 色彩学：6 档按「档位越高越热」排色相弧（绯红 355° → 玫红 324° → 琥珀 36° →
  青蓝 210° → 松绿 147° → 石板灰 240°/饱和仅 5%），相邻档色相差 ≥45°。
- **档位名称是对外契约**（拼进 class 名 + 被 `test/rank-utils.test.mjs` 断言），
  改外观只动 style.css 色值，`rank-utils.js` 逻辑一行未动（仅补注释）。
- 实测对比度：浅 6.02~8.23 / 深 5.58~7.44 / 护眼 5.72~7.61，**18 组全部 ≥4.5:1**。
- ⚠️ **`getComputedStyle` 读不到渐变背景会假阳性**，最终用 `realpx-rank-v1270.mjs`
  在真实截图上逐像素采样复核（背景采样取「与文字色差异最大」的像素，不能取最亮像素）。

### 阅读器工具栏图标化 + 全站加粗（`public/index.html` / `public/style.css` / `public/app.js`）

- 新增 5 个图标 symbol：`i-zoom-out` / `i-fit-width` / `i-rotate-left` / `i-rotate-right` / `i-rotate-reset`。
- 缩放/旋转按钮从 `－ ＋ ⤢ ↶ ↷` 文本字符改为 SVG；`#prRotationLabel` 由 `<span>` 改 `<button>`，
  点击归零（`rotateCurrentPage(-cur)`）。
- 高亮色 4 个按钮移除硬编码 `style="background:#…"`，改走 `--hl-*` 主题变量。
- `body { font-weight: 500 }`（原 400，中文字体里偏细）、表头 700 + `letter-spacing`、
  单元格 500；`--radius` 8→10 / `--radius-sm` 6→7 / `--radius-lg` 12→14。

### 测试证据

| 项目 | 结果 |
| --- | --- |
| 单测 Node 22 | **471 / 471** |
| 单测 Node 20（v20.10.0） | **471 / 471** |
| 全量功能回归（`verify-features.mjs`，44 项） | 40 / 44，4 项失败经 `git stash` 比对与 **HEAD 基线完全一致** |
| 对照精读 E2E（`cmp-e2e.mjs`） | **74 / 74**，0 JS 错误 |
| 自动管线 E2E（`auto-e2e.mjs`） | **11 / 11**，0 JS 错误 |
| 三主题 × 5 视图控制台（`verify-v1260.mjs`） | **0 错误** |
| 期刊等级真实像素对比度 | **18 / 18 ≥ 4.5:1** |

> ⚠️ `verify-features.mjs` 一直存在于 `C:/Users/zjy1998/.workbuddy/zotero-lit-e2e/`
> （不在 `D:/work/.wbverify/`，别再去那儿找）；它**不自带服务**，依赖 `127.0.0.1:3000` 已有实例。
> 本轮用 `D:/work/cmp-test-server.mjs` 起隔离服务（数据目录 `D:/work/cmp-test-data`），
> **不碰项目自带 `data/`**。

---

## 可读性修复与视觉收尾：对比度事故 + emoji 清零 + iOS 式过渡（2026-10-15，v1.26.0）

> 用户反馈（附「顶刊追踪」页截图）：「这里各个文字都看不见了，对比度不够明显」+
> 「减少所有界面 emoji 的使用 / 去除 AI READY，去除 AI 生成的标签 / 整体的配色你要再重新规划一下 /
> 不同的界面切换时能不能使用渐入式效果，更贴近 IOS 效果 / 减少没用的标签与文字」。

- **★ 根因：`--muted` 变量取值错误导致整页小字隐形**（`public/style.css`）：
  - v1.25.0 重做配色时把 `--muted` 设成了**面板色** —— 浅色 `#f0f0f4`（近白，与白底对比度 1.05）、
    深色 `#2c2c2e`、护眼 `#efe6d3`。而全站有 **22 处直接把它当 `color` 用**。
    于是「顶刊追踪」页的 `.top-journal-head p`、`.tj-stat span`、`.tj-journal-options small`、
    `.tj-bulk-toolbar` 等**全部变成白底白字**。
  - 修法：三套分别改为 `#5f5f66` / `#a1a1a8` / `#665c48`，并在变量旁加注释警示
    「**别再写回面板色**：它被 22 处直接当 color 用」。
  - 定位手段：自建 `audit-css-color-vars.mjs` —— 解析 style.css 三套主题块，对每个**被当 color 用**
    的变量算它与 `--bg` / `--surface` 的对比度并排序。这个脚本是本轮最有价值的产物。
- **三套主题文字层级按 WCAG AA（≥4.5:1）整体重定**（`public/style.css`）：
  - `--text-2` / `--text-3` / `--side-muted` / `--gray` / `--ink-2` / `--ink-3` 整族上调，最差 4.74。
  - 强调色：浅色 `--accent` `#007aff`（4.02）→ `#0066d6`（5.42）；`--green` `#248a3d`（4.40）→
    `#1f7a35`（5.39）；护眼 `--accent` / `--star` `#a8762c`（3.75）→ `#8e6220`（5.06）。
  - 侧边栏活动项：深色 `--side-marker` `#7d7aff`（4.13）→ `#a5a2ff`（6.24）；
    护眼 `#7a5c33`（4.45）→ `#6a4f2a`（5.48）。**注意活动项背景是 `--side-active` 半透明叠底，
    不能拿纯面板底色估，必须用截图取真实像素。**
  - ⚠️ **验证方法**：`getComputedStyle` 拿不到渐变背景，会把侧边栏/横幅误判成低对比度（假阳性）。
    最终采用 `contrast-realpx.mjs` —— 截图取真实像素；且**背景采样必须取「与文字色差异最大」的像素**，
    早期版本取"最亮像素"，在深色主题下正好命中浅色字形本身，把好端端的 8.18 误报成 1.00。
- **移除 AI 痕迹与冗余标签**：
  - 删 `index.html` 的 `AI READY` 徽标 + `Research Workspace` 副标题 + 顶栏页面副标题
    （`#topbarPageSub`），并同步删 CSS 规则与响应式断点里的引用。
  - ⚠️ `switchView` 里原本写 `$('topbarPageSub').textContent = page.sub` —— 元素删了之后这是
    **同类 null 崩溃风险**（见 v1.25.0 的教训），已主动加 `if (t)` 兜底并改为只取 `<b>`。
  - 删 `col-ai` 类（表格「AI 生成」标签）2 处渲染 + 2 处 CSS。
- **emoji 从 357 处降到 13 处（降幅 96%），且残留全是注释/默认值**：
  - 工具：`swap-js-emoji-ast.mjs`。**前 4 版判定逻辑都不可靠**（不考虑引号类型 / 跨行模板串误判 /
    `${}` 内嵌引号误判 / 行内就近配对太保守只找到 10 处）。最终用 **acorn 解析 AST**，
    精确区分 `TemplateElement`（可插 `${ico()}`）与 `Literal`（只能删），80 处替换 100% 可靠。
  - 语法自检用 **acorn 重解析**，不用 `node --check` —— 本沙箱禁止 spawn 子进程
    （`execFileSync` 会 `EBUSY`）。
  - 图标精灵 `index.html` 从 54 扩到 **105 个** `<symbol>`。
  - ⚠️ **`ico()` 原先是 `app.js` IIFE 内的局部常量**，而 `thesis.js` / `achievements.js` 是
    **各自独立的 IIFE**，替换后直接调 `ico()` 会抛 `ReferenceError: ico is not defined`
    → 整个模块渲染中断。已改为 `window.ico = ico`。
    （脚本加载顺序是 thesis/achievements 先于 app.js，但它们的 `ico()` 调用都发生在
    **渲染时**而非定义时，所以运行时能取到 `window.ico`。）
  - ⚠️ **AST 脚本按设计只删不换字面量内的 emoji**，导致这些**类型图标被清空**：
    `LIB_META.icon`、`typeIcon()` 的 `attach`/`actions`/`rank`、`achievements.js` 的
    `catOf().icon` 与文件夹 `📁/🗂️` 三元。已逐个补回（`typeIcon` 返回值进 innerHTML，
    所以必须返回 SVG；`CATEGORIES[].icon` 存的是**图标名**，由前端 `ico(c.icon)` 渲染）。
  - 新手引导的 `OB_STEPS[].emoji` / `points[].ico` 也一并换成图标名；引导要点原来靠
    CSS `content: attr(data-ico)` 渲染文本，**伪元素取不到 `<use>`**，改为内联 `<svg>` 节点。
  - 头像默认值 `🎓` → 空（前端 `avatarHtml()` 回落到姓名首字）。
- **iOS 式渐入过渡**（`public/style.css` + `public/app.js`）：
  - 视图切换 `cubic-bezier(.32,.72,0,1)` 0.3s，淡入 + `translateY(8px) scale(.992)`。
    ⚠️ **不加 `animation-fill-mode: forwards`** —— 视图是常驻 DOM 靠 `.hidden` 切换，
    永久保留 `transform` 会创建层叠上下文，破坏 sticky 表头与 `position:fixed` 浮层定位。
  - 侧边栏活动指示条 `cubic-bezier(.34,1.4,.64,1)` 弹性缩放。
  - 主题切换由 `applyThemeMode` 临时挂 `html.theme-anim`（280ms 后移除）。
    ⚠️ **不做常驻 `transition`**：会让滚动条颜色/阴影/焦点环等一切颜色属性都带 0.26s 延迟，
    拖窗口、缩放字号时出现颜色拖尾。
  - `prefers-reduced-motion` 降级为纯淡入 + 关闭过渡。
- **验证**：单测 **471/471 通过**（Node 20.10.0 与 Node 22.22.2 各一次）；
  三主题 × 6 视图截图核对，**控制台 0 报错**；真实像素对比度复核全部 ≥ 4.5；
  图标完整性脚本（`check-icons.mjs` + `check-dynamic-icons.mjs`）校验 105 个定义与全部引用
  （含 `c.icon` / `p.ico` / `step.emoji` 这些动态取值）一一对应。

## 界面整体重构：三套主题 + 导航重排 + SVG 图标系统（2026-10-15，v1.25.0）

> 用户指令：「用这个 skill（ui-ux-pro-max）重新设计这个软件的 UI 界面，去除 AI 模板式的图标，
> 配色自拟，要参考 iOS 系统配色，支持深色、浅色、护眼模式等」
> → 追问后明确扩大范围：「**我要的是整体界面的重构，就保留功能，具体的排布方式等等都要改变**」。
> 设计方向取 skill 检索出的 **Minimalism & Swiss Style**（明确支持明暗双模式、适合信息密集型专业工具）。

- **主题系统换核**（`public/style.css` + `public/app.js`）：
  - 旧方案「单变量色相派生」（`deriveTheme` / `applyTheme` / `renderThemePresets` / `hexToHsl` /
    `hslToHex` / `THEME_PRESETS` / `DEFAULT_THEME`）**整体删除** —— 它只能从主色算出一套明度反转的
    深色，**做不出护眼模式**（护眼要换色相，不是调明度）。
  - 新方案：`<html data-theme="light|dark|sepia">` 驱动 `style.css` 里**三块完整的 CSS 变量集**
    （`:root,[data-theme="light"]` / `[data-theme="dark"]` / `[data-theme="sepia"]`，各 60+ 变量）。
    JS 只负责切属性 + `localStorage`(`uiThemeMode` / `uiThemeFollowSystem`) + 监听系统外观。
  - 配色取 iOS 系统色：主色 System Indigo `#5856D6`、强调 System Blue `#007AFF`；
    深色按 iOS 层级灰 `#000 / #1C1C1E / #2C2C2E / #3A3A3C` 分层；
    语义色明暗两套（`#34C759/#FF9F0A/#FF453A` → `#30D158/#FF9F0A/#FF453A`）。
    护眼模式是暖米底 `#f4ede0` + 暖黑字 `#3a3327` + 暖褐主色 `#8a6b3f`。
  - ⚠️ **踩坑（最隐蔽的一处）**：从 `index.html` 删掉旧主题选择器（`#themeColorPicker` /
    `#themeColorInput` / `#btnThemeApply` / `#btnThemeReset`）后，**`bindEvents` 里对应的 6 行
    事件绑定没删** → 元素为 `null` → `null.addEventListener` 在 `init()` 早期抛
    `TypeError`，**整个应用初始化中断、15 个导航项全部点了没反应**。
    表面上页面"长得正常"（CSS 与 HTML 已经渲染），所以只靠肉眼看很难发现，是**截图脚本
    收集 pageerror 才暴露的**。教训：删 DOM 元素必须同步删事件绑定。
- **服务端放行 `themeMode`**：`src/store.js` 加默认值 `themeMode:'light'`；
  `server.js` 的 `POST /api/settings` 加**白名单校验**（只认三个值，非法回落 `light`），
  防手改 `settings.json` 写入非法主题导致前端一片空白。
  （注：`saveSettings → migrateSettings(modelCatalog) → syncLegacyFields` 这条链**不会**吃掉
  未知字段，已读代码确认；白名单是额外的一道防线。）
- **信息架构重排：15 个模块从 3 组 → 5 组**，按真实科研动线（文献 → 读 → 投稿）排序：
  | 分组 | 模块 |
  | --- | --- |
  | 概览 | `home` |
  | 文献 | `library` `thesis` `topjournals` **`papers`** |
  | 研究 | **`projects`** **`tasks`** `mail` |
  | 写作 | `notes` `markdown` `ideas` `reviewer` **`achievements`** `ai` |
  | 工具 | `worldlib` |
  三处关键移动：`papers` 从「研究工作」末尾**提到「文献」组**（投稿与文献本就相连）；
  `projects`/`tasks` 独立成「研究」组；`achievements` 归入「写作」组。
- **布局改动**：
  - **顶栏**：去掉搜索框 → 换 `#topbarPageTitle`（当前页面名 + 一句副标题）。
    新增 `VIEW_META` 常量（`public/app.js`，15 条 `name`/`sub`），`switchView(v)` 里同步
    `#topbarPageTitle` 与 `document.title`。
  - **侧边栏**：搜索框入驻（`.side-search` / `#sideSearchInput`），**只在「文献中心」显示**
    （搜索本就只作用于文献）。`switchView` 里原 `$('searchInput').classList.toggle(...)`
    改为切 `.side-search` 的显隐；`#searchInput` 已从 HTML 移除，JS 侧保留 `if` 兜底。
    底部「设置 / 检查更新」两个按钮改成一排 `.side-icon-btn`；宽度 224 → 232px；
    `.nav-item.active` 前景色从 `--side-text` 改为 `--side-marker`。
  - `.profile-avatar` 从固定 emoji `🎓` 改为**姓名首字**（`profile.name.slice(0,1)`，
    用户自定义 `profile.avatar` 仍优先）。
- **SVG 图标系统替代 emoji**：
  - `index.html` 的 `<body>` 起始处新增 `<svg class="icon-sprite">` + **54 个 `<symbol id="i-*">`**，
    统一 **24 网格 / `stroke-width:1.5` / `stroke:currentColor`** → 图标颜色**永远跟随所在文字**，
    三套主题零额外适配。用法 `<svg class="ico ico-sm"><use href="#i-xxx"/></svg>`。
    CSS 侧 `.ico`(17px) / `.ico-sm`(14px) / `.ico-lg`(20px)。
  - **静态 HTML 里的 emoji：136 行 → 2 行**（剩 1 行是说明注释、1 行是「头像 Emoji」输入框本身）。
    分 5 轮脚本替换（`D:/work/.wbverify/swap-emoji-html{,2,3,4,5}.mjs`），**全部白名单精确匹配、
    不做泛化正则**（避免误伤正文里的 emoji）。
  - 模型健康状态图例 `🟢🟡🔴` 改为 CSS 圆点 `.rt-led.ok/.warn/.bad`（语义色由主题驱动）。
  - ⚠️ **未完成**：`app.js`（254 行）/ `thesis.js` / `achievements.js` 里以 **JS 字符串动态拼接**的
    emoji 尚未替换 —— 那些是 `'<div class="side-lib-ico">📁</div>'` 之类的片段，
    要么改字符串、要么改 CSS `content:`，需成对动 HTML+CSS，风险高于静态替换，留作下一轮。
- **验证**（脚本在 `D:/work/.wbverify/`，起独立数据目录服务，**不碰项目 `data/`**）：
  - 单元测试 **Node 20.10.0（贴近 CI 的 20.19.0）与 Node 22.22.2 各跑一次，均 471/471 全绿**。
  - `public/app.js` 无语法错误；`node -e` 脚本核对 **54 个 symbol 全部有引用、0 处失效引用**。
  - Playwright 截图 + 断言（`shot-ui.mjs`）：结构 / 三主题实渲色逐字节核对 / 14 视图切换 /
    主题卡片 / **pageerror 收集（0 条）**。
  - 浏览器全量回归 `verify-features.mjs`：**63/64**，唯一失败项「打开会话后 AI 气泡带
    「📥 导入笔记」按钮」经定位与本次改动无关 —— E2E 把会话写入**隔离数据目录**
    （`tmp/serve-data/data`），需配套跑 `serve-3000.mjs`。
  - ⚠️ **数据保护教训**：本轮先用 `node server.js` 起了实例（指向**项目真实 `data/`**），
    导致 E2E 的写操作落在真实数据上（`conversations.json` / `pdf-translate-cache.json` /
    `translations/` 被改动）。已 `rm -rf data && cp -r <备份> data` **字节级还原**并二次 `diff -rq` 确认。
    **正确做法：必须跑 `zotero-lit-e2e/serve-3000.mjs`**（它指向隔离目录）。
    另：隔离目录若被 `rm -rf` 重建，需把 `settings.json` 的 `onboarded` 置 `true`，
    否则新手引导遮罩 `#onboarding` 会拦截全部点击（`verify-features.mjs` 不处理引导）。
  - 设计说明页产出在 `docs/ui-redesign-v1.25.0.html`（自带三主题切换的静态报告）。

## AI 用量优化：对话按需注入、翻译失败二分拆批、自动翻译默认免密钥引擎（2026-10-14，v1.24.6）

> 用户指令：「仔细检查这个项目，为什么 token 消耗得那么快，尤其是解析版面的功能，用的是什么」
> → 追问后选定：优化 ①②④，且「自动翻译默认使用免费翻译引擎，火山那个」。

- **先定位，别乱改**：版面解析（`processor/dist/main.mjs` + `processor/dist/models/*.onnx`，
  PP-DocLayoutV3-FP16，67MB，随包分发）由 `src/layout.js` spawn 成独立子进程，纯本地推理。
  `grep -c "fetch(" processor/dist/main.mjs` = **0**；全仓唯一 `fetch` 在
  `processor/src/prepare-model.ts`（仅构建期下模型，运行时不执行）→ **零 token**。
  真正的消耗来自「解析完自动接上的整篇翻译」与「AI 对话每轮重发全文」，账单记错了地方。
- **① 对话不再每轮灌全文**（`public/app.js` + `public/pdf-reader-utils.js`）：
  - 旧行为：`buildPaperContext()` 把解析全文直接拼进 system prompt，`LIMIT = 60000`，
    且 `sendPrChat` **每发一条消息都重发一遍**（还带最近 8 条历史）→ 多轮近似 N²。
  - 新行为：全文先切段缓存，每轮 `prPickContextSegments(query)` 按提问打分取最相关的 3–12 段
    （按原文顺序拼回），单轮注入 ≤ `PR_CTX_INJECT_MAX = 16000` 字符；
    仅 `prNeedsWholePaper(query)`（总结 / 概括 / 全文 / overview / main point…）才退回
    `prCondensedFullText()`（头 72% + 尾 28%）。
  - 纯算法抽到 `public/pdf-reader-utils.js`（`splitContextSegments` / `queryTokens` /
    `pickContextSegments` / `condensedFullText` / `needsWholePaper`），app.js 只留「读缓存 + 套上限」的壳，
    便于 vm 沙箱单测。
- **② 全文字符上限 60000 → 30000**（`PR_CTX_CACHE_LIMIT`），单轮注入硬顶 16000（服务端单条消息截断在 20000，留余量）。
- **③ 翻译批次失败改「二分拆批」**（`src/pdfTranslate/engines.js` 的 `translateSegments`）：
  旧行为是整批 3 次退避仍失败后 → **逐段各发一次请求**，每次仍带完整 system prompt
  （12 段的批坏 1 段 = 1 + 12 = 13 次请求）。新行为 `translateBatchRecursive()` 递归对半拆，
  先探测哪一半坏、只把真正失败的段隔离出来（同例 13 → 9 次）；`withRetry` 只在最外层做退避，
  子批不叠加重试（`retryAttempts: 1`）。
- **④ 自动整篇翻译默认走免密钥火山网页版**：`CMP_AUTO_ENGINE = 'volcweb'`，`autoCmpPipeline`
  ④ 步 `startCmpTranslate({ engine: 'volcweb' })`。顺手修了三处会让这条失效的坑：
  - 服务端 `normalizeOptions` 白名单只认 `['auto','llm','deepl']` → **`volcweb` 被静默重置成
    `auto`**（= 回落大模型继续烧 token）→ 改为放行 `volcweb`（`src/pdfTranslate/index.js`）；
  - 前端 `startCmpTranslate` 只处理 `llm:` / `deepl` 前缀，其余 provider id 被吞成 `auto`
    → 改为把 `raw` 原样透传（并写回 `cmp.engineSrc`）；
  - 启动面板 `#cmpEngine` 下拉补上「火山翻译 · 网页版（免密钥）（推荐）」项
    （手动模式仍以面板选择为准，`opts.engine` 优先）。
- **⑤ 顺带修掉自动管线「抢界面」的打断问题**（`public/app.js`）：自动管线在译文就绪时会
  自动 `openCmpMode()`；但长文档整篇翻译要好几分钟，用户往往已经点开「笔记模式」在记笔记了，
  这时被强行切到对照精读很唐突（且 `openCmpMode` 内部会 `closePnNoteMode()`，正在写的笔记被挤掉）。
  现在两条自动入口都先看 `pn.on`：
  - 作业完成回调（`subscribeCmpJob` 的 `onDone`）：用户在笔记模式时只把徽标置为
    「翻译完成，可点『📖 对照精读』进入」，不再调 `openCmpMode()`；
  - 打开即有译文的快进分支（`autoCmpPipeline` ①）：同理，只提示不抢。
  手动入口不受影响（`openCmpMode` 里仍会关掉笔记模式），想看译文随时点工具条按钮。
  该问题自 v1.24.1 引入自动管线起就存在，本轮跑全量浏览器回归时暴露
  （老脚本在「进入笔记模式」处被自动切走的对照精读挡住，卡住 30s 超时）。
- **取舍（已在 UI 说明）**：火山网页版接口 `maxItems: 1` → **逐段请求**，且节流是全局共享的
  （220ms），一篇 300 段的论文约需 1 分钟以上。零 token，但比大模型批量翻译慢。
- **调试钩子**：`window.__cmpAutoEngine`（覆盖自动管线的引擎选择）—— 否则 E2E 会打真实外部接口。
- 测试：新增 `test/ai-token-budget.test.mjs`（拆批的真实行为断言 + 「改回去就红」的接线断言：
  引擎白名单、注入上限、自动引擎默认值）；`test/pdf-reader-utils.test.mjs` 补检索/切段用例。
- 验证：单测 Node 22 / Node 20 全量各 **471/471**（两版本都跑了）；
  浏览器全量功能回归 **75/75**（修复「自动管线抢界面」后，此前被卡住的「笔记模式 / 思维导图」
  23 项全部恢复）；自动管线 E2E **11/11**（零点击 7.3s 进对照）。
- 环境备注（供下次发版复用）：`verify-features.mjs` 有两处前置数据要求 ——
  ① 新数据目录会弹一次性引导层（`#obBackdrop`）拦点击，须先 `POST /api/onboarding/done`；
  ② 脚本按源码直接调 `store`，默认写仓库 `data/`，须 `store.configure({ dataDir })` 对齐
  服务实例的数据目录（否则「AI 助手导入笔记」组读不到会话）；顶刊 DOI 组需要
  数据目录里有 `top-journals.json`。
- 改动文件：`public/app.js`、`public/pdf-reader-utils.js`、`src/pdfTranslate/engines.js`、
  `src/pdfTranslate/index.js`、`test/ai-token-budget.test.mjs`(新)、`test/pdf-reader-utils.test.mjs`。

---

## 划词翻译可选引擎 + 重译统一引擎（2026-10-14，v1.24.5）

> 用户指令：「划词翻译要支持选择翻译引擎，而且原文框重译不要每重译一次都选择一次，可以在顶端统一设置」

- 划词翻译面板顶部加引擎选择器 `#prSelSource`（跟随全局设置 / 各模型 / 各服务），
  `doPanelTranslate` 就近读它（非 auto）→ 回落设置页 `#prTranslateSource`；选择记 localStorage `prSelSource`。
- 对照精读顶部工具条 `#cmpBar` 加引擎选择器 `#cmpBarEngine`（常驻），`fillCmpForm` 里用
  `/api/translate/sources` 填充（dataset.filled 守卫防重复）。
- `cmpTranslateBlock` 翻译源优先级：显式 source → `#cmpBarEngine`（工具条）→ `#cmpEngine`（启动面板）
  → `#prTranslateSource`（设置页）。
- `cmpRetranslateBlock` 不再弹浮层选引擎：直接用 `cmpTranslateBlock(id, {force:true})` 复用工具条引擎。
  删除 `#cmpRetransEngine` 浮层逻辑。
- 测试：E2E 重译断言从「弹浮层选引擎」改「工具条选引擎 + 直接重译（不弹浮层、单段 +1）」。
- 验证：单测 457/457（Node 20+22）、E2E 74/74。

---

## 还原「划词翻译」页签到右栏侧边栏（2026-10-14，v1.24.4）

> 用户指令：「还原原来的划词翻译功能，同样添加到侧边栏中」

- 右侧面板恢复「🌐 划词翻译」页签（`#prTabTranslate` + `data-prpane="translate"` 面板）：
  原文框 `#prSourceText`、拼接模式 `#prJoinMode`、清空 `#prClearSelection`、翻译按钮 `#prDoTranslate`、
  结果框 `#prTransResult` 全部还原（这些元素在 v1.24.0 删除时被移除，CSS 样式一直保留未删）。
- 翻译源 / 目标语言**不重复放**在面板里：继续读设置页的 `#prTranslateSource` / `#prLangTo`
  （全局共用，与对照精读单段翻译、笔记模式、邮件翻译一致），避免两处下拉不同步。
- JS 还原：`doPanelTranslate` / `translateSelection` / `resetSelectionTranslation` / `selectionHintText` /
  `translationPlaceholder` 补回；mouseup 选中文字后普通模式自动 `translateSelection`
  （自动切到划词翻译页签 + 立即翻译），工具条「翻译」按钮改回 `translateSelection`（不再走就地浮层）。
- 就地译文浮层 `#prSelTrans` / `showSelTrans` **保留**（未被工具条触发，属无害备用），
  删它要动 HTML/CSS/JS/测试四处，风险大于收益。
- 测试更新：pdf-reader-utils（prJoinMode/prClearSelection 从「应移除」改「应存在」）、
  pdf-translate（划词翻译面板断言 + 浮层断言并存）；E2E 划词翻译断言从「就地浮层」改「面板 + 切页签」。
- 验证：单测 457/457（Node 20 与 22）、E2E 75/75。

---

## 公式转 LaTeX 去全文 + 点击放大 150% + 原文栏居中 + 缩放丝滑（2026-10-14，v1.24.3）

> 用户指令：
> 「公式转latex不需要结合全文」「现在点击放大或者切换界面不丝滑，出现卡顿，能否渲染一下，
>  而且优化一下现在的软件运行速度」「点击原文放大的功能，放大到150%就行」「对于双栏的论文，
>  并没有保证文字框在画面的中心，我指的是文字框需要在原文的这个栏的中心」

### 1. 公式转 LaTeX 不再结合全文

`runBlockAi('latex')` 原来和「AI 解释」共用同一套「取解析全文 + 塞进 system 上下文」的流程。
现在公式转写是**纯看图**：跳过 `ensurePrFullText` / `buildPaperContext`，system 提示词换成独立的
「忠实转写公式」版本，不喂任何论文全文。这样既快（省掉一次全文准备），也不会被全文上下文带偏。
「AI 解释」仍保持结合全文不变。

### 2. 点击原文放大到 150%

`cmpZoomToBlock` 的 `ZOOM_TARGET` 从 1.9 降到 1.5。190% 对双栏论文放大太狠、横向溢出过多，
150% 更克制，配合「原文栏居中」刚好能看清单栏。

### 3. 文字框定位到「原文栏」中心（水平 + 垂直）

原来的 `cmpZoomToBlock` 只做**垂直**居中（只调 `scrollTop`）。双栏论文放大后页面宽度超过栏宽、
出现横向滚动，点右栏的文字框会停在页面边缘看不见。现在补上**水平居中**（同步调 `scrollLeft`），
把文字框的中心对齐到「原文栏」视口的中心 —— 水平、垂直都居中。

### 4. 缩放 / 切换视图不整树重建，更丝滑

卡顿的根子：缩放或切换视图时走的是 `rebuildAllPages()`，它清空 `#prPages` 重建所有占位符 +
重建 IntersectionObserver，把已渲染的几十页 canvas 一次全丢、再靠懒渲染重画。现在新增
`rescaleAllPages()`：**只更新每个 wrap 的占位尺寸、把已渲染页退回占位符**，然后主动重渲染当前
可见页（视口外的页仍靠懒渲染在滚过去时才渲染），不重建 DOM 树、不重建 observer。所有缩放入口
（点块放大 / 缩放按钮 / Ctrl+滚轮 / 视图切换 fitWidth）统一改走它。

> 顺手修掉一个 `rescaleAllPages` 引入的坑：已渲染页被清空后，IntersectionObserver 不会对
> 「一直停在视口内」的元素重新触发（isIntersecting 没变），导致可见页 canvas/文本层消失。
> 解法是清空后在下一帧主动 `renderPageInto` 当前可见页。E2E 抓到（「原文栏是真的 PDF」+ 划词全挂）。

---

## 对照精读交互细化 + AI 设置调整（2026-10-14，v1.24.2）

> 用户指令：
> 「点击原文的文字框的时候，自动放大，定位到原文位置」
> 「要支持该框内的文字重新翻译」「支持重新翻译的时候选择翻译引擎」
> 「AI 设置界面，将重要需要设置的内容提前，必须设置视觉模型」
> 「翻译提供方中火山翻译网页版后面标注（推荐）」

### 一、点原文文字框 → 自动放大并定位（`cmpZoomToBlock`）

对照精读里点 PDF 上的版面块，除了原来的「译文高亮 + 按需翻译」，现在还会**自动放大并定位**：

- 缩放低于 1.9 时提到 190%（已是放大态则不重复放大，连点不会越放越大）；
- `rebuildAllPages()` 重建占位后，懒渲染把目标页渲染出来，再把**块的中心对齐到视口中心**；
- 页面还在渲染（占位符状态）时用 rAF + 轮询等渲染完成再定位，避免量到旧坐标。

### 二、重新翻译 + 选引擎

- 译文块的动作按钮从「⧉ 复制」扩为「⧉ 复制 + 🔄 重译」（`cmpRetransActs`）；
- `cmpTranslateBlock(id, { force, source })`：`force` 覆盖已有译文，`source` 显式指定引擎
  （优先级：显式传入 → 对照精读面板 #cmpEngine → 设置页翻译源 #prTranslateSource）；
- 点「重译」弹出引擎选择浮层（`cmpRetranslateBlock`），复用 `#prPopover` 与
  `/api/translate/sources`（跟随设置 / 逐条大模型配置 / 各翻译服务），锚定到按钮附近，
  默认选中当前实际生效的引擎，确认后强制重译这一段。

### 三、AI 设置：视觉模型提前 + 标必填

- 「👁 视觉模型」从「高级设置」折叠里**提到「已配置的模型」之后**（新的 `#visionSection`），
  标题带红色「必填」徽标，选择器标签带 `*`；高级设置里的「两段式看图」只留说明文字
  （id 唯一性保住，`renderVisionOptions()` 无需改动）；
- 未配置时橙色提示「先添加一个支持视觉的模型」，不阻断保存（按用户选择：提示而非强制）；
- 新增 `.ml-required` 徽标样式（标签与标题两种形态）。

### 四、火山翻译网页版标（推荐）

- `TRANSLATE_PROVIDERS` 的 volcweb label 与设置页 option 文案改为
  「火山翻译 · 网页版（免密钥）（推荐）」—— 重译浮层、翻译源下拉（走 `/api/translate/sources`）
  与设置页三处一致；`translate-search.test.mjs` 的 label 断言同步更新。

### 验证

- 单测 **457 / 457**；对照精读 E2E **75 / 75**（新增 6 项：自动放大 190%、块定位进视口、
  重译按钮出现、引擎浮层弹出、引擎含火山(推荐)、选引擎后强制重译单段调用 +1）；
- 设置弹窗渲染验证：区块顺序 = 已配置模型 → 视觉模型 → 本地端口 → 高级设置，必填徽标与提示正常。

## 打开文献即自动对照 + 三档视图铺满（2026-10-14，v1.24.1）

> 用户两条指令：
> 「点进阅读器就自动进行版面解析和翻译，不需要用户自行点击，当解析和翻译完成后，自动进入对照精读。全程不需要用户自己动手」
> 「仅原文和仅译文模式下，采用三栏，右边不要留白」

### 一、自动对照管线（`autoCmpPipeline`）

文献 PDF 打开（`openPdfReader`）后自动跑完四步，**一次点击都不需要**：

1. **已有整篇翻译**（`findCmpAlignJob` 命中 done 的 align 产物）→ 直接 `openCmpMode()`；
2. **有在跑的翻译作业**（上次没等完就关了阅读器）→ `findCmpRunningJob` 找到后直接跟踪，
   不再起重复作业；
3. **缺版面** → `startLayoutParse()` 自动解析，`waitLayoutDone` 轮询状态位
   （`pr.layoutFor` / `pr.layoutBusy`，由既有的 SSE `watchLayoutProgress` 维护）；
4. **自动整篇翻译** → `startCmpTranslate()` 用默认参数（引擎 `auto` = 服务端
   `resolveActive` 的激活模型，目标语言中文），作业完成（`subscribeCmpJob` 的 `onDone`）→ 自动 `openCmpMode()`。

设计要点：

- **进度可见**：普通阅读视图里看不到启动面板，所以工具条上加了 `#cmpAutoChip` 徽标，
  `renderCmpJob` 每次进度都同步更新它（「正在解析版面… / 正在整篇翻译… 47%」）；
  进对照精读 / 关阅读器时收起。
- **失败降级不卡人**：版面解析失败、翻译启动失败只置徽标为 fail + toast，用户照常阅读，
  所有手动按钮原位保留。
- **一篇一轮**：`cmp.autoId` 防同篇重入；`closePdfReader` 清掉轮询句柄与状态位
  （在跑的作业留在服务端，下次打开这篇会走第 2 步接上）。
- **切篇安全**：轮询与 `onDone` 都检查 `pr.recordId` / `cmp.autoId`，切到别的篇目后
  上一篇的完成事件不会再动 UI。
- **测试免打扰**：`window.__cmpAutoOff` 关掉自动管线（cmp-e2e 验证手动链路用；
  auto-e2e.mjs 不设它，专门验证自动链路）。

### 二、仅原文 / 仅译文铺满（右边不留白）

根因很有意思：四区各栏都是 `flex: <ratio> 1 0`（basis 全 0），而 CSS 规定
**Σflex-grow < 1 时每栏只分到 grow×自由空间、剩余不用**。四栏 Σgrow=1.11（>1，正常按比例铺满），
但「仅原文」隐藏译文栏后 Σgrow 只剩 0.79 —— 于是每栏只拿到自己那份，**右边空出 ~370px**（1760 宽实测）。

修法：`applyCmpRatios()` 感知视图 —— 被隐藏栏的份额并给可见的中间栏
（仅原文 → src 拿 src+trans，仅译文反之），Σgrow 回到 1.11；`bindCmpView()` 切档时重新分配。
效果（1760px 实测）：仅原文 PDF 从 594px 增至 1039px，仅译文译文流 1040px，三栏合计=容器宽。

### 三、验证

- `D:/work/.wbverify/auto-e2e.mjs`（新增，11/11）：上传全新 PDF → 只做 `openReader` 一个动作 →
  采样徽标直到对照精读自动打开（两页文献约 10s）→ 断言译文就位（7/7 块）、启动面板收起、
  徽标收起、三档视图可见栏合计=容器宽、无 JS 错误。
- 主 E2E（手动链路）**69/69** 不变（开 `__cmpAutoOff` 隔离时序）；
- 全量单测 456/457（仅剩的 1 项是模型路由超时用例全量并发下的偶发超时，单独复跑 3/3，与本轮无关）。
- 顺手发现并记录：`pn-resizer` 分隔条各占 5px，「可见栏合计」的断言要把它们算进去。

## 阅读器改造：原文栏换成真正的 PDF、两个翻译页签下线、界面重做（2026-10-13，v1.24.0）

> 这一版**取代**了下面 v1.23.0 那条里的一部分设计，主要三处：
> **①** 原文栏不再是「版面块文本流」，改成搬进来的**真 PDF**（所以「同栏对照」这一档没有了，
> 视图从 `分栏对照 / 同栏对照 / 仅译文` 变成 `仅原文 / 原文译文 / 仅译文`）；
> **②** 「划词翻译」「全文翻译」两个页签**整体删除**，翻译入口收敛到对照精读；
> **③** 界面配色按 reader 改成**黑白灰**。

### 起因

v1.23.0 的对照精读把「原文」做成了一条**版面块文本流**。用户看到后的三条意见是：

> 删除全文翻译和划词翻译。原文部分是要显示原文 pdf，对于选中的原文还要支持添加批注，支持划词。
> pdf 阅读器要使用 https://github.com/cynicalight/reader 的阅读效果。
> UI 界面能不能重做一下，现在比较丑。

经确认拆成两件事：**先重做阅读器（含对照精读）**，配色**改成黑白灰（对齐 reader）**。

### 为什么「原文流」这条路走不通

不是审美问题，是三处硬伤：

1. **图表公式只剩占位。** 文本流里放不下裁图，只能写一句「图表」，想看原图得切回普通阅读；
2. **划不出词。** 文本流是 `<div>` + 文字，**没有 PDF 文本层**，鼠标拖选不出东西 ——
   也就意味着**批注做不了**，而读文献最常用的动作恰恰是划一句、写一句；
3. **等于多维护一套呈现。** 同一篇文献既要渲染 PDF，又要渲染文本流，
   缩放 / 旋转 / 跳页 / 高亮层都要各实现一遍。

### 手法：还是「DOM 搬运」，这次搬的是 `#prPages`

与笔记模式搬运 `#prPages` 完全同一个手法，新增一对函数（`adoptCmpPdfHost` / `restoreCmpPdfHost`），
把 `.pr-main` 里的 PDF 页面流整个搬进 `#cmpPdfHost`，退出时搬回去。

**为什么这是对的做法**：事件监听是挂在元素本身上的，移动节点不会丢。
于是缩放 / 旋转 / 跳页 / 文本层划词 / 批注高亮 / 版面块悬停**全部零重复实现**，
自动跟着容器一起过来 —— 这正是「不要维护第二套呈现」的兑现方式。

**踩到的坑：PDF 的滚动容器必须是 `#prPages` 自己，不能是外层 `#cmpPdfHost`。**

```css
.cmp-pdf-host { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.cmp-pdf-host .pr-pages { flex: 1; min-height: 0; }   /* 让 #prPages 自己成为 scroller */
```

理由在 `buildPlaceholders()`：它的懒渲染 `IntersectionObserver` 用 `$('prPages')` 当 **root**。
只有 `#prPages` 自己就是滚动容器时，「滚到视口附近才渲染这一页」才成立；
若让外层滚，`#prPages` 的高度会变成整篇内容高度，root 等于整个内容 ——
几十页会在 `dpr=2` 下一口气全渲染出来。

### 「点原文哪里，译文跳到哪里」为什么不用猜

块 id **三处同源**，命中即查 `Map`：

| 来源 | 产出块 id |
| --- | --- |
| `src/layoutTranslate.js` 的 `layoutFromManifest()` | 沿用 manifest 的 `p1-b17` |
| `buildAlignOutput()` 的 `blocks[].id` | 同上，逐字一致 |
| `public/reader-blocks.js` 装载的块 | 同上 |

新增 `cmpSyncPdfBlocks()`：把 `PrBlocks` 装载的块集**换成对照流自己的块集**（`cmp.data.blocks`）。
**为什么必须换**：原 manifest 里含页眉 / 页脚 / 页码 / 印章这些排版块，
它们在 `layoutFromManifest` 里就被 `DROP_LABELS` 丢掉了，**不会进对照流**；
若沿用原 manifest，点这些块会「命中一个查不到译文的 id」。换成对照流块集后，
**能点到的块必然有译文槽**。退出对照精读时再 `loadLayoutFor()` 把完整块集还原。

### `PrBlocks.onPick` 的语义变化（要记得清）

- **注入 `onPick` 后，所有块**（含正文块）的点击都走 `onPick`；
- **不注入**时保持原行为：只有带裁图的 chart / table / formula 响应 `onActivate`，正文块留给划词。

所以 `installCmpPdfHooks()` 进对照精读时注入，`uninstallCmpPdfHooks()` 退出时必须
`setHooks({ onPick: null })` 清掉 —— 否则退出后点正文块会误触发对照精读。

### 同步滚动做成单向（PDF → 译文）

`cmpOnPdfScroll` 监听 `#prPages` 的 scroll，用 `cmpTopVisibleBlock()`
（锚线取 `top + min(96, height*0.2)`，即「视口上方那一块」）找落点，译文栏对应块顶部对齐；
`cmp.syncing` 加锁 + `cmp.syncTimer` 防回环，`cmp.syncAnchorId` 去重。

**反向刻意不做**：点译文栏某段时靠 `cmpRevealBlockInPdf()` **显式**滚过去（并画出方框）。
双向互推会来回打架 —— 滚动事件里再触发另一边滚动，很难收敛。

`cmpRevealBlockInPdf()` 里有一条「**已经看得见就不滚**」（整块在视口内直接 return），
为的是点当前页的段落时不要「抖」一下。

### 两种选中态

- `.cmp-pdf-pick`：画在 PDF 页面上的方框（百分比定位 div，`pointer-events: none`），
  由 `cmpPaintPdfPick()` 按 `PrBlocks.blockPercent()` + `.pr-page-wrap` 定位；
- `.cmp-block.active`：译文栏的高亮块；另有更轻的 `.cmp-block.current` 只标「当前读到哪一段」。

**方框会被页面重渲染冲掉**（页面重渲染会把 wrap 的 `innerHTML` 换掉），所以：
`clearPdfPick()` 走双路清理（记着的元素 + `querySelectorAll('#prPages .cmp-pdf-pick')` 兜底），
`cmpRepaintPdfPick()` 挂在 `buildPlaceholders()` 与 `renderPageInto()` 末尾补画。

### 划词链路（对照精读里也能划）

`document.mouseup` → `captureSelection()`（只认落在 `.pr-page-wrap` 内的选区）→
`pr.currentSelection` + `showSelectionToolbar()` → `#prSelectionToolbar` 的 `[data-sel]` 六项分发。

顺手改掉一处：新增 `selectionText(sel)`，把 `Selection.toString()` 的**假换行**按中英边界折掉。
PDF 文本层里每个 span / 每一行都是独立元素，原始取词会带一堆换行；
以前靠一个「拼接模式」开关解决，页签删掉后**改成默认行为**（`pdfReaderUtils.joinSelectionText` 重新回到调用链上）。

六项动作里 `translate` 是：笔记模式走 `pnFillFromSelection`，否则收掉工具条 + `showSelTrans()` 就地弹浮层。

### 删掉两个页签，但 `#prTranslateSource` / `#prLangTo` 一个都不能删

「划词翻译」「全文翻译」两个页签**整体删除**（HTML 面板 + `ftEl()` / `ftOptions()` 等一整套 JS）。
但设置里的 **翻译源 / 源语言 / 目标语言**必须留着 ——
**对照精读的单段翻译、划词浮层、笔记模式、邮件翻译都读它们**。
所以把这组控件从「划词翻译」面板**迁到设置页**（`#prTranslateSource` / `#prLangFrom` / `#prLangTo`）。

服务端没动：`src/pdfTranslate/index.js` 的 `MODES` / `resolveModes` / `OUTPUT_META` 全部保留。
对照精读的作业请求固定 `layoutSource: 'manifest'`，于是产出 `md`（Markdown 译文）+
`align`（对照数据）两件。**注意**：面板删掉后，「单语 / 双语 / 重排版」这三种**成品 PDF 的导出入口在界面上没有了**
（服务端仍支持，`resolveModes` 与 `OUTPUT_META` 都还在）—— 属于本次「收敛入口」的已知取舍，
若要恢复，位置应当是**对照精读的启动面板**（那里已经有引擎 / 目标语言 / 页码范围 / 参考文献开关）。

### UI 重做（黑白灰，对齐 reader）

- `:root` 换成中性灰阶（新增 `--pill / --hair / --ink / --ink-2 / --ink-3` 等），去掉蓝紫渐变与彩色描边；
- `.pr-toolbar` 压扁成一行（`gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--hair)`），按钮改小；
- `.pr-dir*`（论文目录）灰阶重写，选中项用 `border-left` 短竖条而非整行染色；
- `.pdf-reader` 背景 `#e8eaf0` → `var(--bg)`；
- 对照精读整段 CSS 重写：`.cmp-bar`（44px 常驻工具条）/ `.cmp-panes` / 三档 `[data-view]` /
  `.cmp-flow` / `.cmp-block`(+`.current`/`.active`/`.flash`) / `.cmp-start*`，配 1400 / 1240 / 940 三个窄屏断点；
- 新增 `#prSelTrans` 划词译文浮层样式；`.cmp-pdf-pick` 方框样式；
- 删掉随面板一起下线的死样式（`.ft-out-*` / `.ft-history` / `.ft-hist*`），**保留 `.ft-logs`**（对照精读的 `#cmpLogs` 仍在用）。

### 测试与打包：顺手拔掉的三根刺

**① 假失败：陈旧产物被测试发现机制扫了进来。**

跑全量单测时发现 **7 项失败全是假失败** —— 不是代码坏了，而是 `dist/win-unpacked/resources/app/test/**`
里的**陈旧产物**被 `node --test` 的无参发现机制扫了进来：那份 app 里没有 `build/icon.png`、
它的 `package.json` 也没有 `build` 字段，于是「图标透明」「打包排除规则」这些用例在错误的根目录下必然失败，
把真实结果盖住（原来 11 项失败里有 7 项是它）。

**② 更要紧的：`build.files` 白名单根本约束不到 app 目录 —— 本机打包会把开发者自己的 `data/` 打进安装包。**

顺着①往上游查，才看清真正的机制。`dist/builder-debug.yml` 里写得很明白：

```yaml
firstOrDefaultFilePatterns:      # ← app 目录实际用的规则
  - '**/*'
  - '!**/node_modules'
  - '!build{,/**/*}'
  - '!dist{,/**/*}'
  ...
nodeModuleFilePatterns:          # ← 我们写的 files 只落到了这里
  - server.js
  - src/**/*
  - ...
```

也就是说 `build.files` 里那串白名单（`server.js` / `src/**/*` / `public/**/*` …）
**只作用在 node_modules 的筛选上**，app 目录本身是按 `**/*` 整打的。
后果是本机打包时：

```
dist/win-unpacked/resources/app/
├── data/          ← 3.7MB：literature.json / conversations.json / settings.json / paper-chats.json / backups…
├── uploads/       ← 105KB：本机上传的 PDF 附件
├── test/          ← 41 个测试文件（①的元凶）
├── docs/  scripts/  README.md  MODIFICATION_NOTES.md  MACOS_BUILD.md …
└── server.js  src/  public/  electron/  processor/  node_modules/  package.json   ← 真正要发的
```

**`data/` 与 `uploads/` 是用户本地的文献库、对话记录、设置和上传的 PDF** ——
`.gitignore` 里写得清清楚楚「运行时数据（用户本地文献库与设置，不应上传）」。
CI 上一直没暴露，只因为 `data/` `uploads/` 都被 gitignore 排除、CI 根本没检出过它们。
而**本机打包就会把它们一起发给用户**。

先试了往 `build.files` 里加 `!test/**` —— **实测无效**（重建后产物里照样有 `test/`），
原因就是上面那张表：app 目录不吃这份规则。

于是改用 **`afterPack` 钩子**（新增 `scripts/after-pack.cjs`）：

- 时机是「app 目录已经拷完、NSIS / DMG 还没开始压」之间，所以删掉的东西**不会进安装包**；
- 比匹配规则**确定**：删什么就是什么，不受 electron-builder 匹配语义变化影响；
- 移除 `data/ uploads/ test/ docs/ scripts/ .npm-cache/` 与三份开发文档（保留 `LICENSE`，许可证要跟着分发）；
  实测一次本机打包能少带 **约 4.3MB**（`data/` 3.5MB + `test/` 426KB + 开发文档 234KB + `.npm-cache/` 2.3MB 等）；
- 带**护栏** `assertLooksLikePackedApp()`：只有在确认「待删目录在 appOutDir 之内」
  且「里面有 server.js / public / electron」之后才动手，绝不碰源码目录；
- 顺带把 `!test/**` 这条**没生效的**规则删掉，免得以后有人以为它在起作用 ——
  并且补了一条回归测试钉住它（`test/packaging-files.test.mjs`）。

**③ 主题色把阅读器的黑白灰盖掉了（截图目测才发现）。**

E2E 的截图里，对照精读的**大纲栏是深青色底、视图选中态也是深青色**，和刚做完的黑白灰完全两回事。
根因不在样式表，而在 `app.js`：设置页的**主题色**是用 JS 往 `<html>` 上注变量的
（`deriveTheme()` / `applyTheme()`），而它**连 `--side-1` / `--side-2` 都会算成明度 26 / 18 的深色**
（默认主题色 `#176B87` 就是深青）。`:root` 里我写的白底在运行时被 `<html>` 的内联变量整体盖掉。

处置：在 `.pdf-reader` 这一层把要用的变量**重新钉一遍**。
自定义属性就近生效，离元素更近的声明会盖掉 `<html>` 上的内联值 ——
于是**阅读器内部一定是中性的，阅读器之外的界面照旧跟随用户选的主题色**。
这比「不让主题色注入」更合适：主题色是给整个界面用的，而阅读器是读文献的地方，
用户要的就是 reader 那种黑白灰。

之后全量单测 **456 / 456 全绿**（含 Node 20 / Node 22 各一次），E2E 仍然 **69 / 69**，
截图复核：视图三档（仅原文 / 原文译文 / 仅译文）选中态是黑底白字、大纲列为白底 + 左侧短竖条。

另外把三处**已失效的陈旧断言**更新成本版事实（不是删掉，而是改成钉住新契约）：

- `test/pdf-reader-utils.test.mjs`：`prJoinMode` / `prClearSelection` 断言改成「**不应存在**」
  （随面板移除），并保留旋转控件与 `joinSelectionText` 仍在调用链上；
- `test/pdf-translate.test.mjs`：「每个 `ft*` id 都要存在」→「**不许有任何 `ft*` 残留**
  + 设置页翻译源必须留着」；「成品下拉覆盖所有模式」→「**对照精读四区骨架齐备** + `#prPages` 能进能出」；
  「观感控件在表单里」→「**划词工具条六项 + 划词浮层三件套齐备**」。

### 验证

- 单测 **456 / 456**；
- 端到端 **69 / 69**（`D:/work/.wbverify/cmp-e2e.mjs` v2）：真实 PDF → 真实版面模型 → 真实翻译管线 →
  真实前端交互，只把大模型接口换成本机假模型，**前端一行未改**。关键证据：
  `#prPages` 已搬进 `#cmpPdfHost`（`canvas=2 span=21`）、译文栏 12 块且原文栏 0 块 DOM、
  `PrBlocks` 块集 `{"1":8,"2":4}` 与对照流一致、在 PDF 上真实点击 `(432,285) p1` →
  `p1-b6` 高亮 + 自动单段翻译 + 方框 `{page:1,w:50.4%,h:4.86%}`、
  对照精读 PDF 上划词能弹六项工具条、划词「翻译」就地出译文、划词「高亮」写回 `annotations=1` 且高亮层 `hl=1`、
  整篇翻译产出 `md,align` 两件且块 id 与结构版逐条一致、三档视图切换后 PDF 宽度 `仅原文=540 → 分栏=480`、
  退出后 `PrBlocks` 恢复 `12 == manifest 12`。

---

## 对照精读：把「版面识别」与「全文翻译」打通成四区对照界面（2026-10-13，v1.23.0）

> ⚠️ 本条的以下部分**已被上面的 v1.24.0 取代**：原文栏「版面块文本流」、「同栏对照」这一档视图、
> 「划词翻译 / 全文翻译两个页签」。其余（对照数据同源、按需翻译、AI 助读搬 DOM、视觉模型直答图表）仍然有效。

### 起因：版面识别独立存在时「很鸡肋」

v1.22.0 的版面解析能在 PDF 上框出图表 / 表格 / 公式，点一下还能看裁图与 AI 解读 —— 但它是**旁挂**的：
识别完之后，读文献仍然是在「PDF 页面」和「右侧 Markdown 译文」两个互不相干的东西之间来回找。
用户的原话是「很鸡肋啊，我需要这个版面结合翻译，将这个版面识别利用起来」，并给出了目标形态：

> 先执行版面识别，理解 pdf 页面结构，然后执行全文翻译，支持用户选择翻译引擎。
> 然后最左侧显示大纲，中间左显示文献，中间右显示翻译结果，左右需要同步，
> 文献点到哪里翻译就同步到哪里，选中了之后，支持一键把这段文字送入 ai 助读中，也就是最右侧。
> …用户点击原文哪里，右边就弹出相应的翻译和侧边栏，同时目录、笔记模式以顶端保留，用于切换界面。

于是新增第三种阅读形态 **对照精读**（与「普通阅读」「笔记模式」并列、三者互斥）：
**大纲 ｜ 原文流 ｜ 译文流 ｜ AI 助读**。

### 内核：先有「逐块对照数据」，才可能有「左右同步」

这是整件事的先后顺序问题。原来的翻译管线产出的是**整篇 Markdown** —— 它能读，但**没有「第几块对应第几块」这个信息**，
所以「点原文跳到译文」「两侧同步滚动」在数据层就做不到，只能靠文本长度比例去猜（猜不准，尤其是图表占位的那几段）。

补的第一件事是新模块 **`src/layoutTranslate.js`**：把 processor 的 `manifest.json`（版面识别产物）转成
`analyzePdf` 那套 `pages[].blocks[]` 结构，**术语表 / 翻译缓存 / 自适应并发 / Markdown 组装全部复用，一行不改**；
并且额外产出「对照数据」：

```jsonc
{ "schemaVersion": 1, "source": "manifest", "pages": 13, "totalBlocks": 234, "translatedBlocks": 170,
  "blocks": [ { "id": "p1-b6", "page": 1, "kind": "body", "label": "text",
                "text": "…", "translation": "…", "x": 0.08, "y": 0.31, "width": 0.84, "height": 0.07,
                "image": "p1-fig2.png", "caption": "…", "translatable": true } ] }
```

两侧的块 id **同源**，「点原文 → 译文跟着跳」就退化成查一次 `Map`，同步滚动只按「顶部锚点块」做位移补偿，
不存在任何对齐猜测。

label → kind 的映射与标题层级也在这里定死（`doc_title→title`、`paragraph_title→heading`、
`text/abstract→body`、`figure_title→caption`、`chart/image/algorithm→figure`、`table→table`、
`display_formula→formula`、`reference→reference（默认不翻）`；
页眉页脚 / 页码 / 印章 / 页边注 等 `header/footer/number/seal/aside_text` 直接丢弃）。
标题层级按编号点号层数算（`1`→H2、`1.2`→H3、`1.2.3`→H4），论文标题占 H1。

### 两条数据来源，块 id 完全一致（从「看结构」切到「已翻译」不会错位）

按用户的用法，流程是「**先**识别版面 → **再**全文翻译」。如果非要等整篇翻完才能进对照界面，第一步的等待就白费了。
所以做成两条同源路径：

| 来源 | 接口 / 产物 | 内容 |
| --- | --- | --- |
| 结构版 | `GET /api/literature/:id/layout/align`（新增） | 只要跑过版面识别就有：大纲 + 原文流，**译文留空** |
| 已翻译版 | 翻译作业产物 `…-对照数据.json`（`outputs[].kind === 'align'`） | 同上，且 `translation` 字段已填好 |

两者走的是**同一段代码**（`layoutFromManifest` + `buildAlignOutput`），所以块 id / 切分 / 阅读顺序逐字一致 ——
E2E 里专门钉住了这一点（`已翻译版的块 id 与结构版完全一致`）。

于是体验是：**版面识别一跑完，对照界面立刻可用**（大纲 + 原文流秒出），译文按需生成 ——
点哪一段翻哪一段；想整篇翻，再在启动面板里选引擎跑一遍。

### 四种视图与「按需翻译」

- **分栏对照**（默认）左原文右译文，两侧同步滚动；
- **同栏对照**像沉浸式翻译那样把译文下挂在原段之后；
- **仅译文**用于快速通读。
- 原文栏里每块都带 `📌 送 AI`（进右侧引用池）与 `🌐 译`（只翻这一段）；已有译文的块不再显示「译」按钮。

### 最右的「AI 助读」不另起一套 UI

把右侧功能面板（`.pr-trans-panel`）的 DOM **整个搬进**最右栏，退出时搬回去 —— 与笔记模式搬运 `#prPages` 是同一个手法。
这样划词翻译、引用池、模型切换、按文献持久化这些能力天然一致，不存在两套对话实现互相打架。
`送 AI` 之后面板自动切到 AI 对话页签。

### 顺手修掉的两个真问题

1. **「仅译文」视图会把用户卡住。** 视图切换按钮一开始挂在「原文」栏的栏头里，
   而切到「仅译文」时整栏被 `display:none` —— 按钮跟着消失，用户再也切不回分栏对照。
   改成一条**常驻工具条**（`#cmpBar`），并且把「🌐 全文翻译」入口与状态（`共 12 块 · 3 段已译`）也放上去。
   回归测试：切到「仅译文」后断言 `#cmpBar #cmpViewSeg` 仍可见、并真的点回「分栏对照」。
2. **单段按需翻译取错了翻译源。** 它原本沿用「划词翻译」面板的翻译源设置，
   于是出现「用户刚在对照精读里选好引擎，点段落却报『未配置可用 AI 模型』」的断裂体验。
   改为**就近优先**：先用对照精读自己选的引擎（`#cmpEngine`），没选才回落到划词翻译的设置。

### AI 助读升级：图表解释直接走视觉模型 + 结合全文

- **直接走视觉模型。** 原来 `/api/paper-chat` 对「模型看不了图」的情况走两段式：先让视觉模型把图**转述成文字**，
  再交给文本模型答题。转述会丢掉坐标轴数值、表格行列、公式上下标这类关键信息，图表解释恰恰最需要这些。
  新增请求标记 `preferVision`：只要当前模型看不了图，就把**回答模型整个换成视觉模型**，单段直答
  （普通对话不传该标记，行为完全不变）。
- **结合全文。** 「AI 解释」以前只发一张图加一句短提示，没有任何论文上下文。
  现在把这一篇的解析全文作为 `system` 一起喂进去（与 AI 对话共用同一份全文缓存，不会重复下载），
  回答会把这张图放回论文语境（支撑了哪个论点、与正文哪一处对应）；
  对照精读里点开的裁图还会额外带上该块识别出的文字。回答末尾标注「视觉模型直答 · 已结合论文全文」。

### 怎么验证的

- **单测 456 / 456**（Node 20 与 Node 22 各一次），其中新增 `test/layout-translate.test.mjs` 14 条，
  钉住 label→kind 映射、标题层级、装饰块剔除、`buildAlignOutput` 的块 id 稳定性；
- **端到端 51 / 51**（`D:/work/.wbverify/cmp-e2e.mjs`）。打桩范围压到最小 —— **前端一行不改**，
  只把「大模型接口」换成本机假模型，因此走的是**真实链路**：
  真实 PDF → 真实版面模型（processor + ONNX）→ 真实翻译管线 → 真实前端交互。
  覆盖：结构版自动铺开、点击即译单段回填、整篇翻译后块 id 与结构版一致、
  大纲跳转两侧同步、双向同步滚动、送 AI 进引用池、视图三切换（含从「仅译文」切回）、
  拖分隔条调宽并落 localStorage、与笔记模式互斥、无 JS 运行时错误。
  （细节：假模型的**模型名带随机后缀**，否则第二次跑会整篇命中译文磁盘缓存、
  一次都不会真的调用模型，「链路确实跑过」的证据就没了。）
- **打包检查**：新文件落在 `build.files` 的 `src/**/*` 与 `public/**/*` 覆盖范围内；
  `src/layoutTranslate.js` 只依赖 Node 内置模块，**没有引入任何新依赖**；`npm ci --dry-run` 通过。

---

## 修复：打包排除规则误删 `@napi-rs/canvas`，导致 v1.22.0 版面解析全平台不可用（2026-10-13，v1.22.1）

**现象。** 安装 v1.22.0 后点「版面解析」，界面只报一句：

```
版面解析失败：node:internal/assert:14 throw new ERR_INTERNAL_ASSERTION(message); ^
Error [ERR_INTERNAL_ASSERTION]: Code: ERR_MODULE_NOT_FOUND;
The provided arguments length (2) does not match the required ones (3).
This is caused by either a bug in Node.js or incorrect usage of Node.js internals.
```

（这 300 字是 `src/layout.js` 捕获的子进程 stderr 尾部，不是真正的错误信息。）

**两层原因，缺一不可解释它。**

第一层是 **Node.js 自身的 bug**。栈里的关键帧是
`legacyMainResolve (node:internal/modules/esm/resolve)` —— 它只负责「按 `package.json` 的 `main`
字段找包入口」这一步。该函数抛 `ERR_MODULE_NOT_FOUND` 时**只传了 2 个参数**，而新版的
`ERR_MODULE_NOT_FOUND` 消息函数需要 3 个，于是 Node 在「构造错误」时先把自己断言死了
（nodejs/node#52574，已在较新版本修复）。结果是：**真实原因「找不到模块 X」被这句内部断言完全掩盖**。

第二层是**我们自己的打包规则写错了**。`build.files` 里原本有：

```jsonc
"!node_modules/canvas/**",
"!node_modules/**/canvas/**"   // ← 想排掉 node-canvas，却连坐了 @napi-rs/canvas
```

glob `**/canvas/**` 会匹配**任意一层**名为 `canvas` 的目录，于是 `node_modules/@napi-rs/canvas/**`
被整包剔除 —— **目录还在、`package.json` 与 `index.js` 等入口文件全被删光**（实测目录里只剩一个
嵌套的 `node_modules/`）。子进程第 2 行就是 `import { createCanvas, DOMMatrix, ... } from "@napi-rs/canvas"`，
解析失败即崩在启动阶段。三个平台同一条 `files` 规则，所以 Windows / macOS 全都不可用。

**验证方式（没靠猜）。** 直接拿已安装的产物复现，再逐项排除：

```bash
# 1) 按 src/layout.js 的方式启动子进程 —— 一字不差地复现了该报错
cd "<安装目录>/resources/app"
ELECTRON_RUN_AS_NODE=1 "../../<产品名>.exe" processor/dist/main.mjs \
  --input <某篇.pdf> --output <空目录> --model processor/dist/models/*.onnx

# 2) 体检同类依赖，确认只有 canvas 这一处缺失
#    onnxruntime 原生二进制 ✓ / pdfjs-dist legacy 构建 ✓ / 67MB 模型 ✓ / processor 成品 ✓
```

**修复。**

1. `package.json` —— 把过宽的 glob 换成精确形式，既保住「排除 node-canvas」的原意，
   又不再波及带作用域的 `@napi-rs/canvas`：

   ```jsonc
   "!node_modules/canvas/**",
   "!**/node_modules/canvas/**"   // 只匹配「名为 canvas 的那一层」，不匹配 @napi-rs/canvas
   ```

2. `src/layout.js` —— `availability()` 增加 `missingRuntimePackages()` 前置校验。
   原先只检查 onnxruntime 的原生二进制，检查不到「包目录在、入口文件没了」这种形态。
   现在按 Node 的解析方式逐个确认 `@napi-rs/canvas` / `onnxruntime-node` / `pdfjs-dist`
   的 `package.json` 与入口文件真实存在，缺失时界面直接说
   **「安装包不完整：缺少版面解析运行库（…），请重新下载安装包覆盖安装」**，
   而不是抛一堆栈让用户去猜。

3. `test/packaging-files.test.mjs`（新增）—— 把「排除规则不许命中运行时依赖的入口文件」
   固化成回归测试，同时钉住事故形态（任何命中 `@napi-rs/canvas` 的排除规则都判失败），
   并确认 node-canvas 与各平台无关的 onnxruntime 二进制仍按原意被排除。

**验证结果。**

- 重新 `electron-builder --win --dir`：`@napi-rs/canvas` 的 7 个文件回来了，
  `skia.win32-x64-msvc.node` 在位，`node_modules/canvas` 仍被正确排除；
- 用**新产物**端到端跑整篇 PDF：**13 页 / 17 个裁图 / exit 0 / 29.6s / 峰值 848MB**，
  与发版前在 Node 22 上的结果一致；
- 单测 **442/442**（Node 20.10 与 Node 22.22 各一次；新增 5 条）；
- 反向验证：把规则临时换回旧写法，新增的回归测试立刻 **3 条失败** —— 确认它真能拦住这个坑。

**教训。** 打包类问题**只能在打包产物上验证**：发版前那次「用 Electron 二进制跑 `processor/dist/main.mjs`」
的验证之所以全绿，是因为它跑的是**仓库里**的 `node_modules`（完整），完全绕过了 `files` 过滤。
以后改 `build.files` 或新增原生依赖，至少要跑一次 `--dir` 构建并检查产物树。

---

## 发版前加固：版面解析子进程的 Node 20 兼容层 + 桌面端运行时实测（2026-10-13，v1.22.0）

**背景。** 版面解析子进程此前所有验证都是在项目开发用的 Node 22 上做的，而**桌面端实际跑的是
Electron 33 内置的 Node 20**（实测 `electron 33.4.11 → node 20.18.3 / v8 13.0.245`）。
发版前补上这道验证，顺带发现并修掉了一处只在旧 Node 下暴露的兼容问题。

### 一、实测方法（可复现）

```bash
# 1) 看桌面端到底用的哪个运行时
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
  -e "console.log(process.versions)"

# 2) 直接用该运行时跑解析子进程（与 src/layout.js 的 spawn 方式一致）
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
  processor/dist/main.mjs --input <某篇.pdf> --output <空目录> --model processor/dist/models/*.onnx
```

结论：**Electron 33 运行时原生可用** —— 整篇 13 页识别出 17 个裁图，与 Node 22 的结果逐页对拍一致
（每页 region 数完全相同）。下面三个 API 在 Electron 33 里都存在，无需任何补丁：
`Promise.withResolvers`、`ArrayBuffer.prototype.transferToFixedLength`、`process.getBuiltinModule`。

### 二、顺手补的兼容层（只在 API 缺失时生效）

`pdfjs-dist@6` 声明 `engines: node >=22.13` 并非虚言 —— 在**较旧的 plain Node 20**（本机 20.10.0）上，
解析会在三个地方依次炸掉，每一处都把下一处遮住，所以是逐个暴露的：

| 顺序 | 报错 | 缺失的 API | 引入版本 |
| --- | --- | --- | --- |
| 1 | `Promise.withResolvers is not a function` | `Promise.withResolvers` | V8 12.4 / Node 22（Electron 33 的 V8 13.0 已有） |
| 2 | `buffer.transferToFixedLength is not a function` | `ArrayBuffer.prototype.transferToFixedLength` | V8 11.4（Electron 33 已有） |
| 3 | `process.getBuiltinModule is not a function`（`NodeCanvasFactory._createCanvas`） | `process.getBuiltinModule` | Node 22.3（Electron 33 已有） |

已在 `processor/src/main.ts`、`processor/src/repair-text.ts` 顶部，以及对应的 `processor/dist/*.mjs`
（成品是 `dist/`，CI 不重建）各加一段**守卫式**补丁：`typeof x !== "function"` 才注入，
**新版运行时不生效**；兼容实现用 `createRequire` 与「按需复制」，对本用途语义等价
（pdf.js 只在一个局部 `ArrayBuffer` 上调用，不依赖原缓冲被 detach）。

补完后 Node 20.10 也能跑通全篇（13 页 / 17 裁图 / `manifest.json`），与 Node 22、Electron 33 三方结果一致。

### 三、这一条对用户意味着什么

- 桌面端（Windows / macOS 安装包）**本来就是好的** —— 补丁只是把「旧 Node 上开发」这条路也走通。
- 现在有了**在真实 Electron 运行时上跑通版面解析**的证据；此前只有 Node 22 的证据。
- 改动同时落在 `processor/src/*.ts` 与 `processor/dist/*.mjs`，**将来重新 `node build.mjs`
  会从 src 重新生成 dist，两边一致，不会丢补丁**。

---

## 阅读器整合收尾：批注体系增强（P2）+ AI 助读（P3）（2026-10-13，v1.22.0）

补齐最初确认的四大能力里最后两项。至此「EPUB 阅读 / 批注体系 / PDF 版面解析 / AI 助读」全部落地，
且**没有替换**原有阅读器 —— 全部能力都长在同一个 `#pdfReader` 浮层里，PDF 与 EPUB 共用同一套右侧面板。

### 一、P2 批注体系增强

| 能力 | 落地方式 |
| --- | --- |
| **标签** | 批注记录新增 `tags: string[]`（与已有 `page`/`rect`/`cfi`/`note` 并列存进同一条 annotation）。列表里每条可「🏷 +标签」编辑，逗号分隔；浮层里列出本文已用过的标签，点一下即追加，不用手打 |
| **筛选** | 「笔记与高亮」区顶部一条筛选栏：类型（高亮 / 下划线 / 笔记）+ 颜色 + 标签 + 关键词（匹配摘录 / 笔记 / 标签）|
| **定位导航** | 列表右上「↑ / ↓」在**当前筛选结果**里循环跳转；跳到的条目高亮描边。PDF 滚到那一页，EPUB 用 CFI 跳 |
| **导出 Markdown** | 「📤」一键导出整篇的笔记与高亮为 `.md`：正文顺序（PDF 按页、EPUB 按录入序），每条含类型、定位、原文引用（blockquote）、我的笔记、标签；正筛着的时候只导出筛选结果 |

删除 / 改标签都按**持久化下标**定位（`data-annidx` / `data-tag-edit` 用原始 index，而不是渲染后的行号），
所以在筛选状态下操作也不会删错条目。

### 二、P3 AI 助读增强

**多选区引用池。** 精读时最常见的动作是「把 A 段、B 段、C 段放在一起问」，但一次只能选一段。
划词工具条新增「📌 引用」：把选中文字连**来源标注**（PDF 记「第 N 页」、EPUB 记「电子书 · 章节名」）
放进引用池；AI 对话面板里能看到池子内容、可单条移除、可清空、可「就这些提问」。

两个刻意的设计决定：

1. **加到引用池会自动切到「AI 对话」页签**。引用池长在那个面板里，不切过去的话用户在「划词翻译」
   页签上完全看不到自己刚引了什么（只弹一条 toast，很容易以为没生效）。
2. **引用池送出后自动清空**。否则后面每一问（包括「总结本页」）都会一直挂着旧引文，用户却没清过。
   历史消息里仍保留引用原文，追问时模型照样看得到（对话会带最近 8 条），所以清空不丢上下文。

**当前页 / 当前章节总结。** AI 对话工具栏新增「📝 总结本页」（PDF）/「📝 总结本章」（EPUB），
文案随格式自动切换。取当前页文本（PDF，按 `hasEOL` 保留段落）或当前章节正文（EPUB，走新增的
`EpubReader.currentChapterText()`，从 rendition 已渲染的 contents 取），拼成一段结构化总结指令发出。

### 三、验证

- 真实浏览器 E2E（Playwright + 本机 Chromium）：**51/51 通过** —— 覆盖两条高亮的写入与计数、
  标签编辑与下拉收录、四类筛选（含无命中提示）、上下跳转与当前条目高亮、导出下载（文件名 / 后缀 / 正文内容）、
  引用池的累积 / 移除 / 一次提问带上全部引文 / 送出后自动清空、总结本页与总结本章的消息内容、
  EPUB 下按钮文案与来源标注、关闭阅读器后状态复位、无 JS 运行时错误。
- 项目单测：**437/437 通过**（新增一条 index.html 元素接线断言；另把划词工具条
  `data-litonly` 白名单从 3 个扩到 4 个 —— 新增的「引用」同样只在文献库记录下可用）。
- `data/` 目录字节级无变化；测试跑在独立数据目录（`D:/work/epub-test-data`），不碰项目自带 `data/`。

---

## PDF 版面解析：图表 / 表格 / 公式区域识别 + AI 解读（2026-10-13，v1.22.0）

承接上一条（EPUB）未完的第 4 项能力。需求原话：*「不用管模型增重，要最完整功能」*。

### 一、分工：解析在子进程，交互在页面

版式识别用的是 reader 同款模型 **PP-DocLayoutV3-FP16**（ONNX，67MB，sha256 校验随包带），
但**不复用它的 Go 服务**：把 reader 的 `apps/processor` 原样搬进来当**独立 Node 命令行程序**，
由 `src/layout.js` 用 `spawn` 调用。理由不是图省事，而是实测决定的：

- 单页推理 ~1.6s、**峰值内存 ~800MB**，放进 Electron 主进程会把整个应用的内存曲线顶起来；
- 原生推理崩了只死子进程，主服务照常；
- 与上游架构一致，将来同步上游改动成本最低。

子进程用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动（开发态 `node server.js` 时该变量无副作用）。
onnxruntime 走的是 **napi-v6**，Electron 33（Node 20）在其支持范围内，跨 ABI 兼容。

前端新增 `public/reader-blocks.js`，把每个块按归一化坐标铺到 `.pr-page-wrap` 上：

| 交互 | 行为 |
| --- | --- |
| 悬停 | 整块高亮 + 类型徽标（图表 / 公式 / 表格 / 小节标题…） |
| 点击（仅带裁图的块） | 弹出预览：可缩放，可「✨ AI 解释」，可「∑ 转 LaTeX」 |
| 正文块 | **不拦截点击** —— 正文已经有划词翻译，再叠一层点击只会互相打架 |

「AI 解释 / 转 LaTeX」直接复用阅读器既有的 `/api/paper-chat` 链路：本项目已有视觉模型两段式看图机制
（`resolveVisionModel`），所以不需要额外接模型，模型不支持看图时服务端会自动先转述再回答。
LaTeX 结果用已有的 KaTeX 渲染，并同时给出源码便于复制。

### 二、踩到的三个坑（都已固化在代码注释里）

1. **`toDisplayRect` 收数组，`toCanonicalRect` 收对象** —— 同一文件里两个函数入参形态不一致，
   传错**不抛错**、只静默算出 `NaN`，表现为「悬停永远命不中」。排查时是把中间值打出来才发现的。
2. **`node --test` 会把 `processor/src/*.test.ts` 也当测试跑** —— Node 22.18+ 默认启用类型剥离，
   测试发现不再限于 `.js`。表现为 436 通过 + 6 失败。**已删掉这些上游测试文件**；
   今后往本仓库放 `.test.ts` 要留意这一点（放进点号开头的目录可躲过发现）。
3. **`rAF` 节流不可靠** —— 悬停命中判定最初用 `requestAnimationFrame` 节流，在无头 / 后台标签下可能不触发，
   导致高亮间歇性失灵。判定本身只是几次算术，已改为同步执行。

### 三、验证方式

- 真实浏览器 E2E（Playwright + 本机 Chromium）：**23/23 通过** —— 含悬停高亮、徽标文案、点击放大、
  预览图真实加载（`naturalWidth > 0`）、缩放、AI 链路触发（无模型时给出明确提示而非静默）、
  **PDF 文本层仍可划词**、EPUB 下按钮正确隐藏、无 JS 运行时错误。
- 项目单测：**436/436 通过**，`data/` 目录 `diff -rq` 字节级无变化。
- 后端接口：解析进度 SSE、已完成结果、裁图路由、路径穿越防护（400）、EPUB 拒绝解析（400）。

### 四、打包与体积

`package.json` 的 `build.files` 追加 `processor/dist/**`、`processor/model.json`、`processor/model-license/**`；
并在 `win.files` / `mac.files` 里**按平台裁掉无关的 onnxruntime 二进制**（该包默认全平台分发，约 288MB）：

- Windows 包排除 `darwin/**`、`linux/**`、`win32/arm64/**`；
- macOS 包排除 `win32/**`、`linux/**`。

已知限制：**Intel Mac 无预编译绑定**（上游只提供 `darwin/arm64`）。已加平台探测，
这类平台会给出「当前平台没有可用的版面推理运行时」的明确提示，而不是启动子进程后崩一堆栈；
macOS 版建议在 macOS 上构建（`@napi-rs/canvas` 同理按平台分发）。

---

## 文献中心接入 EPUB 阅读内核（2026-10-13，v1.22.0）

需求原话：*「我想在文献中心中加入这个阅读器（cynicalight/reader）的功能。注意，并不是要把我现在的阅读器替换掉，
而是将两个结合起来，尽量两个功能都能保留」*。

### 一、为什么不直接把 reader 搬过来

`cynicalight/reader` 是另一套完整应用：React 19 + **Go 本地服务** + SQLite + Readium + PDF.js 6，
外加约 67MB 的 PP-DocLayoutV3 版面模型。它的阅读器内核（`apps/web/src/readers/pdf.ts`、`epub.ts`、
`epub-web.ts`）是 React 组件 + Go API 一体，**没法像插件那样拷进本项目的 vanilla JS 页面**；
而它的 Go 层干的事（文档库、批注、搜索、AI 编排）本项目已有等价实现（`src/store.js` + `src/modelRouter.js`），
移植过去等于把现有功能重写一遍。

结论：**不装 Go、不引 React、不加构建链**，只取本项目真正缺的那一层 —— EPUB 渲染内核。
版式解析（图表 / 公式识别、公式转 LaTeX）留到后续单独做，届时用 Node 侧 onnxruntime 跑同一个 ONNX 模型，
比放在浏览器里更顺（本项目后端本来就是 Node）。唯一要先验证的硬风险：Electron 是**在主进程内直接
`import` server.js**（`electron/main.cjs:446`），onnxruntime-node 这类 N-API 原生模块能否在主进程加载要实测；
不行就降级为独立 Node 子进程（反而与 reader 原架构一致）。

### 二、融合方式：同一个阅读器外壳，两个渲染内核

`#pdfReader` 浮层与右侧「划词翻译 / AI 对话 / 我的思考 / 笔记与高亮」面板 **全部原样复用**，
只把「正文渲染」这层按文件格式分流：

| | PDF（原有，未动） | EPUB（新增） |
| --- | --- | --- |
| 渲染内核 | PDF.js（连续页） | epub.js 0.3.93 |
| 顶部控件 | 页码 / 缩放 / 旋转 / 适宽 | 字号 / 行距 / 字体 / 主题 / 翻页方式 |
| 左侧抽屉 | 📚 论文目录（跨篇切换） | 📑 章节目录（书内跳转 + 全书搜索） |
| 阅读位置 | 未持久化 | CFI 持久化到 `readPos` 字段 |
| 批注定位 | `page` + `rect` | `cfi` |
| 划词翻译 | ✅ | ✅（同一条链路） |

两套控件互斥显示，由 `applyReaderMode()` 里的 `fileKind` 维度切换；用户在两种文档里看到的是
**同一个阅读器**，操作习惯一致。批注仍写进同一条 `annotations` 数组，只是多一个 `cfi` 字段。

### 三、改动清单

**新增**
- `public/epub-reader.js` —— epub.js 封装（打开 / 销毁、样式注入、目录、搜索、进度、批注挂载）
- `public/vendor/epubjs/epub.min.js`（223KB）、`public/vendor/jszip/jszip.min.js`（96KB）
  —— epub.js 的 dist 把 JSZip 当**外部依赖**，jszip 必须先于它加载

**后端 `server.js`**
- 记录新增 `fileKind`（`'pdf' | 'epub'`）与 `readPos`；`PATCH` 白名单与字段校验同步
- 上传放开 `.epub`；错误码 `ONLY_PDF` → `ONLY_PDF_OR_EPUB`
- `/api/parse` 与 `/api/literature/:id/parse` 对 EPUB 显式跳过（电子书没有 PDF 文本层）

**前端 `public/app.js` / `index.html` / `style.css`**
- `openReaderShell({ fileKind })` 按格式分流；`closePdfReader()` 一并释放 EPUB 内核
- `loadEpubDocument()` / `bindEpubTools()` / `renderEpubToc()` / `runEpubSearch()` / `scheduleEpubProgress()`
- `setPrDir()` 让同一个「目录」按钮在两种格式下呈现两种目录
- 批注：`addEpubAnnotation()` + `addAnnotation()` / `renderNotesList()` 按 cfi 分流
- 划词面板提示文案随格式变化（读 EPUB 时不再说成 PDF）
- 上传 / 拖拽 / 文件选择框一律放开 `.epub`

⚠️ `docType` 字段**不能**用来表示文件格式 —— 它在本项目里表示「实证类 / 模型类文库」。

### 四、验证

- 单测：Node 22 与 Node 20 各跑一次，均 **436/436 通过**（`data/` 目录 `diff -rq` 字节级无变化）
- 真实浏览器 E2E（Playwright + 本机 Chromium 1208、独立数据目录 + 独立端口）：**37/37 通过**，
  覆盖 EPUB 渲染、章节目录、章节跳转、字号 / 行距 / 主题 / 翻页方式、目录搜索、
  阅读位置写回与重开恢复、EPUB 划词驱动右侧翻译面板，以及
  「PDF 原有路径未被破坏」（`#prPages` 画布照常渲染、PDF 工具条与「全文翻译」页签正确回归）

### 五、已知限制

- EPUB 暂无「全文翻译」与「笔记模式」—— 两者都建立在 PDF 版式之上（按页解析 + 左右原文对照），
  已在 EPUB 模式下隐藏对应入口，不会出现「点了没反应」的空面板
- EPUB 全书搜索定位到「章节」而非「段落」：epub.js 自带的 `book.search` 对部分书不稳定，
  这里用可控的逐节字符串匹配实现，宁可定位粗一点
- 版式解析（图表 / 公式区域识别、公式转 LaTeX）尚未接入，见上方「一」

## v1.21.3：阅读器内置「论文目录」（就地换篇）+ 学位论文导入去重（2026-10-12）

需求原话：*「在读文献的界面中增加一个目录，让用户可以跳转其他论文，不用用户需要先返回再打开，优化流程」*
/ *「学位论文阅读中要支持避免重复导入」*。

### 一、两个阅读器都能就地换篇

**文献中心阅读器**：顶栏加「📚 目录」按钮，阅读区左侧滑出一个目录抽屉
（`#prDir`），按文库分组列出**所有带 PDF 的文献**，带搜索框、当前正在读的那篇自动高亮置顶。
点任意条目 → 直接调既有的 `openPdfReader(id)`，**不离开阅读器、URL 不变**，
翻译 / 笔记 / 对话 / 分析面板全部按新的一篇重新走一遍。

目录数据源是内存里的 `items`（不新增接口），只列 `filename` 非空的记录 ——
没有附件的点开也读不了，列出来只会误导。

**学位论文阅读器**：左侧栏原本只有「书签栏」，现在加了一组**页签**：

```
┌──────────────┐
│ 📑 章节 │ 📚 论文 │   ← 同一个区域，只显示一份
├──────────────┤
│ 目录 / 书签      │
└──────────────┘
```

切到「📚 论文」就是全库有 PDF 的学位论文列表（同样带搜索、当前篇高亮），
点一下即换篇。这样没有额外占用任何版面。

### 二、切篇前必须先「拆干净」上一篇（本版最关键的修复）

`openReader()` 原先是靠 `closeReader()` 来销毁 pdf 文档、落盘笔记的，**不关闭就直接换篇**
会漏掉这一步。本版抽出 `teardownReaderBody()`，`closeReader()` 与「切到另一篇」共用它：
断开 observer、`clearQueue()`、`R.doc.destroy()`、`saveNote()`、`saveReadPos(true)`。

⚠️ **由此暴露出一个真实的数据损坏 bug，浏览器 E2E 真的抓到了**：
`saveReadPos()` 把「哪一篇」写在**响应回调里**读（`findIndex((x) => x.id === R.id)`）。
切篇时 `teardownReaderBody()` 会为上一篇立刻发一次位置落盘，而 `openReader()` 紧接着就把
`R.id` 改成新的一篇 —— 等响应回来时 `findIndex(R.id)` 找到的是**新一篇**的下标，
于是把上一篇的记录（含 `id` / 附件名 / 页数）**整条盖到新一篇头上**。
现象：目录里少一篇、另一篇重复（E2E 输出 `目录 3 条 / 去重后 2 条 / 服务端 3 篇`）。

修法：**「哪一篇」在发请求时就锁住**。`saveReadPos` / `addBookmark` / `removeBookmark` /
`saveField`（thesis.js）与 `saveAnnotations` / 「我的思考」保存（app.js）共 6 处一并改掉；
并在 `loadOutline` / `loadChatHistory` / `loadQuotes` / `ensureNote` 的每个 `await` 之后加
`if (R.id !== id) return;` —— 否则上一篇的章节 / 对话 / 摘录 / 笔记会串到当前这篇上。

### 三、学位论文导入去重（三层防线）

1. **纯规则模块** `public/thesis-import-utils.js`（`window.ThesisImportUtils`）：
   `sha256Hex()` 算内容指纹、`matchExisting()` 判定、`partitionDuplicates()` 分组。
2. **前端预检**：导入前先算指纹、刷新一次库、比对 → 有重复弹自绘确认框
   （`#thConfirm`，`askConfirm()`）说明是哪几个文件：
   「跳过重复」只导其余，「仍然导入」为它们各再建一份（`allowDuplicate: true`）。
   —— 这一层是为了避免把几十 MB 的文件白传一遍。
3. **服务端兜底**（权威）：`POST /api/theses` 命中重复时返回
   `409 { duplicate: true, reason, existing }`；指纹由服务端从磁盘流式 `sha256` 现算，
   **不信任客户端传来的 `fileHash`**。附件上传成功后把 `fileHash` 写进记录。

判定规则：**指纹优先**（有指纹的记录命中即判重）；老记录（v1.21.3 之前导入、无 `fileHash`）
退回「体积 + 归一化文件名**两者都相同**」才算重复 —— 宁可漏判，不可误杀。
`normalizeFileName()` 会去掉空白 / 下划线 / 连字符并转小写。

### 四、其他

- 成果管理里读自己的论文时，「📚 目录」按钮与抽屉**整体收起** ——
  否则会在读自己论文时浮出一份不相干的文献列表。
- `sha256Hex` 用 `Object.prototype.toString.call(data) === '[object ArrayBuffer]'` 做品牌检查，
  不用 `instanceof`（跨 vm / iframe realm 时会失效，单测里就踩到过）。

### 五、测试

- 单测 **436 项**（新增 `test/thesis-import-utils.test.mjs` 11 项、`thesis-store` +5 项、
  `thesis-http` 去重块、`test/reader-directory.test.mjs` 10 项），Node 20 与 Node 22 各跑一次均全绿。
- 新增浏览器 E2E `verify-reader-dir.mjs` **40 项**（两个目录的展开 / 搜索 / 高亮 / 就地换篇、
  PDF **真的重载**（用 3/5/7 页 PDF 的页数变化证明）、成果附件收起目录、
  导入去重的两条路径、「换篇没有写坏库里的记录」）。
- 既有基线无回归：`verify-features.mjs` 75 / 75、`verify-thesis.mjs` 170 / 170。
- 变异验证：把 `saveReadPos` 改回「响应回来才读 R.id」→ 新单测红 + E2E 报
  `目录 3 条 / 去重后 2 条`；删掉服务端去重拦截 → `thesis-http` 红。

## v1.21.2：期刊等级标签按档次着色（所有展示位置统一生效）（2026-10-10）

需求原话：*「不同的期刊等级标签使用不同的颜色……是所有涉及期刊等级显示的都要这样」*。

### 一、做法：抽出一个「先解档位、再按体系上色」的纯逻辑模块

新增 `public/rank-utils.js`（无 DOM、便于单测），导出两个函数：

- `tierOf(value)` —— 把各家**写法不统一**的取值统一解析成 1 起档位序号：
  `Q1-Q5`（SSCI）、`N区`（中科院 `"经济学4区"`、新锐 `"1区"`）、`T1-T5`（FMS）、
  `A+/A/B/C/D/E`（新锐、ABS 的字母写法）。认不出返回 0。
- `rankSystemTone(label, value)` —— 按**体系名**给色档。同档概念在不同体系里写法不同，
  所以这里分体系处理，而不是按字符串硬匹配：

| 体系 | 规则 |
| --- | --- |
| SSCI / 中科院分区 / 新锐分区 | 走 `tierOf`，1-4 档 → 淡红 / 黄 / 蓝 / 绿 |
| ABS | `4*`→正红、`4`→黄、`3`→蓝、`2`→绿、`1`→灰（字母写法 `A*/A/B/C` 同义映射） |
| FMS | `T1`→正红、`T2`→黄、`T3`→蓝（字母写法 `A/B/C/D` 同义映射） |
| CSSCI | 主库 → 正红；含「扩展」→ 淡红（体系内次一档） |
| UTD24 | 正红 |
| 任意体系 | 取值里出现 `Top`（中科院 `"1区Top"`、新锐 `"Top"`）一律升为**正红** |
| 空值 / `否`/`无`/`N/A` 等否定写法 / 认不出的写法 | 灰（兜底） |

色档名走**白名单** `TONES = ['red','pink','yellow','blue','green','gray']` 再拼进 class，
避免取值被注入到 class 属性里。

### 二、接线（一处改动，五处生效）

- `public/index.html`：加载 `rank-utils.js`，排在 `app.js` **之前**；
- `public/app.js`：`rankChips()` 给每个 chip 拼 `rank-chip rank-chip-<色档>`；
  另把两处**原本是纯文本**的展示换成彩色标签 —— 模拟审稿页的目标期刊（`reviewRank`）、
  小论文编辑弹窗（`paperRankChips`）；
- `public/style.css`：新增 6 个色档类。**正红做成实心红底白字**，其余为浅底深字 ——
  否则正红与淡红都是浅底，视觉上分不出来。

「所有涉及期刊等级显示」实际共 **5 处**：文献列表「期刊等级」列、文献详情抽屉、
模拟审稿页目标期刊、论文进度小论文卡片、小论文编辑弹窗 —— 全部汇聚到 `rankChips()`。
审稿**导出 PDF / 打印稿保持黑白纯文本**（导出件按可打印处理，未上色）。

### 三、验证

| 项目 | 结果 |
| --- | --- |
| 新增 `test/rank-utils.test.mjs` | **11/11** |
| 全量单测 Node 22.22.2 / Node 20.10.0 | **410/410** · **410/410** |
| 变异验证：改乱档位顺序 + 撤掉 chip 类名 | 4 项断言变红，还原后复绿 |
| 配色专项浏览器 E2E `verify-rank-colors.mjs` | **171/171**，0 条 JS 错误 |
| 全量浏览器功能回归 `verify-features.mjs` | **75/75**，0 条 JS 错误 |

E2E 不只核对 class 名，还用 `getComputedStyle` 比对**浏览器实际算出的背景色**
（6 档底色互不相同、正红白字 / 淡红深红字的区分）。

> 一处自找的坑值得记：新文件顶部注释里写了 `"4*" / "4"`，其中 `*/` 把块注释**提前闭合**，
> 直接 `SyntaxError` —— 已改成顿号。

---

## v1.21.1：期刊等级新增「FMS 分区」与「CSSCI」（2026-10-10）

需求原话：*「期刊等级只支持中科院分区，新锐分区，ABS，SSCI，UTD，我还需要加入 FMS 分区和 CSSCI」*。

### 一、改动本身很小：白名单加两项

`src/easyscholar.js` 的 `KEEP_RANKS` 新增两条（键名**就是** easyScholar 官方数据集缩写，无需映射）：

- `{ key: 'fms', label: 'FMS' }` —— FMS 管理科学高质量期刊，取值形如 `A` / `C`；
- `{ key: 'cssci', label: 'CSSCI' }` —— 官方文档里叫「南大核心」，含 CSSCI / CSSCI扩展 两级。

空结果的占位文案同步补全为 `未收录于中科院/新锐/ABS/UTD24/SSCI/FMS/CSSCI 分区`。
这行占位是**有意保留**的：留空会被前端 / 后端误判成「这条还没查过」而反复发请求。
另外把注释与 JSDoc 里「只保留 4 类」的旧说法一并更正（此前实际已是 5 类，只是注释没跟上）。

### 二、为什么只需要改这一处

- **前端不用改**：`rankChips()`（`public/app.js:685`）是通用渲染，按 `label + value` 铺 chip，
  白名单里有什么就显示什么；
- **数据源不用换**：`fms` / `cssci` 本来就在 easyScholar `officialRank.all` 的字段表里，
  只是过去被白名单挡掉了；
- **去重按 label 而非 key**：`xrTop` 与 `xr` 共用「新锐分区」标签（前者优先），
  `fms` / `cssci` 标签唯一，不参与去重；
- **取值形态不统一**（`ssci: "Q3"` / `ajg: "2"` / `sciUp: "经济学4区"` / `fms: "C"`），
  代码统一走 `String(val)`，不需要按类别特判。

### 三、前端文案同步

- `public/app.js`：新手引导第 3 步的说明从「中科院 / ABS / SSCI 分区」补全为 7 类；
- `README.md`：功能表、EasyScholar 章节的保留类别列表（4 → 7 项）、占位文案与说明句。

### 四、验证

| 项目 | 结果 |
| --- | --- |
| 新增 `test/easyscholar.test.mjs` | **10/10** |
| 全量单测 Node 22.22.2 / Node 20.10.0 | **399/399** · **399/399** |
| 变异验证：撤掉 fms / cssci 两项 | 5 项断言变红，还原后复绿 |
| 真实返回样本核对（社区实测返回） | `中科院分区 经济学4区 · ABS 2 · SSCI Q3 · FMS C`；`sciif` / `jci` / `pku` / `ccf` 被正常丢弃 |
| 浏览器功能回归 `verify-features.mjs` | **75/75**，0 条 JS 错误 |

> 本机 `data/settings.json` 没有配置 easyScholar SecretKey，做不了真实联网查询，
> 因此验证用的是官方文档附录 + 社区实测的真实返回样本，而不是自造的假数据。

---

## v1.21.0：成果管理里的论文支持「在终端内阅读与翻译」（复用文献中心阅读器 + 来源收敛）（2026-10-08）

需求原话：*「对于英文论文，要支持像文献中心一样，能够在这个终端中阅读，翻译，逻辑与文献中心保持一致」*。

做法：**不新写阅读器，而是让阅读器多认一种「记录来源」**。文献中心的 PDF 阅读器（左 PDF / 右划词翻译 +
全文翻译）本来只认文献库的 `literatureId`，这次把「成果管理的附件」作为第二种来源接进去，
翻译走的仍是**同一条服务端流水线**（`/api/pdf-translate/*`），所以引擎 / 模型 / 术语表 / 并发设置天然共用。

### 一、后端：给翻译服务加「成果附件」来源

- `src/pdfTranslate/routes.js`
  - `registerPdfTranslateRoutes` 新增注入项 `resolveAchievementFile`（由 `server.js` 提供），
    路由层不直接 import 数据层，延续本项目「依赖注入避免循环依赖」的既有做法；
  - `resolveSourceFile()` 新增分支：`achievementId` + `fileId` → 交给注入的解析器拿磁盘路径。
    **放在最前面判断**，因为它比 `literatureId` 更具体，混传时不会被误判成文献记录；
  - `estimate` / `jobs` 两个入口把 `achievementId` / `fileId` 透传给服务。
- `src/pdfTranslate/index.js`
  - `PdfTranslateService.start()` 把 `achievementId` / `fileId` 写进作业对象（`publicView` 是浅拷贝，自动带到前端），
    前端才能按「这一篇成果」筛出翻译历史。`literatureId` 语义不变，老路径零影响。
- `server.js`
  - 注入 `resolveAchievementFile(achievementId, fileId)`：从成果数据层按 id 找附件、校验文件存在，返回 `{ path, name }`。

> **安全边界**：前端**始终拿不到**附件的磁盘文件名与绝对路径 —— `publicFile()` 会把 `filename` / `filePath`
> 剥掉，翻译时也只报 `achievementId + fileId` 让服务端自己解析。前端无法拼出任意路径去读本机文件。

### 二、前端：阅读器支持「按来源收敛面板」

- `public/app.js`
  - 阅读器状态新增 `pr.source`：`{ kind:'literature', id }` 或 `{ kind:'achievement', achievementId, fileId, name }`；
  - 抽出 `openReaderShell({ pdfUrl, title, source })`，`openPdfReader`（文献中心）与
    新增的 `openAchievementPdfReader`（成果附件）共用同一套「清残留 → 显示 → 载入 PDF」；
  - 新增 `applyReaderMode()`：成果附件并**没有文献库记录**，所以隐藏所有依赖记录的 UI ——
    「解析结果 / AI 对话」页签、「我的思考 / 笔记与高亮」区块、「高亮色」工具组、「笔记模式」按钮，
    以及划词工具条里的**高亮 / 下划线 / 笔记**（这三个会 PATCH 回文献库），只留「复制 / 翻译」；
  - 全文翻译的请求体改由 `ftSourceBody()` 构造：文献来源传 `literatureId`，成果来源传 `achievementId + fileId`；
    历史过滤抽成 `ftJobBelongsToCurrent()`，避免成果论文的翻译记录串到文献上；
  - `collectPageImages()`（视觉识别的逐页截图）原来用 `it.filename` 拼 `/uploads/...`，
    改成直接用阅读器**已加载的 `pr.docUrl`** —— 现在两类来源都能用，也不必重复加载 PDF；
  - 暴露 `window.__openReaderExternal(opts)` 给成果管理模块调用。
- `public/achievements.js`
  - 附件行新增「**📖 阅读**」（仅 PDF，`isPdfFile()` 判断）：拿到 `raw` 地址与 `achievementId/fileId` 后
    调 `window.__openReaderExternal`。非 PDF 不显示该按钮（pdf.js 读不了）。

### 三、★ 顺手修掉一个只有真实浏览器才暴露的层叠缺陷

`.pdf-reader` 的 `z-index` 是 **90**，而成果管理的详情抽屉 `.ac-detail` 是 **860** ——
从抽屉里点开阅读器，**阅读器会被抽屉盖住**，看起来就是「点了没反应、返回按钮也点不到」。

修法：阅读器按来源打标记（`body.ac-reading`），在 `achievements.css` 里把阅读器提到 `z-index: 1000`；
文献中心路径不受影响。**这是静态检查与单测都发现不了、只有真实点击才暴露的问题** ——
变异测试时把这条 CSS 撤掉，脚本立刻卡在「点不到 `#prClose`」上，正是用户会遇到的现象。

### 四、验证

- 新增 `test/achievement-reader.test.mjs`（7 项）：作业记住成果来源、不误标成文献、
  附件对外不暴露磁盘路径、前端按来源收敛用到的选择器都真的存在于 `index.html`、
  `data-litonly` 标记齐全、成果附件能被翻译服务解析出正文、四条拒绝路径（不存在 / 缺 fileId / 非 PDF / 成果优先于文献）。
- 全量 `node --test`：**389 项全绿**（Node 20.19.0 与 Node 22.22.2 **双版本**都跑，贴近 CI 的 Node 20 不漏）。
- 真实浏览器端到端（Playwright + 真实 Chromium + 真实多页英文 PDF）：**18 项全绿、0 条 JS 运行时错误**，
  含「PDF 真的渲染出画布」「阅读器盖住抽屉」「成果下只剩 2 个页签」「文献下仍是 4 个页签」等。
- **变异验证**：撤掉来源隔离 → 3 条断言立刻变红；撤掉层叠修复 → 层叠断言变红且点击真的失效。
  两次变异都证明断言有效（不会失败的断言等于没有断言）。

### 五、需求覆盖

| 需求 | 落点 |
| --- | --- |
| 英文论文能在终端中阅读 | 成果详情 → 附件 →「📖 阅读」，进入与文献中心同一套阅读器（连续翻页 / 缩放 / 旋转） |
| 能翻译 | 同一阅读器右侧「划词翻译」（选中即译）与「全文翻译」（整篇，产出 Markdown / 单语 / 双语 / 重排版） |
| 逻辑与文献中心一致 | 同一套前端阅读器、同一个 `/api/pdf-translate/*` 服务端流水线、同一份翻译引擎与设置 |

---

## v1.20.0：新增「🏆 成果管理」——自己的成果统一归档（二级侧边栏 / 识别字段 / 任意格式附件 / 在投进度与草稿 / 文件夹 / 导出 ZIP）（2026-10-08）

需求原话：*「支持科研人员自己的成果管理。可以再展开二级侧边栏（可以收回），分为论文、专利、证书、
教材、项目证明等，可以集成到论文进度中，用户上传自己的论文，如果是已经完成出版发行的，
和文献中心一样识别应有的字段，而且还要支持科研人员上传 PDF、上传检索报告，而且还要支持导出这些文件。
如果是在投的论文，支持填写进度、支持保存草稿、支持自定义文件夹、还要支持新建文件夹……
而且里面的内容支持打开，比如 docx 文件就链接到 word 打开，pptx 就链接到 ppt 打开，xlsx 就链接到 excel 打开」*，
并补充：*「包括代码什么的，都要支持用户在电脑上选择程序打开」*。

做法：**再开一个与文献中心、学位论文阅读并列的独立模块**（数据文件、字段表、前端 DOM 全部自建），
`server.js` 只加一行注册、`app.js` 只加视图映射与一次挂载，既有功能零改动。

### 一、数据层与字段表（新增 `src/achievementStore.js` / `src/achievementFields.js`）

- **数据文件**（都在当前数据目录下，随备份 / 迁移 / 导出一起走）：
  `achievements.json`（成果记录，含附件清单）、`achievement-folders.json`（自定义文件夹）。
- `achievementFields.js` 是**唯一真相**：五类型（`paper` / `patent` / `certificate` / `textbook` / `project`）
  各自的**表格列**（`COLUMNS`）、**详情分组**（`DETAIL_GROUPS`）、**字段中文标签**（`FIELD_LABELS`）、
  **两条阶段说法**（`STAGE_LABELS`，论文是「已出版发行 / 在投中」，专利是「已授权 / 申请中」……）。
  前端通过 `GET /api/achievements/meta` 拿同一份定义，避免两边各写一套然后慢慢跑偏。
  **有单测守住「详情里出现的字段一定在字段总表里」**（漏一个就会「表单渲染不出值、保存又被白名单丢掉」）。
- **论文的识别字段直接复用文献中心那套**（`import { FIELDS } from './aiExtractor.js'`），
  外加卷 / 期 / 页码 / 出版社 / ISSN；所以同一篇论文在两处识别出来的字段是一致的一套。
- **在投进度状态复用「论文进度」的流水线词表**（构思中 / 撰写中 / … / 撤稿，`PROGRESS_STATUSES`），
  同步过去不用做映射翻译。
- `advanceStore.blankAchievement()` 把**所有文本字段初始化为空串**（不留 `undefined`）；
  `normalizeFile()` 在 `ext` / `appHint` 缺失时**按文件名推**（调用方漏传也不至于界面显示不出「通常用 Word 打开」）。
- **默认文件夹**：`folderId === ''` 即「数据文件夹」，由 `listFoldersWithDefault()` 永远排在第一、
  不可重命名 / 删除；**删文件夹时里面的成果回到默认文件夹，绝不连带删成果**（有单测）。
- `PATCH_WHITELIST` 与 `patchAchievement`：`filePath` / `files` / `status` / `id` **一律改不动**
  （附件清单只能走附件接口，`status` 只由识别流程改）；`progressPercent` 走 `sanitizePercent` 夹到 0–100，
  `year` 顺手清洗成 4 位。
- `publicRecord()` 对外**剥掉磁盘路径**（前端只需要「叫什么、能不能打开」）。

### 二、HTTP 接口（新增 `src/achievementRoutes.js`，约 700 行）

- 记录：`GET/POST /api/achievements`、`GET/PATCH/DELETE /api/achievements/:id`、`batch-delete`、`batch-update`。
- 文件夹：`GET/POST /api/achievement-folders`、`PATCH/DELETE /api/achievement-folders/:id`
  （重名拒绝、「数据文件夹」这个名字不许被占用）。
- **附件**：`POST /api/achievements/:id/files`（**任意格式**，multer 单独建了一条 storage，
  不复用那个「只收 PDF」的 upload）、`DELETE .../files/:fileId`、
  `GET .../files/:fileId/download`（按原名导出）、`.../raw`（应用内预览）。
- **打开附件三模式** `POST .../files/:fileId/open`：
  - `mode=default` → `openPath`（Electron `shell.openPath`），docx→Word、pptx→PowerPoint、xlsx→Excel；
  - `mode=pick` → `openWith`（**弹出系统对话框让用户自己挑程序**，代码文件 / 无关联格式靠这条）；
  - `mode=folder` → `revealFile`（`shell.showItemInFolder` 定位文件）。
  **没有系统能力时返回 409 + `fallback: 'download'`**，前端据此自动改为下载并提示，
  而不是静默失败；系统「没有关联程序」时（`openPath` 返回错误说明）也返回可读原因 + 下载兜底。
- **字段识别** `POST /api/achievements/:id/parse`（`source=main|searchReport`）与 `batch-parse`：
  PDF 走 `extractPdfText`、DOCX 走 `mammoth`；AI 走 `resolveRequestModel` + `fetchModelCompletion`
  （复用模型路由与故障转移）；**AI 不可用时退 `extractByRules` 规则解析**（与文献中心同一套兜底）；
  识别结果**只覆盖有值的字段**，并把 `folderId` / `tags` / `progressStatus` 等**控制类字段挡在外面**
  （防模型幻觉把记录改乱）。
- **进度与草稿**：`POST /api/achievements/:id/progress`（追加一条进度历史，**同状态同说明不重复记**，
  自动把阶段落到「进行中」，可同时更新投稿 / 返修日期与完成度）、`POST /api/achievements/:id/draft`
  （保存草稿，打 `isDraft` 标记）。
- **与论文进度集成** `POST /api/achievements/:id/sync-paper`：直接在 `papers` 里创建 / 原地更新，
  历史里写「由「成果管理」同步创建 / 更新」，并在成果上记 `paperId`；
  **重复同步不会堆出重复卡片**（有 HTTP 端到端断言守住）。
- **导出**：`GET /api/achievements/export`（CSV 带 BOM / JSON）、
  `POST /api/achievements/export-zip`（每条成果一个文件夹，附件按原名 + `meta.json` + `成果清单.csv`，
  缺文件时附 `导出说明.txt`）。
- **踩坑记录（值得留着）**：`GET /api/achievements/export` **必须注册在 `/api/achievements/:id` 之前** ——
  Express 按注册顺序匹配，放在后面的话 `"export"` 会被当成一个成果 id，永远 404。
  代码里已就地写了注释，勿再调换顺序。

### 三、导出用 ZIP：自己写，不引依赖（新增 `src/zip.js`）

- 为了「导出这些文件」去装一个 archiver / jszip，会牵动 `package-lock`、安装包体积与 CI 构建时间 —— 不划算。
  ZIP 的 **store（不压缩）**格式本身很简单：本地头 + 数据 + 中央目录 + 结尾记录，80 行搞定，
  而且论文 PDF 本来就是压缩过的，不压缩反而更快。
- 通用标志位 `0x0800` 标记 **UTF-8 文件名**（Windows 资源管理器 / 7-Zip / bsdtar 都能正常解出中文名）。
- `sanitizeZipName()` **剥掉绝对路径与 `..`**（防解压时写到目标目录外），非法字符替换；
  `uniqueName()` 同名自动加 `(2)(3)`。
- 单测**独立实现了一个 ZIP 读取器**把字节解回来核对文件名 / CRC / 大小 / 内容，
  并拿 `"123456789"` 的标准 CRC32（`0xCBF43926`）与 `zlib.crc32` 双向对齐 ——
  防止「自己写自己读」的自洽式假验证。

### 四、前端（新增 `public/achievements.js` / `achievements.css`）

- **可收起的二级侧边栏**：类型（含数量）+ 文件夹（含数量）+ 底部「＋ 新建文件夹」；
  `«` / `»` 收起（收起后只留图标，状态存 `localStorage`），窄屏（<1080px）默认收起。
- **表格**：列随类型变化（全部视图用统一列），支持搜索（名称 / 作者 / 期刊 / DOI / 专利号 / 证书编号…）、
  阶段筛选（已完成 / 进行中 / 草稿）、排序与升降序、多选与批量操作（识别 / 移动文件夹 / 导出 / 删除）。
  列表里**直接点附件名就是用默认程序打开**。
- **详情抽屉**：按 `DETAIL_GROUPS` 渲染表单（长文本自动用多行框），顶部可改类型 / 阶段 / 文件夹；
  含「🧠 字段识别」卡、「🚀 在投进度」卡（仅论文，带进度条与时间线）、「📎 附件」卡；
  底部「导出这条（含附件）」「💾 保存草稿」「保存」。
- **新建成果弹窗**：选类型 + 名称 + 阶段 + 文件夹，并明确提示「没选文件夹会放在数据文件夹」；
  「⬆ 上传成果文件（自动建档）」支持**一次选一批 PDF/Word 批量建档 + 上传 + 自动识别**。
- 弹窗一律用**应用内输入弹窗**，不用 `window.prompt`（打包版 Electron 里被禁用会直接报错 —— 这是
  学位论文那轮踩过的坑）；`Esc` 依次关预览 → 弹窗 → 详情抽屉。
- 浏览器模式下的降级：`open` 接口返回 409 时自动改为下载并提示「当前运行方式不能直接调起本地程序」。

### 五、接线与系统能力

- `public/index.html`：导航加 `data-view="achievements"`（🏆 成果管理，排在「论文进度」之后）、
  空 `<section id="viewAchievements">` 挂载点、引入 `achievements.css` / `achievements.js`。
- `public/app.js`：`switchView` 的 `map` 加一项、主区加 `ac-mode`、离开时 `AchievementView.close()`、
  进入时 `AchievementView.mount()`。
- `server.js`：`import { registerAchievementRoutes }` + 一处注册（注入 store / 上传目录 / 文件名修复 /
  `openPath` / `openWith` / `revealFile` / 模型调用）。
- `electron/main.cjs`：新增两项系统能力 ——
  `openWith`（`dialog.showOpenDialog` 挑程序后 `spawn` 打开；macOS 走 `open -a`，`.lnk` 走 `cmd /c start`），
  `revealFile`（`shell.showItemInFolder`）。
- **顺手修掉一个真 bug**：`/api/open-datadir` 里 `const err = openPath(dir); if (err)` ——
  Electron 的 `shell.openPath` 返回的是 **Promise**（永远为真），所以「打开数据目录」**必然报 500
  `[object Promise]`**。已改成 `await` 并兜住异常。同一个坑在这个模块里不会再犯（所有系统调用都 await）。

### 六、测试

- 单元测试 **355 → 382 项全绿**（本轮新增 **27 项**）：
  - `test/achievement-store.test.mjs`（10 项）：字段初始化、默认文件夹、白名单（`filePath` 改不动）、
    完成度 / 年份清洗、删文件夹不连带删成果、附件清单与公开输出、删除返回待删物理文件、summary 统计；
  - `test/achievement-fields.test.mjs`（9 项）：五类齐全、**每类详情里的字段都在字段总表里**、
    论文识别字段与文献中心对齐、进度词表与论文进度一致、DOI / 年份 / 完成度归一化、垃圾输入不抛错、
    扩展名 → 程序提示、提示词点名所有要提取的字段；
  - `test/zip.test.mjs`（5 项）：**独立解包核对文件名 / CRC / 内容**、空内容与二进制、
    CRC 与标准值 + `zlib.crc32` 双向对齐、路径逃逸防护、同名去重；
  - `test/achievements-http.test.mjs`（3 项）：真实 HTTP 端到端 ——
    建档（不选文件夹落默认）→ 上传 PDF / 检索报告 / 代码 / 压缩包 → 下载字节一致 →
    三种打开模式与「无系统能力 409 降级」「系统无关联程序 500 降级」→ AI 识别（含幻觉字段被丢弃、
    DOI / 年份清洗）→ 白名单 → 进度（重复不重复记）→ 草稿 → 同步论文进度（不堆重复卡片）→
    CSV BOM + ZIP 解包核对 → 删除；另有「无模型时规则解析兜底」「换数据目录不丢数据」。
- 全量 `node --test`：**382 项全绿**，既有功能无回退。

### 七、文档与版本

- `package.json` / `package-lock.json`（2 处）版本号 `1.19.2 → 1.20.0`；
- `README.md`：功能表加「成果管理」一行、新增「## 成果管理」章节（二级侧边栏 / 识别字段 / 附件与打开方式 /
  在投进度与草稿 / 同步论文进度 / 导出 / 常见问题）、项目结构补齐新文件；
- `.github/release-body.md`：写入 v1.20.0 正文，v1.19.2 归入历史。

### 八、真实浏览器验证（Playwright）发现的三个缺陷

`node --check` 过了、382 项单测也全绿，但接上真实 Chromium 走一遍 UI，**还是抓到三处只有真实渲染才
会暴露的问题**。三个都是单测与 HTTP 级测试结构上碰不到的（后端接口本身是对的），记在这里：

1. **`#acNewFolder` 一个 id 用了两次** —— 侧边栏底部「＋ 新建文件夹」按钮与新建成果弹窗里的
   文件夹下拉撞了 id。`$('#acNewFolder')` 取到的是 DOM 里靠前的那个**按钮**，于是
   `folderId: $('#acNewFolder').value` 恒为 `undefined`（按钮没有 value）——
   **用户在新建弹窗里选的文件夹永远不生效，成果一律落回「数据文件夹」**。
   这正是用户需求里明确要的「支持自定义文件夹」，功能看起来在、实际是坏的。
   → 修：按钮改 `acBtnNewFolder`，下拉改 `acNewFolderSel`，读取处写明注释。
   → 回归断言：「新建时选中的自定义文件夹真的生效（id 撞车回归）」，比对该条成果落库的 `folderId`。
   变异验证：把读取处改回 `#acNewFolder` 或撤掉按钮改名，该断言分别以「值不符」与「元素找不到」变红。

2. **`bindDetail is not defined`** —— `renderDetail()` 末尾残留一句 `bindDetail(item)`，而该函数
   并不存在。详情里的按钮早已改为 `bindList()` 中的事件委托，这行是重构漏删。后果是
   **每次打开详情都抛 ReferenceError**（控制台报错、中断 renderDetail 收尾），
   只是因为 DOM 已写入、事件走委托，功能表面正常，静态检查与单测都看不到。
   → 修：删掉该行并加注释说明详情事件由委托处理，禁止加回。
   → 回归断言：「无 JS 运行时错误」（收集 `pageerror` / `console.error`）。

3. **侧边栏计数停在旧值** —— `renderSide()` 用的是 `S.summary` / `S.folders[].count` 这两份
   **上一次请求的快照**。新建成果（或改文件夹）后只调 `renderSide()` 不重新拉取，
   于是「2026 年投稿」里明明进了一条，侧边栏还显示 `0`——用户会以为没放进去。
   → 修：分类数与文件夹数一律按当前 `S.items` 实时算（`countByCat` / `countByFolder`），
     并在新建成功后 `await refresh()` 让顶部统计也跟上。
   → 回归断言：「侧边栏该文件夹计数变为 1」+「刷新后成果数据仍在」。

**E2E 覆盖**：49 项断言，含导航与视图切换（渲染产物非空白、主区尺寸非 0）、二级侧边栏收起/展开
与 localStorage 持久化、分类筛选、文件夹新建、新建成果（默认夹与自定义夹两条路径）、
详情抽屉字段编辑落库（读后端确认）、在投进度与保存草稿、附件上传、
「打开 / 用其它程序」在无系统能力时降级为下载、导出附件与导出 ZIP（校验魔数 `50 4b 03 04` 与
内部文件名）、CSV 带 BOM、同步到论文进度且重复同步不堆卡片、刷新持久化、跨视图切换回归。
结果 **49/49 全绿、0 条 JS 运行时错误**。验证脚本与输出留档于
`~/.workbuddy/achievement-e2e-evidence/`（临时目录 `.debug/` 跑完已删）。

### 九、发版自检：只在 Node 20 下暴露的上游流适配缺陷（`src/proxiedFetch.js`）

发版前按流程用 **Node 20 与 Node 22 各跑一次**全量单测：Node 22 全绿，**Node 20 红 1 项** ——

```
not ok 126 - probeProxy：隧道通就算可用（不要求状态码是 2xx）；端口没人监听则不可用
  failureType: 'uncaughtException'
  error: 'Invalid state: Controller is already closed'
  code: 'ERR_INVALID_STATE'
    ReadableStreamDefaultController.close (node:internal/webstreams/readablestream:1058:13)
    IncomingMessage.<anonymous> (node:internal/webstreams/adapters:454:16)
    IncomingMessage.onclose (node:internal/streams/end-of-stream:162:14)
```

**这是上游（v1.18.0 引入）就存在的缺陷，与本次成果管理改动无关**；但它会让 CI 的 Windows 作业
（Node 20.19.0）变红 → `release` 作业被 skip → **Release 一个都发不出来**，所以必须一并修掉。

- **根因**：`toResponse()` 用 `Readable.toWeb(nodeRes)` 包装上游响应。`probeProxy` 拿到状态码就
  `body.cancel()`，而 Node 20 的适配层在 `IncomingMessage` 的 `onclose` 里**对已经 close 的
  controller 再调一次 `close()`** → 抛 `ERR_INVALID_STATE`。该异常发生在微任务里，逃出了
  `cancel()` 的 `try/catch` → 变成 uncaughtException → 测试进程判负。
  **Node 22 时序不同，多数情况不触发** —— 所以「本地 Node 22 全绿」骗过了一轮。
- **修法**：新增 `nodeStreamToWeb()`，自己把 `IncomingMessage` 的 `data / end / error / close`
  接成 `ReadableStream`：所有收尾都过 `finish()`，用 `done` 闸门保证**只收尾一次**（二次收尾直接忽略）；
  `desiredSize <= 0` 时 `pause()` 上游、`pull()` 时 `resume()` 保留背压；`cancel()` 时 `destroy()` 上游。
  **不要再改回 `Readable.toWeb`。**
- **修后**：Node 20 与 Node 22 各自 **382 项全绿**。

**环境教训（跑 `verify-features.mjs` 必读）**：该脚本第 230 行是**直接 import 仓库的 `src/store.js`**
往**默认数据目录**塞种子会话的，所以被测实例**必须也用默认数据目录**（即直接 `node server.js`）。
我一开始为了让验证「不碰真实数据」而给实例指了隔离 / 副本数据目录，结果脚本写进去的会话服务端读不到，
第 4 项必红（`{"ok":false,"count":0,"bubbles":0}`）—— 这是**脚手架配置问题，不是产品缺陷**。
换成默认数据目录后 **75/75 全绿**。脚本自带 cleanup，跑完 `data/` 与备份逐字节一致。

---

## v1.19.2：学位论文阅读六项体验修正——排序 / 分层解析 / 分级评级 / 笔记插图 / 扫描件识别 / 弹窗可关（2026-09-25）

针对用户反馈的六条：①排序选择不够用 ②解析还是慢（每次传 3 页图）③评级看着只能标 5 星
④笔记要能插图片（Ctrl+V）⑤扫描件没文本层、摘不到素材库 ⑥「字段配置」弹窗关不掉。

### 一、排序：年份 / 导入时间 / 评级 + 升降方向 + 表头点击（`public/thesis.js` / `.css`）

- 新增常量 `COL_SORT`（列 key → 排序 key，如 `year`/`importedAt`/`rating`/`title`/`progress`）、
  `SORT_KEYS`（合法排序键集合）、`SORT_LABELS`、`SORT_DEFAULT_DIR = { title: 'asc' }`。
  `S.sort = 'importedAt'`、新增 `S.sortDir = 'desc'`，持久化到 `localStorage.thesisSort`（`LS.sort`）。
- `cmpDesc(a, b, key)` 统一语义为**降序**，调用方乘 ±1 换方向：`filtered()` 里
  `sign = S.sortDir === 'asc' ? -1 : 1`，即 `list.sort((a, b) => sign * cmpDesc(a, b, sort))`。
- `setSort(key, { toggle })`：同列再点**反转方向**，换列用该列默认方向（避免「按年份却把最老的放最前」）。
  `syncSortUi()` 把状态同步到 `#thSort` 下拉与新增的 `#thSortDir` 方向按钮（文案 `↓ 降序` / `↑ 升序`）。
- 表头：带 `COL_SORT` 的列渲染成 `<th class="th-sortable" data-sortkey=…>`，非当前排序列显示 `↕`、
  当前列显示 `↑`/`↓`，`#thWrap` 上做事件委托 `setSort(dataset.sortkey, { toggle: true })`。
- `mount()` 时从 localStorage 恢复排法。CSS 新增 `.th-sortable` / `.th-sorted` / `.th-sort-ind`。

### 二、解析分层：先只送第 1 页，不够才补看 2–3 页（`src/thesisRoutes.js` / `src/thesisFields.js`）

- **`src/thesisFields.js` 新增 `fieldsComplete(fields)`**：`title` 必须存在，且
  `[authors, school, degreeType, year]` 里至少命中 2 个 —— 用来判定「封面页够不够」。
- **`buildThesisParsePrompt(lang, pageCount)`** 按真实页数措辞（「**第 1 页（封面）**」vs「**前 N 页**」），
  不再写死 3 页。
- **`parseThesis` 重写为两段**：
  - 第 1 段固定 `thesisPdf.readThesisHead(filePath, 1)`；
    `useImages = images.length > 0 && !!vision`，视觉优先（`askWithImages(vision, images.slice(0, 1))`），
    失败/无视觉则退文本（`askWithText(profile, head.pages)`）；`method` 记 `'vision' | 'text'`。
  - `!fieldsComplete(fields)` 才进第 2 段，三条分支：
    A. `useImages && images.length >= 2`（前端已补送 2–3 页）→ 直接 `askWithImages(slice(0, 3))`，
       **不再多跑一趟 HTTP**，`pagesUsed = min(3, images.length)`；
    B. `useImages` 但只有封面 1 张 → 后端起不了作用，返回 `needMorePages: true` 让**前端**补图后重来；
    C. 文本路径 → 后端自己 `readThesisHead(filePath, 3)` 再解析一次（省一次往返）。
  - 记录 `parsePages`（这次实际用了几页）落库；`needMorePages` **只在当次响应里**，不落库。
  - 新增内部工具 `askWithImages` / `askWithText` / `joinPagesText` / `bestEffort`（补看失败不推翻第 1 段结果）。
- **`src/thesisStore.js`**：`blankThesis` 增加 `parsePages: 0`。
- **前端 `parseOne(rec)`**：`collectHeadImages(rec, 1)` → POST `/parse`；
  仅当响应带 `needMorePages && S.visionReady` 才 `collectHeadImages(rec, 3)` 再 POST 一次。
  `collectHeadImages` 增加**按页 JPEG 缓存**（`headDoc.cache`），补看时第 1 页不重渲。
- 前端新增 `parseMethodLabel(it)`：「视觉模型看图 · 前 N 页」（`renderFields` / `renderDetail` 共用），
  把「省了几页」变成用户看得见的证据。

### 三、评级可分级：悬停只亮前 N 颗（`public/thesis.js` / `.css`）

- **根因**：不是功能问题，是 CSS —— `.th-stars:hover .th-star { color: var(--star) }` 一次把 5 颗全染金，
  观感上像「只能标 5 星」。点第几颗本来就是几星（`patchItem({ rating })`，同颗再点置 0）。
- 删掉那条 `:hover` 规则，改为 JS 驱动的 `.th-star.preview`：`starPreview(root)` 在 `mouseover` 时
  只给 `data-v <= 悬停星` 的星加 `.preview`（`mouseout` 离开整组时清除），CSS 里
  `.th-star.preview { color: var(--star) }`。表格（`#thWrap`）与抽屉（`#thDetailBody`）各绑一次。
- 星星 `title` 改为「点第几颗星就是几星（再点同一颗取消）」。

### 四、笔记插图：Ctrl+V 粘贴截图（`public/thesis.js`）

- `#thrMd` 上新增 `paste` 监听：从 `clipboardData.items`（`kind === 'file'` 且 `type` 以 `image/` 开头）
  或 `clipboardData.files` 取图；没有图就**不拦截**，交回浏览器默认粘贴。
- 新增 `#thrNoteImg`（🖼 插图）+ 隐藏 `#thrNoteFile`（`accept="image/*" multiple`）作为等价的选文件入口。
- 新增 `noteImageFiles` / `noteFileToDataUrl` / `insertNoteImages`：转成 **data URL** 写成
  Markdown `![名称](data:image/…;base64,…)`，插到光标处（复用 `window.PaperNoteUtils.insertSnippet`），
  插入后立刻 `saveNote()` 落盘；单张上限 **8MB**（`NOTE_IMG_MAX`），超了明确提示并跳过。
- `markdown()` 的 DOMPurify 配置加 **`ADD_DATA_URI_TAGS: ['img']`** —— 否则内联 data URL 会被当
  不可信协议清掉，预览里图片是空白。

### 五、扫描件也能摘录：框选 → 视觉模型转录 → 进素材库（`src/thesisRoutes.js` / `public/thesis.js`）

- **问题本质**：学位论文有相当比例是**扫描件**（整页一张图，无文字层），`getSelection()` 拿不到东西，
  「加入素材库」这条链路断在入口。
- **`src/thesisFields.js` 新增 `buildThesisOcrPrompt(lang)`**：「你是一位文字转录助手……只转录，
  不翻译、不总结、不解释、不补充」。
- **后端新增 `POST /api/theses/:id/ocr`**（`src/thesisRoutes.js`）：入参 `{ page, image(data URL) }`；
  校验 `^data:image/`（否则 400）、论文存在（404）、有视觉模型（否则 400 并给出可操作的提示语）；
  走 `callOnce(vision, { temperature: 0, max_tokens: 2000 })`，剥掉包裹的代码块、截断 20k 字符，
  空结果回 422；成功返回 `{ text, page, model }`。
- **前端**（`public/thesis.js`）：阅读器顶栏新增「🈯 识别文字」按钮 → `startOcr()` 在当前页盖
  `.thr-ocr-layer` 蒙版（`mousedown` 起点、`mousemove` 画框、`mouseup` 出区域），
  没拖动（<14px）视为**识别整页**；Esc 走 `escOcr` → `cancelOcr()`。
  目标页若已被离屏回收，先 `await renderPage(n)` 再允许框选。
- `cropPageJpeg(pageNo, region)` **按 2–3 倍重渲**再裁剪（屏幕位图受 DPR 1.5 限制只有约 100DPI，
  小字认不出），并做屏幕坐标 → 位图坐标映射、四周留 8px 余量。渲染时**先铺白底**（透明区在 JPEG 里会发黑）。
- 结果面板 `.th-ocr`（`#thOcrText` 可编辑）四个动作：**加入素材库 / 追加到笔记 / 用这段提问 / 重新框选**，
  分别复用 `quoteCurrent` / `appendNote(blockquoteText(...))` / 预填 `#thrInput` / 重新 `startOcr()`。
  `closeReader` 会 `cancelOcr()` + `hideOcrPanel()`。

### 六、字段配置弹窗：四条关闭途径（`public/thesis.js` / `.css`）

- **根因**：旧弹层复用共用样式 `.pop`（`position: fixed` 却没给 `top/left`），且**没有写任何关闭路径**。
- 改为专用 `.th-colspop`：`openColsPop()` 用 `#thBtnCols` 的 `getBoundingClientRect()` 把弹层
  **锚定在按钮下方**（`style.top/right`），按钮加 `.active`。
- 关闭途径四条：①`#thColsClose`（✕）②再点 `#thBtnCols`（`toggleColsPop`）③`document` `keydown` 的 **Esc**
  ④`document` `mousedown` 点外部（`closest('#thColsPop') || closest('#thBtnCols')` 则忽略）。
- `renderColsPop()` 的事件监听**只挂一次**（`pop.dataset.bound` 守卫），避免反复开合叠出重复提交。

### 测试

- **`test/thesis-fields.test.mjs`（新增，12 项）**：`fieldsComplete` 边界（标题缺失、5 个字段齐、
  只命中 1 个、`null` 输入）、`buildThesisParsePrompt(pageCount)` 页数措辞、
  `buildThesisOcrPrompt`、`normalizeThesisFields` 收口、字段契约（5 个 AI 字段 / 12 列 / 17 个废弃字段）。
- **`test/thesis-http.test.mjs` 扩写**：mock 上游加 `parsePartialLeft`（只回标题 N 次）与
  `ocrEmptyLeft`（回空代码块 N 次）+「文字转录助手」分支；解析段拆成
  2a 文本路径 `parsePages === 1`、2b 只送 1 图不触发补看、2c 只给封面图 → `needMorePages: true` 且不落库、
  2d 送 3 图 → 两次视觉调用（1 张 → 3 张）且 `parsePages === 3`、2e 文本补看 → `parsePages === 3`、
  2f 垃圾图退回文本；新增 ⑩′ OCR 段（成功、422 空结果、400 无图、404 论文不存在、400 无视觉模型）。
- 结果：单元测试 **355/355**（原 343 + 12）；真机 `verify-thesis.mjs` **170/170**（原 121，
  新增排序 14 项 / 分层解析 5 项 / 分级评级 5 项 / 笔记插图 4 项 / OCR 9 项 / 弹窗关闭 6 项）；
  回归 `verify-features.mjs` **75/75**、`verify-router-panel.mjs` **52/52**，无回退。
- ⚠️ E2E 里的一个真坑：OCR 框选的 `mousedown` 坐标不能只按蒙版矩形钳到视口内 ——
  页面比视口高时蒙版顶部是**负值**（被阅读器顶栏盖住），钳到 8px 会把 `mousedown` 打到顶栏上，
  蒙版收不到 `down`、识别永远不触发。正确做法是取「**蒙版 ∩ `#thrScroll` 可读区域**」再内缩。

## v1.19.1：学位论文阅读体验修正——视觉解析、字段精简、详情抽屉、阅读器提速、笔记模式（2026-09-25）

针对 v1.19.0 上线后反馈的五点：解析慢且会错 / 字段太多 / 想看解析详情 / PDF 滑动卡 / 笔记模式难用。

### 一、解析改走视觉模型（只读前 3 页）

- **`src/thesisPdf.js` 新增 `readThesisHead(filePath, n=3)`** —— 用 pdf.js `getPage(i).getTextContent()`
  只取前 n 页（不再整本抽），返回 `{totalPages, pages, bookmarks, meta, charCount}`。
  内置 `joinTextItems` / `joinLine` 做**行重组**，避免「某某大学硕士学位论文2024」这类封面串行。
  > 旧的 `readThesisPdf`（整本）保留给建索引用，解析路径不再调它。
- **前端渲染前 3 页为 JPEG**：`public/thesis.js` 的 `collectHeadImages()` 用 pdf.js 把页面画到
  **白底 canvas**（PDF 透明底直接画会发黑），scale 设上限、JPEG 质量 0.82，产出
  `data:image/jpeg;base64`，随导入请求以 `pages:[{page,image}]` 送出（并发 2）。
- **`src/thesisRoutes.js` 的 `parseThesis` 重写**：`readThesisHead` + 若 `images.length && vision`
  则走视觉（`visionComplete`，OpenAI 兼容 `image_url`，非流式 `fetchModelCompletion`，`max_tokens:1200`），
  否则退回**只读前 3 页的文本**方式。响应带 `source: 'vision' | 'text'` 与 `parseModel`。
- 视觉能力经 `resolveVisionModel(settings)` 判定（`server.js`），`registerThesisRoutes` 的 ctx 新增该项；
  前端由 `/api/models/choices` + `/api/models` 的 `activeVision` 决定标不标「视觉解析」。

### 二、字段精简：22 → 5（表格 12 列）

- **`src/thesisFields.js`**：`THESIS_AI_FIELDS = ['title','authors','school','degreeType','year']`；
  新增 `THESIS_REMOVED_FIELDS`（17 个废弃：`major`/`supervisor`/`keywords`/`abstractPoints`/`summary`/
  `researchQuestion`/`theory`/`method`/`dataSource`/`conclusion`/`innovation`/`limitation`/`value`/
  `structure`/`dataOpen`/`suggestedRating`/`ratingReason`）。
  `THESIS_DEFAULT_COLUMNS` 12 列（末两列 `degreeType`/`year` 可关），`THESIS_EXTRA_COLUMNS = ['degreeType','year']`。
  `buildThesisParsePrompt` 只问 5 个字段（铁律：只填真实值、年份为 4 位字符串）；
  新增 `sanitizeYear` / `sanitizeDegreeType`（只认硕士/博士）/ `sanitizeSchool`（剥「硕士学位论文」后缀与字段名前缀）
  与 `normalizeThesisFields` 统一收口。
- **`src/thesisStore.js`**：新增 `stripRemovedFields(record)` 与 `pruneRemovedFields()`（模块级 once 守卫），
  `listTheses` 与 `upsertThesis` 都过一遍；`GET /api/theses` 触发一次清理，旧数据自动瘦身。
- **`src/thesisContext.js`**：`buildProfileCard` 收敛到 5 行。
- **`public/thesis.js`**：`BASE_COLS` 改 12 列、`EXTRA_COLS` 清空；删掉 `data-suggest`（AI 建议评级）相关渲染，
  评级改为纯手点。`localStorage` 键 `thesisCols` → `thesisCols2`，强制老用户落到新默认列。

### 三、点标题 → 解析详情抽屉（对齐文献中心）

- `public/thesis.js` 标题格改为 `<div class="th-title-cell" data-detail=...>`，点击调 `openDetail`；
  新增 `openDetail/closeDetail/stepDetail/reparseDetail/renderDetail` 一整块（约 600–773 行），
  结构对齐 `app.js` 的 `openDrawer/renderDrawer`：字段行 + 分类下拉（`change` 即存）+ 评级点星 +
  `↻ 重新解析 / 📖 阅读 PDF / 🗑 删除` + `← →` 前后翻篇。
- `public/thesis.css` 新增 `.th-drawer*` 系列；`public/app.js` 的 `switchView` 增加
  `if (v !== 'thesis') window.ThesisView?.close?.()`，离开视图时收起自建浮层。

### 四、PDF 阅读器提速（不再越滑越卡）

- 旧行为是「打开即把每页渲染成 canvas」，长论文内存爆掉导致滚动卡顿。现改为：
  - `observePages` 挂两个 `IntersectionObserver`：`PRELOAD_MARGIN='600px'` 负责**渲染**，
    `KEEP_MARGIN='2400px'` 负责**离屏回收**（`recyclePage` 释放 canvas、`renderTask.cancel()`）；
  - `enqueueRender` + `pumpRenderQueue` 串行渲染，**按离当前页距离排序**（就近优先）；
  - `renderPage` **DPR 上限从 2 降到 1.5**、`alpha:false`；页高 `Math.round` 取整避免亚像素抖动；
  - `goPage` 先把 `R.page` 更新再滚动，保证队列优先级正确；`setScale` 重建后重新入队邻近页；
  - `closeReader` 断开两个 observer、`clearQueue`、`R.doc.destroy()`。
- 实测 12 页样张**只渲染 3 页**；滚到末尾时画布数仍 ≤2。

### 五、笔记模式改「左原文 ｜ 右笔记」两栏

- 原来是挤成多栏、笔记区仅百余像素。现改为两栏 + 可拖 `#thrNoteResizer`，
  比例存 `localStorage`（`thesisNoteRatio`），并用 `setNoteView` 提供**编辑 / 预览**切换。
- CSS：`.thr.note-mode .thr-outline, .thr.note-mode .thr-side { display:none }`，
  阅读器 DOM 的笔记栏改为 `.thr-note-resizer` + `aside.thr-note#thrNotePane`。
- `openReader` 重置 `R.noteRatio / R.noteView` 并 `setNoteView('edit')`；`saveNote` 加 `R.noteLoaded` 守卫，
  防止「刚打开就存空内容把上一篇笔记覆盖」。

### 六、验证

- 单元测试 **343/343**（新增 2 项：字段精简迁移、`readThesisHead`）；
- `verify-thesis.mjs` **121/121**（重写：真实文件选择导入、抓包确认 3 张 base64 图 → 上游 `image_url`、
  `source==='vision'`、表头 12 列、详情抽屉落库、只渲染 3 页 + 离屏回收、笔记栏比例与拖拽、Markdown 预览）；
- 回归 `verify-features.mjs` **75/75**、`verify-router-panel.mjs` **52/52**，无回退。
- > 重写 E2E 时发现原「重开阅读器笔记还在」是**假通过**：v1.19.0 的 `openReader` 没清 `<textarea>`，
  断言读到的是上一篇的残留值。产品行为本身对（进笔记模式会从后端拉回），已把断言改成三向验证
  （后端落库 → 重开为空框不串笔记 → 进笔记模式内容回来）。这条教训已写进
  `playwright-verify-no-build-webapp` skill。

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