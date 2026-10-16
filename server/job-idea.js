// New idea: a job that starts as a conversation with its planner. The planning run
// either reports a plan, as any job's does, or replies (`reply`, from the planning
// phase) and parks like a session parked on its ready receipt (job-parked.js): no
// slot, held only to its card existing, mailed the human's answer by the runner
// (job-runner.js deliverIdea). A reply may suggest a job, a whole plan with a
// title, which the human accepts with one press; that is the plan receipt the
// planner would have sent, and the parked run then ends quietly. Pure over the job
// draft job-store.js is about to persist, like job-change.js.

export const IDEA_TEXT_MAX = 8000;
export const isIdea = (job) => !!job?.idea;
// Still talking: nothing is planned yet and no plan change has taken over.
export const inConversation = (job) => isIdea(job) && job.stage === 'planning' && !job.plan && !job.replan && !job.cancelledAt;
export const ideaThread = (job) => job?.idea?.thread || [];
export const parkedIdeaRun = (job) => job.runs.find((r) => !r.stopped && !r.subJobId && r.parkedFor === 'idea') || null;
export const unsentIdea = (job) => ideaThread(job).filter((m) => m.from === 'human' && !m.sentAt);
// Only the newest message can carry the live suggestion: anything said after it
// replaces it until the planner answers.
export function liveSuggestion(job) {
  const last = ideaThread(job).at(-1);
  return last?.from === 'planner' && last.suggest && !last.acceptedAt ? last : null;
}
const nextId = (job, now) => `msg_${now.toString(36)}${ideaThread(job).length.toString(36)}`;

// The planner's turn. It parks the run until the human answers; an identical retry
// of the last reply is safe, a different one while parked is refused.
export function plannerReply(job, run, report, now) {
  if (!inConversation(job)) throw new Error('A planning reply is for a new idea\'s conversation; report the plan instead');
  if (report.shots || report.run || report.running) throw new Error('A planning reply is text, with an optional suggest:{title, plan}');
  if (run.parkedFor === 'idea' && run.parkedAt && !run.mailedAt) {
    if (JSON.stringify(run.lastReply) === JSON.stringify(report)) return false;
    throw new Error('You already replied; wait for mail with the human\'s answer');
  }
  job.idea.thread.push({ id: nextId(job, now), at: now, from: 'planner', text: report.text, ...(report.suggest ? { suggest: report.suggest } : {}) });
  job.idea.error = null;
  Object.assign(run, { lastReply: report, parkedFor: 'idea', parkedAt: now, mailedAt: null, idleSince: null });
  return true;
}

// The human's turn: delivered by mail when the planner is parked, or read from the
// prompt by the next planning run when there is none (job-store.js claim).
export function humanReply(job, text, now) {
  const typed = String(text || '').trim().slice(0, IDEA_TEXT_MAX);
  if (!typed) throw new Error('Write a reply first');
  if (!inConversation(job)) throw new Error('This idea is no longer a conversation');
  const id = nextId(job, now);
  job.idea.thread.push({ id, at: now, from: 'human', text: typed, sentAt: null });
  return id;
}

// Create the job from the suggestion on screen, pinned to that message: a newer
// one (or a suggestion already taken) refuses it rather than plan something else.
export function acceptIdea(job, messageId, now) {
  if (!inConversation(job)) throw new Error('This idea is no longer a conversation');
  const msg = liveSuggestion(job);
  if (!msg || msg.id !== messageId) throw new Error('The planner\'s suggestion changed since you looked. Read the latest one and try again.');
  msg.acceptedAt = now;
  job.title = msg.suggest.title;
  return msg.suggest.plan;
}
