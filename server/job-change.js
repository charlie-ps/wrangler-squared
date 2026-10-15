import { isPrSub, isSessionSub, isWriteSub } from './jobs-schema.js';
import { reworkSub } from './job-sub-ops.js';
import { requestReplan, mergeReplan } from './job-replan.js';
import { chipAction, stampActions } from './job-actions.js';
import { parkedReadyRun, askAgent } from './job-parked.js';

// request-change: the one way a human's idea enters a job, from the plan, a code
// review, a session's result, an open PR, a write, or a pending proposal. The
// idea is pinned to what was on screen (`at` names the view, `ref` the exact
// thing in it) and routes to the agent nearest the work: the step's own
// resumable agent when it has one, else the planner. Pure over the job draft
// job-store.js is about to persist, like job-replan.js.

const liveRun = (job, subId) => job.runs.some((r) => !r.stopped && r.subJobId === subId);
const quoted = (title) => `“${title}”`;
export const CHANGE_TEXT_MAX = 8000;
// The agents that can take a step's idea straight back: the session that wrote
// the working tree or the result, and the repair session of an open PR. Every
// other view goes up to the planner.
const STEP_AGENT = new Set(['code', 'session', 'pr']);

// What a human looking at this job (or sub-job) is looking at, and the exact
// thing in it. The client mirrors this (public/jobs.js changeView): a request
// whose pin no longer matches is refused rather than applied to a different
// head, receipt, revision or proposal than the one that was read.
export function changeView(job, sub) {
  if (job.cancelledAt) return null;
  if (!sub) {
    if (job.stage === 'planning' && job.plan) return { at: 'plan', ref: String(job.revision) };
    if (job.stage !== 'active') return null;
    return job.replan?.proposal ? { at: 'proposal', ref: job.replan.proposal.id } : { at: 'job', ref: 'job' };
  }
  if (sub.cancelledAt || ['cleanup', 'done'].includes(sub.stage)) return null;
  const step = { at: 'step', ref: `${sub.stage}/${sub.state}` };
  if (isWriteSub(sub)) return { at: 'write', ref: step.ref };
  if (isSessionSub(sub)) return sub.stage === 'review' && sub.result ? { at: 'session', ref: String(sub.result.receiptId) } : step;
  if (!isPrSub(sub)) return step;
  if (sub.stage === 'review' && ['verified', 'approved'].includes(sub.state) && sub.ready) return { at: 'code', ref: String(sub.ready.receiptId) };
  if (sub.stage === 'pr' && sub.pr?.head) return { at: 'pr', ref: sub.pr.head };
  return step;
}

export function requestChange(job, sub, { at, ref, text, attachments }, { now }) {
  const idea = String(text || '').trim().slice(0, CHANGE_TEXT_MAX);
  if (!idea) throw new Error('Explain the change you want');
  const view = changeView(job, sub);
  if (!view) throw new Error(sub ? 'Nothing is left to change here' : 'The job has nothing to change right now');
  if (view.at !== at || view.ref !== String(ref)) throw new Error('This changed since you looked. Review the latest version and ask again.');
  if (STEP_AGENT.has(view.at)) {
    if (job.replan) throw new Error('A plan change is pending. Approve or discard it first.');
    // The session that wrote this tree is still open (job-parked.js): the idea is
    // written to it, and it answers or reworks and reports ready again.
    const parked = view.at === 'code' && sub.state === 'verified' && parkedReadyRun(job, sub);
    if (parked) {
      const id = askAgent(sub, { from: 'human', text: idea, images: attachments }, now);
      return { detail: `${sub.answering.kind === 'ask' ? 'Asked' : 'Asked for a change to'} ${quoted(sub.title)}`, route: 'parked', messageId: id };
    }
    if (liveRun(job, sub.id)) throw new Error('Wait for the session to stop');
    if (view.at === 'session') {
      sub.feedback = idea; sub.result = null; sub.error = null; sub.blocked = null; sub.stage = 'session'; sub.state = 'queued';
      return { detail: `Requested changes on ${quoted(sub.title)}`, route: 'step' };
    }
    return { detail: reworkSub(job, sub, idea, now), route: 'step' };
  }
  // The first plan is still the planner's own to redraw.
  if (view.at === 'plan') {
    if (job.runs.some((r) => !r.stopped)) throw new Error('Wait for planning to finish');
    job.feedback = idea;
    job.previousPlan = job.plan || job.previousPlan; job.plan = null; job.error = null;
    return { detail: 'Asked the planner to change the plan', route: 'planner' };
  }
  // Anything else is a change of plan on a running job: a proposal the human
  // approves (job-replan.js). A step's idea carries where it came from.
  requestReplan(job, sub ? `About ${quoted(sub.title)} (${sub.id}, ${sub.stage}${sub.state ? `/${sub.state}` : ''}): ${idea}` : idea, now);
  return { detail: sub ? `Asked the planner to change the plan around ${quoted(sub.title)}` : 'Asked the planner to change the plan', route: 'planner' };
}

const CHIP_FEEDBACK = {
  'accept-red': (t) => `Accept the red pipeline on ${t}`,
  'mark-merged': (t) => `Mark ${t} merged`,
  'mark-done': (t) => `Mark ${t} done`,
  drop: (t) => `Drop ${t}`,
};

// An instant chip (Accept red, Mark merged, Mark done, Drop): the same proposal
// an agent would write for it, built here with no agent, pinned to the head,
// merge commit or stage on screen. The human still reads it in the proposal view
// and approves it; nothing changes until then.
export function quickChange(job, sub, { at, ref, kind, note }, { now }) {
  if (!sub) throw new Error('Choose a sub-job');
  const view = changeView(job, sub);
  if (!view) throw new Error('Nothing is left to change here');
  if (view.at !== at || view.ref !== String(ref)) throw new Error('This changed since you looked. Review the latest version and ask again.');
  if (job.stage !== 'active') throw new Error('Only a running job has a plan to change');
  if (job.replan) throw new Error('A plan change is pending. Approve or discard it first.');
  if (job.runs.some((r) => !r.stopped && !r.subJobId)) throw new Error('Wait for the planning step to finish');
  const action = chipAction(kind, note);
  const plan = action ? job.plan : { ...job.plan, subJobs: job.plan.subJobs.filter((s) => s.id !== sub.id) };
  const { plan: merged, changes } = mergeReplan(job, plan);
  if (!action && !changes.removed.includes(sub.id)) throw new Error(`${quoted(sub.title)} has landed and cannot be dropped`);
  const actions = action ? stampActions(job, [{ ...action, sub: sub.id }], merged, changes) : [];
  const feedback = CHIP_FEEDBACK[kind](quoted(sub.title));
  job.replan = { feedback, at: now, previous: null, proposal: { id: `quick_${now}`, label: null, why: null, plan, merged, changes, actions, alternatives: [], instant: true, at: now } };
  return { detail: `Proposed: ${feedback}` };
}
