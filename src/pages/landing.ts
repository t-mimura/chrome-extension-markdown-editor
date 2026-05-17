import {
  getAllDocs,
  getDocTitle,
  saveDoc,
  deleteDoc,
  createNewDoc,
  getSettings,
  getSyncSettings,
  migrateFromChromeStorage,
  type Document,
} from '../lib/storage.js';
import { registerTab, getOpenDocs, focusTab } from '../lib/messaging.js';
import { applyTheme, watchSystemTheme } from '../lib/theme.js';
import {
  syncAll, resolveConflict, onSyncStatusChange, getSyncStatus,
  type ConflictItem,
} from '../lib/sync.js';

async function init() {
  await migrateFromChromeStorage();
  const settings = await getSettings();
  document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
  applyTheme(settings.theme);
  watchSystemTheme(settings.theme, (resolved) => {
    document.documentElement.setAttribute('data-theme', resolved);
  });

  await registerTab().catch(() => {});

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_CHANGED') {
      const s = msg.settings;
      document.documentElement.style.setProperty('--font-size', `${s.fontSize}px`);
      applyTheme(s.theme);
    }
    if (msg.type === 'OPEN_DOCS_CHANGED') {
      // 他のタブでドキュメントが開かれた/閉じられた → リストを再描画
      renderDocList().catch(console.error);
    }
  });

  document.getElementById('btn-new')!.addEventListener('click', () => {
    const doc = createNewDoc();
    window.location.href = `editor.html?docId=${doc.id}&new=1`;
  });

  await renderDocList();

  // 同期 UI
  setupSyncUI();

  // 起動時に自動同期（Drive が設定済みの場合のみ）
  const syncSettings = await getSyncSettings();
  if (syncSettings.clientId && syncSettings.refreshToken) {
    runSync();
  }
}

function setupSyncUI() {
  const btnSync = document.getElementById('btn-sync')!;
  const statusEl = document.getElementById('sync-status')!;

  const updateStatus = (status: ReturnType<typeof getSyncStatus>) => {
    statusEl.className = `sync-status sync-${status}`;
    const labels: Record<string, string> = {
      idle: '同期済み',
      syncing: '同期中...',
      error: '同期エラー',
      conflict: '競合あり',
    };
    statusEl.title = labels[status] ?? '';
  };
  updateStatus(getSyncStatus());
  onSyncStatusChange(updateStatus);

  btnSync.addEventListener('click', () => runSync());
}

async function runSync() {
  const result = await syncAll();

  // pull があればリストを更新
  if (result.pulled > 0) {
    await renderDocList();
  }

  // コンフリクトを順番に処理
  for (const conflict of result.conflicts) {
    await showConflictModal(conflict);
  }
}

function showConflictModal(conflict: ConflictItem): Promise<void> {
  return new Promise((resolve) => {
    const modal = document.getElementById('conflict-modal')!;
    const localMeta = document.getElementById('conflict-local-meta')!;
    const remoteMeta = document.getElementById('conflict-remote-meta')!;
    const localPreview = document.getElementById('conflict-local-preview')!;
    const remotePreview = document.getElementById('conflict-remote-preview')!;

    const fmt = (ts: number) => new Date(ts).toLocaleString('ja-JP');
    localMeta.textContent = `${fmt(conflict.local.updatedAt)} · ${conflict.local.charCount}文字`;
    remoteMeta.textContent = `${conflict.remote.deviceName} · ${fmt(conflict.remote.updatedAt)} · ${conflict.remote.charCount}文字`;
    localPreview.textContent = conflict.local.content.slice(0, 300);
    remotePreview.textContent = conflict.remote.content.slice(0, 300);

    modal.classList.remove('hidden');

    const handleChoice = async (choice: 'local' | 'remote') => {
      modal.classList.add('hidden');
      await resolveConflict(conflict, choice);
      await renderDocList();
      resolve();
    };

    modal.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((btn) => {
      btn.onclick = () => handleChoice(btn.dataset.choice as 'local' | 'remote');
    });
  });
}

async function renderDocList() {
  const listEl = document.getElementById('doc-list')!;
  const [docs, openDocs] = await Promise.all([getAllDocs(), getOpenDocs().catch(() => ({}))]);

  if (docs.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <p>まだドキュメントがありません</p>
        <button class="primary" id="btn-new-empty">+ 新規ドキュメントを作成</button>
      </div>
    `;
    document.getElementById('btn-new-empty')?.addEventListener('click', () => {
      const doc = createNewDoc();
      window.location.href = `editor.html?docId=${doc.id}&new=1`;
    });
    return;
  }

  listEl.innerHTML = '';
  for (const doc of docs) {
    const item = buildDocItem(doc, openDocs);
    listEl.appendChild(item);
  }
}

function buildDocItem(doc: Document, openDocs: Record<string, number>): HTMLElement {
  const openTabId = openDocs[doc.id];
  const isOpen = openTabId != null;

  const item = document.createElement('div');
  item.className = 'doc-item';
  item.dataset.docId = doc.id;

  const title = getDocTitle(doc.content);
  const updatedAt = new Date(doc.updatedAt).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const openBadge = isOpen
    ? `<span class="doc-open-badge">他のタブで開いています</span>`
    : '';

  item.innerHTML = `
    <div class="doc-info">
      <input
        type="text"
        class="doc-title-input"
        value="${escapeHtml(title)}"
        data-doc-id="${doc.id}"
        data-original="${escapeHtml(title)}"
        aria-label="ドキュメントタイトル"
      />
      <div class="doc-meta">
        <span>${updatedAt}</span>
        ${openBadge}
      </div>
    </div>
    <div class="doc-actions">
      ${isOpen ? `<button class="btn-focus" data-tab-id="${openTabId}">タブを表示</button>` : ''}
      ${!isOpen ? `<button class="btn-open" data-doc-id="${doc.id}">開く</button>` : ''}
      <button class="btn-delete" data-doc-id="${doc.id}" title="削除">✕</button>
    </div>
  `;

  const titleInput = item.querySelector<HTMLInputElement>('.doc-title-input')!;
  titleInput.addEventListener('change', async (e) => {
    const input = e.currentTarget as HTMLInputElement;
    const newTitle = input.value.trim();
    if (!newTitle) {
      input.value = input.dataset.original ?? '無題';
      return;
    }

    const currentDoc = await import('../lib/storage.js').then((m) => m.getDoc(doc.id));
    if (!currentDoc) return;

    const firstLine = currentDoc.content.split('\n')[0];
    const isHeading = /^#+/.test(firstLine);
    let newContent: string;

    if (isHeading) {
      const headingPrefix = firstLine.match(/^(#+\s*)/)?.[1] ?? '# ';
      const rest = currentDoc.content.split('\n').slice(1).join('\n');
      newContent = `${headingPrefix}${newTitle}\n${rest}`;
    } else if (firstLine === '') {
      newContent = `# ${newTitle}\n${currentDoc.content}`;
    } else {
      const rest = currentDoc.content.split('\n').slice(1).join('\n');
      newContent = `${newTitle}\n${rest}`;
    }

    await saveDoc({ ...currentDoc, content: newContent, updatedAt: Date.now() });
    input.dataset.original = newTitle;
  });

  item.querySelector<HTMLButtonElement>('.btn-open')?.addEventListener('click', () => {
    window.location.href = `editor.html?docId=${doc.id}`;
  });

  item.querySelector<HTMLButtonElement>('.btn-focus')?.addEventListener('click', async () => {
    const tabId = parseInt(item.querySelector<HTMLButtonElement>('.btn-focus')!.dataset.tabId ?? '0', 10);
    await focusTab(tabId).catch(() => {});
  });

  item.querySelector<HTMLButtonElement>('.btn-delete')?.addEventListener('click', async () => {
    if (!confirm(`"${title}" を削除しますか？`)) return;
    await deleteDoc(doc.id);
    item.remove();
    const listEl = document.getElementById('doc-list')!;
    if (listEl.children.length === 0) {
      await renderDocList();
    }
  });

  return item;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init().catch(console.error);
