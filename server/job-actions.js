import { isPrSub, isSessionSub, isWriteSub, isHumanSub } from './jobs-schema.js';
import { reworkSub, retrySub } from './job-sub-ops.js';
import { redRef } from './job-red.js';
import { parkedReadyRun, askAgent } from './job-parked.js';

// The things approving a proposal can do to a sub-job that are not edits to the
// plan: forward the human's words to its open session, rework its code, accept
// its red pipeline, mark where it stands, start a red step again as it is, or
// make a fix PR the way a merged sub-job recovers. Each claims something about the
// outside world, so each is PINNED to the exact head, merge commit or stage it
// was written against (`pinOf`), and approval is refused if that has moved
// (`checkActions`). Pure over the job draft job-store.js is about to persist,
// like job-replan.js.

const liveRun = (job, subId) => job.runs.some((r) => !r.stopped && r.parkedFor !== 'ready' && r.subJobId === subId);
const quoted = (title) => `“${title}”`;
const BEFORE_MERGE = ['implementation', 'review', 'pr', 'session'];

// The red pipeline an Accept red waves through: the failing checks of an open
// PR (pinned to its head) or the failing post-merge run of a merged one (pinned
// to its merge commit). Already accepted at that ref means nothing is left.
function redPin(sub) {
  if (!isPrSub(sub)) return null;
  if (sub.stage === 'pr' && sub.pr?.checkStatus === 'failing' && !sub.pr.dirty && sub.acceptedRed?.ref !== sub.pr.head) return { at: 'head', ref: sub.pr.head };
  if (sub.stage === 'deployment' && !sub.recoveredBy && sub.deploymentResult?.status === 'failing' && sub.acceptedRed?.ref !== sub.pr?.mergeCommit) return { at: 'merge', ref: sub.pr?.mergeCommit || null };
  return null;
}

// What a human looking at this job (or sub-job) is looking at, and the exact
// thing in it. The client mirrors this (public/jobs.js changeView): an idea is
// pinned to it (job-change.js), and so is every action the planner writes on the
// step the idea came from, so a head, receipt, revision or proposal that moved
// refuses it rather than applying it to something the human never read.
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

// Whether the action can be made of the sub-job as it stands, and the pin that
// says exactly which state that was. Throws what is wrong, in the words the agent
// is told when it reports and the human reads when the job moved.
export function gateAction(job, action, plan) {
  const sub = job.subJobs.find((s) => s.id === action.sub);
  if (!sub) throw new Error(`${action.type}: no sub-job ${action.sub}`);
  const name = quoted(sub.title);
  if (sub.cancelledAt || ['cleanup', 'done'].includes(sub.stage)) throw new Error(`${name} has already finished`);
  if (liveRun(job, sub.id)) throw new Error(`Wait for the step on ${name} to stop`);
  if (isWriteSub(sub) || isHumanSub(sub)) throw new Error(`${name} is a ${sub.kind} step: edit it in the plan instead`);
  // The session that wrote the tree is still open on its review (job-parked.js):
  // the human's words go to it, and nothing ends a session that could answer.
  const parked = parkedReadyRun(job, sub);
  if (action.type === 'forward') {
    if (!action.note) throw new Error(`forward ${name}: put the human's words for it in \`note\``);
    if (!parked || sub.stage !== 'review' || sub.state !== 'verified' || !sub.ready) throw new Error(`${name} has no session open on its review to forward to: use rework instead`);
    if (sub.answering) throw new Error(`${name}'s session is still answering the last message; ask again once it has`);
    return { sub, pin: { at: 'round', ref: String(sub.ready.receiptId), round: sub.ready.round || 1 } };
  }
  if (parked) throw new Error(action.type === 'rework' ? `${name}'s session is still open: forward the feedback to it instead` : `Wait for the step on ${name} to stop`);
  if (action.type === 'accept-red') {
    const pin = redPin(sub);
    if (!pin) throw new Error(`${name} has no red pipeline to accept${sub.pr?.dirty ? ' (merge conflicts cannot be overridden)' : ''}`);
    return { sub, pin };
  }
  // The human's Retry, suggested: pinned to the failure it was written about
  // (job-red.js redRef), so a new error, head or run since refuses it.
  if (action.type === 'retry') {
    if (!sub.error) throw new Error(`${name} is not red: nothing to retry`);
    return { sub, pin: { at: 'red', ref: redRef(job, sub) } };
  }
  if (action.type === 'recover') {
    if (!isPrSub(sub) || sub.stage !== 'deployment' || sub.recoveredBy || sub.deploymentResult?.status !== 'failing') throw new Error(`${name} has no failed post-merge run to recover from`);
    const fix = plan?.subJobs.find((s) => s.id === action.fix);
    if (!fix || fix.id === sub.id || !isPrSub(fix)) throw new Error(`recover needs \`fix\`: the id of a PR sub-job in this plan that fixes ${name}`);
    return { sub, pin: { at: 'merge', ref: sub.pr?.mergeCommit || null } };
  }
  if (action.type === 'mark') {
    if (!action.evidence) throw new Error(`mark ${name}: cite the evidence (the PR or ticket that shows it)`);
    if (action.position === 'merged') {
      if (!isPrSub(sub) || sub.stage !== 'pr') throw new Error(`Only an open PR can be marked merged: ${name} is in ${sub.stage}`);
      return { sub, pin: { at: 'head', ref: sub.pr?.head || null } };
    }
    if (action.position !== 'done') throw new Error('mark needs a position: merged or done');
    return { sub, pin: { at: 'stage', ref: sub.stage } };
  }
  if (action.type === 'rework') {
    if (!action.note) throw new Error(`rework ${name}: say what to change in \`note\``);
    if (!(isSessionSub(sub) ? ['session', 'review'] : BEFORE_MERGE).includes(sub.stage)) throw new Error(`${name} has merged: rework needs code that can still change`);
    return { sub, pin: sub.stage === 'pr' && sub.pr?.head ? { at: 'head', ref: sub.pr.head } : { at: 'stage', ref: sub.stage } };
  }
  throw new Error(`Unknown action: ${action.type}`);
}

// The receipt's actions, judged against the job as it is and the plan they ship
// with, each stamped with its pin. A sub-job the plan cancels cannot also be
// acted on, and one sub-job takes one action.
export function stampActions(job, actions = [], plan, changes) {
  const seen = new Set();
  return actions.map((a) => {
    if (seen.has(a.sub)) throw new Error(`${a.sub} has two actions; one sub-job takes one`);
    seen.add(a.sub);
    if (changes?.removed.includes(a.sub)) throw new Error(`${a.type} acts on ${a.sub}, which this plan cancels`);
    const { sub, pin } = gateAction(job, a, plan);
    sourceHolds(job, sub);
    return { ...a, pin };
  });
}

// The step the idea was typed on must still be what the human read there: a new
// round, receipt or head since means the idea was about something else.
export function sourceHolds(job, sub) {
  const source = job.replan?.source;
  if (source?.sub !== sub.id) return;
  const view = changeView(job, sub);
  if (view?.at !== source.at || view?.ref !== source.ref) throw new Error(`${quoted(sub.title)} has moved since the idea about it was sent (${source.at} ${short(source.ref)} is now ${view ? `${view.at} ${short(view.ref)}` : 'finished'}). Ask again.`);
}

// Approval: every pin must still be true. Something that moved (a new push, a
// different merge, a stage that advanced) is the human reading a stale claim.
export function checkActions(job, actions = [], plan) {
  for (const a of actions) {
    const { sub, pin } = gateAction(job, a, plan);
    sourceHolds(job, sub);
    if (pin.at !== a.pin?.at || pin.ref !== a.pin?.ref) throw new Error(`${quoted(sub.title)} has moved since this was proposed (${PIN_NOUN[a.pin?.at] || 'state'} ${short(a.pin?.ref)} is now ${short(pin.ref)}). Ask again.`);
  }
}
const PIN_NOUN = { head: 'head', merge: 'merge commit', stage: 'stage', round: 'review', red: 'failure' };
const short = (ref) => String(ref ?? 'none').slice(0, 9);

// Where a sub-job has gone since a proposal was written about it, in the words of
// the history and the planner; null while it is where the proposal left it.
export function landedAs(sub) {
  if (sub.cancelledAt) return 'was dropped';
  if (['cleanup', 'done'].includes(sub.stage)) return isPrSub(sub) ? 'has landed' : 'has finished';
  if (isPrSub(sub) && (sub.stage === 'deployment' || sub.mergedAt)) return 'has merged';
  if (sub.deployed || sub.writesOnly) return 'has finished';
  return null;
}

// The actions whose sub-job moved since they were stamped (finished, merged, a new
// head, round or stage), each with how. An action refused for anything else (a
// step still running, say) is not here: that refusal is the human's to read.
export function movedActions(job, actions = [], plan) {
  const moved = [];
  for (const a of actions) {
    const sub = job.subJobs.find((s) => s.id === a.sub);
    if (!sub) continue;
    let pin = null;
    try { pin = gateAction(job, a, plan).pin; } catch { /* judged below */ }
    const was = `${PIN_NOUN[a.pin?.at] || 'state'} ${short(a.pin?.ref)}`;
    const at = { head: sub.pr?.head, merge: sub.pr?.mergeCommit, stage: sub.stage, round: sub.ready?.receiptId }[a.pin?.at];
    const how = pin && (pin.at !== a.pin?.at || pin.ref !== a.pin?.ref) ? `has moved (${was} is now ${short(pin.ref)})`
      : pin ? (() => { try { sourceHolds(job, sub); return null; } catch { return 'has moved since the idea about it was sent'; } })()
      : landedAs(sub) || (at !== undefined && String(at ?? '') !== String(a.pin?.ref ?? '') ? `has moved (${was} is now ${short(at)})` : null)
        || (a.type === 'accept-red' && !liveRun(job, sub.id) && !redPin(sub) ? 'has no red pipeline left to accept' : null);
    if (how) moved.push({ sub, how });
  }
  return moved;
}

// The human's own words to a step's open session, kept verbatim, and nothing
// else: approving that would only repeat what they just wrote.
export function forwardsOnly(proposal) {
  const { added, edited, removed } = proposal.changes;
  return !proposal.escalation && !proposal.alternatives?.length && !added.length && !edited.length && !removed.length
    && proposal.actions.length > 0 && proposal.actions.every((a) => a.type === 'forward');
}

// After the plan is installed (a recover's fix exists by now). Returns the
// history lines; what runs next is the runner's: it reads these fields. `images`
// are the idea's pictures (job-replan.js requestReplan).
export function applyActions(job, actions = [], { now, images = [] }) {
  const lines = [];
  for (const a of actions) {
    const sub = job.subJobs.find((s) => s.id === a.sub);
    const name = quoted(sub.title);
    if (a.type === 'forward') {
      // The runner mails it on its next tick (job-runner.js deliverThread), and the
      // thread shows it as the human's, come through the planner.
      askAgent(sub, { from: 'human', via: 'planner', ...forwarded(sub, a.note, images) }, now);
      lines.push({ sub, detail: `Forwarded your words to ${name}'s open session` });
    } else if (a.type === 'accept-red') {
      // Accepting red at an open PR IS the merge approval for that head: the
      // human just said "merge it as it stands".
      const merged = sub.stage === 'deployment';
      sub.acceptedRed = { ref: a.pin.ref, note: a.note || null, at: now };
      if (!merged) sub.mergeApprovedHead = a.pin.ref;
      sub.error = null; sub.blocked = null; sub.state = 'watching'; sub.nextPollAt = 0;
      lines.push({ sub, detail: merged ? `Accepted the red post-merge run on ${name}` : `Accepted the red checks on ${name}; merging as it stands` });
    } else if (a.type === 'retry') {
      retrySub(sub, a.note);
      lines.push({ sub, detail: `Retried ${name}` });
    } else if (a.type === 'recover') {
      // The fix lands before the dependants, which already wait on this one: it
      // counts as deployed the moment its fix does (job-runner.js).
      sub.recoveredBy = a.fix; sub.state = 'awaiting-fix'; sub.nextPollAt = 0; sub.error = null; sub.blocked = null;
      lines.push({ sub, detail: `${name} recovers when ${quoted(job.subJobs.find((s) => s.id === a.fix)?.title || a.fix)} lands` });
    } else if (a.type === 'mark' && a.position === 'merged') {
      // No stage jump: the next poll reads the merge commit and takes the
      // ordinary merged path, which also decides whether the merge is the delivery.
      sub.error = null; sub.blocked = null; sub.state = 'watching'; sub.nextPollAt = 0;
      lines.push({ sub, detail: `Marked ${name} merged: ${a.evidence}` });
    } else if (a.type === 'mark') {
      if (isPrSub(sub)) sub.deployed = { at: now, checks: [a.evidence], commit: sub.pr?.mergeCommit || null };
      else sub.result = { checks: [a.evidence], at: now, receiptId: null };
      sub.error = null; sub.blocked = null; sub.stage = 'cleanup'; sub.state = 'queued';
      lines.push({ sub, detail: `Marked ${name} done: ${a.evidence}` });
    } else {
      lines.push({ sub, detail: rework(job, sub, a.note, now) });
    }
  }
  return lines;
}

// Pictures kept beside this round (handlers.js prepare, for an idea typed on the
// review) ride as thread images the board draws; any other picture of the idea
// reaches the session as a path in its words.
function forwarded(sub, note, images) {
  const round = sub.ready?.round || 1;
  const own = images.filter((i) => i.sub === sub.id && i.round === round);
  const other = images.filter((i) => !own.includes(i) && i.path);
  const text = other.length ? `${note}\n(Pasted images, read them: ${other.map((i) => JSON.stringify(i.path)).join(', ')})` : note;
  return { text, images: own.map(({ file, mime }) => ({ file, mime })) };
}

// A sub-job's own road back to work, by its kind.
function rework(job, sub, note, now) {
  if (isSessionSub(sub)) {
    sub.error = null; sub.blocked = null; sub.stage = 'session'; sub.state = 'queued';
    if (sub.result) { sub.feedback = note; sub.result = null; } else sub.note = note;
    return `Sent ${quoted(sub.title)} back to work`;
  }
  if (sub.stage === 'implementation') { sub.note = note; sub.error = null; sub.blocked = null; sub.state = 'queued'; return `Ran ${quoted(sub.title)} again`; }
  return reworkSub(job, sub, note, now);
}
