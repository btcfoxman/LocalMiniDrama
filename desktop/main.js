const { app, BrowserWindow, Menu, Tray, dialog, net, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { repairDuplicateTopLevelMappings, mergeBundledStorage } = require('./configRecovery');
const { createUpdateManager } = require('./updateManager');

// 显式固定 userData 目录，使开发模式与打包 exe 路径完全一致，防止 productName 变更导致路径漂移
const USERDATA_DIR = path.join(app.getPath('appData'), 'overseasdrama-desktop');
app.setPath('userData', USERDATA_DIR);

const MAIN_STARTUP_LOG = path.join(USERDATA_DIR, 'main-startup.log');
function writeMainLog(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if (!fs.existsSync(USERDATA_DIR)) fs.mkdirSync(USERDATA_DIR, { recursive: true });
    fs.appendFileSync(MAIN_STARTUP_LOG, line);
  } catch (_) {}
}

process.on('uncaughtException', (err) => {
  writeMainLog(`uncaughtException: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? reason.stack : String(reason);
  writeMainLog(`unhandledRejection: ${text}`);
});

writeMainLog(`main.js loaded packaged=${app.isPackaged} exec=${process.execPath}`);

// 兼容迁移：若旧数据目录有数据而新路径为空，自动迁移
;(function migrateOldUserData() {
  const legacyPaths = [
    path.join(app.getPath('appData'), 'localminidrama-desktop'),
    path.join(app.getPath('appData'), 'LocalMiniDrama'),
  ];
  const oldPath = legacyPaths.find((legacyPath) => fs.existsSync(legacyPath));
  if (oldPath && !fs.existsSync(USERDATA_DIR)) {
    try {
      fs.renameSync(oldPath, USERDATA_DIR);
    } catch (e) {
      // rename 跨驱动器时会失败，此时静默忽略，用户数据仍可手动迁移
    }
  }
})();

const BACKEND_APP_PATH = path.join(__dirname, 'backend-app');
const BACKEND_NODE_PATH = path.join(__dirname, '..', 'backend-node');
const DEFAULT_PORT = 5679;
// Client-facing app-market update service. CI's ORCHESTRATION_API_URL is only
// used to publish release metadata and may point to a different/internal API.
const DEFAULT_UPDATE_SERVICE_BASE_URL = 'https://aiid.qzz.io';

let serverInstance = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let updateManager = null;
let updateUnavailableReason = '更新服务尚未初始化，请稍后重试';
let desktopOrigin = '';

/** 开发模式用 backend-node（改代码即生效）；打包后用 backend-app */
function getBackendModulePath() {
  if (app.isPackaged) return BACKEND_APP_PATH;
  // Electron 开发模式必须用 backend-app：require 会向上解析到 desktop/node_modules，
  // 其中 better-sqlite3 已由 postinstall 的 electron-builder install-app-deps 对准当前 Electron ABI。
  // 若直接用 backend-node，则会加载 backend-node/node_modules（多为本机 Node 编的 ABI，必炸）。
  if (process.versions.electron && fs.existsSync(path.join(BACKEND_APP_PATH, 'src', 'app.js'))) {
    return BACKEND_APP_PATH;
  }
  return fs.existsSync(BACKEND_NODE_PATH) ? BACKEND_NODE_PATH : BACKEND_APP_PATH;
}

function getBackendCwd() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'backend');
  }
  return getBackendModulePath();
}

let desktopPackageCache = null;
function getDesktopPackage() {
  if (desktopPackageCache) return desktopPackageCache;
  try {
    desktopPackageCache = require('./package.json');
  } catch (_) {
    desktopPackageCache = {};
  }
  return desktopPackageCache;
}

function shouldSyncBundledStorage(userStorage, bundledStorage) {
  if (!bundledStorage) return false;
  if (!userStorage) return true;
  if (userStorage.user_customized === true) return false;
  if (userStorage.user_customized === false) return true;

  const text = [
    userStorage.endpoint,
    userStorage.base_url,
    userStorage.public_base_url,
  ].filter(Boolean).join(' ');
  return /192\.168\.3\.6|s3-3-6\.aiid\.edu\.kg/i.test(text);
}

function ensureBackendCwd(backendCwd) {
  if (!fs.existsSync(backendCwd)) {
    fs.mkdirSync(backendCwd, { recursive: true });
  }
  const configsDir = path.join(backendCwd, 'configs');
  const dataDir = path.join(backendCwd, 'data');
  const logsDir = path.join(backendCwd, 'logs');
  const configPath = path.join(configsDir, 'config.yaml');

  if (!fs.existsSync(configsDir)) fs.mkdirSync(configsDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  // 首次安装时，从打包内置的 config.yaml 复制到用户数据目录
  const bundledConfig = path.join(getBackendModulePath(), 'configs', 'config.yaml');
  if (!fs.existsSync(configPath) && fs.existsSync(bundledConfig)) {
    fs.copyFileSync(bundledConfig, configPath);
  }

  // 每次启动时，将内置 config.yaml 中的 vendor_lock 节强制同步到用户 config.yaml，
  // 确保打包时配置的锁定策略对所有用户生效，不受首次安装后遗留旧配置影响。
  // Storage defaults are synced for first installs and old packaged 3.6
  // defaults. Once a user saves a custom target in the app, keep it across
  // future upgrades.
  if (fs.existsSync(bundledConfig) && fs.existsSync(configPath)) {
    try {
      const yaml = require('js-yaml');
      const userConfigRaw = fs.readFileSync(configPath, 'utf8');
      const repaired = repairDuplicateTopLevelMappings(userConfigRaw);
      if (repaired.repairedKeys.length) {
        const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${configPath}.pre-repair-${safeTimestamp}.bak`;
        fs.copyFileSync(configPath, backupPath);
        fs.writeFileSync(configPath, repaired.text, 'utf8');
        writeMainLog(
          `[config] Repaired duplicate YAML sections: ${repaired.repairedKeys.join(', ')}; backup=${backupPath}`
        );
      }
      const bundledRaw = fs.readFileSync(bundledConfig, 'utf8');
      const repairedBundled = repairDuplicateTopLevelMappings(bundledRaw);
      const userCfg = yaml.load(repaired.text) || {};
      const bundledCfg = yaml.load(repairedBundled.text) || {};
      let changed = false;
      if (bundledCfg.vendor_lock !== undefined) {
        userCfg.vendor_lock = bundledCfg.vendor_lock;
        changed = true;
      }
      if (shouldSyncBundledStorage(userCfg.storage, bundledCfg.storage)) {
        userCfg.storage = mergeBundledStorage(userCfg.storage, bundledCfg.storage);
        changed = true;
      }
      // 视频任务有效期是客户端恢复协议的一部分，升级时同步新默认值，
      // 避免旧安装仍使用早期 30 分钟配置。保留 video 下的其他用户配置。
      const bundledVideoTimeout = bundledCfg.video?.generation_timeout_minutes;
      if (
        bundledVideoTimeout !== undefined
        && userCfg.video?.generation_timeout_minutes !== bundledVideoTimeout
      ) {
        userCfg.video = {
          ...(userCfg.video || {}),
          generation_timeout_minutes: bundledVideoTimeout,
        };
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(configPath, yaml.dump(userCfg, { lineWidth: -1 }), 'utf8');
      }
    } catch (e) {
      console.warn('[config] Failed to sync bundled config sections:', e.message);
      writeMainLog(`[config] Failed to repair/sync config: ${e.stack || e.message}`);
    }
  }
}

/**
 * 首次启动时，将打包内置的 ffmpeg 自动复制到 userData/backend/tools/ffmpeg/。
 * 来源：process.resourcesPath/ffmpeg/（由 electron-builder extraResources 写入）。
 * 已存在则跳过，不会重复覆盖，也不影响用户手动替换版本。
 */
function ensureFfmpeg(backendCwd) {
  if (!app.isPackaged) return;
  const isWin = process.platform === 'win32';
  const ffmpegName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const ffprobeName = isWin ? 'ffprobe.exe' : 'ffprobe';

  const destDir = path.join(backendCwd, 'tools', 'ffmpeg');
  const destFfmpeg = path.join(destDir, ffmpegName);

  // 已存在则跳过（支持用户手动替换）
  if (fs.existsSync(destFfmpeg)) {
    console.log('[ffmpeg] Already exists at', destFfmpeg);
    return;
  }

  const srcDir = path.join(process.resourcesPath, 'ffmpeg');
  const srcFfmpeg = path.join(srcDir, ffmpegName);
  if (!fs.existsSync(srcFfmpeg)) {
    console.warn(
      '[ffmpeg] Bundled ffmpeg not found, skipping auto-extract. Expected:',
      srcFfmpeg,
      '(打包前请将 ffmpeg.exe 放入 backend-node/tools/ffmpeg，并确保 package.json 的 extraResources 包含该目录)'
    );
    return;
  }

  try {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcFfmpeg, destFfmpeg);
    if (!isWin) fs.chmodSync(destFfmpeg, 0o755);

    const srcFfprobe = path.join(srcDir, ffprobeName);
    if (fs.existsSync(srcFfprobe)) {
      const destFfprobe = path.join(destDir, ffprobeName);
      fs.copyFileSync(srcFfprobe, destFfprobe);
      if (!isWin) fs.chmodSync(destFfprobe, 0o755);
    }
    console.log('[ffmpeg] Auto-extracted to', destDir);
  } catch (e) {
    console.warn('[ffmpeg] Auto-extract failed:', e.message);
  }
}

function getWebDistPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'frontweb', 'dist');
  }
  return path.join(__dirname, '..', 'frontweb', 'dist');
}

function appWindowTitle(pageTitle = '') {
  const version = app.getVersion();
  const baseTitle = String(pageTitle || '').replace(/\s*-\s*OverseasDrama\s*$/i, '').trim();
  return baseTitle ? `${baseTitle} - OverseasDrama v${version}` : `OverseasDrama v${version}`;
}

function getWindowIconPath() {
  return path.join(__dirname, 'assets', 'icons', 'icon.png');
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function ensureTray() {
  if (tray) return tray;
  tray = new Tray(getWindowIconPath());
  tray.setToolTip('OverseasDrama');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: '检查更新', click: () => { showMainWindow(); checkUpdatesManually(); } },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  return tray;
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function boolConfig(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function getUpdateConfig() {
  const pkg = getDesktopPackage();
  const appKey = String(
    process.env.OVERSEASDRAMA_UPDATE_APP_KEY
      || process.env.APP_MARKET_APP_KEY
      || pkg.updateAppKey
      || 'overseas-drama-desktop'
  ).trim();
  const enabled = boolConfig(
    process.env.OVERSEASDRAMA_UPDATE_ENABLED,
    pkg.updateEnabled !== false
  );
  const serviceBaseUrl = trimTrailingSlash(
    process.env.OVERSEASDRAMA_UPDATE_SERVICE_URL
      || process.env.APP_MARKET_UPDATE_BASE_URL
      || DEFAULT_UPDATE_SERVICE_BASE_URL
  );
  const feedUrl = trimTrailingSlash(
    process.env.OVERSEASDRAMA_UPDATE_FEED_URL
      || pkg.updateFeedUrl
      || (serviceBaseUrl
        ? `${serviceBaseUrl}/api/v1/app-market/${encodeURIComponent(appKey)}/electron/update/${process.platform}/${process.arch}`
        : '')
  );
  const channel = String(process.env.OVERSEASDRAMA_UPDATE_CHANNEL || pkg.updateChannel || 'stable').trim() || 'stable';
  const latestJsonUrl = serviceBaseUrl
    ? `${serviceBaseUrl}/api/v1/app-market/${encodeURIComponent(appKey)}/latest?platform=${encodeURIComponent(process.platform)}&arch=${encodeURIComponent(process.arch)}&channel=${encodeURIComponent(channel)}&current_version=${encodeURIComponent(app.getVersion())}`
    : '';

  return { appKey, enabled, serviceBaseUrl, feedUrl, latestJsonUrl, channel };
}

async function fetchUpdatePolicy(config) {
  const res = await net.fetch(config.latestJsonUrl, {
    headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('读取更新策略失败：HTTP ' + res.status);
  const latest = (await res.json())?.data?.latest;
  if (!latest) throw new Error('更新服务未返回有效的版本策略');
  return {
    version: latest.version || '',
    forceUpdate: latest.force_update === true || latest.forceUpdate === true,
    minSupportedVersion: latest.min_supported_version || latest.minSupportedVersion || '',
    releaseNotes: latest.release_notes || latest.releaseNotes || '',
  };
}

function showUpdateDialog(options) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

async function checkUpdatesManually() {
  if (updateManager) return updateManager.check(true);
  await showUpdateDialog({ type: 'info', title: '检查更新', message: '暂时无法检查更新', detail: updateUnavailableReason, buttons: ['确定'] });
  return { status: 'unavailable', message: updateUnavailableReason };
}

function setupAutoUpdater() {
  const config = getUpdateConfig();
  if (!config.enabled) updateUnavailableReason = '当前客户端配置已关闭更新服务';
  else if (!app.isPackaged && process.env.OVERSEASDRAMA_FORCE_UPDATE_CHECK !== '1') updateUnavailableReason = '开发模式不安装客户端更新，请使用正式安装包';
  else if (!config.feedUrl || !config.latestJsonUrl) updateUnavailableReason = '客户端尚未配置更新服务地址';
  else if (app.isPackaged && (!/^https:\/\//i.test(config.feedUrl) || !/^https:\/\//i.test(config.latestJsonUrl))) updateUnavailableReason = '更新服务必须使用 HTTPS 地址';
  else {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.setFeedURL({ provider: 'generic', url: config.feedUrl });
      updateManager = createUpdateManager({
        updater: autoUpdater, dialog: { showMessageBox: showUpdateDialog },
        currentVersion: app.getVersion(), loadPolicy: () => fetchUpdatePolicy(config),
        log: writeMainLog, onQuit: quitApp, onInstall: () => { isQuitting = true; },
      });
      setTimeout(() => updateManager.check(false), 15000);
      return;
    } catch (error) { updateUnavailableReason = '更新模块初始化失败：' + error.message; }
  }
  writeMainLog(updateUnavailableReason);
}

function registerDesktopIpc(port) {
  desktopOrigin = 'http://127.0.0.1:' + port;
  function assertTrusted(event) {
    let trusted = false;
    try {
      trusted = mainWindow && event.sender === mainWindow.webContents
        && event.senderFrame === event.sender.mainFrame
        && new URL(event.senderFrame.url).origin === desktopOrigin;
    } catch (_) {}
    if (!trusted) throw new Error('不允许从外部页面调用客户端功能');
  }
  ipcMain.handle('desktop:version', event => { assertTrusted(event); return app.getVersion(); });
  ipcMain.handle('desktop:check-updates', event => { assertTrusted(event); return checkUpdatesManually(); });
}

/**
 * 探测端口是否空闲：优先使用 preferredPort，被占用时让 OS 分配一个随机空闲端口。
 * 返回最终可用的端口号。
 */
function findFreePort(preferredPort) {
  const net = require('net');
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      // 首选端口被占，让 OS 随机分配
      const fallback = net.createServer();
      fallback.listen(0, '127.0.0.1', () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferredPort, '127.0.0.1', () => {
      probe.close(() => resolve(preferredPort));
    });
  });
}

function createWindow(port) {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: appWindowTitle(),
    icon: getWindowIconPath(),
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    show: false,
  });
  mainWindow = win;
  ensureTray();
  win.once('ready-to-show', () => {
    win.show();
    writeMainLog('window ready-to-show');
  });
  // 若页面长期不触发 ready-to-show，避免用户误以为“点了没反应”
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
      writeMainLog('window shown (fallback timeout, check page load)');
    }
  }, 8000);
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    writeMainLog(`did-fail-load code=${code} desc=${desc} url=${url}`);
  });
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(appWindowTitle(title));
  });
  writeMainLog(`createWindow loadURL http://127.0.0.1:${port}`);
  win.loadURL(`http://127.0.0.1:${port}`);
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
    writeMainLog('window hidden to tray');
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  if (process.env.OVERSEASDRAMA_DEVTOOLS === '1') {
    win.webContents.openDevTools();
  }
}

/** 后端始终在主进程内运行（打包用子进程会重复启动 exe 导致大量进程，故取消） */
async function startBackend() {
  const backendCwd = getBackendCwd();
  ensureBackendCwd(backendCwd);
  ensureFfmpeg(backendCwd);
  process.env.WEB_DIST_PATH = getWebDistPath();
  if (app.isPackaged) {
    process.env.LOG_FILE = path.join(backendCwd, 'logs', 'app.log');
    process.env.EXAMPLE_DRAMA_PATH = path.join(process.resourcesPath, 'example_drama');
  } else {
    process.env.EXAMPLE_DRAMA_PATH = path.join(__dirname, '..', 'example_drama');
  }
  process.chdir(backendCwd);

  const backendModulePath = getBackendModulePath();
  const { setMediaDownloadFetch } = require(path.join(backendModulePath, 'src', 'services', 'mediaDownloadService.js'));
  setMediaDownloadFetch((url, options) => net.fetch(url, options));
  try {
    require(path.join(backendModulePath, 'src', 'db', 'migrate.js'));
  } catch (err) {
    console.warn('Migration warning:', err.message);
  }

  const { createApp } = require(path.join(backendModulePath, 'src', 'app.js'));
  const { createServer } = require('http');
  const { app: expressApp, config } = createApp();
  const preferredPort = config.server?.port || DEFAULT_PORT;

  // 自动探测空闲端口：优先默认端口，被占时由 OS 分配，支持多实例同时运行
  const port = await findFreePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} in use, using ${port}`);
  }

  return new Promise((resolve, reject) => {
    const server = createServer(expressApp);
    serverInstance = server;
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log('Backend listening on', port);
      resolve(port);
    });
  });
}

app.whenReady().then(async () => {
  writeMainLog('app.whenReady');
  let port;
  try {
    port = await startBackend();
    writeMainLog(`startBackend ok port=${port}`);
  } catch (err) {
    const stack = err && err.stack ? err.stack : String(err);
    writeMainLog(`Failed to start backend\n${stack}`);
    console.error('Failed to start backend', err);
    const { dialog } = require('electron');
    dialog.showErrorBox(
      '本地短剧助手启动失败',
      `后端服务未能启动，请查看日志：\n${MAIN_STARTUP_LOG}\n\n${stack}`
    );
    app.quit();
    return;
  }
  // startBackend 的 Promise 在 listen 回调中 resolve，服务器此时已就绪，直接建窗口
  registerDesktopIpc(port);
  setupAutoUpdater();
  createWindow(port);
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
});

app.on('activate', showMainWindow);
