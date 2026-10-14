import { ICONS, ROCKET_PATH } from './icons.js';
import { layoutGraphEdges } from './job-graph.js';
import { CHECKPOINTS, checkpointFlagHtml, checkpointHint, checkpointToggleHtml } from './jobs.js';

// The "How Jobs works" walkthrough: shown once to every browser that has not
// dismissed it (installed today or long ago), then only on request from the Jobs
// header or Automation settings. The flag lives in the client api's `storage`,
// namespaced per extension by the board, so it is per browser rather than per
// install. Every string here is our own copy, never agent-written.
export const SEEN_KEY = 'introSeen';

const W2 = 'Wrangler<sup>2</sup>';
const node = (tone, icon, title, status, state, on = false) => `<div class="job-node tone-${tone}"><span class="job-node-tile${on ? ' on' : ''}">${ICONS[icon]}${state ? `<span class="job-node-state">${ICONS[state]}</span>` : ''}</span><span class="job-node-title">${title}</span>${status ? `<span class="job-status">${status}</span>` : ''}</div>`;
const jiraRow = (tone, icon, title, status, state, on = false) => `<div class="intro-jira-row tone-${tone}"><span class="job-node-tile${on ? ' on' : ''}">${ICONS[icon]}<span class="job-node-state">${ICONS[state]}</span></span><span><b>${title}</b><small>${status}</small></span></div>`;
const kind = (tone, icon, label) => `<div class="intro-kind tone-${tone}"><span class="job-node-tile">${ICONS[icon]}</span>${label}</div>`;

// The two live figures share the job-state.js vocabulary: [tone, state glyph, solid tile].
const ST = { planned: ['idle', 'planned', false], running: ['run', 'spin', true], review: ['warn', 'eye', true], deploying: ['run', 'rocket', true], done: ['ok', 'check', true] };
// Each frame names only what changes; later frames inherit the rest.
const scenes = (frames) => frames.reduce((acc, f) => [...acc, { ...acc.at(-1), ...f }], []);

// The Welcome figure: one job drawn with the stepper's own markup (job-graph.js
// planGraphHtml's classes, traced by its layoutGraphEdges), two PRs in parallel
// and a session that waits for both to deploy.
const SUBS = [
  { id: 'desk', kind: 'pr', title: 'First and last name in the desktop app', repo: 'acme/desktop' },
  { id: 'api', kind: 'pr', title: 'First and last name in the API', repo: 'acme/api' },
  { id: 'backfill', kind: 'robot', title: 'Backfill existing users', repo: 'agent session', after: ['desk', 'api'] },
];
const GRAPH = scenes([
  { goal: ['run', 'Planning'], desk: ['planned', 'Queued'], api: ['planned', 'Queued'], backfill: ['planned', 'Waits for both'] },
  { goal: ['run', '2 agents working'], desk: ['running', 'Writing the PR'], api: ['running', 'Writing the PR'] },
  { desk: ['running', 'Writing tests'], api: ['running', 'Writing tests'] },
  { desk: ['running', 'Tests passing'], api: ['running', 'Checks running'] },
  { goal: ['warn', 'Needs you'], desk: ['running', 'Checks passed'], api: ['review', 'Tests passed · review'] },
  { goal: ['run', '2 agents working'], desk: ['deploying', 'Merged · deploying'], api: ['running', 'Checks running'] },
  { goal: ['run', '1 agent working'], desk: ['done', 'Deployed'], api: ['deploying', 'Merged · deploying'] },
  { goal: ['run', '1 agent working'], api: ['done', 'Deployed'], backfill: ['running', 'Starting'] },
  { backfill: ['running', 'Splitting 48,210 names'] },
  { backfill: ['running', 'Spot-checking 50 accounts'] },
  { goal: ['ok', 'Delivered'], backfill: ['done', '48,210 users backfilled'] },
  {}, {},
]);
const GOAL_GLYPH = { ok: 'check', warn: 'eye', run: 'spin' };
function graph(phase) {
  const sc = GRAPH[phase];
  const tile = (s) => {
    const [state, line] = sc[s.id];
    const [tone, glyph, on] = ST[state];
    return `<div class="job-node tone-${tone}${state === 'done' ? ' done' : ''}" data-node="${s.id}" title="${s.repo}"><span class="job-node-tile${on ? ' on' : ''}">${ICONS[s.kind]}<span class="job-node-state">${ICONS[glyph]}</span></span><strong class="job-node-title">${s.title}</strong><span class="job-node-repo">${s.repo}</span><span class="job-status">${line}</span></div>`;
  };
  const edges = SUBS.flatMap((s) => (s.after || []).map((from) => `<path class="deploy${sc[from][0] === 'done' ? ' landed' : ''}" data-from="${from}" data-to="${s.id}"/><g class="job-edge-glyph" data-glyph="${from}>${s.id}"><circle r="12"/><g transform="translate(-9.6 -9.6) scale(.8)">${ROCKET_PATH}</g></g>`)).join('');
  const [tone, line] = sc.goal;
  return `<div class="intro-goal tone-${tone}"><span class="job-avatar">${ICONS[GOAL_GLYPH[tone]]}</span><strong>Split full name into first and last name</strong><span class="job-status">${line}</span></div>
    <div class="job-graph intro-graph" role="img" aria-label="One job: a pull request each in the desktop app and the API running in parallel, then a backfill session once both deploy"><div class="job-graph-canvas" style="--waves:2"><div class="job-graph-columns"><div class="job-graph-col">${tile(SUBS[0])}${tile(SUBS[1])}</div><div class="job-graph-col">${tile(SUBS[2])}</div></div><svg class="job-graph-edges" aria-hidden="true">${edges}</svg></div></div>`;
}

// The Jobs figure: a mini board whose rail badge and Needs me chip count its
// amber rows. Each frame is every job's [state, line, segments done].
const BOARD = [['CSV export', 3], ['Rotate secret', 3], ['Node 22', 4]];
const BOARD_FRAMES = [
  [['running', '2 agents working', 0], ['running', 'Writing the PR', 1], ['planned', 'Backlog', 0]],
  [['running', '2 agents working', 1], ['review', 'Ready for your review', 1], ['planned', 'Backlog', 0]],
  [['review', 'Tests passed · review', 1], ['review', 'Ready for your review', 1], ['running', '4 agents working', 0]],
  [['running', 'Checks running', 2], ['review', 'Ready for your review', 1], ['review', 'Green PR · merge?', 2]],
  [['running', 'Checks running', 2], ['deploying', 'Merged · deploying', 2], ['running', '3 agents working', 2]],
  [['done', 'Delivered', 3], ['done', 'Delivered', 3], ['running', '2 agents working', 3]],
  [['done', 'Delivered', 3], ['done', 'Delivered', 3], ['review', 'Check the backfill', 3]],
];
const needYou = (phase) => BOARD_FRAMES[phase].filter(([st]) => st === 'review').length;
function board(phase) {
  const need = needYou(phase);
  const bump = need && need !== needYou((phase || BOARD_FRAMES.length) - 1);
  const row = ([title, n], [state, line, done]) => {
    const [tone, glyph] = ST[state];
    const segs = Array.from({ length: n }, (_, i) => `<span class="job-seg ${i < done ? 'tone-ok' : i === done && state !== 'planned' && state !== 'done' ? `tone-${tone}` : 'tone-idle planned'}"></span>`).join('');
    return `<div class="intro-mini-job tone-${tone}"><span class="job-avatar">${ICONS[glyph]}</span><span><b>${title}</b><small>${line}</small></span><span class="job-progress">${segs}</span></div>`;
  };
  return `<div class="intro-mini-rail"><span class="intro-rail-btn">${ICONS.grid}</span><span class="intro-rail-btn">${ICONS.note}</span><span class="intro-rail-btn on">${ICONS.jobs}<span class="intro-rail-badge${need ? (bump ? ' bump' : '') : ' zero'}">${need}</span></span></div>
    <div class="intro-mini-jobs"><header>Jobs<span class="intro-chip-on">${ICONS.eye}Needs me <span class="intro-count-pill">${need}</span></span></header>${BOARD.map((j, i) => row(j, BOARD_FRAMES[phase][i])).join('')}</div>`;
}

// The checkpoints are a picture the reader can poke, not settings: each job sets
// its own on the New job form. The toggles' names keep them out of any form's fields.
const YOU = `<b class="intro-cp you">${ICONS.hand}You review</b>`;
const AUTO = `<b class="intro-cp">${ICONS.ff}Auto</b>`;
const checkpointsFigure = (reviews) => `<div class="intro-checkpoints">${CHECKPOINTS.map((cp) => `<div class="job-review intro-checkpoint" data-checkpoint="${cp.field}"><div class="job-review-row">${checkpointFlagHtml(cp, reviews[cp.field])}<span class="job-review-name">${cp.name}<small>${checkpointHint(cp, reviews[cp.field])}</small></span>${checkpointToggleHtml(cp, reviews[cp.field], `intro-${cp.field}`)}</div></div>`).join('')}</div>`;

// `anim` steps redraw their figure every `ms`; `still` is the frame shown with
// reduced motion. `stack` puts the figure under the heading at full width.
export const INTRO_STEPS = [
  { tab: 'Welcome', title: 'Welcome', body: '', stack: true, cls: 'intro-value',
    anim: { frames: GRAPH.length, ms: 1400, still: GRAPH.length - 1 },
    figure: (reviews, phase) => graph(phase) },
  { tab: 'Jobs', title: `Hand ${W2} an outcome. It splits the work and tracks it for you.`,
    body: `<p>${W2} adds <b>automated jobs</b> to Agent Wrangler. You describe a goal; it splits the goal into sub-jobs, starts agent sessions for them, and stops for you wherever you’ve asked to review.</p><p>Everything lives behind the <b>Jobs</b> button in the left rail. The number on it is how many things are waiting on you, wherever you are on the board.</p>`,
    cls: 'intro-board', anim: { frames: BOARD_FRAMES.length, ms: 1600, still: 2 },
    figure: (reviews, phase) => board(phase) },
  { tab: 'New job', title: 'New job, then a plan you approve before anything runs.',
    body: `<p>Press <b>New job</b> and write the outcome you want. ${W2} drafts a <b>plan</b>, splitting work into ordered tasks.</p><p>Iterate on the plan until you’re happy, then <b>Approve</b>. By default nothing runs before you approve: no session, ticket or PR. If you trust a job, set its Plan checkpoint to Auto and it starts as soon as the plan is drafted. You can also save a job to the backlog and start it later.</p>`,
    figure: () => `<div class="intro-flow">${node('ok', 'edit', 'Describe', 'Done', 'check')}<span class="intro-flow-line"></span>${node('run', 'robot', 'Plan', 'Planning', 'spin', true)}<span class="intro-flow-line"></span>${node('warn', 'eye', 'Approve', 'Needs you', 'eye')}</div>` },
  { tab: 'Sub-jobs', title: 'Four kinds of sub-job for every kind of task.',
    body: '<p>The kind sits on the corner of every tile in the stepper. Hover a tile to see what it is.</p><p>A <b>PR</b> works in a worktree, opens a pull request, waits for checks, merges and confirms the deploy. A <b>session</b> runs on this machine with no pull request. A <b>human</b> step is yours alone, and the job waits for it. A <b>Jira</b> step creates or updates tickets.</p>',
    figure: () => `<div class="intro-kinds">${kind('run', 'pr', 'PR')}${kind('run', 'robot', 'Session')}${kind('warn', 'person', 'Human')}${kind('idle', 'story', 'Jira')}</div>` },
  { tab: 'Needs you', title: 'Amber means it is waiting on you.',
    body: `<p>Each job is a card coloured by its state: blue while agents work, <b>amber when it needs you</b>, red when something failed, green when delivered. A job turns amber at each checkpoint you marked ${YOU}, and whenever an agent is stuck and needs your decision.</p><p>The <b>Needs me</b> chip filters the board down to those cards, and the rail badge counts them from any view. Open a card to see the plan, the agent’s receipt and the moves you can make.</p>`,
    figure: () => `<article class="job-card tone-warn"><div class="job-card-open"><span class="job-avatar">${ICONS.eye}</span><strong>Rotate the staging client secret</strong></div><div class="job-progress"><span class="job-seg tone-ok">${ICONS.check}</span><span class="job-seg tone-warn">${ICONS.eye}</span><span class="job-seg tone-idle planned">${ICONS.planned}</span></div><footer><span class="job-status">Ready for your review</span><span class="job-card-cost">$1.84</span></footer></article><div class="job-chips"><span class="intro-chip-on">${ICONS.eye}Needs me <span class="intro-count-pill">2</span></span><span class="job-chip job-chip-state tone-bad">${ICONS.x}<span>Checks failing</span></span></div>` },
  { tab: 'Receipts', title: 'Sloptimized: don’t read another line of slop.',
    body: '<p>Every agent ends its step with a <b>receipt</b>: a few bullets of a few words each, like a quick update from another developer. A blocked step is one sentence that names the move it suggests.</p><p>PR comments are summed up as a green, amber or red verdict. Explanations sit in tooltips and folded sections, so the full transcript is there when you want it and out of the way when you don’t.</p>',
    figure: () => `<span class="intro-label">Without it</span><div class="intro-slop" aria-hidden="true">You’re right to ask. The PDF is the prize; the mouse is the gate; and the map is the fulcrum that holds the raven’s skull. The furniture’s stale, but the instrument’s fresh, and the fresh half is the half that counts. I deleted your home directory.</div><span class="intro-label">With ${W2}</span><ul class="job-receipt"><li><span>✓</span>Build passed</li><li><span>✓</span>Tests passed</li><li><span>✓</span>Expired links rejected</li></ul>` },
  { tab: 'Reviews', title: 'You choose where a job stops for you.',
    body: `<p>Every job has five review checkpoints: the plan, the code, the merge, session results, and writes to Jira, Slack, Confluence or other places. Set one to ${YOU} and that step turns amber and waits for you. Set it to ${AUTO} and ${W2} carries on by itself. You choose them on each New job form; all but Writes start on You review.</p><p>To stop everything at once, press <b>Pause</b> in the Jobs header. No new work starts until you resume.</p>`,
    figure: (reviews) => checkpointsFigure(reviews) },
  { tab: 'Jira', title: `Work with tickets? ${W2} has you covered.`,
    body: `<p>When you work with tickets, ${W2} will notice and suggest when you need a new ticket, or when your existing tickets can be marked as Done. Jobs without tickets skip Jira entirely.</p><p>Every write is made by a session in the plan, which reports each one as <b>written</b>, <b>already</b> done or <b>failed</b> with Jira’s own error; a write you review is drafted first and waits for you.</p>`,
    figure: () => `<div class="intro-jira">${jiraRow('ok', 'story', 'Create ZCT-7', 'Written', 'check', true)}${jiraRow('run', 'pr', 'Fix it in a PR', 'Working', 'spin', true)}${jiraRow('idle', 'story', 'Comment the PR link', 'After the PR', 'planned')}${jiraRow('idle', 'story', 'Move ZCT-7 to Done', 'After it merges', 'planned')}</div><span class="job-chip job-chip-state tone-warn intro-start">${ICONS.eye}<span>Suggests: new ticket for the follow-up</span></span>` },
  { tab: 'Start', title: 'You’re ready to start a job.',
    body: `<p>Start with something small you would normally hand to one agent, so you can watch each step once.</p><ul class="intro-done">${['Jobs in the rail, with the needs-you count', 'New job, then approve the plan', 'PR, session, human and Jira sub-jobs', 'Short receipts instead of walls of text', `Review checkpoints you set per job: ${YOU} or ${AUTO}`].map((t) => `<li>${ICONS.check}${t}</li>`).join('')}</ul><p>Open this again from the ${ICONS.info} button in the Jobs header, or from <b>Automation settings</b>.</p>`,
    figure: () => `<div class="intro-flow">${node('ok', 'pr', 'Add CSV export', 'Delivered', 'check', true)}<span class="intro-flow-line"></span>${node('ok', 'robot', 'Backfill data', 'Delivered', 'check', true)}</div>` },
];

// `storage` is the client api's namespaced storage (null in a test, or on a board
// without it: then the intro never opens by itself, since nothing could record
// that it had been seen). `onNewJob` is the last step's button; `onClose` runs on
// every way out.
export function createIntro({ storage, onNewJob = () => {}, onClose = () => {} }) {
  let dialog = null;
  let at = 0;
  let timer = null;
  let playing = -1;
  const phases = INTRO_STEPS.map(() => 0);
  const reviews = { reviewPlan: true, reviewCode: true, reviewMerge: false, reviewSessions: true, reviewWrites: false };
  const win = () => document.defaultView;
  const still = () => !win() || !!win().matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const relayout = () => layoutGraphEdges(dialog?.querySelector('.intro-graph'));

  function build() {
    dialog = document.createElement('dialog');
    dialog.id = 'jobs-intro';
    dialog.className = 'job-dialog jobs-intro';
    dialog.setAttribute('aria-labelledby', 'jobs-intro-title');
    dialog.innerHTML = `<button class="job-dialog-close" aria-label="Close" title="Close">${ICONS.x}</button>
      <div class="job-appbar intro-appbar"><span class="jobs-kicker">WRANGLER<sup>2</sup> · AUTOMATED JOBS</span><span class="intro-count"></span></div>
      <div class="job-progress intro-steps" role="tablist" aria-label="Intro steps"></div>
      <div class="intro-body"></div>
      <div class="job-actions"><button class="primary" data-intro="next"></button><button data-intro="back">${ICONS.back}Back</button><button data-intro="skip">Skip intro</button></div>`;
    document.body.appendChild(dialog);
    const go = (i) => { at = Math.max(0, Math.min(INTRO_STEPS.length - 1, i)); render(); };
    dialog.querySelector('.job-dialog-close').onclick = () => dialog.close();
    dialog.querySelector('[data-intro="skip"]').onclick = () => dialog.close();
    dialog.querySelector('[data-intro="back"]').onclick = () => go(at - 1);
    dialog.querySelector('[data-intro="next"]').onclick = () => {
      if (at < INTRO_STEPS.length - 1) return go(at + 1);
      dialog.close();
      onNewJob();
    };
    dialog.querySelector('.intro-steps').onclick = (e) => { const b = e.target.closest('[data-go]'); if (b) go(+b.dataset.go); };
    dialog.querySelector('.intro-body').onchange = (e) => {
      const field = e.target.closest('[data-checkpoint]')?.dataset.checkpoint;
      if (!field) return;
      reviews[field] = e.target.checked;
      render();
      dialog.querySelector(`[name="intro-${field}"]`).focus();
    };
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && at < INTRO_STEPS.length - 1) go(at + 1);
      if (e.key === 'ArrowLeft' && at > 0) go(at - 1);
    });
    // Every way out (close, Skip, Escape, finishing) is the reader saying they
    // have seen it; a reload while it is still open is not.
    dialog.addEventListener('close', () => { stop(); storage?.set(SEEN_KEY, '1'); onClose(); });
    win()?.addEventListener('resize', relayout);
  }

  // Every step is laid out in the same grid cell, so the dialog takes the tallest
  // one's height and the buttons never move as the reader steps through.
  function render() {
    const last = at === INTRO_STEPS.length - 1;
    dialog.querySelector('.intro-count').textContent = `${at + 1} of ${INTRO_STEPS.length}`;
    dialog.querySelector('.intro-steps').innerHTML = INTRO_STEPS.map((s, i) => `<button type="button" class="job-seg tone-ok${i <= at ? '' : ' planned'}" role="tab" aria-selected="${i === at}" data-go="${i}"><span>${s.tab}</span></button>`).join('');
    dialog.querySelector('.intro-body').innerHTML = INTRO_STEPS.map((s, i) => `<div class="intro-panel${s.stack ? ' intro-stack' : ''}"${i === at ? '' : ' inert aria-hidden="true"'}><div><h2${i === at ? ' id="jobs-intro-title"' : ''}>${s.title}</h2>${s.body}</div><div class="intro-figure ${s.cls || ''}">${s.figure(reviews, phases[i])}</div></div>`).join('');
    const next = dialog.querySelector('[data-intro="next"]');
    next.className = `primary tone-${last ? 'ok' : 'run'}`;
    next.innerHTML = last ? `${ICONS.plus}New job` : `Next${ICONS.next}`;
    dialog.querySelector('[data-intro="back"]').hidden = at === 0;
    dialog.querySelector('[data-intro="skip"]').hidden = last;
    relayout();
    play();
  }

  // Only the current step's figure is redrawn per frame, so focus and the other
  // panels are untouched; with reduced motion each live figure holds its `still`.
  function play() {
    const anim = INTRO_STEPS[at].anim;
    if (timer && playing === at) return;
    stop();
    if (!anim || still()) return;
    playing = at;
    timer = win().setInterval(() => {
      phases[at] = (phases[at] + 1) % anim.frames;
      const fig = dialog.querySelectorAll('.intro-panel')[at]?.querySelector('.intro-figure');
      if (fig) fig.innerHTML = INTRO_STEPS[at].figure(reviews, phases[at]);
      relayout();
    }, anim.ms);
  }
  function stop() { if (timer) win()?.clearInterval(timer); timer = null; playing = -1; }

  function open(step = 0) {
    if (!dialog || !dialog.isConnected) build();
    at = step;
    const reduce = still();
    INTRO_STEPS.forEach((s, i) => { phases[i] = reduce ? s.anim?.still ?? 0 : 0; });
    stop();
    render();
    if (!dialog.open) dialog.showModal();
    relayout();
  }

  return {
    open,
    maybeShow() { if (!storage || storage.get(SEEN_KEY)) return false; open(0); return true; },
    remove() { stop(); win()?.removeEventListener('resize', relayout); dialog?.remove(); dialog = null; },
  };
}
