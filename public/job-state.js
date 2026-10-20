import { ICONS } from './icons.js';
import { isPrSub, isSessionSub, isHumanSub, isWriteSub, writeWaiting, triggerDropped, replanPending, replanProposed, heldByReplan, redFixing, redFixReady, redDeclared, budgetHeld, jobStatus, jobNeedsReview, eventFor, redPipeline, cancelledDependencies, pendingDependencies, deploymentStalled, codeAwaitingReview, runStatus, prNumber, worktreeKept, promptsWaiting } from './jobs.js';

// The one state vocabulary every surface draws: a tone (the colour, see the
// .tone-* rules in jobs.css), a glyph and a short name. Every stage, run status,
// check result and review gate a job or sub-job can be in folds onto one of these.
export const STATES = {
  planned: { tone: 'idle', icon: 'planned', label: 'Planned' },
  queued: { tone: 'idle', icon: 'clock', label: 'Queued' },
  waiting: { tone: 'idle', icon: 'lock', label: 'Waiting' },
  running: { tone: 'run', icon: 'spin', label: 'Running' },
  needs: { tone: 'warn', icon: 'eye', label: 'Needs you' },
  failing: { tone: 'bad', icon: 'x', label: 'Failing' },
  done: { tone: 'ok', icon: 'check', label: 'Done' },
  paused: { tone: 'pause', icon: 'pause', label: 'Paused' },
  dropped: { tone: 'idle', icon: 'stop', label: 'Dropped' },
};
// Most urgent first: the board sorts by it and a job rolls up to its sub-jobs' first.
export const STATE_ORDER = ['failing', 'needs', 'paused', 'running', 'queued', 'waiting', 'planned', 'done', 'dropped'];
export const stateIconHtml = (state) => ICONS[STATES[state].icon];
// A solid tile is a step that is moving or settled; a hollow one has not begun.
export const stateSolid = (state) => !['planned', 'queued', 'waiting', 'dropped'].includes(state);

// A plan's sub-jobs have no stage until approval makes them live.
export function subState(job, sub) {
  if (!sub.stage) return 'planned';
  if (sub.cancelledAt) return worktreeKept(sub) ? 'needs' : 'dropped';
  if (sub.stage === 'done') return 'done';
  // Red, but Wrangler has it (Fixing), or has a fix for you (Fix ready): neither is the failing red you act on.
  if (!job.error && redFixing(job, sub)) return 'running';
  if (!job.error && redFixReady(job, sub)) return 'needs';
  if (job.error || cancelledDependencies(job, sub).length || (eventFor(job, sub) && !deploymentStalled(sub))) return 'failing';
  if (job.paused || budgetHeld(job) || heldByReplan(job, sub)) return 'paused';
  if (jobNeedsReview(job, sub)) return 'needs';
  if (jobStatus(job, sub).tone === 'working') return 'running';
  if (redPipeline(sub)) return 'failing';
  if (isWriteSub(sub)) return writeWaiting(job, sub) ? 'waiting' : 'queued';
  return pendingDependencies(job, sub).length ? 'waiting' : 'queued';
}

export function jobState(job) {
  if (job.cancelledAt) return job.subJobs.some((s) => s.cancelledAt && worktreeKept(s)) ? 'needs' : 'dropped';
  if (job.error) return 'failing';
  if (job.stage === 'done') return 'done';
  if (job.stage !== 'active') {
    if (job.paused || budgetHeld(job)) return 'paused';
    if (jobNeedsReview(job, null)) return 'needs';
    if (job.runs.some((r) => !r.stopped)) return 'running';
    return job.stage === 'backlog' ? 'planned' : 'queued';
  }
  // Sub-jobs frozen by a pending plan change roll up to the change itself:
  // re-planning, then a proposal that needs the human.
  const halted = job.paused || budgetHeld(job);
  const states = job.subJobs.filter((s) => halted || !heldByReplan(job, s)).map((s) => subState(job, s)).filter((s) => s !== 'dropped');
  if (replanProposed(job) && !halted) states.push('needs');
  else if (replanPending(job) && !halted) states.push('running');
  if (!states.length) return 'queued';
  if (states.every((s) => s === 'done')) return 'done';
  return STATE_ORDER.find((s) => states.includes(s));
}

// A local checkout main could not be fast-forwarded (job-main.js), and nothing is fixing it yet:
// an ask of its own beside the stage roll-up, which it never changes, so a finished job keeps it.
export const mainWaiting = (job) => (job.mainNotices || []).filter((n) => !n.retrying && !n.resolving);
// A job needs you exactly when its plate draws an ask (job-plates.js plateAsk): the rail
// badge and the Needs you tab count jobs by this, so both match the cards on the board.
export const jobNeedsYou = (job) => !!job.error || budgetHeld(job) || promptsWaiting(job).length > 0 || ['needs', 'failing'].includes(jobState(job)) || mainWaiting(job).length > 0;
export const leadSub = (job, state = jobState(job)) => job.subJobs.find((s) => subState(job, s) === state) || null;
const redChecks = (sub) => (sub.pr?.checks || []).filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.state)).length;
// A few words for what a sub-job is waiting for, where its state is one a human
// acts on; otherwise the runner's own status line.
export function subLabel(job, sub) {
  const state = subState(job, sub);
  const n = prNumber(sub);
  if (state === 'failing') {
    if (redDeclared(job, sub) && !job.error) return 'Declared red';
    if (cancelledDependencies(job, sub).length) return triggerDropped(job, sub) ? 'Trigger dropped' : 'Prerequisite dropped';
    if (sub.error || eventFor(job, sub)) return eventFor(job, sub).title;
    if (job.error) return 'Needs attention';
    return redPipeline(sub) === 'checks' ? 'Checks failing' : 'Deploy failing';
  }
  if (state === 'needs') {
    if (sub.cancelledAt) return jobStatus(job, sub).text;
    if (redFixReady(job, sub)) return 'Fix ready';
    if (runStatus(job, sub) === 'needs-you') return 'Prompt waiting';
    if (deploymentStalled(sub)) return 'Nothing deployed';
    if (codeAwaitingReview(sub)) return 'Review code';
    if (isSessionSub(sub)) return 'Review result';
    if (isHumanSub(sub)) return 'Your turn';
    if (isWriteSub(sub)) return 'Review write';
    if (sub.stage === 'pr') return n ? `Merge #${n}` : 'Merge';
  }
  return jobStatus(job, sub).text;
}
// The one coloured line under a stepper node: the PR it is, and how it stands.
export function subLine(job, sub) {
  const n = isPrSub(sub) ? prNumber(sub) : '';
  const red = subState(job, sub) === 'failing' && redPipeline(sub) === 'checks' && !redDeclared(job, sub) ? redChecks(sub) : 0;
  const text = red ? `${red} check${red === 1 ? '' : 's'} red` : subLabel(job, sub);
  return n && !text.includes(`#${n}`) ? `#${n} · ${text}` : text;
}
export function jobLabel(job) {
  const state = jobState(job);
  if (job.cancelledAt) return jobStatus(job, null).text;
  if (job.error) return 'Needs attention';
  if (!['needs', 'failing'].includes(state) && mainWaiting(job).length) return `Local ${mainWaiting(job)[0].base} behind`;
  if (budgetHeld(job)) return 'Paused for budget';
  if (job.stage === 'backlog') return job.paused ? 'Paused' : 'Backlog';
  if (job.stage === 'planning' && state === 'needs' && job.plan && !runStatus(job, null)) return 'Plan ready';
  if (job.stage !== 'active') return jobStatus(job, null).text;
  if (state === 'done') return 'Delivered';
  if (state === 'paused') return 'Paused';
  if (state === 'needs' && replanProposed(job) && !job.replan.red) return 'Plan change ready';
  if (state === 'running' && replanPending(job) && !replanProposed(job)) return job.replan.red ? 'Fixing' : 'Re-planning';
  const peers = job.subJobs.filter((s) => subState(job, s) === state);
  if (!peers.length) return jobStatus(job, null).text;
  return `${subLabel(job, peers[0])}${peers.length > 1 ? ` +${peers.length - 1}` : ''}`;
}
export const sortJobs = (jobs) => jobs.map((job, i) => [job, job.createdAt ?? 0, i]).sort((a, b) => b[1] - a[1] || b[2] - a[2]).map(([job]) => job);
