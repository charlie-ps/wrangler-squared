import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createIntro, INTRO_STEPS, SEEN_KEY } from './intro.js';
import { initJobsView } from './jobs-view.js';
import client from './index.js';

// The board's namespaced storage (agent-wrangler public/slots.js namespacedStorage),
// minus the prefix: get/set/remove over a plain map.
const memoryStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { map: m, get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) }; };

function page(t) {
  const window = new Window({ url: 'http://localhost:7878/' });
  const prev = globalThis.document;
  globalThis.document = window.document;
  t.after(async () => { globalThis.document = prev; await window.happyDOM.close(); });
  const q = (s) => document.querySelector(s);
  return { window, q, title: () => q('#jobs-intro-title').textContent, click: (s) => q(s).click() };
}

test('opens by itself for a reader who has not seen it, and every way out records that they have', (t) => {
  for (const exit of ['.jobs-intro .job-dialog-close', '[data-intro="skip"]']) {
    const p = page(t);
    const storage = memoryStorage();
    createIntro({ storage }).maybeShow();
    assert.ok(p.q('#jobs-intro').open, 'unseen opens');
    assert.equal(p.q('#jobs-intro').parentElement, document.body, 'on <body>, so a hidden view host cannot stop showModal');
    p.click(exit);
    assert.equal(p.q('#jobs-intro').open, false);
    assert.equal(storage.get(SEEN_KEY), '1', `${exit} marks it seen`);
  }
  const p = page(t);
  const storage = memoryStorage();
  createIntro({ storage }).maybeShow();
  p.q('#jobs-intro').dispatchEvent(new p.window.Event('cancel', { cancelable: true }));
  p.q('#jobs-intro').close();
  assert.equal(storage.get(SEEN_KEY), '1', 'Escape marks it seen too');
});

test('a reader who has seen it is never shown it again, and with no storage it never opens by itself', (t) => {
  const p = page(t);
  createIntro({ storage: memoryStorage({ [SEEN_KEY]: '1' }) }).maybeShow();
  assert.equal(p.q('#jobs-intro'), null);
  createIntro({ storage: null }).maybeShow();
  assert.equal(p.q('#jobs-intro'), null, 'nothing could record the dismissal, so it would show on every load');
});

test('Next, Back and the stepper walk the steps; only the current one is readable and the last ends on New job', (t) => {
  const p = page(t);
  let started = 0;
  const storage = memoryStorage();
  createIntro({ storage, onNewJob: () => { started += 1; } }).open();
  assert.deepEqual(INTRO_STEPS.map((s) => s.tab), ['Welcome', 'New job', 'Sub-jobs', 'Needs you', 'Receipts', 'Review gates', 'Jira', 'Start']);
  assert.equal(p.q('.intro-count').textContent, `1 of ${INTRO_STEPS.length}`);
  assert.ok(p.q('[data-intro="back"]').hidden, 'no Back on the first step');
  assert.equal(document.querySelectorAll('.intro-panel:not([inert])').length, 1, 'every step is laid out, one is live');
  p.click('[data-intro="next"]');
  assert.match(p.title(), /plan you approve/);
  assert.equal(p.q('[role="tab"][aria-selected="true"]').textContent, 'New job');
  p.click('[data-intro="back"]');
  assert.match(p.title(), /an outcome/);
  p.click(`[data-go="${INTRO_STEPS.length - 1}"]`);
  assert.match(p.title(), /ready to start/);
  assert.ok(p.q('[data-intro="skip"]').hidden, 'no Skip on the last step');
  assert.match(p.q('[data-intro="next"]').textContent, /New job/);
  assert.ok(p.q('[data-intro="next"]').classList.contains('tone-ok'));
  p.click('[data-intro="next"]');
  assert.equal(started, 1);
  assert.equal(p.q('#jobs-intro').open, false);
  assert.equal(storage.get(SEEN_KEY), '1');
});

test('the arrow keys step through, and the gate switches are a picture that toggles in place', (t) => {
  const p = page(t);
  createIntro({ storage: memoryStorage() }).open(5);
  assert.match(p.title(), /stops for your review/);
  const sw = () => p.q('[data-gate="merge"]');
  assert.equal(sw().getAttribute('aria-checked'), 'false');
  sw().click();
  assert.equal(sw().getAttribute('aria-checked'), 'true');
  assert.match(sw().closest('.intro-gate').textContent, /You approve each green PR/);
  p.q('#jobs-intro').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.match(p.title(), /Work with tickets/);
  p.q('#jobs-intro').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.match(p.title(), /stops for your review/);
});

test('reopens from the Jobs header and from Automation settings', (t) => {
  const p = page(t);
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  let opened = 0;
  initJobsView({ send: () => {}, getAgents: () => [], onSession: () => {}, onDiff: () => {}, onBoard: () => false, onIntro: () => { opened += 1; } });
  assert.equal(p.q('#jobs-intro-open').getAttribute('aria-label'), 'How Jobs works');
  p.click('#jobs-intro-open');
  assert.equal(opened, 1);
  p.click('#jobs-settings');
  p.click('#job-settings-intro');
  assert.equal(opened, 2);
  assert.equal(p.q('#job-dialog').open, false, 'settings closes first, so the intro is not stacked on it');
});

// The real client module, registered the way slots.js does with the registrar's
// own `api` (host api 1.14): the intro shows on load, before the Jobs view has
// ever been mounted, and its New job switches to the view and opens the form.
test('the client shows the intro on load to an unseen reader and its New job lands on the Jobs form', (t) => {
  const p = page(t);
  const storage = memoryStorage();
  const contributions = [];
  client.register({ register: (slot, c) => contributions.push(c), onMessage: () => {}, api: { storage } });
  assert.ok(p.q('#jobs-intro').open);
  p.click(`[data-go="${INTRO_STEPS.length - 1}"]`);
  p.click('[data-intro="next"]');
  assert.equal(p.window.location.hash, '#view=ext:jobs:board');
  assert.equal(storage.get(SEEN_KEY), '1');
  const el = document.createElement('div');
  document.body.appendChild(el);
  contributions[0].mount(el, { send: () => {}, agents: () => [{ id: 'claude', label: 'Claude', models: [], efforts: [] }], storage });
  assert.ok(p.q('#job-create-form'), 'the New job form opens once the view mounts');
  p.click('#jobs-intro-open');
  assert.ok(p.q('#jobs-intro').open, 'and the header button brings the intro back');
  contributions[0].unmount();
});
