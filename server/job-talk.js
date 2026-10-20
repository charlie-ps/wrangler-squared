import { looksLikeQuestion } from './job-parked.js';

// A running job's conversation with the wrangler (the board's name for the
// planner): every idea the human types in an Add idea box, every answer, and
// every plan change proposed, kept on `job.talk` so it outlives a plan change and
// a reload. A question starts an ASK run (`job.ask`): a planning run that never
// sets `job.replan`, so nothing is held while it reads, and that replies in the
// thread. A change idea goes to `requestReplan` exactly as before; its proposal
// is drawn in the thread as a card that records what became of it. Pure over the
// job draft job-store.js is about to persist, like job-change.js.

export const TALK_MAX = 200;
export const talkOf = (job) => job?.talk || [];
export const askRun = (job) => job.runs.find((r) => !r.stopped && r.ask) || null;
const nextId = (job, now) => `talk_${now.toString(36)}${talkOf(job).length.toString(36)}`;

export function say(job, entry, now) {
  const msg = { id: nextId(job, now), at: now, ...entry };
  (job.talk ||= []).push(msg);
  if (job.talk.length > TALK_MAX) job.talk.splice(0, job.talk.length - TALK_MAX);
  return msg;
}

// A question goes to its own run unless the planner is already busy: then it
// waits for that run, or for the human to send it again. An idea that reads as a
// question but asks for a change is the ask run's to propose (askToReplan).
export const routesAsQuestion = (job, text) => looksLikeQuestion(text) && !job.ask && !job.runs.some((r) => !r.stopped && !r.subJobId);
export function startAsk(job, message, { feedback, source, images }, now) {
  job.ask = { messageId: message.id, feedback, at: now, ...(source ? { source } : {}), ...(images?.length ? { images } : {}) };
}

// The answer lands in the thread, beside the question's step, and ends the run.
export function answerAsk(job, run, report, now) {
  if (job.ask?.messageId !== run.ask) throw new Error('This question was already answered or withdrawn');
  if (report.suggest || report.shots || report.run || report.running) throw new Error('An answer is text only: job_report {kind:"reply", text}');
  say(job, { from: 'wrangler', kind: 'answer', text: report.text, replyTo: run.ask, ...(job.ask.source?.sub ? { sub: job.ask.source.sub } : {}) }, now);
  job.ask = null;
  run.report = report;
  run.reportedAt = now;
}

// The ask run found a change was wanted: it becomes a plan change exactly as if
// the idea had been sent as one, folded into any proposal already waiting.
export function askToReplan(job, run, requestReplan, now) {
  if (job.ask?.messageId !== run.ask) throw new Error('This question was already answered or withdrawn');
  const { feedback, source, images } = job.ask;
  job.ask = null;
  requestReplan(job, feedback, now, null, { source, images, running: run.id });
}

// A plan-change run whose idea was only a question: answered, and the change it
// started is dropped. Only a fresh one: an earlier proposal or a red step the
// planner was sent after is not the question's to throw away.
export function answerReplan(job, run, report, now) {
  const r = job.replan;
  if (!r || r.proposal) throw new Error('There is no plan change to answer');
  if (r.red || r.previous || r.previousActions?.length) throw new Error('This plan change carries an earlier proposal or a red step: report a plan');
  if (report.suggest || report.shots || report.run || report.running) throw new Error('An answer is text only: job_report {kind:"reply", text}');
  say(job, { from: 'wrangler', kind: 'answer', text: report.text, ...(r.source?.sub ? { sub: r.source.sub } : {}) }, now);
  job.replan = null;
  run.report = report;
  run.reportedAt = now;
}

// What a proposal changes, in the words its card shows, kept with it so an old
// card still reads once the proposal itself is gone.
function changesOf(job, proposal) {
  const title = (id) => proposal.merged.subJobs.find((s) => s.id === id)?.title || job.subJobs.find((s) => s.id === id)?.title || id;
  const { added, edited, removed } = proposal.changes;
  return [...added.map((id) => ({ mark: 'added', title: title(id) })),
    ...edited.map((e) => ({ mark: 'edited', title: title(e.id), detail: e.fields.join(', ') })),
    ...removed.map((id) => ({ mark: 'removed', title: title(id) })),
    ...(proposal.actions || []).map((a) => ({ mark: a.type, title: title(a.sub) }))];
}
export function noteProposal(job, proposal, now) {
  const red = job.replan?.red && !job.replan.red.human ? job.replan.red.sub : null;
  say(job, { from: 'wrangler', kind: 'proposal', proposalId: proposal.id, text: proposal.diagnosis?.summary || proposal.why || proposal.label || '',
    changes: changesOf(job, proposal), options: 1 + (proposal.alternatives?.length || 0), ...(red ? { red } : {}),
    ...(job.replan?.source?.sub ? { sub: job.replan.source.sub } : red ? { sub: red } : {}) }, now);
}
// approved, discarded, or revised (a newer idea went into it).
export function closeProposal(job, proposalId, outcome, now) {
  const card = talkOf(job).findLast((m) => m.kind === 'proposal' && m.proposalId === proposalId);
  if (card && !card.outcome) Object.assign(card, { outcome, outcomeAt: now });
}

// The ask run died or blocked: said in the thread, and the job goes on.
export function askFailed(job, run, why, now) {
  if (job.ask?.messageId !== run.ask) return;
  say(job, { from: 'wrangler', kind: 'error', text: `Could not answer: ${why}`, replyTo: run.ask, ...(job.ask.source?.sub ? { sub: job.ask.source.sub } : {}) }, now);
  job.ask = null;
}
