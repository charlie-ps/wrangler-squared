import { z } from 'zod';
import { reportSchema } from './jobs-schema.js';
import { runnerFor, runForSession } from './jobs.js';

// MCP tools in the EXTENSION signature: `handler({ host, caller }, args)` — no
// `deps` (agent-wrangler docs/superpowers/specs/2026-09-11-extensions-api-design.md,
// "Extension tool and handler signatures"). Core's job-report.js reached
// `deps.jobStore` and `deps.rebuild`; here those are `host.stores.jobs` and
// `host.rebuild()`. Registered on the server AND granted in the launch argv by the
// loader from this one list — the two-place rule is derived for extension tools.
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// A job worker renames its placeholder branch with core's `name_branch`, which
// the wrangler applies to the entry it owns — and there is no rename hook, so
// the extension's own copy of the record (`sub.worktree.branch`, what the PR
// observer matches on and what cleanup deletes) learns about it by READING the
// projection back. Both tools do it before anything else because they are the
// only moments a job session reaches this extension at all: every downstream
// consumer of the branch (job-github.js's headRefName check, cleanup) runs
// after a receipt, and a receipt comes through job_report.
function syncBranch(host, caller) {
  const branch = host.sessions.get(caller)?.worktree?.branch;
  const hit = branch && runForSession(host.stores.jobs, caller);
  const sub = hit && hit.job.subJobs.find((s) => s.id === hit.run.subJobId);
  if (sub?.worktree && sub.worktree.branch !== branch) host.stores.jobs.noteBranchRename(caller, branch);
}

export const jobReportTool = {
  name: 'job_report',
  description: 'Submit the receipt for your assigned automated job run, then stop. One receipt per run: plan, jira, ready (the working tree awaits the human\'s code review, nothing committed), published (the PR url), repaired, deployed or completed. Checks are normally 1–3 bullets of a few words, e.g. "Build passed"; keep the detail in the transcript. Only the assigned session can report; identical retries are safe, and a terminal recap does not advance the job. If you cannot finish, submit {kind:"blocked", summary:"one sentence"} and optionally name the move a human should make: move:"fix-here" (a new commit on this PR), "split-out" (a second PR on this ticket), "new-ticket" (scope nobody knew about), "reorder" (this must land after something else), "drop", "mark" (it is already done elsewhere) or "accept-red" (the failing check or post-merge run is noise; merge or count it as landed anyway). You never change the plan yourself; the human clicks the move.',
  inputSchema: { runId: z.string(), report: reportSchema },
  async handler({ host, caller }, { runId, report }) {
    try {
      syncBranch(host, caller);
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
    syncBranch(host, caller);
    const hit = runForSession(host.stores.jobs, caller);
    if (!hit) return result({ job: null });
    return result({ job: host.stores.jobs.get(hit.job.id), run: hit.run });
  },
};

export const TOOLS = [jobReportTool, getJobContextTool];

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
