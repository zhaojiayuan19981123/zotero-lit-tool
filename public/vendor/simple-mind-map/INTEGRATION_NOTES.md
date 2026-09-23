# 第三方库集成备忘

## simple-mind-map（思绪思维导图）—— XMind 风格思维导图

- 上游：https://github.com/wanglin2/mind-map ｜ 作者 wanglin2 ｜ 许可证 **MIT**
- npm 包：`simple-mind-map`（本仓库固定在 `0.14.0-fix.3`）
- 本地位置：`public/vendor/simple-mind-map/`
  - `simpleMindMap.umd.min.js`（6.8MB，webpack UMD，**已内置全部依赖**）
  - `simpleMindMap.min.css`（24KB，来自包内 `dist/simpleMindMap.esm.min.css`，改名便于理解）
  - `LICENSE`（MIT 原文，来自上游仓库，npm 包里没有）
- 引入方式（沿用仓库既有 `public/vendor/` 约定，与 marked/dompurify/katex 一致）：
  ```html
  <link rel="stylesheet" href="vendor/simple-mind-map/simpleMindMap.min.css" />
  <script src="vendor/simple-mind-map/simpleMindMap.umd.min.js"></script>
  ```

### ⚠️ 关键 API 事实（已用真实 Chromium 实测确认，勿凭记忆猜）

1. **UMD 全局名是 `simpleMindMap`，类挂在 `.default` 上**：
   ```js
   const MindMap = window.simpleMindMap.default;   // ✅ 是构造函数
   // window.simpleMindMap.MindMap === undefined  ❌
   ```

2. **UMD 版已经把全部 21 个插件自动注册好了，不需要 usePlugin**。
   实测 `MindMap.pluginList` 已包含：MiniMap / Watermark / Drag / KeyboardNavigation /
   ExportXMind / ExportPDF / Export / Select / AssociativeLine / RichText / TouchEvent /
   NodeImgAdjust / Search / Painter / Scrollbar / Formula / RainbowLines / Demonstrate /
   OuterFrame / MindMapLayoutPro / NodeBase64ImageStorage。
   → 插件**不在** `MindMap.XxxPlugin` 静态属性上（那里只有 xmind/markdown/iconList/
     constants/defaultTheme/version），照搬源码 `full.js` 的 `MindMap.usePlugin(MindMap.Xxx)`
     写法会全部拿到 undefined。**直接 new 即可。**

3. **XMind 导出必须走 `doExportXMind.xmind()`，不能用 `doExport.xmind()`**：
   ```js
   const data = mm.getData();
   const blob = await mm.doExportXMind.xmind(data, '文件名');  // ✅ 返回 Blob
   // const s = await mm.doExport.xmind(name);                 // ❌ 内部 readBlob() 后返回 String，
   //                                                          //    不能当文件下载
   ```
   实测 Blob 7581 字节，前 4 字节 `50 4b 03 04`（PK\x03\x04），是合法 zip → 即 .xmind。
   下载：`URL.createObjectURL(blob)` + `<a download="x.xmind">`。

4. **PNG 导出**：`await mm.doExport.png(name)` 可用。

5. **节点操作 API（实例方法挂在节点对象上）**：
   ```js
   const node = mm.renderer.activeNodeList[0];
   node.setText(text);           // 改文字
   node.setImage({ url, title }); // 设图片（url 支持 dataURL / base64）
   node.setData({...});          // 改原始数据
   mm.execCommand('INSERT_CHILD_NODE');  // 插入子节点（Tab 同源命令）
   mm.execCommand('INSERT_NODE');        // 插入同级节点（Enter 同源命令）
   ```
   实测 `execCommand('INSERT_CHILD_NODE')` 生效：children 2 → 3、DOM 节点 3 → 4。

6. **内置快捷键（默认已注册，与 XMind 一致，不需要自己重写）**。
   实测 `mm.keyCommand.shortcutMap` 共 **27 个键**，键名是**首字母大写的驼峰**：

   | 键名（实测原文） | 作用 |
   | --- | --- |
   | `Tab` / `Insert` | 插入子节点（= XMind 的 Tab） |
   | `Enter` | 插入同级节点（= XMind 的 Enter） |
   | `Shift+Tab` | 插入父节点 |
   | `F2` | 编辑节点文字 |
   | `Del` / `Backspace` / `Shift+Backspace` | 删除节点 |
   | `Left` / `Up` / `Right` / `Down` | 节点间导航 |
   | `Control+Up` / `Control+Down` | 移动视图 |
   | `Control+=` / `Control+-` | 放大 / 缩小 |
   | `Control+c` / `Control+x` / `Control+v` | 复制 / 剪切 / 粘贴（含图片） |
   | `Control+z` / `Control+y` | 撤销 / 重做 |
   | `Control+a` / `Control+g` / `Control+i` / `Control+l` / `Control+Enter` / `/` | 全选 / 搜索 / 插入同级 / 展开层级 / 插入同级 / 折叠 |

   ⚠️ **注意大小写**：是 `Tab` 不是 `tab`、是 `Enter` 不是 `enter`、是 `Del` 不是 `Delete`。
   写验证脚本时按 `tab`/`enter` 去查会误判成「快捷键没注册」。
   如需微调用 `mm.keyCommand.addShortcut(key, fn)`，移除用 `removeShortcut`。

7. **节点数据格式**：`{ data: { text, uid, ... }, children: [...] }`；
   `getData()` 返回根节点对象（含 `data` / `children` / `smmVersion`）。
   注意 `text` 是**富文本 HTML**（RichText 插件启用时），如 `'<p>中心主题</p>'`，
   纯文本需自己 strip 标签。

8. ⚠️ **容器宽高为 0 时会直接抛错**（本项目踩坑并修复）：
   ```
   Error: 容器元素el的宽高不能为0
       at MindMap.getElRectInfo
   ```
   因此**不要在 `display:none` / 折叠的页签里创建实例**。正确做法：
   - 创建前先查 `el.clientWidth && el.clientHeight`，为 0 就**暂缓创建**并置一个
     `pending` 标记；
   - 等容器可见后**用短间隔轮询**（100ms × 最多 20 次）补建，**不要只依赖
     `requestAnimationFrame`**——后台标签页 / 隐藏窗口里 rAF 会被节流甚至完全不触发，
     实测会导致导图一直空白；
   - 已存在的实例在容器尺寸变化后调 `mm.resize()` 重新布局。

9. **`view` 与 `resize` API 都在**：`mm.view.fit()`（适应画布）、`mm.view.enlarge()`、
   `mm.view.narrow()`、`mm.resize()`、`mm.destroy()`、`mm.setData(data)`、`mm.render()`。
   切换数据用 `setData` + `render`，不要 destroy 重建（会丢缩放与布局状态）。
   ⚠️ **`setData` 之后必须等 `render(cb)` 回调再按 uid 找节点 / 调 `node.active()`**：
   `renderer.nodeList` 里此时还是上一轮的节点对象，过早操作会点到失效节点、把库的
   选中态弄乱（实测表现：之后点节点无反应、F2 进不了编辑、Ctrl+V 也失效）。

10. **`mousewheelZoomActionReverse` 的名字与行为是反的（务必按实测写）**：
   库源码 `mousewheelZoomActionReverse ? this.enlarge() : this.narrow()` 作用在
   「滚轮向上 / 向左」这一支上，**默认值是 `true`**。
   实测（真实 Chromium + `page.mouse.wheel`）：

   | 配置 | Ctrl + 上滑（deltaY<0） | Ctrl + 下滑（deltaY>0） |
   | --- | --- | --- |
   | `reverse: true`（默认） | **放大** | **缩小** |
   | `reverse: false` | 缩小 | 放大 |

   → 想要「Ctrl+下滑缩小、上滑放大」（等同 XMind 习惯）就必须写 **`true`**。
   另外 `mousewheelAction: 'move'` 才是「不按 Ctrl 时平移、按住 Ctrl 缩放」，
   `'zoom'` 会让滚轮无条件缩放。

11. **快捷键默认只在鼠标位于画布内时响应**：`enableShortcutOnlyWhenMouseInSvg`
   默认 `true`，且 `defaultEnableCheck` 只放行「事件目标为 `document.body` 或
   `editNodeClassList` 里的编辑框元素」。快捷键监听挂在 **`window`** 上（全局），
   所以要抢也抢得到 —— 好在有上面这层 `isInSvg` 兜底。
   `KeyCommand.bindEvent` 会监听 `svg_mouseenter` / `svg_mouseleave` 维护 `isInSvg`；
   节点文本编辑期间库会 `stopCheckInSvg()` 暂停检查、结束再 `recoveryCheckInSvg()`。

12. **⚠️ RichText（quill）节点编辑框粘贴时不会识别 smm 自己的剪贴板数据**：
   - 在画布内 Ctrl+C 复制节点 → 库 `copy()` 会把 `createSmmFormatData()` 的结果
     （`{"simpleMindMap":true,"data":[…]}`）经 `setDataToClipboard()` 写进剪贴板的
     **text/plain**。
   - 库对**普通**（非富文本）编辑框有兜底：`textEditNode` 的 paste 监听里会
     `checkSmmFormatData` + `getTextFromHtml(data[0].data.text)`，只取节点纯文本。
   - 但**富文本编辑框（`RichText` 插件 → quill）这条路径没有拦截**：quill 的
     `Clipboard.convert()` 在「没有 html、只有 text」时直接 `delta.insert(text)`，
     不经过 smm 注册的 matcher → **整段 JSON 被原样插入节点文字**（用户会看到一坨
     `{"simpleMindMap":true,…}`）。
   - 本项目的做法（见 `public/app.js`）：在 **`document` 的捕获阶段**拦 paste
     （必须在捕获阶段 —— quill 在编辑区自身监听，冒泡阶段轮不到我们），
     用 `PaperNoteUtils.smmClipboardToPlainText()` 识别并抽出文字，再用
     `document.execCommand('insertText', …)` 写进 quill（**不要直接改 innerHTML**：
     execCommand 会派发标准的 beforeinput/input，quill 才能同步内部 delta，
     否则一退出编辑内容就被回滚）。
   - 判断编辑框用 `.smm-richtext-node-edit-wrap / .smm-node-edit-wrap / .ql-editor`；
     注意这些元素是 `appendChild` 到 `document.body`（或 `customInnerElsAppendTo`）
     的，**不在导图容器里**，所以监听 `#pnMindHost` 是拦不到的。
   - 提交编辑后旧编辑框会以 `display:none` 留在 DOM 里，写验证脚本时要用
     `getBoundingClientRect().width > 0` 过滤出**可见**的那个，否则会读到旧的。

13. **点击「已激活」的节点是 toggle（会取消激活）**。写自动化脚本时不能假定
   「点一下就选中」；点完要检查 `.smm-node.active` 数量，必要时补点。
   另外节点文字变长后框会变宽，自己算中心点可能落到可视区外（点不到）——
   用 Playwright 的 `locator.click()` 交给它处理可见性最稳。

### 实测环境注意（本机）

- 用 playwright 做真实浏览器验证时，workspace 里装的 playwright 期望 chromium-1243，
  但本机只有 **chromium-1208**；必须显式指定：
  `chromium.launch({ executablePath: 'C:/Users/zjy1998/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe' })`
- ESM 下 `NODE_PATH` 对 `import` 无效，要用 `pathToFileURL(绝对路径)` 再 `await import()`。
- `agent-browser` 的 daemon 在本机不稳（偶发 `Failed to create temp profile dir: 拒绝访问 os error 5`），
  批量/无人值守验证优先直接用 playwright。
