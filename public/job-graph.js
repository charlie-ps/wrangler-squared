import { esc, tildify } from './util.js';
import { ICONS, ROCKET_PATH } from './icons.js';
import { isPrSub, KIND_TITLE, kindChipHtml, kindIconHtml, kindLabel, kindClass, kindCountLabel, dependencyLevels, dependencyLine, storyLabel, jobCostLabel, JOB_COST_TITLE, reviewFlagsLabel } from './jobs.js';
import { STATES, stateIconHtml, stateSolid, subState, subLine, jobState, jobLabel } from './job-state.js';

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
export const dependencyEditorHtml = (s, others, depKey) => others.map((d) => `<label><input type="checkbox" data-dep="${esc(depKey)}" value="${esc(d.id)}" ${s.after.includes(d.id) ? 'checked' : ''}>${kindChipHtml(d)}<span>${esc(d.title)}</span></label>`).join('') || '<span>No other sub-jobs</span>';
// A proposed change to a running job's plan (`markOf`) is drawn static, each
// node in its live state and labelled with what approval would do to it.
const MARKS = { frozen: 'Locked · already landed', removed: 'Will be cancelled', added: 'New', edited: 'Edited', kept: 'Unchanged' };
export function planGraphHtml(plan, { editable = false, stateOf = null, lineOf = null, markOf = null, openDeps = new Set() } = {}) {
  const subs = plan.subJobs;
  if (!subs.length) return '';
  const levels = dependencyLevels(plan);
  const waves = Math.max(...levels.values()) + 1;
  const story = (s) => s.jiraKey || (s.storyId ? storyLabel(plan.stories?.find((t) => t.id === s.storyId), plan.stories) : 'No ticket');
  const node = (s, i) => {
    const state = stateOf ? stateOf(s) : 'planned';
    const deps = dependencyLine(plan, s);
    const tip = [KIND_TITLE[kindClass(s)], story(s), isPrSub(s) ? tildify(s.repo) : '', deps, stateOf ? STATES[state].label : ''].filter(Boolean).join('\n');
    const tile = `<span class="job-node-tile ${stateSolid(state) ? 'on' : ''}">${kindChipHtml(s)}<span class="job-node-state">${stateIconHtml(state)}</span></span>`;
    const cls = `job-node tone-${STATES[state].tone} ${kindClass(s)}`;
    if (editable) {
      const others = subs.filter((d) => d.id !== s.id);
      return `<div class="${cls}" data-node="${esc(s.id)}" title="${esc(tip)}">${tile}<textarea class="job-node-title" aria-label="${kindLabel(s)} title ${i + 1}" data-title="${i}" maxlength="180" rows="3">${esc(s.title)}</textarea>
        <details class="job-node-deps" data-deps="${esc(s.id)}" ${openDeps.has(s.id) ? 'open' : ''}><summary title="${esc(deps || 'Independent')} · change">${ICONS.link}<span>${s.after.length || 'None'}</span></summary>${dependencyEditorHtml(s, others, String(i))}</details></div>`;
    }
    if (markOf) { const mark = markOf(s); return `<div class="${cls} job-mark-${mark}" data-node="${esc(s.id)}" title="${esc(tip)}">${tile}<strong class="job-node-title">${esc(s.title)}</strong><span class="job-mark">${mark === 'frozen' ? ICONS.lock : ''}${esc(MARKS[mark])}</span></div>`; }
    if (!stateOf) return `<div class="${cls}" data-node="${esc(s.id)}" title="${esc(tip)}">${tile}<strong class="job-node-title">${esc(s.title)}</strong></div>`;
    return `<button type="button" class="${cls} ${state === 'done' ? 'done' : ''}" data-node="${esc(s.id)}" data-open-sub="${esc(s.id)}" title="${esc(tip)}">${tile}<strong class="job-node-title">${esc(s.title)}</strong><span class="job-status">${esc(lineOf ? lineOf(s) : STATES[state].label)}</span></button>`;
  };
  const columns = Array.from({ length: waves }, (_, w) => `<div class="job-graph-col">${subs.map((s, i) => levels.get(s.id) === w ? node(s, i) : '').join('')}</div>`).join('');
  const byId = new Map(subs.map((s) => [s.id, s]));
  const edges = subs.flatMap((s) => s.after.filter((id) => levels.has(id)).map((id) => {
    const deploy = isPrSub(byId.get(id));
    return `<path class="${deploy ? 'deploy' : 'start'}" data-from="${esc(id)}" data-to="${esc(s.id)}"/>${deploy ? `<g class="job-edge-glyph" data-glyph="${esc(id)}>${esc(s.id)}"><circle r="12"/><g transform="translate(-9.6 -9.6) scale(.8)">${ROCKET_PATH}</g></g>` : ''}`;
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

// The board's tonal card: the whole surface is the job's rolled-up state, the
// progress bar one segment per sub-job in that sub-job's own state, its kind icon above it, in
// dependency-wave order like the graph (a reorder or replan edits `after`, not the array). The open
// button stretches over the card; the segments sit above it and open their
// sub-job directly.
export function jobTileHtml(job) {
  const state = jobState(job);
  const label = jobLabel(job);
  const cost = jobCostLabel(job.usd, job.usdEstimated);
  const live = job.stage === 'active' || job.stage === 'done';
  const plan = { subJobs: live ? job.subJobs : job.plan?.subJobs || [] };
  const levels = dependencyLevels(plan);
  const subs = [...plan.subJobs].sort((a, b) => levels.get(a.id) - levels.get(b.id));
  const segs = subs.map((s) => {
    const st = live ? subState(job, s) : 'planned';
    const tip = `${s.title} · ${live ? subLine(job, s) : 'Planned'}`;
    return live ? `<button type="button" class="job-seg tone-${STATES[st].tone} ${st}" data-job="${esc(job.id)}" data-sub="${esc(s.id)}" title="${esc(tip)}" aria-label="${esc(tip)}">${kindIconHtml(s)}</button>`
      : `<span class="job-seg tone-idle planned" title="${esc(tip)}">${kindIconHtml(s)}</span>`;
  }).join('');
  const tip = [subs.length ? kindCountLabel(subs) : '', reviewFlagsLabel(job)].filter(Boolean).join(' · ');
  return `<article class="job-card tone-${STATES[state].tone} ${state}" data-board="${esc(job.id)}">
    <button class="job-card-open" data-job="${esc(job.id)}" data-sub="" title="${esc(tip)}"><span class="job-avatar ${state}" role="img" aria-label="${esc(STATES[state].label)}">${stateIconHtml(state)}</span><strong>${esc(job.title)}</strong></button>
    ${segs ? `<div class="job-progress">${segs}</div>` : ''}
    <footer><span class="job-status">${esc(label)}</span>${cost ? `<span class="job-card-cost" title="${esc(JOB_COST_TITLE)}${job.usdEstimated ? ' · includes an estimate for Codex sessions' : ''}">${esc(cost)}</span>` : ''}</footer></article>`;
}
