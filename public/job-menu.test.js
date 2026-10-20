import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { jobMenuItems, jobReference, jobPrs, jobStories, mountJobMenu } from './job-menu.js';
import { initJobsView } from './jobs-view.js';

const prSub = (id, extra = {}) => ({ id, title: `Deliver ${id}`, repo: '/repo', after: [], brief: 'Do it', sessions: [], repairs: [], stage: 'pr', ...extra });
const plan = { jiraSite: 'https://example.atlassian.net/', stories: [{ id: 'story', key: 'PROJ-1', title: 'Customers can sign in' }], subJobs: [prSub('api', { storyId: 'story', jiraKey: 'PROJ-1' })] };
const backlog = { id: 'job_b', title: 'Backlog job', stage: 'backlog', plan: null, subJobs: [], runs: [], moves: [] };
const running = { id: 'job_r', title: 'Sign-in', stage: 'active', plan, runs: [], moves: [], subJobs: [
  prSub('api', { storyId: 'story', jiraKey: 'PROJ-1', pr: { url: 'https://github.com/acme/widgets/pull/12', number: 12, head: 'h1' } }),
  prSub('web', { after: ['api'], stage: 'implementation' }),
] };
const done = { ...running, id: 'job_d', stage: 'done', subJobs: running.subJobs.map((s) => ({ ...s, stage: 'done' })) };
const ids = (job) => jobMenuItems(job).map((i) => i.sep ? '—' : i.id);

test('a backlog job offers Start and Cancel, never Pause or links', () => {
  assert.deepEqual(ids(backlog), ['open', 'copy-ref', 'copy-id', '—', 'start', '—', 'cancel']);
  assert.equal(jobMenuItems(backlog).at(-1).danger, true);
});

test('a running job offers its PR and story links, Pause (or Resume when paused) and Cancel', () => {
  assert.deepEqual(ids(running), ['open', 'copy-ref', 'copy-id', '—', 'link', 'link', '—', 'pause', '—', 'cancel']);
  const links = jobMenuItems(running).filter((i) => i.id === 'link');
  assert.deepEqual(links.map((l) => [l.label, l.href]), [['Open PR #12', 'https://github.com/acme/widgets/pull/12'], ['Open story PROJ-1', 'https://example.atlassian.net/browse/PROJ-1']]);
  assert.ok(ids({ ...running, paused: true }).includes('resume'));
  assert.ok(!ids({ ...running, paused: true }).includes('pause'));
});

test('an idea still in conversation cancels as an idea; a planned one as a job', () => {
  const idea = { ...backlog, stage: 'planning', idea: { thread: [] } };
  assert.equal(jobMenuItems(idea).at(-1).label, 'Cancel idea');
  assert.equal(jobMenuItems({ ...idea, plan }).at(-1).label, 'Cancel job');
  assert.equal(jobMenuItems(backlog).at(-1).label, 'Cancel job');
});

test('a done or cancelled job keeps only what reads it', () => {
  assert.deepEqual(ids(done), ['open', 'copy-ref', 'copy-id', '—', 'link', 'link']);
  assert.deepEqual(ids({ ...backlog, cancelledAt: 1 }), ['open', 'copy-ref', 'copy-id']);
});

test('a proposed plan has no PRs yet, and a story link needs a site to point at', () => {
  assert.deepEqual(jobPrs({ ...running, stage: 'planning' }), []);
  assert.deepEqual(jobStories({ ...running, plan: { ...plan, jiraSite: '' }, subJobs: running.subJobs }), []);
  assert.deepEqual(jobStories({ ...running, stage: 'planning' }).map((s) => s.key), ['PROJ-1']);
});

test('the reference names the job, its id, where it stands and its PRs', () => {
  assert.equal(jobReference(backlog), 'Wrangler² job "Backlog job" (id: job_b) — Backlog');
  assert.match(jobReference(running), /^Wrangler² job "Sign-in" \(id: job_r\) — .+; PR: https:\/\/github\.com\/acme\/widgets\/pull\/12$/);
  const two = { ...running, subJobs: [running.subJobs[0], { ...running.subJobs[1], pr: { url: 'https://github.com/acme/widgets/pull/13', number: 13 } }] };
  assert.match(jobReference(two), /; PRs: https:\/\/github\.com\/acme\/widgets\/pull\/12, https:\/\/github\.com\/acme\/widgets\/pull\/13$/);
  assert.match(jobReference({ ...backlog, title: '' }), /^Wrangler² job "job_b"/);
});

function dom(t) {
  const window = new Window({ url: 'http://localhost:7878' });
  const prev = { document: globalThis.document, FormData: globalThis.FormData, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), open: globalThis.open };
  globalThis.document = window.document; globalThis.FormData = window.FormData;
  t.after(async () => {
    globalThis.document = prev.document; globalThis.FormData = prev.FormData; globalThis.open = prev.open;
    if (prev.navigator) Object.defineProperty(globalThis, 'navigator', prev.navigator);
    await window.happyDOM.close();
  });
  return window;
}

test('the menu takes focus, moves with the arrows, picks with a click and closes on Esc or a press outside', (t) => {
  const window = dom(t);
  document.body.innerHTML = '<button id="before">x</button><div id="host"></div>';
  document.getElementById('before').focus();
  const picked = [];
  const host = document.getElementById('host');
  const key = (k) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  mountJobMenu(host, jobMenuItems(running), 30, 40, (it) => picked.push(it.id));
  const rows = [...host.querySelectorAll('.job-menu-item')];
  assert.equal(document.activeElement, rows[0], 'focus lands on the first row');
  key('ArrowDown'); assert.equal(document.activeElement, rows[1]);
  key('ArrowUp'); key('ArrowUp'); assert.equal(document.activeElement, rows.at(-1), 'wraps');
  assert.ok(rows.at(-1).classList.contains('danger'));
  key('Escape');
  assert.equal(host.querySelector('.job-menu'), null);
  assert.equal(document.activeElement.id, 'before', 'focus goes back where it was');
  mountJobMenu(host, jobMenuItems(running), 30, 40, (it) => picked.push(it.id));
  host.querySelectorAll('.job-menu-item')[2].click();
  assert.deepEqual(picked, ['copy-id']);
  assert.equal(host.querySelector('.job-menu'), null, 'a pick closes it');
  mountJobMenu(host, jobMenuItems(running), 30, 40, () => {});
  document.getElementById('before').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(host.querySelector('.job-menu'), null, 'a press outside closes it');
});

test('right-clicking a plate opens its menu; Start, Copy and Cancel do what they say', async (t) => {
  const window = dom(t);
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  const sent = [], toasts = [], copied = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (s) => { copied.push(s); } } } });
  const view = initJobsView({ send: (m) => sent.push(m), stageImage: async () => ({}), getAgents: () => [], onSession: () => {}, onDiff: () => {}, onBoard: () => false, toast: (s) => toasts.push(s) });
  view.update({ jobs: [structuredClone(backlog), structuredClone(running)], settings: { concurrency: 2, maxRepairs: 2 } });
  const menuOf = (id) => {
    document.querySelector(`[data-board="${id}"] .job-plate-art`).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }));
    return [...document.querySelectorAll('.job-menu .job-menu-item')];
  };
  const row = (rows, label) => rows.find((b) => b.textContent === label);
  let rows = menuOf('job_b');
  assert.equal(document.querySelector('.job-menu').style.left, '50px');
  assert.deepEqual(rows.map((b) => b.textContent), ['Open job', 'Copy reference', 'Copy job ID', 'Start planning', 'Cancel job']);
  row(rows, 'Start planning').click();
  assert.deepEqual(sent.at(-1), { type: 'job-action', id: 'job_b', action: 'start' });

  rows = menuOf('job_r');
  assert.equal(document.querySelectorAll('.job-menu').length, 1, 'one menu at a time');
  row(rows, 'Copy reference').click();
  await new Promise((r) => setTimeout(r));
  assert.match(copied.at(-1), /^Wrangler² job "Sign-in" \(id: job_r\).*pull\/12$/);
  assert.equal(toasts.at(-1), 'Copied job reference');

  rows = menuOf('job_r');
  row(rows, 'Cancel job').click();
  const dialog = document.getElementById('job-dialog');
  assert.equal(dialog.querySelector('h2').textContent, 'Cancel this job?', 'asks first');
  assert.ok(!sent.some((m) => m.action === 'cancel-job'), 'nothing sent before the confirm');
  dialog.querySelector('[data-cancel-job]').click();
  assert.deepEqual(sent.at(-1), { type: 'job-action', id: 'job_r', action: 'cancel-job' });
});
