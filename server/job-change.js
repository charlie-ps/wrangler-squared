import { requestReplan } from './job-replan.js';
import { changeView } from './job-actions.js';
import { isDeclared } from './job-red.js';
import { say, ask, convoById, openConvo } from './job-talk.js';
import { looksLikeQuestion } from './job-parked.js';

export { changeView };

// request-change: the one way a human's idea enters a job, from the plan, a code
// review, a session's result, an open PR, a write, or a pending proposal. The
// idea is pinned to what was on screen (`at` names the view, `ref` the exact
// thing in it) and goes to one recipient, the planner ("the wrangler" on the
// board), which sorts it into actions on live steps (forward to an open session,
// rework) and plan edits: one proposal the human approves (job-replan.js,
// job-actions.js). On a running job every idea is also said in one of the job's
// conversations (job-talk.js: `convo` names it, none starts a new one), and a
// question is answered there instead, with no plan change and nothing held.
// Anything said while that conversation's wrangler is still at it goes to that
// wrangler. Pure over the job draft job-store.js is about to persist, like
// job-replan.js.

const quoted = (title) => `“${title}”`;
export const CHANGE_TEXT_MAX = 8000;

// An idea's pictures ride in its words, as paths the planner reads
// (server/handlers.js prepare kept them on disk).
const withImages = (idea, attachments) => attachments?.length ? `${idea}\n(Pasted images, read them: ${attachments.map((a) => JSON.stringify(a.path)).join(', ')})` : idea;

export function requestChange(job, sub, { at, ref, text, attachments, from, convo: convoId }, { now }) {
  const typed = String(text || '').trim().slice(0, CHANGE_TEXT_MAX);
  if (!typed) throw new Error('Explain the change you want');
  const files = (attachments || []).filter((a) => typeof a?.path === 'string');
  const idea = withImages(from === 'helper' ? `(Sent by the human's helper session on this step, at the human's request) ${typed}` : typed, files);
  const view = changeView(job, sub);
  if (!view) throw new Error(sub ? 'Nothing is left to change here' : 'The job has nothing to change right now');
  if (view.at !== at || view.ref !== String(ref)) throw new Error('This changed since you looked. Review the latest version and ask again.');
  // The first plan is still the planner's own to redraw.
  if (view.at === 'plan') {
    if (job.runs.some((r) => !r.stopped)) throw new Error('Wait for planning to finish');
    job.feedback = idea;
    job.previousPlan = job.plan || job.previousPlan; job.plan = null; job.error = null;
    return { detail: 'Asked the wrangler to redraw the plan', route: 'planner' };
  }
  const target = convoById(job, convoId);
  if (convoId && !target) throw new Error('That conversation has gone. Start a new one.');
  // Kept beside the round they were typed on (a code review), a step's pictures can
  // go on into its session's thread when the planner forwards the idea there.
  const source = sub ? { sub: sub.id, at: view.at, ref: view.ref } : null;
  const images = files.map(({ file, mime, path }) => ({ sub: sub?.id || null, round: view.at === 'code' ? sub.ready.round || 1 : null, file, mime, path }));
  // The message keeps where each picture was kept, so the thread can draw it (handlers.js jobImagesHandler).
  const kept = files.map(({ file, mime, round }) => ({ file, mime, ...(sub ? { sub: sub.id } : {}), ...(sub && Number.isInteger(round) ? { round } : {}) }));
  const said = { from: 'human', text: typed, ...(sub ? { sub: sub.id } : {}), ...(files.length ? { images: kept } : {}) };
  // A declared red is the planner's: it has already tried, so the idea goes to it
  // with everything it found, and still holds only that step.
  if (sub && isDeclared(job, sub)) {
    const d = sub.red.declared;
    const convo = target || openConvo(job, sub, now);
    say(job, { ...said, convo: convo.id }, now);
    requestReplan(job, `About ${quoted(sub.title)} (${sub.id}), which was declared red: ${d.summary}${d.tried?.length ? `\nTried: ${d.tried.join(' | ')}` : ''}${d.ask ? `\nThe decision asked of the human: ${d.ask}` : ''}\nThe human says: ${idea}`, now, { sub: sub.id, auto: false, human: true }, { source, images, convo: convo.id });
    return { detail: `${from === 'helper' ? 'A helper session sent' : 'Sent'} the declared red on ${quoted(sub.title)} back to the wrangler`, route: 'planner' };
  }
  // Anything else is a question, answered in the thread, or a change of plan on a
  // running job, even a word for one step's open session: the planner proposes,
  // the human approves. A step's idea says where it came from.
  const feedback = sub ? `About ${quoted(sub.title)} (${sub.id}, ${sub.stage}${sub.state ? `/${sub.state}` : ''}): ${idea}` : idea;
  const convo = target || openConvo(job, sub, now);
  if (job.stage === 'active' && (convo.pending || looksLikeQuestion(typed))) {
    const sent = ask(convo, say(job, { ...said, convo: convo.id }, now), { feedback, source, images }, now);
    if (sent === 'follow-up') return { detail: 'Sent to the wrangler that is answering', route: 'planner' };
    return { detail: sub ? `${from === 'helper' ? 'A helper session asked' : 'Asked'} the wrangler about ${quoted(sub.title)}` : 'Asked the wrangler', route: 'planner' };
  }
  requestReplan(job, feedback, now, null, { source, images, convo: convo.id });
  say(job, { ...said, convo: convo.id }, now);
  return { detail: sub ? `${from === 'helper' ? 'A helper session sent' : 'Sent'} the wrangler an idea about ${quoted(sub.title)}` : 'Asked the wrangler to change the plan', route: 'planner' };
}
