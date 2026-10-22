import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './data-dir.js';
import { readJsonOrLoud, writeJsonAtomic } from './atomic-json.js';
import { jobInputSchema, settingsSchema, REVIEW_DEFAULTS, planSchema, reportSchema, isSessionSub, isHumanSub, isPrSub, isWriteSub, withStoryCreates, reviewCode, checkText, unansweredShow } from './jobs-schema.js';
import { migrateTheme } from '../public/theme-ids.js';
import { adoptEvidence } from './job-evidence.js';
import { parkedReadyRun, askAgent, answered, sayInThread } from './job-parked.js';
import { setRunning, owe, runningOf } from './job-running.js';
import { COMMENT_SETTLE_MS } from './job-comments.js';
import { fallbackTitle } from './job-title.js';
import { dropSub, retrySub } from './job-sub-ops.js';
import { requestChange } from './job-change.js';
import { resolutionsFor, resolutionLabel } from './job-main.js';
import { limitStep, limitOf } from './job-budget.js';
import { plannerReply, humanReply, acceptIdea, leaveIdea, editIdea, unsentIdea, inConversation, UNSENT_IDEA } from './job-idea.js';
import { discardReplan, proposeReplan, proposeOptions, approveReplan, requestReplan } from './job-replan.js';
import { answerAsk, answerReplan, askToReplan, askFailed, replanFailed, convoById, migrateTalk, dismissConvo } from './job-talk.js';
import { forwardsOnly } from './job-actions.js';
import { heldBy, holdRed, declareRed, declareOutOfTries, escalate, settleProposal, failRedReplan } from './job-red.js';
import { applyWrites, applyDrafts, toDraft, approveWrite, skipWrite, editWrite, reopenWrite, isLegacyWrite, LEGACY_WRITE } from './job-writes.js';

const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
// Stamped on the run at claim so the history a later session reads (job-prompts.js)
// names what ran. Null is "the agent's own default", which for Claude is whatever
// ~/.claude/settings.json says at launch — not knowable here, so not guessed.
const launchModel = (job) => job.model || null;
const launchEffort = (job) => job.effort || null;
// What runs a job's steps when its create left agent/model/effort out: New job's
// last pick. That pick's model and effort mean nothing to another agent, and its
// effort is for its own model, so an explicit model keeps the agent's default.
const pickFor = ({ agent, model, effort }, usual) => {
  const resolved = agent ?? usual?.agent ?? 'claude';
  const same = usual?.agent === resolved;
  const m = model ?? (same ? usual.model : '');
  return { agent: resolved, model: m, effort: effort ?? (same && m === usual.model ? usual.effort : '') };
};
const quoted = (title) => `“${title}”`;
const listed = (items, total, label) => `${items.slice(0, 5).map(label).join(', ')}${total > 5 ? ` and ${total - 5} more` : ''}`;
const lossLine = (r) => [r.commitCount && `${r.commitCount} commit${r.commitCount === 1 ? '' : 's'} (${listed(r.commits, r.commitCount, (c) => `${c.sha.slice(0, 8)} ${c.subject}`)})`,
  r.fileCount && `${r.fileCount} file${r.fileCount === 1 ? '' : 's'} (${listed(r.files, r.fileCount, (f) => f.path)})`].filter(Boolean).join(' and ') || `branch ${r.branch}`;
// Every human intervention lands in `moves`, requested changes and approvals
// alike: it is the one timeline the next session's prompt (job-prompts.js
// history) and the detail view's History panel both read, so an approve or retry recorded
// anywhere else would be invisible to the agent it most concerns.
const usd = (n) => `$${n.toFixed(2)}`;
const record = (j, s, move, note, detail) => (j.moves ||= []).push({ id: uid('mv'), at: Date.now(), subJobId: s?.id || null, move, note: note || null, detail });
export const TREE_MOVED = 'TREE_MOVED';
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
// What a job made from one of an idea's suggestions takes from the idea: everything
// the human set on New idea, already resolved against their defaults.
const IDEA_SETTINGS = ['repos', 'agent', 'model', 'effort', 'planningPrompt', ...Object.keys(REVIEW_DEFAULTS), 'base', 'taskId', 'images', 'shareImages', 'sandbox', 'writableDirs'];
const ideaSettings = (j) => Object.fromEntries(IDEA_SETTINGS.filter((k) => j[k] !== undefined).map((k) => [k, structuredClone(j[k])]));
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
  j.cancelledAt = now; j.paused = false; j.budgetPaused = null; j.error = null; j.blocked = null; j.replan = null;
  for (const c of j.convos || []) c.pending = null;
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
export const REVIEW_POINTS = { reviewPlan: 'Plan', reviewCode: 'Local verification', reviewMerge: 'Merge', reviewSessions: 'Session results', reviewWrites: 'Writes', reviewRed: 'Red steps' };
const checkpointWord = (field, you) => field === 'reviewRed' ? (you ? 'You decide' : 'Wrangler replans') : you ? 'You review' : 'Auto';
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
    // A bulk release carries no words, so it clears any an earlier approval left.
    if (field === 'reviewCode') { s.ready = { ...s.ready, approvedAt: now }; s.state = 'approved'; s.approvalNote = null; record(j, s, 'approve-code', null, `Approved the working tree of ${quoted(s.title)}`); }
    else if (field === 'reviewWrites') record(j, s, 'approve-write', null, approveWrite(j, s, now));
    else { s.sessionApprovedAt = now; s.stage = 'cleanup'; s.state = 'queued'; s.approvalNote = null; record(j, s, 'approve-session', null, `Approved the result of ${quoted(s.title)}`); }
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
  record(j, null, 'set-review', null, `Switched ${name} to ${checkpointWord(field, you)}${released ? `, releasing ${released === 1 ? 'what was waiting' : `${released} waiting`}` : ''}`);
}
// The human's words for later steps, given with an approval (job-prompts.js approvalNotesBlock).
export const APPROVAL_NOTE_MAX = 2000;
function approvalNote(payload) {
  if (payload.note == null) return null;
  if (typeof payload.note !== 'string') throw new Error('An approval note must be text');
  const text = payload.note.trim();
  if (text.length > APPROVAL_NOTE_MAX) throw new Error(`An approval note must be at most ${APPROVAL_NOTE_MAX.toLocaleString('en-GB')} characters`);
  return text || null;
}
const HELD_BY_REPLAN = new Set(['approve-code', 'approve-merge', 'approve-session', 'start-human', 'finish-human', 'approve-write', 'skip-write', 'edit-write']);
export const MERGE_IS_DELIVERY = 'Merged; nothing runs on push for these paths';
export const CURRENT_VERSION = 6;

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
  if (![1, 2, 3, 4, 5, CURRENT_VERSION].includes(raw.version) || !Array.isArray(raw.jobs)) throw new Error('Unsupported jobs.json; refusing to discard jobs');
  const data = structuredClone(raw);
  data.version = CURRENT_VERSION;
  if (data.settings) drop(data.settings, 'maxRunMinutes');
  // The board reads settings as stored, so a saved `backdrop` becomes its theme here, not only on the next save.
  if (data.settings) data.settings = migrateTheme(data.settings);
  // Version 5 opened most boards in Space; everyone moves to Wrangler once, so Space is only a
  // choice made since. Its options stay for whoever picks it again.
  if (raw.version < 6 && data.settings?.theme === 'space') data.settings.theme = 'wrangler';
  for (const job of data.jobs) {
    // `reviewCode` is kept: a version-1 job's flag meant the same thing — the
    // human reads the diff before it is committed — and the field is back.
    // `titlePending`: the Haiku run it waited on died with the last process.
    drop(job, 'amendmentAuthority', 'amendments', 'recoveryOf', 'titlePending');
    migratePlan(job.plan); migratePlan(job.previousPlan);
    for (const s of job.subJobs || []) migrateSub(s);
    if (raw.version < 3) migrateTicketing(job);
    if (raw.version < 4) migratePlaces(job);
    if (raw.version < 5) migrateSessionWrites(job);
    migrateTalk(job);
  }
  return data;
}

// A generated conversation title is a list label: Haiku is asked for five words.
const CONVO_TITLE_MAX = 60;

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
    const { reviewDefaults, usualPick } = settingsSchema.parse(this.data.settings ?? {});
    const reviews = Object.fromEntries(Object.keys(REVIEW_DEFAULTS).map((f) => [f, parsed[f] ?? reviewDefaults[f]]));
    const job = { ...parsed, ...reviews, ...pickFor(parsed, usualPick), title: parsed.title || fallbackTitle(parsed.intent), id: uid('job'), stage: 'backlog', revision: 0,
      createdAt: Date.now(), updatedAt: Date.now(), paused: false, plan: null, subJobs: [], runs: [], moves: [], ...extra };
    return this.change((d) => { d.jobs.push(job); return job; });
  }
  // A generated title replaces only the one it was generated for, and is not a
  // revision: approval compares revisions, and a title is not part of the plan.
  // Any answer, a null one included, ends the wait.
  retitle(id, from, to) {
    return this.change((d) => {
      const job = d.jobs.find((j) => j.id === id);
      if (!job) return false;
      const swap = job.title === from && !!to && to !== from;
      delete job.titlePending;
      if (swap) { job.title = to; job.updatedAt = Date.now(); }
      return swap;
    });
  }
  // Haiku's name for a conversation (handlers.js nameConvos), not a revision either.
  // Any answer, a null one included, ends the wait.
  titleConvo(id, convoId, title) {
    return this.change((d) => {
      const convo = d.jobs.find((j) => j.id === id)?.convos?.find((c) => c.id === convoId);
      if (!convo?.titlePending) return false;
      delete convo.titlePending;
      if (title) convo.title = title.slice(0, CONVO_TITLE_MAX);
      return !!title;
    });
  }
  // The board drew these conversations' answers in an open dialog: they are read.
  // Not a revision, like a title: nothing a human approves was written against it.
  seenTalk(id, convos, now = Date.now()) {
    return this.change((d) => {
      const job = d.jobs.find((j) => j.id === id);
      const seen = (job?.convos || []).filter((c) => convos.includes(c.id) && (c.seenAt || 0) < now);
      for (const c of seen) c.seenAt = now;
      return seen.length > 0;
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
  // New idea's press (job-idea.js): each suggestion created is that job's plan receipt
  // and its approval at once, so Plan review never asks again. The last one left turns
  // the idea itself into its job; each other is a new job beside it, made from the
  // idea's own settings and sharing its pictures (JobRunner.finish releases a picture
  // only once no other unfinished job holds it). One write, so a refused plan creates
  // nothing.
  acceptIdea(id, payload) {
    return this.change((d) => {
      const j = d.jobs.find((x) => x.id === id);
      if (!j) throw new Error('Job not found');
      if (j.cancelledAt) throw new Error('Job was cancelled');
      const now = Date.now();
      const { siblings, own } = acceptIdea(j, { messageId: payload.messageId, index: Number(payload.index) || 0, all: payload.all === true }, now);
      for (const x of siblings) {
        const sib = { ...ideaSettings(j), title: x.title, intent: `${x.title}\n\nFrom the idea ${quoted(j.title)}: ${j.intent}`.slice(0, 16000), id: uid('job'), stage: 'planning', revision: 0,
          createdAt: now, updatedAt: now, paused: false, plan: null, subJobs: [], runs: [], moves: [], fromIdea: { jobId: j.id, messageId: payload.messageId } };
        approve(sib, x.plan);
        record(sib, null, 'accept-idea', null, `Created from the idea ${quoted(j.title)}: ${quoted(x.title)}`);
        x.jobId = sib.id;
        d.jobs.push(sib);
      }
      if (own) approve(j, own.plan);
      for (const x of [...siblings, ...(own ? [own] : [])]) record(j, null, 'accept-idea', null, own === x ? `Created the job from Wrangler's suggestion: ${quoted(x.title)}` : `Created a job beside this idea from Wrangler's suggestion: ${quoted(x.title)}`);
      j.updatedAt = now; j.revision++;
      return j;
    });
  }
  // Every action carries its own fields on the control message, so the payload
  // rides through whole rather than as a fixed parameter list.
  action(id, action, payload = {}) {
    const { subJobId, revision, plan, head, sessionReceiptId, readyReceiptId } = payload;
    const note = String(payload.note || '').trim().slice(0, 180) || null;
    if (action === 'approve-plan') return this.approvePlan(id, revision, plan);
    if (action === 'accept-idea') return this.acceptIdea(id, payload);
    return this.update(id, (j) => {
      const s = subJobId ? j.subJobs.find((s) => s.id === subJobId) : null;
      if (subJobId && !s) throw new Error('Sub-job not found');
      if (action === 'cancel-job') { cancelJob(j, Date.now()); return; }
      // Retry and Discard are what is left to do on a cancelled job: a refused
      // cleanup (a worktree with work not on GitHub) is still the human's to clear.
      if (j.cancelledAt && !['retry', 'discard-worktree', 'retry-main', 'dismiss-main', 'resolve-main'].includes(action)) throw new Error('Job was cancelled');
      // A waiting proposal freezes the sub-jobs it touches where they stand: one
      // that moves on under it (approved, merged, marked done) is no longer what
      // the proposal was written against. The rest of the job carries on.
      if (j.replan && HELD_BY_REPLAN.has(action) && (!s || heldBy(j, s))) throw new Error('A plan change is pending. Approve or discard it first.');
      if (action === 'set-review') { setReview(j, payload, Date.now()); return; }
      // The one way an idea comes in (job-change.js): to the step's own agent
      // when it has one, else the planner.
      if (action === 'request-change') {
        const { detail } = requestChange(j, s, payload, { now: Date.now() });
        record(j, s, 'request-change', payload.text, detail);
        return;
      }
      if (action === 'dismiss-convo') {
        dismissConvo(j, payload.convo, Date.now());
        if (j.replan && j.replan.convo === payload.convo) { if (j.replan.red) holdRed(j, j.replan.red.sub); discardReplan(j); }
        record(j, s, 'dismiss-convo', null, 'Dismissed a conversation with Wrangler');
        return;
      }
      // The preview the agent left running (job-running.js): Stop owes its teardown
      // to the runner's next tick; Restart mails the parked session to start it again.
      if (action === 'stop-running') {
        if (!s || !owe(s, payload.name || null)) throw new Error('Nothing is running for this step');
        record(j, s, 'stop-running', null, `Stopped what the agent left running on ${quoted(s.title)}`);
        return;
      }
      if (action === 'restart-running') {
        const run = s && parkedReadyRun(j, s);
        const down = s ? runningOf(s).filter((i) => i.up === false && (!payload.name || i.name === payload.name)) : [];
        if (!run || !s.ready) throw new Error('Its session is no longer open to ask: start it by hand, or ask for a change');
        if (!down.length) throw new Error('Everything it left running is up');
        askAgent(s, { from: 'system', text: `${down.map((i) => i.name).join(', ')} ${down.length === 1 ? 'is' : 'are'} no longer running and the human wants to try it. Start ${down.length === 1 ? 'it' : 'them'} again as before (detached with setsid, free ports) and answer with job_report kind:"reply", text:"…", running:[every entry now up, with its url, pid and stop]. Change nothing else.`, kind: 'restart' }, Date.now());
        record(j, s, 'restart-running', null, `Asked the session to start ${down.map((i) => i.name).join(', ')} again`);
        return;
      }
      // New idea's conversation (job-idea.js): the human's answer to the planner, and
      // Leave the rest closes one that already gave the jobs wanted from it (acceptIdea).
      if (action === 'idea-reply') { humanReply(j, payload.text, Date.now(), payload.attachments); return; }
      // A backlog idea's own words, before any planner has read them (job-idea.js editIdea).
      if (action === 'edit-idea') {
        const detail = editIdea(j, { title: payload.title, text: payload.text });
        if (detail) record(j, null, 'edit-idea', null, detail);
        return;
      }
      if (action === 'leave-idea') {
        const made = leaveIdea(j, Date.now());
        cancelJob(j, Date.now());
        record(j, null, 'leave-idea', null, `Left the rest of Wrangler's suggestions; this idea became ${made.map((x) => quoted(x.title)).join(', ')}`);
        return;
      }
      if (['retry-main', 'dismiss-main', 'resolve-main'].includes(action)) {
        const notice = j.mainNotices?.find((n) => n.path === payload.path);
        if (!notice) throw new Error('That checkout no longer needs updating');
        if (action === 'retry-main') notice.retrying = true;
        else if (action === 'dismiss-main') { j.mainNotices = j.mainNotices.filter((n) => n !== notice); record(j, null, 'dismiss-main', null, `Left ${notice.path} as it was`); }
        else {
          // One session per checkout at a time, and only a fix this notice offers.
          if (notice.resolving) throw new Error('A session is already working on that checkout');
          if (!resolutionsFor(notice).some((r) => r.id === payload.resolution)) throw new Error('That fix does not apply to this checkout');
          notice.resolving = { id: payload.resolution, at: Date.now(), sessionId: null };
          notice.resolveError = null;
          record(j, null, 'resolve-main', null, `Asked an agent to ${resolutionLabel(payload.resolution).toLowerCase()} in ${notice.path}`);
        }
        return;
      }
      if (action === 'pause') { j.paused = true; return; }
      // Resume is the human's own pause only: a budget pause outlives it.
      if (action === 'resume') { j.paused = false; return; }
      // Add $X (job-budget.js): one more X on this job's limit. Pinned to the count
      // the human saw, so a double click adds once; the runner's next tick releases
      // the job if it is now under.
      if (action === 'top-up') {
        const x = limitStep(this.data.settings);
        if (x == null) throw new Error('No job spend limit is set');
        if (j.stage === 'done') throw new Error('Job has finished');
        if ((payload.topUps ?? 0) !== (j.topUps || 0)) throw new Error('The limit was already raised');
        j.topUps = (j.topUps || 0) + 1;
        record(j, null, 'top-up', null, `Added ${usd(x)}: the spend limit is now ${usd(limitOf(this.data.settings, j))}`);
        return;
      }
      if (action === 'start') {
        if (j.stage !== 'backlog') throw new Error('Job has already started');
        j.stage = 'planning'; return;
      }
      if (action === 'discard-replan') {
        // A red step's fix the human turned down is not proposed again for the same failure.
        if (j.replan?.red) holdRed(j, j.replan.red.sub);
        discardReplan(j); record(j, null, 'discard-replan', null, 'Discarded the proposed plan change'); return;
      }
      if (action === 'approve-replan') {
        const red = j.replan?.red;
        const { sentBack } = this._approveReplan(j, payload.proposalId, Number.isInteger(payload.option) ? payload.option : 0);
        if (red && !sentBack) holdRed(j, red.sub);
        return;
      }
      if (action === 'retry') {
        if (!(s || j).error) throw new Error('Nothing is blocked');
        if (j.runs.some((r) => runnable(r) && r.subJobId === (s?.id || null) && !r.convo)) throw new Error('The previous session is still stopping');
        // A write is only ever made by its session: retrying one runs that
        // session again for it (job-writes.js).
        if (isWriteSub(s)) { reopenWrite(j, s); record(j, s, 'retry', note, `Retried ${quoted(s.title)}`); return; }
        if (s) retrySub(s, note);
        else { j.error = null; j.blocked = null; }
        record(j, s, 'retry', note, s ? `Retried ${quoted(s.title)}` : 'Retried the job');
        return;
      }
      // The human's "I don't care" on a refused cleanup. Pinned to the head and
      // tree fingerprint the board showed, so a refusal that has since been
      // replaced by a newer one is not discarded unseen; the runtime checks the
      // disk against the same pair before it deletes anything.
      if (action === 'discard-worktree') {
        const shown = s?.cleanupRefusal;
        if (!shown || s.stage !== 'cleanup' || s.discard) throw new Error('Nothing is waiting to be discarded');
        if (shown.pinned === false) throw new Error('This worktree cannot be pinned to what you saw (a submodule, or too much to check); clean it up by hand');
        if (payload.discardHead !== shown.head || payload.fingerprint !== shown.fingerprint) throw new Error('The worktree changed since you looked. Review it again before discarding.');
        s.discard = { head: shown.head, fingerprint: shown.fingerprint, at: Date.now(), ...(shown.cause === 'unremovable' && { cause: 'unremovable' }) };
        s.error = null; s.blocked = null;
        record(j, s, 'discard-worktree', note, shown.cause === 'unremovable' ? `Chose to delete the leftover folder ${shown.path} and branch ${shown.branch}${shown.commitCount ? `, with ${lossLine(shown)}` : ''}, from ${quoted(s.title)}`
          : `Discarded ${lossLine(shown)} from ${quoted(s.title)}`);
        return;
      }
      if (action === 'approve-session') {
        if (!isSessionSub(s) || s.stage !== 'review' || !s.result || s.result.receiptId !== sessionReceiptId || s.error) throw new Error('The session result is not ready for review');
        const said = approvalNote(payload);
        s.sessionApprovedAt = Date.now(); s.stage = 'cleanup'; s.state = 'queued'; s.approvalNote = said;
        record(j, s, 'approve-session', said, `Approved the result of ${quoted(s.title)}`); return;
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
      // The tree moved under an approval (handlers.js): the parked session is told
      // to report ready again. With no parked session there is nobody to ask.
      if (action === 'tree-moved') {
        const run = parkedReadyRun(j, s);
        if (!run || !s.ready || s.ready.receiptId !== readyReceiptId) return;
        askAgent(s, { from: 'system', text: `The working tree changed after you reported ready (round ${s.ready.round}). Report ready again so the human can approve what is there now.`, kind: 'retell' }, Date.now());
        return;
      }
      if (action === 'approve-code') {
        if (!s || !isPrSub(s) || s.stage !== 'review' || s.state !== 'verified' || !s.ready || s.ready.receiptId !== readyReceiptId || s.error) throw new Error('The code is not ready to approve');
        // The tree the agent reported ready, as the handler read it just now
        // (handlers.js): approval belongs to those exact bytes, not to whatever
        // the worktree holds after someone typed into the session.
        if (s.ready.treeHash && payload.treeHash !== s.ready.treeHash) throw Object.assign(new Error(payload.treeHash ? 'The working tree changed since the agent reported ready. It has been asked to report ready again; approve once it does.' : 'Could not read the working tree to check it is what the agent reported. Try again.'), { code: payload.treeHash ? TREE_MOVED : undefined });
        const said = approvalNote(payload);
        s.ready = { ...s.ready, approvedAt: Date.now() }; s.state = 'approved'; s.approvalNote = said;
        record(j, s, 'approve-code', said, `Approved the working tree of ${quoted(s.title)}`); return;
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
  // The spend limit's verdict (job-runner.js enforceBudget), written only on the edge.
  budgetPause(jobId, { usd: spent, limit }) {
    return this.update(jobId, (j) => {
      j.budgetPaused = { at: Date.now(), usd: spent, limit };
      record(j, null, 'budget-pause', null, `Paused at its spend limit: ${usd(spent)} of ${usd(limit)}`);
    });
  }
  budgetRelease(jobId, { limit }) {
    return this.update(jobId, (j) => {
      j.budgetPaused = null;
      record(j, null, 'budget-release', null, limit == null ? 'Released: no job spend limit is set' : `Released under its spend limit of ${usd(limit)}`);
    });
  }
  // Red handling's last rung: the automatic tries on this step are spent.
  declareOutOfTries(jobId, subId, limit) {
    return this.update(jobId, (j) => {
      const s = j.subJobs.find((x) => x.id === subId);
      declareOutOfTries(j, s, limit, Date.now());
      record(j, s, 'declare-red', null, `Declared ${quoted(s.title)} red to you: ${limit} automatic ${limit === 1 ? 'try' : 'tries'} used`);
    });
  }
  claim(jobId, subJobId, phase, extra = {}) {
    // One run per sub-job, one plan run, and one per conversation (job-talk.js):
    // conversations answer alongside each other and alongside a plan change.
    const clash = (r) => runnable(r) && r.subJobId === subJobId && (r.convo || null) === (extra.convo || null);
    const job = this.data.jobs.find((j) => j.id === jobId);
    if (!job || job.paused || job.budgetPaused || job.cancelledAt || this.data.settings.paused
      || job.runs.some(clash)
      || this.data.jobs.flatMap((j) => j.runs).filter(holdsSlot).length >= this.data.settings.concurrency) return null;
    return this.change((d) => {
      const j = d.jobs.find((j) => j.id === jobId);
      const active = d.jobs.flatMap((j) => j.runs).filter(holdsSlot);
      if (!j || j.paused || j.budgetPaused || j.cancelledAt || d.settings.paused || active.length >= d.settings.concurrency) return null;
      if (j.runs.some(clash)) return null;
      const run = { id: uid('run'), subJobId, phase, model: launchModel(j), effort: launchEffort(j), startedAt: Date.now(), sessionId: null, stopped: false, report: null, ...extra };
      // What its prompt tells it to draft, kept so a Writes switch mid-run
      // reaches the next launch rather than refusing this one's receipt.
      if (phase === 'session') run.drafting = toDraft(j, j.subJobs.find((s) => s.id === subJobId)).map((w) => w.id);
      // A new planner reads the whole conversation from its prompt, so nothing is left to mail it.
      if (phase === 'planning') for (const m of unsentIdea(j)) m.sentAt = run.startedAt;
      for (const a of convoById(j, extra.convo)?.pending?.asks || []) a.sentAt ??= run.startedAt;
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
  // `meta.treeHash` is the working tree as the tool handler read it when a ready
  // receipt arrived (tools.js): the store is synchronous and takes no git.
  report(caller, runId, input, meta = {}) {
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
      const expected = { planning: ['plan', 'reply'], write: [], implementation: ['ready', 'reply', 'published'], publish: ['published'], repair: ['repaired'], verify: ['deployed'], session: ['completed', 'drafts'] }[r.phase];
      if (!expected.length) throw new Error('This run predates session-owned writes; stop now');
      // Going up one level is always open: blocked and escalate from any step, replan
      // from every step but the planner's own (which has no one above it but you).
      const up = report.kind === 'blocked' || report.kind === 'escalate' || (report.kind === 'replan' && r.phase !== 'planning');
      if (!expected.includes(report.kind) && !up) throw new Error(`This run must submit ${expected.join(' or ')}`);
      // A conversation's wrangler answers or proposes; declaring a step red is the red planner's.
      if (r.ask && report.kind === 'escalate') throw new Error('Answer in this conversation with kind:"reply", or propose with kind:"plan"; only the planner sent after a red step declares it red');
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
      // A session parked on its ready receipt is answering the human. A reply
      // keeps it parked; a fresh ready is a new round of the same run.
      if (report.kind === 'reply') {
        // A planner's reply is a turn in a New idea's conversation, or an answer in a
        // running job's (job-talk.js): to a question, or to an idea that was only one.
        if (r.phase === 'planning') {
          if (j.cancelledAt) return;
          if (r.ask) answerAsk(j, r, report, Date.now());
          else if (j.stage === 'active') answerReplan(j, r, report, Date.now());
          else plannerReply(j, r, report, Date.now());
          return;
        }
        return this._reply(j, r, s, report);
      }
      if (report.kind === 'plan' && r.phase === 'planning' && inConversation(j) && unsentIdea(j).length) throw new Error(UNSENT_IDEA);
      const parked = r.parkedFor === 'ready' && r.parkedAt && !r.mailedAt;
      if (parked && report.kind === 'ready' && JSON.stringify(r.readyReport) === JSON.stringify(report)) return;
      if (parked && report.kind !== 'blocked') throw new Error('You already reported ready; wait for mail from the human');
      // The proof is checked and kept BEFORE anything is recorded, so a refused
      // receipt leaves no trace and the agent simply fixes it and reports again.
      const live = s && !j.cancelledAt && !s.cancelledAt;
      const proof = report.kind === 'ready' && live ? this._proofOf(j, r, s, report) : null;
      const park = report.kind === 'ready' && live && isPrSub(s) && r.phase === 'implementation' && reviewCode(j);
      r.reportedAt = Date.now();
      if (park) {
        // Not `report`: that ends a run. With the human reviewing, the session
        // waits for them instead (job-parked.js).
        Object.assign(r, { readyReport: report, readyCount: (r.readyCount || 0) + 1, parkedFor: 'ready', parkedAt: Date.now(), mailedAt: null, idleSince: null });
      } else {
        r.report = report;
        if (r.parkedFor) r.parkedAt = null;
      }
      // A receipt racing a cancel is kept on the run for the record but never
      // moves the sub-job: a late `published` must not pull it back out of cleanup,
      // and a late `plan` must not activate a job that was cancelled while planning.
      if (!j.cancelledAt && !s?.cancelledAt) this._applyReceipt(j, r, s, report, proof, meta);
    });
  }
  // A reply answers the human without moving the tree or the round, so an
  // approval already in progress still holds. Its proof is kept under the
  // current round, in files of its own, so it cannot overwrite what was read.
  _reply(j, r, s, report) {
    if (r.parkedFor !== 'ready' || !s?.ready) throw new Error('A reply answers the human after you reported ready; there is nothing to answer');
    if (report.suggest) throw new Error('Only a new idea\'s planner suggests a job');
    if (report.escalate) throw new Error('Only Wrangler answering a step\'s conversation escalates it');
    if (r.parkedAt && !r.mailedAt) {
      if (JSON.stringify(r.lastReply) === JSON.stringify(report)) return;
      throw new Error('You already answered; wait for mail from the human');
    }
    const now = Date.now();
    const id = `msg_${now.toString(36)}${(s.thread?.length || 0).toString(36)}`;
    const round = s.ready.round;
    const [kept] = report.shots || report.run ? adoptEvidence({ jobId: j.id, subId: s.id, round, prefix: `${id}-`, proof: [{ text: report.text, shots: report.shots, run: report.run }] }) : [null];
    sayInThread(s, { id, at: now, from: 'agent', text: report.text, round, ...(kept?.shots ? { shots: kept.shots } : {}), ...(report.run ? { run: report.run } : {}) });
    answered(s);
    if (report.running) setRunning(s, report.running, { round, keep: true, now });
    Object.assign(r, { lastReply: report, parkedAt: now, mailedAt: null, idleSince: null });
  }
  // The Show me list is answered item by item, each by a check carrying shots, a
  // run or couldNot; the files named are copied into this round's folder. A round
  // is the count of ready receipts this sub-job has had, so a rework never
  // overwrites what the human already read.
  _proofOf(j, r, s, report) {
    const missing = unansweredShow(s.show, report.checks);
    if (missing.length) throw new Error(`Show me: answer ${missing.map((m) => `"${m}"`).join(', ')} with a check of that exact text carrying shots, run or couldNot`);
    const round = Math.max(s.rounds || 0, j.runs.filter((x) => x.subJobId === s.id && x.id !== r.id && x.report?.kind === 'ready').length) + 1;
    const proofs = report.checks.filter((c) => typeof c !== 'string');
    return { round, proof: adoptEvidence({ jobId: j.id, subId: s.id, round, proof: proofs }) };
  }
  // The one road an approved plan change takes, by the human's click or by Wrangler
  // itself under Red steps; the history reads the same either way.
  _approveReplan(j, proposalId, option, by = null) {
    const { lines, detail, feedback: asked, sentBack } = approveReplan(j, proposalId, { now: Date.now(), buildSubJob, option });
    j.repos = planRepos(j.plan);
    record(j, null, sentBack ? 'replan-sent-back' : 'approve-replan', sentBack ? null : asked.slice(0, 180), by ? `${detail} (${by})` : detail);
    for (const l of lines) record(j, l.sub, sentBack ? 'replan-sent-back' : 'replan', null, l.detail);
    return { sentBack: !!sentBack };
  }
  _applyReceipt(j, r, s, report, proof = null, meta = {}) {
    if (report.kind === 'plan' && j.stage === 'active') {
      // A question that turned out to ask for a change is proposed as one.
      // Queued behind a change still being drawn, it is planned afresh in its turn.
      if (r.ask && askToReplan(j, r, requestReplan, Date.now()).queued) return;
      // Discarded while the planner worked: kept on the run, applied nowhere.
      if (j.replan) {
        proposeReplan(j, r, report, Date.now());
        if (j.replan.red) {
          const fate = settleProposal(j, r, { now: Date.now(), apply: () => this._approveReplan(j, j.replan.proposal.id, 0, 'Red steps: Wrangler replans') });
          if (fate === 'declared') record(j, null, 'declare-red', null, 'Declared the red step to you');
        } else if (forwardsOnly(j.replan.proposal)) {
          // A pin that fails here leaves the proposal waiting, as any other would.
          const before = structuredClone(j);
          try { this._approveReplan(j, j.replan.proposal.id, 0, 'Forwarded without a prompt'); }
          catch { for (const k of Object.keys(j)) delete j[k]; Object.assign(j, before); }
        }
      }
      return;
    }
    // A plan change discarded or approved while its planner worked: what that planner
    // says now is about nothing, kept on the run like a stale plan.
    if ((report.kind === 'blocked' || report.kind === 'escalate') && !s && r.phase === 'planning' && !r.ask && j.stage === 'active' && !j.replan) return;
    // The planner says a red step is beyond a fix: declared to the human, its
    // options (when it gave any) waiting in the proposal view.
    if (report.kind === 'escalate' && !s) {
      if (!j.replan && !report.sub) throw new Error('Name the sub-job you are declaring red (sub)');
      const sub = j.subJobs.find((x) => x.id === (report.sub || j.replan?.red?.sub));
      escalate(j, r, report, { now: Date.now(), propose: proposeOptions });
      record(j, sub, 'declare-red', null, `Declared ${quoted(sub.title)} red to you`);
      return;
    }
    if (report.kind === 'blocked' && !s && r.ask) { askFailed(j, r, report.summary, Date.now()); return; }
    if (report.kind === 'blocked' && !s && j.replan?.red) {
      failRedReplan(j, r, report.summary, Date.now());
      return;
    }
    if (report.kind === 'blocked' && !s && replanFailed(j, r, report.summary, Date.now())) return;
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
      // One run can report ready several times (each a round), so a later
      // receipt carries its count: approval is pinned to exactly one of them.
      const receiptId = (r.readyCount || 1) > 1 ? `${r.id}#${r.readyCount}` : r.id;
      if (s.ready?.round && proof && r.parkedFor === 'ready') (s.earlier ||= []).push({ round: s.ready.round, checks: s.ready.checks, ...(s.ready.proof ? { proof: s.ready.proof } : {}), at: s.ready.at });
      s.ready = { checks: report.checks.map(checkText), ...(proof?.proof.length ? { proof: proof.proof } : {}), ...(proof ? { round: proof.round } : {}), ...(meta.treeHash ? { treeHash: meta.treeHash } : {}), receiptId, at: Date.now() }; s.note = null; s.stage = 'review'; s.state = 'verified';
      if (proof) s.rounds = proof.round;
      answered(s);
      // What it left running is kept only for a human to try: Code on Auto, or a
      // receipt that did not park, owes it all straight to teardown.
      if (report.running || runningOf(s).length) setRunning(s, report.running || [], { round: s.ready.round || 1, keep: reviewCode(j) && r.parkedFor === 'ready', now: Date.now() });
      if (r.parkedFor === 'ready' && proof?.round > 1) sayInThread(s, { id: `msg_${Date.now().toString(36)}r`, at: Date.now(), from: 'system', text: `Ready again with new proof.`, round: proof.round });
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
    // The event box on the card: the agent's own sentence. All three go up one
    // level, to the planner (job-runner.js triageRed), and on to the human only
    // when it escalates, runs out of tries, or red handling is off.
    if (report.kind === 'blocked' || report.kind === 'replan') {
      const target = s || j;
      target.error = report.summary;
      target.blocked = { summary: report.summary, phase: r.phase, at: Date.now(), ...(report.kind === 'replan' ? { kind: 'replan', ...(report.why ? { why: report.why } : {}) } : {}) };
    }
    if (report.kind === 'escalate' && s) {
      if (report.options?.length) throw new Error('Only the planner can attach options to an escalation; say the decision you need in ask');
      s.error = report.summary.split('\n')[0].slice(0, 240);
      s.blocked = { summary: s.error, phase: r.phase, at: Date.now(), kind: 'escalate' };
      declareRed(j, s, { summary: report.summary, tried: report.tried, ask: report.ask, by: 'agent' }, Date.now());
      record(j, s, 'declare-red', null, `${quoted(s.title)} was declared red to you by its agent`);
    }
  }
}
