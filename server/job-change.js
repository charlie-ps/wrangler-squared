import { requestReplan } from './job-replan.js';
import { changeView } from './job-actions.js';
import { isDeclared } from './job-red.js';

export { changeView };

// request-change: the one way a human's idea enters a job, from the plan, a code
// review, a session's result, an open PR, a write, or a pending proposal. The
// idea is pinned to what was on screen (`at` names the view, `ref` the exact
// thing in it) and goes to one recipient, the planner, which sorts it into
// actions on live steps (forward to an open session, rework) and plan edits: one
// proposal the human approves (job-replan.js, job-actions.js). Pure over the job
// draft job-store.js is about to persist, like job-replan.js.

const quoted = (title) => `“${title}”`;
export const CHANGE_TEXT_MAX = 8000;

// An idea's pictures ride in its words, as paths the planner reads
// (server/handlers.js prepare kept them on disk).
const withImages = (idea, attachments) => attachments?.length ? `${idea}\n(Pasted images, read them: ${attachments.map((a) => JSON.stringify(a.path)).join(', ')})` : idea;

export function requestChange(job, sub, { at, ref, text, attachments }, { now }) {
  const typed = String(text || '').trim().slice(0, CHANGE_TEXT_MAX);
  if (!typed) throw new Error('Explain the change you want');
  const files = (attachments || []).filter((a) => typeof a?.path === 'string');
  const idea = withImages(typed, files);
  const view = changeView(job, sub);
  if (!view) throw new Error(sub ? 'Nothing is left to change here' : 'The job has nothing to change right now');
  if (view.at !== at || view.ref !== String(ref)) throw new Error('This changed since you looked. Review the latest version and ask again.');
  // The first plan is still the planner's own to redraw.
  if (view.at === 'plan') {
    if (job.runs.some((r) => !r.stopped)) throw new Error('Wait for planning to finish');
    job.feedback = idea;
    job.previousPlan = job.plan || job.previousPlan; job.plan = null; job.error = null;
    return { detail: 'Asked the planner to change the plan', route: 'planner' };
  }
  // Kept beside the round they were typed on (a code review), a step's pictures can
  // go on into its session's thread when the planner forwards the idea there.
  const source = sub ? { sub: sub.id, at: view.at, ref: view.ref } : null;
  const images = files.map(({ file, mime, path }) => ({ sub: sub?.id || null, round: view.at === 'code' ? sub.ready.round || 1 : null, file, mime, path }));
  // A declared red is the planner's: it has already tried, so the idea goes to it
  // with everything it found, and still holds only that step.
  if (sub && isDeclared(job, sub)) {
    const d = sub.red.declared;
    requestReplan(job, `About ${quoted(sub.title)} (${sub.id}), which was declared red: ${d.summary}${d.tried?.length ? `\nTried: ${d.tried.join(' | ')}` : ''}${d.ask ? `\nThe decision asked of the human: ${d.ask}` : ''}\nThe human says: ${idea}`, now, { sub: sub.id, auto: false, human: true }, { source, images });
    return { detail: `Sent the declared red on ${quoted(sub.title)} back to the planner`, route: 'planner' };
  }
  // Anything else is a change of plan on a running job, even a word for one
  // step's open session: the planner proposes, the human approves. A step's idea
  // says where it came from.
  requestReplan(job, sub ? `About ${quoted(sub.title)} (${sub.id}, ${sub.stage}${sub.state ? `/${sub.state}` : ''}): ${idea}` : idea, now, null, { source, images });
  return { detail: sub ? `Sent the planner an idea about ${quoted(sub.title)}` : 'Asked the planner to change the plan', route: 'planner' };
}
