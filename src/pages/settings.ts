import { getSyncSettings, saveSyncSettings, getSettings } from '../lib/storage.js';
import { applyTheme, watchSystemTheme } from '../lib/theme.js';
import { authorize, revokeAuth, getRedirectUri, resetFolderCache } from '../lib/drive.js';

async function init() {
  const [appSettings, syncSettings] = await Promise.all([getSettings(), getSyncSettings()]);

  document.documentElement.style.setProperty('--font-size', `${appSettings.fontSize}px`);
  applyTheme(appSettings.theme);
  watchSystemTheme(appSettings.theme, (resolved) => {
    document.documentElement.setAttribute('data-theme', resolved);
  });

  const deviceNameInput = document.getElementById('device-name') as HTMLInputElement;
  const clientIdInput = document.getElementById('client-id') as HTMLInputElement;
  const redirectUriDisplay = document.getElementById('redirect-uri-display')!;
  const authStatusEl = document.getElementById('auth-status')!;
  const authStatusText = document.getElementById('auth-status-text')!;
  const btnConnect = document.getElementById('btn-connect')!;
  const btnDisconnect = document.getElementById('btn-disconnect')!;
  const btnSave = document.getElementById('btn-save')!;
  const setupGuide = document.getElementById('setup-guide')!;
  const setupGuideToggle = document.getElementById('setup-guide-toggle')!;

  // 初期値セット
  deviceNameInput.value = syncSettings.deviceName;
  clientIdInput.value = syncSettings.clientId;
  redirectUriDisplay.textContent = getRedirectUri();

  updateAuthStatus(!!syncSettings.refreshToken);

  // 設定方法ガイドの展開/収納
  setupGuideToggle.addEventListener('click', (e) => {
    e.preventDefault();
    const hidden = setupGuide.classList.toggle('hidden');
    setupGuideToggle.textContent = hidden ? '設定方法を見る ▾' : '設定方法を隠す ▴';
  });

  // 保存
  btnSave.addEventListener('click', async () => {
    const deviceName = deviceNameInput.value.trim();
    const clientId = clientIdInput.value.trim();
    await saveSyncSettings({ deviceName, clientId });
    btnSave.textContent = '保存しました ✓';
    setTimeout(() => { btnSave.textContent = '保存'; }, 2000);
  });

  // 接続
  btnConnect.addEventListener('click', async () => {
    const clientId = clientIdInput.value.trim();
    if (!clientId) {
      alert('Client ID を入力してください');
      return;
    }
    const deviceName = deviceNameInput.value.trim();
    await saveSyncSettings({ deviceName, clientId });

    btnConnect.textContent = '接続中...';
    btnConnect.setAttribute('disabled', 'true');
    try {
      await authorize(clientId);
      updateAuthStatus(true);
    } catch (e) {
      alert(`接続に失敗しました: ${e}`);
    } finally {
      btnConnect.textContent = 'Google アカウントに接続';
      btnConnect.removeAttribute('disabled');
    }
  });

  // 解除
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
