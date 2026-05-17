import { getSyncSettings, saveSyncSettings, getSettings } from '../lib/storage.js';
import { applyTheme, watchSystemTheme } from '../lib/theme.js';
import { authorize, revokeAuth, resetFolderCache, isConnected } from '../lib/drive.js';

async function init() {
  const [appSettings, syncSettings] = await Promise.all([getSettings(), getSyncSettings()]);

  document.documentElement.style.setProperty('--font-size', `${appSettings.fontSize}px`);
  applyTheme(appSettings.theme);
  watchSystemTheme(appSettings.theme, (resolved) => {
    document.documentElement.setAttribute('data-theme', resolved);
  });

  const deviceNameInput = document.getElementById('device-name') as HTMLInputElement;
  const deviceNameHint = document.getElementById('device-name-hint')!;
  const deviceNameWarning = document.getElementById('device-name-warning')!;
  const authStatusEl = document.getElementById('auth-status')!;
  const authStatusText = document.getElementById('auth-status-text')!;
  const btnConnect = document.getElementById('btn-connect')!;
  const btnDisconnect = document.getElementById('btn-disconnect')!;

  const connected = await isConnected();
  deviceNameInput.value = syncSettings.deviceName;
  updateAuthStatus(connected);
  updateDeviceNameWarning(connected, syncSettings.deviceName);

  // デバイス名は入力から 800ms 後に自動保存
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  deviceNameInput.addEventListener('input', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const name = deviceNameInput.value.trim();
      await saveSyncSettings({ deviceName: name });
      updateDeviceNameWarning(await isConnected(), name);
      deviceNameHint.textContent = '保存しました ✓';
      setTimeout(() => {
        deviceNameHint.textContent = 'コンフリクト発生時に「どのデバイスで編集したか」として表示されます';
      }, 2000);
    }, 800);
  });

  btnConnect.addEventListener('click', async () => {
    // デバイス名が未入力なら先に入力を促す
    if (!deviceNameInput.value.trim()) {
      alert('デバイス名を入力してから接続してください');
      deviceNameInput.focus();
      return;
    }
    await saveSyncSettings({ deviceName: deviceNameInput.value.trim() });

    btnConnect.textContent = '接続中...';
    btnConnect.setAttribute('disabled', 'true');
    try {
      await authorize();
      updateAuthStatus(true);
      updateDeviceNameWarning(true, deviceNameInput.value.trim());
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

  function updateDeviceNameWarning(conn: boolean, name: string) {
    if (conn && !name) {
      deviceNameWarning.classList.remove('hidden');
      deviceNameInput.focus();
    } else {
      deviceNameWarning.classList.add('hidden');
    }
  }

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
