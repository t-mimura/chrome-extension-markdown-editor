import { saveImage, getImage } from './storage.js';

const LOCAL_IMG_PREFIX = 'local-img://';

/** ファイルを IndexedDB に保存して Markdown 挿入用テキストを返す */
export async function storeImageFile(file: File): Promise<string> {
  const id = crypto.randomUUID();
  const data = await file.arrayBuffer();

  await saveImage({
    id,
    mimeType: file.type,
    data,
    size: data.byteLength,
    createdAt: Date.now(),
  });

  const altText = file.name.replace(/\.[^.]+$/, '');
  return `![${altText}](${LOCAL_IMG_PREFIX}${id})`;
}

// Blob URL キャッシュ: imageId → blobUrl
// セッション中は保持し続ける。毎回 IndexedDB を読み直さないためのキャッシュ。
const blobUrlCache = new Map<string, string>();

/**
 * プレビュー DOM 内の local-img:// 参照を Blob URL に置換する。
 *
 * キャッシュ済みの URL は同期で即時適用する。
 * JS は yield するまでブラウザに描画を渡さないため、innerHTML 書き換え直後に
 * src を差し替えれば「local-img:// が解決できない状態」は画面に表示されない。
 * → 大きな画像でも再レンダリング時にちらつかない。
 *
 * キャッシュにない画像だけ IndexedDB から非同期で読み込む。
 */
export async function resolveLocalImages(container: HTMLElement): Promise<void> {
  const imgs = Array.from(
    container.querySelectorAll<HTMLImageElement>(`img[src^="${LOCAL_IMG_PREFIX}"]`),
  );
  if (imgs.length === 0) return;

  const needsLoad: Array<{ img: HTMLImageElement; id: string }> = [];

  // 同期パス: キャッシュ済みは即時適用
  for (const img of imgs) {
    const id = img.getAttribute('src')!.slice(LOCAL_IMG_PREFIX.length);
    const cached = blobUrlCache.get(id);
    if (cached) {
      img.src = cached;
    } else {
      needsLoad.push({ img, id });
    }
  }

  // 非同期パス: 未キャッシュ分のみ IndexedDB から読み込む
  if (needsLoad.length === 0) return;

  await Promise.all(
    needsLoad.map(async ({ img, id }) => {
      const record = await getImage(id);
      if (record) {
        const blob = new Blob([record.data], { type: record.mimeType });
        const url = URL.createObjectURL(blob);
        blobUrlCache.set(id, url);
        img.src = url;
      } else {
        img.removeAttribute('src');
        img.alt = '[画像が見つかりません]';
        img.style.cssText =
          'display:inline-block;padding:4px 8px;border:1px dashed var(--border);color:var(--fg-muted);font-size:0.8em';
      }
    }),
  );
}

/** 指定された ID セットに含まれない Blob URL をキャッシュから削除する */
export function purgeBlobUrlCache(activeIds: Set<string>): void {
  for (const [id, url] of blobUrlCache.entries()) {
    if (!activeIds.has(id)) {
      URL.revokeObjectURL(url);
      blobUrlCache.delete(id);
    }
  }
}
