import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import client from './index.js';

// The client module the wrangler imports from /ext/jobs/index.js, mounted the
// way public/slots.js mounts a `view` contribution: one host element, an api
// with a bound `send`, then update(el, session, graph) on every graph tick.
function mountClient() {
  const window = new Window();
  globalThis.document = window.document;
  const sent = [];
  const contributions = [];
  client.register({ register: (slot, c) => contributions.push({ slot, ...c }) });
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const el = window.document.createElement('div');
  host.appendChild(el);
  const c = contributions[0];
  c.mount(el, { send: (f) => sent.push(f), selectedSessionId: () => null, requestPanelRender: () => {}, storage: null, version: '1.0.0' });
  return { window, el, c, sent, contributions };
}

const graphWith = (jobs) => ({ sessions: [], jobs: { jobs, settings: { concurrency: 2, maxRepairs: 2, deploymentStaleMinutes: 30, paused: false } } });
const job = (over = {}) => ({ id: 'job_1', title: 'Ship it', intent: 'x', repos: [], agent: 'claude', model: '', stage: 'backlog', revision: 0,
  paused: false, plan: null, subJobs: [], runs: [], moves: [], reviewCode: true, reviewMerge: true, reviewSessions: true, ...over });

test('registers one labelled view and mounts the jobs board plus a body-level dialog', () => {
  const { window, el, contributions } = mountClient();
  assert.equal(contributions.length, 1);
  assert.equal(contributions[0].slot, 'view');
  assert.equal(contributions[0].label, 'Jobs');
  assert.ok(el.querySelector('#jobs h1'), 'the board header rendered inside the host');
  assert.equal(window.document.getElementById('job-dialog')?.parentNode, window.document.body, 'dialog lives on <body>, outside the hideable host');
});

test('a graph tick draws the job boards, and a job appearing closes the create form', () => {
  const { window, el, c } = mountClient();
  c.update(el, null, graphWith([]));
  assert.match(el.querySelector('#jobs-boards').textContent, /Start with an outcome/);
  c.update(el, null, graphWith([job()]));
  assert.match(el.querySelector('#jobs-boards').textContent, /Ship it/);
  const dialog = window.document.getElementById('job-dialog');
  dialog.setAttribute('open', '');
  c.update(el, null, graphWith([job(), job({ id: 'job_2', title: 'Second' })]));
  assert.equal(dialog.hasAttribute('open'), false, 'a new job in the snapshot closes the dialog (stand-in for the job-created reply)');
});

test('the toolbar sends only this extension\'s own handler types', () => {
  const { window, el, c, sent } = mountClient();
  c.update(el, null, graphWith([]));
  el.querySelector('#jobs-pause').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(sent, [{ type: 'job-settings', patch: { paused: true } }]);
  c.unmount(el);
  assert.equal(window.document.getElementById('job-dialog'), null);
});
