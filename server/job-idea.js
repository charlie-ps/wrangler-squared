// New idea: a job that starts as a conversation with its planner. The planning run
// either reports a plan, as any job's does, or replies (`reply`, from the planning
// phase) and parks like a session parked on its ready receipt (job-parked.js): no
// slot, held only to its card existing, mailed the human's answer by the runner
// (job-runner.js deliverIdea). A reply may suggest a job, a whole plan with a
// title, or 2–4 when the idea holds separate outcomes; the human creates each with
// one press, which is its plan receipt and approval at once (Plan review never asks
// again). Every press but the last makes a new job beside the idea; the last turns
// the idea itself into its job, and the parked run then ends quietly. Pure over the job
// draft job-store.js is about to persist, like job-change.js.

export const IDEA_TEXT_MAX = 8000;
export const isIdea = (job) => !!job?.idea;
// Still talking: nothing is planned yet and no plan change has taken over.
export const inConversation = (job) => isIdea(job) && job.stage === 'planning' && !job.plan && !job.replan && !job.cancelledAt;
export const ideaThread = (job) => job?.idea?.thread || [];
export const unsentIdea = (job) => ideaThread(job).filter((m) => m.from === 'human' && !m.sentAt);
// A message's suggestions as a list: one stored before several existed is an
// object, created when the message was accepted.
export function suggestionsOf(msg) {
  if (Array.isArray(msg?.suggest)) return msg.suggest;
  return msg?.suggest ? [{ ...msg.suggest, ...(msg.acceptedAt ? { createdAt: msg.acceptedAt } : {}) }] : [];
}
const uncreated = (msg) => suggestionsOf(msg).flatMap((x, i) => (x.createdAt ? [] : [i]));
// Only the newest message can carry live suggestions: anything said after it
// replaces those not yet created until the planner answers.
export function liveSuggestion(job) {
  const last = ideaThread(job).at(-1);
  return last?.from === 'planner' && uncreated(last).length ? last : null;
}
// Created from any of the planner's messages: the planner never suggests them again.
export const createdSuggestions = (job) => ideaThread(job).flatMap((m) => (m.from === 'planner' ? suggestionsOf(m).filter((x) => x.createdAt) : []));
// A plan or reply past words the planner has not been sent would answer only half
// of what the human said; the runner mails them on its next tick (deliverIdea).
export const UNSENT_IDEA = 'The human wrote again while you were working and it is on its way to you by mail: read your mail, then reply or report the plan';
const nextId = (job, now) => `msg_${now.toString(36)}${ideaThread(job).length.toString(36)}`;

// The planner's turn. It parks the run until the human answers; an identical retry
// of the last reply is safe, a different one while parked is refused, and so is
// one written before the human's newest message reached it.
export function plannerReply(job, run, report, now) {
  if (!inConversation(job)) throw new Error('A planning reply is for a new idea\'s conversation; report the plan instead');
  if (report.shots || report.run || report.running || report.escalate) throw new Error('A planning reply is text, with an optional suggest:[{title, plan}]');
  if (run.parkedFor === 'idea' && run.parkedAt && !run.mailedAt) {
    if (JSON.stringify(run.lastReply) === JSON.stringify(report)) return false;
    throw new Error('You already replied; wait for mail with the human\'s answer');
  }
  if (unsentIdea(job).length) throw new Error(UNSENT_IDEA);
  const suggest = [report.suggest || []].flat();
  job.idea.thread.push({ id: nextId(job, now), at: now, from: 'planner', text: report.text, ...(suggest.length ? { suggest } : {}) });
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

// Create jobs from the suggestions on screen, pinned to that message and to each
// suggestion: a newer message, or one already created, refuses it rather than plan
// something else. `index` is one suggestion, `all` every one not yet created. The
// last uncreated one is the idea's own (`own`), so a single suggestion is exactly
// the old press; each of the rest is a new job beside it (`siblings`, which the
// store creates and stamps with `jobId`).
export function acceptIdea(job, { messageId, index = 0, all = false }, now) {
  if (!inConversation(job)) throw new Error('This idea is no longer a conversation');
  const msg = liveSuggestion(job);
  if (!msg || msg.id !== messageId) throw new Error('Wrangler\'s suggestion changed since you looked. Read the latest one and try again.');
  const open = uncreated(msg);
  if (!all && !open.includes(index)) throw new Error('That job was already created from this suggestion.');
  if (!Array.isArray(msg.suggest)) msg.suggest = suggestionsOf(msg);
  const picked = all ? open : [index];
  const ownAt = picked.length === open.length ? picked.at(-1) : null;
  for (const i of picked) msg.suggest[i].createdAt = now;
  const siblings = picked.filter((i) => i !== ownAt).map((i) => msg.suggest[i]);
  let own = null;
  if (ownAt != null) {
    own = msg.suggest[ownAt];
    own.jobId = job.id;
    msg.acceptedAt = now;
    job.title = own.title;
  }
  return { siblings, own };
}

// Close an idea that has given every job wanted from it: the rest of its suggestions
// are left, and the planner ends with it (the store cancels the job).
export function leaveIdea(job, now) {
  if (!inConversation(job)) throw new Error('This idea is no longer a conversation');
  const made = createdSuggestions(job);
  if (!made.length) throw new Error('Nothing was created from this idea yet: cancel it instead');
  job.idea.leftAt = now;
  return made;
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
