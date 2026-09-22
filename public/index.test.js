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
  const window = new Window();
  globalThis.document = window.document;
  const sent = [];
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
  c.mount(el, { send: (f) => sent.push(f), selectedSessionId: () => null, requestPanelRender: () => {}, storage: null, version: '1.4.0' });
  const dispatch = (frame) => { for (const fn of [...listeners]) fn({ type: 'ext:jobs', ...frame }); };
  return { window, el, c, sent, contributions, dispatch, listeners };
}

const graphWith = (jobs) => ({ sessions: [], jobs: { jobs, settings: { concurrency: 2, maxRepairs: 2, deploymentStaleMinutes: 30, paused: false } } });
const job = (over = {}) => ({ id: 'job_1', title: 'Ship it', intent: 'x', repos: [], agent: 'claude', model: '', stage: 'backlog', revision: 0,
  paused: false, plan: null, subJobs: [], runs: [], moves: [], reviewCode: true, reviewMerge: true, reviewSessions: true, ...over });

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
  c.update(el, null, graphWith([job()]));
  assert.match(el.querySelector('#jobs-boards').textContent, /Ship it/);
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
