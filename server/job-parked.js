// The session that reported ready stays open, paused, so the human can ask it
// things or send it back to change the code without a new session re-reading the
// tree. It parks the way a drafting session does (run.parkedAt: no slot, held only
// to its card existing) but keeps `parkedFor: 'ready'` so a draft rule never
// claims it. Everything the human and the agent say lives on the sub-job's
// `thread`; a message for the agent is mailed by the runner (job-runner.js).

// Once approved the same session lands what it wrote (`landing`, job-runner.js):
// it is no longer open for the human's words.
export const parkedReadyRun = (job, sub) => sub && job.runs.find((r) => !r.stopped && r.subJobId === sub.id && r.parkedFor === 'ready' && !r.landing) || null;

// Still this run's to finish: the review is open on a receipt it made, or approved
// and waiting for it to commit and push. Dropped, reworked by a plan change or
// retried all end it.
export const waitsOnReview = (job, run) => {
  const sub = job.subJobs.find((s) => s.id === run.subJobId);
  return !!sub && !sub.cancelledAt && sub.stage === 'review' && ['verified', 'approved'].includes(sub.state) && String(sub.ready?.receiptId || '').startsWith(run.id);
};

// A message for the parked session. It is delivered on the runner's next tick
// (`sentAt` stays null until then); `answering` is what the board shows meanwhile,
// its `kind` only one a caller named (retell, restart): what the session reports
// back, a reply or a fresh round, says what it was.
// `via: 'planner'` marks the human's words forwarded by an approved proposal
// (job-actions.js), the only road an idea takes to a parked session. One written
// while the session is still answering queues behind it (`answered`).
export function askAgent(sub, { from, text, kind, images, via }, now) {
  const round = sub.ready?.round || 1;
  const id = `msg_${now.toString(36)}${(sub.thread?.length || 0).toString(36)}`;
  const queued = !!sub.answering;
  (sub.thread ||= []).push({ id, at: now, from, ...(via ? { via } : {}), to: 'agent', text, round, ...(images?.length ? { images } : {}), ...(queued && kind ? { kind } : {}), sentAt: null });
  if (!queued) sub.answering = { id, at: now, ...(kind ? { kind } : {}), round };
  return id;
}

export const unsentFor = (sub) => (sub?.thread || []).filter((m) => m.to === 'agent' && !m.sentAt);

// The session's own words go above anything still queued for it, so each reply
// sits under the message it answers (public/job-talk.js repliesTo).
export function sayInThread(sub, msg) {
  const at = (sub.thread ||= []).findIndex((m) => m.to === 'agent' && !m.sentAt);
  if (at < 0) sub.thread.push(msg); else sub.thread.splice(at, 0, msg);
}

// The message in flight is answered: the next one queued, if any, is what the
// session answers now.
export function answered(sub) {
  const next = unsentFor(sub)[0];
  sub.answering = next ? { id: next.id, at: next.at, ...(next.kind ? { kind: next.kind } : {}), round: next.round } : null;
}
