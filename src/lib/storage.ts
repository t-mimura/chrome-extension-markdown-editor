export type Document = {
  id: string;
  content: string;
  updatedAt: number;
};

export type FontSize = 12 | 14 | 16 | 18 | 20;
export type Theme = 'light' | 'dark' | 'system';

export type Settings = {
  fontSize: FontSize;
  theme: Theme;
};

const DOCS_KEY = 'docs';
const SETTINGS_KEY = 'settings';

const DEFAULT_SETTINGS: Settings = {
  fontSize: 16,
  theme: 'system',
};

export function getDocTitle(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  return firstLine.replace(/^#+\s*/, '') || '無題';
}

export async function getAllDocs(): Promise<Document[]> {
  const result = await chrome.storage.local.get(DOCS_KEY);
  const docs: Record<string, Document> = result[DOCS_KEY] ?? {};
  return Object.values(docs).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDoc(id: string): Promise<Document | null> {
  const result = await chrome.storage.local.get(DOCS_KEY);
  const docs: Record<string, Document> = result[DOCS_KEY] ?? {};
  return docs[id] ?? null;
}

export async function saveDoc(doc: Document): Promise<void> {
  const result = await chrome.storage.local.get(DOCS_KEY);
  const docs: Record<string, Document> = result[DOCS_KEY] ?? {};
  docs[doc.id] = doc;
  await chrome.storage.local.set({ [DOCS_KEY]: docs });
}

export async function deleteDoc(id: string): Promise<void> {
  const result = await chrome.storage.local.get(DOCS_KEY);
  const docs: Record<string, Document> = result[DOCS_KEY] ?? {};
  delete docs[id];
  await chrome.storage.local.set({ [DOCS_KEY]: docs });
}

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function createNewDoc(): Document {
  return {
    id: crypto.randomUUID(),
    content: '',
    updatedAt: Date.now(),
  };
}
