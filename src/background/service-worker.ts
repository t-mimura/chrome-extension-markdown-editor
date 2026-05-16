import type { Message, OpenDocsResponse } from '../lib/messaging.js';
import type { Settings } from '../lib/storage.js';

const tabDocMap = new Map<number, string>();
const registeredTabs = new Set<number>();

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('landing.html') });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const hadDoc = tabDocMap.has(tabId);
  tabDocMap.delete(tabId);
  registeredTabs.delete(tabId);
  if (hadDoc) {
    broadcastOpenDocsChanged(tabId);
  }
});

chrome.runtime.onMessage.addListener(
  (msg: Message, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    switch (msg.type) {
      case 'REGISTER_TAB':
        if (tabId != null) {
          const hadDoc = tabDocMap.has(tabId);
          registeredTabs.add(tabId);
          tabDocMap.delete(tabId);
          if (hadDoc) {
            broadcastOpenDocsChanged(tabId); // editor → landing に戻った場合に他タブへ通知
          }
        }
        sendResponse(null);
        break;

      case 'SET_TAB_DOC':
        if (tabId != null) {
          tabDocMap.set(tabId, msg.docId);
          broadcastOpenDocsChanged(tabId); // 他の landing タブに通知
        }
        sendResponse(null);
        break;

      case 'GET_OPEN_DOCS': {
        const result: OpenDocsResponse = {};
        for (const [tid, docId] of tabDocMap.entries()) {
          result[docId] = tid;
        }
        sendResponse(result);
        break;
      }

      case 'SETTINGS_CHANGED':
        broadcastSettingsToTabs(msg.settings, tabId);
        sendResponse(null);
        break;

      case 'FOCUS_TAB':
        chrome.tabs.update(msg.tabId, { active: true });
        chrome.tabs.get(msg.tabId, (tab) => {
          if (tab.windowId != null) {
            chrome.windows.update(tab.windowId, { focused: true });
          }
        });
        sendResponse(null);
        break;

      case 'OPEN_DOCS_CHANGED':
        sendResponse(null);
        break;
    }

    return true;
  }
);

function broadcastSettingsToTabs(settings: Settings, excludeTabId: number | undefined) {
  for (const tabId of registeredTabs) {
    if (tabId !== excludeTabId) {
      chrome.tabs.sendMessage(tabId, { type: 'SETTINGS_CHANGED', settings }).catch(() => {
        registeredTabs.delete(tabId);
      });
    }
  }
}

function broadcastOpenDocsChanged(excludeTabId: number | undefined) {
  for (const tabId of registeredTabs) {
    if (tabId !== excludeTabId) {
      chrome.tabs.sendMessage(tabId, { type: 'OPEN_DOCS_CHANGED' }).catch(() => {
        registeredTabs.delete(tabId);
      });
    }
  }
}
