import {
  getDocTitle,
  getDoc,
  saveDoc,
  deleteDoc,
  createNewDoc,
  getSettings,
  getSyncSettings,
  migrateFromChromeStorage,
  createFolder,
  renameFolder,
  deleteFolder,
  moveFolder,
  moveDoc,
  getFolderTree,
  type Document,
  type FolderTreeNode,
} from '../lib/storage.js';
import { registerTab, getOpenDocs, focusTab } from '../lib/messaging.js';
import { applyTheme, watchSystemTheme } from '../lib/theme.js';
import {
  syncAll, resolveConflict, onSyncStatusChange, getSyncStatus, scheduleAutoSync,
  type ConflictItem,
} from '../lib/sync.js';
import { isConnected } from '../lib/drive.js';

const DRAG_DOC = 'application/x-md-doc';
const DRAG_FOLDER = 'application/x-md-folder';

const ICON_DRAG_HANDLE =
  `<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true">` +
  `<path d="M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160Zm-240-240q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400Z"/>` +
  `</svg>`;

type Selection =
  | { type: 'folder'; id: string }
  | { type: 'doc'; id: string }
  | null;

let creationFolderId: string | null = null;
let selectedItem: Selection = null;
let draggingDocId: string | null = null;
let draggingFolderId: string | null = null;
/** ハンドルからのドラッグ開始かどうか（行全体 draggable との併用） */
let dragFromHandle = false;
let cachedOpenDocs: Record<string, number> = {};
const folderNames = new Map<string, string>();

const collapsedFolders = new Set<string>(
  JSON.parse(sessionStorage.getItem('collapsedFolders') ?? '[]') as string[],
);

function persistCollapsed() {
  sessionStorage.setItem('collapsedFolders', JSON.stringify([...collapsedFolders]));
}

function selectFolder(folderId: string) {
  selectedItem = { type: 'folder', id: folderId };
  creationFolderId = folderId;
  updateToolbarState();
}

function selectDoc(docId: string) {
  selectedItem = { type: 'doc', id: docId };
  updateToolbarState();
}

function clearSelection() {
  selectedItem = null;
  updateToolbarState();
}

function setCreationRoot() {
  creationFolderId = null;
  selectedItem = null;
  updateToolbarState();
}

function indexFolderNames(nodes: FolderTreeNode[]) {
  for (const node of nodes) {
    folderNames.set(node.folder.id, node.folder.name);
    indexFolderNames(node.children);
  }
}

function updateToolbarState() {
  const label = document.getElementById('creation-target-label')!;
  const btnTarget = document.getElementById('btn-creation-target')!;
  const btnRename = document.getElementById('btn-rename') as HTMLButtonElement;
  const btnDelete = document.getElementById('btn-delete') as HTMLButtonElement;
  const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;

  if (creationFolderId) {
    label.textContent = folderNames.get(creationFolderId) ?? 'フォルダ';
    btnTarget.classList.add('has-target');
  } else {
    label.textContent = 'ルート';
    btnTarget.classList.remove('has-target');
  }

  const hasSelection = selectedItem !== null;
  btnRename.disabled = !hasSelection;
  btnDelete.disabled = !hasSelection;

  if (selectedItem?.type === 'doc') {
    btnOpen.disabled = false;
    const tabId = cachedOpenDocs[selectedItem.id];
    btnOpen.textContent = tabId != null ? 'タブを表示' : '開く';
  } else {
    btnOpen.disabled = true;
    btnOpen.textContent = '開く';
  }
}

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
      renderDocTree().catch(console.error);
    }
  });

  document.getElementById('btn-creation-target')!.addEventListener('click', () => {
    setCreationRoot();
    void renderDocTree();
  });

  document.getElementById('btn-new')!.addEventListener('click', async () => {
    const doc = createNewDoc(creationFolderId);
    await saveDoc(doc);
    window.location.href = `editor.html?docId=${doc.id}&new=1`;
  });

  document.getElementById('btn-new-folder')!.addEventListener('click', async () => {
    try {
      await createFolder('新しいフォルダ', creationFolderId);
      scheduleAutoSync();
      await renderDocTree();
    } catch (e) {
      showToast(String(e));
    }
  });

  document.getElementById('btn-rename')!.addEventListener('click', () => {
    triggerRenameSelected();
  });

  document.getElementById('btn-delete')!.addEventListener('click', async () => {
    await deleteSelected();
  });

  document.getElementById('btn-open')!.addEventListener('click', async () => {
    await openSelectedDoc();
  });

  document.getElementById('doc-list')!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.folder-row, .doc-item')) return;
    clearSelection();
    void renderDocTree();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSelection();
      void renderDocTree();
    }
  });

  document.addEventListener('mouseup', () => {
    window.setTimeout(() => {
      if (!document.querySelector('.folder-row.dragging, .doc-item.dragging')) {
        dragFromHandle = false;
      }
    }, 0);
  });

  setupRootDropZone();
  await renderDocTree();
  setupSyncUI();

  const connected = await isConnected();
  await updateSettingsBadge(connected);
  if (connected) {
    runSync();
  }
}

async function deleteSelected() {
  if (!selectedItem) return;

  if (selectedItem.type === 'folder') {
    const name = folderNames.get(selectedItem.id) ?? 'フォルダ';
    if (!confirm(`フォルダ「${name}」を削除しますか？\n中のドキュメントはルートに移動し、子フォルダはルート直下に移動します。`)) return;
    if (creationFolderId === selectedItem.id) creationFolderId = null;
    await deleteFolder(selectedItem.id);
    scheduleAutoSync();
  } else {
    const doc = await getDoc(selectedItem.id);
    if (!doc) return;
    const title = getDocTitle(doc.content);
    if (!confirm(`"${title}" を削除しますか？`)) return;
    await deleteDoc(selectedItem.id);
  }

  selectedItem = null;
  await renderDocTree();
}

async function openSelectedDoc() {
  if (selectedItem?.type !== 'doc') return;
  const tabId = cachedOpenDocs[selectedItem.id];
  if (tabId != null) {
    await focusTab(tabId).catch(() => {});
  } else {
    window.location.href = `editor.html?docId=${selectedItem.id}`;
  }
}

function triggerRenameSelected() {
  if (!selectedItem) return;

  if (selectedItem.type === 'folder') {
    const folderId = selectedItem.id;
    const nameEl = document.querySelector<HTMLElement>(
      `.folder-name[data-folder-id="${folderId}"]`,
    );
    if (!nameEl) return;
    const currentName = nameEl.textContent ?? '';
    const input = startInlineRename(currentName, 'folder-name-editing', async (newName) => {
      await renameFolder(folderId, newName);
      scheduleAutoSync();
      await renderDocTree();
    });
    nameEl.replaceWith(input);
    return;
  }

  const titleEl = document.querySelector<HTMLElement>(
    `.doc-item[data-doc-id="${selectedItem.id}"] .doc-title-label`,
  );
  if (!titleEl) return;
  const currentName = titleEl.textContent ?? '';
  const docId = selectedItem.id;
  const input = startInlineRename(currentName, 'doc-title-editing', async (newTitle) => {
    const currentDoc = await getDoc(docId);
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
    await renderDocTree();
  });
  titleEl.replaceWith(input);
}

async function updateSettingsBadge(connected?: boolean) {
  const badge = document.getElementById('settings-badge');
  const btnSettings = document.getElementById('btn-settings');
  if (!badge || !btnSettings) return;

  const isConn = connected ?? await isConnected();
  const { deviceName } = await getSyncSettings();
  const hasWarning = isConn && !deviceName;

  if (hasWarning) {
    badge.classList.remove('hidden');
    btnSettings.title = '設定 ⚠ デバイス名が未設定です';
  } else {
    badge.classList.add('hidden');
    btnSettings.title = '設定';
  }
}

function setupSyncUI() {
  const btnSync = document.getElementById('btn-sync')!;
  const statusEl = document.getElementById('sync-status')!;

  const updateStatus = (status: ReturnType<typeof getSyncStatus>) => {
    statusEl.className = `sync-status sync-${status}`;
    const labels: Record<string, string> = {
      idle: '同期済み', syncing: '同期中...', error: '同期エラー', conflict: '競合あり',
    };
    statusEl.title = labels[status] ?? '';
  };
  updateStatus(getSyncStatus());
  onSyncStatusChange(updateStatus);

  btnSync.addEventListener('click', async () => {
    if (!(await isConnected())) {
      showToast('Google Drive が未接続です。設定から接続してください。', 'settings.html');
      return;
    }
    runSync();
  });
}

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string, linkHref?: string) {
  const existing = document.getElementById('landing-toast');
  if (existing) existing.remove();
  if (_toastTimer) clearTimeout(_toastTimer);

  const toast = document.createElement('div');
  toast.id = 'landing-toast';
  toast.className = 'landing-toast';
  toast.innerHTML = linkHref
    ? `${message} <a href="${linkHref}">設定を開く</a>`
    : message;
  document.body.appendChild(toast);

  _toastTimer = setTimeout(() => {
    toast.classList.add('toast-fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

async function runSync() {
  const result = await syncAll();
  await renderDocTree();

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
      await renderDocTree();
      resolve();
    };

    modal.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((btn) => {
      btn.onclick = () => handleChoice(btn.dataset.choice as 'local' | 'remote');
    });
  });
}

function setupRootDropZone() {
  const zone = document.getElementById('root-drop-zone')!;
  zone.addEventListener('dragover', (e) => {
    if (!hasDragPayload(e)) return;
    e.preventDefault();
    zone.classList.add('drop-target');
  });
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget as Node)) zone.classList.remove('drop-target');
  });
  zone.addEventListener('drop', async (e) => {
    zone.classList.remove('drop-target');
    await handleDrop(e, null);
  });
}

function hasDragPayload(e: DragEvent): boolean {
  return !!(e.dataTransfer?.types.includes(DRAG_DOC) || e.dataTransfer?.types.includes(DRAG_FOLDER));
}

/**
 * 行全体を draggable にし、ハンドルからの開始時だけドラッグを許可する。
 * これによりブラウザ標準のゴーストが行全体になる。
 */
function setupRowDrag(row: HTMLElement, kind: 'folder' | 'doc', id: string) {
  row.draggable = true;

  const handle = row.querySelector('.drag-handle') as HTMLElement;
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    dragFromHandle = true;
  });

  row.addEventListener('dragstart', (e) => {
    if (!dragFromHandle) {
      e.preventDefault();
      return;
    }

    if (kind === 'folder') {
      draggingFolderId = id;
      draggingDocId = null;
      e.dataTransfer!.setData(DRAG_FOLDER, id);
    } else {
      draggingDocId = id;
      draggingFolderId = null;
      e.dataTransfer!.setData(DRAG_DOC, id);
    }
    e.dataTransfer!.effectAllowed = 'move';
    row.classList.add('dragging');
  });

  row.addEventListener('dragend', () => {
    dragFromHandle = false;
    row.classList.remove('dragging');
    draggingFolderId = null;
    draggingDocId = null;
  });
}

async function handleDrop(e: DragEvent, targetFolderId: string | null) {
  e.preventDefault();
  e.stopPropagation();
  const docId = e.dataTransfer?.getData(DRAG_DOC) || draggingDocId;
  const folderId = e.dataTransfer?.getData(DRAG_FOLDER) || draggingFolderId;
  draggingDocId = null;
  draggingFolderId = null;

  try {
    if (docId) {
      await moveDoc(docId, targetFolderId);
    } else if (folderId) {
      if (folderId === targetFolderId) return;
      await moveFolder(folderId, targetFolderId);
    } else {
      return;
    }
    scheduleAutoSync();
    await renderDocTree();
  } catch (err) {
    showToast(String(err));
  }
}

function startInlineRename(
  currentName: string,
  inputClass: string,
  onSave: (name: string) => Promise<void>,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = inputClass;
  input.value = currentName;
  input.setAttribute('aria-label', '名前を編集');

  let finished = false;
  const finish = async (save: boolean) => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    if (save && newName && newName !== currentName) {
      await onSave(newName);
    } else {
      await renderDocTree();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void finish(true);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener('blur', () => void finish(true));

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  return input;
}

async function renderDocTree() {
  const listEl = document.getElementById('doc-list')!;
  const [tree, openDocs] = await Promise.all([
    getFolderTree(),
    getOpenDocs().catch(() => ({})),
  ]);

  cachedOpenDocs = openDocs;
  folderNames.clear();
  indexFolderNames(tree.roots);

  const totalDocs = tree.rootDocs.length + countDocsInNodes(tree.roots);

  if (totalDocs === 0 && tree.roots.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <p>まだドキュメントがありません</p>
        <button class="primary" id="btn-new-empty">+ 新規ドキュメントを作成</button>
      </div>
    `;
    document.getElementById('btn-new-empty')?.addEventListener('click', async () => {
      const doc = createNewDoc(creationFolderId);
      await saveDoc(doc);
      window.location.href = `editor.html?docId=${doc.id}&new=1`;
    });
    updateToolbarState();
    return;
  }

  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();

  const rootZone = document.getElementById('root-drop-zone')!;
  rootZone.classList.toggle('hidden', tree.roots.length === 0);

  for (const node of tree.roots) {
    frag.appendChild(buildFolderNode(node, openDocs, 0));
  }
  for (const doc of tree.rootDocs) {
    frag.appendChild(buildDocItem(doc, openDocs, 0));
  }

  listEl.appendChild(frag);
  updateToolbarState();
}

function countDocsInNodes(nodes: FolderTreeNode[]): number {
  return nodes.reduce((n, node) => n + node.docs.length + countDocsInNodes(node.children), 0);
}

function buildFolderNode(node: FolderTreeNode, openDocs: Record<string, number>, depth: number): HTMLElement {
  const { folder } = node;
  const isCollapsed = collapsedFolders.has(folder.id);
  const isSelected = selectedItem?.type === 'folder' && selectedItem.id === folder.id;

  const wrapper = document.createElement('div');
  wrapper.className = 'folder-branch';
  wrapper.dataset.folderId = folder.id;

  const row = document.createElement('div');
  row.className = `folder-row${isSelected ? ' selected' : ''}`;
  row.style.paddingLeft = `${12 + depth * 16}px`;
  row.dataset.folderId = folder.id;

  row.innerHTML = `
    <span class="drag-handle" title="ドラッグして移動" aria-label="ドラッグして移動">${ICON_DRAG_HANDLE}</span>
    <button type="button" class="folder-toggle" draggable="false" aria-label="${isCollapsed ? '展開' : '折りたたむ'}">${isCollapsed ? '▶' : '▼'}</button>
    <span class="folder-icon" aria-hidden="true">📁</span>
    <span class="folder-name" data-folder-id="${folder.id}">${escapeHtml(folder.name)}</span>
  `;

  row.querySelector('.folder-toggle')!.addEventListener('click', (e) => {
    e.stopPropagation();
    if (collapsedFolders.has(folder.id)) collapsedFolders.delete(folder.id);
    else collapsedFolders.add(folder.id);
    persistCollapsed();
    renderDocTree().catch(console.error);
  });

  row.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, .drag-handle')) return;
    if (selectedItem?.type === 'folder' && selectedItem.id === folder.id) {
      clearSelection();
    } else {
      selectFolder(folder.id);
    }
    void renderDocTree();
  });

  setupRowDrag(row, 'folder', folder.id);
  setupFolderDrop(row, folder.id);

  wrapper.appendChild(row);

  if (!isCollapsed) {
    const children = document.createElement('div');
    children.className = 'folder-children';
    for (const child of node.children) {
      children.appendChild(buildFolderNode(child, openDocs, depth + 1));
    }
    for (const doc of node.docs) {
      children.appendChild(buildDocItem(doc, openDocs, depth + 1));
    }
    wrapper.appendChild(children);
  }

  return wrapper;
}

function setupFolderDrop(row: HTMLElement, folderId: string) {
  row.addEventListener('dragover', (e) => {
    if (!hasDragPayload(e)) return;
    if (draggingFolderId === folderId) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', (e) => {
    if (!row.contains(e.relatedTarget as Node)) row.classList.remove('drop-target');
  });
  row.addEventListener('drop', async (e) => {
    row.classList.remove('drop-target');
    await handleDrop(e, folderId);
  });
}

function buildDocItem(
  doc: Document,
  openDocs: Record<string, number>,
  depth: number,
): HTMLElement {
  const openTabId = openDocs[doc.id];
  const isOpen = openTabId != null;
  const isSelected = selectedItem?.type === 'doc' && selectedItem.id === doc.id;

  const item = document.createElement('div');
  item.className = `doc-item${isSelected ? ' selected' : ''}`;
  item.dataset.docId = doc.id;
  item.style.paddingLeft = `${12 + depth * 16}px`;

  const title = getDocTitle(doc.content);
  const updatedAt = new Date(doc.updatedAt).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  const openBadge = isOpen ? `<span class="doc-open-badge">他のタブで開いています</span>` : '';

  item.innerHTML = `
    <span class="drag-handle" title="ドラッグして移動" aria-label="ドラッグして移動">${ICON_DRAG_HANDLE}</span>
    <div class="doc-info">
      <span class="doc-title-label">${escapeHtml(title)}</span>
      <div class="doc-meta"><span>${updatedAt}</span>${openBadge}</div>
    </div>
    <div class="doc-actions">
      ${isOpen
    ? `<button type="button" class="btn-focus" draggable="false" data-tab-id="${openTabId}">タブを表示</button>`
    : `<button type="button" class="btn-open" draggable="false" data-doc-id="${doc.id}">開く</button>`}
    </div>
  `;

  setupRowDrag(item, 'doc', doc.id);

  item.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, .drag-handle')) return;
    if (selectedItem?.type === 'doc' && selectedItem.id === doc.id) {
      clearSelection();
    } else {
      selectDoc(doc.id);
    }
    void renderDocTree();
  });

  item.querySelector<HTMLButtonElement>('.btn-open')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.location.href = `editor.html?docId=${doc.id}`;
  });

  item.querySelector<HTMLButtonElement>('.btn-focus')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const tabId = parseInt(item.querySelector<HTMLButtonElement>('.btn-focus')!.dataset.tabId ?? '0', 10);
    await focusTab(tabId).catch(() => {});
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
