import { esc } from './util.js';

// Agents answer in Markdown, and the board already renders it: `api.ui.markdownPreview`
// (host api 1.17) is the chat view's markdown-it renderer, raw HTML escaped and unsafe
// link schemes dropped. index.js hands it over at mount; until then, and under node,
// a message is shown escaped as it stands.
const asPlainText = (text) => `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
let render = asPlainText;

export function useMarkdownRenderer(fn) {
  render = typeof fn === 'function' ? fn : asPlainText;
}

export const markdownHtml = (text) => render(String(text ?? ''));
