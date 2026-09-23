# 在 macOS 上打包「一站式科研终端」

本项目是跨平台的 Electron 应用（Node.js + Express + 纯前端），源码在 macOS 上可直接运行和打包。

> ⚠️ macOS 的 `.dmg` 安装包**必须在 Mac 上打包**（依赖 macOS 的 `hdiutil`、代码签名等工具，Windows 无法生成可用的 dmg）。

## 一、准备工作

在 Mac 上安装依赖（首次）：

```bash
# 1. 安装 Node.js（建议 18 或 20+，https://nodejs.org）
# 2. 进入项目目录
cd zotero-lit-tool

# 3. 安装依赖（会自动下载对应 mac 平台的 electron）
npm install
```

> 注意：如果在 Windows 上先 `npm install` 过，`node_modules` 里是 Windows 版的 electron。在 Mac 上需要重新 `npm install` 拉取 mac 版 electron。

## 二、先本地试运行（可选）

```bash
# 直接跑后端（浏览器访问 http://127.0.0.1:3000）
npm run dev

# 或跑 Electron 桌面版
npm run electron
```

## 三、打包 dmg 安装包

```bash
# Apple Silicon（M1/M2/M3，arm64）—— 推荐
npm run dist:mac:arm64

# 或者同时打 arm64 + x64 通用版
npm run dist:mac
```

打包产物在 `dist/` 目录下：

```
dist/一站式科研终端-1.0.0-macOS-arm64.dmg
```

## 四、关于代码签名（重要）

**未签名的 dmg 在别人电脑上会被 macOS Gatekeeper 拦截**，提示"无法打开，因为无法验证开发者"。有两种处理方式：

### 方式 1：让使用者绕过 Gatekeeper（自己用 / 内部分发）

对方首次打开时，右键点击 App →「打开」，或执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/一站式科研终端.app
```

### 方式 2：正式签名（对外分发）

需要 Apple Developer 账号（$99/年），在 `package.json` 的 `build.mac` 里补充：

```json
"mac": {
  "icon": "build/icon.icns",
  "target": [{ "target": "dmg", "arch": ["arm64"] }],
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "identity": "Developer ID Application: 你的名字 (TEAMID)"
}
```

然后打包时自动签名；再配合 Apple 公证（notarization）即可正常分发。

## 五、图标说明

- `build/icon.png`：1024×1024，electron-builder 生成各平台图标的通用源图
- `build/icon.icns`：macOS 专用图标（含 16~1024 全尺寸）
- `build/icon.ico`：Windows 专用图标（多尺寸：16/24/32/48/64/128/256）
- `public/favicon.png`：浏览器标签页 / 侧边栏 logo（64×64）
- `electron/icon.png`：运行时窗口与任务栏图标（256×256）

换了图标后，用一条命令重新生成上面**全部**产物：

```bash
python build/make-icons.py                  # 用默认设计稿
python build/make-icons.py "D:\path\to.png" # 指定设计稿
# 需要 pip install pillow
```

脚本会自动裁掉设计稿四周的大片白底、补成正方形再缩放，
所以直接丢一张「带留白的设计稿」进去即可，不必先手工裁剪。

## 六、技术栈 / 架构速览

| 项 | 说明 |
|---|---|
| 桌面框架 | Electron 33 |
| 后端 | Node.js + Express（内嵌，随 Electron 启动） |
| 打包 | electron-builder（win: NSIS / mac: dmg） |
| 前端 | 原生 HTML/CSS/JS（无框架） |
| PDF 解析 | unpdf |
| AI 提取 | 硅基流动 DeepSeek（用户自填 Key） |
| 期刊等级 | easyScholar Open API（用户自填 SecretKey） |
