/**
 * Google Drive API ラッパー
 *
 * 認証: OAuth 2.0 PKCE + chrome.identity.launchWebAuthFlow
 * スコープ: drive.file（拡張機能が作成したファイルのみアクセス）
 *
 * フォルダ構成:
 *   My Drive/
 *     Markdown Editor/
 *       documents/{docId}.json
 *       images/{imageId}   (バイナリ, mimeType は Drive メタデータに記録)
 */

import { getSyncSettings, saveSyncSettings } from './storage.js';
import { OAUTH_CLIENT_ID } from './config.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const FOLDER_NAME = 'Markdown Editor';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

export type DriveDocMeta = {
  updatedAt: number;
  charCount: number;
  deviceName: string;
};

export type DriveDoc = DriveDocMeta & {
  id: string;
  content: string;
};

// ── PKCE ヘルパー ─────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ── 認証 ─────────────────────────────────────────────────────────────

export function getRedirectUri(): string {
  return chrome.identity.getRedirectURL();
}

export async function authorize(): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const redirectUri = getRedirectUri();

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });

  const responseUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: `${AUTH_URL}?${params}`, interactive: true },
      (url) => {
        if (chrome.runtime.lastError || !url) {
          reject(new Error(chrome.runtime.lastError?.message ?? '認証がキャンセルされました'));
        } else {
          resolve(url);
        }
      },
    );
  });

  const code = new URL(responseUrl).searchParams.get('code');
  if (!code) throw new Error('認証コードが取得できませんでした');

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) throw new Error(`トークン取得失敗: ${tokenRes.status}`);
  const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string };

  if (!tokens.refresh_token) throw new Error('リフレッシュトークンが取得できませんでした');
  await saveSyncSettings({ refreshToken: tokens.refresh_token });

  _cachedToken = { token: tokens.access_token, expiresAt: Date.now() + 3500_000 };
}

export async function revokeAuth(): Promise<void> {
  _cachedToken = null;
  await saveSyncSettings({ refreshToken: null });
}

// ── アクセストークン管理 ──────────────────────────────────────────────

type TokenCache = { token: string; expiresAt: number };
let _cachedToken: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  if (_cachedToken && _cachedToken.expiresAt > Date.now() + 60_000) {
    return _cachedToken.token;
  }

  const { refreshToken } = await getSyncSettings();
  if (!refreshToken) throw new Error('Google Drive が未接続です');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) throw new Error(`トークンリフレッシュ失敗: ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  _cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return _cachedToken.token;
}

async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
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
  _cachedToken = null;
}
