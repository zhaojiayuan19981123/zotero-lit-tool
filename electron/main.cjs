// electron/main.cjs —— Electron 主进程：启动内嵌 Express 后端 + 桌面窗口
const { app, BrowserWindow, shell, Notification, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

// Windows 上桌面通知必须设置 AppUserModelID，否则系统不会显示气泡通知。
// 需与 electron-builder 配置里的 appId 保持一致。
if (process.platform === 'win32') {
  app.setAppUserModelId('com.research.sciterminal');
}

// ★ 固定 userData 目录，避免「重装/升级后数据消失」再次发生。
// Electron 默认把 userData 放在 %APPDATA%\<package.json 的 name>，而安装包身份用的是
// build.appId。两者一旦不一致（改过 name、换过打包方式、从开发版切到安装版），
// 默认目录就会变，用户数据看起来就「凭空消失」——这正是之前踩过的坑。
// 这里显式钉死一个稳定的目录名，保证任何版本升级都读写同一处。
// 必须在 app.whenReady() 之前调用才生效。
const USERDATA_MARKER = '.sciterminal-home'; // 标记文件：记录「这个目录就是家」
function resolveUserDataRoot() {
  const appData = app.getPath('appData'); // Windows: %APPDATA%
  const stableRoot = path.join(appData, 'SciTerminal');
  const legacyRoot = path.join(appData, 'zotero-lit-tool');
  const hasData = (d) => {
    try { return fs.existsSync(path.join(d, 'data', 'literature.json')); } catch (_) { return false; }
  };
  // 1) 已经认过门的目录优先（标记文件 + 有数据），保证认路稳定、绝不来回横跳
  for (const root of [stableRoot, legacyRoot]) {
    try {
      if (fs.existsSync(path.join(root, USERDATA_MARKER)) && hasData(root)) return root;
    } catch (_) { /* ignore */ }
  }
  // 2) 老目录有真实数据 -> 继续沿用（老用户升级不丢数据）
  if (hasData(legacyRoot) && !hasData(stableRoot)) return legacyRoot;
  // 3) 其余情况用新的稳定目录
  return stableRoot;
}
try {
  app.setPath('userData', resolveUserDataRoot());
} catch (e) {
  console.error('设置数据目录失败，将使用默认位置：', e.message);
}

let mainWindow = null;
let backendPort = null;
const updateSupported = app.isPackaged && process.platform === 'win32';

// 更新由主进程负责，页面只能通过本地 API 读取状态和发起明确动作。
// 浏览器开发模式不具备安装权限，也不会连接 GitHub 检查更新。
const updateState = {
  supported: false,
  currentVersion: app.getVersion(),
  phase: 'idle',
  availableVersion: '',
  releaseName: '',
  releaseNotes: '',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: '',
};
let updaterReady = false;

function normalizeReleaseNotes(notes) {
  if (Array.isArray(notes)) {
    return notes.map((item) => item?.note || item?.version || '').filter(Boolean).join('\n\n');
  }
  return typeof notes === 'string' ? notes : '';
}

function updaterSnapshot() {
  return { ...updateState };
}

function setupUpdater() {
  if (updaterReady) return;
  updaterReady = true;
  updateState.supported = updateSupported;
  if (!updateSupported) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => {
    Object.assign(updateState, { phase: 'checking', error: '', percent: 0 });
  });
  autoUpdater.on('update-available', (info) => {
    Object.assign(updateState, {
      phase: 'available',
      availableVersion: info?.version || '',
      releaseName: info?.releaseName || '',
      releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
      error: '',
    });
  });
  autoUpdater.on('update-not-available', () => {
    Object.assign(updateState, {
      phase: 'not-available', availableVersion: '', releaseName: '', releaseNotes: '', error: '',
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    Object.assign(updateState, {
      phase: 'downloading',
      percent: Number(progress?.percent || 0),
      transferred: Number(progress?.transferred || 0),
      total: Number(progress?.total || 0),
      bytesPerSecond: Number(progress?.bytesPerSecond || 0),
      error: '',
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    Object.assign(updateState, {
      phase: 'downloaded',
      availableVersion: info?.version || updateState.availableVersion,
      percent: 100,
      error: '',
    });
  });
  autoUpdater.on('error', (error) => {
    Object.assign(updateState, {
      phase: 'error',
      error: error?.message || '更新服务发生未知错误',
    });
  });
}

const updateService = {
  getStatus() {
    return updaterSnapshot();
  },
  async check() {
    if (!updateSupported) throw new Error('自动更新仅在安装后的 Windows 桌面版中可用');
    if (['checking', 'downloading'].includes(updateState.phase)) return updaterSnapshot();
    Object.assign(updateState, { phase: 'checking', error: '', percent: 0 });
    await autoUpdater.checkForUpdates();
    return updaterSnapshot();
  },
  async download() {
    if (!updateSupported) throw new Error('自动更新仅在安装后的 Windows 桌面版中可用');
    if (updateState.phase === 'downloaded') return updaterSnapshot();
    if (updateState.phase !== 'available') throw new Error('当前没有可下载的新版本');
    Object.assign(updateState, { phase: 'downloading', error: '', percent: 0 });
    await autoUpdater.downloadUpdate();
    return updaterSnapshot();
  },
  install() {
    if (!updateSupported) throw new Error('自动更新仅在安装后的 Windows 桌面版中可用');
    if (updateState.phase !== 'downloaded') throw new Error('更新尚未下载完成');
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 500);
    return updaterSnapshot();
  },
};

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

// 后端成功启动后写下「家目录」标记。之后无论 package.json 的 name 或 appId 怎么变，
// 启动时都会优先认这个打过标记的目录，用户的邮箱/任务/待办/设置不会再丢。
function markHome() {
  try {
    const root = app.getPath('userData');
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, USERDATA_MARKER);
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, JSON.stringify({ markedAt: new Date().toISOString(), app: '一站式科研终端' }, null, 2), 'utf-8');
    }
  } catch (e) { console.error('写入数据目录标记失败：', e.message); }
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

// 数据目录安全校验：数据绝对不能落在「安装目录」内部（NSIS 覆盖安装会整目录替换，
// 导致用户数据被清空）。若用户误将数据目录设到安装目录下，自动回退到默认的 userData。
function isInsideInstallDir(dir) {
  try {
    const installDir = path.resolve(path.dirname(app.getPath('exe')));
    const target = path.resolve(dir);
    const rel = path.relative(installDir, target);
    // rel 不以 .. 开头且非绝对路径 => target 在 installDir 内
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch (_) { return false; }
}

// 自救：若上次把数据目录设到了安装目录内（老版本允许这么做，会导致覆盖安装丢数据），
// 启动时把里面还能读到的数据搬到默认目录，再清掉这个危险配置。
// 返回抢救成功的数据目录，无需要抢救则返回 null。
function rescueDataFromInstallDir(defaultDataDir) {
  try {
    const installDir = path.resolve(path.dirname(app.getPath('exe')));
    if (!fs.existsSync(installDir)) return null;
    const names = ['literature.json', 'settings.json', 'mail.json', 'tasks.json',
      'projects.json', 'notes.json', 'profile.json', 'papers.json', 'chat.json', 'conversations.json', 'ideas.json',
      'markdown-notes.json', 'calendar.json'];
    const found = names.filter((n) => fs.existsSync(path.join(installDir, n)));
    if (!found.length) return null;

    fs.mkdirSync(defaultDataDir, { recursive: true });
    let saved = 0;
    for (const n of found) {
      const dst = path.join(defaultDataDir, n);
      try {
        // 默认目录已有同名文件时不覆盖（避免用安装目录里的旧/残缺数据盖掉好数据）
        if (fs.existsSync(dst)) continue;
        fs.copyFileSync(path.join(installDir, n), dst);
        saved++;
      } catch (_) { /* 单个失败不影响其他 */ }
    }
    // 附件也一并抢救
    try {
      const upOld = path.join(installDir, 'uploads');
      if (fs.existsSync(upOld)) {
        const upNew = path.join(defaultDataDir, 'uploads');
        fs.mkdirSync(upNew, { recursive: true });
        for (const n of fs.readdirSync(upOld)) {
          const s = path.join(upOld, n);
          const d = path.join(upNew, n);
          if (fs.statSync(s).isFile() && !fs.existsSync(d)) fs.copyFileSync(s, d);
        }
      }
    } catch (_) { /* ignore */ }

    console.warn(`[数据救援] 检测到数据曾被存放在安装目录内（覆盖安装会清空），已抢救 ${saved} 个文件到：${defaultDataDir}`);
    return saved ? defaultDataDir : null;
  } catch (e) {
    console.error('[数据救援] 失败（忽略）：', e.message);
    return null;
  }
}

// 启动前自检：确认数据目录存在且关键文件可读，必要时给出明确日志（不阻塞启动）
function verifyDataDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lit = path.join(dir, 'literature.json');
    if (fs.existsSync(lit)) {
      const raw = fs.readFileSync(lit, 'utf-8');
      JSON.parse(raw); // 能解析说明文件完好
      const n = (JSON.parse(raw).items || []).length;
      console.log(`[数据] 数据目录：${dir}（文献 ${n} 条）`);
    } else {
      console.log(`[数据] 数据目录：${dir}（尚未初始化）`);
    }
    const bk = path.join(dir, 'backups');
    if (fs.existsSync(bk)) {
      const n = fs.readdirSync(bk, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
      console.log(`[数据] 已有 ${n} 份自动备份`);
    }
  } catch (e) {
    console.error('[数据] 数据目录自检失败：', e.message);
  }
}

// 动态加载 ESM 后端（server.js），启动 Express，返回端口
async function startBackend() {
  const serverEntry = path.join(__dirname, '..', 'server.js');
  const { startServer } = await import(pathToFileURL(serverEntry).href);

  const userData = app.getPath('userData');
  const defaultDataDir = resolveDefaultDataDir(userData);
  migrateLegacyInstallData(defaultDataDir);
  // 兜底自救：老版本允许把数据目录设到安装目录里，这里把尚存的数据搬回来
  rescueDataFromInstallDir(defaultDataDir);
  const cfg = readAppConfig();

  // 上次设置过自定义数据目录且目录仍存在 → 沿用；否则回退默认目录
  let dataDir = defaultDataDir;
  if (cfg.dataDir && typeof cfg.dataDir === 'string') {
    try {
      if (fs.existsSync(cfg.dataDir) && path.resolve(cfg.dataDir) !== path.resolve(defaultDataDir)) {
        if (isInsideInstallDir(cfg.dataDir)) {
          console.warn('[数据] 自定义数据目录位于安装目录内，覆盖安装会清空数据，已回退到用户数据目录');
          writeAppConfig({ dataDir: '' });
        } else {
          dataDir = path.resolve(cfg.dataDir);
        }
      }
    } catch (_) { /* ignore */ }
  }
  verifyDataDir(dataDir);
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  const { port } = await startServer({
    dataDir, uploadDir, port: 0, defaultDataDir,
    defaultUploadDir: path.join(dataDir, 'uploads'),
    installDir: path.dirname(app.getPath('exe')),
    updateService,
    // 设置里切换数据目录成功后，主进程把新目录持久化，下次启动沿用
    onDataDirChange: (dir) => writeAppConfig({ dataDir: dir === defaultDataDir ? '' : dir }),
    // 「打开数据目录」按钮：交给系统文件管理器
    openPath: (dir) => shell.openPath(dir),
    saveTextFile: async ({ filename, data }) => {
      const choice = await dialog.showSaveDialog(mainWindow || undefined, {
        title: '导出 Markdown 笔记', defaultPath: filename,
        filters: [{ name: 'Markdown 文件', extensions: ['md'] }, { name: '所有文件', extensions: ['*'] }],
      });
      if (choice.canceled || !choice.filePath) return { canceled: true };
      fs.writeFileSync(choice.filePath, String(data || ''), 'utf8');
      return { canceled: false, path: choice.filePath };
    },
    exportPdf: async ({ filename, html }) => {
      const choice = await dialog.showSaveDialog(mainWindow || undefined, {
        title: '导出 PDF', defaultPath: filename,
        filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
      });
      if (choice.canceled || !choice.filePath) return { canceled: true };
      const tempPath = path.join(app.getPath('temp'), `sciterminal-note-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
      const baseTag = `<base href="http://127.0.0.1:${backendPort}/">`;
      const printableHtml = String(html || '').replace('<head>', `<head>${baseTag}`);
      fs.writeFileSync(tempPath, printableHtml, 'utf8');
      const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
      try {
        await printWindow.loadFile(tempPath);
        await printWindow.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
        const pdf = await printWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
        fs.writeFileSync(choice.filePath, pdf);
        return { canceled: false, path: choice.filePath };
      } finally {
        if (!printWindow.isDestroyed()) printWindow.destroy();
        try { fs.unlinkSync(tempPath); } catch (_) { /* ignore */ }
      }
    },
  });
  markHome();
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
    backgroundColor: '#f4f6f3',
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
  setupUpdater();
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
