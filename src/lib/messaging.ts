import type { Settings } from './storage.js';

export type Message =
  | { type: 'REGISTER_TAB' }
  | { type: 'SET_TAB_DOC'; docId: string }
  | { type: 'GET_OPEN_DOCS' }
  | { type: 'SETTINGS_CHANGED'; settings: Settings }
  | { type: 'FOCUS_TAB'; tabId: number }
  | { type: 'OPEN_DOCS_CHANGED' };

export type OpenDocsResponse = Record<string, number>;

export async function sendToServiceWorker(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

export async function getOpenDocs(): Promise<OpenDocsResponse> {
  return sendToServiceWorker({ type: 'GET_OPEN_DOCS' }) as Promise<OpenDocsResponse>;
}

export async function registerTab(): Promise<void> {
  await sendToServiceWorker({ type: 'REGISTER_TAB' });
}

export async function setTabDoc(docId: string): Promise<void> {
  await sendToServiceWorker({ type: 'SET_TAB_DOC', docId });
}

export async function broadcastSettingsChanged(settings: Settings): Promise<void> {
  await sendToServiceWorker({ type: 'SETTINGS_CHANGED', settings });
}

export async function focusTab(tabId: number): Promise<void> {
  await sendToServiceWorker({ type: 'FOCUS_TAB', tabId });
}
