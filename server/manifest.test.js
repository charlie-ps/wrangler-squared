import { inboxDir } from './job-evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import manifest from './manifest.js';
import os from 'node:os';
import path from 'node:path';
import { placeholderBranch } from './job-prompts.js';
import { checkoutsDir } from './data-dir.js';
import { _resetForTests, runnerFor, spendFor, statusOf } from './jobs.js';
import { fakeHost } from './test-helpers.js';
import { REVIEW_DEFAULTS, settingsSchema } from './jobs-schema.js';

const tool = (name) => manifest.tools.find((t) => t.name === name);
const handler = (type) => manifest.handlers.find((h) => h.type === type);
const newJob = { title: 'Ship it', intent: 'Make the thing work end to end.' };

test('the manifest declares what package.json disclosed, and only known hook names', async () => {
  const { readFileSync } = await import('node:fs');
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).wranglerExtension;
  assert.equal(manifest.id, declared.id);
  assert.deepEqual([...manifest.requires].sort(), [...declared.requires].sort(), 'the manifest may not be wider than what the human consented to');
  assert.ok(manifest.requires.includes('tasks:read'));
  assert.ok(manifest.requires.includes('tasks:write'));
  assert.equal(manifest.engines.wranglerApi, '^1.38.0', 'files:view and the client api.files arrived in 1.38');
  assert.ok(manifest.requires.includes('images:keep'));
  assert.ok(manifest.requires.includes('files:view'));
  assert.ok(declared.requires.includes('files:view'));
  assert.deepEqual(manifest.tools.map((t) => t.name), ['job_report', 'get_job_context', 'create_job', 'send_step_idea']);
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

test('job-create and create_job carry reviewWrites, which is off unless asked for', async () => {
  _resetForTests();
  const { host } = fakeHost();
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: newJob, start: false }, host);
  await handler('job-create').handler({ job: { ...newJob, reviewWrites: true }, start: false }, host);
  assert.ok('reviewWrites' in tool('create_job').inputSchema);
  await tool('create_job').handler({ host, caller: 'sid' }, { ...newJob, reviewWrites: true, start: false });
  assert.deepEqual(host.stores.jobs.snapshot().jobs.map((j) => j.reviewWrites), [false, true, true]);
});

test('a job created without review flags takes the saved review defaults; a flag it passes wins', async () => {
  _resetForTests();
  const { host } = fakeHost();
  runnerFor(host).tick = async () => {};
  assert.deepEqual(settingsSchema.parse({}).reviewDefaults, REVIEW_DEFAULTS, 'settings saved before the key parse to the original form');
  await tool('create_job').handler({ host, caller: 'sid' }, { ...newJob, start: false });
  await handler('job-settings').handler({ patch: { reviewDefaults: { reviewPlan: false, reviewCode: true, reviewMerge: false, reviewSessions: true, reviewWrites: true, reviewRed: false } } }, host);
  await tool('create_job').handler({ host, caller: 'sid' }, { ...newJob, start: false });
  await tool('create_job').handler({ host, caller: 'sid' }, { ...newJob, reviewPlan: true, reviewWrites: false, start: false });
  const flags = (j) => Object.keys(REVIEW_DEFAULTS).map((f) => j[f]);
  assert.deepEqual(host.stores.jobs.snapshot().jobs.map(flags), [
    [true, true, true, true, false, true], [false, true, false, true, true, false], [true, true, false, true, false, false],
  ]);
});

test('job-create creates a named task and stores it on the job', async () => {
  _resetForTests();
  const { host, tasks } = fakeHost();
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: newJob, newTaskName: 'Ship it together', start: false }, host);
  const [job] = host.stores.jobs.snapshot().jobs;
  assert.deepEqual(tasks, [{ id: 't_1', name: 'Ship it together', links: [] }]);
  assert.equal(job.taskId, 't_1');
});

test('job-create stores an available selected task without creating another', async () => {
  _resetForTests();
  const { host, tasks } = fakeHost();
  tasks.push({ id: 't_existing', name: 'Existing work', links: [] });
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: { ...newJob, taskId: 't_existing' }, start: false }, host);
  assert.equal(host.stores.jobs.snapshot().jobs[0].taskId, 't_existing');
  assert.equal(tasks.length, 1);
});

test('job-create refuses a task that is no longer available', async () => {
  _resetForTests();
  const { host, broadcasts } = fakeHost();
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: { ...newJob, taskId: 't_missing' }, start: false }, host);
  assert.deepEqual(host.stores.jobs.snapshot().jobs, []);
  assert.deepEqual(broadcasts, [{ event: 'job-create-failed', error: 'The selected task is no longer available' }]);
});

test('job-create refuses an archived selected task', async () => {
  _resetForTests();
  const { host, broadcasts, tasks } = fakeHost();
  tasks.push({ id: 't_archived', name: 'Old work', links: [], archivedAt: Date.now() });
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: { ...newJob, taskId: 't_archived' }, start: false }, host);
  assert.deepEqual(host.stores.jobs.snapshot().jobs, []);
  assert.deepEqual(broadcasts, [{ event: 'job-create-failed', error: 'The selected task is no longer available' }]);
});

test('job-create requires a name when creating a task', async () => {
  _resetForTests();
  const { host, broadcasts, tasks } = fakeHost();
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: newJob, newTaskName: '   ', start: false }, host);
  assert.deepEqual(tasks, []);
  assert.deepEqual(host.stores.jobs.snapshot().jobs, []);
  assert.deepEqual(broadcasts, [{ event: 'job-create-failed', error: 'Enter a name for the new task' }]);
});

test('job-create validates the job before creating its requested task', async () => {
  _resetForTests();
  const { host, broadcasts, tasks } = fakeHost();
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: { title: '', intent: '' }, newTaskName: 'Orphan', start: false }, host);
  assert.deepEqual(tasks, []);
  assert.deepEqual(host.stores.jobs.snapshot().jobs, []);
  assert.equal(broadcasts[0].event, 'job-create-failed');
});

test('job-create accepts only a short one-line string for a new task name', async () => {
  for (const newTaskName of [null, false, 'x'.repeat(181), 'two\nlines']) {
    _resetForTests();
    const { host, broadcasts, tasks } = fakeHost();
    runnerFor(host).tick = async () => {};
    await handler('job-create').handler({ job: newJob, newTaskName, start: false }, host);
    assert.deepEqual(tasks, [], `rejected ${JSON.stringify(newTaskName)}`);
    assert.deepEqual(host.stores.jobs.snapshot().jobs, []);
    assert.deepEqual(broadcasts, [{ event: 'job-create-failed', error: 'Enter a task name of up to 180 characters on one line' }]);
  }
});

test('job-create rejects selecting and creating a task at the same time', async () => {
  _resetForTests();
  const { host, broadcasts, tasks } = fakeHost();
  tasks.push({ id: 't_existing', name: 'Existing work', links: [] });
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: { ...newJob, taskId: 't_existing' }, newTaskName: 'Another task', start: false }, host);
  assert.equal(tasks.length, 1);
  assert.deepEqual(host.stores.jobs.snapshot().jobs, []);
  assert.deepEqual(broadcasts, [{ event: 'job-create-failed', error: 'Choose an existing task or create a new one, not both' }]);
});

test('create_job lets an agent create and start a job, kicks the runner and broadcasts nothing', async () => {
  _resetForTests();
  const { host, broadcasts } = fakeHost();
  let ticks = 0;
  runnerFor(host).tick = async () => { ticks++; };
  const res = await tool('create_job').handler({ host, caller: 'an-agent' }, { ...newJob, repos: ['/repo'], model: 'opus', effort: 'high', reviewPlan: false, start: true });
  const [job] = host.stores.jobs.snapshot().jobs;
  assert.deepEqual(res.structuredContent, { jobId: job.id, title: 'Ship it', stage: 'planning' });
  assert.deepEqual([job.repos, job.model, job.effort, job.reviewPlan], [['/repo'], 'opus', 'high', false]);
  assert.equal(ticks, 1);
  assert.equal(host.rebuilds, 1);
  assert.deepEqual(broadcasts, [], 'a job-created frame would close a human\'s open New job form');
});

test('create_job shares the form\'s task handling and leaves an unstarted job in the backlog', async () => {
  _resetForTests();
  const { host, tasks } = fakeHost();
  runnerFor(host).tick = async () => { throw new Error('a backlogged job must not kick the runner'); };
  const res = await tool('create_job').handler({ host, caller: 'an-agent' }, { ...newJob, newTaskName: 'Agent work' });
  const job = host.stores.jobs.get(res.structuredContent.jobId);
  assert.equal(job.stage, 'backlog');
  assert.deepEqual([tasks.map((t) => t.name), job.taskId], [['Agent work'], 't_1']);
});

test('create_job refuses invalid input as a tool error and creates nothing', async () => {
  _resetForTests();
  const { host, tasks } = fakeHost();
  tasks.push({ id: 't_existing', name: 'Existing work', links: [] });
  const both = await tool('create_job').handler({ host, caller: 'an-agent' }, { ...newJob, taskId: 't_existing', newTaskName: 'Another task' });
  assert.deepEqual([both.isError, both.content[0].text], [true, 'Choose an existing task or create a new one, not both']);
  const missing = await tool('create_job').handler({ host, caller: 'an-agent' }, { ...newJob, taskId: 't_missing' });
  assert.deepEqual([missing.isError, missing.content[0].text], [true, 'The selected task is no longer available']);
  assert.equal((await tool('create_job').handler({ host, caller: 'an-agent' }, { intent: '' })).isError, true);
  assert.deepEqual(host.stores.jobs.snapshot().jobs, []);
  assert.equal(tasks.length, 1);
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
  assert.deepEqual(spawned[0].addDirs, checkoutsDir() ? [checkoutsDir()] : undefined, 'planning clones the repos it discovers, if this machine has a checkouts folder');
  assert.deepEqual([spawned[0].autoMergeOnPass, spawned[0].autoFixPrChecks], [false, false]);

  // The step protocol is only for a job step: hideTool vetoes spawning for the
  // bound card and skillsFor keeps job-worker for it alone.
  assert.equal(manifest.hideTool({ caller: run.sessionId, tool: 'spawn_session', host }), true);
  assert.equal(manifest.hideTool({ caller: run.sessionId, tool: 'list_sessions', host }), false);
  assert.equal(manifest.hideTool({ caller: 'someone-else', tool: 'spawn_session', host }), false);
  assert.equal(manifest.hideTool({ caller: run.sessionId, tool: 'create_job', host }), true, 'a job step cannot start another job');
  assert.equal(manifest.hideTool({ caller: 'someone-else', tool: 'create_job', host }), false);
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

test('codexPolicy answers only for a job step, from its job\'s saved sandbox', async () => {
  _resetForTests();
  const { host } = fakeHost();
  const job = host.stores.jobs.create({ ...newJob, agent: 'codex' });
  assert.equal(job.sandbox, 'auto', 'a new job auto-approves');
  host.stores.jobs.action(job.id, 'start', {});
  await runnerFor(host).tick();
  const { sessionId } = host.stores.jobs.get(job.id).runs[0];
  const ask = (id, phase = 'dispatch') => manifest.codexPolicy({ phase, sessionId: id, entry: null, ext: host });
  const withMode = (sandbox) => { const stored = host.stores.jobs.data.jobs[0]; if (sandbox === undefined) delete stored.sandbox; else stored.sandbox = sandbox; return ask(sessionId); };
  assert.deepEqual(withMode('auto'), { approveForMe: true });
  assert.deepEqual(withMode('full'), { bypass: true });
  assert.equal(withMode('locked'), undefined, 'locked is core\'s own default');
  assert.equal(withMode(undefined), undefined, 'a job stored before the field keeps the lock');
  withMode('full');
  assert.deepEqual(ask(sessionId, 'resume'), { bypass: true }, 'a resumed step keeps its job\'s mode');
  assert.equal(ask('someone-else'), undefined, 'an ordinary session keeps core\'s defaults');
  assert.equal(ask(undefined), undefined);
});

test('job-create and create_job carry the sandbox and writable folders', async () => {
  _resetForTests();
  const { host } = fakeHost();
  runnerFor(host).tick = async () => {};
  await handler('job-create').handler({ job: { ...newJob, agent: 'codex', sandbox: 'locked', writableDirs: ['~/.docker', '/opt/cache'] }, start: false }, host);
  assert.ok('sandbox' in tool('create_job').inputSchema && 'writableDirs' in tool('create_job').inputSchema);
  await tool('create_job').handler({ host, caller: 'sid' }, { ...newJob, sandbox: 'full', start: false });
  await handler('job-create').handler({ job: { ...newJob, writableDirs: ['relative/dir'] }, start: false }, host);
  assert.deepEqual(host.stores.jobs.snapshot().jobs.map((j) => [j.sandbox, j.writableDirs]), [['locked', ['~/.docker', '/opt/cache']], ['full', []]], 'a relative folder is refused');
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

test('an idle card with a background shell running reads as working to the runner', () => {
  _resetForTests();
  const { host } = fakeHost();
  manifest.graph({ host, graph: { sessions: [
    { sessionId: 'waiting', status: 'idle', hasBackgroundShell: true },
    { sessionId: 'done', status: 'idle', hasBackgroundShell: false },
  ] } });
  assert.equal(statusOf('waiting'), 'working', 'not reaped as receipt-less while its background job runs');
  assert.equal(statusOf('done'), 'idle');
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
  const { host, spawned, tasks } = fakeHost();
  tasks.push({ id: 'task_7', name: 'Ship it', links: [] });
  const runtime = runnerFor(host).runtime;
  runtime.run = async (bin, args) => {
    if (bin === 'gh') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
    return args[0] === 'rev-parse' ? 'basehead' : '';
  };
  const job = { id: 'job_00000000abcd1234', title: 'Ship it', agent: 'claude', model: 'opus', effort: 'high', taskId: 'task_7' };
  const sub = { id: 'api', repo: '/repos/thing', brief: 'Do it', jiraKey: 'AUTH-1' };
  let prepared;
  await runtime.launch(job, sub, { id: 'run_1', phase: 'implementation' }, (...v) => { prepared = v; });

  const opts = spawned[0];
  assert.equal(opts.cwd, '/repos/thing', 'the wrangler branches from the main checkout');
  assert.deepEqual(opts.worktree, { branch: placeholderBranch(job, sub), base: 'refs/remotes/origin/main', auto: true });
  assert.deepEqual(opts.addDirs, [inboxDir(job.id, sub.id)], 'only planning gets the repos parent; an implementation run gets its proof inbox');
  assert.equal(opts.taskId, 'task_7');
  assert.deepEqual([opts.model, opts.effort], ['opus', 'high']);
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
  assert.equal(spawned[0].effort, undefined, 'Default effort is left to the agent');
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
