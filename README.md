# 一站式科研终端

面向经管类（经济学 / 管理学）科研人员的一站式文献管理与阅读桌面应用。Zotero 式侧边栏分类 + 多维表格 + 内嵌 PDF 阅读器（左 PDF 划词、右翻译面板）。

批量上传 / 拖入 PDF → AI 自动提取结构化信息 → 表格批量浏览管理 → 阅读器精读，覆盖从「收集文献」到「精读笔记」的完整科研流程。

**架构**：Node.js + Express 后端 + 原生前端（无框架），Electron 打包为 Windows 桌面 exe。

---

## 下载安装（Windows）

无需安装开发环境，直接下载 Windows 安装程序即可使用。

- **下载地址**：[最新版本下载](https://github.com/zhaojiayuan19981123/zotero-lit-tool/releases/latest)

> 或手动访问 [Releases 页面](https://github.com/zhaojiayuan19981123/zotero-lit-tool/releases)，下载最新版 `一站式科研终端-<版本>-安装版.exe`。

**安装说明**：

1. 下载 `一站式科研终端-<版本>-安装版.exe` 并双击运行
2. 按向导选择安装位置（默认会创建桌面快捷方式）
3. 安装完成后启动，首次打开会有新手引导，按提示完成 AI 密钥等初始设置

> 首次运行若被 Windows SmartScreen 拦截（未签名应用），点「更多信息 → 仍要运行」即可。

---

## 功能特性

| 模块 | 说明 |
|------|------|
| **Zotero 式侧边栏** | 「实证类文库」「模型类文库」两个独立文库，各自维护分类（新建 / 重命名 / 删除），底部实时显示阅读进度统计 |
| **文献归类** | 直接把表格里的文献行**拖到左侧分类**即可归类；拖回「全部文献」移出分类 |
| **实证 / 模型界面分开** | 两个文库字段列完全不同。实证类：理论 / 研究方法 / 研究设计 / 构念 / 结论 / 批判性思考；模型类：模型 / 求解方法 / 参数讨论 |
| **多维表格视图** | 字段分列 + AI 生成徽标列头；视图 Tab、字段配置、筛选、排序、列宽拖拽调节、行高调节 |
| **PDF 附件单元格** | 点击或拖拽 PDF 到单元格上传，自动生成首页缩略图；整页拖入 = 批量上传（带视觉反馈） |
| **中文文件名支持** | 自动修复浏览器上传的中文文件名编码（latin1 → utf8），文件名不再乱码 |
| **AI 自动解析** | 上传后自动提取：标题 / 作者 / 期刊 / 年份 / DOI / **摘要（中文翻译）** / 关键词 / 研究背景 / 创新点 / **一段话总结** + 当前文库的专属字段（markdown 分点） |
| **期刊等级** | 接入 easyScholar，保留 **中科院分区 / 新锐分区 / ABS / SSCI** 四类 |
| **PDF 阅读器** | 左侧连续页面渲染（高清、懒加载、适宽缩放），选中文字弹浮条「译 / 高亮 / 笔记」；右侧固定翻译面板（原文 / 译文 / 语言选择）+ 笔记高亮列表 |
| **阅读进度 / 评级** | 未阅读 / 阅读中 / 已阅读一键切换；1–5 星评级 |
| **划词翻译** | 支持硅基流动 DeepSeek / DeepL / 免费接口三种翻译提供方 |
| **AI 助手** | 多会话对话，可结合知识库 / 文献库提问，对话过长自动压缩摘要 |
| **项目管理 / 任务 / 论文进度 / 研究记录** | 科研日历、今日待办、投稿管理（小论文）、学位论文进度、实验记录等多模块联动 |
| **自定义保存位置** | 设置里填写数据目录（如 `D:\文献库`），数据与 PDF 自动迁移过去 |
| **导出** | CSV（全字段含期刊等级，带 BOM 防中文乱码）/ JSON |

## 使用流程

```
左侧选择文库（实证类 / 模型类）与分类 → 上传/拖入 PDF → 自动 AI 解析 → 表格批量浏览
→ 拖动行到左侧分类归类 → 点标题看解析 / 点📖进阅读器
阅读器内：划词 → 浮条「译 / 高亮 / 笔记」→ 右侧翻译面板显示原文与译文 → 笔记列表跳转
```

---

## 快速开始

### 环境要求

- Node.js ≥ 18（推荐 20+）
- npm

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

浏览器打开 <http://localhost:3000>。

### 3. 桌面运行（Electron）

```bash
npm run electron
```

以桌面窗口形式运行，体验与打包后一致。

### 4. 打包为 Windows 安装程序

```bash
npm run dist
```

生成 `dist/一站式科研终端-<版本>-安装版.exe`（NSIS 安装版，可自选安装位置、自动创建桌面快捷方式，数据跟随安装目录保存）。

---

## 目录结构

```
zotero-lit-tool/
├── server.js                # Express 后端入口（上传/解析/存储/导出/期刊等级/翻译/AI 助手）
├── package.json
├── electron/
│   ├── main.cjs             # Electron 主进程（打包 exe 用）
│   └── icon.png             # 桌面图标
├── src/
│   ├── store.js             # JSON 文件持久化（零数据库依赖）
│   ├── pdfParser.js         # PDF 校验 + 文本提取（unpdf）
│   ├── aiExtractor.js       # 提取调度：优先 LLM（硅基流动），回退规则
│   ├── ruleExtractor.js     # 离线规则提取（兜底）
│   ├── easyscholar.js       # easyScholar 期刊等级查询（含限速）
│   └── translate.js         # 划词翻译（DeepSeek / DeepL / 免费接口）
├── public/
│   ├── index.html           # 前端页面
│   ├── style.css            # 样式
│   ├── app.js               # 前端逻辑
│   ├── favicon.png
│   └── vendor/              # pdf.js 本地化（离线缩略图）
├── build/
│   ├── icon.svg / icon.png  # 图标源文件
│   └── installer.nsh        # NSIS 安装脚本
├── data/                    # 运行时生成：literature.json / settings.json（已 gitignore）
└── uploads/                 # 运行时生成：上传的 PDF 文件（已 gitignore）
```

> 打包为 exe 后，`data/` 与 `uploads/` 会自动改存到系统用户数据目录，避免写 exe 所在只读目录。

---

## AI 配置（推荐）

点击右上角「⚙ AI 设置」配置大模型与期刊等级查询，密钥均由用户自己填写、仅保存在本机：

| 配置项 | 说明 |
|--------|------|
| AI 提供方 | 默认「硅基流动 SiliconFlow（DeepSeek）」 |
| 接口地址 | 默认 `https://api.siliconflow.cn/v1` |
| API 密钥 | 硅基流动 API Key（`sk-...`，用户自填；AI 解析与划词翻译共用） |
| 模型 | 默认 `deepseek-ai/DeepSeek-V4-Flash`（可改） |
| 结果语言 | 简体中文 / English |
| easyScholar SecretKey | 期刊等级查询密钥（用户自填，留空则不查询） |
| 翻译提供方 | 硅基流动 DeepSeek（共用上方 Key）/ DeepL（单独 Key）/ 免费接口（无需密钥） |
| 数据保存目录 | 如 `D:\文献库`，保存后数据与 PDF 自动迁移 |

- **已配置 AI**：调用硅基流动 DeepSeek 模型返回结构化 JSON，提取质量高，能准确归纳「研究背景 / 方法 / 结果 / 创新点」。
- **未配置 AI**：使用内置规则离线提取，基础字段较可靠，深层归纳能力有限。
- **easyScholar**：解析出期刊名后自动查询等级，接口限速已内置（约 550ms/次，符合官方「每秒最多 2 次」要求）。

---

## 数据与导出

- 所有文献数据持久化在 `data/literature.json`，重启服务不丢失。
- 表格视图右上角「导出 CSV」一键导出全量字段（带 BOM，Excel 中文不乱码）。
- 也可直接访问 `/api/export?format=json` 导出 JSON。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/upload` | 批量上传 PDF（`multipart/form-data`，字段名 `files`） |
| POST | `/api/literature/:id/attachment` | 单篇附件上传（表格单元格内拖拽/点击） |
| DELETE | `/api/literature/:id/attachment` | 移除附件并清空解析字段 |
| POST | `/api/literature` | 新建空白记录 |
| POST | `/api/parse` | 批量解析（body 可带 `ids`，缺省解析全部非完成态） |
| POST | `/api/literature/:id/parse` | 单篇重新解析 |
| POST | `/api/literature/:id/rank` | 查询单篇期刊等级（easyScholar） |
| POST | `/api/translate` | 划词翻译 |
| GET | `/api/literature` | 列出全部文献 |
| GET | `/api/literature/:id` | 获取单篇 |
| PATCH | `/api/literature/:id` | 编辑字段（含阅读进度 / 评级 / 缩略图） |
| DELETE | `/api/literature/:id` | 删除记录与文件 |
| GET/POST | `/api/settings` | 读写设置 |
| GET | `/api/export?format=csv|json` | 导出 |

> 此外还有项目管理 `/api/projects`、任务 `/api/tasks`、研究记录 `/api/notes`、论文进度 `/api/papers`、AI 助手 `/api/chat/*` 等模块接口。

---

## 关于 Zotero 对接

当前通过「批量上传 PDF 文件」接入 Zotero 中的文献：在 Zotero 中对条目右键 →「显示文件」(Show File) 即可定位 PDF，或将文献 PDF 批量拖入本工具。

如需 Zotero 元数据（条目信息、标签、附件）直接同步，可基于 Zotero 本地 API（Zotero 7 `http://localhost:23119/api/`）或 Web API 扩展，接口预留了 `doi` 字段用于后续匹配去重。

---

## 技术栈

- 后端：Node.js + Express + multer（文件上传）
- PDF 解析：unpdf（基于 pdfjs-dist）
- AI：硅基流动 SiliconFlow（OpenAI 兼容接口，DeepSeek-V4-Flash）
- 期刊等级：easyScholar 开放接口（中科院 / 新锐 / ABS / SSCI）
- 前端：原生 HTML/CSS/JS 多维表格 UI（列宽可拖拽调节）；pdf.js（本地 vendor）缩略图与内嵌阅读器
- 桌面交付：Electron + electron-builder（NSIS 安装程序）
- 存储：本地 JSON 文件（零数据库依赖，开箱即用）

## 发布新版本（GitHub Releases）

打包完成后，把 exe 上传到 GitHub Releases，让上面的下载链接指向最新版本：

1. 本地打包：`npm run dist`，得到 `dist/一站式科研终端-<版本>-安装版.exe`
2. 打开 GitHub 仓库页面 → 右侧 **Releases** → **Draft a new release**
3. **Tag** 填版本号（如 `v1.0.0`）→ **Release title** 填 `v1.0.0`
4. 在「Attach binaries」里拖入那个 exe 文件
5. 点 **Publish release**

发布后，上面「下载安装」里的 `releases/latest` 链接会自动指向这个版本，用户点进去即可下载 exe。

> 上传 exe 前记得先 push 代码并确认版本号与 `package.json` 一致。

## License

[MIT](./LICENSE)
