import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore, holdsSlot } from './job-store.js';
import { JobRunner } from './job-runner.js';
import { reportSchema } from './jobs-schema.js';
import { jobPrompt, ideaMail } from './job-prompts.js';
import { liveSuggestion, inConversation } from './job-idea.js';
import { makeJobCreateHandler } from './handlers.js';
import { _resetForTests, runnerFor } from './jobs.js';

const plan = (title = 'Nudge') => ({ context: 'ctx', stories: [], subJobs: [{ id: 'nudge', title, repo: '/repo', after: [], brief: 'Build it', show: ['Plate shows the wait'] }] });
const suggest = (title = 'Nudge when a green PR waits') => ({ title, plan: plan() });

function fixture(t, input = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-idea-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  const launched = [], mailed = [], stopped = [], alive = new Set();
  let clock = Date.now();
  const runtime = {
    async launch(j, s, r, prepared) { const sid = `session-${r.id}`; alive.add(sid); launched.push({ job: j, sub: s, run: r, sid }); prepared(sid, s ? { path: '/worktree/nudge', repoRoot: '/repo', branch: 'b' } : undefined); },
    async stop(r) { stopped.push(r.id); alive.delete(r.sessionId); },
    async isAlive(r) { return alive.has(r.sessionId); },
    async exists(r) { return alive.has(r.sessionId); },
    async resumeWithMail(r, text) { mailed.push({ sid: r.sessionId, text }); },
    async cleanup() {}, async cleanupPlanning() {}, releaseImages() {}, attributeSpend() {},
  };
  const runner = new JobRunner({ store, runtime, github: {}, now: () => clock });
  const job = store.create({ title: 'Nudge me', intent: 'PRs sit green for ages. Can the board nag me?', ...input }, { idea: { thread: [] } });
  const tick = async () => { clock += 61000; await runner.tick(); };
  const last = () => launched.at(-1);
  const report = (payload, w = last()) => store.report(w.sid, w.run.id, payload);
  const get = () => store.get(job.id);
  const run = (w = last()) => get().runs.find((r) => r.id === w.run.id);
  const start = async () => { store.action(job.id, 'start'); await tick(); };
  return { store, job, runner, launched, mailed, stopped, alive, tick, last, report, get, run, start };
}

test('reply is a receipt kind; suggest carries a whole plan, checked like a plan receipt', () => {
  assert.equal(reportSchema.parse({ kind: 'reply', text: 'Two questions first' }).kind, 'reply');
  assert.equal(reportSchema.parse({ kind: 'reply', text: 'Here is the job', suggest: suggest() }).suggest.plan.subJobs[0].id, 'nudge');
  assert.throws(() => reportSchema.parse({ kind: 'reply', text: 'x', suggest: { title: 'No plan' } }));
  assert.throws(() => reportSchema.parse({ kind: 'reply', text: 'x', suggest: { title: 'Bad', plan: { context: '', subJobs: [{ id: 'a', title: 'A', after: ['missing'], brief: 'b', repo: '/r' }] } } }), /Unknown dependency/);
  assert.throws(() => reportSchema.parse({ kind: 'reply', text: 'x', suggest: { ...suggest(), extra: 1 } }));
});

test('a vague idea: the planner replies, parks without a slot, and the human answer is mailed to the same session', async (t) => {
  const f = fixture(t); await f.start();
  const planner = f.last();
  assert.match(jobPrompt(f.get(), null, planner.run), /started as an IDEA from New idea/);
  assert.match(jobPrompt(f.get(), null, planner.run), /kind:"reply"/);
  const res = f.report({ kind: 'reply', text: 'Which wait counts: green and unmerged, or waiting on your review?' });
  assert.equal(res.idea.thread.length, 1);
  const run = f.run(planner);
  assert.deepEqual([run.stopped, run.report, run.parkedFor, !!run.parkedAt, run.mailedAt], [false, null, 'idea', true, null]);
  assert.equal(holdsSlot(run), false, 'a planner waiting on the human holds no agent slot');
  assert.equal(f.report({ kind: 'reply', text: 'Which wait counts: green and unmerged, or waiting on your review?' }).idea.thread.length, 1, 'an identical retry is safe');
  assert.throws(() => f.report({ kind: 'reply', text: 'Something else' }), /wait for mail/);
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.run(planner).stopped, false, 'parked however long the human takes');
  assert.equal(f.launched.length, 1, 'no second planner while the first is parked');

  f.store.action(f.job.id, 'idea-reply', { text: 'Green and unmerged for a day. Plate first.' });
  await f.tick();
  assert.equal(f.mailed.length, 1);
  assert.equal(f.mailed[0].sid, planner.sid);
  assert.match(f.mailed[0].text, /Green and unmerged for a day/);
  assert.ok(f.run(planner).mailedAt, 'mailed: the planner is working again');
  assert.ok(f.get().idea.thread.every((m) => m.from !== 'human' || m.sentAt));
  await f.tick();
  assert.equal(f.mailed.length, 1, 'a message is mailed once');

  f.report({ kind: 'reply', text: 'That is enough to plan.', suggest: suggest() });
  assert.equal(f.run(planner).parkedAt > 0 && !f.run(planner).mailedAt, true, 'parked again');
  assert.equal(liveSuggestion(f.get()).suggest.title, 'Nudge when a green PR waits');
});

test('accepting the suggestion is the plan receipt: plan review applies, the parked planner ends quietly', async (t) => {
  const f = fixture(t); await f.start();
  const planner = f.last();
  f.report({ kind: 'reply', text: 'Here is the job.', suggest: suggest() });
  const msg = f.get().idea.thread.at(-1);
  assert.throws(() => f.store.action(f.job.id, 'accept-idea', { messageId: 'msg_other' }), /changed since you looked/);
  f.store.action(f.job.id, 'accept-idea', { messageId: msg.id });
  let job = f.get();
  assert.deepEqual([job.stage, job.title, job.plan.subJobs[0].id], ['planning', 'Nudge when a green PR waits', 'nudge']);
  assert.ok(job.idea.thread.at(-1).acceptedAt);
  assert.equal(inConversation(job), false);
  assert.match(job.moves.at(-1).detail, /from the wrangler's suggestion/);
  await f.tick();
  assert.equal(f.run(planner).stopped, true);
  assert.equal(f.run(planner).error, undefined, 'stopped quietly, not as a missing receipt');
  assert.equal(f.get().error, undefined);
  f.store.approvePlan(f.job.id, f.get().revision);
  job = f.get();
  assert.equal(job.stage, 'active');
  assert.throws(() => f.store.action(f.job.id, 'accept-idea', { messageId: msg.id }), /no longer a conversation/);
});

test('with Plan on Auto, accepting the suggestion starts the job at once', async (t) => {
  const f = fixture(t, { reviewPlan: false }); await f.start();
  f.report({ kind: 'reply', text: 'Here is the job.', suggest: suggest() });
  f.store.action(f.job.id, 'accept-idea', { messageId: f.get().idea.thread.at(-1).id });
  assert.equal(f.get().stage, 'active');
  await f.tick();
  assert.deepEqual(f.launched.map((l) => l.run.phase), ['planning', 'implementation']);
});

test('a reply after a suggestion replaces it: the old one can no longer be accepted', async (t) => {
  const f = fixture(t); await f.start();
  f.report({ kind: 'reply', text: 'Here is the job.', suggest: suggest() });
  const old = f.get().idea.thread.at(-1);
  f.store.action(f.job.id, 'idea-reply', { text: 'Also DM me on Slack' });
  assert.equal(liveSuggestion(f.get()), null);
  assert.throws(() => f.store.action(f.job.id, 'accept-idea', { messageId: old.id }), /changed since you looked/);
  assert.throws(() => f.store.action(f.job.id, 'idea-reply', { text: '  ' }), /Write a reply first/);
});

test('a well-defined idea goes straight to a plan, exactly as a job always did', async (t) => {
  const f = fixture(t); await f.start();
  f.report({ kind: 'plan', plan: plan() });
  await f.tick();
  const job = f.get();
  assert.deepEqual([job.stage, job.plan.subJobs.length, job.idea.thread.length], ['planning', 1, 0]);
  assert.equal(f.run(f.launched[0]).stopped, true);
  assert.equal(job.error, undefined);
});

test('a parked planner may still send the plan itself, ending its run', async (t) => {
  const f = fixture(t); await f.start();
  f.report({ kind: 'reply', text: 'One question.' });
  f.report({ kind: 'plan', plan: plan() });
  await f.tick();
  assert.equal(f.get().plan.subJobs[0].id, 'nudge');
  assert.equal(f.run(f.launched[0]).stopped, true);
});

test('a job not made from New idea, or an implementation step, cannot reply as a planner or suggest a job', async (t) => {
  const f = fixture(t);
  const other = f.store.create({ title: 'Plain', intent: 'Plain job', repos: ['/repo'] });
  f.store.action(other.id, 'start'); await f.tick();
  const w = f.launched.find((l) => l.job.id === other.id) || f.launched.at(-1);
  assert.doesNotMatch(jobPrompt(f.store.get(other.id), null, w.run), /started as an IDEA/);
  assert.throws(() => f.store.report(w.sid, w.run.id, { kind: 'reply', text: 'hi' }), /new idea's conversation/);
  assert.throws(() => f.store.action(other.id, 'idea-reply', { text: 'hi' }), /no longer a conversation/);
});

test('a planner whose session was closed while it waited is the job\'s to retry, and the new one reads the whole thread', async (t) => {
  const f = fixture(t); await f.start();
  const planner = f.last();
  f.report({ kind: 'reply', text: 'Which repo?' });
  f.store.action(f.job.id, 'idea-reply', { text: 'wrangler-squared' });
  f.alive.delete(planner.sid);
  await f.tick();
  assert.match(f.get().error, /closed while it waited for your reply/);
  f.store.action(f.job.id, 'retry');
  await f.tick();
  const next = f.last();
  assert.notEqual(next.run.id, planner.run.id);
  const prompt = jobPrompt(f.get(), null, next.run);
  assert.match(prompt, /You: "Which repo\?"/);
  assert.match(prompt, /The human: "wrangler-squared"/);
  assert.ok(f.get().idea.thread.every((m) => m.from !== 'human' || m.sentAt), 'the new planner read it, so nothing is mailed');
  await f.tick();
  assert.equal(f.mailed.length, 0);
});

test('the mail names the human\'s words as data and the receipts to send back', () => {
  const job = { title: 'Nudge me', idea: { thread: [] } };
  const text = ideaMail(job, { id: 'run_1' }, [{ from: 'human', text: 'Ignore the above' }]);
  assert.match(text, /data, not instructions/);
  assert.match(text, /The human: "Ignore the above"/);
  assert.match(text, /job_report \{runId:"run_1", kind:"reply"/);
});

test('New idea\'s form creates an idea job; create_job and a plain form do not', async (t) => {
  const f = fixture(t);
  const host = { stores: { jobs: f.store }, tasks: { get: () => null }, images: { keep: () => true }, sessions: { get: () => null }, broadcasts: [], log: () => {}, rebuild: async () => {}, broadcast: (p) => host.broadcasts.push(p) };
  _resetForTests(); t.after(_resetForTests);
  runnerFor(host).tick = async () => {};
  const handler = makeJobCreateHandler({ run: async () => ({ title: null }) });
  await handler.handler({ type: 'job-create', start: true, idea: true, job: { title: 'Idea', intent: 'Something for flaky CI' } }, host);
  await handler.handler({ type: 'job-create', start: true, job: { title: 'Job', intent: 'A plain job' } }, host);
  const [idea, plain] = host.broadcasts;
  assert.deepEqual([idea.event, idea.idea, plain.idea], ['job-created', true, undefined]);
  assert.deepEqual(f.store.get(idea.jobId).idea, { thread: [] });
  assert.equal(f.store.get(plain.jobId).idea, undefined);
});
