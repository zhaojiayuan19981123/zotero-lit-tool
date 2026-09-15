// electron/main.cjs —— Electron 主进程：启动内嵌 Express 后端 + 桌面窗口
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

let mainWindow = null;
let backendPort = null;

// 单实例锁（避免重复启动多个后端）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// 应用级配置：数据保存目录需要跨启动保留。settings.json 跟随数据目录本身存放，
// 用户切换到自定义目录后，下次启动无法从默认位置的 settings.json 发现它，
// 因此在固定的 userData 下再存一份 app-config.json 作为启动引导配置。
function readAppConfig() {
  const cfgPath = path.join(app.getPath('userData'), 'app-config.json');
  try {
    if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) || {};
  } catch (_) { /* ignore */ }
  return {};
}

function writeAppConfig(patch) {
  const cfgPath = path.join(app.getPath('userData'), 'app-config.json');
  try {
    const next = { ...readAppConfig(), ...patch };
    fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2), 'utf-8');
  } catch (e) { console.error('写入应用配置失败：', e.message); }
}

// 判断目录是否可写（尝试创建并写临时文件）
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test-' + Date.now());
    fs.writeFileSync(probe, 'ok', 'utf-8');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

// 安装版默认数据目录：优先放在安装目录下的 data 子目录（用户可自行选安装位置，
// 数据跟着软件走，便于备份迁移）；若安装目录不可写（如装在 Program Files），
// 则自动回退到系统用户数据目录。
function getInstallDir() {
  try { return path.dirname(app.getPath('exe')); } catch (_) { return null; }
}

function resolveDefaultDataDir(userData) {
  const userDataDir = path.join(userData, 'data');
  const installDir = getInstallDir();
  if (installDir) {
    const installDataDir = path.join(installDir, 'data');
    // 开发环境（electron . / node server.js）安装目录就是项目目录，避免把数据写进源码目录
    const isDev = !app.isPackaged;
    if (!isDev && isWritable(installDir)) {
      return installDataDir;
    }
  }
  return userDataDir;
}

// 动态加载 ESM 后端（server.js），启动 Express，返回端口
async function startBackend() {
  const serverEntry = path.join(__dirname, '..', 'server.js');
  const { startServer } = await import(pathToFileURL(serverEntry).href);

  const userData = app.getPath('userData');
  const defaultDataDir = resolveDefaultDataDir(userData);
  const cfg = readAppConfig();

  // 上次设置过自定义数据目录且目录仍存在 → 沿用；否则回退默认目录
  let dataDir = defaultDataDir;
  if (cfg.dataDir && typeof cfg.dataDir === 'string') {
    try {
      if (fs.existsSync(cfg.dataDir) && path.resolve(cfg.dataDir) !== path.resolve(defaultDataDir)) {
        dataDir = path.resolve(cfg.dataDir);
      }
    } catch (_) { /* ignore */ }
  }
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  const { port } = await startServer({
    dataDir, uploadDir, port: 0, defaultDataDir,
    defaultUploadDir: path.join(dataDir, 'uploads'),
    // 设置里切换数据目录成功后，主进程把新目录持久化，下次启动沿用
    onDataDirChange: (dir) => writeAppConfig({ dataDir: dir === defaultDataDir ? '' : dir }),
  });
  return port;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: '一站式科研终端',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f7f5fa',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`);

  // 外部链接（原 PDF、导出等）交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  try {
    backendPort = await startBackend();
  } catch (e) {
    console.error('后端启动失败：', e);
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
