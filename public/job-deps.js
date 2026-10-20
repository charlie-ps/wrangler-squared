import { prerequisitesOf } from './jobs.js';

// Hovering or focusing a step lights what it waits on: its direct prerequisites
// most strongly, the steps behind them and every connector on those paths, and
// dims the rest a little. A drawn graph walks its own connectors (each was drawn
// from edgesOf), so this needs no plan, only the markup: a step is a
// `[data-node]` (the dialog's tiles, the plate's nodes; writes are not steps)
// and a connector a `path[data-from][data-to]`. Classes only, toggled by one
// delegated listener on a container that outlives re-renders; `relight` puts
// them back on whatever is still hovered after the markup is replaced.
const SCOPE = '.job-graph, .job-plate-graph';
const STEP = '.job-node[data-node], .node[data-node]';
const MARKS = ['dep-self', 'dep-direct', 'dep-up'];

// What each element of a graph gets when step `id` is lit: id → class for steps,
// and `edge(from, to)` for a connector. Empty `steps` past `id` itself means it waits on nothing.
export function depMarks(edges, id) {
  const into = new Map();
  for (const [from, to] of edges) into.set(to, [...(into.get(to) || []), from]);
  const hops = prerequisitesOf([...new Set([id, ...edges.flat()])].map((n) => ({ id: n, after: [] })), id, (s) => into.get(s.id) || []);
  const steps = new Map([[id, 'dep-self'], ...[...hops].map(([n, k]) => [n, k === 1 ? 'dep-direct' : 'dep-up'])]);
  const edge = (from, to) => (to === id && hops.has(from) ? 'dep-direct' : hops.has(to) && hops.has(from) ? 'dep-up' : null);
  return { steps, edge, any: hops.size > 0 };
}

export function clearDeps(scope) {
  scope.classList.remove('deps-lit');
  for (const el of scope.querySelectorAll(MARKS.map((c) => `.${c}`).join(','))) el.classList.remove(...MARKS);
}

export function lightDeps(node) {
  const scope = node.closest(SCOPE);
  if (!scope) return;
  clearDeps(scope);
  const paths = [...scope.querySelectorAll('path[data-from][data-to]')];
  const { steps, edge, any } = depMarks(paths.map((p) => [p.dataset.from, p.dataset.to]), node.dataset.node);
  node.classList.add('dep-self');
  // A step that waits on nothing lights only itself: nothing is dimmed.
  if (!any) return;
  scope.classList.add('deps-lit');
  for (const el of scope.querySelectorAll(STEP)) { const c = steps.get(el.dataset.node); if (c && el !== node) el.classList.add(c); }
  for (const p of paths) { const c = edge(p.dataset.from, p.dataset.to); if (c) p.classList.add(c); }
  // A PR's rocket sits on its outgoing connectors, so it is lit with the PR.
  for (const g of scope.querySelectorAll('.job-edge-glyph[data-glyph]')) if (steps.has(g.dataset.glyph) && g.dataset.glyph !== node.dataset.node) g.classList.add('dep-up');
}

const stepOf = (el) => el?.closest?.(STEP) || null;

export function relight(root) {
  let hovered = null;
  try { hovered = [...root.querySelectorAll(':hover')].map(stepOf).filter(Boolean).at(-1) || null; } catch { /* no :hover outside a browser */ }
  const step = hovered || (root.contains(document.activeElement) ? stepOf(document.activeElement) : null);
  if (step) lightDeps(step);
}

const wired = new WeakSet();
export function wireDeps(root) {
  if (wired.has(root)) return;
  wired.add(root);
  const leave = (e) => {
    const step = stepOf(e.target);
    if (!step || step.contains(e.relatedTarget)) return;
    const scope = step.closest(SCOPE);
    if (scope) clearDeps(scope);
    const next = stepOf(e.relatedTarget) || (e.type === 'pointerout' && root.contains(document.activeElement) ? stepOf(document.activeElement) : null);
    if (next) lightDeps(next);
  };
  const enter = (e) => { const step = stepOf(e.target); if (step && !step.classList.contains('dep-self')) lightDeps(step); };
  root.addEventListener('pointerover', enter);
  root.addEventListener('focusin', enter);
  root.addEventListener('pointerout', leave);
  root.addEventListener('focusout', leave);
}
