import {
  dbGetAllDocs, dbGetDoc, dbSaveDoc, dbDeleteDoc,
  dbGetAllFolders, dbGetFolder, dbSaveFolder, dbDeleteFolder,
  dbSaveImage, dbGetImage, dbDeleteImage, dbGetAllImageIds, dbGetAllImages,
  dbSaveTombstone, dbGetAllTombstones, dbDeleteTombstone,
  type DocRecord, type FolderRecord, type ImageRecord, type TombstoneRecord,
} from './db.js';

export type { FolderRecord };

// ── 型エクスポート（後方互換） ────────────────────────────────────────

export type Document = DocRecord;
export type { ImageRecord, TombstoneRecord };

export type FontSize = 12 | 14 | 16 | 18 | 20;
export type Theme = 'light' | 'dark' | 'system';
export type ViewMode = 'editor' | 'split' | 'preview';

export type Settings = {
  fontSize: FontSize;
  theme: Theme;
  viewMode: ViewMode;
};

// ── ユーティリティ ────────────────────────────────────────────────────

export function getDocTitle(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  return firstLine.replace(/^#+\s*/, '') || '無題';
}

export function createNewDoc(folderId: string | null = null): Document {
  return { id: crypto.randomUUID(), content: '', updatedAt: Date.now(), folderId };
}

// ── Documents (IndexedDB) ─────────────────────────────────────────────

export const getAllDocs = dbGetAllDocs;
export const getDoc    = dbGetDoc;
export const saveDoc   = dbSaveDoc;

/**
 * ドキュメントを削除し、墓標（tombstone）を記録する。
 * 墓標は同期時に「削除された」ことを他デバイス／Drive へ伝播し、
 * 既に同期済みのドキュメントが pull で復活するのを防ぐために使う。
 */
export async function deleteDoc(id: string): Promise<void> {
  await dbDeleteDoc(id);
  await dbSaveTombstone({ docId: id, deletedAt: Date.now() });
}

// ── Tombstones (削除の記録) ───────────────────────────────────────────

export const getAllTombstones = dbGetAllTombstones;

/** 墓標を記録する */
export async function saveTombstone(docId: string, deletedAt: number): Promise<void> {
  await dbSaveTombstone({ docId, deletedAt });
}

/** 墓標を取り除く（削除の取り消し／リモート編集による復活時） */
export const removeTombstone = dbDeleteTombstone;

/** 墓標を記録せずにローカルのドキュメントのみ削除する（同期による削除適用に使う） */
export const hardDeleteDoc = dbDeleteDoc;

// ── Images (IndexedDB) ───────────────────────────────────────────────

export const saveImage      = dbSaveImage;
export const getImage       = dbGetImage;
export const deleteImage    = dbDeleteImage;
export const getAllImageIds  = dbGetAllImageIds;
export const getAllImages    = dbGetAllImages;

/** ドキュメント削除時に孤立した画像をクリーンアップ */
export async function deleteOrphanedImages(): Promise<void> {
  const [allDocs, allImageIds] = await Promise.all([dbGetAllDocs(), dbGetAllImageIds()]);
  const usedIds = new Set<string>();
  for (const doc of allDocs) {
    for (const m of doc.content.matchAll(/local-img:\/\/([a-f0-9-]+)/g)) {
      usedIds.add(m[1]);
    }
  }
  for (const id of allImageIds) {
    if (!usedIds.has(id)) {
      await dbDeleteImage(id);
    }
  }
}

// ── Settings (chrome.storage.local のまま維持) ────────────────────────

const SETTINGS_KEY = 'settings';
const DEFAULT_SETTINGS: Settings = { fontSize: 16, theme: 'system', viewMode: 'split' };

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ── Sync 設定 (chrome.storage.local) ─────────────────────────────────

export type SyncSettings = {
  deviceName: string;
  /** ドキュメント毎の最終同期タイムスタンプ { [docId]: syncedAt } */
  docSyncedAt: Record<string, number>;
  /** 画像の最終同期タイムスタンプ { [imageId]: syncedAt } */
  imageSyncedAt: Record<string, number>;
  /** folders.json の最終同期タイムスタンプ */
  foldersSyncedAt: number;
  /** フォルダ構成が変わった時刻（空の状態でも push するため） */
  foldersRevision: number;
};

const SYNC_SETTINGS_KEY = 'sync_settings';
const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  deviceName: '',
  docSyncedAt: {},
  imageSyncedAt: {},
  foldersSyncedAt: 0,
  foldersRevision: 0,
};

export async function getSyncSettings(): Promise<SyncSettings> {
  const result = await chrome.storage.local.get(SYNC_SETTINGS_KEY);
  return { ...DEFAULT_SYNC_SETTINGS, ...(result[SYNC_SETTINGS_KEY] ?? {}) };
}

export async function saveSyncSettings(settings: Partial<SyncSettings>): Promise<void> {
  const current = await getSyncSettings();
  await chrome.storage.local.set({ [SYNC_SETTINGS_KEY]: { ...current, ...settings } });
}

// ── chrome.storage.local → IndexedDB 移行 ────────────────────────────

const MIGRATION_KEY = 'idb_migrated_v1';

export async function migrateFromChromeStorage(): Promise<void> {
  const flag = await chrome.storage.local.get(MIGRATION_KEY);
  if (flag[MIGRATION_KEY]) return;

  const data = await chrome.storage.local.get('docs');
  const oldDocs = data['docs'] as Record<string, Document> | undefined;

  if (oldDocs) {
    for (const doc of Object.values(oldDocs)) {
      await dbSaveDoc(doc);
    }
  }

  await chrome.storage.local.set({ [MIGRATION_KEY]: true });
}

// ── Folders (IndexedDB) ───────────────────────────────────────────────

export type FolderTreeNode = {
  folder: FolderRecord;
  children: FolderTreeNode[];
  docs: DocRecord[];
};

export const getAllFolders = dbGetAllFolders;
export const getFolder = dbGetFolder;

function normalizeFolderName(name: string): string {
  return name.trim();
}

function hasSiblingFolderName(
  folders: FolderRecord[],
  parentId: string | null,
  name: string,
  excludeId?: string,
): boolean {
  const normalized = normalizeFolderName(name).toLocaleLowerCase('ja');
  if (!normalized) return false;
  return folders.some((f) =>
    f.parentId === parentId
    && f.id !== excludeId
    && normalizeFolderName(f.name).toLocaleLowerCase('ja') === normalized);
}

export function getFoldersSnapshotUpdatedAt(folders: FolderRecord[]): number {
  if (folders.length === 0) return 0;
  return Math.max(...folders.map((f) => f.updatedAt));
}

async function bumpFoldersRevision(): Promise<void> {
  await saveSyncSettings({ foldersRevision: Date.now() });
}

export async function createFolder(name: string, parentId: string | null = null): Promise<FolderRecord> {
  const normalizedName = normalizeFolderName(name) || '新しいフォルダ';
  const allFolders = await dbGetAllFolders();

  if (parentId) {
    const parent = allFolders.find((f) => f.id === parentId);
    if (!parent) throw new Error('親フォルダが見つかりません');
  }

  if (hasSiblingFolderName(allFolders, parentId, normalizedName)) {
    throw new Error('同じ階層に同名のフォルダがあります');
  }

  const siblings = allFolders.filter((f) => f.parentId === parentId);
  const folder: FolderRecord = {
    id: crypto.randomUUID(),
    name: normalizedName,
    parentId,
    order: siblings.length,
    updatedAt: Date.now(),
  };
  await dbSaveFolder(folder);
  await bumpFoldersRevision();
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const allFolders = await dbGetAllFolders();
  const folder = allFolders.find((f) => f.id === id);
  if (!folder) throw new Error('フォルダが見つかりません');
  const normalizedName = normalizeFolderName(name) || folder.name;
  if (hasSiblingFolderName(allFolders, folder.parentId, normalizedName, folder.id)) {
    throw new Error('同じ階層に同名のフォルダがあります');
  }
  await dbSaveFolder({ ...folder, name: normalizedName, updatedAt: Date.now() });
  await bumpFoldersRevision();
}

function collectDescendantFolderIds(folderId: string, folders: FolderRecord[]): Set<string> {
  const ids = new Set<string>();
  const walk = (id: string) => {
    for (const f of folders) {
      if (f.parentId === id && !ids.has(f.id)) {
        ids.add(f.id);
        walk(f.id);
      }
    }
  };
  walk(folderId);
  return ids;
}

export async function deleteFolder(id: string): Promise<Set<string>> {
  const folders = await dbGetAllFolders();
  const folder = folders.find((f) => f.id === id);
  if (!folder) return new Set();

  const descendants = collectDescendantFolderIds(id, folders);
  const folderIdsToDelete = new Set([id, ...descendants]);

  const docs = await dbGetAllDocs();
  const now = Date.now();
  for (const doc of docs) {
    if (doc.folderId && folderIdsToDelete.has(doc.folderId)) {
      await dbDeleteDoc(doc.id);
      await dbSaveTombstone({ docId: doc.id, deletedAt: now });
    }
  }

  for (const folderId of folderIdsToDelete) {
    await dbDeleteFolder(folderId);
  }

  await bumpFoldersRevision();
  return folderIdsToDelete;
}

export async function moveFolder(id: string, newParentId: string | null): Promise<void> {
  if (id === newParentId) throw new Error('自分自身には移動できません');
  const folders = await dbGetAllFolders();
  const folder = folders.find((f) => f.id === id);
  if (!folder) throw new Error('フォルダが見つかりません');

  if (newParentId) {
    const parent = folders.find((f) => f.id === newParentId);
    if (!parent) throw new Error('移動先フォルダが見つかりません');
    const descendants = collectDescendantFolderIds(id, folders);
    if (newParentId === id || descendants.has(newParentId)) {
      throw new Error('子フォルダの中には移動できません');
    }
  }

  const normalizedName = normalizeFolderName(folder.name);
  if (hasSiblingFolderName(folders, newParentId, normalizedName, folder.id)) {
    throw new Error('移動先に同名のフォルダがあります');
  }

  const siblings = folders.filter((f) => f.parentId === newParentId && f.id !== id);
  await dbSaveFolder({
    ...folder,
    parentId: newParentId,
    order: siblings.length,
    updatedAt: Date.now(),
  });
  await bumpFoldersRevision();
}

export async function moveDoc(docId: string, folderId: string | null): Promise<void> {
  const doc = await dbGetDoc(docId);
  if (!doc) throw new Error('ドキュメントが見つかりません');
  if (folderId) {
    const folder = await dbGetFolder(folderId);
    if (!folder) throw new Error('フォルダが見つかりません');
  }
  await dbSaveDoc({ ...doc, folderId, updatedAt: Date.now() });
}

export async function resolveFolderId(folderId: string | null | undefined): Promise<string | null> {
  if (!folderId) return null;
  const folder = await dbGetFolder(folderId);
  return folder ? folderId : null;
}

export function foldersSnapshotKey(folders: FolderRecord[]): string {
  return JSON.stringify(
    [...folders]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, order: f.order })),
  );
}

/** 存在しない親フォルダ・folderId 参照をルートへ修復 */
export async function repairOrphanFolderRefs(): Promise<{ docs: number; folders: number }> {
  const [folders, docs] = await Promise.all([dbGetAllFolders(), dbGetAllDocs()]);
  const validIds = new Set(folders.map((f) => f.id));
  let repairedDocs = 0;
  let repairedFolders = 0;
  const now = Date.now();

  for (const folder of folders) {
    if (folder.parentId && !validIds.has(folder.parentId)) {
      await dbSaveFolder({ ...folder, parentId: null, updatedAt: now });
      repairedFolders++;
    }
  }

  for (const doc of docs) {
    if (doc.folderId && !validIds.has(doc.folderId)) {
      await dbSaveDoc({ ...doc, folderId: null, updatedAt: now });
      repairedDocs++;
    }
  }

  if (repairedFolders > 0) {
    await bumpFoldersRevision();
  }

  return { docs: repairedDocs, folders: repairedFolders };
}

export async function replaceAllFolders(folders: FolderRecord[]): Promise<void> {
  const existing = await dbGetAllFolders();
  const incomingIds = new Set(folders.map((f) => f.id));
  for (const f of existing) {
    if (!incomingIds.has(f.id)) await dbDeleteFolder(f.id);
  }
  for (const f of folders) {
    await dbSaveFolder(f);
  }
}

export async function getFolderTree(): Promise<{ roots: FolderTreeNode[]; rootDocs: DocRecord[] }> {
  const [folders, docs] = await Promise.all([dbGetAllFolders(), dbGetAllDocs()]);
  const validFolderIds = new Set(folders.map((f) => f.id));

  const normalizedDocs = docs.map((d) => ({
    ...d,
    folderId: d.folderId && validFolderIds.has(d.folderId) ? d.folderId : null,
  }));

  const sortFolders = (list: FolderRecord[]) =>
    [...list].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ja'));

  const sortDocs = (list: DocRecord[]) =>
    [...list].sort((a, b) => b.updatedAt - a.updatedAt);

  const childrenByParent = new Map<string | null, FolderRecord[]>();
  for (const folder of folders) {
    const parentKey = folder.parentId;
    const bucket = childrenByParent.get(parentKey);
    if (bucket) bucket.push(folder);
    else childrenByParent.set(parentKey, [folder]);
  }

  const docsByFolder = new Map<string | null, DocRecord[]>();
  for (const doc of normalizedDocs) {
    const folderKey = doc.folderId ?? null;
    const bucket = docsByFolder.get(folderKey);
    if (bucket) bucket.push(doc);
    else docsByFolder.set(folderKey, [doc]);
  }

  const buildNode = (folder: FolderRecord): FolderTreeNode => ({
    folder,
    children: sortFolders(childrenByParent.get(folder.id) ?? []).map(buildNode),
    docs: sortDocs(docsByFolder.get(folder.id) ?? []),
  });

  const roots = sortFolders(childrenByParent.get(null) ?? []).map(buildNode);
  const rootDocs = sortDocs(docsByFolder.get(null) ?? []);

  return { roots, rootDocs };
}
