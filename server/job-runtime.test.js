import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JobRuntime } from './job-runtime.js';
import { DATA_DIR } from './data-dir.js';
import { fakeHost } from './test-helpers.js';

// What survives of agent-wrangler's job-runtime.test.js (`job-system` branch)
// once the runtime talks to the host façade instead of a SessionManager: the launch
// options are manifest.test.js's (they are only observable through the hook),
// so what is left here is the teardown half — stop/isAlive over the projection,
// and the compare-and-delete git rules, which are still core's verbatim and
// still driven through the injected `run`.
const exec = promisify(execFile);
// A path cleanup must find absent; under the redirected DATA_DIR so nothing a
// test makes outlives the run (test-setup.js).
let paths = 0;
const missing = () => path.join(DATA_DIR, `gone-${++paths}`);
const runtimeWith = (host, { statusOf = () => null, run } = {}) => new JobRuntime({ host, statusOf }, run);
// The git/gh fake that suite used, adapted to the current argv: every call
// is recorded, `for-each-ref` answers with the branch head the repo is pretending
// to have and everything else with the empty string a quiet git command gives.
function fakeRun({ head = '', remote = '', overrides = {} } = {}) {
  const calls = [];
  const run = async (bin, args, cwd) => {
    calls.push(args);
    const override = overrides[args[0]];
    if (override) return override(args, cwd);
    if (args[0] === 'for-each-ref') return head;
    if (args[0] === 'ls-remote') return remote;
    return '';
  };
  return { calls, run };
}

test('stop archives the card, then refuses to release the slot while the session is still working', async () => {
  const { host, archived, sessions } = fakeHost();
  sessions.set('sid', { sessionId: 'sid', archived: false });
  // A survivor: the archive lands but the pane is still on the board working, so
  // the concurrency slot stays reserved rather than being handed to the next step.
  host.sessions.archive = async (id) => { archived.push(id); };
  await assert.rejects(runtimeWith(host, { statusOf: () => 'working' }).stop({ sessionId: 'sid' }), /still running/);
  assert.deepEqual(archived, ['sid']);
});

test('stop is one archive per step: an already-archived card is not re-stamped and a purged one is not resurrected', async () => {
  const { host, archived, sessions } = fakeHost();
  // The settle sweep re-runs stop() over runs whose card is already archived;
  // archiving again would move the timestamp Search's buckets read.
  sessions.set('archived-already', { sessionId: 'archived-already', archived: true });
  await runtimeWith(host).stop({ sessionId: 'archived-already' });
  // A human purged the card mid-run: archive() would adopt the id back onto the
  // board as an empty archived row.
  await runtimeWith(host).stop({ sessionId: 'purged' });
  await runtimeWith(host).stop({ id: 'run_1' });
  assert.deepEqual(archived, []);
});

test('isAlive reads the projection and the cached card status, and never another session', async () => {
  const { host, sessions } = fakeHost();
  sessions.set('sid', { sessionId: 'sid', archived: false });
  sessions.set('gone', { sessionId: 'gone', archived: true });
  for (const [status, expected] of [['working', true], ['needs-you', true], ['idle', true], ['done', false], [null, false]]) {
    assert.equal(await runtimeWith(host, { statusOf: () => status }).isAlive({ sessionId: 'sid' }), expected, String(status));
  }
  const live = runtimeWith(host, { statusOf: () => 'working' });
  assert.equal(await live.isAlive({ sessionId: 'gone' }), false, 'an archived card is not a live pane whatever the stale status says');
  assert.equal(await live.isAlive({ sessionId: 'never-existed' }), false);
  assert.equal(await live.isAlive({ id: 'run_1' }), false, 'an unbound run has nothing to probe');
});

test('a dispatch with no launch of ours pending is left to the board', () => {
  const { host } = fakeHost();
  assert.equal(runtimeWith(host).noteDispatch({ sessionId: 'someone-elses', worktree: null }), false);
});

test('launch refuses a missing worktree instead of recreating it on the base checkout', async () => {
  const { host, spawned } = fakeHost();
  const runtime = runtimeWith(host, { run: async () => assert.fail('a missing worktree is not re-cut') });
  await assert.rejects(runtime.launch({ id: 'job_12345678', title: 'Sign-in', agent: 'claude' },
    { id: 'api', repo: '/repo', worktree: { path: missing() } }, { id: 'run_1', phase: 'publish' }, () => {}), /missing/);
  assert.deepEqual(spawned, []);
});

test('launch refuses an archived job task before preparing a workspace or spawning', async () => {
  const { host, spawned, tasks } = fakeHost();
  tasks.push({ id: 't_archived', name: 'Old work', links: [], archivedAt: Date.now() });
  const runtime = runtimeWith(host, { run: async () => assert.fail('an archived task is rejected before repository setup') });
  await assert.rejects(runtime.launch({ id: 'job_12345678', title: 'Sign-in', agent: 'claude', taskId: 't_archived' },
    { id: 'api', repo: '/repo' }, { id: 'run_1', phase: 'implementation' }, () => {}), /Restore it before retrying/);
  assert.deepEqual(spawned, []);
});

test('a jira or session step gets the same scratch workspace as planning: no repository, no branch', async () => {
  for (const phase of ['jira', 'session']) {
    const { host, spawned } = fakeHost();
    const runtime = runtimeWith(host, { run: async () => assert.fail(`${phase} has no repository to fetch`) });
    let prepared = 'unset';
    await runtime.launch({ id: 'job_12345678', title: 'Sign-in', agent: 'claude' }, { id: 'spike', kind: 'session', brief: 'Investigate' },
      { id: 'run_1', phase }, (...v) => { prepared = v; });
    assert.equal(spawned[0].cwd, '', phase);
    assert.equal(spawned[0].worktree, undefined, phase);
    assert.deepEqual(spawned[0].addDirs, [path.join(os.homedir(), 'IdeaProjects')], phase);
    assert.deepEqual(prepared, ['s_1', undefined], 'the wrangler cut nothing, so there is no record to report');
    // And nothing git-shaped to undo afterwards: no worktree, no branch, no PR.
    await runtime.cleanup({ updateMain: true }, { id: 'spike', kind: 'session', sessions: ['s_1'], pr: null, worktree: undefined });
  }
});

test('cleanup deletes only the ref value it verified, and refuses extra commits', async () => {
  const { host } = fakeHost();
  const wt = { path: missing(), repoRoot: '/repo', branch: 'job-api' };
  const verified = fakeRun({ head: 'verified' });
  await runtimeWith(host, { run: verified.run }).cleanupWorktree(wt, 'verified');
  assert.deepEqual(verified.calls.at(-1), ['update-ref', '-d', 'refs/heads/job-api', 'verified']);
  const moved = fakeRun({ head: 'verified' });
  await assert.rejects(runtimeWith(host, { run: moved.run }).cleanupWorktree(wt, 'older'), /additional commits/);
  assert.ok(!moved.calls.some((c) => c[0] === 'update-ref'));
  const never = fakeRun();
  await assert.rejects(runtimeWith(host, { run: never.run }).cleanupWorktree(wt, ''), /verified branch head/);
  assert.deepEqual(never.calls, [], 'without a head to compare against nothing is even looked at');
});

test('cleanup preserves a worktree that moved on since verification, and a branch another worktree holds', async () => {
  const { host } = fakeHost();
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'worktree-'));
  const wt = { path: dir, repoRoot: '/repo', branch: 'job-api' };
  for (const [ref, head] of [['refs/heads/somewhere-else', 'verified'], ['refs/heads/job-api', 'newer']]) {
    const f = fakeRun({ overrides: { 'symbolic-ref': () => ref, 'rev-parse': () => head } });
    await assert.rejects(runtimeWith(host, { run: f.run }).cleanupWorktree(wt, 'verified'), /preserve it for review/);
    assert.ok(!f.calls.some((c) => c[0] === 'worktree'), 'nothing is removed once the tree has changed');
  }
  const held = fakeRun({ overrides: { worktree: () => 'worktree /elsewhere\nbranch refs/heads/job-api' } });
  await assert.rejects(runtimeWith(host, { run: held.run }).cleanupWorktree({ ...wt, path: missing() }, 'verified'), /another worktree/);
});

// A merged PR's sub-job, as cleanup() sees it once the job is finished.
const merged = { id: 'api', repo: '/repo', sessions: [], pr: { head: 'head1', base: 'main', url: 'u' },
  worktree: { path: '', repoRoot: '/repo', branch: 'job-api', cleanupHead: 'base' } };

test('cleanup deletes the branch on origin only while it still points at the merged head', async () => {
  const { host } = fakeHost();
  const sub = { ...merged, worktree: { ...merged.worktree, path: missing() } };
  const matching = fakeRun({ head: 'head1', remote: 'head1\trefs/heads/job-api' });
  await runtimeWith(host, { run: matching.run }).cleanup({}, sub);
  assert.deepEqual(matching.calls.at(-2), ['ls-remote', '--exit-code', 'origin', 'refs/heads/job-api']);
  assert.deepEqual(matching.calls.at(-1), ['push', 'origin', '--force-with-lease=refs/heads/job-api:head1', '--delete', 'refs/heads/job-api']);
  // `ls-remote --exit-code` exits 2 for "no such ref": GitHub's own delete-on-merge
  // or a human got there first, which is success, not a failure to investigate.
  const gone = fakeRun({ head: 'head1', overrides: { 'ls-remote': () => { throw Object.assign(new Error('exit 2'), { code: 2 }); } } });
  await runtimeWith(host, { run: gone.run }).cleanup({}, sub);
  assert.ok(!gone.calls.some((c) => c[0] === 'push'));
  const moved = fakeRun({ head: 'head1', remote: 'head2\trefs/heads/job-api' });
  await assert.rejects(runtimeWith(host, { run: moved.run }).cleanup({}, sub), /beyond the merged PR/);
  assert.ok(!moved.calls.some((c) => c[0] === 'push'));
  const failing = fakeRun({ head: 'head1', overrides: { 'ls-remote': () => { throw Object.assign(new Error('network'), { code: 128 }); } } });
  await assert.rejects(runtimeWith(host, { run: failing.run }).cleanup({}, sub), /network/, 'only exit 2 means "already gone"');
});

test('cleanup of a cancelled sub-job archives its sessions, keeps unpushed commits and leaves origin alone', async () => {
  const { host, archived, sessions } = fakeHost();
  sessions.set('sid', { sessionId: 'sid', archived: false });
  sessions.set('already', { sessionId: 'already', archived: true });
  const cancelled = { ...merged, cancelledAt: 1, pr: null, sessions: ['sid', 'already', 'purged'],
    worktree: { ...merged.worktree, path: missing() } };
  const f = fakeRun({ head: 'base' });
  await runtimeWith(host, { run: f.run }).cleanup({ updateMain: true }, cancelled);
  assert.deepEqual(archived, ['sid'], 'an archived card is not re-stamped and a purged one is not adopted back');
  assert.deepEqual(f.calls.at(-1), ['update-ref', '-d', 'refs/heads/job-api', 'base'], 'a cancelled sub-job never pushed, so the base it was cut from is what may be deleted');
  assert.ok(!f.calls.some((c) => ['merge', 'ls-remote', 'push'].includes(c[0])), 'nothing merged: main and origin are left alone');
  const committed = fakeRun({ head: 'unpushed' });
  await assert.rejects(runtimeWith(host, { run: committed.run }).cleanup({}, cancelled), /additional commits/);
});

test('cleanup of a PR sub-job marked done by hand before it ever got a PR falls back to the worktree\'s cut point', async () => {
  const { host } = fakeHost();
  const sub = { ...merged, pr: null, worktree: { ...merged.worktree, path: missing() } };
  const f = fakeRun({ head: 'base' });
  await runtimeWith(host, { run: f.run }).cleanup({}, sub);
  assert.deepEqual(f.calls.at(-1), ['update-ref', '-d', 'refs/heads/job-api', 'base'], 'never pushed, so the base it was cut from is what may be deleted');
  assert.ok(!f.calls.some((c) => ['ls-remote', 'push'].includes(c[0])), 'no PR ever existed, so there is no origin branch to touch');
});

test('updateMain fast-forwards the main checkout only when it is clean and on the PR base', async () => {
  const { host } = fakeHost();
  const repo = fs.mkdtempSync(path.join(DATA_DIR, 'main-checkout-'));
  await exec('git', ['init', '-q', repo]);
  const sub = { ...merged, repo, worktree: null };
  const state = (dirty, branch) => ({ overrides: { status: () => dirty, branch: () => branch } });
  for (const [dirty, branch] of [[' M src/app.js', 'main'], ['', 'other']]) {
    const f = fakeRun(state(dirty, branch));
    await assert.rejects(runtimeWith(host, { run: f.run }).cleanup({ updateMain: true }, sub), /update it manually/);
    assert.ok(!f.calls.some((c) => c[0] === 'merge'));
  }
  const clean = fakeRun(state('', 'main'));
  await runtimeWith(host, { run: clean.run }).cleanup({ updateMain: true }, sub);
  assert.deepEqual(clean.calls.at(-2), ['fetch', 'origin']);
  assert.deepEqual(clean.calls.at(-1), ['merge', '--ff-only', 'refs/remotes/origin/main'], 'a fast-forward or nothing: a merge commit on main is never this extension\'s to make');
  const nowhere = fakeRun(state('', 'main'));
  await assert.rejects(runtimeWith(host, { run: nowhere.run }).cleanup({ updateMain: true }, { ...sub, repo: missing() }), /Cannot resolve main checkout/);
});

test('cleanupPlanning stops the planning and ticketing steps and removes the worktrees they were given', async () => {
  const { host, archived, sessions } = fakeHost();
  for (const id of ['plan', 'jira']) sessions.set(id, { sessionId: id, archived: false });
  const job = {
    runs: [{ phase: 'planning', sessionId: 'plan' }, { phase: 'jira', sessionId: 'jira' },
      { phase: 'planning', sessionId: null }, { phase: 'implementation', sessionId: 'worker' }],
    planningWorktrees: [{ path: missing(), repoRoot: '/repo', branch: 'job-plan', cleanupHead: 'base' }],
  };
  const f = fakeRun({ head: 'base' });
  await runtimeWith(host, { run: f.run }).cleanupPlanning(job);
  assert.deepEqual(archived, ['plan', 'jira'], 'a sub-job\'s own step is cleaned up with the sub-job, not with the plan');
  assert.deepEqual(f.calls.at(-1), ['update-ref', '-d', 'refs/heads/job-plan', 'base']);
});

test('attributeSpend bills a headless triage to the sub-job\'s latest card, and nothing when there is none', () => {
  const { host, billed, sessions } = fakeHost();
  sessions.set('s_old', { sessionId: 's_old', archived: true, worktree: null });
  sessions.set('s_new', { sessionId: 's_new', archived: false, worktree: null });
  const runtime = runtimeWith(host);
  assert.equal(runtime.attributeSpend({ sessions: ['s_old', 's_new'] }, 'live-triage'), true);
  assert.deepEqual(billed, [{ sessionId: 's_new', liveSessionId: 'live-triage' }]);
  assert.deepEqual(sessions.get('s_new').priorLiveSessionIds, ['live-triage']);
  assert.equal(runtime.attributeSpend({ sessions: [] }, 'live-triage'), false, 'a sub-job that never bound a card');
  assert.equal(runtime.attributeSpend({ sessions: ['s_new'] }, null), false, 'a triage that reported no live id');
  assert.equal(runtime.attributeSpend({ sessions: ['s_gone'] }, 'live-2'), false, 'a purged card is the host\'s false, not a throw');
  assert.equal(billed.length, 1);
});
