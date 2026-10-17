import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { initJobsView } from './jobs-view.js';
import { ideaStage, liveSuggestion, jobNeedsReview, jobStatus } from './jobs.js';
import { plateAsk, plateHtml } from './job-plates.js';
import { proseHtml, suggestionSummary } from './job-idea.js';

const suggest = { title: 'Nudge when a green PR waits over a day', plan: { context: '', stories: [], subJobs: [
  { id: 'track', title: 'Track how long a merge-ready PR has waited', repo: '/Users/me/wrangler-squared', after: [], brief: 'b' },
  { id: 'plate', title: 'Show the wait on the plate', repo: '/Users/me/wrangler-squared', after: ['track'], brief: 'b' },
  { id: 'dm', kind: 'session', title: 'DM you on Slack after 24 hours', after: ['plate'], brief: 'b' },
  { id: 'post', kind: 'write', title: 'Post the DM', place: { type: 'slack', ref: '@me' }, action: { type: 'post', text: 'hi' }, by: 'dm', after: [] },
] } };
const parked = (over = {}) => ({ id: 'run1', subJobId: null, phase: 'planning', stopped: false, parkedFor: 'idea', parkedAt: 2, mailedAt: null, ...over });
const ideaJob = (thread = [], runs = [parked()]) => ({ id: 'idea1', title: 'Nudge me when a green PR waits on me', intent: 'PRs sit green for ages. Can the board nag me?', repos: [], stage: 'planning', plan: null,
  subJobs: [], runs, moves: [], revision: 3, createdAt: 1, reviewPlan: true, idea: { thread } });
const asked = { id: 'm1', at: 2, from: 'planner', text: 'Two choices change the work:\n\n1. Which wait counts?\n2. Where should the nudge land?' };

function fixture(t, jobs) {
  const window = new Window({ url: 'http://localhost:7878' });
  const prevDoc = globalThis.document, prevFormData = globalThis.FormData, prevCSS = globalThis.CSS;
  globalThis.document = window.document; globalThis.FormData = window.FormData; globalThis.CSS = { escape: (v) => String(v) };
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  const sent = [];
  const view = initJobsView({ send: (m) => sent.push(structuredClone(m)), stageImage: async () => ({ name: 'x' }), getAgents: () => [{ id: 'claude', label: 'Claude', models: [{ value: 'sonnet', label: 'Sonnet', default: true }], efforts: [] }], onSession: () => {}, onDiff: () => {}, onBoard: () => true });
  t.after(async () => { globalThis.document = prevDoc; globalThis.FormData = prevFormData; globalThis.CSS = prevCSS; await window.happyDOM.close(); });
  const data = { jobs, settings: { concurrency: 2, maxRepairs: 2 } };
  view.update(data);
  const q = (s) => document.querySelector(s);
  const key = (el, k, extra = {}) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  return { window, view, data, sent, q, key };
}

test('New idea replaces New job: the button, the form, and a create that asks the planner to triage', (t) => {
  const f = fixture(t, []);
  assert.equal(f.q('#job-new').textContent, 'New idea');
  f.q('#job-new').click();
  const form = f.q('#job-create-form');
  assert.equal(form.querySelector('h2').textContent, 'New idea');
  assert.match(form.querySelector('.job-outcome label').textContent, /^Describe your idea/);
  assert.match(form.elements.intent.placeholder, /the planner will ask/);
  assert.match(form.querySelector('.job-create-foot span').textContent, /If the idea is clear, the planner plans it/);
  form.elements.intent.value = 'Something for flaky CI';
  form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  const create = f.sent.find((m) => m.type === 'job-create');
  assert.deepEqual([create.idea, create.start, create.job.intent], [true, true, 'Something for flaky CI']);
  f.view.created({ event: 'job-created', jobId: 'idea1', started: true, idea: true });
  assert.ok(f.q('#job-create-form'), 'the form stays until the idea is in the snapshot');
  f.data.jobs.push(ideaJob([], [parked({ parkedAt: null })])); f.view.update(f.data);
  assert.ok(f.q('#job-dialog .job-idea'), 'then the dialog opens on its conversation');
  assert.match(f.q('.job-idea-thinking').textContent, /reading the idea/);
});

test('an idea whose planner failed still says so, under the band', (t) => {
  const f = fixture(t, [{ ...ideaJob([], [parked({ parkedAt: null, stopped: true })]), error: 'Planner session exited before reporting' }]);
  f.q('[data-board="idea1"] .job-plate-open').click();
  assert.equal(f.q('#job-dialog .job-idea > .job-error').textContent, 'Planner session exited before reporting');
  assert.equal(f.q('#job-dialog .job-idea-band .job-detail-cost'), null, 'nothing spent, no price');
});

test('a vague idea is its conversation: the planner\'s reply, escaped, and Enter sends a follow-up to the same planner', (t) => {
  const f = fixture(t, [{ ...ideaJob([{ ...asked, text: `${asked.text}\n\n<img src=x onerror=alert(1)>` }]), usd: 0.39 }]);
  f.q('[data-board="idea1"] .job-plate-open').click();
  const view = f.q('#job-dialog .job-idea');
  assert.ok(view.querySelector('.job-idea-band .gx.nb[data-inflow]'), 'the formation sky across the top');
  assert.equal(view.querySelector('.job-idea-band h2').textContent, 'Nudge me when a green PR waits on me');
  assert.equal(view.querySelector('.job-sent-bubble').textContent, 'PRs sit green for ages. Can the board nag me?', 'the idea itself opens the thread');
  const body = view.querySelector('.job-idea-msg .job-idea-body');
  assert.deepEqual([...body.querySelectorAll('ol li')].map((l) => l.textContent), ['Which wait counts?', 'Where should the nudge land?']);
  assert.equal(body.querySelector('img'), null, 'agent text is never markup');
  assert.match(body.textContent, /<img src=x/);
  assert.equal(f.q('#job-dialog .job-idea-band > .job-detail-cost').textContent, '$0.39', 'the price sits in the band');
  assert.equal(f.q('#job-dialog .job-idea .job-chips'), null, 'no chip row under it');
  assert.equal(f.q('.job-idea-thinking'), null, 'the planner is waiting, not thinking');
  const box = f.q('[data-idea-composer] textarea');
  box.value = 'Green and unmerged for a day.'; box.dispatchEvent(new f.window.Event('input'));
  f.key(box, 'Enter', { shiftKey: true });
  assert.equal(f.sent.filter((m) => m.action === 'idea-reply').length, 0, 'Shift+Enter is a new line');
  f.key(box, 'Enter');
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'idea1', subJobId: undefined, action: 'idea-reply', text: 'Green and unmerged for a day.' });
  assert.equal([...f.q('#job-dialog').querySelectorAll('.job-sent-bubble')].at(-1).textContent, 'Green and unmerged for a day.', 'drawn at once');
  assert.match(f.q('.job-idea-thinking').textContent, /Planner is thinking/);
  f.data.jobs[0].idea.thread.push({ id: 'm2', at: Date.now(), from: 'human', text: 'Green and unmerged for a day.', sentAt: null });
  f.view.update(f.data);
  assert.equal([...f.q('#job-dialog').querySelectorAll('.job-sent-bubble')].filter((b) => b.textContent === 'Green and unmerged for a day.').length, 1, 'never twice once the thread has it');
});

test('a suggested job is a horizon strip: what it builds, the sub-jobs and repos, and the hole that creates it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, [ideaJob([asked, { id: 'm2', at: 3, from: 'human', text: 'Plate first', sentAt: 3 }, { id: 'm3', at: 4, from: 'planner', text: 'That is enough to plan.', suggest }])]);
  f.q('[data-board="idea1"] .job-plate-open').click();
  const panel = f.q('.job-launch');
  assert.ok(panel.classList.contains('live'));
  assert.equal(panel.querySelector('.job-launch-title').textContent, suggest.title);
  assert.deepEqual([...panel.querySelectorAll('.job-launch-chip')].map((c) => c.textContent.trim()), ['3\u00a0sub-jobs', '2 PR 1 agent', 'wrangler-squared', 'Slack']);
  assert.deepEqual([...panel.querySelectorAll('.job-launch-steps li small')].map((s) => s.textContent), ['wrangler-squared', 'wrangler-squared', 'agent · 1 write']);
  assert.ok(panel.querySelector('.job-launch-go .gx[data-arc][data-tone="warn"]'), 'the event horizon is the button');
  assert.equal(panel.querySelector('.job-launch-label b').textContent, 'Create job');
  assert.match(panel.querySelector('.job-launch-fine').textContent, /Plan on You review/);
  panel.querySelector('[data-accept-idea]').click();
  assert.ok(f.q('.job-launch').classList.contains('firing'), 'the hole flares first');
  assert.equal(f.sent.filter((m) => m.action === 'accept-idea').length, 0);
  t.mock.timers.tick(900);
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'idea1', subJobId: undefined, action: 'accept-idea', messageId: 'm3' });
  assert.ok(f.q('.job-launch').classList.contains('done'));
  f.view.created({ event: 'job-action-complete', jobId: 'idea1', action: 'accept-idea' });
  assert.ok(f.q('#job-dialog').open, 'the dialog stays for the plan');
  Object.assign(f.data.jobs[0], { title: suggest.title, plan: suggest.plan, runs: [parked({ stopped: true })] });
  f.data.jobs[0].idea.thread[2].acceptedAt = 5;
  f.view.update(f.data);
  assert.equal(f.q('#job-dialog .job-idea'), null, 'the plan review takes over');
  assert.ok(f.q('#job-dialog [data-action="approve-plan"]'));
  assert.ok(f.q('#job-dialog details[data-keep="idea"] .job-launch.done'), 'the conversation is folded under the plan');
  assert.equal(f.q('[data-board="idea1"] .job-status').textContent, 'Plan ready');
});

test('a suggestion something newer was said after is stale and cannot be pressed', (t) => {
  const f = fixture(t, [ideaJob([{ id: 'm3', at: 4, from: 'planner', text: 'Here.', suggest }, { id: 'm4', at: 5, from: 'human', text: 'Also Slack', sentAt: null }])]);
  f.q('[data-board="idea1"] .job-plate-open').click();
  const panel = f.q('.job-launch');
  assert.ok(panel.classList.contains('stale'));
  assert.match(panel.querySelector('.job-launch-fine').textContent, /Replaced by a newer reply/);
  panel.querySelector('[data-accept-idea]').click();
  assert.equal(f.sent.filter((m) => m.action === 'accept-idea').length, 0);
  assert.equal(liveSuggestion(f.data.jobs[0]), null);
  assert.equal(ideaStage(f.data.jobs[0]), 'thinking', 'an unsent reply is the planner\'s turn');
});

test('on the board an idea waiting on you is a needs-you stub; one the planner is on is working', () => {
  const reply = ideaJob([asked]), suggested = ideaJob([{ id: 'm3', at: 4, from: 'planner', text: 'Here.', suggest }]), thinking = ideaJob([], [parked({ parkedAt: null })]);
  assert.deepEqual([ideaStage(reply), ideaStage(suggested), ideaStage(thinking)], ['reply', 'suggested', 'thinking']);
  assert.deepEqual([jobNeedsReview(reply, null), jobNeedsReview(suggested, null), jobNeedsReview(thinking, null)], [true, true, false]);
  assert.deepEqual([plateAsk(reply).label, plateAsk(reply).button], ['Your reply', 'Reply']);
  assert.deepEqual([plateAsk(suggested).label, plateAsk(suggested).detail], ['Job suggested', '2 PRs · 1 session · 1 write · wrangler-squared']);
  assert.equal(plateAsk(thinking), null);
  assert.deepEqual(jobStatus(thinking, null), { tone: 'working', text: 'Planner is reading the idea' });
  assert.equal(ideaStage({ ...reply, idea: undefined }), null, 'a job not made from New idea has no conversation');
});

test('the planner\'s prose is escaped before it is marked up, and a summary counts only the work', () => {
  assert.equal(proseHtml('a `b<c>` d\n\n- one\n- two'), '<p>a <code>b&lt;c&gt;</code> d</p><ul><li>one</li><li>two</li></ul>');
  assert.equal(proseHtml('Two things:\n1. Whose CI?\n   a) ours\n2. Which pain?\nIf you mean (a), I would'), '<p>Two things:</p><ol><li>Whose CI?<br>a) ours</li><li>Which pain?</li></ol><p>If you mean (a), I would</p>');
  const s = suggestionSummary(suggest.plan);
  assert.deepEqual([s.work.length, s.repos.length, s.line], [3, 1, '3 sub-jobs · wrangler-squared · Slack']);
});

test('an idea is a plate under a forming sky, tagged IDEA, idle while the planner thinks and amber when it waits on you', (t) => {
  const thinking = { ...ideaJob([], [parked({ parkedAt: null })]), id: 'think' }, reply = { ...ideaJob([asked]), id: 'reply' };
  const suggested = { ...ideaJob([{ id: 'm3', at: 4, from: 'planner', text: 'Here.', suggest }]), id: 'sugg' }, backlog = { ...ideaJob([], []), id: 'later', stage: 'backlog' };
  const job = { id: 'job', title: 'A job', intent: 'x', repos: ['/r'], stage: 'active', plan: suggest.plan, subJobs: [{ id: 'a', title: 'A', repo: '/r', after: [], stage: 'pr', sessions: [], repairs: [] }], runs: [], moves: [], createdAt: 0 };
  const sky = (html) => html.match(/class="gx nb"[^>]*data-stage="(\d)"/)?.[1];
  assert.deepEqual([thinking, reply, suggested, backlog].map((j) => sky(plateHtml(j, 'opus'))), ['0', '1', '2', '0'], 'the point brightens as the planner asks, then suggests');
  assert.equal(plateHtml(job, 'opus').includes('gx nb'), false, 'a job keeps its black hole');
  assert.match(plateHtml(thinking, 'opus'), /class="job-plate idea tone-idle /);
  assert.match(plateHtml(reply, 'opus'), /class="job-plate idea tone-warn /);
  assert.match(plateHtml(thinking, 'opus', 'full'), /class="gx nb"/, 'with launch-page scenes too: an idea has no scene yet');
  const f = fixture(t, [job, thinking, reply, suggested, backlog]);
  const ideaPlate = f.q('[data-board="reply"]');
  assert.ok(ideaPlate.classList.contains('idea'));
  assert.equal(ideaPlate.querySelector('.job-plate-tag').textContent, 'Idea');
  assert.equal(ideaPlate.querySelector('.job-plate-idea').textContent, '2 messages');
  assert.equal(f.q('[data-board="think"] .job-status').textContent, 'Planner is reading the idea');
  f.q('[data-filter="ideas"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-plate')].map((p) => p.dataset.board).sort(), ['later', 'reply', 'sugg', 'think'], 'the Ideas filter shows only ideas');
  assert.equal(f.q('[data-filter="ideas"] .jobs-rail-n').textContent, '4');
  f.q('[data-board="reply"] .job-plate-open').click();
  assert.ok(f.q('#job-dialog .job-idea-band .gx.nb'), 'clicking an idea opens its conversation');
  assert.ok(f.q('#job-dialog [data-idea-composer]'));
});

test('an accepted idea becomes a job plate, folding its cloud into the job\'s sky once', async (t) => {
  const idea = ideaJob([{ id: 'm3', at: 4, from: 'planner', text: 'Here.', suggest }]);
  const f = fixture(t, [idea]);
  assert.ok(f.q('[data-board="idea1"]').classList.contains('idea'));
  Object.assign(f.data.jobs[0], { plan: suggest.plan, title: suggest.title, runs: [{ ...parked(), stopped: true }] });
  f.data.jobs[0].idea.thread[0].acceptedAt = 5;
  f.view.update(f.data);
  const plate = f.q('[data-board="idea1"]'), art = plate.querySelector('.job-plate-art');
  assert.equal(plate.classList.contains('idea'), false, 'now a job plate');
  assert.ok(art.classList.contains('collapsing'));
  assert.ok(art.querySelector(':scope > .gx.nb') && art.querySelector(':scope > .gx:not(.nb)'), 'the cloud over the job\'s own sky');
  assert.equal(plate.querySelectorAll('.job-plate-graph .node').length, 4, 'the plan it became, its write a moon');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(art.classList.contains('collapsed'), 'then it folds in');
  f.view.update(f.data);
  assert.ok(f.q('[data-board="idea1"] .job-plate-art').classList.contains('collapsed'), 'a redraw mid-fold keeps it folded');
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(f.q('[data-board="idea1"] .gx.nb'), null, 'and after it the cloud is gone');
});
