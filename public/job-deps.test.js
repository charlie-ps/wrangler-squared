import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { prerequisitesOf } from './jobs.js';
import { depMarks, wireDeps, relight } from './job-deps.js';
import { planGraphHtml } from './job-graph.js';
import { plateHtml } from './job-plates.js';

const sub = (id, after = [], extra = {}) => ({ id, title: `Deliver ${id}`, repo: '/repo', after, sessions: [], repairs: [], ...extra });
// api ← web ← e2e, docs alone, and a session that starts when web merges, writing a ticket.
const subs = [sub('api'), sub('web', ['api']), sub('e2e', ['web']), sub('docs'),
  sub('note', [], { kind: 'session', on: { sub: 'web', at: 'merged' } }), sub('tick', [], { kind: 'write', by: 'note', place: { type: 'jira' } })];

test('prerequisitesOf walks after and a session\'s on trigger, nearest hop first, and never a write', () => {
  assert.deepEqual([...prerequisitesOf(subs, 'e2e')], [['web', 1], ['api', 2]]);
  assert.deepEqual([...prerequisitesOf(subs, 'note')], [['web', 1], ['api', 2]], 'a milestone is a prerequisite');
  assert.deepEqual([...prerequisitesOf(subs, 'api')], []);
  assert.deepEqual([...prerequisitesOf(subs, 'tick')], [], 'a write is not a step');
  const both = [sub('a'), sub('b', ['a']), sub('c', ['a', 'b'])];
  assert.deepEqual([...prerequisitesOf(both, 'c')], [['a', 1], ['b', 1]], 'reached directly and through another counts as direct');
  const loop = [sub('x', ['y']), sub('y', ['x'])];
  assert.deepEqual([...prerequisitesOf(loop, 'x')], [['y', 1]], 'a cycle terminates');
});

test('depMarks classes the hovered step, its direct and further prerequisites and the connectors between them', () => {
  const edges = [['api', 'web'], ['web', 'e2e'], ['web', 'note'], ['x', 'y']];
  const m = depMarks(edges, 'e2e');
  assert.deepEqual([...m.steps], [['e2e', 'dep-self'], ['web', 'dep-direct'], ['api', 'dep-up']]);
  assert.deepEqual(edges.map(([a, b]) => m.edge(a, b)), ['dep-up', 'dep-direct', null, null]);
  assert.equal(m.any, true);
  assert.equal(depMarks(edges, 'api').any, false);
});

function dom(t) {
  const window = new Window({ url: 'http://localhost:7878' });
  const prev = globalThis.document;
  globalThis.document = window.document;
  t.after(async () => { globalThis.document = prev; await window.happyDOM.close(); });
  const fire = (el, type, relatedTarget = null) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, relatedTarget }));
  return { window, fire };
}
const cls = (root, sel) => [...root.querySelectorAll(sel)].map((e) => [e.dataset.node || (e.dataset.glyph ? `rocket:${e.dataset.glyph}` : `${e.dataset.from}>${e.dataset.to}`), [...e.classList].filter((c) => c.startsWith('dep-')).join(' ')]);

test('hovering a tile in the job graph lights its prerequisites and their connectors, dims the rest, and clears on leave', (t) => {
  const { fire } = dom(t);
  document.body.innerHTML = `<div id="host">${planGraphHtml({ subJobs: subs }, { stateOf: () => 'planned' })}</div>`;
  const host = document.getElementById('host'), graph = host.querySelector('.job-graph');
  wireDeps(host);
  const tile = (id) => graph.querySelector(`.job-node[data-node="${id}"]`);
  fire(tile('e2e').querySelector('.job-node-title'), 'pointerover');
  assert.ok(graph.classList.contains('deps-lit'));
  assert.deepEqual(cls(graph, '.job-node[data-node]').sort(), [['api', 'dep-up'], ['docs', ''], ['e2e', 'dep-self'], ['note', ''], ['web', 'dep-direct']]);
  assert.deepEqual(cls(graph, 'path[data-from]').sort(), [['api>web', 'dep-up'], ['web>e2e', 'dep-direct'], ['web>note', '']]);
  assert.equal(graph.querySelector('.job-write.dep-self, .job-write.dep-up'), null, 'writes are not lit');
  fire(tile('e2e'), 'pointerout', tile('note'));
  assert.deepEqual(cls(graph, '.job-node[data-node]').filter(([, c]) => c).sort(), [['api', 'dep-up'], ['note', 'dep-self'], ['web', 'dep-direct']], 'moving straight to another tile lights its own');
  fire(tile('note'), 'pointerout', host);
  assert.ok(!graph.classList.contains('deps-lit'));
  assert.equal(graph.querySelectorAll('[class*="dep-"]').length, 0, 'everything clears on leave');
});

test('a step with no prerequisites lights only itself, and focus lights as hover does', (t) => {
  const { fire } = dom(t);
  document.body.innerHTML = `<div id="host">${planGraphHtml({ subJobs: subs }, { stateOf: () => 'planned' })}</div>`;
  const host = document.getElementById('host'), graph = host.querySelector('.job-graph');
  wireDeps(host);
  fire(graph.querySelector('[data-node="api"]'), 'pointerover');
  assert.ok(!graph.classList.contains('deps-lit'), 'nothing dims');
  assert.deepEqual(cls(graph, '[class*="dep-"]'), [['api', 'dep-self']]);
  fire(graph.querySelector('[data-node="api"]'), 'pointerout', host);
  graph.querySelector('[data-node="web"]').focus();
  assert.deepEqual(cls(graph, '.dep-self, .dep-direct, .dep-up').sort(), [['api', 'dep-direct'], ['api>web', 'dep-direct'], ['rocket:api', 'dep-up'], ['web', 'dep-self']], 'a PR prerequisite lights its rocket too');
  graph.querySelector('[data-node="web"]').blur();
  assert.equal(graph.querySelectorAll('[class*="dep-"]').length, 0);
});

test('hovering a node on a job plate lights the nodes it waits on, and a re-render keeps the focused one lit', (t) => {
  const { fire } = dom(t);
  const job = { id: 'job1', title: 'Sign-in', intent: 'x', repos: ['/repo'], stage: 'active', subJobs: subs.map((s) => ({ ...s, stage: 'implementation' })), runs: [], moves: [], reviewMerge: true, createdAt: 1 };
  document.body.innerHTML = `<section id="jobs"><div id="boards">${plateHtml(job, 'haiku', 'plain')}</div></section>`;
  const root = document.getElementById('jobs'), boards = document.getElementById('boards');
  wireDeps(root);
  const svg = () => boards.querySelector('.job-plate-graph');
  fire(svg().querySelector('[data-node="e2e"] .core') || svg().querySelector('[data-node="e2e"]'), 'pointerover');
  assert.ok(svg().classList.contains('deps-lit'));
  assert.deepEqual(cls(svg(), '.node[data-node]').filter(([, c]) => c).sort(), [['api', 'dep-up'], ['e2e', 'dep-self'], ['web', 'dep-direct']]);
  assert.deepEqual(cls(svg(), '.edge').filter(([, c]) => c).sort(), [['api>web', 'dep-up'], ['web>e2e', 'dep-direct']]);
  assert.equal(svg().querySelector('.moon[class*="dep-"]'), null, 'a write moon is not lit');
  svg().querySelector('[data-node="note"]').focus();
  boards.innerHTML = plateHtml(job, 'haiku', 'plain');
  assert.equal(svg().querySelectorAll('[class*="dep-"]').length, 0, 'fresh markup carries no highlight');
  svg().querySelector('[data-node="note"]').focus();
  relight(boards);
  assert.deepEqual(cls(svg(), '.node[data-node]').filter(([, c]) => c).sort(), [['api', 'dep-up'], ['note', 'dep-self'], ['web', 'dep-direct']]);
});
