import { isPrSub, isWriteSub, isStoryCreate, isMakeWrite, withStoryCreates } from './jobs-schema.js';
import { dropSub, reworkSub, validatePlan, notStarted } from './job-moves.js';
import { milestoneReached } from './job-writes.js';

// Changing the plan of a job that is already running. The human asks with
// feedback, a planning session proposes a whole plan, and nothing changes until
// the human approves that proposal — the same contract as the first plan, with
// one difference: some of the plan has already happened. Pure over the job draft
// job-store.js is about to persist, like job-moves.js.
//
// Frozen is delivered or past the point of no return: merged (deployment onward),
// a session or human task that finished (a session rerun only for its writes
// included), or already dropped. A proposal may not touch one, and one it leaves
// out is carried over as it stands — the plan is the record of what this job
// did, not only of what it still will.
export const isFrozen = (sub) => !!sub.cancelledAt || ['deployment', 'cleanup', 'done'].includes(sub.stage) || !!sub.mergedAt || !!sub.deployed || !!sub.writesOnly;
// A session's milestone, and a write's action, making session, review flag,
// reason and the channel or page it names are what it IS, so they edit like a
// brief: same place, different write.
const EDITABLE = ['title', 'brief', 'check', 'after', 'action', 'on', 'by', 'review', 'why', 'place'];
// Kind, repository, story and place type decide where a sub-job's work lives
// (its worktree, its PR, its ticket, its channel), so changing one is new work
// under a new id, not an edit.
const FIXED = ['kind', 'repo', 'storyId', 'place.type'];
const fixedOf = (s, k) => (k === 'place.type' ? s.place?.type : s[k]);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const norm = (s) => ({ ...s, kind: s.kind || 'pr', after: s.after || [], check: s.check || undefined });
const quoted = (title) => `“${title}”`;
const liveRun = (job, subId) => job.runs.some((r) => !r.stopped && r.subJobId === subId);
// Code written to the old brief, or cut from a base without the new
// prerequisites, must not merge as if it met the new plan.
const REWORKS = ['brief', 'after'];
const hasCode = (sub) => isPrSub(sub) && (sub.stage === 'review' || (sub.stage === 'pr' && !!sub.pr));

// The proposal laid over the current plan: what each sub-job becomes, and the
// merged plan approval would install. Throws the first rule the proposal breaks,
// which is the agent's to fix when it reports and the human's to read when the
// job moved under a proposal they are about to approve.
export function mergeReplan(job, proposal) {
  const current = new Map(job.plan.subJobs.map((s) => [s.id, s]));
  const live = new Map(job.subJobs.map((s) => [s.id, s]));
  const proposed = new Map(proposal.subJobs.map((s) => [s.id, norm(s)]));
  const frozen = job.subJobs.filter(isFrozen).map((s) => s.id);
  const changes = { frozen, kept: [], edited: [], added: [], removed: [] };
  const subJobs = [];
  for (const p of job.plan.subJobs) {
    const next = proposed.get(p.id);
    const sub = live.get(p.id);
    if (!sub || frozen.includes(p.id)) {
      if (next && (EDITABLE.some((k) => !same(norm(p)[k], next[k])) || FIXED.some((k) => !same(fixedOf(norm(p), k), fixedOf(next, k))))) throw new Error(`${p.id} has already ${sub?.cancelledAt ? 'been dropped' : 'landed'}; keep it exactly as it is`);
      subJobs.push(p); continue;
    }
    // Stories outlive every proposal, so the write that creates one does too,
    // and the session that makes it: a planner that leaves either out has only
    // stopped repeating it.
    if (!next && (isStoryCreate(p) || job.plan.subJobs.some((w) => isStoryCreate(w) && w.by === p.id))) { changes.kept.push(p.id); subJobs.push(p); continue; }
    if (!next) { changes.removed.push(p.id); subJobs.push(p); continue; }
    const fixed = FIXED.filter((k) => !same(fixedOf(norm(p), k), fixedOf(next, k)));
    if (fixed.length) throw new Error(`${p.id}: ${fixed.join(', ')} cannot change; remove it and add the new work under a new id`);
    const fields = EDITABLE.filter((k) => !same(norm(p)[k], next[k]));
    if (fields.length) changes.edited.push({ id: p.id, fields });
    else changes.kept.push(p.id);
    subJobs.push({ ...p, ...Object.fromEntries(EDITABLE.map((k) => [k, next[k]])) });
  }
  for (const s of proposal.subJobs) if (!current.has(s.id)) { changes.added.push(s.id); subJobs.push(norm(s)); }
  // An existing story keeps its key: it is part of what the human already agreed
  // to. A new keyless one gets its own create write (below).
  const stories = [...job.plan.stories];
  for (const t of proposal.stories || []) {
    const had = stories.find((x) => x.id === t.id);
    if (!had) stories.push(t);
    else if (t.key && had.key && t.key !== had.key) throw new Error(`${t.id} was approved as ${had.key}; keep that key`);
  }
  // A write handed to a session that has already finished would never be made.
  const moved = new Set([...changes.added, ...changes.edited.filter((e) => e.fields.includes('by')).map((e) => e.id)]);
  for (const s of subJobs) {
    if (!isWriteSub(s) || !moved.has(s.id) || !live.has(s.by) || !isFrozen(live.get(s.by))) continue;
    throw new Error(`${s.id}: ${s.by} has already finished, so it would never make this write; give it to a session still to run, or add a new one`);
  }
  const gone = new Set([...changes.removed, ...job.subJobs.filter((s) => s.cancelledAt).map((s) => s.id)]);
  // A write goes with the session that would have made it.
  for (const s of subJobs) {
    if (!isWriteSub(s) || !gone.has(s.by) || gone.has(s.id) || frozen.includes(s.id)) continue;
    if (!current.has(s.id)) throw new Error(`${s.id} would never be made: ${s.by} is being cancelled`);
    changes.kept = changes.kept.filter((x) => x !== s.id); changes.edited = changes.edited.filter((e) => e.id !== s.id);
    changes.removed.push(s.id); gone.add(s.id);
  }
  for (const s of subJobs) {
    if (gone.has(s.id) || frozen.includes(s.id)) continue;
    const dead = s.after.filter((id) => gone.has(id));
    if (dead.length) throw new Error(`${s.id} would wait forever on ${dead.join(', ')}, which ${dead.length === 1 ? 'is' : 'are'} being cancelled`);
    // An if-dropped session is exactly what a cancelled trigger starts; any
    // other milestone it has not reached by now it never will.
    if (s.on && gone.has(s.on.sub) && s.on.at !== 'dropped' && !milestoneReached(live.get(s.on.sub), s.on.at)) {
      throw new Error(`${s.id} would wait forever on ${s.on.sub}, which is being cancelled`);
    }
  }
  const workflows = { ...(job.plan.workflows || {}), ...(proposal.workflows || {}) };
  const jiraSite = proposal.jiraSite || job.plan.jiraSite;
  let plan = { context: proposal.context || job.plan.context, stories, workflows, ...(jiraSite ? { jiraSite } : {}), subJobs: subJobs.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))) };
  // A new keyless story is created by its own write, exactly as on first
  // approval: by the stories session if it has not started, else a new one.
  const before = new Set(plan.subJobs.map((s) => s.id));
  plan = withStoryCreates(plan, (id) => !live.has(id) || notStarted(job, id));
  for (const s of plan.subJobs) if (!before.has(s.id)) changes.added.push(s.id);
  validatePlan(plan);
  return { plan, changes };
}

// A request replaces any proposal still waiting: the planner reads that one as
// what the human just asked it to change.
export function requestReplan(job, feedback, now) {
  if (job.stage !== 'active') throw new Error('Only a running job has a plan to change');
  if (job.runs.some((r) => !r.stopped && !r.subJobId)) throw new Error('Wait for the planning step to finish');
  const text = String(feedback || '').trim().slice(0, 8000);
  if (!text) throw new Error('Explain the change you want');
  clearPlanningError(job);
  job.replan = { feedback: text, at: now, proposal: null, previous: job.replan?.proposal?.plan || null };
}

// A planning session that died or blocked set the job's error, which holds the
// whole job; once its replan is gone (discarded, approved or asked again), so is
// the reason to hold it.
function clearPlanningError(job) {
  if (job.runs.filter((r) => !r.subJobId).at(-1)?.phase === 'planning') { job.error = null; job.blocked = null; }
}

export function discardReplan(job) {
  if (!job.replan) throw new Error('No plan change is pending');
  clearPlanningError(job);
  job.replan = null;
}

// The receipt of a re-planning run is a proposal, never the plan. Merged here so
// a proposal that breaks a rule is refused to the agent that can still fix it.
export function proposeReplan(job, run, plan, now) {
  const { plan: merged, changes } = mergeReplan(job, plan);
  job.replan = { ...job.replan, proposal: { id: run.id, plan, merged, changes, at: now } };
}

// Pinned to the proposal the human read, and merged again against the job as it
// is now: something may have landed since, which is fine unless the proposal
// changes it. An edit under a live step would change the brief out from under
// the session working to it; launches are held while a proposal waits, so the
// step finishes and the human approves again.
export function approveReplan(job, proposalId, { now, buildSubJob }) {
  const proposal = job.replan?.proposal;
  if (!proposal || proposal.id !== proposalId) throw new Error('The proposal changed. Review the latest version before approving.');
  const { plan, changes } = mergeReplan(job, proposal.plan);
  // A write is busy while its session runs, the one it leaves or the one it
  // goes to: that session was told its writes as they stood, and a parked one is
  // waiting on its drafts.
  const specOf = (id) => plan.subJobs.find((s) => s.id === id);
  const busy = [...changes.edited.map((e) => e.id), ...changes.added].filter((id) => liveRun(job, id) || liveRun(job, job.subJobs.find((s) => s.id === id)?.by)
    || (isWriteSub(specOf(id)) && liveRun(job, specOf(id).by))).map((id) => (job.subJobs.find((s) => s.id === id) || specOf(id)).title);
  if (busy.length) throw new Error(`Wait for the running step on ${busy.map(quoted).join(' · ')} to stop`);
  const lines = [];
  for (const { id, fields } of changes.edited) {
    const sub = job.subJobs.find((s) => s.id === id);
    const spec = plan.subJobs.find((s) => s.id === id);
    for (const k of EDITABLE) { if (spec[k] === undefined) delete sub[k]; else sub[k] = spec[k]; }
    // A changed write waits for its session afresh, and a reviewed one is drafted
    // again: an approval was of what it said before. A made output in review
    // already exists: it stays there for Accept.
    if (isWriteSub(sub) && ['write', 'review'].includes(sub.stage) && !(isMakeWrite(sub) && sub.result)) { sub.stage = 'write'; sub.state = 'queued'; sub.error = null; sub.blocked = null; delete sub.writeApprovedAt; delete sub.draft; }
    lines.push({ sub, detail: `Plan change edited ${quoted(spec.title)} (${fields.join(', ')})` });
    // The rework launches once the new prerequisites have landed (job-runner.js).
    if (hasCode(sub) && fields.some((k) => REWORKS.includes(k))) {
      lines.push({ sub, detail: reworkSub(job, sub, `${job.replan.feedback}\n\nNew brief: ${spec.brief}`, now) });
    }
  }
  // Installed first: a story's create dropped here unlinks the story on it.
  job.plan = plan;
  for (const id of changes.removed) {
    const sub = job.subJobs.find((s) => s.id === id);
    dropSub(sub, now, job); sub.superseded = true;
    lines.push({ sub, detail: `Plan change cancelled ${quoted(sub.title)}${sub.pr?.url ? `; its PR stays open on GitHub` : ''}` });
  }
  for (const id of changes.added) {
    const sub = buildSubJob(plan, plan.subJobs.find((s) => s.id === id));
    job.subJobs.push(sub);
    lines.push({ sub, detail: `Plan change added ${quoted(sub.title)}` });
  }
  // A session waiting on review of its result runs again for a write it now has
  // to make, as Retry on a failed write sends it (job-writes.js reopenWrite).
  const reopened = new Set();
  for (const id of [...changes.added, ...changes.edited.map((e) => e.id)]) {
    const w = job.subJobs.find((s) => s.id === id);
    const session = isWriteSub(w) && w.stage === 'write' && !w.cancelledAt ? job.subJobs.find((s) => s.id === w.by) : null;
    if (session?.stage !== 'review' || reopened.has(session.id)) continue;
    session.stage = 'session'; session.state = 'queued'; session.result = null;
    reopened.add(session.id);
    lines.push({ sub: session, detail: `Plan change sent ${quoted(session.title)} back to work to make ${quoted(w.title)}` });
  }
  const summary = [changes.added.length && `${changes.added.length} added`, changes.edited.length && `${changes.edited.length} edited`,
    changes.removed.length && `${changes.removed.length} cancelled`].filter(Boolean).join(', ') || 'no sub-job changed';
  const feedback = job.replan.feedback;
  clearPlanningError(job);
  job.replan = null;
  return { lines, detail: `Changed the plan: ${summary}`, feedback };
}

// The re-planner's view of the job: every sub-job as it stands, which ones are
// frozen, and the plan they came from.
export function replanStatus(job, sub) {
  const pr = isPrSub(sub) && sub.pr?.url ? ` · PR ${sub.pr.url}` : '';
  const write = isWriteSub(sub) ? ` · ${JSON.stringify(sub.place || { type: 'jira' })} ${JSON.stringify(sub.action)}${sub.by ? ` by ${sub.by}` : ' (predates session-owned writes)'}${sub.result?.url ? ` · at ${sub.result.url}` : ''}`
    : sub.on ? ` · on ${sub.on.sub}/${sub.on.at}` : '';
  const run = liveRun(job, sub.id) ? ' · a step is running' : '';
  const state = sub.cancelledAt ? 'cancelled' : `${sub.stage}${sub.state ? `/${sub.state}` : ''}`;
  return `- ${sub.id} (${sub.kind || 'pr'}) ${JSON.stringify(sub.title)}: ${state}${pr}${write}${run}${isFrozen(sub) ? ' · FROZEN' : ''}`;
}
