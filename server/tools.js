import { allowFiles } from './job-files.js';
import { z } from 'zod';
import { isHumanSub, jobInputSchema, reportSchema } from './jobs-schema.js';
import { runForSession } from './jobs.js';
import { makeCreateJob } from './job-create.js';
import { workingTreeHash, mergeInProgress } from './git.js';

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

const worktreeOf = (host, caller, runId) => {
  const hit = runForSession(host.stores.jobs, caller);
  const sub = hit?.run.id === runId && hit.job.subJobs.find((s) => s.id === hit.run.subJobId);
  return sub?.worktree?.path || null;
};
async function treeOf(host, path) {
  if (!path) return null;
  try { return await workingTreeHash(path); } catch (e) { host.log('tree hash failed', e); return null; }
}
// Work never merges (job-sync.js): a ready over a merge in progress is refused,
// so the human never reviews the base as if it were the work.
export const MERGE_REFUSED = 'A merge is in progress in this worktree (MERGE_HEAD is set), so the diff would hold the whole base branch. Work never merges the base in: run `git merge --abort`, keep only your own changes uncommitted, and report ready again. Wrangler brings the branch up to date with its base itself.';

export const jobReportTool = {
  name: 'job_report',
  description: 'Submit the receipt for your assigned Wrangler² step, then stop. One receipt per run: plan (a plan change may also carry diagnosis, actions pinned to a head, merge commit, stage or review round — forward to a session open on review, rework, accept-red, mark, recover, retry (a red step started again as it is; always waits for the human) — and up to three ranked options), ready (the working tree awaits the human\'s code review, nothing committed; with Code on You review your session then stays open, paused, for the human to write to you; each Show me item of your prompt is answered by a check of that exact text carrying shots, run or couldNot, and a receipt that leaves one out is refused), reply (text, shots?, run?: answers a human who wrote to your paused session; changes nothing, the session stays paused; from a new idea\'s planner it is a turn in the conversation, with suggest?:[{title, plan}] offering one job, or 2–4 when the idea is several jobs; from a planner asked a question about a running job it is the answer, shown in the job\'s conversation), published (the PR url, once you are told to commit and push), synced or conflict (a sync session: the base merged in and pushed, or the conflicts that need the human\'s pick, each with up to three ranked options, after which you wait for mail), repaired, deployed or completed (with writes: one result per write your prompt lists — written, already, or failed with the place\'s own error — with its link, or a made output\'s location). A session whose prompt puts writes under review first sends drafts (each reviewed write as it would make it) and waits for mail with the human\'s decision before it completes. Checks are normally 1–3 bullets of a few words, e.g. "Build passed"; keep the detail in the transcript. Only the assigned session can report; identical retries are safe, and a terminal recap does not advance the job. If you cannot finish, go up one level: {kind:"blocked", summary:"one sentence"}, or {kind:"replan", summary, why?} when the work needs more than your step, both of which go to the planner first; {kind:"escalate", summary, tried?, ask} declares your step red for the human with what you found, what you tried and the decision you need (the planner may also attach up to three options). You never change the plan yourself.',
  inputSchema: { runId: z.string(), report: reportSchema },
  async handler({ host, caller }, { runId, report }) {
    try {
      syncBranch(host, caller);
      // Approval is pinned to the tree this receipt describes, read now while the
      // session is waiting for it. A tree git cannot read pins nothing.
      const path = report.kind === 'ready' && worktreeOf(host, caller, runId);
      if (path && await mergeInProgress(path)) return errorResult(MERGE_REFUSED);
      const meta = report.kind === 'ready' ? { treeHash: await treeOf(host, path) } : {};
      const job = host.stores.jobs.report(caller, runId, report, meta);
      allowFiles(host, [job]);
      await host.rebuild();
      // Drafts leave the run open: the session ends its turn, but its work is
      // not done until the mail with the human's decision has been acted on.
      const parked = job.runs.find((r) => r.id === runId);
      const next = report.kind === 'drafts' ? 'End your turn and wait: mail will say which writes to make, with their final text. Make exactly those, then send kind:"completed".'
        : parked?.parkedFor === 'idea' && parked.parkedAt && !parked.mailedAt ? 'End your turn and wait: the human answers in the idea\'s conversation, and their answer arrives by mail. Do not stop the session yourself.'
        : parked?.parkedFor === 'ready' && parked.parkedAt && !parked.mailedAt ? 'End your turn and wait: the human may write to you by mail (a question gets kind:"reply"; a change is made and reported ready again), and once they approve, mail asks you to commit and push. Do not stop the session yourself.'
        : parked?.parkedFor === 'ready' && !parked.report && !parked.mailedAt ? 'End your turn and wait: mail asks you to commit and push the approved tree in a moment. Do not stop the session yourself.'
        : parked?.parkedFor === 'conflict' && parked.parkedAt && !parked.mailedAt ? 'End your turn and wait, leaving the merge in progress: the human picks how to resolve each conflict, and their choices arrive by mail. Do not stop the session yourself.'
        : 'Stop now. Wrangler coordinates the next step.';
      return result({ accepted: true, jobId: job.id, next });
    } catch (e) { return errorResult(e.message); }
  },
};

export const getJobContextTool = {
  name: 'get_job_context',
  description: 'Get the current job, approved plan and run assigned to your own session. HUMAN output is included only for completed direct dependencies. No other session or job can be selected.',
  inputSchema: {},
  async handler({ host, caller }) {
    syncBranch(host, caller);
    const hit = runForSession(host.stores.jobs, caller);
    if (!hit) return result({ job: null });
    const job = host.stores.jobs.get(hit.job.id);
    const sub = job.subJobs.find((s) => s.id === hit.run.subJobId);
    const direct = new Set(sub?.after || []);
    for (const s of job.subJobs) if (isHumanSub(s) && !(direct.has(s.id) && s.stage === 'done' && !s.cancelledAt)) {
      if (s.result) delete s.result.output;
    }
    // A conversation's wrangler reads its own conversation: the others are listed
    // in its prompt only so it knows of them (job-talk.js).
    if (hit.run.convo) {
      job.talk = (job.talk || []).filter((m) => m.convo === hit.run.convo);
      job.convos = (job.convos || []).filter((c) => c.id === hit.run.convo);
    }
    return result({ job, run: hit.run });
  },
};

// The New job form as a tool, so an ordinary agent session can hand work to
// Wrangler². Unlike the form it broadcasts nothing: `job-created` would close a
// human's open New job dialog. The rebuild is what shows the job on the board.
export function makeCreateJobTool(deps) {
  const createJob = makeCreateJob(deps);
  return {
    name: 'create_job',
    description: 'Create a Wrangler² job from a description of the outcome you want, the way a human does through the Jobs view\'s New job form. intent is the description (a title is generated from it unless you pass one); repos are absolute repository paths the planner should start from (leave empty to let it discover them); agent/model/effort choose what runs each step (leave one out to use the human\'s usual pick from New job; an empty model or effort is the agent\'s own default). For a Codex job, sandbox is locked (writes only inside the worktree), auto (the default: --approve-for-me, a reviewer model approves stepping outside) or full (no sandbox, no approvals); base is the branch the job\'s PRs land on when it is not the repository\'s default (an integration branch such as next; it must exist on origin); writableDirs are extra folders (absolute or ~/) every Codex step may also write, such as ~/.docker. start:true starts planning straight away; otherwise the job waits in the backlog for a human to start it. Planning stops for the human to approve the plan unless reviewPlan is false, which starts the work as soon as the plan is in. Leave a review flag out to use the human\'s review defaults from Automation settings. Returns the jobId.',
    inputSchema: {
      // A job has no Task: its sessions are off the board (job-runtime.js), so a
      // Task would only count them where nobody can see them.
      ...jobInputSchema.omit({ taskId: true }).shape,
      start: z.boolean().default(false),
    },
    async handler({ host }, { start, ...job }) {
      try {
        const created = await createJob(host, { job, start });
        return result({ jobId: created.id, title: created.title, stage: host.stores.jobs.get(created.id).stage });
      } catch (e) { return errorResult(e?.issues?.[0]?.message || e?.message || String(e)); }
    },
  };
}
export const createJobTool = makeCreateJobTool();

export const TOOLS = [jobReportTool, getJobContextTool, createJobTool];

// Per-caller veto (manifest `hideTool`): a job step must not see the spawning and
// scheduling tools — core's mcp/server.js skipped them for an `automationRun`
// caller — nor create_job, or a job could recursively spawn jobs. Fails OPEN by
// the loader's design (a throw hides nothing).
const SPAWNING = new Set(['spawn_session', 'spawn_workflow', 'schedule_session', 'create_job']);
export function hideTool({ caller, tool, host }) {
  return SPAWNING.has(tool) && Boolean(runForSession(host.stores.jobs, caller));
}
