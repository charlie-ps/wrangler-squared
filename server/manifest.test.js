import { test } from 'node:test';
import assert from 'node:assert/strict';
import manifest from './manifest.js';
import os from 'node:os';
import path from 'node:path';
import { placeholderBranch } from './job-prompts.js';
import { _resetForTests, runnerFor, spendFor, statusOf } from './jobs.js';
import { fakeHost } from './test-helpers.js';

const tool = (name) => manifest.tools.find((t) => t.name === name);
const handler = (type) => manifest.handlers.find((h) => h.type === type);
const newJob = { title: 'Ship it', intent: 'Make the thing work end to end.' };

test('the manifest declares what package.json disclosed, and only known hook names', async () => {
  const { readFileSync } = await import('node:fs');
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).wranglerExtension;
  assert.equal(manifest.id, declared.id);
  assert.deepEqual([...manifest.requires].sort(), [...declared.requires].sort(), 'the manifest may not be wider than what the human consented to');
  // spawn's `taskId` binds the memory and assigns the card itself, and is
  // documented as NOT a tasks:write escalation — so the capability is not asked for.
  assert.ok(!manifest.requires.includes('tasks:write'));
  assert.equal(manifest.engines.wranglerApi, '^1.8.0', 'the client api.openSession the Jobs view opens cards with arrived in 1.8 (1.7 was the rail badge)');
  assert.deepEqual(manifest.tools.map((t) => t.name), ['job_report', 'get_job_context']);
  assert.deepEqual(Object.keys(manifest.session), ['onBeforeDispatch']);
  assert.equal(manifest.client, 'public/index.js');
  assert.equal(manifest.styles, 'public/jobs.css');
});

test('job-create through the extension handler signature creates, starts and broadcasts', async () => {
  _resetForTests();
  const { host, broadcasts } = fakeHost();
  // The runner's tick would try to launch planning through the fake spawn; keep
  // this test to the handler by making the runner a no-op.
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: newJob, start: true }, host);
  const [job] = host.stores.jobs.snapshot().jobs;
  assert.equal(job.stage, 'planning');
  assert.equal(host.rebuilds, 1);
  assert.deepEqual(broadcasts, [{ event: 'job-created', jobId: job.id, started: true }]);
});

test('a launch binds its run to the card id via onBeforeDispatch, and job_report is caller-gated', async () => {
  _resetForTests();
  const { host, spawned } = fakeHost();
  const job = host.stores.jobs.create(newJob);
  host.stores.jobs.action(job.id, 'start', {});
  await runnerFor(host).tick();
  assert.equal(spawned.length, 1, 'planning launched once');
  const run = host.stores.jobs.get(job.id).runs[0];
  assert.equal(run.phase, 'planning');
  assert.equal(run.sessionId, spawned[0].sessionId, 'bound before spawn returned');
  assert.match(spawned[0].intent, /^Plan this job: Ship it/);
  assert.equal(spawned[0].worktree, undefined, 'planning runs in a scratch workspace, not a branch');
  assert.deepEqual(spawned[0].addDirs, [path.join(os.homedir(), 'IdeaProjects')], 'planning clones the repos it discovers');
  assert.deepEqual([spawned[0].autoMergeOnPass, spawned[0].autoFixPrChecks], [false, false]);

  // The step protocol is only for a job step: hideTool vetoes spawning for the
  // bound card and skillsFor keeps job-worker for it alone.
  assert.equal(manifest.hideTool({ caller: run.sessionId, tool: 'spawn_session', host }), true);
  assert.equal(manifest.hideTool({ caller: run.sessionId, tool: 'list_sessions', host }), false);
  assert.equal(manifest.hideTool({ caller: 'someone-else', tool: 'spawn_session', host }), false);
  assert.deepEqual(manifest.skillsFor({ sessionId: run.sessionId, skills: ['job-worker'], host }), ['job-worker']);
  assert.deepEqual(manifest.skillsFor({ sessionId: 'someone-else', skills: ['job-worker'], host }), []);

  const wrong = await tool('job_report').handler({ host, caller: 'someone-else' }, { runId: run.id, report: { kind: 'blocked', summary: 'nope' } });
  assert.equal(wrong.isError, true);
  const ctx = await tool('get_job_context').handler({ host, caller: run.sessionId }, {});
  assert.equal(ctx.structuredContent.run.id, run.id);
  const ok = await tool('job_report').handler({ host, caller: run.sessionId }, { runId: run.id, report: { kind: 'blocked', summary: 'Repo hint does not exist' } });
  assert.equal(ok.structuredContent.accepted, true);
  assert.equal(host.stores.jobs.get(job.id).error, 'Repo hint does not exist');
});

test('the graph contributor carries jobs under its own key and stamps live runs with card status', async () => {
  _resetForTests();
  const { host, spawned } = fakeHost();
  const job = host.stores.jobs.create(newJob);
  host.stores.jobs.action(job.id, 'start', {});
  await runnerFor(host).tick();
  const graph = { sessions: [{ sessionId: spawned[0].sessionId, status: 'needs-you' }] };
  const out = manifest.graph({ host, graph });
  assert.deepEqual(Object.keys(out), ['jobs']);
  assert.equal(out.jobs.jobs[0].runs[0].status, 'needs-you');
  assert.equal(statusOf(spawned[0].sessionId), 'needs-you', 'the runner reads the same cache');
});

test('the graph contributor prices a job off the host\'s usage rows, one refresh behind and never awaited', async () => {
  _resetForTests();
  const { host, spawned, usage } = fakeHost();
  const job = host.stores.jobs.create(newJob);
  const graph = { sessions: [] };
  let reads = 0;
  const byCard = host.usage.byCard;
  host.usage.byCard = () => { reads++; return byCard(); };

  assert.equal(manifest.graph({ host, graph }).jobs.jobs[0].usd, null, 'a backlog job has no card, so nothing is read');
  assert.equal(reads, 0);
  host.stores.jobs.action(job.id, 'start', {});
  await runnerFor(host).tick();
  usage.push({ cardId: spawned[0].sessionId, usd: 0.75, estimatedUsd: 0.75 }, { cardId: 'someone-else', usd: 40, estimatedUsd: 0 });
  assert.equal(manifest.graph({ host, graph }).jobs.jobs[0].usd, null, 'the tick that kicks the read serves the map before it');
  assert.equal(reads, 1);
  await spendFor(host).settled();
  const priced = manifest.graph({ host, graph }).jobs.jobs[0];
  assert.equal(priced.usd, 0.75);
  assert.equal(priced.usdEstimated, true);
  assert.equal(reads, 1, 'the next tick is inside the 60s window');
});

// The store state a PR sub-job reaches once its plan is approved and a session
// is bound, built directly: the path here is the receipt, not the approval flow.
function activeSub(store, { branch = 'job-abcd1234-api', sessionId = 's_1' } = {}) {
  const job = store.create(newJob);
  store.update(job.id, (j) => {
    j.stage = 'active';
    j.subJobs = [{ id: 'api', title: 'API', kind: 'pr', repo: '/repos/thing', storyId: 'story', after: [], brief: 'Do it',
      stage: 'implementation', state: 'queued', jiraKey: 'AUTH-1', repairs: [], sessions: [sessionId], pr: null, prComments: null,
      commentSummary: null, deploys: null, deploymentResult: null, result: null, ready: null, note: null, fixRequested: null, blocked: null,
      worktree: { branch, path: '/repos/thing-worktree', repoRoot: '/repos/thing', cleanupHead: 'basehead' } }];
    j.runs = [{ id: 'run_1', subJobId: 'api', phase: 'implementation', model: null, startedAt: Date.now(), sessionId, stopped: false, report: null }];
  });
  return job.id;
}

test('a PR launch has the wrangler cut the worktree and keeps core off the job PR', async () => {
  _resetForTests();
  const { host, spawned } = fakeHost();
  const runtime = runnerFor(host).runtime;
  runtime.run = async (bin, args) => {
    if (bin === 'gh') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
    return args[0] === 'rev-parse' ? 'basehead' : '';
  };
  const job = { id: 'job_00000000abcd1234', title: 'Ship it', agent: 'claude', model: 'opus', taskId: 'task_7' };
  const sub = { id: 'api', repo: '/repos/thing', brief: 'Do it', jiraKey: 'AUTH-1' };
  let prepared;
  await runtime.launch(job, sub, { id: 'run_1', phase: 'implementation' }, (...v) => { prepared = v; });

  const opts = spawned[0];
  assert.equal(opts.cwd, '/repos/thing', 'the wrangler branches from the main checkout');
  assert.deepEqual(opts.worktree, { branch: placeholderBranch(job, sub), base: 'refs/remotes/origin/main', auto: true });
  assert.equal(opts.addDirs, undefined, 'only planning gets the repos parent');
  assert.equal(opts.taskId, 'task_7');
  assert.deepEqual([opts.autoMergeOnPass, opts.autoFixPrChecks], [false, false], 'the runner drives this PR');
  assert.deepEqual(prepared, ['s_1', {
    branch: placeholderBranch(job, sub), path: `/repos/thing-worktree-${placeholderBranch(job, sub)}`, repoRoot: '/repos/thing',
    cleanupHead: 'basehead',
  }], 'the hook payload\'s worktree, plus the base commit no host projection carries');
});

test('a later phase has the wrangler adopt the existing worktree and leaves the stored record alone', async () => {
  _resetForTests();
  const { host, spawned, sessions } = fakeHost();
  const runtime = runnerFor(host).runtime;
  runtime.run = async () => assert.fail('an existing worktree is reused without fetching or branching');
  const worktree = { branch: 'AUTH-1-add-the-thing', path: os.tmpdir(), repoRoot: '/repos/thing', cleanupHead: 'basehead' };
  let prepared = 'unset';
  await runtime.launch({ id: 'job_00000000abcd1234', title: 'Ship it', agent: 'claude' }, { id: 'api', repo: '/repos/thing', brief: 'Do it', worktree },
    { id: 'run_2', phase: 'publish' }, (...v) => { prepared = v; });
  assert.equal(spawned[0].cwd, '/repos/thing', 'adoption is asked of the repo the worktree belongs to');
  assert.deepEqual(spawned[0].worktree, { branch: 'AUTH-1-add-the-thing', folderName: os.tmpdir(), auto: false },
    'the stored record, handed back so createWorktree classifies it as adopt');
  assert.deepEqual(sessions.get('s_1').worktree, { branch: 'AUTH-1-add-the-thing', path: os.tmpdir(), repoRoot: '/repos/thing' },
    'the card carries the record, so name_branch works on the run that pushes');
  assert.deepEqual(prepared, ['s_1', undefined], 'the store already holds the record, with its cleanupHead and any rename');
});

test('job_report reads a name_branch rename back off the session projection', async () => {
  _resetForTests();
  const { host, sessions } = fakeHost();
  const jobId = activeSub(host.stores.jobs);
  sessions.set('s_1', { sessionId: 's_1', archived: false, worktree: { branch: 'AUTH-1-add-the-thing', path: '/repos/thing-worktree', repoRoot: '/repos/thing' } });

  const out = await tool('job_report').handler({ host, caller: 's_1' }, { runId: 'run_1', report: { kind: 'ready', checks: ['Build passed'] } });
  assert.equal(out.structuredContent.accepted, true);
  const { worktree } = host.stores.jobs.get(jobId).subJobs[0];
  assert.equal(worktree.branch, 'AUTH-1-add-the-thing', 'there is no rename hook, so the receipt is when the record catches up');
  assert.equal(worktree.cleanupHead, 'basehead', 'the rest of the extension\'s own record survives');
});

test('an unrenamed branch is left alone, and a caller that is not a job step is not touched', async () => {
  _resetForTests();
  const { host, sessions } = fakeHost();
  const jobId = activeSub(host.stores.jobs);
  const before = host.stores.jobs.get(jobId).revision;
  sessions.set('s_1', { sessionId: 's_1', archived: false, worktree: { branch: 'job-abcd1234-api', path: '/repos/thing-worktree', repoRoot: '/repos/thing' } });
  await tool('get_job_context').handler({ host, caller: 's_1' }, {});
  assert.equal(host.stores.jobs.get(jobId).revision, before, 'no rename, no write');
  assert.deepEqual((await tool('get_job_context').handler({ host, caller: 'someone-else' }, {})).structuredContent, { job: null });
});
