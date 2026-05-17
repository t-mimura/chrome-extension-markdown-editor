/**
 * IndexedDB ラッパー
 *
 * DB名: markdown-editor / バージョン: 1
 * ストア:
 *   documents  — { id, content, updatedAt }
 *   images     — { id, mimeType, data: ArrayBuffer, size, createdAt }
 */

const DB_NAME = 'markdown-editor';
const DB_VERSION = 1;

export type DocRecord = {
  id: string;
  content: string;
  updatedAt: number;
};

export type ImageRecord = {
  id: string;
  mimeType: string;
  data: ArrayBuffer;
  size: number;
  createdAt: number;
};

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let _dbPromise: Promise<IDBDatabase> | null = null;

export function getDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('documents')) {
        const s = db.createObjectStore('documents', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }

      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IDB blocked'));
  });
  return _dbPromise;
}

// ── Documents ────────────────────────────────────────────────────────

export async function dbGetAllDocs(): Promise<DocRecord[]> {
  const db = await getDB();
  const docs = await idbReq<DocRecord[]>(
    db.transaction('documents', 'readonly').objectStore('documents').getAll(),
  );
  return docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function dbGetDoc(id: string): Promise<DocRecord | null> {
  const db = await getDB();
  const result = await idbReq<DocRecord | undefined>(
    db.transaction('documents', 'readonly').objectStore('documents').get(id),
  );
  return result ?? null;
}

export async function dbSaveDoc(doc: DocRecord): Promise<void> {
  const db = await getDB();
  await idbReq(db.transaction('documents', 'readwrite').objectStore('documents').put(doc));
}

export async function dbDeleteDoc(id: string): Promise<void> {
  const db = await getDB();
  await idbReq(db.transaction('documents', 'readwrite').objectStore('documents').delete(id));
}

// ── Images ───────────────────────────────────────────────────────────

export async function dbSaveImage(record: ImageRecord): Promise<void> {
  const db = await getDB();
  await idbReq(db.transaction('images', 'readwrite').objectStore('images').put(record));
}

export async function dbGetImage(id: string): Promise<ImageRecord | null> {
  const db = await getDB();
  const result = await idbReq<ImageRecord | undefined>(
    db.transaction('images', 'readonly').objectStore('images').get(id),
  );
  return result ?? null;
}

export async function dbDeleteImage(id: string): Promise<void> {
  const db = await getDB();
  await idbReq(db.transaction('images', 'readwrite').objectStore('images').delete(id));
}

export async function dbGetAllImageIds(): Promise<string[]> {
  const db = await getDB();
  const keys = await idbReq<IDBValidKey[]>(
    db.transaction('images', 'readonly').objectStore('images').getAllKeys(),
  );
  return keys as string[];
}

export async function dbGetAllImages(): Promise<ImageRecord[]> {
  const db = await getDB();
  return idbReq<ImageRecord[]>(
    db.transaction('images', 'readonly').objectStore('images').getAll(),
  );
}
