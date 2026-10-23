import { esc } from './util.js';
import { ICONS } from './icons.js';

// What an agent showed at the Code checkpoint (server/job-evidence.js): per
// Show me item a screenshot, a command's output or an honest "could not", kept
// on the sub-job's `ready` receipt as `ready.proof` and, in files, in the
// extension's own store. Nothing serves that store to a browser
// (TODO(host-api files:serve)), so thumbnails and opened files arrive as
// `job-evidence` frames and live in an `EvidenceCache` for the life of the view.
// Every string here is agent-written: it only ever reaches the page through esc().

export const showOf = (sub) => (Array.isArray(sub?.show) ? sub.show : []);
// Mirrors server/jobs-schema.js showKey.
const key = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
export const MAX_FILM = 3;

// Proof in the order the plan asked for it, then whatever else the agent chose to
// attach. A receipt from before proof existed has none, and the step reads as it
// always did.
export function proofItems(sub) {
  const proof = Array.isArray(sub?.ready?.proof) ? sub.ready.proof : [];
  const order = showOf(sub).map(key);
  const rank = (p) => { const i = order.indexOf(key(p.text)); return i < 0 ? order.length : i; };
  return proof.map((p, n) => ({ p, n })).sort((a, b) => rank(a.p) - rank(b.p) || a.n - b.n).map(({ p }) => p);
}
export const hasProof = (sub) => proofItems(sub).length > 0;
export const proofRound = (sub) => sub?.ready?.round || 1;
export function proofSummary(sub) {
  const items = proofItems(sub), gaps = items.filter((p) => p.couldNot).length;
  return { total: items.length, gaps, shown: items.length - gaps, round: proofRound(sub) };
}
export const summaryText = (s) => `${s.shown} of ${s.total} shown${s.gaps ? ` · ${s.gaps} couldn’t` : ''}`;
// Checks the agent listed without proof, as the plain list this step always showed.
export const alsoChecked = (sub) => {
  const proven = new Set(proofItems(sub).map((p) => p.text));
  return (sub?.ready?.checks || []).filter((t) => !proven.has(t));
};
// One file named twice in a check is one shot: the schema does not stop an agent
// listing it again, and the server keeps both names.
export const shotsOf = (p) => (Array.isArray(p?.shots) ? p.shots.filter((s, k, all) => all.findIndex((t) => t.file === s.file) === k) : []);
// The files of a sub-job's current round, in grid order: what the board asks the
// server to thumbnail, and what the plate's filmstrip draws first.
export const filmFiles = (sub, n = MAX_FILM) => proofItems(sub).flatMap((p) => shotsOf(p).map((s) => s.file)).filter((f, k, all) => all.indexOf(f) === k).slice(0, n);

export class EvidenceCache {
  constructor() { this.thumbs = new Map(); this.full = new Map(); this.asked = new Set(); }
  static key(jobId, subId, round, file) { return `${jobId}/${subId}/${round}/${file}`; }
  // One frame is a round's thumbnails, or one full file.
  note(msg) {
    if (!msg?.jobId || !msg.subJobId) return;
    for (const t of msg.thumbs || []) if (t.dataBase64) this.thumbs.set(EvidenceCache.key(msg.jobId, msg.subJobId, msg.round, t.file), t);
    if (msg.file && msg.dataBase64) this.full.set(EvidenceCache.key(msg.jobId, msg.subJobId, msg.round, msg.file), msg);
  }
  thumb(jobId, subId, round, file) { return this.thumbs.get(EvidenceCache.key(jobId, subId, round, file)) || null; }
  open(jobId, subId, round, file) { return this.full.get(EvidenceCache.key(jobId, subId, round, file)) || null; }
  // True once per request, so a tick's redraw never asks twice.
  first(token) { if (this.asked.has(token)) return false; this.asked.add(token); return true; }
}

const dataUrl = (g) => `data:${g.mime};base64,${g.dataBase64}`;
const isVideo = (f) => /\.webm$/i.test(f || '');
const ctxAttrs = (job, sub, file) => `data-ev-job="${esc(job.id)}" data-ev-sub="${esc(sub.id)}" data-ev-round="${proofRound(sub)}" data-ev-file="${esc(file)}"`;

// A thumbnail slot. Its markup is a placeholder the view fills from the cache
// (`hydrateEvidence`), the way job images are, so a redraw never loses a picture.
// A file of a given round, not necessarily the sub-job's current one: a thread
// message carries the round it was sent in.
export const roundThumbHtml = (job, sub, round, file, cls = '') => `<span class="job-proof-thumb ${cls} ${isVideo(file) ? 'video' : ''}" data-ev-job="${esc(job.id)}" data-ev-sub="${esc(sub.id)}" data-ev-round="${Number(round) || 1}" data-ev-file="${esc(file)}">${isVideo(file) ? ICONS.play : ICONS.eye}</span>`;
// A thread or earlier-round thumbnail that opens its group full size: the group
// is its `.job-msg-att` row, so the viewer steps through the shots of one message.
export const shotButtonHtml = (job, sub, round, file, k) => `<button type="button" class="job-shot-open" data-shot-at="${k}" title="Open full size" aria-label="Open shot ${k + 1} full size">${roundThumbHtml(job, sub, round, file)}</button>`;
export const thumbHtml = (job, sub, file, cls = '') => `<span class="job-proof-thumb ${cls} ${isVideo(file) ? 'video' : ''}" ${ctxAttrs(job, sub, file)}>${isVideo(file) ? ICONS.play : ICONS.eye}</span>`;
const termHtml = (run, cls = '') => `<span class="job-proof-thumb term ${cls}"><span class="job-proof-term"><i>$</i> ${esc(run.cmd)}\n${esc(String(run.out || '').split('\n').slice(0, 5).join('\n'))}</span></span>`;
function mediaHtml(job, sub, p, j = 0) {
  if (p.couldNot) return `<span class="job-proof-thumb gap">${ICONS.info}</span>`;
  const shot = shotsOf(p)[j];
  if (shot) return thumbHtml(job, sub, shot.file);
  if (p.run) return termHtml(p.run);
  return `<span class="job-proof-thumb gap">${ICONS.info}</span>`;
}
// One file at full size once it has come, its thumbnail blurred until then, else a placeholder.
function fullMedia(job, sub, round, file, alt, cache) {
  const got = cache.open(job.id, sub.id, round, file), thumb = cache.thumb(job.id, sub.id, round, file);
  return got ? (isVideo(file) ? `<video class="job-proof-full" controls src="${dataUrl(got)}"></video>` : `<img class="job-proof-full" alt="${esc(alt)}" src="${dataUrl(got)}">`)
    : thumb ? `<img class="job-proof-full soft" alt="${esc(alt)}" src="${dataUrl(thumb)}">` : `<span class="job-proof-thumb big ${isVideo(file) ? 'video' : ''}">${ICONS.eye}</span>`;
}
// The review step's one list: a verdict that counts
// every check, then each Show me item with its evidence at the end of its row,
// opened in place for the full output, every shot and Ask; plain checks follow
// as ordinary rows. `isOpen(key)` is the view's memory of which rows are open.
export function verdictOf(sub) {
  const s = proofSummary(sub), also = alsoChecked(sub).length;
  return { ...s, checked: s.shown + also, all: s.total + also };
}
export const verdictText = (v) => `${v.checked} of ${v.all} checked${v.gaps ? ` · ${v.gaps} couldn’t show` : ''}`;
const firstSentence = (t) => { const m = String(t).match(/^.*?[.!?](?=\s|$)/); return m ? m[0] : String(t); };
const mark = (p) => `<span class="job-proof-mk" aria-hidden="true">${p.couldNot ? '!' : '✓'}</span>`;
function rowEvidence(job, sub, p) {
  if (p.couldNot) return '<span class="job-proof-pill gap">couldn’t</span>';
  const shots = shotsOf(p);
  if (shots.length) return `${thumbHtml(job, sub, shots[0].file, 'mini')}${shots.length > 1 ? `<small>+${shots.length - 1}</small>` : ''}`;
  if (p.run) return `<span class="job-proof-pill ${p.run.exit === 0 ? '' : 'bad'}">exit ${esc(p.run.exit)}</span>`;
  return '';
}
function rowDetail(job, sub, p, i, ask) {
  const why = p.couldNot && firstSentence(p.couldNot) !== String(p.couldNot).trim() ? `<p class="gap">${esc(p.couldNot)}</p>` : '';
  const shots = shotsOf(p).map((s, k) => `<button type="button" class="job-proof-shot" data-proof="${i}" data-proof-at="${k}" title="Open full size">${thumbHtml(job, sub, s.file)}<small>${esc([String(s.url || '').replace(/^https?:\/\//i, ''), s.viewport].filter(Boolean).join(' · '))}</small></button>`).join('');
  const run = !shotsOf(p).length && p.run ? `<pre class="job-proof-run"><i>$</i> ${esc(p.run.cmd)}\n${esc(p.run.out)}\n<b class="${p.run.exit === 0 ? 'ok' : 'bad'}">exit ${esc(p.run.exit)}</b></pre>` : '';
  const button = ask ? `<button type="button" data-proof-ask="${i}">${ICONS.edit}${p.couldNot ? 'Ask it to try another way' : 'Ask about this'}</button>` : '';
  return `${why}${p.note ? `<p>${esc(p.note)}</p>` : ''}${shots ? `<div class="job-proof-shots-open">${shots}</div>` : ''}${run}${button ? `<div class="job-proof-ask">${button}</div>` : ''}`;
}
export function proofListHtml(job, sub, { isOpen = () => false, ask = true } = {}) {
  const v = verdictOf(sub), round = proofRound(sub);
  const rows = proofItems(sub).map((p, i) => {
    const key = `proof-${round}-${i}`;
    return `<details class="job-proof-item ${p.couldNot ? 'gap' : ''}" data-keep="${key}" ${isOpen(key) ? 'open' : ''}><summary>${mark(p)}<span class="t">${esc(p.text)}${p.couldNot ? `<small>${esc(firstSentence(p.couldNot))}</small>` : ''}</span><span class="job-proof-ev">${rowEvidence(job, sub, p)}</span></summary><div class="job-proof-open">${rowDetail(job, sub, p, i, ask)}</div></details>`;
  }).join('');
  const plain = alsoChecked(sub).map((c) => `<div class="job-proof-item plain">${mark({})}<span class="t">${esc(c)}</span></div>`).join('');
  return `<section class="job-proof"><div class="job-proof-verdict"><b>${v.checked} of ${v.all} checked</b>${v.gaps ? `<span class="gap">· ${v.gaps} couldn’t show</span>` : ''}</div>
    <div class="job-proof-list">${rows}${plain}</div></section>`;
}

// The shot viewer: one item full size with where and how it was captured, the
// items as one strip, and the way back to the box with the question started.
// An item with several shots reads as a stack with its count; the open one opens
// in place into a tray of its shots, so a shot always sits inside its check.
// `view` is { i, j }: the item, and which of its shots.
export function proofViewerHtml(job, sub, view, cache, { branch = '', ask = true } = {}) {
  const items = proofItems(sub), i = Math.min(Math.max(view.i || 0, 0), items.length - 1), p = items[i];
  if (!p) return '';
  const shots = shotsOf(p), j = Math.min(Math.max(view.j || 0, 0), Math.max(shots.length - 1, 0)), shot = shots[j];
  const round = proofRound(sub);
  let stage;
  if (p.couldNot) stage = `<div class="job-proof-stage gap">${ICONS.info}<b>Couldn’t show this</b><span>${esc(p.couldNot)}</span></div>`;
  else if (shot) {
    stage = `<div class="job-proof-stage" ${ctxAttrs(job, sub, shot.file)}>${fullMedia(job, sub, round, shot.file, p.text, cache)}</div>`;
  } else stage = `<div class="job-proof-stage term"><pre class="job-proof-run"><i>$</i> ${esc(p.run?.cmd)}\n${esc(p.run?.out)}\n<b class="${p.run?.exit === 0 ? 'ok' : 'bad'}">exit ${esc(p.run?.exit)}</b></pre></div>`;
  const row = (k, v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '';
  const meta = p.couldNot ? '' : shot
    ? `<dl class="job-proof-meta">${row('URL', shot.url)}${row('Viewport', shot.viewport)}${row('How', shot.tool || 'Screenshot')}${row('At', shot.at ? new Date(shot.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')}</dl>`
    : `<dl class="job-proof-meta">${row('In', sub.worktree?.path || '')}${row('How', 'Command output')}${row('Exit', String(p.run?.exit))}</dl>`;
  const strip = items.map((x, k) => {
    const n = x.couldNot ? 0 : shotsOf(x).length;
    if (k === i && n > 1) return `<div class="job-proof-tray" role="group" aria-label="${esc(x.text)} · ${n} shots">${shots.map((s, q) => `<button type="button" class="job-proof-pick ${q === j ? 'sel' : ''}" data-proof-shot="${q}" aria-label="Shot ${q + 1} of ${n}" title="Shot ${q + 1} of ${n}">${thumbHtml(job, sub, s.file)}</button>`).join('')}<small>${j + 1}/${n}</small></div>`;
    const label = n > 1 ? `${x.text} · ${n} shots` : x.text;
    return `<button type="button" class="job-proof-pick ${n > 1 ? 'stack' : ''} ${k === i ? 'sel' : ''}" data-proof-go="${k}" aria-label="${esc(label)}" title="${esc(label)}">${mediaHtml(job, sub, x)}${n > 1 ? `<b class="job-proof-count" aria-hidden="true">${n}</b>` : ''}</button>`;
  }).join('');
  const itemStrip = `<div class="job-proof-strip">${strip}</div>`;
  const anyMany = items.some((x) => !x.couldNot && shotsOf(x).length > 1);
  return `<header class="job-appbar"><button class="job-back" data-proof-back title="Back to the sub-job">${ICONS.back}<span>${esc(sub.title)}</span></button><h2>Shown working · ${i + 1} of ${items.length}</h2>
    <div class="job-chips job-detail-meta"><span class="job-chip">${ICONS.eye}<span>Round ${round}</span></span>${branch ? `<span class="job-chip job-plan-branch">${ICONS.branch}<span>${esc(branch)}</span></span>` : ''}</div></header>
    <div class="job-proof-viewer">${stage}<div class="job-proof-side"><h3 class="${p.couldNot ? 'gap' : ''}"><span aria-hidden="true">${p.couldNot ? '!' : '✓'}</span><span>${esc(p.text)}</span></h3>
      ${p.note ? `<p>${esc(p.note)}</p>` : ''}${p.couldNot ? '<p>The plan asked for this to be shown. You decide whether what covers it instead is enough, or ask for another way.</p>' : ''}${meta}
      ${ask ? `<div class="job-actions"><button type="button" data-proof-ask="${i}">${ICONS.edit}${p.couldNot ? 'Ask it to try another way' : 'Ask about this'}</button></div>` : ''}${anyMany ? `<div class="job-proof-row"><small>Checks · ${items.length}</small>${itemStrip}</div>` : itemStrip}</div></div>`;
}

// The thread's lightbox: one shot of a message (or an earlier round) full size,
// with the way to its neighbours. `box` is { round, files, at }.
export function shotBoxHtml(job, sub, box, cache) {
  const files = box.files || [], n = files.length, at = Math.min(Math.max(box.at || 0, 0), n - 1), file = files[at];
  if (!file) return '';
  const go = (d, icon, label) => `<button type="button" class="job-shotbox-btn" data-shotbox-go="${d}" aria-label="${label}" title="${label}" ${at + d < 0 || at + d >= n ? 'disabled' : ''}>${icon}</button>`;
  return `<div class="job-shotbox-body"><div class="job-proof-stage" data-ev-job="${esc(job.id)}" data-ev-sub="${esc(sub.id)}" data-ev-round="${Number(box.round) || 1}" data-ev-file="${esc(file)}">${fullMedia(job, sub, Number(box.round) || 1, file, file, cache)}</div>
    <div class="job-shotbox-bar">${n > 1 ? `${go(-1, ICONS.back, 'Previous shot')}<b>${at + 1} of ${n}</b>${go(1, ICONS.next, 'Next shot')}` : ''}<span>${esc(file)} · Round ${Number(box.round) || 1}</span><button type="button" class="job-shotbox-btn" data-shotbox-close aria-label="Close" title="Close (Esc)">${ICONS.x}</button></div></div>`;
}

// Where each file opens in the step's viewer ({ i, j } of proofViewerHtml): the
// first item and shot naming it, since filmFiles drops a file named again.
export function filmSpots(sub) {
  const spots = new Map();
  proofItems(sub).forEach((p, i) => shotsOf(p).forEach((s, j) => { if (!spots.has(s.file)) spots.set(s.file, { i, j }); }));
  return spots;
}
// The board plate's filmstrip: the first shots of what is waiting to be verified,
// each opening the step's viewer on itself, and +N on the first shot not drawn.
export function filmHtml(job, sub) {
  const files = filmFiles(sub), total = proofItems(sub).reduce((n, p) => n + shotsOf(p).length, 0);
  if (!files.length) return '';
  const spots = filmSpots(sub), more = [...spots].find(([f]) => !files.includes(f))?.[1] || spots.get(files[0]);
  const shot = (at, label, body, cls = '') => `<button type="button" class="job-plate-shot${cls}" data-film="${at.i}:${at.j}" data-film-job="${esc(job.id)}" data-film-sub="${esc(sub.id)}" title="${label}" aria-label="${label}">${body}</button>`;
  return `<div class="job-plate-film">${files.map((f, k) => shot(spots.get(f), `Open this shot (${k + 1} of ${total})`, thumbHtml(job, sub, f))).join('')}${total > files.length ? shot(more, `Open the other ${total - files.length} shots`, `<small>+${total - files.length}</small>`, ' more') : ''}</div>`;
}

// Fill every evidence slot under `root` from the cache and ask the server for what
// it lacks, once per (job, sub, round). `send` is the view's own, and `full` names
// the one file the open viewer wants at full size.
export function hydrateEvidence(root, cache, send, { full = null } = {}) {
  const wanted = new Map();
  root.querySelectorAll('[data-ev-file]').forEach((el) => {
    const { evJob: job, evSub: sub, evRound: r, evFile: file } = el.dataset, round = Number(r);
    const got = el.classList.contains('job-proof-stage') ? null : cache.thumb(job, sub, round, file);
    if (got && !el.querySelector('img')) {
      const img = el.ownerDocument.createElement('img');
      img.alt = ''; img.src = dataUrl(got);
      el.textContent = ''; el.append(img);
    }
    if (!got) { const w = wanted.get(`${job}/${sub}/${round}`) || { id: job, subJobId: sub, round, files: [] }; w.files.push(file); wanted.set(`${job}/${sub}/${round}`, w); }
  });
  // A round's thumbnails come in one frame, but a reply can add files to a round
  // already fetched, so what is still missing is part of the question's identity.
  for (const [key, { files, ...msg }] of wanted) if (cache.first(`${key}/${[...new Set(files)].sort().join(',')}`)) send({ type: 'job-evidence', ...msg });
  if (full) {
    const token = `${EvidenceCache.key(full.jobId, full.subId, full.round, full.file)}/full`;
    if (!cache.open(full.jobId, full.subId, full.round, full.file) && cache.first(token)) send({ type: 'job-evidence', id: full.jobId, subJobId: full.subId, round: full.round, file: full.file });
  }
}
