// The session that reported ready stays open, paused, so the human can ask it
// things or send it back to change the code without a new session re-reading the
// tree. It parks the way a drafting session does (run.parkedAt: no slot, held only
// to its card existing) but keeps `parkedFor: 'ready'` so a draft rule never
// claims it. Everything the human and the agent say lives on the sub-job's
// `thread`; a message for the agent is mailed by the runner (job-runner.js).

export const parkedReadyRun = (job, sub) => sub && job.runs.find((r) => !r.stopped && r.subJobId === sub.id && r.parkedFor === 'ready') || null;

// Still what the human is looking at: the review is open on a receipt this run
// made. Approved, dropped, reworked by a plan change or retried all end it.
export const waitsOnReview = (job, run) => {
  const sub = job.subJobs.find((s) => s.id === run.subJobId);
  return !!sub && !sub.cancelledAt && sub.stage === 'review' && sub.state === 'verified' && String(sub.ready?.receiptId || '').startsWith(run.id);
};

const QUESTION = /\?\s*$|^\s*(what|why|how|where|when|which|who|does|do|did|is|are|can|could|should|would|will)\b/i;
export const looksLikeQuestion = (text) => QUESTION.test(String(text).trim());

// A message for the parked session. It is delivered on the runner's next tick
// (`sentAt` stays null until then); `answering` is what the board shows meanwhile.
// `via: 'planner'` marks the human's words forwarded by an approved proposal
// (job-actions.js), the only road an idea takes to a parked session.
export function askAgent(sub, { from, text, kind, images, via }, now) {
  const round = sub.ready?.round || 1;
  const id = `msg_${now.toString(36)}${(sub.thread?.length || 0).toString(36)}`;
  (sub.thread ||= []).push({ id, at: now, from, ...(via ? { via } : {}), to: 'agent', text, round, ...(images?.length ? { images } : {}), sentAt: null });
  sub.answering = { id, at: now, kind: kind || (looksLikeQuestion(text) ? 'ask' : 'change'), round };
  return id;
}

export const unsentFor = (sub) => (sub?.thread || []).filter((m) => m.to === 'agent' && !m.sentAt);
