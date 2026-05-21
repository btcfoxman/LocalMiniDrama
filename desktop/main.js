const { app, BrowserWindow, Menu, Tray, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

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
const DEFAULT_UPDATE_SERVICE_BASE_URL = 'https://download-drama.kuaxixing.com';

let serverInstance = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;

/** 开发模式用 backend-node（改代码即生效）；打包后用 backend-app */
function getBackendModulePath() {
  if (app.isPackaged) return BACKEND_APP_PATH;
  // Electron 开发模式必须用 backend-app：require 会向上解析到 desktop/node_modules，
  // 其中 better-sqlite3 已由 postinstall 的 electron-rebuild 对准当前 Electron ABI。
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
      const userCfg = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
      const bundledCfg = yaml.load(fs.readFileSync(bundledConfig, 'utf8')) || {};
      let changed = false;
      if (bundledCfg.vendor_lock !== undefined) {
        userCfg.vendor_lock = bundledCfg.vendor_lock;
        changed = true;
      }
      if (shouldSyncBundledStorage(userCfg.storage, bundledCfg.storage)) {
        userCfg.storage = { ...bundledCfg.storage, user_customized: false };
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(configPath, yaml.dump(userCfg, { lineWidth: -1 }), 'utf8');
      }
    } catch (e) {
      console.warn('[config] Failed to sync bundled config sections:', e.message);
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

function parseSemver(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease > b.prerelease ? 1 : -1;
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
  if (!config.latestJsonUrl || typeof fetch !== 'function') return null;
  try {
    const res = await fetch(config.latestJsonUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      writeMainLog(`update policy fetch failed status=${res.status}`);
      return null;
    }
    const body = await res.json();
    const latest = body?.data?.latest;
    if (!latest) return null;
    return {
      version: latest.version || '',
      forceUpdate: latest.force_update === true || latest.forceUpdate === true,
      minSupportedVersion: latest.min_supported_version || latest.minSupportedVersion || '',
    };
  } catch (err) {
    writeMainLog(`update policy fetch error: ${err && err.message ? err.message : err}`);
    return null;
  }
}

function isForceUpdate(policy) {
  if (!policy) return false;
  if (policy.forceUpdate) return true;
  if (policy.minSupportedVersion && compareSemver(app.getVersion(), policy.minSupportedVersion) < 0) {
    return true;
  }
  return false;
}

function setupAutoUpdater() {
  const config = getUpdateConfig();
  if (!config.enabled) {
    writeMainLog('autoUpdater disabled by config');
    return;
  }
  if (!app.isPackaged && process.env.OVERSEASDRAMA_FORCE_UPDATE_CHECK !== '1') {
    writeMainLog('autoUpdater skipped in development');
    return;
  }
  if (!config.feedUrl) {
    writeMainLog('autoUpdater skipped: missing update service url');
    return;
  }
  if (app.isPackaged && !/^https:\/\//i.test(config.feedUrl)) {
    writeMainLog(`autoUpdater skipped: feed url must be https in packaged app (${config.feedUrl})`);
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    writeMainLog(`autoUpdater unavailable: ${err && err.message ? err.message : err}`);
    return;
  }

  let updatePolicyPromise = null;
  let updatePolicy = null;
  const loadPolicy = () => {
    if (!updatePolicyPromise) {
      updatePolicyPromise = fetchUpdatePolicy(config).then((policy) => {
        updatePolicy = policy;
        return policy;
      });
    }
    return updatePolicyPromise;
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: config.feedUrl });

  autoUpdater.on('checking-for-update', () => {
    writeMainLog(`autoUpdater checking appKey=${config.appKey} channel=${config.channel} feed=${config.feedUrl}`);
  });
  autoUpdater.on('update-available', async (info) => {
    const policy = await loadPolicy();
    const force = isForceUpdate(policy);
    writeMainLog(`autoUpdater update available version=${info?.version || ''} force=${force}`);
    if (force) {
      dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        title: 'Update required',
        message: 'A required update is being downloaded.',
        detail: `Current version ${app.getVersion()} will be updated to ${info?.version || policy?.version || 'the latest version'}.`,
      }).catch(() => {});
    }
  });
  autoUpdater.on('update-not-available', (info) => {
    writeMainLog(`autoUpdater no update latest=${info?.version || ''}`);
  });
  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent || 0).toFixed(1);
    writeMainLog(`autoUpdater download ${percent}% ${progress?.transferred || 0}/${progress?.total || 0}`);
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const policy = updatePolicy || await loadPolicy();
    const force = isForceUpdate(policy);
    writeMainLog(`autoUpdater update downloaded version=${info?.version || ''} force=${force}`);
    if (force) {
      await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart now'],
        title: 'Update ready',
        message: 'A required update is ready to install.',
        detail: 'The application will restart to complete the update.',
      }).catch(() => null);
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
      return;
    }

    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `OverseasDrama ${info?.version || ''} is ready to install.`,
      detail: 'Restart the application to finish installing the update.',
    }).catch(() => ({ response: 1 }));
    if (result.response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });
  autoUpdater.on('error', (err) => {
    writeMainLog(`autoUpdater error: ${err && err.stack ? err.stack : err}`);
  });

  setTimeout(() => {
    loadPolicy().catch(() => null);
    autoUpdater.checkForUpdates().catch((err) => {
      writeMainLog(`autoUpdater check failed: ${err && err.message ? err.message : err}`);
    });
  }, 15000);
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
    webPreferences: { nodeIntegration: false, contextIsolation: true },
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
    app.quit();
    return;
  }
  // startBackend 的 Promise 在 listen 回调中 resolve，服务器此时已就绪，直接建窗口
  createWindow(port);
  setupAutoUpdater();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
});

app.on('activate', showMainWindow);
