import { getSyncSettings, saveSyncSettings, getSettings } from '../lib/storage.js';
import { applyTheme, watchSystemTheme } from '../lib/theme.js';
import { authorize, revokeAuth, resetFolderCache } from '../lib/drive.js';

async function init() {
  const [appSettings, syncSettings] = await Promise.all([getSettings(), getSyncSettings()]);

  document.documentElement.style.setProperty('--font-size', `${appSettings.fontSize}px`);
  applyTheme(appSettings.theme);
  watchSystemTheme(appSettings.theme, (resolved) => {
    document.documentElement.setAttribute('data-theme', resolved);
  });

  const deviceNameInput = document.getElementById('device-name') as HTMLInputElement;
  const authStatusEl = document.getElementById('auth-status')!;
  const authStatusText = document.getElementById('auth-status-text')!;
  const btnConnect = document.getElementById('btn-connect')!;
  const btnDisconnect = document.getElementById('btn-disconnect')!;
  const btnSave = document.getElementById('btn-save')!;

  deviceNameInput.value = syncSettings.deviceName;
  updateAuthStatus(!!syncSettings.refreshToken);

  btnSave.addEventListener('click', async () => {
    await saveSyncSettings({ deviceName: deviceNameInput.value.trim() });
    btnSave.textContent = '保存しました ✓';
    setTimeout(() => { btnSave.textContent = '保存'; }, 2000);
  });

  btnConnect.addEventListener('click', async () => {
    // デバイス名が未入力なら先に保存を促す
    const deviceName = deviceNameInput.value.trim();
    if (!deviceName) {
      alert('デバイス名を入力してから接続してください');
      deviceNameInput.focus();
      return;
    }
    await saveSyncSettings({ deviceName });

    btnConnect.textContent = '接続中...';
    btnConnect.setAttribute('disabled', 'true');
    try {
      await authorize();
      updateAuthStatus(true);
    } catch (e) {
      alert(`接続に失敗しました:\n${e}`);
    } finally {
      btnConnect.textContent = 'Google アカウントに接続';
      btnConnect.removeAttribute('disabled');
    }
  });

  btnDisconnect.addEventListener('click', async () => {
    if (!confirm('Google Drive との接続を解除しますか？')) return;
    await revokeAuth();
    resetFolderCache();
    updateAuthStatus(false);
  });

  function updateAuthStatus(connected: boolean) {
    if (connected) {
      authStatusEl.className = 'auth-status auth-connected';
      authStatusText.textContent = '接続済み';
      btnConnect.classList.add('hidden');
      btnDisconnect.classList.remove('hidden');
    } else {
      authStatusEl.className = 'auth-status auth-disconnected';
      authStatusText.textContent = '未接続';
      btnConnect.classList.remove('hidden');
      btnDisconnect.classList.add('hidden');
    }
  }
}

init().catch(console.error);
