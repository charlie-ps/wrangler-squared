import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from './job-store.js';
import { JobRunner, IDLE_RECEIPT_GRACE_MS } from './job-runner.js';
import { limitOf, isOver, budgetOf, withSpendLimit, BudgetEnforcer, INTERRUPT_COOLDOWN_MS } from './job-budget.js';
import { withLiveUsd } from './job-spend.js';
import { JobSpendRefresh } from './job-spend-refresh.js';
import { settingsSchema } from './jobs-schema.js';
import { jobSettingsHandler, jobActionHandler } from './handlers.js';
import { _resetForTests, runnerFor, noteGraph } from './jobs.js';
import { fakeHost } from './test-helpers.js';

const input = { title: 'Reliable sign-in', intent: 'Customers can sign in reliably', repos: ['/repo'] };
const plan = { context: '', stories: [], subJobs: [{ id: 'api', title: 'Deliver api', repo: '/repo', after: [], brief: 'Implement api' }] };

test('the limit is X × (1 + top-ups), in cents, and none once cleared', () => {
  assert.equal(limitOf({ spendLimit: null }, { topUps: 3 }), null);
  assert.equal(limitOf({}, {}), 100, 'absent is the $100 default');
  assert.equal(limitOf({}, { topUps: 1 }), 200);
  assert.equal(limitOf({ spendLimit: 10 }, {}), 10);
  assert.equal(limitOf({ spendLimit: 10 }, { topUps: 2 }), 30);
  assert.equal(limitOf({ spendLimit: 0.1 }, { topUps: 2 }), 0.3, 'no float dust');
  assert.equal(isOver(10, 10), true, 'reaching it is over');
  assert.equal(isOver(9.99, 10), false);
  assert.equal(isOver(1e9, null), false);
});

test('settings default to $100, take dollars with cents, and empty is no limit', () => {
  assert.equal(settingsSchema.parse({}).spendLimit, 100);
  assert.equal(settingsSchema.parse({ spendLimit: null }).spendLimit, null);
  assert.equal(settingsSchema.parse({ spendLimit: '' }).spendLimit, null);
  assert.equal(settingsSchema.parse({ spendLimit: 12.345 }).spendLimit, 12.35);
  assert.throws(() => settingsSchema.parse({ spendLimit: 0 }));
  assert.throws(() => settingsSchema.parse({ spendLimit: -5 }));
});

test('a job\'s spend counts every card its runs bound; a finished or cancelled one is not governed', () => {
  const job = { stage: 'active', runs: [{ sessionId: 'plan' }], subJobs: [{ sessions: ['a', 'b'] }] };
  const byCard = new Map([['plan', { usd: 1 }], ['a', { usd: 2.5 }], ['b', { usd: 0.004 }], ['other', { usd: 100 }]]);
  assert.deepEqual(budgetOf({ spendLimit: 3.5 }, job, byCard), { limit: 3.5, usd: 3.5, over: true });
  assert.deepEqual(budgetOf({ spendLimit: 3.5 }, { ...job, topUps: 1 }, byCard), { limit: 7, usd: 3.5, over: false });
  assert.equal(budgetOf({ spendLimit: 1 }, { ...job, stage: 'done' }, byCard), null);
  assert.equal(budgetOf({ spendLimit: 1 }, { ...job, cancelledAt: 1 }, byCard), null);
  assert.deepEqual(withSpendLimit({ settings: { spendLimit: 5 }, jobs: [{ topUps: 1 }, {}] }).jobs.map((j) => j.spendLimit), [10, 5]);
});

test('a live card\'s price beats a stale scan, and is kept after the card leaves the graph', async () => {
  const merged = withLiveUsd(new Map([['a', { usd: 1, estimated: true }], ['b', { usd: 5, estimated: false }]]), new Map([['a', 3], ['b', 4], ['c', 2]]));
  assert.deepEqual(Object.fromEntries(merged), { a: { usd: 3, estimated: true }, b: { usd: 5, estimated: false }, c: { usd: 2, estimated: false } });
  const { host, usage } = fakeHost();
  usage.push({ cardId: 'a', usd: 1, estimatedUsd: 0 });
  const spend = new JobSpendRefresh({ host });
  const jobs = [{ runs: [{ sessionId: 'a' }] }];
  spend.byCard(jobs); await spend.settled();
  spend.noteLive([{ sessionId: 'a', usd: 4 }]);
  spend.noteLive([]);
  assert.equal(spend.current(jobs).get('a').usd, 4);
});

test('the enforcer interrupts working cards only, once per card per cooldown', async () => {
  const { host, interrupted, sessions } = fakeHost();
  for (const id of ['w', 'idle']) sessions.set(id, { sessionId: id });
  const clock = { t: 0 };
  const enforcer = new BudgetEnforcer({ host, workingOf: (id) => id === 'w', now: () => clock.t });
  assert.deepEqual(await enforcer.interrupt(['w', 'idle']), ['w']);
  clock.t += INTERRUPT_COOLDOWN_MS - 1;
  assert.deepEqual(await enforcer.interrupt(['w']), []);
  clock.t += 1;
  assert.deepEqual(await enforcer.interrupt(['w']), ['w']);
  assert.deepEqual(interrupted, ['w', 'w']);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  store.settings({ maxReplans: 0 });
  const launched = [], mailed = [], interrupted = [], alive = new Set(), usd = new Map();
  let clock = Date.now(), working = new Set();
  const runtime = {
    async launch(j, s, r, prepared) { const sid = `session-${r.id}`; alive.add(sid); launched.push({ sub: s, run: r, sid }); prepared(sid, { path: `/wt/${r.id}`, repoRoot: '/repo', branch: `b-${r.id}` }); },
    async stop(r) { alive.delete(r.sessionId); },
    async isAlive(r) { return alive.has(r.sessionId); },
    async exists(r) { return alive.has(r.sessionId); },
    async resumeWithMail(r, text) { mailed.push({ sid: r.sessionId, text }); },
    async cleanup() {}, async cleanupPlanning() {}, releaseImages() {}, attributeSpend() {},
  };
  const enforcer = new BudgetEnforcer({ host: { sessions: { interrupt: async (id) => { interrupted.push(id); return true; } }, log() {} }, workingOf: (id) => working.has(id), now: () => clock });
  const budget = { spend: () => new Map([...usd].map(([id, v]) => [id, { usd: v, estimated: false }])), interrupt: (cards) => enforcer.interrupt(cards) };
  const github = { async pr() { return { state: 'OPEN', checkStatus: 'pending', head: 'h' }; }, async comments() { return { items: [] }; }, async deploys() { return { expected: true }; } };
  const runner = new JobRunner({ store, runtime, github, budget, now: () => clock, statusOf: (sid) => (working.has(sid) ? 'working' : 'idle') });
  const job = store.create(input);
  const tick = async (ms = 5000) => { clock += ms; await runner.tick(); };
  const get = () => store.get(job.id);
  return { store, runner, job, launched, mailed, interrupted, alive, usd, tick, get,
    setWorking: (...ids) => { working = new Set(ids); },
    async active(p = plan) {
      store.action(job.id, 'start'); await tick();
      store.report(launched.at(-1).sid, launched.at(-1).run.id, { kind: 'plan', plan: p }); await tick();
      store.approvePlan(job.id, get().revision); await tick();
    } };
}

test('a job that reaches its limit is paused for budget, its working session interrupted, and nothing new starts', async (t) => {
  const f = fixture(t);
  await f.active();
  const impl = f.launched.at(-1);
  assert.equal(impl.run.phase, 'implementation');
  f.setWorking(impl.sid);
  f.store.settings({ spendLimit: 5 });
  f.usd.set(impl.sid, 5.2);
  await f.tick();
  assert.equal(f.get().budgetPaused.limit, 5);
  assert.equal(f.get().budgetPaused.usd, 5.2);
  assert.deepEqual(f.interrupted, [impl.sid]);
  assert.ok(f.get().runs.find((r) => r.id === impl.run.id).budgetHaltedAt);
  assert.equal(f.runner.allowed(f.job.id), false);
  assert.equal(f.store.claim(f.job.id, null, 'planning'), null, 'no new run can be claimed');

  // Still over and still working: interrupted again, but not within the cooldown.
  await f.tick(1000);
  assert.equal(f.interrupted.length, 1);
  await f.tick(INTERRUPT_COOLDOWN_MS);
  assert.equal(f.interrupted.length, 2);

  // Idle at the limit is by design: never reaped as a receipt-less session.
  f.setWorking();
  await f.tick(IDLE_RECEIPT_GRACE_MS + 60000);
  await f.tick(IDLE_RECEIPT_GRACE_MS + 60000);
  assert.equal(f.get().runs.find((r) => r.id === impl.run.id).stopped, false);
  assert.equal(f.interrupted.length, 2, 'an idle card gets no Escape');
  assert.equal(f.mailed.length, 0, 'nothing is mailed while paused for budget');
});

test('Resume does not lift a budget pause; Add $X raises the limit by X, releases the job and mails the halted session', async (t) => {
  const f = fixture(t);
  await f.active();
  const impl = f.launched.at(-1);
  f.setWorking(impl.sid);
  f.store.settings({ spendLimit: 5 });
  f.usd.set(impl.sid, 6);
  await f.tick();
  f.store.action(f.job.id, 'resume');
  await f.tick(INTERRUPT_COOLDOWN_MS);
  assert.ok(f.get().budgetPaused, 'Resume is the human\'s own pause only');

  assert.throws(() => f.store.action(f.job.id, 'top-up', { topUps: 1 }), /already raised/);
  f.store.action(f.job.id, 'top-up', { topUps: 0 });
  assert.throws(() => f.store.action(f.job.id, 'top-up', { topUps: 0 }), /already raised/, 'a double click adds once');
  f.store.action(f.job.id, 'top-up', { topUps: 1 });
  assert.equal(f.get().topUps, 2);
  assert.match(f.get().moves.at(-1).detail, /Added \$5\.00: the spend limit is now \$15\.00/);
  f.setWorking();
  await f.tick();
  assert.equal(f.get().budgetPaused, null);
  assert.equal(f.runner.allowed(f.job.id), true);
  assert.equal(f.mailed.length, 1);
  assert.equal(f.mailed[0].sid, impl.sid);
  assert.match(f.mailed[0].text, /limit is now \$15\.00: carry on/);
  assert.equal(f.get().runs.find((r) => r.id === impl.run.id).budgetHaltedAt, null);
  await f.tick();
  assert.equal(f.mailed.length, 1, 'mailed once');
});

test('a new X in Settings re-evaluates every job in flight: lower pauses one already over, raise or clear releases it', async (t) => {
  const f = fixture(t);
  await f.active();
  const impl = f.launched.at(-1);
  f.usd.set(impl.sid, 8);
  f.store.settings({ spendLimit: 20 });
  f.store.action(f.job.id, 'top-up', { topUps: 0 });
  await f.tick();
  assert.equal(f.get().budgetPaused ?? null, null, '8 of 40');

  f.store.settings({ spendLimit: 3 });
  await f.tick();
  assert.equal(f.get().budgetPaused.limit, 6, 'the top-up still counts: 3 × 2');

  f.store.settings({ spendLimit: 4.5 });
  await f.tick();
  assert.equal(f.get().budgetPaused, null, '8 of 9');

  f.store.settings({ spendLimit: 2 });
  await f.tick();
  assert.ok(f.get().budgetPaused);
  f.store.settings({ spendLimit: null });
  await f.tick();
  assert.equal(f.get().budgetPaused, null, 'no limit, nothing held');
  assert.deepEqual(f.get().moves.filter((m) => m.move.startsWith('budget')).map((m) => m.move), ['budget-pause', 'budget-release', 'budget-pause', 'budget-release']);
});

test('a budget-paused job starts no helper, and cancelling it clears the budget pause', async (t) => {
  const f = fixture(t);
  await f.active({ ...plan, subJobs: [...plan.subJobs, { id: 'sign', kind: 'human', title: 'Sign the form', after: [], brief: 'Sign it' }] });
  f.usd.set(f.launched.at(-1).sid, 9);
  f.store.settings({ spendLimit: 1 });
  await f.tick();
  let spawned = 0;
  f.runner.runtime.spawnHelper = async () => { spawned++; return 'helper'; };
  f.store.action(f.job.id, 'ask-helper', { subJobId: 'sign' });
  await f.tick();
  assert.equal(spawned, 0);
  assert.throws(() => f.store.action(f.job.id, 'top-up', { topUps: 5 }));
  f.store.action(f.job.id, 'cancel-job');
  assert.equal(f.get().budgetPaused, null);
});

test('top-up is refused with no limit set', (t) => {
  const f = fixture(t);
  f.store.settings({ spendLimit: null });
  assert.throws(() => f.store.action(f.job.id, 'top-up', { topUps: 0 }), /No job spend limit/);
});

test('through the manifest wiring: a settings change kicks a tick that pauses an over-limit job and interrupts its live card', async () => {
  _resetForTests();
  const { host, usage, interrupted } = fakeHost();
  const store = host.stores.jobs;
  const job = store.create(input);
  const { sessionId } = await host.sessions.spawn({ cwd: '/repo' });
  store.update(job.id, (j) => { j.stage = 'planning'; j.runs.push({ id: 'run_1', subJobId: null, phase: 'planning', sessionId, stopped: false, report: null, startedAt: Date.now() }); });
  usage.push({ cardId: sessionId, usd: 2, estimatedUsd: 0 });
  noteGraph({ sessions: [{ sessionId, status: 'working', usd: 2 }] });
  const runner = runnerFor(host);
  runner.runtime.isAlive = async () => true;
  (await import('./jobs.js')).spendFor(host).noteLive([{ sessionId, usd: 2 }]);
  await jobSettingsHandler.handler({ patch: { spendLimit: 1.5 } }, host);
  while (runner.busy) await new Promise((r) => setTimeout(r, 5));
  await runner.tick();
  assert.equal(store.get(job.id).budgetPaused.limit, 1.5);
  assert.deepEqual(interrupted, [sessionId]);
  await jobActionHandler.handler({ id: job.id, action: 'top-up', topUps: 0 }, host);
  while (runner.busy) await new Promise((r) => setTimeout(r, 5));
  await runner.tick();
  assert.equal(store.get(job.id).budgetPaused, null);
  assert.equal(store.get(job.id).topUps, 1);
  _resetForTests();
});
