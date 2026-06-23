import type { EditorView } from '@codemirror/view';

/**
 * エディタ ↔ プレビューのスクロール同期。
 *
 * element.scrollTop への書き込みで発火する scroll イベントは非同期（次タスク）のため、
 * フラグを即座に下ろす方式だと「フラグ解除後にイベント到達→逆側が sync し直す→ループ」
 * が起きる。そこでタイマー方式を採用し、最後のスクロール発生から LOCK_MS 間は
 * 同側を起点として固定することでループを防ぐ。
 *
 * LOCK_MS の根拠:
 *   - 非同期 scroll イベントは通常 ~1-5ms 以内に発火 → これを確実に吸収する
 *   - 80ms 程度なら逆方向への切り替えにほぼ気づかない遅延
 */
export class ScrollSync {
  private lockSide: 'editor' | 'preview' | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly LOCK_MS = 80;

  constructor(
    private editorView: EditorView,
    private previewEl: HTMLElement,
  ) {}

  onEditorScroll(): void {
    if (this.lockSide === 'preview') return;
    if (!this.isSplitMode()) return;
    this.lock('editor');
    this.syncToPreview();
  }

  onPreviewScroll(): void {
    if (this.lockSide === 'editor') return;
    if (!this.isSplitMode()) return;
    this.lock('preview');
    this.syncToEditor();
  }

  private isSplitMode(): boolean {
    const editorPane = document.getElementById('editor-pane');
    const previewPane = document.getElementById('preview-pane');
    return !!editorPane && !!previewPane
      && !editorPane.classList.contains('hidden')
      && !previewPane.classList.contains('hidden');
  }

  private lock(side: 'editor' | 'preview') {
    this.lockSide = side;
    if (this.lockTimer !== null) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => {
      this.lockSide = null;
      this.lockTimer = null;
    }, ScrollSync.LOCK_MS);
  }

  private syncToPreview(): void {
    const scrollEl = this.getEditorScroller();
    if (!scrollEl) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    const ratio = scrollHeight <= clientHeight ? 0 : scrollTop / (scrollHeight - clientHeight);

    const anchors = this.previewEl.querySelectorAll<HTMLElement>('.sync-anchor');
    if (anchors.length === 0) {
      const ph = this.previewEl.scrollHeight - this.previewEl.clientHeight;
      this.previewEl.scrollTop = ratio * ph;
      return;
    }

    const topLine = this.getTopVisibleLine(scrollEl);
    this.scrollPreviewToLine(topLine, ratio);
  }

  private syncToEditor(): void {
    const { scrollTop, scrollHeight, clientHeight } = this.previewEl;
    const ratio = scrollHeight <= clientHeight ? 0 : scrollTop / (scrollHeight - clientHeight);

    const scrollEl = this.getEditorScroller();
    if (!scrollEl) return;

    const sh = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (sh <= 0) return;
    scrollEl.scrollTop = ratio * sh;
  }

  private getEditorScroller(): HTMLElement | null {
    return this.editorView.dom.querySelector('.cm-scroller') as HTMLElement | null;
  }

  private getTopVisibleLine(scrollEl: HTMLElement): number {
    const view = this.editorView;
    const rect = scrollEl.getBoundingClientRect();
    const pos = view.posAtCoords({ x: rect.left + 1, y: rect.top + 1 });
    if (pos == null) return 0;
    return view.state.doc.lineAt(pos).number - 1;
  }

  private scrollPreviewToLine(line: number, fallbackRatio: number): void {
    const anchors = this.previewEl.querySelectorAll<HTMLElement>('.sync-anchor');
    if (anchors.length === 0) {
      const ph = this.previewEl.scrollHeight - this.previewEl.clientHeight;
      this.previewEl.scrollTop = fallbackRatio * ph;
      return;
    }

    let best: HTMLElement | null = null;
    let bestLine = -1;

    for (const anchor of anchors) {
      const anchorLine = parseInt(anchor.dataset.line ?? '0', 10);
      if (anchorLine <= line && anchorLine > bestLine) {
        best = anchor;
        bestLine = anchorLine;
      }
    }

    if (best) {
      const previewRect = this.previewEl.getBoundingClientRect();
      const anchorRect = best.getBoundingClientRect();
      const relativeTop = anchorRect.top - previewRect.top + this.previewEl.scrollTop;
      this.previewEl.scrollTop = relativeTop;
    } else {
      const ph = this.previewEl.scrollHeight - this.previewEl.clientHeight;
      this.previewEl.scrollTop = fallbackRatio * ph;
    }
  }

  destroy(): void {
    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }
}
