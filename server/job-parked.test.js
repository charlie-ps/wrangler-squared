import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JobStore, holdsSlot, TREE_MOVED } from './job-store.js';
import { JobRunner } from './job-runner.js';
import { changeView } from './job-change.js';
import { ensureInbox, roundDir, ideasDir } from './job-evidence.js';
import { workingTreeHash } from './git.js';
import { threadMail, jobPrompt } from './job-prompts.js';
import { jobActionHandler } from './handlers.js';
import { _resetForTests, runnerFor } from './jobs.js';
import { looksLikeQuestion } from './job-parked.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
function hostFor(t, f, images = {}) {
  const host = { stores: { jobs: f.store }, sessions: { get: () => null }, images: { read: (n) => images[n] || null, remove: (n) => { delete images[n]; } },
    rebuilds: 0, broadcasts: [], log: () => {}, rebuild: async () => { host.rebuilds++; }, broadcast: (p) => host.broadcasts.push(p) };
  _resetForTests(); t.after(_resetForTests);
  runnerFor(host).tick = async () => {};
  return host;
}
const plan = () => ({ context: 'ctx', stories: [], subJobs: [{ id: 'api', title: 'Audit page', repo: '/repo', after: [], brief: 'Build it', show: ['Lists sign-ins'] }] });
const shot = (file = 'list.png') => ({ text: 'Lists sign-ins', shots: [{ file, url: 'http://localhost:5174/audit' }] });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-parked-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  const launched = [], mailed = [], stopped = [], alive = new Set();
  let clock = Date.now();
  const runtime = {
    async launch(j, s, r, prepared) { const sid = `session-${r.id}`; alive.add(sid); launched.push({ sub: s, run: r, sid }); prepared(sid, s?.worktree ? undefined : { path: '/worktree/api', repoRoot: '/repo', branch: 'b' }); },
    async stop(r) { stopped.push(r.id); alive.delete(r.sessionId); },
    async isAlive(r) { return alive.has(r.sessionId); },
    async exists(r) { return alive.has(r.sessionId); },
    async resumeWithMail(r, text) { mailed.push({ sid: r.sessionId, text }); },
    async cleanup() {}, async cleanupPlanning() {}, releaseImages() {}, attributeSpend() {},
  };
  const runner = new JobRunner({ store, runtime, github: {}, now: () => clock });
  const job = store.create({ title: 'Audit log', intent: 'Add an audit log', repos: ['/repo'], reviewCode: true });
  const tick = async () => { clock += 61000; await runner.tick(); };
  // The step's own session, not a planner that ran since (every idea goes through one).
  const last = () => launched.filter((w) => w.sub).at(-1) || launched.at(-1);
  const report = (payload, w = last()) => store.report(w.sid, w.run.id, payload);
  const sub = () => store.get(job.id).subJobs[0];
  const run = () => store.get(job.id).runs.find((r) => r.id === last().run.id);
  // An idea typed on the review goes to the planner, which forwards it to the open
  // session; a forward and nothing else applies with no prompt.
  const propose = async (actions) => {
    await tick();
    const planner = launched.at(-1);
    store.report(planner.sid, planner.run.id, { kind: 'plan', plan: plan(), actions });
    return planner.run.id;
  };
  const ask = async (text, extra = {}) => {
    const j = store.get(job.id); const view = changeView(j, j.subJobs[0]);
    store.action(job.id, 'request-change', { subJobId: 'api', at: view.at, ref: view.ref, text, ...extra });
    await propose([{ type: 'forward', sub: 'api', note: text }]);
  };
  async function ready(checks = [shot()], meta = {}) {
    ensureInbox(job.id, 'api'); fs.writeFileSync(path.join(ensureInbox(job.id, 'api'), 'list.png'), PNG);
    report({ kind: 'ready', checks }, last());
    if (meta.treeHash) store.update(job.id, (j) => { j.subJobs[0].ready.treeHash = meta.treeHash; });
    await tick();
  }
  async function start() {
    store.action(job.id, 'start'); await tick();
    report({ kind: 'plan', plan: plan() }, launched.at(-1)); await tick();
    store.approvePlan(job.id, store.get(job.id).revision); await tick();
  }
  return { store, job, runner, launched, mailed, stopped, alive, tick, last, report, sub, run, ask, propose, ready, start };
}

test('ready parks the run instead of ending it: no slot, no error, the session kept', async (t) => {
  const f = fixture(t); await f.start(); await f.ready();
  const run = f.run();
  assert.deepEqual([run.stopped, run.report, run.parkedFor], [false, null, 'ready']);
  assert.ok(run.parkedAt && !run.mailedAt);
  assert.equal(holdsSlot(run), false);
  assert.deepEqual([f.sub().stage, f.sub().state, !!f.sub().error], ['review', 'verified', false]);
  assert.equal(f.sub().ready.round, 1);
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.run().stopped, false, 'a parked run is held only to its card existing, however long the human takes');
  assert.equal(f.stopped.length, 1, 'only the planner stopped');
  assert.throws(() => f.report({ kind: 'published', url: 'https://github.com/o/r/pull/1' }), /wait for mail/);
  f.report({ kind: 'ready', checks: [shot()] });
});

test('the card going away ends a parked run quietly: the human can still approve the tree', async (t) => {
  const f = fixture(t); await f.start(); await f.ready();
  f.alive.clear(); await f.tick();
  assert.equal(f.run().stopped, true);
  assert.deepEqual([!!f.sub().error, f.sub().state], [false, 'verified']);
});

test('a question is mailed to the parked session, answered by a reply, and the run parks again with the round unchanged', async (t) => {
  const f = fixture(t); await f.start(); await f.ready();
  const receipt = f.sub().ready.receiptId;
  await f.ask('What does it show when nobody has signed in?');
  assert.equal(f.sub().answering.kind, 'ask');
  assert.deepEqual(f.sub().thread.map((m) => [m.from, m.via, m.to, m.sentAt]), [['human', 'planner', 'agent', null]]);
  assert.deepEqual(f.launched.map((w) => w.run.phase), ['planning', 'implementation', 'planning'], 'no new implementer: the open session already has the context');
  await f.tick();
  assert.equal(f.mailed.length, 1); assert.equal(f.mailed[0].sid, f.last().sid);
  assert.match(f.mailed[0].text, /What does it show when nobody has signed in\?/);
  assert.match(f.mailed[0].text, /kind:"reply"/); assert.match(f.mailed[0].text, /kind:"ready"/);
  assert.ok(f.run().mailedAt && holdsSlot(f.run()), 'woken: it holds a slot while it answers');
  assert.ok(f.sub().thread[0].sentAt);
  await f.tick(); assert.equal(f.mailed.length, 1, 'delivered once');
  fs.writeFileSync(path.join(ensureInbox(f.job.id, 'api'), 'empty.png'), PNG);
  f.report({ kind: 'reply', text: 'The empty state.', shots: ['empty.png'] });
  const sub = f.sub();
  assert.equal(sub.answering, null);
  assert.deepEqual(sub.thread.map((m) => m.from), ['human', 'agent']);
  assert.match(sub.thread[1].shots[0].file, /^msg_.*-empty\.png$/);
  assert.ok(fs.existsSync(path.join(roundDir(f.job.id, 'api', 1), sub.thread[1].shots[0].file)));
  assert.deepEqual([sub.ready.receiptId, sub.ready.round, sub.state], [receipt, 1, 'verified']);
  assert.equal(holdsSlot(f.run()), false, 'parked again');
  f.report({ kind: 'reply', text: 'The empty state.', shots: ['empty.png'] });
  assert.throws(() => f.report({ kind: 'reply', text: 'Another' }), /wait for mail/);
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: receipt });
  assert.equal(f.sub().state, 'approved', 'a reply leaves the approval it did not touch standing');
});

test('a forward-only idea lands in the step\'s thread with no plan-change prompt, recorded as Wrangler\'s', async (t) => {
  const f = fixture(t); await f.start(); await f.ready();
  await f.ask('Make the filter a dropdown');
  const job = f.store.get(f.job.id);
  assert.equal(job.replan, null, 'no proposal waits for the human');
  assert.deepEqual(f.sub().thread.map((m) => [m.from, m.via, m.text]), [['human', 'planner', 'Make the filter a dropdown']]);
  const approved = job.moves.find((m) => m.move === 'approve-replan');
  assert.match(approved.detail, /Changed the plan: 1 action \(Forwarded without a prompt\)/);
  await f.tick();
  assert.match(f.mailed.at(-1).text, /The human \(through the planner\): "Make the filter a dropdown"/);
});

test('a forward that comes with a plan edit still waits for the human to approve', async (t) => {
  const f = fixture(t); await f.start(); await f.ready();
  const j = f.store.get(f.job.id); const view = changeView(j, j.subJobs[0]);
  f.store.action(f.job.id, 'request-change', { subJobId: 'api', at: view.at, ref: view.ref, text: 'Use a dropdown, and add docs after' });
  await f.tick();
  const planner = f.launched.at(-1);
  const docs = { id: 'docs', title: 'Docs', repo: '/repo', after: ['api'], brief: 'Document it' };
  f.store.report(planner.sid, planner.run.id, { kind: 'plan', plan: { ...plan(), subJobs: [...plan().subJobs, docs] }, actions: [{ type: 'forward', sub: 'api', note: 'Use a dropdown' }] });
  const waiting = f.store.get(f.job.id).replan.proposal;
  assert.deepEqual([waiting.id, waiting.changes.added, waiting.actions.map((a) => a.type)], [planner.run.id, ['docs'], ['forward']]);
  assert.equal(f.sub().thread, undefined, 'nothing reaches the session before the human approves');
  f.store.action(f.job.id, 'approve-replan', { proposalId: planner.run.id });
  assert.equal(f.sub().thread.length, 1);
  assert.ok(f.store.get(f.job.id).subJobs.some((s) => s.id === 'docs'));
});

test('a reply needs a human to have written first, and a ready run to answer', async (t) => {
  const f = fixture(t); await f.start();
  assert.throws(() => f.report({ kind: 'reply', text: 'hi' }), /nothing to answer/);
  await f.ready();
  assert.throws(() => f.report({ kind: 'reply', text: 'hi' }), /nothing to answer|wait for mail/);
});

test('a change is reworked into a fresh ready: a new round, a new receipt, earlier proof kept', async (t) => {
  const f = fixture(t); await f.start(); await f.ready();
  const first = f.sub().ready;
  await f.ask('Make the IP filter a dropdown');
  assert.equal(f.sub().answering.kind, 'change');
  await f.tick();
  fs.writeFileSync(path.join(ensureInbox(f.job.id, 'api'), 'list2.png'), PNG);
  f.report({ kind: 'ready', checks: [shot('list2.png')] }); await f.tick();
  const sub = f.sub();
  assert.equal(sub.ready.round, 2);
  assert.equal(sub.ready.receiptId, `${f.last().run.id}#2`);
  assert.deepEqual(sub.earlier.map((e) => [e.round, e.proof[0].shots[0].file]), [[1, 'list.png']]);
  assert.equal(sub.answering, null);
  assert.equal(sub.thread.at(-1).from, 'system');
  assert.equal(f.run().parkedFor, 'ready'); assert.equal(holdsSlot(f.run()), false);
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: first.receiptId }), /not ready to approve/, 'an approval of round 1 is refused');
  assert.ok(fs.existsSync(path.join(roundDir(f.job.id, 'api', 1), 'list.png')) && fs.existsSync(path.join(roundDir(f.job.id, 'api', 2), 'list2.png')));
  const parked = f.last().run.id;
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: sub.ready.receiptId });
  await f.tick();
  assert.equal(f.stopped.includes(parked), true, 'approving stops the parked session');
  assert.equal(f.last().run.phase, 'publish');
  assert.match(jobPrompt(f.store.get(f.job.id), f.last().sub, f.last().run), /implementation → ready: /);
});

test('approve-code is pinned to the working tree the agent reported', async (t) => {
  const f = fixture(t); await f.start(); await f.ready([shot()], { treeHash: 'aaa' });
  const receipt = f.sub().ready.receiptId;
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: receipt, treeHash: 'bbb' }), (e) => e.code === TREE_MOVED && /report ready again/.test(e.message));
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: receipt, treeHash: null }), (e) => e.code !== TREE_MOVED && /Could not read the working tree/.test(e.message));
  assert.equal(f.sub().state, 'verified');
  f.store.action(f.job.id, 'tree-moved', { subJobId: 'api', readyReceiptId: receipt });
  assert.equal(f.sub().answering.kind, 'retell');
  await f.tick();
  assert.match(f.mailed.at(-1).text, /working tree changed after you reported ready/);
  assert.match(f.mailed.at(-1).text, /kind:"ready"/);
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: receipt, treeHash: 'aaa' });
  assert.equal(f.sub().state, 'approved');
});

test('the job-action handler reads the tree itself and refuses a stale approval, asking the session again', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tree-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'A');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one'); git('add', '-A'); git('commit', '-qm', 'init');
  const f = fixture(t); await f.start();
  const wt = f.store.get(f.job.id).subJobs[0].worktree;
  f.store.update(f.job.id, (j) => { j.subJobs[0].worktree = { ...wt, path: repo }; });
  fs.writeFileSync(path.join(repo, 'b.txt'), 'two');
  const hash = await workingTreeHash(repo);
  await f.ready([shot()], { treeHash: hash });
  const host = hostFor(t, f);
  const msg = (extra = {}) => ({ id: f.job.id, subJobId: 'api', action: 'approve-code', readyReceiptId: f.sub().ready.receiptId, ...extra });
  fs.writeFileSync(path.join(repo, 'b.txt'), 'changed after ready');
  await jobActionHandler.handler(msg({ treeHash: hash }), host);
  assert.equal(host.broadcasts.at(-1).event, 'job-action-failed');
  assert.match(host.broadcasts.at(-1).error, /working tree changed/);
  assert.equal(f.sub().answering.kind, 'retell', 'a tree hash the client sent is ignored; the server read its own');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'two');
  await jobActionHandler.handler(msg(), host);
  assert.equal(host.broadcasts.at(-1).event, 'job-action-complete');
  assert.equal(f.sub().state, 'approved');
});

test('workingTreeHash covers untracked files, ignores ignored ones, and leaves the real index alone', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tree-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n'); fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  const base = await workingTreeHash(repo);
  assert.equal(await workingTreeHash(repo), base, 'stable');
  fs.mkdirSync(path.join(repo, 'out')); fs.writeFileSync(path.join(repo, 'out', 'x'), 'built');
  assert.equal(await workingTreeHash(repo), base, 'ignored files do not move it');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked');
  const withNew = await workingTreeHash(repo);
  assert.notEqual(withNew, base);
  fs.writeFileSync(path.join(repo, 'a.txt'), '2');
  assert.notEqual(await workingTreeHash(repo), withNew);
  assert.equal(git('status', '--porcelain').includes('A '), false, 'nothing was staged in the real index');
});

test('Code on Auto does not park: the ready receipt ends the run as it always did', async (t) => {
  const f = fixture(t); f.store.update(f.job.id, (j) => { j.reviewCode = false; });
  await f.start();
  const impl = f.last().run.id;
  await f.ready();
  const run = f.store.get(f.job.id).runs.find((r) => r.id === impl);
  assert.equal(run.stopped, true); assert.ok(run.report); assert.equal(run.parkedFor, undefined);
});

test('pasted images go to the evidence folder and the session is mailed their path', async (t) => {
  const f = fixture(t); await f.start(); await f.ready();
  const images = { 'pasted.png': { mime: 'image/png', bytes: PNG } };
  const host = hostFor(t, f, images);
  const view = changeView(f.store.get(f.job.id), f.sub());
  await jobActionHandler.handler({ id: f.job.id, subJobId: 'api', action: 'request-change', at: view.at, ref: view.ref, text: 'See attached', images: ['pasted.png'], attachments: [{ file: '../../etc/passwd' }] }, host);
  assert.equal(f.sub().thread, undefined, 'nothing reaches the session before the planner has read it');
  assert.match(f.store.get(f.job.id).replan.feedback, /See attached\n\(Pasted images, read them: /, 'the planner reads the picture');
  await f.propose([{ type: 'forward', sub: 'api', note: 'See attached' }]);
  const [m] = f.sub().thread;
  assert.equal(m.images.length, 1); assert.match(m.images[0].file, /^ask-.*-1\.png$/);
  assert.ok(fs.existsSync(path.join(roundDir(f.job.id, 'api', 1), m.images[0].file)));
  assert.deepEqual(Object.keys(images), [], 'the staged copy is released');
  const text = threadMail(f.store.get(f.job.id), f.run(), f.sub(), [m]);
  assert.ok(text.includes(path.join(roundDir(f.job.id, 'api', 1), m.images[0].file)));
});

test('an idea for the planner keeps its pasted images too, and hands the planner their paths in the words', async (t) => {
  const f = fixture(t); await f.start();
  const images = { 'pasted.png': { mime: 'image/png', bytes: PNG } };
  const host = hostFor(t, f, images);
  const view = changeView(f.store.get(f.job.id), null);
  assert.equal(view.at, 'job');
  await jobActionHandler.handler({ id: f.job.id, action: 'request-change', at: view.at, ref: view.ref, text: 'Split web in two', images: ['pasted.png'] }, host);
  const job = f.store.get(f.job.id);
  const [file] = fs.readdirSync(ideasDir(f.job.id));
  assert.match(file, /^ask-.*-1\.png$/);
  assert.ok(job.replan.feedback.startsWith('Split web in two\n(Pasted images, read them: '));
  assert.ok(job.replan.feedback.includes(JSON.stringify(path.join(ideasDir(f.job.id), file))));
  assert.equal(job.moves.at(-1).note, 'Split web in two', 'the history keeps the words, not the paths');
  assert.deepEqual(Object.keys(images), [], 'the staged copy is released');
});

test('a plan change that reworks the sub-job ends the parked session and starts a new one', async (t) => {
  const f = fixture(t); await f.start(); await f.ready();
  const parked = f.last().run.id;
  f.store.update(f.job.id, (j) => { const s = j.subJobs[0]; s.stage = 'implementation'; s.state = 'queued'; s.ready = null; });
  await f.tick(); await f.tick();
  assert.ok(f.stopped.includes(parked));
  assert.equal(f.last().run.phase, 'implementation'); assert.notEqual(f.last().run.id, parked);
  assert.equal(!!f.sub().error, false);
});

test('questions are told from changes only to label the card', () => {
  assert.equal(looksLikeQuestion('What does it show?'), true);
  assert.equal(looksLikeQuestion('does it handle empty'), true);
  assert.equal(looksLikeQuestion('Make the filter a dropdown'), false);
});

test('the planner is told the step\'s session is open and where the idea was typed, and the mail says it came through the planner', async (t) => {
  const f = fixture(t); await f.start(); await f.ready();
  const j = f.store.get(f.job.id); const view = changeView(j, j.subJobs[0]);
  f.store.action(f.job.id, 'request-change', { subJobId: 'api', at: view.at, ref: view.ref, text: 'Is the empty state covered?' });
  await f.tick();
  const planner = f.launched.at(-1);
  const prompt = jobPrompt(f.store.get(f.job.id), null, planner.run);
  assert.match(prompt, /- api \(pr\) "Audit page": review\/verified · its session is OPEN on review round 1 \(forward feedback to it\)/);
  assert.match(prompt, /The latest idea was typed on its code review of api "Audit page" \(pinned to run_\w+\)\./);
  assert.match(prompt, /\{type:"forward",sub,note\}/);
  f.store.report(planner.sid, planner.run.id, { kind: 'plan', plan: plan(), actions: [{ type: 'forward', sub: 'api', note: 'Is the empty state covered?' }] });
  await f.tick();
  assert.match(f.mailed.at(-1).text, /The human \(through the planner\): "Is the empty state covered\?"/);
});
