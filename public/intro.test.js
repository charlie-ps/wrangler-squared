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
  assert.deepEqual(INTRO_STEPS.map((s) => s.tab), ['Welcome', 'Jobs', 'New job', 'Sub-jobs', 'Needs you', 'Receipts', 'Reviews', 'Jira', 'Start']);
  assert.equal(p.q('.intro-count').textContent, `1 of ${INTRO_STEPS.length}`);
  assert.ok(p.q('[data-intro="back"]').hidden, 'no Back on the first step');
  assert.equal(document.querySelectorAll('.intro-panel:not([inert])').length, 1, 'every step is laid out, one is live');
  p.click('[data-intro="next"]');
  assert.match(p.title(), /splits the work/);
  p.click('[data-intro="next"]');
  assert.match(p.title(), /plan you approve/);
  assert.equal(p.q('[role="tab"][aria-selected="true"]').textContent, 'New job');
  p.click('[data-intro="back"]');
  p.click('[data-intro="back"]');
  assert.equal(p.title(), 'Welcome');
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

const frames = (step) => Array.from({ length: INTRO_STEPS[step].anim.frames }, (_, i) => {
  const el = document.createElement('div');
  el.innerHTML = INTRO_STEPS[step].figure({}, i);
  return el;
});

test('Welcome plays one job: two PRs in parallel, then a backfill once both deploy, drawn with the stepper markup', async (t) => {
  const p = page(t);
  createIntro({ storage: memoryStorage() }).open();
  assert.ok(p.q('.intro-panel').classList.contains('intro-stack'), 'stacked, the graph full width under the heading');
  assert.equal(document.querySelectorAll('.intro-graph .job-graph-col').length, 2);
  assert.equal(document.querySelectorAll('.intro-graph .job-graph-edges path.deploy').length, 2);
  const line = (el) => [el.querySelector('.intro-goal .job-status'), ...el.querySelectorAll('.intro-graph .job-status')].map((n) => n.textContent).join(' | ');
  assert.equal(line(document), 'Planning | Queued | Queued | Waits for both');
  const seen = frames(0).map(line);
  assert.ok(seen.includes('2 agents working | Writing the PR | Writing the PR | Waits for both'), 'both PRs run at once');
  assert.ok(seen.includes('1 agent working | Deployed | Deployed | Starting'), 'the backfill starts once both deploy');
  assert.equal(seen.at(-1), 'Delivered | Deployed | Deployed | 48,210 users backfilled');
  assert.equal(frames(0).at(-1).querySelectorAll('path.landed').length, 2, 'landed connectors turn green');
  await new Promise((r) => p.window.setTimeout(r, 1450));
  assert.equal(line(document), seen[1], 'it advances by itself');
  p.click('[data-intro="next"]');
  const frozen = p.q('.intro-panel').innerHTML;
  await new Promise((r) => p.window.setTimeout(r, 1450));
  assert.equal(p.q('.intro-panel').innerHTML, frozen, 'the loop stops off the Welcome step');
});

test('the Jobs step plays a mini board whose rail badge counts the amber rows', async (t) => {
  const p = page(t);
  createIntro({ storage: memoryStorage() }).open(1);
  const fig = () => document.querySelectorAll('.intro-panel')[1];
  for (const el of frames(1)) {
    const amber = el.querySelectorAll('.intro-mini-job.tone-warn').length;
    assert.equal(el.querySelector('.intro-rail-badge').textContent, String(amber));
    assert.equal(el.querySelector('.intro-count-pill').textContent, String(amber));
    assert.equal(el.querySelector('.intro-rail-badge').classList.contains('zero'), amber === 0);
  }
  assert.ok(frames(1).some((el) => el.querySelectorAll('.intro-mini-job.tone-warn').length === 2));
  const before = fig().querySelector('.intro-figure').innerHTML;
  await new Promise((r) => p.window.setTimeout(r, 1650));
  assert.notEqual(fig().querySelector('.intro-figure').innerHTML, before, 'it advances by itself');
});

test('with reduced motion each live figure holds a finished frame and nothing ticks', async (t) => {
  const p = page(t);
  p.window.matchMedia = (q) => ({ matches: q.includes('reduce') });
  createIntro({ storage: memoryStorage() }).open();
  const html = p.q('.intro-body').innerHTML;
  assert.match(p.q('.intro-goal').textContent, /Delivered/);
  assert.equal(document.querySelectorAll('.intro-panel')[1].querySelector('.intro-rail-badge').textContent, '2');
  await new Promise((r) => p.window.setTimeout(r, 1450));
  assert.equal(p.q('.intro-body').innerHTML, html);
});

test('the arrow keys step through, and the review checkpoints are a picture that switches in place', (t) => {
  const p = page(t);
  createIntro({ storage: memoryStorage() }).open(6);
  assert.match(p.title(), /stops for you\./);
  const row = () => p.q('.intro-checkpoint[data-checkpoint="reviewMerge"]');
  assert.deepEqual([...p.window.document.querySelectorAll('.intro-checkpoint .job-review-name')].map((n) => n.firstChild.textContent), ['Plan', 'Code', 'Merge', 'Session results', 'Writes'], 'all five checkpoints, in the form’s words');
  const toggle = () => row().querySelector('input[role="switch"]');
  assert.equal(row().querySelectorAll('input').length, 1, 'one control flips the checkpoint');
  assert.equal(toggle().checked, false);
  assert.equal(toggle().getAttribute('aria-label'), 'Merge: Auto');
  assert.equal(row().querySelector('.job-review-toggle').title, 'Merge: Auto');
  assert.equal(row().querySelector('.job-review-toggle').textContent, '', 'icons only; the words are in the title and the name');
  assert.equal(row().querySelector('.job-flag').getAttribute('aria-label'), 'Merge: Auto. PRs merge once checks pass, unless a reviewer leaves blocking comments');
  toggle().click();
  assert.equal(toggle().checked, true);
  assert.equal(toggle().getAttribute('aria-label'), 'Merge: You review');
  assert.equal(row().querySelector('.job-review-toggle').title, 'Merge: You review');
  assert.ok(row().querySelector('.job-flag.you .job-flag-badge'), 'the flag fills amber and takes the hand badge');
  assert.match(row().textContent, /You approve each PR once its checks pass/);
  assert.equal(p.window.document.activeElement, toggle(), 'focus stays on the toggle');
  assert.equal(p.window.document.activeElement.form, null, 'the picture is no form’s field');
  p.q('#jobs-intro').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.match(p.title(), /Work with tickets/);
  p.q('#jobs-intro').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.match(p.title(), /stops for you\./);
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
