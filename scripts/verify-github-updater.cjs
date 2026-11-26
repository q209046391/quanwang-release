const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(async () => {
  const profile = app.getPath('userData');
  const marker = path.join(profile, 'upgrade-result.json');
  const version = app.getVersion();
  if (version === '8.4.6') {
    const before = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (before.version !== '8.4.5' || before.savedValue !== 'keep-me') throw new Error('Test data missing after update');
    fs.writeFileSync(marker, JSON.stringify({ version, savedValue: before.savedValue }));
    app.exit(0);
    return;
  }

  const url = process.argv.find(value => value.startsWith('--feed='))?.slice(7);
  if (version !== '8.4.5' || !url || !url.startsWith('https://github.com/q209046391/quanwang-release/releases/download/')) {
    throw new Error('Unexpected test version or feed');
  }
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ version, savedValue: 'keep-me' }));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.setFeedURL({ provider: 'generic', url });
  const update = await autoUpdater.checkForUpdates();
  if (!update?.isUpdateAvailable || update.updateInfo.version !== '8.4.6') throw new Error('Expected upgrade was not found');
  await autoUpdater.downloadUpdate(update.cancellationToken);
  autoUpdater.quitAndInstall(true, true);
}).catch(error => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'upgrade-error.txt'), String(error.message));
  app.exit(1);
});

