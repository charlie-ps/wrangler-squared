import { esc } from './util.js';

// Agents answer in Markdown, so the threads render the subset they write. Every
// character is escaped before any of it is marked up, and a link only ever points
// at http(s) or mailto.

const FENCE = /^(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/;
const RULE = /^([-*_])(?:\s*\1){2,}$/;
const QUOTE = /^>\s?/;
const TABLE_SEP = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;
const ITEM = { ol: /^(\d+)[.)]\s+/, ul: /^[-*+•]\s+/ };
const URL_TEXT = String.raw`(?:https?:\/\/|mailto:)[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*`;
const LINK = new RegExp(String.raw`\[([^\]\n]+)\]\((${URL_TEXT})\)`, 'g');
const BARE_URL = new RegExp(String.raw`\bhttps?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]`, 'g');

const itemTag = (t) => ITEM.ol.test(t) ? 'ol' : ITEM.ul.test(t) ? 'ul' : null;
const startsBlock = (t, next = '') => FENCE.test(t) || HEADING.test(t) || RULE.test(t) || QUOTE.test(t) || itemTag(t) || (t.includes('|') && TABLE_SEP.test(next.trim()));
const indentOf = (line) => line.match(/^\s*/)[0].length;
const dedent = (lines) => {
  const n = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  return lines.map((l) => l.slice(Number.isFinite(n) ? n : 0));
};

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>')
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g, '<em>$1</em>')
    .replace(/(?<!\w)_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?!\w)/g, '<em>$1</em>');
}

const anchor = (href, html) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;

export function inlineHtml(text) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  const restore = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => restore(held[i]));
  const s = String(text)
    .replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`))
    .replace(LINK, (_, label, href) => hold(anchor(href, emphasis(esc(label)))))
    .replace(BARE_URL, (href) => hold(anchor(href, esc(href))));
  return restore(emphasis(esc(s)));
}

function fenceAt(lines, i) {
  const open = lines[i].trim().match(FENCE)[1];
  let end = i + 1;
  while (end < lines.length && !(lines[end].trim().startsWith(open) && /^[`~]+$/.test(lines[end].trim()))) end++;
  return { html: `<pre><code>${esc(dedent(lines.slice(i + 1, end)).join('\n'))}</code></pre>`, next: end + 1 };
}

function tableAt(lines, i) {
  const cells = (row) => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => inlineHtml(c.trim().replace(/\\\|/g, '|')));
  const head = cells(lines[i]);
  let end = i + 2;
  const rows = [];
  while (end < lines.length && lines[end].trim() && lines[end].includes('|')) rows.push(cells(lines[end++]));
  const tr = (row, tag) => `<tr>${head.map((_, k) => `<${tag}>${row[k] ?? ''}</${tag}>`).join('')}</tr>`;
  return { html: `<div class="md-table"><table><thead>${tr(head, 'th')}</thead><tbody>${rows.map((r) => tr(r, 'td')).join('')}</tbody></table></div>`, next: end };
}

function quoteAt(lines, i) {
  let end = i;
  while (end < lines.length && QUOTE.test(lines[end].trim())) end++;
  return { html: `<blockquote>${blocksHtml(lines.slice(i, end).map((l) => l.trim().replace(QUOTE, '')))}</blockquote>`, next: end };
}

// An item keeps the indented lines under it: plain ones as more lines of the item,
// or blocks of their own once they hold a nested list or code.
function itemHtml(first, rest) {
  const body = dedent(rest);
  if (body.some((l) => itemTag(l.trim()) || FENCE.test(l.trim()))) return `${inlineHtml(first)}${blocksHtml(body)}`;
  return [first, ...body.filter((l) => l.trim())].map((l) => inlineHtml(l.trim())).join('<br>');
}

function listAt(lines, i) {
  const tag = itemTag(lines[i].trim()), indent = indentOf(lines[i]);
  const start = tag === 'ol' ? Number(lines[i].trim().match(ITEM.ol)[1]) : 1;
  const items = [];
  let end = i;
  while (end < lines.length) {
    const line = lines[end], t = line.trim();
    if (t && indentOf(line) <= indent && itemTag(t) === tag) { items.push({ first: t.replace(ITEM[tag], ''), rest: [] }); end++; continue; }
    if (t && indentOf(line) > indent) { items.at(-1).rest.push(line); end++; continue; }
    if (!t) {
      let after = end;
      while (after < lines.length && !lines[after].trim()) after++;
      const n = lines[after];
      if (n !== undefined && (indentOf(n) > indent || itemTag(n.trim()) === tag)) { items.at(-1).rest.push(''); end = after; continue; }
    }
    break;
  }
  const open = tag === 'ol' && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
  return { html: `${open}${items.map((it) => `<li>${itemHtml(it.first, it.rest)}</li>`).join('')}</${tag}>`, next: end };
}

function paragraphAt(lines, i) {
  const para = [lines[i].trim()];
  let end = i + 1;
  while (end < lines.length && lines[end].trim() && !startsBlock(lines[end].trim(), lines[end + 1])) para.push(lines[end++].trim());
  return { html: `<p>${para.map(inlineHtml).join('<br>')}</p>`, next: end };
}

function blockAt(lines, i) {
  const t = lines[i].trim();
  if (FENCE.test(t)) return fenceAt(lines, i);
  const h = t.match(HEADING);
  if (h) { const level = Math.min(6, h[1].length + 3); return { html: `<h${level}>${inlineHtml(h[2])}</h${level}>`, next: i + 1 }; }
  if (RULE.test(t)) return { html: '<hr>', next: i + 1 };
  if (t.includes('|') && TABLE_SEP.test((lines[i + 1] || '').trim())) return tableAt(lines, i);
  if (QUOTE.test(t)) return quoteAt(lines, i);
  if (itemTag(t)) return listAt(lines, i);
  return paragraphAt(lines, i);
}

function blocksHtml(lines) {
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    const block = blockAt(lines, i);
    out.push(block.html);
    i = block.next;
  }
  return out.join('');
}

export function markdownHtml(text) {
  return blocksHtml(String(text ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim().split('\n'));
}
