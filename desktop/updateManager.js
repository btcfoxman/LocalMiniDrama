function compareVersions(left, right) {
  const parse = value => String(value || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  const a = parse(left), b = parse(right);
  if (!a || !b) throw new Error('更新服务返回了无效版本号');
  for (let i = 1; i <= 3; i++) if (+a[i] !== +b[i]) return +a[i] > +b[i] ? 1 : -1;
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const ap = a[4].split('.'), bp = b[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return +ap[i] > +bp[i] ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}

function updateDetails(current, info, policy) {
  let notes = info.releaseNotes || policy.releaseNotes || '';
  if (Array.isArray(notes)) notes = notes.map(item => item.note || '').join('\n');
  const plain = String(notes).replace(/<[^>]*>/g, '').trim().slice(0, 4000);
  return `当前版本：${current}\n新版本：${info.version}${info.releaseDate ? '\n发布时间：' + info.releaseDate : ''}\n\n更新说明：\n${plain || '暂无更新说明'}`;
}

async function resolveUpdatePolicy(info, loadPolicy) {
  // The public Electron feed already carries the release policy. Reading it
  // from that same checked manifest also avoids races between two endpoints.
  if (typeof info.forceUpdate === 'boolean' || typeof info.force_update === 'boolean') {
    return { version: info.version, forceUpdate: info.forceUpdate === true || info.force_update === true,
      minSupportedVersion: info.minSupportedVersion || info.min_supported_version || '', releaseNotes: info.releaseNotes || '' };
  }
  return loadPolicy(info);
}

function createUpdateManager({ updater, dialog, currentVersion, loadPolicy, log = () => {}, onInstall = () => {}, onQuit = () => {} }) {
  let pending = null;
  let manualRequested = false;
  let downloaded = null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.on('error', error => log('更新失败：' + error.message));
  updater.on('download-progress', progress => log(`更新下载进度：${Number(progress.percent || 0).toFixed(1)}%`));
  updater.on('update-downloaded', info => { downloaded = info; });

  async function install(info, policy, force) {
    const answer = await dialog.showMessageBox({
      type: 'info', title: force ? '必须更新' : '更新已就绪',
      message: force ? '必须更新已下载完成，请重启安装后继续使用。' : `新版本 ${info.version} 已下载完成。`,
      detail: updateDetails(currentVersion, info, policy),
      buttons: force ? ['重启并安装'] : ['重启并安装', '稍后'], defaultId: 0, cancelId: force ? 0 : 1,
    });
    if (force || answer.response === 0) {
      onInstall();
      updater.quitAndInstall(false, true);
      return { status: 'installing', version: info.version, force };
    }
    return { status: 'downloaded', version: info.version, force };
  }

  async function runCheck() {
    const checked = await updater.checkForUpdates();
    const info = checked?.updateInfo;
    if (!info) throw new Error('更新服务暂时无法返回版本信息，请稍后重试');
    if (compareVersions(info.version, currentVersion) <= 0) {
      if (manualRequested) await dialog.showMessageBox({ type: 'info', title: '检查更新', message: '当前已是最新版本', detail: `当前版本：${currentVersion}`, buttons: ['确定'] });
      return { status: 'current', version: currentVersion };
    }
    const policy = await resolveUpdatePolicy(info, loadPolicy);
    if (!policy) throw new Error('无法读取更新策略，请检查网络后重试');
    if (policy.version && compareVersions(policy.version, info.version) !== 0) throw new Error('更新版本与更新策略不一致，请稍后重试');
    const force = policy.forceUpdate === true || !!(policy.minSupportedVersion && compareVersions(currentVersion, policy.minSupportedVersion) < 0);
    if (downloaded && compareVersions(downloaded.version, info.version) === 0) return install(info, policy, force);
    const answer = await dialog.showMessageBox({
      type: force ? 'warning' : 'info', title: force ? '发现必须更新的版本' : '发现新版本',
      message: force ? `当前版本需要更新到 ${info.version} 才能继续使用。` : `发现新版本 ${info.version}`,
      detail: updateDetails(currentVersion, info, policy),
      buttons: force ? ['立即更新', '退出软件'] : ['下载更新', '稍后'], defaultId: 0, cancelId: 1,
    });
    if (answer.response !== 0) {
      if (force) onQuit();
      return { status: force ? 'quitting' : 'deferred', version: info.version, force };
    }
    for (;;) {
      try {
        await updater.downloadUpdate();
        downloaded = info;
        return install(info, policy, force);
      } catch (error) {
        if (!force) throw error;
        const retry = await dialog.showMessageBox({ type: 'error', title: '更新下载失败', message: '必须更新尚未完成', detail: error.message, buttons: ['重试', '退出软件'], defaultId: 0, cancelId: 1 });
        if (retry.response !== 0) { onQuit(); return { status: 'quitting', force: true }; }
      }
    }
  }

  function check(manual = false) {
    manualRequested = manualRequested || manual;
    if (pending) return pending;
    pending = runCheck().catch(async error => {
      log(error.stack || error.message);
      if (manualRequested) await dialog.showMessageBox({ type: 'error', title: '检查更新失败', message: '暂时无法完成更新检查', detail: error.message, buttons: ['确定'] });
      return { status: 'error', message: error.message };
    }).finally(() => { pending = null; manualRequested = false; });
    return pending;
  }
  return { check };
}

module.exports = { createUpdateManager, compareVersions, resolveUpdatePolicy };
