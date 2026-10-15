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
export const shotsOf = (p) => (Array.isArray(p?.shots) ? p.shots : []);
// The files of a sub-job's current round, in grid order: what the board asks the
// server to thumbnail, and what the plate's filmstrip draws first.
export const filmFiles = (sub, n = MAX_FILM) => proofItems(sub).flatMap((p) => shotsOf(p).map((s) => s.file)).slice(0, n);

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
export const thumbHtml = (job, sub, file, cls = '') => `<span class="job-proof-thumb ${cls} ${isVideo(file) ? 'video' : ''}" ${ctxAttrs(job, sub, file)}>${isVideo(file) ? ICONS.play : ICONS.eye}</span>`;
const termHtml = (run, cls = '') => `<span class="job-proof-thumb term ${cls}"><span class="job-proof-term"><i>$</i> ${esc(run.cmd)}\n${esc(String(run.out || '').split('\n').slice(0, 5).join('\n'))}</span></span>`;
function mediaHtml(job, sub, p, j = 0) {
  if (p.couldNot) return `<span class="job-proof-thumb gap">${ICONS.info}</span>`;
  const shot = shotsOf(p)[j];
  if (shot) return thumbHtml(job, sub, shot.file);
  if (p.run) return termHtml(p.run);
  return `<span class="job-proof-thumb gap">${ICONS.info}</span>`;
}
const captionOf = (p) => p.couldNot || p.note || (p.run ? `${p.run.cmd} · exit ${p.run.exit}` : shotsOf(p)[0]?.url || '');

export function proofGridHtml(job, sub) {
  const items = proofItems(sub), s = proofSummary(sub);
  return `<section class="job-proof"><div class="job-proof-head">${ICONS.eye}<span>Shown working</span><small>${esc(summaryText(s))}</small><span class="job-proof-round">Round ${s.round}</span></div>
    <div class="job-proof-grid">${items.map((p, i) => {
    const more = shotsOf(p).length > 1 ? `<em class="job-proof-count" title="${shotsOf(p).length} shots">${shotsOf(p).length}</em>` : '';
    return `<button type="button" class="job-proof-card ${p.couldNot ? 'gap' : ''}" data-proof="${i}" title="${p.couldNot ? 'Could not show it: open for the reason' : 'Open full size'}"><span class="job-proof-media">${mediaHtml(job, sub, p)}${more}</span><span class="job-proof-ck"><span aria-hidden="true">${p.couldNot ? '!' : '✓'}</span><span>${esc(p.text)}</span></span><small>${esc(captionOf(p))}</small></button>`;
  }).join('')}</div></section>`;
}
export const alsoCheckedHtml = (sub) => {
  const also = alsoChecked(sub);
  return also.length ? `<h3>Also checked</h3><ul class="job-receipt">${also.map((c) => `<li><span aria-hidden="true">✓</span> ${esc(c)}</li>`).join('')}</ul>` : '';
};

// The shot viewer: one item full size with where and how it was captured, the
// other items as a strip, and the way back to the box with the question started.
// `view` is { i, j }: the item, and which of its shots.
export function proofViewerHtml(job, sub, view, cache, { branch = '' } = {}) {
  const items = proofItems(sub), i = Math.min(Math.max(view.i || 0, 0), items.length - 1), p = items[i];
  if (!p) return '';
  const shots = shotsOf(p), j = Math.min(Math.max(view.j || 0, 0), Math.max(shots.length - 1, 0)), shot = shots[j];
  const round = proofRound(sub);
  let stage;
  if (p.couldNot) stage = `<div class="job-proof-stage gap">${ICONS.info}<b>Couldn’t show this</b><span>${esc(p.couldNot)}</span></div>`;
  else if (shot) {
    const got = cache.open(job.id, sub.id, round, shot.file), thumb = cache.thumb(job.id, sub.id, round, shot.file);
    const media = got ? (isVideo(shot.file) ? `<video class="job-proof-full" controls src="${dataUrl(got)}"></video>` : `<img class="job-proof-full" alt="${esc(p.text)}" src="${dataUrl(got)}">`)
      : thumb ? `<img class="job-proof-full soft" alt="${esc(p.text)}" src="${dataUrl(thumb)}">` : `<span class="job-proof-thumb big ${isVideo(shot.file) ? 'video' : ''}">${ICONS.eye}</span>`;
    stage = `<div class="job-proof-stage" ${ctxAttrs(job, sub, shot.file)}>${media}</div>`;
  } else stage = `<div class="job-proof-stage term"><pre class="job-proof-run"><i>$</i> ${esc(p.run?.cmd)}\n${esc(p.run?.out)}\n<b class="${p.run?.exit === 0 ? 'ok' : 'bad'}">exit ${esc(p.run?.exit)}</b></pre></div>`;
  const row = (k, v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '';
  const meta = p.couldNot ? '' : shot
    ? `<dl class="job-proof-meta">${row('URL', shot.url)}${row('Viewport', shot.viewport)}${row('How', shot.tool || 'Screenshot')}${row('At', shot.at ? new Date(shot.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')}</dl>`
    : `<dl class="job-proof-meta">${row('In', sub.worktree?.path || '')}${row('How', 'Command output')}${row('Exit', String(p.run?.exit))}</dl>`;
  const strip = items.map((x, k) => `<button type="button" class="job-proof-pick ${k === i ? 'sel' : ''}" data-proof-go="${k}" aria-label="${esc(x.text)}" title="${esc(x.text)}">${mediaHtml(job, sub, x)}</button>`).join('');
  const shotStrip = shots.length > 1 ? `<div class="job-proof-shots">${shots.map((s, k) => `<button type="button" class="job-proof-pick ${k === j ? 'sel' : ''}" data-proof-shot="${k}" aria-label="Shot ${k + 1}">${thumbHtml(job, sub, s.file)}</button>`).join('')}</div>` : '';
  return `<header class="job-appbar"><button class="job-back" data-proof-back title="Back to the sub-job">${ICONS.back}<span>${esc(sub.title)}</span></button><h2>Shown working · ${i + 1} of ${items.length}</h2>
    <div class="job-chips job-detail-meta"><span class="job-chip">${ICONS.eye}<span>Round ${round}</span></span>${branch ? `<span class="job-chip job-plan-branch">${ICONS.branch}<span>${esc(branch)}</span></span>` : ''}</div></header>
    <div class="job-proof-viewer">${stage}<div class="job-proof-side"><h3 class="${p.couldNot ? 'gap' : ''}"><span aria-hidden="true">${p.couldNot ? '!' : '✓'}</span><span>${esc(p.text)}</span></h3>
      ${p.note ? `<p>${esc(p.note)}</p>` : ''}${p.couldNot ? '<p>The plan asked for this to be shown. You decide whether what covers it instead is enough, or ask for another way.</p>' : ''}${meta}
      <div class="job-actions"><button type="button" data-proof-ask="${i}">${ICONS.edit}${p.couldNot ? 'Ask it to try another way' : 'Ask about this'}</button></div>${shotStrip}<div class="job-proof-strip">${strip}</div></div></div>`;
}

// The board plate's filmstrip: the first shots of what is waiting to be verified.
export function filmHtml(job, sub) {
  const files = filmFiles(sub), total = proofItems(sub).reduce((n, p) => n + shotsOf(p).length, 0);
  if (!files.length) return '';
  return `<div class="job-plate-film" aria-hidden="true">${files.map((f) => thumbHtml(job, sub, f)).join('')}${total > files.length ? `<small>+${total - files.length}</small>` : ''}</div>`;
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
    if (!got) wanted.set(`${job}/${sub}/${round}`, { id: job, subJobId: sub, round });
  });
  for (const [token, msg] of wanted) if (cache.first(token)) send({ type: 'job-evidence', ...msg });
  if (full) {
    const token = `${EvidenceCache.key(full.jobId, full.subId, full.round, full.file)}/full`;
    if (!cache.open(full.jobId, full.subId, full.round, full.file) && cache.first(token)) send({ type: 'job-evidence', id: full.jobId, subJobId: full.subId, round: full.round, file: full.file });
  }
}
