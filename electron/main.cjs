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

// 默认数据目录：统一放在 Electron 的 userData（系统用户数据目录），
// 与应用安装目录完全分离，覆盖安装/升级都不会清空用户的文献与配置。
// 注：此前版本把数据默认放在「安装目录/data」，NSIS 覆盖安装会整目录替换导致数据丢失，
// 因此这里改为固定使用 userData。用户在设置里仍可手动指定自定义目录。
function resolveDefaultDataDir(userData) {
  return path.join(userData, 'data');
}

// 兼容旧版：若检测到安装目录下存在旧版 data 目录（含 literature.json），
// 且新默认目录尚未初始化，则自动迁移一次，避免老用户升级后数据“凭空消失”。
function migrateLegacyInstallData(defaultDataDir) {
  try {
    const installDir = path.dirname(app.getPath('exe'));
    if (!installDir) return;
    const legacyDir = path.join(installDir, 'data');
    const legacyLit = path.join(legacyDir, 'literature.json');
    const newLit = path.join(defaultDataDir, 'literature.json');
    // 旧目录有数据、新目录还没数据，才迁移
    if (fs.existsSync(legacyLit) && !fs.existsSync(newLit)) {
      fs.mkdirSync(defaultDataDir, { recursive: true });
      for (const name of fs.readdirSync(legacyDir)) {
        const src = path.join(legacyDir, name);
        const dst = path.join(defaultDataDir, name);
        const st = fs.statSync(src);
        if (st.isDirectory()) {
          fs.cpSync(src, dst, { recursive: true });
        } else if (st.isFile()) {
          fs.copyFileSync(src, dst);
        }
      }
      console.log('[迁移] 已将旧版安装目录数据迁移到用户数据目录：', defaultDataDir);
    }
  } catch (e) {
    console.error('[迁移] 旧版数据迁移失败（忽略）：', e.message);
  }
}

// 动态加载 ESM 后端（server.js），启动 Express，返回端口
async function startBackend() {
  const serverEntry = path.join(__dirname, '..', 'server.js');
  const { startServer } = await import(pathToFileURL(serverEntry).href);

  const userData = app.getPath('userData');
  const defaultDataDir = resolveDefaultDataDir(userData);
  migrateLegacyInstallData(defaultDataDir);
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
