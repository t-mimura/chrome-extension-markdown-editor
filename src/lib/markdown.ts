import { marked } from 'marked';
import hljs from 'highlight.js';

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // listitem は上書きせず、デフォルトの動作（class="task-list-item" 付与 + checkbox() 呼び出し）に任せる。
    // ここだけ上書きすることでチェックボックスの表示を制御し、二重描画を防ぐ。
    checkbox({ checked }: { checked: boolean }): string {
      if (checked) {
        return '<span class="task-check task-checked">✓</span>';
      }
      return '<span class="task-check task-unchecked"></span>';
    },
  },
});

export function renderMarkdown(content: string): string {
  const tokens = marked.lexer(content);

  let lineNum = 0;
  let html = '';

  for (const token of tokens) {
    const startLine = lineNum;
    if (token.raw) {
      lineNum += token.raw.split('\n').length - 1;
    }

    const anchor = `<span class="sync-anchor" data-line="${startLine}"></span>`;
    const rendered = marked.parser([token]) as string;
    html += anchor + rendered;
  }

  return html;
}

export function highlightCodeBlocks(container: HTMLElement): void {
  container.querySelectorAll('pre code').forEach((block) => {
    const el = block as HTMLElement;
    if (el.getAttribute('data-highlighted') === 'yes') return;

    const lang = [...el.classList]
      .find((c) => c.startsWith('language-'))
      ?.replace('language-', '');

    try {
      if (lang && hljs.getLanguage(lang)) {
        hljs.highlightElement(el);
      } else {
        const result = hljs.highlightAuto(el.textContent ?? '');
        el.innerHTML = result.value;
      }
    } catch {
      // ignore highlight errors
    }
  });
}
