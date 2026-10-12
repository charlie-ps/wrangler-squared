import { isPrSub } from './jobs-schema.js';
import { dropSub, validatePlan } from './job-moves.js';

// Changing the plan of a job that is already running. The human asks with
// feedback, a planning session proposes a whole plan, and nothing changes until
// the human approves that proposal — the same contract as the first plan, with
// one difference: some of the plan has already happened. Pure over the job draft
// job-store.js is about to persist, like job-moves.js.
//
// Frozen is delivered or past the point of no return: merged (deployment onward),
// a session or human task that finished, or already dropped. A proposal may not
// touch one, and one it leaves out is carried over as it stands — the plan is the
// record of what this job did, not only of what it still will.
export const isFrozen = (sub) => !!sub.cancelledAt || ['deployment', 'cleanup', 'done'].includes(sub.stage) || !!sub.mergedAt || !!sub.deployed;
const EDITABLE = ['title', 'brief', 'check', 'after'];
// Kind, repository and story decide where a sub-job's work lives (its worktree,
// its PR, its ticket), so changing one is new work under a new id, not an edit.
const FIXED = ['kind', 'repo', 'storyId'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const norm = (s) => ({ ...s, kind: s.kind || 'pr', after: s.after || [], check: s.check || undefined });
const quoted = (title) => `“${title}”`;
const liveRun = (job, subId) => job.runs.some((r) => !r.stopped && r.subJobId === subId);

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
      if (next && EDITABLE.concat(FIXED).some((k) => !same(norm(p)[k], next[k]))) throw new Error(`${p.id} has already ${sub?.cancelledAt ? 'been dropped' : 'landed'}; keep it exactly as it is`);
      subJobs.push(p); continue;
    }
    if (!next) { changes.removed.push(p.id); subJobs.push(p); continue; }
    const fixed = FIXED.filter((k) => !same(norm(p)[k], next[k]));
    if (fixed.length) throw new Error(`${p.id}: ${fixed.join(', ')} cannot change; remove it and add the new work under a new id`);
    const fields = EDITABLE.filter((k) => !same(norm(p)[k], next[k]));
    if (fields.length) changes.edited.push({ id: p.id, fields });
    else changes.kept.push(p.id);
    subJobs.push({ ...p, title: next.title, brief: next.brief, after: next.after, ...(next.check ? { check: next.check } : { check: undefined }) });
  }
  for (const s of proposal.subJobs) if (!current.has(s.id)) { changes.added.push(s.id); subJobs.push(norm(s)); }
  // An existing story keeps its key: it is part of what the human already agreed
  // to. A new keyless one is ticketed by the ordinary Jira step once approved.
  const stories = [...job.plan.stories];
  for (const t of proposal.stories || []) {
    const had = stories.find((x) => x.id === t.id);
    if (!had) stories.push(t);
    else if (t.key && had.key && t.key !== had.key) throw new Error(`${t.id} was approved as ${had.key}; keep that key`);
  }
  const gone = new Set([...changes.removed, ...job.subJobs.filter((s) => s.cancelledAt).map((s) => s.id)]);
  for (const s of subJobs) {
    if (gone.has(s.id) || frozen.includes(s.id)) continue;
    const dead = s.after.filter((id) => gone.has(id));
    if (dead.length) throw new Error(`${s.id} would wait forever on ${dead.join(', ')}, which ${dead.length === 1 ? 'is' : 'are'} being cancelled`);
  }
  const plan = { context: proposal.context || job.plan.context, stories, subJobs: subJobs.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))) };
  validatePlan(plan);
  return { plan, changes };
}

// A request replaces any proposal still waiting: the planner reads that one as
// what the human just asked it to change.
export function requestReplan(job, feedback, now) {
  if (job.stage !== 'active') throw new Error('Only a running job has a plan to change');
  if (job.runs.some((r) => !r.stopped && !r.subJobId)) throw new Error('Wait for the planning or ticketing step to finish');
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
  const busy = changes.edited.filter((e) => liveRun(job, e.id)).map((e) => job.subJobs.find((s) => s.id === e.id).title);
  if (busy.length) throw new Error(`Wait for the running step on ${busy.map(quoted).join(' · ')} to stop`);
  const lines = [];
  for (const { id, fields } of changes.edited) {
    const sub = job.subJobs.find((s) => s.id === id);
    const spec = plan.subJobs.find((s) => s.id === id);
    for (const k of EDITABLE) { if (spec[k] === undefined) delete sub[k]; else sub[k] = spec[k]; }
    lines.push({ sub, detail: `Plan change edited ${quoted(spec.title)} (${fields.join(', ')})` });
  }
  for (const id of changes.removed) {
    const sub = job.subJobs.find((s) => s.id === id);
    dropSub(sub, now); sub.superseded = true;
    lines.push({ sub, detail: `Plan change cancelled ${quoted(sub.title)}${sub.pr?.url ? `; its PR stays open on GitHub` : ''}` });
  }
  job.plan = plan;
  for (const id of changes.added) {
    const sub = buildSubJob(plan, plan.subJobs.find((s) => s.id === id));
    job.subJobs.push(sub);
    lines.push({ sub, detail: `Plan change added ${quoted(sub.title)}` });
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
  const run = liveRun(job, sub.id) ? ' · a step is running' : '';
  const state = sub.cancelledAt ? 'cancelled' : `${sub.stage}${sub.state ? `/${sub.state}` : ''}`;
  return `- ${sub.id} (${sub.kind || 'pr'}) ${JSON.stringify(sub.title)}: ${state}${pr}${run}${isFrozen(sub) ? ' · FROZEN' : ''}`;
}
