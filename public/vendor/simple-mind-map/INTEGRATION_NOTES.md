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

### 实测环境注意（本机）

- 用 playwright 做真实浏览器验证时，workspace 里装的 playwright 期望 chromium-1243，
  但本机只有 **chromium-1208**；必须显式指定：
  `chromium.launch({ executablePath: 'C:/Users/zjy1998/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe' })`
- ESM 下 `NODE_PATH` 对 `import` 无效，要用 `pathToFileURL(绝对路径)` 再 `await import()`。
- `agent-browser` 的 daemon 在本机不稳（偶发 `Failed to create temp profile dir: 拒绝访问 os error 5`），
  批量/无人值守验证优先直接用 playwright。
