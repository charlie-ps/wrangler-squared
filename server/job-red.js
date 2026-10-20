import { isPrSub, isHumanSub, isWriteSub, isSessionSub, reviewRed } from './jobs-schema.js';
import { LEGACY_WRITE } from './job-writes.js';

// Red steps: what happens to a sub-job that has gone red (its `error`). With
// `settings.maxReplans` above 0 the planner is sent after it automatically: it
// proposes a fix, changes the plan, or escalates. "You decide" (job.reviewRed,
// the default) leaves every proposal for the human; "Wrangler replans" applies
// the safe ones, and the planner's own limit is `maxReplans` tries per step, after
// which the step is DECLARED red to the human with every attempt listed.
// Never automatic, whatever the setting: Accept red, Mark done and Recover claim
// something about the outside world; a retry is the human's to start; cancelling work that has a PR; changing a
// frozen sub-job. Pure over the job draft job-store.js is about to persist, like
// job-replan.js.

const liveRun = (job, subId) => job.runs.some((r) => !r.stopped && r.subJobId === subId);
const oneLine = (text, max = 180) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
const quoted = (title) => `“${title}”`;

// Which failure, of which piece of work: a new head, a new error or a new run
// after the step was reworked is a different red, so an earlier decision about it
// (declared, held) never carries over to it.
export const redRef = (job, sub) => `${sub.error || ''}|${sub.pr?.head || ''}|${sub.pr?.mergeCommit || ''}|${job.runs.filter((r) => r.subJobId === sub.id).length}`;
export const isDeclared = (job, sub) => !!sub.error && sub.red?.declared?.ref === redRef(job, sub);
// A step the planner may be sent after: red, still ours (not delivered or
// dropped), not already declared, and not set aside by the human's decision on
// this very failure (`held`: they discarded or approved a proposal for it).
export const redCause = (job, sub) => !!sub.error && !sub.cancelledAt && !['cleanup', 'done'].includes(sub.stage) && !isHumanSub(sub)
  && sub.error !== LEGACY_WRITE && !liveRun(job, sub.id) && sub.red?.held !== redRef(job, sub);
export const needsTriage = (job, sub) => redCause(job, sub) && !isDeclared(job, sub);
export const triesOn = (job, subId) => job.runs.filter((r) => r.red?.sub === subId).length;
export const triesAllowed = (settings, sub) => settings.maxReplans + (sub.replanAllowance || 0);

// Every sub-job that waits, directly or through others, on this one: a red
// replan holds these and nothing else.
const edgesOf = (s) => [...(s.after || []), ...(isSessionSub(s) && s.on ? [s.on.sub] : [])];
export function redScope(job, id) {
  const scope = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of job.subJobs) {
      if (scope.has(s.id) || !(edgesOf(s).some((e) => scope.has(e)) || (isWriteSub(s) && scope.has(s.by)))) continue;
      scope.add(s.id); grew = true;
    }
  }
  return scope;
}
// What a waiting proposal would change, in any of its options: the steps it
// edits, cancels or acts on. Nothing else waits for the human to read it.
export function touchedBy(proposal) {
  const ids = new Set();
  for (const o of proposal ? [proposal, ...(proposal.alternatives || [])] : []) {
    for (const e of o.changes?.edited || []) ids.add(e.id);
    for (const id of o.changes?.removed || []) ids.add(id);
    for (const a of o.actions || []) ids.add(a.sub);
  }
  return ids;
}
// A plan change never pauses the job. While the wrangler drafts, only the step
// the idea was typed on waits (its actions are pinned to what the human read),
// and once its proposal is up so does whatever it touches, so the step it edits
// is still the one the human approves. A red step's replan also holds that step
// and the sub-jobs after it from the start.
export const heldBy = (job, sub) => !!job.replan && (job.replan.source?.sub === sub.id || touchedBy(job.replan.proposal).has(sub.id)
  || (!!job.replan.red && redScope(job, job.replan.red.sub).has(sub.id)));

const note = (sub, entry) => { sub.red = { ...(sub.red || {}), attempts: [...(sub.red?.attempts || []), entry] }; };
export const noteAttempt = (sub, run, summary, outcome, now) => note(sub, { at: now, run: run?.id || null, summary: oneLine(summary, 400), outcome });
export const triedLines = (sub) => (sub.red?.attempts || []).map((a, i) => oneLine(`Replan ${i + 1}: ${a.summary || a.outcome}`));

// Hand the step to the human: they act on a declared red, nothing else is red
// to them. A step that was not red (an idea the planner escalated about it) is
// made red by its own summary.
export function declareRed(job, sub, { summary, tried, ask, auto = false }, now) {
  if (!sub.error) { sub.error = oneLine(summary, 240); sub.blocked = { summary: oneLine(summary, 240), phase: 'planning', kind: 'escalate', at: now }; }
  sub.red = { ...(sub.red || {}), declared: { at: now, ref: redRef(job, sub), summary: String(summary).trim().slice(0, 1200), tried: tried?.length ? tried : triedLines(sub), ask: ask || null, auto } };
}
// The human decided about this failure (discarded the proposal, or approved one
// that left the step red): the planner is not sent after the same red again.
export function holdRed(job, subId) {
  const sub = job.subJobs.find((s) => s.id === subId);
  if (sub?.error) sub.red = { ...(sub.red || {}), held: redRef(job, sub) };
}

const othersRed = (job, sub) => job.subJobs.filter((s) => s.id !== sub.id && !!s.error && !s.cancelledAt && !['cleanup', 'done'].includes(s.stage) && !isHumanSub(s));
// What the planner is told about the red step. It decides: fix the step, change
// the plan, or escalate. `auto` says whether its fix lands without the human.
export function redFeedback(job, sub, n, limit) {
  const checks = (sub.pr?.checks || []).filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.state)).map((c) => c.name);
  const runs = (sub.deploymentResult?.runs || []).filter((r) => r.status === 'failing').map((r) => r.workflow);
  return [
    `RED STEP: ${quoted(sub.title)} (${sub.id}, ${sub.stage}${sub.state ? `/${sub.state}` : ''}) has gone red and nobody asked you to look: Wrangler sent you (try ${n} of ${limit}). Find out why, then fix the step, change the plan around it, or escalate it to the human.`,
    `What it says: ${sub.error}`,
    sub.blocked ? `Its own agent ${sub.blocked.kind === 'replan' ? 'said it needs more than its step' : 'reported it is blocked'}: ${sub.blocked.summary}${sub.blocked.why ? ` (${sub.blocked.why})` : ''}` : '',
    isPrSub(sub) && sub.pr?.url ? `PR ${sub.pr.url}${sub.pr.head ? ` at head ${sub.pr.head}` : ''}${sub.pr.dirty ? ' · merge conflicts' : ''}${checks.length ? ` · failing checks: ${checks.join(', ')}` : ''}${sub.stage === 'deployment' ? ` · post-merge run FAILING at merge ${sub.pr.mergeCommit}${runs.length ? ` (${runs.join(', ')})` : ''}` : ''}` : '',
    (sub.repairs || []).length ? `CI repairs already tried: ${sub.repairs.map((r) => (r.changes || []).join(' · ')).join(' | ')}` : '',
    (sub.red?.attempts || []).length ? `Your earlier tries on this step: ${triedLines(sub).join(' | ')}` : '',
    othersRed(job, sub).length ? `Also red right now: ${othersRed(job, sub).map((s) => `${s.id} ${quoted(s.title)}: ${oneLine(s.error)}`).join(' | ')}. Any that fail for the same cause belong in this one proposal: put them after the same fix.` : '',
    job.reviewRed ?? true ? 'Red steps is "You decide": whatever you propose waits for the human.' : 'Red steps is "Wrangler replans": a rework of the step (and, only if the job\'s Plan checkpoint is Auto, plan edits that touch no PR) applies by itself. accept-red, mark, recover and retry never do, so propose them only when they are the honest answer and cite the evidence.',
    'A failure that will not happen again (a race with another step, a lock, a network blip) that the step\'s own code did not cause is a retry action, {type:"retry",sub}: it waits for the human to approve it, whatever Red steps says. An unchanged plan with no actions changes nothing: it declares the step red to the human, and your diagnosis.summary is what they read on it, so say what you found and the decision they need, never what approving would do (there is nothing to approve).',
    'Only this step and the sub-jobs after it are held while you work; everything else keeps running. If neither a fix nor a plan change can get past it without a decision only the human can make, send the escalate receipt: what you found, what you tried, and the one decision you need, with up to three ranked options if there is a real choice.',
  ].filter(Boolean).join('\n');
}

// The whole of an automatic fix: a rework of the step, and plan edits only when
// the human let the plan change without them (Plan on Auto) and none of them
// cancels work that has a PR. Anything claiming something about the outside world
// is the human's, and so is a retry, whatever Red steps says. Judged on the
// recommended option only.
export function autoApplicable(job, proposal) {
  if (proposal.escalation || proposal.actions.some((a) => a.type === 'retry')) return false;
  const { added, edited, removed } = proposal.changes;
  if (!proposal.actions.length && !added.length && !edited.length && !removed.length) return false;
  if (proposal.actions.some((a) => a.type !== 'rework')) return false;
  if ((added.length || edited.length || removed.length) && (job.reviewPlan ?? true)) return false;
  return removed.every((id) => { const s = job.subJobs.find((x) => x.id === id); return !s?.pr?.url && !s?.mergedAt && !s?.deployed; });
}

// Sent after a red step: its replan holds only that step and what follows it.
export function startRed(job, sub, { tries, limit, now }) {
  job.replan = { feedback: redFeedback(job, sub, tries + 1, limit), at: now, proposal: null, previous: null, red: { sub: sub.id, auto: !reviewRed(job), n: tries + 1 } };
}
export function declareOutOfTries(job, sub, limit, now) {
  declareRed(job, sub, { summary: `Wrangler used its ${limit} automatic ${limit === 1 ? 'try' : 'tries'} on this step and it is still red: ${sub.error}`, ask: 'Decide how to carry on: send an idea in, accept the red, or retry', auto: true }, now);
}

// A red replan's proposal just landed (job-store.js _applyReceipt). Its fate:
// applied by itself, waiting for the human (Fix ready), or — when the planner
// had nothing it could change — declared. `apply` approves option 1.
export function settleProposal(job, run, { now, apply }) {
  const { red, proposal } = job.replan;
  const summary = proposal.diagnosis?.summary || proposal.label || proposal.why || 'Proposed a change';
  const subId = red.sub;
  const subOf = () => job.subJobs.find((s) => s.id === subId);
  const empty = !proposal.actions.length && ![...proposal.changes.added, ...proposal.changes.edited, ...proposal.changes.removed].length;
  if (empty) {
    const sub = subOf();
    if (sub) { noteAttempt(sub, run, summary, 'declared', now); declareRed(job, sub, { summary: proposal.diagnosis?.summary || 'The wrangler found nothing it could change', ask: 'Decide how to carry on: send an idea in, accept the red, or retry', auto: false }, now); }
    job.replan = null;
    return 'declared';
  }
  if (red.auto && !red.human && autoApplicable(job, proposal)) {
    const before = structuredClone(job);
    try { apply(); if (subOf()) noteAttempt(subOf(), run, summary, 'applied', now); return 'applied'; }
    catch { for (const k of Object.keys(job)) delete job[k]; Object.assign(job, before); }
  }
  if (subOf()) noteAttempt(subOf(), run, summary, 'proposed', now);
  return 'waiting';
}

// The planner escalated (or could not go on): the step is declared red. Options,
// when it gave them, stay as a proposal the human opens with Decide; without
// any there is nothing to hold the job for.
export function escalate(job, run, report, { now, propose }) {
  const subId = report.sub || job.replan?.red?.sub;
  const sub = job.subJobs.find((s) => s.id === subId);
  if (!sub) throw new Error(`Name the sub-job you are declaring red (sub); ${subId ? `${subId} is not one` : 'this was not a red step'}`);
  if (sub.cancelledAt || ['cleanup', 'done'].includes(sub.stage) || isHumanSub(sub)) throw new Error(`${quoted(sub.title)} cannot be declared red: it has finished or is the human's already`);
  const escalation = { sub: sub.id, summary: report.summary, tried: report.tried || [], ask: report.ask };
  if (report.options?.length) {
    job.replan = { ...(job.replan || { feedback: `Declared red: ${quoted(sub.title)}`, at: now, previous: null }), red: { ...(job.replan?.red || {}), sub: sub.id, auto: false } };
    propose(job, run, report.options, { escalation, diagnosis: { summary: report.summary } }, now);
  } else if (job.replan) job.replan = null;
  noteAttempt(sub, run, report.summary, 'declared', now);
  declareRed(job, sub, { summary: report.summary, tried: report.tried?.length ? [...triedLines(sub).slice(0, -1), ...report.tried].slice(-8) : undefined, ask: report.ask }, now);
}

// The planner's run ended with no receipt, or only a `blocked` one: that red
// step has no one left to look at it, so it is declared and the job goes on
// (never `job.error`, which would hold every sub-job).
export function failRedReplan(job, run, why, now) {
  const red = job.replan?.red;
  const sub = red && job.subJobs.find((s) => s.id === red.sub);
  if (!sub || run.phase !== 'planning' || run.subJobId) return false;
  noteAttempt(sub, run, why, 'failed', now);
  declareRed(job, sub, { summary: `Wrangler could not replan this step: ${why}`, ask: 'Decide how to carry on: send an idea in, accept the red, or retry', auto: true }, now);
  job.replan = null;
  return true;
}
