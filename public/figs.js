import { ICONS, wranglerMark } from './icons.js';
import { proofListHtml } from './job-proof.js';
import { runningChipHtml, stoppedHtml } from './job-running.js';

// Figures drawn with the board's own markup for the Add idea composer, the proof
// checklist and the running chip, fed with example data. Thumbnails are drawn
// screenshots standing in for real proof.

// A composer at rest or with words in it (jobs-view.js changeBoxHtml markup). The
// words sit in a span, not a textarea, so a long example wraps instead of scrolling.
export const composer = (to, placeholder, hint, text = '') => `<div class="job-change${text ? ' has-text is-open' : ''}">
  <div class="job-change-row"><span class="job-change-to">${to === 'Wrangler' ? wranglerMark('small') : `<i>${to[0]}</i>`}${to}</span><span class="job-change-text${text ? '' : ' ph'}">${text || placeholder}</span><span class="job-change-attach">${ICONS.image}</span><span class="job-change-go${text ? ' on' : ''}">${ICONS.send}</span></div>
  <div class="job-change-foot"><span>${hint}</span><span>Paste or drop a screenshot</span><kbd>↵ send · ⇧↵ new line</kbd></div></div>`;

// Two drawn screenshots: the Customers table with a filter applied, and the export open in a spreadsheet.
const svgUrl = (s) => `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
const rows = (y0, n, cols) => Array.from({ length: n }, (_, i) => `<rect x="10" y="${y0 + i * 13}" width="300" height="12" fill="${i % 2 ? '#1c2128' : '#151b23'}"/>${cols.map((x, j) => `<rect x="${x}" y="${y0 + 4 + i * 13}" width="${[46, 60, 30, 38][j % 4]}" height="4" rx="2" fill="#9198a1" opacity="${j ? .55 : .85}"/>`).join('')}`).join('');
export const SHOTS = {
  'filtered.png': svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#0d1117"/><rect x="10" y="10" width="90" height="8" rx="4" fill="#f0f6fc"/><rect x="10" y="28" width="70" height="14" rx="7" fill="#4493f8" opacity=".3"/><rect x="18" y="33" width="50" height="4" rx="2" fill="#79c0ff"/><rect x="236" y="26" width="74" height="18" rx="6" fill="#1f6feb"/><rect x="248" y="33" width="50" height="4" rx="2" fill="#fff"/>${rows(54, 10, [18, 80, 170, 230])}</svg>`),
  'excel.png': svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#f6f8fa"/><rect width="320" height="22" fill="#1a7f37"/><rect x="10" y="8" width="80" height="6" rx="3" fill="#fff"/>${Array.from({ length: 12 }, (_, i) => `<line x1="0" x2="320" y1="${34 + i * 14}" y2="${34 + i * 14}" stroke="#d1d9e0"/>`).join('')}${[40, 110, 190, 250].map((x) => `<line x1="${x}" x2="${x}" y1="22" y2="200" stroke="#d1d9e0"/>`).join('')}${Array.from({ length: 11 }, (_, i) => [46, 116, 196, 256].map((x, j) => `<rect x="${x}" y="${39 + i * 14}" width="${[50, 60, 40, 44][j]}" height="4" rx="2" fill="#59636e" opacity="${i ? .55 : .95}"/>`).join('')).join('')}</svg>`),
};
// Swaps each evidence slot's placeholder glyph for its drawn screenshot.
export const withShots = (html) => html.replace(/(data-ev-file="([^"]+)"[^>]*>)<svg[\s\S]*?<\/svg>/g, (m, open, file) => SHOTS[file] ? `${open}<img alt="" src="${SHOTS[file]}">` : m);

const JOB = { id: 'csv', runs: [{ subJobId: 'csv-pr', parkedFor: 'ready', sessionId: 's1' }] };
const ITEMS = [
  { text: 'Exports only the filtered rows', shots: [{ file: 'filtered.png', url: 'http://localhost:5173/customers?plan=pro' }] },
  { text: 'Opens in Excel with the same columns', shots: [{ file: 'excel.png' }] },
  { text: 'Unit tests pass', run: { cmd: 'npm test', out: '✓ csv export (14)\n✓ filters (9)\n23 passing', exit: 0 } },
];
// `shown` is how many items have their proof so far; the rest are still to come.
export function proofFigure(shown = ITEMS.length, round = 1) {
  const sub = { id: 'csv-pr', title: 'Add CSV export', show: ITEMS.map((i) => i.text), ready: { round, checks: ITEMS.slice(0, shown).map((i) => i.text), proof: ITEMS.slice(0, shown) } };
  const list = shown ? withShots(proofListHtml(JOB, sub, { ask: false })) : `<section class="job-proof"><div class="job-proof-verdict"><b></b><small>Round ${round}</small></div><div class="job-proof-list"></div></section>`;
  const pending = ITEMS.slice(shown).map((i) => `<div class="job-proof-item plain wn-pending"><span class="job-proof-mk" aria-hidden="true">·</span><span class="t">${i.text}</span><span class="job-proof-ev"><span class="job-proof-pill">not yet</span></span></div>`).join('');
  const end = list.lastIndexOf('</div></section>');
  return `${list.slice(0, end)}${pending}${list.slice(end)}`.replace(/<b>[^<]*<\/b>/, `<b>${shown} of ${ITEMS.length} checked</b>`);
}

export const runningBar = (state = 'on') => {
  if (state === 'none') return '';
  const sub = { id: 'csv-pr', ready: { round: 1 },
    running: state === 'stopped' ? { items: [], stopped: { reason: 'you approved round 1', results: [{ name: 'web', ok: true, detail: 'process group 48121 stopped' }, { name: 'api', ok: true, detail: 'process group 48122 stopped' }] } }
      : { items: [{ name: 'web', url: 'http://localhost:5173', pid: 48121, log: 'web.log' }, { name: 'api', url: 'http://localhost:8787', pid: 48122 }] } };
  return state === 'stopped' ? stoppedHtml(sub) : runningChipHtml(sub, { open: true });
};
