import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createUpdates, UPDATES, SEEN_UPDATES_KEY } from './updates.js';
import { SEEN_KEY } from './intro.js';
import { initJobsView } from './jobs-view.js';
import client from './index.js';

const memoryStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { map: m, get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) }; };
const seenIds = (storage) => JSON.parse(storage.get(SEEN_UPDATES_KEY) || '[]').sort();

function page(t) {
  const window = new Window({ url: 'http://localhost:7878/' });
  const prev = globalThis.document;
  globalThis.document = window.document;
  t.after(async () => { globalThis.document = prev; await window.happyDOM.close(); });
  const q = (s) => document.querySelector(s);
  return { window, q, title: () => q('#jobs-update-title').textContent, click: (s) => q(s).click() };
}

// Listed out of order on purpose: the splash and the list sort by date.
const SAMPLE = [
  { id: 'b', date: '2026-10-01', title: 'Second release', body: '<p>Second body</p>', icon: 'eye', tone: 'warn' },
  { id: 'a', date: '2026-09-01', title: 'First release', body: '<p>First body</p>', figure: (phase) => `<span class="fig">frame ${phase}</span>`, anim: { frames: 3, ms: 50, still: 2 } },
  { id: 'c', date: '2026-11-01', title: 'Third release', body: '<p>Third body</p>' },
];

test('the shipped registry is the two Writes pages, review defaults, See it working, the three planner pages and New idea, and every frame of their figures draws', (t) => {
  const p = page(t);
  assert.deepEqual(UPDATES.map((u) => u.id), ['writes-designs', 'writes-places', 'review-defaults', 'see-it-working', 'planner-red-steps', 'planner-options', 'planner-add-idea', 'new-idea']);
  for (const u of UPDATES.filter((u) => u.anim)) {
    for (let i = 0; i < u.anim.frames; i++) assert.match(u.figure(i), /job-node|job-option|job-plate/, `${u.id} frame ${i}`);
    assert.ok(u.anim.still < u.anim.frames, u.id);
  }
  const see = UPDATES.find((u) => u.id === 'see-it-working');
  assert.match(see.figure(4), /class="wn-change-text">Does it keep the column order when a filter is on\?</, 'the question shows in full, not in a one-row textarea');
  assert.doesNotMatch(see.figure(4), /<textarea/);
  assert.match(see.figure(8), /Stopped what the agent started/);
  const idea = UPDATES.find((u) => u.id === 'new-idea');
  const drawn = (i) => { const d = document.createElement('div'); d.innerHTML = idea.figure(i); return d; };
  const at = (i) => { const d = drawn(i); return { plate: d.querySelector('.wn-ideas-plate .job-plate'), sky: d.querySelector('.wn-ideas-plate .gx')?.dataset, chat: d.querySelector('.wn-ideas-chat .job-idea-thread') }; };
  assert.match(at(0).chat.textContent, /Planner is reading the idea/, 'an idea opens on the planner reading it');
  assert.ok(at(0).plate.classList.contains('idea'));
  assert.deepEqual([0, 1, 2, 3].map((i) => at(i).sky.stage), ['0', '1', '0', '2'], 'its sky brightens as the planner asks, then suggests');
  assert.match(at(1).plate.querySelector('.job-plate-stub').textContent, /Your reply/);
  assert.ok(at(3).chat.querySelector('.job-launch.live [data-accept-idea]'), 'the suggestion is a launch strip with one button');
  assert.ok(at(3).plate.querySelector('.job-plate-stub').textContent.startsWith('Job suggested'));
  assert.ok(at(5).chat.querySelector('.job-launch.firing'));
  assert.match(at(6).chat.querySelector('.job-launch.done').textContent, /Creating the job/);
  assert.ok(!at(7).plate.classList.contains('idea'), 'and the job takes the idea’s place on the board');
  assert.match(at(7).plate.querySelector('.job-plate-stub').textContent, /Plan ready/);
  assert.ok([...Array(idea.anim.frames).keys()].every((i) => !drawn(i).querySelector('button:not([tabindex="-1"])')), 'its buttons stay out of the tab order');
  const storage = memoryStorage();
  assert.equal(createUpdates({ storage }).maybeShow(), true);
  assert.equal(p.title(), 'See the design before anything is built');
  assert.equal(p.q('.intro-count').textContent, '1 of 8');
  assert.ok(p.q('.update-panel .wn-row3'));
  p.click('[data-update="next"]');
  assert.match(p.title(), /^Jira, Slack and Confluence/);
  assert.ok(p.q('.update-panel .wn-writes'));
  p.click('[data-update="next"]');
  assert.equal(p.title(), 'Choose where every new job’s checkpoints start');
  p.click('[data-update="next"]');
  assert.equal(p.title(), 'See each PR working before you read its diff');
  assert.ok(p.q('.update-panel .job-proof-list'));
  p.click('[data-update="next"]');
  assert.equal(p.title(), 'A failing step goes to the planner first');
  assert.ok(p.q('.update-panel .wn-row3 .job-node.tone-idle'));
  p.click('[data-update="next"]');
  assert.equal(p.title(), 'Pick from up to three ranked options');
  assert.equal(p.q('.update-panel .wn-ask').querySelectorAll('.job-option').length, 3);
  p.click('[data-update="next"]');
  assert.equal(p.title(), 'Say what to change, on any step');
  assert.ok(p.q('.update-panel .wn-idea .job-change'));
  p.click('[data-update="next"]');
  assert.equal(p.title(), 'Start with an idea, not a plan');
  assert.ok(p.q('.update-panel .wn-ideas .job-plate.idea .gx.nb[data-inflow]'), 'the idea’s plate with its forming sky');
  assert.equal(p.q('[data-update="next"]').textContent, 'Got it');
  p.click('[data-update="next"]');
  assert.deepEqual(seenIds(storage), ['new-idea', 'planner-add-idea', 'planner-options', 'planner-red-steps', 'review-defaults', 'see-it-working', 'writes-designs', 'writes-places']);
});

test('a reader behind on several releases steps through each unseen one, oldest first, with Next and Back', (t) => {
  const p = page(t);
  const storage = memoryStorage({ [SEEN_UPDATES_KEY]: JSON.stringify(['b']) });
  assert.equal(createUpdates({ storage, updates: SAMPLE }).maybeShow(), true);
  const dialog = p.q('#jobs-update');
  assert.ok(dialog.open);
  assert.equal(dialog.parentElement, document.body, 'on <body>, so a hidden view host cannot stop showModal');
  assert.equal(p.title(), 'First release');
  assert.equal(p.q('.intro-count').textContent, '1 of 2', 'the seen one is skipped');
  assert.equal(p.q('.update-date').getAttribute('datetime'), '2026-09-01');
  assert.match(p.q('.update-date').textContent, /September 2026/);
  assert.ok(p.q('[data-update="back"]').hidden);
  assert.match(p.q('[data-update="next"]').textContent, /Next/);
  assert.ok(p.q('.update-panel .intro-figure'), 'a figure sits above the title when the update has one');
  assert.equal(p.q('.job-actions').textContent.includes('Learn more'), false);
  p.click('[data-update="next"]');
  assert.equal(p.title(), 'Third release');
  assert.equal(p.q('.intro-count').textContent, '2 of 2');
  assert.equal(p.q('.update-panel .intro-figure'), null);
  assert.equal(p.q('[data-update="next"]').textContent, 'Got it');
  assert.ok(p.q('[data-update="next"]').classList.contains('tone-ok'));
  dialog.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(p.title(), 'First release');
  p.click('[data-update="next"]');
  assert.deepEqual(seenIds(storage), ['b'], 'nothing is recorded while it is still open');
  p.click('[data-update="next"]');
  assert.equal(dialog.open, false);
  assert.deepEqual(seenIds(storage), ['a', 'b', 'c']);
  assert.equal(createUpdates({ storage, updates: SAMPLE }).maybeShow(), false, 'each shows once');
});

test('one update has no count, and closing it any way, even part way through a run, records the whole run', (t) => {
  for (const exit of ['.jobs-update .job-dialog-close', 'escape']) {
    const p = page(t);
    const storage = memoryStorage({ [SEEN_UPDATES_KEY]: JSON.stringify(['a', 'b']) });
    createUpdates({ storage, updates: SAMPLE }).maybeShow();
    assert.equal(p.q('.intro-count').textContent, '');
    assert.equal(p.q('[data-update="next"]').textContent, 'Got it');
    if (exit === 'escape') p.q('#jobs-update').close(); else p.click(exit);
    assert.deepEqual(seenIds(storage), ['a', 'b', 'c'], exit);
  }
  const p = page(t);
  const storage = memoryStorage();
  createUpdates({ storage, updates: SAMPLE }).maybeShow();
  p.click('.jobs-update .job-dialog-close');
  assert.deepEqual(seenIds(storage), ['a', 'b', 'c']);
});

test('with no storage it never opens by itself, and unreadable storage counts as nothing seen', (t) => {
  const p = page(t);
  assert.equal(createUpdates({ storage: null, updates: SAMPLE }).maybeShow(), false);
  assert.equal(p.q('#jobs-update'), null);
  assert.equal(createUpdates({ storage: memoryStorage({ [SEEN_UPDATES_KEY]: '{not json' }), updates: SAMPLE }).maybeShow(), true);
  assert.equal(p.title(), 'First release');
});

test('an animated figure redraws itself, and holds its still frame with reduced motion', async (t) => {
  const p = page(t);
  createUpdates({ storage: memoryStorage(), updates: SAMPLE }).maybeShow();
  const fig = p.q('.fig');
  assert.equal(fig.textContent, 'frame 0');
  await new Promise((r) => p.window.setTimeout(r, 70));
  assert.equal(p.q('.fig').textContent, 'frame 1');
  assert.equal(p.q('.fig'), fig, 'redrawn in place, not rebuilt, so the figure does not flash');
  const q = page(t);
  q.window.matchMedia = (m) => ({ matches: m.includes('reduce') });
  createUpdates({ storage: memoryStorage(), updates: SAMPLE }).open('a');
  assert.equal(q.q('.fig').textContent, 'frame 2');
  await new Promise((r) => q.window.setTimeout(r, 70));
  assert.equal(q.q('.fig').textContent, 'frame 2');
});

const settings = (p, updates) => {
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  initJobsView({ send: () => {}, getAgents: () => [], onSession: () => {}, onDiff: () => {}, onBoard: () => false, updates });
  p.click('#jobs-settings');
};

test('Automation settings lists past updates newest first, and each reopens its own splash', (t) => {
  const p = page(t);
  const storage = memoryStorage({ [SEEN_UPDATES_KEY]: JSON.stringify(['a', 'b']) });
  settings(p, createUpdates({ storage, updates: SAMPLE }));
  const rows = [...document.querySelectorAll('.update-item')];
  assert.deepEqual(rows.map((r) => r.querySelector('strong').textContent), ['Third release', 'Second release', 'First release']);
  assert.deepEqual(rows.map((r) => !!r.querySelector('.update-new')), [true, false, false], 'unseen ones are marked new');
  assert.ok(rows[1].classList.contains('tone-warn'));
  assert.equal(p.q('.update-empty'), null);
  rows[1].click();
  assert.equal(p.q('#job-dialog').open, false, 'settings closes first, so the splash is not stacked on it');
  assert.ok(p.q('#jobs-update').open);
  assert.equal(p.title(), 'Second release');
  assert.equal(p.q('.intro-count').textContent, '', 'just that one');
  p.click('[data-update="next"]');
  assert.deepEqual(seenIds(storage), ['a', 'b']);
});

test('Automation settings shows an empty state when there are no updates', (t) => {
  const p = page(t);
  settings(p, createUpdates({ storage: memoryStorage(), updates: [] }));
  assert.match(p.q('.update-section h3').textContent, /What’s new/);
  assert.equal(document.querySelectorAll('.update-item').length, 0);
  assert.match(p.q('.update-empty').textContent, /Nothing here yet/);
  settings(p, undefined);
  assert.ok(p.q('.update-empty'), 'and without the updates dependency at all');
});

// The client wires these to the shipped registry; the hand-off to the intro and
// the wait for the Jobs view are what is observable from here.
test('the client never opens an update on top of the first-run intro', (t) => {
  const p = page(t);
  const storage = memoryStorage();
  client.register({ register: () => {}, onMessage: () => {}, api: { storage } });
  assert.ok(p.q('#jobs-intro').open);
  assert.equal(p.q('#jobs-update'), null);
  p.click('.jobs-intro .job-dialog-close');
  assert.equal(storage.get(SEEN_KEY), '1');
  assert.deepEqual(seenIds(storage), ['new-idea', 'planner-add-idea', 'planner-options', 'planner-red-steps', 'review-defaults', 'see-it-working', 'writes-designs', 'writes-places'], 'closing the intro counts every current update as seen');
});

test('the client holds unseen updates until the reader opens the Jobs view', (t) => {
  const p = page(t);
  const storage = memoryStorage({ [SEEN_KEY]: '1' });
  client.register({ register: () => {}, onMessage: () => {}, api: { storage } });
  assert.equal(p.q('#jobs-update'), null, 'not on the sessions board');
  p.window.location.hash = '#view=search';
  p.window.dispatchEvent(new p.window.Event('hashchange'));
  assert.equal(p.q('#jobs-update'), null, 'nor on another view');
  p.window.location.hash = '#view=ext:jobs:board';
  p.window.dispatchEvent(new p.window.Event('hashchange'));
  assert.ok(p.q('#jobs-update').open);
  assert.equal(p.title(), 'See the design before anything is built');
});
