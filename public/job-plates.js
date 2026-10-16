import { esc, tildify } from './util.js';
import { ICONS } from './icons.js';
import { SCENES, sceneArt, hash } from './model-plates.js';
import { skyHtml, inflowHtml } from './job-skylines.js';
import { isPrSub, isSessionSub, isHumanSub, isWriteSub, isMakeWrite, writeAwaitingReview, writeReviewed, writeTarget, writeVerb, placesOf, PLACES, webUrl, edgesOf, kindClass, kindCountLabel, dependencyLevels, dependencyLine, dependencySatisfied, jobCostLabel, JOB_COST_TITLE, reviewFlagsLabel, prNumber, promptsWaiting, promptWhere, codeAwaitingReview, deploymentStalled, mergeApprovable, replanProposed, redDeclared, redFixReady, ideaStage, liveSuggestion, ideaOpen, ideaThread } from './jobs.js';
import { STATES, stateIconHtml, stateSolid, subState, subLabel, subLine, jobState, jobLabel, leadSub } from './job-state.js';
import { hasProof, proofSummary, summaryText, filmHtml } from './job-proof.js';
import { runningDotHtml } from './job-running.js';

// The board as a wall of night skies: each job's plan is drawn into a quiet sky
// over its own Gargantua sky (job-skylines.js), lit in the colour of the job's state,
// and the plate's foot is either the one thing the job needs from you (a ticket
// stub with its button) or a status line. Behind the skyline sits a launch-page
// scene (public/model-plates.js) picked for the job; the `plateArt` setting picks
// one or the other: the sky (quiet) or the scene (full). Hovering never swaps them.
export const PLATE_ART = ['quiet', 'full'];

// Haiku's ivory page is the loudest plate on a dark board, so it comes up least.
const WEIGHT = { opus: 3, sonnet: 3, fable: 2, haiku: 1 };
// Picked once per job, oldest first: never the scene of the job created just
// before it, nor of the one four back (the plate above it on a four-column,
// newest-first wall). `memo` keeps a job's scene for the life of the view, so
// a job leaving the list never reshuffles the rest.
export function assignScenes(jobs, memo = new Map()) {
  const seen = [];
  const order = jobs.map((job, i) => [job, job.createdAt ?? 0, i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([job]) => job);
  for (const job of order) {
    if (!memo.has(job.id)) {
      const pool = SCENES.filter((s) => s !== seen.at(-1) && s !== seen.at(-4)).flatMap((s) => Array(WEIGHT[s]).fill(s));
      memo.set(job.id, pool[hash(job.id) % pool.length]);
    }
    seen.push(memo.get(job.id));
  }
  return memo;
}

// The plan a plate draws: the live sub-jobs once approved, the proposed ones before.
const live = (job) => job.stage === 'active' || job.stage === 'done';
const planOf = (job) => ({ ...job.plan, subJobs: live(job) ? job.subJobs : job.plan?.subJobs || [] });
// A write is not a step of the plan: it hangs off the session that makes it.
const stepsOf = (job) => planOf(job).subJobs.filter((s) => !isWriteSub(s));
const stateOf = (job, s) => (live(job) ? subState(job, s) : 'planned');
const lineOf = (job, s) => (live(job) ? subLine(job, s) : STATES.planned.label);
// How far a sub-job has come, so the scene's light builds as the job lands.
const STAGE_WEIGHT = { session: .3, human: .3, implementation: .3, review: .6, pr: .7, deployment: .85, cleanup: .95, done: 1 };
export function progress(job) {
  if (job.stage === 'done') return 1;
  if (!live(job)) return job.plan ? .06 : 0;
  const subs = stepsOf(job).filter((s) => !s.cancelledAt);
  return subs.reduce((a, s) => a + (STAGE_WEIGHT[s.stage] ?? .1), 0) / Math.max(1, subs.length);
}
export const levelOf = (job) => 1 + Math.round(progress(job) * 4);

// How bright a scene is at a point on the plate (plate units: 320 × 150, the
// art's middle 150 of 200), worked out from the scene's own palette so what is
// drawn over it takes the ink that reads: light on dark sky, dark on light.
const lin = (v) => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return .2126 * lin(n >> 16) + .7152 * lin(n >> 8 & 255) + .0722 * lin(n & 255); };
function gradLum(stops, t) {
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const [t0, c0] = stops[i - 1], [t1, c1] = stops[i], f = (t - t0) / Math.max(1e-6, t1 - t0); return lum(c0) * (1 - f) + lum(c1) * f; }
  return lum(stops.at(-1)[1]);
}
function brightness(scene, lvl, x, py) {
  const y = py + 25;
  if (scene === 'haiku') return .86;
  if (scene === 'fable') return x > 205 && y > 140 ? .2 : .34;
  if (scene === 'sonnet') return x < 44 || x > 276 ? .01 : y > 134 - lvl * 2 + 3 ? .14 : .005;
  if (x < 22) return .5;
  if (x > 298) return .02;
  const hy = 136 - lvl * 2.5;
  if (y > hy + 3) return .015;
  return gradLum([[0, '#0c1836'], [.22, '#244a8c'], [.42, '#5d82c6'], [.55, '#9c97c4'], [hy / 200 - .07, '#f0a15c'], [hy / 200 - .02, '#ea4e17'], [hy / 200 + .02, '#4a160b']], y / 200);
}
// Dark ink wins once the art is brighter than ~0.18 relative luminance, where the two inks' contrast crosses.
export const inkFor = (scene, lvl, x, y) => brightness(scene, lvl, x, y) > .18 ? 'dk' : 'lt';

// One shape per kind, so a pull request never reads as an agent: circle, square,
// diamond, and a pennant for a write.
const SHAPES = {
  pr: (x, y) => `<circle class="core" cx="${x}" cy="${y}" r="5.2"/>`,
  session: (x, y) => `<rect class="core" x="${x - 4.8}" y="${y - 4.8}" width="9.6" height="9.6" rx="2"/>`,
  human: (x, y) => `<rect class="core" x="${x - 4.6}" y="${y - 4.6}" width="9.2" height="9.2" rx="1.5" transform="rotate(45 ${x} ${y})"/>`,
  write: (x, y, r = 3.9) => `<path class="core" d="M${(x - r * .9).toFixed(1)},${(y - r).toFixed(1)} L${(x + r * 1.1).toFixed(1)},${y} L${(x - r * .9).toFixed(1)},${(y + r).toFixed(1)} Z" stroke-linejoin="round"/>`,
};
const KIND_TAG = { pr: 'PR', session: 'AGENT', human: 'YOU' };
const KIND_NAME = { pr: 'Pull request', session: 'Agent session', human: 'Your task' };

// The plan in the sky: one column per dependency wave, a solid link where work
// starts after a session or task is done, a dashed one where it waits for a PR
// to deploy, a dotted one where a session starts at another step's milestone.
// Writes are not steps: each hangs off the session that makes it, like a moon,
// beside it when nothing leaves it to the right, otherwise just above (or
// below) it out of the edges' way. Every node opens its sub-job. Also reports the
// `floor`: the lowest point (plate units) a node or label reaches, which the
// quiet sky keeps its cap and brightness clear of.
function skyGraphHtml(job, scene, lvl, full) {
  const plan = planOf(job), steps = stepsOf(job), levels = dependencyLevels({ subJobs: steps });
  // Wave order, so the nodes read (and tab) left to right as the plan runs.
  const subs = [...steps].sort((a, b) => levels.get(a.id) - levels.get(b.id));
  const writes = plan.subJobs.filter(isWriteSub);
  const waves = Math.max(...levels.values()) + 1, pos = new Map(), out = [];
  // Light ink on the night sky; scene-aware only when the scene is always up.
  const ink = (x, y) => (full ? inkFor(scene, lvl, x, y) : 'lt');
  for (let w = 0; w < waves; w++) {
    const col = subs.filter((s) => levels.get(s.id) === w), x = waves === 1 ? 160 : 56 + 208 * w / (waves - 1);
    const span = Math.min(84, (col.length - 1) * 28);
    col.forEach((s, i) => pos.set(s.id, [x, col.length === 1 ? 70 : 70 - span / 2 + span * i / (col.length - 1), col.length]));
  }
  const byId = new Map(subs.map((s) => [s.id, s]));
  for (const s of subs) for (const id of edgesOf(s).filter((a) => pos.has(a))) {
    const [ax, ay] = pos.get(id), [bx, by] = pos.get(s.id), bend = Math.max(16, (bx - ax) / 2), dep = byId.get(id);
    const kind = !s.after.includes(id) ? 'on' : isPrSub(dep) ? 'deploy' : '';
    const lit = kind !== 'on' && live(job) && dependencySatisfied(dep) && stateSolid(stateOf(job, s));
    out.push(`<path class="edge ${kind} ${lit ? 'lit' : ''} ${ink((ax + bx) / 2, (ay + by) / 2)}" d="M${ax + 8},${ay} C${ax + bend},${ay} ${bx - bend},${by} ${bx - 8},${by}"/>`);
  }
  let floor = 0;
  const open = (s) => live(job) ? `data-job="${esc(job.id)}" data-sub="${esc(s.id)}" tabindex="0" role="button"` : '';
  const labels = subs.length <= 5;
  for (const s of subs) {
    const [x, y, k] = pos.get(s.id), state = stateOf(job, s), kind = kindClass(s), n = isPrSub(s) ? prNumber(s) : '';
    const line = lineOf(job, s);
    const tip = [s.title, `${KIND_NAME[kind]} · ${line}`, dependencyLine(plan, s)].filter(Boolean).join('\n');
    const halo = ['running', 'needs'].includes(state) ? `<circle class="halo" cx="${x}" cy="${y}" r="6"/>` : '';
    const tag = labels && k <= 2 ? `<text class="lbl ${ink(x, y + 15)}" x="${x}" y="${y + 17}" text-anchor="middle">${KIND_TAG[kind]}${n ? ` #${esc(n)}` : ''}</text>` : '';
    floor = Math.max(floor, y + 6, tag ? y + 20 : 0);
    out.push(`<g class="node ${kind} ${stateSolid(state) ? state : 'hollow'} ${state} tone-${STATES[state].tone} ${ink(x, y)}" data-state="${state}" ${open(s)} aria-label="${esc(`${s.title}: ${line}`)}"><title>${esc(tip)}</title>${halo}${SHAPES[kind](x, y)}${tag}<circle cx="${x}" cy="${y}" r="13" fill="transparent"/></g>`);
    const moons = writes.filter((w) => w.by === s.id);
    if (!moons.length) continue;
    const beside = !subs.some((o) => edgesOf(o).includes(s.id)), up = y - 14 >= 32;
    const wy = beside ? y : up ? y - 14 : y + 14, wx = (i) => x + (beside ? 15 : 14) + i * 11;
    out.push(beside ? `<path class="tether ${ink(x + 12, wy)}" d="M${x + 6},${y} H${wx(moons.length - 1)}"/>` : `<path class="tether ${ink(x + 12, wy)}" d="M${x + 4},${y + (up ? -4 : 4)} Q${x + 6},${wy} ${x + 10},${wy} H${wx(moons.length - 1)}"/>`);
    moons.forEach((w, i) => {
      floor = Math.max(floor, wy + 5);
      const st = stateOf(job, w), label = `${writeTarget(plan, w)}: ${lineOf(job, w)}`;
      const halo2 = st === 'needs' ? `<circle class="halo" cx="${wx(i)}" cy="${wy}" r="4.6"/>` : '';
      out.push(`<g class="node moon ${stateSolid(st) ? st : 'hollow'} ${st} tone-${STATES[st].tone} ${ink(wx(i), wy)}" data-state="${st}" ${open(w)} aria-label="${esc(label)}"><title>${esc(label)}</title>${halo2}${SHAPES.write(wx(i), wy)}<circle cx="${wx(i)}" cy="${wy}" r="7" fill="transparent"/></g>`);
    });
  }
  const count = `${kindCountLabel(subs)}${writes.length ? `, ${writes.length} write${writes.length === 1 ? '' : 's'}` : ''}`;
  return { floor, svg: `<svg class="job-plate-graph" viewBox="0 0 320 150" aria-label="${esc(`${job.title}: ${count}`)}">${out.join('')}</svg>` };
}

// Every place the job writes to, as a chip under its title: the place's glyph and
// short name, a dot per write in that write's state, toned when one needs you or
// fails, ghosted until the place exists, and a link out once it has a web address.
function placesHtml(job) {
  const plan = planOf(job), places = placesOf(plan, plan.subJobs.filter(isWriteSub));
  if (!places.length) return '';
  return `<div class="job-plate-places">${places.map((p, i) => {
    const states = p.writes.map((w) => stateOf(job, w));
    const tone = states.includes('failing') ? 'tone-bad urgent' : states.includes('needs') ? 'tone-warn urgent' : '';
    const tip = [`${PLACES[p.type].name} · ${p.name}`, ...p.writes.map((w) => `${writeTarget(plan, w)}: ${lineOf(job, w)}${writeReviewed(job, w) ? ' (you review it first)' : ''}`)].join('\n');
    const href = p.type === 'file' ? null : webUrl(p.url);
    const body = `${PLACES[p.type].icon}<span class="job-plate-place-name">${esc(p.label)}</span>${states.map((st) => `<i class="tone-${STATES[st].tone}"></i>`).join('')}${p.exists ? '<span class="job-plate-place-out" aria-hidden="true">↗</span>' : ''}`;
    const cls = `job-plate-place ${tone} ${p.exists ? '' : 'ghost'}`;
    return `<button type="button" class="${cls}" data-place-job="${esc(job.id)}" data-place="${i}" aria-haspopup="true" title="${esc(tip)}">${body}</button>`;
  }).join('')}</div>`;
}

// A chip's writes, as the expanded job's place pill lists them: the place (with its
// link out once it has one) and a row per write that opens that write. Drawn into a
// popover outside the plate, which clips anything that overflows it.
export function placePopHtml(job, i) {
  const plan = planOf(job), p = placesOf(plan, plan.subJobs.filter(isWriteSub))[i];
  if (!p) return '';
  const href = p.type === 'file' ? null : webUrl(p.url);
  const head = `<header>${PLACES[p.type].icon}<b>${esc(p.name)}</b>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">Open ↗</a>` : p.exists ? '' : '<em>not made yet</em>'}</header>`;
  return head + p.writes.map((w) => {
    const st = stateOf(job, w);
    return `<button type="button" class="job-plate-pop-write" data-job="${esc(job.id)}" data-sub="${esc(w.id)}"><i class="tone-${STATES[st].tone}"></i><span><b>${esc(writeTarget(plan, w))}</b><small>${esc(lineOf(job, w))}${writeReviewed(job, w) ? ' · you review it first' : ''}</small></span></button>`;
  }).join('');
}

// The one thing a job is waiting on you for, as the plate's ticket stub: what
// it is, a detail, and the button that does it (`act`) — or opens what has to be
// read first. Null when nothing needs you.
export function plateAsk(job) {
  const state = jobState(job);
  const tone = state === 'failing' ? 'bad' : 'warn';
  const whole = (label, button, detail = '') => ({ tone, label, detail, button, icon: state === 'failing' ? ICONS.x : ICONS.doc, act: 'open', sub: '' });
  if (job.error) return whole('Needs attention', 'Open');
  // An agent stuck on a prompt outranks anything else waiting on you, and is
  // answered on its own card whether or not the job rolls up to "needs you".
  const prompts = promptsWaiting(job);
  if (prompts.length) {
    const [p] = prompts;
    return { tone, label: 'Prompt waiting', detail: `${promptWhere(job, p)}${prompts.length > 1 ? ` +${prompts.length - 1}` : ''}`, button: 'Answer', icon: ICONS.terminal, act: 'session', sub: p.sub?.id || '', session: p.sessionId };
  }
  if (!['needs', 'failing'].includes(state)) return null;
  // An idea waiting on you: the planner's question, or the job it suggests.
  const idea = ideaStage(job);
  if (idea === 'suggested') { const { plan } = liveSuggestion(job).suggest; return { ...whole('Job suggested', 'Review', [kindCountLabel(plan.subJobs), repoLine({ plan })].filter(Boolean).join(' · ')), icon: ICONS.eye }; }
  if (idea === 'reply') return { ...whole('Your reply', 'Reply', 'The planner asked you'), icon: ICONS.note };
  if (!live(job)) return job.plan ? whole('Plan ready', 'Review plan', kindCountLabel(job.plan.subJobs)) : whole(jobLabel(job), 'Open');
  const lead = leadSub(job, state);
  if (!lead) return whole(jobLabel(job), replanProposed(job) ? 'Review' : 'Open');
  const peers = job.subJobs.filter((s) => subState(job, s) === state).length - 1;
  const n = isPrSub(lead) ? prNumber(lead) : '';
  const detail = `${n ? `#${n} · ` : ''}${lead.title}${peers > 0 ? ` +${peers}` : ''}`;
  const ask = (label, button, icon, act = 'open') => ({ tone, label, detail, button, icon, act, sub: lead.id });
  if (state === 'failing') {
    // The only red you act on: Wrangler gave up and says why. With options it
    // opens the proposal on the job; without, the sub-job holds what it found.
    if (redDeclared(job, lead) && !job.error) { const a = ask('Declared red', 'Decide', ICONS.x); return job.replan?.proposal ? { ...a, sub: '' } : a; }
    return ask(subLine(job, lead).replace(/^#\d+ · /, ''), 'Resolve', ICONS.x);
  }
  if (redFixReady(job, lead)) return { ...ask('Fix ready', 'Review fix', ICONS.eye), sub: '' };
  // A draft (or a published output) waiting on you is decided from the plate
  // as it stands; the dialog is where it is edited first.
  if (writeAwaitingReview(lead)) {
    const made = isMakeWrite(lead);
    return { tone, label: made ? 'Check output' : 'Draft ready', detail: '', button: writeVerb(lead), icon: ICONS.eye, act: 'approve-write', sub: lead.id, alt: made ? null : { label: 'Skip', act: 'skip-write' } };
  }
  if (mergeApprovable(job, lead)) return { ...ask(`Merge${n ? ` #${n}` : ''}`, 'Merge', ICONS.merge, 'merge'), detail: `Checks green · ${detail}` };
  // Proof turns Review code into Ready to verify: what was shown, and a filmstrip
  // of the first shots above the stub (plateHtml) so the board says whether it looks right.
  if (codeAwaitingReview(lead) && hasProof(lead)) return { ...ask('Ready to verify', 'Verify', ICONS.eye), detail: `${detail} · ${summaryText(proofSummary(lead))}`, film: lead };
  if (codeAwaitingReview(lead)) return ask('Review code', 'Review', ICONS.code);
  if (isSessionSub(lead)) return ask(subLabel(job, lead), 'Review', ICONS.doc);
  if (isHumanSub(lead)) return ask(subLabel(job, lead), 'Open task', ICONS.hand);
  return ask(job.cancelledAt ? jobLabel(job) : subLabel(job, lead), deploymentStalled(lead) ? 'Resolve' : 'Open', ICONS.eye);
}

const ago = (at) => { const m = Math.max(1, Math.round((Date.now() - at) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
function repoLine(job) {
  const repos = job.repos?.length ? job.repos : [...new Set(planOf(job).subJobs.filter((s) => isPrSub(s) && s.repo).map((s) => s.repo))];
  return repos.length > 2 ? `${repos.length} repositories` : repos.map((r) => tildify(r).split('/').pop()).join(' + ');
}

// An idea's plate: the same frame, body and stub as a job's, under a sky still forming
// (job-skylines.js paintInflow) whose point brightens as the planner asks and then
// suggests. Its chrome stays idle until something waits on you.
const IDEA_SKY = { thinking: 0, reply: 1, suggested: 2 };
const ideaSkyHtml = (job) => inflowHtml(job.id, IDEA_SKY[ideaStage(job)] ?? 0);
function ideaPlateHtml(job) {
  const ask = plateAsk(job), tone = ask ? ask.tone : 'idle', said = ideaThread(job).length + 1;
  const foot = ask
    ? `<div class="job-plate-stub"><span class="job-plate-ask">${ask.icon}<span class="job-status">${esc(ask.label)}</span></span><span class="job-plate-detail">${esc(ask.detail)}</span><button type="button" class="job-plate-go" data-ask="${esc(ask.act)}" data-job="${esc(job.id)}" data-sub="${esc(ask.sub)}"${ask.session ? ` data-session="${esc(ask.session)}"` : ''}>${esc(ask.button)}</button></div>`
    : `<div class="job-plate-foot"><span class="job-plate-glyph">${stateIconHtml(jobState(job))}</span><span class="job-status">${esc(jobLabel(job))}</span></div>`;
  return `<article class="job-plate idea tone-${tone} ${jobState(job)} ${ask ? 'stubbed' : ''}" data-board="${esc(job.id)}">
    <div class="job-plate-art">${ideaSkyHtml(job)}<div class="job-plate-tag lt"><span class="job-idea-mark">Idea</span></div></div>
    <div class="job-plate-body"><div class="job-plate-where"><span>${job.createdAt ? `${ago(job.createdAt)} ago` : ''}</span><span class="job-plate-idea">${said} message${said === 1 ? '' : 's'}</span></div>
      <button type="button" class="job-plate-open" data-job="${esc(job.id)}" data-sub="" title="Open the conversation">${esc(job.title)}</button></div>
    ${foot}</article>`;
}

// `collapse`: the idea this job was is still drawn over its art, and the board folds it
// into its point (jobs.css .collapsing) as the job's own sky rises from under it.
export function plateHtml(job, scene, art = 'quiet', { collapse = false } = {}) {
  if (ideaOpen(job)) return ideaPlateHtml(job);
  const state = jobState(job), ask = plateAsk(job), lvl = levelOf(job), subs = planOf(job).subJobs, work = stepsOf(job);
  const full = art === 'full', tone = ask ? ask.tone : STATES[state].tone, ink = (x, y) => (full ? inkFor(scene, lvl, x, y) : 'lt');
  const cost = jobCostLabel(job.usd, job.usdEstimated);
  const steps = work.filter((s) => !s.cancelledAt), landed = steps.filter((s) => s.stage === 'done').length;
  const when = live(job) && steps.length > 1 && !['done', 'dropped'].includes(state) ? `${landed} of ${steps.length} landed` : '';
  const empty = job.stage === 'planning' && !job.plan && !job.cancelledAt ? 'Planning' : 'Not planned yet';
  const tip = [subs.length ? kindCountLabel(subs) : '', reviewFlagsLabel(job)].filter(Boolean).join(' · ');
  const foot = ask
    ? `${ask.film ? filmHtml(job, ask.film) : ''}<div class="job-plate-stub"><span class="job-plate-ask">${ask.icon}<span class="job-status">${esc(ask.label)}</span></span><span class="job-plate-detail">${esc(ask.detail)}</span>${ask.alt ? `<button type="button" class="job-plate-alt" data-ask="${esc(ask.alt.act)}" data-job="${esc(job.id)}" data-sub="${esc(ask.sub)}">${esc(ask.alt.label)}</button>` : ''}<button type="button" class="job-plate-go" data-ask="${esc(ask.act)}" data-job="${esc(job.id)}" data-sub="${esc(ask.sub)}"${ask.session ? ` data-session="${esc(ask.session)}"` : ''}>${esc(ask.button)}</button></div>`
    : `<div class="job-plate-foot"><span class="job-plate-glyph">${stateIconHtml(state)}</span><span class="job-status">${esc(jobLabel(job))}</span>${when ? `<span class="job-plate-when">${esc(when)}</span>` : ''}</div>`;
  const repo = repoLine(job), graph = work.length ? skyGraphHtml(job, scene, lvl, full) : null;
  const dim = !stateSolid(state);
  return `<article class="job-plate tone-${ask ? ask.tone : STATES[state].tone} ${state} ${ask ? 'stubbed' : ''}" data-board="${esc(job.id)}" data-scene="${scene}">
    <div class="job-plate-art ${full && (scene === 'haiku' || scene === 'fable') ? 'ink-dark' : ''}${collapse ? ' collapsing' : ''}">${collapse ? inflowHtml(job.id, 2) : ''}${full ? `<svg class="scene" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${sceneArt(scene, job.id, lvl)}</svg><div class="scrim"></div>` : skyHtml(job.id, tone, lvl, graph ? graph.floor : 82, dim)}
      ${repo ? `<div class="job-plate-tag ${ink(160, 14)}">${esc(repo)}</div>` : ''}${graph ? graph.svg : `<div class="job-plate-unplanned ${ink(160, 75)}">${empty}</div>`}</div>
    <div class="job-plate-body"><div class="job-plate-where"><span>${job.createdAt ? `${ago(job.createdAt)} ago` : ''}</span>${runningDotHtml(job)}${cost ? `<span class="job-plate-cost" title="${esc(JOB_COST_TITLE)}${job.usdEstimated ? ' · includes an estimate for Codex sessions' : ''}">${esc(cost)}</span>` : ''}</div>
      <button type="button" class="job-plate-open" data-job="${esc(job.id)}" data-sub="" title="${esc(tip)}">${esc(job.title)}</button>${placesHtml(job)}</div>
    ${foot}</article>`;
}
