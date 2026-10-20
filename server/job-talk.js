// A running job's conversations with the wrangler (the board's name for the
// planner): every idea the human types in an Add idea box, every answer, and
// every plan change proposed, kept on `job.talk` so they outlive a plan change and
// a reload. Each message names its conversation (`convo`, one of `job.convos`),
// and several can be open at once, each with its own wrangler run. A question
// starts an ASK run for its conversation (`convo.pending`): a planning run that
// never sets `job.replan`, so nothing is held while it reads, and that replies in
// the thread. Whatever the human says before that run replies is one more ask for
// the SAME run, mailed to it by the runner (job-runner.js deliverAsks), never a
// new run. A change idea goes to `requestReplan` exactly as before; its proposal
// is drawn in its conversation as a card that records what became of it. Pure
// over the job draft job-store.js is about to persist, like job-change.js.

export const TALK_MAX = 200;
export const CONVOS_MAX = 50;
export const talkOf = (job) => job?.talk || [];
export const convosOf = (job) => job?.convos || [];
export const convoById = (job, id) => id ? convosOf(job).find((c) => c.id === id) || null : null;
export const convoRun = (job, convo) => job.runs.find((r) => !r.stopped && r.convo === convo.id) || null;
// The asks its run has not read yet: queued before it launched (claim marks them
// read, the prompt carries them) or typed while it works (mailed).
export const unsentAsks = (convo) => (convo?.pending?.asks || []).filter((a) => !a.sentAt);
const nextId = (job, now) => `talk_${now.toString(36)}${talkOf(job).length.toString(36)}`;

export function say(job, entry, now) {
  const msg = { id: nextId(job, now), at: now, ...entry };
  (job.talk ||= []).push(msg);
  if (job.talk.length > TALK_MAX) job.talk.splice(0, job.talk.length - TALK_MAX);
  return msg;
}

// A conversation started from the job, or from one step's dialog (`sub`), which
// is where it is drawn.
export function openConvo(job, sub, now) {
  const convo = { id: `convo_${now.toString(36)}${convosOf(job).length.toString(36)}`, at: now, ...(sub ? { sub: sub.id } : {}), pending: null };
  (job.convos ||= []).push(convo);
  if (job.convos.length > CONVOS_MAX) job.convos.splice(0, job.convos.findIndex((c) => !c.pending) + 1);
  return convo;
}

// A question, or anything said while that conversation's wrangler is still at it:
// the first starts a run, the rest go to it.
export function ask(convo, message, { feedback, source, images }, now) {
  const entry = { messageId: message.id, feedback, sentAt: null };
  if (convo.pending) {
    convo.pending.asks.push(entry);
    if (images?.length) convo.pending.images = [...(convo.pending.images || []), ...images];
    return 'follow-up';
  }
  convo.pending = { at: now, asks: [entry], ...(source ? { source } : {}), ...(images?.length ? { images } : {}) };
  return 'new';
}

const ownConvo = (job, run) => {
  const convo = convoById(job, run.convo);
  if (!convo?.pending) throw new Error('This question was already answered or withdrawn');
  return convo;
};
const where = (convo) => convo.sub || convo.pending?.source?.sub;
const textOnly = (report) => { if (report.suggest || report.shots || report.run || report.running) throw new Error('An answer is text only: job_report {kind:"reply", text, escalate?}'); };
// A conversation started on a step shows only there until its wrangler judges it
// the job's (a reply's `escalate`) or proposes a plan change, which is the job's
// by nature: then the job's list shows it too.
export function escalate(convo, now) {
  if (convo?.sub && !convo.escalatedAt) convo.escalatedAt = now;
}

// The answer lands in the thread and ends the run. Anything the human said that
// never reached it starts the conversation's next run.
export function answerAsk(job, run, report, now) {
  const convo = ownConvo(job, run);
  textOnly(report);
  say(job, { from: 'wrangler', kind: 'answer', text: report.text, convo: convo.id, replyTo: run.ask, ...(where(convo) ? { sub: where(convo) } : {}) }, now);
  if (report.escalate) escalate(convo, now);
  const left = unsentAsks(convo);
  convo.pending = left.length ? { ...convo.pending, at: now, asks: left } : null;
  run.report = report;
  run.reportedAt = now;
}

// The ask run found a change was wanted: it becomes a plan change exactly as if
// the idea had been sent as one, folded into any proposal already waiting.
export function askToReplan(job, run, requestReplan, now) {
  const convo = ownConvo(job, run);
  const { asks, source, images } = convo.pending;
  requestReplan(job, asks.map((a) => a.feedback).join('\n\n'), now, null, { source, images, running: run.id, convo: convo.id });
  convo.pending = null;
}

// A plan-change run whose idea was only a question: answered, and the change it
// started is dropped. Only a fresh one: an earlier proposal or a red step the
// planner was sent after is not the question's to throw away.
export function answerReplan(job, run, report, now) {
  const r = job.replan;
  if (!r || r.proposal) throw new Error('There is no plan change to answer');
  if (r.red || r.previous || r.previousActions?.length) throw new Error('This plan change carries an earlier proposal or a red step: report a plan');
  textOnly(report);
  say(job, { from: 'wrangler', kind: 'answer', text: report.text, ...(r.convo ? { convo: r.convo } : {}), ...(r.source?.sub ? { sub: r.source.sub } : {}) }, now);
  if (report.escalate) escalate(convoById(job, r.convo), now);
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
    changes: changesOf(job, proposal), options: 1 + (proposal.alternatives?.length || 0), ...(red ? { red } : {}), ...(job.replan?.convo ? { convo: job.replan.convo } : {}),
    ...(job.replan?.source?.sub ? { sub: job.replan.source.sub } : red ? { sub: red } : {}) }, now);
  escalate(convoById(job, job.replan?.convo), now);
}
// approved, discarded, or revised (a newer idea went into it).
export function closeProposal(job, proposalId, outcome, now) {
  const card = talkOf(job).findLast((m) => m.kind === 'proposal' && m.proposalId === proposalId);
  if (card && !card.outcome) Object.assign(card, { outcome, outcomeAt: now });
}

// The ask run died or blocked: said in the thread, and the job goes on.
export function askFailed(job, run, why, now) {
  const convo = convoById(job, run.convo);
  if (!convo?.pending) return;
  say(job, { from: 'wrangler', kind: 'error', text: `Could not answer: ${why}`, convo: convo.id, replyTo: run.ask, ...(where(convo) ? { sub: where(convo) } : {}) }, now);
  convo.pending = null;
}

// A job saved while it had one conversation (`job.ask`, messages with no
// `convo`): its thread becomes the first conversation, its question that
// conversation's, and an ask run still going keeps answering it.
export function migrateTalk(job) {
  if (job.convos || !(job.talk?.length || job.ask)) { delete job.ask; return; }
  const id = 'convo_0';
  job.convos = [{ id, at: job.talk?.[0]?.at || job.ask?.at || 0, pending: job.ask ? { at: job.ask.at, asks: [{ messageId: job.ask.messageId, feedback: job.ask.feedback, sentAt: job.ask.at }], ...(job.ask.source ? { source: job.ask.source } : {}), ...(job.ask.images?.length ? { images: job.ask.images } : {}) } : null }];
  for (const m of job.talk || []) m.convo ??= id;
  for (const r of job.runs || []) if (r.ask && !r.convo) r.convo = id;
  if (job.replan) job.replan.convo ??= id;
  delete job.ask;
}
