import { isPrSub, isWriteSub, isStoryCreate, isMakeWrite, withStoryCreates } from './jobs-schema.js';
import { dropSub, reworkSub, validatePlan, notStarted } from './job-sub-ops.js';
import { milestoneReached } from './job-writes.js';
import { stampActions, checkActions, applyActions, movedActions, landedAs } from './job-actions.js';
import { parkedReadyRun } from './job-parked.js';
import { noteProposal, closeProposal, noteQueued, noteDequeued } from './job-talk.js';
import { replanAsks, replanAsked } from '../public/replan-asks.js';

// Changing the plan of a job that is already running. The human asks with
// feedback, a planning session proposes a whole plan, and nothing changes until
// the human approves that proposal — the same contract as the first plan, with
// one difference: some of the plan has already happened. Pure over the job draft
// job-store.js is about to persist, like job-sub-ops.js.
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
const EDITABLE = ['title', 'brief', 'check', 'show', 'after', 'action', 'on', 'by', 'review', 'why', 'place'];
// Kind, repository, story and place type decide where a sub-job's work lives
// (its worktree, its PR, its ticket, its channel), so changing one is new work
// under a new id, not an edit. A PR's base is the same until its worktree or PR
// exists: before that it is only a plan.
const FIXED = ['kind', 'repo', 'storyId', 'place.type'];
const baseFixed = (sub) => !!(sub?.worktree || sub?.pr);
const fixedOf = (s, k) => (k === 'place.type' ? s.place?.type : s[k]);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const norm = (s) => ({ ...s, kind: s.kind || 'pr', after: s.after || [], check: s.check || undefined, show: s.show?.length ? s.show : undefined });
const quoted = (title) => `“${title}”`;
// What a frozen sub-job may not change: anything that would make it a different step.
const respecs = (p, next) => [...EDITABLE, 'base'].some((k) => !same(norm(p)[k], next[k])) || FIXED.some((k) => !same(fixedOf(norm(p), k), fixedOf(next, k)));
// A session parked on its ready receipt is only waiting for the human (job-parked.js);
// a plan change that reworks its sub-job simply ends it.
const liveRun = (job, subId) => job.runs.some((r) => !r.stopped && r.parkedFor !== 'ready' && r.subJobId === subId);
// Code written to the old brief, or cut from a base without the new
// prerequisites, must not merge as if it met the new plan.
const REWORKS = ['brief', 'after'];
const hasCode = (sub) => isPrSub(sub) && (sub.stage === 'review' || (sub.stage === 'pr' && !!sub.pr));
// An open PR that only gained prerequisites keeps its code: it waits for them,
// then its branch takes them from the base and its checks run again, with no
// agent (job-runner.js). A new brief still sends it back to work.
const catchesUp = (sub, fields) => isPrSub(sub) && sub.stage === 'pr' && !!sub.pr?.url && fields.includes('after') && !fields.includes('brief');
// Mirrors approveReplan's own test for a red step with no code (PR #220).
const requeues = (sub, fields) => !!sub.error && !isWriteSub(sub) && fields.some((k) => REWORKS.includes(k));
const landed = (dep) => !!dep && (isPrSub(dep) ? !!dep.deployed : dep.stage === 'done' && !dep.cancelledAt);
// What approval does to each step the proposal adds or sends back, in the words
// its card shows: when it starts, and what it waits for.
const MILESTONE = { started: () => 'starts', pr: () => 'opens its PR', merged: () => 'merges', deployed: (t) => (t && !isPrSub(t) ? 'is done' : 'deploys'), dropped: () => 'is dropped' };
function thenOf(job, merged, changes) {
  const live = new Map(job.subJobs.map((s) => [s.id, s]));
  const specOf = (id) => merged.subJobs.find((s) => s.id === id);
  const after = (id) => {
    const waits = (specOf(id).after || []).filter((d) => !landed(live.get(d))).map((d) => quoted(specOf(d)?.title || d));
    const on = specOf(id).on;
    const when = on && !milestoneReached(live.get(on.sub), on.at) ? `once ${quoted(specOf(on.sub)?.title || on.sub)} ${MILESTONE[on.at](specOf(on.sub))}` : '';
    return [waits.length ? `after ${waits.join(', ')}` : '', when].filter(Boolean).join(', ') || 'now';
  };
  const then = {};
  for (const id of changes.added) if (!isWriteSub(specOf(id))) then[id] = `Starts ${after(id)}`;
  for (const { id, fields } of changes.edited) {
    const sub = live.get(id);
    if (catchesUp(sub, fields)) then[id] = `Keeps its PR · branch updated ${after(id)}`;
    else if (hasCode(sub) && fields.some((k) => REWORKS.includes(k))) then[id] = `Back to work ${after(id)}`;
    else if (requeues(sub, fields)) then[id] = `Re-queued · starts ${after(id)}`;
  }
  return then;
}
function catchUp(sub, now) {
  sub.error = null; sub.blocked = null; sub.mergeApprovedHead = null; sub.fixRequested = null;
  if (sub.red) sub.red = { ...sub.red, held: null, declared: null };
  sub.catchUp = { at: now }; sub.state = 'watching'; sub.nextPollAt = 0;
  return `Sent ${quoted(sub.title)} to wait for its new prerequisites, then update its branch`;
}

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
      if (next && respecs(p, next)) throw new Error(`${quoted(p.title)}: ${p.id} has already ${sub?.cancelledAt ? 'been dropped' : 'landed'}; keep it exactly as it is`);
      subJobs.push(p); continue;
    }
    // Stories outlive every proposal, so the write that creates one does too,
    // and the session that makes it: a planner that leaves either out has only
    // stopped repeating it.
    if (!next && (isStoryCreate(p) || job.plan.subJobs.some((w) => isStoryCreate(w) && w.by === p.id))) { changes.kept.push(p.id); subJobs.push(p); continue; }
    if (!next) { changes.removed.push(p.id); subJobs.push(p); continue; }
    const fixed = FIXED.filter((k) => !same(fixedOf(norm(p), k), fixedOf(next, k)));
    if (fixed.length) throw new Error(`${p.id}: ${fixed.join(', ')} cannot change; remove it and add the new work under a new id`);
    if (!same(p.base, next.base) && baseFixed(sub)) throw new Error(`${p.id}: base cannot change, its branch is already cut${sub.pr ? ' and its PR open' : ''}; remove it and add the new work under a new id`);
    const fields = [...EDITABLE, 'base'].filter((k) => !same(norm(p)[k], next[k]));
    if (fields.length) changes.edited.push({ id: p.id, fields });
    else changes.kept.push(p.id);
    subJobs.push({ ...p, ...Object.fromEntries([...EDITABLE, 'base'].map((k) => [k, next[k]])) });
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

// A request replaces any proposal still waiting: the planner reads that one (its
// plan and its actions) as what the human just asked it to change, and the ideas
// add up, so a later one never drops an earlier one: kept as a flat list (latest as
// `feedback`, the rest in `earlier`; public/replan-asks.js), never wrapped in the
// last, and the oldest dropped past the cap. `source` is the step and view
// the latest idea was typed on (job-actions.js holds the step's actions to it);
// `images` are every idea's pictures, for a forward to carry into a thread.
// `running` is the ask run handing its question over as a change, and `convo` the
// conversation its card is drawn in (job-talk.js). Ask runs answer alongside it.
// One sent while the wrangler is drafting (or behind others already waiting) joins
// the FIFO `job.replanQueue` instead, and is planned on its own once the change
// ahead is approved or discarded (startQueued). Returns `{ queued: n }`, its place.
export const REPLAN_FEEDBACK_MAX = 16000;
export const replanQueue = (job) => job.replanQueue || [];
// A planner still writing the proposal for `job.replan`; one that has reported is done.
const drafting = (job, except = null) => job.runs.some((r) => !r.stopped && !r.report && !r.subJobId && !r.ask && r.id !== except);
// A change set but not yet claimed by a planner (a red triage, a dequeued idea,
// slots full) is being drawn all the same: an ask run's hand-over must not become
// its proposal. One whose planner died (`job.error`) takes the next idea as its own.
const undrawn = (job) => !!job.replan && !job.replan.proposal && !job.error;
export function requestReplan(job, feedback, now, red = null, { source = null, images = [], running = null, convo = null } = {}) {
  if (job.stage !== 'active') throw new Error('Only a running job has a plan to change');
  const text = String(feedback || '').trim().slice(0, 8000);
  if (!text) throw new Error('Explain the change you want');
  if (!job.replan?.proposal && (drafting(job, running) || (running && undrawn(job)) || (!job.replan && replanQueue(job).length))) {
    (job.replanQueue ||= []).push({ feedback: text, at: now, ...(source ? { source } : {}), ...(images.length ? { images } : {}), ...(convo ? { convo } : {}), ...(red ? { red } : {}) });
    noteQueued(job, convo, job.replanQueue.length, now);
    return { queued: job.replanQueue.length };
  }
  startReplan(job, text, now, red, { source, images, convo });
  return {};
}
function startReplan(job, text, now, red, { source, images, convo }) {
  clearPlanningError(job);
  const prev = job.replan;
  if (prev?.proposal) closeProposal(job, prev.proposal.id, 'revised', now);
  const asks = [...replanAsks(prev), text];
  while (asks.length > 1 && asks.join('').length > REPLAN_FEEDBACK_MAX) asks.shift();
  const actions = (prev?.proposal?.actions || []).map(({ pin: _pin, ...a }) => a);
  job.replan = { feedback: text, earlier: asks.slice(0, -1), at: now, proposal: null, previous: prev?.proposal?.plan || prev?.previous || null,
    ...(actions.length ? { previousActions: actions } : prev?.proposal ? {} : prev?.previousActions ? { previousActions: prev.previousActions } : {}),
    ...(source || prev?.source ? { source: source || prev.source } : {}),
    ...(convo || prev?.convo ? { convo: convo || prev.convo } : {}),
    ...(images.length || prev?.images?.length ? { images: [...(prev?.images || []), ...images] } : {}),
    ...(red ? { red } : prev?.red ? { red: { ...prev.red, auto: false, human: true } } : {}) };
}

// The next queued change becomes the plan change, drawn against the plan as it
// stands now; its source still says what the step was when it was typed. Waits while a planner is still drafting (a discarded one stopping): the
// runner tries again each tick.
export const queuedReady = (job) => !job.replan && job.stage === 'active' && !job.cancelledAt && !!replanQueue(job).length && !drafting(job);
export function startQueued(job, now) {
  if (!queuedReady(job)) return false;
  const [next, ...rest] = job.replanQueue;
  if (rest.length) job.replanQueue = rest; else delete job.replanQueue;
  startReplan(job, next.feedback, now, next.red || null, { source: next.source || null, images: next.images || [], convo: next.convo || null });
  noteDequeued(job, next.convo, now);
  return true;
}

// A planning session that died or blocked set the job's error, which holds the
// whole job; once its replan is gone (discarded, approved or asked again), so is
// the reason to hold it.
function clearPlanningError(job) {
  if (job.runs.filter((r) => !r.subJobId && !r.ask).at(-1)?.phase === 'planning') { job.error = null; job.blocked = null; }
}

export function discardReplan(job) {
  if (!job.replan) throw new Error('No plan change is pending');
  clearPlanningError(job);
  if (job.replan.proposal) closeProposal(job, job.replan.proposal.id, 'discarded', Date.now());
  job.replan = null;
  startQueued(job, Date.now());
}

// The receipt of a re-planning run is a proposal, never the plan. Merged here so
// a proposal that breaks a rule is refused to the agent that can still fix it.
// Up to three ranked options: the receipt's own plan first (recommended), then its
// alternatives; each is merged and its actions stamped with the pins they were
// written against, so a bad second option refuses the whole receipt.
export function proposeReplan(job, run, report, now) {
  proposeOptions(job, run, [report, ...(report.alternatives || [])], report.diagnosis ? { diagnosis: report.diagnosis } : {}, now);
}
// The same road for a planner's escalation (job-red.js): its options are the
// proposal the human opens from a declared red.
export function proposeOptions(job, run, options, extra, now) {
  const option = (o) => {
    const { plan: merged, changes } = mergeReplan(job, o.plan);
    return { label: o.label || null, why: o.why || null, leaves: o.leaves || null, plan: o.plan, merged, changes, then: thenOf(job, merged, changes), actions: stampActions(job, o.actions, merged, changes) };
  };
  const [first, ...rest] = options.map(option);
  job.replan = { ...job.replan, proposal: { id: run.id, ...first, ...extra, alternatives: rest, at: now } };
  noteProposal(job, job.replan.proposal, now);
}
// The proposal's options as the human picks between them: the first is the one
// recommended, and the only one a proposal without alternatives has.
export const optionsOf = (proposal) => [proposal, ...(proposal.alternatives || [])];

// Pinned to the proposal the human read, and merged again against the job as it
// is now: something may have landed since, which is fine unless the proposal
// changes it. An edit under a live step would change the brief out from under
// the session working to it; a step the proposal touches does not launch while
// it waits, so the step finishes and the human approves again.
export function approveReplan(job, proposalId, { now, buildSubJob, option = 0 }) {
  const proposal = job.replan?.proposal;
  if (!proposal || proposal.id !== proposalId) throw new Error('The proposal changed. Review the latest version before approving.');
  const chosen = optionsOf(proposal)[option];
  if (!chosen) throw new Error('Choose one of the proposal\'s options');
  let merged;
  try {
    merged = mergeReplan(job, chosen.plan);
    // Every action's pin must still be true, before anything is touched: a claim
    // about a head or merge commit is refused once that has moved.
    checkActions(job, chosen.actions, merged.plan);
  } catch (e) {
    const moved = movedSince(job, chosen);
    if (!moved.length) throw e;
    return sendBack(job, moved, now);
  }
  const { plan, changes } = merged;
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
    for (const k of [...EDITABLE, 'base']) { if (spec[k] === undefined) delete sub[k]; else sub[k] = spec[k]; }
    // A changed write waits for its session afresh, and a reviewed one is drafted
    // again: an approval was of what it said before. A made output in review
    // already exists: it stays there for Accept.
    if (isWriteSub(sub) && ['write', 'review'].includes(sub.stage) && !(isMakeWrite(sub) && sub.result)) { sub.stage = 'write'; sub.state = 'queued'; sub.error = null; sub.blocked = null; delete sub.writeApprovedAt; delete sub.draft; }
    lines.push({ sub, detail: `Plan change edited ${quoted(spec.title)} (${fields.join(', ')})` });
    if (catchesUp(sub, fields)) { lines.push({ sub, detail: catchUp(sub, now) }); continue; }
    // The rework launches once the new prerequisites have landed (job-runner.js).
    if (hasCode(sub) && fields.some((k) => REWORKS.includes(k))) {
      lines.push({ sub, detail: reworkSub(job, sub, `${replanAsked(job.replan)}\n\nNew brief: ${spec.brief}`, now) });
    } else if (sub.error && !isWriteSub(sub) && fields.some((k) => REWORKS.includes(k))) {
      // A step that went red before writing any code starts over on its new
      // brief, once its new prerequisites land, as Retry would send it.
      sub.error = null; sub.blocked = null; sub.state = 'queued';
      if (sub.red) sub.red = { ...sub.red, held: null, declared: null };
      lines.push({ sub, detail: `Sent ${quoted(sub.title)} back to wait for its new brief` });
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
  for (const l of applyActions(job, chosen.actions, { now, images: job.replan.images })) lines.push(l);
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
    changes.removed.length && `${changes.removed.length} cancelled`, chosen.actions?.length && `${chosen.actions.length} ${chosen.actions.length === 1 ? 'action' : 'actions'}`].filter(Boolean).join(', ') || 'no sub-job changed';
  const feedback = job.replan.feedback;
  clearPlanningError(job);
  closeProposal(job, proposal.id, 'approved', now, lines.filter((l) => l.forwarded).map((l) => ({ sub: l.sub.id, message: l.forwarded })));
  job.replan = null;
  startQueued(job, now);
  return { lines, detail: `Changed the plan: ${summary}`, feedback };
}

// What the chosen option touches that has landed, finished or moved since it was
// written: an edit, removal or write's session now frozen, an action's pin gone, or
// a frozen step whose stored entry no longer matches the proposal's copy (a write
// the human edited after the proposal kept it, then made). No refusal it causes
// can ever clear, so the proposal would be dead.
function movedSince(job, chosen) {
  const moved = movedActions(job, chosen.actions, chosen.merged);
  const was = new Set(chosen.changes?.frozen || []);
  const writers = [...(chosen.changes?.added || []), ...(chosen.changes?.edited || []).map((e) => e.id)]
    .map((id) => chosen.merged?.subJobs.find((s) => s.id === id)).filter(isWriteSub).map((s) => s.by);
  for (const id of new Set([...(chosen.changes?.edited || []).map((e) => e.id), ...(chosen.changes?.removed || []), ...writers])) {
    const sub = job.subJobs.find((s) => s.id === id);
    if (!sub || was.has(id) || moved.some((m) => m.sub === sub) || !isFrozen(sub)) continue;
    moved.push({ sub, how: landedAs(sub) || 'has finished' });
  }
  for (const next of chosen.plan?.subJobs || []) {
    const sub = job.subJobs.find((s) => s.id === next.id);
    const p = job.plan.subJobs.find((s) => s.id === next.id);
    if (!sub || !p || !isFrozen(sub) || moved.some((m) => m.sub === sub) || !respecs(p, norm(next))) continue;
    moved.push({ sub, how: `${landedAs(sub) || 'has finished'} and changed` });
  }
  return moved;
}

// A proposal the job moved under goes back to the planner with the human's ideas
// as they were, told what moved, rather than refusing every approval: the stale
// action is never applied, and the planner judges what still stands.
function sendBack(job, moved, now) {
  const what = moved.map(({ sub, how }) => `${quoted(sub.title)} (${sub.id}) ${how}`).join('; ');
  requestReplan(job, `Wrangler, not the human: the human approved your last proposal, but it could not apply because the job moved under it: ${what}. Propose again against the job as it stands now; the human's ideas above still stand.`, now);
  return { lines: moved.map(({ sub, how }) => ({ sub, detail: `${quoted(sub.title)} ${how} since the plan change was proposed, so it went back to Wrangler` })),
    detail: `Sent the plan change back to Wrangler: ${moved.map(({ sub, how }) => `${quoted(sub.title)} ${how}`).join(', ')} since it was proposed`, feedback: job.replan.feedback, sentBack: true };
}

// The re-planner's view of the job: every sub-job as it stands, which ones are
// frozen, and the plan they came from.
export function replanStatus(job, sub) {
  const pr = isPrSub(sub) && sub.pr?.url ? ` · PR ${sub.pr.url}` : '';
  const write = isWriteSub(sub) ? ` · ${JSON.stringify(sub.place || { type: 'jira' })} ${JSON.stringify(sub.action)}${sub.by ? ` by ${sub.by}` : ' (predates session-owned writes)'}${sub.result?.url ? ` · at ${sub.result.url}` : ''}`
    : sub.on ? ` · on ${sub.on.sub}/${sub.on.at}` : '';
  const red = sub.pr?.checkStatus === 'failing' && sub.stage === 'pr' ? ` · checks FAILING at head ${sub.pr.head}${sub.pr.dirty ? ' (merge conflicts)' : ''}`
    : sub.stage === 'deployment' && sub.deploymentResult?.status === 'failing' ? ` · post-merge run FAILING at merge ${sub.pr?.mergeCommit}${sub.recoveredBy ? ` (recovering via ${sub.recoveredBy})` : ''}` : '';
  const run = liveRun(job, sub.id) ? ' · a step is running' : parkedReadyRun(job, sub) && sub.ready ? ` · its session is OPEN on review round ${sub.ready.round || 1}${sub.answering ? ' (answering the last message; forward feedback to it, it is read next)' : ' (forward feedback to it)'}` : '';
  const state = sub.cancelledAt ? 'cancelled' : `${sub.stage}${sub.state ? `/${sub.state}` : ''}`;
  return `- ${sub.id} (${sub.kind || 'pr'}) ${JSON.stringify(sub.title)}: ${state}${pr}${red}${write}${run}${isFrozen(sub) ? ' · FROZEN' : ''}`;
}
