import { test } from 'node:test';
import assert from 'node:assert/strict';
import manifest from './manifest.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from './job-store.js';
import { _resetForTests, runnerFor, statusOf } from './jobs.js';

// The fake-host pattern every ported suite should use (docs/PORTING.md, Tests):
// a JobStore on its own temp file (the manifest's factory would share one
// jobs.json across every test in the process), plus the façade keys the manifest
// declares in `requires` — and nothing else, so a test fails the moment code
// reaches for a capability the manifest did not ask for.
function fakeHost() {
  const spawned = [];
  const broadcasts = [];
  const archived = [];
  const sessions = new Map();
  const host = {
    id: 'jobs', version: '1.0.0', log: () => {},
    stores: { jobs: new JobStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsq-')), 'jobs.json')) },
    rebuild: async () => { host.rebuilds++; },
    rebuilds: 0,
    broadcast: (p) => broadcasts.push(p),
    sessions: {
      spawn: async (opts) => {
        const sessionId = `s_${spawned.length + 1}`;
        spawned.push({ sessionId, ...opts });
        sessions.set(sessionId, { sessionId, archived: false });
        // What the wrangler does inside dispatch(): fire onBeforeDispatch with the settled id.
        manifest.session.onBeforeDispatch({ sessionId, cwd: opts.cwd, host });
        return { sessionId };
      },
      get: (id) => sessions.get(id) ?? null,
      archive: async (id) => { archived.push(id); const s = sessions.get(id); if (s) s.archived = true; },
      wake: async () => {},
    },
    tasks: { assign: () => {} },
  };
  return { host, spawned, broadcasts, archived };
}

const tool = (name) => manifest.tools.find((t) => t.name === name);
const handler = (type) => manifest.handlers.find((h) => h.type === type);
const newJob = { title: 'Ship it', intent: 'Make the thing work end to end.' };

test('the manifest declares what package.json disclosed, and only known hook names', async () => {
  const { readFileSync } = await import('node:fs');
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).wranglerExtension;
  assert.equal(manifest.id, declared.id);
  for (const c of manifest.requires) assert.ok(declared.requires.includes(c), `${c} is not disclosed in package.json`);
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
  assert.equal(out.jobs.jobs[0].usd, null, 'no spend until the host exposes the usage scan');
});
