import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JobRuntime, LAUNCH_GRACE_MS, CleanupRefused, parseStatus } from './job-runtime.js';
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
const runtimeWith = (host, { statusOf = () => null, now, run } = {}) => new JobRuntime({ host, statusOf, now }, run);
// The git/gh fake that suite used, adapted to the current argv: every call
// is recorded, `for-each-ref` answers with the branch head the repo is pretending
// to have and everything else with the empty string a quiet git command gives.
// `log` is the branch's commits that origin/main lacks, as `%H<TAB>%s` lines.
function fakeRun({ head = '', remote = '', log = '', overrides = {} } = {}) {
  const calls = [];
  const run = async (bin, args, cwd) => {
    calls.push(args);
    const override = overrides[args[0]];
    if (override) return override(args, cwd);
    if (args[0] === 'for-each-ref') return head;
    if (args[0] === 'ls-remote') return remote;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'origin/main';
    if (args[0] === 'log') return log;
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
  for (const [status, expected] of [['working', true], ['needs-you', true], ['idle', true], ['unknown', true], ['done', false], [null, false]]) {
    assert.equal(await runtimeWith(host, { statusOf: () => status }).isAlive({ sessionId: 'sid' }), expected, String(status));
  }
  const live = runtimeWith(host, { statusOf: () => 'working' });
  assert.equal(await live.isAlive({ sessionId: 'gone' }), false, 'an archived card is not a live pane whatever the stale status says');
  assert.equal(await live.isAlive({ sessionId: 'never-existed' }), false);
  assert.equal(await live.isAlive({ id: 'run_1' }), false, 'an unbound run has nothing to probe');
});

test('a just-launched card with no status yet is alive for the launch grace, then is not', async () => {
  const { host, sessions } = fakeHost();
  sessions.set('sid', { sessionId: 'sid', archived: false });
  // A starting Claude has written no status file and may not be in the cached
  // graph yet: reaping it here killed Jira steps ~9s after launch.
  const at = (ms) => runtimeWith(host, { now: () => 1_000 + ms });
  const run = { sessionId: 'sid', startedAt: 1_000 };
  assert.equal(await at(9_000).isAlive(run), true);
  assert.equal(await at(LAUNCH_GRACE_MS).isAlive(run), false, 'a card that never reaches the graph still errors');
  assert.equal(await at(0).isAlive({ sessionId: 'sid' }), false, 'no startedAt, no grace');
  sessions.set('sid', { sessionId: 'sid', archived: true });
  assert.equal(await at(0).isAlive(run), false, 'an archived card gets no grace');
});

test('a parked session is held only to its card existing; its mail wakes a dormant card first, and the launch grace restarts from the mail', async () => {
  const { host, mailed, woken, sessions } = fakeHost();
  let dormant = true, clock = 1000;
  const runtime = new JobRuntime({ host, statusOf: () => null, dormantOf: () => dormant, now: () => clock });
  const { sessionId } = await host.sessions.spawn({ cwd: '' });
  const run = { id: 'run_1', sessionId, startedAt: 0 };
  assert.equal(await runtime.exists(run), true);
  await runtime.resumeWithMail(run, 'Make post');
  assert.deepEqual([woken, mailed], [[sessionId], [{ to: sessionId, text: 'Make post' }]]);
  dormant = false;
  await runtime.resumeWithMail(run, 'Again');
  assert.equal(woken.length, 1, 'a live card is never relaunched to read its mail');
  clock = LAUNCH_GRACE_MS + 10;
  assert.equal(await runtime.isAlive(run), false, 'long past its launch, with no status');
  assert.equal(await runtime.isAlive({ ...run, mailedAt: 20 }), true, 'just woken for its mail');
  sessions.get(sessionId).archived = true;
  assert.equal(await runtime.exists(run), false);
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

const withCheckouts = async (dir, fn) => {
  const prev = process.env.AW_CHECKOUTS_DIR;
  process.env.AW_CHECKOUTS_DIR = dir;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AW_CHECKOUTS_DIR; else process.env.AW_CHECKOUTS_DIR = prev; }
};

test('a session step gets the same scratch workspace as planning: no repository, no branch', async () => {
  const checkouts = fs.mkdtempSync(path.join(os.tmpdir(), 'checkouts-'));
  for (const phase of ['session']) await withCheckouts(checkouts, async () => {
    const { host, spawned } = fakeHost();
    const runtime = runtimeWith(host, { run: async () => assert.fail(`${phase} has no repository to fetch`) });
    let prepared = 'unset';
    await runtime.launch({ id: 'job_12345678', title: 'Sign-in', agent: 'claude' }, { id: 'spike', kind: 'session', brief: 'Investigate' },
      { id: 'run_1', phase }, (...v) => { prepared = v; });
    assert.equal(spawned[0].cwd, '', phase);
    assert.equal(spawned[0].worktree, undefined, phase);
    assert.deepEqual(spawned[0].addDirs, [checkouts], phase);
    assert.deepEqual(prepared, ['s_1', undefined], 'the wrangler cut nothing, so there is no record to report');
    // And nothing git-shaped to undo afterwards: no worktree, no branch, no PR.
    await runtime.cleanup({ updateMain: true }, { id: 'spike', kind: 'session', sessions: ['s_1'], pr: null, worktree: undefined });
  });
});

test('planning grants no addDir and names no clone root when the checkouts folder does not exist', async () => {
  await withCheckouts(missing(), async () => {
    const { host, spawned } = fakeHost();
    const runtime = runtimeWith(host, { run: async () => assert.fail('planning has no repository to fetch') });
    await runtime.launch({ id: 'job_12345678', title: 'Sign-in', agent: 'claude', intent: 'Ship it' }, null, { id: 'run_1', phase: 'planning' }, () => {});
    assert.equal(spawned[0].addDirs, undefined, 'a missing --add-dir fails the launch');
    assert.doesNotMatch(spawned[0].intent, /IdeaProjects|<repository-name>/);
    assert.match(spawned[0].intent, /clone it beside your checkouts/);
  });
});

test('a Codex job\'s writable folders join every step\'s addDirs, expanded, with missing ones skipped', async () => {
  const checkouts = fs.mkdtempSync(path.join(os.tmpdir(), 'checkouts-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-'));
  fs.mkdirSync(path.join(home, '.docker'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await withCheckouts(checkouts, async () => {
      const launch = async (job, phase = 'planning') => {
        const { host, spawned } = fakeHost();
        await runtimeWith(host, { run: async () => assert.fail('no repository to fetch') }).launch({ id: 'job_12345678', title: 'Sign-in', intent: 'Ship it', ...job },
          phase === 'planning' ? null : { id: 'spike', kind: 'session', brief: 'Investigate' }, { id: 'run_1', phase }, () => {});
        return spawned[0].addDirs;
      };
      const dirs = ['~/.docker', extra, missing(), `${extra}/`];
      assert.deepEqual(await launch({ agent: 'codex', sandbox: 'auto', writableDirs: dirs }), [checkouts, path.join(home, '.docker'), extra], 'planning keeps its checkouts grant; a folder missing here is dropped');
      assert.deepEqual(await launch({ agent: 'codex', sandbox: 'locked', writableDirs: dirs }, 'session'), [checkouts, path.join(home, '.docker'), extra]);
      assert.deepEqual(await launch({ agent: 'codex', sandbox: 'full', writableDirs: dirs }), [checkouts], 'Full access has no sandbox to widen');
      assert.deepEqual(await launch({ agent: 'claude', sandbox: 'auto', writableDirs: dirs }), [checkouts], 'Claude has no OS sandbox');
    });
    await withCheckouts(missing(), async () => {
      const { host, spawned } = fakeHost();
      await runtimeWith(host, { run: async () => assert.fail('no repository') }).launch({ id: 'job_12345678', title: 'Sign-in', intent: 'Ship it', agent: 'codex', writableDirs: [missing()] }, null, { id: 'run_1', phase: 'planning' }, () => {});
      assert.equal(spawned[0].addDirs, undefined, 'nothing left to grant, no addDirs at all');
    });
  } finally { process.env.HOME = prevHome; }
});

test('cleanup deletes only the ref value it verified, and refuses extra commits', async () => {
  const { host } = fakeHost();
  const wt = { path: missing(), repoRoot: '/repo', branch: 'job-api' };
  const verified = fakeRun({ head: 'verified' });
  await runtimeWith(host, { run: verified.run }).cleanupWorktree(wt, 'verified');
  assert.deepEqual(verified.calls.at(-1), ['update-ref', '-d', 'refs/heads/job-api', 'verified']);
  const moved = fakeRun({ head: 'verified', log: 'verified\tAdd the endpoint' });
  await assert.rejects(runtimeWith(host, { run: moved.run }).cleanupWorktree(wt, 'older'), /1 commit not on origin\/main/);
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
    const f = fakeRun({ log: `${head}\tLocal work`, overrides: { 'symbolic-ref': () => ref, 'rev-parse': (args) => args[1] === '--abbrev-ref' ? 'origin/main' : head } });
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

test('cleanup of a PR sub-job accepts a local head behind the GitHub-updated PR head and deletes the local value', async () => {
  const { host } = fakeHost();
  const sub = { ...merged, worktree: { ...merged.worktree, path: missing() } };
  const f = fakeRun({ head: 'pushed', remote: 'head1\trefs/heads/job-api' });
  await runtimeWith(host, { run: f.run }).cleanup({}, sub);
  assert.ok(f.calls.some((c) => c[0] === 'fetch'), 'the merge commit was made on GitHub');
  assert.deepEqual(f.calls.find((c) => c[0] === 'merge-base'), ['merge-base', '--is-ancestor', 'pushed', 'head1']);
  assert.deepEqual(f.calls.find((c) => c[0] === 'update-ref'), ['update-ref', '-d', 'refs/heads/job-api', 'pushed']);
});

test('cleanup of a PR sub-job still preserves a local commit the merged head does not contain', async () => {
  const { host } = fakeHost();
  const notAncestor = { 'merge-base': () => { throw Object.assign(new Error('exit 1'), { code: 1 }); } };
  const sub = { ...merged, worktree: { ...merged.worktree, path: missing() } };
  const branch = fakeRun({ head: 'local-extra', log: 'local-extra\tExtra', overrides: notAncestor });
  await assert.rejects(runtimeWith(host, { run: branch.run }).cleanup({}, sub), /1 commit not on origin\/main/);
  assert.ok(!branch.calls.some((c) => ['update-ref', 'push'].includes(c[0])));
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'worktree-'));
  const tree = fakeRun({ log: 'local-extra\tExtra', overrides: { ...notAncestor, 'symbolic-ref': () => 'refs/heads/job-api', 'rev-parse': (args) => args[1] === '--abbrev-ref' ? 'origin/main' : 'local-extra' } });
  await assert.rejects(runtimeWith(host, { run: tree.run }).cleanup({}, { ...sub, worktree: { ...sub.worktree, path: dir } }), /preserve it for review/);
  assert.ok(!tree.calls.some((c) => c[0] === 'worktree'));
});

test('cleanup of a PR sub-job fails safely, deleting nothing, when the merged head cannot be resolved', async () => {
  const { host } = fakeHost();
  const sub = { ...merged, worktree: { ...merged.worktree, path: missing() } };
  const f = fakeRun({ head: 'pushed', overrides: { 'cat-file': () => { throw new Error('bad object'); } } });
  await assert.rejects(runtimeWith(host, { run: f.run }).cleanup({}, sub), /Cannot resolve merged PR head head1/);
  assert.ok(!f.calls.some((c) => ['update-ref', 'push', 'merge-base'].includes(c[0])));
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
  const committed = fakeRun({ head: 'unpushed', log: 'unpushed\tWork in progress' });
  await assert.rejects(runtimeWith(host, { run: committed.run }).cleanup({}, cancelled), /1 commit not on origin\/main/);
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

test('cleanupPlanning stops the planning and write steps and removes the worktrees they were given', async () => {
  const { host, archived, sessions } = fakeHost();
  for (const id of ['plan', 'write']) sessions.set(id, { sessionId: id, archived: false });
  const job = {
    runs: [{ phase: 'planning', sessionId: 'plan' }, { phase: 'write', sessionId: 'write' },
      { phase: 'planning', sessionId: null }, { phase: 'implementation', sessionId: 'worker' }],
    planningWorktrees: [{ path: missing(), repoRoot: '/repo', branch: 'job-plan', cleanupHead: 'base' }],
  };
  const f = fakeRun({ head: 'base' });
  await runtimeWith(host, { run: f.run }).cleanupPlanning(job);
  assert.deepEqual(archived, ['plan', 'write'], 'a sub-job\'s own step is cleaned up with the sub-job, not with the plan');
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

const launchWith = async (job, run) => {
  const { host, spawned } = fakeHost();
  await runtimeWith(host, { run }).launch({ id: 'job_12345678', title: 'Sign-in', agent: 'claude', ...job }, { id: 'api', repo: '/repo' }, { id: 'run_1', phase: 'implementation' }, () => {});
  return spawned[0];
};

test('a job with no base cuts its worktree from the default branch, as before', async () => {
  const calls = [];
  const spawn = await launchWith({}, async (bin, args) => { calls.push([bin, ...args]); return bin === 'gh' ? JSON.stringify({ defaultBranchRef: { name: 'main' } }) : 'abc'; });
  assert.equal(spawn.worktree.base, 'refs/remotes/origin/main');
  assert.ok(calls.some((c) => c[0] === 'gh'));
});

test('a job with a base fetches, then cuts the worktree and its cleanup head from that branch', async () => {
  const calls = [];
  const spawn = await launchWith({ base: 'next' }, async (bin, args) => { calls.push([bin, ...args]); return 'abc'; });
  assert.equal(spawn.worktree.base, 'refs/remotes/origin/next');
  assert.deepEqual(calls[0], ['git', 'fetch', 'origin']);
  assert.deepEqual(calls.at(-1), ['git', 'rev-parse', '--verify', 'refs/remotes/origin/next']);
  assert.ok(!calls.some((c) => c[0] === 'gh'), 'the default branch is not consulted');
});

test('a base missing on origin fails the launch naming the branch, and spawns nothing', async () => {
  const { host, spawned } = fakeHost();
  const run = async (bin, args) => { if (args[0] === 'rev-parse') throw new Error('fatal: Needed a single revision'); return ''; };
  await assert.rejects(runtimeWith(host, { run }).launch({ id: 'job_12345678', title: 'x', agent: 'claude', base: 'next' }, { id: 'api', repo: '/repo' }, { id: 'run_1', phase: 'implementation' }, () => {}), /Base branch "next" does not exist on origin/);
  assert.deepEqual(spawned, []);
});

test('updateMain leaves main alone when the job landed on a non-default base', async () => {
  const { host } = fakeHost();
  const repo = fs.mkdtempSync(path.join(DATA_DIR, 'main-checkout-'));
  await exec('git', ['init', '-q', repo]);
  const sub = { id: 'api', repo, worktree: null, sessions: [], pr: { url: 'u', head: 'h', base: 'next' } };
  const defaultIs = (name) => ({ overrides: { status: () => '', branch: () => 'main', repo: () => JSON.stringify({ defaultBranchRef: { name } }) } });
  const away = fakeRun(defaultIs('main'));
  await runtimeWith(host, { run: away.run }).cleanup({ updateMain: true, base: 'next' }, sub);
  assert.ok(!away.calls.some((c) => c[0] === 'merge' || c[0] === 'fetch'), 'no surprise fast-forward');
  const home = fakeRun({ overrides: { status: () => '', branch: () => 'next', repo: () => JSON.stringify({ defaultBranchRef: { name: 'next' } }) } });
  await runtimeWith(host, { run: home.run }).cleanup({ updateMain: true, base: 'next' }, sub);
  assert.deepEqual(home.calls.at(-1), ['merge', '--ff-only', 'refs/remotes/origin/next'], 'a base that IS the default still fast-forwards');
});

// A real origin, clone and job worktree, because the refusal rules read real git
// output (status v2, log/rev-list against origin) that the fake cannot stand in for.
async function gitRepo() {
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'cleanup-'));
  const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());
  const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), wtPath = path.join(dir, 'repo-worktree-job-api');
  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await exec('git', ['clone', '-q', origin, repo]);
  const commit = async (cwd, file, message) => { fs.writeFileSync(path.join(cwd, file), `${message}\n`); await git(cwd, 'add', file); await git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message); };
  await commit(repo, 'README.md', 'Initial');
  await git(repo, 'push', '-q', 'origin', 'HEAD:main');
  await git(repo, 'remote', 'set-head', 'origin', 'main');
  const cleanupHead = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'worktree', 'add', '-q', '-b', 'job-api', wtPath, 'refs/remotes/origin/main');
  const wt = { path: wtPath, repoRoot: repo, branch: 'job-api', cleanupHead };
  const branchExists = async () => Boolean(await git(repo, 'for-each-ref', '--format=%(objectname)', 'refs/heads/job-api'));
  return { git, repo, wt, commit, branchExists, runtime: runtimeWith(fakeHost().host) };
}

test('a worktree rebased onto newer main with no commits of its own is cleaned up', async () => {
  const r = await gitRepo();
  await r.commit(r.repo, 'other.js', 'Someone else lands on main');
  await r.git(r.repo, 'push', '-q', 'origin', 'HEAD:main');
  await r.git(r.wt.path, 'fetch', '-q', 'origin');
  await r.git(r.wt.path, 'rebase', '-q', 'refs/remotes/origin/main');
  assert.notEqual(await r.git(r.wt.path, 'rev-parse', 'HEAD'), r.wt.cleanupHead);
  await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead);
  assert.equal(fs.existsSync(r.wt.path), false);
  assert.equal(await r.branchExists(), false);
});

test('a branch with its own commits is refused with the commit list, and says which are pushed', async () => {
  const r = await gitRepo();
  await r.commit(r.wt.path, 'a.js', 'Pushed to its own branch');
  await r.git(r.wt.path, 'push', '-q', 'origin', 'job-api');
  await r.commit(r.wt.path, 'b.js', 'Only on this machine');
  const e = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e);
  assert.ok(e instanceof CleanupRefused);
  assert.match(e.message, /2 commits not on origin\/main/);
  assert.deepEqual(e.refusal.commits.map((c) => [c.subject, c.pushed]), [['Only on this machine', false], ['Pushed to its own branch', true]]);
  assert.deepEqual([e.refusal.commitCount, e.refusal.fileCount, e.refusal.base], [2, 0, 'main']);
  assert.equal(e.refusal.head, await r.git(r.wt.path, 'rev-parse', 'HEAD'));
  assert.ok(fs.existsSync(r.wt.path)); assert.ok(await r.branchExists());
});

test('a dirty tree at the verified head is refused with the file list, untracked files included', async () => {
  const r = await gitRepo();
  fs.writeFileSync(path.join(r.wt.path, 'README.md'), 'edited\n');
  fs.mkdirSync(path.join(r.wt.path, 'new dir'));
  fs.writeFileSync(path.join(r.wt.path, 'new dir', 'list models.js'), 'x\n');
  const e = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e);
  assert.ok(e instanceof CleanupRefused);
  assert.match(e.message, /2 uncommitted files/);
  assert.deepEqual(e.refusal.files, [{ change: 'modified', path: 'README.md' }, { change: 'untracked', path: 'new dir/list models.js' }]);
  assert.equal(e.refusal.commitCount, 0);
  assert.ok(fs.existsSync(r.wt.path));
});

test('untracked files alone are enough to refuse, even with no origin/HEAD to compare against', async () => {
  const r = await gitRepo();
  await r.git(r.repo, 'remote', 'set-head', 'origin', '--delete');
  await r.git(r.repo, 'remote', 'set-url', 'origin', path.join(DATA_DIR, 'no-such-origin'));
  fs.writeFileSync(path.join(r.wt.path, 'notes.txt'), 'x\n');
  const e = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e);
  assert.ok(e instanceof CleanupRefused);
  assert.deepEqual(e.refusal.files, [{ change: 'untracked', path: 'notes.txt' }]);
  assert.ok(fs.existsSync(r.wt.path));
});

test('Discard removes exactly the state it was shown, and refuses again once the worktree has moved on', async () => {
  const r = await gitRepo();
  await r.commit(r.wt.path, 'a.js', 'Local work');
  fs.writeFileSync(path.join(r.wt.path, 'scratch.txt'), 'x\n');
  const shown = (await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e)).refusal;
  await r.commit(r.wt.path, 'b.js', 'Committed after the human looked');
  const stale = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: shown }).catch((e) => e);
  assert.ok(stale instanceof CleanupRefused);
  assert.match(stale.message, /changed after you chose to discard/);
  assert.equal(stale.refusal.commitCount, 2);
  assert.ok(fs.existsSync(r.wt.path) && await r.branchExists(), 'nothing is deleted on a stale discard');
  fs.appendFileSync(path.join(r.wt.path, 'scratch.txt'), 'more\n');
  const edited = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: stale.refusal }).catch((e) => e);
  assert.ok(edited instanceof CleanupRefused, 'an edit to an already-dirty file changes the fingerprint');
  await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: edited.refusal });
  assert.equal(fs.existsSync(r.wt.path), false);
  assert.equal(await r.branchExists(), false);
});

test('Discard of a branch whose worktree is already gone deletes it only at the head shown', async () => {
  const r = await gitRepo();
  await r.commit(r.wt.path, 'a.js', 'Local work');
  await r.git(r.repo, 'worktree', 'remove', r.wt.path);
  const shown = (await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e)).refusal;
  assert.equal(shown.commitCount, 1);
  await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: shown });
  assert.equal(await r.branchExists(), false);
});

test('parseStatus reads porcelain v2: renames carry their old path as the next entry, and paths keep their spaces', () => {
  const out = ['1 .M N... 100644 100644 100644 aaa bbb src/app.js', '2 R. N... 100644 100644 100644 aaa bbb R100 new name.js', 'old name.js',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.js', '? notes/todo list.md', ''].join('\0');
  assert.deepEqual(parseStatus(out), [{ change: 'modified', path: 'src/app.js' }, { change: 'renamed', path: 'new name.js' },
    { change: 'conflicted', path: 'conflict.js' }, { change: 'untracked', path: 'notes/todo list.md' }]);
});

test('a Discard on a tree the human has since emptied of work just cleans it up, without asking again', async () => {
  const r = await gitRepo();
  fs.writeFileSync(path.join(r.wt.path, 'notes.txt'), 'x\n');
  const shown = (await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e)).refusal;
  fs.rmSync(path.join(r.wt.path, 'notes.txt'));
  await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: shown });
  assert.equal(fs.existsSync(r.wt.path), false);
});

test('a planning worktree\'s scratch files are not grounds to refuse: the job has no Discard for it', async () => {
  const r = await gitRepo();
  fs.writeFileSync(path.join(r.wt.path, 'plan-draft.md'), 'x\n');
  await r.runtime.cleanupPlanning({ runs: [], planningWorktrees: [r.wt] });
  assert.equal(fs.existsSync(r.wt.path), false);
  assert.equal(await r.branchExists(), false);
});
