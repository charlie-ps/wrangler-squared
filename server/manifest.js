import { fileURLToPath } from 'node:url';
import { JobStore } from './job-store.js';
import { withJobSpend, withRunStatus } from './job-spend.js';
import { TOOLS, hideTool } from './tools.js';
import { withSpendLimit } from './job-budget.js';
import { withHeld } from './job-red.js';
import { HANDLERS } from './handlers.js';
import { runnerFor, spendFor, noteGraph, isAutomated, runForSession } from './jobs.js';

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

// Per-launch Codex autonomy (host API 1.12, loader createCodexPolicyResolver),
// asked at dispatch (after onBeforeDispatch, so the run is bound), resume and
// fork. Only a job step answers, from its job's saved `sandbox`; a job stored
// before the field keeps core's default lock. `undefined` is core's
// `--sandbox workspace-write --ask-for-approval never`. The answering
// extension's façade arrives as `ext`, not `host`.
export const CODEX_POLICY = { locked: undefined, auto: { approveForMe: true }, full: { bypass: true } };
function codexPolicy({ sessionId, ext }) {
  const owner = runForSession(ext.stores.jobs, sessionId);
  return owner ? CODEX_POLICY[owner.job.sandbox ?? 'locked'] : undefined;
}

export default {
  id: 'jobs',
  label: 'Wrangler²',
  description: 'Plan a goal into PRs (under Jira stories where the work has tickets), run each step as its own bounded agent session in a dedicated worktree, and gate the risky moments (plan, code, merge) on a human.',
  help: 'Adds the Jobs view, the job_report and get_job_context tools for job steps, a create_job tool that lets any other agent session start a job, and the job-worker skill. Jobs and their history stay in jobs.json across toggles.',
  author: 'Charlie Goldstraw',
  homepage: 'https://github.com/charlie-ps/wrangler-squared',
  defaultEnabled: true,
  dir,
  // `sessions:wake` and `mail:send` resume a session parked on its drafts once
  // the human has decided them (job-runtime.js resumeWithMail);
  // `sessions:interrupt` stops a job's sessions at its spend limit (job-budget.js).
  requires: [
    'sessions:read', 'sessions:spawn', 'sessions:archive', 'sessions:bill', 'sessions:wake', 'sessions:interrupt',
    'mail:send',
    'usage:read', 'board:rebuild', 'board:broadcast', 'images:keep', 'files:view',
  ],
  engines: { wranglerApi: '^1.42.0' },
  // Early builds an install may opt into (host API 1.39) from the hidden
  // switch in public/early-adopter.js; mirrored in package.json so it is consented to.
  earlyAdopter: { branch: 'next' },

  // Instantiated once by the wrangler with `{ id, log }`; the file path is the
  // extension's own choice (server/data-dir.js).
  stores: { jobs: () => new JobStore() },

  tools: TOOLS,
  handlers: HANDLERS,
  skills: ['job-worker'],
  skillsFor,
  codexPolicy,
  hideTool,

  // Every ~4s graph tick. `graph.sessions` is what carries each live run's card
  // status onto the run (withRunStatus) and what the runner's `statusOf` reads;
  // `jobs` is not a reserved key. The price is whatever map the last 60s spend
  // refresh produced (job-spend-refresh.js) with each live card's own price off
  // this graph folded in — `byCard` kicks the next refresh but is never awaited
  // here, so the usage scan can never stall a rebuild.
  graph: ({ host, graph }) => {
    noteGraph(graph);
    const spend = spendFor(host);
    spend.noteLive(graph.sessions);
    const snapshot = host.stores.jobs.data;
    return { jobs: withRunStatus(withHeld(withSpendLimit(withJobSpend(snapshot, spend.current(snapshot.jobs)))), graph.sessions) };
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
