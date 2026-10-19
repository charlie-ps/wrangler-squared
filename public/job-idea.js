import { esc, tildify } from './util.js';
import { ICONS } from './icons.js';
import { isPrSub, isSessionSub, isHumanSub, isWriteSub, placeOf, placeShort, PLACES, kindChipHtml, ideaThread, ideaStage, liveSuggestion } from './jobs.js';
import { inflowHtml, arcHtml } from './job-skylines.js';
import { markdownHtml } from './markdown.js';

// New idea's conversation (server/job-idea.js): the idea's formation sky across the
// top, a thread with its planner, and the job the planner suggests as a launch strip
// under its message. Pure markup; jobs-view.js wires it. Everything the planner or
// the human wrote is escaped here.

const STAGE_SKY = { thinking: 0, reply: 1, suggested: 2 };
const time = (at) => at ? new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' }) : '';
const base = (p) => tildify(p).split('/').pop();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What the job will be, in the words the board already uses: how many sub-jobs and
// of which kinds, the repositories, and the places its writes go.
export function suggestionSummary(plan) {
  const work = plan.subJobs.filter((s) => !isWriteSub(s));
  const repos = [...new Set(work.filter(isPrSub).map((s) => s.repo).filter(Boolean))];
  const places = [...new Map(plan.subJobs.filter(isWriteSub).map((w) => [placeOf(w) === 'other' ? `other:${w.place?.name}` : placeOf(w), w])).values()];
  const kinds = [[isPrSub, 'PR'], [isSessionSub, 'agent'], [isHumanSub, 'for you', 'for you']].map(([test, one, many]) => [work.filter(test), one, many]).filter(([list]) => list.length);
  const line = [plural(work.length, 'sub-job'), repos.map(base).join(' + '), ...places.map(placeShort)].filter(Boolean).join(' · ');
  return { work, repos, places, kinds, line };
}

const stepNote = (plan, s) => {
  if (isPrSub(s)) return `${base(s.repo || '')}${s.base ? ` → ${s.base}` : ''}`;
  if (isHumanSub(s)) return 'you';
  const writes = plan.subJobs.filter((w) => isWriteSub(w) && w.by === s.id).length;
  return writes ? `agent · ${plural(writes, 'write')}` : 'agent';
};

// The launch strip (the mock-up's "Horizon strip"): what the job is, then the event
// horizon that IS the button. `state` is live, stale (a newer message replaced it),
// firing (pressed, the hole flaring) or done.
export function suggestionHtml(job, msg, state = 'live') {
  const { title, plan } = msg.suggest;
  const { work, repos, places, kinds, line } = suggestionSummary(plan);
  const meta = [`<span class="job-launch-chip"><b>${work.length}</b>&nbsp;sub-job${work.length === 1 ? '' : 's'}</span>`,
    `<span class="job-launch-chip">${kinds.map(([list, one, many]) => `${kindChipHtml(list[0])}${list.length} ${list.length === 1 ? one : many || one}`).join(' ')}</span>`,
    ...repos.map((r) => `<span class="job-launch-chip" title="${esc(tildify(r))}">${ICONS.folder}${esc(base(r))}</span>`),
    ...places.map((w) => `<span class="job-launch-chip ghost">${PLACES[placeOf(w)].icon}${esc(placeShort(w))}</span>`)].join('');
  const steps = work.map((s) => `<li>${kindChipHtml(s)}<span>${esc(s.title)}</span><small>${esc(stepNote(plan, s))}</small></li>`).join('');
  const done = state === 'done', stale = state === 'stale';
  const label = done ? 'Creating the job' : 'Create job';
  // The press is the plan approval, whatever Plan review says (job-store.js accept-idea).
  const fine = stale ? '<b>Replaced by a newer reply</b> · the planner suggests again once it answers.'
    : done ? '<b>Job starting</b> · it takes this idea\'s place on the board.'
      : '<b>Creating it approves this plan</b> · the job starts as soon as you press; your other checkpoints still apply.';
  return `<div class="job-launch tone-warn ${state}" data-board="${esc(msg.id)}" data-launch="${esc(msg.id)}">
    <div class="job-launch-text"><span class="job-launch-kicker"><i></i>Suggested job</span><h3 class="job-launch-title">${esc(title)}</h3><div class="job-launch-meta">${meta}</div><ol class="job-launch-steps">${steps}</ol></div>
    <button type="button" class="job-launch-go" data-accept-idea="${esc(msg.id)}" data-spin="14" aria-label="${esc(`Create job: ${title}`)}" ${state === 'live' ? '' : 'aria-disabled="true"'}>
      <span class="job-launch-sky">${arcHtml(msg.id, done ? 'ok' : 'warn')}</span>
      <span class="job-launch-face"><span class="job-launch-dot">${done ? ICONS.check : ICONS.send}</span><span class="job-launch-label"><b>${label}</b><small>${esc(line)}</small></span></span>
    </button>
    <div class="job-launch-fine"><span>${fine}</span>${state === 'live' ? '<button type="button" class="job-launch-refine" data-idea-refine>Keep refining</button>' : ''}</div></div>`;
}

const humanHtml = (text, at, extra = '') => `<div class="job-sent ${extra}"><div class="job-sent-bubble"><span>${esc(text)}</span></div><span class="job-sent-meta">You${at ? ` · ${esc(time(at))}` : ''}</span></div>`;
const plannerHtml = (job, m, launch, fresh) => `<div class="job-idea-msg${fresh ? ' fresh' : ''}" data-msg="${esc(m.id)}"><span class="job-idea-orb" aria-hidden="true"></span><div><div class="job-idea-who">Planner<time>${esc(time(m.at))}</time></div><div class="job-idea-body chat-prose">${markdownHtml(m.text)}</div>${launch}</div></div>`;

// `pending` is the reply this tab just sent, drawn until the thread holds it; `firing`
// the suggestion pressed here, whose hole flares before the job replaces the idea;
// `fresh(id)` says whether a message is new to this dialog, so only it fades in.
export function ideaThreadHtml(job, { pending = null, firing = null, fresh = () => false } = {}) {
  const thread = ideaThread(job), live = liveSuggestion(job);
  const rows = [humanHtml(job.intent, job.createdAt)];
  for (const m of thread) {
    if (m.from === 'human') { rows.push(humanHtml(m.text, m.at)); continue; }
    const state = !m.suggest ? null : m.acceptedAt || firing?.state === 'sent' && firing.id === m.id ? 'done' : firing?.id === m.id ? 'firing' : m === live ? 'live' : 'stale';
    rows.push(plannerHtml(job, m, state ? suggestionHtml(job, m, state) : '', fresh(m.id)));
  }
  const held = pending && !thread.some((m) => m.from === 'human' && m.text === pending.text && m.at >= pending.at - 60000);
  if (held) rows.push(humanHtml(pending.text, pending.at, `fresh ${pending.state === 'failed' ? 'failed' : 'sending'}`));
  if (ideaStage(job) === 'thinking' || held && pending.state !== 'failed') rows.push(`<div class="job-idea-thinking"><span class="job-idea-orb small" aria-hidden="true"></span><span class="job-idea-shine">${thread.length ? 'Planner is thinking…' : 'Planner is reading the idea…'}</span></div>`);
  return `<div class="job-idea-thread" aria-live="polite">${rows.join('')}</div>`;
}

export function ideaComposerHtml(draft = '') {
  return `<div class="job-change job-idea-composer is-open" data-idea-composer>
    <div class="job-change-row"><span class="job-change-to" title="Who hears it"><span class="job-idea-orb small" aria-hidden="true"></span>To planner</span><textarea rows="1" maxlength="8000" placeholder="Reply, or ask for a change to the suggestion…" aria-label="Reply to the planner">${esc(draft)}</textarea><button type="button" class="job-change-go" data-idea-send aria-label="Send to the planner" title="Send (↵)" ${draft.trim() ? '' : 'disabled'}>${ICONS.send}</button></div>
    <div class="job-change-foot"><kbd>↵ send · ⇧↵ new line</kbd></div></div>`;
}

// Haiku is still naming the job (server `titlePending`): two faint bars stand where
// the title will land, so the clipped description never shows as a title first.
export const titleLoaderHtml = (cls = '') => `<span class="job-title-loader ${cls}" role="status" aria-label="Naming this idea…"><i></i><i></i></span>`;
const fadingLoader = '<span class="job-title-loader" aria-hidden="true"><i></i><i></i></span>';
// How long the loader and the landed title cross-fade (jobs.css h2.titled).
export const TITLE_FADE_MS = 1100;

// The whole dialog body for an idea still being talked through. `cost` and `actions`
// are the job dialog's own (price chip, Cancel), passed in.
// `titled`: ms since the title replaced the loader while the two still cross-fade, else false.
export function ideaViewHtml(job, { cost = '', actions = '', error = '', pending = null, firing = null, fresh, draft = '', titled = false } = {}) {
  const stage = ideaStage(job) || 'thinking';
  const title = job.titlePending ? `<h2 class="pending" aria-busy="true">${titleLoaderHtml()}</h2>` : titled !== false ? `<h2 class="titled" style="--fade-at:-${titled}ms"><span>${esc(job.title)}</span>${fadingLoader}</h2>` : `<h2>${esc(job.title)}</h2>`;
  return `<div class="job-idea">
    <header class="job-idea-band" data-spin="24">${inflowHtml(job.id, STAGE_SKY[stage] ?? 0)}<div>${title}</div>${cost}</header>${error}
    ${ideaThreadHtml(job, { pending, firing, fresh })}
    <div class="job-idea-dock">${ideaComposerHtml(draft)}${actions ? `<div class="job-actions">${actions}</div>` : ''}</div></div>`;
}
