import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from './job-store.js';
import { JobRunner } from './job-runner.js';
import { changeView } from './job-change.js';
import { ensureInbox, inboxDir } from './job-evidence.js';
import { reportSchema } from './jobs-schema.js';
import { teardown, readLog, setRunning, holdsRunning, dueTeardown } from './job-running.js';
import { jobPrompt, threadMail } from './job-prompts.js';
import { jobRunningLogsHandler } from './handlers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
const plan = () => ({ context: 'ctx', stories: [], subJobs: [{ id: 'api', title: 'Audit page', repo: '/repo', after: [], brief: 'Build it', show: ['Lists sign-ins'] }] });
const shot = { text: 'Lists sign-ins', shots: [{ file: 'list.png' }] };
const VITE = { name: 'vite dev server', url: 'http://localhost:5174/audit', pid: 48211, log: '/worktree/api/vite.log' };
const DB = { name: 'postgres', url: 'http://localhost:55432/', pid: 48300 };

// Fake processes and URLs: what is "up" is whatever the test says, and killing a
// group takes its URL down with it. A `deaf` pid ignores SIGTERM; `immortal` ignores both.
const URL_OF = { 48211: 'http://localhost:5174/audit', 48300: 'http://localhost:55432/' };
function fakeDeps({ deaf = [], immortal = [] } = {}) {
  const calls = { kills: [] };
  const procs = new Map([[48211, 48211], [48300, 48300]]);
  const urls = new Set(Object.values(URL_OF));
  const deps = {
    calls, procs, urls,
    kill: (pid, sig) => {
      calls.kills.push([pid, sig]);
      const p = Math.abs(pid);
      if (immortal.includes(p) || (deaf.includes(p) && sig === 'SIGTERM')) return;
      procs.delete(p); urls.delete(URL_OF[p]);
    },
    alive: (pid) => procs.has(pid),
    pgidOf: async (pid) => procs.get(pid) ?? null,
    answers: async (url) => urls.has(url),
    sleep: async () => {},
  };
  return deps;
}

function fixture(t, { reviewCode = true, deps = fakeDeps() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-running-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  const launched = [], mailed = [], alive = new Set();
  let clock = Date.now();
  const runtime = {
    async launch(j, s, r, prepared) { const sid = `session-${r.id}`; alive.add(sid); launched.push({ run: r, sid }); prepared(sid, s?.worktree ? undefined : { path: '/worktree/api', repoRoot: '/repo', branch: 'b' }); },
    async stop(r) { alive.delete(r.sessionId); },
    async isAlive(r) { return alive.has(r.sessionId); },
    async exists(r) { return alive.has(r.sessionId); },
    async resumeWithMail(r, text) { mailed.push({ sid: r.sessionId, text }); },
    async cleanup() {}, async cleanupPlanning() {}, releaseImages() {}, attributeSpend() {},
  };
  const mkRunner = () => new JobRunner({ store, runtime, github: {}, now: () => clock, running: deps });
  const runner = mkRunner();
  const job = store.create({ title: 'Audit log', intent: 'Add an audit log', repos: ['/repo'], reviewCode });
  const tick = async (r = runner) => { clock += 61000; await r.tick(); };
  // The step's own session, not a planner that ran since (every idea goes through one).
  const last = () => launched.filter((w) => w.run.subJobId).at(-1) || launched.at(-1);
  const report = (payload, w = last()) => store.report(w.sid, w.run.id, payload);
  const sub = () => store.get(job.id).subJobs[0];
  async function start() {
    store.action(job.id, 'start'); await tick();
    report({ kind: 'plan', plan: plan() }, launched.at(-1)); await tick();
    store.approvePlan(job.id, store.get(job.id).revision); await tick();
  }
  async function ready(running, checks = [shot]) {
    fs.writeFileSync(path.join(ensureInbox(job.id, 'api'), 'list.png'), PNG);
    report({ kind: 'ready', checks, ...(running ? { running } : {}) });
    await tick();
  }
  return { store, job, runner, mkRunner, launched, mailed, deps, tick, last, report, sub, ready, start };
}

test('a running entry needs a url or a pid, and nothing odd', () => {
  const parse = (running) => reportSchema.safeParse({ kind: 'ready', checks: ['x'], running });
  assert.equal(parse([VITE, DB]).success, true);
  assert.equal(parse([{ name: 'bare' }]).success, false);
  assert.equal(parse([{ name: 'x', url: 'file:///etc/passwd' }]).success, false);
  assert.equal(parse([{ name: 'x', pid: 1 }]).success, false, 'init is never ours to signal');
  assert.equal(parse([{ name: 'x', pid: 4000, stop: 'docker compose down' }]).success, false, 'no stop commands: teardown is by process group');
  assert.equal(parse([{ name: 'x', pid: 4000, log: 'relative.log' }]).success, false);
  assert.equal(parse(Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, pid: 100 + i }))).success, false);
  assert.equal(reportSchema.safeParse({ kind: 'reply', text: 'ok', running: [VITE] }).success, true);
});

test('what the agent left running is kept for the review and probed up or down', async (t) => {
  const f = fixture(t); await f.start(); await f.ready([VITE, DB]);
  assert.deepEqual(f.sub().running.items.map((i) => [i.name, i.up]), [['vite dev server', true], ['postgres', true]]);
  f.deps.urls.delete('http://localhost:5174/audit');
  await f.tick();
  assert.equal(f.sub().running.items[0].up, false, 'the link stopped answering');
  assert.equal(f.sub().running.items[1].up, true);
  assert.deepEqual(f.deps.calls.kills, [], 'a review that is still open is never torn down');
});

test('approving kills each recorded process group, and the approval goes through', async (t) => {
  const f = fixture(t); await f.start(); await f.ready([VITE, DB]);
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: f.sub().ready.receiptId });
  await f.tick();
  assert.deepEqual(f.deps.calls.kills, [[-48211, 'SIGTERM'], [-48300, 'SIGTERM']], 'a setsid leader is killed as its whole group');
  const { running } = f.sub();
  assert.deepEqual([running.items, running.stopped.reason, running.stopped.still], [[], 'approved', []]);
  assert.deepEqual(running.stopped.results.map((r) => [r.name, r.ok, r.detail]), [['vite dev server', true, 'process group 48211 killed'], ['postgres', true, 'process group 48300 killed']]);
  assert.ok(!f.sub().error, 'teardown is not a step failure');
  assert.ok(f.store.get(f.job.id).runs.some((r) => r.landing), 'and the approval went through: the session is told to land it');
});

test('a group that ignores SIGTERM gets SIGKILL; one that will not die is flagged and never fails the approval', async (t) => {
  const f = fixture(t, { deps: fakeDeps({ deaf: [48211], immortal: [48300] }) });
  await f.start(); await f.ready([VITE, DB]);
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: f.sub().ready.receiptId });
  await f.tick();
  assert.deepEqual(f.deps.calls.kills, [[-48211, 'SIGTERM'], [-48211, 'SIGKILL'], [-48300, 'SIGTERM'], [-48300, 'SIGKILL']]);
  const { stopped } = f.sub().running;
  assert.deepEqual(stopped.still, ['postgres'], 'vite died to SIGKILL; postgres outlived both');
  assert.match(stopped.results[1].detail, /process 48300 would not die/);
  assert.ok(!f.sub().error);
  assert.ok(f.store.get(f.job.id).runs.some((r) => r.landing));
});

test('an entry with only a url has nothing to kill, and says so', async () => {
  const out = await teardown([{ name: 'docker', url: 'http://localhost:8080/' }], { deps: fakeDeps() });
  assert.deepEqual(out, { results: [{ name: 'docker', ok: false, detail: 'no process to stop' }], still: ['docker'] });
});

test('a pid that does not lead its own group is killed alone, and never our own process', async (t) => {
  const deps = fakeDeps(); deps.procs.set(777, 1);
  const out = await teardown([{ name: 'child', pid: 777 }, { name: 'us', pid: process.pid }, { name: 'parent', pid: process.ppid }], { deps });
  assert.deepEqual(deps.calls.kills, [[777, 'SIGTERM']]);
  assert.deepEqual(out.still, ['us', 'parent']);
});

test('a later round that no longer lists an entry stops it at once and keeps the rest', async (t) => {
  const f = fixture(t); await f.start(); await f.ready([VITE, DB]);
  const asked = f.store.get(f.job.id); const view = changeView(asked, asked.subJobs[0]);
  f.store.action(f.job.id, 'request-change', { subJobId: 'api', at: view.at, ref: view.ref, text: 'Drop the database' });
  await f.tick();
  const planner = f.launched.at(-1);
  f.report({ kind: 'plan', plan: plan(), actions: [{ type: 'forward', sub: 'api', note: 'Drop the database' }] }, planner);
  await f.tick();
  await f.ready([VITE], [shot]);
  assert.deepEqual(f.sub().running.items.map((i) => i.name), ['vite dev server']);
  assert.deepEqual(f.deps.calls.kills, [[-48300, 'SIGTERM']], 'postgres was killed; vite, listed again by pid, stays up for round 2');
  assert.deepEqual(f.sub().running.stopped.results.map((r) => r.name), ['postgres']);
});

test('Code on Auto leaves nothing running: what a receipt lists is stopped at once', async (t) => {
  const f = fixture(t, { reviewCode: false }); await f.start(); await f.ready([VITE]);
  assert.equal(f.sub().running.items.length, 0);
  assert.deepEqual(f.deps.calls.kills, [[-48211, 'SIGTERM']]);
  assert.match(jobPrompt(f.store.get(f.job.id), { ...f.sub(), show: ['x'] }, { id: 'r', phase: 'implementation' }), /nothing may be left running/);
});

test('dropping the sub-job, cancelling the job and a replan each tear down; so does boot', async (t) => {
  const drop = fixture(t); await drop.start(); await drop.ready([VITE, DB]);
  drop.store.update(drop.job.id, (j) => { j.subJobs[0].cancelledAt = Date.now(); j.subJobs[0].stage = 'cleanup'; j.subJobs[0].state = 'cancelled'; });
  await drop.tick();
  assert.equal(drop.sub().running.stopped.reason, 'dropped');
  assert.equal(drop.sub().running.items.length, 0);

  const cancel = fixture(t); await cancel.start(); await cancel.ready([VITE]);
  cancel.store.action(cancel.job.id, 'cancel-job', {});
  await cancel.tick();
  assert.equal(cancel.sub().running.stopped.reason, 'dropped');

  const replan = fixture(t); await replan.start(); await replan.ready([VITE]);
  replan.store.update(replan.job.id, (j) => { Object.assign(j.subJobs[0], { stage: 'implementation', state: 'queued', ready: null }); });
  await replan.tick();
  assert.equal(replan.sub().running.stopped.reason, 'reworked');

  const boot = fixture(t); await boot.start(); await boot.ready([VITE]);
  boot.store.update(boot.job.id, (j) => { Object.assign(j.subJobs[0], { stage: 'pr', state: 'watching' }); });
  const fresh = boot.mkRunner();
  await fresh.sweepRunning(boot.job.id);
  assert.equal(boot.sub().running.items.length, 0, 'a sub-job found past review owns nothing that should still answer');
  assert.deepEqual(boot.deps.calls.kills, [[-48211, 'SIGTERM']]);
});

test('Stop all kills every group on the next tick, and a reply\'s list replaces the one before', async (t) => {
  const f = fixture(t); await f.start(); await f.ready([VITE, DB]);
  f.deps.procs.set(50000, 50000); f.deps.urls.add('http://localhost:5199/audit');
  f.store.update(f.job.id, (j) => { j.runs.find((r) => r.parkedFor === 'ready').mailedAt = Date.now(); });
  f.report({ kind: 'reply', text: 'Moved it to 5199', running: [{ name: 'vite dev server', url: 'http://localhost:5199/audit', pid: 50000 }, DB] });
  await f.tick();
  assert.deepEqual(f.sub().running.items.map((i) => [i.name, i.url, i.up]), [['vite dev server', 'http://localhost:5199/audit', true], ['postgres', 'http://localhost:55432/', true]]);
  assert.deepEqual(f.deps.calls.kills, [[-48211, 'SIGTERM']], 'the old vite group it no longer lists is killed');
  f.store.action(f.job.id, 'stop-running', { subJobId: 'api' });
  assert.deepEqual(f.sub().running.items.map((i) => i.replaced), [true, true], 'nothing shows while it waits for the tick');
  await f.tick();
  assert.equal(f.sub().running.items.length, 0);
  assert.deepEqual(f.deps.calls.kills.slice(1), [[-50000, 'SIGTERM'], [-48300, 'SIGTERM']]);
  assert.equal(f.sub().running.stopped.reason, 'stopped during review');
  assert.throws(() => f.store.action(f.job.id, 'stop-running', { subJobId: 'api' }), /Nothing is running/);
  assert.throws(() => f.store.action(f.job.id, 'restart-running', { subJobId: 'api' }));
});

test('holdsRunning is true only while the review waits on the human', () => {
  const job = { subJobs: [] };
  const sub = (o) => ({ stage: 'review', state: 'verified', ready: {}, ...o });
  assert.equal(holdsRunning(job, sub()), true);
  assert.equal(holdsRunning(job, sub({ state: 'approved' })), false);
  assert.equal(holdsRunning(job, sub({ ready: { approvedAt: 1 } })), false);
  assert.equal(holdsRunning(job, sub({ cancelledAt: 1 })), false);
  assert.equal(holdsRunning({ cancelledAt: 1 }, sub()), false);
  assert.equal(holdsRunning(job, sub({ stage: 'cleanup' })), false);
});

test('setRunning keeps a re-listed pid, leaves the rest replaced, and ignores an older save\'s owed and stop', () => {
  const sub = { running: { round: 1, items: [{ ...VITE, up: true }, { name: 'old db', stop: 'docker compose down', up: true }], owed: [{ name: 'ghost', pid: 9 }] } };
  setRunning(sub, [VITE, DB], 2);
  assert.deepEqual(sub.running.items.map((i) => [i.name, i.up, !!i.replaced]), [['vite dev server', true, false], ['postgres', null, false]], 'an entry with no pid has nothing to kill, so it is just forgotten');
  assert.equal('owed' in sub.running, false);
  setRunning(sub, [DB], 3);
  assert.deepEqual(sub.running.items.map((i) => [i.name, !!i.replaced]), [['postgres', false], ['vite dev server', true]]);
  assert.deepEqual(dueTeardown({}, { ...sub, stage: 'review', state: 'verified', ready: {} }).map((i) => i.name), ['vite dev server']);
  assert.deepEqual(dueTeardown({}, { ...sub, stage: 'pr' }).map((i) => i.name), ['postgres', 'vite dev server']);
});

test('Logs reads the tail of a log under the worktree or the proof folder, and nowhere else', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const job = { id: 'job_aaaaaaaa' };
  fs.mkdirSync(path.join(dir, 'wt')); fs.writeFileSync(path.join(dir, 'wt', 'vite.log'), `${'x'.repeat(30000)}\nready in 312 ms`);
  fs.writeFileSync(path.join(dir, 'secret.log'), 'nope');
  fs.symlinkSync(path.join(dir, 'secret.log'), path.join(dir, 'wt', 'link.log'));
  const sub = { id: 'api', worktree: { path: path.join(dir, 'wt') }, running: { items: [
    { name: 'vite', pid: 5, log: path.join(dir, 'wt', 'vite.log') },
    { name: 'outside', pid: 6, log: path.join(dir, 'secret.log') },
    { name: 'link', pid: 7, log: path.join(dir, 'wt', 'link.log') },
    { name: 'none', pid: 8 },
  ] } };
  const got = readLog(job, sub, 'vite');
  assert.match(got.text, /ready in 312 ms$/);
  assert.equal(got.truncated, true);
  assert.ok(got.text.length <= 24 * 1024);
  assert.match(readLog(job, sub, 'outside').error, /outside the worktree/);
  assert.match(readLog(job, sub, 'link').error, /outside the worktree/, 'a symlink out is resolved first');
  assert.match(readLog(job, sub, 'none').error, /No log/);
  assert.ok(inboxDir(job.id, 'api').includes('evidence'));
});

test('the implementer is told to leave the preview running and the thread mail repeats it', () => {
  const job = { id: 'job_12345678', title: 'Audit', agent: 'claude', reviewCode: true, subJobs: [], runs: [], plan: { context: 'c' } };
  const sub = { id: 'api', title: 'A', repo: '/repo', brief: 'b', after: [], show: ['Lists sign-ins'], ready: { round: 1 } };
  const text = jobPrompt(job, sub, { id: 'r1', phase: 'implementation' });
  assert.match(text, /LEAVE RUNNING for the human to try, started detached/);
  assert.match(text, /running:\[\{name, url\?, pid\?, log\?\}\]/);
  assert.doesNotMatch(text, /stop\?|sandboxed/);
  assert.doesNotMatch(text, /Stop everything you started/);
  assert.match(threadMail(job, { id: 'r1' }, sub, [{ from: 'human', text: 'q', round: 1 }]), /anything the new receipt leaves out is stopped/);
  assert.doesNotMatch(threadMail(job, { id: 'r1' }, sub, [{ from: 'human', text: 'q', round: 1 }]), /restart/);
});

test('the Logs handler answers with the tail or the reason, and a missing sub-job', async (t) => {
  const f = fixture(t); await f.start();
  const sent = [];
  const host = { stores: { jobs: f.store }, broadcast: (p) => sent.push(p) };
  jobRunningLogsHandler.handler({ id: f.job.id, subJobId: 'api', name: 'vite' }, host);
  assert.equal(sent.at(-1).event, 'job-running-log');
  assert.match(sent.at(-1).error, /No log/);
  jobRunningLogsHandler.handler({ id: f.job.id, subJobId: 'ghost', name: 'vite' }, host);
  assert.equal(sent.at(-1).error, 'Sub-job not found');
});
