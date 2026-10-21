// New idea: a job that starts as a conversation with its planner. The planning run
// either reports a plan, as any job's does, or replies (`reply`, from the planning
// phase) and parks like a session parked on its ready receipt (job-parked.js): no
// slot, held only to its card existing, mailed the human's answer by the runner
// (job-runner.js deliverIdea). A reply may suggest a job, a whole plan with a
// title, which the human accepts with one press; that press is the plan receipt and
// its approval at once (Plan review never asks again), and the parked run then ends
// quietly. Pure over the job
// draft job-store.js is about to persist, like job-change.js.

export const IDEA_TEXT_MAX = 8000;
export const isIdea = (job) => !!job?.idea;
// Still talking: nothing is planned yet and no plan change has taken over.
export const inConversation = (job) => isIdea(job) && job.stage === 'planning' && !job.plan && !job.replan && !job.cancelledAt;
export const ideaThread = (job) => job?.idea?.thread || [];
export const unsentIdea = (job) => ideaThread(job).filter((m) => m.from === 'human' && !m.sentAt);
// Only the newest message can carry the live suggestion: anything said after it
// replaces it until the planner answers.
export function liveSuggestion(job) {
  const last = ideaThread(job).at(-1);
  return last?.from === 'planner' && last.suggest && !last.acceptedAt ? last : null;
}
// A plan or reply past words the planner has not been sent would answer only half
// of what the human said; the runner mails them on its next tick (deliverIdea).
export const UNSENT_IDEA = 'The human wrote again while you were working and it is on its way to you by mail: read your mail, then reply or report the plan';
const nextId = (job, now) => `msg_${now.toString(36)}${ideaThread(job).length.toString(36)}`;

// The planner's turn. It parks the run until the human answers; an identical retry
// of the last reply is safe, a different one while parked is refused, and so is
// one written before the human's newest message reached it.
export function plannerReply(job, run, report, now) {
  if (!inConversation(job)) throw new Error('A planning reply is for a new idea\'s conversation; report the plan instead');
  if (report.shots || report.run || report.running || report.escalate) throw new Error('A planning reply is text, with an optional suggest:{title, plan}');
  if (run.parkedFor === 'idea' && run.parkedAt && !run.mailedAt) {
    if (JSON.stringify(run.lastReply) === JSON.stringify(report)) return false;
    throw new Error('You already replied; wait for mail with the human\'s answer');
  }
  if (unsentIdea(job).length) throw new Error(UNSENT_IDEA);
  job.idea.thread.push({ id: nextId(job, now), at: now, from: 'planner', text: report.text, ...(report.suggest ? { suggest: report.suggest } : {}) });
  job.idea.error = null;
  Object.assign(run, { lastReply: report, parkedFor: 'idea', parkedAt: now, mailedAt: null, idleSince: null });
  return true;
}

// The human's turn: delivered by mail when the planner is parked, or read from the
// prompt by the next planning run when there is none (job-store.js claim). Pasted
// pictures are already kept (handlers.js prepare); the message names their files.
export function humanReply(job, text, now, attachments = []) {
  const typed = String(text || '').trim().slice(0, IDEA_TEXT_MAX);
  if (!typed) throw new Error('Write a reply first');
  if (!inConversation(job)) throw new Error('This idea is no longer a conversation');
  const id = nextId(job, now);
  const images = attachments.filter((a) => typeof a?.file === 'string').map(({ file, mime }) => ({ file, mime }));
  job.idea.thread.push({ id, at: now, from: 'human', text: typed, ...(images.length ? { images } : {}), sentAt: null });
  return id;
}

// Create the job from the suggestion on screen, pinned to that message: a newer
// one (or a suggestion already taken) refuses it rather than plan something else.
export function acceptIdea(job, messageId, now) {
  if (!inConversation(job)) throw new Error('This idea is no longer a conversation');
  const msg = liveSuggestion(job);
  if (!msg || msg.id !== messageId) throw new Error('The wrangler\'s suggestion changed since you looked. Read the latest one and try again.');
  msg.acceptedAt = now;
  job.title = msg.suggest.title;
  return msg.suggest.plan;
}

// An idea waiting in the backlog is still only the human's words: until planning
// starts (or anything has been said to a planner) they may rewrite its title and
// text. The pictures it was added with stay. Returns the move's detail, or null
// when nothing changed.
export const TITLE_MAX = 180;
export const ideaEditable = (job) => isIdea(job) && job.stage === 'backlog' && !job.plan && !job.replan && !job.cancelledAt && !ideaThread(job).length && !(job.runs || []).length;
export function editIdea(job, { title, text } = {}) {
  if (!ideaEditable(job)) throw new Error('Planning has started on this idea: add an idea to the job instead');
  const typed = String(text ?? job.intent).trim();
  if (!typed) throw new Error('Write the idea first');
  if (typed.length > IDEA_TEXT_MAX) throw new Error(`Keep the idea under ${IDEA_TEXT_MAX} characters`);
  const named = title == null ? job.title : String(title).trim();
  if (!named) throw new Error('Give the idea a title');
  if (named.length > TITLE_MAX || /[\r\n]/.test(named)) throw new Error(`Keep the title to one line under ${TITLE_MAX} characters`);
  const changed = [named !== job.title && 'title', typed !== job.intent && 'text'].filter(Boolean);
  if (!changed.length) return null;
  job.title = named;
  job.intent = typed;
  // A title the human wrote is never replaced by the generated one still on its way.
  if (changed.includes('title')) delete job.titlePending;
  return `Edited the idea's ${changed.join(' and ')}`;
}
