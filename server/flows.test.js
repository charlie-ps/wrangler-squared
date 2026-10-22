import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import manifest from './manifest.js';
import { normaliseComments } from './job-comments.js';
import { changeView } from './job-change.js';
import { _resetForTests, runnerFor } from './jobs.js';
import { fakeHost } from './test-helpers.js';

// Whole lifecycles, driven the way integration.test.js drives one launch: only
// the manifest's own entries (job-create, job-action, job_report, the tick sweep
// and the graph contributor), in the order a live board and its agents call them.
// What stands outside is real where it is local and faked where it is not: a bare
// repository on disk is `origin`, so fetch, worktrees, the tree hash, the push and
// cleanup's compare-and-delete run real git; GitHub is a fake on the runner
// (there is no network in a test), and the agents are the test itself, editing
// and committing in the worktree the wrangler cut before each receipt.
const entry = (list, key, value) => list.find((e) => e[key] === value);
const tool = (name) => entry(manifest.tools, 'name', name);
const handler = (type) => entry(manifest.handlers, 'type', type);
const sweep = entry(manifest.sweeps, 'id', 'tick');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Flow', '-c', 'user.email=flow@example.com', '-C', cwd, ...args], { encoding: 'utf8' }).trim();
const PR_URL = 'https://github.com/acme/widgets/pull/7';

function origin(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-flow-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'origin.git'), repo = path.join(dir, 'widgets');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, repo], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), '# widgets\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'Initial'); git(repo, 'push', '-q', 'origin', 'HEAD:main');
  return repo;
}

// What GitHub would answer about the one PR a flow opens. `merge` lands the head on
// origin's main (a fast-forward stands in for the squash) and the next poll reads
// it as merged, so cleanup and the local-main update see a real landed commit.
function fakeGithub(repo) {
  const state = { pr: null, deployment: { status: 'pending', runs: [] }, deploys: false, merged: [] };
  const empty = { author: { login: 'agent' }, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } };
  const github = {
    async pr(s) { return { ...state.pr, url: s.pr.url }; },
    async comments() { return normaliseComments(empty, 0); },
    async deploys(s, pr) {
      return state.deploys
        ? { head: pr.head, base: pr.base, expected: true, workflows: [{ name: 'Deploy', file: 'deploy.yml', triggers: true, reason: 'runs on push' }], summary: 'Deploys on merge · Deploy' }
        : { head: pr.head, base: pr.base, expected: false, workflows: [], summary: 'Nothing runs on merge' };
    },
    async merge(s) {
      git(repo, 'push', '-q', 'origin', `${s.pr.head}:refs/heads/main`);
      state.merged.push(s.pr.head);
      state.pr = { ...state.pr, state: 'MERGED', mergeCommit: s.pr.head };
    },
    async deployment() { return { ...state.deployment, commit: state.pr.mergeCommit }; },
    async updateBranch() {},
  };
  return { github, state };
}

// One board, one job. The clock is node's mock Date, so a poll's 30s back-off
// passes between ticks the way it would between the wrangler's 4s sweeps.
function board(t, { settings = {} } = {}) {
  _resetForTests();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const repo = origin(t);
  const fake = fakeHost();
  const { host, spawned, broadcasts, sessions, mailed } = fake;
  host.stores.jobs.settings({ maxReplans: 0, ...settings });
  // The wrangler cuts the worktree it was asked for before dispatch (host API 1.4);
  // the fake records the path it would choose, so the folder is made there.
  const spawn = host.sessions.spawn;
  host.sessions.spawn = async (opts) => {
    if (opts.worktree?.auto) git(opts.cwd, 'worktree', 'add', '-q', '-b', opts.worktree.branch, `${opts.cwd}-worktree-${opts.worktree.branch}`, opts.worktree.base);
    return spawn(opts);
  };
  const runner = runnerFor(host);
  const { github, state } = fakeGithub(repo);
  runner.github = github;
  const run = runner.runtime.run;
  runner.runtime.run = async (bin, args, cwd) => (bin === 'gh' ? JSON.stringify({ defaultBranchRef: { name: 'main' } }) : run(bin, args, cwd));
  const real = runner.tick.bind(runner);
  const inflight = [];
  runner.tick = () => { const p = real(); inflight.push(p); return p; };
  const settle = async () => { while (inflight.length) await inflight.shift(); };
  let jobId = null;
  const job = () => host.stores.jobs.get(jobId);
  const sub = (id) => job().subJobs.find((s) => s.id === id);
  const runOf = (subId, phase) => job().runs.findLast((r) => (r.subJobId ?? null) === subId && (!phase || r.phase === phase));
  const f = {
    repo, host, spawned, broadcasts, sessions, mailed, state, job, sub, runOf, settle,
    // The board's ~4s loop: the graph contributor reports every live card as
    // working (the only liveness the runner reads), then the tick sweep runs.
    async tick() {
      await settle();
      t.mock.timers.tick(61000);
      manifest.graph({ host, graph: { sessions: [...sessions.values()].filter((s) => !s.archived).map((s) => ({ sessionId: s.sessionId, status: 'working' })) } });
      await sweep.run({ host }); await settle();
    },
    async act(action, fields = {}) {
      await handler('job-action').handler({ id: jobId, action, ...fields }, host);
      const last = broadcasts.at(-1);
      await settle();
      return last;
    },
    async approve(action, fields) {
      const said = await f.act(action, fields);
      assert.equal(said.event, 'job-action-complete', `${action} refused: ${said.error}`);
    },
    async report(run, report) {
      const out = await tool('job_report').handler({ host, caller: run.sessionId }, { runId: run.id, report });
      assert.ok(!out.isError, `${report.kind} refused: ${out.content?.[0]?.text}`);
      return out.structuredContent;
    },
    // New job → planner's plan → Approve plan, as the board and the planner do it.
    async start(plan, flags = {}) {
      await handler('job-create').handler({ job: { title: 'Widgets', intent: 'Ship the widget changes', ...flags }, start: true }, host);
      jobId = broadcasts.find((b) => b.event === 'job-created').jobId;
      await settle();
      await f.report(runOf(null, 'planning'), { kind: 'plan', plan: { context: 'A small Node service.', stories: [], ...plan } });
      await f.tick();
      assert.equal(job().stage, 'planning', 'a plan waits for the human');
      await f.approve('approve-plan', { revision: job().revision });
      assert.equal(job().stage, 'active');
    },
    // The agent's half of a step that changes code: edit in its worktree, and
    // commit and push when the step is the one that publishes.
    work(subId, file, text, { push = false } = {}) {
      const wt = sub(subId).worktree.path;
      fs.writeFileSync(path.join(wt, file), text);
      if (!push) return null;
      git(wt, 'add', '-A'); git(wt, 'commit', '-qm', `Change ${file}`);
      git(wt, 'push', '-q', 'origin', `HEAD:refs/heads/${sub(subId).worktree.branch}`);
      return git(wt, 'rev-parse', 'HEAD');
    },
    // The Add idea box, pinned to what the board is showing (job-change.js).
    async idea(text, subJobId) {
      const view = changeView(job(), subJobId ? sub(subJobId) : null);
      await f.approve('request-change', { subJobId, at: view?.at, ref: view?.ref, text });
    },
    // The planner's proposal for the idea it was just sent, as a full plan.
    async propose(subJobs, extra = {}) {
      await f.tick();
      const planner = runOf(null, 'planning');
      await f.report(planner, { kind: 'plan', plan: { ...job().plan, subJobs }, ...extra });
      await f.tick();
      assert.equal(job().replan.proposal.id, planner.id, 'the proposal waits for the human');
      return planner;
    },
    // A PR step that publishes itself (Code on Auto): commit, push, report the PR.
    async publish(subId, run, extra = {}) {
      const head = f.work(subId, `${subId}.js`, `export const ${subId} = ${Date.now()};\n`, { push: true });
      await f.report(run, { kind: 'published', url: PR_URL });
      f.openPr(head, extra);
      return head;
    },
    openPr(head, extra = {}) { state.pr = { state: 'OPEN', checkStatus: 'pending', head, mergeCommit: null, checks: [], base: 'main', ...extra }; },
  };
  return f;
}
const pr = (id, after = [], extra = {}) => ({ id, title: `Deliver ${id}`, kind: 'pr', after, brief: `Implement ${id}`, ...extra });
const session = (id, after = [], extra = {}) => ({ id, kind: 'session', title: `Run ${id}`, after, brief: `Do ${id} on this machine`, ...extra });
const human = (id, after = []) => ({ id, kind: 'human', title: `Do ${id} yourself`, after, brief: `Click ${id} in the vendor console` });
const write = (id, by, extra = {}) => ({ id, kind: 'write', place: { type: 'slack', ref: '#widgets' }, title: `Post ${id}`, after: [], by, action: { type: 'post', text: 'Planned post' }, ...extra });
const branchGone = (f, branch) => !git(f.repo, 'ls-remote', 'origin', `refs/heads/${branch}`) && !git(f.repo, 'branch', '--list', branch);

test('a PR step: plan, approve, launch, ready, code review, published, merge approval, merged, deployed, cleaned up, done', async (t) => {
  const f = board(t);
  await f.start({ subJobs: [pr('api', [], { repo: f.repo })] }, { reviewCode: true, reviewMerge: true });
  const impl = f.runOf('api', 'implementation');
  assert.ok(impl.sessionId, 'approval launches the implementation');
  const { branch, path: wt } = f.sub('api').worktree;
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), branch, 'the step works in the worktree Wrangler cut');

  f.work('api', 'api.js', 'export const ok = true;\n');
  const parked = await f.report(impl, { kind: 'ready', checks: ['Tests pass'] });
  assert.match(parked.next, /End your turn and wait/);
  await f.tick();
  assert.deepEqual([f.sub('api').stage, f.sub('api').state], ['review', 'verified']);
  assert.ok(f.sub('api').ready.treeHash, 'the receipt pins the tree it describes');
  assert.equal(f.runOf('api', 'implementation').stopped, false, 'the session stays open, parked, for the human');

  await f.approve('approve-code', { subJobId: 'api', readyReceiptId: f.sub('api').ready.receiptId });
  await f.tick();
  assert.equal(f.runOf('api', 'publish'), undefined, 'no publish session: the one that wrote the tree lands it');
  assert.equal(f.mailed.at(-1).to, impl.sessionId);
  assert.match(f.mailed.at(-1).text, /You are now asked to commit and push it/);

  const head = f.work('api', 'api.js', 'export const ok = true;\n', { push: true });
  await f.report(impl, { kind: 'published', url: PR_URL });
  f.openPr(head, { checkStatus: 'passing' });
  f.state.deploys = true;
  await f.tick();
  assert.deepEqual([f.sub('api').stage, f.sub('api').pr.head], ['pr', head]);
  assert.deepEqual(f.state.merged, [], 'green is not enough while Merge is on You review');

  await f.approve('approve-merge', { subJobId: 'api', head });
  await f.tick();
  assert.deepEqual(f.state.merged, [head], 'the approved head merges');
  await f.tick();
  assert.equal(f.sub('api').stage, 'deployment', 'a merge that deploys is watched');
  f.state.deployment = { status: 'passing', runs: [{ workflow: 'Deploy', status: 'passing' }] };
  await f.tick(); await f.tick();

  const done = f.sub('api');
  assert.deepEqual([done.stage, done.state, done.deployed.checks], ['done', 'done', ['Post-merge runs passed']]);
  assert.equal(f.job().stage, 'done');
  assert.ok(!fs.existsSync(wt), 'cleanup removed the worktree');
  assert.ok(branchGone(f, branch), 'and the merged branch, locally and on origin');
  assert.equal(git(f.repo, 'rev-parse', 'main'), head, 'local main was fast-forwarded to the merge');
  assert.deepEqual(f.job().mainNotices || [], []);
});

test('a session step with a reviewed write: drafts park it, the human decides, mail resumes it, it completes and its result is approved', async (t) => {
  const f = board(t);
  await f.start({ subJobs: [session('notify'), write('post', 'notify', { review: true })] }, { reviewSessions: true });
  const run = f.runOf('notify', 'session');
  assert.ok(run.sessionId);
  const drafted = await f.report(run, { kind: 'drafts', drafts: [{ id: 'post', text: 'Widgets shipped' }] });
  assert.match(drafted.next, /End your turn and wait/);
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.runOf('notify', 'session').stopped, false, 'a parked session is not finished');
  assert.deepEqual([f.sub('post').stage, f.sub('post').action.text], ['review', 'Widgets shipped']);
  assert.deepEqual(f.mailed, [], 'nothing is sent while a draft is undecided');

  await f.approve('approve-write', { subJobId: 'post', write: { action: { text: 'Widgets shipped today' } } });
  await f.tick();
  const [mail] = f.mailed;
  assert.equal(mail.to, run.sessionId);
  assert.match(mail.text, /"text":"Widgets shipped today","approved":true/);
  assert.ok(f.runOf('notify', 'session').mailedAt);

  await f.report(run, { kind: 'completed', checks: ['Posted'], writes: [{ id: 'post', outcome: 'written', url: 'https://acme.slack.com/archives/C1/p1' }] });
  await f.tick();
  assert.deepEqual([f.sub('notify').stage, f.sub('notify').state], ['review', 'verified'], 'Session results on You review: the human reads it first');
  await f.approve('approve-session', { subJobId: 'notify', sessionReceiptId: f.sub('notify').result.receiptId });
  await f.tick(); await f.tick();
  assert.deepEqual(f.job().subJobs.map((s) => [s.id, s.stage]), [['notify', 'done'], ['post', 'done']]);
  assert.equal(f.sub('post').result.url, 'https://acme.slack.com/archives/C1/p1');
  assert.equal(f.job().stage, 'done');
});

test('a human step is marked started then done by the human, which releases the session behind it', async (t) => {
  const f = board(t);
  await f.start({ subJobs: [human('keys'), session('setup', ['keys'])] }, { reviewSessions: false });
  await f.tick();
  assert.equal(f.runOf('setup'), undefined, 'nothing behind a human step starts');
  assert.deepEqual([f.sub('keys').stage, f.sub('keys').state], ['human', 'queued']);
  await f.approve('start-human', { subJobId: 'keys' });
  assert.deepEqual([f.sub('keys').stage, f.sub('keys').state], ['human', 'doing']);
  await f.tick();
  assert.equal(f.runOf('setup'), undefined, 'started is not done');
  await f.approve('finish-human', { subJobId: 'keys', note: 'Vendor keys issued' });
  await f.tick();
  assert.deepEqual([f.sub('keys').stage, f.sub('keys').result.checks], ['done', ['Vendor keys issued']]);
  const setup = f.runOf('setup', 'session');
  assert.ok(setup?.sessionId, 'done is what launches the next step');
  await f.report(setup, { kind: 'completed', checks: ['Keys installed'] });
  await f.tick(); await f.tick();
  assert.deepEqual(f.job().subJobs.map((s) => [s.id, s.stage]), [['keys', 'done'], ['setup', 'done']]);
  assert.equal(f.job().stage, 'done');
  assert.deepEqual(f.job().moves.map((m) => m.move), ['start-human', 'finish-human']);
});

test('red to fix: failing CI goes back to work once, the limit turns it red, the planner proposes a rework, the human approves, and the fixed PR merges', async (t) => {
  const f = board(t, { settings: { maxRepairs: 1, maxReplans: 1 } });
  await f.start({ subJobs: [pr('api', [], { repo: f.repo })] }, { reviewCode: false, reviewMerge: false });
  const failing = { checkStatus: 'failing', checks: [{ name: 'e2e', state: 'FAILURE' }] };
  await f.publish('api', f.runOf('api', 'implementation'), failing);
  await f.tick(); await f.tick();
  const fix = f.runOf('api', 'implementation');
  assert.ok(fix?.sessionId && fix.fixChecks, 'failing CI wakes a work run, not a repair');
  assert.equal(f.runOf('api', 'repair'), undefined);
  assert.equal(f.spawned.at(-1).worktree.folderName, f.sub('api').worktree.path, 'in the PR\'s own worktree');

  f.work('api', 'api.js', 'export const api = 2;\n');
  await f.report(fix, { kind: 'ready', checks: ['e2e passes locally'] });
  await f.tick();
  assert.match(f.mailed.at(-1).text, /Code is on Auto/, 'no park on Auto: the same session is told to push');
  const second = f.work('api', 'api.js', 'export const api = 2;\n', { push: true });
  await f.report(fix, { kind: 'published', url: PR_URL });
  f.openPr(second, failing);
  await f.tick(); await f.tick();
  assert.match(f.sub('api').error, /repair limit/, 'still failing after the last fix: red');
  await f.tick();
  const planner = f.runOf(null, 'planning');
  assert.deepEqual([planner.red, f.job().replan.red], [{ sub: 'api' }, { sub: 'api', auto: false, n: 1 }], 'a red step goes to the planner before the human');
  await f.report(planner, { kind: 'plan', plan: f.job().plan, diagnosis: { summary: 'The e2e wait is too short' }, actions: [{ type: 'rework', sub: 'api', note: 'Raise the e2e wait' }] });
  await f.tick();
  assert.match(f.sub('api').error, /repair limit/, 'Red steps on You decide: nothing applies by itself');

  await f.approve('approve-replan', { proposalId: planner.id });
  assert.equal(f.sub('api').error, null);
  await f.tick();
  const rework = f.runOf('api', 'implementation');
  assert.notEqual(rework.id, fix.id, 'the approved rework is a work run past the limit');
  f.work('api', 'api.js', 'export const api = 3;\n');
  await f.report(rework, { kind: 'ready', checks: ['e2e passes'] });
  await f.tick();
  const third = f.work('api', 'api.js', 'export const api = 3;\n', { push: true });
  await f.report(rework, { kind: 'published', url: PR_URL });
  f.openPr(third, { checkStatus: 'passing' });
  await f.tick(); await f.tick(); await f.tick();
  assert.deepEqual(f.state.merged, [third], 'only the green head merges');
  assert.deepEqual([f.sub('api').stage, f.sub('api').deployed.checks.length], ['done', 1]);
  assert.equal(f.job().stage, 'done');
});

test('a work session that merged the base in has its ready refused while MERGE_HEAD is set; sync merges it instead, and work never does', async (t) => {
  const f = board(t);
  await f.start({ subJobs: [pr('api', [], { repo: f.repo })] }, { reviewCode: true, reviewMerge: true });
  const impl = f.runOf('api', 'implementation');
  const wt = f.sub('api').worktree.path;
  // The base moves under the step, touching the same line the step does.
  fs.writeFileSync(path.join(f.repo, 'README.md'), '# widgets, from main\n');
  git(f.repo, 'commit', '-qam', 'Main moves'); git(f.repo, 'push', '-q', 'origin', 'HEAD:main');
  fs.writeFileSync(path.join(wt, 'README.md'), '# widgets, from the step\n');
  git(wt, 'commit', '-qam', 'Step edit'); git(wt, 'fetch', '-q', 'origin');
  assert.throws(() => git(wt, 'merge', 'origin/main'), /CONFLICT|conflict|Command failed/);
  const refused = await tool('job_report').handler({ host: f.host, caller: impl.sessionId }, { runId: impl.id, report: { kind: 'ready', checks: ['Tests pass'] } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /A merge is in progress in this worktree \(MERGE_HEAD is set\)/);
  assert.equal(f.sub('api').stage, 'implementation', 'nothing recorded');
  git(wt, 'merge', '--abort');
  await f.report(impl, { kind: 'ready', checks: ['Tests pass'] });
  await f.tick();
  assert.equal(f.sub('api').stage, 'review');
  await f.approve('approve-code', { subJobId: 'api', readyReceiptId: f.sub('api').ready.receiptId });
  await f.tick();
  git(wt, 'push', '-q', 'origin', `HEAD:refs/heads/${f.sub('api').worktree.branch}`);
  const head = git(wt, 'rev-parse', 'HEAD');
  await f.report(impl, { kind: 'published', url: PR_URL });
  f.openPr(head, { checkStatus: 'failing', dirty: true });
  await f.tick();
  const sync = f.runOf('api', 'sync');
  assert.ok(sync?.sessionId, 'a conflicting PR gets a sync session, not work');
  assert.equal(f.spawned.at(-1).worktree.folderName, wt, 'in the PR\'s own worktree');
  assert.match(f.spawned.at(-1).intent, /This step only brings the branch .* up to date with origin\/main/);
  // The sync session's half: merge the base, resolve, commit the merge, push.
  assert.throws(() => git(wt, 'merge', 'origin/main'), /Command failed/);
  fs.writeFileSync(path.join(wt, 'README.md'), '# widgets, from main and the step\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '--no-edit');
  git(wt, 'push', '-q', 'origin', `HEAD:refs/heads/${f.sub('api').worktree.branch}`);
  await f.report(sync, { kind: 'synced', resolved: ['README.md: kept both lines'] });
  f.openPr(git(wt, 'rev-parse', 'HEAD'), { checkStatus: 'passing' });
  await f.tick();
  assert.deepEqual([f.sub('api').stage, f.sub('api').syncs.length, f.sub('api').pr.dirty], ['pr', 1, undefined]);
  assert.equal(f.runOf('api', 'sync').stopped, true);
});

test('a running job takes a plan change: the running step carries on, unstarted work is cancelled, the added step runs once its prerequisite lands', async (t) => {
  const f = board(t);
  await f.start({ subJobs: [pr('api', [], { repo: f.repo }), pr('web', ['api'], { repo: f.repo })] }, { reviewCode: false, reviewMerge: false, reviewPlan: true });
  const impl = f.runOf('api', 'implementation');
  await f.idea('Drop web; post release notes once api lands');
  const planner = await f.propose([pr('api', [], { repo: f.repo }), session('notes', ['api'])]);
  assert.deepEqual(f.job().replan.proposal.changes, { frozen: [], kept: ['api'], edited: [], added: ['notes'], removed: ['web'] });
  assert.equal(f.runOf('api', 'implementation').stopped, false, 'the running step is not interrupted while the human weighs it');

  await f.approve('approve-replan', { proposalId: planner.id });
  assert.deepEqual(f.job().subJobs.map((s) => [s.id, s.stage, s.state]), [['api', 'implementation', 'queued'], ['web', 'done', 'cancelled'], ['notes', 'session', 'queued']]);
  await f.tick();
  assert.equal(f.runOf('notes'), undefined, 'the added step waits for api to land');

  await f.publish('api', impl, { checkStatus: 'passing' });
  await f.tick(); await f.tick(); await f.tick();
  assert.equal(f.sub('api').stage, 'done');
  const notes = f.runOf('notes', 'session');
  assert.ok(notes?.sessionId, 'api landing releases the added step');
  await f.report(notes, { kind: 'completed', checks: ['Release notes posted'] });
  await f.tick();
  await f.approve('approve-session', { subJobId: 'notes', sessionReceiptId: f.sub('notes').result.receiptId });
  await f.tick(); await f.tick();
  assert.deepEqual(f.job().subJobs.map((s) => [s.id, s.state]), [['api', 'done'], ['web', 'cancelled'], ['notes', 'done']]);
  assert.equal(f.job().stage, 'done');
});

// Open flow bugs, kept as todo until they are fixed: the runner reports them
// without failing the suite, and each starts passing the day its fix lands.
test('a plan edit to a step that is still running can be approved (charlie-ps/wrangler-squared#112)', { todo: '#112: approve-replan is refused while the edited step runs' }, async (t) => {
  const f = board(t);
  await f.start({ subJobs: [pr('api', [], { repo: f.repo })] }, { reviewCode: false, reviewMerge: false });
  const impl = f.runOf('api', 'implementation');
  await f.idea('api should also log each request');
  const planner = await f.propose([pr('api', [], { repo: f.repo, brief: 'Implement api and log each request' })]);
  const said = await f.act('approve-replan', { proposalId: planner.id });
  assert.equal(said.event, 'job-action-complete', `Approve plan did nothing: ${said.error}`);
  assert.equal(f.job().replan, null);
  await f.publish('api', impl, { checkStatus: 'passing' });
  await f.tick();
  assert.equal(f.sub('api').brief, 'Implement api and log each request', 'the edit reaches the step, queued or by interrupting it');
});

test('a plan change that makes a red step wait on new work clears its red status (charlie-ps/wrangler-squared#165)', { todo: '#165: the blocked status stays until Retry' }, async (t) => {
  const f = board(t);
  await f.start({ subJobs: [pr('api', [], { repo: f.repo })] }, { reviewCode: false, reviewMerge: false });
  await f.report(f.runOf('api', 'implementation'), { kind: 'blocked', summary: 'The schema migration has to land first' });
  await f.tick();
  assert.ok(f.sub('api').blocked || f.sub('api').error, 'the step is red');
  await f.idea('Land the migration in its own PR first, then api');
  const planner = await f.propose([pr('migration', [], { repo: f.repo }), pr('api', ['migration'], { repo: f.repo })]);
  await f.approve('approve-replan', { proposalId: planner.id });
  assert.deepEqual([f.sub('api').after, f.sub('api').error ?? null, f.sub('api').blocked ?? null], [['migration'], null, null], 'waiting on migration, no longer red');
  await f.tick();
  assert.ok(f.runOf('migration', 'implementation')?.sessionId);
});
