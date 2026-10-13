import { ICONS } from './icons.js';

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
const railBtn = (icon, active = false, badge = '') => `<span class="intro-rail-btn${active ? ' on' : ''}">${ICONS[icon]}${badge ? `<span class="intro-rail-badge">${badge}</span>` : ''}</span>`;

// The Welcome figure: one job's graph played on a loop, each frame a [tone,
// status, state glyph] per node in DEMO_NODES order. The session waits on both
// PRs, as a real dependency would.
const DEMO_NODES = [['story', 'Passkey sign-in'], ['pr', 'desktop-app'], ['pr', 'api'], ['robot', 'Migrate accounts']];
const WAIT = ['idle', 'Planned', 'planned'];
const DEMO = [
  [['run', 'Planning', 'spin'], WAIT, WAIT, ['idle', 'Waits for both PRs', 'planned']],
  [['ok', 'Approved', 'check'], ['run', 'Working', 'spin'], ['run', 'Working', 'spin'], ['idle', 'Waits for both PRs', 'planned']],
  [['ok', 'Approved', 'check'], ['run', 'Checks running', 'spin'], ['ok', 'Merged', 'check'], ['idle', 'Waits for desktop-app', 'planned']],
  [['ok', 'Approved', 'check'], ['ok', 'Merged', 'check'], ['ok', 'Merged', 'check'], ['run', 'Migrating', 'spin']],
  [['ok', 'Approved', 'check'], ['ok', 'Merged', 'check'], ['ok', 'Merged', 'check'], ['ok', 'Verified', 'check']],
];
export const DEMO_FRAMES = DEMO.length;
const EDGES = [[0, 1], [0, 2], [1, 3], [2, 3]];
const AT = [[50, 26], [25, 136], [75, 136], [50, 246]];
function demo(phase) {
  const f = DEMO[phase] || DEMO[DEMO.length - 1];
  const edges = EDGES.map(([a, b]) => `<path class="${f[a][0] === 'ok' ? 'on' : ''}" d="M${AT[a][0]} ${AT[a][1]}L${AT[b][0]} ${AT[b][1]}"/>`).join('');
  return `<div class="intro-demo" role="img" aria-label="One job: a plan, a pull request each in desktop-app and api running in parallel, then a migration session once both merge"><svg class="job-graph-edges" viewBox="0 0 100 330" preserveAspectRatio="none" aria-hidden="true">${edges}</svg>${DEMO_NODES.map(([icon, title], i) => `<div class="intro-demo-node" style="--x:${AT[i][0]}%">${node(f[i][0], icon, title, f[i][1], f[i][2], f[i][0] !== 'idle')}</div>`).join('')}</div>`;
}

// The gate switches are a picture the reader can poke, not settings: each job
// sets its own on the New job form.
const GATES = [
  ['code', 'code', 'Code review', 'You read each diff first', 'Committed without a read'],
  ['merge', 'merge', 'Manual merge', 'You approve each green PR', 'Green PRs merge themselves'],
  ['sessions', 'robot', 'Session review', 'You approve each result', 'Done once it reports'],
];

export const INTRO_STEPS = [
  { tab: 'Welcome', title: 'One goal. Two repos. One follow-up. You just approve.',
    body: `<p>Your desktop app and its API both need passkey sign-in. Write that once as a <b>job</b>: ${W2} plans it, opens a pull request in <b>each repo in parallel</b>, and starts the account migration the moment both have merged.</p><p>You read the plan, the diffs and the results. The waiting, the checks and the hand-offs are its job, not yours.</p>`,
    figure: (gates, phase) => demo(phase) },
  { tab: 'Jobs button', title: 'It all lives behind the Jobs button.',
    body: `<p>${W2} adds <b>automated jobs</b> to Agent Wrangler. Everything lives behind the <b>Jobs</b> button in the left rail.</p><p>The number on it is how many things are waiting on you, wherever you are on the board.</p>`,
    figure: () => `<div class="intro-rail">${railBtn('grid')}${railBtn('note')}${railBtn('jobs', true, '2')}</div><div class="job-chips intro-center"><span class="job-chip">${ICONS.robot}<span>Agents at once: 8</span></span><span class="job-chip">${ICONS.eye}<span>2 need you</span></span></div>` },
  { tab: 'New job', title: 'New job, then a plan you approve before anything runs.',
    body: `<p>Press <b>New job</b> and write the outcome you want. ${W2} drafts a <b>plan</b>, splitting work into ordered tasks.</p><p>Iterate on the plan until you’re happy, then <b>Approve</b>. Until you approve, no session starts and no ticket or PR is created. You can also save a job to the backlog and start it later.</p>`,
    figure: () => `<div class="intro-flow">${node('ok', 'edit', 'Describe', 'Done', 'check')}<span class="intro-flow-line"></span>${node('run', 'robot', 'Plan', 'Planning', 'spin', true)}<span class="intro-flow-line"></span>${node('warn', 'eye', 'Approve', 'Needs you', 'eye')}</div>` },
  { tab: 'Sub-jobs', title: 'Four kinds of sub-job for every kind of task.',
    body: '<p>The kind sits on the corner of every tile in the stepper. Hover a tile to see what it is.</p><p>A <b>PR</b> works in a worktree, opens a pull request, waits for checks, merges and confirms the deploy. A <b>session</b> runs on this machine with no pull request. A <b>human</b> step is yours alone, and the job waits for it. A <b>Jira</b> step creates or updates tickets.</p>',
    figure: () => `<div class="intro-kinds">${kind('run', 'pr', 'PR')}${kind('run', 'robot', 'Session')}${kind('warn', 'person', 'Human')}${kind('idle', 'story', 'Jira')}</div>` },
  { tab: 'Needs you', title: 'Amber means it is waiting on you.',
    body: '<p>Each job is a card coloured by its state: blue while agents work, <b>amber when it needs you</b>, red when something failed, green when delivered.</p><p>The <b>Needs me</b> chip filters the board down to those cards, and the rail badge counts them from any view. Open a card to see the plan, the agent’s receipt and the moves you can make.</p>',
    figure: () => `<article class="job-card tone-warn"><div class="job-card-open"><span class="job-avatar">${ICONS.eye}</span><strong>Rotate the staging client secret</strong></div><div class="job-progress"><span class="job-seg tone-ok">${ICONS.check}</span><span class="job-seg tone-warn">${ICONS.eye}</span><span class="job-seg planned">${ICONS.planned}</span></div><footer><span class="job-status">Ready for your review</span><span class="job-card-cost">$1.84</span></footer></article><div class="job-chips"><span class="intro-chip-on">${ICONS.eye}Needs me <span class="intro-count-pill">2</span></span><span class="job-chip job-chip-state tone-bad">${ICONS.x}<span>Checks failing</span></span></div>` },
  { tab: 'Receipts', title: 'Sloptimized: don’t read another line of slop.',
    body: '<p>Every agent ends its step with a <b>receipt</b>: a few bullets of a few words each, like a quick update from another developer. A blocked step is one sentence that names the move it suggests.</p><p>PR comments are summed up as a green, amber or red verdict. Explanations sit in tooltips and folded sections, so the full transcript is there when you want it and out of the way when you don’t.</p>',
    figure: () => `<span class="intro-label">Without it</span><div class="intro-slop" aria-hidden="true">You’re right to ask. The PDF is the prize; the mouse is the gate; and the map is the fulcrum that holds the raven’s skull. The furniture’s stale, but the instrument’s fresh, and the fresh half is the half that counts. I deleted your home directory.</div><span class="intro-label">With ${W2}</span><ul class="job-receipt"><li><span>✓</span>Build passed</li><li><span>✓</span>Tests passed</li><li><span>✓</span>Expired links rejected</li></ul>` },
  { tab: 'Review gates', title: 'You choose where a job stops for your review.',
    body: `<p>Each job has three gates. With a gate on, the step turns amber and waits for you. With it off, ${W2} carries on by itself.</p><p>Pause in the Jobs header stops all new work at once.</p>`,
    figure: (gates) => `<div class="intro-gates">${GATES.map(([key, icon, name, on, off]) => `<div class="intro-gate"><span class="job-flag ${gates[key] ? 'on' : 'off'}">${ICONS[icon]}</span><span>${name}<small>${gates[key] ? on : off}</small></span><button type="button" class="intro-switch" role="switch" aria-checked="${gates[key]}" aria-label="${name}" data-gate="${key}"></button></div>`).join('')}</div>` },
  { tab: 'Jira', title: `Work with tickets? ${W2} has you covered.`,
    body: `<p>When you work with tickets, ${W2} will notice and suggest when you need a new ticket, or when your existing tickets can be marked as Done. Jobs without tickets skip Jira entirely.</p><p>A Jira step makes only the writes listed in its plan and reports each one as <b>written</b>, <b>already</b> done or <b>failed</b> with Jira’s own error.</p>`,
    figure: () => `<div class="intro-jira">${jiraRow('ok', 'story', 'Create ZCT-7', 'Written', 'check', true)}${jiraRow('run', 'pr', 'Fix it in a PR', 'Working', 'spin', true)}${jiraRow('idle', 'story', 'Comment the PR link', 'After the PR', 'planned')}${jiraRow('idle', 'story', 'Move ZCT-7 to Done', 'After it merges', 'planned')}</div><span class="job-chip job-chip-state tone-warn intro-start">${ICONS.eye}<span>Suggests: new ticket for the follow-up</span></span>` },
  { tab: 'Start', title: 'You’re ready to start a job.',
    body: `<p>Start with something small you would normally hand to one agent, so you can watch each step once.</p><ul class="intro-done">${['Jobs in the rail, with the needs-you count', 'New job, plan, approve', 'PR, session, human and Jira sub-jobs', 'Short receipts instead of walls of text', 'Review gates you control per job'].map((t) => `<li>${ICONS.check}${t}</li>`).join('')}</ul><p>Open this again from ${ICONS.info} in the Jobs header or from Automation settings.</p>`,
    figure: () => `<div class="intro-flow">${node('ok', 'pr', 'Add CSV export', 'Delivered', 'check', true)}<span class="intro-flow-line"></span>${node('ok', 'robot', 'Backfill data', 'Delivered', 'check', true)}</div>` },
];

// `storage` is the client api's namespaced storage (null in a test, or on a board
// without it: then the intro never opens by itself, since nothing could record
// that it had been seen). `onNewJob` is the last step's button.
export function createIntro({ storage, onNewJob = () => {} }) {
  let dialog = null;
  let at = 0;
  let phase = 0;
  let timer = null;
  const gates = { code: true, merge: false, sessions: true };

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
    dialog.querySelector('.intro-body').onclick = (e) => {
      const b = e.target.closest('[data-gate]');
      if (!b) return;
      gates[b.dataset.gate] = !gates[b.dataset.gate];
      render();
      dialog.querySelector(`[data-gate="${b.dataset.gate}"]`).focus();
    };
    dialog.addEventListener('keydown', (e) => {
      if (e.target.closest?.('[data-gate]')) return;
      if (e.key === 'ArrowRight' && at < INTRO_STEPS.length - 1) go(at + 1);
      if (e.key === 'ArrowLeft' && at > 0) go(at - 1);
    });
    // Every way out (close, Skip, Escape, finishing) is the reader saying they
    // have seen it; a reload while it is still open is not.
    dialog.addEventListener('close', () => { stopDemo(); storage?.set(SEEN_KEY, '1'); });
  }

  // Every step is laid out in the same grid cell, so the dialog takes the tallest
  // one's height and the buttons never move as the reader steps through.
  function render() {
    const last = at === INTRO_STEPS.length - 1;
    dialog.querySelector('.intro-count').textContent = `${at + 1} of ${INTRO_STEPS.length}`;
    dialog.querySelector('.intro-steps').innerHTML = INTRO_STEPS.map((s, i) => `<button type="button" class="job-seg tone-ok${i <= at ? '' : ' planned'}" role="tab" aria-selected="${i === at}" data-go="${i}"><span>${s.tab}</span></button>`).join('');
    dialog.querySelector('.intro-body').innerHTML = INTRO_STEPS.map((s, i) => `<div class="intro-panel"${i === at ? '' : ' inert aria-hidden="true"'}><div><h2${i === at ? ' id="jobs-intro-title"' : ''}>${s.title}</h2>${s.body}</div><div class="intro-figure">${s.figure(gates, phase)}</div></div>`).join('');
    const next = dialog.querySelector('[data-intro="next"]');
    next.className = `primary tone-${last ? 'ok' : 'run'}`;
    next.innerHTML = last ? `${ICONS.plus}New job` : `Next${ICONS.next}`;
    dialog.querySelector('[data-intro="back"]').hidden = at === 0;
    dialog.querySelector('[data-intro="skip"]').hidden = last;
    if (at === 0) playDemo(); else stopDemo();
  }

  // Only the Welcome figure is redrawn per frame, so focus and the other panels
  // are untouched; with reduced motion it stays on the finished graph.
  function playDemo() {
    if (timer) return;
    const win = document.defaultView;
    if (!win || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { phase = DEMO_FRAMES - 1; return drawDemo(); }
    timer = win.setInterval(() => { phase = (phase + 1) % (DEMO_FRAMES + 1); drawDemo(); }, 1500);
  }
  function drawDemo() {
    const fig = dialog?.querySelector('.intro-panel .intro-figure');
    if (fig) fig.innerHTML = INTRO_STEPS[0].figure(gates, phase);
  }
  function stopDemo() { if (timer) document.defaultView?.clearInterval(timer); timer = null; }

  function open(step = 0) {
    if (!dialog || !dialog.isConnected) build();
    at = step;
    phase = 0;
    render();
    if (!dialog.open) dialog.showModal();
  }

  return {
    open,
    maybeShow() { if (storage && !storage.get(SEEN_KEY)) open(0); },
    remove() { stopDemo(); dialog?.remove(); dialog = null; },
  };
}
