import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueTaskName } from './task-name.js';
import { makeJobCreateHandler } from './handlers.js';
import { makeCreateJobTool } from './tools.js';
import { _resetForTests, runnerFor } from './jobs.js';
import { fakeHost } from './test-helpers.js';

const answering = (answer) => {
  const calls = [];
  const run = async (prompt, stdin) => { calls.push({ prompt, stdin }); return typeof answer === 'function' ? answer() : answer; };
  return { run, calls };
};
const titled = (text, liveSessionId = null) => ({ text, liveSessionId, error: null });

function setup(t) {
  _resetForTests(); t.after(_resetForTests);
  const f = fakeHost();
  runnerFor(f.host).tick = async () => {};
  return f;
}

test('a clashing name is suffixed, ignoring case', () => {
  assert.equal(uniqueTaskName('Sign-in', ['Billing']), 'Sign-in');
  assert.equal(uniqueTaskName('Sign-in', ['sign-in']), 'Sign-in 2');
  assert.equal(uniqueTaskName('Sign-in', ['SIGN-IN', 'sign-in 2']), 'Sign-in 3');
  assert.ok(uniqueTaskName('x'.repeat(180), ['x'.repeat(180)]).length <= 180);
});

test('New task from the form is created at once under the fallback title, then renamed to the generated job title', async (t) => {
  const { host, tasks, broadcasts } = setup(t);
  tasks.push({ id: 't_old', name: 'Billing', links: [] });
  let answer;
  const { run, calls } = answering(() => new Promise((resolve) => { answer = resolve; }));
  await makeJobCreateHandler({ run }).handler({ job: { intent: 'Customers can sign in reliably\nwith SSO' }, newTask: true, idea: true }, host);
  const job = host.stores.jobs.get(broadcasts[0].jobId);
  assert.equal(broadcasts[0].event, 'job-created', 'the create does not wait for a name');
  assert.deepEqual(tasks.map((x) => x.name), ['Billing', 'Customers can sign in reliably']);
  assert.equal(job.taskId, tasks[1].id);
  const rebuilds = host.rebuilds;
  answer(titled('Reliable SSO sign-in'));
  await new Promise(setImmediate);
  assert.equal(host.stores.jobs.get(job.id).title, 'Reliable SSO sign-in');
  assert.equal(tasks[1].name, 'Reliable SSO sign-in');
  assert.ok(host.rebuilds > rebuilds, 'the board hears of the rename');
  assert.equal(calls.length, 1, 'one Haiku run names both');
});

test('a generated title another task already has is suffixed', async (t) => {
  const { host, tasks, broadcasts } = setup(t);
  tasks.push({ id: 't_old', name: 'sso sign-in', links: [] });
  const { run } = answering(titled('SSO sign-in'));
  await makeJobCreateHandler({ run }).handler({ job: { intent: 'Customers can sign in with SSO' }, newTask: true }, host);
  await new Promise(setImmediate);
  const job = host.stores.jobs.get(broadcasts[0].jobId);
  assert.equal(job.title, 'SSO sign-in');
  assert.equal(tasks.find((x) => x.id === job.taskId).name, 'SSO sign-in 2');
});

test('two new tasks titled alike at once never end up with the same name', async (t) => {
  const { host, tasks } = setup(t);
  const answers = [];
  const { run } = answering(() => new Promise((resolve) => { answers.push(resolve); }));
  const handler = makeJobCreateHandler({ run });
  await handler.handler({ job: { intent: 'Customers can sign in with SSO' }, newTask: true }, host);
  await handler.handler({ job: { intent: 'Staff can sign in with SSO' }, newTask: true }, host);
  for (const answer of answers) answer(titled('SSO sign-in'));
  await new Promise(setImmediate);
  assert.deepEqual(tasks.map((x) => x.name), ['SSO sign-in', 'SSO sign-in 2']);
});

test('the fallback name is suffixed too, and a failed title keeps it', async (t) => {
  const { host, tasks } = setup(t);
  tasks.push({ id: 't_old', name: 'Make sign-in reliable', links: [] });
  const { run } = answering({ text: null, liveSessionId: null, error: new Error('boom') });
  await makeJobCreateHandler({ run }).handler({ job: { intent: 'Make sign-in reliable' }, newTask: true }, host);
  await new Promise(setImmediate);
  assert.deepEqual(tasks.map((x) => x.name), ['Make sign-in reliable', 'Make sign-in reliable 2']);
});

test('a task the human renamed before the title lands keeps their name', async (t) => {
  const { host, tasks, broadcasts } = setup(t);
  let answer;
  const { run } = answering(() => new Promise((resolve) => { answer = resolve; }));
  await makeJobCreateHandler({ run }).handler({ job: { intent: 'Make sign-in reliable' }, newTask: true }, host);
  host.tasks.rename(tasks[0].id, 'My name');
  answer(titled('Reliable sign-in'));
  await new Promise(setImmediate);
  assert.equal(host.stores.jobs.get(broadcasts[0].jobId).title, 'Reliable sign-in');
  assert.equal(tasks[0].name, 'My name');
});

test('a job the human retitled first leaves its task alone too', async (t) => {
  const { host, tasks, broadcasts } = setup(t);
  let answer;
  const { run } = answering(() => new Promise((resolve) => { answer = resolve; }));
  await makeJobCreateHandler({ run }).handler({ job: { intent: 'Make sign-in reliable' }, newTask: true }, host);
  host.stores.jobs.change((d) => { d.jobs.find((j) => j.id === broadcasts[0].jobId).title = 'Human title'; });
  answer(titled('Reliable sign-in'));
  await new Promise(setImmediate);
  assert.equal(tasks[0].name, 'Make sign-in reliable');
});

test('newTask with a selected task is refused, and an explicit newTaskName is never renamed', async (t) => {
  const { host, tasks, broadcasts } = setup(t);
  tasks.push({ id: 't_old', name: 'Billing', links: [] });
  const { run } = answering(titled('Something else'));
  await makeJobCreateHandler({ run }).handler({ job: { title: 'X', intent: 'x', taskId: 't_old' }, newTask: true }, host);
  assert.deepEqual(broadcasts, [{ event: 'job-create-failed', error: 'Choose an existing task or create a new one, not both' }]);
  const res = await makeCreateJobTool({ run }).handler({ host, caller: 'an-agent' }, { intent: 'Agent work', newTaskName: 'Agent work' });
  await new Promise(setImmediate);
  assert.equal(res.isError, undefined);
  assert.deepEqual(tasks.map((x) => x.name), ['Billing', 'Agent work']);
});
