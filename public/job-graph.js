import { esc, tildify } from './util.js';
import { ICONS, ROCKET_PATH } from './icons.js';
import { isPrSub, isSessionSub, isWriteSub, isMakeWrite, writeReviewed, writeWhen, writeAction, placeKey, placesOf, webUrl, PLACES, triggerLine, edgesOf, KIND_TITLE, kindChipHtml, kindLabel, kindClass, dependencyLevels, dependencyLine, storyLabel } from './jobs.js';
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
export const dependencyEditorHtml = (s, others, depKey) => others.filter((d) => !isWriteSub(d)).map((d) => `<label><input type="checkbox" data-dep="${esc(depKey)}" value="${esc(d.id)}" ${s.after.includes(d.id) ? 'checked' : ''}>${kindChipHtml(d)}<span>${esc(d.title)}</span></label>`).join('') || '<span>No other sub-jobs</span>';
// A place pill's parts: the glyph, a short mono label, a dot per write in its
// state, and ↗ once the place exists.
const urgentOf = (states) => ['failing', 'needs'].find((st) => states.includes(st));
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
// The popover's header: the whole name, and Open ↗ once there is somewhere to
// go. Only an http(s) link is ever an href, whoever reported it.
function placeHeadHtml(p) {
  const href = p.type === 'file' ? null : webUrl(p.url);
  const head = `<header class="job-place-head">${PLACES[p.type].icon}<b title="${esc(p.name)}">${esc(p.name)}</b>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">Open ↗</a>` : p.exists ? '' : '<em>not made yet</em>'}</header>`;
  // TODO(host-api file:reveal): the board is served over http and cannot follow
  // file://, so a local file shows its path to copy rather than an Open link.
  return p.type === 'file' && p.url ? `${head}<div class="job-place-path"><code>${esc(p.url)}</code><button type="button" data-copy-path="${esc(p.url)}" title="Copy the path">${ICONS.copy}Copy</button></div>` : head;
}

// A proposed change to a running job's plan (`markOf`) is drawn static, each
// node in its live state and labelled with what approval would do to it.
const MARKS = { frozen: 'Locked · already landed', removed: 'Will be cancelled', added: 'New', edited: 'Edited', kept: 'Unchanged' };
export function planGraphHtml(plan, { editable = false, stateOf = null, lineOf = null, markOf = null, openDeps = new Set(), openTickets = new Set(), editing = null, reviewWrites = false } = {}) {
  const subs = plan.subJobs;
  if (!subs.length) return '';
  const levels = dependencyLevels(plan);
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
    const flags = `${reviewed && !editable ? `<span class="job-write-review" title="${isMakeWrite(w) ? 'Reviewed once published' : 'Drafted for your review before it is written'}">${ICONS.eye}</span>` : ''}${editable && !w.added ? `<span class="job-proposed" title="Proposed by the planner">${ICONS.sparkle}</span>` : ''}`;
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
  const waves = Math.max(...levels.values()) + 1;
  const story = (s) => s.jiraKey || (s.storyId ? storyLabel(plan.stories?.find((t) => t.id === s.storyId), plan.stories) : 'No ticket');
  const node = (s, i) => {
    const state = stateOf ? stateOf(s) : 'planned';
    const deps = dependencyLine(plan, s);
    const tip = [KIND_TITLE[kindClass(s)], story(s), isPrSub(s) ? tildify(s.repo) : '', deps, stateOf ? STATES[state].label : ''].filter(Boolean).join('\n');
    const tile = `<span class="job-node-tile ${stateSolid(state) ? 'on' : ''}">${kindChipHtml(s)}<span class="job-node-state">${stateIconHtml(state)}</span></span>`;
    const cls = `job-node tone-${STATES[state].tone} ${kindClass(s)}`;
    const repo = isPrSub(s) && s.kind !== 'jira' && s.repo ? `<span class="job-node-repo">${esc(tildify(s.repo).split('/').pop())}</span>`
      : triggerLine(plan, s) ? `<span class="job-node-repo job-node-on" title="Starts at this milestone">${esc(triggerLine(plan, s))}</span>` : '';
    if (editable) {
      const others = subs.filter((d) => d.id !== s.id && !isWriteSub(d));
      return `<div class="${cls}" data-node="${esc(s.id)}" title="${esc(tip)}">${tile}<textarea class="job-node-title" aria-label="${kindLabel(s)} title ${i + 1}" data-title="${i}" maxlength="180" rows="3">${esc(s.title)}</textarea>${repo}
        <details class="job-node-deps" data-deps="${esc(s.id)}" ${openDeps.has(s.id) ? 'open' : ''}><summary title="${esc(deps || 'Independent')} · change">${ICONS.link}<span>${s.after.length || 'None'}</span></summary>${dependencyEditorHtml(s, others, String(i))}</details></div>`;
    }
    if (markOf) { const mark = markOf(s); return `<div class="${cls} job-mark-${mark}" data-node="${esc(s.id)}" title="${esc(tip)}">${tile}<strong class="job-node-title">${esc(s.title)}</strong>${repo}<span class="job-mark">${mark === 'frozen' ? ICONS.lock : ''}${esc(MARKS[mark])}</span></div>`; }
    if (!stateOf) return `<div class="${cls}" data-node="${esc(s.id)}" title="${esc(tip)}">${tile}<strong class="job-node-title">${esc(s.title)}</strong>${repo}</div>`;
    return `<button type="button" class="${cls} ${state === 'done' ? 'done' : ''}" data-node="${esc(s.id)}" data-open-sub="${esc(s.id)}" title="${esc(tip)}">${tile}<strong class="job-node-title">${esc(s.title)}</strong>${repo}<span class="job-status">${esc(lineOf ? lineOf(s) : STATES[state].label)}</span></button>`;
  };
  const loose = subs.filter((w) => isWriteSub(w) && !hangsOn(w));
  const columns = Array.from({ length: waves }, (_, w) => `<div class="job-graph-col">${w === 0 && loose.length ? `<div class="job-stack job-stack-loose"><div class="job-places">${pills(loose, '')}</div></div>` : ''}${subs.map((s, i) => levels.get(s.id) === w && !isWriteSub(s) ? `<div class="job-stack">${node(s, i)}${hanging(s)}</div>` : '').join('')}</div>`).join('');
  const edges = subs.flatMap((s) => edgesOf(s).filter((id) => levels.has(id)).map((id) => {
    const deploy = isPrSub(byId.get(id)) && s.after.includes(id);
    return `<path class="${deploy ? 'deploy' : s.after.includes(id) ? 'start' : 'on'}" data-from="${esc(id)}" data-to="${esc(s.id)}"/>${deploy ? `<g class="job-edge-glyph" data-glyph="${esc(id)}>${esc(s.id)}"><circle r="12"/><g transform="translate(-9.6 -9.6) scale(.8)">${ROCKET_PATH}</g></g>` : ''}`;
  })).join('');
  return `<div class="job-graph ${editable ? 'editable' : ''}"><div class="job-graph-scroll"><div class="job-graph-canvas" style="--waves:${waves}"><div class="job-graph-columns">${columns}</div>
    <svg class="job-graph-edges" aria-hidden="true">${edges}</svg></div></div></div>`;
}

// Trace each connector between the tiles it names, in the canvas's own pixel
// space (the SVG fills the canvas and has no viewBox, so user units are CSS px).
// A canvas with no size — hidden, or a DOM with no layout — leaves the paths
// without geometry rather than drawing them all at the origin.
export function layoutGraphEdges(graph) {
  const canvas = graph?.querySelector('.job-graph-canvas');
  if (!canvas) return;
  const base = canvas.getBoundingClientRect();
  if (!base.width) return;
  const boxes = new Map([...graph.querySelectorAll('[data-node]')].map((el) => [el.dataset.node, (el.querySelector('.job-node-tile') || el).getBoundingClientRect()]));
  const glyphs = new Map([...graph.querySelectorAll('.job-edge-glyph')].map((g) => [g.dataset.glyph, g]));
  for (const path of graph.querySelectorAll('.job-graph-edges path[data-from]')) {
    const a = boxes.get(path.dataset.from), b = boxes.get(path.dataset.to);
    const glyph = glyphs.get(`${path.dataset.from}>${path.dataset.to}`);
    if (!a || !b) { path.removeAttribute('d'); glyph?.removeAttribute('transform'); continue; }
    const x1 = a.right - base.left + 6, y1 = a.top + a.height / 2 - base.top;
    const x2 = b.left - base.left - 6, y2 = b.top + b.height / 2 - base.top;
    const bend = Math.max(24, Math.abs(x2 - x1) / 2);
    path.setAttribute('d', `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    glyph?.setAttribute('transform', `translate(${(x1 + x2) / 2} ${(y1 + y2) / 2})`);
  }
}
