import { ICONS, wranglerMark } from './icons.js';
import { SHOTS, proofFigure, runningBar } from './figs.js';
import { plateHtml } from './job-plates.js';
import { ideaThreadHtml } from './job-idea.js';
import { talkHtml } from './job-talk.js';
import { mountSkies, releaseSkies } from './job-skylines.js';
import { applyTheme } from './themes.js';

// What's new: a splash for each bigger release, shown once per browser, and the
// list Automation settings reads to show any of them again. Seen ids live in the
// client api's namespaced `storage` beside the intro's flag, so like the intro it
// is per browser rather than per install. Every string here is our own copy.
export const SEEN_UPDATES_KEY = 'updatesSeen';

const W2 = 'WRANGLER<sup>2</sup>';
const done = (items) => `<ul class="intro-done">${items.map((t) => `<li>${ICONS.check}<span>${t}</span></li>`).join('')}</ul>`;

// The Writes figures, in the job graph's own vocabulary (job-state.js tones,
// job-graph.js place pills): [tone, state glyph, solid tile].
const ST = { queued: ['idle', 'planned', false], running: ['run', 'spin', true], review: ['warn', 'eye', true], done: ['ok', 'check', true], failed: ['bad', 'x', true] };
const tile = (state, icon) => `<span class="job-node-tile${ST[state][2] ? ' on' : ''}">${ICONS[icon]}<span class="job-node-state">${ICONS[ST[state][1]]}</span></span>`;
const node = (state, icon, title, line) => `<div class="job-node tone-${ST[state][0]}">${tile(state, icon)}<strong class="job-node-title">${title}</strong><span class="job-status">${line}</span></div>`;
// Dashed until the place exists, a dot per write, amber while one waits on you.
const pill = (icon, label, state, exists) => `<span class="job-place-chip${exists ? '' : ' ghost'}${state === 'review' ? ' tone-warn urgent' : ''}">${ICONS[icon]}<b>${label}</b><span class="job-place-dots"><span class="job-place-dot tone-${ST[state][0]}${ST[state][2] ? ' on' : ''}"></span></span>${exists ? '<span class="job-place-go">↗</span>' : ''}</span>`;
const scenes = (frames) => frames.reduce((acc, f) => [...acc, { ...acc.at(-1), ...f }], []);

const DESIGN = scenes([
  { s: ['running', 'Designing'], art: ['queued', false], tix: ['running', false], h: ['queued', 'After the design'], pr: ['queued', 'After you approve'], view: 'none', note: 'none' },
  { tix: ['done', true], art: ['running', false], view: 'draft' },
  { s: ['done', 'Published'], art: ['done', true], view: 'live', h: ['review', 'Needs you'], note: 'ask' },
  {},
  { h: ['done', 'Approved'], note: 'said', pr: ['running', 'Building the design'] },
  {},
  { pr: ['done', 'Merged'] },
  {}, {},
]);
function designFigure(phase) {
  const f = DESIGN[phase];
  const mock = [['warn', 'Plan', true], ['warn', 'Local verification', true], ['idle', 'Merge', false], ['idle', 'Writes', false]]
    .map(([t, n, on]) => `<div class="wn-art-cp tone-${t}"><i></i><span>${n}</span><span class="wn-art-tg${on ? ' on' : ''}"></span></div>`).join('');
  const body = f.view === 'live' ? `<div class="wn-art-title wn-fade">Checkpoint buttons</div><div class="wn-art-mock wn-fade">${mock}</div>`
    : f.view === 'draft' ? '<div class="wn-art-sk" style="width:55%"></div><div class="wn-art-sk"></div><div class="wn-art-sk" style="width:80%"></div><div class="wn-art-sk" style="width:65%"></div>' : '';
  const bar = f.view === 'live' ? `${ICONS.sparkle}<code>claude.ai/artifact/…</code><span class="wn-art-open">Open ↗</span>` : `${ICONS.sparkle}<code>Claude artifact</code><em>${f.view === 'draft' ? 'Publishing…' : 'Not made yet'}</em>`;
  const tone = { ask: 'warn', said: 'ok' }[f.note] || 'idle';
  const quote = f.note === 'said' ? '<blockquote class="wn-fade">Looks good. Add a Next button for when two updates are waiting, and drop Learn more.</blockquote>'
    : `<blockquote class="ph">${f.note === 'ask' ? 'Open the design, then approve it with a note or ask for changes.' : 'Opens once the design is published.'}</blockquote>`;
  const moves = f.note === 'ask' ? `<span class="go">${ICONS.check}Approve</span><span>${ICONS.edit}Ask for changes</span>` : f.note === 'said' ? `<span>${ICONS.next}Goes to the PR as its brief</span>` : '';
  return `<div class="wn-row3" role="img" aria-label="A session publishes a design artifact and opens a ticket, you approve the design with a note, then a pull request builds it">
      <div class="wn-stack">${node(f.s[0], 'robot', 'Design it as an artifact', f.s[1])}<div class="job-places">${pill('sparkle', 'design', f.art[0], f.art[1])}${pill('ticket', f.tix[1] ? 'WEB-214' : 'story', f.tix[0], f.tix[1])}</div></div>
      <span class="wn-edge${f.s[0] === 'done' ? ' landed' : ''}"></span>
      <div class="wn-stack">${node(f.h[0], 'person', 'Approve the design', f.h[1])}</div>
      <span class="wn-edge${f.h[0] === 'done' ? ' landed' : ''}"></span>
      <div class="wn-stack">${node(f.pr[0], 'pr', 'Build the approved design', f.pr[1])}</div>
    </div>
    <div class="wn-under">
      <div class="wn-art${f.view === 'live' ? '' : ' pending'}"><div class="wn-art-bar">${bar}</div><div class="wn-art-body">${body}</div></div>
      <div class="wn-note tone-${tone}"><header>${ICONS.person}<span>Your sign-off</span><span>${{ said: 'Approved', ask: 'Needs you' }[f.note] || 'Waiting'}</span></header>${quote}${moves ? `<footer>${moves}</footer>` : ''}</div>
    </div>`;
}

const TELL = scenes([
  { s: ['running', 'Starting'], jira: ['queued', 'Queued'], page: ['queued', 'Queued'], slack: ['queued', 'After the page'] },
  { s: ['running', 'Making 3 writes'], jira: ['done', 'Written <u>WEB-214 ↗</u>'], page: ['running', 'Writing'] },
  { page: ['done', 'Written <u>Checkpoints runbook ↗</u>'], slack: ['running', 'Writing'] },
  { s: ['done', 'Delivered'], slack: ['done', 'Written <u>#team-web ↗</u>'] },
  {}, {},
]);
function tellFigure(phase) {
  const f = TELL[phase];
  const write = (state, icon, title, line) => `<div class="wn-write tone-${ST[state][0]}">${tile(state, icon)}<span><b>${title}</b><small>${line}</small></span></div>`;
  return `<div class="wn-row2" role="img" aria-label="A merged pull request, then a session that moves the ticket to Done, adds a Confluence runbook page and posts in Slack, each with a receipt">
      <div class="wn-stack">${node('done', 'merge', 'Build the approved design', 'Merged')}</div>
      <span class="wn-edge landed"></span>
      <div class="wn-stack">${node(f.s[0], 'robot', 'Close the ticket and tell the team', f.s[1])}<div class="job-places">${pill('ticket', 'WEB-214', f.jira[0], true)}${pill('confluence', 'runbook', f.page[0], f.page[0] === 'done')}${pill('slack', '#team-web', f.slack[0], f.slack[0] === 'done')}</div></div>
    </div>
    <div class="wn-writes">
      ${write(f.jira[0], 'ticket', 'Move WEB-214 to Done with the PR link', f.jira[1])}
      ${write(f.page[0], 'confluence', 'Add the “Review checkpoints” runbook page', f.page[1])}
      ${write(f.slack[0], 'slack', 'Post in #team-web: what changed and where', f.slack[1])}
    </div>`;
}

// See it working, in the board's own markup (figs.js checklist and running chip,
// job-thread.js thread, jobs-view.js Add idea box) fed with example data.
// The Add idea box with words in it. A <div> where the board has a <textarea>,
// so the words wrap and show in full rather than scrolling in one row.
const composer = (text) => `<div class="job-change has-text is-open">
  <div class="job-change-row"><span class="job-change-to"><i>T</i>This session</span><div class="wn-change-text">${text}</div><label class="job-change-attach">${ICONS.image}</label><button type="button" class="job-change-go" tabindex="-1">${ICONS.send}</button></div>
  <div class="job-change-foot"><span>A question gets an answer. A change gets a new round.</span><span>Paste or drop a screenshot</span><kbd>↵ send · ⇧↵ new line</kbd></div></div>`;
const thread = (msgs, state) => {
  const head = { waiting: [ICONS.terminal, 'Its session is waiting on your review', 'Paused · no slot · keeps its context'], answering: [ICONS.spin, 'Answering you', 'Working on what you sent'], stopped: [ICONS.terminal, 'Session stopped', 'Approved round 1'] }[state];
  const msg = ([from, text, at, att]) => `<div class="job-msg ${from} wn-fade"><span class="job-msg-who">${from === 'human' ? 'You' : 'Session'}</span><div><p>${text}<time>${at}</time></p>${att ? `<div class="job-msg-att"><span class="job-proof-thumb"><img alt="" src="${SHOTS[att]}"></span></div>` : ''}</div></div>`;
  return `<section class="job-thread ${state}"><div class="job-thread-head">${head[0]}<b>${head[1]}</b><small>${head[2]}</small></div>${msgs.map(msg).join('')}</section>`;
};

// A PR shows each Show me item, leaves the preview running, answers a question
// from its open session, and stops what it started once approved. The slot holds
// the tallest frame, so the title below never moves.
const SEE = scenes([
  { pr: ['running', 'Writing the PR'], shown: 0, slot: 'idle' },
  { pr: ['running', 'Showing it working'], shown: 1 },
  { shown: 2 },
  { pr: ['review', 'Ready to verify'], shown: 3, slot: 'bar' },
  { slot: 'ask' },
  { pr: ['running', 'Answering you'], slot: 'asked' },
  { pr: ['review', 'Ready to verify'], slot: 'answered' },
  {},
  { pr: ['running', 'Committing & opening the PR'], slot: 'stopped' },
  { pr: ['done', 'PR open · checks running'] },
  {}, {},
]);
const Q = ['human', 'Does it keep the column order when a filter is on?', '14:02'];
const A = ['agent', 'Yes. The export follows the table’s visible columns, filtered or not. Here it is with Plan = Pro.', '14:03', 'excel.png'];
function seeFigure(phase) {
  const f = SEE[phase];
  const slot = {
    idle: `<div class="wn-slot-ghost">${ICONS.play}<span>What it starts stays running for you to try</span></div>`,
    bar: runningBar('on'),
    ask: `${runningBar('on')}${composer(Q[1])}`,
    asked: `${runningBar('on')}${thread([Q], 'answering')}`,
    answered: `${runningBar('on')}${thread([Q, A], 'waiting')}`,
    stopped: `${runningBar('stopped')}${thread([Q, A], 'stopped')}`,
  }[f.slot];
  return `<div class="wn-see-top">${node(f.pr[0], 'pr', 'Add CSV export', f.pr[1])}<div class="job-chips"><span class="job-chip job-plan-branch">${ICONS.branch}<span>next</span></span><span class="job-chip">${ICONS.eye}<span>Show me · 3 items</span></span></div></div>
    <div class="wn-see-proof" role="img" aria-label="A pull request shows each Show me item working, leaves its preview running, answers a question from its open session, and stops the preview once you approve">${proofFigure(f.shown)}</div>
    <div class="wn-slot">${slot}</div>`;
}

// The new planner, as three short figures: a red step going to the planner first,
// a decision with ranked options (the board's .job-option), and Add idea sending
// feedback back to the step that made it.
const RED = scenes([
  { pr: ['running', 'Checks running'], pl: ['queued', 'Standing by'], you: ['queued', 'Not needed yet'], e1: '', e2: '', note: 'idle' },
  { pr: ['failed', '2 tests failed'], e1: 'hot' },
  { pl: ['running', 'Looking into it'], note: 'look' },
  { pl: ['done', 'Fix ready'], you: ['review', 'Approve the fix?'], e2: 'ask', note: 'ask' },
  { you: ['done', 'Approved'], pr: ['running', 'Reworking'], e1: 'landed', e2: 'landed', note: 'sent' },
  { pr: ['done', 'Checks pass'] },
  {},
]);
function redFigure(phase) {
  const f = RED[phase];
  const fix = 'Two tests still expect the old date format. <b>Fix: send the PR back to update both tests.</b>';
  const n = {
    idle: ['idle', 'Waiting', '<blockquote class="ph">A red step comes here first.</blockquote>', ''],
    look: ['run', 'Working', '<blockquote class="wn-fade">Two tests still expect the old date format.</blockquote>', ''],
    ask: ['warn', 'Needs you', `<blockquote>${fix}</blockquote>`, `<span class="go">${ICONS.check}Approve</span><span>${ICONS.idea}Add idea</span>`],
    sent: ['ok', 'Approved', `<blockquote>${fix}</blockquote>`, `<span>${ICONS.next}Sent back to the PR</span>`],
  }[f.note];
  return `<div class="wn-row3" role="img" aria-label="A pull request fails its checks, the planner finds why and proposes sending it back, you approve, and the checks pass">
      <div class="wn-stack">${node(f.pr[0], 'pr', 'Add CSV export', f.pr[1])}</div>
      <span class="wn-edge ${f.e1}"></span>
      <div class="wn-stack">${node(f.pl[0], 'sparkle', 'Planner', f.pl[1])}</div>
      <span class="wn-edge ${f.e2}"></span>
      <div class="wn-stack">${node(f.you[0], 'person', 'You', f.you[1])}</div>
    </div>
    <div class="wn-solo"><div class="wn-note tone-${n[0]}"><header>${ICONS.sparkle}<span>Planner</span><span>${n[1]}</span></header>${n[2]}${n[3] ? `<footer>${n[3]}</footer>` : ''}</div></div>`;
}

const OPTS = [
  ['Stream the file as it’s written', 'Works for any size. One more PR, about an hour.'],
  ['Cap the export at 50,000 rows', 'Quick, but big tables lose rows.'],
  ['Leave big tables for now', 'Ship as it is and open a ticket.'],
];
const ASK = scenes([{ shown: 0, sel: false, sent: false }, { shown: 1 }, { shown: 2 }, { shown: 3 }, { sel: true }, { sent: true }, {}]);
function askFigure(phase) {
  const f = ASK[phase];
  const opts = OPTS.map(([t, why], i) => i < f.shown
    ? `<div class="job-option${f.sel && i === 0 ? ' sel' : ''}${i === f.shown - 1 && !f.sel ? ' wn-fade' : ''}"><span class="wn-rank">${i + 1}</span><span><b>${t}${i === 0 ? '<span class="job-option-rec">Recommended</span>' : ''}</b><small>${why}</small></span></div>`
    : `<div class="job-option wn-pending"><span class="wn-rank">${i + 1}</span><span><span class="wn-skel"></span></span></div>`).join('');
  const foot = f.sent ? `<span class="wn-btn ok wn-fade">${ICONS.check}Approved · the PR is sent back to stream it</span>`
    : `<span class="wn-btn${f.sel ? ' go' : ''}">${ICONS.check}Approve option 1</span>`;
  return `<div class="wn-ask" role="img" aria-label="The planner asks how to handle exports that time out and offers three ranked options; you approve the recommended one">
      <div class="wn-route">${ICONS.sparkle}<b>Planner</b><span>needs a decision on <b>Add CSV export</b></span></div>
      <p class="job-replan-ask">The export times out on tables over 50,000 rows. How should it handle them?</p>
      <div class="job-options">${opts}</div>
      <footer>${foot}</footer>
    </div>`;
}

const IDEA_TEXT = 'It’s a bit too tall. Make it fit without scrolling.';
const IDEA = scenes([
  { d: ['done', 'Published'], pr: ['queued', 'Waits for your approval'], text: '', go: false, route: false },
  { text: IDEA_TEXT },
  { go: true },
  { text: '', go: false, route: true, d: ['running', 'Redoing the mock-up'] },
  { d: ['done', 'Published again'] },
  {},
]);
function ideaFigure(phase) {
  const f = IDEA[phase];
  const box = `<div class="job-change${f.text ? ' has-text is-open' : ''}">
    <div class="job-change-row"><span class="job-change-to"><i>M</i>Mock-up</span><div class="job-change-text${f.text ? '' : ' ph'}">${f.text || 'Add idea: a change, a question, new work…'}</div><label class="job-change-attach">${ICONS.image}</label><button type="button" class="job-change-go${f.go ? ' on' : ''}" tabindex="-1">${ICONS.send}</button></div>
    <div class="job-change-foot"><span>The planner works out where it goes</span><span>Paste or drop a screenshot</span><kbd>↵ send · ⇧↵ new line</kbd></div></div>`;
  const route = f.route ? `<div class="wn-route wn-fade">${ICONS.sparkle}<span>Planner: <b>feedback on the mock-up</b>, so it goes back to the step that made it. The PR’s brief is unchanged.</span></div>` : '<div class="wn-route"></div>';
  return `<div class="wn-row2s" role="img" aria-label="You write that a published mock-up is too tall; the planner sends it back to the design step, which publishes it again while the PR waits">
      <div class="wn-stack">${node(f.d[0], 'sparkle', 'Mock-up the splash', f.d[1])}</div>
      <span class="wn-edge"></span>
      <div class="wn-stack">${node(f.pr[0], 'pr', 'Build the splash', f.pr[1])}</div>
    </div>
    <div class="wn-idea">${box}${route}</div>`;
}

// New idea, as the board draws it: an example idea job fed to the real plate
// (job-plates.js) and thread (job-idea.js), so the plate's forming sky brightens
// as the planner asks and then suggests, and the suggestion becomes the job.
// Its clock is the reader's, read when the frame is drawn: the idea started six minutes ago.
const ideaTalk = (now) => {
  const clock = (m) => now - (6 - m) * 60000;
  const asked = { id: 'm1', at: clock(3), from: 'planner', text: 'Happy to. Where should it go, and what should it say about each job?' };
  const answer = { id: 'm2', at: clock(4), from: 'human', text: 'Slack, #team-web. Just the title and its PR.', sentAt: clock(4) };
  const suggest = { id: 'm3', at: clock(5), from: 'planner', text: 'That’s enough to plan. Here’s the job I’d make:',
    suggest: { title: 'Post a Friday digest of finished jobs', plan: { subJobs: [
      { id: 'build', kind: 'pr', title: 'Build the Friday digest', repo: '~/code/wrangler-squared', base: 'next', after: [] },
      { id: 'post', kind: 'session', title: 'Post the first digest', after: ['build'] },
      { id: 'slack', kind: 'write', title: 'Post the digest in #team-web', by: 'post', place: { type: 'slack', channel: '#team-web' }, after: [] },
    ] } } };
  return { clock, suggest, threads: [[], [asked], [asked, { ...answer, sentAt: null }], [asked, answer, suggest], [asked, answer, { ...suggest, acceptedAt: clock(6) }]] };
};
const IDEAS = scenes([
  { thread: 0, parked: false, fresh: null, press: null, made: false },
  { thread: 1, parked: true, fresh: 'm1' },
  { thread: 2, parked: false, fresh: null },
  { thread: 3, parked: true, fresh: 'm3' },
  { fresh: null },
  { press: 'firing' },
  { press: 'sent' },
  { thread: 4, made: true },
  {},
]);
// Figure buttons stay out of the tab order, and its thread is not announced every frame.
const inert = (html) => html.replaceAll('<button ', '<button tabindex="-1" ').replaceAll('<summary>', '<summary tabindex="-1">').replaceAll(' aria-live="polite"', '');
function ideasFigure(phase) {
  const f = IDEAS[phase], { clock, suggest, threads } = ideaTalk(Date.now());
  // Creating it approved the plan, so the job it became is already building.
  const plan = f.made ? suggest.suggest.plan : null;
  const subJobs = plan ? plan.subJobs.map((s) => ({ sessions: [], repairs: [], ...s, stage: s.id === 'build' ? 'implementation' : 'queued' })) : [];
  const job = { id: 'wn-idea', title: 'Friday digest of finished jobs', intent: 'Could the board tell the team what finished each week?', repos: [], stage: f.made ? 'active' : 'planning', subJobs, moves: [], revision: 1,
    createdAt: clock(0), reviewPlan: true, idea: { thread: threads[f.thread] }, plan,
    runs: [{ id: 'wn-run', subJobId: null, phase: 'planning', stopped: f.made, parkedFor: 'idea', parkedAt: f.parked ? clock(5) : null, mailedAt: null },
      ...(f.made ? [{ id: 'wn-build', subJobId: 'build', phase: 'implementation', stopped: false, status: 'working' }] : [])] };
  const thread = ideaThreadHtml(job, { fresh: (id) => id === f.fresh, firing: f.press && { id: 'm3', state: f.press } });
  return `<div class="wn-ideas" role="img" aria-label="An idea sits on the board as a forming sky while its planner asks one question, then suggests a job you create with one press">
      <div class="wn-ideas-plate">${inert(plateHtml(job, 'opus'))}</div>
      <div class="wn-ideas-chat">${inert(thread)}</div>
    </div>`;
}

// The wrangler conversation, as the job dialog draws it: an example running job fed
// to the real talkHtml (job-talk.js). A question is answered in its own
// conversation while the PR carries on; new work in a second one becomes a
// proposal that folds to one line once approved. Times are the reader's clock.
const TALK_Q = 'Does the export keep the column order when a filter is on?';
const TALK_A = 'Yes. It follows the table’s visible columns, filtered or not, and the PR already tests it.';
const TALK_NEW = 'Add an Excel export too, once this PR is in.';
const TALK = scenes([
  { pr: ['running', 'Writing tests'], xl: null, text: '', go: false, c1: 0, c2: 0 },
  { text: TALK_Q },
  { go: true },
  { text: '', go: false, c1: 1, pr: ['running', 'Checks running'] },
  { c1: 2 },
  { text: TALK_NEW, go: true },
  { text: '', go: false, c2: 1, pr: ['review', 'Ready to verify'] },
  { c2: 2, xl: 'proposed' },
  { c2: 3, xl: 'queued' },
  {},
]);
function talkJob(f, now) {
  const clock = (m) => now - (6 - m) * 60000;
  const talk = [], convos = [], runs = [];
  if (f.c1) {
    convos.push({ id: 'c1', at: clock(1), pending: f.c1 === 1 ? { asks: [] } : null });
    talk.push({ id: 't1', convo: 'c1', from: 'human', text: TALK_Q, at: clock(1) });
    if (f.c1 === 1) runs.push({ id: 'wn-ask', subJobId: null, phase: 'planning', ask: true, convo: 'c1', stopped: false });
    else talk.push({ id: 't2', convo: 'c1', from: 'planner', text: TALK_A, at: clock(2) });
  }
  if (f.c2) {
    convos.push({ id: 'c2', at: clock(4) });
    talk.push({ id: 't3', convo: 'c2', from: 'human', text: TALK_NEW, at: clock(4) });
    if (f.c2 > 1) talk.push({ id: 't4', convo: 'c2', from: 'planner', kind: 'proposal', proposalId: 'p1', at: clock(5),
      text: 'One new PR after Add CSV export, so the two exports share its column logic.',
      changes: [{ mark: 'added', title: 'Add Excel export', then: 'Starts after Add CSV export' }],
      ...(f.c2 === 3 ? { outcome: 'approved', outcomeAt: clock(6) } : {}) });
  }
  const replan = f.c2 === 1 ? { convo: 'c2' } : f.c2 === 2 ? { convo: 'c2', proposal: { id: 'p1' } } : null;
  return { id: 'wn-talk', title: 'CSV export', subJobs: [{ id: 'csv', title: 'Add CSV export' }], runs, convos, talk, replan };
}
// The story reads each answer as it lands: the conversation in play stays open, the earlier one folds once the second starts.
const TALK_OPEN = (f) => new Map([['c1', !f.c2], ['c2', true]]);
function talkFigure(phase) {
  const f = TALK[phase];
  const xl = f.xl === 'proposed' ? `<div class="job-node tone-idle job-mark-added wn-fade">${tile('queued', 'pr')}<strong class="job-node-title">Add Excel export</strong><span class="job-status">Proposed</span></div>`
    : f.xl ? node('queued', 'pr', 'Add Excel export', 'After Add CSV export') : '';
  const box = `<div class="job-change${f.text ? ' has-text' : ''}"><div class="job-change-row"><span class="job-change-to">${wranglerMark('small')}Wrangler${f.c1 ? '<small>New conversation</small>' : ''}</span><div class="job-change-text${f.text ? '' : ' ph'}">${f.text || 'Add idea: a question, a change, new work…'}</div><label class="job-change-attach">${ICONS.image}</label><button type="button" class="job-change-go${f.go ? ' on' : ''}" tabindex="-1">${ICONS.send}</button></div></div>`;
  return `<div class="wn-row2s" role="img" aria-label="A running job: you ask Wrangler a question and it answers while the PR carries on, then you ask for new work and approve the PR it proposes">
      <div class="wn-stack">${node(f.pr[0], 'pr', 'Add CSV export', f.pr[1])}</div>
      <span class="wn-edge${!f.xl ? ' ghost' : f.xl === 'proposed' ? ' added' : ''}"></span>
      <div class="wn-stack">${xl}</div>
    </div>
    <div class="wn-talk">${inert(talkHtml(talkJob(f, Date.now()), null, null, TALK_OPEN(f)))}${box}</div>`;
}

// Redraws a figure in place, so surviving nodes keep their identity: tones
// transition, spinners keep turning and fade-ins play only for what is new.
// Replacing innerHTML every tick made the whole figure flash.
function patch(el, html) {
  const next = el.ownerDocument.createElement('div');
  next.innerHTML = html;
  morph(el, next);
}
function morph(a, b) {
  const as = [...a.childNodes];
  const bs = [...b.childNodes];
  bs.forEach((bn, i) => {
    const an = as[i];
    if (!an) return a.appendChild(bn);
    if (an.nodeType !== bn.nodeType || an.nodeName !== bn.nodeName) return a.replaceChild(bn, an);
    if (an.nodeType !== 1) { if (an.nodeValue !== bn.nodeValue) an.nodeValue = bn.nodeValue; return; }
    // A sky is painted on the client (job-skylines.js mountSkies): keep it while its
    // parameters hold, and swap in a fresh placeholder to repaint when they change.
    if (an.classList.contains('gx')) { if (JSON.stringify({ ...an.dataset }) !== JSON.stringify({ ...bn.dataset })) a.replaceChild(bn, an); return; }
    [...an.attributes].forEach((at) => { if (!bn.hasAttribute(at.name)) an.removeAttribute(at.name); });
    [...bn.attributes].forEach((at) => { if (an.getAttribute(at.name) !== at.value) an.setAttribute(at.name, at.value); });
    morph(an, bn);
  });
  as.slice(bs.length).forEach((n) => n.remove());
}
// Oldest first; append a release's entry at the end. `date` is YYYY-MM-DD and
// `body` is our own HTML. Optional: `icon` (an ICONS key) and `tone` for the
// settings row, `figure(phase)` drawn above the title, and `anim` ({ frames, ms,
// still }) to redraw it every `ms`, holding `still` with reduced motion.
export const UPDATES = [
  { id: 'writes-designs', date: '2026-10-14', icon: 'sparkle', tone: 'run',
    title: 'See the design before anything is built',
    body: `<p>A plan can now start with a session that publishes a <b>Claude artifact</b>, such as a mockup, a before and after, or a prototype, and then stop for you. Nothing is built until you approve, and what you write when you approve goes to the PR as its brief.</p>${done([
      '<b>Artifacts are private</b> claude.ai pages, linked from the job and from the ticket.',
      '<b>Files and web pages too</b>: a screenshot of the change on your own board, a report, a page a session hosts.',
      '<b>Ask for it in plain words</b>, like “design it first and let me approve it”, and the plan adds the steps.',
    ])}`,
    anim: { frames: 9, ms: 1500, still: 4 }, figure: (phase) => designFigure(phase) },
  { id: 'writes-places', date: '2026-10-14', icon: 'ticket', tone: 'ok',
    title: 'Jira, Slack and Confluence, kept up to date as the job runs',
    body: `<p>Jobs now handle the work around the code: opening the ticket, linking the design, moving it to Done when the PR merges, and telling the people who need to know. Every write is a step in the plan, made by one of its sessions, and nothing is written that the plan doesn’t list.</p>${done([
      '<b>A receipt for every write</b>: written, already done, or failed with the place’s own error. Nothing is posted twice.',
      '<b>Each place is a pill</b> under the session that writes to it. It shows a dot per write and opens to what was written.',
      '<b>The Writes checkpoint</b> starts on Auto. Set it to You review to get a draft you can edit, write or skip.',
    ])}`,
    anim: { frames: 6, ms: 1400, still: 3 }, figure: (phase) => tellFigure(phase) },
  { id: 'review-defaults', date: '2026-10-14', icon: 'hand', tone: 'warn',
    title: 'Choose where every new job’s checkpoints start',
    body: `<p><b>Automation settings</b> now has the five review checkpoints. Set them once and every New job form opens on your choice, so you no longer flip the same toggles on each job.</p>${done([
      '<b>Nothing changes until you edit them</b>: they start where New job always started.',
      '<b>Jobs agents create</b> use them too, unless the agent picks a checkpoint itself.',
      '<b>Jobs already on the board keep their own.</b> Change one from its detail footer.',
    ])}` },
  { id: 'see-it-working', date: '2026-10-15', icon: 'eye', tone: 'run',
    title: 'See each PR working before you read its diff',
    body: `<p>A PR can now carry a <b>Show me</b> list: the plan writes one, and you can edit it. Before anything is committed, the agent shows each item working on the running build, as a screenshot, a recording or a command’s output. Anything it couldn’t show is marked in amber with why.</p>${done([
      '<b>Try it yourself</b>: what the agent started stays running for you, with a link, its logs and Stop. Approve, and it is stopped for you.',
      '<b>Ask the session</b> in Add idea. It stays open while you review, answers with a shot or output, or makes the change as a new round.',
      '<b>Approve means what you saw</b>: if a file changes after the receipt, the session is asked to show it again.',
    ])}`,
    anim: { frames: 12, ms: 1500, still: 6 }, figure: (phase) => seeFigure(phase) },
  { id: 'planner-red-steps', date: '2026-10-15', icon: 'sparkle', tone: 'warn',
    title: 'A failing step goes to the planner first',
    body: `<p>When a step goes red, the <b>planner</b> now looks at it before you do. It works out what went wrong and proposes a fix, usually sending the step back with a note on what to change.</p>${done([
      '<b>You approve the fix</b> to start with. Set <b>Red steps</b> to Wrangler replans and a fix like this goes ahead by itself.',
      '<b>Only that step waits</b>, with the steps after it. The rest of the job carries on.',
      '<b>If it can’t fix it</b>, it tells you what it found, what it tried and the one thing it needs you to decide.',
    ])}`,
    anim: { frames: 7, ms: 1600, still: 3 }, figure: (phase) => redFigure(phase) },
  { id: 'planner-options', date: '2026-10-15', icon: 'hand', tone: 'warn',
    title: 'Pick from up to three ranked options',
    body: `<p>When the planner needs you to decide, it now offers up to three options, best first, each with why. Pick one and approve. Nothing changes until you do.</p>${done([
      '<b>Each option is a whole plan</b>, with the fixes it makes, such as sending a step back or accepting a red check.',
      '<b>Accept red and Mark done always wait for you</b>, whatever Red steps is set to.',
      '<b>Old options are refused.</b> If the PR has moved on since, approving tells you instead of acting on stale facts.',
    ])}`,
    anim: { frames: 7, ms: 1600, still: 3 }, figure: (phase) => askFigure(phase) },
  { id: 'planner-add-idea', date: '2026-10-15', icon: 'idea', tone: 'run',
    title: 'Say what to change, on any step',
    body: `<p><b>Change plan</b> is now <b>Add idea</b>: one box on every step, review and proposal. Write what you want in your own words and the planner works out where it belongs.</p>${done([
      '<b>Feedback goes back to the step that made it.</b> Say a mock-up is too tall and the design is redone, so the PR doesn’t build the same flaw.',
      '<b>New work becomes a plan change</b> for you to approve. One idea can hold both.',
      '<b>Paste a screenshot</b> to show what you mean.',
    ])}`,
    anim: { frames: 6, ms: 1600, still: 4 }, figure: (phase) => ideaFigure(phase) },
  { id: 'new-idea', date: '2026-10-16', icon: 'idea', tone: 'warn',
    title: 'Start with an idea, not a plan',
    body: `<p><b>New job</b> is now <b>New idea</b>. Write what you’re after in your own words. If it’s clear, the planner plans it. If not, it asks what it needs to know, then suggests a job you create with one press.</p>${done([
      '<b>Ideas sit on the board</b> as forming skies, beside your jobs, until they become one. The <b>Ideas</b> filter shows just them.',
      '<b>Keep refining</b> as long as you like: a reply after a suggestion gets a fresh one.',
      '<b>Creating a suggested job approves its plan</b>, so it starts at once. A plan the planner drafts itself still waits for you with Plan on You review.',
    ])}`,
    anim: { frames: 9, ms: 1700, still: 3 }, figure: (phase) => ideasFigure(phase) },
  { id: 'wrangler-talk', date: '2026-10-21', icon: 'note', tone: 'run',
    title: 'Talk it through with Wrangler',
    body: `<p><b>Add idea</b> is now a conversation with <b>Wrangler</b>, the planner behind every job. Ask it something and it answers right there. Ask for a change and its proposal turns up in the same thread, ready to approve.</p>${done([
      '<b>Several conversations at once</b>, each with its own box. The box at the bottom starts a new one.',
      '<b>The job keeps running</b> while Wrangler thinks. Only the steps a change touches wait for it.',
      '<b>It tidies up after itself</b>: quiet conversations fold to a strip, approved proposals to one line, and × dismisses one.',
    ])}`,
    anim: { frames: 10, ms: 1700, still: 7 }, figure: (phase) => talkFigure(phase) },
];

const dateLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// `storage` is null in a test or on a board without it: then nothing opens by
// itself, since nothing could record that it had been seen.
export function createUpdates({ storage, updates = UPDATES }) {
  const ordered = [...updates].sort((a, b) => a.date.localeCompare(b.date));
  let dialog = null;
  let queue = [];
  let at = 0;
  let phase = 0;
  let timer = null;
  const win = () => document.defaultView;
  const still = () => !win() || !!win().matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function seen() {
    try { const ids = JSON.parse(storage?.get(SEEN_UPDATES_KEY) || '[]'); return new Set(Array.isArray(ids) ? ids : []); } catch { return new Set(); }
  }
  function markSeen(ids) {
    if (!storage) return;
    const all = seen();
    ids.forEach((id) => all.add(id));
    storage.set(SEEN_UPDATES_KEY, JSON.stringify([...all]));
  }
  const unseen = () => { const s = seen(); return ordered.filter((u) => !s.has(u.id)); };

  function build() {
    dialog = document.createElement('dialog');
    dialog.id = 'jobs-update';
    dialog.className = 'job-dialog jobs-update';
    dialog.setAttribute('aria-labelledby', 'jobs-update-title');
    dialog.innerHTML = `<button class="job-dialog-close" aria-label="Close" title="Close">${ICONS.x}</button>
      <div class="update-appbar"><span class="jobs-kicker">${W2} · WHAT’S NEW</span><time class="update-date"></time><span class="intro-count"></span></div>
      <div class="update-panel"></div>
      <div class="job-actions"><button class="primary" data-update="next"></button><button data-update="back">${ICONS.back}Back</button></div>`;
    document.body.appendChild(dialog);
    const go = (i) => { at = Math.max(0, Math.min(queue.length - 1, i)); phase = queue[at].anim && still() ? queue[at].anim.still ?? 0 : 0; render(); };
    dialog.querySelector('.job-dialog-close').onclick = () => dialog.close();
    dialog.querySelector('[data-update="back"]').onclick = () => go(at - 1);
    dialog.querySelector('[data-update="next"]').onclick = () => (at < queue.length - 1 ? go(at + 1) : dialog.close());
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && at < queue.length - 1) go(at + 1);
      if (e.key === 'ArrowLeft' && at > 0) go(at - 1);
    });
    // Every way out, from any update in the run, is the reader having seen the
    // whole run; a reload while it is still open is not.
    dialog.addEventListener('close', () => { stop(); releaseSkies(dialog.querySelector('.update-panel')); markSeen(queue.map((u) => u.id)); });
  }

  function render() {
    const u = queue[at];
    const last = at === queue.length - 1;
    const date = dialog.querySelector('.update-date');
    date.dateTime = u.date;
    date.textContent = dateLabel(u.date);
    dialog.querySelector('.intro-count').textContent = queue.length > 1 ? `${at + 1} of ${queue.length}` : '';
    dialog.querySelector('.update-panel').innerHTML = `${u.figure ? `<div class="intro-figure">${u.figure(phase)}</div>` : ''}<h2 id="jobs-update-title">${u.title}</h2><div class="update-body">${u.body}</div>`;
    const next = dialog.querySelector('[data-update="next"]');
    next.className = `primary tone-${last ? 'ok' : 'run'}`;
    next.innerHTML = last ? 'Got it' : `Next${ICONS.next}`;
    dialog.querySelector('[data-update="back"]').hidden = at === 0;
    mountSkies(dialog.querySelector('.update-panel'));
    play();
  }

  function play() {
    stop();
    const u = queue[at];
    if (!u.anim || still()) return;
    timer = win().setInterval(() => {
      phase = (phase + 1) % u.anim.frames;
      const fig = dialog.querySelector('.update-panel .intro-figure');
      if (fig) { patch(fig, u.figure(phase)); mountSkies(dialog.querySelector('.update-panel')); }
    }, u.anim.ms);
  }
  function stop() { if (timer) win()?.clearInterval(timer); timer = null; }

  function show(list) {
    if (!list.length) return false;
    if (!dialog || !dialog.isConnected) build();
    queue = list;
    at = 0;
    phase = list[0].anim && still() ? list[0].anim.still ?? 0 : 0;
    render();
    applyTheme(dialog);
    if (!dialog.open) dialog.showModal();
    return true;
  }

  return {
    // Newest first, for What's new.
    list() { const s = seen(); return [...ordered].reverse().map((u) => ({ ...u, seen: s.has(u.id) })); },
    open(id) { return show(ordered.filter((u) => u.id === id)); },
    // Every unseen update in one run, oldest first, so a reader a few releases
    // behind steps through them in the order they shipped.
    maybeShow() { return storage ? show(unseen()) : false; },
    markAllSeen() { markSeen(ordered.map((u) => u.id)); },
    remove() { stop(); dialog?.remove(); dialog = null; },
  };
}

// The What's new section of Automation settings: each row reopens its splash.
export function whatsNewHtml(items) {
  const rows = items.map((u) => `<li><button type="button" class="update-item tone-${u.tone || 'run'}" data-update-id="${u.id}"><span class="job-node-tile">${ICONS[u.icon] || ICONS.info}</span><span class="update-item-text"><strong>${u.title}</strong><time datetime="${u.date}">${dateLabel(u.date)}</time></span><span class="update-item-end">${u.seen ? '' : '<span class="update-new">NEW</span>'}${ICONS.next}</span></button></li>`).join('');
  return `<section class="update-section" aria-labelledby="job-settings-updates"><h3 id="job-settings-updates">What’s new</h3>${rows ? `<ul class="update-list">${rows}</ul>` : ''}</section>`;
}
