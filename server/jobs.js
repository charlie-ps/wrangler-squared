import { JobRunner } from './job-runner.js';
import { JobRuntime } from './job-runtime.js';
import { JobGithub } from './job-github.js';

// Composition root for the extension's server half — what agent-wrangler's
// server/index.js did for the in-core job system (construct JobStore, JobRuntime,
// JobGithub and JobRunner, wire `statusOf` off the last graph, tick every 4s).
//
// The store is NOT built here: the manifest's `stores.jobs` factory is, and the
// wrangler instantiates it once and hands it back as `host.stores.jobs`. The
// runner IS built here, lazily, because it needs the façade (for the runtime) and
// a store factory is called with only `{ id, log }` before any façade exists.
// One runner per process: every tool, handler and sweep is handed the same
// façade object for this extension, so the first caller builds it and the rest
// reuse it.
let runner = null;
export function runnerFor(host) {
  if (!runner) {
    const runtime = new JobRuntime({ host, statusOf });
    runner = new JobRunner({
      store: host.stores.jobs,
      runtime,
      github: new JobGithub(),
      onChange: () => host.rebuild(),
      statusOf,
    });
    runner.runtime = runtime;
  }
  return runner;
}

// The card status of every session as of the last graph the contributor saw
// (server/manifest.js `graph`). Core's runner read `lastGraph.sessions` directly;
// the projection `host.sessions.get()` carries no status, so this cache is the
// only source of "is this worker idle / needs-you" the runner has.
// TODO(host-api sessions:read status): drop once the projection carries it.
const lastStatus = new Map();
export function noteGraph(graph) {
  lastStatus.clear();
  for (const s of graph?.sessions || []) lastStatus.set(s.sessionId, s.status ?? null);
}
export const statusOf = (sessionId) => lastStatus.get(sessionId) ?? null;

// Whether a session is (or ever was) a job step. Core stamped `automationRun` on
// the entry at dispatch and every consumer read it back; the extension keeps
// that fact in its own store instead — every run records the card it bound —
// which is what the per-caller tool filter and the per-launch skill gate key on.
export function runForSession(store, sessionId) {
  if (!sessionId) return null;
  for (const job of store.data.jobs) {
    const run = job.runs.findLast((r) => r.sessionId === sessionId);
    if (run) return { job, run };
  }
  return null;
}
export const isAutomated = (store, sessionId) => Boolean(runForSession(store, sessionId));

// Test seam.
export function _resetForTests() { runner = null; lastStatus.clear(); }
