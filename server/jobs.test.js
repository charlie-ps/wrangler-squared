import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JobStore, migrateJobs, MERGE_IS_DELIVERY } from './job-store.js';
import { JobRunner, IDLE_RECEIPT_GRACE_MS, shortError } from './job-runner.js';
import { JobRuntime, CleanupRefused } from './job-runtime.js';
import { jobPrompt } from './job-prompts.js';
import { JobGithub, prSummary } from './job-github.js';
import { normaliseComments, commentsBlockMerge } from './job-comments.js';
import { jobCreateHandler, makeJobCreateHandler, makeJobActionHandler, jobSettingsHandler } from './handlers.js';
import { _resetForTests, runnerFor } from './jobs.js';
import { jobReportTool, getJobContextTool } from './tools.js';
import { changeView } from './job-change.js';
import { say, openConvo } from './job-talk.js';
import { requestReplan } from './job-replan.js';
import { settingsSchema } from './jobs-schema.js';
import { dropSub, validatePlan } from './job-sub-ops.js';

// Never a real Haiku run: a conversation an idea opens is named after the action.
const jobActionHandler = makeJobActionHandler({ run: async () => ({ text: null }) });

const execFileP = promisify(execFile);
const execGit = (cwd, args) => execFileP('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());
const input = { title: 'Reliable sign-in', intent: 'Customers can sign in reliably', repos: ['/repo'], reviewMerge: true };
const spec = (id, after = [], extra = {}) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', after, brief: `Implement ${id}`, ...extra });
const sessionSpec = (id, after = []) => ({ id, kind: 'session', title: `Run ${id}`, storyId: 'story', after, brief: `Do ${id} on this machine` });
const humanSpec = (id, after = []) => ({ id, kind: 'human', title: `Do ${id} yourself`, storyId: 'story', after, brief: `Click ${id} in the vendor console` });
const plan = (subs = [spec('api')], stories = [{ id: 'story', key: 'AUTH-123', title: 'Reliable sign-in' }]) =>
  ({ context: 'The sign-in service is Java; deploys are Helm.', stories, subJobs: subs });
const PR_URL = 'https://github.com/org/repo/pull/1';
// The one way an idea comes in, pinned to what is on screen right now (job-change.js
// changeView), as the board sends it.
const change = (f, subId, text = 'Take another pass', convo) => {
  const job = f.store.get(f.job.id);
  const view = changeView(job, subId ? job.subJobs.find((s) => s.id === subId) : null);
  return f.store.action(f.job.id, 'request-change', { subJobId: subId, at: view?.at, ref: view?.ref, text, ...(convo ? { convo } : {}) });
};
// What the wrangler is reading in the conversation an idea opened, before it answers or proposes.
const reading = (f) => f.store.get(f.job.id).convos.at(-1).pending;
// A change Wrangler is drawing with no ask run before it, as one dequeued or sent
// back is: the human's own ideas reach a replan only through an ask run's proposal.
const drawing = (f, text) => f.store.update(f.job.id, (j) => {
  const convo = openConvo(j, null, Date.now());
  say(j, { from: 'human', text, convo: convo.id }, Date.now());
  requestReplan(j, text, Date.now(), null, { convo: convo.id });
});
// The planner's half of an idea: it proposes `actions` on the plan as it stands,
// and the human approves that proposal.
const plannerOf = (f) => f.launched.findLast((w) => w.run.phase === 'planning' && !w.sub);
async function viaPlanner(f, subId, text, actions) {
  change(f, subId, text); await f.tick();
  const planner = plannerOf(f);
  f.report({ kind: 'plan', plan: f.store.get(f.job.id).plan, actions }, planner);
  f.store.action(f.job.id, 'approve-replan', { proposalId: planner.run.id });
}
const reworkVia = (f, subId, note = 'Take another pass') => viaPlanner(f, subId, note, [{ type: 'rework', sub: subId, note }]);
const dropIt = (f, subId) => f.store.update(f.job.id, (j) => dropSub(j.subJobs.find((s) => s.id === subId), Date.now(), j));
// Stand-ins for what a human did by hand, until proposals carry actions (design A2):
// the runner still honours these states, so its tests set them directly.
const markDone = (f, subId, note = 'Done by hand', extra = {}) => f.store.update(f.job.id, (j) => {
  const s = j.subJobs.find((x) => x.id === subId);
  const checks = [note];
  if (s.kind && s.kind !== 'pr') s.result = { checks, at: Date.now(), receiptId: null, ...extra };
  else s.deployed = { at: Date.now(), checks, commit: s.pr?.mergeCommit || null };
  s.error = null; s.blocked = null; s.stage = 'cleanup'; s.state = 'queued';
});
const acceptRed = (f, subId, note = null) => f.store.update(f.job.id, (j) => {
  const s = j.subJobs.find((x) => x.id === subId);
  if (s.stage === 'pr') { s.acceptedRed = { ref: s.pr.head, note, at: Date.now() }; s.mergeApprovedHead = s.pr.head; }
  else s.acceptedRed = { ref: s.pr?.mergeCommit || null, note, at: Date.now() };
  s.error = null; s.blocked = null; s.state = 'watching'; s.nextPollAt = 0;
});
function fixture(t, jobInput = input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  // Red handling (job-red.js) is off by default here, so a red step waits for the
  // human as these suites assume; its own tests turn it on.
  store.settings({ maxReplans: 0 });
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
  assert.equal(f.store.snapshot().version, 6);
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

test('theme defaults to Wrangler, persists across restart, keeps Space\'s plate art per theme, and rejects an unknown one', (t) => {
  const f = fixture(t);
  assert.equal(f.store.snapshot().settings.theme, 'wrangler');
  assert.deepEqual(f.store.snapshot().settings.themeOptions, { space: { plateArt: 'quiet' } });
  f.store.settings({ themeOptions: { space: { plateArt: 'full' } } }); f.store.settings({ theme: 'space' });
  const back = new JobStore(f.store.file).snapshot().settings;
  assert.equal(back.theme, 'space'); assert.equal(back.themeOptions.space.plateArt, 'full', 'an option saved while another theme was on is kept');
  assert.throws(() => f.store.settings({ theme: 'nebula' }));
  assert.throws(() => f.store.settings({ themeOptions: { space: { plateArt: 'peek' } } }), 'the old hover mode is only read from old settings');
  assert.equal(f.store.snapshot().settings.theme, 'space', 'a rejected patch changes nothing');
});

test('settings saved before themes open in the Wrangler theme, keeping Space\'s plate art for later', (t) => {
  const parse = (s) => { const { theme, themeOptions } = settingsSchema.parse(s); return { theme, themeOptions }; };
  assert.deepEqual(parse({ backdrop: 'wrangler' }), { theme: 'wrangler', themeOptions: { space: { plateArt: 'quiet' } } });
  assert.deepEqual(parse({ backdrop: 'sky', plateArt: 'full' }), { theme: 'wrangler', themeOptions: { space: { plateArt: 'full' } } });
  assert.deepEqual(parse({ plateArt: 'peek' }), { theme: 'wrangler', themeOptions: { space: { plateArt: 'quiet' } } }, 'the dropped hover mode reads as the skyline');
  assert.deepEqual(parse({}), { theme: 'wrangler', themeOptions: { space: { plateArt: 'quiet' } } }, 'settings from no earlier version get the default');
  assert.equal(parse({ backdrop: 'wrangler', theme: 'space' }).theme, 'space', 'a saved theme wins over a stale backdrop');
  const parsed = settingsSchema.parse({ backdrop: 'wrangler', plateArt: 'full' });
  assert.equal('backdrop' in parsed || 'plateArt' in parsed, false, 'the old keys are dropped');
  // The store reads jobs.json as written, so the board gets the theme before anything is saved again.
  const f = fixture(t);
  fs.writeFileSync(f.store.file, JSON.stringify({ version: 5, settings: { concurrency: 3, backdrop: 'wrangler', plateArt: 'full' }, jobs: [] }));
  const loaded = new JobStore(f.store.file).snapshot().settings;
  assert.equal(loaded.theme, 'wrangler'); assert.deepEqual(loaded.themeOptions, { space: { plateArt: 'full' } });
  assert.equal(loaded.backdrop, undefined); assert.equal(loaded.concurrency, 3);
});

test('a version-5 board on Space opens in Wrangler once; Space picked since is kept', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.store.file, JSON.stringify({ version: 5, settings: { theme: 'space', themeOptions: { space: { plateArt: 'full' } } }, jobs: [] }));
  const reset = new JobStore(f.store.file);
  assert.equal(reset.snapshot().settings.theme, 'wrangler');
  assert.deepEqual(reset.snapshot().settings.themeOptions, { space: { plateArt: 'full' } }, 'Space\'s options are kept');
  reset.settings({ theme: 'space' });
  assert.equal(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).version, 6);
  assert.equal(new JobStore(f.store.file).snapshot().settings.theme, 'space', 'the reset happens once');
  fs.writeFileSync(f.store.file, JSON.stringify({ version: 6, settings: { theme: 'space' }, jobs: [] }));
  assert.equal(new JobStore(f.store.file).snapshot().settings.theme, 'space');
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

test('a version-1 file loads as version 6: after/brief replace dependsOn/instructions and every removed field is gone', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-v1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = new JobStore(file);
  const job = store.get('job_old');
  assert.equal(store.snapshot().version, 6);
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
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 6);
  assert.throws(() => migrateJobs({ version: 7, jobs: [] }), /refusing to discard jobs/);
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

test('a human step\'s brief may run to 1000 characters and keeps its line breaks', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const brief = '1. Open https://vendor.example.com/apps\n2. Click Approve\n'.padEnd(1000, 'x');
  f.report({ kind: 'plan', plan: plan([spec('api'), { ...humanSpec('h'), brief }]) });
  assert.equal(f.store.get(f.job.id).plan.subJobs.find((s) => s.id === 'h').brief, brief);
});

test('a new plan needs context, briefs stay short, and checks belong to PRs only', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const before = f.store.snapshot();
  const { context, ...contextless } = plan();
  assert.throws(() => f.report({ kind: 'plan', plan: contextless }), /context/i);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([spec('a', [], { brief: 'x'.repeat(501) })]) }), /a: brief is over 500 characters/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...humanSpec('h'), brief: 'x'.repeat(1001) }]) }));
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
  change(f, null, 'Move this change to the shared service'); await f.tick();
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
  assert.throws(() => f.report({ kind: 'deployed', checks: ['Works'] }), /must submit ready or reply or published/);
  assert.throws(() => f.report({ kind: 'published', url: 'https://example.com/pull/1' }));
  assert.throws(() => f.report({ kind: 'blocked', summary: 'x', amendment: { reason: 'r', ops: [] } }), /amendment/, 'the plan is the human\'s: no receipt may carry a change to it');
  assert.throws(() => f.report({ kind: 'blocked', summary: 'x', move: 'fix-here' }), /move/, 'a blocked receipt no longer names a move');
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
  assert.deepEqual(f.stopped, [f.launched[0].run.id], 'only the planner is released: the implementation session waits, parked, for the human (job-parked.js)');
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: 'run_stale' }), /not ready to approve/);
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: sub.ready.receiptId });
  assert.equal(f.sub().state, 'approved'); assert.ok(f.sub().ready.approvedAt);
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: sub.ready.receiptId }), /not ready/, 'approval is once');
  await f.tick();
  assert.ok(f.stopped.includes(f.launched[1].run.id), 'approving stops the parked session');
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
  f.report({ kind: 'blocked', summary: 'git add of config/example.env was denied' }); await f.tick(); await later();
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

test('an idea on code under review with its session gone: the planner reworks it in the same worktree with the note, receipt withdrawn', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'ready', checks: ['Tests pass'] }); f.alive.delete(f.last().sid); await f.tick();
  await reworkVia(f, 'api', 'Use the existing retry helper');
  const sub = f.sub();
  assert.deepEqual([sub.stage, sub.state, sub.ready, sub.note], ['implementation', 'queued', null, 'Use the existing retry helper']);
  assert.match(f.store.get(f.job.id).moves.at(-1).detail, /back to work/);
  await f.tick();
  assert.deepEqual([f.last().run.phase, f.last().sub.note, f.last().sub.worktree.path], ['implementation', 'Use the existing retry helper', '/worktree/api']);
  f.report({ kind: 'ready', checks: ['Helper reused'] }); f.alive.delete(f.last().sid); await f.tick();
  assert.equal(f.sub().stage, 'review'); assert.equal(f.sub().note, null);
  // Approved but not yet launched: Request changes still withdraws it.
  change(f, 'api'); await f.tick();
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: f.sub().ready.receiptId });
  f.report({ kind: 'plan', plan: f.store.get(f.job.id).plan, actions: [{ type: 'rework', sub: 'api', note: 'Take another pass' }] }, plannerOf(f));
  f.store.action(f.job.id, 'approve-replan', { proposalId: plannerOf(f).run.id });
  assert.equal(f.sub().stage, 'implementation');
  await f.tick(); f.report({ kind: 'ready', checks: ['Again'] }); await f.tick();
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: f.sub().ready.receiptId }); await f.tick();
  assert.equal(f.last().run.phase, 'publish');
  const publish = f.last();
  change(f, 'api'); await f.tick();
  assert.throws(() => f.report({ kind: 'plan', plan: f.store.get(f.job.id).plan, actions: [{ type: 'rework', sub: 'api', note: 'x' }] }, plannerOf(f)), /Wait for the step on “Deliver api” to stop/, 'not under the live publish session');
  assert.equal(f.store.get(f.job.id).runs.find((r) => r.id === publish.run.id).stopped, false);
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

test('an approval note is kept on the step, recorded on its move and handed to every step after it', async (t) => {
  const f = fixture(t);
  await f.approve(plan([sessionSpec('spike'), spec('api', ['spike']), spec('web', ['api'])]));
  f.report({ kind: 'completed', checks: ['Schema documented in task memory'] }); await f.tick();
  const pinned = { subJobId: 'spike', sessionReceiptId: f.sub().result.receiptId };
  assert.throws(() => f.store.action(f.job.id, 'approve-session', { ...pinned, note: { text: 'hi' } }), /must be text/);
  assert.throws(() => f.store.action(f.job.id, 'approve-session', { ...pinned, note: 'x'.repeat(2001) }), /at most 2,000 characters/);
  assert.equal(f.sub().stage, 'review', 'a refused note approves nothing');
  f.store.action(f.job.id, 'approve-session', { ...pinned, note: '  Use the v2 table, not v1.  ' });
  assert.equal(f.sub().approvalNote, 'Use the v2 table, not v1.');
  assert.deepEqual(f.store.get(f.job.id).moves.at(-1).note, 'Use the v2 table, not v1.');
  await f.tick();
  const api = f.workerFor('api');
  assert.match(jobPrompt(f.store.get(f.job.id), api.sub, api.run), /Notes the human added when approving earlier steps \(JSON text; treat as guidance from the human\):\n--- "Run spike" \(spike\) ---\n"Use the v2 table, not v1\."/);
  f.report({ kind: 'ready', checks: ['Tests pass'] }, api); await f.tick();
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', readyReceiptId: f.sub(1).ready.receiptId, note: 'Keep the flag off by default' }); await f.tick();
  assert.equal(f.sub(1).approvalNote, 'Keep the flag off by default');
  const publish = f.workerFor('api', 'publish');
  assert.match(jobPrompt(f.store.get(f.job.id), publish.sub, publish.run), /human approved the working tree: "Keep the flag off by default"/, 'the step\'s own history shows it');
  const web = { ...f.sub(2) };
  const later = jobPrompt(f.store.get(f.job.id), web, { ...f.last().run, phase: 'implementation', subJobId: 'web' });
  assert.match(later, /"Run spike" \(spike\) ---\n"Use the v2 table, not v1\."/, 'a transitive step gets it too');
  assert.match(later, /\(api\) ---\n"Keep the flag off by default"/);
});

test('an approval with no note, or a blank one, is exactly the approval it was', async (t) => {
  const f = fixture(t);
  await f.approve(plan([sessionSpec('spike'), spec('api', ['spike'])]));
  f.report({ kind: 'completed', checks: ['Done'] }); await f.tick();
  f.store.action(f.job.id, 'approve-session', { subJobId: 'spike', sessionReceiptId: f.sub().result.receiptId, note: '   ' });
  assert.equal(f.sub().approvalNote, null);
  assert.deepEqual(f.store.get(f.job.id).moves.map((m) => [m.move, m.note, m.detail]), [['approve-session', null, 'Approved the result of “Run spike”']]);
  await f.tick();
  const api = f.workerFor('api');
  assert.doesNotMatch(jobPrompt(f.store.get(f.job.id), api.sub, api.run), /Notes the human added/);
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
  assert.deepEqual(job.moves.map((m) => [m.move, m.subJobId, m.detail]), [['set-review', null, 'Switched Local verification to Auto']]);
  f.report({ kind: 'ready', checks: ['Tests pass'] }, f.workerFor('web'));
  assert.equal(f.sub(1).state, 'approved', 'the run kept its uncommitted prompt; its receipt is approved as it lands');
  assert.ok(f.sub(1).ready.approvedAt);
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['web', 'publish']);
  setReview(f, 'reviewCode', false, { release: true });
  assert.deepEqual([f.sub().state, !!f.sub().ready.approvedAt], ['approved', true]);
  assert.deepEqual(f.store.get(f.job.id).moves.slice(-2).map((m) => [m.move, m.subJobId]), [['approve-code', 'api'], ['set-review', null]]);
  assert.deepEqual([f.store.get(f.job.id).moves.at(-2).note, f.sub().approvalNote], [null, null], 'a bulk release carries no words');
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

test('start and finish are for human tasks alone', async (t) => {
  const f = fixture(t); await f.approve(plan([humanSpec('sign'), sessionSpec('spike')]));
  assert.throws(() => f.store.action(f.job.id, 'start-human', { subJobId: 'spike' }), /not a human task/);
  assert.throws(() => f.store.action(f.job.id, 'finish-human', { subJobId: 'spike' }), /no longer yours to mark/);
  f.store.action(f.job.id, 'finish-human', { subJobId: 'sign', note: 'The vendor had already done it' });
  const sign = f.sub();
  assert.equal(sign.stage, 'cleanup');
  assert.deepEqual(sign.result, { checks: ['The vendor had already done it'], at: sign.result.at, receiptId: null });
  assert.equal(sign.deployed, undefined);
});

test('a dropped or cancelled human task never satisfies what waits on it', async (t) => {
  const f = fixture(t); await f.approve(plan([humanSpec('sign'), spec('api', ['sign'])]));
  dropIt(f, 'sign');
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

// The runner's deployment poll on a real JobGithub over a fake `gh`: `onCommit`
// is what `gh run list --commit merge1` prints, `later` the workflow's later runs
// on the branch, `contains(head)` whether that head's commit contains the merge.
function ghOver(f, world) {
  const gh = new JobGithub(async (_bin, args) => {
    if (args.includes('--commit')) return JSON.stringify(world.onCommit);
    if (args[0] === 'run') return JSON.stringify(world.later || []);
    return world.contains(args[1].split('...')[1]) ? 'ahead' : 'diverged';
  });
  f.github.deployment = (sub) => gh.deployment(sub);
}
const pushRun = (over) => ({ headBranch: 'main', event: 'push', workflowName: 'Deploy', status: 'completed', attempt: 1, databaseId: 10, headSha: 'merge1', url: 'https://github.example.com/run', ...over });
// A red sub-job is polled every two minutes; two ticks always reach the next poll.
const poll = async (f) => { await f.tick(); await f.tick(); };

test('a failed post-merge run stays red but watched, and a re-run attempt that passes reaches deployed without Retry', async (t) => {
  const f = fixture(t); await atPr(f);
  const world = { onCommit: [pushRun({ conclusion: 'failure' })], contains: () => false };
  ghOver(f, world);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  await f.tick();
  assert.equal(f.sub().error, 'Post-merge run failed: Deploy');
  assert.equal(f.sub().nextPollAt - f.clockNow(), 120000, 'a red deployment is polled, more slowly');
  world.onCommit = [pushRun({ attempt: 2, status: 'in_progress', conclusion: '' })]; await poll(f);
  assert.equal(f.sub().deploymentResult.status, 'pending');
  assert.equal(f.sub().error, 'Post-merge run failed: Deploy', 'the failure stays on the board while the re-run is in flight');
  world.onCommit = [pushRun({ attempt: 2, conclusion: 'success' })]; await poll(f);
  const sub = f.sub();
  assert.equal(sub.error, null); assert.deepEqual(sub.deployed.checks, ['Post-merge runs passed']); assert.equal(sub.deployed.commit, 'merge1');
  assert.equal(f.launched.filter((w) => w.sub?.id === 'api' && w.run.phase !== 'implementation').length, 0, 'no Retry, no session');
  await f.tick(); assert.equal(f.sub().stage, 'done'); assert.deepEqual(f.cleaned, ['api']);
  // With a check in the plan, the green re-run sends it to verify like any green run.
  const g = fixture(t); await atPr(g, plan([spec('api', [], { check: 'helm list shows auth in prod' })]));
  const gWorld = { onCommit: [pushRun({ conclusion: 'failure' })], contains: () => false };
  ghOver(g, gWorld);
  g.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await g.tick(); await g.tick();
  assert.match(g.sub().error, /Post-merge run failed/);
  gWorld.onCommit = [pushRun({ attempt: 2, conclusion: 'success' })]; await poll(g);
  assert.equal(g.sub().error, null); assert.equal(g.last().run.phase, 'verify');
});

test('a failed run on the merge commit is cleared by a later run that contains the merge and passes', async (t) => {
  const f = fixture(t); await atPr(f);
  const world = { onCommit: [pushRun({ conclusion: 'failure' })], later: [], contains: (head) => head === 'next' };
  ghOver(f, world);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick(); await f.tick();
  assert.equal(f.sub().error, 'Post-merge run failed: Deploy');
  world.later = [pushRun({ databaseId: 11, headSha: 'next', status: 'in_progress', conclusion: '' })]; await poll(f);
  assert.equal(f.sub().error, 'Post-merge run failed: Deploy', 'a successor still running is not a verdict on a red run');
  world.later = [pushRun({ databaseId: 11, headSha: 'next', conclusion: 'success' })]; await poll(f);
  assert.equal(f.sub().error, null);
  assert.deepEqual(f.sub().deploymentResult.runs[0], { workflow: 'Deploy', runId: 11, url: 'https://github.example.com/run', status: 'passing', conclusion: 'success', supersedes: 10, commit: 'next' });
  assert.deepEqual(f.sub().deployed.checks, ['Post-merge runs passed']); assert.equal(f.sub().stage, 'cleanup');
});

test('a red post-merge run Retry never saw still waits on Accept red or recover when nothing passes after it', async (t) => {
  const f = fixture(t); await atPr(f);
  const world = { onCommit: [pushRun({ conclusion: 'failure' })], later: [pushRun({ databaseId: 11, headSha: 'sibling', conclusion: 'success' })], contains: () => false };
  ghOver(f, world);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick(); await f.tick();
  await poll(f); await poll(f);
  assert.equal(f.sub().error, 'Post-merge run failed: Deploy', 'a green run on a commit without the merge clears nothing');
  assert.equal(f.sub().deployed, undefined);
  acceptRed(f, 'api', 'unrelated'); await f.tick();
  assert.deepEqual(f.sub().deployed.checks, ['Post-merge run accepted red: unrelated']);
});

test('a red post-merge run nobody acts on is polled at 2, then 5, then 15 minutes, and not at all after six hours until Retry', async (t) => {
  const f = fixture(t); await atPr(f);
  ghOver(f, { onCommit: [pushRun({ conclusion: 'failure' })], later: [], contains: () => false });
  const polled = []; const deployment = f.github.deployment;
  f.github.deployment = (sub) => { polled.push(f.clockNow()); return deployment(sub); };
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick(); await f.tick();
  const since = f.sub().redSince;
  assert.equal(since, f.clockNow()); assert.equal(f.sub().error, 'Post-merge run failed: Deploy');
  while (f.clockNow() - since < 7 * 3600000) await f.tick();
  const gaps = polled.slice(1).map((at, i) => [at - since, at - polled[i]]);
  const gapAt = (from, to) => [...new Set(gaps.filter(([age]) => age > from && age <= to).map(([, gap]) => Math.ceil(gap / 60000)))];
  assert.deepEqual(gapAt(0, 30 * 60000), [3], 'first half hour: every 2 minutes (the next 61s tick after)');
  assert.deepEqual(gapAt(31 * 60000, 2 * 3600000), [6], 'to two hours: every 5 minutes');
  assert.deepEqual(gapAt(2.5 * 3600000, 6 * 3600000), [16], 'to six hours: every 15 minutes');
  assert.ok(polled.every((at) => at - since < 6 * 3600000), 'nothing after six hours');
  assert.ok(polled.length < 60, `${polled.length} polls over seven hours, bounded`);
  assert.equal(f.sub().error, 'Post-merge run failed: Deploy', 'still red on the board');
  const before = polled.length;
  f.store.action(f.job.id, 'retry', { subJobId: 'api' }); await f.tick();
  assert.equal(polled.length, before + 1, 'Retry watches it again'); assert.equal(f.sub().redSince, f.clockNow(), 'from a fresh start');
  assert.equal(f.sub().nextPollAt - f.clockNow(), 120000);
});

test('a green run on a revert of the merge still contains it, so it reads as deployed: run evidence, not liveness', async (t) => {
  // Pinned on purpose: `deployed` means a run that built the merge passed. A
  // revert after it is a later change somebody chose, which no run can tell
  // apart from a fix by containment alone.
  const f = fixture(t); await atPr(f);
  const world = { onCommit: [pushRun({ conclusion: 'failure' })], later: [], contains: (head) => head === 'revert1' };
  ghOver(f, world);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick(); await f.tick();
  assert.equal(f.sub().error, 'Post-merge run failed: Deploy');
  world.later = [pushRun({ databaseId: 11, headSha: 'revert1', conclusion: 'success' })]; await poll(f);
  assert.equal(f.sub().error, null);
  assert.equal(f.sub().deploymentResult.runs[0].commit, 'revert1');
  assert.deepEqual(f.sub().deployed.checks, ['Post-merge runs passed']);
});

test('Accept red on an open PR merges the pinned head instead of repairing it; a new push is judged afresh', async (t) => {
  const f = fixture(t); f.store.settings({ maxRepairs: 0 }); await atPr(f);
  f.setPr({ checkStatus: 'failing', checks: [{ name: 'e2e', state: 'FAILURE' }] }); await f.tick();
  assert.match(f.sub().error, /repair limit/);
  acceptRed(f, 'api', 'e2e is flaky this week');
  assert.equal(f.sub().error, null); assert.deepEqual(f.sub().acceptedRed, { ref: 'head1', note: 'e2e is flaky this week', at: f.sub().acceptedRed.at });
  await f.tick();
  assert.deepEqual(f.merged, ['head1']); assert.equal(f.sub().mergeRequestedHead, 'head1');
  assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 0, 'an accepted head is never repaired');
  // The acceptance was for head1: a push that lands red is back on the repair road.
  const g = fixture(t); g.store.settings({ maxRepairs: 0 }); await atPr(g);
  g.setPr({ checkStatus: 'failing' }); await g.tick();
  acceptRed(g, 'api');
  g.setPr({ head: 'head2' }); await g.tick();
  assert.deepEqual(g.merged, []); assert.match(g.sub().error, /repair limit/);
  assert.equal(g.sub().mergeApprovedHead, 'head1', 'the approval it carried stays pinned to the head that was accepted');
});

test('with manual merge on, Accept red needs no second Approve merge click: the acceptance is the approval', async (t) => {
  const f = fixture(t); f.store.settings({ maxRepairs: 0 }); await f.approve(); f.report({ kind: 'published', url: PR_URL });
  f.setPr({ checkStatus: 'failing' }); await f.tick();
  assert.match(f.sub().error, /repair limit/);
  acceptRed(f, 'api'); await f.tick();
  assert.deepEqual(f.merged, ['head1'], 'reviewMerge on, yet no second Approve merge click is asked for');
});

test('Accept red on a failing post-merge run climbs the rest of the ladder, receipt line saying which colour it was', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'failing', runs: [{ workflow: 'Deploy to prod', status: 'failing' }], commit: 'merge1' }); await f.tick();
  assert.match(f.sub().error, /Post-merge run failed/);
  acceptRed(f, 'api', 'Prod deploy is red for the unrelated smoke test');
  assert.equal(f.sub().error, null);
  await f.tick();
  assert.deepEqual(f.sub().deployed.checks, ['Post-merge run accepted red: Prod deploy is red for the unrelated smoke test']);
  assert.equal(f.sub().deployed.commit, 'merge1');
  await f.tick(); assert.equal(f.sub().stage, 'done'); assert.deepEqual(f.cleaned, ['api']);
  // With a check in the plan, verify still runs — and is told the truth about the runs.
  const g = fixture(t); await atPr(g, plan([spec('api', [], { check: 'helm list shows auth in prod' })]));
  g.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await g.tick();
  g.setDeployment({ status: 'failing', runs: [{ workflow: 'Deploy to prod', status: 'failing' }], commit: 'merge1' }); await g.tick();
  acceptRed(g, 'api', 'smoke test is unrelated'); await g.tick();
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

// The real JobGithub.deploys over a `gh` that answers as GitHub would for
// org/repo, with the local tree always holding a push workflow on main: the
// runner must follow what GitHub runs, not what the local files say.
function githubSees(f, api) {
  const gh = new JobGithub(async (bin, args) => {
    if (args[0] === 'pr') return JSON.stringify({ files: [{ path: 'src/a.js' }] });
    const answer = api[args.at(-1)];
    if (answer === undefined) throw new Error(`Command failed: gh api ${args.at(-1)}\ngh: Server Error (HTTP 500)`);
    if (answer === 404) throw new Error(`Command failed: gh api ${args.at(-1)}\ngh: Not Found (HTTP 404)`);
    return typeof answer === 'string' ? answer : JSON.stringify(answer);
  });
  gh.readWorkflows = () => [{ file: 'deploy.yml', text: 'name: Deploy\non:\n  push:\n    branches: [main]\n' }];
  f.github.deploys = (sub, pr) => gh.deploys(sub, pr);
}
const R = 'repos/org/repo';

test('a repo GitHub has Actions disabled on completes on merge, though its local files declare a push deploy', async (t) => {
  const f = fixture(t); githubSees(f, { [`${R}/actions/permissions`]: { enabled: false } }); await atPr(f); await f.tick();
  assert.equal(f.sub().deploys.summary, 'Merge completes it · Actions disabled'); assert.equal(f.sub().deploys.expected, false);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.equal(f.sub().stage, 'cleanup'); assert.deepEqual(f.sub().deployed.checks, [MERGE_IS_DELIVERY]);
  await f.tick(); assert.deepEqual(f.cleaned, ['api']); assert.equal(f.store.get(f.job.id).stage, 'done');
});

test('a workflow present locally but absent on GitHub at the PR head makes the merge the delivery', async (t) => {
  const f = fixture(t);
  githubSees(f, { [`${R}/actions/permissions`]: { enabled: true }, [`${R}/contents/.github/workflows?ref=head1`]: 404, [`${R}/commits/head1`]: { sha: 'head1' } });
  await atPr(f); await f.tick();
  assert.equal(f.sub().deploys.expected, false); assert.equal(f.sub().deploys.summary, 'Merge completes it · no workflows');
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.equal(f.sub().stage, 'cleanup'); assert.equal(f.sub().deploymentStale, undefined);
});

test('a push workflow every GitHub workflow state has disabled makes the merge the delivery and says which', async (t) => {
  const f = fixture(t);
  githubSees(f, { [`${R}/actions/permissions`]: { enabled: true },
    [`${R}/contents/.github/workflows?ref=head1`]: [{ type: 'file', name: 'deploy.yml', path: '.github/workflows/deploy.yml' }],
    [`${R}/contents/.github/workflows/deploy.yml?ref=head1`]: 'name: Deploy\non:\n  push:\n    branches: [main]\n',
    [`${R}/actions/workflows?per_page=100`]: { workflows: [{ path: '.github/workflows/deploy.yml', state: 'disabled_manually' }] } });
  await atPr(f); await f.tick();
  assert.equal(f.sub().deploys.summary, 'Merge completes it · Deploy disabled');
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick(); assert.equal(f.sub().stage, 'cleanup');
});

test('a genuine push workflow on GitHub still enters deployment, and silence there still goes stale', async (t) => {
  const f = fixture(t);
  githubSees(f, { [`${R}/actions/permissions`]: { enabled: true },
    [`${R}/contents/.github/workflows?ref=head1`]: [{ type: 'file', name: 'deploy.yml', path: '.github/workflows/deploy.yml' }],
    [`${R}/contents/.github/workflows/deploy.yml?ref=head1`]: 'name: Deploy\non:\n  push:\n    branches: [main]\n',
    [`${R}/actions/workflows?per_page=100`]: { workflows: [{ path: '.github/workflows/deploy.yml', state: 'active' }] } });
  await atPr(f); await f.tick();
  assert.equal(f.sub().deploys.summary, 'Deploys on merge · Deploy');
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.equal(f.sub().stage, 'deployment');
  f.setDeployment({ status: 'pending', runs: [], commit: 'merge1' });
  for (let i = 0; i < 31; i++) await f.tick();
  assert.equal(f.sub().deploymentStale.since, f.sub().mergedAt); assert.equal(f.sub().stage, 'deployment');
});

test('when GitHub cannot be asked, the local push workflow is trusted as before', async (t) => {
  const f = fixture(t); githubSees(f, {}); await atPr(f); await f.tick();
  assert.equal(f.sub().deploys.expected, true);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick(); assert.equal(f.sub().stage, 'deployment');
});

// --- Request changes ---

const movesOf = (f) => f.store.get(f.job.id).moves;

test('Request changes on an open PR under code review goes back to work in the PR worktree, through review, and the approved tree is pushed to the same PR', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'published', url: PR_URL }); await f.tick();
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
  assert.equal(f.sub().mergeApprovedHead, 'head1');
  await reworkVia(f, 'api', 'Rename the flag to sign_in_v2');
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

test('Request changes on an open PR with code review off launches a repair whatever colour the checks are, and the repaired receipt clears it', async (t) => {
  const f = fixture(t, { ...input, reviewCode: false }); await f.approve();
  f.report({ kind: 'published', url: PR_URL }); await f.tick();
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 0, 'green checks start nothing on their own');
  await reworkVia(f, 'api', 'Rename the flag to sign_in_v2');
  const requested = f.sub();
  assert.equal(requested.fixRequested.note, 'Rename the flag to sign_in_v2');
  assert.equal(requested.state, 'watching'); assert.equal(requested.nextPollAt, 0);
  await f.tick();
  assert.equal(f.last().run.phase, 'repair');
  assert.equal(f.last().sub.fixRequested.note, 'Rename the flag to sign_in_v2', 'the prompt carries the note');
  f.report({ kind: 'repaired', changes: ['Renamed the flag'], checks: ['Tests pass'] });
  assert.equal(f.sub().fixRequested, null); assert.equal(f.sub().note, null);
  assert.deepEqual(movesOf(f).map((m) => [m.subJobId, m.move, m.note]), [['api', 'request-change', 'Rename the flag to sign_in_v2'], [null, 'approve-replan', 'About “Deliver api” (api, pr/watching): Rename the flag to sign_in_v2'], ['api', 'replan', null]]);
  assert.match(movesOf(f)[2].detail, /new commit on “Deliver api”/);
  assert.match(movesOf(f)[0].id, /^mv_/);
});

test('a blocked step is retried with a note; a request on a step with no agent of its own goes to the planner', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'blocked', summary: 'The feature flag name is ambiguous' }); await f.tick();
  assert.deepEqual(f.sub().blocked, { summary: 'The feature flag name is ambiguous', phase: 'implementation', at: f.sub().blocked.at });
  assert.equal(f.sub().error, 'The feature flag name is ambiguous');
  f.store.action(f.job.id, 'retry', { subJobId: 'api', note: 'Call it sign_in_v2' });
  assert.equal(f.sub().error, null); assert.equal(f.sub().blocked, null);
  assert.equal(f.sub().state, 'queued'); assert.equal(f.sub().note, 'Call it sign_in_v2');
  await f.tick();
  assert.equal(f.last().sub.note, 'Call it sign_in_v2');
  f.report({ kind: 'published', url: PR_URL });
  assert.equal(f.sub().note, null, 'the note is spent once that session reports');
  f.store.update(f.job.id, (j) => { j.subJobs[0].stage = 'deployment'; });
  change(f, 'api', 'Also guard empty payloads');
  assert.match(reading(f).asks[0].feedback, /^About “Deliver api” \(api, deployment\/\w+\): Also guard empty payloads$/, 'merged work has no resumable agent: the planner takes it, told where it came from');
  assert.equal(f.sub().stage, 'deployment', 'nothing moves until the proposal is approved');
  assert.deepEqual(movesOf(f).at(-1) && [movesOf(f).at(-1).subJobId, movesOf(f).at(-1).move, movesOf(f).at(-1).note], ['api', 'request-change', 'Also guard empty payloads']);
});

test('a request is pinned to what was viewed: a moved head, receipt, revision or proposal refuses it, and so does an idea with no words', async (t) => {
  const f = fixture(t); await f.approve(); f.report({ kind: 'published', url: PR_URL }); await f.tick();
  const view = changeView(f.store.get(f.job.id), f.sub());
  assert.deepEqual(view, { at: 'pr', ref: 'head1' });
  const send = (extra) => f.store.action(f.job.id, 'request-change', { subJobId: 'api', ...view, text: 'Rename the flag', ...extra });
  assert.throws(() => send({ ref: 'head0' }), /changed since you looked/);
  assert.throws(() => send({ at: 'code' }), /changed since you looked/);
  assert.throws(() => send({ text: '  ' }), /Explain the change/);
  assert.throws(() => f.store.action(f.job.id, 'request-change', { subJobId: 'ghost', ...view, text: 'x' }), /Sub-job not found/);
  assert.deepEqual(movesOf(f), [], 'a refused request leaves no trace');
  send();
  assert.equal(movesOf(f).length, 1);
});

test('an idea on a session result reaches its own session through the planner; the first plan is still redrawn', async (t) => {
  const g = fixture(t); await g.approve(plan([sessionSpec('spike')]));
  g.report({ kind: 'completed', checks: ['Answered'] }); await g.tick();
  assert.deepEqual(changeView(g.store.get(g.job.id), g.sub()), { at: 'session', ref: g.sub().result.receiptId });
  assert.throws(() => g.store.action(g.job.id, 'request-change', { subJobId: 'spike', at: 'session', ref: 'run_stale', text: 'Also check staging' }), /changed since you looked/);
  change(g, 'spike', 'Also check staging');
  assert.deepEqual([g.sub().stage, !!g.sub().result, reading(g).source], ['review', true, { sub: 'spike', at: 'session', ref: g.sub().result.receiptId }], 'nothing moves before the human approves');
  await g.tick();
  g.report({ kind: 'plan', plan: g.store.get(g.job.id).plan, actions: [{ type: 'rework', sub: 'spike', note: 'Also check staging' }] }, plannerOf(g));
  g.store.action(g.job.id, 'approve-replan', { proposalId: plannerOf(g).run.id });
  assert.deepEqual([g.sub().stage, g.sub().state, g.sub().result, g.sub().feedback], ['session', 'queued', null, 'Also check staging']);
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web')]) }); await f.tick();
  assert.deepEqual(changeView(f.store.get(f.job.id), null), { at: 'plan', ref: String(f.store.get(f.job.id).revision) });
  assert.throws(() => f.store.action(f.job.id, 'request-change', { at: 'plan', ref: '0', text: 'x' }), /changed since you looked/);
  change(f, null, 'Just the API');
  assert.equal(f.store.get(f.job.id).feedback, 'Just the API'); assert.equal(f.store.get(f.job.id).plan, null);
});

test('every idea has one way in: the planner, which takes a step\'s idea into the proposal it is asked to change', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  f.report({ kind: 'ready', checks: ['Tests pass'] }, f.workerFor('api')); await f.tick();
  change(f, null, 'Also cover SSO'); await f.tick();
  const sso = plannerOf(f);
  assert.equal(f.store.get(f.job.id).replan, undefined, 'the wrangler reads it first');
  change(f, 'api', 'Rename it'); await f.tick();
  const rename = plannerOf(f);
  assert.notEqual(rename.run.id, sso.run.id, 'each idea has its own wrangler: nothing queues');
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('sso')]) }, sso); await f.tick();
  const proposal = f.store.get(f.job.id).replan.proposal;
  assert.deepEqual(changeView(f.store.get(f.job.id), null), { at: 'proposal', ref: proposal.id });
  assert.throws(() => f.store.action(f.job.id, 'request-change', { at: 'proposal', ref: 'run_other', text: 'x' }), /changed since you looked/);
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('sso')]) }, rename);
  const replan = f.store.get(f.job.id).replan;
  assert.equal(replan.previous.subJobs.length, 3, 'the planner reads the proposal it is asked to change');
  assert.deepEqual([replan.earlier, replan.feedback], [['Also cover SSO'], 'About “Deliver api” (api, review/verified): Rename it']);
  assert.equal(replan.source.at, 'code');
});

test('a PR sub-job that never opened a PR and was finished by hand still completes cleanup', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  f.store.update(f.job.id, (j) => { j.subJobs[0].worktree.cleanupHead = 'base'; });
  markDone(f, 'api', 'Finished outside the job');
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

test('dropping a sub-job stops the live step and ignores its late receipt', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web', ['api'])]));
  const worker = f.workerFor('api');
  dropIt(f, 'api');
  const api = f.sub();
  assert.equal(api.stage, 'cleanup'); assert.ok(api.cancelledAt); assert.equal(api.state, 'cancelled');
  f.report({ kind: 'published', url: PR_URL }, worker);
  assert.equal(f.sub().pr, null, 'a racing receipt must not move a dropped sub-job');
  await f.tick();
  assert.ok(f.stopped.includes(worker.run.id)); assert.deepEqual(f.cleaned, ['api']);
  assert.equal(f.sub().stage, 'done');
});

test('a finished or dropped sub-job has nothing left to change', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  dropIt(f, 'api');
  assert.equal(changeView(f.store.get(f.job.id), f.sub()), null);
  assert.throws(() => change(f, 'api'), /Nothing is left to change/);
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
  for (const action of ['pause', 'resume', 'start', 'request-change', 'approve-session', 'approve-merge']) {
    assert.throws(() => f.store.action(f.job.id, action, { subJobId: action === 'request-change' ? 'docs' : undefined, text: 'x' }), /Job was cancelled/, action);
  }
  assert.throws(() => f.store.action(f.job.id, 'cancel-job'), /already finished/);
  assert.deepEqual(movesOf(f), [], 'a cancel is job state, not a recorded intervention');
});

test('a sub-job already delivered or refused cleanup is left alone by a cancel, and Retry still clears a refused cleanup', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  f.alive.delete(f.workerFor('api').sid); await f.tick();
  markDone(f, 'api', 'Landed by hand');
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
  dropIt(f, 'api');
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

test('a Discard of a folder git could not remove is marked so the runtime deletes it whole, and says so in history', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api')]));
  dropIt(f, 'api');
  const refusal = { path: '/worktree/api', branch: 'branch-api', head: 'h1', fingerprint: 'fp1', pinned: true, cause: 'unremovable', error: 'error: failed to delete', commits: [], commitCount: 0, files: [], fileCount: 0 };
  f.runtime.cleanup = async () => { throw new CleanupRefused('refused', refusal); };
  await f.tick();
  f.store.action(f.job.id, 'discard-worktree', { subJobId: 'api', discardHead: 'h1', fingerprint: 'fp1' });
  assert.deepEqual([f.sub().discard.cause, f.sub().discard.fingerprint], ['unremovable', 'fp1']);
  assert.equal(f.store.get(f.job.id).moves.at(-1).detail, 'Chose to delete the leftover folder /worktree/api and branch branch-api, from “Deliver api”');
});

test('a failed git command in cleanup shows git\'s own reason on the board, not just the command line', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api')]));
  dropIt(f, 'api');
  const failure = await promisify(execFile)('git', ['symbolic-ref', 'HEAD'], { cwd: process.env.AW_DATA_DIR }).catch((e) => e);
  f.runtime.cleanup = async () => { throw failure; };
  await f.tick();
  assert.equal(f.sub().error, 'Command failed: git symbolic-ref HEAD: fatal: not a git repository (or any of the parent directories): .git');
  assert.equal(shortError(new Error('Plain\nsecond line')), 'Plain', 'an error with no stderr keeps its first line');
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

test('a tick over many idle jobs never deep-clones the store, and allowed() still honours both pause flags', async (t) => {
  const f = fixture(t); for (let n = 0; n < 30; n++) f.store.create(input);
  let clones = 0; const snapshot = f.store.snapshot.bind(f.store); f.store.snapshot = () => { clones++; return snapshot(); };
  await f.tick(); assert.equal(clones, 0);
  const data = f.store.data; assert.ok(data.jobs.length > 30);
  assert.equal(f.runner.allowed(f.job.id), true);
  f.store.action(f.job.id, 'pause'); assert.equal(f.runner.allowed(f.job.id), false);
  assert.equal(f.runner.allowed(data.jobs.at(-1).id), true, 'a per-job pause is that job\'s own');
  f.store.settings({ paused: true }); assert.equal(f.runner.allowed(data.jobs.at(-1).id), false);
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
  markDone(f, 'w', 'Moved it by hand'); await f.tick();
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
  dropIt(f, 'web'); await f.tick();
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

test('a session that ends without a receipt holds its writes; a plan change being drawn holds no milestone session', async (t) => {
  const f = fixture(t);
  await f.approve(plan([spec('api'), notifier('n', { sub: 'api', at: 'started' }), write('w', 'n', moveTo('In Progress')),
    notifier('later', { sub: 'api', at: 'pr' }), write('later-w', 'later', moveTo('In Review'))]));
  f.alive.delete(f.workerFor('n').sid); await f.tick();
  let job = f.store.get(f.job.id);
  assert.match(job.subJobs[1].error, /without a receipt/); assert.equal(job.error ?? null, null);
  assert.equal(job.subJobs[2].state, 'queued');
  change(f, null, 'Also cover SSO');
  f.report({ kind: 'published', url: PR_URL }, f.workerFor('api', 'implementation')); await f.tick();
  job = f.store.get(f.job.id);
  assert.equal(f.launched.filter((l) => l.sub?.id === 'later').length, 1, 'talking to Wrangler pauses nothing');
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
  markDone(f, 'k6', 'Ran k6 myself', { url: '/Users/me/reports/k6.html' }); await f.tick();
  const marked = f.store.get(f.job.id).subJobs.find((s) => s.id === 'k6');
  assert.deepEqual([marked.stage, marked.result.url, marked.result.checks], ['done', '/Users/me/reports/k6.html', ['Ran k6 myself']]);
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
  dropIt(f, 'report'); await f.tick(); await f.tick();
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
  assert.equal(data.version, 6);
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
  validatePlan(store.get('job_live').plan);
  store.update('job_live', (j) => dropSub(j.subJobs.find((s) => s.id === 'w'), Date.now(), j));
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
  assert.throws(() => change(g, 'spike', ' '), /Explain/);
  await reworkVia(g, 'spike', 'Also check staging');
  assert.equal(g.sub().stage, 'session'); assert.equal(g.sub().result, null);
  await g.tick();
  assert.equal(g.last().run.phase, 'session'); assert.equal(g.last().sub.feedback, 'Also check staging');
  g.report({ kind: 'completed', checks: ['Staging checked'] }); await g.tick();
  assert.equal(g.sub().stage, 'review'); assert.equal(g.sub().feedback, null);
  g.store.action(g.job.id, 'approve-session', { subJobId: 'spike', sessionReceiptId: g.sub().result.receiptId });
  assert.deepEqual(g.store.get(g.job.id).moves.map((m) => [m.subJobId, m.move, m.note]),
    [['spike', 'request-change', 'Also check staging'], [null, 'approve-replan', 'About “Run spike” (spike, review/verified): Also check staging'], ['spike', 'replan', null], ['spike', 'approve-session', null]], 'approvals and requests are on the same timeline');
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
  change(f, null, 'Split the API change'); await f.tick();
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
    { runId: s.run.id, report: { kind: 'blocked', summary: 'The proto is out of date' } });
  assert.deepEqual(Object.keys(suggested.sub().blocked).sort(), ['at', 'phase', 'summary']);
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
  assert.equal(f.store.get(id).titlePending, true, 'the board draws a loader until Haiku answers');
  const { revision } = f.store.get(id); const rebuilds = host.rebuilds;
  answer({ text: 'Reliable SSO sign-in', liveSessionId: 'live-1', error: null });
  await new Promise(setImmediate);
  assert.equal(f.store.get(id).title, 'Reliable SSO sign-in');
  assert.equal(f.store.get(id).titlePending, undefined);
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
  const rebuilds = host.rebuilds;
  await new Promise(setImmediate);
  assert.equal(f.store.get(host.broadcasts[0].jobId).title, 'Make sign-in reliable');
  assert.equal(f.store.get(host.broadcasts[0].jobId).titlePending, undefined, 'a failure ends the wait, never a stuck loader');
  assert.equal(host.rebuilds, rebuilds + 1, 'and the board hears so');
  await handler.handler({ job: input }, host);
  await new Promise(setImmediate);
  assert.equal(calls, 1); assert.equal(f.store.get(host.broadcasts[1].jobId).title, 'Reliable sign-in');
  assert.equal(f.store.get(host.broadcasts[1].jobId).titlePending, undefined, 'a supplied title waits on nothing');
});

test('an empty title answer ends the wait under the fallback', async (t) => {
  const f = fixture(t);
  const host = fakeHost(f);
  stubRunner(t, host);
  const handler = makeJobCreateHandler({ run: async () => ({ text: '   ', liveSessionId: null, error: null }) });
  await handler.handler({ job: { intent: 'Make sign-in reliable' } }, host);
  await new Promise(setImmediate);
  const job = f.store.get(host.broadcasts[0].jobId);
  assert.deepEqual([job.title, job.titlePending], ['Make sign-in reliable', undefined]);
});

test('a restart drops a pending title: the Haiku run it waited on died with the process', (t) => {
  const f = fixture(t);
  const job = f.store.create({ intent: 'Make sign-in reliable' }, { titlePending: true });
  assert.equal(new JobStore(f.store.file).get(job.id).titlePending, undefined);
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

test('a request-change arrives as a job-action with its own fields and reaches the store whole', async (t) => {
  const f = fixture(t); await f.approve(); f.report({ kind: 'ready', checks: ['Tests pass'] }); f.alive.delete(f.last().sid); await f.tick();
  const host = fakeHost(f);
  stubRunner(t, host);
  await jobActionHandler.handler({ id: f.job.id, subJobId: 'api', action: 'request-change', at: 'code', ref: f.sub().ready.receiptId, text: 'Use the retry helper' }, host);
  assert.deepEqual(host.broadcasts, [{ event: 'job-action-complete', jobId: f.job.id, action: 'request-change', subJobId: 'api' }]);
  assert.match(reading(f).asks[0].feedback, /Use the retry helper$/);
  assert.equal(f.sub().stage, 'review', 'the planner has it; the step waits for the proposal');
});

test('an idea that opens a conversation has Haiku name it from its first message, after the send', async (t) => {
  const f = fixture(t); await f.approve(); f.report({ kind: 'ready', checks: ['Tests pass'] }); f.alive.delete(f.last().sid); await f.tick();
  const host = fakeHost(f); const billed = [];
  host.sessions.bill = (sid, live) => billed.push([sid, live]);
  stubRunner(t, host);
  const asked = []; let answer;
  const handler = makeJobActionHandler({ run: (prompt, stdin) => { asked.push(stdin); return new Promise((resolve) => { answer = resolve; }); } });
  await handler.handler({ id: f.job.id, subJobId: 'api', action: 'request-change', at: 'code', ref: f.sub().ready.receiptId, text: 'Use the retry helper' }, host);
  assert.equal(host.broadcasts[0].event, 'job-action-complete', 'the send does not wait for a title');
  const convo = () => f.store.get(f.job.id).convos[0];
  assert.equal(convo().titlePending, true, 'the board draws a loader until Haiku answers');
  assert.deepEqual(asked, ['<first_message>\nUse the retry helper\n</first_message>']);
  const { revision } = f.store.get(f.job.id); const rebuilds = host.rebuilds;
  answer({ text: 'Retry helper for the API', liveSessionId: 'live-1', error: null });
  await new Promise(setImmediate);
  assert.deepEqual([convo().title, convo().titlePending], ['Retry helper for the API', undefined]);
  assert.equal(f.store.get(f.job.id).revision, revision, 'a title is not a revision');
  assert.equal(host.rebuilds, rebuilds + 1);
  assert.equal(billed.length, 1, 'billed to the job\'s card');
  await handler.handler({ id: f.job.id, subJobId: 'api', action: 'request-change', at: 'code', ref: f.sub().ready.receiptId, text: 'And log it', convo: convo().id }, host);
  await new Promise(setImmediate);
  assert.equal(asked.length, 1, 'a reply in a named conversation names nothing');
});

test('a failed conversation title ends the wait, and a restart drops one still pending', (t) => {
  const f = fixture(t);
  const job = f.store.create({ intent: 'Make sign-in reliable' });
  f.store.change((d) => { d.jobs.find((j) => j.id === job.id).convos = [{ id: 'c1', at: 1, pending: null, seenAt: 0, titlePending: true }, { id: 'c2', at: 1, pending: null, seenAt: 0, titlePending: true }]; });
  assert.equal(f.store.titleConvo(job.id, 'c1', null), false);
  assert.deepEqual(f.store.get(job.id).convos[0], { id: 'c1', at: 1, pending: null, seenAt: 0 }, 'no title: the board falls back to Conversation N');
  assert.equal(f.store.titleConvo(job.id, 'c1', 'Late answer'), false, 'only a pending title is replaced');
  assert.equal(new JobStore(f.store.file).get(job.id).convos[1].titlePending, undefined);
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
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'org/repo', viewerPermission: 'ADMIN' });
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

test('a failed post-merge run is judged by the NEWEST completed later run that contains the merge', async () => {
  const sub = { repo: '/repo', pr: { mergeCommit: 'merged', base: 'main' } };
  const base = { headBranch: 'main', event: 'push', status: 'completed', attempt: 1, workflowName: 'Build' };
  const failed = { ...base, databaseId: 10, headSha: 'merged', conclusion: 'failure' };
  const red = { ...base, databaseId: 11, headSha: 'next', conclusion: 'failure' };
  const green = { ...base, databaseId: 12, headSha: 'after', conclusion: 'success' };
  const running = { ...base, databaseId: 13, headSha: 'latest', status: 'in_progress', conclusion: '' };
  let later = [];
  const gh = new JobGithub(async (_bin, args) => args.includes('--commit') ? JSON.stringify([failed])
    : args[0] === 'run' ? JSON.stringify(later) : 'ahead');
  assert.equal((await gh.deployment(sub)).status, 'failing', 'nothing after it: still red');
  later = [red, green, running];
  let result = await gh.deployment(sub);
  assert.equal(result.status, 'passing', 'a later red run is not the last word when a newer one passed');
  assert.equal(result.runs[0].runId, 12); assert.equal(result.runs[0].supersedes, 10); assert.equal(result.runs[0].commit, 'after');
  later = [green, { ...red, databaseId: 14 }];
  result = await gh.deployment(sub);
  assert.equal(result.status, 'failing', 'passed then failed is red: the newest completed run decides');
  assert.equal(result.runs[0].runId, 14);
  later = [red, { ...green, databaseId: 15, conclusion: 'cancelled' }];
  assert.equal((await gh.deployment(sub)).runs[0].runId, 11, 'a cancelled successor is skipped for the one before it');
});

test('a later run on a commit that does not contain the merge never supersedes a failed or cancelled one', async () => {
  const sub = { repo: '/repo', pr: { mergeCommit: 'merged', base: 'main' } };
  const base = { headBranch: 'main', event: 'push', status: 'completed', attempt: 1, workflowName: 'Build' };
  const sibling = { ...base, databaseId: 12, headSha: 'sibling', conclusion: 'success' };
  const compared = [];
  let onCommit = [{ ...base, databaseId: 10, headSha: 'merged', conclusion: 'failure' }];
  const gh = new JobGithub(async (_bin, args) => {
    if (args.includes('--commit')) return JSON.stringify(onCommit);
    if (args[0] === 'run') return JSON.stringify([sibling]);
    compared.push(args[1]); return 'diverged';
  });
  let result = await gh.deployment(sub);
  assert.equal(result.status, 'failing'); assert.equal(result.runs[0].runId, 10); assert.equal(result.runs[0].supersedes, undefined);
  assert.deepEqual(compared, ['repos/{owner}/{repo}/compare/merged...sibling'], 'containment was asked, and said no');
  onCommit = [{ ...base, databaseId: 10, headSha: 'merged', conclusion: 'cancelled' }];
  result = await gh.deployment(sub);
  assert.equal(result.status, 'pending'); assert.equal(result.runs[0].status, 'cancelled');
});

// --- Changing the plan of a running job ---

test('a running job takes a plan change as a proposal: frozen work is locked, removed work is cancelled, new work held until approval', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web'), spec('docs', ['web'])]));
  const web = f.workerFor('web');
  assert.throws(() => change(f, null, ' '), /Explain the change/);
  f.alive.delete(f.workerFor('api').sid); await f.tick();
  markDone(f, 'api');
  change(f, null, 'Drop docs; ship a CLI after web'); await f.tick();
  const planner = f.last();
  await f.tick();
  assert.throws(() => f.store.action(f.job.id, 'approve-merge', { subJobId: 'web', head: 'h' }), /green checks/, 'a change being drawn holds nothing it has not touched');
  assert.equal(planner.run.phase, 'planning'); assert.equal(planner.sub, null);
  assert.equal(f.launched.filter((w) => w.sub?.id === 'docs').length, 0, 'docs waits for web');
  assert.equal(f.sub(0).stage, 'done');
  const prompt = jobPrompt(f.store.get(f.job.id), null, planner.run);
  assert.match(prompt, /ALREADY RUNNING/); assert.match(prompt, /- api \(pr\) "Deliver api": done\/done · FROZEN/);
  assert.match(prompt, /Frozen \(.*\): api\./); assert.match(prompt, /- web .*a step is running/); assert.match(prompt, /The human wrote: Drop docs/);
  assert.match(prompt, /Feedback on, or a question about, what a live sub-job already produced.*`forward` when its session is open on review, else `rework`.*never write it into a later sub-job/i);
  assert.match(prompt, /ONE card: the option's `label` as its heading, its `why` under it, its `leaves` line, then Approve and Discard/);
  assert.match(prompt, /Every clause you write must tell the human one of three things: what is wrong, what approving does, or what it leaves them to do\. Cut anything else/);
  assert.match(prompt, /- diagnosis\.summary: .*Never say what approving does/);
  assert.match(prompt, /never file or function names, sub-job ids, or the plan's own words: brief, show, check, context, round, forward, rework, frozen, pinned/);
  assert.match(prompt, /call it that \(the agent that built it\), never a reviewer/);
  assert.match(prompt, /alternatives:\[\{label,why\?,leaves\?,plan,actions\?\}\]/);
  assert.doesNotMatch(prompt, /at most four sentences|in one or two sentences|in a few words/, 'phrasing rules, never a length');

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
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'web', readyReceiptId: ready.receiptId }), /plan change is pending/, 'a step the proposal edits is frozen while the human weighs it');
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
  change(f, 'web', 'Web needs the new api'); await f.tick();
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'web', head: 'head1' });
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web', ['api'], { brief: 'Implement web on the new api' })]) }, f.last());
  f.store.action(f.job.id, 'approve-replan', { proposalId: f.last().run.id });
  const web = () => f.store.get(f.job.id).subJobs.find((s) => s.id === 'web');
  assert.equal(web().mergeApprovedHead, null);
  assert.match(web().fixRequested.note, /^About “Deliver web” \(web, pr\/watching\): Web needs the new api\n\nNew brief: Implement web on the new api$/);
  assert.equal(f.store.get(f.job.id).moves.at(-1).detail, 'Asked for a new commit on “Deliver web”');
  assert.throws(() => f.store.action(f.job.id, 'approve-merge', { subJobId: 'web', head: 'head1' }), /prerequisites/);
  await f.tick(); await f.tick();
  assert.equal(f.workerFor('web', 'repair'), undefined, 'the new brief builds on api, which has not landed');
  assert.deepEqual(f.merged, []);
  f.store.update(f.job.id, (j) => { j.subJobs[0].deployed = { at: 1, checks: ['Shipped'] }; });
  await f.tick();
  assert.ok(f.workerFor('web', 'repair'));
  assert.match(jobPrompt(f.store.get(f.job.id), web(), f.workerFor('web', 'repair').run), /the human asks: About “Deliver web” .*: Web needs the new api/);
});

test('an idea typed on a PR holds it from merging once Wrangler proposes a change to it, until that change is discarded', async (t) => {
  const f = fixture(t); await atPr(f);
  change(f, 'api', 'Rethink it'); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api', [], { brief: 'Rethink api' })]) }, plannerOf(f));
  f.setPr({ checkStatus: 'passing' }); await f.tick(); await f.tick();
  assert.equal(f.merged.length, 0, 'merging would land work the proposal may cancel');
  assert.equal(f.sub().pr.checkStatus, 'passing', 'the PR is still watched');
  f.store.action(f.job.id, 'discard-replan'); f.store.update(f.job.id, (j) => { j.subJobs[0].nextPollAt = 0; }); await f.tick();
  assert.equal(f.merged.length, 1);
});

test('an idea worded as a change on a PR holds nothing while the wrangler reads it: the green PR merges', async (t) => {
  const f = fixture(t); await atPr(f);
  change(f, 'api', 'Rename the flag to sign_in_v2'); await f.tick();
  assert.ok(plannerOf(f).run.ask, 'read by an ask run, as a question would be');
  assert.equal(f.store.get(f.job.id).replan ?? null, null);
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  assert.equal(f.merged.length, 1);
});

test('an idea holds nothing while the wrangler reads it: a green PR merges and the next step starts', async (t) => {
  const f = fixture(t); f.setDeploys({ expected: false }); await atPr(f, plan([spec('api'), sessionSpec('notes', ['api'])]));
  change(f, null, 'Also cover SSO'); await f.tick();
  assert.ok(reading(f), 'the wrangler is reading it');
  assert.equal(f.store.get(f.job.id).replan ?? null, null, 'no plan change until it proposes one');
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  assert.equal(f.merged.length, 1, 'the PR merges under Wrangler');
  f.setPr({ state: 'MERGED', mergeCommit: 'm1' }); f.store.update(f.job.id, (j) => { j.subJobs[0].nextPollAt = 0; }); await f.tick(); await f.tick();
  assert.ok(f.workerFor('notes', 'session'), 'and the step after it starts');
});

test('a fix added before five blocked steps sends them back to wait for it, unrelated work runs throughout, and all five start by themselves once it lands', async (t) => {
  const f = fixture(t, { ...input, reviewMerge: false });
  const five = ['csv', 'range', 'limit', 'page', 'stream'];
  await f.approve(plan([...five.map((id) => spec(id)), sessionSpec('docs', ['csv']), sessionSpec('notes')]));
  for (const id of five) f.report({ kind: 'blocked', summary: 'The shared export fixture fails to load' }, f.workerFor(id, 'implementation'));
  await f.tick();
  assert.ok(five.every((id) => f.store.get(f.job.id).subJobs.find((s) => s.id === id).error), 'five red on one cause');
  change(f, null, 'Five steps fail on the same fixture. Fix it first, then have them carry on by themselves.'); await f.tick();
  const planner = plannerOf(f);
  f.report({ kind: 'completed', checks: ['Notes taken'] }, f.workerFor('notes', 'session'));
  assert.notEqual(f.store.get(f.job.id).subJobs.find((s) => s.id === 'notes').stage, 'session', 'unrelated work finishes while the change is drawn');
  f.report({ kind: 'plan', plan: plan([spec('fix', [], { title: 'Fix the shared export fixture' }), ...five.map((id) => spec(id, ['fix'])), sessionSpec('docs', ['csv']), sessionSpec('notes')]) }, planner);
  assert.deepEqual(f.store.get(f.job.id).replan.proposal.changes.edited.map((e) => [e.id, e.fields]), five.map((id) => [id, ['after']]));
  assert.deepEqual(f.store.get(f.job.id).talk.at(-1).changes.map((c) => c.then), ['Starts now', ...five.map(() => 'Re-queued · starts after “Fix the shared export fixture”')], 'the card says what approval does to each');
  f.store.action(f.job.id, 'approve-replan', { proposalId: planner.run.id });
  const job = () => f.store.get(f.job.id);
  const at = (id) => job().subJobs.find((s) => s.id === id);
  for (const id of five) assert.deepEqual([at(id).stage, at(id).state, at(id).error, at(id).blocked], ['implementation', 'queued', null, null], `${id} waits for the fix`);
  assert.deepEqual(job().moves.filter((m) => m.move === 'replan' && /back to wait/.test(m.detail)).map((m) => m.subJobId), five);
  const before = f.launched.length;
  await f.tick();
  assert.deepEqual(f.launched.slice(before).map((w) => w.sub?.id), ['fix'], 'only the fix starts; the five wait behind it');
  markDone(f, 'fix'); await f.tick();
  assert.deepEqual(f.launched.slice(before + 1).map((w) => [w.sub.id, w.run.phase]), five.map((id) => [id, 'implementation']), 'the fix landed: all five start, nobody pressed anything');
});

test('an open PR moved behind a new fix keeps its code: no repair or merge until the fix lands, then its branch is updated, not reworked', async (t) => {
  const f = fixture(t, { ...input, reviewMerge: false, reviewCode: false }); await f.approve(plan([spec('web')]));
  const updated = []; f.github.updateBranch = async (s) => { updated.push(s.id); };
  f.report({ kind: 'published', url: PR_URL }, f.workerFor('web', 'implementation'));
  f.setPr({ checkStatus: 'failing' });
  f.store.update(f.job.id, (j) => { j.subJobs[0].error = 'Automatic repair limit reached. Review changes, then retry if needed.'; });
  change(f, null, 'Its checks fail on the shared fixture; fix that first'); await f.tick();
  const planner = plannerOf(f);
  f.report({ kind: 'plan', plan: plan([spec('fix'), spec('web', ['fix'])]) }, planner);
  f.store.action(f.job.id, 'approve-replan', { proposalId: planner.run.id });
  const web = () => f.store.get(f.job.id).subJobs.find((s) => s.id === 'web');
  assert.deepEqual([web().stage, web().error, web().fixRequested, !!web().catchUp], ['pr', null, null, true]);
  assert.equal(f.store.get(f.job.id).talk.findLast((m) => m.kind === 'proposal').changes.find((c) => c.title === 'Deliver web').then, 'Keeps its PR · branch updated after “Deliver fix”');
  assert.ok(f.store.get(f.job.id).moves.some((m) => m.subJobId === 'web' && /“Deliver web” to wait for its new prerequisites, then update its branch/.test(m.detail)));
  await f.tick(); await f.tick();
  assert.equal(f.workerFor('web', 'repair'), undefined, 'red checks wait for the fix, not a repair');
  assert.deepEqual([f.merged, updated], [[], []]);
  markDone(f, 'fix'); f.store.update(f.job.id, (j) => { j.subJobs.find((s) => s.id === 'web').nextPollAt = 0; }); await f.tick();
  assert.deepEqual(updated, ['web'], 'the branch takes the fix from the base');
  assert.equal(web().catchUp, null);
  assert.equal(f.launched.filter((w) => w.sub?.id === 'web' && w.run.phase !== 'implementation').length, 0, 'no agent reworked it');
});

test('a discarded plan change stops its planner quietly and ignores a late proposal', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api')]));
  assert.throws(() => f.store.action(f.job.id, 'discard-replan'), /No plan change/);
  drawing(f, 'Smaller'); await f.tick();
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

test('asking again replaces a waiting proposal and shows it to the next wrangler; a blocked planner says so in the conversation and stops nothing', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api')]));
  change(f, null, 'Add web'); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web')]) }); await f.tick();
  change(f, null, 'Web first'); await f.tick();
  const second = f.last();
  assert.match(jobPrompt(f.store.get(f.job.id), null, second.run), /A plan change you proposed is waiting for the human: .*"web"/);
  f.report({ kind: 'plan', plan: plan([spec('web'), spec('api', ['web'])]) }, second);
  assert.deepEqual([f.store.get(f.job.id).replan.earlier, f.store.get(f.job.id).replan.proposal.id], [['Add web'], second.run.id]);
  f.store.action(f.job.id, 'discard-replan'); await f.tick();
  drawing(f, 'Split api'); await f.tick();
  f.report({ kind: 'blocked', summary: 'Cannot tell which repo' }, plannerOf(f)); await f.tick();
  const job = f.store.get(f.job.id);
  assert.deepEqual([job.error ?? null, job.replan], [null, null], 'the job runs on; the change can be sent again');
  const said = job.talk.at(-1);
  assert.deepEqual([said.from, said.kind, said.text], ['wrangler', 'error', 'Could not draw the change: Cannot tell which repo. Send it again to retry.']);
  assert.equal(job.talk.at(-1).convo, job.talk.findLast((m) => m.from === 'human').convo, 'in the conversation it was asked in');
  assert.throws(() => f.store.action(f.job.id, 'discard-replan'), /No plan change/);
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

test('a BEHIND accepted-red head is updated, not --admin merged, and the acceptance follows the new head', async (t) => {
  const f = fixture(t); f.store.settings({ maxRepairs: 0 }); await atPr(f);
  const updated = []; f.github.updateBranch = async (s) => { updated.push(s.pr.head); };
  f.setPr({ checkStatus: 'failing', checks: [{ name: 'e2e', state: 'FAILURE' }] }); await f.tick();
  acceptRed(f, 'api', 'flaky');
  f.setPr({ mergeState: 'BEHIND', behind: false, dirty: false }); await f.tick();
  assert.deepEqual(updated, ['head1']); assert.deepEqual(f.merged, []);
  f.setPr({ head: 'head2', mergeState: 'BLOCKED' }); await f.tick();
  assert.equal(f.sub().acceptedRed.ref, 'head2'); assert.equal(f.sub().mergeApprovedHead, 'head2');
  assert.deepEqual(f.merged, ['head2']);
  const g = fixture(t); g.store.settings({ maxRepairs: 0 }); await atPr(g);
  g.github.updateBranch = async () => { throw new Error('should not update'); };
  g.setPr({ checkStatus: 'failing' }); await g.tick(); acceptRed(g, 'api');
  g.setPr({ mergeState: 'BEHIND', dirty: true }); await g.tick();
  assert.equal(g.sub().branchUpdate, undefined, 'a conflicted head is not updated');
});

test('a merge that needs admin rights the viewer lacks sets a sub-job error; a transient failure still retries', async (t) => {
  const f = fixture(t); await atPr(f);
  f.github.merge = async () => { throw Object.assign(new Error('Merging this PR needs admin rights on the repository.'), { needsAdmin: true }); };
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  assert.match(f.sub().error, /needs admin rights/); assert.equal(f.sub().observationError ?? null, null);
  const g = fixture(t); await atPr(g);
  g.github.merge = async () => { throw new Error('network down'); };
  g.setPr({ checkStatus: 'passing' }); await g.tick();
  assert.match(g.sub().observationError, /network down/); assert.ok(!g.sub().error);
});

test('merge refuses --admin for a viewer without admin permission, or when GitHub refuses the bypass', async () => {
  const redPr = { ...rawPr, mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ name: 'e2e', conclusion: 'FAILURE' }] };
  const { gh, sub, calls } = reviewGithub(redPr);
  sub.pr.mergeWithAdmin = false; sub.acceptedRed = { ref: 'head1', note: null, at: 1 };
  const run = gh.run;
  gh.run = async (bin, args, cwd) => (args[0] === 'repo' && args.includes('viewerPermission') ? JSON.stringify({ viewerPermission: 'WRITE' }) : run(bin, args, cwd));
  await assert.rejects(gh.merge(sub), (e) => e.needsAdmin && /needs admin rights/.test(e.message));
  assert.ok(!calls.some((a) => a[1] === 'merge'));
  const h = reviewGithub(redPr); h.sub.pr.mergeWithAdmin = false; h.sub.acceptedRed = { ref: 'head1', note: null, at: 1 };
  const run2 = h.gh.run;
  h.gh.run = async (bin, args, cwd) => { if (args[1] === 'merge') throw Object.assign(new Error('x'), { stderr: 'the base branch policy prohibits the merge; --admin is not permitted' }); return run2(bin, args, cwd); };
  await assert.rejects(h.gh.merge(h.sub), (e) => e.needsAdmin);
  const k = reviewGithub(redPr); k.sub.pr.mergeWithAdmin = false; k.sub.acceptedRed = { ref: 'head1', note: null, at: 1 };
  const run3 = k.gh.run;
  k.gh.run = async (bin, args, cwd) => { if (args[1] === 'merge') throw new Error('network down'); return run3(bin, args, cwd); };
  await assert.rejects(k.gh.merge(k.sub), (e) => !e.needsAdmin && /network down/.test(e.message));
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

// --- Proposals that carry actions (design A2) ---

test('a planner\'s receipt may carry a diagnosis, ranked options and actions; the human picks one', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web', ['api'])]));
  f.alive.delete(f.workerFor('api').sid); await f.tick();
  f.store.update(f.job.id, (j) => { Object.assign(j.subJobs[0], { stage: 'deployment', state: 'watching', pr: { url: 'https://github.com/o/r/pull/1', head: 'h1', mergeCommit: 'm1' }, deploymentResult: { status: 'failing' } }); });
  change(f, 'api', 'The deploy failed'); await f.tick();
  const planner = f.last();
  const prompt = jobPrompt(f.store.get(f.job.id), null, planner.run);
  assert.match(prompt, /post-merge run FAILING at merge m1/); assert.match(prompt, /ACTIONS on a live sub-job/); assert.match(prompt, /alternatives\?/);
  const both = plan([spec('api'), spec('web', ['api']), spec('fix')]);
  assert.throws(() => f.report({ kind: 'plan', plan: both, actions: [{ type: 'recover', sub: 'api', fix: 'ghost' }] }, planner), /id of a PR sub-job/);
  f.report({ kind: 'plan', plan: both, label: 'Recover with a PR', why: 'Fix the migration', actions: [{ type: 'recover', sub: 'api', fix: 'fix' }],
    diagnosis: { summary: 'The migration is not idempotent', evidence: [{ label: 'run 1', detail: 'column exists' }] },
    alternatives: [{ label: 'Accept the failed run', plan: plan([spec('api'), spec('web', ['api'])]), actions: [{ type: 'accept-red', sub: 'api' }] }] }, planner);
  const proposal = f.store.get(f.job.id).replan.proposal;
  assert.deepEqual([proposal.label, proposal.diagnosis.summary, proposal.alternatives.length, proposal.actions[0].pin], ['Recover with a PR', 'The migration is not idempotent', 1, { at: 'merge', ref: 'm1' }]);
  f.store.action(f.job.id, 'approve-replan', { proposalId: proposal.id, option: 1 });
  const job = f.store.get(f.job.id);
  assert.deepEqual([job.subJobs[0].acceptedRed.ref, job.subJobs[0].recoveredBy, job.subJobs.some((s) => s.id === 'fix')], ['m1', undefined, false]);
});

test('a proposal whose step merged before approval goes back to the planner, and the history says so', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  f.alive.delete(f.workerFor('api').sid); await f.tick();
  f.store.update(f.job.id, (j) => { Object.assign(j.subJobs[0], { stage: 'pr', state: 'watching', pr: { url: PR_URL, head: 'h1', checkStatus: 'passing' } }); });
  change(f, 'api', 'Rename the flag'); await f.tick();
  const planner = plannerOf(f);
  f.report({ kind: 'plan', plan: plan([spec('api', [], { brief: 'Implement api with the renamed flag' }), spec('web')]) }, planner);
  const proposal = f.store.get(f.job.id).replan.proposal;
  f.alive.delete(planner.sid); await f.tick();
  f.store.update(f.job.id, (j) => { Object.assign(j.subJobs[0], { stage: 'deployment', mergedAt: Date.now() }); });
  f.store.action(f.job.id, 'approve-replan', { proposalId: proposal.id });
  const job = f.store.get(f.job.id);
  assert.equal(job.replan.proposal, null);
  assert.deepEqual(job.moves.slice(-2).map((m) => [m.move, m.subJobId, m.detail]), [
    ['replan-sent-back', null, 'Sent the plan change back to Wrangler: “Deliver api” has merged since it was proposed'],
    ['replan-sent-back', 'api', '“Deliver api” has merged since the plan change was proposed, so it went back to Wrangler']]);
  await f.tick();
  const again = plannerOf(f);
  assert.notEqual(again.run.id, planner.run.id, 'a fresh planning run picks it up');
  assert.match(jobPrompt(f.store.get(f.job.id), null, again.run), /Rename the flag[\s\S]*“Deliver api” \(api\) has merged/);
});

// ---- Red steps (job-red.js): a red step goes up one level before it goes to the human ----
// api is at its PR with failing checks and no CI repairs left, so it is red; red handling is on.
async function redApi(t, { flags = {}, settings = {}, specs = [spec('api')] } = {}) {
  const f = fixture(t);
  f.store.settings({ maxRepairs: 0, maxReplans: 2, ...settings });
  f.store.update(f.job.id, (j) => { j.reviewMerge = false; });
  await f.approve(plan(specs));
  f.report({ kind: 'published', url: PR_URL }, f.workerFor('api'));
  f.store.update(f.job.id, (j) => Object.assign(j, flags));
  f.setPr({ checkStatus: 'failing', checks: [{ name: 'e2e', state: 'FAILURE' }] }); await f.tick();
  assert.match(f.sub().error, /repair limit/);
  return f;
}
const redJob = (f) => f.store.get(f.job.id);
const rework = (note = 'Stabilise the e2e wait') => [{ type: 'rework', sub: 'api', note }];

test('Red steps is the sixth checkpoint: You decide by default, switched per job; Replans per step is a setting', async (t) => {
  const f = fixture(t);
  assert.equal(f.job.reviewRed, true);
  assert.equal(f.store.snapshot().settings.reviewDefaults.reviewRed, true);
  assert.equal(f.store.snapshot().settings.maxReplans, 0, 'this fixture turns it off');
  assert.equal(new JobStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-')), 'jobs.json')).snapshot().settings.maxReplans, 2, 'two tries per step by default');
  assert.throws(() => f.store.settings({ maxReplans: 6 })); assert.throws(() => f.store.settings({ maxReplans: -1 }));
  await f.approve();
  f.store.action(f.job.id, 'set-review', { field: 'reviewRed', you: false });
  assert.equal(redJob(f).reviewRed, false);
  assert.equal(redJob(f).moves.at(-1).detail, 'Switched Red steps to Wrangler replans');
  f.store.action(f.job.id, 'set-review', { field: 'reviewRed', you: true });
  assert.equal(redJob(f).moves.at(-1).detail, 'Switched Red steps to You decide');
  assert.equal(f.store.create({ ...input, reviewRed: false }).reviewRed, false, 'a new job takes it too');
});

test('a red step is sent to the planner, which holds only that step; "Replans per step" 0 leaves red to the human', async (t) => {
  const f = await redApi(t, { specs: [spec('api'), spec('web'), spec('later', ['api'])] });
  await f.tick();
  const planner = f.last();
  assert.deepEqual([planner.run.phase, planner.sub, planner.run.red], ['planning', null, { sub: 'api' }]);
  assert.deepEqual(redJob(f).replan.red, { sub: 'api', auto: false, n: 1 });
  const prompt = jobPrompt(redJob(f), null, planner.run);
  assert.match(prompt, /one of its steps has gone red/); assert.match(prompt, /RED STEP: “Deliver api” \(api, pr\/watching\).*try 1 of 2/);
  assert.match(prompt, /failing checks: e2e/); assert.match(prompt, /"You decide": whatever you propose waits/); assert.match(prompt, /kind:"escalate"/);
  assert.match(prompt, /options\?:\[\{label, why\?, leaves\?, plan, actions\?\}\].*`ask` is its heading and the summary's FIRST sentence is the only line under it/, 'an escalation is written for its card');
  // Only the red step and what follows it are held: web carries on, the rest of the job is not frozen.
  f.store.update(f.job.id, (j) => { const w = j.subJobs.find((s) => s.id === 'web'); w.stage = 'review'; w.state = 'verified'; w.ready = { checks: ['ok'], receiptId: 'rcpt', at: 1 }; });
  f.store.action(f.job.id, 'approve-code', { subJobId: 'web', readyReceiptId: 'rcpt' });
  assert.throws(() => f.store.action(f.job.id, 'approve-merge', { subJobId: 'later', head: 'h' }), /plan change is pending/);
  assert.equal(f.launched.filter((w) => w.run.red).length, 1, 'one replan at a time');
  await f.tick();
  assert.equal(f.launched.filter((w) => w.run.red).length, 1);

  const g = await redApi(t, { settings: { maxReplans: 0 } }); await g.tick();
  assert.ok(!redJob(g).replan, 'handling is off: it waits for the human as before');
  assert.equal(g.launched.filter((w) => w.run.phase === 'planning').length, 1, 'only the first plan');
});

test('under You decide the proposed fix waits; discarding it is not asked again for that failure, and Retry grants one more try', async (t) => {
  const f = await redApi(t); await f.tick();
  const planner = f.last();
  f.report({ kind: 'plan', plan: redJob(f).plan, diagnosis: { summary: 'The e2e times out on the SSO stub' }, actions: rework() }, planner);
  let job = redJob(f);
  assert.equal(job.replan.proposal.actions[0].type, 'rework');
  assert.match(job.subJobs[0].error, /repair limit/, 'nothing applied by itself');
  assert.deepEqual(job.subJobs[0].red.attempts.map((a) => [a.summary, a.outcome]), [['The e2e times out on the SSO stub', 'proposed']]);
  f.store.action(f.job.id, 'discard-replan', {});
  await f.tick(); await f.tick();
  assert.equal(redJob(f).replan, null);
  assert.equal(f.launched.filter((w) => w.run.red).length, 1, 'the human turned this fix down: no second triage of the same red');
  f.store.action(f.job.id, 'retry', { subJobId: 'api' });
  assert.equal(redJob(f).subJobs[0].replanAllowance, 1);
  assert.equal(redJob(f).subJobs[0].red.held, null);
});

test('under Wrangler replans a rework applies by itself, recorded as the human\'s approval would be', async (t) => {
  const f = await redApi(t, { flags: { reviewRed: false } }); await f.tick();
  assert.equal(redJob(f).replan.red.auto, true);
  f.report({ kind: 'plan', plan: redJob(f).plan, diagnosis: { summary: 'Flaky wait on the SSO stub' }, actions: rework() }, f.last());
  const job = redJob(f);
  assert.equal(job.replan, null);
  assert.deepEqual([job.subJobs[0].error, job.subJobs[0].stage, job.subJobs[0].note], [null, 'implementation', 'Stabilise the e2e wait']);
  assert.deepEqual(job.moves.filter((m) => /replan/.test(m.move)).map((m) => m.move), ['approve-replan', 'replan']);
  assert.match(job.moves.find((m) => m.move === 'approve-replan').detail, /\(Red steps: Wrangler replans\)/);
  assert.deepEqual(job.subJobs[0].red.attempts.map((a) => a.outcome), ['applied']);
});

test('Wrangler replans never applies Accept red, Mark done, Recover, a plan edit under Plan: You, or a cancelled PR', async (t) => {
  // accept-red claims something about the outside world: always the human's.
  const f = await redApi(t, { flags: { reviewRed: false } }); await f.tick();
  f.report({ kind: 'plan', plan: redJob(f).plan, diagnosis: { summary: 'Unrelated flake' }, actions: [{ type: 'accept-red', sub: 'api', note: 'flaky' }] }, f.last());
  assert.ok(redJob(f).replan.proposal, 'waits as Fix ready'); assert.match(redJob(f).subJobs[0].error, /repair limit/);
  // A plan edit waits unless the Plan checkpoint is Auto.
  const g = await redApi(t, { flags: { reviewRed: false } }); await g.tick();
  g.report({ kind: 'plan', plan: plan([spec('api'), spec('docs')]), diagnosis: { summary: 'Add docs' } }, g.last());
  assert.ok(redJob(g).replan.proposal);
  const h = await redApi(t, { flags: { reviewRed: false, reviewPlan: false } }); await h.tick();
  h.report({ kind: 'plan', plan: plan([spec('api'), spec('docs')]), diagnosis: { summary: 'Add docs' }, actions: rework() }, h.last());
  assert.equal(redJob(h).replan, null); assert.ok(redJob(h).subJobs.some((s) => s.id === 'docs'), 'Plan on Auto lets it through');
  // Cancelling a sub-job whose PR is open is never automatic, even then.
  const k = await redApi(t, { flags: { reviewRed: false, reviewPlan: false }, specs: [spec('api'), spec('web')] }); await k.tick();
  k.report({ kind: 'plan', plan: plan([spec('web')]), diagnosis: { summary: 'Drop api' } }, k.last());
  assert.ok(redJob(k).replan.proposal, 'api has an open PR');
});

test('a proposal with nothing to change declares the step red instead of waiting on nothing', async (t) => {
  const f = await redApi(t); await f.tick();
  f.report({ kind: 'plan', plan: redJob(f).plan, diagnosis: { summary: 'I cannot tell why it fails' } }, f.last());
  const job = redJob(f);
  assert.equal(job.replan, null);
  assert.equal(job.subJobs[0].red.declared.summary, 'I cannot tell why it fails');
  assert.deepEqual(job.moves.filter((m) => m.move === 'declare-red').length, 1);
});

// Two steps fetching in one checkout at once: the step never started, and a fresh
// start is the whole fix.
const LOCK = "Command failed: git fetch origin: error: cannot lock ref 'refs/remotes/origin/main': is at e1 but expected a5";
async function lockedApi(t, flags = {}) {
  const f = fixture(t); f.store.settings({ maxReplans: 2 });
  f.store.update(f.job.id, (j) => Object.assign(j, flags));
  const launch = f.runtime.launch; let race = true;
  f.runtime.launch = async (j, s, r, prepared) => { if (s && race) { race = false; throw new Error(LOCK); } return launch(j, s, r, prepared); };
  await f.approve(); await f.tick();
  assert.equal(f.sub().error, LOCK);
  return f;
}

test('a retry the wrangler suggests waits for the human even under Wrangler replans; approving it starts the step again', async (t) => {
  const f = await lockedApi(t, { reviewRed: false });
  const planner = plannerOf(f);
  assert.deepEqual([planner.run.red, redJob(f).replan.red.auto], [{ sub: 'api' }, true]);
  const prompt = jobPrompt(redJob(f), null, planner.run);
  assert.match(prompt, /\{type:"retry",sub,note\?\} starts a RED step again as it is/);
  assert.match(prompt, /accept-red, mark, recover and retry never do/);
  assert.match(jobReportTool.description, /retry \(a red step started again as it is; always waits for the human\)/);
  f.report({ kind: 'plan', plan: redJob(f).plan, diagnosis: { summary: 'Two steps fetched in the same checkout at once; the step never started.' }, actions: [{ type: 'retry', sub: 'api' }] }, planner);
  let job = redJob(f);
  assert.deepEqual(job.replan.proposal.actions, [{ type: 'retry', sub: 'api', pin: { at: 'red', ref: `${LOCK}|||1` } }]);
  assert.equal(job.subJobs[0].error, LOCK, 'not restarted by itself');
  assert.ok(!job.moves.some((m) => m.move === 'approve-replan'));
  assert.deepEqual(job.subJobs[0].red.attempts.map((a) => a.outcome), ['proposed']);
  await f.tick();
  assert.equal(f.launched.filter((w) => w.sub?.id === 'api').length, 0, 'not started while it waits');

  f.store.action(f.job.id, 'approve-replan', { proposalId: job.replan.proposal.id, option: 0 });
  job = redJob(f);
  assert.deepEqual([job.replan, job.subJobs[0].error, job.subJobs[0].stage, job.subJobs[0].state], [null, null, 'implementation', 'queued']);
  assert.equal(job.moves.at(-1).detail, 'Retried “Deliver api”');
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api', 'implementation']);
  assert.equal(redJob(f).subJobs[0].error, null);
});

test('a retry the wrangler suggested goes back to it once the step has failed differently', async (t) => {
  const f = await lockedApi(t);
  f.report({ kind: 'plan', plan: redJob(f).plan, diagnosis: { summary: 'A fetch race' }, actions: [{ type: 'retry', sub: 'api' }] }, plannerOf(f));
  f.store.update(f.job.id, (j) => { j.subJobs[0].error = 'Command failed: git worktree add'; });
  await f.tick();
  f.store.action(f.job.id, 'approve-replan', { proposalId: redJob(f).replan.proposal.id, option: 0 });
  assert.equal(redJob(f).replan.proposal, null, 'not applied');
  assert.match(redJob(f).replan.feedback, /could not apply because the job moved under it: “Deliver api” \(api\) has moved \(failure /);
});

test('the red replan prompt says an unchanged plan declares the step red, so its summary never talks about approving', async (t) => {
  const f = await lockedApi(t);
  const prompt = jobPrompt(redJob(f), null, plannerOf(f).run);
  assert.match(prompt, /An unchanged plan with no actions changes nothing: it declares the step red to the human, and your diagnosis.summary is what they read on it, so say what you found and the decision they need, never what approving would do \(there is nothing to approve\)\./);
  f.report({ kind: 'plan', plan: redJob(f).plan, diagnosis: { summary: 'Two fetches raced in the main checkout and one lost the ref lock. Retry the step: nothing in it needs to change.' } }, plannerOf(f));
  const declared = redJob(f).subJobs[0].red.declared;
  assert.doesNotMatch(declared.summary, /approv/i);
  assert.equal(declared.ask, 'Decide how to carry on: send an idea in, accept the red, or retry');
});

test('out of tries, a step is declared red with every attempt listed; a declared red is not triaged again', async (t) => {
  const f = await redApi(t, { flags: { reviewRed: false }, settings: { maxReplans: 1 } }); await f.tick();
  f.report({ kind: 'plan', plan: redJob(f).plan, diagnosis: { summary: 'Raised the e2e timeout' }, actions: rework('Raise the timeout') }, f.last());
  f.store.update(f.job.id, (j) => { j.subJobs[0].error = 'Automatic repair limit reached. Review changes, then retry if needed.'; });
  await f.tick();
  const job = redJob(f);
  assert.equal(job.replan, null); assert.equal(f.launched.filter((w) => w.run.red).length, 1);
  const declared = job.subJobs[0].red.declared;
  assert.deepEqual([declared.auto, declared.by, declared.tried], [true, 'auto', ['Replan 1: Raised the e2e timeout']]);
  assert.match(declared.summary, /used its 1 automatic try on this step/);
  assert.match(job.moves.at(-1).detail, /Declared “Deliver api” red to you: 1 automatic try used/);
  await f.tick(); await f.tick();
  assert.equal(f.launched.filter((w) => w.run.red).length, 1);
  // The human's Retry is one more try, and a new failure is judged afresh.
  f.store.action(f.job.id, 'retry', { subJobId: 'api' });
  assert.equal(redJob(f).subJobs[0].red.declared, null);
});

test('the planner escalates with options: the step is declared red and the options open as the proposal', async (t) => {
  const f = await redApi(t); await f.tick();
  const planner = f.last();
  assert.throws(() => f.report({ kind: 'escalate', summary: 'x', ask: 'Merge or wait?', sub: 'ghost' }, planner), /not one/);
  f.report({ kind: 'escalate', summary: 'login-flow.spec is flaky on main and quarantining it needs QA sign-off', tried: ['Reran e2e twice', 'Added a wait'], ask: 'Merge #1 with the red check, or hold it?',
    options: [{ label: 'Accept red and merge', plan: redJob(f).plan, actions: [{ type: 'accept-red', sub: 'api' }] }, { label: 'Hold for QA', plan: redJob(f).plan, actions: rework('Wait for QA') }] }, planner);
  const job = redJob(f);
  assert.deepEqual([job.subJobs[0].red.declared.ask, job.subJobs[0].red.declared.by, job.subJobs[0].red.declared.tried.slice(-2)], ['Merge #1 with the red check, or hold it?', 'planner', ['Reran e2e twice', 'Added a wait']]);
  assert.equal(job.replan.proposal.escalation.sub, 'api'); assert.equal(job.replan.proposal.alternatives.length, 1);
  assert.equal(job.replan.proposal.diagnosis.summary, job.subJobs[0].red.declared.summary);
  f.store.action(f.job.id, 'approve-replan', { proposalId: job.replan.proposal.id, option: 0 });
  assert.equal(redJob(f).subJobs[0].acceptedRed.ref, 'head1');
  assert.equal(redJob(f).replan, null);
});

test('a step agent may declare its own step red, or ask for a replan: blocked and replan go to the planner, escalate to you', async (t) => {
  const f = fixture(t); f.store.settings({ maxReplans: 2 }); await f.approve();
  assert.throws(() => f.report({ kind: 'escalate', summary: 'x', ask: 'y', options: [{ label: 'a', plan: plan() }] }), /Only the planner/);
  f.report({ kind: 'replan', summary: 'The API needs a schema change first', why: 'Another service owns the table' }); await f.tick();
  let job = redJob(f);
  assert.deepEqual([job.subJobs[0].error, job.subJobs[0].blocked.kind, job.subJobs[0].blocked.why], ['The API needs a schema change first', 'replan', 'Another service owns the table']);
  await f.tick();
  assert.match(redJob(f).replan.feedback, /said it needs more than its step: The API needs a schema change first \(Another service owns the table\)/);
  assert.equal(f.last().run.phase, 'planning');

  const g = fixture(t); g.store.settings({ maxReplans: 2 }); await g.approve();
  g.report({ kind: 'escalate', summary: 'Production creds are needed to test this', tried: ['Looked in the vault'], ask: 'Can you supply a read-only key?' });
  await g.tick(); await g.tick();
  job = g.store.get(g.job.id);
  assert.deepEqual([job.subJobs[0].red.declared.ask, job.subJobs[0].red.declared.by], ['Can you supply a read-only key?', 'agent']);
  assert.ok(!job.replan, 'declared by its own agent: nobody is sent after it');
  assert.equal(g.launched.filter((w) => w.run.phase === 'planning').length, 1, 'only the first plan');
  assert.throws(() => g.report({ kind: 'replan', summary: 'x' }, g.launched.find((w) => w.run.phase === 'planning')), /already submitted|must submit/);
});

test('a planner that blocks or dies on a red step declares it; the job is never held with job.error', async (t) => {
  const f = await redApi(t); await f.tick();
  f.report({ kind: 'blocked', summary: 'Cannot read the CI logs' }, f.last());
  let job = redJob(f);
  assert.deepEqual([job.error ?? null, job.replan], [null, null]);
  assert.match(job.subJobs[0].red.declared.summary, /could not replan this step: Cannot read the CI logs/);
  const g = await redApi(t); await g.tick();
  g.alive.delete(g.last().sid); await g.tick();
  job = g.store.get(g.job.id);
  assert.deepEqual([job.error ?? null, job.replan], [null, null]);
  assert.match(job.subJobs[0].red.declared.summary, /Session stopped without a receipt/);
});

test('a human\'s idea on a declared red goes to the planner with what it found, still holding only that step', async (t) => {
  const f = await redApi(t); await f.tick();
  f.report({ kind: 'escalate', summary: 'Needs QA sign-off', ask: 'Wait for QA?' }, f.last()); await f.tick();
  change(f, 'api', 'QA is away; accept it'); 
  const job = redJob(f);
  assert.deepEqual([job.replan.red.sub, job.replan.red.human, job.replan.red.auto], ['api', true, false]);
  assert.match(job.replan.feedback, /Needs QA sign-off/); assert.match(job.replan.feedback, /QA is away; accept it/);
});

test('settings saved before Replans per step existed read the default of two, so red handling is on for an upgraded install', async (t) => {
  const f = await redApi(t, { settings: {} });
  // Simulate a jobs.json written before the setting: the key is simply absent.
  f.store.change((d) => { delete d.settings.maxReplans; });
  await f.tick();
  assert.deepEqual(redJob(f).replan?.red, { sub: 'api', auto: false, n: 1 });
});

test('a PR may land on its own base; an old plan has none, and no other kind may name one', async () => {
  const { planSchema } = await import('./jobs-schema.js');
  const plan = (s) => ({ context: '', subJobs: [{ id: 'a', title: 'A', brief: 'b', ...s }] });
  assert.equal(planSchema.parse(plan({ repo: '/repo' })).subJobs[0].base, undefined);
  assert.equal(planSchema.parse(plan({ repo: '/repo', base: ' release/2.x ' })).subJobs[0].base, 'release/2.x');
  assert.throws(() => planSchema.parse(plan({ repo: '/repo', base: '-D' })), /branch name/);
  assert.throws(() => planSchema.parse(plan({ kind: 'session', base: 'next' })), /only a PR lands on a branch/);
});

test('an unpushed commit on local main leaves merged sub-jobs done and one notice for the checkout', async (t) => {
  const git = (cwd, ...args) => execGit(cwd, args);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), other = path.join(dir, 'other');
  await execFileP('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await execFileP('git', ['clone', '-q', origin, repo]);
  const commit = async (cwd, file, message) => { fs.writeFileSync(path.join(cwd, file), `${message}\n`); await git(cwd, 'add', file); await git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message); };
  await commit(repo, 'README.md', 'Initial');
  await git(repo, 'push', '-q', 'origin', 'HEAD:main');
  await execFileP('git', ['clone', '-q', origin, other]);
  // Two PRs land on origin while another session has a commit of its own on local main.
  for (const n of [1, 2]) { await commit(other, `pr${n}.js`, `Merged PR ${n}`); await git(other, 'push', '-q', 'origin', 'HEAD:main'); }
  await commit(repo, 'local.js', 'Unpushed work from another session');
  const localHead = await git(repo, 'rev-parse', 'HEAD');

  const f = fixture(t); await f.approve(plan([spec('api', [], { repo }), spec('web', [], { repo })])); f.alive.clear(); await f.tick();
  assert.equal(settingsSchema.parse(f.store.data.settings).updateMain, true, 'on by default, for every job');
  const spawned = [];
  const real = new JobRuntime({ host: { sessions: { get: () => null, spawn: async (o) => { spawned.push(o); return { sessionId: 's_fix' }; } } } });
  f.runtime.cleanup = (j, s, o) => real.cleanup(j, { ...s, worktree: null }, o);
  for (const k of ['retryMain', 'resolveMain', 'mainCaughtUp']) f.runtime[k] = (...a) => real[k](...a);
  for (const id of ['api', 'web']) {
    markDone(f, id, 'Merged');
    f.store.update(f.job.id, (j) => { j.subJobs.find((s) => s.id === id).pr = { url: `${PR_URL}${id}`, head: 'h', base: 'main' }; });
  }
  await f.tick();
  const job = f.store.get(f.job.id);
  assert.deepEqual(job.subJobs.map((s) => [s.id, s.stage, s.state, s.error || null]), [['api', 'done', 'done', null], ['web', 'done', 'done', null]], 'the update never blocks a sub-job');
  assert.equal(job.mainNotices.length, 1, 'one checkout, one notice');
  const [notice] = job.mainNotices;
  assert.equal(notice.path, fs.realpathSync(repo));
  assert.equal(notice.reason, 'diverged');
  assert.deepEqual(notice.subs, ['api', 'web']);
  assert.deepEqual(notice.localOnly.map((c) => c.subject), ['Unpushed work from another session']);
  assert.deepEqual(notice.incoming.map((c) => c.subject), ['Merged PR 2', 'Merged PR 1']);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), localHead, 'the human\'s commit is never moved');
  assert.deepEqual(new JobStore(f.store.file).get(f.job.id).mainNotices, job.mainNotices, 'kept across a restart');
  assert.deepEqual(notice.resolutions.map((r) => r.id), ['rebase', 'branch'], 'stashing cannot reconcile commits, so it is not offered');

  // A resolution button: refused unless offered, then spawned on the next tick in the checkout.
  assert.throws(() => f.store.action(f.job.id, 'resolve-main', { path: notice.path, resolution: 'stash' }), /does not apply/);
  f.store.action(f.job.id, 'resolve-main', { path: notice.path, resolution: 'rebase' });
  assert.throws(() => f.store.action(f.job.id, 'resolve-main', { path: notice.path, resolution: 'branch' }), /already working/);
  await f.tick();
  assert.equal(spawned.length, 1);
  const [s] = spawned;
  assert.equal(s.cwd, notice.path);
  assert.equal(s.worktree, undefined, 'the human\'s own checkout, not a worktree');
  assert.match(s.intent, /The human chose one fix: Rebase & push\. Do exactly that/);
  assert.match(s.intent, /git rebase --autostash origin\/main/);
  assert.match(s.intent, /Local commits not on origin \(1\):\n {2}- [0-9a-f]{12} "Unpushed work from another session"/);
  assert.match(s.intent, /New on origin\/main \(2\):/);
  assert.equal(f.store.get(f.job.id).mainNotices[0].resolving.sessionId, 's_fix');
  await f.tick();
  assert.equal(spawned.length, 1, 'one session per press');
  assert.equal(f.store.get(f.job.id).mainNotices.length, 1, 'kept while main is still behind');

  // The session does its one fix; the next tick sees main level with origin and clears the notice.
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'pull', '-q', '--rebase', 'origin', 'main');
  await git(repo, 'push', '-q', 'origin', 'main');
  await f.tick();
  assert.deepEqual(f.store.get(f.job.id).mainNotices, []);
  assert.throws(() => f.store.action(f.job.id, 'dismiss-main', { path: notice.path }), /no longer needs updating/);

  // Retry, once the human has fixed it by hand, clears it too.
  await git(other, 'pull', '-q', 'origin', 'main');
  await commit(other, 'pr3.js', 'Merged PR 3'); await git(other, 'push', '-q', 'origin', 'HEAD:main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'edited\n');
  const stuck = await real.retryMain(notice);
  assert.equal(stuck.reason, 'dirty');
  f.store.update(f.job.id, (j) => { j.mainNotices = [{ ...stuck, subs: ['api'], at: 1, retrying: false, resolutions: [{ id: 'stash' }] }]; });
  await git(repo, 'checkout', '--', 'README.md');
  f.store.action(f.job.id, 'retry-main', { path: notice.path });
  assert.equal(f.store.get(f.job.id).mainNotices[0].retrying, true);
  await f.tick();
  assert.deepEqual(f.store.get(f.job.id).mainNotices, []);
});

test('a resolution session that cannot start says why and offers the buttons again', async (t) => {
  const f = fixture(t);
  f.store.update(f.job.id, (j) => { j.mainNotices = [{ path: '/home/me/repo', base: 'main', reason: 'dirty', dirty: [{ path: 'a.js', change: 'modified' }], dirtyCount: 1, localOnly: [], localCount: 0, incoming: [], incomingCount: 2, subs: ['api'], at: 1, retrying: false, resolutions: [{ id: 'stash' }] }]; });
  f.runtime.resolveMain = async () => { throw new Error('no such directory'); };
  f.store.action(f.job.id, 'resolve-main', { path: '/home/me/repo', resolution: 'stash' });
  await f.tick();
  const [n] = f.store.get(f.job.id).mainNotices;
  assert.equal(n.resolving, null);
  assert.equal(n.resolveError, 'no such directory');
  assert.match(f.store.get(f.job.id).moves.at(-1).detail, /Asked an agent to stash & update in \/home\/me\/repo/);
});

test('Dismiss forgets a checkout notice and records it; a failed Retry keeps it with the new state', async (t) => {
  const f = fixture(t);
  const notice = { path: '/home/me/repo', base: 'main', reason: 'dirty', dirty: [{ path: 'a.js', change: 'modified' }], dirtyCount: 1, localOnly: [], localCount: 0, incoming: [], incomingCount: 0, subs: ['api'], at: 1, retrying: false };
  f.store.update(f.job.id, (j) => { j.mainNotices = [notice]; });
  f.runtime.retryMain = async (n) => ({ ...n, reason: 'diverged', localCount: 1, localOnly: [{ sha: 'abc', subject: 'Local' }] });
  f.store.action(f.job.id, 'retry-main', { path: notice.path });
  await f.tick();
  const [kept] = f.store.get(f.job.id).mainNotices;
  assert.equal(kept.reason, 'diverged'); assert.equal(kept.retrying, false); assert.deepEqual(kept.subs, ['api']);
  f.store.action(f.job.id, 'dismiss-main', { path: notice.path });
  assert.deepEqual(f.store.get(f.job.id).mainNotices, []);
  assert.match(f.store.get(f.job.id).moves.at(-1).detail, /Left \/home\/me\/repo as it was/);
});

// ---- The job's conversation with the wrangler (job-talk.js) ----
const talk = (f) => (f.store.get(f.job.id).talk || []).map((m) => [m.from, m.kind || null, m.text, m.sub || null]);

test('a question is answered in the job\'s conversation: an ask run that holds nothing and proposes nothing', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  change(f, 'api', 'Why did the api step take so long?');
  let job = f.store.get(f.job.id);
  assert.equal(job.replan ?? null, null, 'no plan change: nothing is held');
  assert.deepEqual(talk(f), [['human', null, 'Why did the api step take so long?', 'api']]);
  await f.tick();
  const asker = plannerOf(f);
  assert.equal(asker.run.ask, job.talk[0].id, 'an ask run, tied to the question');
  assert.equal(asker.run.convo, job.convos[0].id, 'and to its conversation');
  const prompt = jobPrompt(f.store.get(f.job.id), null, asker.run);
  assert.match(prompt, /^Answer or act on an idea about this running job/);
  assert.match(prompt, /WRITTEN TO YOU about it .*: a question, or a change they want/); assert.match(prompt, /You may answer or propose/);
  assert.match(prompt, /The human wrote: About “Deliver api” \(api, implementation\/\w+\): Why did the api step/);
  assert.match(prompt, /read_session_transcript/); assert.match(prompt, /kind:"reply"/);
  assert.match(prompt, /reads the FIRST LINE of your text at a glance, so the first line is the answer itself/, 'the reply leads with the answer');
  assert.match(prompt, /what they can do, and what happens if they leave it\. Cut background, history and explanation they did not ask for/);
  assert.doesNotMatch(prompt, /short paragraphs|at most 4000 characters/, 'phrasing rules, never a length');
  assert.match(prompt, /The human \(on api\): "Why did the api step take so long\?"/, 'the conversation so far rides along');
  f.report({ kind: 'reply', text: 'It waited on a slow test suite.' }, asker);
  job = f.store.get(f.job.id);
  assert.deepEqual(talk(f).at(-1), ['wrangler', 'answer', 'It waited on a slow test suite.', 'api'], 'answered on the step it was asked on');
  assert.equal(job.convos[0].pending, null); assert.equal(job.replan ?? null, null);
  f.report({ kind: 'reply', text: 'It waited on a slow test suite.' }, asker);
  await f.tick();
  assert.equal(f.store.get(f.job.id).runs.find((r) => r.id === asker.run.id).stopped, true, 'the answer ends the run');
  assert.equal(f.store.get(f.job.id).error, null);
});

test('a change idea is read like a question, then proposed, drawn in the conversation as a card that records what became of it', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  change(f, null, 'Add a CLI after web'); await f.tick();
  assert.deepEqual(talk(f), [['human', null, 'Add a CLI after web', null]]);
  const planner = plannerOf(f);
  assert.ok(planner.run.ask, 'an ask run, whatever its wording');
  assert.equal(f.store.get(f.job.id).replan ?? null, null, 'nothing held while it reads');
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('cli', ['web'])]), diagnosis: { summary: 'Adds the CLI once web lands.' } }, planner);
  let card = f.store.get(f.job.id).talk.at(-1);
  assert.deepEqual([card.from, card.kind, card.proposalId, card.text, card.outcome], ['wrangler', 'proposal', planner.run.id, 'Adds the CLI once web lands.', undefined]);
  assert.deepEqual(card.changes, [{ mark: 'added', title: 'Deliver cli', then: 'Starts after “Deliver web”' }], 'with what approval does to it');
  await f.tick();
  f.store.action(f.job.id, 'discard-replan');
  change(f, null, 'Add a CLI after web'); await f.tick();
  const again = plannerOf(f);
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('cli', ['web'])]) }, again);
  f.store.action(f.job.id, 'approve-replan', { proposalId: again.run.id });
  card = f.store.get(f.job.id).talk.at(-1);
  assert.equal(card.outcome, 'approved');

  assert.deepEqual(f.store.get(f.job.id).talk.filter((m) => m.kind === 'proposal').map((m) => m.outcome), ['discarded', 'approved']);
});

test('a question that asks for a change is proposed by its ask run, folding into a proposal already waiting', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  change(f, null, 'Add a CLI after web'); await f.tick();
  const first = plannerOf(f);
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('cli', ['web'])]) }, first); await f.tick();
  change(f, null, 'Can you also add docs?'); await f.tick();
  const asker = plannerOf(f);
  assert.ok(asker.run.ask, 'a question, even while a proposal waits');
  assert.match(jobPrompt(f.store.get(f.job.id), null, asker.run), /A plan change you proposed is waiting/);
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('cli', ['web']), spec('docs')]) }, asker);
  const job = f.store.get(f.job.id);
  assert.equal(job.convos.at(-1).pending, null);
  assert.equal(job.replan.proposal.id, asker.run.id);
  assert.deepEqual([job.replan.earlier, job.replan.feedback], [['Add a CLI after web'], 'Can you also add docs?']);
  assert.deepEqual(job.talk.filter((m) => m.kind === 'proposal').map((m) => m.outcome || null), ['revised', null]);
});

test('a question handed over as a change while another is drafted queues behind it, and runs once that one is approved', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  drawing(f, 'Add a CLI after web'); await f.tick();
  const first = plannerOf(f);
  change(f, null, 'Can you also add docs?'); await f.tick();
  const asker = plannerOf(f);
  assert.ok(asker.run.ask);
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('docs')]) }, asker);
  let job = f.store.get(f.job.id);
  assert.equal(job.replan.feedback, 'Add a CLI after web', 'the change being drawn is not the hand-over\'s');
  assert.equal(job.replan.proposal, null);
  assert.deepEqual(job.replanQueue.map((q) => [q.feedback, q.convo]), [['Can you also add docs?', job.convos[1].id]]);
  assert.equal(job.talk.at(-1).kind, 'queued'); assert.doesNotMatch(job.talk.at(-1).text, /Could not/);
  change(f, null, 'And a changelog'); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('changelog')]) }, plannerOf(f));
  assert.equal(f.store.get(f.job.id).replanQueue.length, 2, 'a change idea queues too');
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('cli', ['web'])]) }, first); await f.tick();
  f.store.action(f.job.id, 'approve-replan', { proposalId: first.run.id });
  job = f.store.get(f.job.id);
  assert.deepEqual(job.plan.subJobs.map((s) => s.id), ['api', 'web', 'cli']);
  assert.equal(job.replan.feedback, 'Can you also add docs?');
  await f.tick(); await f.tick();
  const second = plannerOf(f);
  assert.notEqual(second.run.id, first.run.id); assert.ok(!second.run.ask, 'its own planning round');
  assert.match(jobPrompt(f.store.get(f.job.id), null, second.run), /- cli \(pr\) "Deliver cli"/, 'drawn against the plan as it stands now');
  f.store.action(f.job.id, 'discard-replan', {});
  await f.tick(); await f.tick();
  job = f.store.get(f.job.id);
  assert.equal(job.replan.feedback, 'And a changelog', 'discard starts the last one once its planner stopped');
  assert.equal(job.replanQueue, undefined);
});

test('a plan change whose idea was only a question answers it and drops the change', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  drawing(f, 'Tell me how web is going'); await f.tick();
  const planner = plannerOf(f);
  assert.match(jobPrompt(f.store.get(f.job.id), null, planner.run), /If those words are only a question.*kind:"reply"/);
  f.report({ kind: 'reply', text: 'Web is still being written.' }, planner);
  const job = f.store.get(f.job.id);
  assert.equal(job.replan, null, 'nothing waits on the human');
  assert.deepEqual(talk(f).at(-1), ['wrangler', 'answer', 'Web is still being written.', null]);
});

test('several conversations at once: each has its own wrangler run, and each run is told about the others', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  change(f, null, 'What is left?');
  change(f, 'web', 'Why is web slow?');
  let job = f.store.get(f.job.id);
  assert.equal(job.convos.length, 2, 'a message with no conversation starts one');
  assert.deepEqual(job.convos.map((c) => c.sub || null), [null, 'web']);
  await f.tick();
  const askers = f.launched.filter((w) => w.run.ask);
  assert.deepEqual(askers.map((w) => w.run.convo), job.convos.map((c) => c.id), 'two wranglers, one per conversation, answering at once');
  job = f.store.get(f.job.id);
  const [left, slow] = askers.map((w) => jobPrompt(job, null, w.run));
  assert.match(left, /The human wrote: What is left\?/); assert.doesNotMatch(left, /The human wrote: About/);
  assert.match(left, /Other wranglers are at work[\s\S]*\(on web\): the human asked "Why is web slow\?"; another wrangler is answering it now/);
  assert.match(slow, /Other wranglers are at work[\s\S]*the human asked "What is left\?"/);
  assert.doesNotMatch(slow, /This conversation so far[^\n]*\n- The human: "What is left\?"/, 'each reads only its own conversation');
  const ctx = (await getJobContextTool.handler({ host: fakeHost(f), caller: askers[0].sid }, {})).structuredContent;
  assert.deepEqual(ctx.job.talk.map((m) => m.text), ['What is left?'], 'its job context holds its own conversation only');
  assert.deepEqual(ctx.job.convos.map((c) => c.id), [job.convos[0].id]);
  f.report({ kind: 'reply', text: 'Web waits on a slow suite.' }, askers[1]);
  f.report({ kind: 'reply', text: 'Only web.' }, askers[0]);
  job = f.store.get(f.job.id);
  assert.deepEqual(job.talk.filter((m) => m.kind === 'answer').map((m) => [m.convo, m.text]), [[job.convos[1].id, 'Web waits on a slow suite.'], [job.convos[0].id, 'Only web.']]);
});

test('a question asked on a step is that step\'s: its wrangler is told which, and escalates it to the job only when it judges so', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  change(f, 'web', 'Why is this slow?');
  change(f, 'api', 'Is this deployed?');
  await f.tick();
  const [slow, deployed] = f.launched.filter((w) => w.run.ask);
  let job = f.store.get(f.job.id);
  const prompt = jobPrompt(job, null, slow.run);
  assert.match(prompt, /started from the view of sub-job web "Deliver web", which the human had open: read "this", "it" and "here" as that sub-job/);
  assert.match(prompt, /shows only on that sub-job's view\. If your answer matters to the job as a whole[^\n]*escalate:true/);
  assert.match(prompt, /kind:"reply", text:"your answer", escalate\?:true/);
  f.report({ kind: 'reply', text: 'Web waits on api, which every later step needs too.', escalate: true }, slow);
  f.report({ kind: 'reply', text: 'Not yet.' }, deployed);
  job = f.store.get(f.job.id);
  assert.deepEqual(job.convos.map((c) => [c.sub, !!c.escalatedAt]), [['web', true], ['api', false]], 'only the one its wrangler escalated');

  change(f, null, 'What is left?'); await f.tick();
  const jobAsker = plannerOf(f);
  assert.doesNotMatch(jobPrompt(f.store.get(f.job.id), null, jobAsker.run), /started from the view of sub-job|escalate\?:true/, 'a job\'s conversation is the job\'s already');
  f.report({ kind: 'reply', text: 'Web.', escalate: true }, jobAsker);
  assert.equal(f.store.get(f.job.id).convos.at(-1).escalatedAt, undefined);

  change(f, 'api', 'Split this in two', f.store.get(f.job.id).convos[1].id); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('api2'), spec('web')]) }, plannerOf(f));
  assert.ok(f.store.get(f.job.id).convos[1].escalatedAt, 'a plan change it proposes is the job\'s, so the job lists it');
});

test('a message sent before the wrangler replies reaches the same running session, not a new run', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  change(f, null, 'What is left?');
  let convo = f.store.get(f.job.id).convos[0].id;
  change(f, null, 'And what about docs', convo);
  await f.tick();
  const asker = plannerOf(f);
  assert.match(jobPrompt(f.store.get(f.job.id), null, asker.run), /The human wrote: What is left\?\nThen the human added: And what about docs/, 'queued before launch, it rides in the prompt');
  const runs = () => f.store.get(f.job.id).runs.filter((r) => r.ask).length;
  assert.equal(f.mailed.length, 0);
  change(f, null, 'Also, is api deployed?', convo);
  assert.match(talk(f).at(-1)[2], /is api deployed/);
  await f.tick();
  assert.equal(runs(), 1, 'no new run');
  assert.deepEqual(f.mailed.map((m) => m.sid), [asker.sid], 'mailed to Wrangler that is answering');
  assert.match(f.mailed[0].text, /wrote again in your conversation[\s\S]*The human added: Also, is api deployed\?[\s\S]*ONE reply/);
  await f.tick();
  assert.equal(f.mailed.length, 1, 'mailed once');
  change(f, null, 'Never mind docs', convo);
  f.report({ kind: 'reply', text: 'Only web; api is deployed.' }, asker);
  await f.tick(); await f.tick();
  assert.equal(runs(), 2, 'what never reached the run starts the conversation\'s next one');
  const next = plannerOf(f);
  assert.equal(next.run.convo, convo);
  const prompt = jobPrompt(f.store.get(f.job.id), null, next.run);
  assert.match(prompt, /You answered: "Only web; api is deployed\."/); assert.match(prompt, /The human wrote: Never mind docs/);
  f.report({ kind: 'reply', text: 'Noted.' }, next);
  convo = f.store.get(f.job.id).convos[0];
  assert.equal(convo.pending, null);
  change(f, null, 'Add a CLI after web', convo.id);
  assert.equal(f.store.get(f.job.id).replan ?? null, null, 'once answered, a change idea in it is read the same way');
  assert.equal(f.store.get(f.job.id).convos[0].pending.asks.length, 1);
});

test('a question never holds a step, and answers alongside a plan change being drawn', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web', ['api'])]));
  drawing(f, 'Add a CLI after web'); await f.tick();
  change(f, null, 'How is api going?'); await f.tick();
  const job = f.store.get(f.job.id);
  const live = job.runs.filter((r) => !r.stopped);
  assert.ok(live.some((r) => r.phase === 'planning' && !r.ask), 'the plan change is being drawn');
  assert.ok(live.some((r) => r.ask), 'and the question is answered at the same time');
  assert.match(jobPrompt(job, null, live.find((r) => r.ask)), /A plan change is being drawn: "Add a CLI after web"/);
  assert.match(jobPrompt(job, null, live.find((r) => !r.ask && !r.subJobId)), /the human asked "How is api going\?"/);

  const g = fixture(t); await g.approve(plan([spec('api'), spec('web')]));
  change(g, null, 'What is left?'); await g.tick();
  assert.equal(g.store.get(g.job.id).replan ?? null, null);
  assert.ok(g.launched.some((w) => w.sub?.id === 'api' && w.run.phase === 'implementation'), 'steps start while the question is open');
  assert.ok(g.launched.some((w) => w.sub?.id === 'web' && w.run.phase === 'implementation'));
});

test('a job saved with one conversation keeps it as its first', async () => {
  const { migrateTalk } = await import('./job-talk.js');
  const job = { talk: [{ id: 't1', at: 1, from: 'human', text: 'Why?' }], ask: { messageId: 't1', feedback: 'Why?', at: 1 }, runs: [{ id: 'r1', ask: 't1' }], replan: null };
  migrateTalk(job, 5);
  assert.equal(job.ask, undefined);
  assert.deepEqual(job.convos, [{ id: 'convo_0', at: 1, seenAt: 5, pending: { at: 1, asks: [{ messageId: 't1', feedback: 'Why?', sentAt: 1 }] } }]);
  assert.equal(job.talk[0].convo, 'convo_0'); assert.equal(job.runs[0].convo, 'convo_0');
  const fresh = { talk: [], runs: [] }; migrateTalk(fresh);
  assert.equal(fresh.convos, undefined);
});

test('a question the wrangler could not answer is said in the conversation; the job never stops for it', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  change(f, null, 'What is left?'); await f.tick();
  const asker = plannerOf(f);
  f.alive.delete(asker.sid); await f.tick();
  const job = f.store.get(f.job.id);
  assert.equal(job.error, null); assert.equal(job.convos[0].pending, null);
  assert.equal(talk(f).at(-1)[1], 'error');
  assert.match(talk(f).at(-1)[2], /^Could not answer: Session stopped without a receipt/);
  change(f, null, 'What is left now?'); await f.tick();
  f.report({ kind: 'blocked', summary: 'No access to the repo' }, plannerOf(f));
  assert.deepEqual(talk(f).at(-1).slice(1, 3), ['error', 'Could not answer: No access to the repo']);
  assert.equal(f.store.get(f.job.id).error, null);
});

test('dismiss-convo hides a conversation for good, never one whose wrangler is answering or has a plan change in it', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  change(f, null, 'What is left?');
  const id = f.store.get(f.job.id).convos[0].id;
  assert.throws(() => f.store.action(f.job.id, 'dismiss-convo', { convo: id }), /still answering/, 'queued');
  await f.tick();
  const asker = plannerOf(f);
  assert.throws(() => f.store.action(f.job.id, 'dismiss-convo', { convo: id }), /still answering/, 'answering');
  f.report({ kind: 'reply', text: 'Only web.' }, asker);
  await f.tick();
  change(f, null, 'Add a CLI after web', id);
  assert.throws(() => f.store.action(f.job.id, 'dismiss-convo', { convo: id }), /still answering/, 'a change idea is read first');
  await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), spec('web'), spec('cli')]) }, plannerOf(f)); await f.tick();
  assert.ok(f.store.get(f.job.id).replan.proposal);
  assert.throws(() => f.store.action(f.job.id, 'dismiss-convo', { convo: id }), /plan change in progress/, 'a proposal waiting');
  f.store.action(f.job.id, 'discard-replan');
  await f.tick();
  f.store.action(f.job.id, 'dismiss-convo', { convo: id });
  const job = f.store.get(f.job.id);
  assert.equal(typeof job.convos[0].dismissedAt, 'number', 'kept on the job, so a reload still hides it');
  assert.equal(job.moves.at(-1).move, 'dismiss-convo');
  assert.throws(() => f.store.action(f.job.id, 'dismiss-convo', { convo: id }), /already gone/);
  assert.throws(() => f.store.action(f.job.id, 'dismiss-convo', { convo: 'convo_nope' }), /already gone/);
});

test('a dismissed conversation comes back when anything new is said in it, by the human or the wrangler', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  change(f, null, 'What is left?');
  await f.tick();
  f.report({ kind: 'reply', text: 'Only web.' }, plannerOf(f));
  await f.tick();
  const id = f.store.get(f.job.id).convos[0].id;
  f.store.action(f.job.id, 'dismiss-convo', { convo: id });
  change(f, null, 'Is web started?', id);
  assert.equal(f.store.get(f.job.id).convos[0].dismissedAt, undefined, 'the human said something in it');
  await f.tick();
  f.report({ kind: 'reply', text: 'Not yet.' }, plannerOf(f));
  await f.tick();
  f.store.action(f.job.id, 'dismiss-convo', { convo: id });
  const job = f.store.get(f.job.id);
  say(job, { from: 'wrangler', kind: 'answer', text: 'Web has started.', convo: id }, 9);
  assert.equal(job.convos[0].dismissedAt, undefined, 'Wrangler said something in it');
});
