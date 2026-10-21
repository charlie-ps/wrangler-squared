import { esc, tildify } from './util.js';
import { ICONS } from './icons.js';
import { isPrSub, isSessionSub, isHumanSub, isWriteSub, placeOf, placeShort, PLACES, kindChipHtml, ideaThread, ideaStage, liveSuggestion } from './jobs.js';
import { inflowHtml, arcHtml } from './job-skylines.js';

// New idea's conversation (server/job-idea.js): the idea's formation sky across the
// top, a thread with its planner, and the job the planner suggests as a launch strip
// under its message. Pure markup; jobs-view.js wires it. Everything the planner or
// the human wrote is escaped here.

const STAGE_SKY = { thinking: 0, reply: 1, suggested: 2 };
const time = (at) => at ? new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' }) : '';
const base = (p) => tildify(p).split('/').pop();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The wrangler writes plain text: blank lines are paragraphs, a run of "1." or "-"
// lines a list (an indented line under an item stays with it), `backticks` code,
// **double stars** bold. Escaped before anything is marked up.
const ITEM = { ol: /^\d+[.)]\s+/, ul: /^[-*•]\s+/ };
export function proseHtml(text) {
  const inline = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  const out = [];
  for (const block of String(text || '').trim().split(/\n\s*\n/)) {
    let list = null, para = [];
    const flush = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; if (list) out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map((i) => `<li>${i.map(inline).join('<br>')}</li>`).join('')}</${list.tag}>`); list = null; };
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const tag = ITEM.ol.test(line) ? 'ol' : ITEM.ul.test(line) ? 'ul' : null;
      if (tag) { if (para.length || list?.tag !== tag) flush(); (list ||= { tag, start: parseInt(line, 10), items: [] }).items.push([line.replace(ITEM[tag], '')]); }
      else if (list && /^\s/.test(raw)) list.items.at(-1).push(line);
      else { if (list) flush(); para.push(line); }
    }
    flush();
  }
  return out.join('');
}

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
  const fine = stale ? '<b>Replaced by a newer reply</b> · the wrangler suggests again once it answers.'
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

const humanHtml = (text, at, extra = '', pics = '') => `<div class="job-sent ${extra}"><div class="job-sent-bubble">${pics}<span>${esc(text)}</span></div><span class="job-sent-meta">You${at ? ` · ${esc(time(at))}` : ''}</span></div>`;
// Kept pictures are placeholders the dialog fills from a job-images frame (jobs-view.js
// hydrateStrips): `names` are the frame's keys, the job's own as stored, a message's `idea:<file>`.
export const imageStripHtml = (job, names = [], cls = '') => names.length ? `<div class="job-image-strip${cls ? ` ${cls}` : ''}" data-strip="${esc(job.id)}">${names.map((n, i) => `<button type="button" class="job-image-thumb" data-image="${esc(n)}" aria-label="Enlarge image ${i + 1}"><span class="job-image-num">${i + 1}</span></button>`).join('')}</div>` : '';
const keptPics = (job, names) => imageStripHtml(job, names, 'job-sent-strip');
const pendingPics = (urls = []) => urls.length ? `<span class="job-sent-imgs">${urls.map((u) => `<img src="${esc(u)}" alt="">`).join('')}</span>` : '';
const plannerHtml = (job, m, launch, fresh) => `<div class="job-idea-msg${fresh ? ' fresh' : ''}" data-msg="${esc(m.id)}"><span class="job-idea-orb" aria-hidden="true"></span><div><div class="job-idea-who">The wrangler<time>${esc(time(m.at))}</time></div><div class="job-idea-body">${proseHtml(m.text)}</div>${launch}</div></div>`;

// `pending` is the reply this tab just sent, drawn until the thread holds it; `firing`
// the suggestion pressed here, whose hole flares before the job replaces the idea;
// `fresh(id)` says whether a message is new to this dialog, so only it fades in.
export function ideaThreadHtml(job, { pending = null, firing = null, fresh = () => false } = {}) {
  const thread = ideaThread(job), live = liveSuggestion(job);
  const rows = [humanHtml(job.intent, job.createdAt, '', keptPics(job, job.images))];
  for (const m of thread) {
    if (m.from === 'human') { rows.push(humanHtml(m.text, m.at, '', keptPics(job, (m.images || []).map((i) => `idea:${i.file}`)))); continue; }
    const state = !m.suggest ? null : m.acceptedAt || firing?.state === 'sent' && firing.id === m.id ? 'done' : firing?.id === m.id ? 'firing' : m === live ? 'live' : 'stale';
    rows.push(plannerHtml(job, m, state ? suggestionHtml(job, m, state) : '', fresh(m.id)));
  }
  const held = pending && !thread.some((m) => m.from === 'human' && m.text === pending.text && m.at >= pending.at - 60000);
  if (held) rows.push(humanHtml(pending.text, pending.at, `fresh ${pending.state === 'failed' ? 'failed' : 'sending'}`, pendingPics(pending.images)));
  if (ideaStage(job) === 'thinking' || held && pending.state !== 'failed') rows.push(`<div class="job-idea-thinking"><span class="job-idea-orb small" aria-hidden="true"></span><span class="job-idea-shine">${thread.length ? 'The wrangler is thinking…' : 'The wrangler is reading the idea…'}</span></div>`);
  return `<div class="job-idea-thread" aria-live="polite">${rows.join('')}</div>`;
}

// `tray` is the change box's own picture tray (jobs-view.js askTrayHtml), so a
// screenshot pastes, drops and attaches here as it does on a step.
export function ideaComposerHtml(draft = '', tray = '') {
  return `<div class="job-change job-idea-composer is-open" data-idea-composer>
    <ul class="job-change-tray" ${tray ? '' : 'hidden'}>${tray}</ul>
    <div class="job-change-row"><span class="job-change-to" title="Who hears it"><span class="job-idea-orb small" aria-hidden="true"></span>To the wrangler</span><textarea rows="1" maxlength="8000" placeholder="Reply, or ask for a change to the suggestion…" aria-label="Reply to the wrangler">${esc(draft)}</textarea><label class="job-change-attach" title="Attach a screenshot (or paste or drop one)">${ICONS.image}<input type="file" accept="image/*" multiple aria-label="Attach a screenshot"></label><button type="button" class="job-change-go" data-idea-send aria-label="Send to the planner" title="Send (↵)" ${draft.trim() ? '' : 'disabled'}>${ICONS.send}</button></div>
    <p class="job-change-error" role="alert" hidden></p>
    <div class="job-change-foot"><kbd>↵ send · ⇧↵ new line</kbd></div></div>`;
}

// A backlog idea's own words, open to change until planning starts (server/job-idea.js
// editIdea). A form, so a tick leaves what is being typed alone; `strip` is its kept pictures.
export const IDEA_TITLE_MAX = 180;
export const ideaEditHtml = (job, strip = '') => `<form id="job-idea-edit" class="job-write-editor job-idea-edit">
    <label>Title<input name="title" required maxlength="${IDEA_TITLE_MAX}" value="${esc(job.title)}" autocomplete="off"></label>
    <label>Idea<textarea name="text" required maxlength="8000" rows="8">${esc(job.intent)}</textarea></label>
    ${strip ? `<div>${strip}<small class="job-idea-edit-note">Attached pictures stay with the idea.</small></div>` : ''}
    <div class="job-actions"><button class="primary">${ICONS.check}Save</button><button type="button" data-idea-edit-cancel>Cancel</button></div></form>`;

// Haiku is still naming the job (server `titlePending`): two faint bars stand where
// the title will land, so the clipped description never shows as a title first.
export const titleLoaderHtml = (cls = '') => `<span class="job-title-loader ${cls}" role="status" aria-label="Naming this idea…"><i></i><i></i></span>`;
const fadingLoader = '<span class="job-title-loader" aria-hidden="true"><i></i><i></i></span>';
// How long the loader and the landed title cross-fade (jobs.css h2.titled).
export const TITLE_FADE_MS = 1100;

// The whole dialog body for an idea still being talked through. `cost` and `actions`
// are the job dialog's own (price chip, Cancel), passed in.
// `titled`: ms since the title replaced the loader while the two still cross-fade, else false.
export function ideaViewHtml(job, { cost = '', actions = '', error = '', pending = null, firing = null, fresh, draft = '', tray = '', titled = false } = {}) {
  const stage = ideaStage(job) || 'thinking';
  const title = job.titlePending ? `<h2 class="pending" aria-busy="true">${titleLoaderHtml()}</h2>` : titled !== false ? `<h2 class="titled" style="--fade-at:-${titled}ms"><span>${esc(job.title)}</span>${fadingLoader}</h2>` : `<h2>${esc(job.title)}</h2>`;
  return `<div class="job-idea">
    <header class="job-idea-band" data-spin="24">${inflowHtml(job.id, STAGE_SKY[stage] ?? 0)}<div>${title}</div>${cost}</header>${error}
    ${ideaThreadHtml(job, { pending, firing, fresh })}
    <div class="job-idea-dock">${ideaComposerHtml(draft, tray)}${actions ? `<div class="job-actions">${actions}</div>` : ''}</div></div>`;
}
