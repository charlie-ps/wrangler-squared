import { isPrSub, isSessionSub, isWriteSub, isHumanSub } from './jobs-schema.js';
import { reworkSub } from './job-sub-ops.js';

// The things approving a proposal can do to a sub-job that are not edits to the
// plan: rework its code, accept its red pipeline, mark where it stands, or make a
// fix PR the way a merged sub-job recovers. Each claims something about the
// outside world, so each is PINNED to the exact head, merge commit or stage it
// was written against (`pinOf`), and approval is refused if that has moved
// (`checkActions`). Pure over the job draft job-store.js is about to persist,
// like job-replan.js.

const liveRun = (job, subId) => job.runs.some((r) => !r.stopped && r.subJobId === subId);
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
  if (action.type === 'accept-red') {
    const pin = redPin(sub);
    if (!pin) throw new Error(`${name} has no red pipeline to accept${sub.pr?.dirty ? ' (merge conflicts cannot be overridden)' : ''}`);
    return { sub, pin };
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
    return { ...a, pin: gateAction(job, a, plan).pin };
  });
}

// Approval: every pin must still be true. Something that moved (a new push, a
// different merge, a stage that advanced) is the human reading a stale claim.
export function checkActions(job, actions = [], plan) {
  for (const a of actions) {
    const { sub, pin } = gateAction(job, a, plan);
    if (pin.at !== a.pin?.at || pin.ref !== a.pin?.ref) throw new Error(`${quoted(sub.title)} has moved since this was proposed (${PIN_NOUN[a.pin?.at] || 'state'} ${short(a.pin?.ref)} is now ${short(pin.ref)}). Ask again.`);
  }
}
const PIN_NOUN = { head: 'head', merge: 'merge commit', stage: 'stage' };
const short = (ref) => String(ref ?? 'none').slice(0, 9);

// After the plan is installed (a recover's fix exists by now). Returns the
// history lines; what runs next is the runner's: it reads these fields.
export function applyActions(job, actions = [], { now }) {
  const lines = [];
  for (const a of actions) {
    const sub = job.subJobs.find((s) => s.id === a.sub);
    const name = quoted(sub.title);
    if (a.type === 'accept-red') {
      // Accepting red at an open PR IS the merge approval for that head: the
      // human just said "merge it as it stands".
      const merged = sub.stage === 'deployment';
      sub.acceptedRed = { ref: a.pin.ref, note: a.note || null, at: now };
      if (!merged) sub.mergeApprovedHead = a.pin.ref;
      sub.error = null; sub.blocked = null; sub.state = 'watching'; sub.nextPollAt = 0;
      lines.push({ sub, detail: merged ? `Accepted the red post-merge run on ${name}` : `Accepted the red checks on ${name}; merging as it stands` });
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

// The same road request-change takes (job-change.js), by the sub-job's own kind.
function rework(job, sub, note, now) {
  if (isSessionSub(sub)) {
    sub.error = null; sub.blocked = null; sub.stage = 'session'; sub.state = 'queued';
    if (sub.result) { sub.feedback = note; sub.result = null; } else sub.note = note;
    return `Sent ${quoted(sub.title)} back to work`;
  }
  if (sub.stage === 'implementation') { sub.note = note; sub.error = null; sub.blocked = null; sub.state = 'queued'; return `Ran ${quoted(sub.title)} again`; }
  return reworkSub(job, sub, note, now);
}

// What an instant chip builds without an agent: one action, or a drop. Every
// chip's claim is the human's own, so its evidence is their note or the click.
const CHIPS = {
  'accept-red': (note) => ({ type: 'accept-red', ...(note && { note }) }),
  'mark-merged': (note) => ({ type: 'mark', position: 'merged', evidence: note || 'Merged by hand' }),
  'mark-done': (note) => ({ type: 'mark', position: 'done', evidence: note || 'Marked done by hand' }),
  drop: () => null,
};
const noteOf = (note) => String(note || '').trim().slice(0, 180) || null;
export function chipAction(kind, note) {
  if (!CHIPS[kind]) throw new Error('Unknown quick change');
  return CHIPS[kind](noteOf(note));
}
