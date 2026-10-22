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
  const mounted = [];
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
  c.mount(el, { send: (f) => sent.push(f), openSession: (sid) => opened.push(sid), openDiff: (sid) => opened.push(sid), mountSession: (host, sid, opts) => { mounted.push({ host, sid, opts }); return { sessionId: sid, show() { return true; }, unmount() {} }; }, selectedSessionId: () => board.selected, requestPanelRender: () => {}, agents: () => [{ id: 'claude', label: 'Claude', models: [{ value: 'opus', label: 'Opus 5.5', default: true }], efforts: [{ value: 'high', label: 'High' }] }], storage: null, version: '1.42.0' });
  const dispatch = (frame) => { for (const fn of [...listeners]) fn({ type: 'ext:jobs', ...frame }); };
  return { window, el, c, sent, opened, mounted, board, contributions, dispatch, listeners };
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

test('the new-job form has no Task field and sends no task', (t) => {
  const { window, el, c, sent } = mountClient();
  const previousFormData = globalThis.FormData;
  globalThis.FormData = window.FormData;
  t.after(() => { globalThis.FormData = previousFormData; });
  c.update(el, null, { ...graphWith([]), tasks: { tasks: [{ id: 't_auth', name: 'Customer authentication' }] } });
  el.querySelector('#job-new').dispatchEvent(new window.Event('click', { bubbles: true }));
  const form = window.document.getElementById('job-create-form');
  assert.equal(form.elements.taskId, undefined);
  assert.equal(form.elements.newTaskName, undefined);
  assert.doesNotMatch(form.textContent, /Task|Unassigned/);
  form.elements.intent.value = 'Customers can access their accounts';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal('taskId' in sent[0].job, false);
  assert.equal('newTaskName' in sent[0], false);
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
  const page = el.querySelector('#job-page');
  page.querySelector('textarea[name="output"]').value = 'ssh-ed25519 AAAA\nuser@host';
  page.querySelector('[data-action="start-human"]').click();
  assert.equal(sent.at(-1).action, 'start-human');
  dispatch({ event: 'job-action-complete', jobId: work.id, subJobId: 'key', action: 'start-human' });
  assert.equal(page.querySelector('.job-page-crumbs [aria-current]').textContent, 'Get key');
  dispatch({ event: 'job-action-complete', jobId: 'another-job', action: 'pause' });
  assert.equal(page.querySelector('.job-page-crumbs [aria-current]').textContent, 'Get key', 'another client action must not discard a HUMAN draft');
  human.state = 'doing'; c.update(el, null, graphWith([work]));
  assert.equal(page.querySelector('textarea[name="output"]').value, 'ssh-ed25519 AAAA\nuser@host');
  const originalFormData = globalThis.FormData;
  globalThis.FormData = window.FormData;
  try { page.querySelector('#job-human-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
  finally { globalThis.FormData = originalFormData; }
  assert.equal(sent.at(-1).action, 'finish-human');
  assert.equal(sent.at(-1).output, 'ssh-ed25519 AAAA\nuser@host');
  dispatch({ event: 'job-action-complete', jobId: work.id, subJobId: 'key', action: 'finish-human' });
  assert.equal(page.hidden, false);
  assert.equal(page.querySelector('.job-page-crumbs [aria-current]').textContent, work.title, 'done, the page goes up to the job');
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

// Job sessions are off the board (host api 1.41): a step's Sessions shows the
// board's own panel in place through api.mountSession (1.42), and never sends
// the reader to the grid through openSession or openDiff.
test('a step’s Sessions mount the latest card in the page through api.mountSession', () => {
  const { window, el, c, sent, opened, mounted } = mountClient();
  c.update(el, null, graphWith([activeJob({ worktree: { path: '/wt/api', branch: 'fix/api' } })], [{ sessionId: 's2', status: 'working', offBoard: 'jobs' }]));
  el.querySelector('[data-sub="api"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const page = el.querySelector('#job-page');
  assert.doesNotMatch(page.textContent, /Open session|Restore session/);
  page.querySelector('[data-sessions]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].sid, 's2');
  assert.ok(mounted[0].host === page.querySelector('.job-mc-host'));
  assert.match(page.querySelector('[data-pick-session="s2"]').textContent, /Working$/, 'its state read off the graph, off-board card and all');
  assert.match(page.querySelector('[data-pick-session="s1"]').textContent, /Archived/);
  page.querySelector('[data-page-back]').click();
  page.querySelector('#job-diff').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(mounted.at(-1).sid, 's2', 'Review code is the same Sessions, on the latest card');
  assert.deepEqual(opened, [], 'never out to the board');
  assert.deepEqual(sent, []);
  assert.equal(page.hidden, false);
});
