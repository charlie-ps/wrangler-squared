import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JobRuntime, LAUNCH_GRACE_MS, CleanupRefused, parseStatus, queueFetches } from './job-runtime.js';
import { DATA_DIR } from './data-dir.js';
import { fakeHost } from './test-helpers.js';
import { runFile } from './job-github.js';
import { settingsSchema, jobInputSchema } from './jobs-schema.js';
import { resolutionsFor, resolvePrompt } from './job-main.js';

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
    if (args[0] === 'rev-parse' && args[1] === '--verify') return 'tracked';
    if (args[0] === 'log') return log;
    return '';
  };
  return { calls, run };
}

test('fetches into one checkout run one after another; other commands and checkouts do not wait', async () => {
  const log = [];
  const gates = new Map();
  const run = queueFetches((bin, args, cwd) => {
    const name = `${args[0]} ${args[1] || ''} ${cwd}`.replace('  ', ' ');
    log.push(`start ${name}`);
    return new Promise((resolve, reject) => gates.set(name, () => { log.push(`end ${name}`); (args[1] === 'bad' ? reject(new Error('cannot lock ref')) : resolve('')); }));
  });
  const open = (name) => { gates.get(name)(); gates.delete(name); };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const first = run('git', ['fetch', 'bad'], '/repo/a');
  const second = run('git', ['fetch', 'origin'], '/repo/a/');
  const other = run('git', ['fetch', 'origin'], '/repo/b');
  const status = run('git', ['status'], '/repo/a');
  await tick();
  assert.deepEqual(log.sort(), ['start fetch bad /repo/a', 'start fetch origin /repo/b', 'start status /repo/a']);
  log.length = 0;
  open('fetch bad /repo/a');
  await assert.rejects(first, /cannot lock ref/);
  await tick();
  assert.deepEqual(log, ['end fetch bad /repo/a', 'start fetch origin /repo/a/'], 'the second starts only once the first has ended, even after it failed');
  for (const name of [...gates.keys()]) open(name);
  await Promise.all([second, other, status]);
});

test('a runtime queues its own fetches: two launches into one repo never fetch at once', async () => {
  let inFlight = 0;
  let most = 0;
  const run = async (bin, args) => {
    if (bin === 'gh') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
    if (args[0] === 'fetch') {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
    }
    return 'base';
  };
  const spawned = [];
  const runtime = new JobRuntime({ host: { sessions: { spawn: async (o) => { spawned.push(o.worktree); return { sessionId: `s${spawned.length}` }; } } } }, run);
  const job = { id: 'job_1', agent: 'claude' };
  const launch = (id) => runtime.launch(job, { id, repo: '/repo/a' }, { phase: 'implementation' }, () => {});
  await Promise.all([launch('one'), launch('two')]);
  assert.equal(most, 1);
  assert.equal(spawned.length, 2);
});

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

test('a job saved with an archived Task still launches, into no Task', async () => {
  const { host, spawned, tasks } = fakeHost();
  tasks.push({ id: 't_archived', name: 'Old work', links: [], archivedAt: Date.now() });
  const runtime = runtimeWith(host, { run: async (bin, args) => bin === 'gh' ? JSON.stringify({ defaultBranchRef: { name: 'main' } }) : args[0] === 'rev-parse' ? 'basehead' : '' });
  await runtime.launch({ id: 'job_12345678', title: 'Sign-in', agent: 'claude', taskId: 't_archived' },
    { id: 'api', repo: '/repo' }, { id: 'run_1', phase: 'implementation' }, () => {});
  assert.equal(spawned.length, 1);
  assert.equal('taskId' in spawned[0], false);
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
    assert.deepEqual(prepared, ['s_1', undefined], 'Wrangler cut nothing, so there is no record to report');
    // And nothing git-shaped to undo afterwards: no worktree, no branch, no PR.
    await runtime.cleanup({}, { id: 'spike', kind: 'session', sessions: ['s_1'], pr: null, worktree: undefined }, { updateMain: true });
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
    const f = fakeRun({ log: `${head}\tLocal work`, overrides: { 'symbolic-ref': () => ref, 'rev-parse': (args, cwd) => args[1] === '--abbrev-ref' ? 'origin/main' : args[1] === '--verify' ? 'tracked' : args[1] === '--show-toplevel' ? cwd : head } });
    await assert.rejects(runtimeWith(host, { run: f.run }).cleanupWorktree(wt, 'verified'), ref.endsWith('/job-api') ? /would be lost/ : /changed since verification/);
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
  // Gone between the look and the push: the lease refuses it as stale, and a
  // second look that finds nothing makes that success too.
  let looks = 0;
  const raced = fakeRun({ head: 'head1', overrides: {
    'ls-remote': () => { if (looks++) throw Object.assign(new Error('exit 2'), { code: 2 }); return 'head1\trefs/heads/job-api'; },
    push: () => { throw new Error('(delete) -> job-api (stale info)'); } } });
  await runtimeWith(host, { run: raced.run }).cleanup({}, sub);
  assert.equal(looks, 2);
  // Still there after a refused push: that failure is real and stays on the card.
  const refused = fakeRun({ head: 'head1', remote: 'head1\trefs/heads/job-api', overrides: { push: () => { throw new Error('denied'); } } });
  await assert.rejects(runtimeWith(host, { run: refused.run }).cleanup({}, sub), /denied/);
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
  assert.ok(f.calls.some((c) => c[0] === 'fetch' && c.join(' ') === 'fetch origin head1'), 'the merged head is fetched by sha, as its branch may be auto-deleted');
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
  const tree = fakeRun({ log: 'local-extra\tExtra', overrides: { ...notAncestor, 'symbolic-ref': () => 'refs/heads/job-api', 'rev-parse': (args) => args[1] === '--abbrev-ref' ? 'origin/main' : args[1] === '--verify' ? 'tracked' : 'local-extra' } });
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
  await runtimeWith(host, { run: f.run }).cleanup({}, cancelled, { updateMain: true });
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

// The human's checkout and a PR landing on origin behind its back, in real git:
// the update reads status, logs and ancestry the fake cannot stand in for.
async function mainCheckout() {
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'main-checkout-'));
  const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());
  const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), other = path.join(dir, 'other');
  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await exec('git', ['clone', '-q', origin, repo]);
  const commit = async (cwd, file, message) => { fs.writeFileSync(path.join(cwd, file), `${message}\n`); await git(cwd, 'add', file); await git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message); };
  await commit(repo, 'README.md', 'Initial');
  await git(repo, 'push', '-q', 'origin', 'HEAD:main');
  await exec('git', ['clone', '-q', origin, other]);
  const land = async (message) => { await commit(other, `${message.replace(/\W+/g, '-')}.js`, message); await git(other, 'push', '-q', 'origin', 'HEAD:main'); };
  const sub = { id: 'api', repo, worktree: null, sessions: [], pr: { url: 'u', head: 'h', base: 'main' } };
  return { git, repo, commit, land, sub, head: (ref = 'main') => git(repo, 'rev-parse', ref), originHead: () => git(other, 'rev-parse', 'HEAD') };
}

test('updateMain on a clean checkout of main fast-forwards it quietly', async () => {
  const m = await mainCheckout();
  await m.land('Merged PR 1');
  const result = await runtimeWith(fakeHost().host).cleanup({}, m.sub, { updateMain: true });
  assert.deepEqual(result.main, { path: fs.realpathSync(m.repo), result: { ok: true } });
  assert.equal(await m.head(), await m.originHead());
});

test('with Keep local main updated off, cleanup leaves the checkout behind', async () => {
  const m = await mainCheckout();
  const before = await m.head();
  await m.land('Merged PR 1');
  assert.deepEqual(await runtimeWith(fakeHost().host).cleanup({}, m.sub, { updateMain: false }), {});
  assert.equal(await m.head(), before);
});

test('Keep local main updated is a global setting, on by default; a job carries none', () => {
  assert.equal(settingsSchema.parse({}).updateMain, true);
  assert.equal(settingsSchema.parse({ updateMain: false }).updateMain, false);
  assert.equal(jobInputSchema.parse({ intent: 'x', updateMain: false }).updateMain, undefined, 'a job saved with the old toggle carries nothing now');
});

test('a resolution prompt is the one fix, then the divergence as quoted data', () => {
  const n = { path: '/home/me/repo', base: 'main', reason: 'dirty', dirty: [{ path: 'a "b".js', change: 'modified' }], dirtyCount: 3, localOnly: [], localCount: 0, incoming: [{ sha: 'a'.repeat(40), subject: 'Merged PR 1' }], incomingCount: 1 };
  assert.deepEqual(resolutionsFor(n).map((r) => r.id), ['stash']);
  assert.deepEqual(resolutionsFor({ ...n, localCount: 1 }).map((r) => r.id), ['rebase', 'branch']);
  assert.deepEqual(resolutionsFor({ ...n, reason: 'failed', dirtyCount: 0 }), []);
  const p = resolvePrompt(n, 'stash');
  assert.match(p, /^Wrangler² could not fast-forward the local main branch in \/home\/me\/repo/);
  assert.match(p, /The human chose one fix: Stash & update\. Do exactly that/);
  assert.match(p, /git stash push --include-untracked/);
  assert.doesNotMatch(p, /git rebase/, 'only that resolution');
  assert.match(p, /Uncommitted files \(3\):\n {2}- "a \\"b\\".js" \(modified\)\n {2}- … and 2 more/);
  assert.match(p, /New on origin\/main \(1\):\n {2}- aaaaaaaaaaaa "Merged PR 1"/);
});

test('updateMain on a checkout on another branch moves main without touching the tree', async () => {
  const m = await mainCheckout();
  await m.git(m.repo, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(m.repo, 'scratch.txt'), 'mine\n');
  await m.land('Merged PR 1');
  const result = await runtimeWith(fakeHost().host).cleanup({}, m.sub, { updateMain: true });
  assert.deepEqual(result.main.result, { ok: true }, 'a dirty tree on another branch is no obstacle: fetch moves the ref alone');
  assert.equal(await m.head('main'), await m.originHead());
  assert.equal(await m.git(m.repo, 'branch', '--show-current'), 'feature');
  assert.equal(fs.readFileSync(path.join(m.repo, 'scratch.txt'), 'utf8'), 'mine\n');
});

test('updateMain on another branch with local-only commits on main leaves main and says why', async () => {
  const m = await mainCheckout();
  await m.commit(m.repo, 'local.js', 'Unpushed on main');
  const before = await m.head();
  await m.git(m.repo, 'checkout', '-q', '-b', 'feature');
  await m.land('Merged PR 1');
  const { result } = (await runtimeWith(fakeHost().host).cleanup({}, m.sub, { updateMain: true })).main;
  assert.equal(result.reason, 'diverged');
  assert.deepEqual(result.localOnly.map((c) => c.subject), ['Unpushed on main']);
  assert.deepEqual(result.incoming.map((c) => c.subject), ['Merged PR 1']);
  assert.equal(await m.head('main'), before);
});

test('updateMain on a dirty checkout of main leaves it, listing the files and origin\'s new commits', async () => {
  const m = await mainCheckout();
  fs.writeFileSync(path.join(m.repo, 'README.md'), 'edited\n');
  const before = await m.head();
  await m.land('Merged PR 1');
  const { path: where, result } = (await runtimeWith(fakeHost().host).cleanup({}, m.sub, { updateMain: true })).main;
  assert.equal(where, fs.realpathSync(m.repo));
  assert.equal(result.reason, 'dirty');
  assert.deepEqual(result.dirty, [{ change: 'modified', path: 'README.md' }]);
  assert.equal(result.dirtyCount, 1);
  assert.deepEqual(result.incoming.map((c) => c.subject), ['Merged PR 1']);
  assert.equal(await m.head(), before);
  assert.equal(fs.readFileSync(path.join(m.repo, 'README.md'), 'utf8'), 'edited\n');
});

test('updateMain never throws: an unresolvable checkout is a notice, not a red sub-job', async () => {
  const { host } = fakeHost();
  const result = await runtimeWith(host, { run: fakeRun().run }).cleanup({}, { ...merged, repo: missing(), worktree: null }, { updateMain: true });
  assert.equal(result.main.result.reason, 'failed');
  assert.match(result.main.result.error, /Cannot resolve the main checkout/);
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
  const m = await mainCheckout();
  await m.land('Merged PR 1');
  const before = await m.head();
  const sub = { ...m.sub, pr: { ...m.sub.pr, base: 'next' } };
  const away = await runtimeWith(fakeHost().host, { run: async (bin, args, cwd) => bin === 'gh' ? JSON.stringify({ defaultBranchRef: { name: 'main' } }) : runFile(bin, args, cwd) }).cleanup({ base: 'next' }, sub, { updateMain: true });
  assert.equal(away.main, null, 'no surprise fast-forward');
  assert.equal(await m.head(), before);
  const home = await runtimeWith(fakeHost().host, { run: async (bin, args, cwd) => bin === 'gh' ? JSON.stringify({ defaultBranchRef: { name: 'main' } }) : runFile(bin, args, cwd) }).cleanup({ base: 'main' }, m.sub, { updateMain: true });
  assert.deepEqual(home.main.result, { ok: true }, 'a base that IS the default still fast-forwards');
  assert.equal(await m.head(), await m.originHead());
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
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.js', '? notes/todo list.md', '1 .M S.M. 160000 160000 160000 aaa aaa vendor/lib', '? scratch/', ''].join('\0');
  assert.deepEqual(parseStatus(out), [{ change: 'modified', path: 'src/app.js' }, { change: 'renamed', path: 'new name.js' },
    { change: 'conflicted', path: 'conflict.js' }, { change: 'untracked', path: 'notes/todo list.md' },
    { change: 'submodule', path: 'vendor/lib' }, { change: 'nested repository', path: 'scratch/' }]);
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

const refusalOf = (r, opts) => r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, opts).then(() => assert.fail('expected a refusal'), (e) => { assert.ok(e instanceof CleanupRefused, e.message); return e.refusal; });

test('a detached-HEAD worktree is refused with its Discard, naming the cause and the path, even with nothing to lose', async () => {
  const r = await gitRepo();
  await r.git(r.wt.path, 'checkout', '-q', '--detach', 'HEAD');
  const e = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e);
  assert.ok(e instanceof CleanupRefused, e.message);
  assert.equal(e.message, `Worktree at ${r.wt.path} is on a detached HEAD, not on job-api; preserve it for review`);
  assert.deepEqual([e.refusal.cause, e.refusal.state, e.refusal.pinned, e.refusal.head, e.refusal.branchHead], ['detached', null, true, r.wt.cleanupHead, r.wt.cleanupHead]);
  assert.ok(fs.existsSync(r.wt.path) && await r.branchExists());
});

test('Discard on a detached tree removes it and the branch it left behind, at the heads shown', async () => {
  const r = await gitRepo();
  await r.commit(r.wt.path, 'a.js', 'On the branch');
  await r.git(r.wt.path, 'checkout', '-q', '--detach', r.wt.cleanupHead);
  await r.commit(r.wt.path, 'b.js', 'On the detached HEAD');
  const shown = await refusalOf(r);
  assert.deepEqual(shown.commits.map((c) => c.subject).sort(), ['On the branch', 'On the detached HEAD'], 'the branch ref\'s commits are listed too');
  await r.commit(r.wt.path, 'c.js', 'After the human looked');
  const stale = await refusalOf(r, { discard: shown });
  assert.equal(stale.commitCount, 3);
  assert.ok(fs.existsSync(r.wt.path) && await r.branchExists(), 'nothing is deleted on a stale discard');
  await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: stale });
  assert.equal(fs.existsSync(r.wt.path), false);
  assert.equal(await r.branchExists(), false);
});

test('a worktree left mid-rebase is refused with the rebase and its conflict shown, and Discard clears it', async () => {
  const r = await gitRepo();
  await r.commit(r.wt.path, 'README.md', 'Branch edit');
  await r.commit(r.repo, 'README.md', 'Main edit');
  await r.git(r.repo, 'push', '-q', 'origin', 'HEAD:main');
  await r.git(r.wt.path, 'fetch', '-q', 'origin');
  await assert.rejects(r.git(r.wt.path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', 'refs/remotes/origin/main'), /conflict/i);
  const e = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e);
  assert.ok(e instanceof CleanupRefused, e.message);
  assert.match(e.message, new RegExp(`^Worktree at ${r.wt.path} is on a detached HEAD with a rebase in progress, not on job-api \\(1 commit not on origin/main, 1 uncommitted file\\)`));
  assert.deepEqual([e.refusal.state, e.refusal.files], ['rebase', [{ change: 'conflicted', path: 'README.md' }]]);
  await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: e.refusal });
  assert.equal(fs.existsSync(r.wt.path), false);
  assert.equal(await r.branchExists(), false);
});

test('a worktree git cannot read is refused with git\'s reason and no Discard, and nothing is removed', async () => {
  const r = await gitRepo();
  fs.writeFileSync(path.join(r.wt.path, '.git'), 'gitdir: /nowhere\n');
  const e = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e);
  assert.ok(e instanceof CleanupRefused, e.message);
  assert.match(e.message, new RegExp(`^Worktree at ${r.wt.path} could not be read by git \\(fatal: .+\\); preserve it for review$`));
  assert.deepEqual([e.refusal.cause, e.refusal.pinned], ['unreadable', false]);
  await assert.rejects(r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: { head: null, fingerprint: undefined } }), CleanupRefused);
  assert.ok(fs.existsSync(path.join(r.wt.path, 'README.md')));
});

test('a worktree git cannot delete is kept with git\'s reason, and its Discard deletes the whole folder and branch', async () => {
  const r = await gitRepo();
  // An ignored directory git may delete but cannot: what a process still
  // writing there looks like to `git worktree remove`.
  fs.appendFileSync(path.join(r.repo, '.git', 'info', 'exclude'), 'locked/\n');
  const locked = path.join(r.wt.path, 'locked');
  fs.mkdirSync(locked); fs.writeFileSync(path.join(locked, 'out.log'), 'busy\n'); fs.chmodSync(locked, 0o555);
  try {
    const e = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e);
    assert.ok(e instanceof CleanupRefused, e.message);
    assert.match(e.message, new RegExp(`^Worktree at ${r.wt.path} could not be removed \\(error: failed to delete .+\\); preserve it for review$`));
    assert.deepEqual([e.refusal.cause, e.refusal.pinned, e.refusal.path, e.refusal.branch, e.refusal.head], ['unremovable', true, r.wt.path, 'job-api', r.wt.cleanupHead]);
    assert.match(e.refusal.error, /^error: failed to delete/);
    assert.ok(await r.branchExists(), 'the branch is kept with the tree');
    // Git had already dropped its own record of the tree, so a Retry finds the
    // same leftover, with the same pin.
    const again = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e);
    assert.deepEqual([again.refusal?.cause, again.refusal?.fingerprint], ['unremovable', e.refusal.fingerprint], again.message);
    assert.ok(fs.existsSync(path.join(locked, 'out.log')), 'nothing is deleted unasked');
  } finally { fs.chmodSync(locked, 0o755); }
  const e = await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead).catch((e) => e);
  await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: { head: e.refusal.head, fingerprint: e.refusal.fingerprint, cause: 'unremovable' } });
  assert.equal(fs.existsSync(r.wt.path), false);
  assert.equal(await r.branchExists(), false);
});

test('a half-deleted worktree inside its parent checkout is the same refusal on Retry, and its Discard spares the parent', async () => {
  const r = await gitRepo();
  await r.git(r.repo, 'worktree', 'remove', r.wt.path);
  const inside = path.join(r.repo, 'worktrees.noindex', 'job-api');
  await r.git(r.repo, 'worktree', 'add', '-q', inside, 'job-api');
  await r.git(r.repo, 'checkout', '-q', '-b', 'elsewhere');
  await r.commit(inside, 'wip.js', 'Unpushed work');
  // What a failed delete leaves: its .git file gone, some of its files not.
  fs.rmSync(path.join(inside, '.git'));
  const wt = { ...r.wt, path: inside };
  const e = await r.runtime.cleanupWorktree(wt, wt.cleanupHead).catch((e) => e);
  assert.ok(e instanceof CleanupRefused, e.message);
  assert.match(e.message, /could not be removed \(no longer its own worktree: git reads it as .+\/repo\); preserve it for review$/);
  assert.deepEqual([e.refusal.cause, e.refusal.pinned, e.refusal.path, e.refusal.commitCount, e.refusal.commits[0].subject], ['unremovable', true, inside, 1, 'Unpushed work']);
  await assert.rejects(r.runtime.cleanupWorktree(wt, wt.cleanupHead, { discard: { head: e.refusal.head, fingerprint: 'stale', cause: 'unremovable' } }), /changed after you chose to discard/);
  assert.ok(fs.existsSync(path.join(inside, 'README.md')), 'a stale Discard deletes nothing');
  assert.ok(await r.branchExists());
  await r.runtime.cleanupWorktree(wt, wt.cleanupHead, { discard: { head: e.refusal.head, fingerprint: e.refusal.fingerprint, cause: 'unremovable' } });
  assert.equal(fs.existsSync(inside), false);
  assert.equal(await r.branchExists(), false);
  assert.equal(await r.git(r.repo, 'worktree', 'list', '--porcelain').then((t) => t.includes(inside)), false, 'git\'s record is pruned');
  assert.equal(await r.git(r.repo, 'symbolic-ref', '--short', 'HEAD'), 'elsewhere');
  assert.ok(fs.existsSync(path.join(r.repo, 'README.md')), 'the parent checkout is untouched');
});

test('a leftover Discard never deletes the folder holding the repository', async () => {
  const r = await gitRepo();
  const e = await r.runtime.cleanupWorktree({ ...r.wt, path: path.dirname(r.repo) }, r.wt.cleanupHead).catch((e) => e);
  assert.equal(e.refusal?.cause, 'unremovable', e.message);
  await assert.rejects(r.runtime.cleanupWorktree({ ...r.wt, path: path.dirname(r.repo) }, r.wt.cleanupHead, { discard: { head: e.refusal.head, fingerprint: e.refusal.fingerprint, cause: 'unremovable' } }), /holds the repository itself/);
  assert.ok(fs.existsSync(path.join(r.repo, 'README.md')));
});

test('a Discard does not cover a change only to what is staged', async () => {
  const r = await gitRepo();
  fs.writeFileSync(path.join(r.wt.path, 'README.md'), 'edited\n');
  const shown = await refusalOf(r);
  const staged = path.join(DATA_DIR, `staged-${++paths}`);
  fs.writeFileSync(staged, 'staged later\n');
  const blob = await r.git(r.wt.path, 'hash-object', '-w', staged);
  const before = fs.statSync(path.join(r.wt.path, 'README.md'));
  await r.git(r.wt.path, 'update-index', '--cacheinfo', `100644,${blob},README.md`);
  assert.equal(fs.statSync(path.join(r.wt.path, 'README.md')).mtimeMs, before.mtimeMs, 'the working file is untouched');
  const again = await refusalOf(r, { discard: shown });
  assert.notEqual(again.fingerprint, shown.fingerprint);
  assert.ok(fs.existsSync(r.wt.path));
});

test('a Discard does not cover an edit inside a nested repository the parent sees as one entry', async () => {
  const r = await gitRepo();
  const nested = path.join(r.wt.path, 'scratch');
  await exec('git', ['init', '-q', nested]);
  fs.writeFileSync(path.join(nested, 'child.txt'), 'one\n');
  const shown = await refusalOf(r);
  assert.deepEqual(shown.files, [{ change: 'nested repository', path: 'scratch/' }]);
  fs.writeFileSync(path.join(nested, 'child.txt'), 'two\n');
  fs.utimesSync(path.join(nested, 'child.txt'), new Date(), new Date(Date.now() + 5000));
  const again = await refusalOf(r, { discard: shown });
  assert.notEqual(again.fingerprint, shown.fingerprint);
  assert.ok(fs.existsSync(path.join(nested, 'child.txt')));
});

test('without a fresh fetch, an empty commit list is not taken as nothing to lose', async () => {
  const r = await gitRepo();
  await r.commit(r.wt.path, 'a.js', 'Landed on main, then force-reset away');
  await r.git(r.wt.path, 'push', '-q', 'origin', 'HEAD:main');
  await r.git(r.repo, 'fetch', '-q', 'origin');
  await r.git(r.repo, 'remote', 'set-url', 'origin', path.join(DATA_DIR, 'unreachable-origin'));
  const shown = await refusalOf(r);
  assert.deepEqual([shown.stale, shown.commitCount, shown.fileCount], [true, 0, 0]);
  await r.runtime.cleanupWorktree(r.wt, r.wt.cleanupHead, { discard: shown });
  assert.equal(fs.existsSync(r.wt.path), false, 'the human may still Discard it');
});

test('cleanup without a Discard leaves the tree if a file appears between the inspection and the delete', async () => {
  const r = await gitRepo();
  const real = runFile;
  const runtime = runtimeWith(fakeHost().host, { run: async (bin, args, cwd) => {
    const out = await real(bin, args, cwd);
    if (args[0] === 'status') fs.writeFileSync(path.join(r.wt.path, 'UNSEEN.txt'), 'late\n');
    return out;
  } });
  await assert.rejects(runtime.cleanupWorktree(r.wt, r.wt.cleanupHead), /modified or untracked files/);
  assert.ok(fs.existsSync(path.join(r.wt.path, 'UNSEEN.txt')));
});

test('a worktree too large to pin offers no Discard', async () => {
  const r = await gitRepo();
  const nested = path.join(r.wt.path, 'vendor');
  await exec('git', ['init', '-q', nested]);
  for (let i = 0; i < 20001; i++) fs.writeFileSync(path.join(nested, `f${i}`), '');
  const shown = await refusalOf(r);
  assert.equal(shown.pinned, false);
  await refusalOf(r, { discard: shown });
  assert.ok(fs.existsSync(nested));
});

test('a Discard does not cover different bytes behind the same size and mtime', async () => {
  const r = await gitRepo();
  const file = path.join(r.wt.path, 'README.md');
  fs.writeFileSync(file, 'shown1\n');
  const { mtime } = fs.statSync(file);
  const shown = await refusalOf(r);
  fs.writeFileSync(file, 'UNSEEN\n'); fs.utimesSync(file, mtime, mtime);
  const again = await refusalOf(r, { discard: shown });
  assert.notEqual(again.fingerprint, shown.fingerprint);
  assert.equal(fs.readFileSync(file, 'utf8'), 'UNSEEN\n');
});

test('a Discard does not cover commits that origin dropped after the human looked', async () => {
  const r = await gitRepo();
  await r.commit(r.wt.path, 'b.js', 'B: on main when shown');
  await r.git(r.wt.path, 'push', '-q', 'origin', 'HEAD:main');
  await r.commit(r.wt.path, 'c.js', 'C: local only');
  const shown = await refusalOf(r);
  assert.deepEqual(shown.commits.map((c) => c.subject), ['C: local only']);
  await r.git(r.repo, 'push', '-q', '--force', 'origin', `${r.wt.cleanupHead}:main`);
  const again = await refusalOf(r, { discard: shown });
  assert.deepEqual(again.commits.map((c) => c.subject), ['C: local only', 'B: on main when shown']);
  assert.ok(await r.branchExists());
});

test('a default branch origin has deleted is not trusted from its cached tracking ref', async () => {
  const r = await gitRepo();
  await r.commit(r.wt.path, 'b.js', 'B');
  await r.git(r.wt.path, 'push', '-q', 'origin', 'HEAD:main');
  await r.git(r.repo, 'fetch', '-q', 'origin');
  const origin = path.join(path.dirname(r.repo), 'origin.git');
  await r.git(origin, 'branch', 'trunk', r.wt.cleanupHead);
  await r.git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
  await r.git(origin, 'branch', '-D', 'main');
  const shown = await refusalOf(r);
  assert.equal(shown.base, 'trunk', 'origin\'s live HEAD, not the cached origin/HEAD');
  assert.deepEqual(shown.commits.map((c) => c.subject), ['B']);
  assert.ok(fs.existsSync(r.wt.path));
});

test('a worktree holding a dirty submodule cannot be pinned, so it offers no Discard', async () => {
  const r = await gitRepo();
  const lib = path.join(path.dirname(r.repo), 'lib');
  await exec('git', ['init', '-q', '-b', 'main', lib]);
  await r.commit(lib, 'file', 'lib');
  await r.git(r.wt.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
  fs.writeFileSync(path.join(r.wt.path, 'lib', 'file'), 'dirty\n');
  const shown = await refusalOf(r);
  assert.ok(shown.files.some((f) => f.change === 'submodule' && f.path === 'lib'));
  assert.equal(shown.pinned, false);
  await refusalOf(r, { discard: shown });
  assert.ok(fs.existsSync(path.join(r.wt.path, 'lib', 'file')));
});

test('a dropped sub-job of a job that lands on another branch is compared against that branch, not the default', async () => {
  const { host } = fakeHost();
  const sub = { ...merged, cancelledAt: 1, pr: null, worktree: { ...merged.worktree, path: missing() } };
  const f = fakeRun({ head: 'rebased', log: 'rebased\tOnly on this machine' });
  await assert.rejects(runtimeWith(host, { run: f.run }).cleanup({ base: 'next' }, sub), /1 commit not on origin\/next/);
  assert.ok(f.calls.some((c) => c[0] === 'log' && c.includes('refs/remotes/origin/next')));
  assert.ok(!f.calls.some((c) => c[0] === 'ls-remote'), 'the job\'s base is known, so origin\'s default is not asked for');
});

test('a PR\'s own base wins over the job\'s when its worktree is cut', async () => {
  const { host, spawned } = fakeHost();
  const run = async () => 'abc';
  await runtimeWith(host, { run }).launch({ id: 'job_12345678', title: 'x', agent: 'claude', base: 'next' }, { id: 'api', repo: '/repo', base: 'release/2.x' }, { id: 'run_1', phase: 'implementation' }, () => {});
  assert.equal(spawned[0].worktree.base, 'refs/remotes/origin/release/2.x');
  const missing = async (bin, args) => { if (args[0] === 'rev-parse') throw new Error('fatal'); return ''; };
  await assert.rejects(runtimeWith(fakeHost().host, { run: missing }).launch({ id: 'job_12345678', title: 'x', agent: 'claude' }, { id: 'api', repo: '/repo', base: 'release/2.x' }, { id: 'run_1', phase: 'implementation' }, () => {}), /"release\/2\.x" does not exist on origin; push it or change this PR's/);
});
