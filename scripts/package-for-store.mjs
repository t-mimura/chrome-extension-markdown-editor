/**
 * Chrome Web Store 提出用 zip を作成するスクリプト。
 *
 * - dist/ をそのまま使い、manifest.json から key フィールドを除いた
 *   extension-store.zip を生成する。
 * - ローカル開発用の dist/manifest.json は変更しない。
 */

import { readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const STORE_DIR = 'dist-store';
const OUT_ZIP  = 'extension-store.zip';

// 1. まず通常ビルド
console.log('Building...');
execSync('npm run build', { stdio: 'inherit' });

// 2. dist/ を一時ディレクトリにコピー
if (existsSync(STORE_DIR)) rmSync(STORE_DIR, { recursive: true });
cpSync('dist', STORE_DIR, { recursive: true });

// 3. manifest.json から key フィールドを削除
const manifestPath = `${STORE_DIR}/manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
if ('key' in manifest) {
  delete manifest.key;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('✓ key field removed from manifest.json');
} else {
  console.log('  key field not found, skipping');
}

// 4. zip 作成
if (existsSync(OUT_ZIP)) rmSync(OUT_ZIP);
execSync(`cd ${STORE_DIR} && zip -r ../${OUT_ZIP} .`, { stdio: 'inherit' });

// 5. 一時ディレクトリを削除
rmSync(STORE_DIR, { recursive: true });

console.log(`\n✓ ${OUT_ZIP} created`);
console.log('\n次のステップ:');
console.log('  1. extension-store.zip を Chrome Web Store にアップロード');
console.log('  2. Developer Dashboard で新しい拡張機能 ID を確認');
console.log('  3. Google Cloud Console の OAuth クライアントのアイテム ID を更新');
