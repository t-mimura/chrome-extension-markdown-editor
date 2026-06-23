/**
 * Google Drive 同期ロジック
 *
 * 同期戦略: タイムスタンプ last-write-wins + コンフリクト検出
 * - ローカルのみ新しい  → Drive へ push
 * - Drive のみ新しい   → ローカルへ pull
 * - 両方 syncedAt より新しい → コンフリクト → ユーザーに選択させる
 * - 同じ              → 何もしない
 */

import {
  getAllDocs, getDoc, saveDoc, deleteOrphanedImages,
  getSyncSettings, saveSyncSettings,
  getAllImages, saveImage,
  getAllFolders, replaceAllFolders, getFoldersSnapshotUpdatedAt,
  repairOrphanFolderRefs,
  type SyncSettings,
} from './storage.js';
import {
  uploadDoc, downloadDoc, listRemoteDocs,
  uploadImage, downloadImage, listRemoteImages,
  uploadFolders, downloadFolders,
  isConnected,
  type FoldersSnapshot,
} from './drive.js';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'conflict';

export type ConflictItem = {
  docId: string;
  local: { content: string; updatedAt: number; charCount: number };
  remote: { content: string; updatedAt: number; charCount: number; deviceName: string; driveFileId: string };
};

type SyncResult = {
  pushed: number;
  pulled: number;
  conflicts: ConflictItem[];
  errors: string[];
};

// ── 状態管理（コールバックで外部に通知）──────────────────────────────

let _status: SyncStatus = 'idle';
const _listeners = new Set<(s: SyncStatus) => void>();

export function getSyncStatus(): SyncStatus { return _status; }

export function onSyncStatusChange(fn: (s: SyncStatus) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function setStatus(s: SyncStatus) {
  _status = s;
  for (const fn of _listeners) fn(s);
}

// ── 同期エントリポイント ──────────────────────────────────────────────

export async function syncAll(): Promise<SyncResult> {
  if (_status === 'syncing') return { pushed: 0, pulled: 0, conflicts: [], errors: [] };

  setStatus('syncing');
  const result: SyncResult = { pushed: 0, pulled: 0, conflicts: [], errors: [] };

  try {
    if (!(await isConnected())) {
      setStatus('idle');
      return result;
    }
    const syncSettings = await getSyncSettings();

    // 1. フォルダ一覧の同期
    const folderResult = await syncFolders(syncSettings);
    result.errors.push(...folderResult.errors);

    // 2. ドキュメントの同期
    const docResult = await syncDocuments(syncSettings);
    result.pushed += docResult.pushed;
    result.pulled += docResult.pulled;
    result.conflicts.push(...docResult.conflicts);
    result.errors.push(...docResult.errors);

    // 3. 画像の同期（ドキュメントで参照されているものを対象）
    const imgResult = await syncImages(syncSettings);
    result.pushed += imgResult.pushed;
    result.pulled += imgResult.pulled;
    result.errors.push(...imgResult.errors);

    // 4. 孤立画像のクリーンアップ
    await deleteOrphanedImages();

    // 5. 存在しないフォルダを参照するドキュメントを修復
    await repairOrphanFolderRefs();

    setStatus(result.conflicts.length > 0 ? 'conflict' : 'idle');
  } catch (e) {
    result.errors.push(String(e));
    setStatus('error');
  }

  return result;
}

// ── フォルダ同期 ──────────────────────────────────────────────────────

async function syncFolders(syncSettings: SyncSettings) {
  const errors: string[] = [];
  try {
    const localFolders = await getAllFolders();
    const localUpdatedAt = Math.max(
      getFoldersSnapshotUpdatedAt(localFolders),
      syncSettings.foldersRevision ?? 0,
    );
    const remote = await downloadFolders().catch(() => null);
    const remoteUpdatedAt = remote?.updatedAt ?? 0;
    const lastSynced = syncSettings.foldersSyncedAt ?? 0;

    const localChanged = localUpdatedAt > lastSynced;
    const remoteChanged = remoteUpdatedAt > lastSynced;

    if (localChanged && remoteChanged && localUpdatedAt !== remoteUpdatedAt) {
      // last-write-wins
      if (remoteUpdatedAt > localUpdatedAt && remote) {
        await replaceAllFolders(remote.folders);
        await saveSyncSettings({ foldersSyncedAt: Date.now(), foldersRevision: remoteUpdatedAt });
      } else {
        await pushFoldersSnapshot(localFolders, localUpdatedAt);
        await saveSyncSettings({ foldersSyncedAt: Date.now(), foldersRevision: localUpdatedAt });
      }
    } else if (localChanged && localUpdatedAt > remoteUpdatedAt) {
      await pushFoldersSnapshot(localFolders, localUpdatedAt);
      await saveSyncSettings({ foldersSyncedAt: Date.now(), foldersRevision: localUpdatedAt });
    } else if (remoteChanged && remoteUpdatedAt > localUpdatedAt && remote) {
      await replaceAllFolders(remote.folders);
      await saveSyncSettings({ foldersSyncedAt: Date.now(), foldersRevision: remoteUpdatedAt });
    }
  } catch (e) {
    errors.push(`folders: ${e}`);
  }
  return { errors };
}

async function pushFoldersSnapshot(
  folders: Awaited<ReturnType<typeof getAllFolders>>,
  updatedAt: number,
): Promise<void> {
  const snapshot: FoldersSnapshot = {
    version: 1,
    updatedAt: updatedAt || Date.now(),
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      order: f.order,
      updatedAt: f.updatedAt,
    })),
  };
  await uploadFolders(snapshot);
}

// ── ドキュメント同期 ──────────────────────────────────────────────────

async function syncDocuments(syncSettings: SyncSettings) {
  const result = { pushed: 0, pulled: 0, conflicts: [] as ConflictItem[], errors: [] as string[] };

  const [localDocs, remoteDocs] = await Promise.all([
    getAllDocs(),
    listRemoteDocs().catch(() => [] as Awaited<ReturnType<typeof listRemoteDocs>>),
  ]);

  const remoteMap = new Map(remoteDocs.map((r) => [r.docId, r]));
  const localMap = new Map(localDocs.map((d) => [d.id, d]));
  const processed = new Set<string>();

  // ローカルドキュメントを処理
  for (const local of localDocs) {
    processed.add(local.id);
    const remote = remoteMap.get(local.id);
    const lastSynced = syncSettings.docSyncedAt[local.id] ?? 0;

    if (!remote) {
      // Drive にない → push
      await uploadDoc({
        id: local.id, content: local.content,
        updatedAt: local.updatedAt, charCount: local.content.length,
        deviceName: syncSettings.deviceName, folderId: local.folderId ?? null,
      }).catch((e) => result.errors.push(`push ${local.id}: ${e}`));
      await saveSyncSettings({ docSyncedAt: { ...syncSettings.docSyncedAt, [local.id]: Date.now() } });
      result.pushed++;
      continue;
    }

    const localNewer = local.updatedAt > lastSynced;
    const remoteNewer = remote.updatedAt > lastSynced;

    if (localNewer && remoteNewer && remote.updatedAt !== local.updatedAt) {
      // 両方変更 → コンフリクト
      const remoteDoc = await downloadDoc(remote.driveFileId).catch(() => null);
      if (remoteDoc) {
        result.conflicts.push({
          docId: local.id,
          local: { content: local.content, updatedAt: local.updatedAt, charCount: local.content.length },
          remote: { content: remoteDoc.content, updatedAt: remote.updatedAt, charCount: remote.charCount, deviceName: remote.deviceName, driveFileId: remote.driveFileId },
        });
      }
    } else if (localNewer) {
      await uploadDoc({
        id: local.id, content: local.content,
        updatedAt: local.updatedAt, charCount: local.content.length,
        deviceName: syncSettings.deviceName, folderId: local.folderId ?? null,
      }).catch((e) => result.errors.push(`push ${local.id}: ${e}`));
      await saveSyncSettings({ docSyncedAt: { ...syncSettings.docSyncedAt, [local.id]: Date.now() } });
      result.pushed++;
    } else if (remoteNewer) {
      const remoteDoc = await downloadDoc(remote.driveFileId).catch(() => null);
      if (remoteDoc) {
        await saveDoc({
          id: remoteDoc.id,
          content: remoteDoc.content,
          updatedAt: remoteDoc.updatedAt,
          folderId: remoteDoc.folderId ?? null,
        });
        await saveSyncSettings({ docSyncedAt: { ...syncSettings.docSyncedAt, [local.id]: Date.now() } });
        result.pulled++;
      }
    }
  }

  // Drive にあってローカルにないドキュメントを pull
  for (const remote of remoteDocs) {
    if (processed.has(remote.docId)) continue;
    if (!localMap.has(remote.docId)) {
      const remoteDoc = await downloadDoc(remote.driveFileId).catch(() => null);
      if (remoteDoc) {
        await saveDoc({
          id: remoteDoc.id,
          content: remoteDoc.content,
          updatedAt: remoteDoc.updatedAt,
          folderId: remoteDoc.folderId ?? null,
        });
        await saveSyncSettings({ docSyncedAt: { ...syncSettings.docSyncedAt, [remote.docId]: Date.now() } });
        result.pulled++;
      }
    }
  }

  return result;
}

// ── 画像同期 ──────────────────────────────────────────────────────────

async function syncImages(syncSettings: SyncSettings) {
  const result = { pushed: 0, pulled: 0, errors: [] as string[] };

  // ローカルのすべてのドキュメントから参照されている画像 ID を収集
  const allDocs = await getAllDocs();
  const referencedIds = new Set<string>();
  for (const doc of allDocs) {
    for (const m of doc.content.matchAll(/local-img:\/\/([a-f0-9-]+)/g)) {
      referencedIds.add(m[1]);
    }
  }
  if (referencedIds.size === 0) return result;

  const [localImages, remoteImages] = await Promise.all([
    getAllImages(),
    listRemoteImages().catch(() => [] as Awaited<ReturnType<typeof listRemoteImages>>),
  ]);

  const remoteMap = new Map(remoteImages.map((r) => [r.imageId, r]));
  const localMap = new Map(localImages.map((i) => [i.id, i]));

  // ローカルにあって Drive にない → push
  for (const id of referencedIds) {
    const local = localMap.get(id);
    if (!local) continue;
    const lastSynced = syncSettings.imageSyncedAt[id] ?? 0;
    if (!remoteMap.has(id) || local.createdAt > lastSynced) {
      await uploadImage(id, local.mimeType, local.data)
        .catch((e) => result.errors.push(`push image ${id}: ${e}`));
      await saveSyncSettings({ imageSyncedAt: { ...syncSettings.imageSyncedAt, [id]: Date.now() } });
      result.pushed++;
    }
  }

  // Drive にあってローカルにない → pull
  for (const remote of remoteImages) {
    if (!referencedIds.has(remote.imageId)) continue;
    if (!localMap.has(remote.imageId)) {
      const data = await downloadImage(remote.driveFileId).catch(() => null);
      if (data) {
        await saveImage({ id: remote.imageId, mimeType: remote.mimeType, data, size: data.byteLength, createdAt: Date.now() });
        await saveSyncSettings({ imageSyncedAt: { ...syncSettings.imageSyncedAt, [remote.imageId]: Date.now() } });
        result.pulled++;
      }
    }
  }

  return result;
}

// ── コンフリクト解決 ──────────────────────────────────────────────────

export async function resolveConflict(
  conflict: ConflictItem,
  choice: 'local' | 'remote',
): Promise<void> {
  const syncSettings = await getSyncSettings();

  if (choice === 'remote') {
    await saveDoc({ id: conflict.docId, content: conflict.remote.content, updatedAt: conflict.remote.updatedAt });
  }
  // local を選んだ場合: Drive に push
  if (choice === 'local') {
    const doc = await getDoc(conflict.docId);
    if (doc) {
      await uploadDoc({
        id: doc.id, content: doc.content,
        updatedAt: doc.updatedAt, charCount: doc.content.length,
        deviceName: syncSettings.deviceName, folderId: doc.folderId ?? null,
      });
    }
  }

  await saveSyncSettings({ docSyncedAt: { ...syncSettings.docSyncedAt, [conflict.docId]: Date.now() } });
  if (_status === 'conflict') setStatus('idle');
}

// ── 自動同期デバウンス ────────────────────────────────────────────────

let _autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_SYNC_DELAY_MS = 15_000;

export function scheduleAutoSync(): void {
  if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
  _autoSyncTimer = setTimeout(() => {
    _autoSyncTimer = null;
    syncAll().catch(console.error);
  }, AUTO_SYNC_DELAY_MS);
}
