import { fileURLToPath } from 'node:url';
import { JobStore } from './job-store.js';
import { withJobSpend, withRunStatus } from './job-spend.js';
import { TOOLS, hideTool } from './tools.js';
import { HANDLERS } from './handlers.js';
import { runnerFor, spendFor, noteGraph, isAutomated } from './jobs.js';

// The extension manifest (agent-wrangler docs/superpowers/specs/
// 2026-09-11-extensions-api-design.md, "Manifest"). The repo root's index.js
// re-exports this: an installed extension's `index.js` must default-export the
// manifest, but the wrangler's leaf-import scanner quarantines any own file whose
// import line matches `from '../index.js'` (external.js FORBIDDEN_IMPORTS), so a
// test may only ever import THIS module, never the root.
//
// `dir` is the repo root because `client`/`styles` must resolve inside
// `<dir>/public/`; for an installed copy discovery overwrites it with the real
// location anyway.
export const dir = fileURLToPath(new URL('..', import.meta.url));

// Per-launch skill gate (loader createSkillGate): the job-worker protocol is
// ~1k tokens that only make sense to a session holding job_report, so it is
// kept for a job step and dropped for every ordinary launch — what core's
// `automation` boolean threaded through both agent adapters. Runs AFTER
// onBeforeDispatch by design, so at `phase: 'dispatch'` the run is already bound
// and `sessionId` answers. Returning the full list keeps; `[]` suppresses.
function skillsFor({ sessionId, skills, host }) {
  return isAutomated(host.stores.jobs, sessionId) ? skills : [];
}

export default {
  id: 'jobs',
  label: 'Automated jobs (Wrangler²)',
  description: 'Plan a goal into PRs (under Jira stories where the work has tickets), run each step as its own bounded agent session in a dedicated worktree, and gate the risky moments (plan, code, merge) on a human.',
  help: 'Adds the Jobs view, the job_report and get_job_context tools and the job-worker skill. Jobs and their history stay in jobs.json across toggles.',
  author: 'Charlie Goldstraw',
  homepage: 'https://github.com/charlie-ps/wrangler-squared',
  defaultEnabled: true,
  dir,
  requires: [
    'sessions:read', 'sessions:spawn', 'sessions:archive', 'sessions:bill',
    'usage:read', 'board:rebuild', 'board:broadcast',
  ],
  engines: { wranglerApi: '^1.8.0' },

  // Instantiated once by the wrangler with `{ id, log }`; the file path is the
  // extension's own choice (server/data-dir.js).
  stores: { jobs: () => new JobStore() },

  tools: TOOLS,
  handlers: HANDLERS,
  skills: ['job-worker'],
  skillsFor,
  hideTool,

  // Every ~4s graph tick. `graph.sessions` is what carries each live run's card
  // status onto the run (withRunStatus) and what the runner's `statusOf` reads;
  // `jobs` is not a reserved key. The price is whatever map the last 60s spend
  // refresh produced (job-spend-refresh.js) — `byCard` kicks the next one but is
  // never awaited here, so the usage scan can never stall a rebuild.
  graph: ({ host, graph }) => {
    noteGraph(graph);
    const snapshot = host.stores.jobs.snapshot();
    return { jobs: withRunStatus(withJobSpend(snapshot, spendFor(host).byCard(snapshot.jobs)), graph.sessions) };
  },

  session: {
    // Fires inside spawn() with the card id settled, the worktree already cut and
    // no pane started — the one window in which the run can be bound (and its
    // worktree recorded) before the agent's first job_report.
    onBeforeDispatch: ({ sessionId, worktree, host }) => { runnerFor(host).runtime.noteDispatch({ sessionId, worktree }); },
  },

  // The runner owns its own re-entry guard (`busy`) and only rebuilds after a
  // state change, so a 4s cadence is free when nothing moves.
  sweeps: [{ id: 'tick', everyMs: 4000, run: ({ host }) => runnerFor(host).tick() }],

  client: 'public/index.js',
  styles: 'public/jobs.css',
};
