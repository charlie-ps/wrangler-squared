import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import manifest from './manifest.js';
import { JobStore } from './job-store.js';
import { placeholderBranch } from './job-prompts.js';
import { _resetForTests, runnerFor } from './jobs.js';
import { fakeHost } from './test-helpers.js';

// What agent-wrangler's jobs-integration.test.js (`job-system` branch) did,
// minus the transport: it stood up the wrangler's own HTTP/WS/MCP stack to prove the job
// system worked through the wire it was registered on. An extension registers
// nothing — the wrangler serves /mcp and the control socket and routes a frame
// here by the name in THIS manifest — so the equivalent end-to-end is the
// manifest's own entries (tools, handlers, sweeps, hooks, graph) driven in the
// order a live board drives them, and the loader agreeing that those entries are
// well-formed (the AW_REPO test below, and scripts/validate-manifest.mjs).
const entry = (list, key, value) => list.find((e) => e[key] === value);
const tool = (name) => entry(manifest.tools, 'name', name);
const handler = (type) => entry(manifest.handlers, 'type', type);
const sweep = entry(manifest.sweeps, 'id', 'tick');

// Every handler kicks the runner without awaiting it (the board must not wait on
// a launch), so a test that asserts on what a kick did has to join it first.
function trackTicks(host) {
  const runner = runnerFor(host);
  const real = runner.tick.bind(runner);
  const inflight = [];
  runner.tick = () => { const p = real(); inflight.push(p); return p; };
  const settle = async () => { while (inflight.length) await inflight.shift(); };
  return { settle, tick: async () => { await settle(); await sweep.run({ host }); await settle(); } };
}

test('a job runs from the create frame to a launched PR step through the manifest alone', async () => {
  _resetForTests();
  const { host, spawned, broadcasts, sessions } = fakeHost();
  const { settle, tick } = trackTicks(host);
  runnerFor(host).runtime.run = async (bin, args) => {
    if (bin === 'gh') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
    return args[0] === 'rev-parse' ? 'basehead' : '';
  };

  await handler('job-create').handler({ job: { title: 'Sign-in', intent: 'Reliable sign-in' }, start: true }, host);
  const [{ jobId }] = broadcasts;
  assert.deepEqual(broadcasts, [{ event: 'job-created', jobId, started: true }]);
  assert.deepEqual(host.stores.jobs.get(jobId).repos, [], 'a job with no repository hints discovers them');
  await settle();
  const planning = host.stores.jobs.get(jobId).runs[0];
  assert.deepEqual([spawned.length, planning.phase, planning.sessionId], [1, 'planning', spawned[0].sessionId]);

  // The receipt: caller-bound, as the wrangler's /mcp route hands the tool the
  // calling card's id. Core's own test spent its HTTP work on the Origin and
  // wrong-caller refusals; the first is the wrangler's now, the second is here.
  const plan = { context: 'The sign-in service is Java; deploys are Helm.',
    stories: [{ id: 's', key: 'AUTH-1', title: 'Reliable sign-in' }],
    subJobs: [{ id: 'api', title: 'Fix sign-in', kind: 'pr', repo: '/repo', storyId: 's', after: [], brief: 'Implement and verify sign-in' }] };
  const report = { runId: planning.id, report: { kind: 'plan', plan } };
  assert.equal((await tool('job_report').handler({ host, caller: 'someone-else' }, report)).isError, true);
  assert.equal((await tool('job_report').handler({ host, caller: planning.sessionId }, report)).structuredContent.accepted, true);

  await tick();
  assert.equal(spawned.length, 1, 'a reported plan must not silently approve itself');
  const reviewing = host.stores.jobs.get(jobId);
  assert.deepEqual(reviewing.repos, ['/repo'], 'the discovered repository is the job\'s before a human sees the plan');

  await handler('job-action').handler({ id: jobId, action: 'approve-plan', revision: reviewing.revision }, host);
  assert.deepEqual(broadcasts.at(-1), { event: 'job-action-complete', jobId, action: 'approve-plan' });
  await settle();
  assert.equal(host.stores.jobs.get(jobId).stage, 'active');
  assert.equal(spawned.length, 2, 'approval is what launches the implementation');
  const branch = placeholderBranch({ id: jobId }, { id: 'api' });
  assert.deepEqual(spawned[1].worktree, { branch, base: 'refs/remotes/origin/main', auto: true });
  const [sub] = host.stores.jobs.get(jobId).subJobs;
  assert.equal(sub.jiraKey, 'AUTH-1');
  assert.deepEqual(sub.worktree, { branch, path: `/repo-worktree-${branch}`, repoRoot: '/repo', cleanupHead: 'basehead' },
    'the record the wrangler settled on, through onBeforeDispatch, plus the base commit only this extension knows');

  // The board's own two per-caller questions, on the step that is actually
  // running: the answers are what stop a job worker spawning more work.
  const caller = host.stores.jobs.get(jobId).runs.at(-1).sessionId;
  assert.deepEqual([manifest.hideTool({ caller, tool: 'spawn_session', host }), manifest.hideTool({ caller: 'a-human\'s-session', tool: 'spawn_session', host })], [true, false]);
  assert.deepEqual(manifest.skillsFor({ sessionId: caller, skills: ['job-worker'], host }), ['job-worker']);
  assert.deepEqual(manifest.skillsFor({ sessionId: 'a-human\'s-session', skills: ['job-worker'], host }), []);

  const contributed = manifest.graph({ host, graph: { sessions: [{ sessionId: caller, status: 'working' }] } });
  assert.deepEqual(Object.keys(contributed), ['jobs']);
  assert.equal(contributed.jobs.jobs[0].runs.at(-1).status, 'working');
  // The two sweeps are a loop: the graph contributor is the only thing that
  // tells the tick its worker is alive (jobs.js statusOf), so a step survives
  // the next tick exactly as long as the board keeps reporting it.
  await tick();
  assert.equal(host.stores.jobs.get(jobId).runs.at(-1).stopped, false);
  assert.equal(new JobStore(host.stores.jobs.file).get(jobId).subJobs[0].jiraKey, 'AUTH-1', 'the store outlives the process that wrote it');
  assert.equal(sessions.get(caller).worktree.branch, branch);
});

test('the wrangler\'s own loader accepts this manifest', async (t) => {
  const repo = process.env.AW_REPO && path.resolve(process.env.AW_REPO.replace(/^~/, os.homedir()));
  const loader = repo && path.join(repo, 'server/extensions/index.js');
  if (!loader || !fs.existsSync(loader)) {
    return t.skip('set AW_REPO to an agent-wrangler checkout to run the real loader (scripts/validate-manifest.mjs does the whole boot)');
  }
  // Imported dynamically, and only here: the loader is a leaf the import scanner
  // does not forbid, but a static import would put agent-wrangler in this
  // extension's graph on every run, including the runs that have no checkout.
  const { validateManifest, CAPABILITIES, RESERVED_GRAPH_KEYS, SESSION_HOOKS } = await import(pathToFileURL(loader).href);
  validateManifest(manifest);
  for (const c of manifest.requires) assert.ok(CAPABILITIES.has(c), `unknown capability ${c}`);
  for (const k of Object.keys(manifest.session)) assert.ok(SESSION_HOOKS.includes(k), `unknown session hook ${k}`);
  assert.ok(!RESERVED_GRAPH_KEYS.has('jobs'), 'the graph key this extension contributes under is its own');
});
