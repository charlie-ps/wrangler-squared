import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { initJobsView, isPrimaryActionKey, primaryAction } from './jobs-view.js';
import { jobCards, jobStatus, jobNeedsReview, dependencyLevels, mergeHeldByComments, movesFor, eventFor } from './jobs.js';
import { jobTileHtml } from './job-graph.js';

const sub = (id, after = []) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', jiraKey: 'AUTH-1', after, brief: 'Implement it and open the PR', sessions: [], repairs: [] });
const plan = { context: 'Keys live in the vault; every service reads them at boot.', stories: [{ id: 'story', key: 'AUTH-1', title: 'Customers can sign in' }], subJobs: [sub('api'), sub('web', ['api'])] };
const hint = (f) => f.q('#job-dialog .job-chip-state').title;
const deploys = (summary = 'Deploys on merge · Deploy') => ({ head: 'head1', base: 'main', expected: true, workflows: [{ name: 'Deploy', file: 'deploy.yml', triggers: true, reason: 'runs on push' }], summary });
function fixture(t) {
  const window = new Window({ url: 'http://localhost:7878' });
  const prevDoc = globalThis.document, prevFormData = globalThis.FormData;
  globalThis.document = window.document; globalThis.FormData = window.FormData;
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  const sent = [], sessions = [], diffs = [], diffContexts = [], onBoard = new Set();
  const view = initJobsView({ send: (m) => sent.push(structuredClone(m)), getAgents: () => [{ id: 'claude', label: 'Claude', models: [{ value: 'sonnet', label: 'Sonnet', default: true }], efforts: [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }] }, { id: 'codex', label: 'Codex', models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', default: true }], efforts: [{ value: 'high', label: 'High' }] }], onSession: (s) => sessions.push(s), onDiff: (s, ctx) => { diffs.push(s); diffContexts.push(ctx); }, onBoard: (s) => onBoard.has(s) });
  t.after(async () => { globalThis.document = prevDoc; globalThis.FormData = prevFormData; await window.happyDOM.close(); });
  const job = { id: 'job1', title: 'Sign-in', intent: 'Reliable sign-in', repos: ['/repo'], stage: 'planning', plan, subJobs: [], runs: [], moves: [], revision: 2, reviewMerge: true };
  const data = { jobs: [structuredClone(job)], settings: { concurrency: 2, maxRepairs: 2 } };
  const q = (s) => document.querySelector(s);
  const event = (name) => new window.Event(name, { bubbles: true, cancelable: true });
  view.update(data);
  return { window, view, data, sent, q, event, sessions, diffs, diffContexts, onBoard };
}

test('every job is one tonal card in its state, and only jobs with attention items survive Needs me', (t) => {
  const f = fixture(t);
  f.data.jobs.push({ ...f.data.jobs[0], id: 'backlog', stage: 'backlog', plan: null }); f.view.update(f.data);
  assert.deepEqual([...document.querySelectorAll('.job-card')].map((b) => b.dataset.board), ['job1', 'backlog']);
  assert.ok(f.q('[data-board="job1"]').classList.contains('tone-warn'), 'a plan to review is amber');
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Plan ready');
  assert.equal(f.q('[data-board="backlog"] .job-status').textContent, 'Backlog');
  assert.equal(document.querySelectorAll('[data-board="job1"] .job-seg').length, 2, 'one segment per planned sub-job');
  f.q('#jobs-needs').checked = true; f.q('#jobs-needs').dispatchEvent(f.event('change'));
  assert.deepEqual([...document.querySelectorAll('.job-card')].map((b) => b.dataset.board), ['job1']);
});

test('the board leads with what is failing, colours each segment by its sub-job, and a segment opens that sub-job', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'done' }, { ...sub('web', ['api']), stage: 'implementation' }];
  job.runs = [{ id: 'r1', subJobId: 'web', phase: 'implementation', stopped: false, status: 'working' }];
  f.data.jobs.push({ ...structuredClone(job), id: 'job2', title: 'Broken', runs: [], subJobs: [{ ...sub('x'), stage: 'implementation', error: 'boom' }] });
  f.view.update(f.data);
  assert.deepEqual([...document.querySelectorAll('.job-card')].map((b) => b.dataset.board), ['job2', 'job1'], 'failing sorts first');
  assert.ok(f.q('[data-board="job2"]').classList.contains('tone-bad'));
  assert.deepEqual([...document.querySelectorAll('[data-board="job1"] .job-seg')].map((e) => [e.dataset.sub, [...e.classList].find((c) => c.startsWith('tone-'))]), [['api', 'tone-ok'], ['web', 'tone-run']]);
  assert.match(f.q('.job-seg[data-sub="web"]').title, /Deliver web · Working/);
  f.q('.job-seg[data-sub="web"]').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver web');
  f.q('[data-open-job]').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Sign-in', 'the sub-job leads back to its job');
});

test('code review is a stop before anything is committed: the card asks for a read, approval is pinned to the receipt, and Request changes sends it back', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'review', state: 'verified', worktree: { path: '/wt', branch: 'fix/AUTH-1' }, sessions: ['s1'], ready: { checks: ['Tests pass', 'Lint clean'], receiptId: 'run_1' } }];
  f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'needs', text: 'Ready to review' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true);
  assert.deepEqual(jobCards([job])[0].stage, 'review');
  f.q('[data-sub="api"]').click();
  assert.match(f.q('#job-dialog').textContent, /Ready for review/); assert.match(hint(f), /Nothing is committed yet/);
  assert.deepEqual([...f.q('#job-dialog').querySelectorAll('.job-receipt li')].map((li) => li.textContent.trim()), ['✓ Tests pass', '✓ Lint clean']);
  assert.ok(f.q('#job-diff'), 'the diff is the review surface');
  assert.equal(f.q('#job-ide').textContent, 'Review code in IntelliJ IDEA', 'the desktop IDE is the other review surface, named after the setting');
  f.q('#job-ide').click(); assert.deepEqual(f.sent.at(-1), { type: 'job-open-ide', id: 'job1', subJobId: 'api' }); assert.equal(f.q('#job-dialog').open, true, 'the dialog stays: approval happens here');
  f.data.settings.ideApp = 'Rider'; f.view.update(f.data); assert.equal(f.q('#job-ide').textContent, 'Review code in Rider');
  delete f.data.settings.ideApp; f.view.update(f.data);
  assert.deepEqual(movesFor(job, job.subJobs[0]).map((m) => [m.id, m.label]).filter(([id]) => id === 'fix-here'), [['fix-here', 'Request changes']]);
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
  const boards = () => [...document.querySelectorAll('.job-card')].map((x) => x.dataset.board);
  assert.deepEqual(boards(), ['job1', 'job2'], 'the delivered job is hidden by default');
  assert.deepEqual([...document.querySelectorAll('.job-card')].map((x) => [...x.querySelectorAll('.job-seg')].map((c) => c.dataset.sub)), [['api'], ['cart']]);
  assert.match(f.q('[data-board="job2"]').textContent, /Checkout/);
  f.q('#jobs-done').checked = true; f.q('#jobs-done').dispatchEvent(f.event('change'));
  assert.deepEqual(boards(), ['job1', 'job2', 'job3']);
  assert.ok(f.q('[data-board="job3"]').classList.contains('tone-ok'));
  f.q('#jobs-filter').value = 'job2'; f.q('#jobs-filter').dispatchEvent(f.event('change'));
  assert.deepEqual(boards(), ['job2']);
  f.q('.job-card-open').click(); assert.equal(f.q('#job-dialog h2').textContent, 'Checkout');
  f.q('[data-sub="cart"]').click();
  assert.equal(f.q('#job-dialog .job-detail-meta').textContent.includes('SHOP-7'), true, 'the ticket rides in the chips');
  f.q('#job-dialog').close(); f.q('.job-card-open').click();
  f.q('#job-dialog [data-action="pause"]').click(); assert.deepEqual([f.sent.at(-1).id, f.sent.at(-1).action, f.sent.at(-1).subJobId], ['job2', 'pause', undefined]);
  b.paused = true; f.view.update(f.data);
  assert.equal(f.q('#job-dialog [data-action="resume"]').textContent, 'Resume'); f.q('#job-dialog [data-action="resume"]').click(); assert.equal(f.sent.at(-1).action, 'resume');
  assert.ok(f.q('[data-board="job2"]').classList.contains('tone-pause'), 'a paused job is purple');
});

test('a sub-job carries what the merge will do and the note left for the next session, and goes red when something happened', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', deploys: deploys(), note: 'Rebase on <main> first', pr: { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'pending', checks: [] } }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.equal(f.q('.job-deploys').title, 'Deploys on merge · Deploy');
  assert.equal(f.q('.job-note').textContent, 'Rebase on <main> first');
  assert.ok(!f.q('#job-dialog').innerHTML.includes('<main>'), 'a note is human text on an agent surface: escaped');
  f.q('#job-dialog').close();
  assert.equal(f.q('.job-seg[data-sub="api"]').classList.contains('tone-bad'), false, 'nothing has gone wrong yet');
  job.subJobs[0].error = 'PR was closed without merging'; f.view.update(f.data);
  assert.equal(f.q('.job-seg[data-sub="api"]').classList.contains('tone-bad'), true);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'PR was closed');
  assert.deepEqual(eventFor(job, job.subJobs[0]), { title: 'PR was closed', detail: 'PR was closed without merging', suggested: null });
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
  f.q('.job-card-open').click(); assert.equal(f.q('#job-dialog [data-fab-session]'), null, 'no session to answer yet');
  job.subJobs[0].sessions = ['s9']; f.view.update(f.data);
  f.q('#job-dialog [data-fab-session]').click(); assert.deepEqual(f.sessions, ['s9'], 'the job’s one button opens the prompt');
});

test('the event box names what happened and the move the agent suggested, and that move is the hot one', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', error: 'The <proto> files are out of sync with the API',
    blocked: { summary: 'The <proto> files are out of sync with the API', move: 'split-out', phase: 'implementation', at: 1 } }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  const dialog = f.q('#job-dialog');
  assert.equal(dialog.querySelector('.job-event b').textContent, 'Worker blocked');
  assert.equal(dialog.querySelector('.job-event p').textContent, 'The <proto> files are out of sync with the API');
  assert.ok(!dialog.innerHTML.includes('<proto>'), 'the agent’s sentence is escaped');
  assert.equal(dialog.querySelector('.job-event-move').textContent, 'Suggests Split out');
  assert.deepEqual([...dialog.querySelectorAll('.job-move')].map((b) => b.dataset.move), ['fix-here', 'split-out', 'new-ticket', 'reorder', 'drop', 'mark']);
  assert.deepEqual([...dialog.querySelectorAll('.job-move.hot')].map((b) => b.dataset.move), ['split-out'], 'suggested, not chosen');
  // Fix here on a sub-job with no PR promises a rerun, not a commit that cannot exist.
  assert.equal(dialog.querySelector('[data-move="fix-here"] b').textContent, 'Retry with a note');
  assert.ok(dialog.querySelector('#job-retry'), 'the plain retry is still there for a transient failure');
});

test('a finished, dropped or cleaning-up sub-job offers no moves at all', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  assert.deepEqual(movesFor(job, { ...sub('api'), stage: 'done' }), []);
  assert.deepEqual(movesFor(job, { ...sub('api'), stage: 'cleanup' }), []);
  assert.deepEqual(movesFor(job, { ...sub('api'), stage: 'pr', cancelledAt: 1 }), []);
  // Merged: the fix is a new PR, not a new commit here, and the order is settled.
  assert.deepEqual(movesFor(job, { ...sub('api'), stage: 'deployment' }).map((m) => m.id), ['split-out', 'new-ticket', 'drop', 'mark']);
  // Neither agentless kind has a repository, so neither offers a move that adds a PR.
  assert.deepEqual(movesFor(job, { ...sub('api'), kind: 'session', stage: 'session' }).map((m) => m.id), ['fix-here', 'reorder', 'drop', 'mark']);
  assert.deepEqual(movesFor(job, { ...sub('api'), kind: 'human', stage: 'human' }).map((m) => m.id), ['reorder', 'drop'], 'the HUMAN result form owns Mark done');
});

test('Accept red appears only beside a red pipeline, says which side of the merge it acts on, and sends just the note', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const redPr = { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [{ name: 'e2e', state: 'FAILURE' }, { name: 'lint', state: 'SUCCESS' }] };
  assert.equal(movesFor(job, { ...sub('api'), stage: 'pr', pr: { ...redPr, checkStatus: 'pending' } }).find((m) => m.id === 'accept-red'), undefined);
  assert.equal(movesFor(job, { ...sub('api'), stage: 'pr', pr: { ...redPr, dirty: true } }).find((m) => m.id === 'accept-red'), undefined, 'a conflict cannot be waved through');
  assert.equal(movesFor(job, { ...sub('api'), stage: 'pr', pr: redPr, acceptedRed: { ref: 'h1' } }).find((m) => m.id === 'accept-red'), undefined, 'already accepted at this head');
  assert.equal(movesFor(job, { ...sub('api'), stage: 'pr', pr: redPr }).find((m) => m.id === 'accept-red').blurb, 'Merge this PR as it stands, red checks and all.');
  const landing = { ...sub('api'), stage: 'deployment', pr: { ...redPr, checkStatus: 'passing', mergeCommit: 'abc' }, deploymentResult: { status: 'failing', runs: [{ workflow: 'Deploy', status: 'failing', url: 'https://github.com/org/repo/actions/runs/1' }], commit: 'abc' } };
  assert.deepEqual(movesFor(job, landing).map((m) => m.id), ['split-out', 'new-ticket', 'drop', 'mark', 'accept-red']);
  assert.equal(movesFor(job, landing).at(-1).blurb, 'Count the merge as landed despite the failing post-merge run.');
  assert.equal(movesFor(job, { ...landing, recoveredBy: 'api-2' }).find((m) => m.id === 'accept-red'), undefined, 'awaiting its fix, not a pipeline');
  assert.deepEqual(jobStatus(job, { ...landing, acceptedRed: { ref: 'abc' }, error: null }), { tone: 'working', text: 'Red run accepted · landing' });
  assert.deepEqual(jobStatus(job, { ...sub('api'), stage: 'pr', pr: redPr, acceptedRed: { ref: 'h1' } }), { tone: 'working', text: 'Merging with red checks' });

  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: redPr, error: 'Automatic repair limit reached. Review changes, then retry if needed.' }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'accept-red');
  assert.deepEqual([...form.querySelectorAll('.job-checks li')].map((li) => li.textContent.trim()), ['× e2e'], 'only the red checks are listed');
  assert.match(form.textContent, /Merges head h1 with the checks as they are/);
  assert.equal(form.querySelector('button.primary').textContent, 'Merge anyway');
  form.elements.note.value = ' e2e is flaky ';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'accept-red', note: 'e2e is flaky' });
  job.subJobs = [{ ...landing, check: 'helm shows it', error: 'Post-merge run failed: Deploy' }];
  f.view.update(f.data);
  const landingForm = openMove(f, 'api', 'accept-red');
  assert.match(landingForm.textContent, /Counts merge commit abc as landed, then runs the plan’s check/);
  assert.equal(landingForm.querySelector('button.primary').textContent, 'Count it as landed');
  landingForm.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'accept-red' });
});

const openMove = (f, subId, move) => { f.q(`[data-sub="${subId}"]`).click(); f.q(`.job-move[data-move="${move}"]`).click(); return f.q('#job-move-form'); };

test('Fix here hands the next session a note and nothing else', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [] } }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'fix-here');
  form.elements.note.value = '  Pin the client to v3  ';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'fix-here', note: 'Pin the client to v3' });
});

test('Split out asks for a whole PR and where it lands; a merged sub-job is not asked where', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [] } },
    { ...sub('merged'), stage: 'deployment', pr: { url: 'https://github.com/org/repo/pull/2', mergeCommit: 'abc', checkStatus: 'passing', checks: [] } }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'split-out');
  form.elements.title.value = 'Sync the proto files';
  form.elements.brief.value = 'Regenerate the protos and land them on their own';
  form.elements.check.value = 'proto lint passes';
  form.querySelector('[name="position"][value="before"]').checked = true;
  form.elements.note.value = 'Land this first';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'split-out', title: 'Sync the proto files', brief: 'Regenerate the protos and land them on their own', position: 'before', check: 'proto lint passes', note: 'Land this first' });
  f.q('#job-move-back').click(); f.q('#job-dialog').close();
  const merged = openMove(f, 'merged', 'split-out');
  assert.equal(merged.querySelector('[name="position"]'), null, 'merged: the new PR simply lands next');
  assert.match(f.q('#job-dialog').textContent, /everything already waiting on this one waits for it instead/);
  merged.elements.title.value = 'Guard empty payloads'; merged.elements.brief.value = 'Reject an empty body with a 400';
  merged.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'merged', action: 'split-out', title: 'Guard empty payloads', brief: 'Reject an empty body with a 400', position: 'after' });
});

test('New ticket carries the story as well as the PR, and leaves out what was not filled in', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }]; f.view.update(f.data);
  const form = openMove(f, 'api', 'new-ticket');
  form.elements.storyTitle.value = 'Sign-ins are audited';
  form.elements.project.value = 'SEC';
  form.elements.title.value = 'Emit an audit event';
  form.elements.brief.value = 'Write one audit row per sign-in';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'new-ticket', storyTitle: 'Sign-ins are audited', title: 'Emit an audit event', brief: 'Write one audit row per sign-in', project: 'SEC' },
    'an untouched key, check, position or note is left out rather than sent empty');
  f.q('#job-move-back').click();
  const again = f.q('.job-move[data-move="new-ticket"]'); again.click();
  const second = f.q('#job-move-form');
  second.elements.storyTitle.value = 'Existing work'; second.elements.key.value = 'AUTH-9';
  second.elements.title.value = 'Reuse the audit writer'; second.elements.brief.value = 'Call the shared writer';
  second.querySelector('[name="position"][value="after"]').checked = true;
  second.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).key, 'AUTH-9'); assert.equal(f.sent.at(-1).position, 'after');
});

test('Reorder sends the whole new prerequisite list, from the same checkboxes the plan graph uses', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }, { ...sub('web'), stage: 'implementation' }, { ...sub('gone'), stage: 'cleanup', cancelledAt: 1 }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'reorder');
  assert.deepEqual([...form.querySelectorAll('[data-dep]')].map((c) => c.value), ['web'], 'a dropped sub-job is not a prerequisite anyone can pick');
  form.querySelector('[data-dep][value="web"]').checked = true;
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'reorder', after: ['web'] });
});

test('Drop is the old cancel: confirmed first, and it sends nothing but the move', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', checkStatus: 'pending' } }, { ...sub('web', ['api']), stage: 'implementation' }];
  job.runs = [{ id: 'r1', subJobId: 'api', phase: 'repair', stopped: false }];
  f.view.update(f.data);
  openMove(f, 'api', 'drop');
  assert.equal(f.sent.length, 0, 'dropping needs a confirmation first');
  assert.match(f.q('#job-dialog').textContent, /running step is stopped/); assert.match(f.q('#job-dialog').textContent, /pull request stays open/);
  f.q('#job-move-back').click(); assert.ok(f.q('.job-move[data-move="drop"]'), 'backing out returns to the detail view');
  f.q('.job-move[data-move="drop"]').click(); f.q('[data-drop]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'drop' });
  job.subJobs[0] = { ...job.subJobs[0], stage: 'cleanup', cancelledAt: 1 }; job.runs = []; f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Dropped · cleaning up');
  assert.equal(jobNeedsReview(job, job.subJobs[1]), true); assert.match(jobStatus(job, job.subJobs[1]).text, /dropped sub-job/);
  f.q('[data-sub="api"]').click(); assert.equal(f.q('.job-moves'), null, 'a dropped sub-job has no moves left');
  job.subJobs[0].stage = 'done'; f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Dropped');
  assert.match(f.q('#jobs-active-count').textContent, /0 delivered/);
});

test('Cancel job is confirmed first, sends only the job action, and a cancelled job reads as cancelled rather than delivered', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', checkStatus: 'pending' } }, { ...sub('web', ['api']), stage: 'implementation' }, { ...sub('docs'), stage: 'done', deployed: { checks: ['Merged'], at: 1 } }];
  job.runs = [{ id: 'r1', subJobId: 'api', phase: 'repair', stopped: false }];
  f.view.update(f.data);
  f.q('[data-job="job1"]').click(); f.q('#job-cancel').click();
  assert.equal(f.sent.length, 0, 'cancelling needs a confirmation first');
  const text = () => f.q('#job-dialog').textContent;
  assert.match(text(), /drops the 2 unfinished sub-jobs and stops the running step/); assert.match(text(), /already delivered stay delivered/); assert.match(text(), /Its open pull request stays open/);
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
  assert.equal(document.querySelectorAll('.job-card').length, 0, 'a cancelled job is finished: hidden until Show finished');
  f.q('#jobs-done').checked = true; f.q('#jobs-done').dispatchEvent(f.event('change'));
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Cancelled');
  assert.deepEqual([...document.querySelectorAll('[data-board="job1"] .job-seg')].map((e) => [...e.classList].at(-1)), ['dropped', 'dropped', 'done'], 'dropped work reads apart from delivered work');
  assert.match(f.q('#jobs-active-count').textContent, /1 delivered/, 'dropped sub-jobs are never counted as delivered');
});

test('a job cancelled before it had sub-jobs keeps a card in Done and never offers Start planning', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'backlog'; job.plan = null; job.cancelledAt = 5; f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.equal(f.q('[data-action="start"]'), null); assert.match(f.q('#job-dialog').textContent, /Cancelled/);
  assert.equal(jobNeedsReview({ ...job, stage: 'planning', plan }, null), false, 'a cancelled plan is not waiting for review');
  job.stage = 'done'; f.view.update(f.data);
  f.q('#jobs-done').checked = true; f.q('#jobs-done').dispatchEvent(f.event('change'));
  assert.equal(jobCards([job]).length, 1);
  assert.equal(f.q('.job-card').dataset.board, 'job1');
  assert.equal(f.q('.job-card .job-status').textContent, 'Cancelled');
});

test('Mark position offers only the claims this stage can accept, and insists on the URL for an open PR', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }, { ...sub('open'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'pending', checks: [] } }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'mark');
  assert.deepEqual([...form.querySelectorAll('[name="position"]')].map((r) => r.value), ['pr', 'done']);
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.length, 0); assert.match(f.q('#job-move-error').textContent, /Paste the pull request URL/);
  form.elements.url.value = 'https://github.com/org/repo/pull/12';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'mark', position: 'pr', url: 'https://github.com/org/repo/pull/12' });
  f.q('#job-move-back').click(); f.q('#job-dialog').close();
  const opened = openMove(f, 'open', 'mark');
  assert.deepEqual([...opened.querySelectorAll('[name="position"]')].map((r) => r.value), ['merged', 'done']);
  assert.equal(opened.elements.url, undefined, 'the PR is already known');
  opened.querySelector('[name="position"][value="done"]').checked = true;
  opened.elements.note.value = 'Shipped in last week’s release';
  opened.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'open', action: 'mark', position: 'done', note: 'Shipped in last week’s release' });
});

test('the moves a job has taken fold into a collapsed history that stays open across ticks', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'pending', checks: [] } }];
  job.moves = [{ id: 'mv_1', at: 1757400000000, subJobId: 'api', move: 'fix-here', detail: 'Fix here on “Deliver api”' },
    { id: 'mv_2', at: 1757400600000, subJobId: 'api', move: 'split-out', detail: 'Split out “<proto> sync” to land before this' }];
  f.view.update(f.data); f.q('.job-card-open').click();
  const history = f.q('.job-moves-history');
  assert.equal(history.open, false); assert.match(history.querySelector('summary').textContent, /Moves\s*2/);
  assert.deepEqual([...history.querySelectorAll('.job-move-log span')].map((e) => e.textContent), ['Split out “<proto> sync” to land before this', 'Fix here on “Deliver api”'], 'newest first');
  assert.ok(!history.innerHTML.includes('<proto>'), 'a move line is agent-adjacent text: escaped');
  assert.equal(history.querySelectorAll('.job-move-log small').length, 2, 'each move says when it was made');
  history.open = true; history.dispatchEvent(f.event('toggle'));
  f.view.update(f.data);
  assert.equal(f.q('.job-moves-history').open, true, 'the disclosure survives the tick');
});

test('planning edits survive live snapshots and submit the displayed revision', (t) => {
  const f = fixture(t); f.q('[data-job="job1"]').click();
  const title = f.q('[data-title="0"]'); title.value = 'Deliver secure API'; title.dispatchEvent(f.event('input'));
  f.data.jobs[0].revision = 3; f.view.update(f.data);
  assert.equal(f.q('[data-title="0"]').value, 'Deliver secure API');
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent[0].revision, 2); assert.equal(f.sent[0].plan.subJobs[0].title, 'Deliver secure API');
  assert.equal(f.q('#job-dialog').open, true, 'remain open until server acknowledges');
  f.view.created(); assert.equal(f.q('#job-dialog').open, false);
});

test('the plan under review shows the shared context, each brief and each check — and no business-value prose', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan.subJobs[0].check = 'helm list shows auth-api in dev and prod';
  f.view.update(f.data); f.q('[data-job="job1"]').click();
  const dialog = f.q('#job-dialog');
  assert.equal(dialog.querySelector('.job-context').textContent, 'Keys live in the vault; every service reads them at boot.');
  assert.equal(dialog.querySelector('.job-context').closest('details').open, false, 'context is folded until asked for; the landing order is the decision');
  assert.equal(dialog.querySelectorAll('.job-stories p').length, 0, 'a story is a title; its value is not the board’s business');
  assert.match(dialog.textContent, /Implement it and open the PR/);
  assert.match(dialog.textContent, /Check after it lands: helm list shows auth-api in dev and prod/);
  assert.doesNotMatch(dialog.textContent, /No deployment: merging the PR completes it/, 'the runner infers what a merge deploys');
  const approve = f.q('[data-action="approve-plan"]');
  assert.equal(approve.textContent, 'Approve 2');
  assert.doesNotMatch(approve.title, /[Cc]ode review/);
  assert.match(approve.title, /Approve starts work in dedicated worktrees/, 'what approval does is one hover away');
});

test('the plan review has no branch field; a sub-job\'s detail shows the branch its worktree is actually on', (t) => {
  const f = fixture(t); f.q('[data-job="job1"]').click();
  assert.equal(f.q('[data-branch]'), null); assert.equal(f.q('.job-plan-branch'), null);
  f.q('#job-dialog').close();
  const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', worktree: { path: '/wt/api', branch: 'fix/AUTH-1-api', repoRoot: '/repo' } }, { ...sub('web', ['api']), stage: 'implementation' }]; f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.equal(f.q('.job-plan-branch'), null, 'the graph stays uncluttered');
  f.q('[data-open-sub="api"]').click();
  assert.equal(f.q('.job-detail-meta .job-plan-branch').textContent, 'fix/AUTH-1-api');
  f.q('#job-dialog').close(); f.q('[data-job="job1"]').click(); f.q('[data-open-sub="web"]').click();
  assert.equal(f.q('.job-detail-meta .job-plan-branch'), null, 'no worktree yet, nothing to show');
});

test('a job session archived when its step stopped is offered as a restore, not a dead open', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', sessions: ['s1', 's2'] }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.equal(f.q('#job-session').textContent, 'Restore session');
  f.onBoard.add('s2'); f.view.update(f.data);
  assert.equal(f.q('#job-session').textContent, 'Open session');
  f.q('#job-session').click(); assert.deepEqual(f.sessions, ['s2'], 'the latest run, live or archived');
});

test('Review code in Wrangler opens the latest run already on the board, else the latest', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'review', worktree: { path: '/wt/api' }, sessions: ['s1', 's2', 's3'] }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  f.q('#job-diff').click(); assert.deepEqual(f.diffs, ['s3'], 'every run shares the worktree; nothing on the board, so the latest');
  f.onBoard.add('s1'); f.onBoard.add('s2'); f.view.openDetail('job1', 'api');
  f.q('#job-diff').click(); assert.equal(f.diffs.at(-1), 's2', 'an archived card would resume its agent just to show a diff');
});

test('PR review shows green checks, what runs on merge, CI changes, and approves only the displayed head', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', deploys: deploys(), worktree: { path: '/wt/api' }, sessions: ['s1'],
    pr: { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', mergeWithAdmin: true, checks: [{ name: 'Tests', state: 'SUCCESS' }] }, repairs: [{ changes: ['Fixed timeout'], checks: ['Tests pass'] }] }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
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
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Comments block merging'); assert.ok(f.q('.job-seg[data-sub="api"].tone-bad'));
  assert.equal(mergeHeldByComments(job, job.subJobs[0]), true); assert.equal(jobNeedsReview(job, job.subJobs[0]), true);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Comments block merging');
  const asked = { ...job.subJobs[0], fixRequested: { note: null, at: 1 } };
  assert.equal(jobNeedsReview(job, asked), false, 'a requested fix takes the comments off the human'); assert.equal(jobStatus(job, asked).text, 'Fix requested');
  const fixing = { ...job, runs: [{ id: 'r1', subJobId: 'api', phase: 'repair', stopped: false, status: 'working' }] };
  assert.equal(jobNeedsReview(fixing, job.subJobs[0]), false); assert.equal(jobStatus(fixing, job.subJobs[0]).text, 'Fixing the PR');
  f.q('[data-sub="api"]').click();
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
  f.view.update(f.data); f.q('[data-sub="api"]').click();
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
    assert.ok(f.q('.job-seg[data-sub="api"].tone-run'), 'green checks and no blocking comments: on its way'); assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
    f.q('[data-sub="api"]').click(); assert.match(f.q('#job-dialog').textContent, expectDetail);
    assert.match(f.q('.job-comment-summary b')?.textContent || '', expectCard);
    assert.equal(f.q('[data-action="approve-merge"]'), null, 'automatic merge needs no approval');
    f.q('#job-dialog').close();
  }
});

test('new-job form sends chosen model, repositories and the three review points', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  assert.equal(form.elements.reviewCode.checked, true, 'the human reads each diff before it is committed, unless they opt out');
  assert.equal(form.elements.amendmentAuthority, undefined, 'agents never change the plan, so there is no authority to grant');
  form.elements.intent.value = 'Deliver something useful';
  form.elements.repos.value = '/repo\n/repo\n/second';
  form.dispatchEvent(f.event('submit'));
  const msg = f.sent[0]; assert.equal(msg.type, 'job-create'); assert.deepEqual(msg.job.repos, ['/repo', '/second']);
  assert.equal(msg.job.taskId, null, 'jobs stay Unassigned unless a task is chosen');
  assert.equal(msg.job.model, 'sonnet'); assert.equal(msg.job.reviewPlan, true); assert.equal(msg.job.reviewCode, true); assert.equal(msg.job.reviewMerge, true); assert.equal(msg.job.reviewSessions, true);
  assert.equal(msg.job.effort, '', 'Default leaves effort to the agent');
  assert.deepEqual(Object.keys(msg.job).filter((k) => /amendment/.test(k)), []);
  assert.equal(f.q('#job-dialog').open, true);
});

test('plan review is an opt-out in the new-job form and a flag on the job', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  f.q('[data-job="job1"]').click();
  assert.match(f.q('.job-flag[aria-label^="Plan review"]').title, /approve the plan before work begins/, 'a job without the flag still reviews its plan');
  f.q('#job-dialog').close();
  job.reviewPlan = false; f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.match(f.q('.job-flag.off[aria-label^="No plan review"]').title, /work starts as soon as the plan is in/);
  f.q('#job-dialog').close();
  f.q('#job-new').click(); const form = f.q('#job-create-form');
  assert.equal(form.elements.reviewPlan.disabled, false); assert.equal(form.elements.reviewPlan.checked, true);
  form.elements.reviewPlan.checked = false;
  form.elements.intent.value = 'Deliver it'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).job.reviewPlan, false);
});

test('new-job effort picker follows the chosen agent and keeps a level both offer', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  const options = () => [...form.elements.effort.options].map((o) => o.value);
  assert.deepEqual(options(), ['', 'high', 'max']);
  form.elements.effort.value = 'max';
  form.elements.agent.value = 'codex'; form.elements.agent.onchange();
  assert.deepEqual(options(), ['', 'high']); assert.equal(form.elements.effort.value, '', 'a level the new agent lacks falls back to Default');
  assert.equal(form.elements.model.value, 'gpt-5.6-sol');
  form.elements.effort.value = 'high';
  form.elements.agent.value = 'claude'; form.elements.agent.onchange();
  assert.equal(form.elements.effort.value, 'high');
  form.elements.intent.value = 'I';
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent[0].job.effort, 'high');
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

test('new jobs need only an outcome while repository hints stay optional', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  form.elements.intent.value = 'Customers can access their accounts';
  assert.equal(form.elements.repos.required, false);
  assert.equal(form.elements.repos.closest('details').open, false);
  assert.equal(form.checkValidity(), true);
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent[0].type, 'job-create'); assert.deepEqual(f.sent[0].job.repos, []);
  f.view.created();
  const job = f.data.jobs[0]; job.repos = []; job.plan = null; job.stage = 'backlog'; f.view.update(f.data);
  f.q('.job-card-open').click();
  assert.match([...document.querySelectorAll('#job-dialog .job-chip')].map((c) => c.title).join(' '), /discover the repositories/);
  assert.equal(f.q('#job-dialog .job-intent').textContent, 'Reliable sign-in', 'a backlog job shows the outcome it was given');
});

test('the plan review shows discovered checkout paths before approval', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.plan.subJobs[0].repo = '/projects/api/service'; job.plan.subJobs[1].repo = '/projects/web/service';
  job.repos = job.plan.subJobs.map((s) => s.repo); f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((e) => e.title.split('\n')[2]), job.repos, 'each node names its checkout on hover');
  f.q('[data-action="approve-plan"]').click();
  assert.deepEqual(f.sent[0].plan.subJobs.map((s) => s.repo), job.repos);
});

test('global concurrency, pause and repair limits are explicit controls, and no step is on a clock', (t) => {
  const f = fixture(t); f.q('#jobs-concurrency').value = '4'; f.q('#jobs-concurrency').dispatchEvent(f.event('change'));
  assert.deepEqual(f.sent[0], { type: 'job-settings', patch: { concurrency: 4 } });
  f.q('#jobs-pause').click(); assert.equal(f.sent[1].patch.paused, true);
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form');
  assert.equal(form.elements.maxRunMinutes, undefined, 'a step ends with a receipt or an idle session, not a timeout');
  form.elements.maxRepairs.value = '1'; form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1).patch, { maxRepairs: 1, deploymentStaleMinutes: 30, ideApp: 'IntelliJ IDEA' });
});

test('dependency waves, session waits and escaped titles remain compact', () => {
  assert.deepEqual([...dependencyLevels(plan)], [['api', 0], ['web', 1]]);
  const spike = { ...sub('spike'), kind: 'session', stage: 'session' };
  const job = { title: '<script>bad()</script>', stage: 'active', subJobs: [spike, { ...sub('web', ['spike']), stage: 'implementation' }], runs: [], moves: [] };
  assert.match(jobStatus(job, job.subJobs[1]).text, /Waiting for 1 session/);
  job.subJobs[0].title = '<img src=x>';
  const html = jobTileHtml({ ...job, id: 'j1', repos: [] }); assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<img'));
  assert.equal(jobNeedsReview(job, job.subJobs[1]), false);
});

test('cleanup failures stay discoverable even after every sub-job is delivered', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.error = 'Planning worktree has local changes'; job.subJobs = [{ ...sub('api'), stage: 'done' }];
  f.view.update(f.data); assert.equal(jobCards([job]).length, 2);
  assert.equal(document.querySelectorAll('.job-card').length, 1); f.q('[data-job="job1"]').click();
  assert.match(f.q('#job-dialog').textContent, /Planning worktree has local changes/); assert.ok(f.q('#job-retry'));
});

test('retry targets the job when a sub-job displays an inherited coordinator error', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.error = 'Could not observe a stopped worker';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  f.q('#job-retry').click();
  assert.equal(f.q('#job-retry-form [name="note"]'), null, 'a coordinator retry has no session to leave a note for');
  f.q('#job-retry-form').dispatchEvent(new f.window.Event('submit', { cancelable: true }));
  assert.equal(f.sent.at(-1).action, 'retry');
  assert.equal(f.sent.at(-1).id, job.id);
  assert.equal(f.sent.at(-1).subJobId, undefined);
  assert.equal('note' in f.sent.at(-1), false);

  job.subJobs[0].error = 'Restore repository access';
  f.view.update(f.data); f.q('[data-sub="api"]').click();
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
  assert.deepEqual([...document.querySelectorAll('.job-seg')].map((e) => [...e.classList].at(-1)), ['needs', 'waiting', 'running']);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Review result');
  assert.equal(jobStatus(job, job.subJobs[1]).text, 'Waiting for 1 session'); assert.equal(jobStatus(job, job.subJobs[0]).text, 'Ready to review');
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true); assert.equal(f.q('#jobs-review-count').textContent, '1');
  f.q('.job-card-open').click();
  assert.match(f.q('.job-flag[aria-label^="Session review on"]').title, /approve each agent session/);
  assert.equal(f.q('#job-dialog .job-actions button.primary').dataset.openSub, 'spike', 'the job’s one button opens what needs reading');
  f.q('#job-dialog .job-actions button.primary').click();
  assert.match(f.q('#job-dialog').textContent, /Schema documented/);
  f.q('[data-action="approve-session"]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'spike', action: 'approve-session', head: undefined, sessionReceiptId: 'receipt9' });
  f.q('#job-revise-session').click();
  const form = f.q('#job-dialog form'); form.elements.feedback.value = 'Check staging too'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).action, 'revise-session'); assert.equal(f.sent.at(-1).feedback, 'Check staging too');
});

const humanSub = (id, after = []) => ({ id, kind: 'human', title: `Sign ${id}`, storyId: 'story', jiraKey: 'AUTH-1', after, brief: 'Click approve in the vendor console', sessions: [], repairs: [] });

test('a waiting human task needs you, and the work behind it waits', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...humanSub('licence'), stage: 'human', state: 'queued' }, { ...sub('api', ['licence']), stage: 'implementation' }];
  f.view.update(f.data);
  assert.deepEqual([...document.querySelectorAll('.job-seg')].map((e) => [...e.classList].at(-1)), ['needs', 'waiting']);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Your turn');
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'needs', text: 'Needs you' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true); assert.equal(f.q('#jobs-review-count').textContent, '1');
  assert.equal(jobStatus(job, job.subJobs[1]).text, 'Waiting for 1 human task');
  assert.match(f.q('.job-card-open').title, /1 PR · 1 human task/);
  f.q('[data-sub="api"]').click();
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
  f.q('[data-sub="licence"]').click();
  const dialog = f.q('#job-dialog');
  assert.match(dialog.textContent, /Click approve in the vendor console/, 'the brief is the instruction, not a folded detail');
  assert.match(hint(f), /No agent will ever run this one/);
  assert.equal(dialog.querySelector('[data-action="start-human"]').className, '');
  const output = `ssh-ed25519 ${'A'.repeat(600)} user@host\nSecond line`;
  dialog.querySelector('textarea[name="output"]').value = output;
  f.q('[data-action="start-human"]').click();
  assert.deepEqual(f.sent.at(-1).action, 'start-human'); assert.equal(f.sent.at(-1).subJobId, 'licence');

  job.subJobs[0].state = 'doing'; f.view.update(f.data);
  assert.ok(f.q('.job-seg[data-sub="licence"]').classList.contains('running'), 'in progress by hand reads as moving');
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'In progress' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
  assert.equal(dialog.querySelector('[data-action="start-human"]'), null, 'it is already started');
  assert.equal(dialog.querySelector('textarea[name="output"]').value, output);
  assert.equal(dialog.querySelector('#job-human-form button.primary').textContent, 'Mark done');
  dialog.querySelector('#job-human-form').dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'licence', action: 'finish-human', output });

  job.subJobs[0] = { ...job.subJobs[0], stage: 'done', state: 'done', result: { checks: ['Done by hand'], output: '<img src=x onerror=alert(1)>\nssh-ed25519 AAAA', at: 1, receiptId: null } };
  f.data.jobs[0] = { ...job }; f.q('#jobs-done').checked = true; f.q('#jobs-done').dispatchEvent(f.event('change'));
  assert.ok(f.q('.job-seg[data-sub="licence"]').classList.contains('done'));
  assert.deepEqual(jobStatus(f.data.jobs[0], f.data.jobs[0].subJobs[0]), { tone: 'done', text: 'Done' });
  f.q('[data-sub="licence"]').click();
  assert.match(dialog.textContent, /ssh-ed25519 AAAA/);
  assert.equal(dialog.querySelector('.job-human-output').textContent, '<img src=x onerror=alert(1)>\nssh-ed25519 AAAA');
  assert.equal(dialog.querySelector('.job-human-output img'), null, 'output is escaped, not rendered as markup');
  assert.equal(dialog.querySelector('#job-human-form'), null, 'a finished task has no marks left');
  dialog.close();
});

test('a human task can be finished directly with no output', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...humanSub('licence'), stage: 'human', state: 'queued' }]; f.view.update(f.data);
  f.q('[data-sub="licence"]').click();
  assert.equal(f.q('#job-human-form button.primary').textContent, 'Mark done');
  primaryAction(f.q('#job-dialog'))();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'licence', action: 'finish-human' });
});

test('a plan proposing a human task draws it as a third kind with no repository', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.plan = { ...plan, subJobs: [humanSub('licence'), sessionSub('spike', ['licence']), sub('api', ['spike'])] }; f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  const kinds = () => [...document.querySelectorAll('.job-node')].map((n) => n.querySelector('.job-kind').getAttribute('aria-label'));
  assert.deepEqual(kinds(), ['Human', 'Session', 'PR'], 'the kind is a glyph, named for assistive tech and on hover');
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((n) => n.title.split('\n')[0]), ['Only you can do this one — no agent, no pull request', 'An agent session on this machine — no pull request', 'A pull request in a repository']);
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((n) => n.title.includes('~') || n.title.includes('/repo')), [false, false, true], 'only a PR names a repository');
  assert.match(f.q('[data-action="approve-plan"]').title, /Nothing starts a human task: you mark it done/);
  f.q('#job-dialog').close();
});

test('plans show session rows without a repository and new jobs default to reviewing session results', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.plan = { ...plan, subJobs: [sessionSub('spike'), sub('api', ['spike'])] }; f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((n) => [n.dataset.node, n.querySelector('.job-kind').getAttribute('aria-label')]), [['spike', 'Session'], ['api', 'PR']]);
  assert.match(f.q('[data-node="spike"]').title, /An agent session on this machine/);
  assert.match(f.q('[data-action="approve-plan"]').title, /approve each agent session/);
  f.q('#job-dialog').close();
  f.q('#job-new').click(); const form = f.q('#job-create-form');
  form.elements.intent.value = 'Deliver it'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).job.reviewSessions, true);
});

test('a plan proposes story titles the human can edit, and approval of keyless stories says tickets follow', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan = structuredClone(plan); job.plan.stories = [{ id: 'story', title: 'Customers can sign in' }, { id: 'audit', project: 'SEC', key: undefined, title: 'Sign-ins are audited' }, { id: 'old', key: 'AUTH-9', title: 'Existing work' }, { id: 'events', project: 'SEC', title: 'Sign-in events are emitted' }];
  job.plan.subJobs[1].storyId = 'audit'; job.plan.subJobs.forEach((s) => delete s.jiraKey); f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-story-key')].map((e) => e.textContent), ['NEW-1', 'SEC-NEW-1', 'AUTH-9', 'SEC-NEW-2'], 'proposals are numbered per project');
  assert.equal(document.querySelectorAll('.job-story-key.job-story-new').length, 3);
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((e) => e.title.split('\n')[1]), ['NEW-1', 'SEC-NEW-1']);
  assert.deepEqual([...document.querySelectorAll('.job-appbar .job-chip')].slice(1).map((c) => c.textContent), ['NEW-1', 'SEC-NEW-1', '+2'], 'the app bar names the first stories; the rest are one chip');
  assert.match(f.q('.job-appbar .job-chip[title^="Customers can sign in"]').title, /created only after you approve/);
  assert.match(f.q('[data-action="approve-plan"]').title, /creates the 3 new Jira stories with these titles, then starts work/);
  const title = f.q('[data-story="0"]'); title.value = 'Customers sign in without lockouts'; title.dispatchEvent(f.event('input'));
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent[0].plan.stories[0].title, 'Customers sign in without lockouts');
  assert.equal(f.sent[0].plan.stories[0].key, undefined, 'the browser never mints a key');
  f.q('#job-dialog').close();
  // Approved: the job card waits in the Jira column while a ticketing session runs, and never asks for review.
  job.stage = 'jira'; job.plan = f.sent[0].plan; job.runs = [{ id: 'r2', subJobId: null, phase: 'jira', stopped: false }]; f.view.update(f.data);
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Creating Jira tickets');
  assert.ok(f.q('[data-board="job1"]').classList.contains('tone-run'));
  assert.equal(jobNeedsReview(job, null), false);
  f.q('[data-job="job1"]').click();
  assert.match(hint(f), /Creating the approved Jira stories/);
  assert.equal(f.q('[data-action="approve-plan"]'), null);
});

test('a ticketless plan reviews with no stories, its sub-jobs carry No ticket and never wait for Jira', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan = structuredClone(plan); job.plan.stories = []; job.plan.subJobs.forEach((s) => { delete s.storyId; delete s.jiraKey; }); f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.equal(f.q('.job-appbar .job-chip[title="This work has no Jira ticket"]').textContent, 'No ticket');
  assert.equal(document.querySelectorAll('.job-story-key').length, 0);
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((e) => e.title.split('\n')[1]), ['No ticket', 'No ticket']);
  assert.match(f.q('[data-action="approve-plan"]').title, /^Approve starts work/);
  f.q('#job-dialog').close();
  job.stage = 'active'; job.subJobs = job.plan.subJobs.map((s) => ({ ...s, stage: 'implementation', sessions: [], repairs: [] })); f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'muted', text: 'Queued' });
  assert.deepEqual(jobStatus(job, { ...job.subJobs[0], storyId: 'story' }), { tone: 'muted', text: 'Waiting for a Jira ticket' }, 'naming a keyless story is what waits');
  f.q('[data-sub="api"]').click();
  assert.match(f.q('.job-detail-meta').textContent, /No ticket/);
});

test('a plan whose stories all exist reads as existing and approval starts work directly', (t) => {
  const f = fixture(t); f.q('[data-job="job1"]').click();
  assert.match(f.q('.job-plan-more h4').textContent, /existing/);
  assert.equal(f.q('.job-appbar .job-chip[title="Customers can sign in"]').textContent, 'AUTH-1');
  assert.match(f.q('[data-action="approve-plan"]').title, /^Approve starts work/);
  assert.equal(f.q('.job-story-key').textContent, 'AUTH-1');
});

test('a job card carries its total price, and each sub-job its own in the detail', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', usd: 3.5, usdEstimated: false }, { ...sub('web'), stage: 'implementation' }];
  job.usd = 12.345; job.usdEstimated = false; f.view.update(f.data);
  assert.equal(f.q('.job-card-cost').textContent, '$12.35');
  assert.equal(f.q('.job-card footer').lastElementChild.className, 'job-card-cost', 'the price closes the footer, opposite the state');
  assert.match(f.q('.job-card-cost').title, /Total price of this job.*planning.*repairs.*comment triage/);
  f.q('[data-sub="api"]').click(); assert.equal(f.q('#job-dialog .job-detail-cost').textContent, '$3.50');
  f.q('[data-sub="web"]').click(); assert.equal(f.q('#job-dialog .job-detail-cost'), null, 'a sub-job with nothing attributed shows no price');
  f.q('#job-dialog').close();
  // Codex is an estimate everywhere it is shown, exactly as a session card reads it.
  job.usd = 8; job.usdEstimated = true; job.subJobs[0].usdEstimated = true; f.view.update(f.data);
  assert.equal(f.q('.job-card-cost').textContent, '~$8.00');
  assert.match(f.q('.job-card-cost').title, /includes an estimate for Codex sessions/);
  f.q('[data-sub="api"]').click(); assert.equal(f.q('#job-dialog .job-detail-cost').textContent, '~$3.50');
});

test('a job with no attributable spend shows no price rather than $0.00', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.usd = null; f.view.update(f.data);
  assert.equal(f.q('.job-card-cost'), null);
  job.usd = 0; f.view.update(f.data);
  assert.equal(f.q('.job-card-cost'), null, 'zero is "nothing attributed yet", not a price');
});

test('the detail dialog shows a sub-job price with the job total behind it, and a job total alone', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.usd = 12.5; job.subJobs = [{ ...sub('api'), stage: 'pr', usd: 3.5 }]; f.view.update(f.data);
  f.q('[data-sub="api"]').click();
  assert.deepEqual([...document.querySelectorAll('#job-dialog .job-detail-cost')].map((e) => e.textContent), ['$3.50']);
  assert.match(f.q('#job-dialog .job-detail-cost').title, /job total \$12\.50/);
  f.q('#job-dialog').close();
  f.q('.job-card-open').click();
  assert.deepEqual([...document.querySelectorAll('#job-dialog .job-detail-cost')].map((e) => e.textContent), ['$12.50']);
});

test('the plan is a dependency graph: a box per sub-job in its wave, an arrow per prerequisite, and a dependency edit moves the box', (t) => {
  const f = fixture(t); f.q('[data-job="job1"]').click();
  const waves = () => [...document.querySelectorAll('.job-graph-col')].map((c) => [...c.querySelectorAll('.job-node')].map((n) => n.dataset.node));
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
  assert.match(f.q('.job-card-open').title, /^1 PR · 1 session/, 'the card counts the kinds on hover rather than "sub-jobs"');
  f.q('.job-card-open').click();
  assert.match(f.q('#job-dialog').textContent, /Keys live in the vault/, 'the shared context is one fold away');
  const nodes = [...document.querySelectorAll('button.job-node')];
  assert.deepEqual(nodes.map((n) => [n.dataset.openSub, n.classList.contains('session'), [...n.classList].find((c) => c.startsWith('tone-')), n.querySelector('.job-status').textContent]),
    [['spike', true, 'tone-warn', 'Review result'], ['api', false, 'tone-idle', 'Waiting for 1 session']]);
  assert.ok(f.q('[data-node="spike"] .job-node-tile').classList.contains('on'), 'a step that needs you is filled; one still waiting is hollow');
  assert.equal(f.q('[data-node="api"] .job-node-tile').classList.contains('on'), false);
  assert.deepEqual([...document.querySelectorAll('.job-graph-edges path[data-from]')].map((p) => `${p.dataset.from}→${p.dataset.to}:${p.getAttribute('class')}`), ['spike→api:start'], 'a session prerequisite gates the start: a solid line');
  assert.match(f.q('[data-node="api"]').title, /Start after Run spike/);
  f.q('[data-open-sub="api"]').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver api'); assert.equal(f.q('.job-detail-meta .job-kind').getAttribute('aria-label'), 'PR');
  assert.equal(f.q('.job-graph'), null, 'a sub-job detail is about one sub-job, not the graph');
});

test('a merge that deploys nothing says so in the detail', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('docs'), stage: 'done', deploys: { head: 'h', base: 'main', expected: false, workflows: [], summary: 'Merge completes it · deployment-pipeline ignores **.md' },
    deployed: { at: 1, checks: ['Merged; nothing runs on push for these paths'], commit: 'abc' } }];
  f.view.update(f.data); f.q('#jobs-done').checked = true; f.q('#jobs-done').dispatchEvent(f.event('change'));
  f.q('[data-sub="docs"]').click();
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
  assert.ok(f.q('.job-seg[data-sub="api"]').classList.contains('tone-warn')); assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Nothing deployed');
  f.q('[data-sub="api"]').click();
  assert.match(hint(f), /No GitHub Actions run has started for merge commit abcdef12 in 40 min/);
  assert.match(hint(f), /Mark position: done/, 'it says what the human can do about it');
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

test('Fix here on an open PR under code review reads as a fix queued in Work, and review copy says push rather than open', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const pr = { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'passing', checks: [] };
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr }];
  assert.deepEqual(movesFor(job, job.subJobs[0]).find((m) => m.id === 'fix-here').blurb, 'Back to work on this PR. You review the diff before it is pushed.');
  assert.equal(movesFor({ ...job, reviewCode: false }, job.subJobs[0]).find((m) => m.id === 'fix-here').blurb, 'New commit on this PR, with your note.');
  job.subJobs = [{ ...sub('api'), stage: 'implementation', state: 'queued', pr, note: 'Pin the client to v3' }];
  f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Fix queued' });
  assert.equal(jobCards([job])[0].stage, 'implementation', 'the card sits in Work, not PR');
  job.subJobs = [{ ...sub('api'), stage: 'review', state: 'verified', pr, ready: { checks: ['Pinned'], receiptId: 'run_2' } }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.match(hint(f), /pushes it to the open PR/);
  assert.equal(f.q('#job-dialog [data-action="approve-code"]').textContent, 'Approve & push');
});

test('a requested fix reads as work about to happen, and the note rides on the card until the next receipt', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.reviewCode = false;
  job.subJobs = [{ ...sub('api'), stage: 'pr', fixRequested: { note: 'Pin the client to v3', at: 1 }, note: 'Pin the client to v3',
    pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'passing', checks: [] } }];
  f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Fix requested' });
  f.q('[data-sub="api"]').click();
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

test('Cmd+Enter in a move form submits it, honouring required exactly as the button does', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [] } }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'fix-here');
  chord(f, form.elements.note);
  assert.equal(f.sent.length, 0, 'an empty required note holds the chord back');
  form.elements.note.value = '  Pin the client to v3  ';
  chord(f, form.elements.note, { shiftKey: true });
  assert.equal(f.sent.length, 0);
  chord(f, form.elements.note);
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'fix-here', note: 'Pin the client to v3' });
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
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.ok(f.q('[data-action="approve-merge"]'), 'the primary is the only data-action primary on the detail');
  chord(f, f.q('#job-dialog'), { altKey: true });
  assert.equal(f.sent.length, 0);
  chord(f, f.q('#job-dialog'));
  assert.equal(f.sent.at(-1).action, 'approve-merge'); assert.equal(f.sent.at(-1).head, 'head1');
  // Drop is a confirmation with nothing but destructive buttons: keyboard-inert.
  const before = f.sent.length;
  f.q('[data-sub="api"]').click(); f.q('.job-move[data-move="drop"]').click();
  assert.equal(primaryAction(f.q('#job-dialog')), null);
  chord(f, f.q('#job-drop-form'));
  assert.equal(f.sent.length, before); assert.equal(f.q('#job-dialog').open, true, 'the chord neither submits nor closes it');
});

test('a disabled primary stays disabled to the keyboard', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.runs = [{ id: 'r1', phase: 'planning', stopped: false }]; f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.equal(f.q('[data-action="approve-plan"]').disabled, true);
  assert.equal(primaryAction(f.q('#job-dialog')), null);
  chord(f, f.q('#job-dialog'));
  assert.equal(f.sent.length, 0);
  job.runs = []; f.view.update(f.data); f.q('[data-job="job1"]').click();
  chord(f, f.q('#job-dialog'));
  assert.equal(f.sent.at(-1).action, 'approve-plan');
});

test('the job dialog’s one button merges the green PR waiting on you, pinned to its head; a failing step opens instead', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/142', head: 'head9', checkStatus: 'passing', checks: [] } }, { ...sub('web', ['api']), stage: 'implementation' }];
  f.view.update(f.data); f.q('.job-card-open').click();
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
  assert.equal(f.q('.job-overflow').open, true, 'something went wrong, so the moves start unfolded');
});

test('a folded section stays open across live ticks', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', worktree: { path: '/wt/api' } }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  const details = f.q('[data-keep="details"]');
  assert.equal(details.open, false); assert.match(details.textContent, /\/wt\/api/);
  details.open = true; details.dispatchEvent(f.event('toggle'));
  f.view.update(f.data);
  assert.equal(f.q('[data-keep="details"]').open, true);
  assert.equal(f.q('.job-overflow').open, false, 'nothing went wrong: the moves stay behind the overflow');
});

// --- Changing the plan of a running job ---

test('Change plan on a running job asks for a proposal; while it is pending new work reads as held and Discard is offered', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'done', deployed: { at: 1, checks: ['ok'] } }, { ...sub('web', ['api']), stage: 'implementation', state: 'queued' }];
  f.view.update(f.data);
  f.q('[data-board="job1"] .job-card-open').click();
  f.q('#job-refine').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Change the plan');
  assert.match(f.q('#job-dialog').textContent, /nothing changes until you approve the proposal/);
  f.q('#job-feedback textarea').value = 'Split web in two';
  f.q('#job-feedback').dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: undefined, action: 'replan', feedback: 'Split web in two' });

  job.replan = { feedback: 'Split web in two', at: 1, proposal: null, previous: null };
  job.runs = [{ id: 'plan2', subJobId: null, phase: 'planning', stopped: false }];
  f.view.update(f.data); f.q('[data-board="job1"] .job-card-open').click();
  assert.equal(f.q('[data-board="job1"] .job-status').textContent, 'Re-planning');
  assert.equal(jobStatus(job, job.subJobs[1]).text, 'Held for the plan change');
  assert.match(f.q('.job-replan-ask').textContent, /Split web in two/);
  assert.equal(f.q('#job-refine'), null, 'one change at a time');
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
  f.q('[data-sub="api"]').click();
  assert.equal(f.q('[data-action="approve-code"]'), null);
  assert.equal(f.q('.job-overflow'), null, 'every move is refused while the change is pending');
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
  f.q('[data-board="job1"] .job-card-open').click();
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
  f.q('#job-refine').click();
  f.q('#job-feedback textarea').value = 'Keep web';
  f.q('#job-feedback').dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: undefined, action: 'replan', feedback: 'Keep web' });
});

test('a superseded sub-job reads as superseded, and its open PR stays linked from the job and the sub-job', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'done', state: 'cancelled', cancelledAt: 1, superseded: true, pr: { url: 'https://github.com/org/repo/pull/7', checkStatus: 'pending' } }, { ...sub('cli'), stage: 'implementation', state: 'queued' }];
  f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Superseded');
  f.q('[data-board="job1"] .job-card-open').click();
  assert.match(f.q('.job-node[data-node="api"] .job-status').textContent, /#7 · Superseded/);
  assert.equal(f.q('.job-superseded a').href, 'https://github.com/org/repo/pull/7');
  f.q('.job-node[data-node="api"]').click();
  assert.match(f.q('#job-dialog .job-chip-state').title, /Superseded by a plan change and cancelled. Its PR is left open on GitHub/);
  assert.equal(f.q('.job-pipeline-status').href, 'https://github.com/org/repo/pull/7');
});
