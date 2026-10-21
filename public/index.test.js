import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import client from './index.js';

// The client module the wrangler imports from /ext/jobs/index.js, mounted the
// way public/slots.js mounts a `view` contribution: the registrar bound to this
// extension (register + onMessage), one host element, an api with a bound
// `send`, then update(el, session, graph) on every graph tick. `dispatch`
// stands in for slots.dispatchMessage — every listener gets its OWN shallow
// copy of the frame, `type` included.
function mountClient() {
  const window = new Window({ url: 'http://localhost:7777/' });
  globalThis.document = window.document;
  const sent = [];
  const opened = [];
  const diffs = [];
  const board = { selected: null };
  const contributions = [];
  const listeners = new Set();
  client.register({
    register: (slot, c) => contributions.push({ slot, ...c }),
    onMessage: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  });
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const el = window.document.createElement('div');
  host.appendChild(el);
  const c = contributions[0];
  c.mount(el, { send: (f) => sent.push(f), openSession: (sid) => opened.push(sid), openDiff: (sid, opts) => diffs.push({ sid, ...opts }), selectedSessionId: () => board.selected, requestPanelRender: () => {}, agents: () => [{ id: 'claude', label: 'Claude', models: [{ value: 'opus', label: 'Opus 5.5', default: true }], efforts: [{ value: 'high', label: 'High' }] }], storage: null, version: '1.27.0' });
  const dispatch = (frame) => { for (const fn of [...listeners]) fn({ type: 'ext:jobs', ...frame }); };
  return { window, el, c, sent, opened, diffs, board, contributions, dispatch, listeners };
}

const graphWith = (jobs, sessions = []) => ({ sessions, jobs: { jobs, settings: { concurrency: 2, maxRepairs: 2, deploymentStaleMinutes: 30, paused: false } } });
const job = (over = {}) => ({ id: 'job_1', title: 'Ship it', intent: 'x', repos: [], agent: 'claude', model: '', stage: 'backlog', revision: 0,
  paused: false, plan: null, subJobs: [], runs: [], moves: [], reviewCode: true, reviewMerge: true, reviewSessions: true, ...over });
const sub = (over = {}) => ({ id: 'api', title: 'Deliver api', repo: '/repo', storyId: 'story', jiraKey: 'AUTH-1', after: [], brief: 'Implement it', sessions: ['s1', 's2'], repairs: [], stage: 'pr', ...over });
const activeJob = (subOver = {}) => {
  const s = sub(subOver);
  return job({ stage: 'active', plan: { context: '', stories: [{ id: 'story', key: 'AUTH-1', title: 'Sign in' }], subJobs: [s] }, subJobs: [s] });
};

const toastText = (el) => el.querySelector('.jobs-toast')?.textContent ?? null;

test('registers one labelled view and mounts the jobs board plus a body-level dialog', () => {
  const { window, el, contributions } = mountClient();
  assert.equal(contributions.length, 1);
  assert.equal(contributions[0].slot, 'view');
  assert.equal(contributions[0].label, 'Jobs');
  assert.ok(el.querySelector('#jobs h1'), 'the board header rendered inside the host');
  assert.equal(window.document.getElementById('job-dialog')?.parentNode, window.document.body, 'dialog lives on <body>, outside the hideable host');
});

test('a graph tick draws the job boards', () => {
  const { el, c } = mountClient();
  c.update(el, null, graphWith([]));
  assert.match(el.querySelector('#jobs-boards').textContent, /Start with an outcome/);
  c.update(el, null, graphWith([job({ stage: 'planning' })]));
  assert.match(el.querySelector('#jobs-boards').textContent, /Ship it/);
});

test('the new-job form selects an active task or reveals a required new-task name', (t) => {
  const { window, el, c, sent } = mountClient();
  const previousFormData = globalThis.FormData;
  globalThis.FormData = window.FormData;
  t.after(() => { globalThis.FormData = previousFormData; });
  c.update(el, null, {
    ...graphWith([]),
    tasks: { tasks: [
      { id: 't_auth', name: 'Customer authentication' },
      { id: 't_old', name: 'Archived work', archivedAt: Date.now() },
    ] },
  });
  el.querySelector('#job-new').dispatchEvent(new window.Event('click', { bubbles: true }));
  const form = window.document.getElementById('job-create-form');
  assert.deepEqual([...form.elements.taskId.options].map((o) => [o.value, o.textContent]), [
    ['', 'Unassigned'],
    ['t_auth', 'Customer authentication'],
    ['__new__', '＋ New task'],
  ]);
  assert.equal(form.elements.taskId.value, '');
  assert.equal(form.elements.newTaskName.hidden, true);
  form.elements.taskId.value = '__new__';
  form.elements.taskId.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(form.elements.newTaskName.hidden, false);
  assert.equal(form.elements.newTaskName.required, true);
  form.elements.intent.value = 'Customers can access their accounts';
  form.elements.newTaskName.value = 'Sign-in delivery';
  assert.equal(form.checkValidity(), true);
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(sent[0].job.taskId, null);
  assert.equal(sent[0].newTaskName, 'Sign-in delivery');

  el.querySelector('#job-new').dispatchEvent(new window.Event('click', { bubbles: true }));
  const existing = window.document.getElementById('job-create-form');
  existing.elements.intent.value = 'Keep the work together';
  existing.elements.taskId.value = 't_auth';
  existing.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const creates = sent.filter((m) => m.type === 'job-create');
  assert.equal(creates[1].job.taskId, 't_auth');
  assert.equal('newTaskName' in creates[1], false);
});

test('the rail badge counts every job that needs a human, whatever the view is drawing', () => {
  const { el, c } = mountClient();
  assert.equal(c.badge(), 0, 'before the first graph the rail draws nothing');
  c.update(el, null, graphWith([job()]));
  assert.equal(c.badge(), 0, 'a backlog job waiting on the runner is not waiting on a human');
  // The second job is finished, so the view hides it behind Show finished — the
  // badge still owes the human its count, which is the whole reason it is taken
  // from graph.jobs rather than off the rendered board.
  c.update(el, null, graphWith([job({ error: 'plan failed' }), job({ id: 'job_2', title: 'Old one', stage: 'done', error: 'cleanup failed' })]));
  assert.equal(c.badge(), 2);
  assert.doesNotMatch(el.querySelector('#jobs-boards').textContent, /Old one/, 'the finished job is filtered out of the view it is still counted in');
  c.unmount(el);
  assert.equal(c.badge(), 0, 'an unloaded extension leaves no stale count behind');
});

test('the rail badge, the Needs you tab and the cards asking for you agree, counting jobs', () => {
  const { el, c } = mountClient();
  const review = (id) => sub({ id, kind: 'session', stage: 'review', result: { checks: [] } });
  const two = job({ id: 'job_2', title: 'Two waiting', stage: 'active', subJobs: [review('a'), review('b')] });
  const plan = job({ id: 'job_3', title: 'Plan ready', stage: 'planning', plan: { context: '', stories: [], subJobs: [sub()] } });
  const cancelled = job({ id: 'job_4', title: 'Cancelled', stage: 'active', cancelledAt: 1, subJobs: [sub({ stage: 'cleanup', cancelledAt: 1, error: 'cleanup failed' })] });
  const finished = job({ id: 'job_5', title: 'Finished', stage: 'done', subJobs: [sub({ stage: 'done', error: 'cleanup failed' })] });
  c.update(el, null, graphWith([two, plan, cancelled, finished]));
  const asking = () => [...el.querySelectorAll('.job-plate.stubbed')].map((p) => p.dataset.board).sort();
  el.querySelector('[data-filter="needs"]').click();
  assert.deepEqual(asking(), ['job_2', 'job_3'], 'two waiting sub-jobs are one job; a cancelled or finished one asks nothing');
  assert.equal(el.querySelectorAll('.job-plate').length, 2, 'the Needs you view draws only the jobs asking');
  assert.equal(el.querySelector('#jobs-review-count').textContent, '2');
  assert.equal(c.badge(), 2);
  for (const f of ['all', 'done']) { el.querySelector(`[data-filter="${f}"]`).click(); assert.ok(asking().every((id) => ['job_2', 'job_3'].includes(id)), f); }
  c.unmount(el);
});

test('the toolbar sends only this extension\'s own handler types', () => {
  const { window, el, c, sent } = mountClient();
  c.update(el, null, graphWith([]));
  el.querySelector('#jobs-pause').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(sent, [{ type: 'job-settings', patch: { paused: true } }]);
  c.unmount(el);
  assert.equal(window.document.getElementById('job-dialog'), null);
});

test('a job-created frame closes the open form and toasts what happened to the job', () => {
  const { window, el, c, dispatch } = mountClient();
  c.update(el, null, graphWith([]));
  const dialog = window.document.getElementById('job-dialog');
  dialog.setAttribute('open', '');
  dispatch({ event: 'job-created', jobId: 'x', started: true });
  assert.equal(dialog.hasAttribute('open'), false, 'the create form closes on the reply, not on the next graph');
  assert.equal(toastText(el), 'Job started — planning');
  dispatch({ event: 'job-created', jobId: 'y', started: false });
  assert.equal(toastText(el), 'Job added to backlog');
  assert.equal(el.querySelectorAll('.jobs-toast').length, 1, 'a second toast replaces the first rather than stacking');
});

test('a job-create failure keeps the form open and shows the reason', () => {
  const { window, el, c, dispatch } = mountClient();
  c.update(el, null, graphWith([]));
  const dialog = window.document.getElementById('job-dialog');
  dialog.setAttribute('open', '');
  dispatch({ event: 'job-create-failed', error: 'Task limit reached (max 50).' });
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(toastText(el), 'Task limit reached (max 50).');
});

test('a job-action-complete frame toasts, and an unknown event is ignored', () => {
  const { window, el, c, dispatch } = mountClient();
  c.update(el, null, graphWith([job()]));
  dispatch({ event: 'job-action-complete', jobId: 'job_1' });
  assert.equal(toastText(el), 'Job updated');
  el.querySelector('.jobs-toast').remove();
  const dialog = window.document.getElementById('job-dialog');
  dialog.setAttribute('open', '');
  dispatch({ event: 'job-invented-later', jobId: 'job_1' });
  assert.equal(toastText(el), null, 'an event this version does not know draws nothing');
  assert.equal(dialog.hasAttribute('open'), true);
});

test('starting a HUMAN task keeps its output draft open through the board reply and next graph tick', () => {
  const { window, el, c, sent, dispatch } = mountClient();
  const human = { id: 'key', kind: 'human', title: 'Get key', brief: 'Request the key', after: [], sessions: [], repairs: [], stage: 'human', state: 'queued' };
  const work = job({ stage: 'active', plan: { context: '', stories: [], subJobs: [human] }, subJobs: [human] });
  c.update(el, null, graphWith([work]));
  el.querySelector('.job-plate-graph [data-sub="key"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const dialog = window.document.getElementById('job-dialog');
  dialog.querySelector('textarea[name="output"]').value = 'ssh-ed25519 AAAA\nuser@host';
  dialog.querySelector('[data-action="start-human"]').click();
  assert.equal(sent.at(-1).action, 'start-human');
  dispatch({ event: 'job-action-complete', jobId: work.id, subJobId: 'key', action: 'start-human' });
  assert.equal(dialog.open, true);
  dispatch({ event: 'job-action-complete', jobId: 'another-job', action: 'pause' });
  assert.equal(dialog.open, true, 'another client action must not discard a HUMAN draft');
  human.state = 'doing'; c.update(el, null, graphWith([work]));
  assert.equal(dialog.querySelector('textarea[name="output"]').value, 'ssh-ed25519 AAAA\nuser@host');
  const originalFormData = globalThis.FormData;
  globalThis.FormData = window.FormData;
  try { dialog.querySelector('#job-human-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
  finally { globalThis.FormData = originalFormData; }
  assert.equal(sent.at(-1).action, 'finish-human');
  assert.equal(sent.at(-1).output, 'ssh-ed25519 AAAA\nuser@host');
  dispatch({ event: 'job-action-complete', jobId: work.id, subJobId: 'key', action: 'finish-human' });
  assert.equal(dialog.open, false);
});

test('a toast clears itself, and a frame arriving while no view is mounted is harmless', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, c, dispatch, listeners } = mountClient();
  c.update(el, null, graphWith([]));
  dispatch({ event: 'job-action-complete', jobId: 'job_1' });
  assert.equal(toastText(el), 'Job updated');
  t.mock.timers.tick(3000);
  assert.equal(toastText(el), null, 'the toast auto-dismisses');
  // The subscription is the registrar's, taken once per module load, so it
  // outlives the view's host — the frame must find no view and no host and
  // simply do nothing.
  c.unmount(el);
  assert.equal(listeners.size, 1);
  dispatch({ event: 'job-created', jobId: 'x', started: true });
  assert.equal(toastText(el), null);
});

test('the IDE handler answers with a broadcast either way, and both land as a toast', () => {
  const { el, c, dispatch } = mountClient();
  c.update(el, null, graphWith([job()]));
  dispatch({ event: 'job-ide-opened', jobId: 'job_1', subJobId: 'api', app: 'IntelliJ IDEA' });
  assert.equal(toastText(el), 'Opened in IntelliJ IDEA');
  dispatch({ event: 'job-ide-failed', jobId: 'job_1', subJobId: 'api', app: 'IntelliJ IDEA', error: 'Worktree no longer exists: /wt' });
  assert.equal(toastText(el), 'Worktree no longer exists: /wt');
});

test('a failure toasts as an error that outlasts a success and can be dismissed; a success stays plain', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, c, dispatch } = mountClient();
  c.update(el, null, graphWith([job()]));
  dispatch({ event: 'job-action-complete', jobId: 'job_1' });
  const ok = el.querySelector('.jobs-toast');
  assert.equal(ok.classList.contains('jobs-toast-error'), false);
  assert.equal(ok.getAttribute('role'), 'status');
  assert.equal(ok.getAttribute('popover'), 'manual', 'a manual popover sits in the top layer, above an open modal');
  assert.equal(ok.parentNode, el.querySelector('#jobs'), 'inside #jobs, so it wears the theme and hides with the host');
  assert.equal(ok.querySelector('button'), null);
  for (const frame of [
    { event: 'job-create-failed', error: 'Task limit reached' },
    { event: 'job-action-failed', jobId: 'job_1', action: 'approve-plan', error: 'Plan moved' },
    { event: 'job-ide-failed', jobId: 'job_1', error: 'Worktree no longer exists' },
  ]) {
    dispatch(frame);
    const bad = el.querySelector('.jobs-toast');
    assert.ok(bad.classList.contains('jobs-toast-error'), frame.event);
    assert.equal(bad.getAttribute('role'), 'alert');
    assert.equal(bad.textContent, frame.error);
  }
  t.mock.timers.tick(3000);
  assert.equal(toastText(el), 'Worktree no longer exists', 'an error outlasts a success toast');
  el.querySelector('.jobs-toast-close').click();
  assert.equal(toastText(el), null, 'Dismiss removes it at once');
  dispatch({ event: 'job-ide-failed', jobId: 'job_1', error: 'Gone' });
  t.mock.timers.tick(10000);
  assert.equal(toastText(el), null, 'and it still clears itself');
  dispatch({ event: 'job-action-failed', jobId: 'job_1', action: 'approve-plan', error: '<b>x</b>' });
  assert.equal(el.querySelector('.jobs-toast b'), null, 'agent-written text is never markup');
});

// Core's onSession: select the card when the board has it, resume it first when
// it does not. Both are api.openSession's job since host api 1.8; the view only
// has to label the button right, off the graph's session list.
test('Open/Restore session reads the board off the graph and hands the card to api.openSession', () => {
  const { window, el, c, sent, opened } = mountClient();
  c.update(el, null, graphWith([activeJob()], [{ sessionId: 's1', status: 'idle' }]));
  el.querySelector('[data-sub="api"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const dialog = window.document.getElementById('job-dialog');
  assert.equal(dialog.querySelector('#job-session').textContent, 'Restore session', 'the latest run is archived; an earlier one on the board does not count');
  c.update(el, null, graphWith([activeJob()], [{ sessionId: 's2', status: 'working' }]));
  assert.equal(dialog.querySelector('#job-session').textContent, 'Open session', 'the open detail re-labels on the next graph');
  dialog.querySelector('#job-session').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(opened, ['s2'], 'the latest run, live or archived');
  assert.equal(dialog.hasAttribute('open'), false);
  assert.deepEqual(sent, [], 'no frame of our own: the board navigates');
});

// Core's diff round trip (diff-return.js), now over api.openDiff: the panel opens
// over the grid, and closing it comes back to this view with the same detail —
// unless the reader went somewhere else on the way out.
const tick = () => new Promise((r) => setTimeout(r));
function reviewFromDialog(sessions = []) {
  const m = mountClient();
  m.c.update(m.el, null, graphWith([activeJob({ worktree: { path: '/wt/api', branch: 'fix/api' } })], sessions));
  m.el.querySelector('[data-sub="api"]').dispatchEvent(new m.window.Event('click', { bubbles: true }));
  m.dialog = m.window.document.getElementById('job-dialog');
  m.dialog.querySelector('#job-diff').dispatchEvent(new m.window.Event('click', { bubbles: true }));
  return m;
}

test('Review code in Wrangler opens the diff through api.openDiff, not openSession', () => {
  const { dialog, diffs, opened, sent } = reviewFromDialog([{ sessionId: 's1', status: 'idle' }]);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].sid, 's1', 'the latest run on the board: s2 is archived');
  assert.equal(typeof diffs[0].onClose, 'function');
  assert.deepEqual(opened, []);
  assert.deepEqual(sent, []);
  assert.equal(dialog.hasAttribute('open'), false);
});

test('closing the diff returns to the Jobs view and re-opens the same detail', async () => {
  const { window, dialog, diffs, board } = reviewFromDialog();
  assert.equal(diffs[0].sid, 's2', 'nothing on the board: the latest run');
  window.location.hash = '#session=s2'; board.selected = 's2';
  diffs[0].onClose();
  await tick();
  assert.equal(window.location.hash, '#view=ext:jobs:board');
  assert.equal(dialog.hasAttribute('open'), true);
  assert.match(dialog.textContent, /Deliver api/);
});

test('closing the diff by leaving the grid or picking another card stays where the reader went', async () => {
  const left = reviewFromDialog();
  left.window.location.hash = '#view=search';
  left.diffs[0].onClose();
  await tick();
  assert.equal(left.window.location.hash, '#view=search');
  assert.equal(left.dialog.hasAttribute('open'), false);

  const other = reviewFromDialog();
  other.board.selected = 'elsewhere';
  other.diffs[0].onClose();
  await tick();
  assert.notEqual(other.window.location.hash, '#view=ext:jobs:board');
  assert.equal(other.dialog.hasAttribute('open'), false);
});

test('a job gone by the time the diff closes returns to Jobs without a dialog', async () => {
  const { window, el, c, dialog, diffs } = reviewFromDialog();
  c.update(el, null, graphWith([]));
  diffs[0].onClose();
  await tick();
  assert.equal(window.location.hash, '#view=ext:jobs:board');
  assert.equal(dialog.hasAttribute('open'), false);
});
