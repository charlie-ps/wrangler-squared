import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './data-dir.js';
import { readJsonOrLoud, writeJsonAtomic } from './atomic-json.js';
import { jobInputSchema, settingsSchema, REVIEW_DEFAULTS, planSchema, reportSchema, isSessionSub, isHumanSub, isPrSub, isWriteSub, withStoryCreates, reviewCode } from './jobs-schema.js';
import { COMMENT_SETTLE_MS } from './job-comments.js';
import { fallbackTitle } from './job-title.js';
import { dropSub } from './job-sub-ops.js';
import { requestChange, quickChange } from './job-change.js';
import { discardReplan, proposeReplan, approveReplan } from './job-replan.js';
import { applyWrites, applyDrafts, toDraft, approveWrite, skipWrite, editWrite, reopenWrite, isLegacyWrite, LEGACY_WRITE } from './job-writes.js';

const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
// Stamped on the run at claim so the history a later session reads (job-prompts.js)
// names what ran. Null is "the agent's own default", which for Claude is whatever
// ~/.claude/settings.json says at launch — not knowable here, so not guessed.
const launchModel = (job) => job.model || null;
const launchEffort = (job) => job.effort || null;
const quoted = (title) => `“${title}”`;
// Every human intervention lands in `moves`, requested changes and approvals
// alike: it is the one timeline the next session's prompt (job-prompts.js
// history) and the detail view's History panel both read, so an approve or retry recorded
// anywhere else would be invisible to the agent it most concerns.
const record = (j, s, move, note, detail) => (j.moves ||= []).push({ id: uid('mv'), at: Date.now(), subJobId: s?.id || null, move, note: note || null, detail });
export const runnable = (run) => run && !run.stopped;
// A run parked on its drafts is idle until the human decides them: still live
// for its own sub-job (never launched twice), but no agent is working, so it
// holds no concurrency slot.
export const holdsSlot = (run) => runnable(run) && !(run.parkedAt && !run.mailedAt);
// A PR dependency is satisfied once deployed; a session or human dependency once
// it reached done (a cancelled one never satisfies) — an approved receipt for the
// one, the human's own mark for the other. A done session rerun only for its
// writes (job-writes.js reopenWrite) stays done for whatever waits on it.
export const dependencySatisfied = (dep) => isPrSub(dep) ? !!dep?.deployed : (dep.stage === 'done' || dep.writesOnly?.from === 'done') && !dep.cancelledAt;
export const dependenciesSatisfied = (job, sub) => sub.after.every((id) => dependencySatisfied(job.subJobs.find((s) => s.id === id)));
const reviewSessions = (job) => job.reviewSessions ?? true;
const reviewPlan = (job) => job.reviewPlan ?? true;
const planRepos = (plan) => [...new Set(plan.subJobs.filter(isPrSub).map((s) => s.repo))];
// The one place a plan entry becomes a live sub-job, so one approved with the
// plan and one added later by a plan change are indistinguishable to the runner. A
// keyless story leaves `jiraKey` null: the write that creates the story fills
// it in, and the sub-job cannot start until it has one. A sub-job with no story
// is ticketless by design and starts as soon as its dependencies allow.
export function buildSubJob(plan, s) {
  const jiraKey = s.jiraKey || (s.storyId && plan.stories.find((t) => t.id === s.storyId)?.key) || null;
  return { ...s, stage: isSessionSub(s) ? 'session' : isHumanSub(s) ? 'human' : isWriteSub(s) ? 'write' : 'implementation', state: 'queued', jiraKey,
    repairs: [], sessions: [], pr: null, prComments: null, commentSummary: null, deploys: null,
    deploymentResult: null, result: null, ready: null, note: null, fixRequested: null, blocked: null };
}
function activate(j) {
  j.subJobs = j.plan.subJobs.map((s) => buildSubJob(j.plan, s));
  j.stage = 'active';
}
function approve(j, input) {
  const plan = withStoryCreates(planSchema.parse(input));
  j.plan = plan;
  j.repos = planRepos(plan);
  j.approvedAt = Date.now(); j.error = null;
  activate(j);
}
// The whole job at once: Drop applied to every sub-job that has not finished,
// plus the job-level state Drop never touches. A sub-job already in cleanup is
// left alone — a delivered one finishes as delivered, and one whose cleanup was
// refused keeps that error for the human. Pause is cleared because the runner
// does nothing for a paused job, cleanup included, and a cancelled job has
// nothing left to pause; the job error is cleared for the same reason. The
// runner takes it from here (job-runner.js): live steps stop, each sub-job's
// cleanup runs, then the planning sessions and worktrees go, and the job lands
// in `done` with `cancelledAt` telling it apart from a delivered one.
function cancelJob(j, now) {
  if (j.stage === 'done') throw new Error('Job has already finished');
  if (j.cancelledAt) throw new Error('Job is already cancelled');
  j.cancelledAt = now; j.paused = false; j.error = null; j.blocked = null; j.replan = null;
  for (const s of j.subJobs) if (!['cleanup', 'done'].includes(s.stage)) dropSub(s, now);
}
// A running job's review checkpoints, switched from the detail footer. Every gate
// reads its flag when the job reaches it (a receipt landing, a merge poll), so
// writing the field is the whole of "from the next gate on". Work already WAITING
// at a gate is released only when the human confirmed exactly that (`release`):
// a board a tick behind must never let through something nobody saw waiting.
// Merge has nothing to release here: the runner's next poll merges a green PR
// once the flag is off. Plan locks once approved: a replan always waits anyway.
// Writes is only the default: a write's own `review` (true or false) beats it
// (`writeReviewed`), so only writes without one are released, and a session
// already drafting under it lands its drafts approved (job-writes.js applyDrafts).
export const REVIEW_POINTS = { reviewPlan: 'Plan', reviewCode: 'Code', reviewMerge: 'Merge', reviewSessions: 'Session results', reviewWrites: 'Writes' };
const flagOf = (j, field) => field === 'reviewCode' ? reviewCode(j) : field === 'reviewMerge' || field === 'reviewWrites' ? !!j[field] : j[field] ?? true;
function releaseWaiting(j, field, { plan, revision }, now) {
  if (field === 'reviewPlan') {
    if (j.stage !== 'planning' || !j.plan || j.runs.some(runnable)) return 0;
    if (revision != null && j.revision !== revision) throw new Error('The plan changed. Review the latest version before approving.');
    approve(j, plan || j.plan);
    return 1;
  }
  const waiting = j.subJobs.filter((s) => !s.error && s.stage === 'review' && (field === 'reviewCode'
    ? isPrSub(s) && s.state === 'verified' && s.ready && !s.ready.approvedAt
    : field === 'reviewWrites' ? isWriteSub(s) && !s.cancelledAt && s.review !== true
      : field === 'reviewSessions' && isSessionSub(s) && s.result));
  if (waiting.length && j.replan) throw new Error('A plan change is pending. Approve or discard it first.');
  for (const s of waiting) {
    if (field === 'reviewCode') { s.ready = { ...s.ready, approvedAt: now }; s.state = 'approved'; record(j, s, 'approve-code', null, `Approved the working tree of ${quoted(s.title)}`); }
    else if (field === 'reviewWrites') record(j, s, 'approve-write', null, approveWrite(j, s, now));
    else { s.sessionApprovedAt = now; s.stage = 'cleanup'; s.state = 'queued'; record(j, s, 'approve-session', null, `Approved the result of ${quoted(s.title)}`); }
  }
  return waiting.length;
}
function setReview(j, { field, you, release, plan, revision }, now) {
  const name = REVIEW_POINTS[field];
  if (!name || typeof you !== 'boolean') throw new Error('Unknown review checkpoint');
  if (j.stage === 'done') throw new Error('The job is finished: there is nothing left to review');
  if (field === 'reviewPlan' && !['backlog', 'planning'].includes(j.stage)) throw new Error('The plan is already approved. A replan always waits for you');
  const released = !you && release ? releaseWaiting(j, field, { plan, revision }, now) : 0;
  if (flagOf(j, field) === you && !released) return;
  j[field] = you;
  record(j, null, 'set-review', null, `Switched ${name} to ${you ? 'You review' : 'Auto'}${released ? `, releasing ${released === 1 ? 'what was waiting' : `${released} waiting`}` : ''}`);
}
const HELD_BY_REPLAN = new Set(['approve-code', 'approve-merge', 'approve-session', 'start-human', 'finish-human', 'approve-write', 'skip-write', 'edit-write']);
export const MERGE_IS_DELIVERY = 'Merged; nothing runs on push for these paths';
export const CURRENT_VERSION = 5;

const drop = (obj, ...keys) => { for (const k of keys) delete obj[k]; };
// Version 1 named the plan's edges `dependsOn` and its text `instructions`, and
// carried the whole verification vocabulary the runner now infers (deployment,
// local receipts, code approval) plus amendments and recovery jobs. Migration is
// in memory and persisted by the next ordinary write, so a downgrade before then
// still finds its own file. Legacy text may exceed today's caps — it is NOT
// truncated, because the cap is a rule for what a planner may propose, not a
// reason to damage work already approved.
function migrateSub(s) {
  s.after = s.after || s.dependsOn || [];
  s.brief = s.brief || s.instructions || s.title;
  drop(s, 'dependsOn', 'instructions', 'deployment', 'local', 'dependenciesVerified', 'codeApprovedAt', 'recoveryJobId', 'recoveryReason');
  // It had a local receipt and was waiting to publish; one implementation
  // session now commits, pushes and opens the PR from that same worktree.
  if (s.stage === 'implementation' && s.state === 'verified') s.state = 'queued';
  return s;
}
function migratePlan(plan) {
  if (!plan) return plan;
  plan.context = plan.context ?? '';
  for (const story of plan.stories || []) drop(story, 'value');
  for (const s of plan.subJobs || []) migrateSub(s);
  return plan;
}
// Version 2 created keyless stories in a job-level `jira` stage (approved, no
// sub-jobs yet) and again whenever New ticket added one to a running job. Both
// become create writes under a stories session: the waiting job is activated
// with them, a running one gains them beside the PR waiting for the key. A
// ticketing run still live is stopped quietly, like the batched writer's.
function migrateTicketing(job) {
  if (!job.plan || job.cancelledAt || !['jira', 'active'].includes(job.stage)) return;
  const known = new Set(job.plan.subJobs.map((s) => s.id));
  job.plan = withStoryCreates(job.plan);
  if (job.stage === 'jira') { activate(job); return; }
  for (const s of job.plan.subJobs) if (!known.has(s.id)) job.subJobs.push(buildSubJob(job.plan, s));
}
// Version 3 had one place, so a write was `kind: 'jira'` in its own `jira`
// stage, batched by a `jira`-phase run. Jira is now one place of several.
function migrateWrite(s) {
  if (s.kind !== 'jira') return;
  s.kind = 'write'; s.place = { type: 'jira' };
  if (s.stage === 'jira') s.stage = 'write';
}
function migratePlaces(job) {
  for (const s of [...(job.subJobs || []), ...(job.plan?.subJobs || []), ...(job.previousPlan?.subJobs || [])]) migrateWrite(s);
  for (const r of job.runs || []) if (r.phase === 'jira') r.phase = 'write';
}
// Version 4 fired a write on a milestone (`on`) through one batched writer
// session (a `write`-phase run); every write is now its session's (`by`). A
// running job's milestone write is failed in place, never guessed onto a
// session or rewritten: the human drops it or makes it by hand. Its plan entry
// is left as it was (job-sub-ops.js validatePlan looks past it), and a plan still
// awaiting approval is re-judged on approval. A live writer run is stopped
// quietly by the runner (job-runner.js settle).
function migrateSessionWrites(job) {
  if (job.stage !== 'active' || job.cancelledAt) return;
  for (const s of job.subJobs || []) {
    if (!isLegacyWrite(s) || s.cancelledAt || ['cleanup', 'done'].includes(s.stage)) continue;
    s.stage = 'write'; s.state = 'failed'; s.error = LEGACY_WRITE; s.blocked = null;
  }
}
export function migrateJobs(raw) {
  if (!raw) return null;
  if (![1, 2, 3, 4, CURRENT_VERSION].includes(raw.version) || !Array.isArray(raw.jobs)) throw new Error('Unsupported jobs.json; refusing to discard jobs');
  const data = structuredClone(raw);
  data.version = CURRENT_VERSION;
  if (data.settings) drop(data.settings, 'maxRunMinutes');
  for (const job of data.jobs) {
    // `reviewCode` is kept: a version-1 job's flag meant the same thing — the
    // human reads the diff before it is committed — and the field is back.
    drop(job, 'amendmentAuthority', 'amendments', 'recoveryOf');
    migratePlan(job.plan); migratePlan(job.previousPlan);
    for (const s of job.subJobs || []) migrateSub(s);
    if (raw.version < 3) migrateTicketing(job);
    if (raw.version < 4) migratePlaces(job);
    if (raw.version < 5) migrateSessionWrites(job);
  }
  return data;
}

// Only this store writes jobs. Mutations validate a copy and persist it BEFORE
// replacing memory, so failed validation/disk writes cannot half-approve a job.
export class JobStore {
  constructor(file = path.join(DATA_DIR, 'jobs.json')) {
    this.file = file;
    this.data = migrateJobs(readJsonOrLoud(file, 'jobs.json'))
      || { version: CURRENT_VERSION, settings: settingsSchema.parse({}), jobs: [] };
  }
  snapshot() { return structuredClone(this.data); }
  get(id) { return structuredClone(this.data.jobs.find((j) => j.id === id)); }
  change(fn) {
    const next = this.snapshot();
    const result = fn(next);
    writeJsonAtomic(this.file, next);
    this.data = next;
    return structuredClone(result);
  }
  update(id, fn) {
    return this.change((data) => {
      const job = data.jobs.find((j) => j.id === id);
      if (!job) throw new Error('Job not found');
      fn(job); job.updatedAt = Date.now(); job.revision++;
      return job;
    });
  }
  settings(patch) {
    return this.change((d) => { d.settings = settingsSchema.parse({ ...d.settings, ...patch }); return d.settings; });
  }
  create(input, extra = {}) {
    const parsed = jobInputSchema.parse(input);
    // Parsed here, not trusted: the store parses settings only for a fresh file.
    const { reviewDefaults } = settingsSchema.parse(this.data.settings ?? {});
    const reviews = Object.fromEntries(Object.keys(REVIEW_DEFAULTS).map((f) => [f, parsed[f] ?? reviewDefaults[f]]));
    const job = { ...parsed, ...reviews, title: parsed.title || fallbackTitle(parsed.intent), id: uid('job'), stage: 'backlog', revision: 0,
      createdAt: Date.now(), updatedAt: Date.now(), paused: false, plan: null, subJobs: [], runs: [], moves: [], ...extra };
    return this.change((d) => { d.jobs.push(job); return job; });
  }
  // A generated title replaces only the one it was generated for, and is not a
  // revision: approval compares revisions, and a title is not part of the plan.
  retitle(id, from, to) {
    return this.change((d) => {
      const job = d.jobs.find((j) => j.id === id);
      if (!job || job.title !== from || !to || to === from) return false;
      job.title = to; job.updatedAt = Date.now();
      return true;
    });
  }
  // Approval authorises every write in the plan and the implementation. A
  // keyless story is created by its own write, which the stories session makes
  // at once; a sub-job naming it waits for the key, since its card eyebrow and
  // branch name are that key.
  approvePlan(id, revision, editedPlan) {
    return this.update(id, (j) => {
      if (j.revision !== revision) throw new Error('The plan changed. Review the latest version before approving.');
      if (j.cancelledAt) throw new Error('Job was cancelled');
      if (j.stage !== 'planning' || !j.plan || j.runs.some(runnable)) throw new Error('The plan is not ready for review');
      approve(j, editedPlan || j.plan);
    });
  }
  // Every action carries its own fields on the control message, so the payload
  // rides through whole rather than as a fixed parameter list.
  action(id, action, payload = {}) {
    const { subJobId, revision, plan, head, sessionReceiptId, readyReceiptId } = payload;
    const note = String(payload.note || '').trim().slice(0, 180) || null;
    if (action === 'approve-plan') return this.approvePlan(id, revision, plan);
    return this.update(id, (j) => {
      const s = subJobId ? j.subJobs.find((s) => s.id === subJobId) : null;
      if (subJobId && !s) throw new Error('Sub-job not found');
      if (action === 'cancel-job') { cancelJob(j, Date.now()); return; }
      // Retry is the one thing left to do on a cancelled job: a refused cleanup
      // (a worktree with unpushed commits) is still the human's to clear.
      if (j.cancelledAt && action !== 'retry') throw new Error('Job was cancelled');
      // A pending plan change freezes the job where it stands: a sub-job that
      // moves on under the planner (approved, merged, marked done) is no longer
      // the job the proposal was written against.
      if (j.replan && HELD_BY_REPLAN.has(action)) throw new Error('A plan change is pending. Approve or discard it first.');
      if (action === 'set-review') { setReview(j, payload, Date.now()); return; }
      // The one way an idea comes in (job-change.js): to the step's own agent
      // when it has one, else the planner.
      if (action === 'request-change') {
        const { detail } = requestChange(j, s, payload, { now: Date.now() });
        record(j, s, 'request-change', payload.text, detail);
        return;
      }
      // The instant chips (job-change.js): a proposal built with no agent, for the
      // human to read and approve like any other.
      if (action === 'quick-change') {
        const { detail } = quickChange(j, s, payload, { now: Date.now() });
        record(j, s, 'quick-change', payload.note || null, detail);
        return;
      }
      if (action === 'pause') { j.paused = true; return; }
      if (action === 'resume') { j.paused = false; return; }
      if (action === 'start') {
        if (j.stage !== 'backlog') throw new Error('Job has already started');
        j.stage = 'planning'; return;
      }
      if (action === 'discard-replan') { discardReplan(j); record(j, null, 'discard-replan', null, 'Discarded the proposed plan change'); return; }
      if (action === 'approve-replan') {
        const { lines, detail, feedback: asked } = approveReplan(j, payload.proposalId, { now: Date.now(), buildSubJob, option: Number.isInteger(payload.option) ? payload.option : 0 });
        j.repos = planRepos(j.plan);
        record(j, null, 'approve-replan', asked.slice(0, 180), detail);
        for (const l of lines) record(j, l.sub, 'replan', null, l.detail);
        return;
      }
      if (action === 'retry') {
        const target = s || j;
        if (!target.error) throw new Error('Nothing is blocked');
        if (j.runs.some((r) => runnable(r) && r.subJobId === (s?.id || null))) throw new Error('The previous session is still stopping');
        // A write is only ever made by its session: retrying one runs that
        // session again for it (job-writes.js).
        if (isWriteSub(s)) { reopenWrite(j, s); record(j, s, 'retry', note, `Retried ${quoted(s.title)}`); return; }
        target.error = null; target.blocked = null;
        // Under review the only run that can have failed is publish, and the tree
        // the human approved is unchanged: keep the approval so publish runs
        // again. `queued` here would strand the card — the runner launches only
        // on `approved`, and approve-code refuses anything but `verified`.
        if (s) {
          s.state = s.cancelledAt ? 'cancelled' : s.stage === 'review' ? (s.ready?.approvedAt ? 'approved' : 'verified') : 'queued';
          s.repairAllowance = (s.repairAllowance || 0) + 1;
          if (note) s.note = note;
        }
        record(j, s, 'retry', note, s ? `Retried ${quoted(s.title)}` : 'Retried the job');
        return;
      }
      if (action === 'approve-session') {
        if (!isSessionSub(s) || s.stage !== 'review' || !s.result || s.result.receiptId !== sessionReceiptId || s.error) throw new Error('The session result is not ready for review');
        s.sessionApprovedAt = Date.now(); s.stage = 'cleanup'; s.state = 'queued';
        record(j, s, 'approve-session', null, `Approved the result of ${quoted(s.title)}`); return;
      }
      // The two marks that are the whole engine of a human task: no agent is ever
      // launched for one, so nothing but a human click moves it. Done releases
      // whatever waits on it exactly as an approved session does — cleanup has no
      // session to archive and no worktree to remove, so the next tick lands it
      // in done. Marking done straight from waiting is allowed: a step done
      // before anyone thought to mark it started is the common case.
      if (action === 'start-human') {
        if (!isHumanSub(s) || s.stage !== 'human' || s.state === 'doing') throw new Error('This is not a human task waiting to be started');
        s.state = 'doing'; s.error = null; s.blocked = null;
        record(j, s, 'start-human', note, `Started ${quoted(s.title)} by hand`); return;
      }
      if (action === 'finish-human') {
        if (!isHumanSub(s) || s.stage !== 'human') throw new Error('This human task is no longer yours to mark');
        if (payload.output != null && typeof payload.output !== 'string') throw new Error('Human output must be text');
        const output = payload.output?.trim() || null;
        if (output && output.length > 8000) throw new Error('Human output must be at most 8,000 characters');
        s.result = { checks: [note || 'Done by hand'], ...(output ? { output } : {}), at: Date.now(), receiptId: null };
        s.stage = 'cleanup'; s.state = 'queued'; s.error = null; s.blocked = null;
        record(j, s, 'finish-human', note, `Marked ${quoted(s.title)} done by hand`); return;
      }
      // Pinned to the receipt the human read, like approve-session: a board that
      // is a tick behind cannot approve a working tree a later run has changed.
      // The runner's claim refuses a launch while the reporting run is still
      // stopping, so no live-run check is needed here.
      if (action === 'approve-code') {
        if (!s || !isPrSub(s) || s.stage !== 'review' || s.state !== 'verified' || !s.ready || s.ready.receiptId !== readyReceiptId || s.error) throw new Error('The code is not ready to approve');
        s.ready = { ...s.ready, approvedAt: Date.now() }; s.state = 'approved';
        record(j, s, 'approve-code', null, `Approved the working tree of ${quoted(s.title)}`); return;
      }
      if (['approve-write', 'skip-write', 'edit-write'].includes(action)) {
        if (!s) throw new Error('Choose a sub-job');
        const detail = action === 'approve-write' ? approveWrite(j, s, Date.now(), payload.write || null) : action === 'skip-write' ? skipWrite(s, Date.now()) : editWrite(j, s, payload.write || {});
        record(j, s, action, note, detail); return;
      }
      if (action === 'approve-merge') {
        if (s?.stage !== 'pr' || s.pr?.checkStatus !== 'passing' || !head || head !== s.pr?.head || s.error) throw new Error('PR must have green checks first');
        // The runner merges nothing before its prerequisites deploy (job-runner.js).
        if (!dependenciesSatisfied(j, s)) throw new Error('Wait for its prerequisites to deploy first');
        // Approval belongs to these exact bytes. A later push invalidates it.
        s.mergeApprovedHead = s.pr.head; return;
      }
      throw new Error('Unknown job action');
    });
  }
  claim(jobId, subJobId, phase, extra = {}) {
    const job = this.data.jobs.find((j) => j.id === jobId);
    if (!job || job.paused || job.cancelledAt || this.data.settings.paused
      || job.runs.some((r) => runnable(r) && r.subJobId === subJobId)
      || this.data.jobs.flatMap((j) => j.runs).filter(holdsSlot).length >= this.data.settings.concurrency) return null;
    return this.change((d) => {
      const j = d.jobs.find((j) => j.id === jobId);
      const active = d.jobs.flatMap((j) => j.runs).filter(holdsSlot);
      if (!j || j.paused || j.cancelledAt || d.settings.paused || active.length >= d.settings.concurrency) return null;
      if (j.runs.some((r) => runnable(r) && r.subJobId === subJobId)) return null;
      const run = { id: uid('run'), subJobId, phase, model: launchModel(j), effort: launchEffort(j), startedAt: Date.now(), sessionId: null, stopped: false, report: null, ...extra };
      // What its prompt tells it to draft, kept so a Writes switch mid-run
      // reaches the next launch rather than refusing this one's receipt.
      if (phase === 'session') run.drafting = toDraft(j, j.subJobs.find((s) => s.id === subJobId)).map((w) => w.id);
      j.runs.push(run); j.revision++;
      return run;
    });
  }
  bindRun(jobId, runId, sessionId, worktree) {
    return this.update(jobId, (j) => {
      const r = j.runs.find((r) => r.id === runId);
      if (!r || r.stopped) throw new Error('Run is no longer active');
      r.sessionId = sessionId;
      const s = j.subJobs.find((s) => s.id === r.subJobId);
      if (s && !s.sessions.includes(sessionId)) s.sessions.push(sessionId);
      if (worktree) { if (s) s.worktree = worktree; else j.planningWorktrees = [...(j.planningWorktrees || []), worktree]; }
    });
  }
  // The implementer renames its placeholder branch (name_branch) once it has read
  // the repository's convention; `sub.worktree` is a copy taken at launch, and
  // the PR observer (`job-github.js`) and cleanup both match on it, so the copy
  // must follow. Keyed on the reporting session, which is the only one allowed
  // to touch this sub-job's worktree; anything else (an autopilot run, a stale
  // session) is not a job's and is left alone.
  noteBranchRename(sessionId, branch) {
    const job = this.data.jobs.find((j) => j.runs.some((r) => !r.stopped && r.sessionId === sessionId));
    const run = job?.runs.find((r) => !r.stopped && r.sessionId === sessionId);
    const sub = run && job.subJobs.find((s) => s.id === run.subJobId);
    if (!sub?.worktree) return false;
    this.update(job.id, (j) => { const s = j.subJobs.find((x) => x.id === sub.id); s.worktree = { ...s.worktree, branch }; });
    return true;
  }
  report(caller, runId, input) {
    const report = reportSchema.parse(input);
    const job = this.data.jobs.find((j) => j.runs.some((r) => r.id === runId));
    if (!job) throw new Error('Unknown run');
    return this.update(job.id, (j) => {
      const r = j.runs.find((r) => r.id === runId);
      if (!caller || caller !== r.sessionId) throw new Error('Only the assigned session can report this run');
      // A lost HTTP reply can be retried safely, including after the worker stops.
      if (r.report) {
        if (JSON.stringify(r.report) === JSON.stringify(report)) return;
        throw new Error('This run already submitted a different report');
      }
      if (r.stopped) throw new Error('This run has stopped');
      // Implementation lands EITHER receipt: which one its prompt asked for
      // depends on `reviewCode`, and a session launched before that flag flipped
      // (or one that pushed anyway) must still be able to land what it did — a
      // PR that exists is a PR, whatever the board expected. A `write` run is
      // the batched writer's, which no longer exists: nothing it says is taken.
      const expected = { planning: ['plan'], write: [], implementation: ['ready', 'published'], publish: ['published'], repair: ['repaired'], verify: ['deployed'], session: ['completed', 'drafts'] }[r.phase];
      if (!expected.length) throw new Error('This run predates session-owned writes; stop now');
      if (!expected.includes(report.kind) && report.kind !== 'blocked') throw new Error(`This run must submit ${expected.join(' or ')}`);
      const s = j.subJobs.find((s) => s.id === r.subJobId);
      // Drafts park the run rather than end it: the session waits for mail with
      // the human's decision (job-runner.js), then completes. Its receipt is the
      // draft set, kept apart from `report`, which is what ends a run.
      if (report.kind === 'drafts') {
        if (r.parkedAt) {
          if (JSON.stringify(r.draftReport) === JSON.stringify(report)) return;
          throw new Error('This run already sent its drafts; wait for mail with the human\'s decision');
        }
        if (!j.cancelledAt && !s?.cancelledAt) for (const [w, detail] of applyDrafts(j, r, s, report, Date.now())) record(j, w, 'approve-write', null, `${detail}: Writes is on Auto`);
        r.draftReport = report; r.parkedAt ??= Date.now();
        return;
      }
      if (report.kind === 'completed' && r.parkedAt && !r.mailedAt) throw new Error('Your drafts are with the human: wait for mail saying which writes to make, then complete');
      r.report = report; r.reportedAt = Date.now();
      // A receipt racing a cancel is kept on the run for the record but never
      // moves the sub-job: a late `published` must not pull it back out of cleanup,
      // and a late `plan` must not activate a job that was cancelled while planning.
      if (!j.cancelledAt && !s?.cancelledAt) this._applyReceipt(j, r, s, report);
    });
  }
  _applyReceipt(j, r, s, report) {
    if (report.kind === 'plan' && j.stage === 'active') {
      // Discarded while the planner worked: kept on the run, applied nowhere.
      if (j.replan) proposeReplan(j, r, report, Date.now());
      return;
    }
    // With plan review off the planner's own receipt is the approval: the
    // planning run is still live here, which approvePlan would refuse. Under
    // review the human sees the create writes with the rest: a keyless story's
    // creation is drawn (and can be set to review) before anything is approved.
    if (report.kind === 'plan') {
      if (!reviewPlan(j) && j.stage === 'planning') approve(j, report.plan);
      else { j.plan = withStoryCreates(report.plan); j.repos = planRepos(report.plan); }
    }
    // A fresh head (new PR or repair push) is first observed after the comment
    // settle, so reviewers posting seconds after it lands are in that first read.
    // The working tree is the deliverable and nothing is committed: the card
    // waits in Code review until the human approves it (approve-code), which
    // is what releases the publish session.
    // Code review switched off while the session worked: its prompt still said
    // leave it uncommitted, so the receipt is approved as it lands.
    if (report.kind === 'ready') {
      s.ready = { checks: report.checks, receiptId: r.id, at: Date.now() }; s.note = null; s.stage = 'review'; s.state = 'verified';
      if (!reviewCode(j)) { s.ready.approvedAt = s.ready.at; s.state = 'approved'; }
    }
    if (report.kind === 'published') { s.pr = { url: report.url, checkStatus: 'pending' }; s.stage = 'pr'; s.state = 'watching'; s.mergeApprovedHead = null; s.note = null; s.nextPollAt = Date.now() + COMMENT_SETTLE_MS; }
    if (report.kind === 'repaired') { s.repairs.push({ ...report, at: Date.now() }); s.state = 'watching'; s.mergeApprovedHead = null; s.pr.checkStatus = 'pending'; s.fixRequested = null; s.note = null; s.nextPollAt = Date.now() + COMMENT_SETTLE_MS; }
    // A session's receipt is the whole deliverable; with review on it waits for a
    // human, otherwise cleanup (archive its session) takes it straight to done.
    // Every write it owns is accounted for first: a receipt that forgets one is
    // refused whole, and the session corrects it. A created story's key is set
    // on the plan and on every sub-job naming it, which is what releases them;
    // an approved key is part of what the human agreed to and never swaps.
    // A rerun only for its writes keeps the result it finished with and goes
    // back to cleanup. The stories session never waits for review: its writes,
    // each with its own receipt, are its whole result.
    if (report.kind === 'completed') applyWrites(j, r, s, report, Date.now());
    if (report.kind === 'completed' && s.writesOnly) { delete s.writesOnly; s.stage = 'cleanup'; s.state = 'queued'; }
    else if (report.kind === 'completed') {
      const review = reviewSessions(j) && !s.stories;
      s.result = { ...report, receiptId: r.id, at: Date.now() }; s.feedback = null; s.note = null; s.stage = review ? 'review' : 'cleanup'; s.state = review ? 'verified' : 'queued';
    }
    if (report.kind === 'deployed') { s.deployed = { checks: report.checks, at: Date.now(), commit: s.pr?.mergeCommit || null }; s.stage = 'cleanup'; s.state = 'queued'; }
    // The event box on the card: the agent's own sentence.
    if (report.kind === 'blocked') {
      const target = s || j;
      target.error = report.summary;
      target.blocked = { summary: report.summary, phase: r.phase, at: Date.now() };
    }
  }
}
