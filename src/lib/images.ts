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

// Blob URL のライフサイクル管理
const activeBlobUrls: string[] = [];

export function revokeAllBlobUrls(): void {
  for (const url of activeBlobUrls) {
    URL.revokeObjectURL(url);
  }
  activeBlobUrls.length = 0;
}

/**
 * プレビュー DOM 内の local-img:// 参照を Blob URL に置換する。
 * 再レンダリング前に revokeAllBlobUrls() を呼ぶこと。
 */
export async function resolveLocalImages(container: HTMLElement): Promise<void> {
  const imgs = container.querySelectorAll<HTMLImageElement>(
    `img[src^="${LOCAL_IMG_PREFIX}"]`,
  );
  if (imgs.length === 0) return;

  await Promise.all(
    Array.from(imgs).map(async (img) => {
      const id = img.getAttribute('src')!.slice(LOCAL_IMG_PREFIX.length);
      const record = await getImage(id);
      if (record) {
        const blob = new Blob([record.data], { type: record.mimeType });
        const url = URL.createObjectURL(blob);
        activeBlobUrls.push(url);
        img.src = url;
      } else {
        img.removeAttribute('src');
        img.alt = `[画像が見つかりません]`;
        img.style.cssText =
          'display:inline-block;padding:4px 8px;border:1px dashed var(--border);color:var(--fg-muted);font-size:0.8em';
      }
    }),
  );
}
