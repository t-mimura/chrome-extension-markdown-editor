/**
 * Google Drive API ラッパー
 *
 * 認証: chrome.identity.getAuthToken()（Chrome Extension 専用 OAuth）
 *   - manifest.json の oauth2 セクションで設定済みの client_id を使用
 *   - Chrome がトークンのキャッシュ・リフレッシュを自動管理
 * スコープ: drive.file（拡張機能が作成したファイルのみアクセス）
 *
 * フォルダ構成:
 *   My Drive/
 *     Markdown Editor/
 *       documents/{docId}.json
 *       images/{imageId}   (バイナリ, mimeType は Drive メタデータに記録)
 */

import { getSyncSettings } from './storage.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_NAME = 'Markdown Editor';

export type DriveDocMeta = {
  updatedAt: number;
  charCount: number;
  deviceName: string;
  folderId?: string | null;
};

export type DriveDoc = DriveDocMeta & {
  id: string;
  content: string;
};

export type FoldersSnapshot = {
  version: 1;
  updatedAt: number;
  folders: {
    id: string;
    name: string;
    parentId: string | null;
    order: number;
    updatedAt: number;
  }[];
};

// ── 認証 ─────────────────────────────────────────────────────────────

/**
 * Chrome が管理するアクセストークンを取得する。
 * interactive=true: 未認証なら Google 認証画面を表示
 */
function getAccessToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? '認証エラー'));
        return;
      }
      // @types/chrome >= 0.0.317 では result が GetAuthTokenResult オブジェクト
      const token = typeof result === 'string' ? result : (result as { token?: string })?.token;
      if (!token) {
        reject(new Error('トークンが取得できませんでした'));
        return;
      }
      resolve(token);
    });
  });
}

/** 認証フローを起動する（設定画面の「接続」ボタンから呼ばれる） */
export async function authorize(): Promise<void> {
  await getAccessToken(true); // Google 認証画面を表示
}

/** キャッシュを削除して接続を解除する */
export async function revokeAuth(): Promise<void> {
  const token = await getAccessToken(false).catch(() => null);
  if (token) {
    await new Promise<void>((resolve) =>
      chrome.identity.removeCachedAuthToken({ token }, resolve),
    );
  }
}

/** Drive が接続済みかどうかを確認する（認証画面なし） */
export async function isConnected(): Promise<boolean> {
  const token = await getAccessToken(false).catch(() => null);
  return token !== null;
}

async function apiFetch(url: string, options: RequestInit = {}, retry = true): Promise<Response> {
  const token = await getAccessToken(true);
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });

  // 401 はトークン期限切れ → キャッシュを削除して1回リトライ
  if (res.status === 401 && retry) {
    await new Promise<void>((resolve) =>
      chrome.identity.removeCachedAuthToken({ token }, resolve),
    );
    return apiFetch(url, options, false);
  }

  if (!res.ok) throw new Error(`Drive API エラー: ${res.status} ${await res.text()}`);
  return res;
}

// ── フォルダ管理 ──────────────────────────────────────────────────────

let _rootFolderId: string | null = null;
let _documentsFolderId: string | null = null;
let _imagesFolderId: string | null = null;

async function getOrCreateFolder(name: string, parentId?: string): Promise<string> {
  const q = [
    `name = '${name}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
    parentId ? `'${parentId}' in parents` : `'root' in parents`,
  ].join(' and ');

  const res = await apiFetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`,
  );
  const data = await res.json() as { files: { id: string }[] };

  if (data.files.length > 0) return data.files[0].id;

  const createRes = await apiFetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  const created = await createRes.json() as { id: string };
  return created.id;
}

async function getFolderIds() {
  if (!_rootFolderId) {
    _rootFolderId = await getOrCreateFolder(FOLDER_NAME);
    _documentsFolderId = await getOrCreateFolder('documents', _rootFolderId);
    _imagesFolderId = await getOrCreateFolder('images', _rootFolderId);
  }
  return {
    root: _rootFolderId!,
    documents: _documentsFolderId!,
    images: _imagesFolderId!,
  };
}

// ── ドキュメント操作 ──────────────────────────────────────────────────

export async function listDriveFiles(folderId: string): Promise<{ id: string; name: string; modifiedTime: string }[]> {
  const q = `'${folderId}' in parents and trashed = false`;
  const res = await apiFetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=1000`,
  );
  const data = await res.json() as { files: { id: string; name: string; modifiedTime: string }[] };
  return data.files;
}

export async function uploadDoc(doc: DriveDoc): Promise<void> {
  const folders = await getFolderIds();
  const fileName = `${doc.id}.json`;
  const body = JSON.stringify({
    id: doc.id,
    content: doc.content,
    updatedAt: doc.updatedAt,
    charCount: doc.content.length,
    deviceName: (await getSyncSettings()).deviceName,
    folderId: doc.folderId ?? null,
  });

  const existing = await findFileInFolder(folders.documents, fileName);

  if (existing) {
    await apiFetch(`${UPLOAD_API}/files/${existing}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } else {
    const meta = JSON.stringify({ name: fileName, parents: [folders.documents] });
    const form = buildMultipart(meta, body, 'application/json');
    await apiFetch(`${UPLOAD_API}/files?uploadType=multipart`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${form.boundary}` },
      body: form.body,
    });
  }
}

export async function downloadDoc(driveFileId: string): Promise<DriveDoc> {
  const res = await apiFetch(`${DRIVE_API}/files/${driveFileId}?alt=media`);
  return res.json() as Promise<DriveDoc>;
}

export async function listRemoteDocs(): Promise<{ driveFileId: string; docId: string; updatedAt: number; charCount: number; deviceName: string }[]> {
  const folders = await getFolderIds();
  const files = await listDriveFiles(folders.documents);
  const results = [];
  for (const f of files) {
    const meta = await (await apiFetch(`${DRIVE_API}/files/${f.id}?alt=media`)).json() as DriveDoc;
    results.push({
      driveFileId: f.id,
      docId: meta.id,
      updatedAt: meta.updatedAt,
      charCount: meta.charCount ?? meta.content?.length ?? 0,
      deviceName: meta.deviceName ?? '',
    });
  }
  return results;
}

// ── フォルダ一覧 ──────────────────────────────────────────────────────

const FOLDERS_FILE = 'folders.json';

export async function uploadFolders(snapshot: FoldersSnapshot): Promise<void> {
  const folders = await getFolderIds();
  const body = JSON.stringify(snapshot);
  const existing = await findFileInFolder(folders.root, FOLDERS_FILE);

  if (existing) {
    await apiFetch(`${UPLOAD_API}/files/${existing}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } else {
    const meta = JSON.stringify({ name: FOLDERS_FILE, parents: [folders.root] });
    const form = buildMultipart(meta, body, 'application/json');
    await apiFetch(`${UPLOAD_API}/files?uploadType=multipart`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${form.boundary}` },
      body: form.body,
    });
  }
}

export async function downloadFolders(): Promise<FoldersSnapshot | null> {
  const folders = await getFolderIds();
  const fileId = await findFileInFolder(folders.root, FOLDERS_FILE);
  if (!fileId) return null;
  const res = await apiFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
  return res.json() as Promise<FoldersSnapshot>;
}

// ── 画像操作 ──────────────────────────────────────────────────────────

export async function uploadImage(id: string, mimeType: string, data: ArrayBuffer): Promise<void> {
  const folders = await getFolderIds();
  const existing = await findFileInFolder(folders.images, id);

  if (existing) {
    await apiFetch(`${UPLOAD_API}/files/${existing}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body: data,
    });
  } else {
    const meta = JSON.stringify({ name: id, parents: [folders.images], mimeType });
    const form = buildMultipartBinary(meta, data, mimeType);
    await apiFetch(`${UPLOAD_API}/files?uploadType=multipart`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${form.boundary}` },
      body: form.body,
    });
  }
}

export async function downloadImage(driveFileId: string): Promise<ArrayBuffer> {
  const res = await apiFetch(`${DRIVE_API}/files/${driveFileId}?alt=media`);
  return res.arrayBuffer();
}

export async function listRemoteImages(): Promise<{ driveFileId: string; imageId: string; mimeType: string }[]> {
  const folders = await getFolderIds();
  const files = await listDriveFiles(folders.images);
  const results = [];
  for (const f of files) {
    const meta = await (await apiFetch(`${DRIVE_API}/files/${f.id}?fields=name,mimeType`)).json() as { name: string; mimeType: string };
    results.push({ driveFileId: f.id, imageId: meta.name, mimeType: meta.mimeType });
  }
  return results;
}

// ── ユーティリティ ────────────────────────────────────────────────────

async function findFileInFolder(folderId: string, name: string): Promise<string | null> {
  const q = `'${folderId}' in parents and name = '${name}' and trashed = false`;
  const res = await apiFetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`,
  );
  const data = await res.json() as { files: { id: string }[] };
  return data.files[0]?.id ?? null;
}

const BOUNDARY = 'mdeditor_boundary_xyz';

function buildMultipart(meta: string, body: string, bodyMime: string) {
  const text =
    `--${BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${BOUNDARY}\r\nContent-Type: ${bodyMime}\r\n\r\n${body}\r\n` +
    `--${BOUNDARY}--`;
  return { boundary: BOUNDARY, body: text };
}

function buildMultipartBinary(meta: string, data: ArrayBuffer, mime: string) {
  const enc = new TextEncoder();
  const part1 = enc.encode(
    `--${BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${BOUNDARY}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const part2 = enc.encode(`\r\n--${BOUNDARY}--`);
  const combined = new Uint8Array(part1.byteLength + data.byteLength + part2.byteLength);
  combined.set(part1, 0);
  combined.set(new Uint8Array(data), part1.byteLength);
  combined.set(part2, part1.byteLength + data.byteLength);
  return { boundary: BOUNDARY, body: combined.buffer };
}

export function resetFolderCache(): void {
  _rootFolderId = null;
  _documentsFolderId = null;
  _imagesFolderId = null;
}
