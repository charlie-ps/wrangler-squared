import { esc, tildify } from './util.js';
import { ICONS, ROCKET_PATH } from './icons.js';
import { isPrSub, targetOf, offBase, isSessionSub, isWriteSub, isMakeWrite, writeReviewed, writeWhen, writeAction, placeKey, placesOf, webUrl, PLACES, triggerLine, edgesOf, KIND_TITLE, kindChipHtml, kindLabel, kindClass, dependencyLevels, dependencyLine, storyLabel } from './jobs.js';
import { STATES, stateIconHtml, stateSolid } from './job-state.js';

// A job's sub-jobs drawn as a horizontal stepper: one column per wave (a
// sub-job's wave is one past its deepest prerequisite, `dependencyLevels`), a
// tile per sub-job showing its kind, ringed and badged in its state, and a connector from every
// prerequisite to what waits on it — solid where the work starts after it, dashed
// with a rocket where it waits for a PR to deploy. The same drawing serves the
// plan under review (`editable`: title fields and a per-node dependency editor),
// the approved plan while tickets are created (static), and the live job
// (`stateOf`/`lineOf`: each node is a button that opens its sub-job).
//
// Connectors are traced by `layoutGraphEdges` from the tiles' rendered
// rectangles, not by this markup, so callers re-run it after anything that can
// move a node.
//
// A write is not a step in the order, so it gets no column and no connector:
// every write hangs under the session that makes it (`by`), folded into one pill
// per PLACE (the place's glyph, a short label, a dot per write in that write's
// state), dashed until the place exists and ringed when a write there needs the
// human. The pill is a <details> whose popover names the place, opens it once it
// exists, and has a row per write saying in a word how it is made, never the
// session's title, since the pill hangs under it. A write from before
// session-owned writes has no session and hangs at the top of the first wave. A
// session's milestone (`on`) is a connector from its trigger like `after`'s,
// and a line on its node. Under review each row opens its editor (`editing` is
// the open one) and every session node offers "+ place"; live, a row opens its
// sub-job. Under review each row also carries an eye that flips whether that
// write stops for review: a sibling of the row's button, since a button cannot
// hold another. `reviewWrites` is the job's default for a write that does not say.
//
// Every PR tile has a branch line under its repo: its worktree branch once cut,
// then → where it lands (muted `default branch` when no base). Under review every
// PR also has a branch pill beside its dependencies, blank until it overrides the
// job's, with the branch it would land on as its placeholder.
export const dependencyEditorHtml = (s, others, depKey) => others.filter((d) => !isWriteSub(d)).map((d) => `<label><input type="checkbox" data-dep="${esc(depKey)}" value="${esc(d.id)}" ${s.after.includes(d.id) ? 'checked' : ''}>${kindChipHtml(d)}<span>${esc(d.title)}</span></label>`).join('') || '<span>No other sub-jobs</span>';
// "Show me before review", edited like the title: one input per item, redrawn
// from the draft on add and remove so the stepper never holds a stale list.
export const showEditorHtml = (s, key) => `<div class="job-show-ed"><small>Show me</small>${(s.show || []).map((t, k) => `<div class="job-show-row"><input data-show="${esc(key)}" data-show-k="${k}" maxlength="180" value="${esc(t)}" aria-label="Show me item ${k + 1}"><button type="button" class="ghost" data-show-rm="${esc(key)}:${k}" aria-label="Remove item ${k + 1}">${ICONS.x}</button></div>`).join('')}<button type="button" class="job-show-add" data-show-add="${esc(key)}">${ICONS.plus}Add an item</button></div>`;
// Blank lands where the job does; the summary names the branch only once it differs.
// A PR tile's branch line: its worktree branch once cut, then where it lands. A PR
// on the default branch with no worktree yet shows nothing: that is the usual case.
const landingHtml = (s, base) => {
  const target = targetOf({ base }, s), branch = s.worktree?.branch;
  if (!target && !branch) return '';
  const tip = [branch ? `Branch ${branch}` : '', `Lands on ${target || 'the default branch'}`].filter(Boolean).join('\n');
  return `<span class="job-node-landing" title="${esc(tip)}">${branch ? `<span class="job-node-wt">${esc(branch)}</span>` : ''}${target ? `<span class="job-node-arrow" aria-hidden="true">→</span><span class="job-node-base ${offBase({ base }, s) ? 'own' : ''}">${esc(target)}</span>` : ''}</span>`;
};
const branchEditorHtml = (s, i, base, open) => `<details class="job-node-deps job-node-branch ${s.base ? 'set' : base ? '' : 'unset'}" data-base-of="${esc(s.id)}" ${open ? 'open' : ''}><summary title="Lands on ${esc(targetOf({ base }, s) || 'the default branch')} · change">${ICONS.branch}<span>${esc(s.base || base || 'default branch')}</span></summary>
  <input data-base="${i}" value="${esc(s.base || '')}" placeholder="${esc(base || 'Default branch')}" maxlength="200" autocomplete="off" spellcheck="false" aria-label="Land on branch"></details>`;
// A place pill's parts: the glyph, a short mono label, a dot per write in its
// state, and ↗ once the place exists.
const urgentOf = (states) => ['failing', 'needs', 'change', 'read'].find((st) => states.includes(st));
const placePillClass = (p, states, base = 'job-place') => { const u = urgentOf(states); return `${base} ${p.exists ? '' : 'ghost'} ${p.type === 'other' ? 'other' : ''} ${u ? `tone-${STATES[u].tone} urgent` : ''}`; };
// The ↗ is its own link straight to the place: a link inside a summary follows
// without toggling it.
const placeBodyHtml = (p, states) => {
  const href = p.type !== 'file' ? webUrl(p.url) : null;
  const go = href ? `<a class="job-place-go" href="${esc(href)}" target="_blank" rel="noopener" title="Open ${esc(p.name)}">↗</a>` : p.exists ? '<span class="job-place-go" aria-hidden="true">↗</span>' : '';
  return `${PLACES[p.type].icon}<b>${esc(p.label)}</b><span class="job-place-dots">${states.map((st) => `<span class="job-place-dot tone-${STATES[st].tone} ${stateSolid(st) ? 'on' : ''}"></span>`).join('')}</span>${go}`;
};
const placeTip = (plan, p, writes, states) => [`${PLACES[p.type].name} · ${p.name}${p.type === 'file' && p.url ? `\n${p.url}` : ''}`,
  ...writes.map((w, i) => `${STATES[states[i]].label}: ${writeAction(w)} (${writeWhen(plan, w)})`)].join('\n');
// A host serving `api.files` (1.38) can open a path it knows how to show, so Open
// sits beside Copy for those only; an older host, or any other file, keeps Copy.
let canOpenFile = () => false;
export const setFileOpener = (canOpen) => { canOpenFile = typeof canOpen === 'function' ? canOpen : () => false; };
export function filePathHtml(path) {
  let can = false;
  try { can = !!canOpenFile(path); } catch { can = false; }
  return `<div class="job-place-path"><code>${esc(path)}</code>${can ? `<button type="button" data-open-path="${esc(path)}" title="Open the file">${ICONS.link}Open</button>` : ''}<button type="button" data-copy-path="${esc(path)}" title="Copy the path">${ICONS.copy}Copy</button></div>`;
}
// The popover's header: the whole name, and Open ↗ once there is somewhere to
// go. Only an http(s) link is ever an href, whoever reported it.
function placeHeadHtml(p) {
  const href = p.type === 'file' ? null : webUrl(p.url);
  const head = `<header class="job-place-head">${PLACES[p.type].icon}<b title="${esc(p.name)}">${esc(p.name)}</b>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">Open ↗</a>` : p.exists ? '' : '<em>not made yet</em>'}</header>`;
  return p.type === 'file' && p.url ? `${head}${filePathHtml(p.url)}` : head;
}

// Each wave's column, top to bottom. A connector that skips waves reserves a
// pass (an empty slot) in every column it crosses, so it is drawn through clear
// space rather than over the tiles in between. Rows are then ordered to keep
// connectors short and uncrossed: sweeping right, each column by the mean row of
// its items' predecessors in the column before; sweeping left, by the mean row
// of their successors in the column after (so the first column can move too).
// A few rounds, keeping whichever order crossed least; ties, and an item with no
// neighbour on that side, keep their place, so a plan with nothing to untangle
// reads in plan order.
const SWEEPS = 4;
export function graphRows(work, levels, waves) {
  const rows = Array.from({ length: waves }, () => []);
  const preds = new Map(), succs = new Map();
  const link = (from, to) => { preds.set(to, [...(preds.get(to) || []), from]); succs.set(from, [...(succs.get(from) || []), to]); };
  for (const s of work) rows[levels.get(s.id)].push({ key: s.id, sub: s });
  for (const s of work) for (const id of edgesOf(s).filter((d) => levels.has(d))) {
    let prev = id;
    for (let w = levels.get(id) + 1; w < levels.get(s.id); w++) {
      const key = `${id}>${s.id}@${w}`;
      rows[w].push({ key, pass: `${id}>${s.id}` });
      link(prev, key); prev = key;
    }
    link(prev, s.id);
  }
  const order = (col, side, next) => {
    const at = new Map(side.map((it, i) => [it.key, i * col.length / Math.max(side.length, 1)]));
    const mean = (it, i) => { const ns = (next.get(it.key) || []).map((k) => at.get(k)).filter((n) => n != null); return ns.length ? ns.reduce((x, y) => x + y, 0) / ns.length : i; };
    return col.map((it, i) => ({ it, m: mean(it, i), i })).sort((p, q) => p.m - q.m || p.i - q.i).map(({ it }) => it);
  };
  const crossings = (rs) => rs.slice(1).reduce((n, col, w) => {
    const at = new Map(rs[w].map((it, i) => [it.key, i]));
    const links = col.flatMap((it, j) => (preds.get(it.key) || []).filter((k) => at.has(k)).map((k) => [at.get(k), j]));
    return n + links.reduce((c, [a, b], i) => c + links.slice(i + 1).filter(([x, y]) => (x - a) * (y - b) < 0).length, 0);
  }, 0);
  let best = rows.map((c) => [...c]), least = crossings(rows);
  const keep = () => { const n = crossings(rows); if (n < least) { best = rows.map((c) => [...c]); least = n; } };
  for (let round = 0; round < SWEEPS && least; round++) {
    for (let w = 1; w < waves; w++) rows[w] = order(rows[w], rows[w - 1], preds);
    keep();
    for (let w = waves - 2; w >= 0; w--) rows[w] = order(rows[w], rows[w + 1], succs);
    keep();
  }
  return best;
}

// Rows shared by every column, so tiles on the same row line up and a connector
// between them is one straight line. Each column keeps `graphRows`' order; a
// tile takes the (lower) median row of its prerequisites, or the next free row below. A
// connector that skips waves gets a lane: one row, free of tiles in every
// column it crosses, nearest to both its ends (its source's row first, so it
// leaves straight), or a lane-only row under the tiles when none is free.
// Lanes out of one tile in one style share a track, so they read as one bundle
// that branches at each target; other lanes in that cell stack 12px apart.
export function graphGrid(cols, work, levels, styleOf) {
  const at = new Map(), used = cols.map(() => new Set());
  const preds = new Map(work.map((s) => [s.id, edgesOf(s).filter((d) => levels.has(d))]));
  const median = (rs) => { const xs = rs.filter((r) => r != null).sort((a, b) => a - b); return xs.length ? xs[(xs.length - 1) >> 1] : null; };
  // Left to right, each tile on the (lower) median row of its prerequisites.
  const place = (w, want) => {
    let last = -1;
    for (const it of cols[w].filter((c) => !c.pass)) { const r = Math.max(last + 1, want(it.key) ?? last + 1); at.set(it.key, r); last = r; }
  };
  cols.forEach((_, w) => place(w, (id) => median(preds.get(id).map((p) => at.get(p)))));
  cols.forEach((col, w) => col.forEach((it) => !it.pass && used[w].add(at.get(it.key))));
  const tileRows = Math.max(...at.values()) + 1;
  const lanes = new Map(), laneOnly = new Set();
  const long = work.flatMap((s) => preds.get(s.id).filter((d) => levels.get(s.id) - levels.get(d) > 1).map((d) => ({ from: d, to: s.id, style: styleOf(s, d) })));
  for (const e of long) {
    const span = Array.from({ length: levels.get(e.to) - levels.get(e.from) - 1 }, (_, i) => levels.get(e.from) + 1 + i);
    const rs = at.get(e.from), rt = at.get(e.to);
    // A free tile row at either end runs straight; otherwise the channel (r + .5,
    // the thin row under tile row r) nearest both ends, which is always free.
    // A lane already out of the same port pulls it in, so the two bundle.
    const cost = (r) => Math.abs(r - rs) + Math.abs(r - rt) + (r === rs ? 0 : r === rt ? 0.25 : Number.isInteger(r) ? 1 : 0.5) + (r < Math.min(rs, rt) ? 0.1 : 0)
      - ([...lanes.values()].some((l) => l.from === e.from && l.style === e.style && l.r === r) ? 0.6 : 0);
    const free = [...Array.from({ length: tileRows }, (_, r) => r).filter((r) => span.every((w) => !used[w].has(r))), ...Array.from({ length: tileRows }, (_, r) => r + 0.5)];
    const r = free.reduce((a, b) => cost(b) < cost(a) ? b : a);
    if (!Number.isInteger(r)) laneOnly.add(r);
    lanes.set(`${e.from}>${e.to}`, { ...e, r, cols: span, bundle: `${e.from}:${e.style}:${r}` });
  }
  // A track (k) per bundle, the lowest not taken by another bundle in any cell it crosses.
  const taken = new Map();
  for (const l of lanes.values()) {
    const cells = l.cols.map((w) => `${w}:${l.r}`);
    const mine = [...lanes.values()].find((o) => o !== l && o.bundle === l.bundle && o.k != null);
    let k = mine ? mine.k : 0;
    while (!mine && cells.some((c) => (taken.get(c) || new Map()).has(k) && taken.get(c).get(k) !== l.bundle)) k++;
    l.k = k;
    for (const c of cells) { if (!taken.has(c)) taken.set(c, new Map()); taken.get(c).set(k, l.bundle); }
  }
  // Which gutters a connector changes row in, so a gutter only widens for a curve.
  const gutters = Array.from({ length: Math.max(cols.length - 1, 0) }, () => new Set());
  for (const s of work) for (const d of preds.get(s.id)) {
    const l = lanes.get(`${d}>${s.id}`), style = styleOf(s, d);
    const seq = [at.get(d), ...(l ? l.cols.map(() => l.r) : []), at.get(s.id)];
    seq.slice(1).forEach((r, i) => { if (r !== seq[i]) gutters[levels.get(d) + i].add(i === 0 ? `s:${d}:${style}` : i === seq.length - 2 ? `t:${s.id}:${style}` : `e:${d}>${s.id}`); });
  }
  return { at, lanes, laneOnly, gutters: gutters.map((g) => g.size), rows: tileRows };
}

// A plan's steps laid out once, for the dialog's grid and the Jobs view's plate
// alike, so both read in the same columns, order and rows.
export function planLayout(plan) {
  const levels = dependencyLevels(plan), byId = new Map(plan.subJobs.map((s) => [s.id, s]));
  const styleOf = (s, id) => isPrSub(byId.get(id)) && s.after.includes(id) ? 'deploy' : s.after.includes(id) ? 'start' : 'on';
  const waves = Math.max(...levels.values()) + 1, tiles = plan.subJobs.filter((s) => !isWriteSub(s));
  const rows = graphRows(tiles, levels, waves);
  return { levels, waves, tiles, rows, grid: graphGrid(rows, tiles, levels, styleOf) };
}

// A proposed change to a running job's plan (`markOf`) is drawn static, each
// node in its live state and labelled with what approval would do to it.
export const rocketHtml = (id) => `<g class="job-edge-glyph" data-glyph="${esc(id)}"><circle r="12"/><g transform="translate(-9.6 -9.6) scale(.8)">${ROCKET_PATH}</g></g>`;
const MARKS = { frozen: 'Locked · already landed', removed: 'Will be cancelled', added: 'New', edited: 'Edited', kept: 'Unchanged',
  'accept-red': 'Accept red', recover: 'Waits for its fix', rework: 'Rework', forward: 'To its open session', 'mark-done': 'Marked done', 'mark-merged': 'Marked merged', retry: 'Retry this step' };
// `was` (a proposal's live plan) diffs the drawing: a dependency the change drops
// stays drawn, struck, so the graph shows every edge it adds and every one it takes away.
const FIELD_NAMES = { title: 'title', brief: 'brief', check: 'check', show: 'show me', after: 'waits for', action: 'action', on: 'trigger', by: 'session', review: 'review', why: 'why', place: 'place', base: 'base' };
export const fieldName = (k) => FIELD_NAMES[k] || k;
export function planGraphHtml(plan, { editable = false, stateOf = null, lineOf = null, markOf = null, editsOf = () => [], was = null, openDeps = new Set(), openTickets = new Set(), openShow = new Set(), editing = null, reviewWrites = false, base = null } = {}) {
  const before = was && new Map(was.subJobs.map((s) => [s.id, s]));
  const goneDeps = (s) => (before?.get(s.id)?.after || []).filter((id) => !s.after.includes(id) && plan.subJobs.some((t) => t.id === id));
  const dropped = new Map(before ? plan.subJobs.map((s) => [s.id, goneDeps(s)]) : []);
  if (before) plan = { ...plan, subJobs: plan.subJobs.map((s) => dropped.get(s.id).length ? { ...s, after: [...s.after, ...dropped.get(s.id)] } : s) };
  const subs = plan.subJobs;
  if (!subs.length) return '';
  const edgeDiff = (s, id) => !before ? '' : dropped.get(s.id)?.includes(id) || [s.id, id].some((x) => markOf?.({ id: x }) === 'removed') ? 'gone' : !before.has(s.id) || !(before.get(s.id).after || []).includes(id) ? 'added' : 'kept';
  const { levels, waves, tiles, rows, grid } = planLayout(plan);
  const byId = new Map(subs.map((s) => [s.id, s]));
  const work = new Set(subs.filter((s) => !isWriteSub(s)).map((s) => s.id));
  const hangsOn = (w) => (work.has(w.by) ? w.by : null);
  const stateOfWrite = (w) => stateOf ? stateOf(w) : 'planned';
  // Whether a place exists, and what it is called, is the whole job's business:
  // a ticket one node's write created is a ticket under every node.
  const places = new Map(placesOf(plan, subs.filter(isWriteSub)).map((p) => [p.key, p]));
  // Until its session has it in hand a write reads as how it is made; after, as the runner's line.
  const pending = (w, state) => ['planned', 'waiting'].includes(state);
  const write = (w) => {
    const i = subs.indexOf(w);
    const state = stateOfWrite(w);
    const dormant = byId.get(w.by)?.on?.at === 'dropped' && ['planned', 'waiting'].includes(state);
    const cls = `job-write tone-${STATES[state].tone} ${dormant ? 'dormant' : ''} ${markOf ? `job-mark-${markOf(w)}` : ''}`;
    const line = markOf ? MARKS[markOf(w)] : !stateOf || pending(w, state) ? writeWhen({ reviewWrites }, w) : lineOf ? lineOf(w) : STATES[state].label;
    const reviewed = writeReviewed({ reviewWrites }, w);
    const flags = `${reviewed && !editable ? `<span class="job-write-review" title="${isMakeWrite(w) ? 'Reviewed once published' : 'Drafted for your review before it is written'}">${ICONS.eye}</span>` : ''}${editable && !w.added ? `<span class="job-proposed" title="Proposed by the wrangler">${ICONS.sparkle}</span>` : ''}`;
    const body = `<span class="job-write-state ${stateSolid(state) ? 'on' : ''}">${stateIconHtml(state)}</span><b>${esc(writeAction(w))}${flags}</b><span class="job-write-line">${esc(line)}</span>`;
    const tip = esc([KIND_TITLE.write, w.title, w.why ? `Why: ${w.why}` : ''].filter(Boolean).join('\n'));
    if (editable) {
      const eye = `<button type="button" class="job-write-eye ${reviewed ? 'on' : ''}" data-review-write="${i}" aria-pressed="${reviewed}" title="${isMakeWrite(w) ? 'Review once published' : 'Review before writing'}" aria-label="${isMakeWrite(w) ? 'Review once published' : 'Review before writing'}">${ICONS.eye}</button>`;
      return `<div class="job-write-row"><button type="button" class="${cls}" data-node="${esc(w.id)}" data-edit-write="${i}" aria-pressed="${editing === i}" title="${tip}">${body}</button>${eye}</div>`;
    }
    if (stateOf && !markOf) return `<button type="button" class="${cls}" data-node="${esc(w.id)}" data-open-sub="${esc(w.id)}" title="${tip}">${body}</button>`;
    return `<div class="${cls}" data-node="${esc(w.id)}" title="${tip}">${body}</div>`;
  };
  const pills = (list, owner) => {
    const groups = new Map();
    for (const w of list) groups.set(placeKey(w), [...(groups.get(placeKey(w)) || []), w]);
    return [...groups.entries()].map(([key, g]) => {
      const p = places.get(key);
      const ref = `${owner}|${key}`;
      const states = g.map(stateOfWrite);
      const open = openTickets.has(ref) || (editing != null && g.includes(subs[editing]));
      return `<details class="${placePillClass(p, states)}" data-ticket="${esc(ref)}" ${open ? 'open' : ''}><summary title="${esc(placeTip({ ...plan, reviewWrites }, p, g, states))}">${placeBodyHtml(p, states)}</summary><div class="job-place-pop">${placeHeadHtml(p)}${g.map(write).join('')}</div></details>`;
    }).join('');
  };
  const hanging = (s) => {
    const list = subs.filter((w) => isWriteSub(w) && hangsOn(w) === s.id);
    const add = editable && isSessionSub(s) ? `<button type="button" class="job-place-add" data-add-write="${esc(s.id)}" title="Add a place this session writes to">${ICONS.plus}<b>place</b></button>` : '';
    return list.length || add ? `<div class="job-places">${pills(list, s.id)}${add}</div>` : '';
  };
  const story = (s) => s.jiraKey || (s.storyId ? storyLabel(plan.stories?.find((t) => t.id === s.storyId), plan.stories) : 'No ticket');
  const node = (s, i) => {
    const state = stateOf ? stateOf(s) : 'planned';
    const deps = dependencyLine(plan, s);
    const lands = isPrSub(s) ? `Lands on ${targetOf({ base }, s) || 'the default branch'}${offBase({ base }, s) ? `, not the job's ${base || 'default branch'}` : ''}` : '';
    const tip = [KIND_TITLE[kindClass(s)], story(s), isPrSub(s) ? tildify(s.repo) : '', lands, isPrSub(s) && s.worktree?.branch ? `Branch ${s.worktree.branch}` : '', deps, stateOf ? STATES[state].label : ''].filter(Boolean).join('\n');
    const tile = `<span class="job-node-tile ${stateSolid(state) ? 'on' : ''}">${kindChipHtml(s)}<span class="job-node-state">${stateIconHtml(state)}</span></span>`;
    const cls = `job-node tone-${STATES[state].tone} ${kindClass(s)}${s.cancelledAt ? ' cancelled' : ''}`;
    const repo = isPrSub(s) && s.kind !== 'jira' && s.repo ? `<span class="job-node-repo">${esc(tildify(s.repo).split('/').pop())}</span>${landingHtml(s, base)}`
      : triggerLine(plan, s) ? `<span class="job-node-repo job-node-on" title="Starts at this milestone">${esc(triggerLine(plan, s))}</span>` : '';
    if (editable) {
      const others = subs.filter((d) => d.id !== s.id && !isWriteSub(d));
      return `<div class="${cls}" data-node="${esc(s.id)}" title="${esc(tip)}">${tile}<textarea class="job-node-title" aria-label="${kindLabel(s)} title ${i + 1}" data-title="${i}" maxlength="180" rows="3">${esc(s.title)}</textarea>${repo}
        <div class="job-node-edit"><details class="job-node-deps" data-deps="${esc(s.id)}" ${openDeps.has(s.id) ? 'open' : ''}><summary title="${esc(deps || 'Independent')} · change">${ICONS.link}<span>${s.after.length || 'None'}</span></summary>${dependencyEditorHtml(s, others, String(i))}</details>${isPrSub(s) ? `<details class="job-node-show" data-show-d="${esc(s.id)}" ${openShow.has(s.id) ? 'open' : ''}><summary title="Show me before review · change">${ICONS.eye}<span>${(s.show || []).length || 'None'}</span></summary>${showEditorHtml(s, String(i))}</details>${branchEditorHtml(s, i, base, openDeps.has(`base:${s.id}`))}` : ''}</div></div>`;
    }
    if (markOf) {
      const mark = markOf(s), fields = mark === 'edited' ? editsOf(s.id) : [];
      const old = fields.includes('title') && before?.get(s.id) ? `<s class="job-node-was" title="Title before this change">${esc(before.get(s.id).title)}</s>` : '';
      const label = fields.length ? `${MARKS.edited} · ${fields.map(fieldName).join(', ')}` : MARKS[mark];
      return `<div class="${cls} job-mark-${mark}" data-node="${esc(s.id)}" title="${esc(tip)}">${tile}${old}<strong class="job-node-title">${esc(s.title)}</strong>${repo}<span class="job-mark">${mark === 'frozen' ? ICONS.lock : ''}${esc(label)}</span></div>`;
    }
    if (!stateOf) return `<div class="${cls}" data-node="${esc(s.id)}" title="${esc(tip)}">${tile}<strong class="job-node-title">${esc(s.title)}</strong>${repo}</div>`;
    return `<button type="button" class="${cls} ${state === 'done' ? 'done' : ''}" data-node="${esc(s.id)}" data-open-sub="${esc(s.id)}" title="${esc(tip)}">${tile}<strong class="job-node-title">${esc(s.title)}</strong>${repo}<span class="job-status">${esc(lineOf ? lineOf(s) : STATES[state].label)}</span></button>`;
  };
  const loose = subs.filter((w) => isWriteSub(w) && !hangsOn(w));
  const top = loose.length ? 1 : 0;
  // Columns sit at odd grid tracks; the even track after column w is gutter w, sized by `layoutGraphEdges`.
  const cell = (w, r) => `grid-column:${2 * w + 1};grid-row:${2 * r + top + 1}`;
  const columns = (loose.length ? `<div class="job-stack job-stack-loose" style="grid-column:1;grid-row:1"><div class="job-places">${pills(loose, '')}</div></div>` : '')
    + rows.flatMap((col, w) => col.filter((it) => !it.pass).map((it) => `<div class="job-stack" data-col="${w}" style="${cell(w, grid.at.get(it.key))}">${node(it.sub, subs.indexOf(it.sub))}${hanging(it.sub)}</div>`)).join('')
    + [...grid.lanes].flatMap(([key, l]) => l.cols.map((w) => `<div class="job-graph-pass" data-pass="${esc(key)}" style="${cell(w, l.r)};margin-top:${(grid.laneOnly.has(l.r) ? 2 : 29) + l.k * 12}px"></div>`)).join('');
  const template = rows.map((_, w) => `minmax(148px,1fr)${w < waves - 1 ? ` var(--g${w}, ${grid.gutters[w] ? GUTTER.curve : GUTTER.min}px)` : ''}`).join(' ');
  const edges = subs.flatMap((s) => edgesOf(s).filter((id) => levels.has(id)).map((id) => {
    const deploy = isPrSub(byId.get(id)) && s.after.includes(id);
    // A flag, not a class: the class is the connector's style, which picks its port.
    const diff = edgeDiff(s, id);
    return `<path class="${deploy ? 'deploy' : s.after.includes(id) ? 'start' : 'on'}" data-from="${esc(id)}" data-to="${esc(s.id)}"${s.cancelledAt ? ' data-cancelled' : ''}${diff ? ` data-diff="${diff}"` : ''}/>`;
  })).join('');
  // Every deploy connector out of a PR says the same thing (it waits for that
  // PR to deploy), so the PR gets one rocket, beside its tile, not one per connector.
  const rockets = subs.filter((s) => isPrSub(s) && subs.some((t) => t.after.includes(s.id) && levels.has(s.id))).map((s) => rocketHtml(s.id)).join('');
  return `<div class="job-graph ${editable ? 'editable' : ''}"><div class="job-graph-scroll"><div class="job-graph-canvas" style="--waves:${waves}"><div class="job-graph-columns job-graph-grid" style="grid-template-columns:${template}">${columns}</div>
    <svg class="job-graph-edges" aria-hidden="true">${edges}${rockets}</svg></div></div></div>`;
}

// Trace each connector between the tiles it names, in the canvas's own pixel
// space (the SVG fills the canvas and has no viewBox, so user units are CSS px).
// A canvas with no size — hidden, or a DOM with no layout — leaves the paths
// without geometry rather than drawing them all at the origin.
//
// Connectors run horizontally along rows and lanes (`graphGrid`) and change row
// once per gutter they cross, in one cubic bézier that leaves and arrives level
// (each handle is half its width), so a connector has no corner anywhere. The
// curve is as wide as the free space allows: it may start beside its source's
// tile and end beside its target's, and only falls back towards the gutter
// when a wider curve would touch a tile, a title or a pill (`clear`). The
// gutter itself is always clear, so a connector never crosses a tile. A gutter
// grows a little with its tallest drop (`gutterWidth`). Each tile has a port per
// connector style on each side, so solid, dashed and dotted lines never share a
// stub; curves out of one port fan out from it, and curves into one port fan in.
const GUTTER = { min: 48, curve: 72, max: 104 }, PORT = 10, ROCKET = 34;
const gutterWidth = (dy) => Math.round(Math.min(GUTTER.max, Math.max(GUTTER.min, 40 + dy / 4)));
const bezier = (x0, y0, x1, y1) => { const h = (x1 - x0) / 2; return [x0, y0, x0 + h, y0, x1 - h, y1, x1, y1]; };
const sCurve = (c) => ` H${c[0]} C${c[2]} ${c[3]}, ${c[4]} ${c[5]}, ${c[6]} ${c[7]}`;
// Whether a curve keeps 4px from every obstacle rectangle, sampled along its length.
const clear = (c, obstacles) => {
  for (let i = 1; i < 40; i++) {
    const t = i / 40, u = 1 - t, k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    const x = k[0] * c[0] + k[1] * c[2] + k[2] * c[4] + k[3] * c[6], y = k[0] * c[1] + k[1] * c[3] + k[2] * c[5] + k[3] * c[7];
    if (obstacles.some((o) => x > o.left - 4 && x < o.right + 4 && y > o.top - 4 && y < o.bottom + 4)) return false;
  }
  return true;
};
// The widest clear curve from somewhere in [lo0, hi0] to somewhere in [lo1, hi1]; the gutter-to-gutter one always is.
const widest = (lo0, hi0, y0, lo1, hi1, y1, obstacles) => {
  const steps = [0, 0.25, 0.5, 0.75, 1], pairs = [];
  for (const a of steps) for (const b of steps) pairs.push([lo0 + (hi0 - lo0) * a, hi1 - (hi1 - lo1) * b]);
  pairs.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
  for (const [x0, x1] of pairs) { const c = bezier(x0, y0, x1, y1); if (clear(c, obstacles)) return c; }
  return bezier(hi0, y0, lo1, y1);
};
export function layoutGraphEdges(graph, sized = false) {
  const canvas = graph?.querySelector('.job-graph-canvas');
  if (!canvas) return;
  const base = canvas.getBoundingClientRect();
  if (!base.width) return;
  const box = (r) => ({ left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top, mid: r.top + r.height / 2 - base.top });
  const tiles = new Map(), colOf = new Map(), cols = [];
  for (const el of graph.querySelectorAll('[data-node]')) {
    const stack = el.closest('[data-col]');
    tiles.set(el.dataset.node, box((el.querySelector('.job-node-tile') || el).getBoundingClientRect()));
    if (stack) { const w = +stack.dataset.col; colOf.set(el.dataset.node, w); cols[w] = box(stack.getBoundingClientRect()); }
  }
  // What a curve must not touch: each tile, and everything stacked under it.
  const obstacles = [...graph.querySelectorAll('.job-node-tile, .job-node > :not(.job-node-tile), .job-stack > :not(.job-node)')].map((el) => box(el.getBoundingClientRect())).filter((o) => o.right > o.left);
  const rockets = new Set([...graph.querySelectorAll('.job-edge-glyph')].map((g) => g.dataset.glyph));
  const passes = new Map();
  for (const el of graph.querySelectorAll('.job-graph-pass')) passes.set(el.dataset.pass, [...(passes.get(el.dataset.pass) || []), box(el.getBoundingClientRect())]);
  const paths = [...graph.querySelectorAll('.job-graph-edges path[data-from]')].map((path) => ({ path, from: path.dataset.from, to: path.dataset.to, style: path.getAttribute('class') }));
  // A port per style on each side, stacked by where its connectors head (up
  // above, down below), the straightest on the tile's centre line so it stays straight.
  const ports = new Map();
  const port = (id, side, style, toward) => {
    const k = `${id}|${side}`, m = ports.get(k) || new Map();
    m.set(style, [...(m.get(style) || []), toward - tiles.get(id).mid]); ports.set(k, m);
  };
  const portY = (id, side, style) => {
    const m = ports.get(`${id}|${side}`), mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const order = [...m.keys()].sort((a, b) => mean(m.get(a)) - mean(m.get(b)));
    const centre = order.reduce((c, st, i) => Math.abs(mean(m.get(st))) < Math.abs(mean(m.get(order[c]))) ? i : c, 0);
    return tiles.get(id).mid + (order.indexOf(style) - centre) * PORT;
  };
  // Each connector as horizontal runs (source stub, a run per lane cell, target stub), a curve across each gutter between.
  for (const e of paths) {
    const a = tiles.get(e.from), b = tiles.get(e.to);
    if (!a || !b) { e.path.removeAttribute('d'); e.runs = null; continue; }
    const out = a.right + (rockets.has(e.from) ? ROCKET : 6);
    e.runs = [{ x0: out, x1: out, y: a.mid },
      ...(passes.get(`${e.from}>${e.to}`) || []).map((p) => ({ x0: p.left, x1: p.right, y: p.mid })),
      { x0: b.left - 6, x1: b.left - 6, y: b.mid }];
    port(e.from, 'out', e.style, e.runs[1].y); port(e.to, 'in', e.style, e.runs[e.runs.length - 2].y);
  }
  const drawn = paths.filter((e) => e.runs), drop = [];
  for (const e of drawn) {
    e.runs[0].y = portY(e.from, 'out', e.style); e.runs[e.runs.length - 1].y = portY(e.to, 'in', e.style);
    e.runs.slice(1).forEach((run, i) => { const g = colOf.get(e.from) + i; drop[g] = Math.max(drop[g] || 0, Math.abs(run.y - e.runs[i].y)); });
  }
  // Widen or narrow each gutter to its tallest curve, then trace again on the
  // new layout. Only once: a narrower column can rewrap a title and move a row.
  const grid = graph.querySelector('.job-graph-grid');
  if (grid && !sized) {
    let moved = false;
    for (let g = 0; g < cols.length - 1; g++) {
      const want = drop[g] > 0.5 ? gutterWidth(drop[g]) : GUTTER.min;
      if (Math.abs(want - (cols[g + 1].left - cols[g].right)) > 1) { grid.style.setProperty(`--g${g}`, `${want}px`); moved = true; }
    }
    if (moved) return layoutGraphEdges(graph, true);
  }
  for (const e of drawn) {
    let d = `M${tiles.get(e.from).right + 6} ${e.runs[0].y}`, x = e.runs[0].x0;
    e.runs.slice(1).forEach((run, i) => {
      const g = colOf.get(e.from) + i, prev = e.runs[i];
      if (Math.abs(run.y - prev.y) > 0.5) {
        const c = widest(Math.max(x, prev.x0), cols[g].right, prev.y, cols[g + 1].left, run.x1, run.y, obstacles);
        d += sCurve(c); x = c[6];
      }
      d += ` H${Math.max(x, run.x1)}`; x = Math.max(x, run.x1);
    });
    e.path.setAttribute('d', d);
  }
  // A PR's rocket sits where its connectors leave its tile, before any of them bends away.
  for (const g of graph.querySelectorAll('.job-edge-glyph')) {
    const a = tiles.get(g.dataset.glyph);
    if (a) g.setAttribute('transform', `translate(${a.right + 20} ${a.mid})`); else g.removeAttribute('transform');
  }
}
