import { planSchema, isWriteSub, isHumanSub, MAX_BRIEF, MAX_HUMAN_BRIEF, isJiraWrite, isStoryCreate, reviewCode } from './jobs-schema.js';

// What the runner, a plan change and request-change (job-change.js) share about
// a sub-job: dropping one, reworking its code, validating a plan. Pure over the
// job draft job-store.js is about to persist, and never touches disk.
const liveRun = (job, subId) => job.runs.some((r) => !r.stopped && r.subJobId === subId);
// A session that may still take another write: waiting, and never run.
export const notStarted = (job, id) => { const s = job.subJobs.find((x) => x.id === id); return !!s && s.stage === 'session' && !s.sessions?.length && !s.cancelledAt && !liveRun(job, id); };
const quoted = (title) => `“${title}”`;
// planSchema is the same judge the plan was approved under (unique ids, unknown
// story/dependency, cycles, repo rules), so a plan edit reuses it on a projection of
// the plan and only commits once it passes — nothing here half-edits a plan it
// is about to refuse. A migrated plan may carry a brief longer than today's cap;
// it is not what is being changed, so the throwaway projection trims it rather
// than refusing an unrelated move. A write from before session-owned writes
// names no session (`by`): the store failed it on load (job-store.js), it is
// never what an edit changes, and it must not make every edit on its job fail.
export function validatePlan(plan) {
  const projected = { ...plan, subJobs: plan.subJobs.filter((s) => !(isWriteSub(s) && !s.by)).map((s) => ({ ...s, brief: String(s.brief || 'x').slice(0, isHumanSub(s) ? MAX_HUMAN_BRIEF : MAX_BRIEF) })) };
  const parsed = planSchema.safeParse(projected);
  if (!parsed.success) throw new Error([...new Set(parsed.error.issues.map((i) => i.message))].join('; '));
}

// Straight to cleanup. The runner stops any live step; nothing merged, so
// cleanup keeps every commit it cannot prove is retained elsewhere. Shared by
// a whole-job cancel (job-store.js), a plan change that cancels a sub-job and a
// not-needed session (job-runner.js), so none can disagree about dropping. Given the job, a story's create
// takes the story with it (`unlinkStory`); a whole-job cancel has no need.
export function dropSub(sub, now, job = null) {
  sub.cancelledAt = now; sub.stage = 'cleanup'; sub.state = 'cancelled';
  sub.error = null; sub.blocked = null; sub.observationError = null;
  if (job && isStoryCreate(sub)) unlinkStory(job, sub.storyId, now);
}
// A red step started again as it is: the human's Retry, and the planner's retry
// action once the human approves it (job-actions.js). Under review the only run
// that can have failed is publish, and the tree the human approved is unchanged:
// keep the approval so publish runs again. `queued` here would strand the card —
// the runner launches only on `approved`, and approve-code refuses anything but
// `verified`.
export function retrySub(sub, note) {
  sub.error = null; sub.blocked = null; sub.cleanupRefusal = null; sub.discard = null;
  sub.state = sub.cancelledAt ? 'cancelled' : sub.stage === 'review' ? (sub.ready?.approvedAt ? 'approved' : 'verified') : 'queued';
  sub.repairAllowance = (sub.repairAllowance || 0) + 1;
  // One more automatic try for a red step, and it wipes the human's "leave it"
  // on that failure.
  sub.replanAllowance = (sub.replanAllowance || 0) + 1;
  if (sub.red) sub.red = { ...sub.red, held: null, declared: null };
  if (note) sub.note = note;
}
// A created story's key, from its create's receipt or a receipt: on
// the plan and on every sub-job naming it, which is what releases them. An
// approved key is part of what the human agreed to and never swaps.
export function keyStory(job, storyId, key) {
  const story = job.plan.stories.find((t) => t.id === storyId);
  if (!story) throw new Error(`Unknown story: ${storyId}`);
  if (story.key && story.key !== key) throw new Error(`${storyId} was approved as ${story.key}; keep that key`);
  story.key = key;
  for (const sub of [...job.subJobs, ...job.plan.subJobs]) if (sub.storyId === storyId && !sub.jiraKey) sub.jiraKey = key;
}
// Its create dropped before it minted a key, a story will never have one: what
// named it goes ahead ticketless (its branch and commits carry no key), except a
// Jira write to it, which has no ticket to write to and is dropped too. Plan
// entries follow their live sub-job; the story stays as the record, `dropped`
// so nothing creates it again.
function unlinkStory(job, storyId, now) {
  const story = job.plan?.stories.find((t) => t.id === storyId);
  if (!story || story.key) return;
  story.dropped = true;
  const unlinked = new Set();
  for (const s of job.subJobs) {
    if (s.storyId !== storyId || s.jiraKey || s.cancelledAt) continue;
    if (isJiraWrite(s)) dropSub(s, now);
    else { delete s.storyId; unlinked.add(s.id); }
  }
  for (const p of job.plan.subJobs) if (unlinked.has(p.id)) delete p.storyId;
}
// Rework code that already exists: an open PR or an uncommitted working tree.
// Shared by request-change (job-change.js) and an approved plan change
// (job-replan.js) that rewrites one.
export function reworkSub(job, sub, note, now) {
  sub.error = null; sub.blocked = null; sub.mergeApprovedHead = null;
  // Under code review a fix is the same road as the first cut: back to work in
  // the PR's worktree, the human reads the uncommitted diff, and approval
  // releases the publish session that pushes it to the open PR. A repair that
  // commits straight to the branch would skip the very review the flag exists
  // for. Without a PR nothing is committed either way, and an approval already
  // given is withdrawn.
  if (sub.stage === 'review' || reviewCode(job)) {
    const wasPr = sub.stage === 'pr';
    sub.note = note || null; sub.ready = null; sub.fixRequested = null; sub.stage = 'implementation'; sub.state = 'queued';
    return wasPr ? `Sent ${quoted(sub.title)} back to work on its PR` : `Sent ${quoted(sub.title)} back to work`;
  }
  // Deliberately independent of checkStatus: the human has seen something
  // green checks do not cover, so a repair launches anyway.
  sub.fixRequested = { note: note || null, at: now };
  sub.state = 'watching'; sub.nextPollAt = 0;
  sub.repairAllowance = (sub.repairAllowance || 0) + 1;
  return `Asked for a new commit on ${quoted(sub.title)}`;
}
