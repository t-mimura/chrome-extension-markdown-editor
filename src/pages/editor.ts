import 'highlight.js/styles/github.min.css';
import { EditorView, keymap, scrollPastEnd, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import { defaultKeymap, historyKeymap, history, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

import {
  getDoc,
  saveDoc,
  getDocTitle,
  getSettings,
  saveSettings,
  createNewDoc,
  migrateFromChromeStorage,
  type Document,
  type FontSize,
  type Theme,
  type ViewMode,
} from '../lib/storage.js';
import { registerTab, setTabDoc, broadcastSettingsChanged } from '../lib/messaging.js';
import { applyTheme, watchSystemTheme } from '../lib/theme.js';
import { renderMarkdown, highlightCodeBlocks } from '../lib/markdown.js';
import { ScrollSync } from '../lib/scroll-sync.js';
import { storeImageFile, resolveLocalImages } from '../lib/images.js';
import { scheduleAutoSync, onSyncStatusChange, getSyncStatus } from '../lib/sync.js';

let currentDoc: Document | null = null;
let editorView: EditorView | null = null;
let scrollSync: ScrollSync | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let viewMode: ViewMode = 'split';
let stopWatchSystem: (() => void) | null = null;
let currentSettings = { fontSize: 16 as FontSize, theme: 'system' as Theme, viewMode: 'split' as ViewMode };

const SAVE_DEBOUNCE_MS = 400;

async function init() {
  await migrateFromChromeStorage();

  const params = new URLSearchParams(window.location.search);
  const docId = params.get('docId');
  const isNew = params.get('new') === '1';

  const settings = await getSettings();
  currentSettings = { ...settings };
  viewMode = settings.viewMode;
  applyFontSize(settings.fontSize);
  applyTheme(settings.theme);
  stopWatchSystem = watchSystemTheme(settings.theme, (resolved) => {
    document.documentElement.setAttribute('data-theme', resolved);
    rebuildEditor();
  });

  (document.getElementById('font-size-select') as HTMLSelectElement).value = String(settings.fontSize);
  (document.getElementById('theme-select') as HTMLSelectElement).value = settings.theme;

  await registerTab().catch(() => {});

  if (docId) {
    if (isNew) {
      currentDoc = await getDoc(docId);
      if (!currentDoc) {
        currentDoc = { ...createNewDoc(), id: docId };
        await saveDoc(currentDoc);
      }
    } else {
      currentDoc = await getDoc(docId);
    }
  }

  if (!currentDoc) {
    currentDoc = createNewDoc();
    await saveDoc(currentDoc);
    const url = new URL(window.location.href);
    url.searchParams.set('docId', currentDoc.id);
    window.history.replaceState({}, '', url.toString());
  }

  await setTabDoc(currentDoc.id).catch(() => {});
  updateTitle();

  // プレビューの scroll リスナーは init で一度だけ登録（buildEditor が複数回呼ばれても重複しない）
  const previewEl = document.getElementById('preview-content')!;
  previewEl.addEventListener('scroll', () => scrollSync?.onPreviewScroll(), { passive: true });

  buildEditor(currentDoc.content);
  await renderPreview(currentDoc.content);
  setupSplitter();
  setupToolbar();
  applyViewMode(viewMode);
  setupHelpModal();
  setupImageDrop();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_CHANGED') {
      currentSettings = { ...msg.settings };
      viewMode = msg.settings.viewMode;
      applyFontSize(msg.settings.fontSize);
      applyTheme(msg.settings.theme);
      applyViewMode(viewMode);
      (document.getElementById('font-size-select') as HTMLSelectElement).value = String(msg.settings.fontSize);
      (document.getElementById('theme-select') as HTMLSelectElement).value = msg.settings.theme;
      applyViewMode(msg.settings.viewMode);
      stopWatchSystem?.();
      stopWatchSystem = watchSystemTheme(msg.settings.theme, (resolved) => {
        document.documentElement.setAttribute('data-theme', resolved);
        rebuildEditor();
      });
      rebuildEditor();
    }
  });
}

function buildEditor(content: string) {
  const container = document.getElementById('codemirror-container')!;
  container.innerHTML = '';

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const themeExt = isDark ? oneDark : EditorView.theme({}, { dark: false });

  const state = EditorState.create({
    doc: content,
    extensions: [
      history(),
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      markdown(),
      themeExt,
      scrollPastEnd(),
      EditorView.lineWrapping,
      keymap.of([
        // リスト専用の Tab/Shift-Tab を最優先に。非リスト行では false を返すので indentWithTab に fallthrough する
        { key: 'Tab', run: indentListItem },
        { key: 'Shift-Tab', run: outdentListItem },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
        { key: 'Mod-b', run: wrapWith('**', '**') },
        { key: 'Mod-i', run: wrapWith('*', '*') },
        { key: 'Mod-k', run: insertLink },
        { key: 'Mod-Shift-h', run: insertHeading },
        { key: 'Mod-Shift-c', run: insertCodeBlock },
        { key: 'Mod-Shift-l', run: insertList },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onEditorChange(update.view.state.doc.toString());
        }
      }),
    ],
  });

  if (editorView) {
    editorView.destroy();
  }
  editorView = new EditorView({ state, parent: container });

  // エディタの .cm-scroller は rebuild のたびに新しい要素になるのでここで登録
  const scroller = container.querySelector('.cm-scroller') as HTMLElement | null;
  if (scroller) {
    scroller.addEventListener('scroll', () => scrollSync?.onEditorScroll(), { passive: true });
  }

  const previewEl = document.getElementById('preview-content')!;
  scrollSync?.destroy();
  scrollSync = new ScrollSync(editorView, previewEl);
}

function rebuildEditor() {
  if (!editorView) return;
  const content = editorView.state.doc.toString();
  buildEditor(content);
}

function onEditorChange(content: string) {
  if (!currentDoc) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    currentDoc = { ...currentDoc!, content, updatedAt: Date.now() };
    await saveDoc(currentDoc);
    updateTitle();
    await renderPreview(content);
    scheduleAutoSync(); // ローカル保存後 15 秒で Drive へ自動同期
  }, SAVE_DEBOUNCE_MS);
}

async function renderPreview(content: string) {
  const previewEl = document.getElementById('preview-content')!;
  previewEl.innerHTML = renderMarkdown(content);
  highlightCodeBlocks(previewEl);
  await resolveLocalImages(previewEl); // キャッシュ済み画像は同期で即時適用されるためちらつかない
}

function updateTitle() {
  const title = currentDoc ? getDocTitle(currentDoc.content) : '無題';
  document.title = `${title} — Markdown Editor`;
  document.getElementById('doc-title')!.textContent = title;
}

function applyFontSize(size: FontSize) {
  document.documentElement.style.setProperty('--font-size', `${size}px`);
}

function applyViewMode(mode: ViewMode) {
  viewMode = mode;
  const previewPane = document.getElementById('preview-pane')!;
  const splitterEl = document.getElementById('splitter')!;
  const editorPane = document.getElementById('editor-pane')!;
  const btnImage = document.getElementById('btn-insert-image') as HTMLButtonElement | null;

  const showEditor = mode === 'editor' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';
  const showSplitter = mode === 'split';

  editorPane.classList.toggle('hidden', !showEditor);
  previewPane.classList.toggle('hidden', !showPreview);
  splitterEl.classList.toggle('hidden', !showSplitter);

  if (mode === 'editor') {
    editorPane.style.flex = '1';
  } else if (mode === 'preview') {
    previewPane.style.flex = '1';
    editorPane.style.flex = '';
  } else {
    editorPane.style.flex = '';
    previewPane.style.flex = '';
  }

  if (btnImage) {
    btnImage.disabled = mode === 'preview';
    btnImage.title = mode === 'preview' ? 'プレビューモードでは画像を挿入できません' : '画像を挿入';
  }

  document.querySelectorAll<HTMLButtonElement>('.segment-btn').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('segment-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  editorView?.requestMeasure();
}

function setupSplitter() {
  const splitter = document.getElementById('splitter')!;
  const editorPane = document.getElementById('editor-pane')!;
  const previewPane = document.getElementById('preview-pane')!;
  const body = document.getElementById('editor-body')!;

  let dragging = false;
  let startX = 0;
  let startEditorWidth = 0;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startEditorWidth = editorPane.getBoundingClientRect().width;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const splitterWidth = splitter.offsetWidth;
    const totalWidth = body.getBoundingClientRect().width - splitterWidth;
    const delta = e.clientX - startX;
    const newEditorWidth = Math.max(200, Math.min(totalWidth - 200, startEditorWidth + delta));
    const ratio = (newEditorWidth / totalWidth) * 100;
    editorPane.style.flex = `0 0 ${ratio}%`;
    previewPane.style.flex = `0 0 ${100 - ratio}%`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

function setupToolbar() {
  const fontSizeSelect = document.getElementById('font-size-select') as HTMLSelectElement;
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const syncStatusEl = document.getElementById('sync-status');

  if (syncStatusEl) {
    const labels: Record<string, string> = {
      idle: '同期済み', syncing: '同期中...', error: '同期エラー', conflict: '競合あり',
    };
    const updateSync = (s: ReturnType<typeof getSyncStatus>) => {
      syncStatusEl.className = `sync-status sync-${s}`;
      syncStatusEl.title = labels[s] ?? '';
    };
    updateSync(getSyncStatus());
    onSyncStatusChange(updateSync);
  }

  fontSizeSelect.addEventListener('change', async () => {
    const newFontSize = parseInt(fontSizeSelect.value, 10) as FontSize;
    currentSettings.fontSize = newFontSize;
    applyFontSize(newFontSize);
    await saveSettings({ ...currentSettings });
    await broadcastSettingsChanged({ ...currentSettings }).catch(() => {});
  });

  themeSelect.addEventListener('change', async () => {
    const newTheme = themeSelect.value as Theme;
    currentSettings.theme = newTheme;
    stopWatchSystem?.();
    applyTheme(newTheme);
    stopWatchSystem = watchSystemTheme(newTheme, (resolved) => {
      document.documentElement.setAttribute('data-theme', resolved);
      rebuildEditor();
    });
    rebuildEditor();
    await saveSettings({ ...currentSettings });
    await broadcastSettingsChanged({ ...currentSettings }).catch(() => {});
  });

  document.querySelectorAll<HTMLButtonElement>('.segment-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode as ViewMode;
      if (!mode || mode === viewMode) return;
      currentSettings.viewMode = mode;
      applyViewMode(mode);
      await saveSettings({ ...currentSettings });
      await broadcastSettingsChanged({ ...currentSettings }).catch(() => {});
    });
  });
}

function setupHelpModal() {
  const modal = document.getElementById('help-modal')!;
  const btnHelp = document.getElementById('btn-help')!;
  const btnClose = document.getElementById('btn-help-close')!;

  btnHelp.addEventListener('click', () => modal.classList.remove('hidden'));
  btnClose.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') modal.classList.add('hidden');
  });
}

// ── 画像挿入 ──────────────────────────────────────────────────────────

async function insertImageMarkdown(markdown: string) {
  if (!editorView) return;
  const { state, dispatch } = editorView;
  const range = state.selection.main;
  dispatch(state.update({
    changes: { from: range.from, to: range.to, insert: markdown },
    selection: EditorSelection.cursor(range.from + markdown.length),
  }, { scrollIntoView: true, userEvent: 'input' }));
}

function setupImageDrop() {
  const editorPane = document.getElementById('editor-pane')!;

  editorPane.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    editorPane.classList.add('drag-over');
  });

  editorPane.addEventListener('dragleave', (e) => {
    if (!editorPane.contains(e.relatedTarget as Node)) {
      editorPane.classList.remove('drag-over');
    }
  });

  editorPane.addEventListener('drop', async (e) => {
    e.preventDefault();
    editorPane.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer?.files ?? []).filter(
      (f) => f.type.startsWith('image/'),
    );
    for (const file of files) {
      const md = await storeImageFile(file);
      await insertImageMarkdown(md);
    }
  });

  // ツールバーボタンからのファイル選択
  const btnImage = document.getElementById('btn-insert-image');
  if (!btnImage) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;

  btnImage.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    for (const file of Array.from(input.files ?? [])) {
      const md = await storeImageFile(file);
      await insertImageMarkdown(md);
    }
    input.value = '';
  });
}

// Keybinding helpers

function wrapWith(before: string, after: string) {
  return (view: EditorView): boolean => {
    const { state, dispatch } = view;
    const tr = state.changeByRange((range) => {
      if (range.empty) {
        return {
          changes: { from: range.from, insert: before + after },
          range: EditorSelection.cursor(range.from + before.length),
        };
      }
      const selected = state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: `${before}${selected}${after}` },
        range: EditorSelection.range(
          range.from + before.length,
          range.from + before.length + selected.length,
        ),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

function insertLink(view: EditorView): boolean {
  const { state, dispatch } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const linkText = selected || 'リンクテキスト';
  const insert = `[${linkText}](url)`;
  const urlStart = range.from + linkText.length + 3;
  dispatch(state.update({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + 3),
  }, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

function insertHeading(view: EditorView): boolean {
  const { state, dispatch } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);

  if (line.text.startsWith('# ')) {
    dispatch(state.update({
      changes: { from: line.from, to: line.from + 2, insert: '' },
    }, { scrollIntoView: true, userEvent: 'input' }));
  } else {
    dispatch(state.update({
      changes: { from: line.from, insert: '# ' },
    }, { scrollIntoView: true, userEvent: 'input' }));
  }
  return true;
}

function insertCodeBlock(view: EditorView): boolean {
  const { state, dispatch } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);

  if (selected) {
    dispatch(state.update({
      changes: { from: range.from, to: range.to, insert: `\`\`\`\n${selected}\n\`\`\`\n` },
    }, { scrollIntoView: true, userEvent: 'input' }));
  } else {
    const insert = '```\n\n```\n';
    dispatch(state.update({
      changes: { from: range.from, insert },
      selection: EditorSelection.cursor(range.from + 4),
    }, { scrollIntoView: true, userEvent: 'input' }));
  }
  return true;
}

function insertList(view: EditorView): boolean {
  const { state, dispatch } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);

  if (line.text.startsWith('- ')) {
    dispatch(state.update({
      changes: { from: line.from, to: line.from + 2, insert: '' },
    }, { scrollIntoView: true, userEvent: 'input' }));
  } else {
    dispatch(state.update({
      changes: { from: line.from, insert: '- ' },
    }, { scrollIntoView: true, userEvent: 'input' }));
  }
  return true;
}

function listIndentSize(_listMarker: string): number {
  return 4;
}

function indentListItem(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const match = line.text.match(/^(\s*)([-*+]|\d+\.)\s/);
  if (!match) return false;

  const indent = ' '.repeat(listIndentSize(match[2]));
  view.dispatch(state.update({
    changes: { from: line.from, insert: indent },
  }, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

function outdentListItem(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const match = line.text.match(/^(\s+)([-*+]|\d+\.)\s/);
  if (!match) return false;

  const removeCount = Math.min(listIndentSize(match[2]), match[1].length);
  view.dispatch(state.update({
    changes: { from: line.from, to: line.from + removeCount, insert: '' },
  }, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

init().catch(console.error);
