import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { initJobsView, isPrimaryActionKey, primaryAction } from './jobs-view.js';
import { CHECKPOINTS, reviewDefaultsOf, jobCards, jobStatus, jobNeedsReview, dependencyLevels, mergeHeldByComments, changeView, eventFor, writeReviewed, heldByReplan, redScope, changeRoute, actionLine, pinLine } from './jobs.js';
import { threadHtml } from './job-thread.js';
import { planGraphHtml, layoutGraphEdges } from './job-graph.js';
import { plateHtml, plateAsk } from './job-plates.js';
import { subState, subLabel, subLine, jobState, jobLabel } from './job-state.js';

const sub = (id, after = []) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', jiraKey: 'AUTH-1', after, brief: 'Implement it and open the PR', sessions: [], repairs: [] });
const plan = { context: 'Keys live in the vault; every service reads them at boot.', stories: [{ id: 'story', key: 'AUTH-1', title: 'Customers can sign in' }], subJobs: [sub('api'), sub('web', ['api'])] };
const hint = (f) => f.q('#job-dialog .job-chip-state').title;
const deploys = (summary = 'Deploys on merge · Deploy') => ({ head: 'head1', base: 'main', expected: true, workflows: [{ name: 'Deploy', file: 'deploy.yml', triggers: true, reason: 'runs on push' }], summary });
function fixture(t) {
  const window = new Window({ url: 'http://localhost:7878' });
  const prevDoc = globalThis.document, prevFormData = globalThis.FormData;
  globalThis.document = window.document; globalThis.FormData = window.FormData;
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  const staging = { stage: async () => ({ name: 'paste-1700000000000-aaaa1111.png' }) };
  const sent = [], usualSaves = [], sessions = [], diffs = [], diffContexts = [], onBoard = new Set();
  const view = initJobsView({ send: (m) => (m.patch?.usualPick ? usualSaves : sent).push(structuredClone(m)), stageImage: (blob) => staging.stage(blob), frameOf: async () => ({ mime: 'image/png', dataBase64: 'cG5n' }), getAgents: () => [{ id: 'claude', label: 'Claude', models: [{ value: 'sonnet', label: 'Sonnet', default: true }], efforts: [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }] }, { id: 'codex', label: 'Codex', models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', default: true }], efforts: [{ value: 'high', label: 'High' }] }], onSession: (s) => sessions.push(s), onDiff: (s, ctx) => { diffs.push(s); diffContexts.push(ctx); }, onBoard: (s) => onBoard.has(s) });
  t.after(async () => { globalThis.document = prevDoc; globalThis.FormData = prevFormData; await window.happyDOM.close(); });
  const job = { id: 'job1', title: 'Sign-in', intent: 'Reliable sign-in', repos: ['/repo'], stage: 'planning', plan, subJobs: [], runs: [], moves: [], revision: 2, reviewMerge: true };
  const data = { jobs: [structuredClone(job)], settings: { concurrency: 2, maxRepairs: 2 } };
  const q = (s) => document.querySelector(s);
  const event = (name) => new window.Event(name, { bubbles: true, cancelable: true });
  view.update(data);
  return { window, view, data, staging, sent, usualSaves, q, event, sessions, diffs, diffContexts, onBoard };
}

test('every job is one tonal card in its state, and only jobs with attention items survive Needs me', (t) => {
  const f = fixture(t);
  f.data.jobs.push({ ...f.data.jobs[0], id: 'backlog', stage: 'backlog', plan: null }); f.view.update(f.data);
  assert.deepEqual([...document.querySelectorAll('.job-plate')].map((b) => b.dataset.board), ['backlog', 'job1'], 'newest first');
  assert.ok(f.q('[data-board="job1"]').classList.contains('tone-warn'), 'a plan to review is amber');
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Plan ready');
  assert.equal(f.q('[data-board="backlog"] .job-status').textContent, 'Backlog');
  assert.equal(document.querySelectorAll('[data-board="job1"] .job-plate-graph .node').length, 2, 'one segment per planned sub-job');
  f.q('[data-filter="needs"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-plate')].map((b) => b.dataset.board), ['job1']);
});

test('the board orders segments by dependency wave, so a sub-job moved after another reads after it', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('pr', ['web']), stage: 'pr' }, { ...sub('api'), stage: 'done' }, { ...sub('web', ['api']), stage: 'implementation' }];
  f.view.update(f.data);
  assert.deepEqual([...document.querySelectorAll('[data-board="job1"] .job-plate-graph .node')].map((e) => e.getAttribute('data-sub')), ['api', 'web', 'pr']);
});

test('the board colours each segment by its sub-job, and a segment opens that sub-job', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'done' }, { ...sub('web', ['api']), stage: 'implementation' }];
  job.runs = [{ id: 'r1', subJobId: 'web', phase: 'implementation', stopped: false, status: 'working' }];
  f.data.jobs.push({ ...structuredClone(job), id: 'job2', title: 'Broken', runs: [], subJobs: [{ ...sub('x'), stage: 'implementation', error: 'boom' }] });
  f.view.update(f.data);
  assert.deepEqual([...document.querySelectorAll('.job-plate')].map((b) => b.dataset.board), ['job2', 'job1'], 'newest first, whatever is failing');
  assert.ok(f.q('[data-board="job2"]').classList.contains('tone-bad'));
  assert.deepEqual([...document.querySelectorAll('[data-board="job1"] .job-plate-graph .node')].map((e) => [e.getAttribute('data-sub'), [...e.classList].find((c) => c.startsWith('tone-'))]), [['api', 'tone-ok'], ['web', 'tone-run']]);
  assert.match(f.q('.job-plate-graph .node[data-sub="web"]').getAttribute('aria-label'), /Deliver web: Working/);
  f.q('.job-plate-graph .node[data-sub="web"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver web');
  f.q('[data-open-job]').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Sign-in', 'the sub-job leads back to its job');
});

test('code review is a stop before anything is committed: the card asks for a read, approval is pinned to the receipt, and Add idea sends it back', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'review', state: 'verified', worktree: { path: '/wt', branch: 'fix/AUTH-1' }, sessions: ['s1'], ready: { checks: ['Tests pass', 'Lint clean'], receiptId: 'run_1' } }];
  f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'needs', text: 'Ready to review' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true);
  assert.deepEqual(jobCards([job])[0].stage, 'review');
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.match(f.q('#job-dialog').textContent, /Ready for review/); assert.match(hint(f), /^Uncommitted · approve to commit and open the PR$/m);
  assert.deepEqual([...f.q('#job-dialog').querySelectorAll('.job-receipt li')].map((li) => li.textContent.trim()), ['✓ Tests pass', '✓ Lint clean']);
  assert.equal(f.q('#job-diff').textContent, 'Review code', 'the diff is the review surface');
  assert.equal(f.q('#job-ide').closest('.job-split-more .job-split-menu') !== null, true, 'the desktop IDE is the other review surface, in the same control\'s menu');
  assert.equal(f.q('#job-ide').textContent, 'In IntelliJ IDEA', 'named after the setting');
  f.q('.job-split-more').open = true; f.q('#job-ide').click(); assert.equal(f.q('.job-split-more').open, false, 'picking it closes the menu'); assert.deepEqual(f.sent.at(-1), { type: 'job-open-ide', id: 'job1', subJobId: 'api' }); assert.equal(f.q('#job-dialog').open, true, 'the dialog stays: approval happens here');
  f.data.settings.ideApp = 'Rider'; f.view.update(f.data); assert.equal(f.q('#job-ide').textContent, 'In Rider');
  delete f.data.settings.ideApp; f.view.update(f.data);
  const box = f.q('.job-change');
  assert.deepEqual([box.dataset.changeAt, box.dataset.changeRef], ['code', 'run_1'], 'the idea box is on the review itself, pinned to the receipt that was read');
  assert.equal(box.querySelector('textarea').placeholder, 'Add an idea about this step…');
  assert.equal(box.querySelector('.job-change-to').textContent, 'PPlanner', 'one recipient'); assert.equal(box.querySelector('.job-change-foot').textContent, '⌘↵'); assert.equal(f.q('.job-moves'), null, 'no Moves menu');
  job.runs = [{ id: 'run_1', subJobId: 'api', phase: 'implementation', stopped: false, parkedFor: 'ready' }]; f.view.update(f.data);
  const parked = f.q('.job-change');
  assert.deepEqual([parked.querySelector('.job-change-to').textContent, parked.querySelector('textarea').placeholder, parked.querySelector('[data-change-send]').getAttribute('aria-label')], ['PPlanner', 'Ask about it, or say what to change…', 'Send to planner'], 'its session is open, and the idea still goes to the planner');
  job.runs = []; f.view.update(f.data);
  f.q('[data-action="approve-code"]').click();
  assert.equal(f.sent.at(-1).action, 'approve-code'); assert.equal(f.sent.at(-1).readyReceiptId, 'run_1');
  job.subJobs[0].state = 'approved'; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Approved · committing next' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
  assert.equal(f.q('[data-action="approve-code"]'), null);
  job.runs = [{ id: 'r2', subJobId: 'api', phase: 'publish', stopped: false, status: 'working' }]; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Committing & opening the PR' });
  f.q('#job-dialog').close();
});

test('each job is its own card, and a delivered job only returns with Finished', (t) => {
  const f = fixture(t); const [a] = f.data.jobs; a.stage = 'active';
  a.subJobs = [{ ...sub('api'), stage: 'pr' }];
  const b = { ...structuredClone(a), id: 'job2', title: 'Checkout', subJobs: [{ ...sub('cart'), stage: 'pr', jiraKey: 'SHOP-7' }] };
  const done = { ...structuredClone(a), id: 'job3', title: 'Old work', stage: 'done', subJobs: [{ ...sub('legacy'), stage: 'done' }] };
  f.data.jobs.push(b, done); f.view.update(f.data);
  const boards = () => [...document.querySelectorAll('.job-plate')].map((x) => x.dataset.board);
  assert.deepEqual(boards(), ['job2', 'job1'], 'the delivered job is hidden by default');
  assert.deepEqual([...document.querySelectorAll('.job-plate')].map((x) => [...x.querySelectorAll('.job-plate-graph .node')].map((c) => c.getAttribute('data-sub'))), [['cart'], ['api']]);
  assert.match(f.q('[data-board="job2"]').textContent, /Checkout/);
  f.q('[data-filter="done"]').click();
  assert.deepEqual(boards(), ['job3'], 'Finished shows only the finished');
  assert.ok(f.q('[data-board="job3"]').classList.contains('tone-ok'));
  assert.deepEqual([...document.querySelectorAll('.jobs-rail-n')].map((n) => n.textContent), ['2', '', '', '', '', '1'], 'each filter counts its jobs, and none is blank, not a grey 0');
  assert.equal(f.q('.jobs-rail-sort'), null, 'no fixed sort label posing as a control');
  const sky = f.q('.jobs-top > canvas.jobs-mast-sky');
  assert.equal(sky?.getAttribute('aria-hidden'), 'true', 'the masthead sits on its own painted sky, hidden from assistive tech');
  assert.equal(f.q('.jobs-top').firstElementChild, sky, 'the sky comes first, under the title and tools');
  f.q('[data-filter="all"]').click();
  f.q('.job-plate-open').click(); assert.equal(f.q('#job-dialog h2').textContent, 'Checkout');
  f.q('[data-sub="cart"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('#job-dialog .job-detail-line').textContent.includes('SHOP-7'), true, 'the ticket rides in the meta line');
  f.q('#job-dialog').close(); f.q('.job-plate-open').click();
  f.q('#job-dialog [data-action="pause"]').click(); assert.deepEqual([f.sent.at(-1).id, f.sent.at(-1).action, f.sent.at(-1).subJobId], ['job2', 'pause', undefined]);
  b.paused = true; f.view.update(f.data);
  assert.equal(f.q('#job-dialog [data-action="resume"]').textContent, 'Resume'); f.q('#job-dialog [data-action="resume"]').click(); assert.equal(f.sent.at(-1).action, 'resume');
  assert.ok(f.q('[data-board="job2"]').classList.contains('tone-pause'), 'a paused job is purple');
});

test('a sub-job carries what the merge will do and the note left for the next session, and goes red when something happened', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', deploys: deploys(), note: 'Rebase on <main> first', pr: { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'pending', checks: [] } }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('.job-deploys').title, 'Deploys on merge · Deploy');
  assert.equal(f.q('.job-note').textContent, 'Rebase on <main> first');
  assert.ok(!f.q('#job-dialog').innerHTML.includes('<main>'), 'a note is human text on an agent surface: escaped');
  f.q('#job-dialog').close();
  assert.equal(f.q('.job-plate-graph .node[data-sub="api"]').classList.contains('tone-bad'), false, 'nothing has gone wrong yet');
  job.subJobs[0].error = 'PR was closed without merging'; f.view.update(f.data);
  assert.equal(f.q('.job-plate-graph .node[data-sub="api"]').classList.contains('tone-bad'), true);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'PR was closed');
  assert.deepEqual(eventFor(job, job.subJobs[0]), { title: 'PR was closed', detail: 'PR was closed without merging' });
});

test('a step waiting on a prompt is the human’s: it says so, and it counts under Needs me', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }];
  job.runs = [{ id: 'r1', subJobId: 'api', phase: 'implementation', stopped: false, status: 'working' }];
  f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Working' });
  assert.deepEqual(jobStatus({ ...job, reviewCode: false }, job.subJobs[0]), { tone: 'working', text: 'Working on the PR' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
  job.runs[0].status = 'needs-you'; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'needs', text: 'Waiting on a prompt' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true); assert.equal(f.q('#jobs-review-count').textContent, '1');
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Prompt waiting');
  f.q('.job-plate-open').click(); assert.equal(f.q('#job-dialog [data-fab-session]'), null, 'no session to answer yet');
  job.subJobs[0].sessions = ['s9']; f.view.update(f.data);
  f.q('#job-dialog [data-fab-session]').click(); assert.deepEqual(f.sessions, ['s9'], 'the job’s one button opens the prompt');
});

test('a planning session waiting on a prompt is one click away, from the plate and from the job', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.plan = null;
  job.runs = [{ id: 'p1', subJobId: null, phase: 'planning', stopped: false, status: 'needs-you', sessionId: 'plan-card' }];
  f.view.update(f.data);
  assert.equal(f.q('[data-board="job1"] .job-plate-detail').textContent, 'Planning');
  f.q('[data-board="job1"] .job-plate-go').click();
  assert.deepEqual(f.sessions, ['plan-card'], 'Answer goes straight to the planning card');
  f.q('.job-plate-open').click();
  const fab = f.q('#job-dialog [data-fab-session]');
  assert.equal(fab.title, 'Planning · Prompt waiting');
  fab.click(); assert.deepEqual(f.sessions, ['plan-card', 'plan-card']); assert.equal(f.q('#job-dialog').open, false);
});

test('the job’s button answers a waiting prompt before a merge, and says how many more wait', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', checks: [] } },
    { ...sub('docs'), kind: 'session', stage: 'session', sessions: ['docs-card'] }, { ...sub('ui'), kind: 'session', stage: 'session', sessions: ['ui-card'] }];
  job.runs = [{ id: 'r1', subJobId: 'docs', phase: 'session', stopped: false, status: 'needs-you', startedAt: 1 }, { id: 'r2', subJobId: 'ui', phase: 'session', stopped: false, status: 'needs-you', sessionId: 'ui-card', startedAt: 2 }];
  f.view.update(f.data); f.q('.job-plate-open').click();
  assert.equal(f.q('#job-dialog [data-action="approve-merge"]'), null, 'the merge waits behind the prompt');
  const fab = f.q('#job-dialog [data-fab-session]');
  assert.equal(fab.title, 'Deliver docs · Prompt waiting · +1 more waiting');
  fab.click(); assert.deepEqual(f.sessions, ['docs-card']);
});

test('the event box names what happened, escaped, and Add idea is the way to answer it', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', error: 'The <proto> files are out of sync with the API',
    blocked: { summary: 'The <proto> files are out of sync with the API', phase: 'implementation', at: 1 } }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const dialog = f.q('#job-dialog');
  assert.equal(dialog.querySelector('.job-event b').textContent, 'Worker blocked');
  assert.equal(dialog.querySelector('.job-event p').textContent, 'The <proto> files are out of sync with the API');
  assert.ok(!dialog.innerHTML.includes('<proto>'), 'the agent’s sentence is escaped');
  assert.equal(dialog.querySelector('.job-event-move'), null); assert.equal(dialog.querySelector('.job-moves'), null);
  assert.equal(dialog.querySelector('details[data-keep="change"]'), null, 'no fold to open: the box is always there');
  assert.ok(dialog.querySelector('.job-change').classList.contains('is-open'), 'a failing step starts with the box open, its hint showing');
  assert.equal(dialog.querySelector('.job-change').dataset.changeAt, 'step');
  assert.equal(dialog.querySelector('.job-change-to').textContent, 'PPlanner', 'a step with no agent of its own sends the idea to the planner');
  assert.ok(dialog.querySelector('#job-retry'), 'the plain retry is still there for a transient failure');
});

test('what a human is looking at, and what a request is pinned to, per view', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const at = (extra) => changeView(job, { ...sub('api'), ...extra });
  assert.equal(at({ stage: 'done' }), null); assert.equal(at({ stage: 'cleanup' }), null); assert.equal(at({ stage: 'pr', cancelledAt: 1 }), null);
  assert.deepEqual(at({ stage: 'pr', pr: { head: 'h1' } }), { at: 'pr', ref: 'h1' });
  assert.deepEqual(at({ stage: 'review', state: 'verified', ready: { receiptId: 'run_4' } }), { at: 'code', ref: 'run_4' });
  assert.deepEqual(at({ stage: 'review', state: 'approved', ready: { receiptId: 'run_4' } }), { at: 'code', ref: 'run_4' });
  assert.deepEqual(at({ kind: 'session', stage: 'review', result: { receiptId: 'run_5' } }), { at: 'session', ref: 'run_5' });
  assert.deepEqual(at({ kind: 'session', stage: 'session', state: 'queued' }), { at: 'step', ref: 'session/queued' });
  assert.deepEqual(at({ kind: 'human', stage: 'human', state: 'waiting' }), { at: 'step', ref: 'human/waiting' });
  assert.deepEqual(at({ stage: 'deployment', state: 'watching' }), { at: 'step', ref: 'deployment/watching' });
  assert.deepEqual(at({ kind: 'write', stage: 'review', state: 'verified' }), { at: 'write', ref: 'review/verified' });
  assert.deepEqual(changeView({ ...job, stage: 'planning', plan: { subJobs: [] }, revision: 7 }, null), { at: 'plan', ref: '7' });
  assert.deepEqual(changeView(job, null), { at: 'job', ref: 'job' });
  assert.deepEqual(changeView({ ...job, replan: { proposal: { id: 'run_8' } } }, null), { at: 'proposal', ref: 'run_8' });
  assert.equal(changeView({ ...job, cancelledAt: 1 }, null), null); assert.equal(changeView({ ...job, stage: 'backlog' }, null), null);
});

test('a red run the human accepted reads as landing or merging', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const redPr = { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [{ name: 'e2e', state: 'FAILURE' }, { name: 'lint', state: 'SUCCESS' }] };
  const landing = { ...sub('api'), stage: 'deployment', pr: { ...redPr, checkStatus: 'passing', mergeCommit: 'abc' }, deploymentResult: { status: 'failing', runs: [{ workflow: 'Deploy', status: 'failing', url: 'https://github.com/org/repo/actions/runs/1' }], commit: 'abc' } };
  assert.deepEqual(jobStatus(job, { ...landing, acceptedRed: { ref: 'abc' }, error: null }), { tone: 'working', text: 'Red run accepted · landing' });
  assert.deepEqual(jobStatus(job, { ...sub('api'), stage: 'pr', pr: redPr, acceptedRed: { ref: 'h1' } }), { tone: 'working', text: 'Merging with red checks' });
});

test('Request changes sends the text pinned to the PR head that was on screen, and nothing else', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [] } }];
  f.view.update(f.data);
  f.q('.job-plate-graph [data-sub="api"]').dispatchEvent(f.event('click'));
  const box = f.q('.job-change');
  const send = f.q('[data-change-send]');
  assert.equal(send.disabled, true, 'nothing to send yet');
  const text = box.querySelector('textarea'); text.value = '  Pin the client to v3  '; text.dispatchEvent(f.event('input'));
  assert.equal(send.disabled, false);
  job.subJobs[0].pr.head = 'h2';
  send.click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'request-change', at: 'pr', ref: 'h1', text: 'Pin the client to v3' }, 'pinned to h1, the head that was read, even though a new one has landed since');
});

test('a change being typed is not redrawn away by a live tick, and an escaped agent title stays escaped', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), title: 'Sync <b>protos</b>', stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'pending', checks: [] } }];
  f.view.update(f.data); f.q('.job-plate-graph [data-sub="api"]').dispatchEvent(f.event('click'));
  const text = f.q('.job-change textarea'); text.value = 'Half a thought';
  job.subJobs[0].pr.checkStatus = 'passing'; f.view.update(f.data);
  assert.equal(f.q('.job-change textarea').value, 'Half a thought', 'the draft survives the tick');
  assert.equal(f.q('.job-change textarea'), text, 'the same element: nothing was repainted');
  assert.ok(!f.q('#job-dialog').innerHTML.includes('<b>protos</b>'));
});

test('Cancel job is confirmed first, sends only the job action, and a cancelled job reads as cancelled rather than delivered', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', checkStatus: 'pending' } }, { ...sub('web', ['api']), stage: 'implementation' }, { ...sub('docs'), stage: 'done', deployed: { checks: ['Merged'], at: 1 } }];
  job.runs = [{ id: 'r1', subJobId: 'api', phase: 'repair', stopped: false }];
  f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click(); f.q('#job-cancel').click();
  assert.equal(f.sent.length, 0, 'cancelling needs a confirmation first');
  const text = () => f.q('#job-dialog').textContent;
  assert.deepEqual([...f.q('#job-dialog').querySelectorAll('.job-cancel-counts li')].map((li) => li.textContent), ['Drops 2 sub-jobs', 'PR #1 stays open on GitHub', 'Worktrees with unsaved work are kept']);
  assert.ok(f.q('#job-cancel-form'), 'a form, so a live graph tick leaves the question alone');
  f.q('#job-move-back').click(); assert.ok(f.q('#job-cancel'), 'backing out returns to the detail view');
  f.q('#job-cancel').click(); f.q('[data-cancel-job]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', action: 'cancel-job' });
  job.cancelledAt = Date.now(); job.runs = [];
  job.subJobs[0] = { ...job.subJobs[0], stage: 'cleanup', cancelledAt: job.cancelledAt }; job.subJobs[1] = { ...job.subJobs[1], stage: 'cleanup', cancelledAt: job.cancelledAt };
  f.view.update(f.data); f.q('#job-move-back').click();
  assert.equal(jobStatus(job, null).text, 'Cancelled · cleaning up');
  assert.equal(jobNeedsReview(job, job.subJobs[1]), false, 'nothing under a cancelled job asks for a human');
  assert.equal(f.q('#job-cancel'), null); assert.equal(f.q('[data-action="pause"]'), null);
  assert.match(hint(f), /Cancelled .* being stopped and cleaned up/);
  job.stage = 'done'; for (const s of job.subJobs) s.stage = 'done'; f.view.update(f.data);
  assert.equal(jobStatus(job, null).text, 'Cancelled');
  assert.equal(document.querySelectorAll('.job-plate').length, 0, 'a cancelled job is finished: hidden until Show finished');
  f.q('[data-filter="done"]').click();
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Cancelled');
  assert.deepEqual([...document.querySelectorAll('[data-board="job1"] .job-plate-graph .node')].map((e) => e.getAttribute('data-state')), ['dropped', 'done', 'dropped'], 'dropped work reads apart from delivered work, in dependency-wave order');
  assert.match(f.q('#jobs-delivered').textContent, /1 delivered/, 'dropped sub-jobs are never counted as delivered');
});

test('a job cancelled before it had sub-jobs keeps a card in Done and never offers Start planning', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'backlog'; job.plan = null; job.cancelledAt = 5; f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.equal(f.q('[data-action="start"]'), null); assert.match(f.q('#job-dialog').textContent, /Cancelled/);
  assert.equal(jobNeedsReview({ ...job, stage: 'planning', plan }, null), false, 'a cancelled plan is not waiting for review');
  job.stage = 'done'; f.view.update(f.data);
  f.q('[data-filter="done"]').click();
  assert.equal(jobCards([job]).length, 1);
  assert.equal(f.q('.job-plate').dataset.board, 'job1');
  assert.equal(f.q('.job-plate .job-status').textContent, 'Cancelled');
});

test('the interventions a job has seen fold into a collapsed history that stays open across ticks', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'pending', checks: [] } }];
  job.moves = [{ id: 'mv_1', at: 1757400000000, subJobId: 'api', move: 'fix-here', detail: 'Fix here on “Deliver api”' },
    { id: 'mv_2', at: 1757400600000, subJobId: 'api', move: 'split-out', detail: 'Split out “<proto> sync” to land before this' }];
  f.view.update(f.data); f.q('.job-plate-open').click();
  const history = f.q('.job-moves-history');
  assert.equal(history.open, false); assert.match(history.querySelector('summary').textContent, /History\s*2/);
  assert.deepEqual([...history.querySelectorAll('.job-move-log span')].map((e) => e.textContent), ['Split out “<proto> sync” to land before this', 'Fix here on “Deliver api”'], 'newest first');
  assert.ok(!history.innerHTML.includes('<proto>'), 'a move line is agent-adjacent text: escaped');
  assert.equal(history.querySelectorAll('.job-move-log small').length, 2, 'each move says when it was made');
  history.open = true; history.dispatchEvent(f.event('toggle'));
  f.view.update(f.data);
  assert.equal(f.q('.job-moves-history').open, true, 'the disclosure survives the tick');
});

test('planning edits survive live snapshots and submit the displayed revision', (t) => {
  const f = fixture(t); f.q('.job-plate-open[data-job=\"job1\"]').click();
  const title = f.q('[data-title="0"]'); title.value = 'Deliver secure API'; title.dispatchEvent(f.event('input'));
  f.data.jobs[0].revision = 3; f.view.update(f.data);
  assert.equal(f.q('[data-title="0"]').value, 'Deliver secure API');
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent[0].revision, 3, 'a bump that left the plan alone is adopted'); assert.equal(f.sent[0].plan.subJobs[0].title, 'Deliver secure API');
  assert.equal(f.q('#job-dialog').open, true, 'remain open until server acknowledges');
  f.view.created(); assert.equal(f.q('#job-dialog').open, false);
});

test('a plan changed under review keeps the displayed revision, so the server refuses it', (t) => {
  const f = fixture(t); f.q('.job-plate-open[data-job=\"job1\"]').click();
  f.data.jobs[0].revision = 3; f.data.jobs[0].plan = { ...plan, subJobs: [sub('api')] }; f.view.update(f.data);
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent[0].revision, 2);
});

test('Approve unlocks when the planning run stops under an open review', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.runs = [{ id: 'r1', phase: 'planning', stopped: false, report: true }]; f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.equal(f.q('[data-action="approve-plan"]').disabled, true);
  job.runs[0].stopped = true; job.revision = 3; f.view.update(f.data);
  assert.equal(f.q('[data-action="approve-plan"]').disabled, false);
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent[0].revision, 3);
});

test('the plan under review shows the shared context, each brief and each check — and no business-value prose', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan.subJobs[0].check = 'helm list shows auth-api in dev and prod';
  f.view.update(f.data); f.q('.job-plate-open[data-job=\"job1\"]').click();
  const dialog = f.q('#job-dialog');
  assert.equal(dialog.querySelector('.job-context').textContent, 'Keys live in the vault; every service reads them at boot.');
  assert.equal(dialog.querySelector('.job-context').closest('details').open, false, 'context is folded until asked for; the landing order is the decision');
  assert.equal(dialog.querySelectorAll('.job-stories p').length, 0, 'a story is a title; its value is not the board’s business');
  assert.match(dialog.textContent, /Implement it and open the PR/);
  assert.match(dialog.textContent, /Check: helm list shows auth-api in dev and prod/);
  assert.doesNotMatch(dialog.textContent, /No deployment: merging the PR completes it/, 'the runner infers what a merge deploys');
  const approve = f.q('[data-action="approve-plan"]');
  assert.equal(approve.textContent, 'Approve 2');
  assert.doesNotMatch(approve.title, /[Cc]ode review/);
  assert.equal(approve.title, 'Starts 2 steps', 'what approval does is one hover away');
});

test('the plan review names no worktree branch, and a cut PR tile shows it; a sub-job\'s detail shows the branch its worktree is actually on', (t) => {
  const f = fixture(t); f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.equal(f.q('[data-branch]'), null); assert.equal(f.q('.job-plan-branch'), null);
  f.q('#job-dialog').close();
  const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', worktree: { path: '/wt/api', branch: 'fix/AUTH-1-api', repoRoot: '/repo' } }, { ...sub('web', ['api']), stage: 'implementation' }]; f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.equal(f.q('[data-node="api"] .job-node-wt').textContent, 'fix/AUTH-1-api', 'a cut PR shows its worktree branch on its tile');
  assert.equal(f.q('[data-node="api"] .job-node-landing').textContent, 'fix/AUTH-1-api', 'default branch: no arrow, nothing to say');
  assert.equal(f.q('[data-node="web"] .job-node-wt'), null, 'not cut yet: only where it lands');
  assert.equal(f.q('[data-node="web"] .job-node-landing'), null, 'a PR on the default branch with no worktree shows nothing');
  assert.match(f.q('[data-open-sub="api"]').title, /Lands on the default branch\nBranch fix\/AUTH-1-api/, 'both are a hover away');
  f.q('[data-open-sub="api"]').click();
  assert.equal(f.q('.job-detail-line .job-plan-branch').textContent, 'fix/AUTH-1-api');
  f.q('#job-dialog').close(); f.q('.job-plate-open[data-job=\"job1\"]').click(); f.q('[data-open-sub="web"]').click();
  assert.equal(f.q('.job-detail-line .job-plan-branch'), null, 'no worktree yet, nothing to show');
});

test('a job session archived when its step stopped is offered as a restore, not a dead open', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', sessions: ['s1', 's2'] }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('#job-session').textContent, 'Restore session');
  f.onBoard.add('s2'); f.view.update(f.data);
  assert.equal(f.q('#job-session').textContent, 'Open session');
  f.q('#job-session').click(); assert.deepEqual(f.sessions, ['s2'], 'the latest run, live or archived');
});

test('Review code in Wrangler opens the latest run already on the board, else the latest', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'review', worktree: { path: '/wt/api' }, sessions: ['s1', 's2', 's3'] }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  f.q('#job-diff').click(); assert.deepEqual(f.diffs, ['s3'], 'every run shares the worktree; nothing on the board, so the latest');
  f.onBoard.add('s1'); f.onBoard.add('s2'); f.view.openDetail('job1', 'api');
  f.q('#job-diff').click(); assert.equal(f.diffs.at(-1), 's2', 'an archived card would resume its agent just to show a diff');
});

test('PR review shows green checks, what runs on merge, CI changes, and approves only the displayed head', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', deploys: deploys(), worktree: { path: '/wt/api' }, sessions: ['s1'],
    pr: { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', mergeWithAdmin: true, checks: [{ name: 'Tests', state: 'SUCCESS' }] }, repairs: [{ changes: ['Fixed timeout'], checks: ['Tests pass'] }] }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('.job-deploys').title, 'Deploys on merge · Deploy');
  assert.match(f.q('#job-dialog').textContent, /Deploy\s*runs on push/, 'the inferred workflows say why');
  assert.match(f.q('#job-dialog').textContent, /Changes after failed checks/); assert.match(f.q('#job-dialog').textContent, /Fixed timeout/);
  assert.match(hint(f), /Merging will override GitHub’s required review/);
  assert.equal(f.q('[data-action="approve-merge"]').textContent, 'Merge #1');
  f.q('[data-action="approve-merge"]').click(); assert.equal(f.sent.at(-1).head, 'head1');
  // Reviewing the code is still a round trip out to the board's diff panel.
  f.q('#job-diff').click(); assert.deepEqual(f.diffs, ['s1']); assert.deepEqual(f.diffContexts, [{ jobId: 'job1', subId: 'api' }]);
  assert.equal(f.q('#job-dialog').open, false);
  f.view.openDetail('job1', 'api');
  assert.equal(f.q('#job-dialog').open, true, 'the same detail re-opens on the return leg');
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver api');
});

const prComments = (tone, fingerprint = 'f1') => ({
  prComments: { fetchedAt: 1, prAuthor: 'agent', truncated: 0, unresolved: 1, fingerprint, items: [
    { id: 'c1', kind: 'thread', author: 'bob', bot: false, body: 'Drops the <auth> check', at: '2026-09-08T10:00:00Z', url: 'https://github.com/org/repo/pull/1#c1', path: 'src/auth.js', line: 12, resolved: false, outdated: false },
    { id: 'r1', kind: 'review', state: 'APPROVED', author: 'ci-bot', bot: true, body: 'LGTM', at: '2026-09-08T10:01:00Z', url: 'https://github.com/org/repo/pull/1#r1' },
  ] },
  commentSummary: tone ? { tone, text: `${tone} summary text`, fingerprint: 'f1', at: 2, error: false } : null,
});

test('PR comments render escaped with their shaded verdict, and a red verdict holds automatic merge until approved', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.reviewMerge = false;
  const pr = { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', checks: [] };
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr, ...prComments('red') }];
  f.view.update(f.data);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Comments block merging'); assert.ok(f.q('.job-plate-graph .node[data-sub="api"].tone-bad'));
  assert.equal(mergeHeldByComments(job, job.subJobs[0]), true); assert.equal(jobNeedsReview(job, job.subJobs[0]), true);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Comments block merging');
  const asked = { ...job.subJobs[0], fixRequested: { note: null, at: 1 } };
  assert.equal(jobNeedsReview(job, asked), false, 'a requested fix takes the comments off the human'); assert.equal(jobStatus(job, asked).text, 'Fix requested');
  const fixing = { ...job, runs: [{ id: 'r1', subJobId: 'api', phase: 'repair', stopped: false, status: 'working' }] };
  assert.equal(jobNeedsReview(fixing, job.subJobs[0]), false); assert.equal(jobStatus(fixing, job.subJobs[0]).text, 'Fixing the PR');
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const dialog = f.q('#job-dialog');
  assert.equal(dialog.querySelector('.job-event b').textContent, 'Comments block merging', 'blocked comments are an event like any other');
  assert.ok(dialog.querySelector('.job-comment-summary.red')); assert.match(dialog.textContent, /Blocks merging.*red summary text/);
  assert.match(dialog.textContent, /1 unresolved thread/); assert.match(dialog.textContent, /src\/auth\.js:12/); assert.match(dialog.textContent, /ci-bot \(bot\) · review · approved/);
  dialog.querySelector('[data-comment-toggle="c1"]').click();
  assert.equal(dialog.querySelector('.job-comments p').textContent, 'Drops the <auth> check'); assert.equal(dialog.querySelector('.job-comments auth'), null);
  assert.match(hint(f), /automatic merge is on hold/);
  f.q('[data-action="approve-merge"]').click(); assert.equal(f.sent.at(-1).action, 'approve-merge'); assert.equal(f.sent.at(-1).head, 'head1');
  job.subJobs[0].mergeApprovedHead = 'head1'; f.view.update(f.data);
  assert.equal(mergeHeldByComments(job, job.subJobs[0]), false); assert.equal(f.q('[data-action="approve-merge"]'), null);
});

test('a comment body stays hidden until shown, survives a live re-render, and hides again', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const pr = { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', checks: [] };
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr, ...prComments('amber') }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const dialog = f.q('#job-dialog');
  const bodies = () => [...dialog.querySelectorAll('.job-comments p')].map((p) => p.textContent);
  assert.deepEqual(bodies(), [], 'bodies are not rendered by default');
  assert.equal(dialog.querySelectorAll('[data-comment-toggle]').length, 2);
  assert.match(dialog.textContent, /bob · src\/auth\.js:12/, 'the meta line is still there');
  dialog.querySelector('[data-comment-toggle="c1"]').click();
  assert.deepEqual(bodies(), ['Drops the <auth> check']);
  assert.equal(dialog.querySelector('[data-comment-toggle="c1"]').textContent, 'Hide');
  f.view.update(f.data);
  assert.deepEqual(bodies(), ['Drops the <auth> check'], 'a graph tick must not snap it shut');
  dialog.querySelector('[data-comment-toggle="c1"]').click();
  assert.deepEqual(bodies(), []);
  assert.equal(dialog.querySelector('[data-comment-toggle="c1"]').textContent, 'Show comment');
});

test('green and amber verdicts, a pending summary and no comments each read distinctly without asking for review', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.reviewMerge = false;
  const pr = { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', checks: [] };
  for (const [state, expectCard, expectDetail] of [
    [prComments('green'), /All good/, /green summary text/], [prComments('amber'), /Needs attention/, /amber summary text/],
    [prComments(null), /^$/, /Summarising comments/], [prComments('green', 'f2'), /^$/, /Summarising comments/],
    [{ prComments: { items: [], fingerprint: 'e', unresolved: 0, truncated: 0 }, commentSummary: null }, /^$/, /No comments yet/],
  ]) {
    job.subJobs = [{ ...sub('api'), stage: 'pr', pr, ...state }]; f.view.update(f.data);
    assert.ok(f.q('.job-plate-graph .node[data-sub="api"].tone-run'), 'green checks and no blocking comments: on its way'); assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
    f.q('[data-sub="api"]').dispatchEvent(f.event('click')); assert.match(f.q('#job-dialog').textContent, expectDetail);
    assert.match(f.q('.job-comment-summary b')?.textContent || '', expectCard);
    assert.equal(f.q('[data-action="approve-merge"]'), null, 'automatic merge needs no approval');
    f.q('#job-dialog').close();
  }
});

test('new-job form sends chosen model and the four review checkpoints', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  assert.equal(form.elements.reviewCode.checked, true, 'the human reads each diff before it is committed, unless they opt out');
  assert.equal(form.elements.amendmentAuthority, undefined, 'agents never change the plan, so there is no authority to grant');
  form.elements.intent.value = 'Deliver something useful';
  form.dispatchEvent(f.event('submit'));
  const msg = f.sent[0]; assert.equal(msg.type, 'job-create');
  assert.equal(msg.job.taskId, null, 'jobs stay Unassigned unless a task is chosen');
  assert.equal(msg.job.model, 'sonnet'); assert.equal(msg.job.reviewPlan, true); assert.equal(msg.job.reviewCode, true); assert.equal(msg.job.reviewMerge, true); assert.equal(msg.job.reviewSessions, true);
  assert.equal(msg.job.effort, '', 'Default leaves effort to the agent');
  assert.deepEqual(Object.keys(msg.job).filter((k) => /amendment/.test(k)), []);
  assert.equal(f.q('#job-dialog').open, true);
});

const reviewSent = (f) => { const m = f.sent.at(-1); return m && Object.fromEntries(Object.entries(m).filter(([k, v]) => v !== undefined && k !== 'plan')); };
const footerButton = (f, field) => f.q(`.job-detail-footer [data-review="${field}"]`);
const footerHint = (f) => f.q('.job-detail-footer .job-flags-hint').textContent;

test('the footer checkpoints are buttons: a switch counts from the next gate, keeps the dialog, and offers Undo', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }];
  f.view.update(f.data); f.view.openDetail('job1');
  const code = () => footerButton(f, 'reviewCode');
  assert.deepEqual([code().tagName, code().type, code().getAttribute('aria-pressed'), code().getAttribute('aria-label')], ['BUTTON', 'button', 'true', 'Code: You review. Switch to Auto']);
  assert.equal(f.q('.job-detail-footer .job-flags').getAttribute('role'), 'group');
  assert.equal(footerButton(f, 'reviewPlan').getAttribute('aria-disabled'), 'true');
  assert.match(footerButton(f, 'reviewPlan').getAttribute('aria-label'), /^Plan: You review\. The plan is already approved/);
  const before = f.sent.length;
  footerButton(f, 'reviewPlan').click();
  assert.equal(f.sent.length, before, 'a locked checkpoint sends nothing');
  code().dispatchEvent(new f.window.Event('pointerenter'));
  assert.match(footerHint(f), /Code: You review You see each PR working and read its diff before it’s committed\. Click for Auto\./);
  code().click();
  assert.deepEqual(reviewSent(f), { type: 'job-action', id: 'job1', action: 'set-review', field: 'reviewCode', you: false });
  assert.deepEqual([code().className, code().getAttribute('aria-pressed'), code().getAttribute('aria-busy')], ['job-flag auto', 'false', 'true'], 'shown at once, busy until the job confirms it');
  assert.match(footerHint(f), /Code: Auto From the next PR on\. Undo/);
  f.view.created({ event: 'job-action-complete', jobId: 'job1', action: 'set-review' });
  assert.equal(f.q('#job-dialog').open, true, 'the switch was made here, so the dialog stays');
  job.reviewCode = false; f.view.update(f.data);
  assert.equal(code().getAttribute('aria-busy'), null);
  assert.equal(code().getAttribute('aria-label'), 'Code: Auto. Switch to You review');
  f.q('[data-review-undo]').click();
  assert.deepEqual(reviewSent(f), { type: 'job-action', id: 'job1', action: 'set-review', field: 'reviewCode', you: true });
  assert.match(footerHint(f), /Code: You review Switched back\./);
  assert.equal(f.q('[data-review-undo]'), null, 'Undo is for one step');
  f.view.reviewFailed({ event: 'job-action-failed', jobId: 'job1', action: 'set-review', field: 'reviewCode', error: 'Job was cancelled' });
  assert.equal(code().getAttribute('aria-pressed'), 'false', 'a refusal snaps back to what the job says');
  assert.match(footerHint(f), /Code: Auto Job was cancelled/);
});

test('switching to Auto while work waits at the checkpoint asks first, and only then releases it', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'review', state: 'verified', ready: { checks: ['Tests pass'], receiptId: 'run_1' } }, { ...sub('web'), stage: 'review', state: 'verified', ready: { checks: ['Tests pass'], receiptId: 'run_2' } }];
  f.view.update(f.data); f.view.openDetail('job1');
  const before = f.sent.length;
  footerButton(f, 'reviewCode').click();
  assert.equal(f.sent.length, before, 'nothing is sent before the human confirms');
  const confirm = () => f.q('#job-review-confirm');
  assert.match(confirm().textContent, /Switch Code to Auto\?2 diffs are waiting for your review\. Auto lets them through now/);
  assert.equal(confirm().querySelector('button.primary').textContent, 'Commit and open 2 PRs');
  f.view.update(f.data);
  assert.ok(confirm(), 'a graph tick leaves the question open');
  confirm().querySelector('[data-review-keep]').click();
  assert.equal(confirm(), null); assert.equal(f.sent.length, before, 'Keep You review leaves everything as it was');
  assert.equal(footerButton(f, 'reviewCode').getAttribute('aria-pressed'), 'true');
  footerButton(f, 'reviewCode').click();
  confirm().dispatchEvent(f.event('submit'));
  assert.deepEqual(reviewSent(f), { type: 'job-action', id: 'job1', action: 'set-review', field: 'reviewCode', you: false, release: true });
  assert.match(footerHint(f), /Code: Auto 2 diffs are being committed and opened as PRs\. Released work can’t be pulled back\./);
  assert.equal(f.q('[data-review-undo]'), null, 'released work has no Undo');
});

test('Plan switched to Auto on a drafted plan approves the draft on display; a finished job locks every checkpoint', (t) => {
  const f = fixture(t);
  f.data.jobs[0].plan = { ...plan, subJobs: [...plan.subJobs, { id: 'spike', kind: 'session', title: 'Run spike', storyId: 'story', after: [], brief: 'Do it here' }] };
  f.view.update(f.data); f.view.openDetail('job1');
  assert.ok(footerButton(f, 'reviewSessions'), 'a planned session sub-job is enough to switch Session results');
  f.q('[data-title="0"]').value = 'Deliver the API'; f.q('[data-title="0"]').dispatchEvent(f.event('input'));
  footerButton(f, 'reviewPlan').click();
  assert.equal(f.q('#job-review-confirm button.primary').textContent, 'Approve the plan and start');
  f.q('#job-review-confirm').dispatchEvent(f.event('submit'));
  const msg = f.sent.at(-1);
  assert.deepEqual([msg.action, msg.field, msg.you, msg.release, msg.revision, msg.plan.subJobs[0].title], ['set-review', 'reviewPlan', false, true, 2, 'Deliver the API']);
  f.q('#job-dialog').close();
  const job = f.data.jobs[0]; job.stage = 'done'; job.subJobs = [{ id: 'spike', kind: 'session', title: 'Run spike', after: [], brief: 'Do it here', sessions: [], repairs: [], stage: 'done' }]; f.view.update(f.data);
  f.view.openDetail('job1');
  assert.deepEqual([...document.querySelectorAll('.job-detail-footer [data-review]')].map((b) => [b.dataset.review, b.getAttribute('aria-disabled')]),
    [['reviewPlan', 'true'], ['reviewCode', 'true'], ['reviewMerge', 'true'], ['reviewSessions', 'true'], ['reviewRed', 'true']]);
  assert.match(footerButton(f, 'reviewMerge').getAttribute('aria-label'), /The job is finished/);
});

test('the Plan checkpoint can be set to Auto in the new-job form, and is a flag on the job', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  const plan = () => f.q('.job-detail-footer .job-flag');
  assert.equal(plan().getAttribute('aria-label'), 'Plan: You review. Switch to Auto', 'a job without the flag still reviews its plan');
  assert.equal(plan().title, 'Plan: You review. You approve the plan before any ticket, PR or session starts');
  assert.ok(plan().classList.contains('you') && plan().querySelector('.job-flag-badge'), 'filled amber with the hand badge');
  assert.deepEqual([...document.querySelectorAll('.job-detail-footer .job-flag')].map((e) => [e.getAttribute('aria-label').split('.')[0], e.className]),
    [['Plan: You review', 'job-flag you'], ['Code: You review', 'job-flag you'], ['Merge: You review', 'job-flag you'], ['Red steps: You decide', 'job-flag you']], 'no session sub-jobs, so no Session results flag');
  f.q('#job-dialog').close();
  job.reviewPlan = false; job.reviewMerge = false; f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.equal(plan().title, 'Plan: Auto. Work starts as soon as the plan is drafted');
  assert.ok(plan().classList.contains('auto'), 'a dashed outline with the fast-forward badge');
  assert.match(f.q('.job-flag.auto[aria-label^="Merge: Auto"]').title, /PRs merge once checks pass, unless a reviewer leaves blocking comments/);
  f.q('#job-dialog').close();
  f.q('#job-new').click(); const form = f.q('#job-create-form');
  const row = form.querySelector('.job-review[data-checkpoint="reviewPlan"]');
  const toggle = row.querySelector('.job-review-toggle'); const input = form.elements.reviewPlan;
  assert.equal(row.querySelectorAll('input').length, 1, 'one click-to-toggle control, not a pair');
  assert.deepEqual([input.type, input.getAttribute('role'), input.checked, input.getAttribute('aria-label'), toggle.title, toggle.textContent], ['checkbox', 'switch', true, 'Plan: You review', 'Plan: You review', '']);
  assert.ok(row.querySelector('.job-review-row').contains(toggle), 'on the same row as the name');
  assert.equal(row.querySelector('.job-review-name').title, 'You approve the plan before any ticket, PR or session starts');
  toggle.click();
  assert.equal(input.checked, false);
  assert.deepEqual([input.getAttribute('aria-label'), toggle.title], ['Plan: Auto', 'Plan: Auto']);
  assert.equal(row.querySelector('.job-review-name').title, 'Work starts as soon as the plan is drafted', 'the hint follows the choice');
  form.elements.intent.value = 'Deliver it'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).job.reviewPlan, false);
  assert.equal(f.sent.at(-1).job.reviewCode, true);
});

const click = (f, sel) => { const el = f.q(sel); assert.ok(el, `${sel} exists`); el.click(); };
const picked = (form) => ['agent', 'model', 'effort'].map((k) => form.elements[k].value);

test('new-job picker keeps an effort both models offer, drops one the new agent lacks, and sends the pick', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  assert.equal(form.querySelectorAll('select[name=agent],select[name=model],select[name=effort]').length, 0, 'the selects are gone');
  assert.deepEqual(picked(form), ['claude', 'sonnet', ''], 'no usual: the first agent’s default, effort left to the agent');
  click(f, '.pick-bar[data-effort=max]'); assert.equal(form.elements.effort.value, 'max');
  click(f, '.pick-ticket'); assert.ok(f.q('.pick-cabinet'), 'the ticket opens the cabinet');
  click(f, '.pick-tab[data-agent=codex]'); click(f, '.pick-cell[data-value="gpt-5.6-sol"]');
  assert.deepEqual(picked(form), ['codex', 'gpt-5.6-sol', ''], 'codex has no max, so the level falls back to auto');
  assert.equal(f.q('.pick-cabinet'), null, 'choosing closes the cabinet');
  click(f, '.pick-bar[data-effort=high]');
  click(f, '.pick-ticket'); click(f, '.pick-tab[data-agent=claude]'); click(f, '.pick-cell[data-value=sonnet]');
  assert.deepEqual(picked(form), ['claude', 'sonnet', 'high'], 'high survives the switch back');
  form.elements.intent.value = 'I';
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent[0].job.effort, 'high'); assert.equal(f.sent[0].job.agent, 'claude'); assert.equal(f.sent[0].job.model, 'sonnet');
  assert.deepEqual(f.usualSaves, [{ type: 'job-settings', patch: { usualPick: { agent: 'claude', model: 'sonnet', effort: 'high' } } }], 'creating a job saves the pick as your usual');
});

test('new-job picker opens on your usual, says when it is not, and one click returns to it', (t) => {
  const f = fixture(t); f.data.settings.usualPick = { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' };
  f.q('#job-new').click(); const form = f.q('#job-create-form');
  assert.deepEqual(picked(form), ['codex', 'gpt-5.6-sol', 'high']);
  assert.equal(f.q('.pick-usual').textContent.trim(), 'Your usual');
  click(f, '.pick-ticket'); click(f, '.pick-tab[data-agent=claude]'); click(f, '.pick-cell[data-value=sonnet]');
  assert.match(f.q('.pick-usual').textContent, /Not your usual/);
  assert.match(f.q('.pick-reset').textContent, /Use Sol 5\.6 · high/);
  click(f, '.pick-reset');
  assert.deepEqual(picked(form), ['codex', 'gpt-5.6-sol', 'high']);
  assert.equal(f.q('.pick-usual').textContent.trim(), 'Your usual');
  f.view.update(f.data); f.data.settings.usualPick = { agent: 'codex', model: 'gone', effort: 'high' };
  f.q('#job-dialog').close(); f.q('#job-new').click();
  assert.deepEqual(picked(f.q('#job-create-form')), ['claude', 'sonnet', ''], 'a usual the catalog no longer has falls back to the default');
  assert.equal(f.q('.pick-usual').textContent.trim(), 'Claude\'s default');
});

test('new-job picker follows a changed catalog and Escape closes only the cabinet', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  click(f, '.pick-ticket');
  form.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(f.q('.pick-cabinet'), null, 'Escape closes the cabinet');
  assert.ok(f.q('#job-create-form'), 'the dialog content stays');
  click(f, '.pick-ticket');
  f.view.update(f.data);
  assert.ok(f.q('.pick-cabinet'), 'an unchanged catalog leaves the open cabinet alone');
});

test('the new-job primary action starts planning and the plain button parks it in the backlog', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  const [primary, backlog] = form.querySelectorAll('.job-actions button');
  assert.equal(primary.className, 'primary'); assert.equal(primary.textContent, 'Start planning');
  assert.equal(backlog.className, ''); assert.equal(backlog.textContent, 'Add to backlog');
  form.elements.intent.value = 'Deliver it';
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent[0].start, true, 'Enter is the main action');
  form.dispatchEvent(new f.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: primary }));
  assert.equal(f.sent[1].start, true);
  form.dispatchEvent(new f.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: backlog }));
  assert.equal(f.sent[2].start, false);
});

test('new idea is a brief beside a property sidebar, and the brief is the description, images and checkpoint tiles', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  const brief = form.querySelector('.job-create-brief'); const props = form.querySelector('.job-create-props');
  assert.equal(brief.querySelector('h2').textContent, 'New idea');
  assert.ok(brief.contains(form.elements.intent));
  assert.equal(brief.querySelector('details'), null, 'no folded planning guidance or repository hints');
  assert.deepEqual([...brief.querySelectorAll('textarea')].map((e) => e.name), ['intent']);
  assert.equal(form.elements.repos, undefined); assert.equal(form.elements.planningPrompt, undefined);
  assert.deepEqual([...props.querySelectorAll('legend')].map((l) => l.textContent), ['Task', 'Agent', 'Sandbox', 'Images', 'After delivery']);
  assert.deepEqual([...brief.querySelectorAll('legend')].map((l) => l.textContent), ['Review checkpoints']);
  for (const name of ['taskId', 'newTaskName', 'agent', 'model', 'effort', 'shareImages', 'updateMain']) assert.ok(props.contains(form.querySelector(`[name="${name}"]`)), `${name} lives in the sidebar`);
  for (const name of ['reviewPlan', 'reviewCode', 'reviewMerge', 'reviewSessions', 'reviewWrites', 'reviewRed']) assert.ok(brief.contains(form.querySelector(`[name="${name}"]`)), `${name} is a tile under the brief`);
  assert.ok(props.querySelector('#job-pick').querySelector('.pick-ticket') && props.querySelector('#job-pick .pick-meter'), 'the picker is a ticket with an effort meter in the sidebar');
  assert.deepEqual([...brief.querySelectorAll('.job-review')].map((r) => [r.querySelector('input').name, r.querySelector('.job-review-name').firstChild.textContent, form.elements[r.dataset.checkpoint].checked, r.querySelector('.job-review-name').title, r.querySelector('small')]),
    [['reviewPlan', 'Plan', true, 'You approve the plan before any ticket, PR or session starts', null], ['reviewCode', 'Code', true, 'You see each PR working and read its diff before it’s committed', null], ['reviewMerge', 'Merge', true, 'You approve each PR once its checks pass', null], ['reviewSessions', 'Session results', true, 'You approve each session’s receipt before it counts as done', null], ['reviewWrites', 'Writes', false, 'Each write is made by its session, with a receipt', null], ['reviewRed', 'Red steps', true, 'Wrangler proposes a fix for a red step and waits for you to decide', null]]);
  assert.deepEqual([...props.querySelectorAll('.job-toggle')].map((l) => [l.querySelector('input').name, l.querySelector('input').checked, l.querySelector('span').title]),
    [['shareImages', true, 'every session on the job sees them, not just planning'], ['updateMain', false, '']]);
  assert.equal(form.querySelector('.job-create-foot').textContent, 'Start planningAdd to backlog');
  form.elements.intent.value = 'Deliver it';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent[0], { type: 'job-create', idea: true, start: true, job: { intent: 'Deliver it', agent: 'claude', model: 'sonnet', effort: '', reviewPlan: true, reviewCode: true, reviewMerge: true, reviewSessions: true, reviewWrites: false, reviewRed: true, sandbox: 'auto', writableDirs: [], updateMain: false, images: [], shareImages: true, taskId: null } });
});

test('new jobs need only an outcome and leave repositories to planning', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  form.elements.intent.value = 'Customers can access their accounts';
  assert.equal(form.checkValidity(), true);
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent[0].type, 'job-create'); assert.equal('repos' in f.sent[0].job, false); assert.equal('planningPrompt' in f.sent[0].job, false);
  f.view.created();
  const job = f.data.jobs[0]; job.repos = []; job.plan = null; job.stage = 'backlog'; f.view.update(f.data);
  f.q('.job-plate-open').click();
  assert.match([...document.querySelectorAll('#job-dialog .job-chip')].map((c) => c.title).join(' '), /discover the repositories/);
  assert.equal(f.q('#job-dialog .job-intent').textContent, 'Reliable sign-in', 'a backlog job shows the outcome it was given');
});

test('the plan review shows discovered checkout paths before approval', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.plan.subJobs[0].repo = '/projects/api/service'; job.plan.subJobs[1].repo = '/projects/web/service';
  job.repos = job.plan.subJobs.map((s) => s.repo); f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((e) => e.title.split('\n')[2]), job.repos, 'each node names its checkout on hover');
  f.q('[data-action="approve-plan"]').click();
  assert.deepEqual(f.sent[0].plan.subJobs.map((s) => s.repo), job.repos);
});

test('Automation settings holds the review defaults New job starts from', (t) => {
  const f = fixture(t);
  assert.deepEqual(reviewDefaultsOf({}), { reviewPlan: true, reviewCode: true, reviewMerge: true, reviewSessions: true, reviewWrites: false, reviewRed: true }, 'a graph from before the setting seeds the original form');
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form');
  const plan = form.querySelector('[data-checkpoint="reviewPlan"]'); const note = plan.querySelector('.job-review-note');
  assert.equal(form.querySelector('.job-settings-review legend').textContent, 'Defaults for new jobs');
  assert.equal(note.hidden, true, 'the agent warning shows only while Plan is on Auto');
  form.elements.reviewPlan.checked = false; plan.dispatchEvent(f.event('change'));
  assert.equal(note.hidden, false); assert.equal(plan.querySelector('.job-review-name').title, 'Work starts as soon as the plan is drafted');
  assert.equal(form.elements.reviewPlan.getAttribute('aria-label'), 'Plan: Auto');
  form.elements.reviewWrites.checked = true; form.dispatchEvent(f.event('submit'));
  const reviewDefaults = f.sent.at(-1).patch.reviewDefaults;
  assert.deepEqual(reviewDefaults, { reviewPlan: false, reviewCode: true, reviewMerge: true, reviewSessions: true, reviewWrites: true, reviewRed: true });
  f.data.settings.reviewDefaults = reviewDefaults; f.view.update(f.data);
  f.q('#job-new').click(); const create = f.q('#job-create-form');
  assert.deepEqual(CHECKPOINTS.map((cp) => create.elements[cp.field].checked), [false, true, true, true, true, true]);
  assert.equal(create.querySelector('.job-review-note'), null, 'New job is per job, so it carries no warning');
  assert.equal(create.querySelector('[data-checkpoint="reviewPlan"] .job-review-name').title, 'Work starts as soon as the plan is drafted');
});

test('global concurrency, pause and repair limits are explicit controls, and no step is on a clock', (t) => {
  const f = fixture(t); f.q('#jobs-concurrency').value = '4'; f.q('#jobs-concurrency').dispatchEvent(f.event('change'));
  assert.deepEqual(f.sent[0], { type: 'job-settings', patch: { concurrency: 4 } });
  f.q('#jobs-pause').click(); assert.equal(f.sent[1].patch.paused, true);
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form');
  assert.equal(form.elements.maxRunMinutes, undefined, 'a step ends with a receipt or an idle session, not a timeout');
  form.elements.maxRepairs.value = '1'; form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1).patch, { maxRepairs: 1, maxReplans: 2, deploymentStaleMinutes: 30, ideApp: 'IntelliJ IDEA', plateArt: 'quiet', backdrop: 'sky', reviewDefaults: { reviewPlan: true, reviewCode: true, reviewMerge: true, reviewSessions: true, reviewWrites: false, reviewRed: true } });
});

test('the Jobs view draws over its own sky unless the Wrangler background is chosen, which persists through settings', (t) => {
  const f = fixture(t), jobs = f.q('#jobs');
  assert.equal(jobs.dataset.backdrop, 'sky', 'settings saved before the backdrop existed read as the sky');
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form');
  assert.deepEqual([...form.elements.backdrop.options].map((o) => [o.value, o.textContent]), [['sky', 'Wrangler² sky'], ['wrangler', 'Wrangler background']]);
  assert.equal(form.elements.backdrop.value, 'sky');
  form.elements.backdrop.value = 'wrangler'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).patch.backdrop, 'wrangler');
  f.data.settings.backdrop = 'wrangler'; f.view.update(f.data);
  assert.equal(jobs.dataset.backdrop, 'wrangler');
  f.q('#jobs-settings').click();
  assert.equal(f.q('#job-settings-form').elements.backdrop.value, 'wrangler', 'the dialog opens on the saved choice');
  f.data.settings.backdrop = 'nebula'; f.view.update(f.data);
  assert.equal(jobs.dataset.backdrop, 'sky', 'an unknown value falls back to the sky');
});

test('dependency waves, session waits and escaped titles remain compact', () => {
  assert.deepEqual([...dependencyLevels(plan)], [['api', 0], ['web', 1]]);
  const spike = { ...sub('spike'), kind: 'session', stage: 'session' };
  const job = { title: '<script>bad()</script>', stage: 'active', subJobs: [spike, { ...sub('web', ['spike']), stage: 'implementation' }], runs: [], moves: [] };
  assert.match(jobStatus(job, job.subJobs[1]).text, /Waiting for 1 session/);
  job.subJobs[0].title = '<img src=x>';
  const html = plateHtml({ ...job, id: 'j1', repos: [] }, 'opus'); assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<img'));
  assert.equal(jobNeedsReview(job, job.subJobs[1]), false);
});

test('cleanup failures stay discoverable even after every sub-job is delivered', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.error = 'Planning worktree has local changes'; job.subJobs = [{ ...sub('api'), stage: 'done' }];
  f.view.update(f.data); assert.equal(jobCards([job]).length, 2);
  assert.equal(document.querySelectorAll('.job-plate').length, 1); f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.match(f.q('#job-dialog').textContent, /Planning worktree has local changes/); assert.ok(f.q('#job-retry'));
});

test('retry targets the job when a sub-job displays an inherited coordinator error', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.error = 'Could not observe a stopped worker';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  f.q('#job-retry').click();
  assert.equal(f.q('#job-retry-form [name="note"]'), null, 'a coordinator retry has no session to leave a note for');
  f.q('#job-retry-form').dispatchEvent(new f.window.Event('submit', { cancelable: true }));
  assert.equal(f.sent.at(-1).action, 'retry');
  assert.equal(f.sent.at(-1).id, job.id);
  assert.equal(f.sent.at(-1).subJobId, undefined);
  assert.equal('note' in f.sent.at(-1), false);

  job.subJobs[0].error = 'Restore repository access';
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  f.q('#job-retry').click();
  assert.match(f.q('#job-dialog').textContent, /Restore repository access/, 'the error is in front of the human while they write the note');
  f.q('#job-retry-form [name="note"]').value = 'Access restored, go again';
  f.q('#job-retry-form').dispatchEvent(new f.window.Event('submit', { cancelable: true }));
  assert.equal(f.sent.at(-1).subJobId, 'api');
  assert.equal(f.sent.at(-1).note, 'Access restored, go again');
});

const sessionSub = (id, after = []) => ({ id, kind: 'session', title: `Run ${id}`, storyId: 'story', jiraKey: 'AUTH-1', after, brief: 'Do it here', sessions: ['s1'], repairs: [] });

test('a reported session needs you, a running one spins, and approval is pinned to the receipt', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sessionSub('spike'), stage: 'review', result: { checks: ['Schema documented'], receiptId: 'receipt9' } }, { ...sub('api', ['spike']), stage: 'implementation' }, { ...sessionSub('backfill', ['api']), stage: 'session' }];
  job.runs = [{ id: 'r1', subJobId: 'backfill', phase: 'session', stopped: false, status: 'working' }];
  f.view.update(f.data);
  assert.deepEqual([...document.querySelectorAll('.job-plate-graph .node')].map((e) => e.getAttribute('data-state')), ['needs', 'waiting', 'running']);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Review result');
  assert.equal(jobStatus(job, job.subJobs[1]).text, 'Waiting for 1 session'); assert.equal(jobStatus(job, job.subJobs[0]).text, 'Ready to review');
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true); assert.equal(f.q('#jobs-review-count').textContent, '1');
  f.q('.job-plate-open').click();
  assert.match(f.q('.job-flag.you[aria-label^="Session results: You review"]').title, /approve each session’s receipt/);
  assert.equal(f.q('#job-dialog .job-actions button.primary').dataset.openSub, 'spike', 'the job’s one button opens what needs reading');
  f.q('#job-dialog .job-actions button.primary').click();
  assert.match(f.q('#job-dialog').textContent, /Schema documented/);
  f.q('[data-action="approve-session"]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'spike', action: 'approve-session', head: undefined, sessionReceiptId: 'receipt9' });
  assert.equal(f.q('#job-revise-session'), null, 'Request changes is the box on the review, not a button that opens a dialog');
  const text = f.q('.job-change textarea'); text.value = 'Check staging too'; text.dispatchEvent(f.event('input')); f.q('[data-change-send]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'spike', action: 'request-change', at: 'session', ref: 'receipt9', text: 'Check staging too' });
});

test('Approve keeps one click, and its caret opens a popup whose words go to later steps, on a session result and on code', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sessionSub('spike'), stage: 'review', result: { checks: ['Schema documented'], receiptId: 'receipt9' } },
    { ...sub('api', ['spike']), stage: 'review', state: 'verified', worktree: { path: '/wt', branch: 'fix/AUTH-1' }, sessions: ['s1'], ready: { checks: ['Tests pass'], receiptId: 'run_1' } }];
  f.view.update(f.data);
  f.q('[data-sub="spike"]').dispatchEvent(f.event('click'));
  const split = f.q('.job-actions .job-approve-split');
  assert.equal(split.querySelector('button.primary').dataset.action, 'approve-session');
  const more = split.querySelector('.job-approve-more');
  assert.equal(more.open, false, 'the note is out of the way until asked for');
  assert.equal(more.querySelector('summary').getAttribute('aria-label'), 'Approve with context for later steps');
  more.open = true; more.dispatchEvent(f.event('toggle'));
  assert.match(more.querySelector('label').textContent, /Add context for later steps/);
  more.querySelector('textarea').value = '  Use the <v2> table  ';
  f.view.update(f.data);
  assert.equal(f.q('.job-approve-more').open, true, 'the popup survives a tick');
  assert.equal(f.q('[data-approve-note]').value, '  Use the <v2> table  ', 'a tick does not wipe what is being typed');
  f.q('.job-approve-more summary').dispatchEvent(new f.window.Event('click', { bubbles: true }));
  f.q('[data-approve-note]').dispatchEvent(f.event('click'));
  assert.equal(f.q('.job-approve-more').open, true, 'a click inside the popup leaves it open');
  f.q('#job-dialog h2, #job-dialog h3').dispatchEvent(f.event('click'));
  assert.equal(f.q('.job-approve-more').open, false, 'a click elsewhere closes it');
  f.view.update(f.data);
  assert.equal(f.q('.job-approve-more').open, false, 'and the next tick does not reopen it');
  f.q('.job-approve-more').open = true; f.q('.job-approve-more').dispatchEvent(f.event('toggle'));
  f.q('[data-approve-note]').value = '  Use the <v2> table  ';
  f.q('[data-action="approve-session"][data-with-note]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'spike', action: 'approve-session', head: undefined, sessionReceiptId: 'receipt9', note: 'Use the <v2> table' });
  f.q('.job-approve-split > button.primary').click();
  assert.equal('note' in f.sent.at(-1), false, 'plain Approve never sends the popup\'s words');
  Object.assign(job.subJobs[0], { stage: 'cleanup', approvalNote: 'Use the <v2> table' });
  job.moves = [{ id: 'mv_1', at: 1757400000000, subJobId: 'spike', move: 'approve-session', note: 'Use the <v2> table', detail: 'Approved the result of “Run spike”' }];
  f.q('[data-approve-note]').value = ''; f.view.update(f.data);
  assert.equal(f.q('[data-approve-note]'), null, 'no popup once it is approved');
  assert.equal(f.q('.job-approval-note').textContent, 'Use the <v2> table', 'escaped, and kept on the step');
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('.job-approve-split > button.primary').textContent, 'Approve & open PR');
  assert.equal(f.q('[data-with-note]').textContent, 'Approve & open PR with note');
  f.q('[data-approve-note]').value = 'Keep the flag off';
  f.q('[data-action="approve-code"][data-with-note]').click();
  assert.deepEqual([f.sent.at(-1).action, f.sent.at(-1).readyReceiptId, f.sent.at(-1).note], ['approve-code', 'run_1', 'Keep the flag off']);
  f.q('[data-open-job]').click();
  assert.equal(f.q('.job-move-log q').textContent, 'Use the <v2> table', 'the job history shows the words with the approval');
});

const humanSub = (id, after = []) => ({ id, kind: 'human', title: `Sign ${id}`, storyId: 'story', jiraKey: 'AUTH-1', after, brief: 'Click approve in the vendor console', sessions: [], repairs: [] });

test('a waiting human task needs you, and the work behind it waits', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...humanSub('licence'), stage: 'human', state: 'queued' }, { ...sub('api', ['licence']), stage: 'implementation' }];
  f.view.update(f.data);
  assert.deepEqual([...document.querySelectorAll('.job-plate-graph .node')].map((e) => e.getAttribute('data-state')), ['needs', 'waiting']);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Your turn');
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'needs', text: 'Needs you' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true); assert.equal(f.q('#jobs-review-count').textContent, '1');
  assert.equal(jobStatus(job, job.subJobs[1]).text, 'Waiting for 1 human task');
  assert.match(f.q('.job-plate-open').title, /1 PR · 1 human task/);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('.job-dependency-list .job-chip').title, 'Start after Sign licence');
  f.q('[data-open-job]').click();
  assert.equal(f.q('[data-node="licence"] .job-kind').getAttribute('aria-label'), 'Human');
  assert.match(f.q('[data-node="licence"]').title, /Only you can do this one/);
  // One a prerequisite still gates is just waiting, not the human's yet.
  const behind = { ...humanSub('audit', ['api']), stage: 'human', state: 'queued' };
  assert.deepEqual(jobStatus({ ...job, subJobs: [...job.subJobs, behind] }, behind), { tone: 'muted', text: 'Waiting for 1 deployment' });
  assert.equal(jobNeedsReview({ ...job, subJobs: [...job.subJobs, behind] }, behind), false);
});

test('the human task dialog submits multiline output with Mark done and preserves a draft when work starts', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...humanSub('licence'), stage: 'human', state: 'queued' }];
  f.view.update(f.data);
  f.q('[data-sub="licence"]').dispatchEvent(f.event('click'));
  const dialog = f.q('#job-dialog');
  assert.match(dialog.textContent, /Click approve in the vendor console/, 'the brief is the instruction, not a folded detail');
  assert.match(hint(f), /No agent will ever run this one/);
  assert.equal(dialog.querySelector('[data-action="start-human"]').className, '');
  const output = `ssh-ed25519 ${'A'.repeat(600)} user@host\nSecond line`;
  dialog.querySelector('textarea[name="output"]').value = output;
  f.q('[data-action="start-human"]').click();
  assert.deepEqual(f.sent.at(-1).action, 'start-human'); assert.equal(f.sent.at(-1).subJobId, 'licence');

  job.subJobs[0].state = 'doing'; f.view.update(f.data);
  assert.ok(f.q('.job-plate-graph .node[data-sub="licence"]').classList.contains('running'), 'in progress by hand reads as moving');
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'In progress' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
  assert.equal(dialog.querySelector('[data-action="start-human"]'), null, 'it is already started');
  assert.equal(dialog.querySelector('textarea[name="output"]').value, output);
  assert.equal(dialog.querySelector('#job-human-form button.primary').textContent, 'Mark done');
  dialog.querySelector('#job-human-form').dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'licence', action: 'finish-human', output });

  job.subJobs[0] = { ...job.subJobs[0], stage: 'done', state: 'done', result: { checks: ['Done by hand'], output: '<img src=x onerror=alert(1)>\nssh-ed25519 AAAA', at: 1, receiptId: null } };
  f.data.jobs[0] = { ...job }; f.view.update(f.data);
  assert.ok(f.q('.job-plate-graph .node[data-sub="licence"]').classList.contains('done'));
  assert.deepEqual(jobStatus(f.data.jobs[0], f.data.jobs[0].subJobs[0]), { tone: 'done', text: 'Done' });
  f.q('[data-sub="licence"]').dispatchEvent(f.event('click'));
  assert.match(dialog.textContent, /ssh-ed25519 AAAA/);
  assert.equal(dialog.querySelector('.job-human-output').textContent, '<img src=x onerror=alert(1)>\nssh-ed25519 AAAA');
  assert.equal(dialog.querySelector('.job-human-output img'), null, 'output is escaped, not rendered as markup');
  assert.equal(dialog.querySelector('#job-human-form'), null, 'a finished task has no marks left');
  dialog.close();
});

test('a human task can be finished directly with no output', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...humanSub('licence'), stage: 'human', state: 'queued' }]; f.view.update(f.data);
  f.q('[data-sub="licence"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('#job-human-form button.primary').textContent, 'Mark done');
  primaryAction(f.q('#job-dialog'))();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'licence', action: 'finish-human' });
});

test('a plan proposing a human task draws it as a third kind with no repository', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.plan = { ...plan, subJobs: [humanSub('licence'), sessionSub('spike', ['licence']), sub('api', ['spike'])] }; f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  const kinds = () => [...document.querySelectorAll('.job-node')].map((n) => n.querySelector('.job-kind').getAttribute('aria-label'));
  assert.deepEqual(kinds(), ['Human', 'Session', 'PR'], 'the kind is a glyph, named for assistive tech and on hover');
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((n) => n.title.split('\n')[0]), ['Only you can do this one — no agent, no pull request', 'An agent session on this machine — no pull request', 'A pull request in a repository']);
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((n) => n.title.includes('~') || n.title.includes('/repo')), [false, false, true], 'only a PR names a repository');
  assert.equal(f.q('[data-action="approve-plan"]').title, 'Starts 3 steps', 'a human task is a step');
  f.q('#job-dialog').close();
});

test('plans show session rows without a repository and new jobs default to reviewing session results', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.plan = { ...plan, subJobs: [sessionSub('spike'), sub('api', ['spike'])] }; f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((n) => [n.dataset.node, n.querySelector('.job-kind').getAttribute('aria-label')]), [['spike', 'Session'], ['api', 'PR']]);
  assert.match(f.q('[data-node="spike"]').title, /An agent session on this machine/);
  assert.equal(f.q('[data-action="approve-plan"]').title, 'Starts 2 steps');
  f.q('#job-dialog').close();
  f.q('#job-new').click(); const form = f.q('#job-create-form');
  form.elements.intent.value = 'Deliver it'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).job.reviewSessions, true);
});

test('a plan lists its story titles, and approval of keyless stories says whether each is created at once or held for review', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan = structuredClone(plan); job.plan.stories = [{ id: 'story', title: 'Customers can sign in' }, { id: 'audit', project: 'SEC', key: undefined, title: 'Sign-ins are audited' }, { id: 'old', key: 'AUTH-9', title: 'Existing work' }, { id: 'events', project: 'SEC', title: 'Sign-in events are emitted' }];
  job.plan.subJobs[1].storyId = 'audit'; job.plan.subJobs.forEach((s) => delete s.jiraKey); f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-story-key')].map((e) => e.textContent), ['NEW-1', 'SEC-NEW-1', 'AUTH-9', 'SEC-NEW-2'], 'proposals are numbered per project');
  assert.equal(document.querySelectorAll('.job-story-key.job-story-new').length, 3);
  assert.equal(document.querySelectorAll('.job-stories input, .job-stories textarea, .job-new-stories').length, 0, 'plan review shows titles only: a story is edited on its create, in review');
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((e) => e.title.split('\n')[1]), ['NEW-1', 'SEC-NEW-1']);
  assert.deepEqual([...document.querySelectorAll('.job-appbar .job-chip')].slice(1).map((c) => c.textContent), ['NEW-1', 'SEC-NEW-1', '+2'], 'the app bar names the first stories; the rest are one chip');
  assert.match(f.q('.job-appbar .job-chip[title^="Customers can sign in"]').title, /created only after you approve/);
  assert.doesNotMatch(f.q('[data-action="approve-plan"]').title, /held/);
  job.reviewWrites = true; f.view.update(f.data); f.q('#job-dialog').close(); f.q('[data-job="job1"]').click();
  assert.match(f.q('[data-action="approve-plan"]').title, / · 3 writes held for you$/, 'a job reviewing its writes holds every create');
  job.reviewWrites = false; job.plan.subJobs.unshift({ id: 'create-story', kind: 'write', place: { type: 'jira' }, title: 'Create story: Customers can sign in', storyId: 'story', after: [], action: { type: 'create' }, review: true });
  f.view.update(f.data); f.q('#job-dialog').close(); f.q('[data-job="job1"]').click();
  assert.match(f.q('[data-action="approve-plan"]').title, / · 1 write held for you$/, 'a create\'s own review wins over the job\'s');
  job.plan.subJobs.shift(); job.plan.stories[0].title = 'Customers sign in without lockouts'; f.view.update(f.data); f.q('#job-dialog').close(); f.q('[data-job="job1"]').click();
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent[0].plan.stories[0].title, 'Customers sign in without lockouts');
  assert.equal(f.sent[0].plan.stories[0].key, undefined, 'the browser never mints a key');
  f.q('#job-dialog').close();
  // Approved: the job runs at once, and creating each keyless story is a write its stories session makes, never asking for review.
  job.stage = 'active'; job.plan = f.sent[0].plan;
  job.subJobs = [{ id: 'stories', kind: 'session', title: 'Create Jira stories', after: [], brief: 'Create them', stage: 'session', state: 'queued', sessions: ['s2'], repairs: [] },
    { id: 'create-story', kind: 'write', place: { type: 'jira' }, title: 'Create story: Customers sign in without lockouts', storyId: 'story', after: [], by: 'stories', action: { type: 'create' }, stage: 'write', state: 'queued', sessions: [], repairs: [] },
    ...job.plan.subJobs.map((s) => ({ ...s, stage: 'implementation', state: 'queued', jiraKey: null }))];
  job.runs = [{ id: 'r2', subJobId: 'stories', phase: 'session', stopped: false, sessionId: 's2' }]; f.view.update(f.data);
  assert.match(f.q('[data-board="job1"] .job-status').textContent, /^Working/);
  assert.ok(f.q('[data-board="job1"]').classList.contains('tone-run'));
  assert.equal(jobNeedsReview(job, null), false);
  assert.equal(jobStatus(job, job.subJobs[2]).text, 'Waiting for a Jira ticket');
  f.q('.job-plate-open[data-job="job1"]').click();
  assert.equal(f.q('[data-action="approve-plan"]'), null);
  const create = f.q('.job-write[data-open-sub="create-story"]');
  assert.match(create.textContent, /^Create.*Create Jira stories is working$/);
  assert.equal(create.closest('.job-stack'), f.q('[data-node="stories"]').closest('.job-stack'), 'a create hangs under the session that makes it');
  assert.match(create.closest('.job-place').querySelector('summary').textContent, /NEW-1/);
});

test('a story create in review is its own editor: summary and fields as planned, and approving creates it with exactly what is left', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan = structuredClone(plan);
  job.plan.stories = [{ id: 'story', key: 'AUTH-1', title: 'Customers can sign in' }, { id: 'audit', project: 'SEC', title: 'Sign-ins are audited',
    fields: [{ name: 'Issue Type', value: 'Story' }, { name: 'Components', value: 'Auth <b>core</b>' }, { name: 'Description', value: 'Every sign-in writes one audit row.' }] }];
  job.plan.subJobs[1].storyId = 'audit'; delete job.plan.subJobs[1].jiraKey; f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.equal(f.q('.job-new-stories'), null, 'plan review no longer edits a story\'s fields');
  assert.equal(f.q('[data-story-field]'), null);
  f.q('#job-dialog').close();
  job.stage = 'active';
  job.subJobs = [{ id: 'stories', kind: 'session', title: 'Create Jira stories', after: [], brief: 'Create them', stage: 'session', state: 'queued', sessions: ['s2'], repairs: [] },
    { id: 'create-audit', kind: 'write', place: { type: 'jira' }, title: 'Create story: Sign-ins are audited', storyId: 'audit', after: [], by: 'stories', action: { type: 'create' }, review: true, stage: 'review', state: 'verified', sessions: [], repairs: [] },
    ...job.plan.subJobs.map((s) => ({ ...s, stage: 'implementation', state: 'queued', sessions: [], repairs: [] }))];
  job.runs = [{ id: 'r2', subJobId: 'stories', phase: 'session', stopped: false, sessionId: 's2', parkedAt: 1, drafts: ['create-audit'] }];
  f.view.update(f.data); f.q('.job-plate-open[data-job="job1"]').click(); f.q('.job-write[data-open-sub="create-audit"]').click();
  const panel = () => f.q('#job-write-review');
  assert.match(f.q('.job-appbar .job-chip-state').title, /Review is on for this write: Create Jira stories drafted it below and nothing has been written to Jira yet/);
  assert.equal(panel().querySelector('[name="storyTitle"]').value, 'Sign-ins are audited');
  assert.deepEqual([...panel().querySelectorAll('dt')].map((e) => e.textContent), ['Project', 'Issue Type', 'Components', 'Description']);
  assert.ok(!panel().innerHTML.includes('<b>core'), 'a planner-written value is escaped');
  assert.deepEqual([...panel().querySelectorAll('.job-actions button')].map((b) => b.textContent.trim()), ['Create in Jira', 'Skip']);
  assert.equal(f.q('#job-write-edit'), null, 'the panel is the editor');
  const title = panel().querySelector('[name="storyTitle"]'); title.value = 'Every sign-in is audited'; title.dispatchEvent(f.event('input'));
  const desc = f.q('[data-story-field="2"]'); desc.value = 'One audit row per sign-in.  '; desc.dispatchEvent(f.event('input'));
  f.q('[data-story-field-remove="1"]').click();
  f.q('[data-story-new-name]').value = 'Labels'; f.q('[data-story-new-value]').value = 'audit';
  f.q('[data-story-field-add]').click();
  assert.deepEqual([...panel().querySelectorAll('dt')].map((e) => e.textContent), ['Project', 'Issue Type', 'Description', 'Labels']);
  assert.equal(panel().querySelector('[name="storyTitle"]').value, 'Every sign-in is audited', 'a redraw keeps what was typed');
  f.q('[data-story-new-name]').value = 'labels'; f.q('[data-story-new-value]').value = 'audit, sso';
  f.q('[data-story-field-add]').click();
  const blank = f.q('[data-story-field="0"]'); blank.value = ' '; blank.dispatchEvent(f.event('input'));
  f.data.jobs[0].revision++; f.view.update(f.data);
  assert.equal(panel().querySelector('[name="storyTitle"]').value, 'Every sign-in is audited', 'a live tick leaves the panel alone');
  panel().requestSubmit();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'create-audit', action: 'approve-write',
    write: { story: { title: 'Every sign-in is audited', fields: [{ name: 'Description', value: 'One audit row per sign-in.' }, { name: 'Labels', value: 'audit, sso' }] } } },
    'an emptied field is left unset; a field added twice is one field');
  f.q('[data-open-job]').click(); f.q('.job-write[data-open-sub="create-audit"]').click();
  f.q('#job-write-review').requestSubmit();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'create-audit', action: 'approve-write' }, 'nothing changed sends no write');
  f.q('[data-action="skip-write"]').click();
  assert.equal(f.sent.at(-1).action, 'skip-write');
});

test('a ticketless plan reviews with no stories, its sub-jobs carry No ticket and never wait for Jira', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan = structuredClone(plan); job.plan.stories = []; job.plan.subJobs.forEach((s) => { delete s.storyId; delete s.jiraKey; }); f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.equal(f.q('.job-appbar .job-chip[title="This work has no Jira ticket"]').textContent, 'No ticket');
  assert.equal(document.querySelectorAll('.job-story-key').length, 0);
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((e) => e.title.split('\n')[1]), ['No ticket', 'No ticket']);
  assert.match(f.q('[data-action="approve-plan"]').title, /^Starts \d+ steps?$/);
  f.q('#job-dialog').close();
  job.stage = 'active'; job.subJobs = job.plan.subJobs.map((s) => ({ ...s, stage: 'implementation', sessions: [], repairs: [] })); f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'muted', text: 'Queued' });
  assert.deepEqual(jobStatus(job, { ...job.subJobs[0], storyId: 'story' }), { tone: 'muted', text: 'Waiting for a Jira ticket' }, 'naming a keyless story is what waits');
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.doesNotMatch(f.q('#job-dialog .job-appbar').textContent, /No ticket/, 'an absent ticket is the normal case, so the step does not say so');
});

test('a plan whose stories all exist reads as existing and approval starts work directly', (t) => {
  const f = fixture(t); f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.match(f.q('.job-plan-more h4').textContent, /existing/);
  assert.equal(f.q('.job-appbar .job-chip[title="Customers can sign in"]').textContent, 'AUTH-1');
  assert.match(f.q('[data-action="approve-plan"]').title, /^Starts \d+ steps?$/);
  assert.equal(f.q('.job-story-key').textContent, 'AUTH-1');
});

test('a job card carries its total price, and each sub-job its own in the detail', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', usd: 3.5, usdEstimated: false }, { ...sub('web'), stage: 'implementation' }];
  job.usd = 12.345; job.usdEstimated = false; f.view.update(f.data);
  assert.equal(f.q('.job-plate-cost').textContent, '$12.35');
  assert.equal(f.q('.job-plate-where').lastElementChild.className, 'job-plate-cost', 'the price closes the footer, opposite the state');
  assert.match(f.q('.job-plate-cost').title, /Total price of this job.*planning.*repairs.*comment triage/);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click')); assert.equal(f.q('#job-dialog .job-detail-cost').textContent, '$3.50');
  f.q('[data-sub="web"]').dispatchEvent(f.event('click')); assert.equal(f.q('#job-dialog .job-detail-cost'), null, 'a sub-job with nothing attributed shows no price');
  f.q('#job-dialog').close();
  // Codex is an estimate everywhere it is shown, exactly as a session card reads it.
  job.usd = 8; job.usdEstimated = true; job.subJobs[0].usdEstimated = true; f.view.update(f.data);
  assert.equal(f.q('.job-plate-cost').textContent, '~$8.00');
  assert.match(f.q('.job-plate-cost').title, /includes an estimate for Codex sessions/);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click')); assert.equal(f.q('#job-dialog .job-detail-cost').textContent, '~$3.50');
});

test('a job with no attributable spend shows no price rather than $0.00', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.usd = null; f.view.update(f.data);
  assert.equal(f.q('.job-plate-cost'), null);
  job.usd = 0; f.view.update(f.data);
  assert.equal(f.q('.job-plate-cost'), null, 'zero is "nothing attributed yet", not a price');
});

test('the detail dialog shows a sub-job price with the job total behind it, and a job total alone', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.usd = 12.5; job.subJobs = [{ ...sub('api'), stage: 'pr', usd: 3.5 }]; f.view.update(f.data);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.deepEqual([...document.querySelectorAll('#job-dialog .job-detail-cost')].map((e) => e.textContent), ['$3.50']);
  assert.match(f.q('#job-dialog .job-detail-cost').title, /job total \$12\.50/);
  f.q('#job-dialog').close();
  f.q('.job-plate-open').click();
  assert.deepEqual([...document.querySelectorAll('#job-dialog .job-detail-cost')].map((e) => e.textContent), ['$12.50']);
});

// Each column's tiles in order, read from the grid's stacks (`data-col`).
const graphColumns = (document) => [...document.querySelectorAll('.job-stack[data-col]')].reduce((cols, el) => {
  (cols[+el.dataset.col] ||= []).push(...[...el.querySelectorAll('.job-node')].map((n) => n.dataset.node)); return cols;
}, []);
// Points along a connector's `d` (M, H and C only), for clearance checks.
const pathPoints = (d) => {
  const pts = [];
  let x = 0, y = 0;
  for (const [, op, args] of d.matchAll(/([MHC])([^MHC]*)/g)) {
    const n = args.split(/[ ,]+/).filter(Boolean).map(Number);
    if (op === 'M') [x, y] = n;
    else if (op === 'H') { for (let i = 0; i <= 20; i++) pts.push([x + (n[0] - x) * i / 20, y]); x = n[0]; }
    else {
      const [x1, y1, x2, y2, x3, y3] = n;
      for (let i = 0; i <= 40; i++) { const t = i / 40, u = 1 - t; pts.push([u ** 3 * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3, u ** 3 * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3]); }
      [x, y] = [x3, y3];
    }
  }
  return pts;
};

test('the plan is a dependency graph: a box per sub-job in its wave, an arrow per prerequisite, and a dependency edit moves the box', (t) => {
  const f = fixture(t); f.q('.job-plate-open[data-job=\"job1\"]').click();
  const waves = () => graphColumns(document);
  const arrows = () => [...document.querySelectorAll('.job-graph-edges path[data-from]')].map((p) => `${p.dataset.from}→${p.dataset.to}`);
  assert.deepEqual(waves(), [['api'], ['web']]); assert.deepEqual(arrows(), ['api→web']);
  assert.deepEqual([...document.querySelectorAll('.job-node-tile .job-kind')].map((k) => k.getAttribute('aria-label')), ['PR', 'PR']);
  assert.deepEqual([...document.querySelectorAll('.job-graph-edges path[data-from]')].map((p) => p.getAttribute('class')), ['deploy'], 'a PR prerequisite is a deploy gate: dashed, with a rocket');
  assert.equal(document.querySelectorAll('.job-edge-glyph').length, 1);
  assert.match(f.q('[data-node="web"] .job-node-deps summary').title, /Start after Deliver api deploys/);
  const details = f.q('[data-node="web"] .job-node-deps'); details.open = true; details.dispatchEvent(f.event('toggle'));
  const box = f.q('[data-node="web"] [data-dep]'); box.checked = false; box.dispatchEvent(f.event('change'));
  assert.deepEqual(waves(), [['api', 'web']]); assert.deepEqual(arrows(), [], 'independent work shares wave one with nothing pointing at it');
  assert.equal(f.q('[data-node="web"] .job-node-deps').open, true, 'the open editor survives the redraw');
  f.q('[data-node="api"] [data-dep]').checked = true; f.q('[data-node="api"] [data-dep]').dispatchEvent(f.event('change'));
  assert.deepEqual(waves(), [['web'], ['api']]); assert.deepEqual(arrows(), ['web→api']);
  const title = f.q('[data-node="api"] [data-title]'); title.value = 'Deliver the API last'; title.dispatchEvent(f.event('input'));
  f.q('[data-action="approve-plan"]').click();
  assert.deepEqual(f.sent[0].plan.subJobs.map((s) => [s.title, s.after]), [['Deliver the API last', ['web']], ['Deliver web', []]]);
});

test('a live job shows the same graph with each box carrying its kind and status, opening its sub-job on click', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sessionSub('spike'), stage: 'review' }, { ...sub('api', ['spike']), stage: 'implementation' }]; f.view.update(f.data);
  assert.match(f.q('.job-plate-open').title, /^1 PR · 1 session/, 'the card counts the kinds on hover rather than "sub-jobs"');
  f.q('.job-plate-open').click();
  assert.match(f.q('#job-dialog').textContent, /Keys live in the vault/, 'the shared context is one fold away');
  const nodes = [...document.querySelectorAll('button.job-node')];
  assert.deepEqual(nodes.map((n) => [n.dataset.openSub, n.classList.contains('session'), [...n.classList].find((c) => c.startsWith('tone-')), n.querySelector('.job-status').textContent]),
    [['spike', true, 'tone-warn', 'Review result'], ['api', false, 'tone-idle', 'Waiting for 1 session']]);
  assert.ok(f.q('[data-node="spike"] .job-node-tile').classList.contains('on'), 'a step that needs you is filled; one still waiting is hollow');
  assert.equal(f.q('[data-node="api"] .job-node-tile').classList.contains('on'), false);
  assert.deepEqual([...document.querySelectorAll('.job-graph-edges path[data-from]')].map((p) => `${p.dataset.from}→${p.dataset.to}:${p.getAttribute('class')}`), ['spike→api:start'], 'a session prerequisite gates the start: a solid line');
  assert.match(f.q('[data-node="api"]').title, /Start after Run spike/);
  f.q('[data-open-sub="api"]').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver api'); assert.equal(f.q('.job-detail-line .job-kind-label').textContent, 'PR'); assert.equal(f.q('.job-detail-line .job-kind-label').title, 'A pull request in a repository');
  assert.equal(f.q('.job-graph'), null, 'a sub-job detail is about one sub-job, not the graph');
});

test('a PR node names its repo under the title in every graph mode; session, human and jira nodes do not', () => {
  const plan = { stories: [], subJobs: [{ ...sub('api'), repo: '/Users/me/IdeaProjects/wrangler-squared' }, sessionSub('spike', ['api']), humanSub('sign', ['api']), { ...sub('ticket', ['api']), kind: 'jira' }] };
  const { document } = new Window();
  for (const opts of [{ editable: true }, {}, { markOf: () => 'kept' }, { stateOf: () => 'planned' }]) {
    document.body.innerHTML = planGraphHtml(plan, opts);
    assert.deepEqual([...document.querySelectorAll('.job-node-repo')].map((e) => [e.closest('.job-node').dataset.node, e.textContent]), [['api', 'wrangler-squared']], JSON.stringify(opts));
    assert.equal(document.querySelector('.job-node-title + .job-node-repo')?.textContent, 'wrangler-squared', 'the repo sits right under the title');
    assert.match(document.querySelector('[data-node="api"]').title, /wrangler-squared/);
  }
});

test('a cancelled sub-job (superseded, dropped, not needed) is drawn as a cancelled node, still clickable, and so are the connectors into it', () => {
  const plan = { stories: [], subJobs: [sub('api'), { ...sub('old', ['api']), superseded: true, cancelledAt: 1 }, { ...sub('gone', ['api']), cancelledAt: 1 }, { ...sessionSub('spare', ['api']), notNeeded: true, cancelledAt: 1 }, sub('web', ['api'])] };
  const { document } = new Window();
  document.body.innerHTML = planGraphHtml(plan, { stateOf: () => 'done' });
  assert.deepEqual([...document.querySelectorAll('.job-node.cancelled')].map((e) => e.dataset.node), ['old', 'gone', 'spare']);
  assert.ok(!document.querySelector('[data-node="web"]').classList.contains('cancelled'), 'a planned sub-job is drawn live');
  assert.equal(document.querySelector('.job-node.cancelled[data-node="old"]').dataset.openSub, 'old', 'its detail still opens');
  assert.deepEqual([...document.querySelectorAll('.job-graph-edges path[data-cancelled]')].map((p) => p.dataset.to), ['old', 'gone', 'spare']);
  assert.equal(document.querySelector('path[data-to="old"]').getAttribute('class'), 'deploy', 'the flag leaves the connector style (its port) alone');
});

test('every column shares one row grid, and a connector that skips a wave takes a lane under the tile it passes', () => {
  const plan = { stories: [], subJobs: [sub('api'), sub('web', ['api']), sub('docs', ['api', 'web'])] };
  const { document } = new Window();
  document.body.innerHTML = planGraphHtml(plan, {});
  assert.deepEqual([...document.querySelectorAll('.job-stack[data-col]')].map((el) => [el.querySelector('[data-node]').dataset.node, el.style.gridColumn, el.style.gridRow]),
    [['api', '1', '1'], ['web', '3', '1'], ['docs', '5', '1']], 'tiles on one row line up across columns; gutters are the even tracks');
  assert.deepEqual([...document.querySelectorAll('.job-graph-pass')].map((el) => [el.dataset.pass, el.style.gridColumn, el.style.gridRow]), [['api>docs', '3', '2']],
    'web holds row 1 of its column, so the lane takes the channel just under it');
});

test('connectors run level between rows and change row in one smooth curve that never enters a tile or a title', () => {
  const plan = { stories: [], subJobs: [sub('api'), sub('web', ['api']), sub('docs', ['api', 'web'])] };
  const { document } = new Window();
  document.body.innerHTML = planGraphHtml(plan, {});
  const rect = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height });
  const at = (el, r) => { el.getBoundingClientRect = r; };
  at(document.querySelector('.job-graph-canvas'), rect(0, 0, 540, 240));
  const obstacles = [];
  ['api', 'web', 'docs'].forEach((id, i) => {
    const tile = [i * 196 + 44, 0, 60, 60], title = [i * 196 + 14, 64, 120, 18];
    at(document.querySelector(`[data-node="${id}"]`).closest('[data-col]'), rect(i * 196, 0, 148, 110));
    at(document.querySelector(`[data-node="${id}"] .job-node-tile`), rect(...tile));
    at(document.querySelector(`[data-node="${id}"] .job-node-title`), rect(...title));
    obstacles.push(tile, title);
  });
  at(document.querySelector('.job-graph-pass'), rect(196, 120, 148, 2));
  layoutGraphEdges(document.querySelector('.job-graph'));
  const d = (from, to) => document.querySelector(`path[data-from="${from}"][data-to="${to}"]`).getAttribute('d');
  assert.equal(d('api', 'web'), 'M110 30 H234', 'tiles on one row are joined by one straight line');
  const skip = d('api', 'docs');
  assert.match(skip, /^M110 30 H[\d.]+ C[^C]+ H344 H[\d.]+ C[^C]+ H430$/, 'level runs, and one curve into the lane and one out of it');
  for (const curve of skip.matchAll(/C([\d.]+) ([\d.]+), ([\d.]+) ([\d.]+), [\d.]+ ([\d.]+)/g)) {
    const [, , y1, , y2, y3] = curve.map(Number);
    assert.ok(y1 !== y3 && y2 === y3, 'each curve leaves and arrives level, so the line has no corner');
  }
  for (const id of ['api>web', 'api>docs', 'web>docs']) {
    const [from, to] = id.split('>');
    for (const [x, y] of pathPoints(d(from, to)).slice(1, -1)) {
      assert.ok(!obstacles.some(([l, t, w, h]) => x > l && x < l + w && y > t && y < t + h), `${id} passes (${x}, ${y}) through a tile or title`);
    }
  }
  assert.deepEqual([...document.querySelectorAll('.job-edge-glyph')].map((g) => [g.dataset.glyph, g.getAttribute('transform')]), [['api', 'translate(124 30)'], ['web', 'translate(320 30)']],
    'a PR has one rocket, beside its tile, however many connectors wait for it to deploy');
});

test('each column after the first is ordered by where its predecessors sit, so connectors run short and uncrossed', () => {
  const plan = { stories: [], subJobs: [sub('a'), sub('b'), sub('late', ['b']), sub('early', ['a'])] };
  const { document } = new Window();
  document.body.innerHTML = planGraphHtml(plan, {});
  assert.deepEqual(graphColumns(document), [['a', 'b'], ['early', 'late']]);
});

test('a merge that deploys nothing says so in the detail', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('docs'), stage: 'done', deploys: { head: 'h', base: 'main', expected: false, workflows: [], summary: 'Merge completes it · deployment-pipeline ignores **.md' },
    deployed: { at: 1, checks: ['Merged; nothing runs on push for these paths'], commit: 'abc' } }];
  f.view.update(f.data);
  f.q('[data-sub="docs"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('.job-deploys').textContent, 'No deploy'); assert.equal(f.q('.job-deploys').title, 'Merge completes it · deployment-pipeline ignores **.md');
  assert.match(f.q('#job-dialog').textContent, /Merged; nothing runs on push for these paths/);
});

test('a merged sub-job with no post-merge run turns amber, joins Needs me and says which move ends it', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const watching = { ...sub('api'), stage: 'deployment', mergedAt: Date.now() - 40 * 60000, deploys: deploys(), pr: { url: 'https://github.com/org/repo/pull/1', mergeCommit: 'abcdef1234567890', base: 'main', checkStatus: 'passing', checks: [] },
    deploymentResult: { status: 'pending', runs: [{ workflow: 'Deploy', runId: 3, status: 'pending' }], commit: 'abcdef1234567890' } };
  job.subJobs = [watching]; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, watching), { tone: 'muted', text: 'Watching post-merge runs' }); assert.equal(jobNeedsReview(job, watching), false);
  watching.deploymentStale = { since: watching.mergedAt }; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, watching), { tone: 'needs', text: 'No deployment run' }); assert.equal(jobNeedsReview(job, watching), true);
  assert.ok(f.q('.job-plate-graph .node[data-sub="api"]').classList.contains('tone-warn')); assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Nothing deployed');
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.match(hint(f), /No GitHub Actions run has started for merge commit abcdef12 in 40 min/);
  assert.match(hint(f), /Request changes and say so/, 'it says what the human can do about it');
  watching.deploymentStale = { since: watching.mergedAt, cancelled: ['Build'] }; f.view.update(f.data);
  assert.match(hint(f), /Build was cancelled on merge commit abcdef12 and no later run that includes it has started in 40 min/);
  assert.equal(f.q('.job-event b').textContent, 'Nothing deployed');
  assert.equal(jobStatus(job, { ...watching, stage: 'cleanup', deploymentStale: watching.deploymentStale }).text, 'Queued', 'stale is only meaningful while watching');
});

test('the stale window is an explicit automation setting', (t) => {
  const f = fixture(t); f.data.settings.deploymentStaleMinutes = 45; f.view.update(f.data);
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form');
  assert.equal(form.elements.deploymentStaleMinutes.value, '45');
  form.elements.deploymentStaleMinutes.value = '90'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).patch.deploymentStaleMinutes, 90);
});

test('a change requested on an open PR under code review reads as a fix queued in Work, and review copy says push rather than open', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const pr = { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'passing', checks: [] };
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr }];
  job.subJobs = [{ ...sub('api'), stage: 'implementation', state: 'queued', pr, note: 'Pin the client to v3' }];
  f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Fix queued' });
  assert.equal(jobCards([job])[0].stage, 'implementation', 'the card sits in Work, not PR');
  job.subJobs = [{ ...sub('api'), stage: 'review', state: 'verified', pr, ready: { checks: ['Pinned'], receiptId: 'run_2' } }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.match(hint(f), /push to the open PR/);
  assert.equal(f.q('#job-dialog [data-action="approve-code"]').textContent, 'Approve & push');
});

test('a requested fix reads as work about to happen, and the note rides on the card until the next receipt', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.reviewCode = false;
  job.subJobs = [{ ...sub('api'), stage: 'pr', fixRequested: { note: 'Pin the client to v3', at: 1 }, note: 'Pin the client to v3',
    pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'passing', checks: [] } }];
  f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Fix requested' });
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.match(hint(f), /Fix requested: Pin the client to v3/);
  assert.equal(f.q('.job-note').title, 'Note for the next session'); assert.equal(f.q('.job-note').textContent, 'Pin the client to v3');
});


// The chord lands on the dialog, so it is dispatched from the field a human would
// be typing in rather than from the dialog itself.
const chord = (f, el, init = {}) => el.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true, ...init }));

test('the dialog chord is the board\u2019s: plain Cmd or Ctrl with Enter, and nothing else', () => {
  assert.equal(isPrimaryActionKey({ key: 'Enter', metaKey: true }), true);
  assert.equal(isPrimaryActionKey({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(isPrimaryActionKey({ key: 'Enter', metaKey: false, ctrlKey: false }), false);
  assert.equal(isPrimaryActionKey({ key: 'a', metaKey: true }), false);
  assert.equal(isPrimaryActionKey({ key: 'Enter', metaKey: true, shiftKey: true }), false, 'Shift+Enter is still a newline');
  assert.equal(isPrimaryActionKey({ key: 'Enter', ctrlKey: true, altKey: true }), false);
});

test('Cmd+Enter in Request changes sends it, and waits for words exactly as the button does', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [] } }];
  f.view.update(f.data);
  f.q('.job-plate-graph [data-sub="api"]').dispatchEvent(f.event('click'));
  const text = f.q('.job-change textarea');
  chord(f, text);
  assert.equal(f.sent.length, 0, 'an empty box holds the chord back');
  text.value = '  Pin the client to v3  '; text.dispatchEvent(f.event('input'));
  chord(f, text, { shiftKey: true });
  assert.equal(f.sent.length, 0);
  chord(f, text);
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'request-change', at: 'pr', ref: 'h1', text: 'Pin the client to v3' });
});

test('the chord carries the primary submitter, so a new job starts planning rather than parking', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  form.elements.intent.value = 'Customers can access their accounts';
  chord(f, form.elements.intent);
  assert.equal(f.sent.at(-1).type, 'job-create'); assert.equal(f.sent.at(-1).start, true, 'the primary button is the submitter, not Add to backlog');
});

test('the chord fires a detail\u2019s primary action, and stops at a disabled or destructive one', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', checks: [] } }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.ok(f.q('[data-action="approve-merge"]'), 'the primary is the only data-action primary on the detail');
  chord(f, f.q('#job-dialog'), { altKey: true });
  assert.equal(f.sent.length, 0);
  chord(f, f.q('#job-dialog'));
  assert.equal(f.sent.at(-1).action, 'approve-merge'); assert.equal(f.sent.at(-1).head, 'head1');
  // Cancel job is a confirmation with nothing but destructive buttons: keyboard-inert.
  const before = f.sent.length;
  f.q('.job-plate-open').click(); f.q('#job-cancel').click();
  assert.equal(primaryAction(f.q('#job-dialog')), null);
  chord(f, f.q('#job-cancel-form'));
  assert.equal(f.sent.length, before); assert.equal(f.q('#job-dialog').open, true, 'the chord neither submits nor closes it');
});

test('a disabled primary stays disabled to the keyboard', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.runs = [{ id: 'r1', phase: 'planning', stopped: false }]; f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.equal(f.q('[data-action="approve-plan"]').disabled, true);
  assert.equal(primaryAction(f.q('#job-dialog')), null);
  chord(f, f.q('#job-dialog'));
  assert.equal(f.sent.length, 0);
  job.runs = []; f.view.update(f.data); f.q('.job-plate-open[data-job=\"job1\"]').click();
  chord(f, f.q('#job-dialog'));
  assert.equal(f.sent.at(-1).action, 'approve-plan');
});

test('a green PR moved behind work that has not deployed offers no Merge and is not counted as needing you', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }, { ...sub('web', ['api']), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/142', head: 'head9', checkStatus: 'passing', checks: [] }, fixRequested: { note: 'New brief', at: 1 } }];
  f.view.update(f.data);
  assert.equal(jobNeedsReview(job, job.subJobs[1]), false);
  assert.equal(f.q('#jobs-review-count').textContent, '');
  f.q('.job-plate-graph .node[data-sub="web"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('[data-action="approve-merge"]'), null);
  assert.equal(f.q('#job-dialog .job-chip-state').textContent, 'Waiting for 1 deployment');
  assert.match(hint(f), /A repair session starts once its prerequisites deploy/);
});

test('the job dialog’s one button merges the green PR waiting on you, pinned to its head; a failing step opens instead', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/142', head: 'head9', checkStatus: 'passing', checks: [] } }, { ...sub('web', ['api']), stage: 'implementation' }];
  f.view.update(f.data); f.q('.job-plate-open').click();
  assert.equal(f.q('#job-dialog .job-chip-state').textContent, 'Merge #142');
  const fab = f.q('#job-dialog .job-actions button.primary');
  assert.equal(fab.textContent, 'Merge #142');
  chord(f, f.q('#job-dialog'));
  assert.deepEqual([f.sent.at(-1).action, f.sent.at(-1).subJobId, f.sent.at(-1).head], ['approve-merge', 'api', 'head9']);
  job.subJobs[0].error = 'PR was closed without merging'; f.view.update(f.data);
  assert.equal(f.q('#job-dialog .job-actions button.primary').textContent, 'Resolve #142');
  assert.equal(primaryAction(f.q('#job-dialog')), null, 'opening a sub-job is not a chord action');
  f.q('#job-dialog .job-actions button.primary').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver api');
  assert.ok(f.q('.job-change').classList.contains('is-open'), 'something went wrong, so the box starts open');
});

test('a folded section stays open across live ticks', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', worktree: { path: '/wt/api' } }];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const body = () => f.q('#job-dialog .job-details-body');
  assert.equal(body().hidden, true); assert.match(body().textContent, /\/wt\/api/);
  assert.equal(f.q('[data-details-toggle]').closest('.job-actions') !== null, true, 'Details sits in the action row, not a row of its own');
  f.q('[data-details-toggle]').click();
  assert.equal(body().hidden, false); assert.equal(f.q('[data-details-toggle]').getAttribute('aria-expanded'), 'true');
  f.view.update(f.data);
  assert.equal(body().hidden, false, 'still open after a live tick');
  assert.equal(f.q('.job-change').classList.contains('is-open'), false, 'nothing went wrong: the box rests as one line');
});

// --- Changing the plan of a running job ---

test('Add idea on a running job asks the planner for a proposal; the sent idea stays as a bubble; while it is pending new work reads as held and Discard is offered', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'done', deployed: { at: 1, checks: ['ok'] } }, { ...sub('web', ['api']), stage: 'implementation', state: 'queued' }];
  f.view.update(f.data);
  f.q('[data-board="job1"] .job-plate-open').click();
  assert.equal(f.q('#job-refine'), null, 'there is no separate Change plan dialog: the box is on the job');
  assert.equal(f.q('.job-change textarea').placeholder, 'Add an idea for the planner…');
  assert.equal(f.q('.job-change-foot').textContent, '⌘↵');
  const text = f.q('.job-change textarea'); text.value = 'Split web in two'; text.dispatchEvent(f.event('input')); f.q('[data-change-send]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: undefined, action: 'request-change', at: 'job', ref: 'job', text: 'Split web in two' });

  job.replan = { feedback: 'Split web in two', at: 1, proposal: null, previous: null };
  job.runs = [{ id: 'plan2', subJobId: null, phase: 'planning', stopped: false }];
  f.view.created({ event: 'job-action-complete', jobId: 'job1', action: 'request-change' }); f.view.update(f.data);
  assert.equal(f.q('#job-dialog').open, true);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Re-planning');
  assert.equal(jobStatus(job, job.subJobs[1]).text, 'Held for the plan change');
  assert.match(f.q('.job-replan-ask').textContent, /Split web in two/);
  assert.equal(f.q('.job-change'), null, 'one change at a time');
  assert.equal(f.q('.job-sent .job-sent-bubble').textContent, 'Split web in two', 'what was sent stays where the box was');
  f.q('[data-action="discard-replan"]').click();
  assert.equal(f.sent.at(-1).action, 'discard-replan');
});

test('a pending plan change freezes a sub-job awaiting review: held, not needs-you, and nothing to approve or move', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'review', state: 'verified', ready: { checks: ['Tests pass'], receiptId: 'r1' }, worktree: { path: '/wt/api' } }];
  f.view.update(f.data);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Review code');
  job.replan = { feedback: 'Rethink api', at: 1, proposal: null, previous: null };
  f.view.update(f.data);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Re-planning');
  assert.equal(jobNeedsReview(job, job.subJobs[0]), false); assert.equal(f.q('#jobs-review-count').textContent, '');
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('[data-action="approve-code"]'), null);
  assert.equal(f.q('.job-change'), null, 'a step’s own agent is refused while the change is pending');
  assert.match(f.q('#job-dialog').textContent, /Held for the plan change/);
  job.runs = [{ id: 'w', subJobId: 'api', phase: 'implementation', stopped: false, status: 'running' }];
  assert.notEqual(jobStatus(job, job.subJobs[0]).text, 'Held for the plan change', 'a step already running carries on');
});

test('a plan-change proposal locks landed work, marks removed work as cancelled with its PR, highlights new and edited, and Approve is pinned to the proposal', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  const api = { ...sub('api'), stage: 'done', deployed: { at: 1, checks: ['ok'] } };
  const web = { ...sub('web', ['api']), stage: 'pr', state: 'watching', pr: { url: 'https://github.com/org/repo/pull/7', checkStatus: 'pending' } };
  const docs = { ...sub('docs'), stage: 'implementation', state: 'queued' };
  job.subJobs = [api, web, docs]; job.plan = { ...plan, subJobs: [sub('api'), sub('web', ['api']), sub('docs')] };
  const merged = { ...job.plan, subJobs: [sub('api'), sub('web', ['api']), { ...sub('docs'), title: 'Docs <b>v2</b>' }, sub('cli', ['docs'])] };
  job.replan = { feedback: 'Replace web with a CLI', at: 1, proposal: { id: 'run_p', plan: merged, merged,
    changes: { frozen: ['api'], kept: [], edited: [{ id: 'docs', fields: ['title'] }], added: ['cli'], removed: ['web'] } } };
  f.view.update(f.data);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Plan change ready');
  assert.ok(f.q('[data-board="job1"]').classList.contains('tone-warn'));
  assert.equal(jobNeedsReview(job, null), true); assert.equal(f.q('#jobs-review-count').textContent, '1');
  f.q('[data-board="job1"] .job-plate-open').click();
  const mark = (id) => f.q(`.job-node[data-node="${id}"] .job-mark`).textContent;
  assert.equal(mark('api'), 'Locked · already landed'); assert.ok(f.q('.job-node[data-node="api"] .job-mark svg'));
  assert.equal(mark('web'), 'Will be cancelled'); assert.equal(mark('docs'), 'Edited'); assert.equal(mark('cli'), 'New');
  assert.equal(f.q('.job-node[data-node="docs"] .job-node-title').textContent, 'Docs <b>v2</b>', 'agent text is escaped');
  const removed = f.q('.job-replan-changes .job-mark-removed');
  assert.match(removed.textContent, /Will be cancelled: Deliver web · PR #7 ↗ stays open on GitHub/);
  assert.equal(removed.querySelector('a').href, 'https://github.com/org/repo/pull/7');
  assert.equal(f.q('[data-node="cli"]').tagName, 'DIV', 'a proposed node opens nothing: it has no sub-job yet');
  f.q('[data-action="approve-replan"]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: undefined, action: 'approve-replan', proposalId: 'run_p' });
  f.q('[data-action="discard-replan"]').click();
  assert.equal(f.sent.at(-1).action, 'discard-replan');
  const text = f.q('.job-change textarea'); text.value = 'Keep web'; text.dispatchEvent(f.event('input')); f.q('[data-change-send]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: undefined, action: 'request-change', at: 'proposal', ref: 'run_p', text: 'Keep web' }, 'pinned to the proposal that was read');
});

test('a superseded sub-job reads as superseded, and its open PR stays linked from the job and the sub-job', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'done', state: 'cancelled', cancelledAt: 1, superseded: true, pr: { url: 'https://github.com/org/repo/pull/7', checkStatus: 'pending' } }, { ...sub('cli'), stage: 'implementation', state: 'queued' }];
  f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Superseded');
  f.q('[data-board="job1"] .job-plate-open').click();
  assert.match(f.q('.job-node[data-node="api"] .job-status').textContent, /#7 · Superseded/);
  assert.equal(f.q('.job-superseded a').href, 'https://github.com/org/repo/pull/7');
  f.q('.job-node[data-node="api"]').click();
  assert.match(f.q('#job-dialog .job-chip-state').title, /Superseded by a plan change and cancelled. Its PR is left open on GitHub/);
  assert.equal(f.q('.job-pipeline-status').href, 'https://github.com/org/repo/pull/7');
});

test('a green PR behind its base reads as updating the branch', () => {
  const sub = { id: 'a', title: 'A', repo: '/repo', after: [], stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'pending', behind: true, checks: [] } };
  const job = { id: 'j', stage: 'active', subJobs: [sub], runs: [], moves: [], reviewMerge: true };
  assert.deepEqual(jobStatus(job, sub), { tone: 'working', text: 'Behind base · updating branch' });
});

test('New job holds planning back while an image uploads, then creates the job with its names and the sharing flag', async (t) => {
  const f = fixture(t);
  const prevURL = globalThis.URL;
  globalThis.URL = Object.assign(function (...a) { return new prevURL(...a); }, { createObjectURL: () => 'blob:1', revokeObjectURL() {} });
  t.after(() => { globalThis.URL = prevURL; });
  let release;
  f.staging.stage = () => new Promise((r) => { release = () => r({ name: 'paste-1700000000000-aaaa1111.png' }); });
  f.q('#job-new').click(); const form = f.q('#job-create-form');
  const share = f.q('#job-share-images');
  assert.equal(share.hidden, true, 'the sharing switch only appears once there is an image');
  const drop = f.event('drop'); drop.dataTransfer = { files: [new f.window.File(['x'], 'shot.png', { type: 'image/png' })], types: ['Files'], items: [], getData: () => '' };
  form.querySelector('.job-outcome').dispatchEvent(drop);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(share.hidden, false);
  assert.deepEqual([...form.querySelectorAll('.job-create-foot button')].map((b) => b.disabled), [true, true]);
  form.elements.intent.value = 'Match the mockup';
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.length, 0, 'submitting mid-upload sends nothing');
  release(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...form.querySelectorAll('.job-create-foot button')].map((b) => b.disabled), [false, false]);
  form.elements.shareImages.checked = false;
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual([f.sent[0].job.images, f.sent[0].job.shareImages], [['paste-1700000000000-aaaa1111.png'], false]);
});

test('a job’s Outcome shows its pictures as a numbered strip, asks for the bytes once, and fills in when they arrive', (t) => {
  const f = fixture(t);
  const A = 'paste-1700000000000-aaaa1111.png', B = 'paste-1700000000001-bbbb2222.png';
  f.data.jobs[0].images = [A, B]; f.view.update(f.data);
  f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.deepEqual([...f.q('#job-dialog').querySelectorAll('.job-image-strip .job-image-num')].map((n) => n.textContent), ['1', '2']);
  assert.deepEqual(f.sent, [{ type: 'job-images', id: 'job1' }]);
  f.view.update(f.data);
  assert.equal(f.sent.length, 1, 'asked once per job');
  f.view.images({ jobId: 'job1', images: [{ name: A, mime: 'image/png', dataBase64: 'eA==' }] });
  const thumbs = [...f.q('#job-dialog').querySelectorAll('.job-image-strip .job-image-thumb')];
  assert.equal(thumbs[0].querySelector('img').getAttribute('src'), 'data:image/png;base64,eA==');
  assert.equal(thumbs[1].querySelector('img'), null, 'a picture the store lost stays a numbered blank');
});

// The "Have an idea?" corner: a quiet pill until opened, then a form whose
// public-issue notice is on screen before anything can be sent.
const ideaOpen = (f) => { f.q('.jobs-idea-teaser').click(); return f.sent.at(-1); };
const ideaType = (f, title, body = '') => {
  f.q('.jobs-idea [name=title]').value = title;
  f.q('.jobs-idea [name=body]').value = body;
  f.q('.jobs-idea form').dispatchEvent(f.event('submit'));
  return f.sent.at(-1);
};

test('the idea corner says where the text goes before it is sent, and files it as the reader’s own GitHub issue', (t) => {
  const f = fixture(t);
  assert.match(f.q('.jobs-idea-teaser').textContent, /Have an idea\?.*Help make Wrangler² better/);
  const who = ideaOpen(f);
  assert.equal(who.type, 'feature-request-whoami', 'opening asks gh who the reader is');
  const notice = f.q('.jobs-idea-notice').textContent;
  assert.match(notice, /public GitHub issue/);
  assert.match(notice, /charlie-ps\/wrangler-squared/);
  assert.match(notice, /secrets/);
  f.q('.jobs-idea [name=title]').value = 'half-typed';
  f.view.idea({ event: 'feature-request-gh', rid: who.rid, login: 'octo<b>' });
  assert.match(f.q('.jobs-idea-notice').textContent, /posted as @octo<b>/, 'the login is text, never markup');
  assert.equal(f.q('.jobs-idea [name=title]').value, 'half-typed', 'the login arriving does not redraw over what is typed');
  assert.equal(f.q('.jobs-idea [type=submit]').textContent.trim(), 'Post');
  const sent = ideaType(f, '  Clone a job  ', 'Most of my jobs repeat.');
  assert.deepEqual({ ...sent, rid: undefined }, { type: 'feature-request', rid: undefined, title: 'Clone a job', body: 'Most of my jobs repeat.' });
  assert.ok(f.q('.jobs-idea [name=title]').disabled, 'fields lock while it posts');
  f.view.idea({ event: 'feature-request-created', rid: 'another-tab', url: 'https://github.com/charlie-ps/wrangler-squared/issues/1', number: 1, title: 'x' });
  assert.equal(f.q('.jobs-idea').dataset.view, 'sending', 'an answer to another tab is ignored');
  f.view.idea({ event: 'feature-request-created', rid: sent.rid, url: 'https://github.com/charlie-ps/wrangler-squared/issues/47', number: 47, title: 'Clone a job' });
  const link = f.q('.jobs-idea-issue');
  assert.equal(link.getAttribute('href'), 'https://github.com/charlie-ps/wrangler-squared/issues/47');
  assert.match(link.textContent, /#47.*Clone a job/);
  f.q('[data-idea="again"]').click();
  assert.equal(f.q('.jobs-idea [name=title]').value, '', 'Send another starts from a blank draft');
});

test('a missing or signed-out gh says how to fix it, keeps the draft, and nothing is sent without a title', (t) => {
  const f = fixture(t);
  const who = ideaOpen(f);
  const count = f.sent.length;
  ideaType(f, '   ');
  assert.equal(f.sent.length, count, 'a blank title sends nothing');
  f.q('.jobs-idea [name=title]').value = 'Keep me';
  f.view.idea({ event: 'feature-request-gh', rid: who.rid, reason: 'auth', error: 'The GitHub CLI is not signed in' });
  assert.equal(f.q('.jobs-idea').dataset.view, 'auth');
  assert.equal(f.q('.jobs-idea-cmd code').textContent, 'gh auth login');
  f.q('[data-idea="retry"]').click();
  assert.equal(f.q('.jobs-idea [name=title]').value, 'Keep me', 'the draft survives the detour');
  const sent = ideaType(f, 'Keep me');
  f.view.idea({ event: 'feature-request-failed', rid: sent.rid, reason: 'missing', error: 'not installed' });
  assert.match(f.q('.jobs-idea-result').textContent, /isn’t installed[^]*cli\.github\.com/);
  f.q('[data-idea="retry"]').click();
  const again = ideaType(f, 'Keep me');
  f.view.idea({ event: 'feature-request-failed', rid: again.rid, reason: 'error', error: 'error connecting to api.github.com' });
  assert.equal(f.q('.jobs-idea-error').textContent, 'error connecting to api.github.com');
  assert.equal(f.q('.jobs-idea [name=title]').value, 'Keep me');
  f.q('.jobs-idea-close').click();
  assert.equal(f.q('.jobs-idea').dataset.view, 'teaser');
  ideaOpen(f);
  assert.equal(f.q('.jobs-idea [name=title]').value, 'Keep me', 'closing keeps the draft too');
  f.view.update(f.data);
  assert.ok(f.q('.jobs-idea form'), 'a graph tick leaves the open panel alone');
});

// --- Writes and places ---

const jiraWrite = (id, by, action, extra = {}) => ({ id, kind: 'write', place: { type: 'jira' }, title: `Write ${id}`, storyId: 'story', jiraKey: 'AUTH-1', after: [], ...(by ? { by } : {}), action, sessions: [], repairs: [], ...extra });
const sessionNode = (id, extra = {}) => ({ id, kind: 'session', title: `Run ${id}`, after: [], brief: 'Measure it', sessions: [], repairs: [], ...extra });
const withWrites = (f, writes, extra = {}) => {
  const [job] = f.data.jobs;
  job.plan = { ...structuredClone(plan), workflows: { AUTH: ['To Do', 'In Progress', 'In Review', 'Done'] }, subJobs: [...structuredClone(plan.subJobs), ...writes] };
  Object.assign(job, extra); f.view.update(f.data);
  return job;
};

test('plan review hangs each proposed write under the session that makes it, draws a session\'s milestone, and the editor changes the write in the draft that approval sends', (t) => {
  const f = fixture(t);
  withWrites(f, [sessionNode('n-pr', { on: { sub: 'api', at: 'pr' } }), sessionNode('n-wont', { on: { sub: 'web', at: 'dropped' } }),
    jiraWrite('w-pr', 'n-pr', { type: 'transition', to: 'In Review', comment: 'PR {pr.url}' }, { why: 'AUTH moves <b>open</b> PRs to In Review' }),
    jiraWrite('w-wont', 'n-wont', { type: 'transition', to: 'Done' }, { review: true })]);
  f.q('[data-job="job1"]').click();
  const stack = (id) => f.q(`[data-node="${id}"]`).closest('.job-stack');
  assert.equal(stack('w-pr'), stack('n-pr'), 'a write hangs under the session that makes it');
  assert.equal(stack('w-wont'), stack('n-wont'));
  assert.equal(f.q('[data-node="n-pr"] .job-node-on').textContent, 'When Deliver api opens its PR', 'the milestone is the session\'s');
  assert.equal(f.q('[data-node="n-wont"] .job-node-on').textContent, 'Only if Deliver web is dropped');
  assert.ok(f.q('path.on[data-from="api"][data-to="n-pr"]'), 'a milestone is a connector from its trigger');
  assert.match(f.q('[data-node="w-pr"]').textContent, /^→ In Review \+ comment\s*by the session$/);
  assert.ok(f.q('[data-node="w-pr"] .job-proposed'));
  const pill = f.q('[data-node="w-pr"]').closest('details.job-place');
  assert.equal(pill.open, false, 'a place starts folded');
  assert.equal(pill.querySelector('summary').textContent, 'AUTH-1↗', 'an existing ticket is a place that exists');
  assert.equal(pill.querySelectorAll('.job-place-dot').length, 1);
  assert.match(f.q('[data-node="w-wont"]').textContent, /drafted for your review/);
  assert.ok(f.q('[data-node="w-wont"]').classList.contains('dormant'), 'an if-dropped session\'s writes are dormant with it');
  const eye = (id) => f.q(`[data-node="${id}"]`).parentElement.querySelector('[data-review-write]');
  assert.deepEqual([eye('w-wont').getAttribute('aria-pressed'), eye('w-wont').classList.contains('on'), eye('w-wont').title], ['true', true, 'Review before writing']);
  assert.equal(eye('w-pr').getAttribute('aria-pressed'), 'false');
  assert.equal(f.q('[data-node="w-wont"]').contains(eye('w-wont')), false, 'the eye is beside the row, not inside its button');
  assert.equal(f.q('.job-write-count').textContent, '2 writes · 1 reviewed');
  eye('w-wont').click();
  assert.equal(f.q('[data-write-editor]'), null, 'flipping review does not open the editor');
  assert.equal(eye('w-wont').getAttribute('aria-pressed'), 'false'); assert.equal(f.q('.job-write-count').textContent, '2 writes');
  assert.equal(f.q('[data-action="approve-plan"]').title, 'Starts 4 steps');
  eye('w-wont').click();
  assert.equal(f.q('.job-write-count').textContent, '2 writes · 1 reviewed');
  assert.equal(f.q('[data-action="approve-plan"]').textContent, 'Approve 4', 'writes are not counted as work; their sessions are');
  assert.equal(f.q('[data-action="approve-plan"]').title, 'Starts 4 steps · 1 write held for you');
  assert.ok(![...document.querySelectorAll('[data-dep]')].some((c) => c.value.startsWith('w-')), 'nothing can wait on a write');
  assert.equal(f.q('[data-add-write="api"]'), null, 'only a session makes writes');
  f.q('[data-node="w-pr"]').click();
  const editor = f.q('[data-write-editor]');
  assert.match(editor.querySelector('.job-write-why').innerHTML, /&lt;b&gt;open&lt;\/b&gt;/, 'the planner\'s reason is text, never markup');
  assert.deepEqual([...editor.querySelectorAll('[name="to"] option')].map((o) => o.value), ['', 'To Do', 'In Progress', 'In Review', 'Done']);
  assert.equal(editor.querySelector('[name="on"]'), null, 'a write has no milestone of its own');
  editor.querySelector('[name="to"]').value = 'Done'; editor.querySelector('[name="to"]').dispatchEvent(f.event('change'));
  f.q('[data-write-editor] [name="review"]').checked = true; f.q('[data-write-editor] [name="review"]').dispatchEvent(f.event('change'));
  assert.match(f.q('[data-node="w-pr"]').textContent, /^→ Done/);
  assert.ok(f.q('[data-node="w-pr"]').closest('details.job-place').open, 'the place holding the open editor stays open');
  f.q('[data-write-editor] [name="to"]').value = ''; f.q('[data-write-editor] [name="to"]').dispatchEvent(f.event('change'));
  f.q('[data-write-editor] [name="comment"]').value = ''; f.q('[data-write-editor] [name="comment"]').dispatchEvent(f.event('change'));
  assert.ok(f.q('[data-action="approve-plan"]').disabled, 'a write that neither moves nor comments cannot be approved');
  f.q('[data-write-editor] [name="comment"]').value = 'Merged: {pr.url}'; f.q('[data-write-editor] [name="comment"]').dispatchEvent(f.event('change'));
  f.q('[data-add-write="n-pr"]').click();
  assert.match(f.q('[data-write-editor] h4').textContent, /AUTH-1 → In Review/); assert.doesNotMatch(f.q('[data-write-editor] h4').textContent, /Proposed/, 'the human\'s own write is not proposed');
  f.q('[data-write-remove]').click();
  f.q('[data-node="w-wont"]').click(); f.q('[data-write-done]').click();
  assert.equal(f.q('[data-write-editor]'), null);
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent.at(-1).plan.subJobs.find((s) => s.id === 'w-wont').review, true, 'a flipped eye is sent as an explicit boolean');
  const sent = f.sent.at(-1).plan.subJobs.find((s) => s.id === 'w-pr');
  assert.deepEqual([sent.action, sent.by, sent.on, sent.review, sent.title], [{ type: 'comment', comment: 'Merged: {pr.url}' }, 'n-pr', undefined, true, 'Comment on AUTH-1']);
  assert.equal(f.sent.at(-1).plan.subJobs.length, 6, 'the removed write is gone');
});

test('a write waits on its session; a draft needs you, its panel the editor that Move in Jira approves, while the parked session says it waits; Edit and Skip send their actions', (t) => {
  const f = fixture(t);
  const job = withWrites(f, [], { stage: 'active', subJobs: [{ ...sub('api'), stage: 'implementation', state: 'queued' }, { ...sub('web', ['api']), stage: 'implementation', state: 'queued' },
    sessionNode('n', { on: { sub: 'api', at: 'pr' }, stage: 'session', state: 'queued' }), jiraWrite('w-pr', 'n', { type: 'transition', to: 'In Review' }, { stage: 'write', state: 'queued' }),
    sessionNode('n-wont', { on: { sub: 'web', at: 'dropped' }, stage: 'session', state: 'queued' }), jiraWrite('w-wont', 'n-wont', { type: 'transition', to: 'Done' }, { stage: 'write', state: 'queued' }),
    sessionNode('n-rev', { stage: 'session', state: 'queued', sessions: ['s1'] }),
    jiraWrite('w-rev', 'n-rev', { type: 'transition', to: 'In Progress', comment: 'Started <script>' }, { stage: 'review', state: 'verified', review: true, why: 'Team <i>rule</i>' })],
  runs: [{ id: 'r1', subJobId: 'n-rev', phase: 'session', stopped: false, sessionId: 's1', parkedAt: 1, drafts: ['w-rev'] }] });
  const at = (id) => job.subJobs.find((s) => s.id === id);
  assert.deepEqual(['w-pr', 'n', 'n-wont', 'w-rev', 'n-rev'].map((id) => jobStatus(job, at(id)).text),
    ['Written by Run n', 'Waits until Deliver api opens its PR', 'Only if Deliver web is dropped', 'Review the draft', 'Paused · 1 draft to review']);
  assert.deepEqual(['w-pr', 'w-rev', 'n-rev'].map((id) => jobNeedsReview(job, at(id))), [false, true, false], 'the drafts need you, not the session waiting on them');
  assert.equal(f.q('#jobs-review-count').textContent, '1', 'a draft in review counts toward needs-you');
  assert.match(f.q('[data-board="job1"]').textContent, /Review write/);
  f.q('[data-board="job1"] .job-plate-open').click();
  const pill = f.q('[data-node="w-rev"]').closest('details.job-place');
  assert.equal(pill.closest('.job-stack'), f.q('[data-node="n-rev"]').closest('.job-stack'));
  assert.ok(pill.classList.contains('urgent') && pill.classList.contains('tone-warn'), 'a draft in review rings its folded pill');
  assert.match(f.q('[data-node="w-pr"]').textContent, /by the session$/);
  assert.match(f.q('[data-node="n"]').textContent, /When Deliver api opens its PR/);
  assert.match(f.q('[data-node="w-rev"]').textContent, /Review write$/);
  assert.ok(f.q('[data-board="job1"] .job-plate-graph g.moon[data-sub="w-rev"]'), 'a write is a moon on the plate, no step of the plan');
  f.q('[data-open-sub="w-rev"]').click();
  assert.match(f.q('.job-appbar .job-chip-state').title, /Review is on for this write: Run n-rev drafted it below and nothing has been written to Jira yet\. .*once every draft it sent is decided, Run n-rev is told what to make/);
  const panel = f.q('#job-write-review');
  assert.match(panel.innerHTML, /Started &lt;script&gt;/); assert.match(panel.innerHTML, /Team &lt;i&gt;rule&lt;\/i&gt;/);
  assert.equal(panel.querySelector('[name="to"]').value, 'In Progress');
  assert.deepEqual([panel.querySelector('[name="on"]'), panel.querySelector('[name="review"]')], [null, null], 'in review only what it writes can change');
  assert.match(f.q('.job-write-spec').textContent, /By\s*Written by Run n-rev/);
  assert.deepEqual([...document.querySelectorAll('.job-actions button')].map((b) => b.textContent.trim()), ['Move in Jira', 'Skip']);
  assert.equal(f.q('.job-change').dataset.changeAt, 'write', 'a draft takes ideas too, pinned to where it stands'); assert.equal(f.q('.job-moves'), null);
  panel.requestSubmit();
  assert.deepEqual([f.sent.at(-1).action, f.sent.at(-1).subJobId, f.sent.at(-1).write], ['approve-write', 'w-rev', undefined], 'nothing changed: a plain approval');
  panel.querySelector('[name="to"]').value = ''; panel.querySelector('[name="comment"]').value = '';
  panel.requestSubmit();
  assert.match(f.q('#job-move-error').textContent, /moves the ticket, comments on it, or both/); assert.equal(f.sent.at(-1).write, undefined);
  panel.querySelector('[name="comment"]').value = 'Picked up: {pr.url}';
  panel.requestSubmit();
  assert.deepEqual(f.sent.at(-1).write, { action: { to: null, comment: 'Picked up: {pr.url}' } }, 'only what changed, null where emptied');
  f.q('[data-action="skip-write"]').click();
  assert.equal(f.sent.at(-1).action, 'skip-write');
  f.q('[data-open-job]').click(); f.q('[data-open-sub="n-rev"]').click();
  assert.match(hint(f), /Paused on 1 draft for your review/);
  assert.deepEqual([...document.querySelectorAll('.job-chips [data-open-sub]')].map((b) => b.dataset.openSub), ['w-rev'], 'a session lists the writes it owns');
  f.q('[data-open-job]').click(); f.q('[data-open-sub="w-pr"]').click();
  f.q('#job-write-edit').click();
  const form = f.q('#job-write-form');
  assert.equal(form.querySelector('[name="review"]').checked, false);
  assert.equal(form.querySelector('[name="on"]'), null);
  form.querySelector('[name="to"]').value = 'Done'; form.querySelector('[name="review"]').checked = true;
  form.requestSubmit();
  assert.deepEqual(f.sent.at(-1).write, { action: { to: 'Done', comment: null }, review: true });
});

test('a refused write shows its place\'s error with Retry and Pick another status; a session on a dropped trigger can never start; already-there explains itself', (t) => {
  const f = fixture(t);
  const job = withWrites(f, [], { stage: 'active', subJobs: [{ ...sub('api'), stage: 'cleanup', cancelledAt: 1, state: 'cancelled' }, { ...sub('web', ['api']), stage: 'implementation', state: 'queued' },
    sessionNode('n', { stage: 'review', state: 'verified', sessions: ['s1'], result: { checks: ['Tried'], receiptId: 'r1' } }),
    jiraWrite('w-fail', 'n', { type: 'transition', to: 'In Review' }, { stage: 'write', state: 'failed', error: 'Field Reviewer is required for this transition.' }),
    sessionNode('n-dead', { on: { sub: 'api', at: 'pr' }, stage: 'session', state: 'queued' }), jiraWrite('w-dead', 'n-dead', { type: 'comment', comment: 'x' }, { stage: 'write', state: 'queued' }),
    jiraWrite('w-there', 'n', { type: 'transition', to: 'In Progress', comment: 'Picked up' }, { stage: 'done', state: 'done', result: { outcome: 'already', from: 'In Review', checks: ['AUTH-1 was already at or past In Progress; comment posted'], text: 'Picked up', receiptId: 'r1' } })] });
  const at = (id) => job.subJobs.find((s) => s.id === id);
  assert.equal(jobStatus(job, at('n-dead')).text, 'Trigger dropped'); assert.equal(jobNeedsReview(job, at('n-dead')), true);
  assert.equal(jobStatus(job, at('w-there')).text, 'Already there');
  assert.deepEqual(eventFor(job, at('w-fail')), { title: 'Jira refused the write', detail: 'Field Reviewer is required for this transition.' });
  f.q('[data-board="job1"] .job-plate-open').click(); f.q('[data-open-sub="w-fail"]').click();
  assert.match(f.q('.job-event').textContent, /Jira refused the write.*Field Reviewer is required/);
  assert.match(hint(f), /Retry once it allows it, pick another status \(either runs Run n again for it\)/);
  assert.deepEqual([...document.querySelectorAll('.job-actions button')].map((b) => b.textContent.trim()), ['Retry', 'Pick another status']);
  assert.equal(document.querySelector('.job-moves'), null, 'no Moves menu on a refused write');
  f.q('#job-write-edit').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Pick another status');
  f.q('#job-move-back').click();
  f.q('[data-open-job]').click(); f.q('[data-open-sub="n-dead"]').click();
  assert.match(hint(f), /Deliver api was dropped, so it will never reach PR opened and this session will never start/);
  f.q('[data-open-job]').click(); f.q('[data-open-sub="w-there"]').click();
  assert.match(f.q('.job-write-hint').textContent, /AUTH-1 was already at or past In Progress \(In Review\), so nothing moved; the comment was still posted/);
  assert.match(f.q('.job-write-spec').textContent, /In Review → In Progress/);
  at('n').stage = 'done'; f.view.update(f.data);
  f.q('[data-open-job]').click(); f.q('[data-open-sub="w-fail"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-actions button')].map((b) => b.textContent.trim()), ['Retry', 'Pick another status'], 'a finished session still runs again for its writes alone');
  at('n').cancelledAt = 2; f.view.update(f.data);
  f.q('[data-open-job]').click(); f.q('[data-open-sub="w-fail"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-actions button')].map((b) => b.textContent.trim()), [], 'its session was dropped: nothing runs it again');
});

const made = (id, type, by, what, extra = {}) => ({ id, kind: 'write', place: { type }, title: `Make ${what}`, by, after: [], action: { type: 'make', what }, sessions: [], repairs: [], ...extra });
const placesJob = (f, result = {}) => withWrites(f, [], { stage: 'active', plan: { ...structuredClone(plan), jiraSite: 'https://x.atlassian.net', subJobs: [] }, subJobs: [
  { ...sub('api'), stage: 'pr', state: 'watching', pr: { url: 'https://github.com/org/repo/pull/7', checkStatus: 'pending' } },
  sessionNode('report', { stage: 'session', state: 'queued' }),
  sessionNode('tix', { on: { sub: 'api', at: 'pr' }, stage: 'session', state: 'queued' }),
  jiraWrite('w-pr', 'tix', { type: 'transition', to: 'In Review' }, { stage: 'done', state: 'done', result: { outcome: 'written', receiptId: 'r1', checks: ['Moved'] } }),
  jiraWrite('w-done', 'tix', { type: 'transition', to: 'Done' }, { stage: 'write', state: 'queued' }),
  made('chart', 'artifact', 'report', 'p95 <i>chart</i>', { stage: 'write', state: 'queued', ...result.chart }),
  made('k6', 'file', 'report', 'k6 report', { stage: 'write', state: 'queued', ...result.k6 }),
  sessionNode('announce', { after: ['report'], stage: 'session', state: 'queued' }),
  { id: 'post', kind: 'write', place: { type: 'slack', ref: '#web-platform' }, title: 'Post in #web-platform', after: [], by: 'announce', review: true, action: { type: 'post', text: 'Chart: {chart.url}' }, stage: 'write', state: 'queued', sessions: [], repairs: [] },
] });

test('the stepper folds a session\'s writes into one pill per place: dots per write, dashed until the place exists, ringed when one needs you', (t) => {
  const f = fixture(t);
  placesJob(f, { k6: { state: 'failed', error: 'k6 was not installed' } });
  f.q('[data-board="job1"] .job-plate-open').click();
  const pill = (id) => f.q(`[data-node="${id}"]`).closest('details.job-place');
  assert.equal(pill('w-pr'), pill('w-done'), 'two writes to one ticket by one session are one pill');
  assert.equal(pill('w-pr').closest('.job-stack'), f.q('[data-node="tix"]').closest('.job-stack'));
  assert.equal(pill('w-pr').querySelectorAll('.job-place-dot').length, 2);
  assert.deepEqual([...pill('w-pr').querySelectorAll('.job-place-dot')].map((d) => d.className.includes('tone-ok')), [true, false]);
  assert.equal(pill('w-pr').querySelector('summary b').textContent, 'AUTH-1');
  assert.ok(!pill('w-pr').classList.contains('ghost'), 'a ticket with a key exists');
  const open = pill('w-pr').querySelector('.job-place-head a');
  assert.deepEqual([open.getAttribute('href'), open.target, open.rel], ['https://x.atlassian.net/browse/AUTH-1', '_blank', 'noopener'], 'a ticket opens on the site the planner read');
  const go = pill('w-pr').querySelector('summary a.job-place-go');
  assert.deepEqual([go.getAttribute('href'), go.target], ['https://x.atlassian.net/browse/AUTH-1', '_blank'], 'the pill\'s own arrow opens the place');
  assert.equal(pill('chart').querySelector('summary a'), null, 'nothing to open before it is made');
  pill('w-pr').open = true; pill('w-pr').ontoggle();
  pill('chart').open = true; pill('chart').ontoggle();
  assert.deepEqual([pill('w-pr').open, pill('chart').open], [false, true], 'one place open at a time');
  assert.notEqual(pill('chart'), pill('k6'), 'each made output is its own place');
  assert.equal(f.q('[data-node="chart"]').closest('.job-stack'), f.q('[data-node="report"]').closest('.job-stack'), 'a made output hangs under its session');
  assert.ok(pill('chart').classList.contains('ghost')); assert.match(pill('chart').querySelector('.job-place-head em').textContent, /not made yet/);
  assert.equal(pill('chart').querySelector('summary b').textContent, 'p95 <i>chart</i>', 'what the planner wrote is text');
  assert.match(f.q('[data-node="chart"]').textContent, /^Make\s*made by the session$/);
  assert.ok(pill('k6').classList.contains('urgent') && pill('k6').classList.contains('tone-bad'), 'a failed output rings its pill');
  assert.match(pill('post').querySelector('summary').textContent, /^#web-platform$/); assert.ok(pill('post').querySelector('.job-write-review'), 'the eye says it is reviewed first');
  f.q('[data-open-sub="k6"]').click();
  assert.equal(f.q('.job-event b').textContent, 'Not made');
  assert.deepEqual([...document.querySelectorAll('.job-actions button')].map((b) => b.textContent.trim()), ['Retry', 'Edit'], 'Retry runs its session again for it');
});

test('a place that exists opens from its pill; a local file shows its path to copy', async (t) => {
  const f = fixture(t);
  placesJob(f, { chart: { stage: 'done', state: 'done', result: { outcome: 'written', url: 'https://claude.ai/artifact/7f3c', title: 'Checkout p95', receiptId: 'r2', at: 2 } },
    k6: { stage: 'done', state: 'done', result: { outcome: 'written', url: '/Users/me/k6 report.html', receiptId: 'r2', at: 2 } } });
  f.q('[data-board="job1"] .job-plate-open').click();
  const pill = (id) => f.q(`[data-node="${id}"]`).closest('details.job-place');
  assert.equal(pill('chart').querySelector('summary b').textContent, 'Checkout p95', 'a made place takes the title it was made with');
  assert.equal(pill('chart').querySelector('.job-place-head a').getAttribute('href'), 'https://claude.ai/artifact/7f3c');
  assert.equal(pill('k6').querySelector('.job-place-head a'), null, 'the board cannot follow file://');
  assert.equal(pill('k6').querySelector('.job-place-path code').textContent, '/Users/me/k6 report.html');
  const copied = [];
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (s) => { copied.push(s); } } }, configurable: true });
  t.after(() => Object.defineProperty(globalThis, 'navigator', prev));
  pill('k6').querySelector('[data-copy-path]').click(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, ['/Users/me/k6 report.html']);
  assert.equal(pill('k6').querySelector('[data-copy-path]').textContent, 'Copied');
});

test('the plate carries one chip per place across the job, dots merged, an existing place a link above the plate, and a moon rather than a step for a write', (t) => {
  const f = fixture(t);
  const job = placesJob(f, { chart: { stage: 'done', state: 'done', result: { outcome: 'written', url: 'https://claude.ai/artifact/7f3c', receiptId: 'r2', at: 2 } } });
  const card = f.q('[data-board="job1"]');
  assert.deepEqual([...card.querySelectorAll('.job-plate-graph g.node:not(.moon)')].map((e) => e.dataset.sub), ['api', 'report', 'tix', 'announce'], 'writes add no step; a session waiting on a milestone is a wave later');
  assert.deepEqual([...card.querySelectorAll('.job-plate-graph g.moon')].map((e) => e.dataset.sub), ['chart', 'k6', 'w-pr', 'w-done', 'post'], 'each write hangs off the session that makes it');
  const chips = [...card.querySelectorAll('.job-plate-places .job-plate-place')];
  assert.deepEqual(chips.map((c) => c.querySelector('.job-plate-place-name').textContent), ['AUTH-1', 'p95 <i>chart</i>', 'k6 report', '#web-platform']);
  assert.equal(chips[0].querySelectorAll('i').length, 2, 'every write to the ticket, merged');
  assert.ok(chips.every((c) => c.tagName === 'BUTTON'), 'a chip opens its writes, as the expanded job\'s place pill does');
  assert.equal(chips[2].classList.contains('ghost'), true, 'a place not made yet is ghosted');
  assert.match(chips[3].title, /^Slack channel · #web-platform\nPost in #web-platform: .+ \(you review it first\)$/);
  assert.doesNotMatch(plateHtml({ ...job, stage: 'planning', plan: job.plan }, 'opus'), /job-plate-places/, 'a plan with no writes draws no chips');
  card.querySelector('.job-plate-art').click();
  assert.equal(f.q('#job-dialog').open, true, 'the sky opens the job, as the title does');
  f.q('#job-dialog').close();
  const pop = f.q('.job-plate-pop');
  chips[0].click();
  assert.equal(f.q('#job-dialog').open, false, 'opening the place is not opening the job');
  assert.equal(pop.hidden, false);
  assert.deepEqual([pop.querySelector('header a').getAttribute('href'), pop.querySelector('header a').target], ['https://x.atlassian.net/browse/AUTH-1', '_blank'], 'the link out lives in the list');
  assert.equal(pop.querySelectorAll('.job-plate-pop-write').length, 2);
  chips[0].click();
  assert.equal(pop.hidden, true, 'a second click on the same chip closes it');
  chips[3].click();
  pop.querySelector('.job-plate-pop-write').click();
  assert.equal(pop.hidden, true);
  assert.equal(f.q('#job-dialog').open, true, 'a write in the list opens that write');
});

test('plan review adds a place under a session and picks its type: a Slack post needs its channel and text, or the session can make an output instead', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan = { ...structuredClone(plan), stories: [], subJobs: [{ ...sub('api'), storyId: undefined, jiraKey: undefined }, sessionNode('report')] };
  f.view.update(f.data); f.q('[data-job="job1"]').click();
  assert.equal(f.q('[data-add-write="api"]'), null, 'a PR makes no writes');
  f.q('[data-add-write="report"]').click();
  let editor = f.q('[data-write-editor]');
  assert.equal(editor.querySelector('[name="placeType"]:checked').value, 'slack', 'a plan with no stories offers a post first');
  assert.deepEqual([...editor.querySelectorAll('[name="placeType"]')].map((o) => o.value), ['slack', 'confluence', 'artifact', 'file', 'url', 'other'], 'no Jira without a story');
  assert.ok(editor.querySelector('[name="placeType"][value="other"]').closest('.job-place-opt').classList.contains('other'), 'Something else is the dashed, open-ended one');
  assert.match(editor.querySelector('.job-error').textContent, /Name the channel/);
  assert.ok(f.q('[data-action="approve-plan"]').disabled);
  editor.querySelector('[name="ref"]').value = '#web-platform'; editor.querySelector('[name="ref"]').dispatchEvent(f.event('change'));
  editor = f.q('[data-write-editor]');
  editor.querySelector('[name="text"]').value = 'Shipped {pr.url}'; editor.querySelector('[name="text"]').dispatchEvent(f.event('change'));
  assert.equal(f.q('[data-write-editor] .job-error'), null);
  assert.match(f.q('[data-write-editor] h4').textContent, /Post in #web-platform/);
  f.q('[data-write-done]').click();
  f.q('[data-add-write="report"]').click();
  editor = f.q('[data-write-editor]');
  editor.querySelector('[name="placeType"][value="artifact"]').checked = true; editor.querySelector('[name="placeType"][value="artifact"]').dispatchEvent(f.event('change'));
  editor = f.q('[data-write-editor]');
  assert.equal(editor.querySelector('[name="on"]'), null, 'its session decides when');
  editor.querySelector('[name="what"]').value = 'p95 chart'; editor.querySelector('[name="what"]').dispatchEvent(f.event('change'));
  f.q('[data-action="approve-plan"]').click();
  const sent = f.sent.at(-1).plan.subJobs.filter((s) => s.kind === 'write');
  assert.deepEqual(sent.map((s) => [s.id, s.place, s.action, s.on, s.by, s.title]), [
    ['report-write', { type: 'slack', ref: '#web-platform' }, { type: 'post', text: 'Shipped {pr.url}' }, undefined, 'report', 'Post in #web-platform'],
    ['report-write-2', { type: 'artifact' }, { type: 'make', what: 'p95 chart' }, undefined, 'report', 'Make p95 chart']]);
});

test('a Slack post in review asks to Post to Slack, with only its edited fields', (t) => {
  const f = fixture(t);
  placesJob(f, { k6: { state: 'failed', error: 'k6 was not installed' } });
  f.q('[data-board="job1"] .job-plate-open').click(); f.q('[data-open-sub="k6"]').click();
  const [job] = f.data.jobs;
  Object.assign(job.subJobs.find((s) => s.id === 'post'), { stage: 'review', state: 'verified' }); f.view.update(f.data);
  f.q('[data-open-job]').click(); f.q('[data-open-sub="post"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-actions button')].map((b) => b.textContent.trim()), ['Post to Slack', 'Skip']);
  assert.match(f.q('.job-appbar .job-chip-state').title, /nothing has been written to Slack yet/);
  assert.equal(f.q('.job-write-hint'), null, 'the chip already says it');
  const panel = f.q('#job-write-review');
  assert.deepEqual([panel.querySelector('[name="ref"]').value, panel.querySelector('[name="text"]').value], ['#web-platform', 'Chart: {chart.url}']);
  panel.querySelector('[name="ref"]').value = '#web'; panel.querySelector('[name="text"]').value = 'Chart is up: {chart.url}';
  panel.requestSubmit();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'post', action: 'approve-write', write: { action: { text: 'Chart is up: {chart.url}' }, ref: '#web' } });
  panel.querySelector('[name="ref"]').value = ''; panel.requestSubmit();
  assert.match(f.q('#job-move-error').textContent, /Name the channel/);
});

test('a made output in review is already published: it says where, and Accept finishes it with no Skip and no Edit', (t) => {
  const f = fixture(t);
  const job = placesJob(f, { chart: { stage: 'review', state: 'verified', review: true, result: { outcome: 'written', url: 'https://claude.ai/artifact/7f3c', title: 'Checkout <b>p95</b>', receiptId: 'r2', checks: ['Published'], at: 2 } },
    k6: { stage: 'review', state: 'verified', review: true, result: { outcome: 'written', url: '/Users/me/k6.html', receiptId: 'r3', checks: ['Written'], at: 2 } } });
  const chart = job.subJobs.find((s) => s.id === 'chart');
  assert.deepEqual([jobStatus(job, chart).text, jobNeedsReview(job, chart)], ['Review the output', true]);
  f.q('[data-board="job1"] .job-plate-open').click(); f.q('[data-open-sub="chart"]').click();
  assert.equal(f.q('.job-appbar .job-chip-state').title, 'Review is on for this output: Run report published it. Accept it to finish, or drop it.');
  const where = f.q('.job-write-where a');
  assert.deepEqual([where.getAttribute('href'), where.textContent, where.target], ['https://claude.ai/artifact/7f3c', 'Checkout <b>p95</b> ↗', '_blank']);
  assert.deepEqual([...document.querySelectorAll('.job-actions button')].map((b) => b.textContent.trim()), ['Accept']);
  assert.equal(f.q('#job-write-review'), null, 'nothing is left to edit');
  f.q('[data-action="approve-write"]').click();
  assert.deepEqual([f.sent.at(-1).action, f.sent.at(-1).subJobId, f.sent.at(-1).write], ['approve-write', 'chart', undefined]);
  f.q('[data-open-job]').click(); f.q('[data-open-sub="k6"]').click();
  assert.equal(f.q('.job-write-where code').textContent, '/Users/me/k6.html', 'a path is text, never a link');
  assert.equal(f.q('.job-write-where a'), null);
});

test('write review is tri-state: a write\'s own boolean wins, else the job\'s reviewWrites, else off', () => {
  const w = { kind: 'write', place: { type: 'slack' } };
  assert.deepEqual([writeReviewed({}, w), writeReviewed({ reviewWrites: true }, w), writeReviewed({ reviewWrites: true }, { ...w, review: false }), writeReviewed({}, { ...w, review: true })], [false, true, false, true]);
});

test('a job that reviews its writes says so: New job sends the switch, the header flags it, and every write without its own say shows the eye', (t) => {
  const f = fixture(t);
  f.q('#job-new').click(); const form = f.q('#job-create-form');
  assert.equal(form.elements.reviewWrites.checked, false, 'writes run unreviewed unless asked');
  form.elements.reviewWrites.checked = true; form.elements.intent.value = 'Deliver it'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).job.reviewWrites, true);
  f.q('#job-dialog').close();
  const job = placesJob(f);
  f.q('[data-board="job1"] .job-plate-open').click();
  assert.equal(f.q('.job-flag.auto[aria-label^="Writes:"]').title, 'Writes: Auto. Each write is made by its session, with a receipt');
  assert.equal(document.querySelectorAll('.job-write-review').length, 1, 'only the post asks for review itself');
  f.q('#job-dialog').close();
  job.reviewWrites = true; f.view.update(f.data); f.q('[data-board="job1"] .job-plate-open').click();
  assert.equal(f.q('.job-flag.you[aria-label^="Writes:"]').title, 'Writes: You review. Each write to Jira, Slack, Confluence or another place stops for you before it’s made');
  assert.equal(document.querySelectorAll('.job-write-review').length, 5, 'every write now waits for review');
  assert.match(f.q('[data-board="job1"] .job-plate-open').title, /Writes: You review/);
});

test('plan review adds a write to somewhere else: named, optionally located, with the one instruction, and reviewed if asked', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan = { ...structuredClone(plan), stories: [], subJobs: [{ ...sub('api'), storyId: undefined, jiraKey: undefined }, sessionNode('report')] };
  f.view.update(f.data); f.q('[data-job="job1"]').click();
  f.q('[data-add-write="report"]').click();
  let editor = f.q('[data-write-editor]');
  editor.querySelector('[name="placeType"][value="other"]').checked = true; editor.querySelector('[name="placeType"][value="other"]').dispatchEvent(f.event('change'));
  editor = f.q('[data-write-editor]');
  assert.equal(editor.querySelector('.job-error').textContent, 'Name the place.');
  assert.equal(editor.querySelector('[name="on"]'), null, 'its session decides when, like any write');
  const set = (name, value) => { const e = f.q(`[data-write-editor] [name="${name}"]`); e.value = value; e.dispatchEvent(f.event('change')); };
  set('name', 'Status page'); set('ref', 'https://status.example.com');
  assert.equal(f.q('[data-write-editor] .job-error').textContent, 'Say what to do there.');
  set('text', 'Post a resolved notice');
  assert.equal(f.q('[data-write-editor] .job-error'), null);
  assert.match(f.q('[data-write-editor] h4').textContent, /Write to Status page/);
  assert.equal(f.q('[data-node="report-write"]').closest('details.job-place').querySelector('summary b').textContent, 'Status page');
  assert.ok(f.q('[data-node="report-write"]').closest('details.job-place').classList.contains('other'), 'a place elsewhere is drawn dashed');
  const review = f.q('[data-write-editor] [name="review"]'); review.checked = true; review.dispatchEvent(f.event('change'));
  f.q('[data-write-done]').click();
  f.q('[data-add-write="report"]').click();
  editor = f.q('[data-write-editor]');
  editor.querySelector('[name="placeType"][value="other"]').checked = true; editor.querySelector('[name="placeType"][value="other"]').dispatchEvent(f.event('change'));
  assert.deepEqual([...f.q('[data-write-editor] [name="actionType"]').options].map((o) => o.textContent), ['Do something there', 'Made by Run report']);
  set('name', 'Grafana'); set('actionType', 'make');
  assert.match(f.q('[data-write-editor] .job-write-toggle span').title, /once its session publishes it, it waits for you to accept it/);
  set('what', 'p95 dashboard');
  f.q('[data-action="approve-plan"]').click();
  const sent = f.sent.at(-1).plan.subJobs.filter((s) => s.kind === 'write');
  assert.deepEqual(sent.map((s) => [s.place, s.action, s.on, s.by, s.review]), [
    [{ type: 'other', name: 'Status page', ref: 'https://status.example.com' }, { type: 'write', text: 'Post a resolved notice' }, undefined, 'report', true],
    [{ type: 'other', name: 'Grafana' }, { type: 'make', what: 'p95 dashboard' }, undefined, 'report', false]]);
});

test('a write elsewhere in review is approved as Write to its name, sending only the edited instruction', (t) => {
  const f = fixture(t);
  withWrites(f, [], { stage: 'active', subJobs: [{ ...sub('api'), stage: 'pr', state: 'watching', pr: { url: 'https://github.com/org/repo/pull/7', checkStatus: 'pending' } },
    sessionNode('notify', { on: { sub: 'api', at: 'pr' }, stage: 'session', state: 'queued', sessions: ['s1'] }),
    { id: 'status', kind: 'write', place: { type: 'other', name: 'Status page', ref: 'https://status.example.com' }, title: 'Write to Status page', after: [], by: 'notify', review: true, action: { type: 'write', text: 'Post a notice' }, stage: 'review', state: 'verified', sessions: [], repairs: [] }] });
  f.q('[data-board="job1"] .job-plate-open').click(); f.q('[data-open-sub="status"]').click();
  assert.match(f.q('.job-appbar .job-chip-state').title, /nothing has been written to Status page yet/);
  assert.deepEqual([...document.querySelectorAll('.job-actions button')].map((b) => b.textContent.trim()), ['Write to Status page', 'Skip']);
  const panel = f.q('#job-write-review');
  panel.querySelector('[name="text"]').value = 'Post a resolved notice';
  panel.requestSubmit();
  assert.deepEqual(f.sent.at(-1).write, { action: { text: 'Post a resolved notice' } });
  panel.querySelector('[name="name"]').value = 'Statuspage'; panel.requestSubmit();
  assert.deepEqual(f.sent.at(-1).write, { action: { text: 'Post a resolved notice' }, name: 'Statuspage' });
});

test('the Writes checkpoint is in the footer only with writes, asks before releasing the drafts that follow it, and locks once none does', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }];
  f.view.update(f.data); f.view.openDetail('job1');
  assert.equal(footerButton(f, 'reviewWrites'), null, 'no writes, no Writes switch');
  f.q('#job-dialog').close();
  job.reviewWrites = true;
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }, sessionNode('n', { stage: 'session', state: 'running' }),
    jiraWrite('post', 'n', { type: 'comment', comment: 'Shipped' }, { stage: 'review', state: 'verified' }),
    jiraWrite('move', 'n', { type: 'transition', to: 'Done' }, { stage: 'review', state: 'verified', review: true }),
    jiraWrite('later', 'n', { type: 'comment', comment: 'Later' }, { stage: 'write', state: 'queued' })];
  f.view.update(f.data); f.view.openDetail('job1');
  const writes = () => footerButton(f, 'reviewWrites');
  assert.deepEqual([writes().getAttribute('aria-pressed'), writes().getAttribute('aria-label'), writes().getAttribute('aria-disabled')], ['true', 'Writes: You review. Switch to Auto', null]);
  const before = f.sent.length;
  writes().click();
  assert.equal(f.sent.length, before, 'a draft is waiting, so it asks first');
  assert.match(f.q('#job-review-confirm').textContent, /Switch Writes to Auto\?A write is waiting for your review\. Auto lets it through now/, 'a write with its own review is not counted');
  assert.equal(f.q('#job-review-confirm button.primary').textContent, 'Approve the write');
  f.q('#job-review-confirm').dispatchEvent(f.event('submit'));
  assert.deepEqual(reviewSent(f), { type: 'job-action', id: 'job1', action: 'set-review', field: 'reviewWrites', you: false, release: true });
  assert.match(footerHint(f), /Writes: Auto The write is approved; each session makes what it drafted\. Released work can’t be pulled back\./);
  job.reviewWrites = false; f.view.update(f.data);
  writes().click();
  assert.deepEqual(reviewSent(f), { type: 'job-action', id: 'job1', action: 'set-review', field: 'reviewWrites', you: true }, 'nothing waits on Auto, so back on applies at once');
  assert.match(footerHint(f), /Writes: You review From the next write on\./);
  job.reviewWrites = true;
  for (const w of job.subJobs.filter((s) => s.kind === 'write' && s.id !== 'move')) Object.assign(w, { stage: 'done', state: 'done' });
  f.view.update(f.data);
  assert.equal(writes().getAttribute('aria-disabled'), 'true');
  assert.match(writes().getAttribute('aria-label'), /^Writes: You review\. Every write is made, decided, or has its own review setting$/);
});

test('a plate’s stub does what it names: Merge sends the merge pinned to its head, a failing one opens the sub-job to resolve', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/4', head: 'h4', checkStatus: 'passing', checks: [] } }];
  f.view.update(f.data);
  assert.equal(f.q('[data-filter="needs"] .jobs-rail-n').textContent, '1'); assert.ok(f.q('#jobs-review-count').classList.contains('ask'));
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Merge #4');
  f.q('.job-plate-go').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'approve-merge', head: 'h4' });
  assert.equal(f.q('#job-dialog').open, false, 'merging from the board opens nothing');
  job.subJobs[0] = { ...job.subJobs[0], pr: { ...job.subJobs[0].pr, checkStatus: 'failing' }, error: 'Automatic repair limit reached' };
  f.view.update(f.data);
  assert.ok(f.q('[data-board="job1"]').classList.contains('tone-bad'));
  assert.equal(f.q('.job-plate-go').textContent, 'Resolve');
  f.q('.job-plate-go').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver api', 'Resolve lands on the sub-job, where Request changes is');
  assert.ok(f.q('.job-change').classList.contains('is-open'));
});

test('a plate’s stub decides a write draft in place: its verb approves it as drafted, Skip finishes it unwritten', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const draft = { id: 'w', kind: 'write', place: { type: 'jira' }, title: 'Move AUTH-1', storyId: 'story', jiraKey: 'AUTH-1', by: 'n', after: [], action: { type: 'transition', to: 'In Review' }, review: true, stage: 'review', state: 'verified', sessions: [], repairs: [] };
  job.subJobs = [{ id: 'n', kind: 'session', title: 'Run n', after: [], brief: 'b', stage: 'session', state: 'queued', sessions: ['s1'], repairs: [] }, draft];
  job.runs = [{ id: 'r1', subJobId: 'n', phase: 'session', stopped: false, sessionId: 's1', parkedAt: 1, drafts: ['w'] }];
  f.view.update(f.data);
  assert.equal(f.q('[data-board="job1"] .job-plate-ask').textContent, 'Draft ready');
  assert.equal(f.q('.job-plate-go').textContent, 'Move in Jira');
  f.q('.job-plate-alt').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'w', action: 'skip-write' });
  assert.ok(f.q('.job-plate-go').disabled, 'one decision per tick');
  f.view.update(f.data); f.q('.job-plate-go').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'w', action: 'approve-write' });
  assert.equal(f.q('#job-dialog').open, false, 'deciding from the board opens nothing');
});

test('the masthead is titled Wrangler² over a kicker that is just the date', (t) => {
  const f = fixture(t);
  assert.equal(f.q('.jobs-mast h1').textContent, 'Wrangler²');
  assert.equal(f.q('#jobs-date').textContent, new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }));
  assert.equal(f.q('.jobs-mast').textContent.split('Wrangler²').length, 2, 'the name appears once, in the title');
});

test('the masthead counts agents in bays and says when automation is paused', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.usd = 3.5;
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }];
  job.runs = [{ id: 'r1', subJobId: 'api', phase: 'implementation', stopped: false, status: 'working' }];
  f.view.update(f.data);
  assert.equal(f.q('#jobs-active-count').textContent, '1/2');
  assert.equal(f.q('#jobs-active-count').title, '1 of 2 agents working');
  assert.deepEqual([...document.querySelectorAll('#jobs-bays i')].map((i) => i.className), ['on', '']);
  assert.equal(f.q('#jobs-spend').textContent, '$3.50 on open jobs');
  f.data.settings.paused = true; f.view.update(f.data);
  assert.ok(f.q('#jobs').classList.contains('jobs-paused'));
  assert.equal(f.q('#jobs-pause').getAttribute('aria-pressed'), 'true');
  assert.equal(f.q('#jobs-active-count').textContent, '1/2');
  assert.equal(f.q('#jobs-active-count').title, '1 of 2 agents paused');
});

test('New job\'s Sandbox section follows the agent and round-trips its mode and folders into job-create', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  const sbx = () => f.q('#job-sandbox');
  assert.ok(f.q('.job-create-brief .job-review-grid .job-review-tiles .job-review[data-checkpoint="reviewWrites"]'), 'the checkpoints are tiles under the brief');
  assert.equal(f.q('.job-create-props .job-review'), null, 'and no longer in the side panel');
  assert.match(sbx().textContent, /Not used by Claude/, 'Claude collapses the section to one row');
  assert.equal(sbx().querySelector('.job-sbx'), null);
  click(f, '.pick-ticket'); click(f, '.pick-tab[data-agent=codex]'); click(f, '.pick-cell[data-value="gpt-5.6-sol"]');
  const pressed = () => sbx().querySelector('.job-sbx[aria-pressed=true]').dataset.mode;
  const launches = () => sbx().querySelector('.job-sbx-launch code').textContent;
  assert.equal(pressed(), 'auto', 'a new job auto-approves');
  assert.equal(launches(), 'codex --approve-for-me');
  click(f, '.job-sbx-add');
  const input = sbx().querySelector('.job-sbx-input');
  const enter = (value) => { const el = sbx().querySelector('.job-sbx-input'); el.value = value; el.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); };
  assert.ok(input, 'the add button opens a path field');
  enter('relative/dir');
  assert.equal(sbx().querySelector('.job-sbx-input').getAttribute('aria-invalid'), 'true', 'a relative path is refused');
  enter('~/.docker/'); enter('/opt/cache'); enter('~/.docker');
  assert.equal(f.sent.length, 0, 'Enter in the folder field never submits New job');
  assert.deepEqual([...sbx().querySelectorAll('.job-sbx-chip')].map((c) => c.textContent), ['~/.docker', '/opt/cache'], 'trailing slash trimmed, duplicates dropped');
  assert.equal(launches(), 'codex --approve-for-me --add-dir ~/.docker --add-dir /opt/cache');
  click(f, '.job-sbx-chip button[aria-label="Remove /opt/cache"]');
  click(f, '.job-sbx[data-mode=full]');
  assert.equal(sbx().querySelector('.job-sbx-dirs').hidden, true, 'Full access hides the folders');
  assert.equal(launches(), 'codex --dangerously-bypass-approvals-and-sandbox');
  click(f, '.job-sbx[data-mode=locked]');
  assert.equal(launches(), 'codex --sandbox workspace-write --ask-for-approval never --add-dir ~/.docker');
  form.elements.intent.value = 'Build the dev container';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual([f.sent[0].type, f.sent[0].job.agent, f.sent[0].job.sandbox, f.sent[0].job.writableDirs], ['job-create', 'codex', 'locked', ['~/.docker']]);
});

test('New job has no Land on field: the plan chooses each PR\'s branch, so the job carries no base', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  assert.equal(form.elements.base, undefined);
  form.elements.intent.value = 'Deliver something useful';
  form.dispatchEvent(f.event('submit'));
  assert.equal('base' in f.sent[0].job, false);
});

test('a red PR\'s box is plain words: no Instant or Claude chips, and the idea goes to the planner pinned to the head on screen', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', state: 'watching', pr: { url: 'https://github.com/org/repo/pull/7', head: 'h1', checkStatus: 'failing', checks: [] } }, { ...sub('web', ['api']), stage: 'implementation', state: 'queued' }];
  f.view.update(f.data); f.q('.job-plate-graph [data-sub="api"]').dispatchEvent(f.event('click'));
  assert.deepEqual([f.q('.job-quick'), f.q('[data-quick]'), f.q('[data-fill]')], [null, null, null], 'no chips');
  const box = f.q('.job-change');
  assert.deepEqual([box.querySelector('.job-change-to').textContent, box.querySelector('textarea').placeholder, box.querySelector('[data-change-send]').getAttribute('aria-label')], ['PPlanner', 'Add an idea about this step…', 'Send to planner']);
  assert.ok(box.querySelector('.job-change-attach input[type="file"]'), 'a picture can be picked as well as pasted or dropped');
  const text = box.querySelector('textarea'); text.value = 'Accept the flaky e2e'; text.dispatchEvent(f.event('input'));
  box.querySelector('[data-change-send]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'request-change', at: 'pr', ref: 'h1', text: 'Accept the flaky e2e' }, 'pinned to the head on screen');
  f.q('.job-dialog-close').click();
  f.q('.job-plate-graph [data-sub="web"]').dispatchEvent(f.event('click'));
  assert.deepEqual([f.q('.job-quick'), f.q('.job-change-to').textContent], [null, 'PPlanner']);
});

test('a merged sub-job\'s idea goes to the planner; the box steps aside while the planner draws, and adds to the proposal once one waits', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'deployment', state: 'watching', pr: { url: 'https://github.com/org/repo/pull/7', head: 'h1', mergeCommit: 'm1' }, deploymentResult: { status: 'failing', runs: [] } }, { ...sub('web'), stage: 'implementation', state: 'queued' }];
  f.view.update(f.data); f.q('.job-plate-graph [data-sub="api"]').dispatchEvent(f.event('click'));
  assert.deepEqual([f.q('.job-change').dataset.changeAt, f.q('.job-change-to').textContent, f.q('.job-quick')], ['step', 'PPlanner', null]);
  job.replan = { feedback: 'x', at: 1, proposal: null }; f.view.update(f.data);
  assert.equal(f.q('.job-change'), null, 'the planner takes one idea at a time');
  job.replan.proposal = { id: 'run_p', plan: job.plan, merged: job.plan, changes: { frozen: [], kept: [], edited: [], added: [], removed: [] }, actions: [] }; f.view.update(f.data);
  assert.equal(f.q('.job-quick'), null);
  assert.deepEqual([f.q('.job-change').dataset.changeAt, f.q('.job-change-to').textContent], ['step', 'PPlanner']);
});

test('a proposal with a diagnosis, ranked options and actions: options switch the graph, actions are marks on the node, approve names the option', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  const pr = { url: 'https://github.com/org/repo/pull/7', head: 'h1', checkStatus: 'failing' };
  job.subJobs = [{ ...sub('api'), stage: 'pr', state: 'watching', pr }, { ...sub('web', ['api']), stage: 'implementation', state: 'queued' }];
  job.plan = { ...plan, subJobs: [sub('api'), sub('web', ['api'])] };
  const changes = (extra) => ({ frozen: [], kept: ['api', 'web'], edited: [], added: [], removed: [], ...extra });
  const fixed = { ...job.plan, subJobs: [sub('flake'), { ...sub('api'), after: ['flake'] }, sub('web', ['api'])] };
  job.replan = { feedback: 'Checks red', at: 1, previous: null, proposal: { id: 'run_p', label: 'Accept the red checks', why: 'Unrelated <i>flake</i>', plan: job.plan, merged: job.plan, changes: changes(),
    actions: [{ type: 'accept-red', sub: 'api', pin: { at: 'head', ref: 'h1abcdef123' } }],
    diagnosis: { summary: 'login-flow.spec <b>times out</b>', evidence: [{ label: 'run 88213', detail: 'e2e' }] },
    alternatives: [{ label: 'Fix the flaky test first', why: 'A new PR first', plan: fixed, merged: fixed, changes: changes({ added: ['flake'], edited: [{ id: 'api', fields: ['after'] }], kept: ['web'] }), actions: [] }] } };
  f.view.update(f.data); f.q('[data-board="job1"] .job-plate-open').click();
  const html = () => f.q('#job-dialog').innerHTML;
  assert.match(f.q('.job-triage').textContent, /Wrangler looked into it.*times out.*run 88213e2e/);
  assert.ok(!html().includes('<b>times out</b>') && !html().includes('<i>flake</i>'), 'agent text is escaped');
  assert.deepEqual([...document.querySelectorAll('.job-option b')].map((b) => b.textContent), ['Accept the red checksRecommended', 'Fix the flaky test first']);
  assert.equal(f.q('.job-node[data-node="api"] .job-mark').textContent, 'Accept red', 'the action is drawn on the node it acts on');
  assert.match(f.q('.job-replan-changes .job-mark-act').textContent, /Accept red: Deliver api\s*merge as it stands\s*pinned to head h1abcdef1/);
  f.q('[data-action="approve-replan"]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: undefined, action: 'approve-replan', proposalId: 'run_p', option: 0 });
  const second = f.q('input[name="opt"][value="1"]'); second.checked = true; second.dispatchEvent(f.event('change'));
  assert.equal(f.q('.job-node[data-node="flake"] .job-mark').textContent, 'New');
  assert.equal(f.q('.job-node[data-node="api"] .job-mark').textContent, 'Edited');
  assert.equal(document.querySelectorAll('.job-replan-changes .job-mark-act').length, 0, 'the other option\'s action is not shown');
  assert.ok(f.q('.job-option.sel').textContent.includes('Fix the flaky test first'));
  f.q('[data-action="approve-replan"]').click();
  assert.equal(f.sent.at(-1).option, 1);
});

test('a recover is a mark on the merged node that waits for its fix, and a proposal without options sends no option', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'deployment', state: 'watching', pr: { url: 'https://github.com/org/repo/pull/7', head: 'h1', mergeCommit: 'm1' }, deploymentResult: { status: 'failing' } }];
  job.plan = { ...plan, subJobs: [sub('api')] };
  const merged = { ...job.plan, subJobs: [sub('api'), sub('fix')] };
  job.replan = { feedback: 'Deploy failed', at: 1, previous: null, proposal: { id: 'run_q', plan: merged, merged, changes: { frozen: ['api'], kept: [], edited: [], added: ['fix'], removed: [] }, actions: [{ type: 'recover', sub: 'api', fix: 'fix', pin: { at: 'merge', ref: 'm1' } }] } };
  f.view.update(f.data); f.q('[data-board="job1"] .job-plate-open').click();
  assert.equal(f.q('.job-node[data-node="api"] .job-mark').textContent, 'Waits for its fix');
  assert.match(f.q('.job-replan-changes .job-mark-act').textContent, /Recover: Deliver api\s*lands when “Deliver fix” deploys\s*pinned to merge m1/);
  assert.equal(f.q('.job-options'), null, 'one option needs no chooser');
  f.q('[data-action="approve-replan"]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: undefined, action: 'approve-replan', proposalId: 'run_q' });
});

// --- Show me and proof (design B step 1) ---

const proofSub = (extra = {}) => ({ ...sub('api'), stage: 'review', state: 'verified', worktree: { path: '/wt', branch: 'sec-412' }, sessions: ['s1'], show: ['Lists sign-ins', 'SSO appears'],
  ready: { round: 1, receiptId: 'run_1', checks: ['Lint clean', 'Lists sign-ins', 'SSO appears'], proof: [
    { text: 'Lists sign-ins', shots: [{ file: 'l.png', mime: 'image/png', url: 'http://localhost:5174/audit', viewport: '1280x800', tool: 'Playwright', at: 1700000000000 }] },
    { text: 'SSO appears', couldNot: 'No SSO key in this worktree' }] }, ...extra });
const evidenceFrame = (file = 'l.png') => ({ event: 'job-evidence', jobId: 'job1', subJobId: 'api', round: 1, thumbs: [{ file, mime: 'image/jpeg', dataBase64: 'dGg=' }] });

test('the plan editor lists each PR\'s Show me items, edits them like the title, and approval sends the cleaned list', (t) => {
  const f = fixture(t);
  f.data.jobs[0].plan = { ...plan, subJobs: [{ ...sub('api'), show: ['Lists sign-ins', 'Unit tests pass'] }, sub('web', ['api'])] };
  f.view.update(f.data);
  f.q('.job-plate-open[data-job="job1"]').click();
  assert.equal(f.q('.job-node-show summary span').textContent, '2', 'the count on the node');
  assert.deepEqual([...f.q('[data-show-d="api"]').querySelectorAll('input')].map((i) => i.value), ['Lists sign-ins', 'Unit tests pass']);
  assert.equal(f.q('[data-show-d="web"] summary span').textContent, 'None');
  const first = f.q('input[data-show="0"][data-show-k="0"]'); first.value = 'Filters by result'; first.dispatchEvent(f.event('input'));
  f.q('[data-show-add="1"]').click();
  assert.equal(f.q('[data-show-d="web"]').open, true, 'adding opens the editor and it survives the redraw');
  assert.equal(document.activeElement, f.q('input[data-show="1"][data-show-k="0"]'), 'the new row takes focus');
  const added = f.q('input[data-show="1"][data-show-k="0"]'); added.value = '  Web renders  '; added.dispatchEvent(f.event('input'));
  f.q('[data-show-add="1"]').click(); f.q('[data-show-add="1"]').click();
  f.q('[data-show-rm="0:1"]').click();
  assert.deepEqual([...f.q('[data-show-d="api"]').querySelectorAll('input')].map((i) => i.value), ['Filters by result'], 'a redraw keeps what was typed');
  assert.equal(f.q('input[data-show="0"]').value, 'Filters by result');
  f.q('[data-action="approve-plan"]').click();
  const [api, web] = f.sent[0].plan.subJobs;
  assert.deepEqual(api.show, ['Filters by result']);
  assert.deepEqual(web.show, ['Web renders'], 'trimmed, and the blank rows are gone');
  assert.equal('show' in sub('x'), false);
  assert.equal(f.data.jobs[0].plan.subJobs[1].show, undefined, 'the live plan is not touched until the server answers');
});

test('a sub-job with no Show me list sends none, and a session or write node has no editor', (t) => {
  const f = fixture(t);
  f.q('.job-plate-open[data-job="job1"]').click();
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent[0].plan.subJobs.every((s) => !('show' in s)), true);
  const g = fixture(t);
  g.data.jobs[0].plan = { ...plan, subJobs: [{ id: 'spike', kind: 'session', title: 'Spike', after: [], brief: 'Look' }] };
  g.view.update(g.data); g.q('.job-plate-open[data-job="job1"]').click();
  assert.equal(document.querySelectorAll('.job-node-show').length, 0);
});

test('the sub-job and the plan\'s reading section say what must be shown, escaped', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [proofSub({ show: ['Lists <b>sign-ins</b>', 'SSO appears'] })];
  f.view.update(f.data);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.deepEqual([...f.q('#job-dialog .job-show-list').querySelectorAll('li')].map((li) => li.textContent), ['Lists <b>sign-ins</b>', 'SSO appears']);
  assert.equal(f.q('#job-dialog .job-show-list b'), null);
});

test('a ready receipt with proof is one checklist: the verdict, each Show me row with its evidence, the plain checks as rows, and no old list', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [proofSub()];
  f.view.update(f.data);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const dialog = f.q('#job-dialog');
  assert.match(dialog.querySelector('.job-proof-verdict').textContent, /^2 of 3 checked· 1 couldn’t show$/);
  assert.deepEqual([...dialog.querySelectorAll('.job-proof-item')].map((c) => [c.classList.contains('gap'), c.classList.contains('plain'), c.querySelector('.t').textContent.trim()]),
    [[false, false, 'Lists sign-ins'], [true, false, 'SSO appears' + dialog.querySelector('.job-proof-item.gap .t small').textContent], [false, true, 'Lint clean']]);
  assert.equal(dialog.querySelector('.job-proof-item.gap .job-proof-pill').textContent, 'couldn’t');
  assert.equal([...dialog.querySelectorAll('h3')].some((h) => h.textContent === 'Ready for review'), false);
  assert.equal(dialog.querySelector('.job-receipt'), null, 'no separate Also checked list');
  assert.equal(dialog.querySelector('.job-pinned'), null, 'no round or tree hash beside Approve');
  assert.equal(f.sent.at(-1).type, 'job-evidence', 'the dialog asks for the round\'s thumbnails');
  assert.deepEqual(f.sent.at(-1), { type: 'job-evidence', id: 'job1', subJobId: 'api', round: 1 });
  const asked = f.sent.length; f.view.update(f.data);
  assert.equal(f.sent.filter((m) => m.type === 'job-evidence').length, 1, `a tick does not ask again (${asked})`);
  f.view.evidence(evidenceFrame());
  assert.equal(dialog.querySelector('[data-ev-file="l.png"] img').getAttribute('src'), 'data:image/jpeg;base64,dGg=', 'the thumbnail fills in place');
  assert.match(f.q('#job-diff').textContent, /^Review code$/, 'the diff is still the other half of the review');
});

test('a receipt with no proof keeps the Ready for review list exactly as before', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [proofSub({ show: undefined, ready: { checks: ['Tests pass'], receiptId: 'run_1' } })];
  f.view.update(f.data);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.match(f.q('#job-dialog').textContent, /Ready for review/);
  assert.equal(f.q('#job-dialog .job-proof'), null);
  assert.equal(f.sent.some((m) => m.type === 'job-evidence'), false);
});

test('a delivered sub-job keeps what it verified: the checks as Verified, or its proof with no Ask', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'done';
  job.subJobs = [proofSub({ show: undefined, stage: 'done', state: 'done', ready: { checks: ['Tests pass'], receiptId: 'run_1' } })];
  f.view.update(f.data);
  f.q('[data-filter="done"]').click();
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.ok([...f.q('#job-dialog').querySelectorAll('h3')].some((h) => h.textContent === 'Verified'));
  assert.deepEqual([...f.q('#job-dialog .job-receipt').querySelectorAll('li')].map((li) => li.textContent.trim()), ['✓ Tests pass']);
  job.subJobs = [proofSub({ stage: 'done', state: 'done' })];
  f.view.update(f.data);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.ok(f.q('#job-dialog .job-proof'), 'the checklist stays');
  f.q('#job-dialog [data-proof="0"]').click();
  assert.equal(f.q('#job-dialog [data-proof-ask]'), null, 'nothing is left to ask a delivered step');
});

test('a row opens in place, its shot opens the viewer: where it was taken, a reason in full, a way back, and Ask about this starts the box', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [proofSub()];
  f.view.update(f.data);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const dialog = f.q('#job-dialog');
  const row = dialog.querySelector('.job-proof-item');
  row.open = true; row.dispatchEvent(f.event('toggle'));
  f.view.update(f.data);
  assert.equal(dialog.querySelector('.job-proof-item').open, true, 'an opened row stays open across a tick');
  assert.match(dialog.querySelector('.job-proof-item .job-proof-shot small').textContent, /localhost:5174\/audit · 1280x800/);
  f.q('[data-proof="0"]').click();
  assert.equal(dialog.querySelector('h2').textContent, 'Shown working · 1 of 2');
  assert.match(dialog.querySelector('.job-proof-meta').textContent, /URLhttp:\/\/localhost:5174\/audit.*Viewport1280x800.*HowPlaywright/);
  assert.deepEqual(f.sent.at(-1), { type: 'job-evidence', id: 'job1', subJobId: 'api', round: 1, file: 'l.png' }, 'the full file is asked for once it is open');
  f.view.evidence({ event: 'job-evidence', jobId: 'job1', subJobId: 'api', round: 1, file: 'l.png', mime: 'image/png', dataBase64: 'ZnVsbA==' });
  assert.equal(dialog.querySelector('img.job-proof-full').getAttribute('src'), 'data:image/png;base64,ZnVsbA==');
  f.view.update(f.data);
  assert.equal(dialog.querySelector('h2').textContent, 'Shown working · 1 of 2', 'a tick leaves the open shot where it was');
  f.q('[data-proof-go="1"]').click();
  assert.match(dialog.querySelector('.job-proof-stage.gap').textContent, /No SSO key in this worktree/);
  assert.match(dialog.querySelector('[data-proof-ask]').textContent, /Ask it to try another way/);
  f.q('[data-proof-back]').click();
  assert.ok(dialog.querySelector('.job-proof-list'), 'back is the step');
  f.q('[data-proof-ask="0"]').click();
  const box = dialog.querySelector('.job-change textarea');
  assert.equal(box.value, 'About “Lists sign-ins”: ', 'the question is started, about this picture');
  assert.equal(dialog.querySelector('[data-change-send]').disabled, false);
  assert.equal(dialog.querySelector('.job-proof-list') != null, true);
  f.view.update(f.data);
  assert.equal(dialog.querySelector('.job-change textarea').value, 'About “Lists sign-ins”: ', 'typed text survives the tick');
  box.value = `${box.value}is the order right?`; box.dispatchEvent(f.event('input'));
  dialog.querySelector('[data-change-send]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'request-change', at: 'code', ref: 'run_1', text: 'About “Lists sign-ins”: is the order right?' });
});

test('asking about a gap asks the agent to try another way', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [proofSub()];
  f.view.update(f.data);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  f.q('[data-proof-ask="1"]').click();
  assert.equal(f.q('#job-dialog .job-change textarea').value, 'You couldn’t show “SSO appears”. Please try another way: ');
});

test('the board plate says Ready to verify with a filmstrip, only for a sub-job that showed something', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [proofSub()];
  f.view.update(f.data);
  const plate = f.q('[data-board="job1"]');
  assert.equal(plate.querySelector('.job-status').textContent, 'Ready to verify');
  assert.match(plate.querySelector('.job-plate-detail').textContent, /1 of 2 shown · 1 couldn’t/);
  assert.equal(plate.querySelectorAll('.job-plate-film .job-proof-thumb').length, 1);
  assert.equal(f.sent.filter((m) => m.type === 'job-evidence').length, 1, 'the board asks for the thumbnails it draws');
  f.view.evidence(evidenceFrame());
  assert.equal(plate.querySelector('.job-plate-film img') !== null || f.q('[data-board="job1"] .job-plate-film img') !== null, true);
  job.subJobs = [proofSub({ show: undefined, ready: { checks: ['Tests pass'], receiptId: 'run_1' } })];
  f.view.update(f.data);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Review code');
  assert.equal(f.q('[data-board="job1"] .job-plate-film'), null);
});

// --- Design B step 2: the session stays open after ready ---

const parkedJob = (f, extra = {}, subExtra = {}) => {
  const job = f.data.jobs[0]; job.stage = 'active';
  job.runs = [{ id: 'run_1', subJobId: 'api', phase: 'implementation', stopped: false, parkedFor: 'ready', parkedAt: 1700000000000, mailedAt: null, sessionId: 's1', status: 'idle', ...extra }];
  job.subJobs = [proofSub({ thread: [], ...subExtra })];
  f.view.update(f.data);
  return job;
};

test('a Code review step with its session parked and nothing said draws no empty thread, and the thread folds once there is one', (t) => {
  const f = fixture(t); const job = parkedJob(f);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'needs', text: 'Ready to review' }, 'a paused session is not a running step');
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true);
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('#job-dialog .job-thread'), null);
  assert.equal(f.q('#job-dialog .job-history'), null);
  job.subJobs[0].thread = [{ id: 'm1', at: 1, from: 'human', to: 'agent', text: 'Hi', round: 1 }]; f.view.update(f.data);
  const fold = f.q('#job-dialog .job-history');
  assert.equal(fold.open, false);
  assert.equal(fold.querySelector('summary').textContent, 'Conversation 1 message', 'a session waiting on review is what the state chip already says');
  assert.equal(fold.querySelector('.job-thread-head'), null, 'no inner header repeating the state chip');
  assert.equal(f.q('#job-dialog [data-fab-session]'), null, 'Open session is the footer\'s alone');
  assert.equal(document.querySelectorAll('#job-dialog #job-session').length, 1);
  job.runs[0].mailedAt = 2; job.subJobs[0].answering = { id: 'm1', kind: 'change', round: 1 }; f.view.update(f.data);
  assert.match(f.q('#job-dialog .job-history summary').textContent, /Conversation 1 message · working on what you sent/);
  assert.ok(f.q('#job-dialog .job-history summary .icon-spin, #job-dialog .job-history summary svg'), 'the spinner moved up with it');
  assert.match(f.q('#job-dialog .job-proof-verdict').textContent, /from round 1$/, 'the header says round 2, so the list says which round it is from');
  job.subJobs[0].answering.kind = 'ask'; f.view.update(f.data);
  assert.doesNotMatch(f.q('#job-dialog .job-proof-verdict').textContent, /round/, 'answering a question names no round, so neither does the list');
});

test('while the session works on a message the card says what it is doing and is not yours until it reports back', (t) => {
  const f = fixture(t);
  const job = parkedJob(f, { mailedAt: 1700000001000, status: 'working' }, { answering: { id: 'm1', kind: 'ask', round: 1 } });
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Answering you' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
  job.subJobs[0].answering.kind = 'change'; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Reworking · round 2' });
  job.subJobs[0].answering.kind = 'retell'; f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Rechecking the tree');
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Rechecking the tree');
});

test('the thread shows both sides, the round markers and pictures, and escapes every word', (t) => {
  const f = fixture(t);
  const thread = [
    { id: 'm1', at: 1700000000000, from: 'human', to: 'agent', text: 'What if <i>nobody</i> signed in?', round: 1, images: [{ file: 'ask-1.png' }] },
    { id: 'm2', at: 1700000060000, from: 'agent', text: 'The empty state <b>shows</b>.', round: 1, shots: [{ file: 'm2-empty.png' }], run: { cmd: 'npm test', out: '1 passed <x>', exit: 0 } },
    { id: 'm3', at: 1700000120000, from: 'system', text: 'Ready again with new proof.', round: 2 },
  ];
  parkedJob(f, {}, { thread });
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const msgs = [...f.q('#job-dialog').querySelectorAll('.job-msg')];
  assert.deepEqual(msgs.map((m) => m.querySelector('.job-msg-who').textContent), ['You', 'Session', 'Round 2']);
  assert.equal(f.q('#job-dialog .job-msg p i'), null); assert.equal(f.q('#job-dialog .job-msg p b'), null);
  assert.equal(f.q('#job-dialog .job-msg-run x'), null);
  assert.deepEqual([...f.q('#job-dialog').querySelectorAll('.job-msg [data-ev-file]')].map((e) => e.dataset.evFile), ['ask-1.png', 'm2-empty.png']);
});

test('a thread or earlier-round shot opens full size in its own modal, steps through its group, and closes back to its thumbnail', (t) => {
  const f = fixture(t);
  const thread = [
    { id: 'm1', at: 1, from: 'human', to: 'agent', text: 'Look', round: 1, images: [{ file: 'ask-1.png' }] },
    { id: 'm2', at: 2, from: 'agent', text: 'Here', round: 1, shots: [{ file: 'a.png' }, { file: 'b.png' }, { file: 'c.webm' }] },
  ];
  parkedJob(f, {}, { thread, earlier: [{ round: 1, checks: [], proof: [{ text: 'Old', shots: [{ file: 'old.png' }] }] }] });
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  let opens = [...f.q('#job-dialog').querySelectorAll('.job-msg .job-shot-open')];
  assert.deepEqual(opens.map((b) => [b.tagName, b.dataset.shotAt]), [['BUTTON', '0'], ['BUTTON', '0'], ['BUTTON', '1'], ['BUTTON', '2']], 'every thumbnail is a focusable button');
  opens[3].focus(); f.view.update(f.data);
  assert.equal(document.activeElement.querySelector('[data-ev-file]').dataset.evFile, 'c.webm', 'a tick redrawing the step keeps the focused shot focused');
  opens = [...f.q('#job-dialog').querySelectorAll('.job-msg .job-shot-open')];
  f.sent.length = 0;
  opens[2].click();
  const box = () => document.querySelector('.job-shotbox');
  assert.equal(box().tagName, 'DIALOG');
  assert.equal(box().parentElement, document.body, 'its own modal, so Esc closes it and not the step');
  assert.equal(box().querySelector('.job-proof-stage').dataset.evFile, 'b.png');
  assert.match(box().querySelector('.job-shotbox-bar b').textContent, /^2 of 3$/, 'the message\'s own shots, not the question\'s picture');
  assert.deepEqual(f.sent.find((m) => m.file), { type: 'job-evidence', id: 'job1', subJobId: 'api', round: 1, file: 'b.png' }, 'the full file comes the way the proof viewer\'s does');
  box().dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(box().querySelector('.job-proof-stage').dataset.evFile, 'c.webm');
  box().dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(box().querySelector('.job-proof-stage').dataset.evFile, 'c.webm', 'the last stays the last');
  f.view.evidence({ event: 'job-evidence', jobId: 'job1', subJobId: 'api', round: 1, file: 'c.webm', mime: 'video/webm', dataBase64: 'dmlk' });
  assert.ok(box().querySelector('video.job-proof-full[controls]'), 'a clip plays in the box');
  box().querySelector('[data-shotbox-go="-1"]').click();
  assert.equal(box().querySelector('.job-proof-stage').dataset.evFile, 'b.png');
  f.view.update(f.data);
  assert.ok(box(), 'a tick redrawing the step leaves the box open');
  box().querySelector('[data-shotbox-close]').click();
  assert.equal(box(), null);
  assert.equal(document.activeElement.querySelector('[data-ev-file]').dataset.evFile, 'b.png', 'focus goes back to the shot it was on');
  assert.ok(f.q('#job-dialog').open, 'the step stays open');
  f.q('#job-dialog .job-earlier .job-shot-open').click();
  assert.equal(box().querySelector('.job-proof-stage').dataset.evFile, 'old.png', 'earlier rounds open the same viewer');
  assert.equal(box().querySelector('[data-shotbox-go]'), null);
  box().dispatchEvent(f.event('click'));
  assert.equal(box(), null, 'a click on the backdrop closes it');
  f.q('#job-dialog .job-msg .job-shot-open').click();
  f.q('#job-dialog').close();
  assert.equal(box(), null, 'closing the step closes its shot');
});

test('a met prerequisite is history in Details; one still holding the step keeps its chip', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'done', state: 'done', deployed: { checks: [] } }, { ...sub('web', ['api']), stage: 'implementation', worktree: { path: '/wt/web' } }];
  f.view.update(f.data); f.q('[data-sub="web"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('#job-dialog .job-dependency-list'), null, 'nothing holds it, so no chip row');
  assert.equal(f.q('#job-dialog .job-details-body .job-deps-met').textContent, 'After: Deliver api');
  job.subJobs[0] = { ...sub('api'), stage: 'implementation' }; f.view.update(f.data);
  assert.equal(f.q('#job-dialog .job-dependency-list .job-chip').title, 'Start after Deliver api deploys');
  assert.equal(f.q('#job-dialog .job-deps-met'), null);
});

test('once the conversation shows what was sent, its ticked row is the receipt and the bubble goes', (t) => {
  const f = fixture(t); const job = parkedJob(f, {}, { thread: [] });
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const text = f.q('.job-change textarea'); text.value = 'Make it blue'; text.dispatchEvent(f.event('input')); f.q('[data-change-send]').click();
  f.view.created({ event: 'job-action-complete', jobId: 'job1', subJobId: 'api', action: 'request-change' });
  assert.equal(f.q('#job-dialog .job-sent').dataset.sentState, 'sent', 'the server took it, the thread does not have it yet');
  job.subJobs[0].thread = [{ id: 'm1', at: Date.now(), from: 'human', to: 'agent', text: 'Make it blue', round: 1, sentAt: null }]; f.view.update(f.data);
  assert.equal(f.q('#job-dialog .job-sent'), null, 'your words are not drawn twice');
  assert.equal(f.q('#job-dialog .job-msg-tick'), null, 'not delivered to the session yet');
  job.subJobs[0].thread[0].sentAt = Date.now(); f.view.update(f.data);
  assert.ok(f.q('#job-dialog .job-msg.human .job-msg-tick'), 'delivered: a tick by its time');
});

test('with the session gone the thread stays as the record, and an approved round says which', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.runs = [];
  job.subJobs = [proofSub({ state: 'approved', thread: [{ id: 'm1', at: 1, from: 'human', to: 'agent', text: 'Hi', round: 1 }] })];
  f.view.update(f.data); f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.match(f.q('#job-dialog .job-history summary').textContent, /1 message · session stopped/);
  job.subJobs = [proofSub({ thread: [] })]; f.view.update(f.data);
  assert.equal(f.q('#job-dialog .job-thread'), null, 'no session and nothing said: nothing to draw');
});

test('approval names its round and tree only in its title, and earlier rounds stay one click away', (t) => {
  const f = fixture(t);
  parkedJob(f, {}, { ready: { ...proofSub().ready, round: 2, treeHash: 'a71d0e4ffff', receiptId: 'run_1#2' }, earlier: [{ round: 1, checks: ['Lint clean'], proof: [{ text: 'Lists sign-ins', shots: [{ file: 'l.png' }] }] }] });
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  assert.equal(f.q('#job-dialog .job-pinned'), null);
  assert.match(f.q('[data-action="approve-code"]').title, /Approval is tied to round 2 and working tree a71d0e4\./);
  assert.equal(f.q('#job-dialog [data-change-ref]').dataset.changeRef, 'run_1#2');
  assert.match(f.q('#job-dialog .job-history summary').textContent, /Earlier rounds Round 1/);
  assert.equal(f.q('#job-dialog .job-earlier [data-ev-round="1"]').dataset.evFile, 'l.png');
  f.q('[data-action="approve-code"]').click();
  assert.equal(f.sent.at(-1).readyReceiptId, 'run_1#2');
});

test('a screenshot pasted into the Code review box is staged, held back from Send until it lands, and goes with the message', async (t) => {
  const f = fixture(t); parkedJob(f);
  let release; f.staging.stage = () => new Promise((r) => { release = () => r({ name: 'paste-1700000000000-bbbb2222.png' }); });
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const box = f.q('#job-dialog .job-change'), text = box.querySelector('textarea');
  text.value = 'Make this a dropdown'; text.dispatchEvent(f.event('input'));
  const e = f.event('paste'); e.clipboardData = { files: [new f.window.File(['x'], 'Screenshot.png', { type: 'image/png' })], items: [], types: ['Files'], getData: () => '' };
  text.dispatchEvent(e);
  assert.equal(e.defaultPrevented, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(box.querySelectorAll('.job-change-tray li').length, 1);
  assert.equal(box.querySelector('[data-change-send]').disabled, true, 'not while it is still travelling');
  release(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(box.querySelector('[data-change-send]').disabled, false);
  box.querySelector('[data-change-send]').click();
  const sent = f.sent.at(-1);
  assert.deepEqual([sent.action, sent.at, sent.ref, sent.text, sent.images], ['request-change', 'code', 'run_1', 'Make this a dropdown', ['paste-1700000000000-bbbb2222.png']]);
  assert.equal(f.q('#job-dialog .job-change-tray').hidden, true, 'the tray empties once sent');
});

test('every idea box takes pictures: one dropped on the job\'s box is staged and goes with the idea to the planner', async (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('web'), stage: 'implementation', state: 'queued' }];
  f.view.update(f.data); f.q('[data-board="job1"] .job-plate-open').click();
  const box = f.q('#job-dialog .job-change'), text = box.querySelector('textarea');
  assert.equal(box.dataset.changeAt, 'job'); assert.ok(box.querySelector('.job-change-tray'));
  text.value = 'Match this layout'; text.dispatchEvent(f.event('input'));
  const e = f.event('drop'); e.dataTransfer = { files: [new f.window.File(['x'], 'Mock.png', { type: 'image/png' })], items: [], types: ['Files'], getData: () => '' };
  box.dispatchEvent(e);
  assert.equal(e.defaultPrevented, true);
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  assert.equal(box.querySelectorAll('.job-change-tray li').length, 1);
  assert.ok(box.classList.contains('has-img'), 'a picture opens the box');
  box.querySelector('[data-change-send]').click();
  assert.deepEqual([f.sent.at(-1).at, f.sent.at(-1).text, f.sent.at(-1).images], ['job', 'Match this layout', ['paste-1700000000000-aaaa1111.png']]);
  assert.equal(f.q('#job-dialog .job-sent-imgs').querySelectorAll('img').length, 1, 'the picture rides up into the bubble');
});

test('the sent moment: the idea lifts into a bubble that says sending, ticks to sent when the server takes it, and a refusal puts the words back', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', state: 'watching', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [] } }];
  f.view.update(f.data); f.q('.job-plate-graph [data-sub="api"]').dispatchEvent(f.event('click'));
  const send = (words) => { const text = f.q('.job-change textarea'); text.value = words; text.dispatchEvent(f.event('input')); f.q('[data-change-send]').click(); };
  send('Pin the client to v3');
  const sent = () => f.q('#job-dialog .job-sent');
  assert.deepEqual([sent().dataset.sentState, sent().querySelector('.job-sent-bubble').textContent], ['sending', 'Pin the client to v3']);
  assert.match(sent().textContent, /Sending to planner…/);
  assert.equal(f.q('.job-change textarea').value, '', 'the box is empty again');
  assert.equal(f.q('[data-change-send]').disabled, true);
  assert.ok(sent().classList.contains('fresh'), 'it rises once');
  f.view.update(f.data);
  assert.equal(sent().classList.contains('fresh'), false, 'a live tick does not replay it');
  f.view.created({ event: 'job-action-complete', jobId: 'job1', subJobId: 'api', action: 'request-change' });
  assert.equal(f.q('#job-dialog').open, true, 'the dialog stays: the bubble is the confirmation');
  assert.equal(sent().dataset.sentState, 'sent');
  assert.match(sent().textContent, /Sent to planner · /);
  assert.doesNotMatch(sent().textContent, /The planner sends feedback back to this step/, 'the routing hint is the box\'s own footer, not repeated under the bubble');
  assert.ok(sent().querySelector('.job-sent-tick'));
  send('Also bump the lockfile');
  assert.equal(f.view.changeFailed({ event: 'job-action-failed', jobId: 'job1', subJobId: 'api', action: 'request-change', error: 'This changed since you looked' }), true);
  assert.equal(sent().dataset.sentState, 'failed');
  assert.match(sent().textContent, /Not sent: This changed since you looked/);
  assert.equal(f.q('.job-change textarea').value, 'Also bump the lockfile', 'nothing typed is lost');
  f.view.openDetail('job1', 'api');
  assert.equal(sent(), null, 'a fresh look starts clean');
});

// ---- Red steps (server/job-red.js): Fixing is Wrangler's, Declared red is yours ----
const fixtureWithRed = (t) => fixture(t);
const redRef = (job, s) => `${s.error || ''}|${s.pr?.head || ''}|${s.pr?.mergeCommit || ''}|${job.runs.filter((r) => r.subJobId === s.id).length}`;
function redJob(f, over = {}) {
  const [job] = f.data.jobs; job.stage = 'active'; job.plan = plan; job.revision = 3;
  job.subJobs = [{ ...sub('api'), stage: 'pr', state: 'watching', error: 'Automatic repair limit reached. Review changes, then retry if needed.', pr: { url: 'https://github.com/org/repo/pull/412', head: 'h1', checkStatus: 'failing', checks: [{ name: 'e2e', state: 'FAILURE' }] } },
    { ...sub('web', ['api']), stage: 'implementation', state: 'queued' }, { ...sub('docs'), stage: 'implementation', state: 'queued' }];
  Object.assign(job, over);
  return job;
}
const feedback = 'RED STEP: …';

test('Fixing is Wrangler\'s: not counted in Needs you, a spinner on the card, and only the red step and what follows it are held', (t) => {
  const f = fixtureWithRed(t);
  const job = redJob(f, { replan: { feedback, at: 1, proposal: null, previous: null, red: { sub: 'api', auto: false, n: 1 } } });
  f.view.update(f.data);
  assert.deepEqual([jobState(job), jobLabel(job), subState(job, job.subJobs[0]), subLabel(job, job.subJobs[0])], ['running', 'Fixing', 'running', 'Fixing']);
  assert.equal(jobNeedsReview(job, job.subJobs[0]), false, 'red, but handled: not yours');
  assert.deepEqual(job.subJobs.map((s) => heldByReplan(job, s)), [false, true, false], 'web waits on api; docs carries on');
  assert.deepEqual([...redScope(job, 'api')], ['api', 'web']);
  f.q('.job-plate-open[data-job="job1"]').click();
  assert.match(f.q('#job-dialog').textContent, /Fixing/);
  f.view.openDetail('job1', 'api');
  const dialog = f.q('#job-dialog');
  assert.ok(dialog.querySelector('.job-event-fix.fixing .job-spin'), 'the failure stays; under it Wrangler\'s turn');
  assert.match(dialog.querySelector('.job-event').textContent, /Checks failing on #412/);
  assert.ok(dialog.querySelector('#job-retry') && !dialog.querySelector('#job-retry').classList.contains('primary'), 'Retry stays, quietly');
  assert.equal(dialog.querySelector('.job-change'), null, 'the planner has it: the box is back once it does');
  f.view.openDetail('job1', 'web');
  assert.match(f.q('#job-dialog .job-chip-state').textContent, /Held for the fix/);
  assert.match(f.q('#job-dialog .job-chip-state').title, /Held while Wrangler fixes a red step this one waits on/);
});

test('a fix waiting on you is Fix ready (Needs you); approving opens the proposal on the job', (t) => {
  const f = fixtureWithRed(t);
  const job = redJob(f, { replan: { feedback, at: 1, red: { sub: 'api', auto: false, n: 1 }, proposal: { id: 'run_p', label: null, diagnosis: { summary: 'The e2e times out on the SSO stub' }, plan: { ...plan }, merged: { ...plan }, changes: { frozen: [], kept: ['api'], edited: [], added: [], removed: [] }, actions: [{ type: 'rework', sub: 'api', note: 'Wait for the stub', pin: { at: 'head', ref: 'h1' } }], alternatives: [] } } });
  f.view.update(f.data);
  assert.deepEqual([subState(job, job.subJobs[0]), subLabel(job, job.subJobs[0]), jobNeedsReview(job, job.subJobs[0])], ['needs', 'Fix ready', true]);
  assert.equal(jobCards([job]).filter((c) => !c.sub).length, 0, 'the red step is the card: not counted twice');
  assert.match(plateAsk(job).label, /Fix ready/); assert.deepEqual([plateAsk(job).button, plateAsk(job).sub], ['Review fix', '']);
  f.view.openDetail('job1', 'api');
  const dialog = f.q('#job-dialog');
  assert.match(dialog.querySelector('.job-event-fix.ready').textContent, /The e2e times out on the SSO stub.*Waiting because Red steps is “You decide”/);
  const review = dialog.querySelector('[data-open-job].primary'); assert.equal(review.textContent, 'Review fix');
  review.click();
  assert.match(f.q('#job-dialog').textContent, /Red step.*Deliver api.*repair limit/s, 'the proposal says which step, not what a person typed');
  assert.ok(f.q('#job-dialog [data-action="approve-replan"]'));
});

test('a declared red is the only red you act on: counted in Needs you, with what was tried and the decision, and Decide opens the options', (t) => {
  const f = fixtureWithRed(t);
  const job = redJob(f); const api = job.subJobs[0];
  api.red = { attempts: [], declared: { at: 1, ref: redRef(job, api), summary: 'login-flow.spec is flaky on main and needs QA sign-off', tried: ['Replan 1: reran e2e twice', 'Replan 2: added a wait'], ask: 'Merge #412 with the red check, or hold it?', auto: false } };
  f.view.update(f.data);
  assert.deepEqual([subState(job, api), subLabel(job, api), subLine(job, api), jobNeedsReview(job, api), jobState(job)], ['failing', 'Declared red', '#412 · Declared red', true, 'failing']);
  assert.deepEqual([plateAsk(job).label, plateAsk(job).button, plateAsk(job).sub], ['Declared red', 'Decide', 'api']);
  assert.equal(changeRoute('pr', job, api).placeholder, 'Add an idea for the planner…');
  f.view.openDetail('job1', 'api');
  const dialog = f.q('#job-dialog');
  const box = dialog.querySelector('.job-event-fix.declared');
  assert.match(box.textContent, /Declared red.*QA sign-off/); assert.deepEqual([...box.querySelectorAll('li')].map((l) => l.textContent), ['Replan 1: reran e2e twice', 'Replan 2: added a wait']);
  assert.match(box.querySelector('.ask').textContent, /Needs you: Merge #412 with the red check, or hold it\?/);
  assert.ok(dialog.querySelector('.job-change'), 'your own words go to the planner with all of it');
  // With options waiting, Decide opens them on the job.
  job.replan = { feedback: 'Declared red', at: 1, red: { sub: 'api', auto: false }, proposal: { id: 'run_e', label: 'Accept red and merge', plan, merged: plan, changes: { frozen: [], kept: ['api'], edited: [], added: [], removed: [] }, actions: [{ type: 'accept-red', sub: 'api', pin: { at: 'head', ref: 'h1' } }],
    alternatives: [], escalation: { sub: 'api', summary: 'x', tried: [], ask: 'Merge #412 with the red check, or hold it?' } } };
  f.view.update(f.data); f.view.openDetail('job1', 'api');
  assert.equal(f.q('#job-dialog [data-open-job].primary').textContent, 'Decide');
  assert.equal(plateAsk(job).sub, '');
  f.q('#job-dialog [data-open-job].primary').click();
  assert.match(f.q('#job-dialog').textContent, /Declared red.*Deliver api.*Needs you.*Merge #412/s);
});

test('a step its own agent escalated shows one block: the declaration in full, footed "Declared by its agent"', (t) => {
  const f = fixtureWithRed(t);
  const job = redJob(f); const api = job.subJobs[0];
  const summary = `Cannot reproduce the log noise on main. ${'Ran isolated servers for six minutes with codex off PATH. '.repeat(5)}A fix without the real line would be a guess.`;
  api.error = summary.slice(0, 240); api.blocked = { summary: api.error, phase: 'implementation', kind: 'escalate', at: 1 };
  api.red = { declared: { at: 1, ref: redRef(job, api), summary, tried: ['Ran it with codex off PATH'], ask: 'Paste the repeating log line?', auto: false, by: 'agent' } };
  f.view.update(f.data);
  assert.deepEqual([eventFor(job, api).title, eventFor(job, api).detail], ['Worker blocked', ''], 'the card still says what happened');
  f.view.openDetail('job1', 'api');
  const event = f.q('#job-dialog .job-event');
  assert.equal(event.querySelectorAll('.job-event-fix').length, 1); assert.equal(event.querySelector('p'), null, 'the cut-off copy is gone');
  assert.ok(event.textContent.includes(summary));
  assert.deepEqual([...event.querySelectorAll('li')].map((l) => l.textContent), ['Ran it with codex off PATH']);
  assert.match(event.querySelector('.ask').textContent, /Needs you: Paste the repeating log line\?/);
  assert.equal(event.querySelector('small').textContent, 'Declared by its agent');
});

test('a red the planner declared after a real failure still shows both, and a declaration saved before "by" reads as it did', (t) => {
  const f = fixtureWithRed(t);
  const job = redJob(f); const api = job.subJobs[0];
  api.red = { declared: { at: 1, ref: redRef(job, api), summary: 'e2e is flaky on main and needs QA sign-off', tried: [], ask: 'Merge or hold?', auto: false, by: 'planner' } };
  f.view.update(f.data); f.view.openDetail('job1', 'api');
  let event = f.q('#job-dialog .job-event');
  assert.match(event.querySelector('p').textContent, /Automatic repair limit reached/);
  assert.ok(event.querySelector('.job-event-fix.declared:not(.alone)'));
  assert.equal(event.querySelector('small').textContent, 'Declared by the planner');
  for (const [auto, footer] of [[false, 'Declared by the planner'], [true, 'Declared automatically']]) {
    api.red = { declared: { at: 1, ref: redRef(job, api), summary: 'Still red', tried: [], ask: '', auto } };
    f.view.update(f.data); f.view.openDetail('job1', 'api');
    event = f.q('#job-dialog .job-event');
    assert.equal(event.querySelector('small').textContent, footer); assert.ok(event.querySelector('p'));
  }
});

test('Red steps is the sixth checkpoint (You decide / Wrangler replans) and Replans per step is a setting', (t) => {
  const f = fixtureWithRed(t);
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form');
  const row = form.querySelector('[data-checkpoint="reviewRed"]');
  assert.equal(row.querySelector('.job-review-name').firstChild.textContent, 'Red steps');
  assert.deepEqual([form.elements.reviewRed.checked, form.elements.reviewRed.getAttribute('aria-label')], [true, 'Red steps: You decide']);
  form.elements.reviewRed.checked = false; row.dispatchEvent(f.event('change'));
  assert.equal(form.elements.reviewRed.getAttribute('aria-label'), 'Red steps: Wrangler replans');
  assert.match(row.querySelector('.job-review-name').title, /^Wrangler replans a red step: it fixes the step, changes the plan \(if Plan is on Auto\), or declares it red for you/);
  assert.equal(form.elements.maxReplans.value, '2'); form.elements.maxReplans.value = '3';
  form.dispatchEvent(f.event('submit'));
  const patch = f.sent.at(-1).patch;
  assert.deepEqual([patch.maxReplans, patch.reviewDefaults.reviewRed], [3, false]);
  const job = redJob(f); f.view.update(f.data);
  f.q('.job-plate-open[data-job="job1"]').click();
  const tile = f.q('.job-detail-footer [data-review="reviewRed"]');
  assert.equal(tile.getAttribute('aria-label'), 'Red steps: You decide. Switch to Wrangler replans');
  job.reviewRed = false; f.view.update(f.data);
  assert.equal(f.q('.job-detail-footer [data-review="reviewRed"]').getAttribute('aria-label'), 'Red steps: Wrangler replans. Switch to You decide');
  f.q('.job-detail-footer [data-review="reviewRed"]').click();
  assert.deepEqual([f.sent.at(-1).action, f.sent.at(-1).field, f.sent.at(-1).you, f.sent.at(-1).release], ['set-review', 'reviewRed', true, undefined], 'nothing waits at this checkpoint, so it never asks first');
});

test('a refused cleanup on a dropped sub-job shows what would be lost, and Discard echoes back exactly the list it showed', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.cancelledAt = 1;
  const refusal = { path: '/wt/api', branch: 'job-api', base: 'main', head: 'cc47137aaaa', fingerprint: 'fp1',
    commits: [{ sha: 'abc12345ffff', subject: '<b>Local</b> work', pushed: false }], commitCount: 1,
    files: [{ change: 'untracked', path: 'server/mcp/tools/list-models.js' }], fileCount: 3 };
  job.subJobs = [{ ...sub('api'), stage: 'cleanup', state: 'cancelled', cancelledAt: 1, worktree: { path: '/wt/api', branch: 'job-api' },
    error: 'Worktree has work that would be lost (1 commit not on origin/main, 3 uncommitted files); preserve it for review', cleanupRefusal: refusal }];
  f.view.update(f.data);
  assert.equal(eventFor(job, job.subJobs[0]).title, 'Worktree kept');
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true);
  f.view.openDetail('job1', 'api');
  const text = () => f.q('#job-dialog').textContent;
  assert.match(text(), /1 commit not on origin\/main/); assert.match(text(), /<b>Local<\/b> work/, 'agent-written subjects are text, not markup');
  assert.match(text(), /list-models\.js/); assert.match(text(), /and 2 more/);
  f.q('#job-discard').click();
  assert.equal(f.sent.length, 0, 'discarding needs a confirmation first');
  assert.ok(f.q('#job-discard-form'), 'a form, so a live graph tick leaves the question alone');
  assert.equal(primaryAction(f.q('#job-dialog')), null, 'Cmd+Enter cannot discard work');
  assert.match(text(), /lost for good/); assert.match(text(), /list-models\.js/);
  f.q('[data-discard]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'discard-worktree', discardHead: 'cc47137aaaa', fingerprint: 'fp1' });
  job.subJobs[0] = { ...job.subJobs[0], error: null, discard: { head: 'cc47137aaaa', fingerprint: 'fp1' } }; f.view.update(f.data);
  f.view.openDetail('job1', 'api');
  assert.equal(f.q('#job-discard'), null, 'a discard already chosen is not offered twice');
});

test('every PR tile shows its worktree branch → where it lands, the override marked and long names truncated', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active'; job.base = 'next';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', base: 'release/2.x', worktree: { path: '/wt/api', branch: 'fix/api-2x', repoRoot: '/repo' } },
    { ...sub('web', ['api']), stage: 'implementation' }, { ...sub('same', ['api']), stage: 'implementation', base: 'next' }];
  f.view.update(f.data); f.q('.job-plate-open[data-job=\"job1\"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-node-landing')].map((e) => [e.closest('[data-node]').dataset.node, e.textContent]), [['api', 'fix/api-2x→release/2.x'], ['web', '→next'], ['same', '→next']], 'every PR names where it lands');
  assert.deepEqual([...document.querySelectorAll('.job-node-base.own')].map((e) => e.closest('[data-node]').dataset.node), ['api'], 'only the override is marked');
  const long = 'feature/' + 'a'.repeat(80); job.subJobs[2].worktree = { path: '/wt/s', branch: long }; f.view.update(f.data);
  assert.equal(f.q('[data-node="same"] .job-node-wt').textContent, long, 'the whole name is in the markup, CSS truncates it');
  assert.match(f.q('[data-node="same"] .job-node-landing').title, new RegExp(`Branch ${long}\\nLands on next`), 'and whole in the tooltip');
  assert.match(f.q('[data-open-sub="api"]').title, /Lands on release\/2\.x, not the job's next/);
  assert.match(f.q('[data-open-sub="web"]').title, /Lands on next/);
  assert.match(f.q('#job-dialog .job-chips').textContent, /→ next/, 'the job\'s own base heads the job');
  f.q('[data-open-sub="api"]').click();
  assert.equal(f.q('.job-detail-line .job-plan-branch').textContent, 'fix/api-2x → release/2.x', 'worktree branch and target are one part of the meta line');
  assert.equal(f.q('.job-detail-meta .job-plan-branch'), null, 'and not a chip: it is not something to click');
  f.q('#job-dialog').close(); f.q('.job-plate-open[data-job=\"job1\"]').click(); f.q('[data-open-sub="web"]').click();
  assert.match(f.q('.job-detail-line').textContent, /→ next/, 'no worktree yet: just where it lands');
});

test('plan review sets a PR\'s own base from its branch pill, and blank lands where the job does', (t) => {
  const f = fixture(t); f.q('.job-plate-open[data-job=\"job1\"]').click();
  const pills = document.querySelectorAll('details[data-base-of]');
  assert.equal(pills.length, f.data.jobs[0].plan.subJobs.filter((s) => (s.kind || 'pr') === 'pr').length, 'one per PR');
  assert.equal(f.q('.job-node-base.own'), null);
  assert.equal(f.q('details[data-base-of] summary').textContent, 'default branch', 'blank shows where it would land');
  const input = f.q('[data-base="0"]'); assert.equal(input.placeholder, 'Default branch');
  input.value = ' release/2.x '; input.dispatchEvent(f.event('change'));
  assert.equal(f.q('.job-node-base.own').textContent, 'release/2.x');
  assert.equal(f.q('details[data-base-of] summary').textContent, 'release/2.x');
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent.at(-1).plan.subJobs[0].base, 'release/2.x');
  const again = f.q('[data-base="0"]'); again.value = ''; again.dispatchEvent(f.event('change'));
  assert.equal(f.q('.job-node-base.own'), null);
  f.q('[data-action="approve-plan"]').click();
  assert.equal('base' in f.sent.at(-1).plan.subJobs[0], false, 'cleared, it is gone rather than empty');
});

test('what the agent left running is a chip among the step\'s own, its popover stays open across a tick, and Logs and Stop all act', (t) => {
  const f = fixture(t);
  const job = parkedJob(f, {}, { running: { items: [{ name: 'web', url: 'http://localhost:5174', pid: 4821, log: '/wt/web.log', up: true }, { name: 'api', url: 'http://localhost:8788', up: true }] } });
  f.q('[data-sub="api"]').dispatchEvent(f.event('click'));
  const chip = f.q('#job-dialog .job-detail-meta .job-run-chip');
  assert.equal(chip.textContent.trim(), '2 running');
  assert.equal(f.q('#job-dialog .job-running'), null, 'no Running for you bar in the body');
  const pop = f.q('#job-dialog .job-run-pop');
  pop.open = true; pop.dispatchEvent(f.event('toggle'));
  f.view.update(f.data);
  assert.equal(f.q('#job-dialog .job-run-pop').open, true);
  assert.deepEqual([...f.q('#job-dialog').querySelectorAll('.job-run-panel li a')].map((a) => a.textContent), ['localhost:5174 ↗', 'localhost:8788 ↗']);
  f.q('[data-running-logs="web"]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-running-logs', id: 'job1', subJobId: 'api', name: 'web' });
  f.view.runningLog({ subJobId: 'api', name: 'web', text: 'ready in 300ms' });
  assert.match(f.q('#job-dialog .job-run-panel .job-run-logs pre').textContent, /ready in 300ms/);
  f.q('[data-running-stop]').click();
  assert.equal(f.sent.at(-1).action, 'stop-running');
  job.subJobs[0].running.items[0].up = false; f.view.update(f.data);
  assert.equal(f.q('#job-dialog .job-run-chip').textContent.trim(), '1 of 2 running');
});

test('a forward reads as the quote the session will be told, pinned to its round, and lands in the thread tagged as come through the planner', () => {
  const plan = { subJobs: [{ id: 'api', title: 'Design export button' }] };
  const a = { type: 'forward', sub: 'api', note: 'Not enough spacing before the button.', pin: { at: 'round', ref: 'run_1#2', round: 2 } };
  assert.deepEqual(actionLine(a, plan), { text: 'Forward: Design export button', detail: '“Not enough spacing before the button.”' });
  assert.equal(pinLine(a.pin), 'to its open session · pinned to round 2');
  const job = { id: 'job1', runs: [{ id: 'run_1', subJobId: 'api', stopped: false, parkedFor: 'ready', sessionId: 's1' }] };
  const sub = { id: 'api', ready: { round: 2 }, answering: { kind: 'change', round: 2 }, thread: [{ id: 'm1', at: 1, from: 'human', via: 'planner', to: 'agent', text: 'Not enough <b>spacing</b>', round: 2, sentAt: null }] };
  const html = threadHtml(job, sub);
  assert.match(html, /<span class="job-msg-via">via the planner<\/span>/);
  assert.match(html, /Not enough &lt;b&gt;spacing&lt;\/b&gt;/, 'the words are escaped');
  assert.doesNotMatch(threadHtml(job, { ...sub, thread: [{ ...sub.thread[0], via: undefined }] }), /job-msg-via/);
});

test('a tick that changes nothing leaves the board and detail DOM alone, and a selection holds a changed one until cleared', (t) => {
  const f = fixture(t);
  const plate = f.q('[data-board="job1"]');
  f.view.update(structuredClone(f.data));
  assert.equal(f.q('[data-board="job1"]'), plate, 'same markup, same nodes');
  f.data.jobs[0] = { ...f.data.jobs[0], stage: 'running', plan: null, subJobs: [{ ...sub('api'), stage: 'implementing' }] };
  f.view.update(structuredClone(f.data));
  f.q('[data-board="job1"] .job-plate-open').click();
  const heading = f.q('#job-dialog h2');
  assert.ok(heading, 'the detail is open');
  f.view.update(structuredClone(f.data));
  assert.equal(f.q('#job-dialog h2'), heading, 'an unchanged detail is not redrawn');
  const range = document.createRange(); range.selectNodeContents(heading);
  document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
  f.data.jobs[0] = { ...f.data.jobs[0], title: 'Sign-in, renamed' };
  f.view.update(structuredClone(f.data));
  assert.equal(f.q('#job-dialog h2'), heading, 'held while text is selected');
  assert.equal(document.getSelection().toString().length > 0, true);
  document.getSelection().removeAllRanges();
  document.dispatchEvent(f.event('selectionchange'));
  assert.notEqual(f.q('#job-dialog h2'), heading, 'redrawn once the selection is gone');
  assert.match(f.q('[data-board="job1"]').textContent, /renamed/, 'the board caught up too');
});
