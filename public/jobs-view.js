import { esc, tildify } from './util.js';
import { ICONS, wranglerMark } from './icons.js';
import { conflictWaiting, convoGroups, convosOf, CHECKPOINTS, checkpoint, reviewDefaultsOf, youReview, checkpointLabel, checkpointHint, checkpointButtonHtml, checkpointLock, checkpointWaiting, checkpointToggleHtml, syncCheckpointToggle, codeAwaitingReview, jobCostLabel, JOB_COST_TITLE, SUB_COST_TITLE, storyLabel, isSessionSub, isHumanSub, isPrSub, targetOf, offBase, hasSessionSubs, reviewedSession, kindChipHtml, kindLabel, KIND_TITLE, kindClass, dependencySatisfied, pendingDependencies, noteReaders, jobCards, jobStatus, receiptHtml, cancelledDependencies, commentVerdict, mergeHeldByComments, deploymentStalled, mergeApprovable, COMMENT_TONE_LABEL, deploysLine, eventFor, changeView, changeRoute, proposalOptions, actionMark, actionLine, editLine, pinLine, prNumber, runStatus, promptsWaiting, promptWhere, replanPending, replanProposed, heldByReplan, redFixing, redFixReady, redDeclared, isWriteSub, isStoryCreate, isMakeWrite, isJiraWrite, placeOf, PLACES, webUrl, placesOf, writeSession, sessionTrigger, triggerLine, writeTarget, milestoneLabel, workflowFor, triggerDropped, sessionDormant, parkedRun, draftsWaiting, writeAwaitingReview, writeReviewed, writeVerb, placeShort, hasWrites, dependencyLine, storyProject, inConversation, ideaThread, ideaOpen, uncreatedSuggestions, ideaEditable, budgetHeld, budgetLine, topUpLabel, dollars, DEFAULT_SPEND_LIMIT, talkFor, askPending, planningRun, replanQueued, queuedLabel, leadSentence } from './jobs.js';
import { talkHtml, convoTitle, latestConvo, unreadIn } from './job-talk.js';
import { TITLE_FADE_MS, ideaViewHtml, ideaThreadHtml, imageStripHtml, ideaEditHtml } from './job-idea.js';
import { planGraphHtml, layoutGraphEdges, filePathHtml, setFileOpener, fieldName } from './job-graph.js';
import { assignScenes, plateHtml, placePopHtml, askActs, plateAsk } from './job-plates.js';
import { jobMenuItems, jobReference, mountJobMenu } from './job-menu.js';
import { holdSkies, mountSkies, releaseSkies, spinTo } from './job-skylines.js';
import { wireDeps, relight } from './job-deps.js';
import { THEMES, themeOf, optionsOf, applyTheme, setCurrentTheme } from './themes.js';
import { mountThemePicker } from './theme-picker.js';
import { mountForming, dropForming, formingClock, formingMs } from './job-forming.js';
import { STATES, stateIconHtml, subState, subLabel, subLine, jobState, jobLabel, leadSub, sortJobs, jobNeedsYou } from './job-state.js';

// The board's filter rail: what each shows, and the one an empty view explains.
const FILTERS = [
  ['all', 'In flight', (job) => job.stage !== 'done' && job.stage !== 'backlog'],
  ['needs', 'Needs you', jobNeedsYou],
  ['ideas', 'Ideas', (job) => ideaOpen(job)],
  ['running', 'Running', (job) => jobState(job) === 'running'],
  ['backlog', 'Backlog', (job) => job.stage === 'backlog'],
  ['done', 'Finished', (job) => job.stage === 'done'],
];
import { createJobImages, imagesPanelHtml, openZoom, blobOf } from './job-images.js';
import { imageSources, sourceToFrame } from './clipboard-images.js';
import { mountModelPicker } from './model-picker.js';
import { mountSandbox } from './job-sandbox.js';
import { whatsNewHtml } from './updates.js';
import { tabsHtml, panelHtml, bindTabs } from './settings-tabs.js';
import { createIdeaCorner } from './idea-corner.js';
import { createRedrawHold, keepFields, keepScrollX } from './redraw-hold.js';
import { historyHtml } from './job-thread.js';
import { replanAsks, latestAsk } from './replan-asks.js';
import { runningChipHtml, stoppedHtml } from './job-running.js';
import { pressBusy, isBusy, submitterOf } from './busy-button.js';
import { guardOpen } from './dialog-backdrop.js';
import { EvidenceCache, hasProof, proofListHtml, proofViewerHtml, shotBoxHtml, proofItems, shotsOf, hydrateEvidence, showOf, proofRound } from './job-proof.js';
// Mirrors server/jobs-schema.js MAX_SHOW.
const MAX_SHOW = 8;
// Automation settings' tabs (settings-tabs.js), in the order the row draws them.
export const SETTINGS_TABS = [{ id: 'general', label: 'General' }, { id: 'automation', label: 'Automation' }, { id: 'review', label: 'Review defaults' }, { id: 'appearance', label: 'Appearance' }, { id: 'updates', label: 'What’s new' }];
export const SETTINGS_TAB_KEY = 'settingsTab';
const checkTone = (state) => ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'passing'].includes(state) ? 'passed' : ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'failing'].includes(state) ? 'failed' : '';
const checkMark = (state) => checkTone(state) === 'passed' ? '✓' : checkTone(state) === 'failed' ? '×' : '○';
const link = (url, title) => /^https:\/\/github\.com\//.test(url || '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>` : esc(title);
const commentWhere = (c) => c.kind === 'review' ? `review · ${c.state.toLowerCase().replace('_', ' ')}` : c.kind === 'thread' ? `${c.path || 'thread'}${c.line != null ? `:${c.line}` : ''}${c.outdated ? ' · outdated' : ''}${c.resolved ? ' · resolved' : ''}` : 'comment';
// An assist chip: a glyph and a few words, the sentence behind them in its tooltip.
const chip = (icon, text, { cls = '', title = '' } = {}) => `<span class="job-chip ${cls}"${title ? ` title="${esc(title)}"` : ''}>${icon}${text ? `<span>${esc(text)}</span>` : ''}</span>`;
// One part of a step's meta line: a few words, the sentence behind them in its tooltip.
const metaPart = (text, { cls = '', title = '' } = {}) => text ? `<span class="${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>` : '';
// A PR's worktree branch and where it lands as one part, `branch → target`; a
// PR on the default branch shows only its branch, and nothing until it is cut.
function branchPart(job, sub) {
  const branch = sub.worktree?.branch, target = isPrSub(sub) ? targetOf(job, sub) : null;
  if (!branch && !target) return '';
  const lands = target ? `Lands on ${target}${sub.base ? ' (this PR\'s own branch)' : ' (the job\'s branch)'}` : '';
  return metaPart([branch, target ? `→ ${target}` : ''].filter(Boolean).join(' '), { cls: `job-plan-branch ${offBase(job, sub) ? 'job-chip-base' : ''}`, title: [branch ? `Branch ${branch}` : '', lands].filter(Boolean).join('\n') });
}
// The state chip carries every explanatory sentence the step has, so they cost a
// hover rather than a paragraph; the info glyph says there is something to read.
const stateChip = (state, text, hints = []) => `<span class="job-chip job-chip-state tone-${STATES[state].tone}"${hints.length ? ` title="${esc(hints.join('\n\n'))}"` : ''}>${stateIconHtml(state)}<span>${esc(text)}</span>${hints.length ? ICONS.info : ''}</span>`;
// Comment text is written by reviewers and bots: escaped, never trusted HTML.
// A body is only rendered once asked for — a long review thread otherwise buries
// the verdict and the actions under it — and the expanded keys are passed in from
// the view's own state rather than read back off this markup, which is rebuilt
// from scratch on every graph tick and would snap a just-opened comment shut.
function commentsHtml(sub, shown) {
  const c = sub.prComments;
  if (!c) return '';
  const verdict = commentVerdict(sub);
  const summary = verdict === undefined ? '<p class="job-comments-none">No comments yet</p>'
    : verdict === null ? '<div class="job-comment-summary pending">Summarising comments…</div>'
      : `<div class="job-comment-summary ${esc(verdict.tone)}"><b>${esc(COMMENT_TONE_LABEL[verdict.tone])}</b> ${esc(verdict.text)}</div>`;
  return `<h3>Comments <small>${c.items.length}${c.unresolved ? ` · ${c.unresolved} unresolved thread${c.unresolved === 1 ? '' : 's'}` : ''}${c.truncated ? ` · ${c.truncated} older not shown` : ''}</small></h3>${summary}
    ${c.items.length ? `<ul class="job-comments">${c.items.map((i) => {
    const key = i.id || i.url;
    const open = shown.has(key);
    return `<li class="${i.resolved ? 'resolved' : ''}"><span class="job-comment-meta">${esc(i.author)}${i.bot ? ' (bot)' : ''} · ${esc(commentWhere(i))} ${link(i.url, 'view')}</span><button class="job-comment-toggle" data-comment-toggle="${esc(key)}" aria-expanded="${open}">${open ? 'Hide' : 'Show comment'}</button>${open ? `<p>${esc(i.body)}</p>` : ''}</li>`;
  }).join('')}</ul>` : ''}`;
}

const minutesSince = (at) => Math.max(1, Math.round((Date.now() - at) / 60000));
const PHASE_LABEL = { implementation: 'Implementation', repair: 'Repair', sync: 'Sync', publish: 'Publish', verify: 'Verify', session: 'Session', write: 'Write', planning: 'Planning' };
const when = (at) => at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
const staleHint = (sub) => {
  if (!deploymentStalled(sub)) return '';
  const commit = (sub.pr?.mergeCommit || '').slice(0, 8), minutes = minutesSince(sub.deploymentStale.since);
  const cancelled = sub.deploymentStale.cancelled || [];
  return cancelled.length
    ? `${cancelled.join(', ')} was cancelled on merge commit ${commit} and no later run that includes it has started in ${minutes} min. If it was cancelled on purpose, Request changes and say so. Wrangler keeps polling in case a run appears.`
    : `No GitHub Actions run has started for merge commit ${commit} in ${minutes} min. If this repository does not deploy for these paths, Request changes and say so. Wrangler keeps polling in case a run appears.`;
};
const DECLARED_BY = { agent: 'Declared by its agent', planner: 'Declared by Wrangler', auto: 'Declared automatically' };
function declaredHtml(ev, f, more, key) {
  const { head, rest } = leadSentence(f.detail);
  const behind = `${rest ? `<p>${esc(rest)}</p>` : ''}${f.tried.length ? `<b>Tried</b><ul>${f.tried.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}`;
  const why = behind ? more(`declared:${key}`, `Why${f.tried.length ? ` · tried ${f.tried.length}` : ''}`, `<div class="job-event-why">${behind}</div>`, 'job-event-more') : '';
  return `<div class="job-event-fix declared${ev.detail ? '' : ' alone'}">${ICONS.x}<span>${f.ask ? `<b class="ask">${esc(f.ask)}</b>` : `<b>${esc(f.title)}</b>`}${esc(head)}${why}<small>${DECLARED_BY[f.by] || DECLARED_BY.planner}${f.options ? ' · options are in the job’s plan change' : ''}</small></span></div>`;
}
// What happened, in the danger register. Title and detail are agent- or
// observation-written, so both are escaped. A declaration leads with the decision
// it needs and the first sentence of why; the rest and what was tried wait behind
// `more` (the dialog's kept disclosure).
function eventHtml(job, sub, more) {
  const ev = eventFor(job, sub);
  if (!ev) return '';
  const f = ev.fix;
  // Under the failure, what Wrangler did about it (job-red.js): looking at it, a fix
  // waiting for you, or given up on with what it tried and the decision it needs.
  const fix = !f ? '' : f.kind === 'fixing'
    ? `<div class="job-event-fix fixing">${ICONS.spin}<span><b>${esc(f.title)}</b>${f.n ? `<small>try ${f.n}</small>` : ''}</span></div>`
    : f.kind === 'ready'
      ? `<div class="job-event-fix ready">${ICONS.sparkle}<span><b>${esc(f.title)}</b>${esc(leadSentence(f.detail).head)}<small>${f.waits ? 'Waiting because Red steps is “You decide”' : 'Waiting for you: it changes the plan or claims something about the outside world'}</small></span></div>`
      : declaredHtml(ev, f, more, sub?.id || 'job');
  // A declaration that repeats the failure word for word stands in for it.
  if (!ev.detail && f) return `<div class="job-event">${fix}</div>`;
  return `<div class="job-event">${ICONS.x}<div><b>${esc(ev.title)}</b><p>${esc(ev.detail)}</p>${fix}</div></div>`;
}
// A sub-job's prerequisites that still matter, as small chips: one dropped, or
// still holding it, is why nothing happens. A met one is history, kept in Details.
const depsOf = (job, sub) => sub.after.map((id) => job.subJobs.find((s) => s.id === id));
function depsHtml(job, sub) {
  const deps = depsOf(job, sub).filter((d) => !dependencySatisfied(d));
  if (!deps.length) return '';
  return `<div class="job-dependency-list">${deps.map((d) => {
    const [icon, tone] = d?.cancelledAt ? [ICONS.x, 'bad'] : [ICONS.lock, 'idle'];
    return chip(icon, d?.title, { cls: `tone-${tone}`, title: `${isPrSub(sub) ? 'Start after' : 'After'} ${d?.title}${isPrSub(d) ? ' deploys' : ''}${d?.cancelledAt ? ' (dropped)' : ''}` });
  }).join('')}</div>`;
}
const metDepsHtml = (job, sub) => { const met = depsOf(job, sub).filter(dependencySatisfied); return met.length ? `<p class="job-deps-met">After: ${met.map((d) => esc(d.title)).join(', ')}</p>` : ''; };

// The five checkpoint rows New job and Automation settings share, each starting
// on `you[field]` (settings.reviewDefaults, so a write can still be held one by
// one in plan review); `bindReviewPoints` keeps each hint (the name's tooltip) on the choice. Only
// settings warns about Plan on Auto: there it also starts agent-created jobs.
const PLAN_AUTO_NOTE = 'Jobs agents create will start work without your approval too';
const planNote = (cp, you, warn) => cp.field === 'reviewPlan' && warn ? `<span class="job-review-note"${you ? ' hidden' : ''}>${PLAN_AUTO_NOTE}</span>` : '';
export const reviewPointsHtml = (you, { warn = false } = {}) => CHECKPOINTS.map((cp) => `<div class="job-review" data-checkpoint="${cp.field}"><div class="job-review-row"><span class="job-review-stage">${ICONS[cp.icon]}</span><span class="job-review-name" title="${checkpointHint(cp, you[cp.field])}">${cp.name}${planNote(cp, you[cp.field], warn)}</span>${checkpointToggleHtml(cp, you[cp.field])}</div></div>`).join('');
const bindReviewPoints = (form) => form.querySelectorAll('.job-review').forEach((row) => row.onchange = () => {
  const cp = checkpoint(row.dataset.checkpoint);
  const input = form.elements[cp.field]; syncCheckpointToggle(input, cp);
  row.querySelector('.job-review-name').title = checkpointHint(cp, input.checked);
  const note = row.querySelector('.job-review-note'); if (note) note.hidden = input.checked;
});
const reviewFlagsOf = (values) => Object.fromEntries(CHECKPOINTS.map((cp) => [cp.field, values.get(cp.field) === 'you']));
// What each place can be asked for (server/jobs-schema.js PLACE_ACTIONS); every
// write hangs under the session that makes it.
const PLACE_ACTIONS = { jira: ['transition', 'comment'], slack: ['post', 'make'], confluence: ['create', 'comment', 'make'], artifact: ['make'], file: ['make'], url: ['make'], other: ['write', 'make'] };
const ACTION_LABEL = { post: 'Post a message', create: 'Create a page', comment: 'Comment on a page', write: 'Do something there' };
const MADE_ONLY = ['artifact', 'file', 'url'];
export const writeOwner = (plan, w) => plan.subJobs.find((s) => s.id === w.by) || null;
const reviewToggleHtml = (job, w) => `<label class="job-write-toggle"><input type="checkbox" name="review" ${writeReviewed(job, w) ? 'checked' : ''}><span title="${isMakeWrite(w)
  ? 'Off: it is done as soon as its session reports where it is. On: once its session publishes it, it waits for you to accept it.'
  : 'Off: its session makes it and reports a receipt. On: its session drafts it and waits while you approve the exact change, edit it or skip it.'}"><b>${isMakeWrite(w) ? 'Review once published' : 'Review before writing'}</b></span></label>`;
// A write's fields, shared by the plan-review editor, a live write's Edit form
// and the panel a draft in review is approved from. `plan` supplies the owning
// session, stories and the workflow statuses the planner read; a status the
// workflow does not list (an older plan, a planner that read none) is still
// offered as typed. In plan review (`pick`) the place and what is done there
// can change too; live, they are what the write is. In review (`inReview`)
// only what it writes can change. When it is made is its session's business.
export function writeFieldsHtml(plan, w, { ticket = false, pick = false, job = null, inReview = false } = {}) {
  const type = placeOf(w);
  const a = w.action || {};
  const owner = writeOwner(plan, w);
  const review = inReview ? '' : reviewToggleHtml(job, w);
  if (isStoryCreate(w)) return `<p class="job-write-hint">${ICONS.info}<span>${esc(owner?.title || 'Its session')} creates this story in Jira; whatever names the story waits for its key. With review on it is drafted for you first, and you can change its summary and fields then.</span></p>${review}`;
  const types = Object.keys(PLACES).filter((t) => t === type || ((isSessionSub(owner) || !MADE_ONLY.includes(t)) && (t !== 'jira' || plan.stories?.length)));
  const actions = (PLACE_ACTIONS[type] || []).filter((x) => x !== 'make' || isSessionSub(owner) || x === a.type);
  const actionLabel = (x) => x === 'make' ? `Made by ${owner?.title || 'its session'}` : ACTION_LABEL[x];
  // Radios rather than a select, so "Something else" can read as the open-ended one.
  const picker = pick ? `<fieldset class="job-place-pick"><legend>Place</legend>${types.map((t) => `<label class="job-place-opt ${t === 'other' ? 'other' : ''}" title="${esc(PLACES[t].name)}"><input type="radio" name="placeType" value="${t}" ${t === type ? 'checked' : ''}>${PLACES[t].icon}<span>${esc(t === 'other' ? 'Something else' : PLACES[t].short)}</span></label>`).join('')}</fieldset>
    ${type !== 'jira' && actions.length > 1 ? `<div class="job-form-row"><label>Do<select name="actionType">${actions.map((x) => `<option value="${x}" ${x === a.type ? 'selected' : ''}>${esc(actionLabel(x))}</option>`).join('')}</select></label></div>` : ''}` : '';
  const why = w.why ? `<p class="job-write-why"><b>Wrangler:</b> ${esc(w.why)}</p>` : '';
  const filled = '{pr.url}, {pr.title} and {deploy.run} come from its session\'s trigger, {<write id>.url} from that write once made';
  const tip = (hint) => hint ? ` title="${esc(hint)}"` : '';
  const refField = (label, hint, placeholder) => `<label${tip(hint)}>${label}<input name="ref" maxlength="500" value="${esc(w.place?.ref || '')}" placeholder="${esc(placeholder)}"></label>`;
  const textField = (label, optional) => `<label${tip(`${optional ? 'Optional · ' : ''}${filled}`)}>${label}<textarea name="text" rows="3" maxlength="2000">${esc(a.text || '')}</textarea></label>`;
  const elsewhere = type === 'other' ? `<div class="job-form-row"><label${tip('One line: what it is called')}>Place<input name="name" maxlength="60" value="${esc(w.place?.name || '')}" placeholder="Status page"></label>${refField('Where', 'Optional · a link or a path', 'https://…')}</div>` : '';
  if (a.type === 'make') {
    const where = type === 'slack' ? refField('Channel', '', '#channel') : type === 'confluence' ? refField('Where', 'Optional · space › parent', 'WEB › Incidents') : elsewhere;
    return `${why}${picker}${where}<label${tip('One line; the session it hangs under makes it and reports where it is')}>What it is<input name="what" maxlength="180" value="${esc(a.what || '')}"></label>${review}`;
  }
  if (type === 'other') return `${why}${picker}${elsewhere}<label${tip(`The one instruction its session follows · ${filled}`)}>What to do there<textarea name="text" rows="3" maxlength="2000">${esc(a.text || '')}</textarea></label>${review}`;
  if (type === 'slack') return `${why}${picker}${refField('Channel', '', '#channel')}${textField('Post')}${review}`;
  if (type === 'confluence') {
    return a.type === 'create' ? `${why}${picker}${refField('Where', 'Space › parent page', 'WEB › Incidents')}<label>Title<input name="title" maxlength="180" value="${esc(a.title || '')}"></label>${textField('Body', true)}${review}`
      : `${why}${picker}${refField('Page', '', 'https://…/wiki/…')}${textField('Comment')}${review}`;
  }
  const statuses = workflowFor(plan, w);
  const to = a.to || '';
  const moveTo = statuses.length
    ? `<select name="to"><option value="" ${to ? '' : 'selected'}>No transition (comment only)</option>${[...statuses, ...(to && !statuses.includes(to) ? [to] : [])].map((st) => `<option value="${esc(st)}" ${st === to ? 'selected' : ''}>${esc(st)}</option>`).join('')}</select>`
    : `<input name="to" maxlength="180" value="${esc(to)}" placeholder="Status name, or blank to comment only">`;
  const stories = ticket && plan.stories?.length > 1 ? `<label>Ticket<select name="storyId">${plan.stories.map((t) => `<option value="${esc(t.id)}" ${t.id === w.storyId ? 'selected' : ''}>${esc(storyLabel(t, plan.stories))} · ${esc(t.title)}</option>`).join('')}</select></label>` : '';
  return `${why}${picker}${stories}<label>Move to${moveTo}</label>
    <label${tip(`Optional · ${filled}`)}>Comment<textarea name="comment" rows="3" maxlength="2000">${esc(a.comment || '')}</textarea></label>${review}`;
}
// The fields as the write they describe; empty means none, absent means the
// form has no such field.
export function readWriteFields(el) {
  const v = (n) => el.querySelector(`[name="${n}"]`);
  const text = (n) => (v(n) ? v(n).value.trim() : undefined);
  return { placeType: el.querySelector('[name="placeType"]:checked')?.value, actionType: v('actionType')?.value,
    to: text('to'), comment: text('comment'), text: text('text'), title: text('title'), what: text('what'), ref: text('ref'), name: text('name'),
    hasReview: !!v('review'), review: !!v('review')?.checked, storyId: v('storyId')?.value };
}
// The write the fields describe, from the one they were drawn for: a new place
// type or action starts that write afresh, keeping its session and whether it
// is reviewed. Pure; the plan editor stores it and a live Edit sends the difference.
export function writeFromFields(plan, w, f) {
  const review = f.hasReview ? f.review : w.review;
  if (isStoryCreate(w)) return { ...w, ...(review === undefined ? {} : { review }) };
  const owner = writeOwner(plan, w);
  const type = f.placeType || placeOf(w);
  const retyped = type !== placeOf(w);
  let act = retyped ? PLACE_ACTIONS[type].find((x) => x !== 'make' || isSessionSub(owner) || MADE_ONLY.includes(type)) : f.actionType || w.action?.type;
  if (type === 'jira') act = f.to || (retyped && !f.comment) ? 'transition' : 'comment';
  const name = type === 'other' && !retyped ? f.name ?? w.place?.name : '';
  const next = { ...w, place: { type, ...(name ? { name } : {}), ...((retyped ? '' : f.ref) ? { ref: f.ref } : {}) } };
  for (const k of ['review', 'storyId', 'jiraKey']) delete next[k];
  if (review !== undefined) next.review = review;
  if (type === 'jira') { next.storyId = (retyped ? owner?.storyId || plan.stories?.[0]?.id : f.storyId || w.storyId); if (!retyped && next.storyId === w.storyId && w.jiraKey) next.jiraKey = w.jiraKey; }
  if (act === 'make') {
    next.action = { type: 'make', what: retyped || w.action?.type !== 'make' ? w.action?.what || '' : f.what || '' };
    if (!next.action.what) delete next.action.what;
    return next;
  }
  const fresh = retyped || act !== w.action?.type;
  const pick = (k) => (fresh ? undefined : f[k]) || undefined;
  next.action = Object.fromEntries(Object.entries(type === 'jira' ? { type: act, to: f.to || undefined, comment: f.comment || undefined }
    : act === 'post' ? { type: act, text: pick('text') } : act === 'create' ? { type: act, title: pick('title'), text: pick('text') } : { type: act, text: pick('text') }).filter(([, x]) => x !== undefined));
  if (type === 'jira' && retyped) next.action = statusDefault(plan, next);
  return next;
}
// A new Jira write moves the ticket to the first status past its start that
// reads like review, or comments the PR its session waits on where the planner
// read no workflow.
function statusDefault(plan, w) {
  const statuses = workflowFor(plan, w);
  return statuses.length ? { type: 'transition', to: statuses.find((st) => /review/i.test(st)) || statuses[Math.min(1, statuses.length - 1)] } : { type: 'comment', comment: writeOwner(plan, w)?.on ? 'PR: {pr.url}' : 'Update from this job.' };
}
// An `other` place's name goes only when changed: every other place has none.
const nameEdit = (sub, f) => f.name !== undefined && f.name !== (sub.place?.name || '') ? { name: f.name } : {};
// The live Edit's payload (server/job-writes.js writeEditSchema): every field
// the form shows, null where emptied, so the server sees exactly this write.
export function writeEditPayload(sub, f) {
  if (isStoryCreate(sub)) return { review: f.review };
  const action = Object.fromEntries(['to', 'comment', 'text', 'title', 'what'].filter((k) => f[k] !== undefined).map((k) => [k, f[k] || null]));
  return { action, ...(f.ref !== undefined ? { ref: f.ref || null } : {}), ...nameEdit(sub, f), ...(f.hasReview ? { review: f.review } : {}) };
}
// What approving a write in review sends with it (approve-write's `write`, the
// edit-write shape): only what the human changed in the panel, null where
// emptied, and never `review`. `story` is a create's own summary and fields.
// Null when nothing changed.
export function writeReviewPayload(sub, f, story = null) {
  const a = sub.action || {};
  const action = Object.fromEntries(['to', 'comment', 'text', 'title', 'what'].filter((k) => f[k] !== undefined && (f[k] || null) !== (a[k] || null)).map((k) => [k, f[k] || null]));
  const write = { ...(Object.keys(action).length ? { action } : {}), ...(f.ref !== undefined && (f.ref || null) !== (sub.place?.ref || null) ? { ref: f.ref || null } : {}), ...nameEdit(sub, f), ...(story ? { story } : {}) };
  return Object.keys(write).length ? write : null;
}
// A create's story as the panel left it, against the story as planned: the
// summary if it changed, and the whole field list if any of it did (the server
// replaces fields wholesale). An emptied field is one the create leaves unset.
export function storyEdit(story, draft) {
  const fields = draft.fields.map((x) => ({ name: x.name.trim(), value: x.value.trim() })).filter((x) => x.name && x.value);
  const title = draft.title.trim();
  const edit = { ...(title !== (story?.title || '') ? { title } : {}), ...(JSON.stringify(fields) !== JSON.stringify(story?.fields || []) ? { fields } : {}) };
  return Object.keys(edit).length ? edit : null;
}
// happy-dom (the view tests' DOM) misreads `selected` past an option's second
// sibling; pinning each select to its marked option is a no-op in a browser.
const pinSelects = (el) => el.querySelectorAll('select').forEach((sel) => { const o = sel.querySelector('option[selected]'); if (o) sel.value = o.value; });
// Mirrors the server's write rules (jobs-schema.js writeRules) for what an
// editor can leave half-filled: the sentence that says what is missing.
export function writeProblem(w) {
  if (!isWriteSub(w) || isStoryCreate(w)) return '';
  const a = w.action || {};
  const type = placeOf(w);
  if (type === 'slack' && !w.place?.ref) return 'Name the channel.';
  if (type === 'other' && !w.place?.name) return 'Name the place.';
  if (a.type === 'make') return a.what ? '' : 'Say in a line what the session makes.';
  if (type === 'other') return a.text ? '' : 'Say what to do there.';
  if (type === 'jira') return a.to || a.comment ? '' : 'A write moves the ticket, comments on it, or both.';
  if (type === 'slack') return a.text ? '' : 'Write the post.';
  if (a.type === 'create') return !w.place?.ref ? 'Say where the page goes.' : a.title ? '' : 'Give the page a title.';
  return !w.place?.ref ? 'Paste the page’s URL.' : a.text ? '' : 'Write the comment.';
}

// The approve button's title: what Approve starts and how many writes wait for
// the human. Each write's own review decides whether it waits.
export function authorityText(job, plan) {
  const writes = plan.subJobs.filter(isWriteSub);
  const creates = writes.filter(isStoryCreate);
  // A keyless story always gets a create write on the server; one not in this
  // draft yet is reviewed by the job's default.
  const stories = (plan.stories || []).filter((t) => !t.key && writeReviewed(job, creates.find((c) => c.storyId === t.id) || {})).length;
  const held = stories + writes.filter((w) => !isStoryCreate(w) && writeReviewed(job, w)).length;
  const steps = plan.subJobs.length - writes.length;
  return `Starts ${steps} step${steps === 1 ? '' : 's'}${held ? ` · ${held} write${held === 1 ? '' : 's'} held for you` : ''}`;
}

// What a refused cleanup would lose, exactly as the server listed it: commit
// subjects and paths are agent-written, so all of it is escaped.
const plural = (n) => n === 1 ? '' : 's';
const andMore = (shown, total) => total > shown ? `<li><small>and ${total - shown} more</small></li>` : '';
export function lossHtml(r) {
  return `${r.cause === 'detached' ? `<p>The worktree is on a detached HEAD at <code>${esc(String(r.head).slice(0, 8))}</code>${r.state ? `, with a ${esc(r.state)} in progress` : ''}, not on <code>${esc(r.branch)}</code>${r.branchHead ? ` (at <code>${esc(r.branchHead.slice(0, 8))}</code>)` : ''}.</p>` : ''}
    ${r.cause === 'unreadable' ? `<p>Git could not read the worktree: <code>${esc(r.error || '')}</code></p>` : ''}
    ${r.cause === 'unremovable' ? `<p>Could not remove the worktree: <code>${esc(r.error || '')}</code></p>` : ''}
    ${r.commitCount ? `<h4>${r.commitCount} commit${plural(r.commitCount)} not on origin/${esc(r.base)}</h4><ul class="job-checks job-loss">${r.commits.map((c) => `<li><code>${esc(c.sha.slice(0, 8))}</code> ${esc(c.subject)} <small>${c.pushed ? 'on a branch on origin' : 'not pushed'}</small></li>`).join('')}${andMore(r.commits.length, r.commitCount)}</ul>` : ''}
    ${r.fileCount ? `<h4>${r.fileCount} uncommitted file${plural(r.fileCount)}</h4><ul class="job-checks job-loss">${r.files.map((f) => `<li><code>${esc(f.path)}</code> <small>${esc(f.change)}</small></li>`).join('')}${andMore(r.files.length, r.fileCount)}</ul>` : ''}
    ${r.stale ? `<p>Origin could not be reached, so whether origin/${esc(r.base)} still has this branch’s commits is unconfirmed.</p>` : ''}
    ${!r.cause && !r.commitCount && !r.fileCount && !r.stale ? `<p>Branch <code>${esc(r.branch)}</code> at ${esc(String(r.head).slice(0, 8))}.</p>` : ''}`;
}
// A checkout the fast-forward left alone (server/job-main.js): what is in the way,
// what origin has that it lacks, a button per fix an agent can make, Retry and Dismiss.
const MAIN_REASON = {
  dirty: (n) => `It has uncommitted changes, so it was left as it was. ${n.localCount ? 'Commit or stash them, then Retry.' : 'Stash & update has an agent do it, or commit or stash them yourself, then Retry.'}`,
  diverged: (n) => `It has commits origin/${esc(n.base)} does not, so it cannot fast-forward. Pick a fix for an agent to make, or push or rebase them yourself, then Retry.`,
  failed: (n) => `The update failed: ${esc(n.error || 'unknown error')}`,
};
const commitList = (title, list, count) => count ? `<h4>${title}</h4><ul class="job-checks job-loss">${list.map((c) => `<li><code>${esc(c.sha.slice(0, 8))}</code> ${esc(c.subject)}</li>`).join('')}${andMore(list.length, count)}</ul>` : '';
export function mainNoticeHtml(job) {
  return (job.mainNotices || []).map((n) => `<section class="job-main-notice" data-main-path="${esc(n.path)}"><h3>${ICONS.branch}Local ${esc(n.base)} not updated <small>${esc(tildify(n.path))}</small></h3>
    <p>${(MAIN_REASON[n.reason] || MAIN_REASON.failed)(n)} Your PRs are merged either way; only this checkout is behind.</p>
    ${n.dirtyCount ? `<h4>${n.dirtyCount} uncommitted file${plural(n.dirtyCount)}</h4><ul class="job-checks job-loss">${n.dirty.map((f) => `<li><code>${esc(f.path)}</code> <small>${esc(f.change)}</small></li>`).join('')}${andMore(n.dirty.length, n.dirtyCount)}</ul>` : ''}
    ${commitList(`${n.localCount} local commit${plural(n.localCount)} not on origin`, n.localOnly || [], n.localCount)}
    ${commitList(`${n.incomingCount} new on origin/${esc(n.base)}`, n.incoming || [], n.incomingCount)}
    ${n.resolving ? `<p class="job-main-agent">${n.resolving.sessionId ? ICONS.robot : ICONS.spin}<span>${n.resolving.sessionId ? 'An agent is working on it' : 'Starting an agent'}: <b>${esc(n.resolutions?.find((r) => r.id === n.resolving.id)?.label || n.resolving.id)}</b>. This clears once local ${esc(n.base)} matches origin.</span></p>` : ''}
    ${n.resolveError ? `<p class="job-main-error">Could not start the agent: ${esc(n.resolveError)}</p>` : ''}
    <div class="job-actions">${n.resolving?.sessionId ? `<button class="primary" data-main-session="${esc(n.resolving.sessionId)}">${ICONS.terminal}Open session</button>` : ''}${n.resolving ? '' : (n.resolutions || []).map((r, i) => `<button ${i ? '' : 'class="primary"'} data-main-resolve="${esc(r.id)}" title="${esc(r.title)}. Starts an agent in this checkout that does only this.">${ICONS.robot}${esc(r.label)}</button>`).join('')}<button ${n.resolving || n.resolutions?.length ? '' : 'class="primary"'} data-main-retry ${n.retrying ? 'disabled' : ''} title="Try the update again, after you have fixed it yourself">${n.retrying ? ICONS.spin : ICONS.wrench}${n.retrying ? 'Retrying' : 'Retry'}</button><button data-main-dismiss title="Leave this checkout as it is and forget this notice">${ICONS.x}Dismiss</button></div></section>`).join('');
}
// Paused at its spend limit (server/job-budget.js): what it spent, and the one way on.
export const budgetHtml = (job) => budgetHeld(job) ? `<section class="job-main-notice job-budget"><h3>${ICONS.pause}Paused for budget <small>${esc(budgetLine(job))}</small></h3>
    <p>This job reached its spend limit, so nothing new starts and its working sessions were interrupted. Resume does not lift it: add ${esc(dollars(job.spendStep ?? 0))} to its limit and it carries on${job.topUps ? ` (added ${job.topUps} time${plural(job.topUps)} so far)` : ''}, or change the limit for every job in Automation settings.</p>
    <div class="job-actions"><button class="primary" data-top-up title="Raise this job's limit to ${esc(dollars((job.spendLimit ?? 0) + (job.spendStep ?? 0)))} and resume it">${ICONS.plus}${esc(topUpLabel(job))}</button></div></section>` : '';
const refusalHtml = (sub) => {
  const r = sub.cleanupRefusal;
  if (!r || sub.discard) return '';
  const where = `<code>${esc(tildify(r.path || sub.worktree?.path || ''))}</code>`;
  if (r.cause === 'unremovable') return `<h3>Kept for you <small>Cleanup could not remove this</small></h3>${lossHtml(r)}<p class="job-authority">Something may still be running in ${where}, such as a dev server, a build or an editor. Stop it and Retry, or Discard to delete that folder with everything in it and the local branch <code>${esc(r.branch)}</code>.</p>`;
  return `<h3>Kept for you <small>Cleanup would lose this</small></h3>${lossHtml(r)}<p class="job-authority">Save anything you want from ${where}, then Retry${r.cause === 'unreadable' ? '. Git cannot read it, so there is nothing to pin a Discard to; repair or clear it by hand' : r.pinned === false ? '. It holds a submodule or too much to pin a Discard to what you see here, so clear it by hand' : '; or Discard anyway to delete the worktree and its local branch as listed here'}.</p>`;
};

// The board's own Cmd/Ctrl+Enter handlers only reach the elements they own, and
// this dialog hangs off <body> outside every one of them, so the chord is matched
// again here to the same rule: plain Cmd or Ctrl, inert once alt or shift is held.
export const isPrimaryActionKey = (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.altKey && !e.shiftKey;
// A chat box sends on Enter, the chord included; Shift+Enter is a new line, and
// an Enter that commits an IME composition is the composition's, not a send
// (Safari reports that one after compositionend, as keyCode 229).
export const isChatSendKey = (e) => e.key === 'Enter' && !e.altKey && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
// A dialog's primary action is either its form's primary button — fired through
// requestSubmit so `required` and the submitter (New job's start/backlog pair)
// behave exactly as the click does — or, on a detail, the lone primary
// [data-action]. A confirmation whose only buttons are destructive (Drop, Cancel
// job) has neither and stays keyboard-inert: those are for the mouse to say.
export function primaryAction(dialog) {
  const form = dialog.querySelector('form');
  const button = form ? form.querySelector('button.primary:not([type="button"])') : dialog.querySelector('button.primary[data-action]');
  if (!button || button.disabled) return null;
  return form ? () => form.requestSubmit(button) : () => button.click();
}

const MAX_ASK_IMAGES = 4;
export function initJobsView({ send, stageImage, frameOf = sourceToFrame, getAgents, getTasks = () => [], onSession, onDiff, onBoard, onIntro = () => {}, onThemeChoice = () => {}, now = () => Date.now(), files = null, onOpenFile = null, updates = null, storage = null, toast = () => {}, toastError = toast }) {
  setFileOpener(files ? (path) => files.canOpen(path) : null);
  const root = document.getElementById('jobs');
  const dialog = document.getElementById('job-dialog');
  wireDeps(root); wireDeps(dialog);
  const markOpened = guardOpen(dialog, { now });
  let data = { jobs: [], settings: { concurrency: 8, maxRepairs: 2, maxReplans: 2, deploymentStaleMinutes: 30 } };
  // Ideas on the board at the last render, and those forming into a job since (id → { start, ms, stage }):
  // `stage` is the idea's sky as last drawn, so the painted cloud is kept rather than drawn again.
  let ideasShown = new Set();
  const forming = new Map();
  let filter = 'all', selected = null, planDraft = null, revision = null, basePlan = null, writeEdit = null;
  // A story create in review: its summary and fields as the panel holds them,
  // so adding or removing a field (which redraws) keeps what was typed.
  let storyDraft = null;
  const commentsShown = new Set();
  // Each job's plate scene, kept for the life of the view.
  const scenes = new Map();
  // The New job dialog's model picker while that dialog is open, and Automation settings' theme picker.
  let picker = null, themePicker = null;
  // The theme #jobs is drawn in, and the unmount of its live art (themes.js mount).
  let theme = null, unmountTheme = null;
  // Kept images by name, filled by `job-images` frames; asked once per job.
  const imageCache = new Map();
  // The proof a Code review step shows (job-proof.js): thumbnails and opened files by
  // `job-evidence` frames, and which item the shot viewer has open.
  const evidence = new EvidenceCache();
  let proofView = null;
  // The tail of a log the Logs button asked for (`job-running-log` frames), by sub-job.
  const runLogs = new Map();
  // What "Ask about this" starts the Request changes box with, once.
  let askDraft = null;
  // The one box writes to one conversation at a time: the one the human pointed it
  // at, by view ('' the job, else a step's id; '' a new conversation), and what was
  // typed for each target while it pointed elsewhere (`<view>|<convo>`).
  const replyTo = new Map(), boxDrafts = new Map();
  // Pictures pasted, dropped or picked into an idea box, staged as they land (api.images.stage); sent with the idea.
  // Each is the box's it went into (`box`: its conversation's id, '' for a new one).
  let askImages = [];
  // The idea last sent from this dialog, drawn as a bubble above its box until the
  // dialog moves on: `state` is sending, sent or failed (the job-action frames).
  let askSent = null;
  const askedImages = new Set();
  // New idea's conversation: the reply this tab sent until the thread holds it, the
  // suggestion pressed here while its hole flares, how many messages were last drawn
  // (a new one scrolls the thread to it), and the idea a fresh New idea opens on.
  let ideaSent = null, ideaFiring = null, ideaSeen = null, openOnCreate = null;
  // The backlog idea whose words are open to edit in its dialog.
  let ideaEdit = null;
  const ideaDrawn = new Set();
  const freshMessage = (id) => !ideaDrawn.has(id) && !!ideaDrawn.add(id);
  // Ideas drawn with the title loader, then when their title landed: a tick redraws the
  // dialog mid-fade, so each draw resumes the cross-fade where it is (ms in) until it ends.
  const titleWaited = new Map();
  const titledNow = (job) => {
    if (job.titlePending) { titleWaited.set(job.id, null); return false; }
    if (!titleWaited.has(job.id)) return false;
    if (titleWaited.get(job.id) == null) titleWaited.set(job.id, Date.now());
    const since = Date.now() - titleWaited.get(job.id);
    if (since < TITLE_FADE_MS) return since;
    titleWaited.delete(job.id);
    return false;
  };
  // Which folded sections the human has opened: the detail is rebuilt on every
  // graph tick, so the open state has to outlive the markup.
  const openMore = new Set();
  // Snapshots written before the setting existed carry no `ideApp`.
  const ideApp = () => data.settings.ideApp || 'IntelliJ IDEA';
  // Which nodes in the plan stepper have their dependency editor open: a
  // dependency change redraws the whole stepper (the node moves wave), so the
  // open state has to outlive the markup or the editor snaps shut under the pointer.
  const openDeps = new Set();
  // The same for each PR node's Show me editor.
  const openShow = new Set();
  // The detail footer's checkpoint buttons. Their hint, a pending switch, an Undo
  // and an open confirm all outlive the markup, which every graph tick rebuilds.
  let flags = null;
  const resetFlags = (jobId = null) => { flags = { jobId, hover: null, note: null, pending: null, confirm: null, inside: false, painting: false }; };
  resetFlags();
  const openTickets = new Set();
  root.innerHTML = `<header class="jobs-mast"><div class="jobs-top"><div><div class="jobs-kicker" id="jobs-date"></div><h1>Wrangler²</h1></div>
      <div class="jobs-telemetry"><span class="jobs-beacon" id="jobs-active-count" aria-live="polite"></span><span class="jobs-bays" id="jobs-bays" aria-hidden="true"></span><span id="jobs-spend"></span><span id="jobs-delivered"></span></div>
      <div class="jobs-tools"><label class="jobs-ghost" title="Agents at once. Waiting for pipelines, dependencies and reviews uses none.">${ICONS.robot}<input id="jobs-concurrency" type="number" min="1" max="16" value="8" aria-label="Agents at once"></label><button id="jobs-pause" class="jobs-ghost"></button><button id="jobs-intro-open" class="jobs-icon" title="How Jobs works" aria-label="How Jobs works">${ICONS.info}</button><button id="jobs-settings" class="jobs-icon" title="Automation settings" aria-label="Automation settings">${ICONS.gear}</button><button class="jobs-newjob" id="job-new">${ICONS.plus}New idea</button></div></div>
      <nav class="jobs-rail" aria-label="Show jobs">${FILTERS.map(([key, label]) => `<button type="button" data-filter="${key}" aria-pressed="${key === filter}">${label}<span class="jobs-rail-n" ${key === 'needs' ? 'id="jobs-review-count"' : ''}></span></button>`).join('')}</nav></header>
    <div id="jobs-boards" class="jobs-plates" aria-live="polite"></div>`;
  // Outside #jobs-boards, so a graph tick's redraw never touches a half-typed idea.
  const idea = createIdeaCorner({ send });
  root.appendChild(idea.el);
  const q = (s) => root.querySelector(s);
  // #jobs and every dialog it opens on <body> wear the saved theme; switching swaps the live art.
  function applyViewTheme() {
    const t = themeOf(data.settings);
    setCurrentTheme(t);
    for (const el of [root, dialog, ...document.querySelectorAll('.jobs-intro, .jobs-update, .job-image-zoom, .job-shotbox')]) applyTheme(el, t);
    if (t === theme) return t;
    unmountTheme?.(); theme = t; unmountTheme = t.mount?.(root) || null;
    return t;
  }
  // A theme choice applies at once, ahead of the snapshot that confirms it.
  function saveSettings(patch) {
    send({ type: 'job-settings', patch });
    data = { ...data, settings: { ...data.settings, ...patch } };
    render();
  }
  // The markup last put on the board and in the detail (with the job it drew): a tick
  // that would draw the same again leaves the DOM, and so a selection or scroll, alone.
  // Anything that changes that DOM by hand forgets it, so the next tick redraws.
  let boardHtml = null, detailShown = null;
  const hold = createRedrawHold(() => [q('#jobs-boards'), dialog]);
  function update(snapshot) {
    data = snapshot || data;
    hold.run(refresh);
  }
  function refresh() {
    const job = data.jobs.find((j) => j.id === flags.jobId);
    if (flags.pending && job && youReview(job, flags.pending.field) === flags.pending.you) flags.pending = null;
    // A plan approved from the footer (Plan switched to Auto) leaves review: the
    // draft goes, so the detail follows the job instead of the frozen editor.
    if (planDraft && job && job.id === selected?.jobId && !selected.subId && job.stage !== 'planning') planDraft = null;
    render(); picker?.agentsChanged(getAgents()); themePicker?.sync(themeOf(data.settings).id);
    if (openOnCreate && data.jobs.some((j) => j.id === openOnCreate)) { const id = openOnCreate; openOnCreate = null; openDetail(id); }
  }
  function render() {
    const cards = jobCards(data.jobs);
    // A run parked on its drafts holds no slot (server/job-store.js holdsSlot).
    const active = data.jobs.flatMap((j) => j.runs).filter((r) => !r.stopped && !(r.parkedAt && !r.mailedAt)).length;
    const paused = !!data.settings.paused;
    const { concurrency } = data.settings;
    root.classList.toggle('jobs-paused', paused);
    q('#jobs-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    q('#jobs-active-count').innerHTML = `<b>${active}</b>/${concurrency}`;
    q('#jobs-active-count').title = `${active} of ${concurrency} agents ${paused ? 'paused' : 'working'}`;
    q('#jobs-bays').innerHTML = Array.from({ length: Math.max(concurrency, active) }, (_, i) => `<i class="${i < active ? 'on' : ''}"></i>`).join('');
    const spend = data.jobs.filter((j) => j.stage !== 'done').reduce((a, j) => a + (j.usd || 0), 0);
    q('#jobs-spend').innerHTML = spend > 0 ? `<b>$${spend.toFixed(2)}</b> on open jobs` : '';
    q('#jobs-delivered').innerHTML = `<b>${cards.filter((c) => c.sub?.stage === 'done' && !c.sub.cancelledAt).length}</b> delivered`;
    if (document.activeElement !== q('#jobs-concurrency')) q('#jobs-concurrency').value = concurrency;
    const pause = q('#jobs-pause');
    pause.innerHTML = paused ? `${ICONS.play}<span>Paused</span>` : `${ICONS.pause}<span>Pause</span>`;
    pause.title = paused ? 'Resume automation' : 'Pause new work';
    pause.setAttribute('aria-label', pause.title);
    pause.setAttribute('aria-pressed', String(paused));
    for (const [key, , test] of FILTERS) {
      const b = q(`[data-filter="${key}"]`), n = data.jobs.filter((j) => test(j)).length;
      b.setAttribute('aria-pressed', String(key === filter));
      b.querySelector('.jobs-rail-n').textContent = n || '';
      b.querySelector('.jobs-rail-n').classList.toggle('ask', key === 'needs' && n > 0);
      // Amber while anything needs acting on; the read tone once all that waits is a wrangler reply to read.
      b.querySelector('.jobs-rail-n').classList.toggle('read', key === 'needs' && n > 0 && data.jobs.filter((j) => test(j)).every((j) => plateAsk(j)?.tone === 'read'));
    }
    assignScenes(data.jobs, scenes);
    const test = FILTERS.find(([key]) => key === filter)[2];
    const jobs = sortJobs(data.jobs.filter((j) => test(j)));
    const empty = !data.jobs.length ? 'Start with an outcome.<br>Wrangler will shape the work.' : filter === 'needs' ? 'Nothing needs you right now.' : filter === 'ideas' ? 'No ideas being talked through.' : 'No jobs here.';
    const t = applyViewTheme(), art = t.plateArt(optionsOf(data.settings, t));
    root.dataset.plateArt = art;
    // An idea that gained a plan since the last render forms the job it became (job-forming.js).
    const now = formingClock(), ideas = new Set(data.jobs.filter(ideaOpen).map((j) => j.id)), starting = [];
    for (const j of data.jobs) if (ideasShown.has(j.id) && !ideas.has(j.id) && j.plan && !j.cancelledAt) {
      const stage = +(q(`#jobs-boards [data-board="${CSS.escape(j.id)}"] .gx.nb`)?.dataset.stage ?? 2);
      forming.set(j.id, { start: now, ms: formingMs(), stage }); starting.push(j.id);
    }
    for (const [id, f] of forming) if (now - f.start > f.ms) { forming.delete(id); dropForming(id); }
    ideasShown = ideas;
    const boards = q('#jobs-boards');
    const html = jobs.map((j) => {
      try { return plateHtml(j, scenes.get(j.id), art, { forming: forming.get(j.id)?.stage }); } catch (e) { console.error('jobs: card', j.id, 'failed to draw', e); return ''; }
    }).join('') || `<div class="job-empty jobs-empty">${empty}</div>`;
    if (html !== boardHtml) {
      boardHtml = html;
      const scrolls = keepScrollX(boards);
      holdSkies(boards);
      boards.innerHTML = html;
      mountSkies(boards);
      relight(boards);
      scrolls();
      // Keyed to when each started, so a redraw mid-transition picks it up at the same instant; a
      // render after it drops the cloud, which is clear by then.
      for (const art of boards.querySelectorAll('.job-plate-art.forming')) {
        const id = art.closest('[data-board]').dataset.board;
        mountForming(art, id, forming.get(id));
      }
    }
    if (starting.length) setTimeout(() => { if (root.isConnected) render(); }, Math.max(...starting.map((id) => forming.get(id).ms)) + 50);
    hydrateEvidence(q('#jobs-boards'), evidence, send);
    // Keep a human's plan edits and review snapshot intact across live graph ticks;
    // any open form, or a change being typed, is a human mid-edit and is left alone.
    // A run stopping or going idle bumps the job's revision without touching the
    // plan; only a changed plan may make approval refuse, so an unchanged one
    // adopts the new revision and drops the running lock it was drawn under.
    const reviewed = planDraft && data.jobs.find((j) => j.id === selected?.jobId);
    if (reviewed?.plan && JSON.stringify(reviewed.plan) === basePlan) {
      revision = reviewed.revision;
      const approve = dialog.querySelector('[data-action="approve-plan"]');
      if (approve && !isBusy(approve)) approve.disabled = reviewed.runs.some((r) => !r.stopped);
      // The chip was drawn while the planner was still stopping; it follows the job.
      const chip = dialog.querySelector('.job-appbar .job-chip-state');
      if (chip) chip.outerHTML = stateChip(jobState(reviewed), jobLabel(reviewed));
    }
    // Typing holds nothing: the step's status keeps moving under a half-written idea or note,
    // and what was typed, the cursor and the pictures are carried into the redrawn fields.
    // Only an open form (a write, a cancel question) is left alone, being a decision in progress.
    const humanForm = dialog.querySelector('#job-human-form');
    const currentSub = humanForm && data.jobs.find((j) => j.id === selected?.jobId)?.subJobs.find((s) => s.id === selected?.subId);
    if (dialog.open && selected && !planDraft && !proofView && !dialog.querySelector('form')
      || humanForm && currentSub && (currentSub.stage !== 'human' || humanForm.dataset.state !== currentSub.state)) {
      const fields = keepFields(dialog);
      keepBoxes(); renderDetail(); fields();
    }
  }
  // An idea box with something in it keeps its conversation across a tick: a reply landing
  // elsewhere must not move the words to another target.
  function keepBoxes() {
    const subId = selected?.subId || '';
    for (const box of dialog.querySelectorAll('.job-change:not([data-idea-composer])')) {
      const key = box.dataset.changeConvo || '', text = box.querySelector('textarea').value;
      if (!text && !boxImages(key).length) continue;
      boxDrafts.set(`${subId}|${key}`, text);
      if (!replyTo.has(subId)) replyTo.set(subId, key);
    }
  }
  function show(html) {
    detailShown = null;
    dialog.innerHTML = `<button class="job-dialog-close" aria-label="Close" title="Close">${ICONS.x}</button>${html}`;
    dialog.querySelector('.job-dialog-close').onclick = () => dialog.close();
    dialog.querySelectorAll('details[data-keep]').forEach((d) => d.ontoggle = () => { if (d.open) openMore.add(d.dataset.keep); else openMore.delete(d.dataset.keep); });
    if (!dialog.open) { dialog.showModal(); markOpened(); }
  }
  const more = (key, summary, body, cls = '') => `<details class="job-more ${cls}" data-keep="${key}" ${openMore.has(key) ? 'open' : ''}><summary>${summary}</summary>${body}</details>`;
  // The conversations the human folded or unfolded by hand, by id; kept across redraws and dialogs.
  const convoFold = new Map();
  // Which of a proposal's options is picked; it resets with a new proposal.
  let optionPick = { id: null, i: 0 };
  const pickedOption = (job) => (optionPick.id === job.replan?.proposal?.id && proposalOptions(job.replan.proposal)[optionPick.i] ? optionPick.i : 0);
  function action(name, extra = {}, subId = selected.subId) {
    send({ type: 'job-action', id: selected.jobId, subJobId: subId || undefined, action: name, ...extra });
  }
  function openDetail(jobId, subId) {
    selected = { jobId, subId }; ideaEdit = null; planDraft = null; proofView = null; askDraft = null; replyTo.clear(); boxDrafts.clear(); clearAskImages(); clearAskSent(); ideaSent = null; ideaFiring = null; ideaSeen = null; revision = null; writeEdit = null; storyDraft = null; commentsShown.clear(); openDeps.clear(); openShow.clear(); openTickets.clear(); openMore.clear(); resetFlags(jobId);
    const job = data.jobs.find((j) => j.id === jobId);
    if (!subId && job?.stage === 'planning' && job.plan) { planDraft = structuredClone(job.plan); revision = job.revision; basePlan = JSON.stringify(job.plan); }
    const sub = job?.subJobs.find((s) => s.id === subId);
    if (sub && subState(job, sub) === 'failing') replyTo.set(sub.id, '');
    renderDetail();
  }
  const reviewDefault = () => !!data.jobs.find((j) => j.id === selected?.jobId)?.reviewWrites;
  const jobBase = () => data.jobs.find((j) => j.id === selected?.jobId)?.base || null;
  // Connectors follow the tiles' rendered rectangles, so anything that can move a
  // node (a dependency editor opening, the dialog resizing) re-traces them.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layoutGraphEdges(dialog.querySelector('.job-graph'))) : null;
  function wireGraph() {
    const graph = dialog.querySelector('.job-graph');
    observer?.disconnect();
    if (!graph) return;
    graph.querySelectorAll('[data-title]').forEach((e) => {
      e.oninput = () => { planDraft.subJobs[+e.dataset.title].title = e.value.replace(/\s*\n\s*/g, ' '); };
      // A title is one line however the field wraps it; the chord still reaches the dialog.
      e.onkeydown = (k) => { if (k.key === 'Enter' && !isPrimaryActionKey(k)) k.preventDefault(); };
    });
    // A write's editor opens under the stepper; its tile is a toggle for it.
    graph.querySelectorAll('[data-edit-write]').forEach((b) => b.onclick = () => { writeEdit = writeEdit === +b.dataset.editWrite ? null : +b.dataset.editWrite; renderDetail(); });
    // The eye beside it says outright whether that one write stops for review.
    graph.querySelectorAll('[data-review-write]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const w = planDraft.subJobs[+b.dataset.reviewWrite];
      w.review = !writeReviewed({ reviewWrites: reviewDefault() }, w);
      renderDetail();
    });
    graph.querySelectorAll('[data-add-write]').forEach((b) => b.onclick = () => { writeEdit = addWrite(b.dataset.addWrite); renderDetail(); });
    // A ticket stays open across redraws; closing the one holding the open editor closes that too.
    // One place open at a time: opening one closes the rest (their own toggles then forget them).
    graph.querySelectorAll('details[data-ticket]').forEach((d) => d.ontoggle = () => {
      if (d.open) { openTickets.add(d.dataset.ticket); graph.querySelectorAll('details[data-ticket][open]').forEach((o) => { if (o !== d) o.open = false; }); } else openTickets.delete(d.dataset.ticket);
      if (!d.open && d.querySelector('[aria-pressed="true"]')) { writeEdit = null; renderDetail(); } else layoutGraphEdges(graph);
    });
    graph.querySelectorAll('details[data-deps]').forEach((d) => d.ontoggle = () => { if (d.open) openDeps.add(d.dataset.deps); else openDeps.delete(d.dataset.deps); layoutGraphEdges(graph); });
    // A dependency change can move the node to another wave, so the stepper is
    // redrawn from the draft rather than patched; the changed checkbox keeps focus.
    graph.querySelectorAll('[data-copy-path]').forEach((b) => b.onclick = () => copyPath(b));
    graph.querySelectorAll('[data-open-path]').forEach((b) => b.onclick = () => openPath(b));
    const redraw = () => { dialog.querySelector('.job-graph').outerHTML = planGraphHtml(planDraft, { editable: true, openDeps, openTickets, openShow, editing: writeEdit, reviewWrites: reviewDefault(), base: jobBase() }); wireGraph(); };
    graph.querySelectorAll('[data-dep]').forEach((e) => e.onchange = () => {
      const s = planDraft.subJobs[+e.dataset.dep]; s.after = e.checked ? [...s.after, e.value] : s.after.filter((d) => d !== e.value);
      redraw();
      [...dialog.querySelectorAll(`[data-dep="${e.dataset.dep}"]`)].find((c) => c.value === e.value)?.focus();
    });
    // A PR's own base, blank for the job's: the tile's repo line follows it, so it redraws once settled.
    graph.querySelectorAll('details[data-base-of]').forEach((d) => d.ontoggle = () => { if (d.open) openDeps.add(`base:${d.dataset.baseOf}`); else openDeps.delete(`base:${d.dataset.baseOf}`); layoutGraphEdges(graph); });
    graph.querySelectorAll('[data-base]').forEach((e) => {
      const commit = () => {
        const s = planDraft.subJobs[+e.dataset.base], v = e.value.trim();
        if ((s.base || '') === v) return;
        if (v) s.base = v; else delete s.base;
        redraw(); dialog.querySelector(`[data-base="${e.dataset.base}"]`)?.focus();
      };
      e.onchange = commit;
      e.onkeydown = (k) => { if (k.key === 'Enter' && !isPrimaryActionKey(k)) { k.preventDefault(); commit(); } };
    });
    // Show me: a typed item lands in the draft as it is typed; add and remove redraw.
    graph.querySelectorAll('details[data-show-d]').forEach((d) => d.ontoggle = () => { if (d.open) openShow.add(d.dataset.showD); else openShow.delete(d.dataset.showD); layoutGraphEdges(graph); });
    graph.querySelectorAll('input[data-show]').forEach((e) => {
      e.oninput = () => { planDraft.subJobs[+e.dataset.show].show[+e.dataset.showK] = e.value.replace(/\s*\n\s*/g, ' '); };
      e.onkeydown = (k) => { if (k.key === 'Enter' && !isPrimaryActionKey(k)) k.preventDefault(); };
    });
    graph.querySelectorAll('[data-show-rm]').forEach((b) => b.onclick = () => {
      const [i, k] = b.dataset.showRm.split(':').map(Number);
      planDraft.subJobs[i].show.splice(k, 1);
      redraw();
    });
    graph.querySelectorAll('[data-show-add]').forEach((b) => b.onclick = () => {
      const s = planDraft.subJobs[+b.dataset.showAdd];
      if ((s.show ||= []).length >= MAX_SHOW) return;
      s.show.push(''); openShow.add(s.id);
      redraw();
      [...dialog.querySelectorAll(`input[data-show="${b.dataset.showAdd}"]`)].at(-1)?.focus();
    });
    observer?.observe(graph.querySelector('.job-graph-canvas'));
    layoutGraphEdges(graph);
    relight(graph);
  }
  // A human's own write, made by the session they added it from: a Jira write
  // where the plan has stories (the first status past its start, or a PR-link
  // comment where the planner read no workflow), else a Slack post. Marked
  // `added`, so it is not drawn as Proposed.
  function addWrite(subId) {
    const t = planDraft.subJobs.find((s) => s.id === subId);
    const taken = new Set(planDraft.subJobs.map((s) => s.id));
    let id = `${subId}-write`.slice(0, 60), n = 2;
    while (taken.has(id)) id = `${subId}-write-${n++}`.slice(0, 64);
    const jira = planDraft.stories?.length > 0;
    const w = { id, kind: 'write', title: '', place: { type: jira ? 'jira' : 'slack' }, after: [], by: t.id, added: true,
      ...(jira ? { storyId: t.storyId || planDraft.stories[0].id } : {}) };
    w.action = jira ? statusDefault(planDraft, w) : { type: 'post' };
    w.title = writeTarget(planDraft, w).slice(0, 180);
    planDraft.subJobs.push(w);
    return planDraft.subJobs.length - 1;
  }
  function wireWriteReview(job, sub) {
    const form = dialog.querySelector('#job-write-review');
    if (!form) return;
    pinSelects(form);
    if (storyDraft) {
      form.querySelector('[data-story-title]').oninput = (e) => { storyDraft.title = e.target.value; };
      form.querySelectorAll('[data-story-field]').forEach((e) => e.oninput = () => { storyDraft.fields[+e.dataset.storyField].value = e.value; });
      form.querySelectorAll('[data-story-field-remove]').forEach((b) => b.onclick = () => { storyDraft.fields.splice(+b.dataset.storyFieldRemove, 1); renderDetail(); });
      // A field named twice is one field, and the summary is the story's title,
      // never a field of its own (the server refuses both).
      form.querySelector('[data-story-field-add]').onclick = () => {
        const name = form.querySelector('[data-story-new-name]').value.trim(), value = form.querySelector('[data-story-new-value]').value.trim();
        if (!name || !value) return;
        if (name.toLowerCase() === 'summary') storyDraft.title = value;
        else {
          const had = storyDraft.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (had) had.value = value; else storyDraft.fields.push({ name, value });
        }
        renderDetail();
      };
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      const fail = (text) => { const err = form.querySelector('#job-move-error'); err.textContent = text; err.hidden = false; };
      let write;
      if (storyDraft) {
        if (!storyDraft.title.trim()) return fail('Give the story a summary.');
        const edit = storyEdit(job.plan?.stories?.find((t) => t.id === sub.storyId), storyDraft);
        write = edit ? { story: edit } : null;
      } else {
        const f = readWriteFields(form);
        const problem = writeProblem(writeFromFields({ ...job.plan, subJobs: job.subJobs }, sub, f));
        if (problem) return fail(problem);
        write = writeReviewPayload(sub, f);
      }
      if (pressBusy(submitterOf(e))) action('approve-write', write ? { write } : {});
    };
  }
  function wireWriteEditor() {
    const editor = dialog.querySelector('[data-write-editor]');
    if (!editor) return;
    const i = +editor.dataset.writeEditor;
    pinSelects(editor);
    const apply = () => {
      const w = writeFromFields(planDraft, planDraft.subJobs[i], readWriteFields(editor));
      w.title = writeTarget(planDraft, w).slice(0, 180);
      planDraft.subJobs[i] = w;
    };
    // Typing text only updates the draft; anything that changes the pill (or the
    // text, once the field is left) redraws the dialog around it.
    editor.querySelectorAll('textarea, input[type="text"], input:not([type])').forEach((e) => e.addEventListener('input', apply));
    editor.querySelectorAll('select, input, textarea').forEach((e) => e.addEventListener('change', () => { apply(); renderDetail(); }));
    editor.querySelector('[data-write-done]').onclick = () => { writeEdit = null; renderDetail(); };
    const remove = editor.querySelector('[data-write-remove]');
    if (remove) remove.onclick = () => { planDraft.subJobs.splice(i, 1); writeEdit = null; renderDetail(); };
  }
  function writeEditorHtml(job, plan, i) {
    const w = plan.subJobs[i];
    if (!isWriteSub(w)) return '';
    const problem = writeProblem(w);
    return `<section class="job-write-editor" data-write-editor="${i}" aria-label="Write"><h4>${PLACES[placeOf(w)].icon}${esc(writeTarget(plan, w))}${w.added ? '' : `<span class="job-proposed">${ICONS.sparkle}Proposed</span>`}</h4>${writeFieldsHtml(plan, w, { ticket: true, pick: true, job })}
      ${problem ? `<p class="job-error">${esc(problem)}</p>` : ''}
      <div class="job-actions"><button type="button" data-write-done>${ICONS.check}Done</button>${isStoryCreate(w) ? '' : `<button type="button" class="danger" data-write-remove>${ICONS.x}Remove from plan</button>`}</div></section>`;
  }
  // The board is not a secure context everywhere it is served, so a failed
  // clipboard write falls back to selecting the path for the human to copy.
  function copyPath(button) {
    const code = button.parentElement.querySelector('code');
    const select = () => { const range = document.createRange(); range.selectNodeContents(code); const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range); };
    const done = () => { button.lastChild.textContent = 'Copied'; detailShown = null; };
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard?.writeText) clipboard.writeText(button.dataset.copyPath).then(done, select); else select();
  }
  async function openPath(button) {
    let res;
    try { res = await onOpenFile?.(button.dataset.openPath); } catch { res = null; }
    if (!res?.ok) toastError(res?.reason ? `Could not open the file: ${res.reason}` : 'Could not open the file');
  }
  const noteFor = (sub) => sub.note ? `<p class="job-note" title="Note for the next session">${ICONS.note}<span>${esc(sub.note)}</span></p>` : '';
  const NOTED_APPROVALS = new Set(['approve-session', 'approve-code']);
  // Approve goes at once, as Retry does; its caret holds a note Approve itself sends to
  // the prompts that read it (server/job-prompts.js approvalNotesBlock), so a
  // step nothing reads it from gets no caret (`reach` null).
  const NOTE_REACH = { later: ['Approve with context for later steps', 'Add context for later steps', 'Passed to every step after this one'],
    pr: ['Approve with context for this PR and later steps', 'Add context for this PR and later steps', 'Passed to this PR’s publish run and every step after it'] };
  const approveSplitHtml = (action, title, label, reach) => {
    const button = `<button class="primary" data-action="${action}" title="${esc(title)}">${ICONS.check}${label}</button>`;
    if (!reach) return button;
    const [aria, heading, placeholder] = NOTE_REACH[reach];
    return `<span class="job-split job-approve-split">${button}<details class="job-split-more job-approve-more" data-keep="approve-note" ${openMore.has('approve-note') ? 'open' : ''}><summary aria-label="${aria}" title="${aria}">${ICONS.caret}</summary><div class="job-split-menu job-approve-pop"><label>${heading}<textarea data-approve-note maxlength="2000" rows="3" placeholder="${placeholder}"></textarea></label></div></details></span>`;
  };
  // A failing step's Retry goes at once; its caret holds the one line the retried
  // session reads last (server/job-prompts.js). A coordinator error has no session
  // to read it, so the job's own Retry stays plain.
  const retrySplitHtml = (primary) => `<span class="job-split job-retry-split"><button id="job-retry" ${primary ? 'class="primary"' : ''}>${ICONS.wrench}Retry</button><details class="job-split-more" data-keep="retry-note" ${openMore.has('retry-note') ? 'open' : ''}><summary aria-label="Add a note for Retry to send" title="Add a note for Retry to send">${ICONS.caret}</summary><div class="job-split-menu job-approve-pop"><label>Note sent with Retry<textarea data-retry-note maxlength="180" rows="2" placeholder="Optional. Shown on the card until the retried session reports"></textarea></label></div></details></span>`;
  // Every run's session, newest first: a repair or publish run hides the implementation one behind it.
  const sessionSplitHtml = (job, sub, primary) => {
    const button = `<button id="job-session" ${primary ? 'class="primary"' : ''}>${ICONS.terminal}${onBoard(sub.sessions.at(-1)) ? 'Open session' : 'Restore session'}</button>`;
    if (sub.sessions.length < 2) return button;
    const items = sub.sessions.map((sid, i) => { const run = job.runs?.find((r) => r.sessionId === sid); return `<button type="button" data-step-session="${esc(sid)}">${ICONS.terminal}<span>${esc(PHASE_LABEL[run?.phase] || `Session ${i + 1}`)}${run?.startedAt ? ` · ${esc(when(run.startedAt))}` : ''}</span><span class="job-split-hint">${onBoard(sid) ? 'Open' : 'Restore'}</span></button>`; }).reverse().join('');
    return `<span class="job-split job-session-split">${button}<details class="job-split-more" data-keep="session-menu" ${openMore.has('session-menu') ? 'open' : ''}><summary aria-label="Open an earlier session of this step" title="Open an earlier session of this step">${ICONS.caret}</summary><div class="job-split-menu">${items}</div></details></span>`;
  };
  // Squash is the default and says nothing; only a worker's explicit suggestion is drawn.
  const mergeMethodOf = (sub) => (sub.pr ? sub.merge : sub.ready?.merge) || null;
  const MERGE_METHOD_LABEL = { merge: 'a merge commit', rebase: 'a rebase' };
  const mergeMethodHtml = (sub) => { const m = mergeMethodOf(sub); return m ? `<p class="job-merge-method">${ICONS.merge}<span><strong>Lands by ${esc(MERGE_METHOD_LABEL[m.method] || m.method)}, not squash.</strong> ${esc(m.why)}</span></p>` : ''; };
  const approvalNoteFor = (sub) => sub.approvalNote ? `<h3>Context for later steps</h3><p class="job-approval-note">${esc(sub.approvalNote)}</p>` : '';
  // What a whole-job cancel did and what it left: the sub-job nodes say Dropped
  // one by one, this is the sentence that says why all of them do.
  const cancelledText = (job) => `Cancelled ${when(job.cancelledAt)}. ${job.stage === 'done' ? 'Every unfinished sub-job was dropped and cleaned up' : 'Every unfinished sub-job was dropped; running steps are being stopped and cleaned up'}. Merged work stays merged, open pull requests stay open on GitHub, and a worktree holding work that is not on the branch the job lands on is kept for you to look at${kept(job)}.`;
  const kept = (job) => { const n = job.subJobs.filter((x) => x.cleanupRefusal && !x.discard).length; return n ? ` (${n} kept now; open ${n === 1 ? 'it' : 'each'} to Retry or Discard)` : ''; };
  // Confirmed first, like Drop, and wrapped in a form so a live graph tick does not
  // re-render the detail view over the question (render() leaves any open form alone).
  function openCancel(job, back = renderDetail) {
    const live = job.runs.filter((r) => !r.stopped).length;
    const unfinished = job.subJobs.filter((s) => !['cleanup', 'done'].includes(s.stage)).length;
    const prs = job.subJobs.filter((s) => s.pr && s.stage === 'pr');
    const counts = job.stage === 'active' ? [`Drops ${unfinished} sub-job${unfinished === 1 ? '' : 's'}`, ...(prs.length ? [prs.length === 1 ? `PR #${prNumber(prs[0])} stays open on GitHub` : `${prs.length} PRs stay open on GitHub`] : []), 'Worktrees with unsaved work are kept'] : [live ? 'Stops planning' : 'Planning never starts'];
    const noun = inConversation(job) ? 'idea' : 'job';
    show(`<span class="jobs-kicker">${esc(job.title)}</span><h2>Cancel this ${noun}?</h2><form id="job-cancel-form"><ul class="job-cancel-counts">${counts.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><div class="job-actions"><button type="button" class="danger" data-cancel-job="1">Cancel ${noun}</button><button type="button" id="job-move-back">Keep working</button></div></form>`);
    dialog.querySelector('[data-cancel-job]').onclick = (e) => { if (pressBusy(e.currentTarget)) send({ type: 'job-action', id: job.id, action: 'cancel-job' }); };
    dialog.querySelector('#job-move-back').onclick = () => back();
  }
  // One escaped line per intervention, newest first, with when it was made — the
  // record of every human decision in a job, kept out of the way until asked for.
  function movesHistoryHtml(job) {
    const list = job.moves || [];
    if (!list.length) return '';
    return more('history', `${ICONS.wrench}History <small>${list.length}</small>`, `<ul class="job-move-log">${list.slice().reverse().map((m) => `<li><span>${esc(m.detail || m.move)}${m.note && NOTED_APPROVALS.has(m.move) ? `<q>${esc(m.note)}</q>` : ''}</span><small>${esc(when(m.at))}</small></li>`).join('')}</ul>`, 'job-moves-history');
  }
  // A picture that could not be attached stays in the tray, marked, until the
  // human retries or removes it: one quietly gone was believed sent. Each
  // target of the box (a conversation, '' a new one) holds its own (`box`).
  const boxImages = (key) => askImages.filter((i) => i.box === key);
  const askTrayHtml = (key) => boxImages(key).map((i) => `<li class="job-image ${i.failed ? 'failed' : i.name ? '' : 'uploading'}"${i.failed ? ` title="${esc(i.failed)}"` : ''}>${i.url ? `<img src="${esc(i.url)}" alt="">` : ''}${i.failed ? `<button type="button" class="job-image-retry" data-ask-retry="${i.id}" ${i.blob ? '' : 'disabled'} aria-label="Couldn’t attach${i.blob ? ', retry' : ''}">${ICONS.x}<span>${i.blob ? 'Retry' : 'Failed'}</span></button>` : ''}<button type="button" class="job-image-remove" data-ask-image="${i.id}" aria-label="Remove image" title="Remove">×</button></li>`).join('');
  const askErrorText = (key) => {
    const bad = boxImages(key).filter((i) => i.failed);
    if (!bad.length) return '';
    return `Couldn’t attach ${bad.length > 1 ? `${bad.length} images` : 'this image'}: ${bad[0].failed.replace(/\.$/, '')}. Retry or remove ${bad.length > 1 ? 'them' : 'it'} to send.`;
  };
  function clearAskImages() { for (const i of askImages) if (i.url) URL.revokeObjectURL(i.url); askImages = []; }
  function clearAskSent() { for (const i of askSent?.items || []) if (i.url) URL.revokeObjectURL(i.url); askSent = null; }
  let askSeq = 0;
  // Every box on screen, not the one a paste landed in: a redraw while an upload
  // travels replaces that box, and its Send must still learn the upload landed.
  const paintAskBoxes = () => dialog.querySelectorAll('.job-change').forEach(paintAsk);
  function syncAsk(box) {
    const text = box.querySelector('textarea'), send = box.querySelector('[data-change-send], [data-idea-send]'), mine = boxImages(box.dataset.changeConvo || '');
    send.disabled = !text.value.trim() || mine.some((i) => !i.name);
    box.classList.toggle('has-text', !!text.value.trim()); box.classList.toggle('has-img', mine.length > 0);
    text.style.height = 'auto'; if (text.scrollHeight) text.style.height = `${Math.min(text.scrollHeight, 160)}px`;
  }
  function paintAsk(box) {
    const tray = box.querySelector('.job-change-tray'), error = box.querySelector('.job-change-error'), key = box.dataset.changeConvo || '';
    tray.innerHTML = askTrayHtml(key); tray.hidden = !boxImages(key).length;
    error.textContent = askErrorText(key); error.hidden = !error.textContent;
    tray.querySelectorAll('[data-ask-image]').forEach((b) => b.onclick = () => { const i = askImages.find((x) => String(x.id) === b.dataset.askImage); if (i?.url) URL.revokeObjectURL(i.url); askImages = askImages.filter((x) => x !== i); paintAskBoxes(); });
    tray.querySelectorAll('[data-ask-retry]').forEach((b) => b.onclick = () => { const i = askImages.find((x) => String(x.id) === b.dataset.askRetry); if (i?.blob) stageAsk(i); });
    syncAsk(box);
  }
  async function stageAsk(item) {
    item.failed = null; paintAskBoxes();
    try { item.name = (await stageImage(item.blob)).name; } catch (e) { item.failed = e?.message || 'The upload failed.'; }
    paintAskBoxes();
  }
  // Pasted, dropped or picked into an idea box: staged the moment it lands, sent
  // with the idea, and kept by the server (server/handlers.js prepare).
  function wireAskImages(box) {
    const text = box.querySelector('textarea'), file = box.querySelector('.job-change-attach input');
    const key = box.dataset.changeConvo || '';
    const take = (dt, e) => {
      const { sources } = imageSources(dt);
      if (!sources.length) return;
      e?.preventDefault();
      for (const source of sources.slice(0, Math.max(0, MAX_ASK_IMAGES - boxImages(key).length))) (async () => {
        let blob = null;
        try { blob = blobOf(await frameOf(source)); } catch { /* drawn as a failed tile below */ }
        const item = { id: ++askSeq, box: key, name: null, blob, url: blob && URL.createObjectURL(blob), failed: blob ? null : 'That picture could not be read.' };
        askImages.push(item);
        if (blob) stageAsk(item); else paintAskBoxes();
      })();
    };
    text.addEventListener('input', () => syncAsk(box));
    text.addEventListener('paste', (e) => take(e.clipboardData, e));
    box.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); box.classList.add('drag'); } });
    box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drag'); });
    box.addEventListener('drop', (e) => { box.classList.remove('drag'); take(e.dataTransfer, e); });
    if (file) file.onchange = () => { take({ files: file.files }); file.value = ''; };
    paintAsk(box);
  }
  // What was sent, above the box it came from: the words and pictures lift into a
  // bubble, and the line under it says who has it once the server took it. Once the
  // conversation shows the message itself, even before the ack, its row there is the receipt instead.
  const sentHeld = (m) => m.from === 'human' && m.text === askSent.text && m.at >= askSent.at - 60000;
  function askSentHtml(job, sub, key = '') {
    if (!askSent || askSent.subId !== (sub?.id ?? null) || (askSent.convo || '') !== key) return '';
    if (askSent.state !== 'failed' && (sub?.thread?.some(sentHeld) || talkFor(job, sub).some(sentHeld))) return '';
    const s = askSent, fresh = s.drawn !== s.state; s.drawn = s.state;
    const pics = s.images.length ? `<span class="job-sent-imgs">${s.images.map((u) => `<img src="${esc(u)}" alt="">`).join('')}</span>` : '';
    const n = s.images.length ? ` with ${s.images.length} image${s.images.length > 1 ? 's' : ''}` : '';
    const meta = s.state === 'failed' ? `<span class="job-sent-meta failed">${ICONS.x}Not sent: ${esc(s.error || 'refused')}. Your words${s.hadImages ? ' and pictures' : ''} are back in the box.</span>`
      : s.state === 'sent' ? `<span class="job-sent-meta"><i class="job-sent-tick">${ICONS.check}</i>Sent to ${esc(s.to)}${n} · ${esc(new Date(s.at).toLocaleTimeString(undefined, { timeStyle: 'short' }))}</span>`
      : `<span class="job-sent-meta"><span class="job-sent-sending">Sending to ${esc(s.to)}…</span></span>`;
    return `<div class="job-sent ${s.state}${fresh ? ' fresh' : ''}" data-sent-state="${s.state}"><div class="job-sent-bubble">${pics}<span>${esc(s.text)}</span></div>${meta}</div>`;
  }
  // The conversation the box writes to is only ever the human's pick: with none yet
  // the most recent conversation (job-talk.js latestConvo), kept as the pick so
  // nothing a wrangler does moves it. A failing step opens on a new one, since what
  // to do about it is a new decision (openDetail); once the human sends there, the
  // conversation it started is theirs.
  function replyTarget(job, sub, view) {
    if (view.at === 'plan') return '';
    const key = sub?.id || '', picked = replyTo.get(key);
    const shown = (id) => convoGroups(job, sub).some((g) => g.convo?.id === id);
    if (picked === '') {
      const landed = askSent && askSent.state !== 'failed' && askSent.subId === (sub?.id ?? null) && !askSent.convo ? talkFor(job, sub).find(sentHeld) : null;
      if (!landed?.convo || !shown(landed.convo)) return '';
      askSent.convo = landed.convo; replyTo.set(key, landed.convo);
      return landed.convo;
    }
    if (picked && shown(picked)) return picked;
    const first = latestConvo(job, sub);
    replyTo.set(key, first);
    return first;
  }
  // The one box an idea goes in through, on every step, review and proposal: at the
  // foot of the conversation it replies to, the only one open (job-talk.js), else
  // below them all for a new one. Its chip says who hears it and where, and its ×
  // folds that conversation to start a new one instead, taking what is in the box. It is
  // never refused as stale: the wrangler judges a step that moved since. Not a <form>, so a
  // tick redraws it, carrying over what is typed (keepBoxes), never held by a box's presence.
  // At rest it is one line; focus, words or a picture open it.
  function boxHtml(job, sub, view, key) {
    const convo = key ? convosOf(job).find((c) => c.id === key) || null : null;
    const base = changeRoute(view.at, job, sub);
    const draft = askDraft && askDraft.subId === sub?.id && (askDraft.convo || '') === key ? askDraft.text : boxDrafts.get(`${sub?.id || ''}|${key}`) || '';
    // Said before its wrangler replies, it goes to that wrangler.
    const route = !convo ? base : askPending(job, convo) ? { ...base, placeholder: 'Add to your question…' }
      : { ...base, placeholder: 'Reply in this conversation…' };
    const where = convo ? `↩ ${convoTitle(job, convo)}` : view.at === 'plan' || !talkFor(job, sub).some((m) => m.convo) ? '' : 'New conversation';
    const fresh = convo ? `<button type="button" class="job-change-new" data-change-new title="Start a new conversation instead" aria-label="Start a new conversation instead">${ICONS.x}</button>` : '';
    const sent = convo ? '' : askSentHtml(job, sub);
    const open = !convo && sub && subState(job, sub) === 'failing';
    const mine = boxImages(key);
    return `${sent}<div class="job-change${open ? ' is-open' : ''}" data-change-convo="${esc(key)}" data-change-to="${esc(route.to)}">
      <ul class="job-change-tray" ${mine.length ? '' : 'hidden'}>${askTrayHtml(key)}</ul>
      <p class="job-change-error" role="alert" ${askErrorText(key) ? '' : 'hidden'}>${esc(askErrorText(key))}</p>
      <div class="job-change-row"><span class="job-change-to" title="Who hears it">${wranglerMark('small')}${esc(route.to)}${where ? `<small>${esc(where)}</small>` : ''}${fresh}</span><textarea rows="1" maxlength="8000" placeholder="${esc(route.placeholder)}" aria-label="${convo ? `Reply in ${esc(convoTitle(job, convo))}` : `Add idea for ${esc(route.to)}`}">${esc(draft)}</textarea><label class="job-change-attach" title="Attach a screenshot (or paste or drop one)">${ICONS.image}<input type="file" accept="image/*" multiple aria-label="Attach a screenshot"></label><button type="button" class="job-change-go" data-change-send aria-label="Send to ${esc(route.to)}" title="Send (↵)" ${draft ? '' : 'disabled'}>${ICONS.send}</button></div>
      <div class="job-change-foot"><kbd>↵ send · ⇧↵ new line</kbd></div></div>`;
  }
  // What was sent to a conversation is drawn at its end, where the answer comes, above
  // the box; one that starts a new conversation, above the box below them all.
  function changeBoxHtml(job, sub) {
    const view = changeView(job, sub);
    // A step Wrangler is fixing is the wrangler's for now.
    const open = view && !(sub && redFixing(job, sub));
    const target = open && view.at !== 'plan' ? replyTarget(job, sub, view) : null;
    const talk = talkHtml(job, sub, target ? (convo) => `${askSentHtml(job, sub, convo.id)}${boxHtml(job, sub, view, convo.id)}` : null, convoFold, openMore, target);
    return open ? target ? talk : `${talk}${boxHtml(job, sub, view, '')}` : talk + askSentHtml(job, sub);
  }
  // Opens another conversation with the box at its foot (or none, for a new one),
  // keeping what was typed for the last one. `carry` (the chip's ×) takes the words
  // and pictures along instead, after any draft already waiting there.
  function aimBox(sub, key, carry = false) {
    const box = dialog.querySelector('.job-change[data-change-convo]:not([data-idea-composer])');
    if (box) {
      const from = box.dataset.changeConvo || '', text = box.querySelector('textarea').value, id = sub?.id || '';
      if (!carry || from === key) boxDrafts.set(`${id}|${from}`, text);
      else {
        const there = boxDrafts.get(`${id}|${key}`) || '';
        boxDrafts.delete(`${id}|${from}`);
        boxDrafts.set(`${id}|${key}`, there && text ? `${there}\n${text}` : there || text);
        for (const i of askImages) if (i.box === from) i.box = key;
      }
    }
    replyTo.set(sub?.id || '', key);
    renderDetail();
    const text = dialog.querySelector('.job-change[data-change-convo]:not([data-idea-composer]) textarea');
    if (text) { text.focus(); text.setSelectionRange(text.value.length, text.value.length); }
  }
  // One control for reading the diff: Wrangler's own view, the desktop IDE in its menu.
  // Each conflict the sync session parked on, with its ranked ways out; the first is
  // its own pick and starts chosen. One Resolve sends a pick per conflict.
  const conflictHtml = (sub) => {
    const c = sub.conflict;
    if (!c) return '';
    if (c.decided) return `<h3>${c.decided.auto ? 'Conflict · recommended option taken on Auto' : 'Conflict'}</h3><ul class="job-conflicts">${c.conflicts.map((x, i) => `<li><code>${esc(x.file)}</code> ${esc(x.options[c.decided.picks[i]]?.label || '')}</li>`).join('')}</ul>`;
    return `<form id="job-conflict-form" class="job-conflict" data-run="${esc(c.runId)}"><h3>Conflict needs you</h3>${c.summary ? `<p>${esc(c.summary)}</p>` : ''}
      ${c.conflicts.map((x, i) => `<fieldset class="job-options job-conflict-pick"><legend><code>${esc(x.file)}</code></legend><p class="job-conflict-what">${esc(x.what)}</p>
        ${x.options.map((o, n) => `<label class="job-option"><input type="radio" name="c${i}" value="${n}" ${n === 0 ? 'checked' : ''}><span><b>${esc(o.label)}${n === 0 && x.options.length > 1 ? '<span class="job-option-rec">Recommended</span>' : ''}</b>${o.why ? `<small>${esc(o.why)}</small>` : ''}</span></label>`).join('')}</fieldset>`).join('')}
      <label>Note for the session <small>optional</small><textarea name="note" maxlength="2000" rows="2"></textarea></label>
      <div class="job-actions tone-warn"><button class="primary" type="submit" title="Sends your choices to the session, which finishes the merge, commits and pushes">${ICONS.check}Resolve</button></div></form>`;
  };
  const reviewCodeHtml = (sub) => `<span class="job-split"><button id="job-diff" title="Review code in Wrangler">${ICONS.code}Review code</button>${sub.worktree?.path ? `<details class="job-split-more" data-keep="review-menu" ${openMore.has('review-menu') ? 'open' : ''}><summary aria-label="More ways to review code" title="More ways to review code">${ICONS.caret}</summary><div class="job-split-menu"><button id="job-ide" title="Review code in ${esc(ideApp())}">In ${esc(ideApp())}</button></div></details>` : ''}</span>`;
  const appbar = (title, chips, kicker = '', line = '') => `<header class="job-appbar">${kicker}<h2>${esc(title)}</h2><div class="job-chips job-detail-meta">${chips}</div>${line ? `<div class="job-detail-line">${line}</div>` : ''}</header>`;
  const costChip = (usd, estimated, title) => { const c = jobCostLabel(usd, estimated); return c ? chip('', c, { cls: 'job-detail-cost', title }) : ''; };
  function storyChips(stories) {
    if (!stories.length) return chip(ICONS.story, 'No ticket', { cls: 'job-chip-quiet', title: 'This work has no Jira ticket' });
    const fresh = stories.filter((s) => !s.key).length;
    return stories.slice(0, 2).map((s) => chip(ICONS.story, storyLabel(s, stories), { title: `${s.title}${s.key ? '' : ' · new Jira story, created only after you approve'}` })).join('')
      + (stories.length > 2 ? chip('', `+${stories.length - 2}`, { title: `${stories.length} stories${fresh ? ` · ${fresh} new` : ''}` }) : '');
  }
  const repoChips = (repos) => repos.length ? repos.map((r) => chip(ICONS.folder, tildify(r).split('/').pop(), { title: tildify(r) })).join('')
    : chip(ICONS.folder, 'Repos', { cls: 'job-chip-quiet', title: 'Wrangler will discover the repositories needed during planning.' });
  // Titles only: a new story's fields are edited on its create write, once it
  // is in review, not at plan time.
  const storiesHtml = (stories) => stories.length ? `<div class="job-stories">${stories.map((s) => `<div class="job-story"><div><span class="job-story-key ${s.key ? '' : 'job-story-new'}">${esc(storyLabel(s, stories))}</span> ${esc(s.title)}</div></div>`).join('')}</div>` : '';
  // A story create in review is its own editor: the summary, every field the
  // create fills in (server/jobs-schema.js storySchema; the planner copies the
  // team's usual ones), and a row to add one. Approving sends what is left.
  function storyEditorHtml(story) {
    const project = storyProject(story);
    const rows = [...(project ? [['Project', esc(project)]] : []), ...storyDraft.fields.map((f, j) => [esc(f.name),
      `<textarea aria-label="${esc(f.name)}" data-story-field="${j}" rows="${Math.min(6, Math.max(1, Math.ceil(f.value.length / 70), f.value.split('\n').length))}" maxlength="2000">${esc(f.value)}</textarea><button type="button" class="job-story-field-remove" data-story-field-remove="${j}" title="Leave ${esc(f.name)} empty" aria-label="Remove ${esc(f.name)}">${ICONS.x}</button>`])];
    const none = !storyDraft.fields.length ? `<p class="job-write-hint">${ICONS.info}<span>Only the summary is set: no other fields.</span></p>` : '';
    return `<label>Summary<input name="storyTitle" data-story-title maxlength="180" value="${esc(storyDraft.title)}"></label>${rows.length ? `<dl class="job-write-spec job-story-fields">${rows.map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('')}</dl>` : ''}${none}
      <div class="job-story-field-add"><input aria-label="New field name" data-story-new-name maxlength="180" placeholder="Field, e.g. Labels"><input aria-label="New field value" data-story-new-value maxlength="2000" placeholder="Value"><button type="button" data-story-field-add>${ICONS.plus}Add field</button></div>`;
  }
  // Everything a plan says in prose, folded into one section: the stepper is the
  // decision, this is the reading behind it.
  // The pictures a job was created with, as numbered thumbnails under the outcome, filled
  // in from `imageCache` once a job-images frame has brought them.
  const stripHtml = (job) => imageStripHtml(job, job.images);
  function hydrateStrips() {
    dialog.querySelectorAll('[data-strip]').forEach((strip) => {
      const missing = [];
      strip.querySelectorAll('[data-image]').forEach((b) => {
        const got = imageCache.get(b.dataset.image);
        if (!got) return missing.push(b.dataset.image);
        if (b.querySelector('img')) return;
        const img = document.createElement('img');
        img.src = `data:${got.mime};base64,${got.dataBase64}`;
        img.alt = '';
        b.prepend(img);
        b.title = 'Enlarge';
        b.onclick = () => openZoom(img.src, `Image ${b.querySelector('.job-image-num').textContent}`);
      });
      // Keyed by what is missing, so a picture a later idea message adds is asked for too.
      const ask = `${strip.dataset.strip}|${missing.join('|')}`;
      if (missing.length && !askedImages.has(ask)) { askedImages.add(ask); send({ type: 'job-images', id: strip.dataset.strip }); }
    });
  }
  // What the agent must show before the code is committed (server/jobs-schema.js show).
  const showMeHtml = (s) => showOf(s).length ? `<p>Show me:</p><ul class="job-show-list">${showOf(s).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
  function planMoreHtml(job, plan) {
    const briefs = (plan?.subJobs || []).map((s) => `<h5>${kindChipHtml(s)} ${esc(s.title)}</h5><p${s.kind === 'human' ? ' class="job-brief"' : ''}>${esc(s.brief)}</p>${s.check ? `<p>Check: ${esc(s.check)}</p>` : ''}${showMeHtml(s)}`).join('');
    const fresh = (plan?.stories || []).filter((s) => !s.key).length;
    return more('plan', `${ICONS.doc}Plan details`, `${plan?.stories?.length ? `<h4>Stories <small>${fresh ? `${fresh} new` : 'existing'}</small></h4>${storiesHtml(plan.stories)}` : ''}
      ${plan?.context ? `<h4>Context</h4><p class="job-context">${esc(plan.context)}</p>` : ''}
      <h4>Outcome</h4><p class="job-intent">${esc(job.intent)}</p>${stripHtml(job)}${briefs ? `<h4>Briefs</h4>${briefs}` : ''}`, 'job-plan-more');
  }
  // Superseded PRs are left open on GitHub (nothing here closes or deletes one),
  // so the job says where they are rather than leaving an orphan to puzzle over.
  function supersededHtml(job) {
    const list = job.subJobs.filter((s) => s.superseded && s.pr?.url);
    return list.length ? `<p class="job-superseded">${ICONS.stop}<span>Superseded by a plan change; ${list.length === 1 ? 'its PR is' : 'their PRs are'} left open on GitHub for you: ${list.map((s) => link(s.pr.url, `${s.title} #${prNumber(s)}`)).join(' · ')}</span></p>` : '';
  }
  // What an edit did to each field, before → after: long text keeps the words both
  // share and marks only the run that changed; a list says what it gains and loses.
  function wordsDiffHtml(a = '', b = '') {
    const x = String(a).split(/(\s+)/), y = String(b).split(/(\s+)/);
    let i = 0, j = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
    const mid = (w) => w.slice(i, w.length - j).join('');
    return `${esc(x.slice(0, i).join(''))}${mid(x) ? `<del>${esc(mid(x))}</del>` : ''}${mid(y) ? `<ins>${esc(mid(y))}</ins>` : ''}${esc(x.slice(x.length - j).join(''))}`;
  }
  function editDiffHtml(was = {}, now = {}, fields, title) {
    const list = (a = [], b = [], name = (v) => v) => [...b.filter((v) => !a.includes(v)).map((v) => `<ins>+ ${esc(name(v))}</ins>`), ...a.filter((v) => !b.includes(v)).map((v) => `<del>− ${esc(name(v))}</del>`)].join(' ') || 'reordered';
    const row = (k) => k === 'after' ? list(was.after, now.after, title) : k === 'show' ? list(was.show, now.show)
      : typeof (now[k] ?? was[k]) === 'string' || (now[k] ?? was[k]) == null ? wordsDiffHtml(was[k] ?? '', now[k] ?? '') : `<del>${esc(JSON.stringify(was[k] ?? null))}</del> <ins>${esc(JSON.stringify(now[k] ?? null))}</ins>`;
    return `<dl class="job-edit-diff">${fields.map((k) => `<dt>${esc(fieldName(k))}</dt><dd>${row(k)}</dd>`).join('')}</dl>`;
  }
  // Hovering it lists what waits, oldest first.
  const queuedTag = (job) => queuedLabel(job) ? `<span class="job-talk-tag tone-working job-replan-queued" title="${esc(replanQueued(job).map((q, i) => `${i + 1}. ${q.feedback}`).join('\n'))}">${esc(queuedLabel(job))}</span>` : '';
  const ACT_KIND = { 'accept-red': 'Accept red', recover: 'Recover', 'mark-merged': 'Mark merged', 'mark-done': 'Mark done', forward: 'Forward', rework: 'Rework', retry: 'Retry' };
  // A plan change is ONE decision card: what approving does (the option's label),
  // why, what it leaves you, and the two buttons. What Wrangler found, its
  // evidence and the asks wait behind Why, and the other options fold to their
  // labels. Under the card the graph and every change are drawn as they were.
  function proposalHtml(job) {
    const proposal = job.replan.proposal;
    const options = proposalOptions(proposal);
    const picked = pickedOption(job);
    const option = options[picked];
    const { merged, changes, actions = [], then = {} } = option;
    const liveSub = (id) => job.subJobs.find((x) => x.id === id);
    const acting = new Map(actions.map((a) => [a.sub, a]));
    const markOf = (s) => acting.has(s.id) ? actionMark(acting.get(s.id)) : changes.frozen.includes(s.id) ? 'frozen' : changes.removed.includes(s.id) ? 'removed' : changes.added.includes(s.id) ? 'added' : changes.edited.some((e) => e.id === s.id) ? 'edited' : 'kept';
    const title = (id) => merged.subJobs.find((s) => s.id === id)?.title || id;
    const pr = (id) => { const s = liveSub(id); return s?.pr?.url ? ` · ${link(s.pr.url, `PR #${prNumber(s)}`)} stays open on GitHub` : ''; };
    // Every row is kind | step, so titles line up whether or not the row opens.
    const row = (kind, what) => `<span class="job-change-kind">${esc(kind)}</span><span class="job-change-what">${what}</span>`;
    // What approval does to it (server/job-replan.js thenOf): when it starts, and behind what.
    const thenOf = (id) => (then[id] ? `<span class="job-talk-then">${esc(then[id])}</span>` : '');
    const acts = actions.map((a) => { const l = actionLine(a, merged); return `<li class="job-mark-act job-mark-${actionMark(a)}" title="${esc(pinLine(a.pin))}">${row(ACT_KIND[actionMark(a)] || a.type, `${esc(l.text)}${l.detail ? ` <small>${esc(l.detail)}</small>` : ''}`)}</li>`; });
    const items = [...changes.added.map((id) => `<li class="job-mark-added">${row('New', `${esc(title(id))}${thenOf(id)}`)}</li>`),
      ...changes.edited.map((e) => `<li class="job-mark-edited"><details><summary>${row('Edited', `${esc(editLine(e, merged))}${thenOf(e.id)}`)}</summary>${editDiffHtml(job.plan.subJobs.find((s) => s.id === e.id), merged.subJobs.find((s) => s.id === e.id), e.fields, title)}</details></li>`),
      ...changes.removed.map((id) => `<li class="job-mark-removed">${row('Will be cancelled', `${esc(title(id))}${pr(id) ? ` <small>${pr(id).replace(/^ · /, '')}</small>` : ''}`)}</li>`), ...acts];
    // A red step's replan was Wrangler's own (job-red.js): the card names that step, never a human's words.
    const red = job.replan.red && !job.replan.red.human ? job.replan.red : null;
    const redSub = red && liveSub(red.sub);
    const counts = [[changes.added.length, 'new'], [changes.edited.length, 'edited'], [changes.removed.length, 'cancelled']].filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
    const kicker = red ? [redSub?.title || red.sub, proposal.escalation ? 'declared red' : redSub?.error].filter(Boolean).join(' · ')
      : ['Plan change', counts.join(', ') || [...new Set(actions.map((a) => ACT_KIND[actionMark(a)] || a.type))].join(', ')].filter(Boolean).join(' · ');
    const d = proposal.diagnosis;
    // The card's line under its heading is the option's why; with none, what Wrangler found leads instead.
    const why = option.why || (picked === 0 && d ? leadSentence(d.summary).head : '');
    const heading = option.label || (red ? 'Proposed fix' : 'Proposed change');
    const blocked = planningRun(job);
    const others = options.map((o, i) => i === picked ? '' : `<button type="button" class="job-decision-other" data-option="${i}">${i === 0 ? 'Recommended' : 'Other option'}: ${esc(o.label || `Option ${i + 1}`)}</button>`).join('');
    const asks = red ? [] : replanAsks(job.replan);
    const whyBody = `${d ? `<p>${esc(d.summary)}</p>` : ''}${d?.evidence?.length ? `<ul class="job-decision-evidence">${d.evidence.map((e) => `<li><span>${esc(e.label)}</span>${esc(e.detail)}</li>`).join('')}</ul>` : ''}`
      + (asks.length ? `<p class="job-replan-ask"><b>You asked</b> ${esc(asks.at(-1))}</p>${asks.length > 1 ? `<ol class="job-ask-earlier">${asks.slice(0, -1).map((a) => `<li>${esc(a)}</li>`).join('')}</ol>` : ''}` : '');
    const whyMore = whyBody ? more('proposal-why', `Why${d?.evidence?.length ? ` (${d.evidence.length})` : ''}`, `<div class="job-decision-why-body">${whyBody}</div>`, 'job-decision-more') : '';
    const count = (n, cls, label) => n ? `<span class="job-diff-key job-mark-${cls}"><b>${n}</b> ${label}</span>` : '';
    const kept = merged.subJobs.filter((s) => ['kept', 'frozen'].includes(markOf(s))).length;
    const legend = `<p class="job-diff-legend">${count(changes.added.length, 'added', 'new')}${count(changes.edited.length, 'edited', 'edited')}${count(changes.removed.length, 'removed', 'cancelled')}${count(actions.length, 'rework', actions.length === 1 ? 'action' : 'actions')}${count(kept, 'kept', 'unchanged')}<span class="job-diff-edges"><i class="added"></i>new link<i class="gone"></i>dropped link</span></p>`;
    const planHtml = `${legend}${planGraphHtml(merged, { stateOf: (s) => liveSub(s.id) ? subState(job, liveSub(s.id)) : 'planned', markOf, editsOf: (id) => changes.edited.find((e) => e.id === id)?.fields || [], was: job.plan, openTickets, reviewWrites: job.reviewWrites, base: job.base })}
      <ul class="job-replan-changes">${items.join('')}</ul>${planMoreHtml(job, merged)}`;
    // Only the head (what it is, the heading, the buttons) pins while the rest of the card and the plan diff scroll under it.
    const body = `${why ? `<p class="job-decision-why">${esc(why)}</p>` : ''}${option.leaves ? `<p class="job-decision-leaves"><b>Leaves you</b> ${esc(option.leaves)}</p>` : ''}${whyMore || others ? `<div class="job-decision-foot">${whyMore}${others}</div>` : ''}`;
    return `<section class="job-decision${red ? ' is-red' : ''}" aria-label="Plan change waiting for you"><div class="job-decision-head"><p class="job-decision-kicker">${ICONS.eye}<span>${esc(kicker)}</span>${queuedTag(job)}</p>
      ${proposal.escalation?.ask ? `<p class="job-decision-ask">${esc(proposal.escalation.ask)}</p>` : ''}<div class="job-decision-row"><h3 class="job-decision-title">${esc(heading)}${options.length > 1 && picked === 0 ? '<span class="job-option-rec">Recommended</span>' : ''}</h3>
      <div class="job-actions job-proposal-cta tone-warn"><button class="primary" data-action="approve-replan" ${blocked ? 'disabled' : ''} title="${blocked ? 'Wrangler is still planning; approve once it stops' : 'Only the steps it changes wait until you approve or discard it'}">${ICONS.check}Approve</button><button data-action="discard-replan">${ICONS.x}Discard</button></div></div></div>
      ${body ? `<div class="job-decision-body">${body}</div>` : ''}${planHtml}</section>`;
  }
  // The job dialog's one extended button: the single most urgent thing the job is
  // waiting on. A green PR awaiting approval merges from here, pinned to the head
  // on display; anything that needs reading first opens its sub-job instead.
  function promptFab(job) {
    const prompts = promptsWaiting(job);
    if (!prompts.length) return '';
    const [p] = prompts, more = prompts.length - 1;
    const title = esc(`${promptWhere(job, p)} · Prompt waiting${more ? ` · +${more} more waiting` : ''}`);
    return `<button class="primary" data-fab-session="${esc(p.sessionId)}" title="${title}">${ICONS.terminal}Answer prompt</button>`;
  }
  function leadFab(job) {
    const prompt = promptFab(job);
    if (prompt) return prompt;
    const state = jobState(job);
    const lead = leadSub(job, state);
    if (!lead || !['failing', 'needs'].includes(state)) return '';
    const n = isPrSub(lead) ? prNumber(lead) : '';
    const title = esc(`${lead.title} · ${subLabel(job, lead)}`);
    if (state === 'needs' && mergeApprovable(job, lead)) return `<button class="primary" data-action="approve-merge" data-sub="${esc(lead.id)}" title="${title}">${ICONS.merge}Merge${n ? ` #${n}` : ''}</button>`;
    const [icon, text] = redDeclared(job, lead) && state === 'failing' ? [ICONS.eye, 'Decide'] : redFixReady(job, lead) ? [ICONS.eye, 'Review fix'] : state === 'failing' ? [ICONS.wrench, 'Resolve'] : codeAwaitingReview(lead) ? [ICONS.code, 'Review code'] : isSessionSub(lead) ? [ICONS.doc, 'Review result'] : isHumanSub(lead) ? [ICONS.person, 'Open task'] : [ICONS.eye, 'Open'];
    return `<button class="primary" data-open-sub="${esc(lead.id)}" title="${title}">${icon}${text}${n ? ` #${n}` : ''}</button>`;
  }
  // A switch counts from the next gate the job reaches (server/job-store.js
  // setReview). One that would release work already waiting asks first and has
  // no Undo; any other applies at once, Undo in the hint until the pointer and
  // focus leave the footer. The tile shows the new state, aria-busy, until the
  // job's next broadcast confirms it or a refusal snaps it back.
  const shownYou = (job, field) => flags.pending?.field === field ? flags.pending.you : youReview(job, field);
  function flagsHintHtml(job) {
    let head = 'Review checkpoints', body = '', undo = false;
    if (flags.note) ({ head, body, undo } = flags.note);
    else if (flags.hover) {
      const cp = checkpoint(flags.hover), you = shownYou(job, cp.field), lock = checkpointLock(job, cp.field);
      head = checkpointLabel(cp, you);
      body = lock ? `${lock}.` : `${checkpointHint(cp, you)}. Click for ${you ? 'Auto' : 'You review'}.`;
    }
    return `<p class="job-flags-hint" aria-live="polite"><b>${esc(head)}</b>${body ? ` <span>${esc(body)}</span>` : ''}${undo ? ' <button type="button" class="job-flags-undo" data-review-undo>Undo</button>' : ''}</p>`;
  }
  function footerHtml(job) {
    // Before approval the sub-jobs exist only in the plan, and Session results and
    // Writes are still switchable there.
    const planned = (planDraft || job.plan)?.subJobs || [];
    const sessions = hasSessionSubs(job) || planned.some(reviewedSession);
    const writes = hasWrites(job) || planned.some(isWriteSub);
    const cps = CHECKPOINTS.filter((cp) => (cp.field !== 'reviewSessions' || sessions) && (cp.field !== 'reviewWrites' || writes));
    const buttons = cps.map((cp) => checkpointButtonHtml(cp, shownYou(job, cp.field), { lock: checkpointLock(job, cp.field), saving: flags.pending?.field === cp.field })).join('');
    const c = flags.confirm && checkpoint(flags.confirm.field);
    // A form, so a graph tick leaves the question where it is (render() skips a dialog holding one).
    const confirm = c ? `<form class="job-flags-confirm" id="job-review-confirm"><b>Switch ${esc(c.name)} to Auto?</b><p>${esc(c.wait(flags.confirm.n))} Auto lets ${flags.confirm.n === 1 ? 'it' : 'them'} through now, and every later one goes straight on.</p><div class="job-actions"><button class="primary">${esc(c.yes(flags.confirm.n))}</button><button type="button" data-review-keep>Keep You review</button></div></form>` : '';
    return `<footer class="job-detail-footer">${confirm}<div class="job-flags" role="group" aria-label="Review checkpoints">${buttons}</div>${flagsHintHtml(job)}</footer>`;
  }
  function setReview(field, you, release) {
    const cp = checkpoint(field);
    const n = release ? flags.confirm?.n || 1 : 0;
    flags.confirm = null; flags.pending = { field, you };
    flags.note = release ? { field, head: checkpointLabel(cp, false), body: `${cp.done(n)}. Released work can’t be pulled back.`, undo: false }
      : { field, head: checkpointLabel(cp, you), body: `From the next ${cp.unit} on.${you ? ' Anything already past this checkpoint carries on.' : ''}`, undo: { field, you: !you } };
    action('set-review', { field, you, ...(release ? { release: true } : {}), ...(release && field === 'reviewPlan' && planDraft ? { plan: planDraft, revision } : {}) }, '');
    paintFooter(field);
  }
  // Handlers read the job when they fire: a plan under review is not redrawn on
  // graph ticks, so a job captured at wiring time would go stale.
  const shownJob = () => data.jobs.find((j) => j.id === selected?.jobId);
  function wireFooter() {
    const footer = dialog.querySelector('.job-detail-footer');
    if (!footer) return;
    footer.querySelectorAll('[data-review]').forEach((b) => {
      const field = b.dataset.review;
      const enter = () => { if (flags.hover === field) return; flags.hover = field; if (flags.note?.field !== field) flags.note = null; paintHint(); };
      b.onpointerenter = enter; b.onfocus = enter;
      b.onclick = () => {
        const job = shownJob();
        if (!job || checkpointLock(job, field) || flags.pending) return;
        const you = shownYou(job, field);
        const n = you ? checkpointWaiting(job, field) : 0;
        if (!n) return setReview(field, !you, false);
        flags.confirm = { field, n }; flags.note = null;
        paintFooter();
        dialog.querySelector('#job-review-confirm button.primary')?.focus();
      };
    });
    // Leaving with neither pointer nor focus inside drops the hover hint and any Undo.
    const left = () => { flags.hover = null; if (flags.note?.undo) flags.note = null; paintHint(); };
    footer.onpointerenter = () => { flags.inside = true; };
    footer.onpointerleave = () => { flags.inside = false; if (!footer.contains(document.activeElement)) left(); };
    footer.onfocusout = (e) => { if (!flags.painting && !flags.inside && !footer.contains(e.relatedTarget)) left(); };
    const undo = footer.querySelector('[data-review-undo]');
    if (undo) undo.onclick = () => {
      if (flags.pending) return;
      const { field, you } = flags.note.undo;
      setReview(field, you, false);
      flags.note = { field, head: checkpointLabel(checkpoint(field), you), body: 'Switched back.', undo: false };
      paintFooter(field);
    };
    const confirm = footer.querySelector('#job-review-confirm');
    if (confirm) {
      confirm.onsubmit = (e) => { e.preventDefault(); setReview(flags.confirm.field, false, true); };
      confirm.querySelector('[data-review-keep]').onclick = () => { const { field } = flags.confirm; flags.confirm = null; paintFooter(field); };
    }
  }
  function paintHint() {
    const hint = dialog.querySelector('.job-detail-footer .job-flags-hint');
    if (!hint) return;
    hint.outerHTML = flagsHintHtml(shownJob());
    wireFooter();
  }
  // The footer alone, so a click does not rebuild the dialog under the pointer;
  // `focus` names the button that should hold focus afterwards.
  function paintFooter(focus = null) {
    const job = shownJob();
    const footer = dialog.querySelector('.job-detail-footer');
    if (!job || !footer) return;
    flags.painting = true;
    footer.outerHTML = footerHtml(job);
    flags.painting = false;
    wireFooter();
    if (focus) dialog.querySelector(`.job-detail-footer [data-review="${focus}"]`)?.focus();
  }
  // An idea still being talked through is its conversation (job-idea.js); once its
  // suggestion is accepted the job starts, the thread folded under its detail.
  function ideaDetail(job) {
    const cost = costChip(job.usd, job.usdEstimated, JOB_COST_TITLE);
    const error = budgetHtml(job) + (job.error ? `<p class="job-error">${esc(job.error)}</p>` : job.idea?.error ? `<p class="job-error">${esc(job.idea.error)} · Retrying automatically</p>` : '');
    const actions = `${job.error ? `<button class="primary" id="job-retry">${ICONS.wrench}Retry</button>` : ''}<button data-action="${job.paused ? 'resume' : 'pause'}" title="${job.paused ? 'Resume job' : 'Pause new work for this job'}">${job.paused ? `${ICONS.play}Resume` : `${ICONS.pause}Pause`}</button><button class="danger" id="job-cancel">${ICONS.stop}Cancel idea</button>`;
    // What was on screen when the dialog opened is not new; only what arrives after fades in.
    if (ideaSeen?.jobId !== job.id) for (const m of ideaThread(job)) ideaDrawn.add(m.id);
    return ideaViewHtml(job, { cost, actions, error, pending: ideaSent?.jobId === job.id ? ideaSent : null, firing: ideaFiring?.jobId === job.id ? ideaFiring : null, fresh: freshMessage, tray: askTrayHtml(''), titled: titledNow(job) });
  }
  const conversationHtml = (job) => ideaThread(job).length ? more('idea', `${ICONS.note}Conversation <small>${ideaThread(job).length + 1}</small>`, ideaThreadHtml(job), 'job-idea-past') : '';
  // A node's colour and icon already say done, queued or planned, so only the
  // states they cannot say carry a line. A delivered job is one line of what
  // landed; its all-green graph waits behind a disclosure.
  const QUIET_LINE = ['done', 'queued', 'planned'];
  function liveGraphHtml(job) {
    const graph = planGraphHtml({ ...job.plan, subJobs: job.subJobs }, { stateOf: (s) => subState(job, s), lineOf: (s) => QUIET_LINE.includes(subState(job, s)) ? '' : subLine(job, s), openTickets, reviewWrites: job.reviewWrites, base: job.base });
    if (job.stage !== 'done' || job.cancelledAt) return graph;
    const landed = job.subJobs.filter((s) => !s.cancelledAt && s.pr?.url);
    const line = landed.length ? `Delivered: ${landed.map((s) => link(s.pr.url, `${s.title} #${prNumber(s)}`)).join(' · ')}` : 'Delivered';
    return `<p class="job-delivered">${ICONS.check}<span>${line}</span></p>${more('steps', `Steps <small>${job.subJobs.length}</small>`, graph, 'job-steps-more')}`;
  }
  function jobDetail(job) {
    if (inConversation(job)) return ideaDetail(job);
    const state = jobState(job);
    const live = job.stage === 'active' || job.stage === 'done';
    const plan = planDraft || job.plan;
    const running = job.runs.some((r) => !r.stopped);
    const hints = [job.cancelledAt ? cancelledText(job) : '',
      job.stage === 'backlog' && !job.cancelledAt ? 'Planning proposes Jira story titles without touching Jira. You review the plan before tickets are created or work begins.' : '',
      job.stage === 'planning' && !job.plan && !job.cancelledAt ? 'Wrangler will bring the plan here for review.' : '',
      replanPending(job) ? replanProposed(job) ? 'Approving applies the change: new sub-jobs are added, edited ones take their new brief, removed ones are cancelled with any PR left open on GitHub. Locked sub-jobs have already landed and stay as they are. Only the steps it changes wait until you approve or discard it; the rest of the job carries on.' : 'Wrangler is working on it and will bring any proposal here. Only held steps wait meanwhile; the rest of the job carries on.' : ''].filter(Boolean);
    const chips = stateChip(state, jobLabel(job), hints) + (plan ? storyChips(plan.stories || []) : repoChips(job.repos))
      + (job.base ? chip(ICONS.branch, `→ ${job.base}`, { title: `Every PR lands on ${job.base} unless it names another branch` }) : '') + costChip(job.usd, job.usdEstimated, `${JOB_COST_TITLE}${job.usdEstimated ? ' · includes an estimate for Codex sessions' : ''}`);
    let body = '', fab = '', extra = '';
    if (planDraft) {
      const writes = planDraft.subJobs.filter(isWriteSub);
      const reviewedOf = (list) => list.filter((w) => writeReviewed(job, w)).length;
      const reviewed = reviewedOf(writes);
      const bad = planDraft.subJobs.filter(writeProblem);
      if (writeEdit != null && !isWriteSub(planDraft.subJobs[writeEdit])) writeEdit = null;
      body = `${writes.length ? `<div class="job-chips job-write-count">${chip(ICONS.link, `${writes.length} write${writes.length === 1 ? '' : 's'}${reviewed ? ` · ${reviewed} reviewed` : ''}`, { cls: 'job-chip-quiet', title: 'Open a place under its step to change its writes; its eye says whether it stops for your review' })}</div>` : ''}${planGraphHtml(planDraft, { editable: true, openDeps, openTickets, openShow, editing: writeEdit, reviewWrites: reviewDefault(), base: job.base })}${writeEdit != null ? writeEditorHtml(job, planDraft, writeEdit) : ''}${planMoreHtml(job, planDraft)}`;
      const authority = authorityText(job, planDraft);
      fab = `<button class="primary" data-action="approve-plan" title="${esc(bad.length ? `Finish ${bad.length === 1 ? 'the write' : `${bad.length} writes`} first: ${writeProblem(bad[0])}` : authority)}" ${running || bad.length ? 'disabled' : ''}>${ICONS.check}Approve ${planDraft.subJobs.filter((s) => !isWriteSub(s)).length}</button>`;
    } else if (replanProposed(job)) body = proposalHtml(job);
    else if (live && !(job.cancelledAt && !job.subJobs.length)) body = `${replanPending(job) ? `<p class="job-replan-ask"><b>Wrangling</b>${queuedTag(job)} ${esc(latestAsk(job.replan))}</p>` : replanQueued(job).length ? `<p class="job-replan-ask"><b>Wrangling</b>${queuedTag(job)} Starts once the last change's wrangler has stopped</p>` : ''}${supersededHtml(job)}${liveGraphHtml(job)}${planMoreHtml(job, job.plan)}${movesHistoryHtml(job)}`;
    else if (ideaEditable(job) && ideaEdit === job.id) body = ideaEditHtml(job, stripHtml(job));
    else body = `<p class="job-intent">${esc(job.intent)}</p>${stripHtml(job)}`;
    if (job.error) fab = `<button class="primary" id="job-retry">${ICONS.wrench}Retry</button>`;
    else if (ideaEditable(job) && ideaEdit === job.id) fab = '';
    else if (job.stage === 'backlog' && !job.cancelledAt) fab = `<button class="primary" data-action="start" title="${esc(hints[0])}">${ICONS.play}Start planning</button>${ideaEditable(job) ? `<button data-idea-edit title="Change the title and words before a planner reads them">${ICONS.edit}Edit idea</button>` : ''}`;
    else if (replanProposed(job)) fab = '';
    else if (job.stage === 'active') fab = leadFab(job);
    else if (!fab) fab = promptFab(job);
    if (job.stage === 'active' && !job.cancelledAt) extra = replanProposed(job) ? ''
      : replanPending(job) ? `<button data-action="discard-replan" title="Stop wrangling and keep the plan as it is">${ICONS.x}Discard change</button>` : '';
    const tail = job.cancelledAt || job.stage === 'done' ? '' : `<button data-action="${job.paused ? 'resume' : 'pause'}" title="${job.paused ? 'Resume job' : 'Pause new work for this job'}">${job.paused ? `${ICONS.play}Resume` : `${ICONS.pause}Pause`}</button><button class="danger" id="job-cancel">${ICONS.stop}Cancel job</button>`;
    const ask = changeBoxHtml(job, null);
    // The job's buttons and its checkpoints share one row; a delivered job has no checkpoints left to switch.
    const done = job.stage === 'done' && !job.cancelledAt;
    const buttons = fab || extra || tail ? `<div class="job-actions tone-${STATES[state].tone}">${fab}${extra}${tail}</div>` : '';
    return `${appbar(job.title, chips)}${eventHtml(job, null, more)}${budgetHtml(job)}${mainNoticeHtml(job)}${body}${conversationHtml(job)}${ask}
      ${buttons || !done ? `<div class="job-detail-tail">${buttons}${done ? '' : footerHtml(job)}</div>` : ''}`;
  }
  // What a write's state means, in sentences: the chip's tooltip carries them all,
  // and the review / already-there one is also the box above it.
  const placeName = placeShort;
  function writeHints(job, sub, held) {
    if (!isWriteSub(sub) || sub.cancelledAt) return [];
    const key = sub.jiraKey || sub.result?.key || 'The ticket';
    const by = writeSession(job, sub)?.title || 'Its session';
    const parked = !!parkedRun(job, writeSession(job, sub));
    return [
      writeAwaitingReview(sub) && !held ? (isMakeWrite(sub) ? `Review is on for this output: ${by} published it. Accept it to finish, or drop it.`
        : `Review is on for this write: ${by} drafted it below and nothing has been written to ${placeName(sub)} yet. Change anything before you approve it${parked ? `; once every draft it sent is decided, ${by} is told what to make` : ''}.`) : '',
      sub.result?.outcome === 'already' ? (isJiraWrite(sub) ? `${key} was already ${sub.action?.to ? `at or past ${sub.action.to}` : 'there'}${sub.result.from ? ` (${sub.result.from})` : ''}, so nothing moved${sub.action?.comment ? '; the comment was still posted' : ''}.` : `It was already in ${placeName(sub)}, so nothing was written twice.`) : '',
      sub.stage === 'write' && sub.state === 'queued' && sub.by ? (isMakeWrite(sub) ? `${by} makes this and says where it is when it reports.`
        : writeReviewed(job, sub) ? `${by} drafts this for your review before it writes anything.` : `${by} makes this write and reports it.`) : '',
      sub.stage === 'write' && sub.state === 'approved' ? `You approved it; ${by} makes it as approved.` : '',
      sub.state === 'failed' && !sub.blocked && sub.by ? (isMakeWrite(sub) ? `${by} did not make it. Retry runs it again for this; or mark it done with where it is if you made it yourself, or drop it.`
        : `${placeName(sub)} refused it. Retry once it allows it${isJiraWrite(sub) ? ', pick another status' : ', edit it'} (either runs ${by} again for it), or mark it done if you made the change yourself.`) : '',
    ].filter(Boolean);
  }
  // Where the write goes, and where it ended up: an http(s) link opens, a file
  // shows its path to copy, and to open where the host can show it.
  function placeRowHtml(job, sub) {
    const p = placesOf({ ...job.plan, subJobs: job.subJobs }, job.subJobs.filter((w) => isWriteSub(w))).find((x) => x.writes.includes(sub));
    if (!p) return '';
    const href = p.type === 'file' ? null : webUrl(p.url);
    const where = p.type === 'file' && p.url ? filePathHtml(p.url)
      : href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(p.name)} ↗</a>` : esc(p.name);
    return `<div><dt>${esc(PLACES[p.type].name)}</dt><dd>${where}</dd></div>`;
  }
  // `brief`: only where it goes and when, for a write whose fields are the panel above.
  function writeSpecHtml(job, sub, brief = false) {
    const stories = job.plan?.stories || [];
    const story = stories.find((t) => t.id === sub.storyId);
    const row = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;
    const a = sub.action || {};
    const text = sub.result?.text || a.comment || a.text;
    const jira = isJiraWrite(sub);
    const where = jira ? row('Ticket', esc([sub.jiraKey || (story ? storyLabel(story, stories) : ''), story?.title].filter(Boolean).join(' · '))) : placeRowHtml(job, sub);
    if (brief) return `<dl class="job-write-spec">${where}${row('By', esc(dependencyLine(job, sub)))}</dl>`;
    return `<h3>The write</h3><dl class="job-write-spec">${where}
      ${isStoryCreate(sub) ? row('Action', 'Create the story') + (storyProject(story) ? row('Project', esc(storyProject(story))) : '') + (story?.fields || []).map((f) => row(esc(f.name), `<span class="job-write-quote">${esc(f.value)}</span>`)).join('') : ''}
      ${jira && sub.result?.url ? placeRowHtml(job, sub) : ''}
      ${!jira && sub.place?.ref ? row(placeOf(sub) === 'slack' ? 'Channel' : a.type === 'comment' ? 'Page' : 'Where', esc(sub.place.ref)) : ''}
      ${a.what ? row('Makes', esc(a.what)) : ''}${a.title ? row('Title', esc(a.title)) : ''}
      ${a.to ? row('Status', `${sub.result?.from ? `<span class="job-write-from">${esc(sub.result.from)}</span> → ` : ''}<b>${esc(a.to)}</b>`) : ''}
      ${text ? row(a.type === 'post' ? 'Post' : a.type === 'create' ? 'Body' : 'Comment', `<span class="job-write-quote">${esc(text)}</span>`) : ''}
      ${row('By', esc(dependencyLine(job, sub)))}${sub.why ? row('Why', esc(sub.why)) : ''}</dl>`;
  }
  // A write in review is approved from its own fields: the panel is the editor.
  // A form, so a live tick leaves what is being typed alone and the chord
  // approves; Skip finishes it without writing.
  function writeReviewHtml(job, sub, state) {
    const story = isStoryCreate(sub) ? job.plan?.stories?.find((t) => t.id === sub.storyId) : null;
    if (story && storyDraft?.id !== sub.id) storyDraft = { id: sub.id, title: story.title, fields: structuredClone(story.fields || []) };
    const fields = story ? storyEditorHtml(story) : writeFieldsHtml({ ...job.plan, subJobs: job.subJobs }, sub, { inReview: true, job });
    return `<form id="job-write-review" class="job-write-editor job-write-panel">${fields}<p class="job-error" id="job-move-error" hidden></p>
      <div class="job-actions tone-${STATES[state].tone}"><button class="primary" title="Make this write now, as it stands here">${ICONS.check}${esc(writeVerb(sub))}</button><button type="button" data-action="skip-write" title="Finish it without writing anything">Skip</button></div></form>${writeSpecHtml(job, sub, true)}`;
  }
  // Where a published output is: a link opens, anything else is a path to read.
  function madeWhereHtml(sub) {
    const r = sub.result;
    if (!r?.url) return '';
    const href = webUrl(r.url);
    return `<p class="job-write-where">${PLACES[placeOf(sub)].icon}${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(r.title || r.url)} ↗</a>` : `<code>${esc(r.url)}</code>`}</p>`;
  }
  function subDetail(job, sub) {
    const state = subState(job, sub);
    const status = jobStatus(job, sub);
    const pr = isPrSub(sub);
    const trigger = sessionTrigger(job, sub);
    const dropped = sub.notNeeded && !sub.superseded ? `${trigger?.title || 'Its trigger'} landed, so this if-dropped session was not needed.` : isWriteSub(sub) && sub.cancelledAt && !sub.superseded ? (isMakeWrite(sub) ? 'Dropped. The session will not make it.' : `Dropped. Nothing was written to ${placeName(sub)}.`) : sub.superseded ? `Superseded by a plan change and cancelled.${sub.pr?.url ? ' Its PR is left open on GitHub for you to close.' : ''}${isPrSub(sub) ? ' Cleanup removes the worktree only if it has no uncommitted files and every commit is already on the branch the job lands on or the branch is unchanged.' : ''}` : sub.cancelledAt ? (isHumanSub(sub) ? 'Dropped. Nothing ever ran for it, so there is nothing to clean up.' : isSessionSub(sub) ? 'Dropped. Its session is archived; nothing on disk is removed.' : 'Dropped. Nothing was merged. Cleanup archives its sessions and removes the worktree only if it has no uncommitted files and every commit is already on the branch the job lands on or the branch is unchanged.') : '';
    const orphan = triggerDropped(job, sub) ? `${trigger.title} was dropped, so it will never reach ${milestoneLabel(trigger, sub.on.at)} and this session will never start. Drop it, or Change plan to start it on something else.`
      : !sub.cancelledAt && sub.stage !== 'done' && cancelledDependencies(job, sub).length
      ? `A prerequisite was dropped, so this ${isHumanSub(sub) ? 'task’s turn will never come' : isSessionSub(sub) ? 'session can never start' : 'sub-job can never land'}. Drop it too, or add the remaining work with New ticket.` : '';
    const held = heldByReplan(job, sub);
    const yours = isHumanSub(sub) && sub.stage === 'human' && !held;
    const hints = [dropped, orphan,
      held ? (job.replan?.red?.sub === sub.id ? 'Held while Wrangler fixes it: nothing here starts, merges or can be approved until the fix is in or you decide on it.' : job.replan?.red ? 'Held while Wrangler fixes a red step this one waits on: nothing here starts, merges or can be approved until the fix is in or you decide on it.' : 'Frozen while the plan is being changed: nothing here starts, merges or can be approved until you approve or discard the change on the job.') : '',
      isSessionSub(sub) && sub.stage === 'review' ? 'Approving marks the session done and lets the work depending on it start.' : '',
      parkedRun(job, sub) ? (draftsWaiting(job, sub).length ? `Paused on ${draftsWaiting(job, sub).length} draft${draftsWaiting(job, sub).length === 1 ? '' : 's'} for your review. Approve, edit or skip each; once all are decided the session is told which to make and carries on.` : 'Every draft is decided: the session is being told which writes to make.') : '',
      sessionDormant(job, sub) ? `${triggerLine(job, sub)}: it is dropped itself once ${trigger?.title || sub.on.sub} lands.` : '',
      ...writeHints(job, sub, held),
      yours ? `No agent will ever run this one${sub.state === 'doing' ? '; you marked it in progress' : ''}. Marking it done is what releases the work waiting on it.` : '',
      codeAwaitingReview(sub) ? `Uncommitted · approve to commit and ${sub.pr ? 'push to the open PR' : 'open the PR'}` : pr && sub.stage === 'review' && !sub.error && !held ? `Approved. Its session commits and ${sub.pr ? 'pushes to the open PR' : 'pushes and opens the PR'} next.` : '',
      conflictWaiting(sub) ? 'Merging the base into this PR hit a conflict the agent would not guess at. Pick one way to resolve each; its session finishes the merge, commits and pushes.' : sub.conflict?.decided ? (sub.conflict.decided.auto ? 'Code and Merge review are on Auto, so the session’s recommended option was taken for each conflict: it finishes the merge, commits and pushes. History lists what was chosen.' : 'Your choices went to the session: it finishes the merge, commits and pushes.') : '',
      mergeHeldByComments(job, sub) ? 'Comments read as blocking, so the automatic merge is on hold. Approve merge to override for this head.' : '',
      sub.stage === 'pr' && sub.pr?.mergeWithAdmin ? 'Checks have passed. Merging will override GitHub’s required review.' : '',
      sub.fixRequested ? `Fix requested${sub.fixRequested.note ? `: ${sub.fixRequested.note}` : ''}. A repair session starts ${pendingDependencies(job, sub).length ? 'once its prerequisites deploy' : 'on the next tick'}.` : '',
      staleHint(sub),
      sub.recoveredBy ? `The merged change stays deployed. The fix is a sub-job in this job, ${job.subJobs.find((f) => f.id === sub.recoveredBy)?.title || sub.recoveredBy}; this sub-job counts as deployed once it does.` : ''].filter(Boolean);
    const n = prNumber(sub);
    const deploys = deploysLine(sub);
    const workflows = sub.deploys?.workflows || [];
    const story = job.plan?.stories?.find((s) => s.id === sub.storyId);
    // Only what can be acted on stays a chip; what the step is and where it lives is one quiet line.
    const cost = jobCostLabel(sub.usd, sub.usdEstimated), total = jobCostLabel(job.usd, job.usdEstimated);
    const line = [metaPart(kindLabel(sub), { cls: 'job-kind-label', title: KIND_TITLE[kindClass(sub)] }),
      metaPart(sub.jiraKey || (sub.storyId ? 'Ticket pending' : ''), { title: story?.title || '' }),
      pr ? metaPart(tildify(sub.repo).split('/').pop(), { title: tildify(sub.repo) }) : '',
      branchPart(job, sub),
      metaPart(cost, { cls: 'job-detail-cost', title: `${SUB_COST_TITLE}${total ? ` · job total ${total}` : ''}` })].filter(Boolean).join('<i aria-hidden="true">·</i>');
    const chips = stateChip(state, status.text, hints)
      + (sub.pr ? `<a class="job-chip job-pipeline-status ${checkTone(sub.pr.checkStatus)}" ${/^https:\/\/github\.com\//.test(sub.pr.url || '') ? `href="${esc(sub.pr.url)}" target="_blank" rel="noopener noreferrer"` : ''} title="Pull request · checks ${esc(sub.pr.checkStatus)}${sub.pr.head ? ` · ${esc(sub.pr.head.slice(0, 8))}` : ''}">${ICONS.pr}<span>${n ? `#${esc(n)}` : 'PR'}</span></a>` : '')
      + (deploys ? chip(ICONS.rocket, sub.deploys.expected === false ? 'No deploy' : 'Deploys', { cls: 'job-deploys', title: deploys }) : '')
      + (sub.stage === 'review' ? runningChipHtml(sub, { open: openMore.has('running'), logs: runLogs.get(sub.id) }) : '');
    const kicker = `<button class="job-back" data-open-job title="Back to the job">${ICONS.back}<span>${esc(job.title)}</span></button>`;
    const session = sub.sessions.length ? sessionSplitHtml(job, sub, runStatus(job, sub) === 'needs-you') : '';
    // Wrangler's own turn (Fixing) or a fix for you (Fix ready, a declared red's options)
    // outranks Retry as the primary action; Retry stays for a transient failure.
    const redAsk = sub.error && !job.error && (redFixReady(job, sub) || (redDeclared(job, sub) && job.replan?.proposal)) ? `<button class="primary" data-open-job title="Opens the job dialog on the proposal">${ICONS.eye}${redFixReady(job, sub) ? 'Review fix' : 'Decide'}</button>` : '';
    const retry = sub.error ? `${redAsk}${retrySplitHtml(!redAsk && !redFixing(job, sub))}` : job.error ? `<button id="job-retry">${ICONS.wrench}Retry</button>` : '';
    let body = '', actions = '';
    const reviewing = ['code', 'session'].includes(changeView(job, sub)?.at);
    if (isWriteSub(sub)) {
      const review = writeAwaitingReview(sub) && !held;
      const box = (text) => text ? `<p class="job-write-hint">${ICONS.info}<span>${esc(text)}</span></p>` : '';
      const made = isMakeWrite(sub);
      const panel = review && !made;
      body = `${box(review ? '' : sub.result?.outcome === 'already' ? hints.find((h) => /^(.* reached |.* was already )/.test(h)) : orphan)}${review && made ? madeWhereHtml(sub) : ''}${sub.result ? `<h3>Reported</h3>${receiptHtml(sub.result.checks)}` : ''}${panel ? writeReviewHtml(job, sub, state) : writeSpecHtml(job, sub)}`;
      // A write is only ever made by its session, so Retry (and an edit of a
      // failed one) runs that again for it, a finished session for its writes
      // alone; a dropped session leaves it to be marked done or dropped.
      const owner = writeSession(job, sub);
      const failed = sub.state === 'failed' && !isStoryCreate(sub);
      const unowned = !owner || !!owner.cancelledAt || (['cleanup', 'done'].includes(owner.stage) && sub.state !== 'failed');
      const editable = !sub.cancelledAt && !['cleanup', 'done'].includes(sub.stage) && !held && !unowned && !!sub.by
        && !(sub.stage === 'write' && job.runs.some((r) => !r.stopped && r.subJobId === sub.by));
      const again = unowned || !sub.by ? '' : retry;
      // A made output is already published: it can only be accepted or dropped.
      actions = `${review && made ? `<button class="primary" data-action="approve-write" title="Accept it as published and finish it">${ICONS.check}Accept</button>` : ''}${again}
        ${editable && !review ? `<button id="job-write-edit">${ICONS.edit}${failed && isJiraWrite(sub) && sub.action?.to ? 'Pick another status' : 'Edit'}</button>` : ''}`;
    } else if (isSessionSub(sub)) {
      // Its writes hang under it in the graph; here each opens its own dialog,
      // which is where a draft is approved.
      const owned = job.subJobs.filter((w) => isWriteSub(w) && w.by === sub.id);
      // A made write with a link also opens where it is, beside the chip's own dialog.
      const writeChip = (w) => {
        const tone = `tone-${STATES[subState(job, w)].tone}`, href = webUrl(w.result?.url);
        const open = `<button type="button" ${href ? '' : `class="job-chip ${tone}" `}data-open-sub="${esc(w.id)}" title="${esc(jobStatus(job, w).text)}">${PLACES[placeOf(w)].icon}<span>${esc(w.title)}</span></button>`;
        return href ? `<span class="job-chip job-chip-go ${tone}">${open}<a class="job-place-go" href="${esc(href)}" target="_blank" rel="noopener" title="Open ${esc(w.result.title || w.title)} in a new tab">↗</a></span>` : open;
      };
      const writes = owned.length ? `<h3>Writes</h3><div class="job-chips">${owned.map(writeChip).join('')}</div>` : '';
      body = `${sub.feedback && !sub.result ? `<h3>Requested changes</h3><p>${esc(sub.feedback)}</p>` : ''}${sub.result ? `<h3>Reported</h3>${receiptHtml(sub.result.checks)}` : ''}${writes}${noteFor(sub)}${approvalNoteFor(sub)}`;
      actions = `${sub.stage === 'review' && !sub.error && !held ? approveSplitHtml('approve-session', hints.find((h) => h.startsWith('Approving')) || '', 'Approve', noteReaders(job, sub).length ? 'later' : null) : ''}${session}${retry}`;
    } else if (isHumanSub(sub)) {
      // The brief is the instruction here, not background for an agent, so it is
      // the body of the dialog rather than a folded detail.
      body = `<h3>What to do</h3><p class="job-brief">${esc(sub.brief)}</p>${sub.result ? `<h3>Recorded</h3>${receiptHtml(sub.result.checks)}` : ''}
        ${sub.result?.output ? `<h3>Result for dependent work</h3><pre class="job-human-output">${esc(sub.result.output)}</pre>` : ''}${noteFor(sub)}
        ${yours ? `<form id="job-human-form" data-state="${esc(sub.state)}"><label>Result for dependent work <small title="Up to 8,000 characters, passed to dependent agents">optional</small><textarea name="output" maxlength="8000" rows="4"></textarea></label><div class="job-actions tone-${STATES[state].tone}"><button class="primary" type="submit" title="${esc(hints.find((h) => h.startsWith('No agent')) || '')}">${ICONS.check}Mark done</button>${sub.state === 'doing' ? '' : '<button type="button" data-action="start-human">Mark in progress</button>'}</div></form>` : ''}`;
      actions = retry;
    } else {
      body = `${conflictHtml(sub)}${sub.ready ? (hasProof(sub) ? proofListHtml(job, sub, { isOpen: (k) => openMore.has(k), ask: sub.stage === 'review' }) : `<h3>${sub.stage === 'review' ? 'Ready for review' : 'Verified'}</h3>${receiptHtml(sub.ready.checks)}`) : ''}${sub.stage === 'review' ? `${stoppedHtml(sub)}${historyHtml(job, sub, { open: openMore.has('history') })}` : ''}
        ${sub.stage !== 'done' ? mergeMethodHtml(sub) : ''}
        ${sub.pr?.checks?.length ? `<h3>Checks</h3><ul class="job-checks">${sub.pr.checks.map((c) => `<li class="${checkTone(c.state)}">${checkMark(c.state)} ${esc(c.name)} <small>${esc(c.state.toLowerCase())}</small></li>`).join('')}</ul>` : ''}
        ${sub.pr ? commentsHtml(sub, commentsShown) : ''}
        ${sub.deploymentResult ? `<h3>Deployment pipelines</h3><ul class="job-checks">${sub.deploymentResult.runs.map((r) => `<li class="${checkTone(r.status)}">${checkMark(r.status)} ${link(r.url, r.workflow)} <small>${esc(r.status)}${r.supersedes ? ` · on ${esc(String(r.commit || '').slice(0, 8))}, which replaced the cancelled run` : ''}</small></li>`).join('')}</ul>` : ''}
        ${sub.deployed ? `<h3>Landed</h3>${receiptHtml(sub.deployed.checks)}` : ''}${noteFor(sub)}${approvalNoteFor(sub)}${refusalHtml(sub)}`;
      actions = `${codeAwaitingReview(sub) && !sub.error && !held ? approveSplitHtml('approve-code', [hints.find((h) => h.startsWith('Uncommitted')) || '', sub.ready?.round ? `Approval is tied to round ${sub.ready.round}${sub.ready.treeHash ? ` and working tree ${sub.ready.treeHash.slice(0, 7)}` : ''}.` : ''].filter(Boolean).join(' · '), `Approve &amp; ${sub.pr ? 'push' : 'open PR'}`, 'pr') : ''}${mergeApprovable(job, sub) && !held ? `<button class="primary" data-action="approve-merge" title="${mergeMethodOf(sub) ? `${esc(mergeMethodOf(sub).method === 'rebase' ? 'Rebase' : 'Merge-commit')} head` : 'Squash head'} ${esc((sub.pr.head || '').slice(0, 8))}">${ICONS.merge}Merge${n ? ` #${esc(n)}` : ''}</button>` : ''}
        ${sub.worktree && sub.stage !== 'done' ? reviewCodeHtml(sub) : ''}${session}${retry}${sub.cleanupRefusal && sub.cleanupRefusal.pinned !== false && sub.stage === 'cleanup' && !sub.discard ? `<button class="danger" id="job-discard">${ICONS.x}${sub.cleanupRefusal.cause === 'unremovable' ? 'Discard' : 'Discard anyway'}</button>` : ''}
        ${sub.recoveredBy ? `<button data-open-sub="${esc(sub.recoveredBy)}" title="${esc(hints.at(-1))}">${ICONS.wrench}Open fix sub-job</button>` : ''}`;
    }
    const details = `${metDepsHtml(job, sub)}${pr ? `<code>${esc(sub.worktree?.path || 'Worktree created on dispatch')}</code>` : ''}${isHumanSub(sub) || isWriteSub(sub) ? '' : `<p>${esc(sub.brief)}</p>`}${sub.why ? `<p>Why: ${esc(sub.why)}</p>` : ''}${sub.check ? `<p>Check after it lands: ${esc(sub.check)}</p>` : ''}${showMeHtml(sub)}
      ${workflows.length ? `<h4>What runs on merge <small>${workflows.filter((w) => w.triggers).length} of ${workflows.length}</small></h4><ul class="job-checks">${workflows.map((w) => `<li class="${w.triggers ? 'passed' : ''}">${w.triggers ? '✓' : '○'} ${esc(w.name)} <small>${esc(w.reason)}</small></li>`).join('')}</ul>` : ''}
      ${sub.repairs.length ? `<h4>Changes after failed checks</h4>${sub.repairs.map((r, i) => `<div class="job-repair"><b>Repair ${i + 1}</b>${receiptHtml(r.changes)}<details><summary>Re-verified</summary>${receiptHtml(r.checks)}</details></div>`).join('')}` : ''}`;
    const detailsOpen = openMore.has('details');
    if (!isWriteSub(sub)) actions += `<button type="button" class="job-details-toggle" data-details-toggle aria-expanded="${detailsOpen}">${ICONS.doc}Details</button>`;
    return `${appbar(sub.title, chips, kicker, line)}${depsHtml(job, sub)}
      ${job.error && !sub.error ? `<p class="job-error">${esc(job.error)}</p>` : ''}${eventHtml(job, sub, more)}
      ${sub.observationError ? `<p class="job-error">${esc(sub.observationError)} · Retrying automatically</p>` : ''}${body}
      ${reviewing ? changeBoxHtml(job, sub) : ''}${actions.trim() ? `<div class="job-actions tone-${STATES[state].tone}">${actions}</div>` : ''}${reviewing ? '' : changeBoxHtml(job, sub)}
      ${isWriteSub(sub) ? '' : `<div class="job-details-body" ${detailsOpen ? '' : 'hidden'}>${details}</div>`}`;
  }
  // The shot viewer's own controls. Back and Ask both leave it; Ask lands in the
  // Request changes box with the question started, about this item.
  // Blank Show me rows are dropped on the way out, and a list left empty is no list.
  const cleanedPlan = (plan) => ({ ...plan, subJobs: plan.subJobs.map((s) => {
    const { show, ...rest } = s;
    const items = [...new Set((show || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, MAX_SHOW);
    return items.length ? { ...rest, show: items } : rest;
  }) });
  const wireProofAsk = (sub) => dialog.querySelectorAll('[data-proof-ask]').forEach((b) => b.onclick = () => {
    const item = proofItems(sub)[+b.dataset.proofAsk];
    if (!item) return;
    replyTo.set(sub.id, '');
    askDraft = { subId: sub.id, text: item.couldNot ? `You couldn’t show “${item.text}”. Please try another way: ` : `About “${item.text}”: ` };
    proofView = null;
    renderDetail();
    askDraft = null;
    const box = dialog.querySelector('.job-change[data-change-convo=""] textarea');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  });
  function wireProofViewer(job, sub) {
    const item = proofItems(sub)[proofView.i], shot = shotsOf(item)[proofView.j || 0];
    dialog.querySelector('[data-proof-back]').onclick = () => { proofView = null; renderDetail(); };
    dialog.querySelectorAll('[data-proof-go]').forEach((b) => b.onclick = () => { proofView = { i: +b.dataset.proofGo, j: 0 }; renderDetail(); });
    dialog.querySelectorAll('[data-proof-shot]').forEach((b) => b.onclick = () => { proofView = { ...proofView, j: +b.dataset.proofShot }; renderDetail(); });
    wireProofAsk(sub);
    hydrateEvidence(dialog, evidence, send, shot ? { full: { jobId: job.id, subId: sub.id, round: proofRound(sub), file: shot.file } } : {});
  }
  // The conversation's own controls. Enter sends (Shift+Enter is a new line); the
  // launch strip's press sends at once and flares the hole for a beat before the dialog
  // closes, so the board's switch to the plan reads as its consequence.
  function wireIdea(job) {
    const n = ideaThread(job).length + (ideaSent?.jobId === job.id ? 1 : 0);
    if (ideaSeen?.jobId !== job.id || ideaSeen.n !== n) { dialog.scrollTop = dialog.scrollHeight; ideaSeen = { jobId: job.id, n }; }
    const box = dialog.querySelector('[data-idea-composer]'), text = box.querySelector('textarea'), go = box.querySelector('[data-idea-send]');
    // Send waits for every picture to finish uploading, as the change box's does.
    const sendReply = () => {
      const v = text.value.trim();
      if (!v || go.disabled) return;
      const images = askImages.map((i) => i.name).filter(Boolean);
      ideaSent = { jobId: job.id, text: v, images: askImages.map((i) => i.url), at: Date.now(), state: 'sending' };
      action('idea-reply', { text: v, ...(images.length ? { images } : {}) }, '');
      askImages = []; text.value = '';
      renderDetail();
      dialog.querySelector('[data-idea-composer] textarea')?.focus();
    };
    go.onclick = sendReply;
    wireAskImages(box);
    hydrateStrips();
    dialog.querySelectorAll('[data-idea-refine]').forEach((b) => b.onclick = () => text.focus());
    // Every press but the last makes a job beside the idea (`own` false), so the dialog stays.
    const fire = (id, pick) => {
      if (ideaFiring) return;
      const left = uncreatedSuggestions(ideaThread(job).find((m) => m.id === id)).length;
      // Sent at once, so closing the dialog mid-flare (which drops ideaFiring) never loses it;
      // the dialog keeps drawing `job` as pressed until it settles, so a tick that already
      // holds the created job cannot cut the flare short.
      ideaFiring = { jobId: job.id, job: structuredClone(job), id, ...pick, own: !!pick.all || left === 1, state: 'firing' };
      action('accept-idea', { messageId: id, ...pick }, '');
      renderDetail();
      dialog.querySelectorAll(`.job-launch.firing [data-accept-idea="${CSS.escape(id)}"]`).forEach((go) => spinTo(go, 40));
      const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      // The flare, then the strip turns green for a beat, however soon the server confirmed.
      setTimeout(() => {
        if (ideaFiring?.id !== id) return;
        ideaFiring.state = 'sent';
        if (dialog.open && selected?.jobId === job.id) renderDetail();
        setTimeout(() => {
          if (ideaFiring?.id !== id) return;
          ideaFiring.shown = true;
          if (ideaFiring.confirmed) ideaSettled(job.id);
        }, calm ? 0 : 700);
      }, calm ? 0 : 900);
    };
    dialog.querySelectorAll('[data-accept-idea]').forEach((b) => b.onclick = () => {
      if (b.getAttribute('aria-disabled') !== 'true') fire(b.dataset.acceptIdea, { index: Number(b.dataset.index) || 0 });
    });
    dialog.querySelectorAll('[data-accept-all]').forEach((b) => b.onclick = () => fire(b.dataset.acceptAll, { all: true }));
    dialog.querySelectorAll('[data-open-idea-job]').forEach((b) => b.onclick = () => openDetail(b.dataset.openIdeaJob, ''));
    dialog.querySelectorAll('[data-leave-idea]').forEach((b) => b.onclick = () => action('leave-idea', {}, ''));
  }
  // A thread or earlier-round shot opened full size: a modal of its own on <body>
  // (like job-images.js's zoom), so Esc closes it and leaves the step open, and a
  // tick redrawing the step underneath never touches it.
  let shotBox = null, shotZoom = null;
  function paintShotBox() {
    const job = data.jobs.find((j) => j.id === shotBox?.jobId), sub = job?.subJobs.find((s) => s.id === shotBox.subId);
    if (!sub || !shotZoom) return shotZoom?.close();
    const was = document.activeElement?.closest?.('.job-shotbox [data-shotbox-go], .job-shotbox [data-shotbox-close]');
    shotZoom.innerHTML = shotBoxHtml(job, sub, shotBox, evidence);
    shotZoom.setAttribute('aria-label', `Shot ${shotBox.at + 1} of ${shotBox.files.length}`);
    shotZoom.querySelector('[data-shotbox-close]').onclick = () => shotZoom.close();
    shotZoom.querySelectorAll('[data-shotbox-go]').forEach((b) => b.onclick = () => stepShot(+b.dataset.shotboxGo));
    const again = was && shotZoom.querySelector(was.dataset.shotboxGo ? `[data-shotbox-go="${was.dataset.shotboxGo}"]:not(:disabled)` : '[data-shotbox-close]');
    (again || shotZoom.querySelector('[data-shotbox-close]')).focus();
    hydrateEvidence(shotZoom, evidence, send, { full: { jobId: job.id, subId: sub.id, round: shotBox.round, file: shotBox.files[shotBox.at] } });
  }
  function stepShot(d) {
    const at = shotBox && shotBox.at + d;
    if (at == null || at < 0 || at >= shotBox.files.length) return;
    shotBox = { ...shotBox, at };
    paintShotBox();
  }
  function openShot(b) {
    const slots = [...b.closest('.job-msg-att').querySelectorAll('[data-shot-at] [data-ev-file]')];
    shotBox = { jobId: slots[0].dataset.evJob, subId: slots[0].dataset.evSub, round: Number(slots[0].dataset.evRound), files: slots.map((e) => e.dataset.evFile), at: +b.dataset.shotAt };
    shotZoom = document.createElement('dialog');
    shotZoom.className = 'job-shotbox';
    applyTheme(shotZoom);
    shotZoom.onkeydown = (e) => { const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key]; if (d) { e.preventDefault(); stepShot(d); } };
    shotZoom.onclick = (e) => { if (e.target === shotZoom || e.target.classList.contains('job-shotbox-body')) shotZoom.close(); };
    shotZoom.addEventListener('close', () => {
      const { round, files, at } = shotBox || {};
      shotZoom.remove(); shotZoom = null; shotBox = null;
      [...dialog.querySelectorAll('[data-shot-at] [data-ev-file]')].find((e) => Number(e.dataset.evRound) === round && e.dataset.evFile === files?.[at])?.closest('button').focus();
    });
    document.body.append(shotZoom);
    shotZoom.showModal();
    paintShotBox();
  }
  // What the wrangler said that this dialog draws is read once it is open on it: tell the
  // server once per message, so the job leaves the to-read state and the title row its
  // unread mark on the next tick. A folded conversation draws none of it, so it is read
  // only once the human opens it.
  const seenSent = new Set();
  function markSeen(job, sub) {
    const drawn = new Set([...dialog.querySelectorAll('.job-talk-convo[data-convo]:not(.is-folded)')].map((e) => e.dataset.convo));
    const unread = convoGroups(job, sub || null).filter((g) => g.convo && drawn.has(g.convo.id)).flatMap((g) => unreadIn(g.convo, g.messages)).filter((m) => !seenSent.has(m.id));
    if (!unread.length) return;
    for (const m of unread) seenSent.add(m.id);
    send({ type: 'job-talk-seen', id: job.id, convos: [...new Set(unread.map((m) => m.convo))] });
  }
  function renderDetail() {
    const job = ideaFiring?.jobId === selected?.jobId ? ideaFiring.job : data.jobs.find((j) => j.id === selected?.jobId);
    if (!job) return;
    const sub = job.subJobs.find((s) => s.id === selected.subId);
    if (!sub && !planDraft && job.stage === 'planning' && job.plan) { planDraft = structuredClone(job.plan); revision = job.revision; basePlan = JSON.stringify(job.plan); }
    const focus = document.activeElement?.closest?.('.job-detail-footer [data-review]')?.dataset.review;
    const shotFocus = [...dialog.querySelectorAll('.job-shot-open')].indexOf(document.activeElement);
    // An open shot is drawn instead of the step, and a tick redraws it where it was.
    const viewing = sub && proofView && proofItems(sub).length > proofView.i && !isWriteSub(sub);
    if (!viewing) proofView = null;
    flags.painting = true;
    const html = viewing ? proofViewerHtml(job, sub, proofView, evidence, { branch: sub.worktree?.branch, ask: sub.stage === 'review' }) : sub ? subDetail(job, sub) : jobDetail(job);
    // Its handlers close over `job`, so the same markup is kept only for the same job.
    const drawn = { html, job: JSON.stringify(job) };
    if (dialog.open && detailShown?.html === drawn.html && detailShown.job === drawn.job) { flags.painting = false; return; }
    const scrolled = dialog.scrollTop, scrolls = keepScrollX(dialog);
    holdSkies(dialog);
    show(html);
    detailShown = drawn;
    mountSkies(dialog);
    dialog.scrollTop = scrolled;
    scrolls();
    flags.painting = false;
    if (viewing) { wireProofViewer(job, sub); return; }
    markSeen(job, sub);
    if (!sub && inConversation(job)) wireIdea(job);
    wireFooter();
    if (focus) dialog.querySelector(`.job-detail-footer [data-review="${focus}"]`)?.focus();
    if (shotFocus >= 0) dialog.querySelectorAll('.job-shot-open')[shotFocus]?.focus();
    const approvalNoteOf = (b) => {
      const note = NOTED_APPROVALS.has(b.dataset.action) && dialog.querySelector('[data-approve-note]')?.value.trim();
      return note ? { note } : {};
    };
    dialog.querySelectorAll('[data-main-retry], [data-main-dismiss], [data-main-resolve]').forEach((b) => b.onclick = () => {
      if (!pressBusy(b)) return;
      const path = b.closest('[data-main-path]').dataset.mainPath;
      if ('mainResolve' in b.dataset) action('resolve-main', { path, resolution: b.dataset.mainResolve }, null);
      else action('mainDismiss' in b.dataset ? 'dismiss-main' : 'retry-main', { path }, null);
    });
    dialog.querySelectorAll('[data-top-up]').forEach((b) => b.onclick = () => { if (pressBusy(b)) action('top-up', { topUps: job.topUps || 0 }, null); });
    dialog.querySelectorAll('[data-main-session]').forEach((b) => b.onclick = () => { dialog.close(); onSession(b.dataset.mainSession); });
    dialog.querySelectorAll('[data-action]').forEach((b) => b.onclick = () => {
      if (!pressBusy(b)) return;
      const name = b.dataset.action;
      const target = b.dataset.sub ? job.subJobs.find((s) => s.id === b.dataset.sub) : sub;
      action(name, name === 'approve-plan' ? { plan: cleanedPlan(planDraft), revision } : name === 'approve-replan' ? { proposalId: job.replan.proposal.id, ...(job.replan.proposal.alternatives?.length ? { option: pickedOption(job) } : {}) }
        : { head: target?.pr?.head, sessionReceiptId: target?.result?.receiptId, ...(target?.ready ? { readyReceiptId: target.ready.receiptId } : {}), ...approvalNoteOf(b) }, target?.id);
    });
    dialog.querySelector('[data-idea-edit]')?.addEventListener('click', () => {
      ideaEdit = job.id; renderDetail();
      const box = dialog.querySelector('#job-idea-edit textarea');
      box?.focus(); box?.setSelectionRange(box.value.length, box.value.length);
    });
    const ideaForm = dialog.querySelector('#job-idea-edit');
    if (ideaForm) {
      ideaForm.querySelector('[data-idea-edit-cancel]').onclick = () => { ideaEdit = null; renderDetail(); };
      ideaForm.onsubmit = (e) => {
        e.preventDefault();
        if (!pressBusy(submitterOf(e))) return;
        const title = ideaForm.elements.title.value.trim();
        // Only a title the human changed is sent, so one Haiku named meanwhile is not undone.
        action('edit-idea', { text: ideaForm.elements.text.value, ...(title !== job.title ? { title } : {}) }, null);
      };
    }
    const conflictForm = dialog.querySelector('#job-conflict-form');
    if (conflictForm) conflictForm.onsubmit = (e) => {
      e.preventDefault();
      if (!pressBusy(submitterOf(e))) return;
      const form = new FormData(conflictForm);
      const picks = [...conflictForm.querySelectorAll('fieldset')].map((_, i) => Number(form.get(`c${i}`) ?? 0));
      const note = String(form.get('note') || '').trim();
      action('resolve-conflict', { runId: conflictForm.dataset.run, picks, ...(note ? { note } : {}) });
    };
    const humanForm = dialog.querySelector('#job-human-form');
    if (humanForm) humanForm.onsubmit = (e) => {
      e.preventDefault();
      if (!pressBusy(submitterOf(e))) return;
      const output = String(new FormData(humanForm).get('output') || '').trim();
      action('finish-human', output ? { output } : {});
    };
    dialog.querySelectorAll('[data-comment-toggle]').forEach((b) => b.onclick = () => {
      const key = b.dataset.commentToggle;
      if (!commentsShown.delete(key)) commentsShown.add(key);
      renderDetail();
    });
    wireWriteReview(job, sub);
    dialog.querySelectorAll('[data-proof]').forEach((b) => b.onclick = () => { proofView = { i: +b.dataset.proof, j: +b.dataset.proofAt || 0 }; renderDetail(); });
    dialog.querySelectorAll('[data-shot-at]').forEach((b) => b.onclick = () => openShot(b));
    if (sub) wireProofAsk(sub);
    hydrateEvidence(dialog, evidence, send);
    // The popover hangs from its chip, so near the dialog's right edge it slides left to stay inside.
    const fitRunning = () => dialog.querySelectorAll('.job-run-pop[open] .job-run-panel').forEach((p) => {
      p.style.left = '';
      const over = p.getBoundingClientRect().right - (dialog.getBoundingClientRect().right - 16);
      if (over > 0) p.style.left = `${-over}px`;
    });
    dialog.querySelectorAll('.job-run-pop').forEach((d) => d.addEventListener('toggle', fitRunning));
    fitRunning();
    dialog.querySelectorAll('[data-running-stop]').forEach((b) => b.onclick = () => { if (!pressBusy(b)) return; detailShown = null; runLogs.delete(sub.id); action('stop-running'); });
    dialog.querySelectorAll('[data-running-logs]').forEach((b) => b.onclick = () => {
      if (runLogs.get(sub.id)?.name === b.dataset.runningLogs) { runLogs.delete(sub.id); renderDetail(); return; }
      send({ type: 'job-running-logs', id: job.id, subJobId: sub.id, name: b.dataset.runningLogs });
    });
    dialog.querySelectorAll('[data-open-sub]').forEach((b) => b.onclick = () => openDetail(job.id, b.dataset.openSub));
    dialog.querySelectorAll('[data-copy-path]').forEach((b) => b.onclick = () => copyPath(b));
    dialog.querySelectorAll('[data-open-path]').forEach((b) => b.onclick = () => openPath(b));
    dialog.querySelectorAll('[data-open-job]').forEach((b) => b.onclick = () => openDetail(job.id));
    // A conversation opens on its title row, folding the one that was open, and the box
    // goes with it; open, its header folds it. × is for good (job-talk.js).
    dialog.querySelectorAll('[data-convo-fold]').forEach((el) => el.onclick = (e) => {
      if (e.target.closest('[data-convo-dismiss], a, .job-proof')) return;
      const box = el.closest('[data-convo]'), folded = box.classList.contains('is-folded');
      if (box.closest('[data-talk-target]')) return aimBox(sub, folded ? box.dataset.convo : '');
      convoFold.set(box.dataset.convo, folded);
      renderDetail();
    });
    // Its foot folds it as its header does, then brings that header back into view.
    dialog.querySelectorAll('[data-convo-collapse]').forEach((b) => b.onclick = () => {
      const id = b.closest('[data-convo]').dataset.convo;
      if (b.closest('[data-talk-target]')) aimBox(sub, '');
      else { convoFold.set(id, false); renderDetail(); }
      [...dialog.querySelectorAll('[data-convo]')].find((c) => c.dataset.convo === id)?.querySelector('.job-talk-convo-head')?.scrollIntoView?.({ block: 'nearest' });
    });
    // The waiting card in a conversation jumps to the decision card at the top, which flashes once.
    dialog.querySelectorAll('[data-goto-plan]').forEach((b) => b.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const card = dialog.querySelector('.job-decision');
      if (!card) return;
      const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView?.({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
      card.classList.remove('is-flash'); void card.offsetWidth; card.classList.add('is-flash');
      setTimeout(() => card.classList.remove('is-flash'), 1600);
    });
    dialog.querySelectorAll('[data-convo-dismiss]').forEach((b) => b.onclick = () => {
      const id = b.closest('[data-convo]').dataset.convo;
      if (!pressBusy(b)) return;
      if (dialog.querySelector('.job-change[data-change-convo]:not([data-idea-composer])')?.dataset.changeConvo === id) replyTo.set(sub?.id || '', '');
      action('dismiss-convo', { convo: id }, null);
    });
    // Pressing one must not blur the box: it would fold shut and shift the rows from under the pointer.
    dialog.querySelectorAll('[data-talk-target] [data-convo-fold], [data-talk-target] [data-convo-collapse], [data-change-new]').forEach((b) => b.onmousedown = (e) => e.preventDefault());
    dialog.querySelectorAll('[data-change-new]').forEach((b) => b.onclick = () => aimBox(sub, '', true));
    dialog.querySelectorAll('[data-open-idea-job]').forEach((b) => b.onclick = () => openDetail(b.dataset.openIdeaJob, ''));
    dialog.querySelectorAll('[data-fab-session]').forEach((b) => b.onclick = () => { dialog.close(); onSession(b.dataset.fabSession); });
    wireGraph();
    hydrateStrips();
    wireWriteEditor();
    const bind = (id, fn) => { const e = dialog.querySelector(id); if (e) e.onclick = fn; };
    dialog.querySelectorAll('.job-change:not([data-idea-composer])').forEach((box) => {
      const text = box.querySelector('textarea'), send = box.querySelector('[data-change-send]');
      send.onclick = () => {
        if (!text.value.trim() || send.disabled) return;
        const key = box.dataset.changeConvo || '', mine = askImages.filter((i) => i.box === key);
        const images = mine.map((i) => i.name).filter(Boolean);
        action('request-change', { text: text.value.trim(), ...(box.dataset.changeConvo ? { convo: box.dataset.changeConvo } : {}), ...(images.length ? { images } : {}) });
        clearAskSent();
        askSent = { jobId: job.id, subId: sub?.id ?? null, convo: key, text: text.value.trim(), items: mine, images: mine.map((i) => i.url), to: box.dataset.changeTo, at: Date.now(), state: 'sending' };
        askImages = askImages.filter((i) => i.box !== key); text.value = ''; convoFold.delete(key); boxDrafts.delete(`${sub?.id || ''}|${key}`);
        renderDetail();
      };
      wireAskImages(box);
    });
    dialog.querySelectorAll('[data-option]').forEach((b) => b.onclick = () => { optionPick = { id: job.replan.proposal.id, i: +b.dataset.option }; renderDetail(); });
    // Only the popup's own button sends its words: plain Retry sends none.
    const retry = (b, note) => { if (pressBusy(b)) action('retry', { subJobId: sub?.error ? sub.id : undefined, ...only({ note }) }); };
    bind('#job-retry', (e) => retry(e.currentTarget, dialog.querySelector('[data-retry-note]')?.value.replace(/\s+/g, ' ').trim()));
    // Echoes the head and fingerprint of the list being read, so a refusal the
    // runner has replaced since is refused by the server instead of discarded unseen.
    bind('#job-discard', () => {
      const r = sub.cleanupRefusal;
      show(`<span class="jobs-kicker">${esc(job.title)}</span><h2>Discard ${esc(sub.title)}’s worktree?</h2><form id="job-discard-form">${r.cause === 'unremovable' ? `<p>This deletes the folder <code>${esc(tildify(r.path || sub.worktree?.path || ''))}</code> with everything in it, deletes the local branch <code>${esc(r.branch)}</code> and tells git the worktree is gone. Nothing in the folder can be listed first, and it is lost for good.</p>${r.commitCount ? lossHtml({ ...r, cause: null }) : ''}<p class="job-authority">Cleanup checks the branch again just before deleting: if it has moved, nothing is deleted and you are shown it again.</p>`
        : `<p>This force-removes <code>${esc(tildify(r.path || sub.worktree?.path || ''))}</code> and deletes the local branch <code>${esc(r.branch)}</code>. This is lost for good, along with any gitignored files in it (build output, a local <code>.env</code>):</p>${lossHtml(r)}<p class="job-authority">Cleanup checks the worktree again just before deleting it: if anything has changed, nothing is deleted and you are shown the new list.</p>`}<div class="job-actions"><button type="button" class="danger" data-discard="1">${r.cause === 'unremovable' ? 'Delete it' : 'Discard anyway'}</button><button type="button" id="job-move-back">Keep it</button></div></form>`);
      dialog.querySelector('[data-discard]').onclick = (e) => { if (pressBusy(e.currentTarget)) action('discard-worktree', { discardHead: r.head, fingerprint: r.fingerprint }); };
      dialog.querySelector('#job-move-back').onclick = () => renderDetail();
    });
    bind('#job-cancel', () => openCancel(job));
    // Edit, Pick another status and Move trigger: the same fields as the plan's
    // editor, sent as one edit-write the server validates against the plan.
    bind('#job-write-edit', () => {
      const failed = sub.state === 'failed' && isJiraWrite(sub) && !!sub.action?.to;
      show(`<span class="jobs-kicker">${esc(job.title)}</span><h2>${failed ? 'Pick another status' : 'Edit the write'}</h2><form id="job-write-form">${writeFieldsHtml({ ...job.plan, subJobs: job.subJobs }, sub, { job })}<p class="job-error" id="job-move-error" hidden></p><div class="job-actions"><button class="primary">Save</button><button type="button" id="job-move-back">Back</button></div></form>`);
      dialog.querySelector('#job-move-back').onclick = () => renderDetail();
      const form = dialog.querySelector('#job-write-form');
      pinSelects(form);
      form.onsubmit = (e) => {
        e.preventDefault();
        const f = readWriteFields(form);
        const problem = writeProblem(writeFromFields({ ...job.plan, subJobs: job.subJobs }, sub, f));
        if (problem) { const err = dialog.querySelector('#job-move-error'); err.textContent = problem; err.hidden = false; return; }
        if (!pressBusy(submitterOf(e))) return;
        action('edit-write', { write: writeEditPayload(sub, f) });
      };
    });
    bind('#job-session', () => { dialog.close(); onSession(sub.sessions.at(-1)); });
    dialog.querySelectorAll('[data-step-session]').forEach((b) => b.onclick = () => { dialog.close(); onSession(b.dataset.stepSession); });
    // Reviewing the code is a round trip out to the board's diff panel, so hand over
    // where the reader came FROM as well as what to show — index.js re-opens this
    // same detail via openDetail once the panel closes. Every run of a sub-job
    // shares its worktree (later phases adopt it), so any of its cards shows the
    // same diff: the latest one already on the board, because opening an archived
    // card resumes its agent just to read a diff; else the latest.
    bind('#job-diff', () => { dialog.close(); onDiff(sub.sessions.findLast(onBoard) || sub.sessions.at(-1), { jobId: job.id, subId: sub.id }); });
    // The IDE opens beside the board rather than instead of it, so the dialog
    // stays: approving is still done here once the code has been read.
    bind('#job-ide', () => { openMore.delete('review-menu'); const m = dialog.querySelector('.job-split-more'); if (m) m.open = false; send({ type: 'job-open-ide', id: job.id, subJobId: sub.id }); });
    bind('[data-details-toggle]', (e) => {
      const open = !openMore.has('details'), body = dialog.querySelector('.job-details-body');
      if (open) openMore.add('details'); else openMore.delete('details');
      e.currentTarget.setAttribute('aria-expanded', String(open)); if (body) body.hidden = !open;
    });
  }
  // An empty optional field is left OUT of the payload rather than sent as '': the
  // schemas treat a present empty string as a value, and a blank note would clear
  // nothing but occupy the card.
  const only = (fields) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v != null));
  function createJob() {
    selected = null; planDraft = null;
    picker?.dispose(); picker = null;
    const agents = getAgents();
    const tasks = getTasks().filter((t) => !t.archived && !t.archivedAt);
    const toggle = (name, label, consequence, checked) => `<label class="job-toggle"><span${consequence ? ` title="${consequence}"` : ''}>${label}</span><input type="checkbox" class="job-switch" name="${name}" ${checked ? 'checked' : ''}></label>`;
    show(`<form id="job-create-form" class="job-create">
      <div class="job-create-brief"><h2>New idea</h2><div class="job-outcome"><label>Idea<textarea name="intent" required rows="8" maxlength="16000" placeholder="What should exist that doesn’t yet?"></textarea></label>${imagesPanelHtml()}</div><fieldset class="job-prop job-review-grid"><legend>Review checkpoints</legend><div class="job-review-tiles">${reviewPointsHtml(reviewDefaultsOf(data.settings))}</div></fieldset></div>
      <aside class="job-create-props"><fieldset class="job-prop"><legend>Task</legend><select name="taskId" aria-label="Task"><option value="">Unassigned</option>${tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}<option value="__new__">＋ New task</option></select><input name="newTaskName" maxlength="180" placeholder="New task name" aria-label="New task name" hidden></fieldset><fieldset class="job-prop job-pick" id="job-pick"><legend>Agent</legend></fieldset><input type="hidden" name="agent"><input type="hidden" name="model"><input type="hidden" name="effort"><fieldset class="job-prop job-sandbox" id="job-sandbox"></fieldset><fieldset class="job-prop" id="job-share-images" hidden><legend>Images</legend>${toggle('shareImages', 'Share with sub-jobs', 'every session on the job sees them, not just planning', true)}</fieldset></aside>
      <footer class="job-create-foot"><div class="job-actions"><button class="primary" name="destination" value="start">Start planning</button><button name="destination" value="backlog">Add to backlog</button></div></footer></form>`);
    const form = dialog.querySelector('form');
    let images;
    images = createJobImages({
      root: form.querySelector('.job-outcome'), input: form.elements.intent,
      attach: form.querySelector('.job-images-attach'), fileInput: form.querySelector('.job-images-panel input[type=file]'),
      stage: (blob) => stageImage(blob),
      onChange: () => {
        if (!images) return;
        const busy = images.busy();
        form.querySelector('#job-share-images').hidden = !images.names().length && !busy;
        // A pressed Start planning holds both buttons until the job lands; an upload must not free them.
        const foot = form.querySelectorAll('.job-create-foot button');
        if (![...foot].some(isBusy)) foot.forEach((b) => { b.disabled = busy; b.title = busy ? 'Waiting for images to finish uploading' : ''; });
      },
    });
    dialog.addEventListener('close', () => images.dispose(), { once: true });
    // Before the picker: its first onChange, at mount, tells the sandbox which agent it is for.
    const sandbox = mountSandbox(form.querySelector('#job-sandbox'));
    // Hidden agent/model/effort keep form.onsubmit and the job-create payload as they were.
    picker = mountModelPicker(form.querySelector('#job-pick'), {
      agents, usual: data.settings.usualPick, cover: form,
      onChange: (pick) => { for (const k of ['agent', 'model', 'effort']) form.elements[k].value = pick[k]; sandbox.setAgent(pick.agent); },
    });
    dialog.addEventListener('close', () => { picker?.dispose(); picker = null; }, { once: true });
    form.elements.taskId.onchange = () => {
      const creating = form.elements.taskId.value === '__new__';
      form.elements.newTaskName.hidden = !creating;
      form.elements.newTaskName.required = creating;
    };
    bindReviewPoints(form);
    form.onsubmit = (e) => {
      e.preventDefault(); if (images.busy()) return;
      if (!pressBusy(submitterOf(e), { also: form.querySelectorAll('.job-create-foot button') })) return;
      const values = new FormData(form);
      const taskId = values.get('taskId');
      // Enter and the primary button both start planning; only the grey button parks it.
      send({ type: 'job-create', idea: true, start: e.submitter?.value !== 'backlog', ...only({ newTaskName: taskId === '__new__' ? String(values.get('newTaskName')).trim() : '' }), job: { intent: values.get('intent'), agent: values.get('agent'), model: values.get('model') || '', effort: values.get('effort') || '', ...reviewFlagsOf(values), ...sandbox.value(), images: images.names(), shareImages: values.has('shareImages'), taskId: taskId && taskId !== '__new__' ? taskId : null } });
      const usualPick = { agent: String(values.get('agent')), model: String(values.get('model')), effort: String(values.get('effort')) };
      if (usualPick.agent && usualPick.model) send({ type: 'job-settings', patch: { usualPick } });
    };
  }
  q('#job-new').onclick = createJob;
  q('#jobs-concurrency').onchange = (e) => send({ type: 'job-settings', patch: { concurrency: Number(e.target.value) } });
  q('#jobs-pause').onclick = () => send({ type: 'job-settings', patch: { paused: !data.settings.paused } });
  q('.jobs-rail').onclick = (e) => { const b = e.target.closest('[data-filter]'); if (b) { filter = b.dataset.filter; render(); } };
  // A plate's stub does what it names (Merge, Answer, approve or skip a draft) or opens what has to be read first; a node opens its sub-job, the title the job.
  function runAsk(jobId, subId, act, session) {
    const job = data.jobs.find((j) => j.id === jobId);
    const sub = job?.subJobs.find((s) => s.id === subId);
    if (!job) return;
    if (act === 'merge' && sub) return send({ type: 'job-action', id: job.id, subJobId: sub.id, action: 'approve-merge', head: sub.pr?.head, ...(sub.ready ? { readyReceiptId: sub.ready.receiptId } : {}) });
    if (act === 'session' && session) return onSession(session);
    if (['approve-write', 'skip-write'].includes(act) && sub) return send({ type: 'job-action', id: job.id, subJobId: sub.id, action: act });
    openDetail(job.id, subId);
  }
  // A plate's place chip opens its writes here, fixed over the board: the plate clips
  // overflow. Outside #jobs-boards, so a tick's redraw leaves it be.
  const placePop = document.createElement('div');
  placePop.className = 'job-plate-pop'; placePop.hidden = true; placePop.setAttribute('role', 'menu');
  root.append(placePop);
  let popFor = null;
  const closePlacePop = () => { placePop.hidden = true; popFor?.setAttribute('aria-expanded', 'false'); popFor = null; };
  function openPlacePop(chip) {
    const job = data.jobs.find((j) => j.id === chip.dataset.placeJob);
    const same = popFor?.dataset.placeJob === chip.dataset.placeJob && popFor?.dataset.place === chip.dataset.place;
    closePlacePop();
    if (!job || same) return;
    placePop.innerHTML = placePopHtml(job, Number(chip.dataset.place));
    placePop.hidden = false; popFor = chip; chip.setAttribute('aria-expanded', 'true');
    const r = chip.getBoundingClientRect(), w = placePop.offsetWidth, h = placePop.offsetHeight;
    placePop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
    placePop.style.top = `${r.bottom + 6 + h > innerHeight - 12 ? Math.max(12, r.top - 6 - h) : r.bottom + 6}px`;
  }
  placePop.onclick = (e) => { const row = e.target.closest('[data-sub]'); if (row) { closePlacePop(); openDetail(row.dataset.job, row.dataset.sub); } };
  // Capture phase: the board's own handlers stop some clicks and keys from bubbling.
  // A split button's popup closes the same way, and forgets its key so a tick leaves it shut.
  document.addEventListener('click', (e) => {
    if (!placePop.hidden && !placePop.contains(e.target) && !e.target.closest?.('[data-place]')) closePlacePop();
    dialog.querySelectorAll('.job-split-more[open]').forEach((d) => { if (!d.contains(e.target)) { d.open = false; openMore.delete(d.dataset.keep); } });
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !placePop.hidden) closePlacePop(); }, true);
  q('#jobs-boards').onclick = (e) => {
    const chip = e.target.closest('[data-place]'); if (chip) return openPlacePop(chip);
    const go = e.target.closest('[data-ask]');
    // One click per decision: a sent one holds the stub busy until the next tick redraws it.
    if (go) { if (askActs(go.dataset.ask)) { if (!pressBusy(go, { also: go.parentElement.querySelectorAll('button') })) return; boardHtml = null; } return runAsk(go.dataset.job, go.dataset.sub, go.dataset.ask, go.dataset.session); }
    const el = e.target.closest('[data-job]'); if (el) return openDetail(el.getAttribute('data-job'), el.getAttribute('data-sub'));
    // Anywhere else on a plate (the sky, the gaps between chips) opens the job, as the title does.
    const plate = e.target.closest('.job-plate'); if (plate && !e.target.closest('a,button')) openDetail(plate.dataset.board, '');
  };
  // A plate's right-click menu (job-menu.js), mounted outside #jobs-boards so a
  // tick's redraw leaves it be; a pick reads the job as it is now, not as it was.
  let closeMenu = null;
  function copyText(text, done) {
    const p = globalThis.navigator?.clipboard?.writeText?.(text);
    if (!p) return toastError('Clipboard unavailable');
    p.then(() => toast(done), () => toastError('Could not copy to clipboard'));
  }
  function pickMenu(jobId, item) {
    const job = data.jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (item.id === 'open') return openDetail(job.id, '');
    if (item.id === 'copy-ref') return copyText(jobReference(job), 'Copied job reference');
    if (item.id === 'copy-id') return copyText(job.id, 'Copied job ID');
    if (item.id === 'link') return void globalThis.open?.(item.href, '_blank', 'noopener');
    if (['start', 'pause', 'resume'].includes(item.id)) return send({ type: 'job-action', id: job.id, action: item.id });
    if (item.id === 'cancel') { selected = null; planDraft = null; return openCancel(job, () => dialog.close()); }
  }
  q('#jobs-boards').oncontextmenu = (e) => {
    const plate = e.target.closest('.job-plate');
    const job = plate && data.jobs.find((j) => j.id === plate.dataset.board);
    if (!job) return;
    e.preventDefault();
    closeMenu?.(); closePlacePop();
    // The keyboard's menu key fires at (0, 0): open it under the plate's title instead.
    const at = e.clientX || e.clientY ? [e.clientX, e.clientY] : (() => { const r = plate.querySelector('.job-plate-open')?.getBoundingClientRect() || plate.getBoundingClientRect(); return [r.left, r.bottom]; })();
    closeMenu = mountJobMenu(root, jobMenuItems(job), at[0], at[1], (item) => pickMenu(job.id, item));
  };
  q('#jobs-boards').onkeydown = (e) => {
    const node = e.target.closest?.('g[data-job]');
    if (!node || !['Enter', ' '].includes(e.key)) return;
    e.preventDefault(); openDetail(node.getAttribute('data-job'), node.getAttribute('data-sub'));
  };
  q('#jobs-intro-open').onclick = () => onIntro();
  // The last tab lives in the client api's per-viewer storage (null in a test).
  const settingsTab = () => { try { return storage?.get(SETTINGS_TAB_KEY) || 'general'; } catch { return 'general'; } };
  q('#jobs-settings').onclick = () => {
    selected = null; planDraft = null;
    const tab = settingsTab();
    const section = (title, body, note = '') => `<section class="job-settings-section"><h3>${title}</h3>${note ? `<p>${note}</p>` : ''}${body}</section>`;
    const panels = {
      general: section('Editor', `<label title="A macOS application name — IntelliJ IDEA, Visual Studio Code, Rider…">IDE<input name="ideApp" required maxlength="120" value="${esc(ideApp())}"></label>`, 'Review code’s “In IDE” opens a step’s worktree in this app.')
        + section('Local checkout', '<label class="job-toggle job-settings-main" title="Once a PR lands on the default branch, fast-forward your own checkout of it. A checkout with work of its own is left alone and the job tells you, with fixes an agent can make.">Keep local main updated<input type="checkbox" class="job-switch" name="updateMain" ' + (data.settings.updateMain === false ? '' : 'checked') + '></label>'),
      automation: section('Repairs and replans', `<label title="How many times a failing PR goes back to work to fix its checks. Merge conflicts are synced separately and never count.">Fixes for failing checks per PR<input type="number" name="maxRepairs" min="0" max="5" required value="${data.settings.maxRepairs}"></label><label title="Red steps set to “Wrangler replans” (or “You decide”) go to Wrangler this many times. 0 leaves every red step to you.">Replans per red step<input type="number" name="maxReplans" min="0" max="5" required value="${data.settings.maxReplans ?? 2}"></label>`, 'These limits apply across all jobs.')
        + section('Spend', `<label title="Dollars, cents allowed, $100 unless you change it. Empty for no limit. A job that reaches it is paused and its working sessions interrupted, until you add this much again on the job.">Job spend limit ($)<input type="number" name="spendLimit" min="0.01" max="100000" step="0.01" placeholder="No limit" value="${data.settings.spendLimit === undefined ? DEFAULT_SPEND_LIMIT : data.settings.spendLimit ?? ''}"></label>`, 'Each job may spend this much, plus this much again for every time you top it up. A new figure applies to jobs already running.')
        + section('Deployments', `<label>Deploy wait (min)<input type="number" name="deploymentStaleMinutes" min="5" max="1440" required value="${data.settings.deploymentStaleMinutes ?? 30}"></label>`, 'How long a merge may go without any deployment run before the job asks you.'),
      review: `<fieldset class="job-prop job-settings-review"><legend>Defaults for new jobs</legend>${reviewPointsHtml(reviewDefaultsOf(data.settings), { warn: true })}</fieldset>`,
      appearance: '<fieldset class="job-prop job-settings-theme" id="job-theme-pick"><legend>Theme</legend></fieldset>',
      updates: whatsNewHtml(updates?.list() || []),
    };
    show(`<h2>Automation settings</h2>${tabsHtml('job-settings', SETTINGS_TABS, tab)}<form id="job-settings-form">${SETTINGS_TABS.map((t) => panelHtml('job-settings', t.id, tab, panels[t.id])).join('')}<div class="job-actions"><button class="primary" title="Saves every tab. Waiting for pipelines, dependencies and reviews uses no agent slots. Pause prevents new steps; sessions already working finish their current step.">Save settings</button><button type="button" id="job-settings-intro">${ICONS.info}How Jobs works</button></div></form>`);
    bindTabs(dialog, { onSelect: (id) => { try { storage?.set(SETTINGS_TAB_KEY, id); } catch {} } });
    const settingsForm = dialog.querySelector('form'); bindReviewPoints(settingsForm);
    themePicker?.dispose();
    themePicker = mountThemePicker(dialog.querySelector('#job-theme-pick'), {
      themes: THEMES, value: themeOf(data.settings).id,
      optionsOf: (t) => optionsOf(data.settings, t),
      onChange: (id) => { const from = themeOf(data.settings).id; saveSettings({ theme: id }); onThemeChoice({ id, from }); },
      // Sent whole: settings(patch) merges shallowly, and each theme keeps its own.
      onOption: (t, key, v) => saveSettings({ themeOptions: { ...data.settings.themeOptions, [t.id]: { ...optionsOf(data.settings, t), [key]: v } } }),
    });
    dialog.addEventListener('close', () => { themePicker?.dispose(); themePicker = null; }, { once: true });
    settingsForm.onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); send({ type: 'job-settings', patch: { maxRepairs: +f.get('maxRepairs'), maxReplans: +f.get('maxReplans'), deploymentStaleMinutes: +f.get('deploymentStaleMinutes'), spendLimit: f.get('spendLimit') === '' ? null : +f.get('spendLimit'), ideApp: String(f.get('ideApp')).trim(), updateMain: f.has('updateMain'), reviewDefaults: reviewFlagsOf(f) } }); dialog.close(); };
    dialog.querySelector('#job-settings-intro').onclick = () => { dialog.close(); onIntro(); };
    dialog.querySelector('.update-section').onclick = (e) => { const b = e.target.closest('[data-update-id]'); if (b) { dialog.close(); updates.open(b.dataset.updateId); } };
  };
  dialog.addEventListener('keydown', (e) => {
    // A chat box is not a form: Enter in its textarea, or the chord anywhere in
    // it, is its Send. Plain Enter on its attach or Send button stays theirs.
    const box = e.target.closest?.('.job-change');
    if (box && isChatSendKey(e) && (e.target.matches?.('textarea') || isPrimaryActionKey(e))) { e.preventDefault(); box.querySelector('[data-change-send],[data-idea-send]').click(); return; }
    if (!isPrimaryActionKey(e)) return;
    const run = primaryAction(dialog);
    if (!run) return;
    e.preventDefault();
    run();
  });
  dialog.addEventListener('close', () => { shotZoom?.close(); releaseSkies(dialog); ideaEdit = null; ideaSent = null; ideaFiring = null; ideaSeen = null; selected = null; planDraft = null; proofView = null; askDraft = null; replyTo.clear(); boxDrafts.clear(); clearAskImages(); clearAskSent(); commentsShown.clear(); openDeps.clear(); openShow.clear(); openTickets.clear(); openMore.clear(); resetFlags(); });
  render();
  // openDetail is exposed for the return leg of the diff round trip only — it opens
  // the same dialog a board card's click does, from a job/sub id pair index.js kept.
  // newJob is the intro's last button.
  // A refused switch snaps back and the hint says why.
  function reviewFailed(msg) {
    if (msg.jobId !== flags.jobId || !flags.pending) return;
    const cp = checkpoint(msg.field || flags.pending.field);
    const job = data.jobs.find((j) => j.id === flags.jobId);
    flags.pending = null;
    flags.note = { field: cp.field, head: job ? checkpointLabel(cp, youReview(job, cp.field)) : cp.name, body: msg.error, undo: false };
    paintFooter();
  }
  // A confirmed launch acts only once its flare and green have played: the last one closes onto the board.
  function ideaSettled(jobId) {
    if (!ideaFiring.own) { ideaFiring = null; if (dialog.open && selected?.jobId === jobId) renderDetail(); return; }
    if (dialog.open && selected?.jobId === jobId) dialog.close();
  }
  // A refused idea goes back in its box, with why, so nothing typed is lost.
  // A refused reply goes back in the box; a refused launch stops flaring and the toast says why.
  function ideaFailed(msg) {
    if (msg.action === 'idea-reply' && ideaSent?.jobId === msg.jobId && ideaSent.state === 'sending') {
      const text = ideaSent.text; ideaSent = null;
      if (dialog.open && selected?.jobId === msg.jobId) { renderDetail(); const box = dialog.querySelector('[data-idea-composer] textarea'); if (box && !box.value) { box.value = text; box.dispatchEvent(new box.ownerDocument.defaultView.Event('input')); } }
      return false;
    }
    if (msg.action === 'accept-idea' && ideaFiring?.jobId === msg.jobId) { ideaFiring = null; if (dialog.open && selected?.jobId === msg.jobId) renderDetail(); }
    return false;
  }
  function changeFailed(msg) {
    if (askSent?.state !== 'sending' || msg.jobId !== askSent.jobId || (msg.subJobId ?? null) !== askSent.subId) return false;
    // The pictures go back in the tray with the words: the bubble lets go of them.
    // A conversation gone meanwhile (dismissed, or pruned) cannot take them: a new one does.
    const job = data.jobs.find((j) => j.id === askSent.jobId);
    if (askSent.convo && !(job && convoGroups(job, job.subJobs.find((s) => s.id === askSent.subId) || null).some((g) => g.convo?.id === askSent.convo))) askSent.convo = '';
    const items = (askSent.items || []).map((i) => ({ ...i, box: askSent.convo || '' }));
    askImages = [...items, ...askImages];
    Object.assign(askSent, { state: 'failed', error: msg.error, hadImages: items.length > 0, items: [], images: [] }); askDraft = { subId: askSent.subId ?? undefined, convo: askSent.convo, text: askSent.text };
    replyTo.set(askSent.subId || '', askSent.convo || '');
    if (dialog.open) renderDetail();
    askDraft = null;
    return true;
  }
  return { update, newJob: createJob, reviewFailed, changeFailed, ideaFailed, idea: idea.message, runningLog: (msg) => { if (msg.subJobId && msg.name) { runLogs.set(msg.subJobId, { name: msg.name, text: msg.text, truncated: msg.truncated, error: msg.error }); if (dialog.open && selected?.subId === msg.subJobId) renderDetail(); } }, evidence: (msg) => { evidence.note(msg); hydrateEvidence(root, evidence, send); if (proofView && dialog.open) renderDetail(); else hydrateEvidence(dialog, evidence, send); if (shotZoom && !shotZoom.querySelector('.job-proof-full:not(.soft)')) paintShotBox(); }, images: (msg) => { for (const i of msg.images || []) imageCache.set(i.name, i); hydrateStrips(); }, created: (msg) => {
    // A checkpoint switch keeps the dialog: the footer is where it was made.
    if (msg?.action === 'set-review') {
      if (msg.jobId === flags.jobId) { flags.pending = null; paintFooter(); }
      return;
    }
    // A saved idea stays open, back on its words: the rebuild before this frame already carries them.
    if (msg?.action === 'edit-idea') { if (msg.jobId === selected?.jobId) { ideaEdit = null; if (dialog.open) renderDetail(); } return; }
    // A Retry's, a fix's or a dismissal's outcome lands on a later tick, in the dialog it was pressed in.
    if (['retry-main', 'dismiss-main', 'resolve-main', 'dismiss-convo'].includes(msg?.action)) return;
    // A New idea that is planning opens on its conversation once the snapshot has it.
    if (msg?.event === 'job-created' && msg.idea && msg.started) { openOnCreate = msg.jobId; if (data.jobs.some((j) => j.id === msg.jobId)) { openOnCreate = null; openDetail(msg.jobId); } return; }
    // A reply stays in its conversation for the next tick. A created job closes the dialog it was pressed in,
    // so the board's forming animation plays in view; one the human has since navigated away from is left alone.
    if (msg?.action === 'idea-reply') { if (ideaSent?.jobId === msg.jobId) ideaSent.state = 'sent'; return; }
    if (msg?.action === 'accept-idea') {
      if (ideaFiring?.jobId !== msg.jobId) return;
      ideaFiring.confirmed = true;
      if (ideaFiring.shown) ideaSettled(msg.jobId);
      return;
    }
    // An idea stays on screen as its bubble: the tick is the confirmation, not a closed dialog.
    if (msg?.action === 'request-change' && askSent?.state === 'sending' && msg.jobId === askSent.jobId && (msg.subJobId ?? null) === askSent.subId) { askSent.state = 'sent'; askSent.at = Date.now(); if (!askSent.convo) replyTo.delete(askSent.subId || ''); if (dialog.open) renderDetail(); return; }
    if (dialog.querySelector('#job-human-form') && !(msg?.event === 'job-action-complete' && msg.action === 'finish-human' && msg.jobId === selected?.jobId && msg.subJobId === selected?.subId)) return;
    dialog.close();
  }, openDetail };
}
