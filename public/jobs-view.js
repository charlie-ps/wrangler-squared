import { esc, tildify } from './util.js';
import { ICONS } from './icons.js';
import { reviewCode, codeAwaitingReview, jobCostLabel, JOB_COST_TITLE, SUB_COST_TITLE, storyLabel, isSessionSub, isHumanSub, isPrSub, hasSessionSubs, kindChipHtml, kindLabel, KIND_TITLE, kindClass, dependencySatisfied, jobCards, jobNeedsReview, jobStatus, receiptHtml, cancelledDependencies, commentVerdict, redComments, mergeHeldByComments, deploymentStalled, COMMENT_TONE_LABEL, deploysLine, eventFor, movesFor, moveById, moveCopy, markOptions, prNumber, runStatus } from './jobs.js';
import { planGraphHtml, layoutGraphEdges, dependencyEditorHtml, jobTileHtml } from './job-graph.js';
import { STATES, stateIconHtml, subState, subLabel, subLine, jobState, jobLabel, leadSub, sortJobs } from './job-state.js';
const checkTone = (state) => ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'passing'].includes(state) ? 'passed' : ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'failing'].includes(state) ? 'failed' : '';
const checkMark = (state) => checkTone(state) === 'passed' ? '✓' : checkTone(state) === 'failed' ? '×' : '○';
const link = (url, title) => /^https:\/\/github\.com\//.test(url || '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>` : esc(title);
const commentWhere = (c) => c.kind === 'review' ? `review · ${c.state.toLowerCase().replace('_', ' ')}` : c.kind === 'thread' ? `${c.path || 'thread'}${c.line != null ? `:${c.line}` : ''}${c.outdated ? ' · outdated' : ''}${c.resolved ? ' · resolved' : ''}` : 'comment';
// An assist chip: a glyph and a few words, the sentence behind them in its tooltip.
const chip = (icon, text, { cls = '', title = '' } = {}) => `<span class="job-chip ${cls}"${title ? ` title="${esc(title)}"` : ''}>${icon}${text ? `<span>${esc(text)}</span>` : ''}</span>`;
// The state chip carries every explanatory sentence the step has, so they cost a
// hover rather than a paragraph; the info glyph says there is something to read.
const stateChip = (state, text, hints = []) => `<span class="job-chip job-chip-state tone-${STATES[state].tone}"${hints.length ? ` title="${esc(hints.join('\n\n'))}"` : ''}>${stateIconHtml(state)}<span>${esc(text)}</span>${hints.length ? ICONS.info : ''}</span>`;
const flag = (on, icon, onText, offText) => `<span class="job-flag ${on ? 'on' : 'off'}" role="img" aria-label="${esc(on ? onText : offText)}" title="${esc(on ? onText : offText)}">${icon}</span>`;
const flagsHtml = (job) => flag(reviewCode(job), ICONS.code, 'Code review: you read each PR’s diff before it is committed', 'No code review: work is committed without a read')
  + flag(job.reviewMerge, ICONS.merge, 'Manual merge: you approve each green PR', 'Automatic merge: green PRs merge on their own')
  + (hasSessionSubs(job) ? flag(job.reviewSessions ?? true, ICONS.robot, 'Session review on: you approve each agent session’s result', 'Sessions auto-complete once they report') : '');
const mergeApprovable = (job, sub) => sub.stage === 'pr' && sub.pr?.checkStatus === 'passing' && (job.reviewMerge || redComments(sub)) && sub.mergeApprovedHead !== sub.pr.head;
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
const when = (at) => at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
const staleHint = (sub) => deploymentStalled(sub) ? `No GitHub Actions run has started for merge commit ${(sub.pr?.mergeCommit || '').slice(0, 8)} in ${minutesSince(sub.deploymentStale.since)} min. If this repository does not deploy for these paths, Mark position: done. Wrangler keeps polling in case a run appears.` : '';
// What happened and what the agent suggested, in the danger register: the one box
// a human reads before choosing a move. Title, detail and the suggestion are all
// agent- or observation-written, so every one of them is escaped.
function eventHtml(job, sub) {
  const ev = eventFor(job, sub);
  if (!ev) return '';
  // A suggestion is agent-written, so a name that is not one of the moves is
  // simply not named rather than rendered as an unknown move.
  const suggested = ev.suggested && moveById(ev.suggested);
  const move = suggested ? moveCopy(job, sub, suggested) : null;
  return `<div class="job-event">${ICONS.x}<div><b>${esc(ev.title)}</b><p>${esc(ev.detail)}</p>${move ? `<span class="job-event-move">Suggests ${esc(move.label)}</span>` : ''}</div></div>`;
}
// One sub-job's prerequisites as small chips: met, dropped, or still holding it.
function depsHtml(job, sub) {
  const deps = sub.after.map((id) => job.subJobs.find((s) => s.id === id));
  if (!deps.length) return '';
  return `<div class="job-dependency-list">${deps.map((d) => {
    const [icon, tone] = dependencySatisfied(d) ? [ICONS.check, 'ok'] : d?.cancelledAt ? [ICONS.x, 'bad'] : [ICONS.lock, 'idle'];
    return chip(icon, d?.title, { cls: `tone-${tone}`, title: `${isPrSub(sub) ? 'Start after' : 'After'} ${d?.title}${isPrSub(d) ? ' deploys' : ''}${d?.cancelledAt ? ' (dropped)' : ''}` });
  }).join('')}</div>`;
}

// The board's own Cmd/Ctrl+Enter handlers only reach the elements they own, and
// this dialog hangs off <body> outside every one of them, so the chord is matched
// again here to the same rule: plain Cmd or Ctrl, inert once alt or shift is held.
export const isPrimaryActionKey = (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.altKey && !e.shiftKey;
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

export function initJobsView({ send, getAgents, getTasks = () => [], onSession, onDiff, onBoard }) {
  const root = document.getElementById('jobs');
  const dialog = document.getElementById('job-dialog');
  let data = { jobs: [], settings: { concurrency: 2, maxRepairs: 2, deploymentStaleMinutes: 30 } };
  let filter = '', needsOnly = false, showDone = false, selected = null, planDraft = null, revision = null;
  const commentsShown = new Set();
  // Which folded sections the human has opened: the detail is rebuilt on every
  // graph tick, so the open state has to outlive the markup.
  const openMore = new Set();
  // Snapshots written before the setting existed carry no `ideApp`.
  const ideApp = () => data.settings.ideApp || 'IntelliJ IDEA';
  // Which nodes in the plan stepper have their dependency editor open: a
  // dependency change redraws the whole stepper (the node moves wave), so the
  // open state has to outlive the markup or the editor snaps shut under the pointer.
  const openDeps = new Set();
  root.innerHTML = `<header class="jobs-header"><h1>Jobs</h1>
    <div class="jobs-filters"><select id="jobs-filter" aria-label="Show one job"><option value="">Every job</option></select><label class="jobs-chip jobs-chip-needs" title="Only jobs waiting on you"><input id="jobs-needs" type="checkbox">${ICONS.eye}Needs me <span id="jobs-review-count">0</span></label><label class="jobs-chip" title="Include delivered and cancelled jobs"><input id="jobs-done" type="checkbox">${ICONS.check}Finished</label></div>
    <div class="jobs-toolbar"><span id="jobs-active-count" aria-live="polite"></span><label class="jobs-chip" title="Agents at once. Waiting for pipelines, dependencies and reviews uses none.">${ICONS.robot}<input id="jobs-concurrency" type="number" min="1" max="16" value="2" aria-label="Agents at once"></label><button id="jobs-pause" class="jobs-icon"></button><button id="jobs-settings" class="jobs-icon" title="Automation settings" aria-label="Automation settings">${ICONS.gear}</button><button class="primary" id="job-new">${ICONS.plus}New job</button></div></header>
    <div id="jobs-boards" class="jobs-grid"></div>`;
  const q = (s) => root.querySelector(s);
  function update(snapshot) { data = snapshot || data; render(); }
  function render() {
    const cards = jobCards(data.jobs);
    const needs = new Set(cards.filter((c) => jobNeedsReview(c.job, c.sub)).map((c) => c.job));
    const active = data.jobs.flatMap((j) => j.runs).filter((r) => !r.stopped).length;
    q('#jobs-active-count').textContent = `${active} / ${data.settings.concurrency} agents · ${cards.filter((c) => c.sub?.stage === 'done' && !c.sub.cancelledAt).length} delivered`;
    q('#jobs-review-count').textContent = cards.filter((c) => jobNeedsReview(c.job, c.sub)).length;
    if (document.activeElement !== q('#jobs-concurrency')) q('#jobs-concurrency').value = data.settings.concurrency;
    const paused = !!data.settings.paused;
    const pause = q('#jobs-pause');
    pause.innerHTML = paused ? `${ICONS.play}<span>Paused</span>` : ICONS.pause;
    pause.title = paused ? 'Resume automation' : 'Pause new work';
    pause.setAttribute('aria-label', pause.title);
    pause.classList.toggle('paused', paused);
    q('#jobs-filter').innerHTML = `<option value="">Every job</option>${data.jobs.map((j) => `<option value="${esc(j.id)}" ${filter === j.id ? 'selected' : ''}>${esc(j.title)}</option>`).join('')}`;
    // A finished (delivered or cancelled) job only returns with Finished.
    const jobs = sortJobs(data.jobs.filter((j) => (!filter || j.id === filter) && (!needsOnly || needs.has(j)) && (showDone || j.stage !== 'done')));
    const empty = !data.jobs.length ? 'Start with an outcome.<br>Wrangler will shape the work.' : needsOnly ? 'Nothing needs you right now.' : 'No jobs match these filters.';
    q('#jobs-boards').innerHTML = jobs.map(jobTileHtml).join('') || `<div class="job-empty jobs-empty">${empty}</div>`;
    // Keep a human's plan edits and review snapshot intact across live graph ticks;
    // any open form (feedback, a move) is a human mid-edit and is left alone.
    const humanForm = dialog.querySelector('#job-human-form');
    const currentSub = humanForm && data.jobs.find((j) => j.id === selected?.jobId)?.subJobs.find((s) => s.id === selected?.subId);
    if (dialog.open && selected && !planDraft && (!dialog.querySelector('form') && !dialog.contains(document.activeElement?.closest('input, textarea, select'))
      || humanForm && currentSub && (currentSub.stage !== 'human' || humanForm.dataset.state !== currentSub.state))) {
      const output = humanForm?.elements.output.value;
      renderDetail();
      if (output != null && dialog.querySelector('#job-human-form')) dialog.querySelector('#job-human-form').elements.output.value = output;
    }
  }
  function show(html) {
    dialog.innerHTML = `<button class="job-dialog-close" aria-label="Close" title="Close">${ICONS.x}</button>${html}`;
    dialog.querySelector('.job-dialog-close').onclick = () => dialog.close();
    dialog.querySelectorAll('details[data-keep]').forEach((d) => d.ontoggle = () => { if (d.open) openMore.add(d.dataset.keep); else openMore.delete(d.dataset.keep); });
    if (!dialog.open) dialog.showModal();
  }
  const more = (key, summary, body, cls = '') => `<details class="job-more ${cls}" data-keep="${key}" ${openMore.has(key) ? 'open' : ''}><summary>${summary}</summary>${body}</details>`;
  function action(name, extra = {}, subId = selected.subId) {
    send({ type: 'job-action', id: selected.jobId, subJobId: subId || undefined, action: name, ...extra });
  }
  function openDetail(jobId, subId) {
    selected = { jobId, subId }; planDraft = null; revision = null; commentsShown.clear(); openDeps.clear(); openMore.clear();
    const job = data.jobs.find((j) => j.id === jobId);
    if (!subId && job?.stage === 'planning' && job.plan) { planDraft = structuredClone(job.plan); revision = job.revision; }
    const sub = job?.subJobs.find((s) => s.id === subId);
    // Something went wrong: the moves are the decision, so they start unfolded.
    if (sub && subState(job, sub) === 'failing') openMore.add('moves');
    renderDetail();
  }
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
    graph.querySelectorAll('details[data-deps]').forEach((d) => d.ontoggle = () => { if (d.open) openDeps.add(d.dataset.deps); else openDeps.delete(d.dataset.deps); layoutGraphEdges(graph); });
    // A dependency change can move the node to another wave, so the stepper is
    // redrawn from the draft rather than patched; the changed checkbox keeps focus.
    graph.querySelectorAll('[data-dep]').forEach((e) => e.onchange = () => {
      const s = planDraft.subJobs[+e.dataset.dep]; s.after = e.checked ? [...s.after, e.value] : s.after.filter((d) => d !== e.value);
      graph.outerHTML = planGraphHtml(planDraft, { editable: true, openDeps });
      wireGraph();
      [...dialog.querySelectorAll(`[data-dep="${e.dataset.dep}"]`)].find((c) => c.value === e.value)?.focus();
    });
    observer?.observe(graph.querySelector('.job-graph-canvas'));
    layoutGraphEdges(graph);
  }
  const noteFor = (sub) => sub.note ? `<p class="job-note" title="Note for the next session">${ICONS.note}<span>${esc(sub.note)}</span></p>` : '';
  // What a whole-job cancel did and what it left: the sub-job nodes say Dropped
  // one by one, this is the sentence that says why all of them do.
  const cancelledText = (job) => `Cancelled ${when(job.cancelledAt)}. ${job.stage === 'done' ? 'Every unfinished sub-job was dropped and cleaned up' : 'Every unfinished sub-job was dropped; running steps are being stopped and cleaned up'}. Merged work stays merged, open pull requests stay open on GitHub, and a worktree with unpushed commits is kept for you to look at.`;
  // Confirmed first, like Drop, and wrapped in a form so a live graph tick does not
  // re-render the detail view over the question (render() leaves any open form alone).
  function openCancel(job) {
    const live = job.runs.filter((r) => !r.stopped).length;
    const unfinished = job.subJobs.filter((s) => !['cleanup', 'done'].includes(s.stage)).length;
    const prs = job.subJobs.filter((s) => s.pr && s.stage === 'pr').length;
    const what = job.stage === 'active' ? `This drops the ${unfinished === 1 ? 'one unfinished sub-job' : `${unfinished} unfinished sub-jobs`}${live ? ` and stops the ${live === 1 ? 'running step' : `${live} running steps`}; their receipts are ignored` : ''}. Sub-jobs already delivered stay delivered. ` : `This stops ${live ? 'the running ' : ''}${job.stage === 'jira' ? 'ticketing' : 'planning'}${live ? '' : ' before it starts'}; no tickets or PRs are created. `;
    show(`<span class="jobs-kicker">${esc(job.title)}</span><h2>Cancel this job?</h2><form id="job-cancel-form"><p>${what}${prs ? `${prs === 1 ? 'Its open pull request stays' : `${prs} open pull requests stay`} open on GitHub for you to close. ` : ''}Sessions are archived; each worktree is removed only if its commits are already pushed or the branch is unchanged, and kept otherwise.</p><div class="job-actions"><button type="button" class="danger" data-cancel-job="1">Cancel job</button><button type="button" id="job-move-back">Keep working</button></div></form>`);
    dialog.querySelector('[data-cancel-job]').onclick = () => send({ type: 'job-action', id: job.id, action: 'cancel-job' });
    dialog.querySelector('#job-move-back').onclick = () => renderDetail();
  }
  // One escaped line per move, newest first, with when it was made — the record of
  // every human intervention in a job, kept out of the way until asked for.
  function movesHistoryHtml(job) {
    const list = job.moves || [];
    if (!list.length) return '';
    return more('history', `${ICONS.wrench}Moves <small>${list.length}</small>`, `<ul class="job-move-log">${list.slice().reverse().map((m) => `<li><span>${esc(m.detail || moveById(m.move)?.label || m.move)}</span><small>${esc(when(m.at))}</small></li>`).join('')}</ul>`, 'job-moves-history');
  }
  // The moves a human makes by hand, minus the ones this stage would refuse. Folded
  // behind an overflow until something goes wrong; the suggested one is marked
  // `hot` rather than pre-selected: the agent names a move, the human makes it.
  function movesHtml(job, sub) {
    const list = movesFor(job, sub);
    if (!list.length) return '';
    const suggested = eventFor(job, sub)?.suggested;
    return more('moves', `${ICONS.more}Moves`, `<div class="job-moves">${list.map((m) => `<button type="button" class="job-move ${m.id === suggested ? 'hot' : ''}" data-move="${esc(m.id)}" title="${esc(m.blurb)}"><b>${esc(m.label)}</b></button>`).join('')}</div>`, 'job-overflow');
  }
  const appbar = (title, chips, kicker = '') => `<header class="job-appbar">${kicker}<h2>${esc(title)}</h2><div class="job-chips job-detail-meta">${chips}</div></header>`;
  const costChip = (usd, estimated, title) => { const c = jobCostLabel(usd, estimated); return c ? chip('', c, { cls: 'job-detail-cost', title }) : ''; };
  function storyChips(stories) {
    if (!stories.length) return chip(ICONS.story, 'No ticket', { cls: 'job-chip-quiet', title: 'This work has no Jira ticket' });
    const fresh = stories.filter((s) => !s.key).length;
    return stories.slice(0, 2).map((s) => chip(ICONS.story, storyLabel(s, stories), { title: `${s.title}${s.key ? '' : ' · new Jira story, created only after you approve'}` })).join('')
      + (stories.length > 2 ? chip('', `+${stories.length - 2}`, { title: `${stories.length} stories${fresh ? ` · ${fresh} new` : ''}` }) : '');
  }
  const repoChips = (repos) => repos.length ? repos.map((r) => chip(ICONS.folder, tildify(r).split('/').pop(), { title: tildify(r) })).join('')
    : chip(ICONS.folder, 'Repos', { cls: 'job-chip-quiet', title: 'Wrangler will discover the repositories needed during planning.' });
  const storiesHtml = (stories, editable) => stories.length ? `<div class="job-stories">${stories.map((s, i) => editable
    ? `<label><span class="job-story-key ${s.key ? '' : 'job-story-new'}">${esc(storyLabel(s, stories))}</span><input aria-label="Story title ${i + 1}" data-story="${i}" maxlength="180" value="${esc(s.title)}"></label>`
    : `<div><span class="job-story-key">${esc(storyLabel(s, stories))}</span> ${esc(s.title)}</div>`).join('')}</div>` : '';
  // Everything a plan says in prose, folded into one section: the stepper is the
  // decision, this is the reading behind it.
  function planMoreHtml(job, plan, editable) {
    const briefs = (plan?.subJobs || []).map((s) => `<h5>${kindChipHtml(s)} ${esc(s.title)}</h5><p>${esc(s.brief)}</p>${s.check ? `<p>Check after it lands: ${esc(s.check)}</p>` : ''}`).join('');
    const fresh = (plan?.stories || []).filter((s) => !s.key).length;
    return more('plan', `${ICONS.doc}Plan details`, `${plan?.stories?.length ? `<h4>Stories <small>${fresh ? `${fresh} new · created only after you approve` : 'existing'}</small></h4>${storiesHtml(plan.stories, editable)}` : ''}
      ${plan?.context ? `<h4>Context <small>every session on this job gets it</small></h4><p class="job-context">${esc(plan.context)}</p>` : ''}
      <h4>Outcome</h4><p class="job-intent">${esc(job.intent)}</p>${briefs ? `<h4>What each sub-job is asked to do</h4>${briefs}` : ''}`, 'job-plan-more');
  }
  // The job dialog's one extended button: the single most urgent thing the job is
  // waiting on. A green PR awaiting approval merges from here, pinned to the head
  // on display; anything that needs reading first opens its sub-job instead.
  function leadFab(job) {
    const state = jobState(job);
    const lead = leadSub(job, state);
    if (!lead || !['failing', 'needs'].includes(state)) return '';
    const n = isPrSub(lead) ? prNumber(lead) : '';
    const title = esc(`${lead.title} · ${subLabel(job, lead)}`);
    if (state === 'needs' && mergeApprovable(job, lead)) return `<button class="primary" data-action="approve-merge" data-sub="${esc(lead.id)}" title="${title}">${ICONS.merge}Merge${n ? ` #${n}` : ''}</button>`;
    if (state === 'needs' && runStatus(job, lead) === 'needs-you' && lead.sessions.length) return `<button class="primary" data-fab-session="${esc(lead.sessions.at(-1))}" title="${title}">${ICONS.terminal}Answer prompt</button>`;
    const [icon, text] = state === 'failing' ? [ICONS.wrench, 'Resolve'] : codeAwaitingReview(lead) ? [ICONS.code, 'Review code'] : isSessionSub(lead) ? [ICONS.doc, 'Review result'] : isHumanSub(lead) ? [ICONS.person, 'Open task'] : [ICONS.eye, 'Open'];
    return `<button class="primary" data-open-sub="${esc(lead.id)}" title="${title}">${icon}${text}${n ? ` #${n}` : ''}</button>`;
  }
  function jobDetail(job) {
    const state = jobState(job);
    const live = job.stage === 'active' || job.stage === 'done';
    const plan = planDraft || job.plan;
    const running = job.runs.some((r) => !r.stopped);
    const hints = [job.cancelledAt ? cancelledText(job) : '',
      job.stage === 'backlog' && !job.cancelledAt ? 'Planning proposes Jira story titles without touching Jira. You review the plan before tickets are created or work begins.' : '',
      job.stage === 'jira' ? 'Creating the approved Jira stories. Work starts once every story has a key.' : '',
      job.stage === 'planning' && !job.plan && !job.cancelledAt ? 'Wrangler will bring the plan here for review.' : ''].filter(Boolean);
    const chips = stateChip(state, jobLabel(job), hints) + (plan ? storyChips(plan.stories || []) : repoChips(job.repos)) + costChip(job.usd, job.usdEstimated, `${JOB_COST_TITLE}${job.usdEstimated ? ' · includes an estimate for Codex sessions' : ''}`);
    let body = '', fab = '', extra = '';
    if (planDraft) {
      const sessions = planDraft.subJobs.some(isSessionSub);
      const humans = planDraft.subJobs.some(isHumanSub);
      const newStories = planDraft.stories.filter((s) => !s.key).length;
      const authority = `${newStories ? `Approve creates the ${newStories === 1 ? 'new Jira story' : `${newStories} new Jira stories`} with these titles, then starts` : 'Approve starts'} work in dedicated worktrees. ${reviewCode(job) ? 'You review each PR’s code before it is committed. ' : ''}${job.reviewMerge ? 'You approve each merge.' : 'Green PRs merge automatically.'}${sessions ? ((job.reviewSessions ?? true) ? ' You approve each agent session’s result.' : ' Agent sessions count as done once they report.') : ''}${humans ? ' Nothing starts a human task: you mark it done, and that releases whatever waits on it.' : ''}`;
      body = `${planGraphHtml(planDraft, { editable: true, openDeps })}${planMoreHtml(job, planDraft, true)}`;
      fab = `<button class="primary" data-action="approve-plan" title="${esc(authority)}" ${running ? 'disabled' : ''}>${ICONS.check}Approve ${planDraft.subJobs.length}</button>`;
      extra = `<button id="job-refine">${ICONS.edit}Request changes</button>`;
    } else if (job.stage === 'jira') body = `${planGraphHtml(job.plan)}${planMoreHtml(job, job.plan, false)}`;
    else if (live && !(job.cancelledAt && !job.subJobs.length)) body = `${planGraphHtml({ subJobs: job.subJobs, stories: job.plan?.stories }, { stateOf: (s) => subState(job, s), lineOf: (s) => subLine(job, s) })}${planMoreHtml(job, job.plan, false)}${movesHistoryHtml(job)}`;
    else body = `<p class="job-intent">${esc(job.intent)}</p>`;
    if (job.error) fab = `<button class="primary" id="job-retry">${ICONS.wrench}Retry</button>`;
    else if (job.stage === 'backlog' && !job.cancelledAt) fab = `<button class="primary" data-action="start" title="${esc(hints[0])}">${ICONS.play}Start planning</button>`;
    else if (job.stage === 'active') fab = leadFab(job);
    const tail = job.cancelledAt || job.stage === 'done' ? '' : `<button data-action="${job.paused ? 'resume' : 'pause'}" title="${job.paused ? 'Resume job' : 'Pause new work for this job'}">${job.paused ? `${ICONS.play}Resume` : `${ICONS.pause}Pause`}</button><button class="danger" id="job-cancel">${ICONS.stop}Cancel job</button>`;
    return `${appbar(job.title, chips)}${eventHtml(job, null)}${body}
      <div class="job-actions tone-${STATES[state].tone}">${fab}${extra}${tail}</div><footer class="job-detail-footer">${flagsHtml(job)}</footer>`;
  }
  function subDetail(job, sub) {
    const state = subState(job, sub);
    const status = jobStatus(job, sub);
    const pr = isPrSub(sub);
    const dropped = sub.cancelledAt ? (isHumanSub(sub) ? 'Dropped. Nothing ever ran for it, so there is nothing to clean up.' : isSessionSub(sub) ? 'Dropped. Its session is archived; nothing on disk is removed.' : 'Dropped. Nothing was merged. Cleanup archives its sessions and removes the worktree only if every commit is already on GitHub or the branch is unchanged.') : '';
    const orphan = !sub.cancelledAt && sub.stage !== 'done' && cancelledDependencies(job, sub).length
      ? `A prerequisite was dropped, so this ${isHumanSub(sub) ? 'task’s turn will never come' : isSessionSub(sub) ? 'session can never start' : 'sub-job can never land'}. Drop it too, or add the remaining work with New ticket.` : '';
    const yours = isHumanSub(sub) && sub.stage === 'human';
    const hints = [dropped, orphan,
      isSessionSub(sub) && sub.stage === 'review' ? 'Approving marks the session done and lets the work depending on it start.' : '',
      yours ? `No agent will ever run this one${sub.state === 'doing' ? '; you marked it in progress' : ''}. Marking it done is what releases the work waiting on it.` : '',
      codeAwaitingReview(sub) ? `Nothing is committed yet. Read the diff with Review code in Wrangler — comments there go straight to the session — then approve: a short session commits the working tree as it stands and ${sub.pr ? 'pushes it to the open PR' : 'pushes and opens the PR'}.` : pr && sub.stage === 'review' && !sub.error ? `Approved. A session commits and ${sub.pr ? 'pushes to the open PR' : 'pushes and opens the PR'} next.` : '',
      mergeHeldByComments(job, sub) ? 'Comments read as blocking, so the automatic merge is on hold. Approve merge to override for this head.' : '',
      sub.stage === 'pr' && sub.pr?.mergeWithAdmin ? 'Checks have passed. Merging will override GitHub’s required review.' : '',
      sub.fixRequested ? `Fix requested${sub.fixRequested.note ? `: ${sub.fixRequested.note}` : ''}. A repair session starts on the next tick.` : '',
      staleHint(sub),
      sub.recoveredBy ? `The merged change stays deployed. The fix is a sub-job in this job, ${job.subJobs.find((f) => f.id === sub.recoveredBy)?.title || sub.recoveredBy}; this sub-job counts as deployed once it does.` : ''].filter(Boolean);
    const n = prNumber(sub);
    const deploys = deploysLine(sub);
    const workflows = sub.deploys?.workflows || [];
    const story = job.plan?.stories?.find((s) => s.id === sub.storyId);
    const chips = stateChip(state, status.text, hints)
      + `<span class="job-chip" title="${esc(KIND_TITLE[kindClass(sub)])}">${kindChipHtml(sub)}<span>${kindLabel(sub)}</span></span>`
      + chip(ICONS.story, sub.jiraKey || (sub.storyId ? 'Ticket pending' : 'No ticket'), { title: story?.title || '' })
      + (pr ? chip(ICONS.folder, tildify(sub.repo).split('/').pop(), { title: tildify(sub.repo) }) : '')
      + (sub.worktree?.branch ? chip(ICONS.branch, sub.worktree.branch, { cls: 'job-plan-branch', title: 'Branch' }) : '')
      + (sub.pr ? `<a class="job-chip job-pipeline-status ${checkTone(sub.pr.checkStatus)}" ${/^https:\/\/github\.com\//.test(sub.pr.url || '') ? `href="${esc(sub.pr.url)}" target="_blank" rel="noopener noreferrer"` : ''} title="Pull request · checks ${esc(sub.pr.checkStatus)}${sub.pr.head ? ` · ${esc(sub.pr.head.slice(0, 8))}` : ''}">${ICONS.pr}<span>${n ? `#${esc(n)}` : 'PR'}</span></a>` : '')
      + (deploys ? chip(ICONS.rocket, sub.deploys.expected === false ? 'No deploy' : 'Deploys', { cls: 'job-deploys', title: deploys }) : '')
      + costChip(sub.usd, sub.usdEstimated, `${SUB_COST_TITLE}${jobCostLabel(job.usd, job.usdEstimated) ? ` · job total ${jobCostLabel(job.usd, job.usdEstimated)}` : ''}`);
    const kicker = `<button class="job-back" data-open-job title="Back to the job">${ICONS.back}<span>${esc(job.title)}</span></button>`;
    const session = sub.sessions.length ? `<button id="job-session" ${runStatus(job, sub) === 'needs-you' ? 'class="primary"' : ''}>${ICONS.terminal}${onBoard(sub.sessions.at(-1)) ? 'Open session' : 'Restore session'}</button>` : '';
    const suggested = eventFor(job, sub)?.suggested && movesFor(job, sub).find((m) => m.id === eventFor(job, sub).suggested);
    const retry = sub.error || job.error ? `<button id="job-retry" ${sub.error && !suggested ? 'class="primary"' : ''}>${ICONS.wrench}Retry</button>` : '';
    const fabMove = suggested ? `<button class="primary" data-fab-move="${esc(suggested.id)}" title="${esc(suggested.blurb)}">${ICONS.wrench}${esc(suggested.label)}</button>` : '';
    let body = '', actions = '';
    if (isSessionSub(sub)) {
      body = `${sub.feedback && !sub.result ? `<h3>Requested changes</h3><p>${esc(sub.feedback)}</p>` : ''}${sub.result ? `<h3>Reported</h3>${receiptHtml(sub.result.checks)}` : ''}${noteFor(sub)}`;
      actions = `${sub.stage === 'review' && !sub.error ? `<button class="primary" data-action="approve-session" title="${esc(hints.find((h) => h.startsWith('Approving')) || '')}">${ICONS.check}Approve</button><button id="job-revise-session">${ICONS.edit}Request changes</button>` : ''}${fabMove}${session}${retry}`;
    } else if (isHumanSub(sub)) {
      // The brief is the instruction here, not background for an agent, so it is
      // the body of the dialog rather than a folded detail.
      body = `<h3>What to do</h3><p class="job-brief">${esc(sub.brief)}</p>${sub.result ? `<h3>Recorded</h3>${receiptHtml(sub.result.checks)}` : ''}
        ${sub.result?.output ? `<h3>Result for dependent work</h3><pre class="job-human-output">${esc(sub.result.output)}</pre>` : ''}${noteFor(sub)}
        ${yours ? `<form id="job-human-form" data-state="${esc(sub.state)}"><label>Result for dependent work <small title="Up to 8,000 characters, passed to dependent agents">optional</small><textarea name="output" maxlength="8000" rows="4"></textarea></label><div class="job-actions tone-${STATES[state].tone}"><button class="primary" type="submit" title="${esc(hints.find((h) => h.startsWith('No agent')) || '')}">${ICONS.check}Mark done</button>${sub.state === 'doing' ? '' : '<button type="button" data-action="start-human">Mark in progress</button>'}</div></form>` : ''}`;
      actions = `${fabMove}${retry}`;
    } else {
      body = `${sub.stage === 'review' && sub.ready ? `<h3>Ready for review</h3>${receiptHtml(sub.ready.checks)}` : ''}
        ${sub.pr?.checks?.length ? `<h3>Checks</h3><ul class="job-checks">${sub.pr.checks.map((c) => `<li class="${checkTone(c.state)}">${checkMark(c.state)} ${esc(c.name)} <small>${esc(c.state.toLowerCase())}</small></li>`).join('')}</ul>` : ''}
        ${sub.pr ? commentsHtml(sub, commentsShown) : ''}
        ${sub.deploymentResult ? `<h3>Deployment pipelines</h3><ul class="job-checks">${sub.deploymentResult.runs.map((r) => `<li class="${checkTone(r.status)}">${checkMark(r.status)} ${link(r.url, r.workflow)} <small>${esc(r.status)}</small></li>`).join('')}</ul>` : ''}
        ${sub.deployed ? `<h3>Landed</h3>${receiptHtml(sub.deployed.checks)}` : ''}${noteFor(sub)}`;
      actions = `${codeAwaitingReview(sub) && !sub.error ? `<button class="primary" data-action="approve-code" title="${esc(hints.find((h) => h.startsWith('Nothing is committed')) || '')}">${ICONS.check}Approve &amp; ${sub.pr ? 'push' : 'open PR'}</button>` : ''}${mergeApprovable(job, sub) ? `<button class="primary" data-action="approve-merge" title="Merge head ${esc((sub.pr.head || '').slice(0, 8))}">${ICONS.merge}Merge${n ? ` #${esc(n)}` : ''}</button>` : ''}${fabMove}
        ${sub.worktree && sub.stage !== 'done' ? `<button id="job-diff">${ICONS.code}Review code in Wrangler</button>` : ''}${sub.worktree?.path && sub.stage !== 'done' ? `<button id="job-ide">Review code in ${esc(ideApp())}</button>` : ''}${session}${retry}
        ${sub.recoveredBy ? `<button data-open-sub="${esc(sub.recoveredBy)}" title="${esc(hints.at(-1))}">${ICONS.wrench}Open fix sub-job</button>` : ''}`;
    }
    const details = `${pr ? `<code>${esc(sub.worktree?.path || 'Worktree created on dispatch')}</code>` : ''}${isHumanSub(sub) ? '' : `<p>${esc(sub.brief)}</p>`}${sub.check ? `<p>Check after it lands: ${esc(sub.check)}</p>` : ''}
      ${workflows.length ? `<h4>What runs on merge <small>${workflows.filter((w) => w.triggers).length} of ${workflows.length}</small></h4><ul class="job-checks">${workflows.map((w) => `<li class="${w.triggers ? 'passed' : ''}">${w.triggers ? '✓' : '○'} ${esc(w.name)} <small>${esc(w.reason)}</small></li>`).join('')}</ul>` : ''}
      ${sub.repairs.length ? `<h4>Changes after failed checks</h4>${sub.repairs.map((r, i) => `<div class="job-repair"><b>Repair ${i + 1}</b>${receiptHtml(r.changes)}<details><summary>Re-verified</summary>${receiptHtml(r.checks)}</details></div>`).join('')}` : ''}`;
    return `${appbar(sub.title, chips, kicker)}${depsHtml(job, sub)}
      ${job.error && !sub.error ? `<p class="job-error">${esc(job.error)}</p>` : ''}${eventHtml(job, sub)}
      ${sub.observationError ? `<p class="job-error">${esc(sub.observationError)} · Retrying automatically</p>` : ''}${body}
      ${actions.trim() ? `<div class="job-actions tone-${STATES[state].tone}">${actions}</div>` : ''}${movesHtml(job, sub)}
      ${more('details', `${ICONS.doc}${isHumanSub(sub) ? 'Details' : pr ? 'Worktree &amp; brief' : 'Brief'}`, details)}`;
  }
  function renderDetail() {
    const job = data.jobs.find((j) => j.id === selected?.jobId);
    if (!job) return;
    const sub = job.subJobs.find((s) => s.id === selected.subId);
    if (!sub && !planDraft && job.stage === 'planning' && job.plan) { planDraft = structuredClone(job.plan); revision = job.revision; }
    show(sub ? subDetail(job, sub) : jobDetail(job));
    dialog.querySelectorAll('[data-action]').forEach((b) => b.onclick = () => {
      const name = b.dataset.action;
      const target = b.dataset.sub ? job.subJobs.find((s) => s.id === b.dataset.sub) : sub;
      action(name, name === 'approve-plan' ? { plan: planDraft, revision }
        : { head: target?.pr?.head, sessionReceiptId: target?.result?.receiptId, ...(target?.ready ? { readyReceiptId: target.ready.receiptId } : {}) }, target?.id);
    });
    const humanForm = dialog.querySelector('#job-human-form');
    if (humanForm) humanForm.onsubmit = (e) => {
      e.preventDefault();
      const output = String(new FormData(humanForm).get('output') || '').trim();
      action('finish-human', output ? { output } : {});
    };
    dialog.querySelectorAll('[data-comment-toggle]').forEach((b) => b.onclick = () => {
      const key = b.dataset.commentToggle;
      if (!commentsShown.delete(key)) commentsShown.add(key);
      renderDetail();
    });
    dialog.querySelectorAll('[data-story]').forEach((e) => e.oninput = () => { planDraft.stories[+e.dataset.story].title = e.value; });
    dialog.querySelectorAll('[data-open-sub]').forEach((b) => b.onclick = () => openDetail(job.id, b.dataset.openSub));
    dialog.querySelectorAll('[data-open-job]').forEach((b) => b.onclick = () => openDetail(job.id));
    dialog.querySelectorAll('[data-fab-session]').forEach((b) => b.onclick = () => { dialog.close(); onSession(b.dataset.fabSession); });
    dialog.querySelectorAll('.job-move[data-move], [data-fab-move]').forEach((b) => b.onclick = () => openMove(job, sub, b.dataset.move || b.dataset.fabMove));
    wireGraph();
    const bind = (id, fn) => { const e = dialog.querySelector(id); if (e) e.onclick = fn; };
    bind('#job-refine', () => {
      show('<h2>Refine the plan</h2><form id="job-feedback"><label>What should change?<textarea name="feedback" required maxlength="8000" rows="5"></textarea></label><div class="job-actions"><button class="primary">Send to planning</button></div></form>');
      dialog.querySelector('form').onsubmit = (e) => { e.preventDefault(); action('replan', { feedback: new FormData(e.target).get('feedback') }); };
    });
    bind('#job-revise-session', () => {
      show('<h2>Request changes</h2><form><label>What should change?<textarea name="feedback" required rows="4" maxlength="8000"></textarea></label><div class="job-actions"><button class="primary">Send to a new session</button></div></form>');
      dialog.querySelector('form').onsubmit = (e) => { e.preventDefault(); action('revise-session', { feedback: new FormData(e.target).get('feedback') }); };
    });
    // The note is what the retried session reads as the last line of its
    // history (server/job-prompts.js): a blocked step usually needs one sentence
    // from the human ("that file is a template, stage it"), and Retry was the one
    // button with nowhere to type it.
    bind('#job-retry', () => {
      const target = sub?.error ? sub : null;
      show(`<h2>Retry ${esc(target ? target.title : job.title)}</h2>${target?.error ? `<p class="job-error">${esc(target.error)}</p>` : job.error ? `<p class="job-error">${esc(job.error)}</p>` : ''}<form id="job-retry-form">${target ? noteField('Note for the retried session') : ''}<div class="job-actions"><button class="primary">Retry</button><button type="button" id="job-move-back">Back</button></div></form>`);
      dialog.querySelector('#job-move-back').onclick = () => renderDetail();
      dialog.querySelector('form').onsubmit = (e) => { e.preventDefault(); action('retry', { subJobId: target?.id, ...only({ note: trimmed(new FormData(e.target), 'note') }) }); };
    });
    bind('#job-cancel', () => openCancel(job));
    bind('#job-session', () => { dialog.close(); onSession(sub.sessions.at(-1)); });
    // Reviewing the code is a round trip out to the board's diff panel, so hand over
    // where the reader came FROM as well as what to show — index.js re-opens this
    // same detail via openDetail once the panel closes. Every run of a sub-job
    // shares its worktree (later phases adopt it), so any of its cards shows the
    // same diff: the latest one already on the board, because opening an archived
    // card resumes its agent just to read a diff; else the latest.
    bind('#job-diff', () => { dialog.close(); onDiff(sub.sessions.findLast(onBoard) || sub.sessions.at(-1), { jobId: job.id, subId: sub.id }); });
    // The IDE opens beside the board rather than instead of it, so the dialog
    // stays: approving is still done here once the code has been read.
    bind('#job-ide', () => send({ type: 'job-open-ide', id: job.id, subJobId: sub.id }));
  }
  // Every move is one small form in the same dialog, submitting exactly the fields
  // server/job-moves.js validates — nothing is inferred from the sub-job's state at
  // send time, so what the human read is what the server is asked for.
  const trimmed = (f, name) => String(f.get(name) || '').trim();
  // An empty optional field is left OUT of the payload rather than sent as '': the
  // schemas treat a present empty string as a value, and a blank note would clear
  // nothing but occupy the card.
  const only = (fields) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v != null));
  const noteField = (label = 'Note for the next session') => `<label>${esc(label)} <small>Optional · one line, shown on the card until the next session reports</small><input name="note" maxlength="180"></label>`;
  const briefField = (label = 'Brief') => `<label>${esc(label)} <small>Write it like a dispatch: what to do, not how</small><textarea name="brief" required rows="4" maxlength="500"></textarea></label>`;
  const checkField = () => '<label>Check after it lands <small>Optional · one line an agent confirms once the pipeline is green</small><input name="check" maxlength="180"></label>';
  // Merged work cannot be reordered around, so the position radios are dropped
  // rather than disabled — the server ignores `position` in that case, and the form
  // still sends 'after' so the payload matches the schema either way.
  const positionField = ({ optional = false } = {}) => `<fieldset><legend>Where it lands</legend>${optional ? '<label><input type="radio" name="position" value="" checked> Independent of this one</label>' : ''}<label><input type="radio" name="position" value="before"> Before this one</label><label><input type="radio" name="position" value="after" ${optional ? '' : 'checked'}> After this one</label></fieldset>`;
  function moveForm(job, sub, id, inner, submitLabel) {
    const m = moveCopy(job, sub, moveById(id));
    show(`<span class="jobs-kicker">${esc(job.title)}</span><h2>${esc(m.label)}</h2><p>${esc(m.blurb)}</p><form id="job-move-form" data-move-form="${esc(id)}">${inner}<p class="job-error" id="job-move-error" hidden></p><div class="job-actions"><button class="primary">${esc(submitLabel)}</button><button type="button" id="job-move-back">Back</button></div></form>`);
    dialog.querySelector('#job-move-back').onclick = () => renderDetail();
    return dialog.querySelector('#job-move-form');
  }
  function openMove(job, sub, id) {
    const fail = (text) => { const err = dialog.querySelector('#job-move-error'); err.textContent = text; err.hidden = false; };
    const submit = (form, build) => { form.onsubmit = (e) => { e.preventDefault(); build(new FormData(form)); }; };
    const merged = sub.stage === 'deployment';
    if (id === 'drop') {
      const live = job.runs.some((r) => !r.stopped && r.subJobId === sub.id);
      show(`<h2>Drop ${esc(sub.title)}?</h2><p>This skips straight to cleanup. ${live ? 'The running step is stopped and its receipt is ignored. ' : ''}${sub.pr ? 'The pull request stays open on GitHub for you to close. ' : ''}${isHumanSub(sub) ? 'Nothing ever ran for it, so there is nothing to stop or clean up.' : isSessionSub(sub) ? 'Its session is archived; nothing on disk is removed.' : 'Sessions are archived; the worktree is removed only if its commits are already pushed or the branch is unchanged.'} Sub-jobs that ${isPrSub(sub) ? 'land' : 'start'} after this one will need dropping too.</p><form id="job-drop-form"><div class="job-actions"><button type="button" class="danger" data-drop="1">Drop sub-job</button><button type="button" id="job-move-back">Keep working</button></div></form>`);
      dialog.querySelector('[data-drop]').onclick = () => action('drop');
      dialog.querySelector('#job-move-back').onclick = () => renderDetail();
      return;
    }
    if (id === 'fix-here') {
      const form = moveForm(job, sub, id, `<label>What should change? <small>One line, handed to the ${sub.stage === 'pr' ? 'repair session with the failing checks and comments' : 'next session as a steer'}</small><input name="note" maxlength="180" required></label>`, sub.stage === 'pr' ? 'Start a repair' : 'Run it again');
      return submit(form, (f) => action('fix-here', only({ note: trimmed(f, 'note') })));
    }
    if (id === 'split-out') {
      const form = moveForm(job, sub, id, `<label>Title<input name="title" required maxlength="180"></label>${briefField()}${checkField()}
        ${merged ? '<p class="job-authority">This one is merged, so the new PR lands next and everything already waiting on this one waits for it instead.</p>' : positionField()}${noteField()}`, 'Add the PR');
      return submit(form, (f) => action('split-out', { title: trimmed(f, 'title'), brief: trimmed(f, 'brief'), position: merged ? 'after' : f.get('position'), ...only({ check: trimmed(f, 'check'), note: trimmed(f, 'note') }) }));
    }
    if (id === 'new-ticket') {
      const form = moveForm(job, sub, id, `<label>Story title <small>The ticket. Created in Jira unless you give an existing key.</small><input name="storyTitle" required maxlength="180"></label>
        <div class="job-form-row"><label>Existing key <small>Optional</small><input name="key" maxlength="40" placeholder="AUTH-123"></label><label>Project <small>Optional · where a new ticket is created</small><input name="project" maxlength="40" placeholder="AUTH"></label></div>
        <label>PR title<input name="title" required maxlength="180"></label>${briefField()}${checkField()}${positionField({ optional: true })}${noteField()}`, 'Add the story and PR');
      return submit(form, (f) => action('new-ticket', { storyTitle: trimmed(f, 'storyTitle'), title: trimmed(f, 'title'), brief: trimmed(f, 'brief'), ...only({ key: trimmed(f, 'key'), project: trimmed(f, 'project'), check: trimmed(f, 'check'), position: trimmed(f, 'position'), note: trimmed(f, 'note') }) }));
    }
    if (id === 'reorder') {
      const others = job.subJobs.filter((d) => d.id !== sub.id && !d.cancelledAt);
      const form = moveForm(job, sub, id, `<fieldset class="job-move-deps"><legend>${isPrSub(sub) ? 'Deploys after' : 'Starts after'}</legend>${dependencyEditorHtml(sub, others, sub.id)}</fieldset><p class="job-authority">A prerequisite that is already merged or done stays ticked and simply counts as satisfied.</p>`, 'Save the order');
      return submit(form, () => action('reorder', { after: [...form.querySelectorAll('[data-dep]')].filter((c) => c.checked).map((c) => c.value) }));
    }
    if (id === 'accept-red') {
      const checks = sub.stage === 'pr';
      const red = checks ? (sub.pr?.checks || []).filter((c) => checkTone(c.state) === 'failed').map((c) => c.name)
        : (sub.deploymentResult?.runs || []).filter((r) => r.status === 'failing').map((r) => r.workflow);
      const form = moveForm(job, sub, id, `${red.length ? `<ul class="job-checks">${red.map((n) => `<li class="failed">${checkMark('failing')} ${esc(n)}</li>`).join('')}</ul>` : ''}
        <p class="job-authority">${checks ? `Merges head ${esc((sub.pr?.head || '').slice(0, 8))} with the checks as they are — with an admin override if branch protection would otherwise refuse it. A later push is judged afresh.` : `Counts merge commit ${esc((sub.pr?.mergeCommit || '').slice(0, 8))} as landed${sub.check ? ', then runs the plan’s check against it' : ''}, and releases whatever waits on it.`}</p>
        <label>Why is red fine here? <small>Optional · recorded with the move${checks ? '' : ', and as the receipt line'}</small><input name="note" maxlength="180"></label>`, checks ? 'Merge anyway' : 'Count it as landed');
      return submit(form, (f) => action('accept-red', only({ note: trimmed(f, 'note') })));
    }
    if (id === 'mark') {
      const options = markOptions(sub);
      const form = moveForm(job, sub, id, `<fieldset><legend>What is true</legend>${options.map((o, i) => `<label><input type="radio" name="position" value="${esc(o.value)}" ${i === 0 ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}</fieldset>
        ${options.some((o) => o.value === 'pr') ? '<label>Pull request URL<input name="url" maxlength="300" placeholder="https://github.com/org/repo/pull/12"></label>' : ''}
        <label>Note <small>Optional · recorded with the move, and as the receipt line when you mark it done</small><input name="note" maxlength="180"></label>`, 'Mark it');
      return submit(form, (f) => {
        const position = f.get('position');
        const url = trimmed(f, 'url');
        if (position === 'pr' && !url) return fail('Paste the pull request URL');
        action('mark', { position, ...only({ url: position === 'pr' ? url : '', note: trimmed(f, 'note') }) });
      });
    }
  }
  function createJob() {
    selected = null; planDraft = null;
    const agents = getAgents();
    const tasks = getTasks().filter((t) => !t.archived && !t.archivedAt);
    show(`<h2>New job</h2><form id="job-create-form"><label>Title<input name="title" required maxlength="180" placeholder="What should we deliver?"></label><label>What does success look like?<textarea name="intent" required rows="4" maxlength="16000" placeholder="Describe the value and how we’ll know it works."></textarea></label><div class="job-form-row"><label>Task<select name="taskId"><option value="">Unassigned</option>${tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}<option value="__new__">＋ New task</option></select></label><label id="job-new-task" hidden>New task name<input name="newTaskName" maxlength="180" hidden></label></div><div class="job-form-row"><label>Agent<select name="agent">${agents.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')}</select></label><label>Model<select name="model"></select></label><label>Effort<select name="effort"></select></label></div><fieldset><legend>Your review points</legend><label><input type="checkbox" checked disabled> Plan: titles, repositories, any proposed Jira stories & landing order (tickets are created only after you approve)</label><label><input type="checkbox" name="reviewCode" checked> Review each PR’s code before anything is committed</label><label><input type="checkbox" name="reviewMerge" checked> Review green PRs before merging</label><label><input type="checkbox" name="reviewSessions" checked> Review agent-session results before they count as done</label></fieldset><details class="job-more"><summary>Planning guidance & cleanup</summary><label>Repository hints <small>Optional · one local checkout path per line. Wrangler can discover others.</small><textarea name="repos" rows="2" placeholder="Leave blank to let Wrangler find the repositories"></textarea></label><label>Extra guidance for the planning agent<textarea name="planningPrompt" rows="4" maxlength="8000" placeholder="Your reusable planning guidance…"></textarea></label><label><input type="checkbox" name="updateMain"> Fast-forward my clean main checkout after delivery</label></details><div class="job-actions"><button class="primary" name="destination" value="start" title="Planning proposes Jira story titles without touching Jira, or none for work that has no ticket; you review the plan before tickets are created or work begins. Wrangler discovers the repositories it needs. Automated work uses dedicated worktrees and the shared concurrency limit.">Start planning</button><button name="destination" value="backlog">Add to backlog</button></div></form>`);
    const form = dialog.querySelector('form');
    const setModels = () => { form.elements.model.innerHTML = (agents.find((a) => a.id === form.elements.agent.value)?.models || []).map((m) => `<option value="${esc(m.value)}" ${m.default ? 'selected' : ''}>${esc(m.label || m.value)}</option>`).join(''); };
    // Default leaves effort to the agent, as core's dispatch dialog does; a level
    // only survives an agent switch if the new agent offers it too.
    const setEfforts = () => {
      const prev = form.elements.effort.value;
      const efforts = agents.find((a) => a.id === form.elements.agent.value)?.efforts || [];
      form.elements.effort.innerHTML = `<option value="">Default</option>${efforts.map((e) => `<option value="${esc(e.value)}">${esc(e.label || e.value)}</option>`).join('')}`;
      form.elements.effort.value = efforts.some((e) => e.value === prev) ? prev : '';
    };
    setModels(); setEfforts(); form.elements.agent.onchange = () => { setModels(); setEfforts(); };
    form.elements.taskId.onchange = () => {
      const creating = form.elements.taskId.value === '__new__';
      form.elements.newTaskName.hidden = !creating;
      form.elements.newTaskName.required = creating;
      form.elements.newTaskName.closest('label').hidden = !creating;
    };
    form.onsubmit = (e) => {
      e.preventDefault(); const values = new FormData(form);
      const taskId = values.get('taskId');
      // Enter and the primary button both start planning; only the grey button parks it.
      send({ type: 'job-create', start: e.submitter?.value !== 'backlog', ...only({ newTaskName: taskId === '__new__' ? String(values.get('newTaskName')).trim() : '' }), job: { title: values.get('title'), intent: values.get('intent'), repos: [...new Set(values.get('repos').split('\n').map((s) => s.trim()).filter(Boolean))], agent: values.get('agent'), model: values.get('model') || '', effort: values.get('effort') || '', planningPrompt: values.get('planningPrompt'), reviewCode: values.has('reviewCode'), reviewMerge: values.has('reviewMerge'), reviewSessions: values.has('reviewSessions'), updateMain: values.has('updateMain'), taskId: taskId && taskId !== '__new__' ? taskId : null } });
    };
  }
  q('#job-new').onclick = createJob;
  q('#jobs-concurrency').onchange = (e) => send({ type: 'job-settings', patch: { concurrency: Number(e.target.value) } });
  q('#jobs-pause').onclick = () => send({ type: 'job-settings', patch: { paused: !data.settings.paused } });
  q('#jobs-filter').onchange = (e) => { filter = e.target.value; render(); };
  q('#jobs-needs').onchange = (e) => { needsOnly = e.target.checked; render(); };
  q('#jobs-done').onchange = (e) => { showDone = e.target.checked; render(); };
  q('#jobs-boards').onclick = (e) => {
    const card = e.target.closest('[data-job]'); if (card) openDetail(card.dataset.job, card.dataset.sub);
  };
  q('#jobs-settings').onclick = () => {
    selected = null; planDraft = null;
    show(`<h2>Automation settings</h2><form id="job-settings-form"><label>Automatic CI repair attempts per sub-job<input type="number" name="maxRepairs" min="0" max="5" required value="${data.settings.maxRepairs}"></label><label>Minutes a merged PR may wait for a post-merge run to start before it is flagged<input type="number" name="deploymentStaleMinutes" min="5" max="1440" required value="${data.settings.deploymentStaleMinutes ?? 30}"></label><label>Application for “Review code in…” <small>A macOS application name — IntelliJ IDEA, Visual Studio Code, Rider…</small><input name="ideApp" required maxlength="120" value="${esc(ideApp())}"></label><div class="job-actions"><button class="primary" title="These limits apply across all automated jobs. Waiting for pipelines, dependencies and reviews uses no agent slots. Pause prevents new steps; sessions already working finish their current step.">Save settings</button></div></form>`);
    dialog.querySelector('form').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); send({ type: 'job-settings', patch: { maxRepairs: +f.get('maxRepairs'), deploymentStaleMinutes: +f.get('deploymentStaleMinutes'), ideApp: String(f.get('ideApp')).trim() } }); dialog.close(); };
  };
  dialog.addEventListener('keydown', (e) => {
    if (!isPrimaryActionKey(e)) return;
    const run = primaryAction(dialog);
    if (!run) return;
    e.preventDefault();
    run();
  });
  dialog.addEventListener('close', () => { selected = null; planDraft = null; commentsShown.clear(); openDeps.clear(); openMore.clear(); });
  render();
  // openDetail is exposed for the return leg of the diff round trip only — it opens
  // the same dialog a board card's click does, from a job/sub id pair index.js kept.
  return { update, created: (msg) => {
    if (dialog.querySelector('#job-human-form') && !(msg?.event === 'job-action-complete' && msg.action === 'finish-human' && msg.jobId === selected?.jobId && msg.subJobId === selected?.subId)) return;
    dialog.close();
  }, openDetail };
}
