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
  type Document,
  type FontSize,
  type Theme,
} from '../lib/storage.js';
import { registerTab, setTabDoc, broadcastSettingsChanged } from '../lib/messaging.js';
import { applyTheme, watchSystemTheme } from '../lib/theme.js';
import { renderMarkdown, highlightCodeBlocks } from '../lib/markdown.js';
import { ScrollSync } from '../lib/scroll-sync.js';

let currentDoc: Document | null = null;
let editorView: EditorView | null = null;
let scrollSync: ScrollSync | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let previewVisible = true;
let stopWatchSystem: (() => void) | null = null;
let currentSettings = { fontSize: 16 as FontSize, theme: 'system' as Theme };

const SAVE_DEBOUNCE_MS = 400;

// 2ペイン表示アイコン: Material Symbols / view_column_2
const ICON_SPLIT =
  `<svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 -960 960 960" width="18" fill="currentColor" aria-hidden="true">` +
  `<path d="M600-120q-33 0-56.5-23.5T520-200v-560q0-33 23.5-56.5T600-840h160q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H600Zm0-640v560h160v-560H600ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h160q33 0 56.5 23.5T440-760v560q0 33-23.5 56.5T360-120H200Zm0-640v560h160v-560H200Zm560 0H600h160Zm-400 0H200h160Z"/>` +
  `</svg>`;

// 1ペイン表示アイコン: Material Symbols / crop_landscape
const ICON_SINGLE =
  `<svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 -960 960 960" width="18" fill="currentColor" aria-hidden="true">` +
  `<path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-480H160v480Zm0 0v-480 480Z"/>` +
  `</svg>`;

async function init() {
  const params = new URLSearchParams(window.location.search);
  const docId = params.get('docId');
  const isNew = params.get('new') === '1';

  const settings = await getSettings();
  currentSettings = { ...settings };
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
      currentDoc = { ...createNewDoc(), id: docId };
      await saveDoc(currentDoc);
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
  renderPreview(currentDoc.content);
  setupSplitter();
  setupToolbar();
  setupHelpModal();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_CHANGED') {
      currentSettings = { ...msg.settings };
      applyFontSize(msg.settings.fontSize);
      applyTheme(msg.settings.theme);
      (document.getElementById('font-size-select') as HTMLSelectElement).value = String(msg.settings.fontSize);
      (document.getElementById('theme-select') as HTMLSelectElement).value = msg.settings.theme;
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
    renderPreview(content);
  }, SAVE_DEBOUNCE_MS);
}

function renderPreview(content: string) {
  const previewEl = document.getElementById('preview-content')!;
  previewEl.innerHTML = renderMarkdown(content);
  highlightCodeBlocks(previewEl);
}

function updateTitle() {
  const title = currentDoc ? getDocTitle(currentDoc.content) : '無題';
  document.title = `${title} — Markdown Editor`;
  document.getElementById('doc-title')!.textContent = title;
}

function applyFontSize(size: FontSize) {
  document.documentElement.style.setProperty('--font-size', `${size}px`);
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

function setPreviewButtonIcon(btn: HTMLElement, showing: boolean) {
  btn.innerHTML = showing ? ICON_SPLIT : ICON_SINGLE;
  btn.title = showing ? 'プレビューを非表示' : 'プレビューを表示';
  btn.setAttribute('aria-label', btn.title);
}

function setupToolbar() {
  const fontSizeSelect = document.getElementById('font-size-select') as HTMLSelectElement;
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const btnTogglePreview = document.getElementById('btn-toggle-preview')!;

  setPreviewButtonIcon(btnTogglePreview, true);

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

  btnTogglePreview.addEventListener('click', () => {
    previewVisible = !previewVisible;
    const previewPane = document.getElementById('preview-pane')!;
    const splitterEl = document.getElementById('splitter')!;
    const editorPane = document.getElementById('editor-pane')!;

    if (previewVisible) {
      previewPane.classList.remove('hidden');
      splitterEl.classList.remove('hidden');
      editorPane.style.flex = '';
    } else {
      previewPane.classList.add('hidden');
      splitterEl.classList.add('hidden');
      editorPane.style.flex = '1';
    }
    setPreviewButtonIcon(btnTogglePreview, previewVisible);
    editorView?.requestMeasure();
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
