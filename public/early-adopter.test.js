import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSwapDetector, createEarlyAdopterGesture, SWAPS, WINDOW_MS } from './early-adopter.js';

// A detector on a fake clock, fed as the theme picker feeds it: each step is
// [theme chosen, ms], starting on `on`, and run() returns the indexes of the
// steps that completed the gesture.
function run(steps, { on = 'wrangler', ...opts } = {}) {
  let t = 0, current = on;
  const d = createSwapDetector({ ...opts, now: () => t });
  return steps.flatMap(([id, at], i) => { t = at; const from = current; current = id; return d.note({ id, from }) ? [i] : []; });
}
const W = 'wrangler', S = 'space', N = 'nord';

test('off the theme, on, off, on inside ten seconds opens it once, back on the theme you started on', () => {
  assert.equal(SWAPS, 4);
  assert.equal(WINDOW_MS, 10000);
  assert.deepEqual(run([[S, 0], [W, 1000], [S, 2000], [W, 3000]]), [3]);
  assert.deepEqual(run([[S, 0], [W, 1000], [S, 2000]]), [], 'three changes are not enough');
});

test('ordinary theme changes never open it', () => {
  assert.deepEqual(run([[S, 0], [W, 60_000], [S, 120_000], [W, 180_000], [S, 240_000]]), [], 'switching now and then');
  assert.deepEqual(run([[S, 0], [W, 0], [W, 100], [W, 200]]), [], 'choosing the theme already on is no change');
  assert.deepEqual(run([[S, 0]]), [], 'one change');
});

test('swaps spread over more than the window start over', () => {
  assert.deepEqual(run([[S, 0], [W, 4000], [S, 8000], [W, 10_001]]), []);
  assert.deepEqual(run([[S, 0], [W, 4000], [S, 8000], [W, 10_001], [S, 11_000], [W, 12_000], [S, 13_000]]), [6], 'the late swap opened a new chain');
  assert.deepEqual(run([[S, 0], [W, 4000], [S, 8000], [W, 10_000]]), [3], 'the window is inclusive');
});

test('a third theme breaks the chain, and the gesture can be made again after it fires', () => {
  assert.deepEqual(run([[S, 0], [W, 100], [N, 200], [W, 300], [N, 400], [W, 500]]), [5], 'wrangler and nord from the third change');
  assert.deepEqual(run([[S, 0], [W, 100], [S, 200], [W, 300], [S, 400], [W, 500], [S, 600], [W, 700]]), [3, 7]);
});

test('without the theme it left, the first change counts and any reverse follows it', () => {
  let t = 0;
  const d = createSwapDetector({ now: () => t });
  assert.deepEqual([S, W, S, W].map((id, i) => { t = i * 100; return d.note({ id }); }), [false, false, false, true]);
  assert.equal(d.note({ id: '' }), false, 'a choice with no id is ignored');
});

function page(t) {
  const window = new Window({ url: 'http://localhost:7878/' });
  t.after(async () => { await window.happyDOM.close(); });
  return window.document;
}

function fakeApi({ ea = true } = {}) {
  let enabled = false;
  const sets = [];
  return {
    sets,
    get earlyAdopter() {
      return ea ? { branch: 'next', enabled: () => enabled, set: async (on) => { sets.push(on); if (ea === 'refuse') throw new Error('No origin to follow'); enabled = on; return on; } } : undefined;
    },
  };
}

test('the gesture opens the Early adopter dialog, and switching it on shows the tracked branch', async (t) => {
  const doc = page(t);
  const api = fakeApi();
  const gesture = createEarlyAdopterGesture(api, { document: doc, now: () => 0 });
  const swap = (id) => gesture.note({ id });
  for (const id of ['space', 'wrangler', 'space']) swap(id);
  assert.equal(doc.querySelector('.ea-dialog'), null, 'three swaps open nothing');
  swap('wrangler');
  const dialog = doc.querySelector('.ea-dialog');
  assert.ok(dialog?.open);
  assert.equal(dialog.querySelector('h2').textContent, 'Early adopter');
  assert.match(dialog.querySelector('[data-ea-state]').textContent, /default branch/);
  const sw = dialog.querySelector('[name=earlyAdopter]');
  sw.checked = true;
  sw.dispatchEvent(new doc.defaultView.Event('change'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(api.sets, [true]);
  assert.equal(dialog.querySelector('.ea-branch').textContent, 'next');
  assert.ok(dialog.querySelector('[name=earlyAdopter]').checked);
});

test('a refused switch goes back and says why', async (t) => {
  const doc = page(t);
  const api = fakeApi({ ea: 'refuse' });
  const gesture = createEarlyAdopterGesture(api, { document: doc, now: () => 0 });
  const swap = (id) => gesture.note({ id });
  for (const id of ['space', 'wrangler', 'space', 'wrangler']) swap(id);
  const dialog = doc.querySelector('.ea-dialog');
  const sw = dialog.querySelector('[name=earlyAdopter]');
  sw.checked = true;
  sw.dispatchEvent(new doc.defaultView.Event('change'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(dialog.querySelector('[name=earlyAdopter]').checked, false);
  assert.equal(dialog.querySelector('.ea-error').textContent, 'No origin to follow');
});

test('a board without api.earlyAdopter draws nothing', (t) => {
  const doc = page(t);
  const api = fakeApi({ ea: false });
  const gesture = createEarlyAdopterGesture(api, { document: doc, now: () => 0 });
  const swap = (id) => gesture.note({ id });
  for (const id of ['space', 'wrangler', 'space', 'wrangler']) swap(id);
  assert.equal(doc.querySelector('.ea-dialog'), null);
  assert.doesNotThrow(() => { const g = createEarlyAdopterGesture(undefined, { document: doc, now: () => 0 }); for (const id of ['space', 'wrangler', 'space', 'wrangler']) g.note({ id }); });
});
