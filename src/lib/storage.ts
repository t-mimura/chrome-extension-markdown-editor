import {
  dbGetAllDocs, dbGetDoc, dbSaveDoc, dbDeleteDoc,
  dbSaveImage, dbGetImage, dbDeleteImage, dbGetAllImageIds, dbGetAllImages,
  type DocRecord, type ImageRecord,
} from './db.js';

// ── 型エクスポート（後方互換） ────────────────────────────────────────

export type Document = DocRecord;
export type { ImageRecord };

export type FontSize = 12 | 14 | 16 | 18 | 20;
export type Theme = 'light' | 'dark' | 'system';

export type Settings = {
  fontSize: FontSize;
  theme: Theme;
};

// ── ユーティリティ ────────────────────────────────────────────────────

export function getDocTitle(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  return firstLine.replace(/^#+\s*/, '') || '無題';
}

export function createNewDoc(): Document {
  return { id: crypto.randomUUID(), content: '', updatedAt: Date.now() };
}

// ── Documents (IndexedDB) ─────────────────────────────────────────────

export const getAllDocs = dbGetAllDocs;
export const getDoc    = dbGetDoc;
export const saveDoc   = dbSaveDoc;
export const deleteDoc = dbDeleteDoc;

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
const DEFAULT_SETTINGS: Settings = { fontSize: 16, theme: 'system' };

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
  clientId: string;
  refreshToken: string | null;
  /** ドキュメント毎の最終同期タイムスタンプ { [docId]: syncedAt } */
  docSyncedAt: Record<string, number>;
  /** 画像の最終同期タイムスタンプ { [imageId]: syncedAt } */
  imageSyncedAt: Record<string, number>;
};

const SYNC_SETTINGS_KEY = 'sync_settings';
const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  deviceName: '',
  clientId: '',
  refreshToken: null,
  docSyncedAt: {},
  imageSyncedAt: {},
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
