# processor —— PDF 版面解析子进程

这个目录**不是本仓库原创**，代码取自开源项目 [`cynicalight/reader`](https://github.com/cynicalight/reader)
的 `apps/processor`，用于给「一站式科研终端」补齐 PDF **版面结构解析**能力：
把每一页切成标题 / 段落 / 图表 / 表格 / 公式等区域，并给出每个区域的位置、类型与文字。

它被设计成**独立的 Node 命令行程序**（不是库），由主服务 `src/layout.js` 以子进程方式调用，
这样原生推理模块崩溃或吃内存时不会拖垮主进程。

## 目录结构

| 路径 | 说明 |
|---|---|
| `dist/` | **运行时要用的构建产物**（`main.mjs` / `repair-text.mjs` / `model.mjs`）。服务只跑这里面的文件。 |
| `dist/models/` | 版面模型 `PP-DocLayoutV3-FP16`（67 MB）+ 其许可文件。 |
| `src/` | 原始 TypeScript 源码（来自 reader 仓库），仅供追溯与二次修改。 |
| `model.json` | 模型定义（仓库、revision、sha256、体积）。 |
| `build.mjs` | 重建脚本（需要 esbuild）。 |
| `model-license/` | 模型许可（随模型一起分发，勿删）。 |

## 运行方式

```bash
node processor/dist/main.mjs --input <PDF> --output <空目录> [--from-page N] [--to-page N] [--model <onnx>] [--debug]
```

产物：

- `manifest.json`：每页每个版面块（`label` / `confidence` / `bounds` / `page` / `text` / `image`）
- `paper.md`：按阅读顺序拼好的 Markdown 全文
- `assets/*.png`：图表 / 公式 / 表格的裁图

stdout 逐页输出 `{"event":"page",...}` 进度行，最后一行 `{"event":"done",...}`。

## 重建（仅当需要修改算法时）

```bash
cd processor
npm install            # 需要 esbuild
npm run build          # 重新生成 dist/（模型已随仓库提供，不会重复下载）
```

`build.mjs` 默认会从 HuggingFace 校验/下载模型。**本机直连 HuggingFace 不通**，
如需重新下载请先设置镜像（`hf-mirror.com`），或直接把模型文件放入 `dist/models/`。
模型 sha256 见 `model.json`，校验不过会直接报错而不是静默使用坏文件。

## 注意事项

- **不要在 `processor/` 下放 `*.test.ts`**：本项目的单测跑的是 `node --test`，而 Node 22.18+ 默认启用
  类型剥离，会把 `.test.ts` 一并当作测试文件执行（表现为「多出若干必然失败的用例」）。
  上游自带的 6 个测试文件正因此已从本仓库移除。
- `dist/` 是**运行时唯一被引用的目录**（`src/layout.js` 只 spawn `dist/main.mjs`）。
  `src/` 仅作追溯，本项目没有 TS / esbuild 构建链，要改算法请按上面的「重建」步骤走。
- `dist/models/` 下的 `.onnx` 是从 HuggingFace 下载后随包分发的，**不要用 git 之外的方式改名**
   （文件名里的 revision 与 `model.json` 对应，校验不过会直接报错）。

## 许可

版面模型 `PP-DocLayoutV3` 的许可见 `model-license/LICENSE` 与 `model-license/NOTICE.md`，
随应用分发时必须一并保留。
