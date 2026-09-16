import { z } from 'zod';
import { reportSchema } from './jobs-schema.js';
import { runnerFor, runForSession } from './jobs.js';
import { renameBranch } from './git.js';

// MCP tools in the EXTENSION signature: `handler({ host, caller }, args)` — no
// `deps` (agent-wrangler docs/superpowers/specs/2026-09-11-extensions-api-design.md,
// "Extension tool and handler signatures"). Core's job-report.js reached
// `deps.jobStore` and `deps.rebuild`; here those are `host.stores.jobs` and
// `host.rebuild()`. Registered on the server AND granted in the launch argv by the
// loader from this one list — the two-place rule is derived for extension tools.
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

export const jobReportTool = {
  name: 'job_report',
  description: 'Submit the receipt for your assigned automated job run, then stop. One receipt per run: plan, jira, ready (the working tree awaits the human\'s code review, nothing committed), published (the PR url), repaired, deployed or completed. Checks are normally 1–3 bullets of a few words, e.g. "Build passed"; keep the detail in the transcript. Only the assigned session can report; identical retries are safe, and a terminal recap does not advance the job. If you cannot finish, submit {kind:"blocked", summary:"one sentence"} and optionally name the move a human should make: move:"fix-here" (a new commit on this PR), "split-out" (a second PR on this ticket), "new-ticket" (scope nobody knew about), "reorder" (this must land after something else), "drop", "mark" (it is already done elsewhere) or "accept-red" (the failing check or post-merge run is noise; merge or count it as landed anyway). You never change the plan yourself; the human clicks the move.',
  inputSchema: { runId: z.string(), report: reportSchema },
  async handler({ host, caller }, { runId, report }) {
    try {
      const job = host.stores.jobs.report(caller, runId, report);
      await host.rebuild();
      return result({ accepted: true, jobId: job.id, next: 'Stop now. Wrangler coordinates the next step.' });
    } catch (e) { return errorResult(e.message); }
  },
};

export const getJobContextTool = {
  name: 'get_job_context',
  description: 'Get the current automated job, approved plan and run assigned to your own session. No other session or job can be selected.',
  inputSchema: {},
  async handler({ host, caller }) {
    const hit = runForSession(host.stores.jobs, caller);
    if (!hit) return result({ job: null });
    return result({ job: host.stores.jobs.get(hit.job.id), run: hit.run });
  },
};

// Stand-in for core's `name_branch` on a job session. Core's tool renames the
// wrangler's worktree record verbatim for an `automationRun` entry and calls
// `jobStore.noteBranchRename`; an extension-launched session has NO worktree
// record on its entry (job-runtime.js launch()), so core's tool refuses it and
// this one renames the branch with git and keeps the sub-job's own record in step.
// Access control is the missing `session` parameter: the caller can only ever
// rename the branch of the sub-job whose run it is.
// TODO(host-api sessions:spawn worktree options): retire this once the wrangler
// owns job worktrees again and core's name_branch works for job sessions.
export const jobNameBranchTool = {
  name: 'job_name_branch',
  description: 'Automated job sub-jobs only: rename THIS run\'s placeholder worktree branch to the repository\'s own branch-naming convention, verbatim (e.g. "AUTH-123-short-description" or "fix/AUTH-123-short-description"). Call it once, before pushing. Returns the final branch name (auto-suffixed -2, -3… if taken).',
  inputSchema: { name: z.string().min(1).describe('The branch name, used verbatim; must be a valid git branch name.') },
  async handler({ host, caller }, { name }) {
    const hit = runForSession(host.stores.jobs, caller);
    const sub = hit && hit.job.subJobs.find((s) => s.id === hit.run.subJobId);
    if (!sub?.worktree) return errorResult('This session is not a job sub-job running in a worktree.');
    try {
      const { branch } = await renameBranch({ worktreePath: sub.worktree.path, desired: name, currentBranch: sub.worktree.branch });
      host.stores.jobs.noteBranchRename(caller, branch);
      await host.rebuild();
      return result({ branch });
    } catch (e) { return errorResult(e.message); }
  },
};

export const TOOLS = [jobReportTool, getJobContextTool, jobNameBranchTool];

// Per-caller veto (manifest `hideTool`): a job step must not see the spawning and
// scheduling tools — core's mcp/server.js skipped them for an `automationRun`
// caller. Fails OPEN by the loader's design (a throw hides nothing).
const SPAWNING = new Set(['spawn_session', 'spawn_workflow', 'schedule_session']);
export function hideTool({ caller, tool, host }) {
  return SPAWNING.has(tool) && Boolean(runForSession(host.stores.jobs, caller));
}

// Keep the runner import used from here so tools.js is the one module handlers
// and tools share for "something changed, poke the runner".
export const kick = (host) => runnerFor(host).tick();
