import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore, holdsSlot } from './job-store.js';
import { JobRunner } from './job-runner.js';
import { reportSchema } from './jobs-schema.js';
import { jobPrompt, ideaMail, SPLIT_PRINCIPLE } from './job-prompts.js';
import { liveSuggestion, inConversation, suggestionsOf, ideaEditable, IDEA_TEXT_MAX } from './job-idea.js';
import { makeJobCreateHandler, jobActionHandler, jobImagesHandler } from './handlers.js';
import { ideasDir } from './job-evidence.js';
import { _resetForTests, runnerFor } from './jobs.js';

const plan = (title = 'Nudge') => ({ context: 'ctx', stories: [], subJobs: [{ id: 'nudge', title, repo: '/repo', after: [], brief: 'Build it', show: ['Plate shows the wait'] }] });
const suggest = (title = 'Nudge when a green PR waits') => ({ title, plan: plan() });

function fixture(t, input = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-idea-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  const launched = [], mailed = [], stopped = [], released = [], alive = new Set();
  let clock = Date.now();
  const runtime = {
    async launch(j, s, r, prepared) { const sid = `session-${r.id}`; alive.add(sid); launched.push({ job: j, sub: s, run: r, sid }); prepared(sid, s ? { path: '/worktree/nudge', repoRoot: '/repo', branch: 'b' } : undefined); },
    async stop(r) { stopped.push(r.id); alive.delete(r.sessionId); },
    async isAlive(r) { return alive.has(r.sessionId); },
    async exists(r) { return alive.has(r.sessionId); },
    async resumeWithMail(r, text) { mailed.push({ sid: r.sessionId, text }); },
    async cleanup() {}, async cleanupPlanning() {}, releaseImages(j) { released.push(...(j.images || [])); }, attributeSpend() {},
  };
  const runner = new JobRunner({ store, runtime, github: {}, now: () => clock });
  const job = store.create({ title: 'Nudge me', intent: 'PRs sit green for ages. Can the board nag me?', ...input }, { idea: { thread: [] } });
  const tick = async () => { clock += 61000; await runner.tick(); };
  const last = () => launched.at(-1);
  const report = (payload, w = last()) => store.report(w.sid, w.run.id, payload);
  const get = () => store.get(job.id);
  const run = (w = last()) => get().runs.find((r) => r.id === w.run.id);
  const start = async () => { store.action(job.id, 'start'); await tick(); };
  return { store, job, runner, launched, mailed, stopped, released, alive, tick, last, report, get, run, start };
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
  assert.equal(liveSuggestion(f.get()).suggest[0].title, 'Nudge when a green PR waits');
});

test('accepting the suggestion is the plan receipt and its approval, even with Plan on You review; the parked planner ends quietly', async (t) => {
  const f = fixture(t); await f.start();
  const planner = f.last();
  f.report({ kind: 'reply', text: 'Here is the job.', suggest: suggest() });
  const msg = f.get().idea.thread.at(-1);
  assert.throws(() => f.store.action(f.job.id, 'accept-idea', { messageId: 'msg_other' }), /changed since you looked/);
  f.store.action(f.job.id, 'accept-idea', { messageId: msg.id });
  const job = f.get();
  assert.equal(job.reviewPlan ?? true, true);
  assert.deepEqual([job.stage, job.title, job.plan.subJobs[0].id, job.subJobs[0].id], ['active', 'Nudge when a green PR waits', 'nudge', 'nudge']);
  assert.ok(job.approvedAt, 'no second Approve for the plan just accepted');
  assert.ok(job.idea.thread.at(-1).acceptedAt);
  assert.equal(inConversation(job), false);
  assert.match(job.moves.at(-1).detail, /from the planner's suggestion/);
  await f.tick();
  assert.equal(f.run(planner).stopped, true);
  assert.equal(f.run(planner).error, undefined, 'stopped quietly, not as a missing receipt');
  assert.ok(!f.get().error);
  assert.deepEqual(f.launched.map((l) => l.run.phase), ['planning', 'implementation']);
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

const two = () => [suggest('Sort the job list by last activity'), suggest('Add a dark theme to settings')];

test('a reply may suggest 2–4 jobs; one stored before lists reads as a list of one', () => {
  assert.equal(reportSchema.parse({ kind: 'reply', text: 'Two jobs', suggest: two() }).suggest.length, 2);
  assert.throws(() => reportSchema.parse({ kind: 'reply', text: 'x', suggest: [] }));
  assert.throws(() => reportSchema.parse({ kind: 'reply', text: 'x', suggest: Array.from({ length: 5 }, () => suggest()) }));
  const old = { id: 'm', from: 'planner', text: 't', suggest: suggest(), acceptedAt: 5 };
  assert.deepEqual(suggestionsOf(old).map((x) => [x.title, x.createdAt]), [['Nudge when a green PR waits', 5]]);
  assert.equal(liveSuggestion({ idea: { thread: [{ ...old, acceptedAt: undefined }] } }).id, 'm', 'an old single suggestion is still live');
});

test('several suggestions: each press creates its own job beside the idea, the last turns the idea into its job', async (t) => {
  const f = fixture(t, { images: [], base: 'next', model: 'opus', reviewMerge: false }); await f.start();
  const planner = f.last();
  f.report({ kind: 'reply', text: 'These are two separate jobs.', suggest: [...two(), suggest('Rename the backlog tab')] });
  const msg = f.get().idea.thread.at(-1);
  assert.equal(msg.suggest.length, 3);
  f.store.action(f.job.id, 'accept-idea', { messageId: msg.id, index: 1 });
  let idea = f.get();
  assert.equal(inConversation(idea), true, 'the idea stays open for the rest');
  const made = idea.idea.thread.at(-1).suggest[1];
  assert.ok(made.createdAt && made.jobId && made.jobId !== f.job.id);
  const sib = f.store.get(made.jobId);
  assert.deepEqual([sib.stage, sib.title, sib.base, sib.model, sib.reviewMerge, sib.plan.subJobs[0].id, !!sib.approvedAt, sib.fromIdea.jobId],
    ['active', 'Add a dark theme to settings', 'next', 'opus', false, 'nudge', true, f.job.id]);
  assert.match(sib.moves[0].detail, /Created from the idea/);
  assert.match(idea.moves.at(-1).detail, /beside this idea/);
  assert.throws(() => f.store.action(f.job.id, 'accept-idea', { messageId: msg.id, index: 1 }), /already created/);
  assert.equal(liveSuggestion(idea).id, msg.id, 'the other two are still live');

  f.store.action(f.job.id, 'accept-idea', { messageId: msg.id, index: 0 });
  assert.equal(inConversation(f.get()), true);
  f.store.action(f.job.id, 'accept-idea', { messageId: msg.id, index: 2 });
  idea = f.get();
  assert.deepEqual([idea.stage, idea.title, inConversation(idea), idea.idea.thread.at(-1).suggest[2].jobId], ['active', 'Rename the backlog tab', false, f.job.id], 'the last one is the idea itself');
  assert.equal(f.store.snapshot().jobs.length, 3);
  await f.tick();
  assert.equal(f.run(planner).stopped, true);
  assert.equal(f.run(planner).error, undefined);
});

test('Create all makes the others beside the idea and the idea the last; a newer reply replaces every uncreated one', async (t) => {
  const f = fixture(t); await f.start();
  const planner = f.last();
  f.report({ kind: 'reply', text: 'Three jobs.', suggest: [...two(), suggest('Third')] });
  const first = f.get().idea.thread.at(-1);
  f.store.action(f.job.id, 'accept-idea', { messageId: first.id, index: 0 });
  f.store.action(f.job.id, 'idea-reply', { text: 'Make the dark theme follow the OS' });
  assert.equal(liveSuggestion(f.get()), null, 'the human\'s message replaces both uncreated suggestions');
  assert.throws(() => f.store.action(f.job.id, 'accept-idea', { messageId: first.id, index: 1 }), /changed since you looked/);
  await f.tick();
  assert.match(f.mailed.at(-1).text, /Already created from your suggestions, never suggest again: "Sort the job list by last activity"/);
  f.report({ kind: 'reply', text: 'Refined.', suggest: [suggest('Dark theme that follows the OS'), suggest('Third')] }, planner);
  const next = f.get().idea.thread.at(-1);
  assert.match(jobPrompt(f.get(), null, planner.run), /you suggested the jobs "Sort the job list by last activity", "Add a dark theme to settings" and "Third"; the human created "Sort the job list by last activity"/);
  f.store.action(f.job.id, 'accept-idea', { messageId: next.id, all: true });
  const idea = f.get();
  assert.deepEqual([idea.title, idea.stage], ['Third', 'active']);
  assert.deepEqual(f.store.snapshot().jobs.map((j) => j.title).sort(), ['Dark theme that follows the OS', 'Sort the job list by last activity', 'Third']);
});

test('Leave the rest closes an idea that already gave a job; before any, it is Cancel', async (t) => {
  const f = fixture(t); await f.start();
  const planner = f.last();
  f.report({ kind: 'reply', text: 'Two jobs.', suggest: two() });
  assert.throws(() => f.store.action(f.job.id, 'leave-idea'), /cancel it instead/);
  f.store.action(f.job.id, 'accept-idea', { messageId: f.get().idea.thread.at(-1).id, index: 0 });
  f.store.action(f.job.id, 'leave-idea');
  const idea = f.get();
  assert.ok(idea.cancelledAt && idea.idea.leftAt);
  assert.match(idea.moves.at(-1).detail, /this idea became “Sort the job list by last activity”/);
  await f.tick();
  assert.equal(f.run(planner).stopped, true);
});

test('a job made beside the idea shares its pictures: the idea finishing first keeps them for it', async (t) => {
  const f = fixture(t, { images: ['paste-1-abcd.png'] }); await f.start();
  f.report({ kind: 'reply', text: 'Two jobs.', suggest: two() });
  f.store.action(f.job.id, 'accept-idea', { messageId: f.get().idea.thread.at(-1).id, index: 0 });
  const sib = f.get().idea.thread.at(-1).suggest[0].jobId;
  assert.deepEqual(f.store.get(sib).images, ['paste-1-abcd.png']);
  f.store.action(f.job.id, 'leave-idea');
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.get().stage, 'done');
  assert.deepEqual(f.released, [], 'still held by the job made from it');
  f.store.action(sib, 'cancel-job');
  for (let i = 0; i < 3; i++) await f.tick();
  assert.deepEqual(f.released, ['paste-1-abcd.png']);
});

test('the idea prompt carries the approved split principle', async (t) => {
  const f = fixture(t); await f.start();
  const text = jobPrompt(f.get(), null, f.last().run);
  for (const p of SPLIT_PRINCIPLE) assert.ok(text.includes(p));
  assert.match(text, /suggest\?:\[\{title:/);
  assert.match(text, /replaces every suggestion they have not created yet/);
});

test('a well-defined idea goes straight to a plan, exactly as a job always did: Plan review still waits for Approve', async (t) => {
  const f = fixture(t); await f.start();
  f.report({ kind: 'plan', plan: plan() });
  await f.tick();
  const job = f.get();
  assert.deepEqual([job.stage, job.plan.subJobs.length, job.idea.thread.length, job.subJobs.length], ['planning', 1, 0, 0]);
  assert.equal(job.approvedAt, undefined);
  assert.equal(f.run(f.launched[0]).stopped, true);
  assert.equal(job.error, undefined);
  assert.equal(f.launched.length, 1, 'nothing runs before Approve');
  f.store.approvePlan(f.job.id, f.get().revision);
  assert.equal(f.get().stage, 'active');
});

test('two quick messages while the planner is still working both reach it: mailed mid-turn, and a plan cannot skip past one', async (t) => {
  const f = fixture(t); await f.start();
  const planner = f.last();
  f.store.action(f.job.id, 'idea-reply', { text: 'Start with one new theme.' });
  f.store.action(f.job.id, 'idea-reply', { text: 'And think deeply about how to make this extensible.' });
  assert.throws(() => f.report({ kind: 'plan', plan: plan() }), /wrote again while you were working/);
  await f.tick();
  assert.equal(f.mailed.length, 1, 'both go in one mail to the busy planner');
  assert.equal(f.mailed[0].sid, planner.sid);
  assert.match(f.mailed[0].text, /wrote again .* while you were working/);
  assert.match(f.mailed[0].text, /Start with one new theme\.[\s\S]*think deeply about how to make this extensible/);
  assert.ok(f.get().idea.thread.every((m) => m.sentAt));
  f.store.action(f.job.id, 'idea-reply', { text: 'Dark mode too.' });
  await f.tick();
  assert.equal(f.mailed.length, 2, 'a third, still mid-turn, follows in its own mail');
  assert.match(f.mailed[1].text, /Dark mode too/);
  await f.tick();
  assert.equal(f.mailed.length, 2, 'each message is mailed once');
  f.report({ kind: 'plan', plan: plan() });
  assert.equal(f.get().plan.subJobs[0].id, 'nudge');
});

test('a reply written before the second message reaches the busy planner is refused, and accepted once it is mailed', async (t) => {
  const f = fixture(t); await f.start();
  const planner = f.last();
  f.store.action(f.job.id, 'idea-reply', { text: 'Start with one new theme.' });
  f.store.action(f.job.id, 'idea-reply', { text: 'And think deeply about how to make this extensible.' });
  assert.throws(() => f.report({ kind: 'reply', text: 'Which theme first?' }), /wrote again while you were working[\s\S]*read your mail/);
  assert.equal(f.get().idea.thread.filter((m) => m.from === 'planner').length, 0, 'the refused reply leaves no trace');
  assert.equal(f.run(planner).parkedFor ?? null, null);
  await f.tick();
  assert.equal(f.mailed.length, 1);
  assert.match(f.mailed[0].text, /Start with one new theme\.[\s\S]*think deeply about how to make this extensible/);
  f.report({ kind: 'reply', text: 'One theme now, with a registry so more can be added. Which first?' });
  assert.equal(f.get().idea.thread.at(-1).from, 'planner');
  assert.equal(f.run(planner).parkedFor, 'idea');
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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
test('a picture pasted into the conversation is kept, shown in the thread, and mailed to the planner as a path', async (t) => {
  const f = fixture(t); await f.start();
  f.report({ kind: 'reply', text: 'Which screen?' });
  const staged = { 'paste.png': { mime: 'image/png', bytes: PNG } }, kept = {};
  const host = { stores: { jobs: f.store }, images: { keep: (n) => !!staged[n] && !!(kept[n] = staged[n]), read: (n) => kept[n] || null, remove: (n) => { delete kept[n]; } }, broadcasts: [], log: () => {}, rebuild: async () => {}, broadcast: (p) => host.broadcasts.push(p) };
  _resetForTests(); t.after(_resetForTests);
  runnerFor(host).tick = async () => {};
  t.after(() => fs.rmSync(path.dirname(ideasDir(f.job.id)), { recursive: true, force: true }));
  await jobActionHandler.handler({ id: f.job.id, action: 'idea-reply', text: 'This one', images: ['paste.png'], attachments: [{ file: '../../etc/passwd', path: '/etc/passwd' }] }, host);
  assert.deepEqual(host.broadcasts.at(-1), { event: 'job-action-complete', jobId: f.job.id, action: 'idea-reply' });
  const m = f.get().idea.thread.at(-1);
  assert.match(m.images[0].file, /^ask-.*-1\.png$/);
  assert.deepEqual(Object.keys(m.images[0]), ['file', 'mime'], 'a client-sent attachment never reaches the thread');
  const file = path.join(ideasDir(f.job.id), m.images[0].file);
  assert.deepEqual(fs.readFileSync(file), PNG);
  assert.deepEqual(Object.keys(kept), [], 'the kept copy is released once it is in the folder');
  await f.tick();
  assert.ok(f.mailed.at(-1).text.includes(`The human: "This one" (pasted images, read them: ${JSON.stringify(file)})`));
  assert.ok(jobPrompt(f.get(), null, f.last().run).includes(JSON.stringify(file)), 'a fresh planner reads it from the conversation too');
  jobImagesHandler.handler({ id: f.job.id }, host);
  assert.deepEqual(host.broadcasts.at(-1).images, [{ name: `idea:${m.images[0].file}`, mime: 'image/png', dataBase64: PNG.toString('base64') }]);
});

test('the reply reads as a colleague talking: the triage stays the planner\'s own thinking', async (t) => {
  const f = fixture(t); await f.start();
  const mail = ideaMail({ title: 'Nudge me', idea: { thread: [] } }, { id: 'run_1' }, [{ from: 'human', text: 'What does the toggle do?' }]);
  for (const text of [jobPrompt(f.get(), null, f.last().run), mail]) {
    assert.match(text, /colleague talking: answer the question, or ask what you need, straight away/);
    assert.match(text, /is your own thinking: never name the kind of request, say nothing will be built, or open with a stock preamble/);
  }
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

test('a backlog idea is edited before planning, and the planner reads the edited words', async (t) => {
  const f = fixture(t, { images: ['paste-1-abcd.png'] });
  assert.equal(ideaEditable(f.get()), true);
  const before = f.get().revision;
  f.store.action(f.job.id, 'edit-idea', { title: '  Nag me about green PRs ', text: 'Nag me when a green PR waits over a day.' });
  const edited = f.get();
  assert.deepEqual([edited.title, edited.intent, edited.images, edited.stage], ['Nag me about green PRs', 'Nag me when a green PR waits over a day.', ['paste-1-abcd.png'], 'backlog']);
  assert.ok(edited.revision > before);
  assert.deepEqual(edited.moves.map((m) => [m.move, m.detail]), [['edit-idea', 'Edited the idea\'s title and text']]);
  f.store.action(f.job.id, 'edit-idea', { text: 'Nag me when a green PR waits over a day.' });
  assert.equal(f.get().moves.length, 1, 'an unchanged save records nothing');
  f.store.action(f.job.id, 'edit-idea', { text: 'Only the words change' });
  assert.deepEqual([f.get().title, f.get().moves.at(-1).detail], ['Nag me about green PRs', 'Edited the idea\'s text']);
  await f.start();
  const prompt = jobPrompt(f.get(), null, f.last().run);
  assert.match(prompt, /Goal: Only the words change/);
  assert.doesNotMatch(prompt, /Can the board nag me/);
});

test('editing an idea is refused once planning starts, when cancelled, for a plain job, and when malformed', async (t) => {
  const f = fixture(t);
  const edit = (payload, id = f.job.id) => f.store.action(id, 'edit-idea', payload);
  assert.throws(() => edit({ text: '   ' }), /Write the idea first/);
  assert.throws(() => edit({ text: 'x'.repeat(IDEA_TEXT_MAX + 1) }), /under 8000 characters/);
  assert.throws(() => edit({ title: '' }), /Give the idea a title/);
  assert.throws(() => edit({ title: 'two\nlines' }), /one line/);
  assert.throws(() => edit({ title: 'x'.repeat(181) }), /one line under 180/);
  edit({ text: 'x'.repeat(IDEA_TEXT_MAX) });
  const plain = f.store.create({ title: 'Plain', intent: 'A job, not an idea' });
  assert.throws(() => edit({ text: 'new' }, plain.id), /Planning has started/);
  await f.start();
  assert.equal(f.get().stage, 'planning');
  assert.throws(() => edit({ text: 'Too late' }), /Planning has started on this idea/);
  assert.equal(f.get().intent, 'x'.repeat(IDEA_TEXT_MAX));
  const g = fixture(t);
  g.store.action(g.job.id, 'cancel-job');
  assert.throws(() => g.store.action(g.job.id, 'edit-idea', { text: 'new' }), /cancelled/);
});

test('a typed title wins over the generated one still on its way', (t) => {
  const f = fixture(t);
  const fallback = f.get().title;
  f.store.change((d) => { d.jobs[0].titlePending = true; });
  f.store.action(f.job.id, 'edit-idea', { title: 'Mine' });
  assert.equal(f.get().titlePending, undefined);
  assert.equal(f.store.retitle(f.job.id, fallback, 'Generated'), false);
  assert.equal(f.get().title, 'Mine');
});
