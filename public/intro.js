import { ICONS } from './icons.js';
import { layoutGraphEdges, rocketHtml } from './job-graph.js';
import { CHECKPOINTS, checkpointFlagHtml, checkpointHint, checkpointToggleHtml } from './jobs.js';
import { composer, proofFigure, runningBar } from './figs.js';
import { ideaThreadHtml } from './job-idea.js';
import { inflowHtml, holdSkies, mountSkies, releaseSkies } from './job-skylines.js';
import { applyTheme } from './themes.js';

// The "How Jobs works" walkthrough: shown once to every browser that has not
// dismissed it (installed today or long ago), then only on request from the Jobs
// header or Automation settings. The flag lives in the client api's `storage`,
// namespaced per extension by the board, so it is per browser rather than per
// install. Every string here is our own copy, never agent-written.
export const SEEN_KEY = 'introSeen';

const W2 = 'Wrangler<sup>2</sup>';
const node = (tone, icon, title, status, state, on = false) => `<div class="job-node tone-${tone}"><span class="job-node-tile${on ? ' on' : ''}">${ICONS[icon]}${state ? `<span class="job-node-state">${ICONS[state]}</span>` : ''}</span><span class="job-node-title">${title}</span>${status ? `<span class="job-status">${status}</span>` : ''}</div>`;
const writeRow = (tone, icon, title, status, state, on = false) => `<div class="intro-jira-row tone-${tone}"><span class="job-node-tile${on ? ' on' : ''}">${ICONS[icon]}<span class="job-node-state">${ICONS[state]}</span></span><span><b>${title}</b><small>${status}</small></span></div>`;
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
  const edges = SUBS.flatMap((s) => (s.after || []).map((from) => `<path class="deploy${sc[from][0] === 'done' ? ' landed' : ''}" data-from="${from}" data-to="${s.id}"/>`)).join('') + SUBS.filter((s) => SUBS.some((t) => t.after?.includes(s.id))).map((s) => rocketHtml(s.id)).join('');
  const [tone, line] = sc.goal;
  return `<div class="intro-goal tone-${tone}"><span class="job-avatar">${ICONS[GOAL_GLYPH[tone]]}</span><strong>Split full name into first and last name</strong><span class="job-status">${line}</span></div>
    <div class="job-graph intro-graph" role="img" aria-label="One job: a pull request each in the desktop app and the API running in parallel, then a backfill session once both deploy"><div class="job-graph-canvas" style="--waves:2"><div class="job-graph-columns"><div class="job-graph-col" data-col="0">${tile(SUBS[0])}${tile(SUBS[1])}</div><div class="job-graph-col" data-col="1">${tile(SUBS[2])}</div></div><svg class="job-graph-edges" aria-hidden="true">${edges}</svg></div></div>`;
}

// The Jobs figure: a mini board whose rail badge and Needs me chip count its
// amber rows. Each frame is every job's [state, line, segments done]; the first
// row is an idea, drawn under its forming sky (job-skylines.js inflowHtml) while
// the planner talks it through, then the job it became.
const BOARD = [['Dark mode for reports', 3], ['CSV export', 3], ['Rotate secret', 3], ['Node 22', 4]];
const IDEA = { thinking: ['idle', 0, 'Planner is reading it'], reply: ['warn', 1, 'The planner asked you'], suggested: ['warn', 2, 'Job suggested · review'] };
const BOARD_FRAMES = [
  [['thinking'], ['running', '2 agents working', 0], ['running', 'Writing the PR', 1], ['planned', 'Backlog', 0]],
  [['thinking'], ['running', '2 agents working', 1], ['review', 'Ready for your review', 1], ['planned', 'Backlog', 0]],
  [['reply'], ['review', 'Tests passed · review', 1], ['review', 'Ready for your review', 1], ['running', '4 agents working', 0]],
  [['thinking'], ['running', 'Checks running', 2], ['review', 'Ready for your review', 1], ['review', 'Green PR · merge?', 2]],
  [['suggested'], ['running', 'Checks running', 2], ['deploying', 'Merged · deploying', 2], ['running', '3 agents working', 2]],
  [['running', 'Starting its sub-jobs', 0], ['done', 'Delivered', 3], ['done', 'Delivered', 3], ['running', '2 agents working', 3]],
  [['running', '2 agents working', 0], ['done', 'Delivered', 3], ['done', 'Delivered', 3], ['review', 'Check the backfill', 3]],
];
const waits = ([st]) => st === 'review' || IDEA[st]?.[0] === 'warn';
const needYou = (phase) => BOARD_FRAMES[phase].filter(waits).length;
function board(phase) {
  const need = needYou(phase);
  const bump = need && need !== needYou((phase || BOARD_FRAMES.length) - 1);
  const idea = ([title], [stage]) => {
    const [tone, sky, line] = IDEA[stage];
    return `<div class="intro-mini-job intro-mini-idea tone-${tone}"><span class="intro-mini-sky">${inflowHtml('intro-idea', sky)}</span><span><b>${title}</b><small><span class="job-idea-mark">Idea</span> · ${line}</small></span></div>`;
  };
  const row = ([title, n], [state, line, done]) => {
    if (IDEA[state]) return idea([title], [state]);
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

// New idea: the idea, the planner's question and the job it suggests, drawn by
// job-idea.js itself, then the job it starts: pressing the suggestion approves its plan. The chat is a fixed
// window that keeps its newest message at the foot, so the dialog never grows.
const SUGGEST = { title: 'Dark mode for the reports dashboard', plan: { subJobs: [
  { id: 'tokens', kind: 'pr', title: 'Dark theme colours in the UI kit', repo: 'acme/ui-kit', base: 'next' },
  { id: 'toggle', kind: 'pr', title: 'Theme toggle on the dashboard', repo: 'acme/reports', base: 'next', after: ['tokens'] },
  { id: 'check', kind: 'session', title: 'Check every chart in both themes', after: ['toggle'] },
] } };
const SAID = [
  { id: 'q', from: 'planner', text: 'Should it follow the system setting, or have its own switch? And which branch should it land on?' },
  { id: 'a', from: 'human', sentAt: 1, text: 'Follow the system, with a switch to override it. Land it on next.' },
  { id: 's', from: 'planner', text: 'Here is a job for that: the colours first, then the switch, then a check of every chart.', suggest: SUGGEST },
];
// [messages said, planner thinking, suggestion pressed, plan shown, flow states]
const IDEA_FRAMES = [
  [0, true, false, false, ['run', 'ok', 'idle']],
  [1, false, false, false, ['warn', 'ok', 'idle']],
  [2, true, false, false, ['run', 'ok', 'idle']],
  [3, false, false, false, ['warn', 'ok', 'idle']],
  [3, false, true, false, ['ok', 'ok', 'run']],
  [3, false, true, true, ['ok', 'ok', 'run']],
  [3, false, true, true, ['ok', 'ok', 'run']],
];
const FLOW = { ok: ['check', 'Done'], run: ['spin', 'Working'], warn: ['eye', 'Needs you'], idle: ['planned', 'Next'] };
const flowNode = (tone, icon, title) => node(tone, icon, title, FLOW[tone][1], FLOW[tone][0], tone !== 'idle');
const newIdeaFigure = (phase) => {
  const [n, thinking, pressed, plan, [talk, , start]] = IDEA_FRAMES[phase];
  const thread = SAID.slice(0, n).map((m) => (m.suggest && pressed ? { ...m, acceptedAt: 1 } : m));
  const job = { id: 'intro-idea', intent: 'Add a dark mode to the reports dashboard', idea: { thread }, stage: 'planning', runs: thinking ? [] : [{ parkedFor: 'idea', parkedAt: 1 }], reviewPlan: true };
  const fresh = (id) => id === SAID[n - 1]?.id && !pressed;
  return `<div class="intro-flow">${flowNode('ok', 'edit', 'Idea')}<span class="intro-flow-line"></span>${flowNode(talk, 'robot', 'Planner')}<span class="intro-flow-line"></span>${flowNode(start, 'play', 'Job')}</div>
  <div class="intro-chat" inert>${ideaThreadHtml(job, { fresh })}${plan ? `<div class="intro-chat-plan"><div class="job-chips"><span class="job-chip job-plan-branch">${ICONS.branch}<span>next</span></span><span class="job-chip">${ICONS.pr}<span>2 PRs · 1 session</span></span></div>
  ${composer('Planner', 'Add an idea for the planner…', 'Sorts it into feedback for a step or a change to the plan.', 'Design the switch first')}</div>` : ''}</div>`;
};

// Sub-jobs: three kinds of tile, and the places a session writes to as pills.
const placePill = (icon, label, tone = 'idle', on = false) => `<span class="job-place-chip">${ICONS[icon]}<b>${label}</b><span class="job-place-dots"><span class="job-place-dot tone-${tone}${on ? ' on' : ''}"></span></span></span>`;
const kindsFigure = () => `<div class="intro-kinds">${kind('run', 'pr', 'PR')}${kind('run', 'robot', 'Session')}${kind('warn', 'person', 'Human')}</div>
  <span class="intro-label">Places a session writes to</span>
  <div class="job-places intro-places">${placePill('ticket', 'Jira')}${placePill('slack', 'Slack')}${placePill('confluence', 'Confluence')}${placePill('sparkle', 'Artifact')}${placePill('file', 'File')}${placePill('globe', 'Web page')}</div>`;

// Needs you: one card going red, Wrangler fixing it while it is not counted, then the fix waiting on you.
const RED = [
  { tone: 'warn', glyph: 'eye', seg: ['warn', 'eye'], line: 'Ready for your review', need: 1, chip: null },
  { tone: 'bad', glyph: 'x', seg: ['bad', 'x'], line: 'Checks failing', need: 1, chip: ['bad', 'x', 'Checks failing'] },
  { tone: 'run', glyph: 'spin', seg: ['run', 'spin'], line: 'Fixing · try 1 of 2', need: 0, chip: ['run', 'wrench', 'Wrangler is fixing it'] },
  { tone: 'run', glyph: 'spin', seg: ['run', 'spin'], line: 'Fixing · try 1 of 2', need: 0, chip: ['run', 'wrench', 'Only this step and the next wait'] },
  { tone: 'warn', glyph: 'eye', seg: ['warn', 'eye'], line: 'Fix ready · Review fix', need: 1, chip: ['warn', 'eye', 'Fix ready'] },
  { tone: 'warn', glyph: 'eye', seg: ['warn', 'eye'], line: 'Fix ready · Review fix', need: 1, chip: ['warn', 'eye', 'Fix ready'] },
];
const needsFigure = (phase) => {
  const f = RED[phase];
  return `<article class="job-card tone-${f.tone}"><div class="job-card-open"><span class="job-avatar">${ICONS[f.glyph]}</span><strong>Rotate the staging client secret</strong></div><div class="job-progress"><span class="job-seg tone-ok">${ICONS.check}</span><span class="job-seg tone-${f.seg[0]}">${ICONS[f.seg[1]]}</span><span class="job-seg tone-idle planned">${ICONS.planned}</span></div><footer><span class="job-status">${f.line}</span><span class="job-card-cost">$1.84</span></footer></article><div class="job-chips"><span class="intro-chip-on">${ICONS.eye}Needs me <span class="intro-count-pill">${f.need + 1}</span></span>${f.chip ? `<span class="job-chip job-chip-state tone-${f.chip[0]}">${ICONS[f.chip[1]]}<span>${f.chip[2]}</span></span>` : ''}</div>`;
};

// See it working: the proof checklist filling in, then the preview left running.
const SEE = [[0, 'none'], [1, 'none'], [2, 'none'], [3, 'on'], [3, 'on'], [3, 'on']];
// Inert: the board's own cards and bar carry buttons and a link that do nothing here.
const seeFigure = (phase) => `<div class="intro-inert" inert>${proofFigure(SEE[phase][0])}${runningBar(SEE[phase][1])}</div>`;

// Writes: a design to approve, then a ticket moved and the team told, each with its receipt.
const WRITES = scenes([
  { a: ['run', 'spin', 'Publishing', true], t: ['idle', 'planned', 'Queued'], d: ['idle', 'planned', 'After it merges'], s: ['idle', 'planned', 'After the ticket'] },
  { a: ['ok', 'check', 'Written <u>Claude artifact ↗</u>', true], t: ['run', 'spin', 'Writing', true] },
  { t: ['ok', 'check', 'Written <u>WEB-214 ↗</u>', true] },
  { d: ['run', 'spin', 'Writing', true] },
  { d: ['ok', 'check', 'Already done', true], s: ['run', 'spin', 'Writing', true] },
  { s: ['ok', 'check', 'Written <u>#team-web ↗</u>', true] },
  {},
]);
const writesFigure = (phase) => {
  const row = ([tone, state, line, on], icon, title) => writeRow(tone, icon, title, line, state, on);
  const f = WRITES[phase];
  return `<div class="intro-jira">${row(f.a, 'sparkle', 'Publish the design for you to approve')}${row(f.t, 'ticket', 'Create WEB-214 with the design linked')}${row(f.d, 'ticket', 'Move WEB-214 to Done')}${row(f.s, 'slack', 'Post in #team-web: what changed')}</div>`;
};

// `anim` steps redraw their figure every `ms`; `still` is the frame shown with
// reduced motion. `stack` puts the figure under the heading at full width.
export const INTRO_STEPS = [
  { tab: 'Welcome', title: 'Welcome', body: `<p>${W2} breaks work into AI sessions and PRs, provides proof that changes work, and allows you to get more done in parallel.</p>`, stack: true, cls: 'intro-value',
    anim: { frames: GRAPH.length, ms: 1400, still: GRAPH.length - 1 },
    figure: (reviews, phase) => graph(phase) },
  { tab: 'Jobs', title: `Hand ${W2} an outcome. It splits the work and tracks it for you.`,
    body: `<p>You describe a goal; ${W2} splits it into sub-jobs, starts agent sessions for them, and stops for you wherever you’ve asked to review.</p><p>Everything lives behind the <b>Jobs</b> button in the left rail. The number on it is how many things are waiting on you, wherever you are on the board. An idea you are still talking through sits there too, marked <b>Idea</b>, until it becomes a job.</p>`,
    cls: 'intro-board', anim: { frames: BOARD_FRAMES.length, ms: 1600, still: 2 },
    figure: (reviews, phase) => board(phase) },
  { tab: 'New idea',
    title: 'New idea, then a plan you approve before anything runs.',
    body: `<p>Press <b>New idea</b> and describe the outcome, in words or with screenshots. If it is unclear, the planner asks you, then suggests a job; if it is clear, ${W2} drafts the <b>plan</b> straight away. It picks the branch each PR lands on from what you wrote, like “land it on next”.</p><p>A drafted plan is ordered sub-jobs. To change it, write in <b>Add idea</b> under it. Nothing runs until you <b>Approve</b>: no session, ticket or PR. A suggested job needs no second look: pressing <b>Create job</b> approves its plan and starts it. You can also save an idea to the backlog and come back to it.</p>`,
    cls: 'intro-idea', anim: { frames: IDEA_FRAMES.length, ms: 1700, still: 5 },
    figure: (reviews, phase) => newIdeaFigure(phase) },
  { tab: 'Sub-jobs',
    title: 'Three kinds of sub-job, and the places they write to.',
    body: '<p>The kind sits on the corner of every tile in the stepper. Hover a tile to see what it is.</p><p>A <b>PR</b> works in a worktree, shows you it working, opens a pull request, waits for checks, merges and confirms the deploy. A <b>session</b> runs on this machine with no pull request. A <b>human</b> step is yours alone, and the job waits for it.</p><p>A session can also write to places outside the board: a Jira ticket, a Slack channel, a Confluence page, or a Claude artifact it publishes. Each place is a pill under the session that writes to it.</p>',
    figure: () => kindsFigure() },
  { tab: 'Needs you',
    title: 'Amber means it is waiting on you.',
    body: `<p>Each job is a card coloured by its state: blue while agents work, <b>amber when it needs you</b>, red when something failed, green when delivered. A job turns amber at each checkpoint you marked ${YOU}, and whenever an agent needs your decision. The <b>Needs me</b> chip filters the board down to those cards.</p><p>Red goes to ${W2}’s planner first. It fixes the step or changes the plan while the rest of the job carries on, and only that step and the ones after it wait. If it can’t, the step is <b>declared red</b> and waits for you to decide.</p>`,
    anim: { frames: RED.length, ms: 1500, still: 4 },
    figure: (reviews, phase) => needsFigure(phase) },
  { tab: 'Receipts',
    title: 'Sloptimized: don’t read another line of slop.',
    body: '<p>Every agent ends its step with a <b>receipt</b>: a few bullets of a few words each, like a quick update from another developer. A blocked step is one sentence saying what stopped it.</p><p>PR comments are summed up as a green, amber or red verdict. Explanations sit in tooltips and folded sections, so the full transcript is there when you want it and out of the way when you don’t.</p>',
    figure: () => `<span class="intro-label">Without it</span><div class="intro-slop" aria-hidden="true">You’re right to ask. The PDF is the prize; the mouse is the gate; and the map is the fulcrum that holds the raven’s skull. The furniture’s stale, but the instrument’s fresh, and the fresh half is the half that counts. I deleted your home directory.</div><span class="intro-label">With ${W2}</span><ul class="job-receipt"><li><span>✓</span>Build passed</li><li><span>✓</span>Tests passed</li><li><span>✓</span>Expired links rejected</li></ul>` },
  { tab: 'See it working',
    title: 'See each PR working before you read its diff.',
    body: `<p>The plan lists what each PR must <b>show you</b>, and you can edit the list. The agent captures each item from the running build, as a screenshot, a recording or a command’s output, before anything is committed.</p><p>What it started stays <b>running for you</b> to try. Ask its session about it, or for a change, in <b>Add idea</b>: it stays open while you review and answers from what it built. Approve, and ${W2} stops everything it started.</p>`,
    cls: 'intro-see', anim: { frames: SEE.length, ms: 1300, still: 3 },
    figure: (reviews, phase) => seeFigure(phase) },
  { tab: 'Reviews',
    title: 'You choose where a job stops for you.',
    body: `<p>Every job has six checkpoints: the plan, local verification, the merge, session results, writes to other places, and red steps. Set one to ${YOU} and that step turns amber and waits for you. Set it to ${AUTO} and ${W2} carries on by itself, so a Plan on Auto starts as soon as it is drafted. For red steps you choose <b>You decide</b> or <b>Wrangler replans</b>.</p><p>New idea starts from the defaults in <b>Automation settings</b>, where all but Writes start on You review. To stop everything at once, press <b>Pause</b> in the Jobs header.</p>`,
    figure: (reviews) => checkpointsFigure(reviews) },
  { tab: 'Writes',
    title: 'Tickets, designs and posts, kept up to date as the job runs.',
    body: `<p>Sessions in the plan publish a design for you to approve, open the ticket, move it to Done when the PR merges, and tell the team. Nothing is written that the plan doesn’t list, and jobs without tickets skip Jira entirely.</p><p>Every write gets a receipt: <b>written</b>, <b>already</b> done, or <b>failed</b> with the place’s own error. With Writes on ${YOU}, you get a draft to edit, write or skip first.</p>`,
    anim: { frames: WRITES.length, ms: 1400, still: 5 },
    figure: (reviews, phase) => writesFigure(phase) },
  { tab: 'Start',
    title: 'You’re ready to start a job.',
    body: `<p>Start with something small you would normally hand to one agent, so you can watch each step once.</p><ul class="intro-done">${['Jobs in the rail, with the needs-you count', 'New idea: talk it through with the planner, then approve the plan', 'PR, session and human sub-jobs, and the places they write to', 'Short receipts, and each PR shown working', 'Red steps go to the planner before you', `Six checkpoints you set per job: ${YOU} or ${AUTO}`].map((t) => `<li>${ICONS.check}${t}</li>`).join('')}</ul><p>Open this again from the ${ICONS.info} button in the Jobs header, or from <b>Automation settings</b>.</p>`,
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
  const reviews = { reviewPlan: true, reviewCode: true, reviewMerge: false, reviewSessions: true, reviewWrites: false, reviewRed: true };
  const win = () => document.defaultView;
  const still = () => !win() || !!win().matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // The idea skies are painted by job-skylines.js, kept across each frame's redraw under the one body.
  const relayout = () => { layoutGraphEdges(dialog?.querySelector('.intro-graph')); if (dialog) mountSkies(dialog.querySelector('.intro-body')); };

  function build() {
    dialog = document.createElement('dialog');
    dialog.id = 'jobs-intro';
    dialog.className = 'job-dialog jobs-intro';
    dialog.setAttribute('aria-labelledby', 'jobs-intro-title');
    dialog.innerHTML = `<button class="job-dialog-close" aria-label="Close" title="Close">${ICONS.x}</button>
      <div class="job-appbar intro-appbar"><span class="jobs-kicker">WRANGLER<sup>2</sup> · A NEW WAY OF WORKING WITH AI</span><span class="intro-count"></span></div>
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
    dialog.addEventListener('close', () => { stop(); releaseSkies(dialog.querySelector('.intro-body')); storage?.set(SEEN_KEY, '1'); onClose(); });
    win()?.addEventListener('resize', relayout);
  }

  // Every step is laid out in the same grid cell, so the dialog takes the tallest
  // one's height and the buttons never move as the reader steps through.
  function render() {
    const last = at === INTRO_STEPS.length - 1;
    dialog.querySelector('.intro-count').textContent = `${at + 1} of ${INTRO_STEPS.length}`;
    dialog.querySelector('.intro-steps').innerHTML = INTRO_STEPS.map((s, i) => `<button type="button" class="job-seg tone-ok${i <= at ? '' : ' planned'}" role="tab" aria-selected="${i === at}" data-go="${i}"><span>${s.tab}</span></button>`).join('');
    holdSkies(dialog.querySelector('.intro-body'));
    dialog.querySelector('.intro-body').innerHTML = INTRO_STEPS.map((s, i) => `<div class="intro-panel${s.stack ? ' intro-stack' : ''}"${i === at ? '' : ' inert aria-hidden="true"'}><div><h2${i === at ? ' id="jobs-intro-title"' : ''}>${s.title}</h2>${s.body}</div><div class="intro-figure ${s.cls || ''}">${s.figure(reviews, phases[i])}</div></div>`).join('');
    const next = dialog.querySelector('[data-intro="next"]');
    next.className = `primary tone-${last ? 'ok' : 'run'}`;
    next.innerHTML = last ? `${ICONS.plus}New idea` : `Next${ICONS.next}`;
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
      if (fig) { holdSkies(dialog.querySelector('.intro-body')); fig.innerHTML = INTRO_STEPS[at].figure(reviews, phases[at]); }
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
    applyTheme(dialog);
    if (!dialog.open) dialog.showModal();
    relayout();
  }

  return {
    open,
    maybeShow() { if (!storage || storage.get(SEEN_KEY)) return false; open(0); return true; },
    remove() { stop(); win()?.removeEventListener('resize', relayout); if (dialog) releaseSkies(dialog.querySelector('.intro-body')); dialog?.remove(); dialog = null; },
  };
}
