import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore, migrateJobs, MERGE_IS_DELIVERY } from './job-store.js';
import { JobRunner, IDLE_RECEIPT_GRACE_MS } from './job-runner.js';
import { JobRuntime, CleanupRefused } from './job-runtime.js';
import { jobPrompt } from './job-prompts.js';
import { JobGithub, prSummary } from './job-github.js';
import { normaliseComments, commentsBlockMerge } from './job-comments.js';
import { jobCreateHandler, makeJobCreateHandler, jobActionHandler, jobSettingsHandler } from './handlers.js';
import { _resetForTests, runnerFor } from './jobs.js';
import { jobReportTool, getJobContextTool } from './tools.js';

const input = { title: 'Reliable sign-in', intent: 'Customers can sign in reliably', repos: ['/repo'], reviewMerge: true };
const spec = (id, after = [], extra = {}) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', after, brief: `Implement ${id}`, ...extra });
const sessionSpec = (id, after = []) => ({ id, kind: 'session', title: `Run ${id}`, storyId: 'story', after, brief: `Do ${id} on this machine` });
const humanSpec = (id, after = []) => ({ id, kind: 'human', title: `Do ${id} yourself`, storyId: 'story', after, brief: `Click ${id} in the vendor console` });
const plan = (subs = [spec('api')], stories = [{ id: 'story', key: 'AUTH-123', title: 'Reliable sign-in' }]) =>
  ({ context: 'The sign-in service is Java; deploys are Helm.', stories, subJobs: subs });
const PR_URL = 'https://github.com/org/repo/pull/1';
function fixture(t, jobInput = input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  const launched = [], stopped = [], merged = [], cleaned = [], mailed = [], alive = new Set();
  let clock = Date.now();
  const runtime = {
    async launch(j, s, r, prepared) {
      const sid = `session-${r.id}`; alive.add(sid); launched.push({ job: j, sub: s, run: r, sid });
      prepared(sid, s?.worktree ? undefined : { path: `/worktree/${s?.id || r.id}`, repoRoot: '/repo', branch: `branch-${s?.id || r.id}` });
    },
    async stop(r) { stopped.push(r.id); alive.delete(r.sessionId); },
    async isAlive(r) { return alive.has(r.sessionId); },
    async exists(r) { return alive.has(r.sessionId); },
    async resumeWithMail(r, text) { mailed.push({ sid: r.sessionId, text }); },
    async cleanup(j, s) { cleaned.push(s.id); }, async cleanupPlanning() {}, releaseImages() {},
    attributeSpend(s, live) { attributed.push(live); },
  };
  let pr = { state: 'OPEN', checkStatus: 'pending', head: 'head1', mergeCommit: null, checks: [], base: 'main' };
  let deployment = { status: 'pending', runs: [], commit: 'merge1' };
  let deploys = { expected: true, workflows: [{ name: 'Deploy', file: 'deploy.yml', triggers: true, reason: 'runs on push' }], summary: 'Deploys on merge · Deploy' };
  let comments = normaliseComments(resource(), 0);
  let status = () => null;
  const attributed = [], triaged = [], deployCalls = [];
  let verdict = async () => ({ tone: 'green', text: 'Reviewer approved.', liveSessionId: 'live-triage', error: false });
  const github = {
    async pr(s) { return { ...pr, url: s.pr.url }; }, async comments() { return comments; },
    async merge(s) { merged.push(s.pr.head); }, async deployment() { return deployment; },
    async deploys(s, observed) { deployCalls.push(observed.head); return { head: observed.head, base: observed.base, ...deploys }; },
  };
  const runner = new JobRunner({ store, runtime, github, now: () => clock, statusOf: (sid) => status(sid),
    summarise: async (c, p) => { triaged.push(c.fingerprint); return verdict(c, p); } });
  const job = store.create(jobInput);
  const tick = async () => { clock += 61000; await runner.tick(); };
  const last = () => launched.at(-1);
  const workerFor = (subId, phase) => launched.findLast((w) => w.sub?.id === subId && (!phase || w.run.phase === phase));
  const report = (payload, worker = last()) => store.report(worker.sid, worker.run.id, payload);
  const sub = (index = 0) => store.get(job.id).subJobs[index];
  async function approve(p = plan()) {
    store.action(job.id, 'start'); await tick(); report({ kind: 'plan', plan: p }); await tick();
    const current = store.get(job.id); store.approvePlan(job.id, current.revision); await tick();
  }
  return { store, job, runner, runtime, github, alive, launched, stopped, merged, cleaned, mailed, tick, last, workerFor, report, approve, sub,
    attributed, triaged, deployCalls, clockNow: () => clock,
    setPr: (value) => { pr = { ...pr, ...value }; }, setDeployment: (value) => { deployment = value; },
    setDeploys: (value) => { deploys = { ...deploys, ...value }; }, setStatus: (fn) => { status = fn; },
    setComments: (value) => { comments = normaliseComments(value, 0); }, setVerdict: (fn) => { verdict = fn; } };
}
const author = (login, bot = false) => ({ login, __typename: bot ? 'Bot' : 'User' });
const node = (id, login, body, at, extra = {}) => ({ id, author: author(login, extra.bot), body, createdAt: at, updatedAt: at, url: `${PR_URL}#${id}`, ...extra });
// A GraphQL `resource` payload in the shape COMMENTS_QUERY returns.
function resource({ comments = [], reviews = [], threads = [] } = {}) {
  return { author: { login: 'agent' }, comments: { nodes: comments }, reviews: { nodes: reviews },
    reviewThreads: { nodes: threads.map((t) => ({ id: t.id, isResolved: !!t.resolved, isOutdated: false, path: t.path || 'src/app.js', line: 4, comments: { nodes: t.comments } })) } };
}
// A sub-job at the PR stage, one session having done the whole implementation.
async function atPr(f, p = plan()) {
  f.store.update(f.job.id, (j) => { j.reviewMerge = false; });
  await f.approve(p);
  f.report({ kind: 'published', url: PR_URL });
}

test('store persists settings, plans and live claims across restart', async (t) => {
  const f = fixture(t); await f.approve();
  f.store.settings({ concurrency: 4 });
  assert.equal(f.store.snapshot().version, 5);
  assert.deepEqual(new JobStore(f.store.file).snapshot(), f.store.snapshot());
  assert.equal(f.store.get(f.job.id).runs.filter((r) => !r.stopped).length, 1);
});

test('usualPick persists across restart, merges like any setting, and is validated like the job fields', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.snapshot().settings.usualPick, null, 'unset until a job is created');
  f.store.settings({ usualPick: { agent: 'codex', model: 'gpt-6-sol', effort: 'high' } });
  f.store.settings({ concurrency: 3 });
  assert.deepEqual(new JobStore(f.store.file).snapshot().settings.usualPick, { agent: 'codex', model: 'gpt-6-sol', effort: 'high' });
  f.store.settings({ usualPick: { agent: 'claude', model: 'opus' } });
  assert.deepEqual(f.store.snapshot().settings.usualPick, { agent: 'claude', model: 'opus', effort: '' }, 'effort defaults to the agent default');
  assert.throws(() => f.store.settings({ usualPick: { agent: 'nope', model: 'x', effort: '' } }));
  assert.throws(() => f.store.settings({ usualPick: { agent: 'claude', model: 'm'.repeat(151), effort: '' } }));
  assert.throws(() => f.store.settings({ usualPick: { agent: 'claude', model: 'opus', effort: 'e'.repeat(41) } }));
  assert.equal(f.store.snapshot().settings.usualPick.model, 'opus', 'a rejected patch changes nothing');
});

// --- Migration (version 1 -> 2) ---

const legacy = {
  version: 1,
  settings: { concurrency: 2, maxRepairs: 2, maxRunMinutes: 120, deploymentStaleMinutes: 30, paused: false },
  jobs: [{
    id: 'job_old', title: 'Old', intent: 'Old goal', stage: 'active', revision: 7, reviewCode: true, amendmentAuthority: 'auto',
    amendments: [{ id: 'amd_1', status: 'accepted' }], recoveryOf: { jobId: 'job_older', subJobId: 'api' },
    plan: { stories: [{ id: 'story', key: 'AUTH-1', title: 'Sign-in', value: 'Customers can sign in' }],
      subJobs: [{ id: 'api', title: 'Deliver api', repo: '/repo', storyId: 'story', dependsOn: [], instructions: 'x'.repeat(900), deployment: { verify: 'hit /health' } },
        { id: 'web', title: 'Deliver web', repo: '/repo', storyId: 'story', dependsOn: ['api'], instructions: 'Implement web' }] },
    subJobs: [{ id: 'api', title: 'Deliver api', repo: '/repo', storyId: 'story', dependsOn: [], instructions: 'x'.repeat(900),
      deployment: { verify: 'hit /health' }, stage: 'implementation', state: 'verified', jiraKey: 'AUTH-1',
      local: { commitMessage: 'AUTH-1: x', checks: ['Tests pass'] }, dependenciesVerified: true, codeApprovedAt: 5, recoveryJobId: 'job_r', recoveryReason: 'boom' }],
    runs: [{ id: 'run_1', subJobId: 'api', phase: 'publish', stopped: false, sessionId: 'sid', report: null }],
  }],
};

test('a version-1 file loads as version 5: after/brief replace dependsOn/instructions and every removed field is gone', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-v1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = new JobStore(file);
  const job = store.get('job_old');
  assert.equal(store.snapshot().version, 5);
  assert.equal(store.snapshot().settings.maxRunMinutes, undefined);
  for (const key of ['amendmentAuthority', 'amendments', 'recoveryOf']) assert.equal(job[key], undefined, key);
  assert.equal(job.reviewCode, true, 'the version-1 flag meant the same thing and is kept');
  assert.equal(job.plan.context, '', 'a legacy plan has no context; the schema only requires one of a new plan');
  assert.equal(job.plan.stories[0].value, undefined);
  const [api, web] = job.plan.subJobs;
  assert.deepEqual(web.after, ['api']); assert.equal(web.dependsOn, undefined);
  assert.equal(api.brief.length, 900, 'legacy text over the new cap is kept, never truncated');
  for (const key of ['instructions', 'deployment', 'check']) assert.equal(api[key], undefined, key);
  const liveApi = job.subJobs[0];
  assert.equal(liveApi.state, 'queued', 'it had a local receipt and was waiting to publish: one session now does both');
  for (const key of ['local', 'dependenciesVerified', 'codeApprovedAt', 'recoveryJobId', 'recoveryReason']) assert.equal(liveApi[key], undefined, key);
  // The file itself is untouched until the next ordinary write.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  store.action('job_old', 'pause');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 5);
  assert.throws(() => migrateJobs({ version: 6, jobs: [] }), /refusing to discard jobs/);
  assert.throws(() => migrateJobs({ version: 1, jobs: {} }), /refusing to discard jobs/);
  assert.deepEqual(migrateJobs(structuredClone(migrateJobs(legacy))), migrateJobs(legacy), 'migration is idempotent');
});

test('a legacy publish run can still land its receipt on the migrated job', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-v1b-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = new JobStore(file);
  store.report('sid', 'run_1', { kind: 'published', url: PR_URL });
  assert.equal(store.get('job_old').subJobs[0].stage, 'pr');
});

// --- Plan schema ---

test('a new plan needs context, briefs stay short, and checks belong to PRs only', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const before = f.store.snapshot();
  const { context, ...contextless } = plan();
  assert.throws(() => f.report({ kind: 'plan', plan: contextless }), /context/i);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([spec('a', [], { brief: 'x'.repeat(501) })]) }));
  assert.throws(() => f.report({ kind: 'plan', plan: plan([sessionSpec('a')].map((s) => ({ ...s, check: 'curl it' }))) }), /own check/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([spec('a', ['b']), spec('b', ['a'])]) }), /cycles/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([spec('a', ['ghost'])]) }), /Unknown dependency/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('a'), storyId: 'ghost' }]) }), /Unknown story/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...sessionSpec('a'), repo: '/repo' }]) }), /session sub-job has no repo/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('a'), repo: undefined }]) }), /PR sub-job needs repo/);
  for (const repo of ['service', 'https://github.com/org/repo', '/repo\n/other']) {
    assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('a'), repo }]) }), /local repository path/);
  }
  assert.deepEqual(f.store.snapshot(), before, 'a rejected plan persists nothing');
  f.report({ kind: 'plan', plan: plan([spec('api', [], { check: 'Sign-in works in dev' }), sessionSpec('spike')],
    [{ id: 'story', key: 'AUTH-123', title: 'Reliable sign-in', value: 'dropped' }]) });
  const stored = f.store.get(f.job.id).plan;
  assert.equal(stored.stories[0].value, undefined, 'a story is a title, not a value statement');
  assert.equal(stored.subJobs[0].check, 'Sign-in works in dev');
  assert.equal(stored.context, plan().context);
});

test('plan approval is explicit and rejects a stale or running review', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan() });
  assert.throws(() => f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision), /not ready/);
  await f.tick();
  const rev = f.store.get(f.job.id).revision;
  f.store.action(f.job.id, 'pause');
  assert.throws(() => f.store.approvePlan(f.job.id, rev), /changed/);
});

test('jobs without repository hints discover and persist repositories before human approval', async (t) => {
  const { repos, ...withoutRepos } = input;
  const f = fixture(t, withoutRepos);
  assert.deepEqual(f.job.repos, []);
  f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), { ...spec('web'), repo: '/web' }, spec('api-followup', ['api'])]) }); await f.tick();
  const current = new JobStore(f.store.file).get(f.job.id);
  assert.deepEqual(current.repos, ['/repo', '/web']);
  assert.equal(current.stage, 'planning'); assert.deepEqual(current.subJobs, []);
  assert.equal(f.launched.length, 1, 'discovery must wait for plan approval');
  f.store.approvePlan(f.job.id, current.revision); await f.tick();
  assert.deepEqual(f.launched.slice(1).map((w) => w.sub.repo), ['/repo', '/web']);
});

test('a replan keeps the previous plan and an edited plan replaces the proposed repositories', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan([{ ...spec('api'), repo: '/discovered' }]) }); await f.tick();
  const first = f.store.get(f.job.id);
  f.store.action(f.job.id, 'replan', { feedback: 'Move this change to the shared service' }); await f.tick();
  assert.deepEqual(f.last().job.previousPlan, first.plan);
  f.report({ kind: 'plan', plan: plan([{ ...spec('api'), repo: '/shared' }]) }); await f.tick();
  assert.throws(() => f.store.approvePlan(f.job.id, first.revision), /changed/);
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision, plan([{ ...spec('api'), repo: '/reviewed' }]));
  assert.deepEqual(f.store.get(f.job.id).repos, ['/reviewed']);
  assert.equal(f.sub().repo, '/reviewed');
});

test('reports require the assigned caller and the phase they were launched for', async (t) => {
  const f = fixture(t); await f.approve();
  const w = f.last();
  assert.equal(w.run.phase, 'implementation');
  assert.throws(() => f.store.report('someone-else', w.run.id, { kind: 'published', url: PR_URL }), /assigned/);
  assert.throws(() => f.report({ kind: 'deployed', checks: ['Works'] }), /must submit ready or published/);
  assert.throws(() => f.report({ kind: 'published', url: 'https://example.com/pull/1' }));
  assert.throws(() => f.report({ kind: 'blocked', summary: 'x', amendment: { reason: 'r', ops: [] } }), /amendment/, 'the plan is the human\'s: no receipt may carry a change to it');
  assert.throws(() => f.report({ kind: 'blocked', summary: 'x', move: 'invent-a-move' }));
  f.report({ kind: 'published', url: PR_URL });
  f.report({ kind: 'published', url: PR_URL }, w);
  assert.throws(() => f.report({ kind: 'published', url: 'https://github.com/org/repo/pull/2' }, w), /different report/);
});

// --- Code review, then one PR ---

test('with code review on the implementation leaves the tree uncommitted and reports ready; approval of that receipt launches the publish session', async (t) => {
  const f = fixture(t); await f.approve();
  assert.equal(f.last().run.phase, 'implementation');
  f.report({ kind: 'ready', checks: ['Tests pass', 'Lint clean'] }); await f.tick();
  const sub = f.sub();
  assert.equal(sub.stage, 'review'); assert.equal(sub.state, 'verified');
  assert.deepEqual([sub.ready.checks, sub.ready.receiptId], [['Tests pass', 'Lint clean'], f.last().run.id]);
  assert.equal(f.launched.length, 2, 'nothing runs while the human reads the diff');
  assert.deepEqual(f.stopped, [f.launched[0].run.id, f.last().run.id], 'the implementation session is released like any finished step');
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: 'run_stale' }), /not ready to approve/);
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: sub.ready.receiptId });
  assert.equal(f.sub().state, 'approved'); assert.ok(f.sub().ready.approvedAt);
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: sub.ready.receiptId }), /not ready/, 'approval is once');
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api', 'publish']);
  assert.equal(f.last().sub.worktree.path, '/worktree/api', 'the publish session adopts the reviewed worktree');
  assert.throws(() => f.report({ kind: 'ready', checks: ['x'] }), /must submit published/);
  f.report({ kind: 'published', url: PR_URL }); await f.tick();
  assert.equal(f.sub().stage, 'pr'); assert.equal(f.sub().state, 'watching');
});

test('Retry after a blocked publish keeps the approval: the tree the human approved is unchanged, so publish runs again', async (t) => {
  const f = fixture(t); await f.approve();
  // Runs and moves are stamped by the wall clock; a millisecond apart is enough
  // for the history to read in the order it happened.
  const later = () => new Promise((r) => setTimeout(r, 2));
  f.report({ kind: 'ready', checks: ['Tests pass'] }); await f.tick(); await later();
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: f.sub().ready.receiptId }); await later(); await f.tick();
  assert.equal(f.last().run.phase, 'publish');
  f.report({ kind: 'blocked', summary: 'git add of config/example.env was denied', move: 'fix-here' }); await f.tick(); await later();
  assert.deepEqual([f.sub().stage, f.sub().error, f.sub().blocked.phase], ['review', 'git add of config/example.env was denied', 'publish']);
  f.store.action(f.job.id, 'retry', { subJobId: 'api', note: 'example.env is a template, stage it' });
  assert.deepEqual([f.sub().stage, f.sub().state, f.sub().error, f.sub().note], ['review', 'approved', null, 'example.env is a template, stage it']);
  assert.ok(f.sub().ready.approvedAt, 'the approval survives the retry');
  await f.tick();
  assert.deepEqual([f.last().run.phase, f.last().sub.worktree.path], ['publish', '/worktree/api']);
  // The relaunched session is told the whole story, from the store's own records.
  const text = jobPrompt(f.store.get(f.job.id), f.last().sub, f.last().run);
  assert.match(text, /History of this sub-job, oldest first:\n- \d\d:\d\d implementation → ready: Tests pass\n- \d\d:\d\d human approved the working tree\n- \d\d:\d\d publish → blocked: git add of config\/example.env was denied\n- \d\d:\d\d human retried: "example.env is a template, stage it"\nThe worktree already holds the work above\./);
  assert.deepEqual(f.store.get(f.job.id).moves.map((m) => [m.move, m.note]), [['approve-code', null], ['retry', 'example.env is a template, stage it']]);
  f.report({ kind: 'published', url: PR_URL }); await f.tick();
  assert.equal(f.sub().stage, 'pr');
});

test('Request changes under code review is Fix here: back to work in the same worktree with the note, receipt withdrawn', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'ready', checks: ['Tests pass'] }); await f.tick();
  f.store.action(f.job.id, 'fix-here', { subJobId: 'api', note: 'Use the existing retry helper' });
  const sub = f.sub();
  assert.deepEqual([sub.stage, sub.state, sub.ready, sub.note], ['implementation', 'queued', null, 'Use the existing retry helper']);
  assert.match(f.store.get(f.job.id).moves.at(-1).detail, /back to work/);
  await f.tick();
  assert.deepEqual([f.last().run.phase, f.last().sub.note, f.last().sub.worktree.path], ['implementation', 'Use the existing retry helper', '/worktree/api']);
  f.report({ kind: 'ready', checks: ['Helper reused'] }); await f.tick();
  assert.equal(f.sub().stage, 'review'); assert.equal(f.sub().note, null);
  // Approved but not yet launched: Request changes still withdraws it.
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: f.sub().ready.receiptId });
  f.store.action(f.job.id, 'fix-here', { subJobId: 'api' });
  assert.equal(f.sub().stage, 'implementation');
  await f.tick(); f.report({ kind: 'ready', checks: ['Again'] }); await f.tick();
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: f.sub().ready.receiptId }); await f.tick();
  assert.equal(f.last().run.phase, 'publish');
  assert.throws(() => f.store.action(f.job.id, 'fix-here', { subJobId: 'api' }), /Wait for the session to stop/, 'not under the live publish session');
});

test('an implementation session that published anyway lands its PR whatever the review flag says, and with review off one session does it all', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'published', url: PR_URL }); await f.tick();
  assert.equal(f.sub().stage, 'pr');
  const g = fixture(t, { ...input, reviewCode: false });
  await g.approve();
  g.report({ kind: 'ready', checks: ['x'] }); await g.tick();
  assert.equal(g.sub().stage, 'review', 'a stray ready receipt still parks the card for a read rather than being lost');
});

test('one session works, commits, pushes and opens the PR: no publish phase, and a PR dependency gates the launch until it deploys', async (t) => {
  const f = fixture(t); f.store.update(f.job.id, (j) => { j.reviewMerge = false; });
  await f.approve(plan([spec('api'), spec('web', ['api'])]));
  assert.deepEqual(f.launched.slice(1).map((w) => [w.sub.id, w.run.phase]), [['api', 'implementation']],
    'web is cut from the default branch, so it waits for api to be in it');
  f.report({ kind: 'published', url: 'https://github.com/org/repo/pull/2' }, f.workerFor('api'));
  assert.ok(f.sub(0).nextPollAt > Date.now() + 9000, 'a fresh PR settles before the first observation');
  await f.tick();
  assert.equal(f.sub(0).stage, 'pr'); assert.equal(f.sub(0).state, 'watching');
  assert.equal(f.launched.filter((w) => w.run.phase === 'publish').length, 0);
  f.store.update(f.job.id, (j) => { j.subJobs[0].mergedAt = Date.now(); });
  await f.tick(); assert.equal(f.launched.filter((w) => w.sub?.id === 'web').length, 0, 'merged is not enough: api has not deployed');
  f.store.update(f.job.id, (j) => { j.subJobs[0].deployed = { checks: ['Live'] }; j.subJobs[0].stage = 'done'; });
  await f.tick(); assert.deepEqual(f.launched.slice(-1).map((w) => [w.sub.id, w.run.phase]), [['web', 'implementation']]);
});

test('a session sub-job is a hard prerequisite: nothing behind it starts until its receipt is approved', async (t) => {
  const f = fixture(t);
  await f.approve(plan([sessionSpec('spike'), spec('api', ['spike'])]));
  assert.deepEqual(f.launched.slice(1).map((w) => [w.sub.id, w.run.phase]), [['spike', 'session']]);
  assert.throws(() => f.report({ kind: 'published', url: PR_URL }), /must submit completed/);
  f.report({ kind: 'completed', checks: ['Schema documented in task memory'] }); await f.tick();
  assert.equal(f.sub().stage, 'review');
  assert.equal(f.launched.length, 2, 'nothing starts while the session result awaits review');
  f.store.action(f.job.id, 'approve-session', { subJobId: 'spike', sessionReceiptId: f.sub().result.receiptId });
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api', 'implementation']);
});

// --- Review checkpoints switched mid-job ---

const setReview = (f, field, you, extra = {}) => f.store.action(f.job.id, 'set-review', { field, you, ...extra });

test('a code review switch counts from the next gate: waiting diffs stay until released, and a ready receipt under Auto is approved as it lands', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  f.report({ kind: 'ready', checks: ['Tests pass'] }, f.workerFor('api'));
  setReview(f, 'reviewCode', false);
  let job = f.store.get(f.job.id);
  assert.equal(job.reviewCode, false);
  assert.deepEqual([job.subJobs[0].stage, job.subJobs[0].state], ['review', 'verified'], 'a diff already waiting is not let through unasked');
  assert.deepEqual(job.moves.map((m) => [m.move, m.subJobId, m.detail]), [['set-review', null, 'Switched Code to Auto']]);
  f.report({ kind: 'ready', checks: ['Tests pass'] }, f.workerFor('web'));
  assert.equal(f.sub(1).state, 'approved', 'the run kept its uncommitted prompt; its receipt is approved as it lands');
  assert.ok(f.sub(1).ready.approvedAt);
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['web', 'publish']);
  setReview(f, 'reviewCode', false, { release: true });
  assert.deepEqual([f.sub().state, !!f.sub().ready.approvedAt], ['approved', true]);
  assert.deepEqual(f.store.get(f.job.id).moves.slice(-2).map((m) => [m.move, m.subJobId]), [['approve-code', 'api'], ['set-review', null]]);
  const revision = f.store.get(f.job.id).revision;
  setReview(f, 'reviewCode', false);
  assert.equal(f.store.get(f.job.id).moves.length, 3, 'switching to what it already is records nothing');
  assert.ok(f.store.get(f.job.id).revision > revision);
  setReview(f, 'reviewCode', true);
  assert.equal(f.store.get(f.job.id).reviewCode, true);
});

test('a set-review switch is validated: an unknown checkpoint, a non-boolean, an approved plan and a cancelled job are refused', async (t) => {
  const f = fixture(t); await f.approve();
  assert.throws(() => setReview(f, 'reviewNope', false), /Unknown review checkpoint/);
  assert.throws(() => setReview(f, 'reviewCode', 'no'), /Unknown review checkpoint/);
  assert.throws(() => setReview(f, 'reviewPlan', false), /plan is already approved/);
  f.store.action(f.job.id, 'cancel-job');
  assert.throws(() => setReview(f, 'reviewMerge', false), /Job was cancelled/);
});

test('Plan switched to Auto: while planning the receipt approves itself, and a drafted plan is approved only on release, pinned to its revision', async (t) => {
  const f = fixture(t);
  f.store.action(f.job.id, 'start'); await f.tick();
  setReview(f, 'reviewPlan', false);
  f.report({ kind: 'plan', plan: plan() });
  assert.equal(f.store.get(f.job.id).stage, 'active', 'as a job created with Plan on Auto');

  const g = fixture(t);
  g.store.action(g.job.id, 'start'); await g.tick(); g.report({ kind: 'plan', plan: plan() }); await g.tick();
  setReview(g, 'reviewPlan', false);
  assert.equal(g.store.get(g.job.id).stage, 'planning', 'a drafted plan waits unless released');
  setReview(g, 'reviewPlan', true);
  const { revision } = g.store.get(g.job.id);
  assert.throws(() => setReview(g, 'reviewPlan', false, { release: true, revision: revision - 1 }), /plan changed/);
  const edited = plan([spec('api', [], { title: 'Deliver the API' })]);
  setReview(g, 'reviewPlan', false, { release: true, revision, plan: edited });
  const job = g.store.get(g.job.id);
  assert.deepEqual([job.stage, job.reviewPlan, job.subJobs.map((s) => s.title)], ['active', false, ['Deliver the API']]);
  assert.equal(job.moves.at(-1).detail, 'Switched Plan to Auto, releasing what was waiting');
});

test('Session results and Merge switched mid-job: a released receipt is accepted, and a green PR merges on the next poll once Merge is Auto', async (t) => {
  const f = fixture(t); await f.approve(plan([sessionSpec('spike'), spec('api', ['spike'])]));
  f.report({ kind: 'completed', checks: ['Schema documented'] });
  setReview(f, 'reviewSessions', false, { release: true });
  assert.deepEqual([f.sub().stage, !!f.sub().sessionApprovedAt], ['cleanup', true]);
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api', 'implementation']);

  const g = fixture(t); await g.approve();
  g.report({ kind: 'published', url: PR_URL }); g.setPr({ checkStatus: 'passing' });
  await g.tick(); await g.tick();
  assert.deepEqual(g.merged, [], 'Merge on You review waits for Approve merge');
  setReview(g, 'reviewMerge', false);
  await g.tick();
  assert.deepEqual(g.merged, ['head1']);
});

// --- Human tasks ---

test('a human sub-job has no repo and no check, and lands in its own stage no runner ever launches', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...humanSpec('sign'), repo: '/repo' }]) }), /human sub-job has no repo/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...humanSpec('sign'), check: 'the licence shows' }]) }), /nothing to check after it lands/);
  f.report({ kind: 'plan', plan: plan([humanSpec('sign')]) }); await f.tick();
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision); await f.tick();
  assert.deepEqual([f.sub().stage, f.sub().state], ['human', 'queued']);
  assert.deepEqual(f.store.get(f.job.id).repos, [], 'nothing in this plan touches a repository');
  await f.tick(); await f.tick();
  assert.deepEqual(f.launched.map((w) => w.run.phase), ['planning'], 'no agent is ever launched for a human task');
});

test('a human task is a hard prerequisite released by the human\'s own two marks', async (t) => {
  const f = fixture(t);
  await f.approve(plan([humanSpec('sign'), spec('api', ['sign'])]));
  assert.deepEqual(f.launched.map((w) => w.run.phase), ['planning'], 'nothing behind a human task starts');
  f.store.action(f.job.id, 'start-human', { subJobId: 'sign' });
  await f.tick();
  assert.deepEqual([f.sub().stage, f.sub().state], ['human', 'doing']);
  assert.equal(f.launched.length, 1, 'in progress is not done');
  assert.throws(() => f.store.action(f.job.id, 'start-human', { subJobId: 'sign' }), /waiting to be started/);
  f.store.action(f.job.id, 'finish-human', { subJobId: 'sign', note: 'Licence key issued by the vendor' });
  const marked = f.sub();
  assert.deepEqual([marked.stage, marked.state], ['cleanup', 'queued']);
  assert.deepEqual(marked.result, { checks: ['Licence key issued by the vendor'], at: marked.result.at, receiptId: null });
  await f.tick();
  assert.deepEqual([f.sub().stage, f.sub().state], ['done', 'done']);
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api', 'implementation'], 'done is what releases the work behind it');
  assert.throws(() => f.store.action(f.job.id, 'finish-human', { subJobId: 'sign' }), /no longer yours to mark/);
  assert.deepEqual(f.store.get(f.job.id).moves.map((m) => [m.subJobId, m.move, m.note]),
    [['sign', 'start-human', null], ['sign', 'finish-human', 'Licence key issued by the vendor']], 'both marks are on the same timeline as every other intervention');
});

test('finishing a human task stores multiline output without shortening it or exposing it as a move note', async (t) => {
  const f = fixture(t); await f.approve(plan([humanSpec('sign')]));
  const output = `ssh-ed25519 ${'A'.repeat(600)} user@example\nSecond line <literal>`;
  f.store.action(f.job.id, 'finish-human', { subJobId: 'sign', output: `  ${output}\n` });
  const saved = f.sub();
  assert.equal(saved.result.output, output);
  assert.equal(new JobStore(f.store.file).get(f.job.id).subJobs[0].result.output, output);
  assert.equal(f.store.get(f.job.id).moves.at(-1).note, null);
});

test('human output is optional but rejected above its dedicated limit', async (t) => {
  const f = fixture(t); await f.approve(plan([humanSpec('sign')]));
  assert.throws(() => f.store.action(f.job.id, 'finish-human', { subJobId: 'sign', output: 'x'.repeat(8001) }), /8,000/);
  assert.equal(f.sub().stage, 'human', 'the failed write cannot finish the task');
  f.store.action(f.job.id, 'finish-human', { subJobId: 'sign', output: '  \n  ' });
  assert.equal(f.sub().result.output, undefined);
});

test('the marks belong to human tasks alone, and Mark done still finishes one by hand', async (t) => {
  const f = fixture(t); await f.approve(plan([humanSpec('sign'), sessionSpec('spike')]));
  assert.throws(() => f.store.action(f.job.id, 'start-human', { subJobId: 'spike' }), /not a human task/);
  assert.throws(() => f.store.action(f.job.id, 'finish-human', { subJobId: 'spike' }), /no longer yours to mark/);
  assert.throws(() => f.store.action(f.job.id, 'fix-here', { subJobId: 'sign', note: 'again' }), /nothing to run again/);
  assert.throws(() => f.store.action(f.job.id, 'accept-red', { subJobId: 'sign' }), /no pipeline to accept/);
  assert.throws(() => f.store.action(f.job.id, 'split-out', { subJobId: 'sign', title: 'Follow-up', brief: 'Do the rest' }), /no repository to open a PR in/);
  f.store.action(f.job.id, 'mark', { subJobId: 'sign', position: 'done', note: 'The vendor had already done it' });
  const sign = f.sub();
  assert.equal(sign.stage, 'cleanup');
  assert.deepEqual(sign.result, { checks: ['The vendor had already done it'], at: sign.result.at, receiptId: null });
  assert.equal(sign.deployed, undefined);
});

test('a dropped or cancelled human task never satisfies what waits on it', async (t) => {
  const f = fixture(t); await f.approve(plan([humanSpec('sign'), spec('api', ['sign'])]));
  f.store.action(f.job.id, 'drop', { subJobId: 'sign' });
  await f.tick(); await f.tick();
  assert.deepEqual([f.sub().stage, f.sub().state], ['done', 'cancelled']);
  assert.deepEqual(f.launched.map((w) => w.run.phase), ['planning'], 'api can never start behind a dropped prerequisite');
});

// --- PR stage ---

test('whether a merge deploys is inferred once per head and again after a new one', async (t) => {
  const f = fixture(t); await atPr(f); await f.tick();
  assert.deepEqual(f.deployCalls, ['head1']);
  assert.equal(f.sub().deploys.summary, 'Deploys on merge · Deploy');
  await f.tick(); assert.deepEqual(f.deployCalls, ['head1'], 'the same head is not re-read');
  f.setPr({ head: 'head2' }); await f.tick();
  assert.deepEqual(f.deployCalls, ['head1', 'head2']);
  // A failed inference is an observation error like any other poll's.
  f.github.deploys = async () => { throw new Error('gh unavailable'); };
  f.setPr({ head: 'head3' }); await f.tick();
  assert.match(f.sub().observationError, /unavailable/); assert.equal(f.sub().pr.head, 'head2');
});

test('a merge that starts nothing IS the delivery: no post-merge watch and no verify session', async (t) => {
  const f = fixture(t);
  f.setDeploys({ expected: false, summary: 'Merge completes it · deployment-pipeline ignores **.md' });
  f.store.update(f.job.id, (j) => { j.reviewMerge = false; });
  await f.approve(plan([spec('docs'), spec('api', ['docs'])]));
  f.report({ kind: 'published', url: PR_URL }, f.workerFor('docs'));
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  const docs = f.sub();
  assert.equal(docs.stage, 'cleanup'); assert.equal(docs.deployed.commit, 'merge1'); assert.ok(docs.mergedAt);
  assert.deepEqual(docs.deployed.checks, [MERGE_IS_DELIVERY]);
  assert.equal(f.launched.some((w) => w.run.phase === 'verify'), false);
  await f.tick(); assert.deepEqual(f.cleaned, ['docs']);
  assert.equal(f.launched.filter((w) => w.sub?.id === 'api' && w.run.phase === 'implementation').length, 1);
});

test('a merge that deploys is watched, and passing post-merge runs finish it without a session unless the plan named a check', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.equal(f.sub().stage, 'deployment');
  f.setDeployment({ status: 'passing', runs: [{ workflow: 'Deploy', status: 'passing' }], commit: 'merge1' });
  await f.tick();
  assert.equal(f.launched.some((w) => w.run.phase === 'verify'), false, 'nothing to confirm by hand');
  assert.equal(f.sub().stage, 'cleanup'); assert.deepEqual(f.sub().deployed.checks, ['Post-merge runs passed']);
  await f.tick(); assert.equal(f.store.get(f.job.id).stage, 'done');

  const g = fixture(t); await atPr(g, plan([spec('api', [], { check: 'helm list shows auth in dev and prod' })]));
  g.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await g.tick();
  g.setDeployment({ status: 'passing', runs: [{ workflow: 'Deploy', status: 'passing' }], commit: 'merge1' });
  await g.tick();
  assert.equal(g.last().run.phase, 'verify');
  g.report({ kind: 'deployed', checks: ['helm shows auth 1.4.0 in both'] }); await g.tick();
  assert.equal(g.sub().stage, 'done'); assert.deepEqual(g.cleaned, ['api']);
});

test('a failing post-merge run names the workflow and creates no second job', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'failing', runs: [{ workflow: 'Deploy to prod', status: 'failing' }, { workflow: 'Scan', status: 'passing' }], commit: 'merge1' });
  await f.tick();
  assert.equal(f.sub().error, 'Post-merge run failed: Deploy to prod');
  assert.equal(f.sub().stage, 'deployment');
  assert.equal(f.store.snapshot().jobs.length, 1, 'the fix is a move on this job, never a recovery job');
  assert.equal(f.sub().deployed, undefined);
});

test('Accept red on an open PR merges the pinned head instead of repairing it; a new push is judged afresh', async (t) => {
  const f = fixture(t); f.store.settings({ maxRepairs: 0 }); await atPr(f);
  f.setPr({ checkStatus: 'failing', checks: [{ name: 'e2e', state: 'FAILURE' }] }); await f.tick();
  assert.match(f.sub().error, /repair limit/);
  f.store.action(f.job.id, 'accept-red', { subJobId: 'api', note: 'e2e is flaky this week' });
  assert.equal(f.sub().error, null); assert.deepEqual(f.sub().acceptedRed, { ref: 'head1', note: 'e2e is flaky this week', at: f.sub().acceptedRed.at });
  await f.tick();
  assert.deepEqual(f.merged, ['head1']); assert.equal(f.sub().mergeRequestedHead, 'head1');
  assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 0, 'an accepted head is never repaired');
  assert.deepEqual(f.store.get(f.job.id).moves.map((m) => [m.move, m.note]), [['accept-red', 'e2e is flaky this week']]);
  // The acceptance was for head1: a push that lands red is back on the repair road.
  const g = fixture(t); g.store.settings({ maxRepairs: 0 }); await atPr(g);
  g.setPr({ checkStatus: 'failing' }); await g.tick();
  g.store.action(g.job.id, 'accept-red', { subJobId: 'api' });
  g.setPr({ head: 'head2' }); await g.tick();
  assert.deepEqual(g.merged, []); assert.match(g.sub().error, /repair limit/);
  assert.equal(g.sub().mergeApprovedHead, 'head1', 'the approval it carried stays pinned to the head that was accepted');
});

test('with manual merge on, Accept red needs no second Approve merge click: the acceptance is the approval', async (t) => {
  const f = fixture(t); f.store.settings({ maxRepairs: 0 }); await f.approve(); f.report({ kind: 'published', url: PR_URL });
  f.setPr({ checkStatus: 'failing' }); await f.tick();
  assert.match(f.sub().error, /repair limit/);
  f.store.action(f.job.id, 'accept-red', { subJobId: 'api' }); await f.tick();
  assert.deepEqual(f.merged, ['head1'], 'reviewMerge on, yet no second Approve merge click is asked for');
});

test('Accept red on a failing post-merge run climbs the rest of the ladder, receipt line saying which colour it was', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'failing', runs: [{ workflow: 'Deploy to prod', status: 'failing' }], commit: 'merge1' }); await f.tick();
  assert.match(f.sub().error, /Post-merge run failed/);
  f.store.action(f.job.id, 'accept-red', { subJobId: 'api', note: 'Prod deploy is red for the unrelated smoke test' });
  assert.equal(f.sub().error, null);
  await f.tick();
  assert.deepEqual(f.sub().deployed.checks, ['Post-merge run accepted red: Prod deploy is red for the unrelated smoke test']);
  assert.equal(f.sub().deployed.commit, 'merge1');
  await f.tick(); assert.equal(f.sub().stage, 'done'); assert.deepEqual(f.cleaned, ['api']);
  // With a check in the plan, verify still runs — and is told the truth about the runs.
  const g = fixture(t); await atPr(g, plan([spec('api', [], { check: 'helm list shows auth in prod' })]));
  g.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await g.tick();
  g.setDeployment({ status: 'failing', runs: [{ workflow: 'Deploy to prod', status: 'failing' }], commit: 'merge1' }); await g.tick();
  g.store.action(g.job.id, 'accept-red', { subJobId: 'api', note: 'smoke test is unrelated' }); await g.tick();
  assert.equal(g.last().run.phase, 'verify');
  const prompt = jobPrompt(g.store.get(g.job.id), g.sub(), g.last().run);
  assert.match(prompt, /post-merge runs FAILED \(Deploy to prod\) and the human accepted that — "smoke test is unrelated"/);
  assert.doesNotMatch(prompt, /runs passed/);
  g.report({ kind: 'deployed', checks: ['helm shows auth 1.4.0'] }); await g.tick();
  assert.equal(g.sub().stage, 'done');
});

test('a closed PR blocks the sub-job', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setPr({ state: 'CLOSED' }); await f.tick();
  assert.equal(f.sub().error, 'PR was closed without merging');
});

test('failed CI wakes only bounded repair sessions, and the limit is an error the human retries', async (t) => {
  const f = fixture(t); f.store.settings({ maxRepairs: 1 }); await atPr(f);
  f.setPr({ checkStatus: 'failing' }); await f.tick(); assert.equal(f.last().run.phase, 'repair');
  await f.tick(); assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 1);
  f.report({ kind: 'repaired', changes: ['Fixed flaky clock assertion'], checks: ['Clock test passes'] }); await f.tick();
  assert.equal(f.sub().repairs.length, 1); assert.match(f.sub().error, /limit reached/);
  f.store.action(f.job.id, 'retry', { subJobId: 'api' }); await f.tick();
  assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 2);
});

test('a merged sub-job with nothing deployed past the stale window is flagged; a slow run in progress is not', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.ok(f.sub().mergedAt);
  f.setDeployment({ status: 'pending', runs: [], commit: 'merge1' });
  await f.tick(); assert.equal(f.sub().deploymentStale, null, 'inside the window it is just waiting');
  for (let i = 0; i < 30; i++) await f.tick();
  assert.equal(f.sub().deploymentStale.since, f.sub().mergedAt);
  assert.ok(!f.sub().error, 'advisory: polling continues and nothing is blocked');
  f.setDeployment({ status: 'pending', runs: [{ workflow: 'Deploy', runId: 7, status: 'skipped' }], commit: 'merge1' });
  await f.tick(); assert.ok(f.sub().deploymentStale, 'an all-skipped merge deployed nothing');
  f.setDeployment({ status: 'pending', runs: [{ workflow: 'Deploy', runId: 7, status: 'pending' }], commit: 'merge1' });
  await f.tick(); assert.equal(f.sub().deploymentStale, null, 'a run in progress is a slow deploy, never stale');
  f.setDeployment({ status: 'pending', runs: [{ workflow: 'Deploy', runId: 7, status: 'passing' }, { workflow: 'Build', runId: 8, status: 'cancelled' }], commit: 'merge1' });
  await f.tick(); assert.deepEqual(f.sub().deploymentStale, { since: f.sub().mergedAt, cancelled: ['Build'] }, 'a cancellation nothing replaced goes to the human');
  assert.ok(!f.sub().error, 'and is never a failed deploy');
});

// --- Moves ---

const movesOf = (f) => f.store.get(f.job.id).moves;

test('Fix here on an open PR under code review goes back to work in the PR worktree, through review, and the approved tree is pushed to the same PR', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'published', url: PR_URL }); await f.tick();
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
  assert.equal(f.sub().mergeApprovedHead, 'head1');
  f.store.action(f.job.id, 'fix-here', { subJobId: 'api', note: 'Rename the flag to sign_in_v2' });
  const sent = f.sub();
  assert.deepEqual([sent.stage, sent.state, sent.fixRequested, sent.note, sent.pr.url], ['implementation', 'queued', null, 'Rename the flag to sign_in_v2', PR_URL], 'the PR stays on the card; nothing is committed to it yet');
  assert.match(movesOf(f).at(-1).detail, /back to work on its PR/);
  await f.tick();
  assert.deepEqual([f.last().run.phase, f.last().sub.worktree.path], ['implementation', '/worktree/api'], 'the same worktree, whose branch is the PR');
  assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 0, 'no repair commits behind the human’s back');
  const work = jobPrompt(f.store.get(f.job.id), f.last().sub, f.last().run);
  assert.match(work, /PR https:\/\/github.com\/org\/repo\/pull\/1 is already open from this worktree's branch/);
  assert.match(work, /Leave every change UNCOMMITTED.*pushes it to the open PR/);
  assert.match(work, /human requested changes: "Rename the flag to sign_in_v2"/);
  f.report({ kind: 'ready', checks: ['Flag renamed', 'Tests pass'] }); await f.tick();
  assert.deepEqual([f.sub().stage, f.sub().state], ['review', 'verified'], 'the human reads the diff before it reaches the PR');
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: f.sub().ready.receiptId }); await f.tick();
  assert.equal(f.last().run.phase, 'publish');
  const publish = jobPrompt(f.store.get(f.job.id), f.last().sub, f.last().run);
  assert.match(publish, /push to the open PR; do not open another/);
  assert.match(publish, /Commit, push to the open PR, then job_report \{runId:"run_\w+", kind:"published", url:"https:\/\/github.com\/org\/repo\/pull\/1"\}/);
  f.report({ kind: 'published', url: PR_URL }); await f.tick();
  assert.deepEqual([f.sub().stage, f.sub().state, f.sub().mergeApprovedHead], ['pr', 'watching', null], 'a new head: the old merge approval is spent');
});

test('Fix here on an open PR with code review off launches a repair whatever colour the checks are, and the repaired receipt clears it', async (t) => {
  const f = fixture(t, { ...input, reviewCode: false }); await f.approve();
  f.report({ kind: 'published', url: PR_URL }); await f.tick();
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 0, 'green checks start nothing on their own');
  f.store.action(f.job.id, 'fix-here', { subJobId: 'api', note: 'Rename the flag to sign_in_v2' });
  const requested = f.sub();
  assert.equal(requested.fixRequested.note, 'Rename the flag to sign_in_v2');
  assert.equal(requested.state, 'watching'); assert.equal(requested.nextPollAt, 0);
  await f.tick();
  assert.equal(f.last().run.phase, 'repair');
  assert.equal(f.last().sub.fixRequested.note, 'Rename the flag to sign_in_v2', 'the prompt carries the note');
  f.report({ kind: 'repaired', changes: ['Renamed the flag'], checks: ['Tests pass'] });
  assert.equal(f.sub().fixRequested, null); assert.equal(f.sub().note, null);
  assert.deepEqual(movesOf(f).map((m) => [m.subJobId, m.move, m.note]), [['api', 'fix-here', 'Rename the flag to sign_in_v2']]);
  assert.match(movesOf(f)[0].detail, /new commit on “Deliver api”/);
  assert.match(movesOf(f)[0].id, /^mv_/);
});

test('Fix here before a PR exists is a retry with a steer, and is refused once the PR has merged', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'blocked', summary: 'The feature flag name is ambiguous', move: 'fix-here' }); await f.tick();
  assert.deepEqual(f.sub().blocked, { summary: 'The feature flag name is ambiguous', move: 'fix-here', phase: 'implementation', at: f.sub().blocked.at });
  assert.equal(f.sub().error, 'The feature flag name is ambiguous');
  f.store.action(f.job.id, 'fix-here', { subJobId: 'api', note: 'Call it sign_in_v2' });
  assert.equal(f.sub().error, null); assert.equal(f.sub().blocked, null);
  assert.equal(f.sub().state, 'queued'); assert.equal(f.sub().note, 'Call it sign_in_v2');
  await f.tick();
  assert.equal(f.last().sub.note, 'Call it sign_in_v2');
  f.report({ kind: 'published', url: PR_URL });
  assert.equal(f.sub().note, null, 'the note is spent once that session reports');
  f.store.update(f.job.id, (j) => { j.subJobs[0].stage = 'deployment'; });
  assert.throws(() => f.store.action(f.job.id, 'fix-here', { subJobId: 'api' }), /Split out/);
});

test('Split out adds a PR on the same ticket, before or after this one', async (t) => {
  for (const position of ['before', 'after']) {
    const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
    f.store.action(f.job.id, 'split-out', { subJobId: 'api', title: 'Sync the proto', brief: 'Regenerate the proto', position, check: 'Proto matches', note: 'Do this one first' });
    const job = f.store.get(f.job.id);
    const [api, extra] = job.subJobs;
    assert.equal(extra.id, 'api-2'); assert.equal(extra.repo, '/repo'); assert.equal(extra.storyId, 'story');
    assert.equal(extra.jiraKey, 'AUTH-123'); assert.equal(extra.check, 'Proto matches'); assert.equal(extra.stage, 'implementation');
    assert.deepEqual(job.plan.subJobs.map((s) => s.id), ['api', 'api-2'], 'the approved plan carries it too');
    if (position === 'before') { assert.deepEqual(api.after, ['api-2']); assert.deepEqual(extra.after, []); }
    else { assert.deepEqual(api.after, []); assert.deepEqual(extra.after, ['api']); }
    assert.deepEqual(job.plan.subJobs[0].after, api.after);
    assert.equal(api.note, 'Do this one first'); assert.equal(api.repairAllowance, 1);
    assert.match(movesOf(f)[0].detail, new RegExp(`Split out “Sync the proto” to land ${position} this`));
  }
});

test('Split out from a merged sub-job is its fix: it counts as deployed when the fix does', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'failing', runs: [{ workflow: 'Deploy', status: 'failing' }], commit: 'merge1' }); await f.tick();
  assert.match(f.sub().error, /Post-merge run failed/);
  f.store.action(f.job.id, 'split-out', { subJobId: 'api', title: 'Guard empty payloads', brief: 'Add the null guard', position: 'before' });
  const api = f.sub();
  assert.equal(api.recoveredBy, 'api-2'); assert.equal(api.state, 'awaiting-fix'); assert.equal(api.error, null);
  assert.deepEqual(api.after, [], 'a merged sub-job cannot wait for anything: position is ignored');
  assert.match(movesOf(f)[0].detail, /as the fix for this merged PR/);
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api-2', 'implementation']);
  f.store.update(f.job.id, (j) => { j.subJobs[1].deployed = { checks: ['Live'] }; j.subJobs[1].stage = 'done'; });
  await f.tick();
  assert.equal(f.sub().stage, 'cleanup'); assert.match(f.sub().deployed.checks[0], /Fixed by Guard empty payloads/);
  assert.equal(f.sub().deployed.commit, 'merge1');
});

test('New ticket adds a keyless story and the write that creates it, under a stories session; its key releases the new PR', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  f.store.action(f.job.id, 'new-ticket', { subJobId: 'api', storyTitle: 'Sign-ins are audited', project: 'SEC',
    title: 'Emit audit events', brief: 'Emit an event per sign-in', position: 'after' });
  let job = f.store.get(f.job.id);
  assert.deepEqual(job.plan.stories.map((s) => [s.id, s.key ?? null, s.project ?? null]), [['story', 'AUTH-123', null], ['s-2', null, 'SEC']]);
  const extra = job.subJobs.find((s) => s.id === 'api-2');
  assert.equal(extra.storyId, 's-2'); assert.equal(extra.jiraKey, null); assert.deepEqual(extra.after, ['api']);
  assert.deepEqual(job.subJobs.filter((s) => s.kind === 'write').map((s) => [s.id, s.storyId, s.action.type, s.by]), [['create-s-2', 's-2', 'create', 'stories']]);
  assert.deepEqual(job.subJobs.find((s) => s.id === 'stories').title, 'Create Jira stories');
  await f.tick();
  const ticketing = f.workerFor('stories', 'session');
  assert.match(jobPrompt(f.store.get(f.job.id), ticketing.sub, ticketing.run), /"id":"create-s-2","place":"jira","ticket":null,"story":"Sign-ins are audited","project":"SEC"/);
  assert.equal(f.launched.filter((w) => w.sub?.id === 'api-2').length, 0, 'nothing starts without a key');
  f.report({ kind: 'completed', checks: ['Created SEC-42'], writes: [{ id: 'create-s-2', outcome: 'written', key: 'SEC-42' }] }, ticketing);
  job = f.store.get(f.job.id);
  assert.equal(job.stage, 'active');
  assert.equal(job.subJobs.find((s) => s.id === 'api-2').jiraKey, 'SEC-42'); assert.equal(job.plan.subJobs.find((s) => s.id === 'api-2').jiraKey, 'SEC-42');
  f.store.update(f.job.id, (j) => { j.subJobs[0].deployed = { checks: ['Live'] }; j.subJobs[0].stage = 'done'; });
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api-2', 'implementation']);
  assert.match(movesOf(f)[0].detail, /New ticket “Sign-ins are audited” with PR “Emit audit events” to land after this/);
});

test('Reorder rewrites what a sub-job lands after, refusing itself, a stranger and a cycle', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')])); f.alive.clear(); await f.tick();
  assert.throws(() => f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: ['web'] }), /cannot depend on itself/);
  assert.throws(() => f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: ['ghost'] }), /Unknown dependency/);
  f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: ['api'] });
  assert.deepEqual(f.sub(1).after, ['api']); assert.deepEqual(f.store.get(f.job.id).plan.subJobs[1].after, ['api']);
  assert.throws(() => f.store.action(f.job.id, 'reorder', { subJobId: 'api', after: ['web'] }), /cycles/);
  assert.deepEqual(f.sub().after, [], 'a refused reorder changes nothing');
  f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: [] });
  assert.equal(movesOf(f).at(-1).detail, 'No longer waits for anything');
  f.store.update(f.job.id, (j) => { j.subJobs[1].stage = 'deployment'; });
  assert.throws(() => f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: ['api'] }), /has merged/);
});

test('Mark position: a PR opened by hand, a merge done by hand, and work already covered elsewhere', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  assert.throws(() => f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'merged' }), /Only an open PR/);
  assert.throws(() => f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'pr' }), /Give the PR url/);
  f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'pr', url: PR_URL });
  let api = f.sub();
  assert.equal(api.stage, 'pr'); assert.equal(api.state, 'watching'); assert.equal(api.pr.url, PR_URL);
  assert.ok(api.nextPollAt > Date.now() + 9000, 'a PR named by hand settles like a reported one');
  assert.throws(() => f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'pr', url: PR_URL }), /already has a PR/);
  f.store.update(f.job.id, (j) => { j.subJobs[0].error = 'stuck'; });
  f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'merged' });
  api = f.sub();
  assert.equal(api.error, null); assert.equal(api.nextPollAt, 0); assert.equal(api.stage, 'pr', 'the next poll reads the merge itself');
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.equal(f.sub().stage, 'deployment');
  f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'done', note: 'Deployed by hand, /health is green' });
  api = f.sub();
  assert.equal(api.stage, 'cleanup'); assert.deepEqual(api.deployed.checks, ['Deployed by hand, /health is green']);
  assert.equal(api.deployed.commit, 'merge1'); assert.equal(api.note, null, 'a mark note is history, not a steer for a next session');
  await f.tick(); assert.equal(f.store.get(f.job.id).stage, 'done');
  assert.deepEqual(movesOf(f).map((m) => m.move), ['mark', 'mark', 'mark']);
});

test('Mark done finishes a session sub-job with its own receipt', async (t) => {
  const f = fixture(t); await f.approve(plan([sessionSpec('spike')])); f.alive.clear(); await f.tick();
  f.store.action(f.job.id, 'mark', { subJobId: 'spike', position: 'done', note: 'Already answered in the incident review' });
  const spike = f.sub();
  assert.equal(spike.stage, 'cleanup');
  assert.deepEqual(spike.result, { checks: ['Already answered in the incident review'], at: spike.result.at, receiptId: null });
  assert.equal(spike.deployed, undefined);
});

test('Mark done on a PR sub-job that never opened a PR still completes cleanup', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  f.store.update(f.job.id, (j) => { j.subJobs[0].worktree.cleanupHead = 'base'; });
  f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'done', note: 'Finished outside the job' });
  let api = f.sub();
  assert.equal(api.stage, 'cleanup'); assert.equal(api.pr, null);
  // The fixture's own runtime stub never exercises cleanupWorktree's git rules;
  // swap in the real one, which is what threw "Cannot read properties of null
  // (reading 'head')" on this exact shape before the cleanupHead fallback.
  const host = { sessions: { get: () => null } };
  const run = async (bin, args) => (args[0] === 'for-each-ref' ? 'base' : '');
  f.runtime.cleanup = (j, s) => new JobRuntime({ host }, run).cleanup(j, s);
  await f.tick();
  api = f.sub();
  assert.deepEqual([api.stage, api.state, api.error], ['done', 'done', null]);
});

test('Drop is the old cancel under a new name: it stops the live step and ignores its late receipt', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web', ['api'])]));
  const worker = f.workerFor('api');
  f.store.action(f.job.id, 'drop', { subJobId: 'api' });
  let api = f.sub();
  assert.equal(api.stage, 'cleanup'); assert.ok(api.cancelledAt); assert.equal(api.state, 'cancelled');
  f.report({ kind: 'published', url: PR_URL }, worker);
  assert.equal(f.sub().pr, null, 'a racing receipt must not move a dropped sub-job');
  await f.tick();
  assert.ok(f.stopped.includes(worker.run.id)); assert.deepEqual(f.cleaned, ['api']);
  assert.equal(f.sub().stage, 'done');
  assert.throws(() => f.store.action(f.job.id, 'drop', { subJobId: 'api' }), /already finished/);
  assert.throws(() => f.store.action(f.job.id, 'cancel', { subJobId: 'api' }), /already finished/, 'the old name still routes here');
  assert.throws(() => f.store.action(f.job.id, 'drop'), /Choose a sub-job/);
  assert.deepEqual(movesOf(f).map((m) => m.move), ['drop']);
});

test('a move that rewrites the plan waits for the session working to it; Drop never does', async (t) => {
  const f = fixture(t); await f.approve();
  for (const [action, payload] of [
    ['split-out', { title: 'Second PR', brief: 'Split it' }],
    ['new-ticket', { storyTitle: 'Another story', title: 'Second PR', brief: 'Split it' }],
    ['reorder', { after: [] }],
    ['mark', { position: 'done' }],
  ]) assert.throws(() => f.store.action(f.job.id, action, { subJobId: 'api', ...payload }), /Wait for the session to stop/, action);
  assert.deepEqual(movesOf(f), []);
  f.store.action(f.job.id, 'drop', { subJobId: 'api' });
  assert.equal(f.sub().state, 'cancelled');
});

test('every move is refused on a finished or dropped sub-job', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  f.store.action(f.job.id, 'drop', { subJobId: 'api' });
  for (const action of ['fix-here', 'split-out', 'new-ticket', 'reorder', 'drop', 'mark', 'accept-red']) {
    assert.throws(() => f.store.action(f.job.id, action, { subJobId: 'api', title: 't', brief: 'b', storyTitle: 's', after: [], position: 'done' }), /already finished/, action);
  }
});

test('cancelling a job drops every unfinished sub-job, stops its steps, cleans up and finishes as cancelled', async (t) => {
  const f = fixture(t); f.store.settings({ concurrency: 2 }); await f.approve(plan([spec('api'), spec('web'), spec('docs')]));
  assert.deepEqual(f.launched.filter((w) => w.sub).map((w) => w.sub.id), ['api', 'web'], 'two slots, so docs is still queued');
  f.store.action(f.job.id, 'pause');
  const before = f.launched.length, api = f.workerFor('api');
  f.store.action(f.job.id, 'cancel-job');
  let job = f.store.get(f.job.id);
  assert.ok(job.cancelledAt); assert.equal(job.paused, false, 'a paused job is un-paused so cleanup can run');
  for (const s of job.subJobs) { assert.equal(s.stage, 'cleanup', s.id); assert.equal(s.state, 'cancelled', s.id); assert.ok(s.cancelledAt, s.id); }
  assert.throws(() => f.store.action(f.job.id, 'cancel-job'), /already cancelled/);
  f.report({ kind: 'published', url: PR_URL }, api);
  assert.equal(f.sub().pr, null, 'a racing receipt never pulls a sub-job back out of cleanup');
  await f.tick();
  job = f.store.get(f.job.id);
  for (const w of [api, f.workerFor('web')]) assert.ok(f.stopped.includes(w.run.id), w.sub.id);
  assert.deepEqual(f.cleaned, ['api', 'web', 'docs']);
  assert.deepEqual(job.subJobs.map((s) => [s.stage, s.state, s.error ?? null]), [['done', 'cancelled', null], ['done', 'cancelled', null], ['done', 'cancelled', null]]);
  assert.equal(job.stage, 'done'); assert.ok(job.completedAt); assert.equal(job.error ?? null, null);
  assert.equal(f.launched.length, before, 'the freed slots launch nothing');
  for (const action of ['pause', 'resume', 'start', 'replan', 'approve-session', 'approve-merge', 'drop', 'fix-here']) {
    assert.throws(() => f.store.action(f.job.id, action, { subJobId: action === 'drop' || action === 'fix-here' ? 'docs' : undefined, feedback: 'x' }), /Job was cancelled/, action);
  }
  assert.throws(() => f.store.action(f.job.id, 'cancel-job'), /already finished/);
  assert.deepEqual(movesOf(f), [], 'a cancel is job state, not one of the six moves');
});

test('a sub-job already delivered or refused cleanup is left alone by a cancel, and Retry still clears a refused cleanup', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  f.alive.delete(f.workerFor('api').sid); await f.tick();
  f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'done', note: 'Landed by hand' });
  const cleanupError = new Error('Branch has additional commits; preserve it for review');
  f.runtime.cleanup = async (j, s) => { if (s.id === 'web' && s.cancelledAt) throw cleanupError; f.cleaned.push(s.id); };
  f.store.action(f.job.id, 'cancel-job');
  let [api, web] = f.store.get(f.job.id).subJobs;
  assert.equal(api.cancelledAt, undefined, 'work marked done stays delivered'); assert.equal(api.stage, 'cleanup');
  assert.equal(web.state, 'cancelled');
  await f.tick();
  [api, web] = f.store.get(f.job.id).subJobs;
  assert.deepEqual([api.stage, api.state], ['done', 'done']);
  assert.deepEqual([web.stage, web.error], ['cleanup', cleanupError.message]);
  assert.equal(f.store.get(f.job.id).stage, 'active', 'the job waits for the human while a cleanup is refused');
  await f.tick();
  assert.equal(f.cleaned.filter((id) => id === 'web').length, 0, 'a refused cleanup is not retried by the clock');
  f.store.action(f.job.id, 'retry', { subJobId: 'web' });
  assert.deepEqual([f.sub(1).error, f.sub(1).state], [null, 'cancelled']);
  f.runtime.cleanup = async (j, s) => { f.cleaned.push(s.id); };
  await f.tick();
  const job = f.store.get(f.job.id);
  assert.deepEqual(job.subJobs.map((s) => s.state), ['done', 'cancelled']);
  assert.equal(job.stage, 'done'); assert.ok(job.cancelledAt);
});

test('Discard on a refused cleanup is pinned to what the board showed, recorded as a move, and lets a cancelled job finish', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api')]));
  f.store.action(f.job.id, 'cancel-job');
  const refusal = { path: '/worktree/api', branch: 'branch-api', base: 'main', head: 'cc47137', fingerprint: 'fp1',
    commits: [], commitCount: 0, files: [{ change: 'untracked', path: 'server/mcp/tools/list-models.js' }], fileCount: 1 };
  const seen = [];
  f.runtime.cleanup = async (j, s) => {
    seen.push(s.discard);
    if (!s.discard) throw new CleanupRefused('Worktree has work that would be lost (1 uncommitted file); preserve it for review', refusal);
  };
  await f.tick();
  assert.deepEqual([f.sub().stage, f.sub().cleanupRefusal], ['cleanup', refusal]);
  assert.equal(f.store.get(f.job.id).stage, 'active', 'the cancelled job waits on the human while a cleanup is refused');
  assert.throws(() => f.store.action(f.job.id, 'discard-worktree', { subJobId: 'api', discardHead: 'older', fingerprint: 'fp1' }), /changed since you looked/);
  assert.throws(() => f.store.action(f.job.id, 'discard-worktree', { subJobId: 'api', discardHead: 'cc47137', fingerprint: 'stale' }), /changed since you looked/);
  f.store.action(f.job.id, 'discard-worktree', { subJobId: 'api', discardHead: 'cc47137', fingerprint: 'fp1' });
  assert.equal(f.sub().error, null);
  assert.deepEqual([f.sub().discard.head, f.sub().discard.fingerprint], ['cc47137', 'fp1']);
  assert.throws(() => f.store.action(f.job.id, 'discard-worktree', { subJobId: 'api', discardHead: 'cc47137', fingerprint: 'fp1' }), /Nothing is waiting/, 'one discard per refusal');
  const move = f.store.get(f.job.id).moves.at(-1);
  assert.equal(move.move, 'discard-worktree'); assert.match(move.detail, /1 file \(server\/mcp\/tools\/list-models\.js\)/);
  await f.tick();
  const job = f.store.get(f.job.id);
  assert.deepEqual([job.subJobs[0].stage, job.subJobs[0].state, job.subJobs[0].cleanupRefusal, job.subJobs[0].discard], ['done', 'cancelled', null, null]);
  assert.equal(job.stage, 'done'); assert.ok(job.cancelledAt);
  assert.equal(seen.at(-1).head, 'cc47137', 'the runtime is handed the pinned head to re-check on disk');
});

test('a Discard the disk no longer matches is spent: the fresh refusal replaces it and must be chosen again', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api')]));
  f.store.action(f.job.id, 'drop', { subJobId: 'api' });
  let refusal = { head: 'h1', fingerprint: 'fp1', branch: 'b', base: 'main', commits: [], commitCount: 0, files: [], fileCount: 0 };
  f.runtime.cleanup = async () => { throw new CleanupRefused('refused', refusal); };
  await f.tick();
  f.store.action(f.job.id, 'discard-worktree', { subJobId: 'api', discardHead: 'h1', fingerprint: 'fp1' });
  refusal = { ...refusal, head: 'h2' };
  await f.tick();
  assert.deepEqual([f.sub().discard, f.sub().cleanupRefusal.head, f.sub().error], [null, 'h2', 'refused']);
  assert.throws(() => f.store.action(f.job.id, 'discard-worktree', { subJobId: 'api', discardHead: 'h1', fingerprint: 'fp1' }), /changed since you looked/);
  f.store.action(f.job.id, 'retry', { subJobId: 'api' });
  assert.equal(f.sub().cleanupRefusal, null, 'Retry clears the old refusal; the next attempt writes a fresh one');
  refusal = { ...refusal, head: 'h3', pinned: false };
  await f.tick();
  assert.throws(() => f.store.action(f.job.id, 'discard-worktree', { subJobId: 'api', discardHead: 'h3', fingerprint: 'fp1' }), /cannot be pinned/);
});

test('cancelling before there are sub-jobs stops the planner quietly, ignores its late plan and finishes without launching anything', async (t) => {
  const f = fixture(t); let planningCleanups = 0;
  f.runtime.cleanupPlanning = async () => { planningCleanups++; };
  f.store.action(f.job.id, 'start'); await f.tick();
  const planner = f.last(); assert.equal(planner.run.phase, 'planning');
  f.store.action(f.job.id, 'cancel-job');
  f.report({ kind: 'plan', plan: plan() }, planner);
  assert.equal(f.store.get(f.job.id).plan, null, 'a plan reported after the cancel does not activate the job');
  assert.throws(() => f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision), /Job was cancelled/);
  await f.tick();
  const job = f.store.get(f.job.id);
  assert.ok(f.stopped.includes(planner.run.id)); assert.equal(job.error ?? null, null, 'no missing-receipt error for a step the human ended');
  assert.equal(job.stage, 'done'); assert.ok(job.cancelledAt); assert.deepEqual(job.subJobs, []);
  assert.equal(planningCleanups, 1, 'the planning worktree is cleaned up');
  assert.equal(f.launched.length, 1);
  // From the backlog there is nothing to stop; the next tick simply closes it.
  const idle = f.store.create(input);
  f.store.action(idle.id, 'cancel-job'); await f.tick();
  assert.equal(f.store.get(idle.id).stage, 'done'); assert.equal(f.launched.length, 1); assert.equal(planningCleanups, 2);
  await f.tick();
  assert.equal(planningCleanups, 2, 'a finished job is never cleaned up again');
});

// --- Settle ---

test('a long step is never killed by a clock, but one that stops working without a receipt is an error', async (t) => {
  const f = fixture(t); f.setStatus(() => 'working');
  await f.approve();
  for (let i = 0; i < 40; i++) await f.tick();
  assert.equal(f.store.get(f.job.id).runs.filter((r) => !r.stopped).length, 1, 'no time limit');
  assert.equal(f.sub().error, undefined);
  f.setStatus(() => 'needs-you');
  for (let i = 0; i < 20; i++) await f.tick();
  assert.equal(f.sub().error, undefined, 'waiting on a human is surfaced on the board, never ended here');
  f.setStatus(() => 'idle');
  await f.tick();
  const idleAt = f.store.get(f.job.id).runs[1].idleSince;
  assert.ok(idleAt);
  f.setStatus(() => 'working'); await f.tick();
  assert.equal(f.store.get(f.job.id).runs[1].idleSince, null, 'working again clears it');
  f.setStatus(() => 'idle');
  await f.tick();
  while (f.clockNow() - f.store.get(f.job.id).runs[1].idleSince <= IDLE_RECEIPT_GRACE_MS) await f.tick();
  await f.tick();
  assert.match(f.sub().error, /finished without a receipt/);
  assert.equal(f.store.get(f.job.id).runs[1].stopped, true);
  assert.match(f.store.get(f.job.id).runs[1].error, /finished without a receipt/, 'kept on the run: retry clears the card\'s copy, the next session\'s history reads this one');
});

test('a run records the model it was claimed on, and none when the job leaves it to the agent', async (t) => {
  const f = fixture(t, { ...input, model: 'sonnet', effort: 'high' }); await f.approve();
  assert.ok(f.store.get(f.job.id).runs.every((r) => r.model === 'sonnet' && r.effort === 'high'));
  const g = fixture(t); await g.approve();
  assert.ok(g.store.get(g.job.id).runs.every((r) => r.model === null), 'not guessed: Claude reads its default from settings.json at launch');
});

test('crashed and uncertain launches are blocked, not silently duplicated on restart', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  assert.match(f.sub().error, /stopped without a receipt/);
  const other = f.store.create(input); f.store.action(other.id, 'start'); f.store.claim(other.id, null, 'planning');
  await f.tick(); assert.match(f.store.get(other.id).error, /Launch was interrupted/);
});

test('a receipt arriving during an exit probe is honoured without a false missing-receipt error', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.runtime.isAlive = async () => { f.report({ kind: 'plan', plan: plan() }); return false; };
  await f.tick();
  const job = f.store.get(f.job.id);
  assert.equal(job.error, undefined); assert.ok(job.plan); assert.equal(job.runs[0].stopped, true);
});

test('a failed liveness query does not stop the worker or release its slot', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.runtime.isAlive = async () => { throw new Error('tmux temporarily unavailable'); };
  await f.tick();
  assert.equal(f.stopped.length, 0); assert.equal(f.store.get(f.job.id).runs[0].stopped, false);
});

test('session teardown failure keeps its slot reserved', async (t) => {
  const f = fixture(t); await f.approve(); f.report({ kind: 'published', url: PR_URL });
  f.runtime.stop = async () => { throw new Error('Still alive'); }; await f.tick();
  assert.equal(f.store.get(f.job.id).runs.filter((r) => !r.stopped).length, 1);
  assert.match(f.store.get(f.job.id).error, /Still alive/);
});

test('cleanup refusal remains visible and retryable', async (t) => {
  const f = fixture(t); await f.approve();
  f.alive.clear(); await f.tick();
  f.store.update(f.job.id, (j) => { const s = j.subJobs[0]; s.error = null; s.stage = 'cleanup'; s.deployed = { checks: ['Works'] }; });
  f.runtime.cleanup = async () => { throw new Error('Worktree contains local changes'); };
  await f.tick();
  assert.equal(f.sub().stage, 'cleanup'); assert.match(f.sub().error, /local changes/);
});

test('concurrency applies to all jobs and paused work never starts a session', async (t) => {
  const f = fixture(t); f.store.settings({ concurrency: 1 });
  const second = f.store.create(input); f.store.action(f.job.id, 'start'); f.store.action(second.id, 'start');
  await f.tick(); await f.tick(); assert.equal(f.launched.length, 1);
  f.store.settings({ paused: true }); f.report({ kind: 'plan', plan: plan() }); await f.tick();
  assert.equal(f.launched.length, 1); assert.equal(f.alive.size, 0);
  f.store.settings({ paused: false }); await f.tick(); assert.equal(f.launched.length, 2);
});

test('a run parked on its drafts holds no concurrency slot, yet its own sub-job is not launched twice', async (t) => {
  const f = fixture(t); f.store.settings({ concurrency: 1 });
  const second = f.store.create(input); f.store.action(f.job.id, 'start'); f.store.action(second.id, 'start');
  await f.tick(); assert.equal(f.launched.length, 1);
  const [run] = f.store.get(f.job.id).runs;
  f.store.update(f.job.id, (j) => { j.runs[0].parkedAt = 1; });
  assert.equal(f.store.claim(f.job.id, null, 'planning'), null, 'still live for its own work');
  await f.tick(); assert.equal(f.launched.length, 2, 'the other job takes the slot it is not using');
  f.store.update(f.job.id, (j) => { j.runs.find((r) => r.id === run.id).mailedAt = 2; });
  assert.equal(f.store.claim(second.id, 'x', 'session'), null, 'mailed, it is working again and the slots are full');
});

test('idle ticks and exhausted claims do not rewrite state or trigger extra graph rebuilds', async (t) => {
  const f = fixture(t); let rebuilt = 0; f.runner.onChange = async () => { rebuilt++; };
  const before = f.store.data; await f.tick(); assert.equal(rebuilt, 0); assert.equal(f.store.data, before);
  f.store.action(f.job.id, 'start'); await f.tick(); assert.equal(rebuilt, 1);
  const running = f.store.data; assert.equal(f.store.claim(f.job.id, null, 'planning'), null); assert.equal(f.store.data, running);
  await f.tick(); assert.equal(rebuilt, 1);
});

test('tick overlap does not duplicate side effects and paused-in-flight polling cannot merge', async (t) => {
  const f = fixture(t); await atPr(f);
  let release; f.github.pr = async () => { await new Promise((r) => { release = r; }); return { state: 'OPEN', checkStatus: 'passing', head: 'head1' }; };
  const pending = f.tick();
  while (!release) await new Promise((r) => setImmediate(r));
  await f.runner.tick(); f.store.action(f.job.id, 'pause'); release(); await pending;
  assert.equal(f.merged.length, 0);
});

test('pipeline API failure never turns old green evidence into a merge', async (t) => {
  const f = fixture(t); await atPr(f); f.github.pr = async () => { throw new Error('GitHub unavailable'); };
  await f.tick(); assert.equal(f.merged.length, 0); assert.match(f.sub().observationError, /unavailable/);
});

// --- Writes: every one made by a session ---

const write = (id, by, action, extra = {}) => ({ id, kind: 'write', place: { type: 'jira' }, title: `Write ${id}`, storyId: 'story', after: [], ...(by ? { by } : {}), action, ...extra });
const notifier = (id, on, after = []) => ({ id, kind: 'session', title: `Notify ${id}`, after, brief: `Make the writes of ${id}`, ...(on ? { on } : {}) });
const moveTo = (to, comment) => ({ type: 'transition', to, ...(comment ? { comment } : {}) });
const completed = (writes, checks = ['Made the writes']) => ({ kind: 'completed', checks, writes });
const noSessionReview = { ...input, reviewSessions: false };

test('approving a plan with a keyless story creates it under a stories session, whose key, and only that, unlocks the sub-jobs naming it', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const proposed = plan([spec('api'), { ...spec('web'), storyId: 'audit' }],
    [{ id: 'story', key: 'AUTH-123', title: 'Reliable sign-in' }, { id: 'audit', project: 'SEC', title: 'Sign-ins are audited' }]);
  f.report({ kind: 'plan', plan: proposed }); await f.tick();
  assert.deepEqual(f.store.get(f.job.id).plan.subJobs.slice(0, 2), [
    { id: 'stories', kind: 'session', title: 'Create Jira stories', after: [], brief: 'Create this job\'s new Jira stories, one per create write you are given, and nothing else.', stories: true },
    { id: 'create-audit', title: 'Create story: Sign-ins are audited', kind: 'write', place: { type: 'jira' }, storyId: 'audit', after: [], action: { type: 'create' }, by: 'stories' }],
  'the human reviews the create and the session that makes it with the plan');
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision); await f.tick();
  let job = f.store.get(f.job.id);
  assert.equal(job.stage, 'active', 'no separate ticketing stage: the create is a sub-job of the running job');
  assert.deepEqual(job.subJobs.map((s) => [s.id, s.kind, s.stage, s.state]),
    [['stories', 'session', 'session', 'queued'], ['create-audit', 'write', 'write', 'queued'], ['api', 'pr', 'implementation', 'queued'], ['web', 'pr', 'implementation', 'queued']]);
  const w = f.workerFor('stories', 'session');
  assert.deepEqual(f.launched.filter((l) => l.run.phase === 'implementation').map((l) => l.sub.id), ['api'], 'web waits for its key');
  assert.throws(() => f.report(completed([]), w), /still missing: create-audit/);
  assert.throws(() => f.report(completed([{ id: 'api', outcome: 'written' }]), w), /api is not one of the writes this session makes/);
  assert.throws(() => f.report(completed([{ id: 'create-audit', outcome: 'written' }]), w), /report the key/);
  assert.equal(f.store.get(f.job.id).subJobs[1].state, 'queued', 'a rejected receipt changes nothing');
  f.report(completed([{ id: 'create-audit', outcome: 'written', key: 'SEC-42' }]), w); await f.tick();
  job = f.store.get(f.job.id);
  assert.equal(job.plan.stories[1].key, 'SEC-42');
  assert.deepEqual(job.subJobs.map((s) => s.jiraKey), [null, 'SEC-42', 'AUTH-123', 'SEC-42']);
  assert.deepEqual(job.subJobs[1].result.checks, ['Created SEC-42']); assert.equal(job.subJobs[1].stage, 'done');
  assert.equal(job.subJobs[0].stage, 'done', 'its writes are its result: no Session results review, though the job has it on');
  assert.deepEqual([f.last().run.phase, f.last().sub.id], ['implementation', 'web']);
});

test('a proposed story carries the fields its create fills in; the human edits them on approval and its session gets exactly those', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const story = (fields) => [{ id: 'audit', project: 'SEC', title: 'Sign-ins are audited', fields }];
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('web'), storyId: 'audit' }], story([{ name: 'Labels', value: 'a' }, { name: 'labels', value: 'b' }])) }), /name each field once/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('web'), storyId: 'audit' }], story([{ name: 'Summary', value: 'x' }])) }), /title is the summary/);
  f.report({ kind: 'plan', plan: plan([{ ...spec('web'), storyId: 'audit' }], story([{ name: 'Issue Type', value: 'Story' }, { name: 'Components', value: 'Auth' }])) }); await f.tick();
  const edited = structuredClone(f.store.get(f.job.id).plan);
  edited.stories[0].fields = [{ name: 'Issue Type', value: 'Story' }, { name: 'Labels', value: 'audit' }];
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision, edited); await f.tick();
  assert.deepEqual(f.store.get(f.job.id).plan.stories[0].fields, edited.stories[0].fields);
  const w = f.workerFor('stories', 'session'); const prompt = jobPrompt(f.store.get(f.job.id), w.sub, w.run);
  assert.match(prompt, /"fields":\[\{"name":"Issue Type","value":"Story"\},\{"name":"Labels","value":"audit"\}\]/);
  assert.doesNotMatch(prompt, /Components/, 'a field the human removed is not set');
});

test('a plan can mix ticketed and ticketless sub-jobs: only the one naming a keyless story waits for its create write', async (t) => {
  const f = fixture(t);
  const tool = { ...spec('tool') }; delete tool.storyId;
  await f.approve(plan([tool, { ...spec('web'), storyId: 'audit' }], [{ id: 'audit', project: 'SEC', title: 'Sign-ins are audited' }]));
  assert.deepEqual(f.launched.slice(1).map((l) => [l.run.phase, l.sub?.id ?? null]), [['session', 'stories'], ['implementation', 'tool']]);
  f.report(completed([{ id: 'create-audit', outcome: 'already', key: 'SEC-42' }]), f.workerFor('stories')); await f.tick();
  assert.deepEqual(f.store.get(f.job.id).subJobs.map((s) => [s.id, s.jiraKey]), [['stories', null], ['create-audit', 'SEC-42'], ['tool', null], ['web', 'SEC-42']]);
  assert.deepEqual([f.last().run.phase, f.last().sub.id], ['implementation', 'web']);
});

test('a blocked stories session holds its writes, not the job, and Retry runs it again; a fully keyed plan writes nothing', async (t) => {
  const f = fixture(t);
  await f.approve(plan([spec('api')], [{ id: 'story', title: 'Reliable sign-in' }]));
  f.report({ kind: 'blocked', summary: 'Jira search failed: 401 from the Atlassian MCP' }, f.workerFor('stories')); await f.tick();
  let job = f.store.get(f.job.id);
  assert.equal(job.error ?? null, null);
  assert.match(job.subJobs[0].error, /401/); assert.equal(job.subJobs[0].blocked.phase, 'session');
  assert.deepEqual([job.subJobs[1].state, job.subJobs[1].error ?? null], ['queued', null], 'its write still waits on it');
  const before = f.launched.length; await f.tick();
  assert.equal(f.launched.length, before, 'a blocked session waits for the human');
  f.store.action(f.job.id, 'retry', { subJobId: 'stories' }); await f.tick();
  f.report(completed([{ id: 'create-story', outcome: 'written', key: 'AUTH-7' }]), f.workerFor('stories')); await f.tick();
  job = f.store.get(f.job.id);
  assert.equal(job.subJobs[2].jiraKey, 'AUTH-7'); assert.deepEqual([f.last().run.phase, f.last().sub.id], ['implementation', 'api']);
  const g = fixture(t); await g.approve();
  assert.deepEqual(g.launched.map((l) => l.run.phase), ['planning', 'implementation'], 'existing keys mean nothing to write in Jira');
});

test('a session with a milestone starts at it and not before, and its writes are filled from that trigger', async (t) => {
  const f = fixture(t, noSessionReview);
  await f.approve(plan([spec('api'),
    notifier('n-start', { sub: 'api', at: 'started' }), write('w-start', 'n-start', moveTo('In Progress')),
    notifier('n-pr', { sub: 'api', at: 'pr' }), write('w-pr', 'n-pr', moveTo('In Review', 'PR opened: {pr.url}'), { why: 'AUTH uses In Review for open PRs' }),
    write('w-note', 'n-pr', { type: 'comment', comment: 'Review {pr.title}' }),
    notifier('n-done', { sub: 'api', at: 'deployed' }), write('w-done', 'n-done', moveTo('Done'))]));
  const started = () => f.launched.filter((l) => l.run.phase === 'session').map((l) => l.sub.id);
  assert.deepEqual(started(), ['n-start'], 'started: the implementation session was launched; nothing else has come');
  f.report(completed([{ id: 'w-start', outcome: 'written', from: 'To Do' }]), f.workerFor('n-start'));
  f.setDeploys({ expected: false });
  f.report({ kind: 'published', url: PR_URL }, f.workerFor('api', 'implementation'));
  await f.tick();
  assert.deepEqual(started(), ['n-start', 'n-pr']);
  let job = f.store.get(f.job.id);
  const batch = f.workerFor('n-pr');
  const prompt = jobPrompt(job, batch.sub, batch.run);
  assert.match(prompt, /"comment":"PR opened: https:\/\/github.com\/org\/repo\/pull\/1"/); assert.match(prompt, /"comment":"Review Deliver api"/);
  assert.throws(() => f.report(completed([{ id: 'w-pr', outcome: 'written' }]), batch), /still missing: w-note/);
  f.report(completed([{ id: 'w-pr', outcome: 'already', from: 'In Review' }, { id: 'w-note', outcome: 'written', checks: ['Comment posted'] }]), batch);
  job = f.store.get(f.job.id);
  const pr = job.subJobs.find((s) => s.id === 'w-pr');
  assert.equal(pr.result.outcome, 'already'); assert.equal(pr.result.from, 'In Review');
  assert.equal(pr.result.text, `PR opened: ${PR_URL}`); assert.deepEqual(pr.result.checks, ['AUTH-123 was already at or past In Review; comment posted']);
  f.setPr({ state: 'MERGED', mergeCommit: 'm1' });
  await f.tick();
  assert.deepEqual(started(), ['n-start', 'n-pr', 'n-done'], 'deployed: here the merge is the delivery');
  f.report(completed([{ id: 'w-done', outcome: 'written', from: 'In Review' }]), f.workerFor('n-done'));
  await f.tick(); await f.tick();
  job = f.store.get(f.job.id);
  assert.equal(job.subJobs.find((s) => s.id === 'w-done').result.checks[0], 'AUTH-123 moved to Done');
  assert.equal(job.stage, 'done');
});

test('a reviewed write is drafted by its session, which stays parked until every draft is decided, is mailed the final text, and then completes', async (t) => {
  const f = fixture(t, noSessionReview);
  await f.approve(plan([notifier('n'),
    write('post', 'n', { type: 'post', text: 'Planned post' }, { place: { type: 'slack', ref: '#web' }, storyId: undefined, review: true }),
    write('move', 'n', moveTo('In Review'), { review: true }),
    write('free', 'n', { type: 'comment', comment: 'Unreviewed' })]));
  const w = f.workerFor('n', 'session');
  assert.match(jobPrompt(f.store.get(f.job.id), w.sub, w.run), /Review is on for post, move: do NOT make them yet/);
  assert.throws(() => f.report(completed([{ id: 'free', outcome: 'written' }]), w), /Review is on for post, move: report them as kind:"drafts" first/);
  assert.throws(() => f.report({ kind: 'drafts', drafts: [{ id: 'post', text: 'x' }] }, w), /still missing: move/);
  const drafts = { kind: 'drafts', drafts: [{ id: 'post', text: 'Shipped the sign-in fix' }, { id: 'move', to: 'In Review', comment: 'Ready for review' }] };
  f.report(drafts, w);
  f.report(drafts, w);
  assert.throws(() => f.report({ ...drafts, drafts: drafts.drafts.slice().reverse() }, w), /already sent its drafts/);
  let job = f.store.get(f.job.id);
  const [post, move] = ['post', 'move'].map((id) => job.subJobs.find((s) => s.id === id));
  assert.deepEqual([post.stage, post.state, post.action.text], ['review', 'verified', 'Shipped the sign-in fix'], 'the review panel shows the agent\'s draft');
  assert.deepEqual(move.action, { type: 'transition', to: 'In Review', comment: 'Ready for review' });
  const run = () => f.store.get(f.job.id).runs.find((r) => r.id === w.run.id);
  assert.ok(run().parkedAt); assert.equal(run().report, null, 'drafts park the run; they do not end it');
  f.setStatus(() => 'idle');
  for (let i = 0; i < 12; i++) await f.tick();
  assert.equal(run().stopped, false, 'an idle parked session is neither finished nor stalled');
  assert.ok(!f.stopped.includes(w.run.id), 'nor archived');
  assert.equal(f.store.get(f.job.id).subJobs[0].error ?? null, null);
  assert.throws(() => f.report(completed([]), w), /Your drafts are with the human/);
  f.store.action(f.job.id, 'approve-write', { subJobId: 'post', write: { action: { text: 'Shipped the sign-in fix today' } } }); await f.tick();
  assert.deepEqual(f.mailed, [], 'one draft is still undecided');
  f.store.action(f.job.id, 'skip-write', { subJobId: 'move' }); await f.tick();
  assert.equal(f.mailed.length, 1);
  assert.equal(f.mailed[0].sid, w.sid);
  assert.match(f.mailed[0].text, /"id":"post","place":"slack","where":"#web","write":"post","text":"Shipped the sign-in fix today","approved":true/);
  assert.match(f.mailed[0].text, /Do not make: move/);
  assert.match(f.mailed[0].text, /kind:"completed".*for post, free/);
  assert.ok(run().mailedAt); await f.tick();
  assert.equal(f.mailed.length, 1, 'told once');
  assert.throws(() => f.report(completed([{ id: 'post', outcome: 'written', url: 'https://acme.slack.com/archives/C1/p1' }]), w), /still missing: free/);
  f.report(completed([{ id: 'post', outcome: 'written', url: 'https://acme.slack.com/archives/C1/p1' }, { id: 'free', outcome: 'written' }]), w);
  await f.tick(); await f.tick();
  job = f.store.get(f.job.id);
  assert.deepEqual(job.subJobs.map((s) => [s.id, s.stage]), [['n', 'done'], ['post', 'done'], ['move', 'done'], ['free', 'done']]);
  assert.deepEqual([job.subJobs[1].result.url, job.subJobs[2].result.outcome], ['https://acme.slack.com/archives/C1/p1', 'skipped']);
  assert.deepEqual(job.moves.map((m) => m.move), ['approve-write', 'skip-write']);
});

test('Writes switched to Auto with drafts waiting: release approves each without a review of its own, and the parked session is mailed once all are decided', async (t) => {
  const f = fixture(t, { ...noSessionReview, reviewWrites: true });
  await f.approve(plan([notifier('n'),
    write('post', 'n', { type: 'post', text: 'Planned post' }, { place: { type: 'slack', ref: '#web' }, storyId: undefined }),
    write('move', 'n', moveTo('In Review'), { review: true })]));
  const w = f.workerFor('n');
  f.report({ kind: 'drafts', drafts: [{ id: 'post', text: 'Shipped it' }, { id: 'move', to: 'In Review' }] }, w);
  const write_ = (id) => f.store.get(f.job.id).subJobs.find((s) => s.id === id);
  setReview(f, 'reviewWrites', false, { release: true });
  let job = f.store.get(f.job.id);
  assert.equal(job.reviewWrites, false);
  assert.deepEqual([write_('post').stage, write_('post').state, !!write_('post').writeApprovedAt], ['write', 'approved', true]);
  assert.deepEqual([write_('move').stage, write_('move').state], ['review', 'verified'], 'its own review:true beats the job default');
  assert.deepEqual(job.moves.map((m) => [m.move, m.subJobId, m.detail]), [['approve-write', 'post', 'Approved the write “Write post”'], ['set-review', null, 'Switched Writes to Auto, releasing what was waiting']]);
  await f.tick();
  assert.deepEqual(f.mailed, [], 'the parked session still has a draft with the human');
  f.store.action(f.job.id, 'approve-write', { subJobId: 'move' }); await f.tick();
  assert.equal(f.mailed.length, 1);
  assert.match(f.mailed[0].text, /"id":"post".*"text":"Shipped it","approved":true/);
  assert.match(f.mailed[0].text, /"id":"move".*"approved":true/);

  const g = fixture(t, { ...noSessionReview, reviewWrites: true });
  await g.approve(plan([notifier('n'), write('move', 'n', moveTo('In Review'))]));
  g.report({ kind: 'drafts', drafts: [{ id: 'move', to: 'In Review' }] }, g.workerFor('n'));
  g.store.action(g.job.id, 'set-review', { field: 'reviewWrites', you: false });
  assert.equal(g.store.get(g.job.id).subJobs[1].stage, 'review', 'a draft already waiting is not let through unasked');
  await g.tick();
  assert.deepEqual(g.mailed, []);
});

test('drafts landing after Writes went to Auto are approved as they land; a session launched under Auto is not made to draft when it goes back on', async (t) => {
  const f = fixture(t, { ...noSessionReview, reviewWrites: true });
  await f.approve(plan([notifier('n'),
    write('post', 'n', { type: 'post', text: 'Planned post' }, { place: { type: 'slack', ref: '#web' }, storyId: undefined }),
    write('move', 'n', moveTo('In Review'), { review: true })]));
  const w = f.workerFor('n');
  assert.match(jobPrompt(f.store.get(f.job.id), w.sub, w.run), /Review is on for post, move: do NOT make them yet/);
  setReview(f, 'reviewWrites', false);
  assert.match(jobPrompt(f.store.get(f.job.id), w.sub, w.run), /Review is on for post, move/, 'the prompt it was launched with stands');
  f.report({ kind: 'drafts', drafts: [{ id: 'post', text: 'Shipped it' }, { id: 'move', to: 'In Review' }] }, w);
  const job = f.store.get(f.job.id);
  const [post, move] = ['post', 'move'].map((id) => job.subJobs.find((s) => s.id === id));
  assert.deepEqual([post.stage, post.state, post.action.text, !!post.writeApprovedAt], ['write', 'approved', 'Shipped it', true]);
  assert.equal(move.stage, 'review');
  assert.deepEqual(job.moves.at(-1), { ...job.moves.at(-1), move: 'approve-write', subJobId: 'post', detail: 'Approved the write “Write post”: Writes is on Auto' });
  f.store.action(f.job.id, 'skip-write', { subJobId: 'move' }); await f.tick();
  assert.equal(f.mailed.length, 1, 'mailed as soon as nothing is left in review');
  assert.match(f.mailed[0].text, /Do not make: move/);

  const h = fixture(t, { ...noSessionReview, reviewWrites: true });
  await h.approve(plan([notifier('n'), write('move', 'n', moveTo('In Review'))]));
  const u = h.workerFor('n');
  setReview(h, 'reviewWrites', false);
  h.report({ kind: 'drafts', drafts: [{ id: 'move', to: 'In Review' }] }, u);
  await h.tick();
  assert.equal(h.mailed.length, 1, 'every draft approved as it landed: the session is told at once');
  assert.match(h.mailed[0].text, /"id":"move".*"approved":true/);

  const g = fixture(t, noSessionReview);
  await g.approve(plan([notifier('n'), write('move', 'n', moveTo('In Review'))]));
  const v = g.workerFor('n');
  setReview(g, 'reviewWrites', true);
  assert.doesNotMatch(jobPrompt(g.store.get(g.job.id), v.sub, v.run), /kind:"drafts"/);
  g.report(completed([{ id: 'move', outcome: 'written', from: 'To Do' }]), v);
  assert.equal(g.store.get(g.job.id).subJobs[1].stage, 'cleanup', 'what it made under Auto is not pulled back');
});

test('a parked session whose card goes away errors; until then nothing relaunches it', async (t) => {
  const f = fixture(t, { ...noSessionReview, reviewWrites: true });
  await f.approve(plan([notifier('n'), write('w', 'n', moveTo('In Review'))]));
  const w = f.workerFor('n');
  f.report({ kind: 'drafts', drafts: [{ id: 'w', to: 'In Review' }] }, w);
  f.alive.delete(w.sid); await f.tick();
  const job = f.store.get(f.job.id);
  assert.match(job.subJobs[0].error, /closed while its drafts waited for review/);
  f.store.action(f.job.id, 'retry', { subJobId: 'n' }); await f.tick();
  assert.equal(f.launched.filter((l) => l.sub?.id === 'n').length, 1, 'its draft is still the human\'s to decide');
  f.store.action(f.job.id, 'approve-write', { subJobId: 'w' }); await f.tick();
  const again = f.workerFor('n');
  assert.notEqual(again.run.id, w.run.id);
  assert.match(jobPrompt(f.store.get(f.job.id), again.sub, again.run), /"to":"In Review","approved":true/);
  assert.doesNotMatch(jobPrompt(f.store.get(f.job.id), again.sub, again.run), /kind:"drafts"/, 'an approved write is not drafted twice');
});

test('a refused write shows its place\'s error; Retry and Pick another status run its session again for it, and Mark done ends it', async (t) => {
  const f = fixture(t);
  await f.approve(plan([notifier('n'), write('w', 'n', moveTo('In Review'))]));
  f.report(completed([{ id: 'w', outcome: 'failed', error: 'Field Reviewer is required for this transition.' }]), f.workerFor('n')); await f.tick();
  let job = f.store.get(f.job.id);
  assert.deepEqual([job.subJobs[1].state, job.subJobs[1].error, job.subJobs[0].stage], ['failed', 'Field Reviewer is required for this transition.', 'review']);
  f.store.action(f.job.id, 'retry', { subJobId: 'w' }); await f.tick();
  assert.equal(f.store.get(f.job.id).subJobs[0].stage, 'session', 'its session goes back to work for it');
  f.report(completed([{ id: 'w', outcome: 'failed', error: 'Still required' }]), f.workerFor('n')); await f.tick();
  f.store.action(f.job.id, 'edit-write', { subJobId: 'w', write: { action: { to: 'QA' } } }); await f.tick();
  assert.match(jobPrompt(f.store.get(f.job.id), f.workerFor('n').sub, f.workerFor('n').run), /"to":"QA"/);
  f.report(completed([{ id: 'w', outcome: 'failed', error: 'No' }]), f.workerFor('n')); await f.tick();
  f.store.action(f.job.id, 'mark', { subJobId: 'w', position: 'done', note: 'Moved it by hand' }); await f.tick();
  job = f.store.get(f.job.id);
  assert.equal(job.subJobs[1].stage, 'done'); assert.deepEqual(job.subJobs[1].result.checks, ['Moved it by hand']);
  assert.equal(f.launched.filter((l) => l.sub?.id === 'n').length, 3);
  f.store.action(f.job.id, 'approve-session', { subJobId: 'n', sessionReceiptId: job.subJobs[0].result.receiptId }); await f.tick(); await f.tick();
  const done = fixture(t);
  await done.approve(plan([notifier('n'), write('w', 'n', moveTo('In Review'))]));
  done.report(completed([{ id: 'w', outcome: 'failed', error: 'No' }]), done.workerFor('n')); await done.tick();
  done.store.action(done.job.id, 'approve-session', { subJobId: 'n', sessionReceiptId: done.store.get(done.job.id).subJobs[0].result.receiptId }); await done.tick(); await done.tick();
  job = done.store.get(done.job.id);
  assert.equal(job.subJobs[0].stage, 'done');
  const firstResult = job.subJobs[0].result;
  done.store.action(done.job.id, 'retry', { subJobId: 'w' }); await done.tick();
  const rerun = done.workerFor('n');
  assert.equal(done.launched.filter((l) => l.sub?.id === 'n').length, 2, 'Retry reruns the finished session for the write');
  const prompt = jobPrompt(done.store.get(done.job.id), rerun.sub, rerun.run);
  assert.match(prompt, /already done/); assert.match(prompt, /only task now is to make/); assert.doesNotMatch(prompt, /^This session: /m);
  assert.match(prompt, /"id":"w"/);
  assert.equal(done.store.get(done.job.id).subJobs[0].stage, 'session');
  done.report(completed([{ id: 'w', outcome: 'written', from: 'To Do' }]), rerun); await done.tick(); await done.tick();
  job = done.store.get(done.job.id);
  assert.deepEqual([job.subJobs[0].stage, job.subJobs[0].writesOnly, job.subJobs[1].stage], ['done', undefined, 'done'], 'back to done, never to review');
  assert.deepEqual(job.subJobs[0].result, firstResult, 'it keeps the result it finished with');
});

test('an if-dropped session is dormant: it starts when its trigger is dropped and is dropped itself when it deploys; any other session on a dropped trigger can never start', async (t) => {
  const f = fixture(t);
  await f.approve(plan([spec('api'), spec('web'),
    notifier('api-wont', { sub: 'api', at: 'dropped' }), write('api-wont-w', 'api-wont', moveTo("Won't Do")),
    notifier('web-pr', { sub: 'web', at: 'pr' }), write('web-pr-w', 'web-pr', { type: 'comment', comment: 'PR {pr.url}' }),
    notifier('web-wont', { sub: 'web', at: 'dropped' }), write('web-wont-w', 'web-wont', moveTo("Won't Do"))]));
  const sessions = () => f.launched.filter((l) => l.run.phase === 'session').map((l) => l.sub.id);
  assert.deepEqual(sessions(), [], 'nothing has come yet');
  f.store.action(f.job.id, 'drop', { subJobId: 'web' }); await f.tick();
  let job = f.store.get(f.job.id);
  assert.deepEqual(sessions(), ['web-wont']);
  assert.deepEqual([job.subJobs.find((s) => s.id === 'web-pr').stage, job.subJobs.find((s) => s.id === 'web-pr-w').state], ['session', 'queued'], 'its milestone will never come: the human drops it');
  f.store.update(f.job.id, (j) => { j.subJobs[0].deployed = { checks: ['Live'] }; j.subJobs[0].stage = 'done'; });
  await f.tick(); await f.tick();
  job = f.store.get(f.job.id);
  const wont = job.subJobs.find((s) => s.id === 'api-wont');
  assert.ok(wont.cancelledAt); assert.equal(wont.notNeeded, true);
  assert.ok(job.subJobs.find((s) => s.id === 'api-wont-w').cancelledAt, 'its write goes with it');
  assert.deepEqual(sessions(), ['web-wont'], 'the landed trigger started nothing');
});

test('a session that ends without a receipt holds its writes; a pending plan change holds a milestone session from starting', async (t) => {
  const f = fixture(t);
  await f.approve(plan([spec('api'), notifier('n', { sub: 'api', at: 'started' }), write('w', 'n', moveTo('In Progress')),
    notifier('later', { sub: 'api', at: 'pr' }), write('later-w', 'later', moveTo('In Review'))]));
  f.alive.delete(f.workerFor('n').sid); await f.tick();
  let job = f.store.get(f.job.id);
  assert.match(job.subJobs[1].error, /without a receipt/); assert.equal(job.error ?? null, null);
  assert.equal(job.subJobs[2].state, 'queued');
  f.store.action(f.job.id, 'replan', { feedback: 'Also cover SSO' });
  f.report({ kind: 'published', url: PR_URL }, f.workerFor('api', 'implementation')); await f.tick();
  job = f.store.get(f.job.id);
  assert.equal(f.launched.filter((l) => l.sub?.id === 'later').length, 0, 'held: the change may still edit or drop it');
});

test('every write names the session that makes it; only a session waits on a milestone, which must be reachable; links are ordered', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const bad = (subs, message) => assert.throws(() => f.report({ kind: 'plan', plan: plan([spec('api'), sessionSpec('spike'), humanSpec('sign'), ...subs]) }), message);
  bad([write('w', null, moveTo('Done'))], /w: a write names the session sub-job that makes it \(by\)/);
  bad([write('w', 'api', moveTo('Done'))], /api is not a session sub-job, so it cannot make it/);
  bad([write('w', 'sign', moveTo('Done'))], /sign is not a session sub-job/);
  bad([write('w', 'spike', moveTo('Done'), { on: { sub: 'api', at: 'pr' } })], /a write is made by its session \(by\); put the milestone \(on\) on that session/);
  bad([write('w', 'spike', moveTo('Done'), { after: ['api'] })], /not after anything; order the session instead/);
  bad([{ ...spec('web'), on: { sub: 'api', at: 'pr' } }], /web: only a session sub-job waits for a milestone/);
  bad([{ ...humanSpec('h'), on: { sub: 'api', at: 'pr' } }], /h: only a session sub-job waits for a milestone/);
  bad([notifier('n', { sub: 'ghost', at: 'pr' })], /unknown trigger ghost/);
  bad([notifier('n', { sub: 'spike', at: 'merged' })], /spike opens no PR, so it is never merged/);
  bad([notifier('n', { sub: 'n', at: 'started' })], /not its own/);
  bad([notifier('n', { sub: 'w', at: 'started' }), write('w', 'spike', moveTo('Done'))], /not a write's/);
  bad([notifier('n', { sub: 'm', at: 'started' }), notifier('m', null, ['n'])], /must not contain cycles/);
  bad([write('w', 'spike', { type: 'transition' })], /needs a status/);
  bad([write('w', 'spike', { type: 'create', to: 'Done' })], /creating a story is the whole write/);
  bad([{ ...write('w', 'spike', { type: 'comment', comment: 'x' }), storyId: undefined }], /names the story/);
  bad([write('w', 'spike', moveTo('Done')), spec('web', ['w'])], /nothing waits on a write \(w\); wait on the session that makes it/);
  const page = write('page', 'spike', { type: 'make', what: 'Notes' }, { place: { type: 'artifact' }, storyId: undefined });
  const dm = (by, text = 'See {page.url}') => write('dm', by, { type: 'post', text }, { place: { type: 'slack', ref: '@sam' }, storyId: undefined });
  bad([page, notifier('n'), dm('n')], /dm: \{page\.url\} is made by spike, so n must wait for spike to finish \(after\)/);
  bad([page, notifier('n', { sub: 'spike', at: 'started' }), dm('n')], /must wait for spike to finish/);
  bad([write('a', 'spike', { type: 'post', text: '{b.url}' }, { place: { type: 'slack', ref: '#x' }, storyId: undefined }),
    write('b', 'spike', { type: 'post', text: '{a.url}' }, { place: { type: 'slack', ref: '#y' }, storyId: undefined })], /link each other in a circle/);
  f.report({ kind: 'plan', plan: { ...plan([spec('api'), sessionSpec('spike'), page, notifier('n', null, ['spike']), dm('n'), notifier('m', { sub: 'spike', at: 'deployed' }),
    write('dm2', 'm', { type: 'post', text: '{page.url}' }, { place: { type: 'slack', ref: '#web' }, storyId: undefined }),
    notifier('t', { sub: 'api', at: 'merged' }), write('w', 't', moveTo('Done'), { why: 'Team convention' }),
    write('same', 'spike', { type: 'post', text: 'Notes: {page.url}' }, { place: { type: 'slack', ref: '#z' }, storyId: undefined })]), workflows: { AUTH: ['To Do', 'In Review', 'Done'] } } });
  const stored = f.store.get(f.job.id).plan;
  assert.deepEqual(stored.workflows, { AUTH: ['To Do', 'In Review', 'Done'] }); assert.equal(stored.subJobs.find((s) => s.id === 'w').why, 'Team convention');
});

// --- Places ---

const place = (id, type, action, extra = {}) => ({ id, kind: 'write', title: `Write ${id}`, place: { type, ...(extra.ref ? { ref: extra.ref } : {}) }, action, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'ref')) });
const make = (id, type, by, what, extra = {}) => place(id, type, { type: 'make', what }, { by, ...extra });

test('a write goes to one place: each type takes its own actions, and a made output names the session that makes it', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const base = [spec('api'), sessionSpec('report'), humanSpec('sign')];
  const bad = (w, message, extra = []) => assert.throws(() => f.report({ kind: 'plan', plan: plan([...base, ...extra, w]) }), message);
  bad(place('w', 'slack', { type: 'post', text: 'Shipped' }, { by: 'report' }), /names its channel/);
  bad(place('w', 'slack', { type: 'transition', to: 'Done' }, { ref: '#web', by: 'report' }), /a slack write can post, make, not transition/);
  bad(place('w', 'confluence', { type: 'create', text: 'Body' }, { ref: 'WEB › Incidents', by: 'report' }), /needs a title and where it goes/);
  bad(place('w', 'artifact', { type: 'make', what: 'A chart' }), /names the session sub-job that makes it \(by\)/);
  bad(make('w', 'file', 'api', 'k6 report'), /api is not a session sub-job/);
  bad(make('w', 'file', 'sign', 'k6 report'), /sign is not a session sub-job/);
  bad(make('w', 'artifact', 'report', 'A chart', { on: { sub: 'api', at: 'pr' } }), /put the milestone \(on\) on that session/);
  bad(make('w', 'url', 'report', 'A page', { ref: 'somewhere' }), /a url is made by its session, so it has no ref/);
  bad(place('w', 'slack', { type: 'post', text: 'Page: {nope.url}' }, { ref: '#web', by: 'report' }), /\{nope\.url\} names no write in this plan/);
  bad(place('w', 'slack', { type: 'post', text: 'Fix: {api.url}' }, { ref: '#web', by: 'report' }), /\{api\.url\} names no write in this plan/);
  bad(place('w', 'slack', { type: 'post', text: 'x' }, { ref: '#web', storyId: 'story', by: 'report' }), /only a Jira write names a story/);
  bad(place('w', 'jira', { type: 'comment', comment: 'x' }, { storyId: 'story', ref: 'AUTH-1', by: 'report' }), /names its ticket through its story, not a ref/);
  f.report({ kind: 'plan', plan: { ...plan([...base, notifier('ship', { sub: 'api', at: 'deployed' }, ['report']),
    make('chart', 'artifact', 'report', 'p95 chart by endpoint'), make('k6', 'file', 'report', 'k6 HTML report'),
    make('page', 'confluence', 'report', 'Incident review', { ref: 'WEB › Incidents' }),
    place('post', 'slack', { type: 'post', text: 'Review: {page.url} for {pr.url}' }, { ref: '#web-platform', by: 'ship', review: true, why: 'The team hears about incidents here' }),
    place('note', 'confluence', { type: 'comment', text: 'Fixed in {pr.url}' }, { ref: 'https://x.atlassian.net/wiki/pages/9', by: 'ship' }),
    place('ticket', 'jira', { type: 'transition', to: 'Done' }, { storyId: 'story', by: 'ship' })]), jiraSite: 'https://x.atlassian.net' } });
  const stored = f.store.get(f.job.id).plan;
  assert.equal(stored.jiraSite, 'https://x.atlassian.net');
  assert.deepEqual(stored.subJobs.filter((s) => s.kind === 'write').map((s) => [s.id, s.place.type, s.action.type]),
    [['chart', 'artifact', 'make'], ['k6', 'file', 'make'], ['page', 'confluence', 'make'], ['post', 'slack', 'post'], ['note', 'confluence', 'comment'], ['ticket', 'jira', 'transition']]);
});

test('a session accounts for every output it makes: a link completes one, failed leaves it to retry, and a receipt that forgets one is refused', async (t) => {
  const f = fixture(t);
  await f.approve(plan([sessionSpec('report'), make('chart', 'artifact', 'report', 'p95 chart'), make('k6', 'file', 'report', 'k6 report'),
    make('page', 'confluence', 'report', 'Incident review', { ref: 'WEB › Incidents' })]));
  const worker = f.workerFor('report', 'session');
  const checks = ['Measured p95'];
  assert.throws(() => f.report({ kind: 'completed', checks }, worker), /still missing: chart, k6, page/);
  assert.throws(() => f.report(completed([{ id: 'chart', outcome: 'written', url: 'https://claude.ai/artifact/7f3c' }], checks), worker), /still missing: k6, page/);
  assert.throws(() => f.report(completed([{ id: 'chart', outcome: 'written', url: 'https://claude.ai/artifact/7f3c' }, { id: 'k6', outcome: 'written', url: 'https://example.com/k6' }, { id: 'page', outcome: 'failed', error: 'x' }], checks), worker), /k6: give the file's absolute path/);
  assert.throws(() => f.report(completed([{ id: 'chart', outcome: 'written' }, { id: 'k6', outcome: 'failed' }, { id: 'page', outcome: 'failed' }], checks), worker), /chart: say where it is/);
  assert.throws(() => f.report(completed([{ id: 'ghost', outcome: 'written', url: 'https://x' }], checks), worker), /ghost is not one of the writes this session makes/);
  assert.equal(f.store.get(f.job.id).subJobs.find((s) => s.id === 'report').stage, 'session', 'a refused receipt changes nothing');
  f.report({ kind: 'completed', checks, writes: [{ id: 'chart', outcome: 'written', url: 'https://claude.ai/artifact/7f3c', title: 'Checkout p95 by endpoint' }],
    outputs: [{ id: 'k6', missing: 'k6 was not installed on this machine' }, { id: 'page', url: 'https://x.atlassian.net/wiki/pages/42' }] }, worker);
  await f.tick();
  const job = f.store.get(f.job.id);
  const [chart, k6, page] = ['chart', 'k6', 'page'].map((id) => job.subJobs.find((s) => s.id === id));
  assert.deepEqual([chart.stage, chart.result.url, chart.result.title, chart.result.checks], ['done', 'https://claude.ai/artifact/7f3c', 'Checkout p95 by endpoint', ['Made Checkout p95 by endpoint']]);
  assert.deepEqual([k6.stage, k6.state, k6.error], ['write', 'failed', 'k6 was not installed on this machine'], 'the receipt shape of a session launched before every write lived on one still lands');
  assert.equal(page.result.url, 'https://x.atlassian.net/wiki/pages/42');
  assert.equal(job.subJobs.find((s) => s.id === 'report').stage, 'review', 'the session itself completes as usual');
  assert.throws(() => f.store.action(f.job.id, 'mark', { subJobId: 'k6', position: 'done', link: 'not a link' }), /http\(s\) URL or an absolute path/);
  f.store.action(f.job.id, 'mark', { subJobId: 'k6', position: 'done', link: '/Users/me/reports/k6.html', note: 'Ran k6 myself' }); await f.tick();
  const marked = f.store.get(f.job.id).subJobs.find((s) => s.id === 'k6');
  assert.deepEqual([marked.stage, marked.result.url, marked.result.checks], ['done', '/Users/me/reports/k6.html', ['Ran k6 myself']]);
  assert.throws(() => f.store.action(f.job.id, 'mark', { subJobId: 'report', position: 'done', link: 'https://x' }), /Only a write is marked done with where it is/);
});

test('a reviewed Slack post links the page another session made, is drafted for review, and keeps the permalink it was posted at', async (t) => {
  const f = fixture(t);
  await f.approve(plan([sessionSpec('report'), make('page', 'confluence', 'report', 'Incident review', { ref: 'WEB › Incidents' }),
    notifier('announce', null, ['report']), place('post', 'slack', { type: 'post', text: 'Review: {page.url}' }, { ref: '#web-platform', by: 'announce', review: true })]));
  f.report(completed([{ id: 'page', outcome: 'written', url: 'https://x.atlassian.net/wiki/pages/42' }], ['Wrote it']), f.workerFor('report', 'session'));
  f.store.action(f.job.id, 'approve-session', { subJobId: 'report', sessionReceiptId: f.store.get(f.job.id).subJobs[0].result.receiptId });
  await f.tick(); await f.tick();
  const w = f.workerFor('announce');
  assert.match(jobPrompt(f.store.get(f.job.id), w.sub, w.run), /"text":"Review: https:\/\/x.atlassian.net\/wiki\/pages\/42"/);
  f.report({ kind: 'drafts', drafts: [{ id: 'post', text: 'Incident review is up: https://x.atlassian.net/wiki/pages/42' }] }, w);
  assert.deepEqual(['stage', 'state'].map((k) => f.store.get(f.job.id).subJobs[3][k]), ['review', 'verified'], 'posted publicly, so it waits for the human');
  f.store.action(f.job.id, 'approve-write', { subJobId: 'post' }); await f.tick();
  assert.match(f.mailed.at(-1).text, /"text":"Incident review is up: https:\/\/x.atlassian.net\/wiki\/pages\/42","approved":true/);
  assert.throws(() => f.report(completed([{ id: 'post', outcome: 'written', url: 'slack.com/x' }]), w), /http\(s\) URL|https link/);
  f.report(completed([{ id: 'post', outcome: 'written', url: 'https://acme.slack.com/archives/C1/p1' }]), w); await f.tick();
  const post = f.store.get(f.job.id).subJobs[3];
  assert.deepEqual([post.stage, post.result.url, post.result.checks, post.result.text], ['done', 'https://acme.slack.com/archives/C1/p1', ['Posted in #web-platform'], 'Incident review is up: https://x.atlassian.net/wiki/pages/42']);
});

test('an other place is named, takes one instruction to write or a session to make it, and may say where in it', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const base = [spec('api'), sessionSpec('report')];
  const bad = (w, message) => assert.throws(() => f.report({ kind: 'plan', plan: plan([...base, w]) }), message);
  const by = { by: 'report' };
  bad(place('w', 'other', { type: 'write', text: 'Link {pr.url}' }, by), /name the place \(place.name\)/);
  bad({ ...place('w', 'slack', { type: 'post', text: 'x' }, { ref: '#web', ...by }), place: { type: 'slack', ref: '#web', name: 'Slack' } }, /only an other place is named/);
  bad({ ...place('w', 'other', { type: 'write' }, by), place: { type: 'other', name: 'Linear' } }, /say what to write there/);
  bad({ ...place('w', 'other', { type: 'write', text: 'x', title: 'T' }, by), place: { type: 'other', name: 'Linear' } }, /one instruction \(text\)/);
  bad({ ...place('w', 'other', { type: 'write', text: 'x', to: 'Done' }, by), place: { type: 'other', name: 'Linear' } }, /only a Jira write moves a ticket/);
  bad({ ...place('w', 'slack', { type: 'write', text: 'x' }, { ref: '#web', ...by }) }, /a slack write can post, make, not write/);
  bad({ ...place('w', 'other', { type: 'write', text: 'x' }, by), place: { type: 'other', name: 'x'.repeat(61) } }, /60|too_big|at most/i);
  f.report({ kind: 'plan', plan: plan([...base,
    { ...place('lin', 'other', { type: 'write', text: 'Link {pr.url}' }, by), place: { type: 'other', name: 'Linear', ref: 'ENG-12' } },
    { ...place('nowhere', 'other', { type: 'write', text: 'Add a row for {pr.title}' }, by), place: { type: 'other', name: 'Google Sheets' } },
    { ...make('sheet', 'other', 'report', 'A results sheet'), place: { type: 'other', name: 'Google Sheets', ref: 'Team drive' } }]) });
  const stored = f.store.get(f.job.id).plan.subJobs.filter((s) => s.kind === 'write');
  assert.deepEqual(stored.map((s) => [s.id, s.place, s.action.type]), [['lin', { type: 'other', name: 'Linear', ref: 'ENG-12' }, 'write'],
    ['nowhere', { type: 'other', name: 'Google Sheets' }, 'write'], ['sheet', { type: 'other', name: 'Google Sheets', ref: 'Team drive' }, 'make']]);
});

test('a write to an other place is briefed by name to its session, and an output made there may be a local path', async (t) => {
  const f = fixture(t);
  await f.approve(plan([spec('api'), sessionSpec('report'),
    { ...place('lin', 'other', { type: 'write', text: 'Link {pr.url}' }, { by: 'report' }), place: { type: 'other', name: 'Linear' } },
    { ...make('notes', 'other', 'report', 'Run notes'), place: { type: 'other', name: 'Obsidian' } }]));
  const worker = f.workerFor('report', 'session');
  const prompt = jobPrompt(f.store.get(f.job.id), worker.sub, worker.run);
  assert.match(prompt, /Other place \(`name`, at `where` when given\): do exactly the one instruction/); assert.match(prompt, /never improvise a substitute place/);
  assert.match(prompt, /"place":"other","name":"Linear","write":"write","text":"Link \(not available\)"/);
  assert.match(prompt, /- notes: Run notes — made in Obsidian with whatever tool reaches it; give its URL, or its absolute path/);
  f.report(completed([{ id: 'lin', outcome: 'written' }, { id: 'notes', outcome: 'written', url: '/Users/me/vault/run.md' }]), worker);
  const job = f.store.get(f.job.id);
  assert.deepEqual(job.subJobs.find((s) => s.id === 'lin').result.checks, ['Wrote to Linear']);
  assert.equal(job.subJobs.find((s) => s.id === 'notes').result.url, '/Users/me/vault/run.md');
});

test('writes are not reviewed by default; a job that reviews them has each drafted unless the write says review:false', async (t) => {
  const plain = fixture(t);
  assert.equal(plain.store.get(plain.job.id).reviewWrites, false);
  const f = fixture(t, { ...input, reviewWrites: true });
  assert.equal(f.store.get(f.job.id).reviewWrites, true);
  await f.approve(plan([notifier('n'), write('held', 'n', moveTo('In Progress')), write('free', 'n', moveTo('In Progress'), { review: false })]));
  const job = f.store.get(f.job.id);
  assert.deepEqual(job.subJobs.slice(1).map((s) => [s.id, s.stage, s.state]), [['held', 'write', 'queued'], ['free', 'write', 'queued']]);
  assert.match(jobPrompt(job, f.workerFor('n').sub, f.workerFor('n').run), /Review is on for held: do NOT make it yet/);
  assert.equal(job.plan.subJobs[2].review, false, 'an explicit false is kept on the plan');
});

test('a reviewed output is published by its session, then waits in review until Accept; Skip is refused', async (t) => {
  const f = fixture(t);
  await f.approve(plan([sessionSpec('report'), make('chart', 'artifact', 'report', 'p95 chart', { review: true }), make('k6', 'file', 'report', 'k6 report')]));
  assert.doesNotMatch(jobPrompt(f.store.get(f.job.id), f.workerFor('report').sub, f.workerFor('report').run), /kind:"drafts"/, 'an output has no draft');
  f.report(completed([{ id: 'chart', outcome: 'written', url: 'https://claude.ai/artifact/1', title: 'p95' }, { id: 'k6', outcome: 'written', url: '/tmp/k6.html' }], ['Measured']), f.workerFor('report', 'session'));
  await f.tick();
  let job = f.store.get(f.job.id);
  const chart = job.subJobs.find((s) => s.id === 'chart');
  assert.deepEqual([chart.stage, chart.state, chart.result.url, chart.result.checks], ['review', 'verified', 'https://claude.ai/artifact/1', ['Made p95']]);
  assert.equal(job.subJobs.find((s) => s.id === 'k6').stage, 'done', 'an unreviewed output finishes as before');
  assert.throws(() => f.store.action(f.job.id, 'skip-write', { subJobId: 'chart' }), /already made; drop it instead/);
  f.store.action(f.job.id, 'approve-write', { subJobId: 'chart' }); await f.tick();
  job = f.store.get(f.job.id);
  assert.deepEqual([job.subJobs[1].stage, job.subJobs[1].result.url], ['done', 'https://claude.ai/artifact/1']);
  assert.equal(job.moves.at(-1).detail, 'Accepted the output “Write chart”');
  assert.equal(f.launched.filter((l) => l.sub?.id === 'report').length, 1, 'no second session publishes it');
});

test('approve-write applies the review panel\'s edit to the draft in the same change: a refused edit approves nothing', async (t) => {
  const f = fixture(t);
  await f.approve(plan([notifier('n'), write('w', 'n', moveTo('In Progress'), { review: true })]));
  f.report({ kind: 'drafts', drafts: [{ id: 'w', to: 'In Progress', comment: 'Starting' }] }, f.workerFor('n'));
  const before = f.store.get(f.job.id);
  assert.throws(() => f.store.action(f.job.id, 'approve-write', { subJobId: 'w', write: { action: { to: null, comment: null } } }), /moves the ticket, comments on it, or both/);
  assert.deepEqual(f.store.get(f.job.id), before, 'nothing changed');
  f.store.action(f.job.id, 'approve-write', { subJobId: 'w', write: { action: { to: 'In Review', comment: 'Picked up' } } }); await f.tick();
  const job = f.store.get(f.job.id);
  assert.deepEqual(job.plan.subJobs[1].action, { type: 'transition', to: 'In Review', comment: 'Picked up' });
  assert.deepEqual(job.subJobs[1].draft.comment, 'Starting', 'what the session drafted stays on record');
  assert.match(f.mailed.at(-1).text, /"to":"In Review","comment":"Picked up","approved":true/);
  assert.equal(job.moves.at(-1).detail, 'Approved the write “Write w” with edits');
});

test('a reviewed story create is drafted by its session, where its story is edited and then created', async (t) => {
  const f = fixture(t, { ...input, reviewWrites: true });
  await f.approve(plan([{ ...spec('web'), storyId: 'audit' }], [{ id: 'audit', project: 'SEC', title: 'Sign-ins are audited', fields: [{ name: 'Components', value: 'Auth' }] }]));
  let job = f.store.get(f.job.id);
  assert.deepEqual([job.subJobs[1].id, job.subJobs[1].stage, job.subJobs[1].state], ['create-audit', 'write', 'queued']);
  f.report({ kind: 'drafts', drafts: [{ id: 'create-audit', title: 'Sign-ins are audited, every one', fields: [{ name: 'Components', value: 'Auth' }, { name: 'Labels', value: 'audit' }] }] }, f.workerFor('stories'));
  job = f.store.get(f.job.id);
  assert.deepEqual([job.subJobs[1].stage, job.plan.stories[0].title, job.plan.stories[0].fields.length], ['review', 'Sign-ins are audited, every one', 2]);
  assert.throws(() => f.store.action(f.job.id, 'edit-write', { subJobId: 'create-audit', write: { story: { fields: [{ name: 'Summary', value: 'x' }] } } }), /the title is the summary/);
  assert.throws(() => f.store.action(f.job.id, 'edit-write', { subJobId: 'create-audit', write: { on: { sub: 'web', at: 'pr' } } }), /Unrecognized key/);
  f.store.action(f.job.id, 'approve-write', { subJobId: 'create-audit', write: { story: { title: 'Audit every sign-in', fields: [{ name: 'Issue Type', value: 'Story' }] } } }); await f.tick();
  job = f.store.get(f.job.id);
  assert.deepEqual(job.plan.stories[0], { id: 'audit', project: 'SEC', title: 'Audit every sign-in', fields: [{ name: 'Issue Type', value: 'Story' }] });
  assert.equal(job.subJobs[1].title, 'Create story: Audit every sign-in');
  assert.match(f.mailed.at(-1).text, /"story":"Audit every sign-in","project":"SEC","fields":\[\{"name":"Issue Type","value":"Story"\}\]/);
  assert.doesNotMatch(f.mailed.at(-1).text, /Components/);
});

test('dropping a session drops the writes it would have made', async (t) => {
  const f = fixture(t);
  await f.approve(plan([sessionSpec('report'), make('chart', 'artifact', 'report', 'p95 chart'), write('w', 'report', moveTo('Done'))]));
  f.store.action(f.job.id, 'drop', { subJobId: 'report' }); await f.tick(); await f.tick();
  const [chart, w] = f.store.get(f.job.id).subJobs.slice(1);
  assert.ok(chart.cancelledAt); assert.equal(chart.stage, 'done');
  assert.ok(w.cancelledAt);
});

test('a version-3 file migrates its Jira writes to writes to a Jira place, then fails them as predating session-owned writes', () => {
  const p = plan([spec('api'), { id: 'w', kind: 'jira', title: 'In Review', storyId: 'story', after: [], on: { sub: 'api', at: 'pr' }, action: { type: 'transition', to: 'In Review' } }]);
  const data = migrateJobs({ version: 3, settings: { concurrency: 2, maxRepairs: 2, deploymentStaleMinutes: 30, paused: false }, jobs: [{
    id: 'job_v3', title: 'Old', intent: 'x', repos: [], revision: 1, paused: false, moves: [], stage: 'active', plan: structuredClone(p), previousPlan: structuredClone(p),
    subJobs: [{ ...spec('api'), stage: 'pr', state: 'watching', sessions: [], repairs: [] }, { ...p.subJobs[1], stage: 'jira', state: 'writing', jiraKey: 'AUTH-123', sessions: [], repairs: [] }],
    runs: [{ id: 'run_w', subJobId: null, phase: 'jira', writes: ['w'], sessionId: 'sid', stopped: false, report: null }] }] });
  const [job] = data.jobs;
  assert.equal(data.version, 5);
  for (const list of [job.subJobs, job.plan.subJobs, job.previousPlan.subJobs]) assert.deepEqual([list[1].kind, list[1].place], ['write', { type: 'jira' }]);
  assert.deepEqual([job.subJobs[1].stage, job.subJobs[1].state, job.subJobs[1].error], ['write', 'failed', 'This write predates session-owned writes; drop it or redo it by hand']);
  assert.equal(job.subJobs[0].kind, undefined, 'a PR is untouched');
  assert.equal(job.runs[0].phase, 'write');
});

test('a version-4 file: an in-flight milestone write is failed, never run; its writer run stops quietly; a plan awaiting approval is left alone; the job still moves', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-v4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.json');
  const legacy = (id, extra = {}) => ({ id, kind: 'write', place: { type: 'jira' }, title: `Write ${id}`, storyId: 'story', after: [], on: { sub: 'api', at: 'pr' }, action: moveTo('In Review'), ...extra });
  const p = plan([spec('api'), spec('web'), legacy('w'), legacy('gone')]);
  const base = { title: 'Old', intent: 'x', repos: ['/repo'], revision: 3, paused: false, moves: [], reviewSessions: false };
  const live = (s, extra) => ({ ...s, sessions: [], repairs: [], jiraKey: 'AUTH-123', ...extra });
  const raw = { version: 4, settings: { concurrency: 4, maxRepairs: 2, deploymentStaleMinutes: 30, paused: false }, jobs: [
    { ...base, id: 'job_live', stage: 'active', plan: structuredClone(p),
      subJobs: [live(spec('api'), { stage: 'pr', state: 'watching', pr: { url: PR_URL } }), live(spec('web'), { stage: 'implementation', state: 'queued' }),
        live(p.subJobs[2], { stage: 'write', state: 'writing' }), live(p.subJobs[3], { stage: 'done', state: 'done', result: { checks: ['Moved'] } })],
      runs: [{ id: 'run_w', subJobId: null, phase: 'write', writes: ['w'], sessionId: 'sid_w', startedAt: 1, stopped: false, report: null }] },
    { ...base, id: 'job_planning', stage: 'planning', plan: structuredClone(p), subJobs: [], runs: [] },
  ] };
  fs.writeFileSync(file, JSON.stringify(raw));
  const store = new JobStore(file);
  let job = store.get('job_live');
  const w = job.subJobs.find((s) => s.id === 'w');
  assert.deepEqual([w.stage, w.state, w.error], ['write', 'failed', 'This write predates session-owned writes; drop it or redo it by hand']);
  assert.deepEqual(job.subJobs.find((s) => s.id === 'gone').state, 'done', 'a write that already landed stays landed');
  assert.deepEqual([job.plan.subJobs[2].on, job.plan.subJobs[2].by], [{ sub: 'api', at: 'pr' }, undefined], 'the plan is the record and is not rewritten');
  assert.deepEqual(store.get('job_planning').plan.subJobs[2].on, { sub: 'api', at: 'pr' });
  assert.throws(() => store.report('sid_w', 'run_w', { kind: 'blocked', summary: 'x' }), /predates session-owned writes/);
  assert.throws(() => store.action('job_live', 'retry', { subJobId: 'w' }), /predates session-owned writes; drop it or redo it by hand/);
  assert.throws(() => store.action('job_live', 'edit-write', { subJobId: 'w', write: { action: { to: 'Done' } } }), /predates session-owned writes/);
  const stopped = [];
  const runner = new JobRunner({ store, github: { async pr() { return { state: 'OPEN', checkStatus: 'pending', head: 'h' }; }, async comments() { return normaliseComments(resource(), 0); }, async deploys(s, o) { return { head: o.head, expected: true, workflows: [], summary: '' }; } },
    runtime: { async stop(r) { stopped.push(r.id); }, async isAlive() { return true; }, async exists() { return true; }, async launch(j, s, r, prepared) { prepared(`sid-${r.id}`); }, async cleanup() {}, async cleanupPlanning() {}, releaseImages() {}, attributeSpend() {} } });
  await runner.tick();
  job = store.get('job_live');
  assert.deepEqual(stopped, ['run_w']); assert.equal(job.runs[0].stopped, true);
  assert.equal(job.error ?? null, null, 'the writer run stopped quietly');
  assert.ok(!job.runs.some((r) => r.phase === 'write' && !r.stopped), 'and nothing launches a writer again');
  store.action('job_live', 'reorder', { subJobId: 'api', after: ['web'] });
  assert.deepEqual(store.get('job_live').subJobs[0].after, ['web'], 'a move still validates the plan around the legacy write');
  store.action('job_live', 'drop', { subJobId: 'w' });
  assert.ok(store.get('job_live').subJobs.find((s) => s.id === 'w').cancelledAt);
  assert.throws(() => store.approvePlan('job_planning', 3), /names the session sub-job that makes it/, 'an unapproved plan is judged afresh on approval');
});

test('a version-2 job waiting in the old ticketing stage migrates to a running job whose stories session creates the story; the old ticketing run stops quietly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.json');
  const p = plan([spec('api'), { ...spec('web'), storyId: 'audit' }], [{ id: 'story', key: 'AUTH-1', title: 'Sign-in' }, { id: 'audit', project: 'SEC', title: 'Audit' }]);
  const base = { title: 'Old', intent: 'x', repos: ['/repo'], revision: 3, paused: false, moves: [] };
  fs.writeFileSync(file, JSON.stringify({ version: 2, settings: { concurrency: 2, maxRepairs: 2, deploymentStaleMinutes: 30, paused: false }, jobs: [
    { ...base, id: 'job_ticketing', stage: 'jira', plan: structuredClone(p), subJobs: [], runs: [{ id: 'run_t', subJobId: null, phase: 'jira', sessionId: 'sid', stopped: false, report: null }] },
    { ...base, id: 'job_running', stage: 'active', plan: structuredClone(p), runs: [],
      subJobs: [{ ...spec('api'), stage: 'implementation', state: 'queued', jiraKey: 'AUTH-1', sessions: [], repairs: [] }, { ...spec('web'), storyId: 'audit', stage: 'implementation', state: 'queued', jiraKey: null, sessions: [], repairs: [] }] },
  ] }));
  const store = new JobStore(file);
  for (const id of ['job_ticketing', 'job_running']) {
    const job = store.get(id);
    assert.equal(job.stage, 'active', id);
    assert.deepEqual(job.subJobs.map((s) => [s.id, s.stage, s.state]).sort(), [['api', 'implementation', 'queued'], ['create-audit', 'write', 'queued'], ['stories', 'session', 'queued'], ['web', 'implementation', 'queued']], id);
    assert.deepEqual(job.plan.subJobs.find((s) => s.id === 'create-audit').by, 'stories');
  }
  assert.equal(store.get('job_ticketing').runs[0].phase, 'write', 'the ticketing run is the old batched writer, stopped by the runner like one');
});

test('a plan carries no branch names: only the renaming session\'s own sub-job follows', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  const [api, web] = f.launched.slice(1);
  assert.equal(f.sub().worktree.branch, 'branch-api', 'launched on the placeholder');
  assert.equal(f.store.noteBranchRename('session-nobody', 'fix/AUTH-123-x'), false);
  assert.equal(f.store.noteBranchRename(api.sid, 'fix/AUTH-123-reliable-sign-in'), true);
  const job = f.store.get(f.job.id);
  assert.deepEqual(job.subJobs.map((s) => s.worktree.branch), ['fix/AUTH-123-reliable-sign-in', 'branch-web']);
  assert.equal(job.subJobs[0].worktree.path, '/worktree/api');
  assert.equal(f.store.noteBranchRename(web.sid, 'fix/AUTH-123-web'), true);
});

// --- Comments ---

test('PR comments are read with every poll, triaged once per comment set and shaded on the sub-job', async (t) => {
  const f = fixture(t); await atPr(f);
  await f.tick(); await f.runner.idle();
  assert.equal(f.sub().prComments.items.length, 0); assert.equal(f.sub().commentSummary, null); assert.deepEqual(f.triaged, []);
  f.setComments(resource({ reviews: [{ ...node('r1', 'alice', 'Looks good', '2026-09-08T10:00:00Z'), state: 'APPROVED', submittedAt: '2026-09-08T10:00:00Z' }],
    comments: [node('c1', 'coverage-bot', 'Coverage 91%', '2026-09-08T10:00:05Z', { bot: true })] }));
  await f.tick(); await f.runner.idle();
  const sub = f.sub();
  assert.equal(sub.prComments.items.length, 2); assert.equal(sub.prComments.items[1].bot, true);
  assert.equal(sub.commentSummary.tone, 'green'); assert.equal(sub.commentSummary.fingerprint, sub.prComments.fingerprint);
  assert.deepEqual(f.attributed, ['live-triage'], 'the triage spend is billed to the sub-job session');
  await f.tick(); await f.runner.idle();
  assert.equal(f.triaged.length, 1, 'an unchanged comment set is not re-triaged');
});

test('a red verdict holds automatic merging until the head is approved; amber and green merge', async (t) => {
  const thread = (resolved) => resource({ threads: [{ id: 't1', resolved, comments: [node('tc1', 'bob', 'This drops the auth check; do not merge', '2026-09-08T10:00:00Z')] }] });
  for (const tone of ['red', 'amber', 'green']) {
    const f = fixture(t); await atPr(f);
    f.setVerdict(async () => ({ tone, text: `${tone} verdict`, liveSessionId: `live-${tone}` }));
    f.setComments(thread(false)); f.setPr({ checkStatus: 'passing' });
    await f.tick(); assert.equal(f.merged.length, 0, `${tone}: the verdict is still being written on the first poll`);
    await f.runner.idle(); await f.tick();
    assert.equal(commentsBlockMerge(f.sub()), tone === 'red');
    assert.equal(f.merged.length, tone === 'red' ? 0 : 1, tone);
    if (tone !== 'red') continue;
    f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
    await f.tick(); assert.deepEqual(f.merged, ['head1'], 'an explicit approval overrides the hold');
  }
});

test('a failed triage is an amber unavailable verdict that never blocks merging', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setVerdict(async () => { throw new Error('claude exited 1'); });
  f.setComments(resource({ comments: [node('c1', 'alice', 'Question?', '2026-09-08T10:00:00Z')] })); f.setPr({ checkStatus: 'passing' });
  await f.tick(); await f.runner.idle();
  const sub = f.sub();
  assert.equal(sub.commentSummary.tone, 'amber'); assert.equal(sub.commentSummary.error, true); assert.match(sub.commentSummary.text, /unavailable/);
  await f.tick(); assert.deepEqual(f.merged, ['head1']);
});

test('a comments read failure is an observation error that keeps the previous PR evidence', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ checkStatus: 'passing' });
  f.store.update(f.job.id, (j) => { j.reviewMerge = true; });
  await f.tick(); assert.equal(f.sub().pr.head, 'head1');
  f.github.comments = async () => { throw new Error('GraphQL rate limited'); };
  await f.tick();
  assert.match(f.sub().observationError, /rate limited/); assert.equal(f.sub().pr.head, 'head1'); assert.equal(f.merged.length, 0);
});

test('manual merge approval is bound to the exact head a push invalidates', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'published', url: PR_URL });
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  assert.throws(() => f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'older' }), /green/);
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
  f.setPr({ head: 'head2' }); await f.tick(); assert.equal(f.merged.length, 0);
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head2' });
  await f.tick(); assert.deepEqual(f.merged, ['head2']);
});

test('with session review off a completed session goes straight to done; request changes reruns it with feedback', async (t) => {
  const f = fixture(t, { ...input, reviewSessions: false });
  await f.approve(plan([sessionSpec('spike')]));
  f.report({ kind: 'completed', checks: ['Done'] }); await f.tick();
  assert.equal(f.sub().stage, 'done'); assert.equal(f.store.get(f.job.id).stage, 'done');

  const g = fixture(t);
  await g.approve(plan([sessionSpec('spike')]));
  g.report({ kind: 'completed', checks: ['Done'] }); await g.tick();
  assert.throws(() => g.store.action(g.job.id, 'revise-session', { subJobId: 'spike' }), /Explain/);
  g.store.action(g.job.id, 'revise-session', { subJobId: 'spike', feedback: 'Also check staging' });
  assert.equal(g.sub().stage, 'session'); assert.equal(g.sub().result, null);
  await g.tick();
  assert.equal(g.last().run.phase, 'session'); assert.equal(g.last().sub.feedback, 'Also check staging');
  g.report({ kind: 'completed', checks: ['Staging checked'] }); await g.tick();
  assert.equal(g.sub().stage, 'review'); assert.equal(g.sub().feedback, null);
  g.store.action(g.job.id, 'approve-session', { subJobId: 'spike', sessionReceiptId: g.sub().result.receiptId });
  assert.deepEqual(g.store.get(g.job.id).moves.map((m) => [m.subJobId, m.move, m.note]),
    [['spike', 'revise-session', 'Also check staging'], ['spike', 'approve-session', null]], 'approvals and requests are on the same timeline as the plan moves');
});

test('with plan review off the plan receipt approves itself; a keyless story is still created by its own session first and a replan still waits', async (t) => {
  const f = fixture(t, { ...input, reviewPlan: false });
  assert.equal(f.store.get(f.job.id).reviewPlan, false);
  f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan() });
  let job = f.store.get(f.job.id);
  assert.equal(job.stage, 'active'); assert.ok(job.approvedAt); assert.equal(job.subJobs[0].id, 'api');
  await f.tick();
  assert.equal(f.last().run.phase, 'implementation');
  f.store.action(f.job.id, 'replan', { feedback: 'Split the API change' }); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('more')]) }); await f.tick();
  job = f.store.get(f.job.id);
  assert.ok(job.replan.proposal, 'a replan is a proposal the human approves'); assert.deepEqual(job.subJobs.map((s) => s.id), ['api']);

  const g = fixture(t, { ...input, reviewPlan: false });
  g.store.action(g.job.id, 'start'); await g.tick();
  g.report({ kind: 'plan', plan: plan([spec('api')], [{ id: 'story', title: 'Reliable sign-in' }]) });
  assert.equal(g.store.get(g.job.id).stage, 'active');
  assert.deepEqual(g.store.get(g.job.id).subJobs.map((s) => s.id), ['stories', 'create-story', 'api']);
  await g.tick();
  assert.deepEqual([g.last().run.phase, g.last().sub.id], ['session', 'stories'], 'the sub-job naming the story waits for its key');

  const h = fixture(t, { ...input, reviewPlan: false });
  h.store.action(h.job.id, 'start'); await h.tick();
  assert.throws(() => h.report({ kind: 'plan', plan: plan([spec('api', ['missing'])]) }));
  assert.equal(h.store.get(h.job.id).stage, 'planning', 'an invalid plan approves nothing');
});

test('jobs created before plan review was optional still stop for approval', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.get(f.job.id).reviewPlan, true);
  f.store.update(f.job.id, (j) => { delete j.reviewPlan; });
  f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan() }); await f.tick();
  assert.equal(f.store.get(f.job.id).stage, 'planning');
});

// --- MCP and control ---

// Both halves in the EXTENSION signatures: a tool is `handler({ host, caller }, args)`
// and a control handler is `handler(msg, host)`, so core's `deps` and `ctx.reply`
// are gone — `host.stores.jobs`, `host.rebuild()` and `host.broadcast()` stand in
// (server/tools.js, server/handlers.js). The launch allowlist assertions went with
// them: an extension tool is registered and granted in the argv from one list, so
// there is no second place left to drift.
function fakeHost(f) {
  const host = { stores: { jobs: f.store }, sessions: { get: () => null }, rebuilds: 0, broadcasts: [], log: () => {},
    rebuild: async () => { host.rebuilds++; }, broadcast: (p) => host.broadcasts.push(p) };
  return host;
}
// The runner is a per-process singleton built from the first façade it sees, and a
// handler kicks it; stub its tick so a control test never reaches a real launch.
function stubRunner(t, host) {
  _resetForTests();
  t.after(_resetForTests);
  let ticks = 0;
  runnerFor(host).tick = async () => { ticks++; };
  return () => ticks;
}

test('MCP receipts and context are caller-bound and carry the job and run only', async (t) => {
  const f = fixture(t); await f.approve(); const w = f.last();
  const host = fakeHost(f);
  assert.equal((await getJobContextTool.handler({ host, caller: 'other' }, {})).structuredContent.job, null);
  const ctx = (await getJobContextTool.handler({ host, caller: w.sid }, {})).structuredContent;
  assert.deepEqual(Object.keys(ctx).sort(), ['job', 'run']);
  assert.equal(ctx.run.id, w.run.id); assert.equal(ctx.job.plan.context, plan().context);
  const report = { kind: 'published', url: PR_URL };
  assert.equal((await jobReportTool.handler({ host, caller: 'other' }, { runId: w.run.id, report })).isError, true);
  const amended = await jobReportTool.handler({ host, caller: w.sid }, { runId: w.run.id, report: { kind: 'blocked', summary: 's', amendment: { reason: 'r', ops: [] } } });
  assert.equal(amended.isError, true); assert.match(amended.content[0].text, /amendment/);
  assert.equal((await jobReportTool.handler({ host, caller: w.sid }, { runId: w.run.id, report })).structuredContent.accepted, true);
  assert.equal(f.sub().stage, 'pr');
  assert.equal(host.rebuilds, 1, 'only an accepted receipt rebuilds the board');
  const suggested = fixture(t);
  await suggested.approve();
  const s = suggested.last();
  await jobReportTool.handler({ host: fakeHost(suggested), caller: s.sid },
    { runId: s.run.id, report: { kind: 'blocked', summary: 'The proto is out of date', move: 'split-out' } });
  assert.equal(suggested.sub().blocked.move, 'split-out');
  const drafting = fixture(t, { ...input, reviewWrites: true });
  await drafting.approve(plan([notifier('n'), write('w', 'n', moveTo('In Review'))]));
  const d = drafting.workerFor('n');
  const parked = await jobReportTool.handler({ host: fakeHost(drafting), caller: d.sid }, { runId: d.run.id, report: { kind: 'drafts', drafts: [{ id: 'w', to: 'In Review' }] } });
  assert.match(parked.structuredContent.next, /^End your turn and wait: mail will say which writes to make/, 'drafts do not end the run');
});

test('job-create acknowledges the creation by broadcast and kicks the runner when it starts one', async (t) => {
  const f = fixture(t);
  const host = fakeHost(f);
  const ticks = stubRunner(t, host);
  await jobCreateHandler.handler({ job: input }, host);
  assert.equal(host.broadcasts[0].event, 'job-created'); assert.equal(host.broadcasts[0].started, false);
  assert.equal(f.store.get(host.broadcasts[0].jobId).stage, 'backlog');
  assert.equal(ticks(), 0, 'a backlogged job waits for a human');
  await jobCreateHandler.handler({ job: input, start: true }, host);
  assert.equal(host.broadcasts[1].event, 'job-created'); assert.equal(host.broadcasts[1].started, true);
  assert.equal(f.store.get(host.broadcasts[1].jobId).stage, 'planning', 'the main action skips the backlog');
  assert.equal(ticks(), 1, 'the runner is kicked so planning launches without waiting for the next sweep');
});

test('a job created without a title starts under its description and takes the generated one when Haiku answers', async (t) => {
  const f = fixture(t);
  const host = fakeHost(f); const billed = [];
  host.sessions.bill = (sid, live) => billed.push([sid, live]);
  stubRunner(t, host);
  let answer;
  const handler = makeJobCreateHandler({ run: () => new Promise((resolve) => { answer = resolve; }) });
  await handler.handler({ job: { intent: 'Customers can sign in reliably\nwith SSO' } }, host);
  const id = host.broadcasts[0].jobId;
  assert.equal(host.broadcasts[0].event, 'job-created', 'the create does not wait for a title');
  assert.equal(f.store.get(id).title, 'Customers can sign in reliably');
  const { revision } = f.store.get(id); const rebuilds = host.rebuilds;
  answer({ text: 'Reliable SSO sign-in', liveSessionId: 'live-1', error: null });
  await new Promise(setImmediate);
  assert.equal(f.store.get(id).title, 'Reliable SSO sign-in');
  assert.equal(f.store.get(id).revision, revision, 'a title is not a plan revision');
  assert.equal(host.rebuilds, rebuilds + 1);
  assert.deepEqual(billed, [], 'no card yet, so nothing to bill');
});

test('a failed title generation keeps the fallback, and a supplied title is never regenerated', async (t) => {
  const f = fixture(t);
  const host = fakeHost(f);
  stubRunner(t, host);
  let calls = 0;
  const handler = makeJobCreateHandler({ run: async () => { calls++; return { text: null, liveSessionId: 'live-1', error: new Error('boom') }; } });
  await handler.handler({ job: { intent: 'Make sign-in reliable' } }, host);
  await new Promise(setImmediate);
  assert.equal(f.store.get(host.broadcasts[0].jobId).title, 'Make sign-in reliable');
  await handler.handler({ job: input }, host);
  await new Promise(setImmediate);
  assert.equal(calls, 1); assert.equal(f.store.get(host.broadcasts[1].jobId).title, 'Reliable sign-in');
});

test('a generated title replaces only the title it was generated for', (t) => {
  const f = fixture(t);
  const job = f.store.create({ intent: 'Make sign-in reliable' });
  assert.equal(f.store.retitle(job.id, 'Something else', 'Generated'), false);
  assert.equal(f.store.retitle(job.id, job.title, 'Generated'), true);
  assert.equal(f.store.get(job.id).title, 'Generated');
});

test('an invalid job-settings patch is refused and leaves the settings alone', async (t) => {
  const f = fixture(t);
  const host = fakeHost(f);
  // Core replied `{type:'error'}`; with no reply channel a throw is the whole
  // answer, and the wrangler's router is what reports it.
  await assert.rejects(jobSettingsHandler.handler({ patch: { concurrency: 0 } }, host));
  assert.equal(f.store.snapshot().settings.concurrency, 8);
  assert.equal(host.rebuilds, 0, 'a refused patch does not rebuild');
  await jobSettingsHandler.handler({ patch: { concurrency: 4 } }, host);
  assert.equal(f.store.snapshot().settings.concurrency, 4);
});

test('a move arrives as a job-action with its own fields and reaches the store whole', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  const host = fakeHost(f);
  stubRunner(t, host);
  await jobActionHandler.handler({ id: f.job.id, subJobId: 'api', action: 'split-out',
    title: 'Sync the proto', brief: 'Regenerate the proto', position: 'after', note: 'small one' }, host);
  assert.deepEqual(host.broadcasts, [{ event: 'job-action-complete', jobId: f.job.id, action: 'split-out', subJobId: 'api' }]);
  assert.deepEqual(f.store.get(f.job.id).subJobs.map((s) => s.id), ['api', 'api-2']);
});

test('a refused job-action is broadcast with its reason instead of thrown, so the footer can snap back', async (t) => {
  const f = fixture(t); await f.approve();
  const host = fakeHost(f); const ticks = stubRunner(t, host);
  await jobActionHandler.handler({ id: f.job.id, action: 'set-review', field: 'reviewPlan', you: false }, host);
  assert.deepEqual(host.broadcasts, [{ event: 'job-action-failed', jobId: f.job.id, action: 'set-review', field: 'reviewPlan', error: 'The plan is already approved. A replan always waits for you' }]);
  assert.equal(host.rebuilds, 0); assert.equal(ticks(), 0);
  await jobActionHandler.handler({ id: f.job.id, action: 'set-review', field: 'reviewMerge', you: false }, host);
  assert.deepEqual(host.broadcasts.at(-1), { event: 'job-action-complete', jobId: f.job.id, action: 'set-review' });
  assert.equal(f.store.get(f.job.id).reviewMerge, false);
});

test('starting a HUMAN task identifies its reply so the client can keep a draft open', async (t) => {
  const f = fixture(t); await f.approve(plan([humanSpec('key')]));
  const host = fakeHost(f); stubRunner(t, host);
  await jobActionHandler.handler({ id: f.job.id, subJobId: 'key', action: 'start-human' }, host);
  assert.deepEqual(host.broadcasts, [{ event: 'job-action-complete', jobId: f.job.id, action: 'start-human', subJobId: 'key' }]);
});

test('get_job_context includes only completed direct HUMAN output for its assigned worker', async (t) => {
  const f = fixture(t); await f.approve(plan([humanSpec('key'), humanSpec('other'), spec('api', ['key'])]));
  f.store.action(f.job.id, 'finish-human', { subJobId: 'key', output: 'ssh-ed25519 AAAA' });
  f.store.action(f.job.id, 'finish-human', { subJobId: 'other', output: 'unrelated-secret' });
  await f.tick();
  const worker = f.workerFor('api', 'implementation');
  const ctx = (await getJobContextTool.handler({ host: fakeHost(f), caller: worker.sid }, {})).structuredContent;
  assert.equal(ctx.job.subJobs.find((s) => s.id === 'key').result.output, 'ssh-ed25519 AAAA');
  assert.equal(ctx.job.subJobs.find((s) => s.id === 'other').result.output, undefined);
  assert.equal(f.store.get(f.job.id).subJobs.find((s) => s.id === 'other').result.output, 'unrelated-secret', 'projection must not rewrite the store');
});

// --- GitHub observation ---

const rawPr = { url: PR_URL, state: 'OPEN', headRefName: 'branch-api', headRefOid: 'head1', baseRefName: 'main', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'tests', conclusion: 'SUCCESS' }] };
const reviewRequiredPr = { ...rawPr, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE' };
function reviewGithub(raw = reviewRequiredPr, { classic = { contexts: ['tests'] }, rules = [], runs = [] } = {}) {
  const calls = [];
  const gh = new JobGithub(async (_bin, args) => {
    calls.push(args);
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'org/repo' });
    if (args[0] === 'pr') return JSON.stringify(raw);
    if (args[1].includes('/rules/branches/')) return JSON.stringify([rules]);
    if (args[1].includes('/check-runs?')) return JSON.stringify([{ check_runs: runs }]);
    if (args[1].includes('/branches/')) return JSON.stringify({ protection: { required_status_checks: classic } });
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
  const sub = { repo: '/repo', worktree: { branch: rawPr.headRefName }, pr: { url: rawPr.url, head: rawPr.headRefOid, mergeWithAdmin: true } };
  return { gh, calls, sub };
}

test('GitHub readiness never treats running, failed, draft or blocked checks as green', () => {
  assert.equal(prSummary(rawPr).checkStatus, 'passing');
  for (const patch of [{ statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }] }, { statusCheckRollup: [{ conclusion: 'FAILURE' }] }, { isDraft: true }, { mergeStateStatus: 'BLOCKED' }]) assert.notEqual(prSummary({ ...rawPr, ...patch }).checkStatus, 'passing');
});

test('required review can be overridden only with green checks and confirmed mergeability', () => {
  assert.equal(prSummary(reviewRequiredPr).checkStatus, 'passing');
  assert.equal(prSummary(reviewRequiredPr).mergeWithAdmin, true);
  for (const patch of [
    { statusCheckRollup: [] }, { statusCheckRollup: null },
    ...['IN_PROGRESS', 'QUEUED', 'WAITING', 'UNKNOWN'].map(status => ({ statusCheckRollup: [{ status, conclusion: 'SUCCESS' }] })),
    ...['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'UNKNOWN'].map(conclusion => ({ statusCheckRollup: [{ conclusion }] })),
    { statusCheckRollup: [{ context: 'legacy CI', state: 'PENDING' }] },
    { isDraft: true }, { state: 'CLOSED' }, { state: 'MERGED' },
    ...['DIRTY', 'BEHIND', 'UNKNOWN', 'UNSTABLE'].map(mergeStateStatus => ({ mergeStateStatus })),
    ...['UNKNOWN', 'CONFLICTING', undefined].map(mergeable => ({ mergeable })),
    { reviewDecision: 'CHANGES_REQUESTED' }, { reviewDecision: 'APPROVED' }, { reviewDecision: undefined },
  ]) {
    const summary = prSummary({ ...reviewRequiredPr, ...patch });
    assert.equal(summary.mergeWithAdmin, false, JSON.stringify(patch));
    assert.notEqual(summary.checkStatus, 'passing', JSON.stringify(patch));
  }
  assert.equal(prSummary({ ...reviewRequiredPr, statusCheckRollup: [{ context: 'legacy CI', state: 'SUCCESS' }] }).checkStatus, 'passing');
});

test('review override verifies missing checks from branch protection and rulesets', async () => {
  for (const policy of [
    { classic: { contexts: ['tests', 'plan'] } },
    { classic: { checks: [{ context: 'plan', app_id: null }] } },
    { rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'plan', integration_id: null }] } }] },
  ]) {
    const { gh, sub, calls } = reviewGithub(reviewRequiredPr, policy);
    const pr = await gh.pr(sub);
    assert.equal(pr.checkStatus, 'pending'); assert.equal(pr.mergeWithAdmin, false);
    assert.deepEqual(pr.checks.at(-1), { name: 'plan', state: 'PENDING' });
    await assert.rejects(gh.merge(sub), /no longer green/);
    assert.ok(!calls.some(args => args[0] === 'pr' && args[1] === 'merge'));
  }
});

test('required check app identity and commit must match before overriding review', async () => {
  const policy = { classic: { checks: [{ context: 'tests', app_id: 123 }] } };
  const run = { name: 'tests', app: { id: 123 }, head_sha: 'head1', status: 'completed', conclusion: 'success' };
  for (const runs of [[], [{ ...run, app: { id: 456 } }], [{ ...run, head_sha: 'old' }], [{ ...run, status: 'in_progress' }], [{ ...run, conclusion: 'failure' }]]) {
    const { gh, sub } = reviewGithub(reviewRequiredPr, { ...policy, runs });
    assert.equal((await gh.pr(sub)).mergeWithAdmin, false);
  }
  const { gh, sub } = reviewGithub(reviewRequiredPr, { ...policy, runs: [run] });
  assert.equal((await gh.pr(sub)).mergeWithAdmin, true);
});

test('admin merge re-observes readiness, pins the head, and drops admin when review is approved', async () => {
  for (const [raw, admin] of [[reviewRequiredPr, true], [{ ...rawPr, reviewDecision: 'APPROVED' }, false]]) {
    const { gh, sub, calls } = reviewGithub(raw);
    await gh.merge(sub);
    assert.equal(calls[0][1], 'view');
    assert.deepEqual(calls.at(-1), ['pr', 'merge', rawPr.url, '--squash', ...(admin ? ['--admin'] : []), '--match-head-commit', 'head1', '--body', 'Made with Agent Wrangler and the charlie-ps/wrangler-squared extension']);
  }
  for (const patch of [{ headRefOid: 'head2' }, { statusCheckRollup: [{ name: 'tests', conclusion: 'FAILURE' }] }, { reviewDecision: 'CHANGES_REQUESTED' }]) {
    const { gh, sub, calls } = reviewGithub({ ...reviewRequiredPr, ...patch });
    await assert.rejects(gh.merge(sub), /PR changed or checks are no longer green/);
    assert.ok(!calls.some(args => args[1] === 'merge'));
  }
});

test('an accepted-red merge re-observes the head and uses admin only where GitHub would otherwise refuse', async () => {
  const redPr = { ...rawPr, statusCheckRollup: [{ name: 'e2e', conclusion: 'FAILURE' }] };
  for (const [mergeStateStatus, admin] of [['BLOCKED', true], ['UNSTABLE', false], ['CLEAN', false], ['BEHIND', true]]) {
    const { gh, sub, calls } = reviewGithub({ ...redPr, mergeStateStatus });
    sub.pr.mergeWithAdmin = false; sub.acceptedRed = { ref: 'head1', note: null, at: 1 };
    await gh.merge(sub);
    assert.equal(calls[0][1], 'view');
    assert.deepEqual(calls.at(-1), ['pr', 'merge', rawPr.url, '--squash', ...(admin ? ['--admin'] : []), '--match-head-commit', 'head1', '--body', 'Made with Agent Wrangler and the charlie-ps/wrangler-squared extension'], mergeStateStatus);
  }
  for (const [patch, message] of [[{ headRefOid: 'head2' }, /PR changed/], [{ state: 'MERGED' }, /PR changed/], [{ mergeStateStatus: 'DIRTY' }, /merge conflicts/]]) {
    const { gh, sub, calls } = reviewGithub({ ...redPr, ...patch });
    sub.pr.mergeWithAdmin = false; sub.acceptedRed = { ref: 'head1', note: null, at: 1 };
    await assert.rejects(gh.merge(sub), message);
    assert.ok(!calls.some(args => args[1] === 'merge'));
  }
  // Accepted at an older head: the ordinary path, no override.
  const { gh, sub, calls } = reviewGithub({ ...rawPr, reviewDecision: 'APPROVED' });
  sub.pr.mergeWithAdmin = false; sub.acceptedRed = { ref: 'head0', note: null, at: 1 };
  await gh.merge(sub);
  assert.deepEqual(calls, [['pr', 'view', rawPr.url, '--json', 'body'], ['pr', 'merge', rawPr.url, '--squash', '--match-head-commit', 'head1', '--body', 'Made with Agent Wrangler and the charlie-ps/wrangler-squared extension']]);
});

test('the squash body is the PR description ending with the attribution line exactly once, whatever the repository squash setting', async () => {
  const line = 'Made with Agent Wrangler and the charlie-ps/wrangler-squared extension';
  for (const [body, expected] of [['Fix the retry.\n', `Fix the retry.\n\n${line}`], [`Fix the retry.\n\n${line}\n`, `Fix the retry.\n\n${line}`], [null, line]]) {
    const { gh, sub, calls } = reviewGithub({ ...rawPr, reviewDecision: 'APPROVED', body });
    sub.pr.mergeWithAdmin = false;
    await gh.merge(sub);
    assert.deepEqual(calls.at(-1).slice(-2), ['--body', expected]);
  }
});

test('failure to observe required checks never permits an admin merge', async () => {
  const { gh, sub, calls } = reviewGithub();
  const run = gh.run;
  gh.run = async (bin, args, cwd) => {
    if (args[0] === 'api') throw new Error('GitHub unavailable');
    return run(bin, args, cwd);
  };
  await assert.rejects(gh.pr(sub), /unavailable/);
  await assert.rejects(gh.merge(sub), /unavailable/);
  assert.ok(!calls.some(args => args[1] === 'merge'));
});

test('review override preserves manual merge approval and automatic merge behaviour', async (t) => {
  for (const reviewMerge of [true, false]) {
    const f = fixture(t, { ...input, reviewMerge }); await atPr(f);
    f.store.update(f.job.id, j => { j.reviewMerge = reviewMerge; });
    f.setPr(prSummary(reviewRequiredPr)); await f.tick();
    assert.equal(f.merged.length, reviewMerge ? 0 : 1);
    if (reviewMerge) {
      f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
      f.setPr({ head: 'head2' }); await f.tick(); assert.equal(f.merged.length, 0);
      f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head2' });
      await f.tick(); assert.deepEqual(f.merged, ['head2']);
    }
  }
});

test('pausing during the admin recheck prevents merging and leaves the merge retryable', async (t) => {
  const f = fixture(t); await atPr(f);
  const { gh, calls } = reviewGithub();
  const observe = gh.pr.bind(gh);
  gh.pr = async sub => {
    const pr = await observe(sub);
    f.store.action(f.job.id, 'pause');
    return pr;
  };
  f.github.merge = gh.merge.bind(gh);
  f.setPr(prSummary(reviewRequiredPr)); await f.tick();
  assert.ok(!calls.some(args => args[0] === 'pr' && args[1] === 'merge'));
  assert.equal(f.sub().mergeRequestedHead, undefined);
  gh.pr = observe; f.store.action(f.job.id, 'resume'); await f.tick();
  assert.equal(calls.filter(args => args[0] === 'pr' && args[1] === 'merge').length, 1);
});

test('GitHub PR observer verifies repository and worktree branch, merge pins head', async () => {
  const calls = [];
  const gh = new JobGithub(async (bin, args) => { calls.push(args); return JSON.stringify(args[0] === 'repo' ? { nameWithOwner: 'org/repo' } : rawPr); });
  const sub = { repo: '/repo', worktree: { branch: 'branch-api' }, pr: { url: rawPr.url, head: 'head1' } };
  await gh.pr(sub); await gh.merge(sub);
  assert.deepEqual(calls.at(-1).slice(-4), ['--match-head-commit', 'head1', '--body', 'Made with Agent Wrangler and the charlie-ps/wrangler-squared extension']);
  assert.ok(!calls.at(-1).includes('--admin'));
  await assert.rejects(gh.pr({ ...sub, worktree: { branch: 'other' } }), /does not belong/);
  gh.run = async (bin, args) => { calls.push(args); return JSON.stringify({ data: { resource: resource({ comments: [node('c1', 'alice', 'Nice', '2026-09-08T10:00:00Z')] }) } }); };
  const comments = await gh.comments(sub);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['api', 'graphql']); assert.ok(calls.at(-1).includes(`url=${rawPr.url}`));
  assert.equal(comments.items[0].author, 'alice'); assert.equal(comments.prAuthor, 'agent');
  gh.run = async () => JSON.stringify({ data: { resource: null } });
  await assert.rejects(gh.comments(sub), /not found/);
});

test('deployment observer discovers the runs GitHub started for the exact merge commit', async () => {
  const sub = { repo: '/repo', pr: { mergeCommit: 'merged', base: 'main' } };
  const good = { databaseId: 1, headSha: 'merged', headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success', attempt: 1, workflowName: 'Deploy' };
  const calls = [];
  const gh = new JobGithub(async (_bin, args) => { calls.push(args); return JSON.stringify([good]); });
  assert.equal((await gh.deployment(sub)).status, 'passing');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--commit') && calls[0].includes('merged'));
  assert.ok(!calls[0].includes('--workflow') && !calls[0].includes('--branch'));

  gh.run = async () => JSON.stringify([]);
  const silent = await gh.deployment(sub);
  assert.equal(silent.status, 'pending'); assert.deepEqual(silent.runs, []);

  gh.run = async () => JSON.stringify([{ ...good, headSha: 'unrelated' }]);
  assert.equal((await gh.deployment(sub)).status, 'pending', 'a run on another commit is not evidence');
  gh.run = async () => JSON.stringify([{ ...good, event: 'pull_request' }]);
  assert.equal((await gh.deployment(sub)).status, 'pending', 'the PR gate was already judged before the merge');

  gh.run = async () => JSON.stringify([good, { ...good, databaseId: 2, workflowName: 'Scan', status: 'in_progress', conclusion: '' }]);
  assert.equal((await gh.deployment(sub)).status, 'pending', 'one discovered run still in flight holds the verdict');
  gh.run = async () => JSON.stringify([good, { ...good, databaseId: 2, workflowName: 'Scan', conclusion: 'failure' }]);
  assert.equal((await gh.deployment(sub)).status, 'failing');

  gh.run = async () => JSON.stringify([{ ...good, conclusion: 'skipped' }]);
  const skipped = await gh.deployment(sub);
  assert.equal(skipped.status, 'pending'); assert.equal(skipped.runs[0].status, 'skipped');
  gh.run = async () => JSON.stringify([good, { ...good, databaseId: 2, workflowName: 'Scan', conclusion: 'skipped' }]);
  assert.equal((await gh.deployment(sub)).status, 'passing', 'a skipped sibling does not hold back a real deploy');

  gh.run = async () => JSON.stringify([{ ...good, databaseId: 9, conclusion: 'failure' }, { ...good, databaseId: 9, attempt: 2 }]);
  const rerun = await gh.deployment(sub);
  assert.equal(rerun.status, 'passing'); assert.equal(rerun.runs.length, 1);
});

test('a cancelled post-merge run is judged by the later run on the same branch that contains the merge', async () => {
  const sub = { repo: '/repo', pr: { mergeCommit: 'merged', base: 'main' } };
  const base = { headBranch: 'main', event: 'push', status: 'completed', attempt: 1, workflowName: 'Build' };
  const cancelled = { ...base, databaseId: 10, headSha: 'merged', conclusion: 'cancelled' };
  const sibling = { ...base, databaseId: 11, headSha: 'sibling', conclusion: 'success' };
  const next = { ...base, databaseId: 12, headSha: 'next', status: 'in_progress', conclusion: '' };
  let later = [next, sibling]; const calls = [];
  const gh = new JobGithub(async (_bin, args) => {
    calls.push(args);
    if (args.includes('--commit')) return JSON.stringify([cancelled]);
    if (args[0] === 'run') return JSON.stringify(later);
    return args[1].endsWith('merged...next') ? 'ahead' : 'behind';
  });
  let result = await gh.deployment(sub);
  assert.equal(result.status, 'pending', 'the replacement is still running');
  assert.deepEqual(result.runs[0], { workflow: 'Build', runId: 12, url: undefined, status: 'pending', conclusion: null, supersedes: 10, commit: 'next' });
  const list = calls.find((a) => a[0] === 'run' && a.includes('--workflow'));
  assert.deepEqual(list.slice(0, 8), ['run', 'list', '--workflow', 'Build', '--branch', 'main', '--event', 'push']);

  later = [sibling, { ...next, status: 'completed', conclusion: 'success' }];
  assert.equal((await gh.deployment(sub)).status, 'passing');
  assert.equal(calls.filter((a) => a[0] === 'api' && a[1].endsWith('merged...next')).length, 1, 'containment is asked once per pair');
  later = [{ ...next, status: 'completed', conclusion: 'failure' }];
  assert.equal((await gh.deployment(sub)).status, 'failing', 'a red build containing the merge is a red merge');

  later = [sibling];
  result = await gh.deployment(sub);
  assert.equal(result.status, 'pending', 'a run on a commit without the merge is not evidence');
  assert.equal(result.runs[0].status, 'cancelled'); assert.equal(result.runs[0].runId, 10);
  later = [{ ...next, status: 'completed', conclusion: 'cancelled' }, { ...next, databaseId: 13, headSha: 'after', status: 'completed', conclusion: 'success' }];
  gh.run = async (_bin, args) => args.includes('--commit') ? JSON.stringify([cancelled]) : args[0] === 'run' ? JSON.stringify(later) : 'ahead';
  result = await gh.deployment(sub);
  assert.equal(result.status, 'passing', 'a replacement cancelled in turn hands on to the next');
  assert.equal(result.runs[0].runId, 13);
  gh.run = async (_bin, args) => args.includes('--commit') ? JSON.stringify([cancelled, { ...cancelled, databaseId: 20, workflowName: 'Deploy', conclusion: 'success' }])
    : args[0] === 'run' ? '[]' : 'ahead';
  assert.equal((await gh.deployment(sub)).status, 'pending', 'an unreplaced cancellation holds back a green sibling');
});

// --- Changing the plan of a running job ---

test('a running job takes a plan change as a proposal: frozen work is locked, removed work is cancelled, new work held until approval', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web'), spec('docs', ['api'])]));
  const web = f.workerFor('web');
  assert.throws(() => f.store.action(f.job.id, 'replan', { feedback: ' ' }), /Explain the change/);
  f.alive.delete(f.workerFor('api').sid); await f.tick();
  f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'done' });
  f.store.action(f.job.id, 'replan', { feedback: 'Drop docs; ship a CLI after web' }); await f.tick();
  const planner = f.last();
  await f.tick();
  assert.throws(() => f.store.action(f.job.id, 'drop', { subJobId: 'docs' }), /plan change is pending/, 'a move would reshape the plan under the planner');
  assert.equal(planner.run.phase, 'planning'); assert.equal(planner.sub, null);
  assert.equal(f.launched.filter((w) => w.sub?.id === 'docs').length, 0, 'new sub-job work is held while the change is pending');
  assert.equal(f.sub(0).stage, 'done');
  const prompt = jobPrompt(f.store.get(f.job.id), null, planner.run);
  assert.match(prompt, /ALREADY RUNNING/); assert.match(prompt, /- api \(pr\) "Deliver api": done\/done · FROZEN/);
  assert.match(prompt, /Frozen \(.*\): api\./); assert.match(prompt, /- web .*a step is running/); assert.match(prompt, /Requested change: Drop docs/);
  assert.throws(() => f.store.action(f.job.id, 'replan', { feedback: 'again' }), /Wait for the planning/);

  const proposal = (subs) => plan(subs);
  assert.throws(() => f.report({ kind: 'plan', plan: proposal([{ ...spec('api'), brief: 'Redo api' }, spec('web')]) }, planner), /api has already landed/);
  assert.throws(() => f.report({ kind: 'plan', plan: proposal([spec('web'), spec('cli', ['docs'])]) }, planner), /Unknown dependency: docs/);
  assert.throws(() => f.report({ kind: 'plan', plan: proposal([{ ...spec('web'), repo: '/other' }]) }, planner), /web: repo cannot change/);
  f.report({ kind: 'plan', plan: proposal([{ ...spec('web'), title: 'Deliver web, smaller' }, spec('cli', ['web'])]) }, planner);
  let job = f.store.get(f.job.id);
  assert.deepEqual(job.plan.subJobs.map((s) => s.id), ['api', 'web', 'docs'], 'a proposal is never applied directly');
  assert.deepEqual(job.replan.proposal.changes, { frozen: ['api'], kept: [], edited: [{ id: 'web', fields: ['title'] }], added: ['cli'], removed: ['docs'] });
  await f.tick();
  assert.equal(f.launched.filter((w) => w.sub?.id === 'docs').length, 0);

  assert.throws(() => f.store.action(f.job.id, 'approve-replan', { proposalId: 'stale' }), /proposal changed/);
  assert.throws(() => f.store.action(f.job.id, 'approve-replan', { proposalId: planner.run.id }), /Wait for the running step on “Deliver web”/);
  f.report({ kind: 'ready', checks: ['Tests pass'] }, web); await f.tick();
  const ready = f.store.get(f.job.id).subJobs.find((s) => s.id === 'web').ready;
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'web', readyReceiptId: ready.receiptId }), /plan change is pending/, 'the job is frozen while the human weighs the proposal');
  f.store.action(f.job.id, 'approve-replan', { proposalId: planner.run.id });
  job = f.store.get(f.job.id);
  assert.equal(job.replan, null);
  assert.deepEqual(job.plan.subJobs.map((s) => s.id), ['api', 'web', 'docs', 'cli'], 'a cancelled sub-job stays in the plan as the record of it');
  const docs = job.subJobs.find((s) => s.id === 'docs');
  assert.ok(docs.cancelledAt); assert.equal(docs.superseded, true); assert.equal(docs.stage, 'cleanup');
  assert.equal(job.subJobs.find((s) => s.id === 'web').title, 'Deliver web, smaller');
  assert.equal(job.subJobs.find((s) => s.id === 'web').stage, 'review', 'an edit does not throw away the work');
  assert.deepEqual(job.subJobs.find((s) => s.id === 'cli'), { ...job.subJobs.find((s) => s.id === 'cli'), stage: 'implementation', state: 'queued', after: ['web'] });
  const moves = job.moves.filter((m) => /replan/.test(m.move));
  assert.deepEqual(moves.map((m) => [m.move, m.subJobId]), [['approve-replan', null], ['replan', 'web'], ['replan', 'docs'], ['replan', 'cli']]);
  assert.equal(moves[0].note, 'Drop docs; ship a CLI after web'); assert.match(moves[0].detail, /1 added, 1 edited, 1 cancelled/);
  const before = f.launched.length;
  await f.tick();
  assert.equal(f.store.get(f.job.id).subJobs.find((s) => s.id === 'docs').stage, 'done');
  assert.equal(f.launched.length, before, 'cli waits for web to deploy');
});

test('a plan change that moves a green PR behind new work reworks it, and neither the rework nor a merge runs before that work deploys', async (t) => {
  const f = fixture(t, { ...input, reviewCode: false }); await f.approve(plan([spec('api'), spec('web')]));
  f.report({ kind: 'published', url: PR_URL }, f.workerFor('web')); f.setPr({ checkStatus: 'passing' }); await f.tick();
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'web', head: 'head1' });
  f.store.action(f.job.id, 'replan', { feedback: 'Web needs the new api' }); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web', ['api'], { brief: 'Implement web on the new api' })]) }, f.last());
  f.store.action(f.job.id, 'approve-replan', { proposalId: f.last().run.id });
  const web = () => f.store.get(f.job.id).subJobs.find((s) => s.id === 'web');
  assert.equal(web().mergeApprovedHead, null);
  assert.match(web().fixRequested.note, /^Web needs the new api\n\nNew brief: Implement web on the new api$/);
  assert.equal(f.store.get(f.job.id).moves.at(-1).detail, 'Asked for a new commit on “Deliver web”');
  assert.throws(() => f.store.action(f.job.id, 'approve-merge', { subJobId: 'web', head: 'head1' }), /prerequisites/);
  await f.tick(); await f.tick();
  assert.equal(f.workerFor('web', 'repair'), undefined, 'the new brief builds on api, which has not landed');
  assert.deepEqual(f.merged, []);
  f.store.update(f.job.id, (j) => { j.subJobs[0].deployed = { at: 1, checks: ['Shipped'] }; });
  await f.tick();
  assert.ok(f.workerFor('web', 'repair'));
  assert.match(jobPrompt(f.store.get(f.job.id), web(), f.workerFor('web', 'repair').run), /the human asks: Web needs the new api/);
});

test('a pending plan change holds a green PR from merging until it is discarded', async (t) => {
  const f = fixture(t); await atPr(f);
  f.store.action(f.job.id, 'replan', { feedback: 'Rethink it' }); await f.tick();
  f.setPr({ checkStatus: 'passing' }); await f.tick(); await f.tick();
  assert.equal(f.merged.length, 0, 'merging would land work the proposal may cancel');
  assert.equal(f.sub().pr.checkStatus, 'passing', 'the PR is still watched');
  f.store.action(f.job.id, 'discard-replan'); f.store.update(f.job.id, (j) => { j.subJobs[0].nextPollAt = 0; }); await f.tick();
  assert.equal(f.merged.length, 1);
});

test('a discarded plan change stops its planner quietly and ignores a late proposal', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api')]));
  assert.throws(() => f.store.action(f.job.id, 'discard-replan'), /No plan change/);
  f.store.action(f.job.id, 'replan', { feedback: 'Smaller' }); await f.tick();
  const planner = f.last();
  f.store.action(f.job.id, 'discard-replan');
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web')]) }, planner);
  await f.tick();
  const job = f.store.get(f.job.id);
  assert.equal(job.replan, null); assert.equal(job.error ?? null, null);
  assert.deepEqual(job.plan.subJobs.map((s) => s.id), ['api']);
  assert.ok(f.stopped.includes(planner.run.id));
  assert.equal(job.moves.at(-1).move, 'discard-replan');
});

test('asking again replaces a waiting proposal and shows it to the next planner; a blocked planner is cleared by discarding', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api')]));
  f.store.action(f.job.id, 'replan', { feedback: 'Add web' }); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web')]) }); await f.tick();
  f.store.action(f.job.id, 'replan', { feedback: 'Web first' }); await f.tick();
  const second = f.last();
  assert.match(jobPrompt(f.store.get(f.job.id), null, second.run), /Your previous proposal, which the human asked to change: .*"web"/);
  f.report({ kind: 'blocked', summary: 'Cannot tell which repo' }, second); await f.tick();
  assert.equal(f.store.get(f.job.id).error, 'Cannot tell which repo');
  f.store.action(f.job.id, 'discard-replan');
  assert.equal(f.store.get(f.job.id).error, null);
});

// --- Behind base ---

const behindPr = { ...rawPr, mergeStateStatus: 'BEHIND' };

test('a green PR behind its base is flagged behind, not passing', () => {
  const s = prSummary(behindPr);
  assert.equal(s.behind, true); assert.equal(s.checkStatus, 'pending');
  assert.equal(prSummary({ ...behindPr, reviewDecision: 'REVIEW_REQUIRED' }).behind, true);
  assert.equal(prSummary({ ...behindPr, statusCheckRollup: [] }).behind, true);
  for (const patch of [{ statusCheckRollup: [{ conclusion: 'FAILURE' }] }, { statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }] }, { isDraft: true }, { reviewDecision: 'CHANGES_REQUESTED' }, { mergeStateStatus: 'CLEAN' }]) {
    assert.equal(prSummary({ ...behindPr, ...patch }).behind, false);
  }
});

test('JobGithub.updateBranch runs gh pr update-branch in the repo', async () => {
  const calls = [];
  await new JobGithub(async (bin, args, cwd) => { calls.push([bin, args, cwd]); return ''; }).updateBranch({ repo: '/repo', pr: { url: PR_URL } });
  assert.deepEqual(calls, [['gh', ['pr', 'update-branch', PR_URL], '/repo']]);
});

test('runner updates a behind PR once, backs off, keeps a prior approval across the new head', async (t) => {
  const f = fixture(t); await atPr(f);
  const updated = []; f.github.updateBranch = async (s) => { updated.push(s.pr.head); };
  f.setPr({ checkStatus: 'pending', behind: true }); await f.tick();
  f.store.update(f.job.id, (j) => { j.subJobs[0].mergeApprovedHead = 'head1'; });
  assert.deepEqual(updated, ['head1']); assert.equal(f.sub().branchUpdate.from, 'head1');
  await f.tick(); assert.deepEqual(updated, ['head1'], 'backs off while GitHub catches up');
  f.setPr({ head: 'head2', behind: false, checkStatus: 'passing' }); await f.tick();
  assert.equal(f.sub().mergeApprovedHead, 'head2'); assert.deepEqual(f.merged, ['head2']);
});

test('a head change that was not ours does not inherit the approval', async (t) => {
  const f = fixture(t); await atPr(f);
  f.store.update(f.job.id, (j) => { j.subJobs[0].mergeApprovedHead = 'head1'; });
  f.setPr({ head: 'head2', checkStatus: 'pending' }); await f.tick();
  assert.equal(f.sub().mergeApprovedHead, 'head1');
});

test('a conflicting update is treated as DIRTY and sent to repair; transient failures just retry', async (t) => {
  const f = fixture(t); await atPr(f);
  f.github.updateBranch = async () => { throw new Error('merge conflict between base and head'); };
  f.setPr({ checkStatus: 'pending', behind: true }); await f.tick();
  assert.match(f.sub().note, /conflict/);
  await f.tick();
  assert.equal(f.last().run.phase, 'repair'); assert.equal(f.sub().pr.dirty, true);
  const g = fixture(t); await atPr(g);
  g.github.updateBranch = async () => { throw new Error('network down'); };
  g.setPr({ checkStatus: 'pending', behind: true }); await g.tick(); await g.tick();
  assert.notEqual(g.last().run.phase, 'repair'); assert.equal(g.sub().branchUpdate.failedHead, undefined);
});

test('a PR that stays behind gives up after repeated updates', async (t) => {
  const f = fixture(t); await atPr(f);
  let n = 0; f.github.updateBranch = async () => { n++; };
  f.setPr({ checkStatus: 'pending', behind: true });
  for (let i = 0; i < 5; i++) { await f.tick(); await f.tick(); await f.tick(); }
  assert.equal(n, 3); assert.match(f.sub().error, /still behind/);
});

test('a job lands on its own base branch when it names one, and an old job has none', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.create(input).base, undefined, 'no base means the default branch, as before');
  assert.equal(f.store.create({ ...input, base: ' next ' }).base, 'next');
  for (const bad of ['-D', 'a b', 'a..b', 'x/', '/x', 'refs/heads/x', 'x.lock', 'x;rm']) assert.throws(() => f.store.create({ ...input, base: bad }), /branch name/, bad);
  const host = fakeHost(f);
  stubRunner(t, host);
  await jobCreateHandler.handler({ job: { ...input, base: 'release/2.x' } }, host);
  assert.equal(f.store.get(host.broadcasts[0].jobId).base, 'release/2.x');
});

test('a merge into a branch no workflow runs on is the delivery', async () => {
  const { inferDeploys } = await import('./job-deploys.js');
  const workflows = [{ file: '.github/workflows/deploy.yml', text: 'name: Deploy\non:\n  push:\n    branches: [main]\n' }];
  assert.equal(inferDeploys({ workflows, files: ['a.js'], base: 'main' }).expected, true);
  const next = inferDeploys({ workflows, files: ['a.js'], base: 'next' });
  assert.equal(next.expected, false, 'the runner then marks it MERGE_IS_DELIVERY');
  assert.match(next.summary, /Merge completes it/);
});

test('a PR may land on its own base; an old plan has none, and no other kind may name one', async () => {
  const { planSchema } = await import('./jobs-schema.js');
  const plan = (s) => ({ context: '', subJobs: [{ id: 'a', title: 'A', brief: 'b', ...s }] });
  assert.equal(planSchema.parse(plan({ repo: '/repo' })).subJobs[0].base, undefined);
  assert.equal(planSchema.parse(plan({ repo: '/repo', base: ' release/2.x ' })).subJobs[0].base, 'release/2.x');
  assert.throws(() => planSchema.parse(plan({ repo: '/repo', base: '-D' })), /branch name/);
  assert.throws(() => planSchema.parse(plan({ kind: 'session', base: 'next' })), /only a PR lands on a branch/);
});
