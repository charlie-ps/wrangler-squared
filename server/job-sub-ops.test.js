import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSub, keyStory, reworkSub, validatePlan } from './job-sub-ops.js';
import { requestChange, changeView } from './job-change.js';
import { requestReplan } from './job-replan.js';
import { askToReplan } from './job-talk.js';
import { awaitsTicket, withStoryCreates } from './jobs-schema.js';
import { buildSubJob } from './job-store.js';

// The pure surface: job-store.js hands these the draft it is about to persist, so
// everything here is a plain object with no disk behind it.
const planSub = (id, extra = {}) => ({ id, title: `Deliver ${id}`, kind: 'pr', repo: '/repo', storyId: 'story', after: [], brief: `Implement ${id}`, ...extra });
function job({ subs = [planSub('api')], stories = [{ id: 'story', key: 'AUTH-1', title: 'Sign-in' }], runs = [], live } = {}) {
  const plan = { context: 'Shared context', stories, subJobs: structuredClone(subs) };
  return { id: 'job_1', stage: 'active', revision: 1, plan, runs, subJobs: live || plan.subJobs.map((s) => buildSubJob(plan, s)) };
}
const PR = 'https://github.com/org/repo/pull/1';
const ask = (j, subId, text = 'Rename it') => {
  const sub = subId ? j.subJobs.find((s) => s.id === subId) : null;
  return requestChange(j, sub, { ...changeView(j, sub), text }, { now: 1000 });
};
// The ask run that read the idea (its launch marks the asks read, job-store.js claim)
// proposes a change (job-talk.js askToReplan).
const readBy = (j, convo) => { for (const a of j.convos.find((c) => c.id === convo).pending.asks) a.sentAt ??= 1000; return { id: 'run_a', convo }; };
const handOver = (j) => askToReplan(j, readBy(j, j.talk.at(-1).convo), requestReplan, 1001);

test('a plan edit is judged by the plan schema it was approved under, without punishing a migrated brief', () => {
  const j = job({ subs: [planSub('api'), planSub('web', { brief: 'x'.repeat(900) })] });
  assert.doesNotThrow(() => validatePlan(j.plan));
  const edit = (...changes) => ({ ...j.plan, subJobs: j.plan.subJobs.map((s) => ({ ...s, ...(changes.find(([id]) => id === s.id)?.[1] || {}) })) });
  assert.throws(() => validatePlan(edit(['web', { after: ['ghost'] }])), /Unknown dependency/);
  assert.doesNotThrow(() => validatePlan(edit(['web', { after: ['api'] }])));
  assert.throws(() => validatePlan(edit(['web', { after: ['api'] }], ['api', { after: ['web'] }])), /cycles/);
});

test('reworkSub follows the code-review flag: back to work under review, a repair commit without it', () => {
  const open = (extra = {}) => { const j = job(); Object.assign(j, extra); Object.assign(j.subJobs[0], { stage: 'pr', state: 'watching', pr: { url: PR, head: 'h1' }, ready: { checks: ['x'], receiptId: 'run_1' } }); return j; };
  const reviewed = open();
  assert.match(reworkSub(reviewed, reviewed.subJobs[0], 'Rename it', 1000), /back to work on its PR/);
  assert.deepEqual([reviewed.subJobs[0].stage, reviewed.subJobs[0].state, reviewed.subJobs[0].note, reviewed.subJobs[0].fixRequested, reviewed.subJobs[0].ready],
    ['implementation', 'queued', 'Rename it', null, null]);
  assert.equal(reviewed.subJobs[0].pr.url, PR, 'the PR is kept: the approved tree is pushed to it');
  const direct = open({ reviewCode: false });
  assert.match(reworkSub(direct, direct.subJobs[0], 'Rename it', 1000), /new commit on/);
  assert.deepEqual([direct.subJobs[0].stage, direct.subJobs[0].fixRequested.note, direct.subJobs[0].repairAllowance], ['pr', 'Rename it', 1]);
});

test('every idea goes to the planner, noting the step and view it was typed on', () => {
  const at = (stage, extra = {}) => { const j = job(); Object.assign(j.subJobs[0], { stage, ...extra }); return j; };
  const code = at('review', { state: 'verified', ready: { checks: ['x'], receiptId: 'run_1', round: 2 } });
  code.runs.push({ id: 'run_1', subJobId: 'api', stopped: false, parkedFor: 'ready' });
  assert.equal(requestChange(code, code.subJobs[0], { ...changeView(code, code.subJobs[0]), text: 'Tighten the spacing', attachments: [{ file: 'ask-1.png', mime: 'image/png', path: '/rounds/2/ask-1.png' }] }, { now: 1000 }).route, 'planner');
  assert.deepEqual([code.subJobs[0].stage, code.subJobs[0].thread], ['review', undefined], 'nothing reaches the open session before the human approves');
  assert.equal(code.replan, undefined, 'the wrangler reads it first, holding nothing');
  assert.equal(code.convos[0].pending.asks.length, 1);
  handOver(code);
  assert.deepEqual(code.replan.source, { sub: 'api', at: 'code', ref: 'run_1', state: 'review/verified' });
  assert.deepEqual(code.replan.images, [{ sub: 'api', round: 2, file: 'ask-1.png', mime: 'image/png', path: '/rounds/2/ask-1.png' }]);
  assert.match(code.replan.feedback, /^About “Deliver api” \(api, review\/verified\): Tighten the spacing\n\(Pasted images, read them: "\/rounds\/2\/ask-1.png"\)$/);
  const open = at('pr', { state: 'watching', pr: { url: PR, head: 'h1' } });
  assert.equal(changeView(open, open.subJobs[0]).ref, 'h1');
  assert.equal(ask(open, 'api').route, 'planner');
  handOver(open);
  assert.deepEqual([open.subJobs[0].stage, open.replan.source], ['pr', { sub: 'api', at: 'pr', ref: 'h1', state: 'pr/watching' }]);
  const result = job({ subs: [session('spike')] });
  Object.assign(result.subJobs[0], { stage: 'review', state: 'verified', result: { checks: ['x'], receiptId: 'run_2' } });
  assert.equal(ask(result, 'spike').route, 'planner');
  handOver(result);
  assert.deepEqual([result.subJobs[0].stage, result.subJobs[0].feedback, result.replan.source.at], ['review', undefined, 'session']);
  const whole = job();
  assert.equal(ask(whole, null).route, 'planner');
  handOver(whole);
  assert.deepEqual([whole.replan.feedback, whole.replan.source, whole.replan.images], ['Rename it', undefined, undefined]);
  const merged = at('deployment', { state: 'watching' });
  assert.equal(ask(merged, 'api').route, 'planner');
  handOver(merged);
  assert.match(merged.replan.feedback, /^About “Deliver api” \(api, deployment\/watching\): Rename it$/);
  for (const stage of ['cleanup', 'done']) assert.throws(() => ask(at(stage), 'api'), /Nothing is left to change/, stage);
  assert.throws(() => ask(at('pr', { cancelledAt: 5 }), 'api'), /Nothing is left to change/);
  assert.doesNotThrow(() => requestChange(open, open.subJobs[0], { text: 'Typed before h1 landed' }, { now: 1 }), 'a head that moved does not refuse it: the wrangler judges');
  assert.throws(() => requestChange(open, open.subJobs[0], { text: '  ' }, { now: 1 }), /Explain/);
  const busy = job(); busy.runs.push({ id: 'run_p', subJobId: null, stopped: false });
  assert.equal(ask(busy, 'api').detail, 'Asked Wrangler about “Deliver api”');
  assert.deepEqual(handOver(busy), { queued: 1 }, 'its change queues behind the one Wrangler is drawing');
  assert.ok(!busy.replan); assert.equal(busy.replanQueue[0].source.sub, 'api');
});

test('a second idea adds to the waiting proposal: earlier words, plan and actions all carry over', () => {
  const j = job({ subs: [planSub('api'), planSub('web')] });
  ask(j, null, 'Add CSV export'); handOver(j);
  j.replan.proposal = { id: 'run_p', plan: j.plan, actions: [{ type: 'rework', sub: 'web', note: 'Return 204', pin: { at: 'stage', ref: 'implementation' } }] };
  ask(j, 'api', 'And make it smaller');
  assert.ok(j.replan.proposal, 'a proposal stays up while the wrangler reads the next idea');
  handOver(j);
  assert.equal(j.replan.proposal, null);
  assert.deepEqual(j.replan.earlier, ['Add CSV export']);
  assert.match(j.replan.feedback, /^About “Deliver api”.*And make it smaller$/s);
  assert.deepEqual(j.replan.previous, j.plan);
  assert.deepEqual(j.replan.previousActions, [{ type: 'rework', sub: 'web', note: 'Return 204' }], 'pins are stamped afresh on the new proposal');
  assert.equal(j.replan.source.sub, 'api');
});

const session = (id, extra = {}) => ({ id, title: `Run ${id}`, kind: 'session', after: [], brief: `Do ${id}`, ...extra });
const jiraW = (id, by, action, extra = {}) => ({ id, kind: 'write', title: `Write ${id}`, place: { type: 'jira' }, storyId: 'new', after: [], by, action, ...extra });
const keyless = () => job({ stories: [{ id: 'new', project: 'SEC', title: 'Audit' }],
  subs: [session('stories', { stories: true }), jiraW('create-new', 'stories', { type: 'create' }), jiraW('move', 'ship', { type: 'transition', to: 'Done' }),
    planSub('api', { storyId: 'new' }), session('ship')] });

test('a created story\'s key is on the plan and on every sub-job naming it, and never swaps once approved', () => {
  const j = keyless();
  const at = (id) => j.subJobs.find((s) => s.id === id);
  keyStory(j, 'new', 'SEC-4');
  assert.equal(j.plan.stories[0].key, 'SEC-4');
  assert.deepEqual([at('api').jiraKey, at('move').jiraKey, j.plan.subJobs.find((s) => s.id === 'api').jiraKey], ['SEC-4', 'SEC-4', 'SEC-4']);
  assert.throws(() => keyStory(j, 'new', 'SEC-5'), /approved as SEC-4/);
  assert.throws(() => keyStory(j, 'ghost', 'SEC-5'), /Unknown story/);
});

test('dropping a story\'s create before it has a key unlinks the story: its work goes ahead ticketless, its Jira writes are dropped, and nothing creates it again', () => {
  const j = keyless();
  const at = (id) => j.subJobs.find((s) => s.id === id);
  assert.equal(awaitsTicket(at('api')), true);
  dropSub(at('create-new'), 1000, j);
  assert.equal(j.plan.stories[0].dropped, true);
  assert.equal(at('api').storyId, undefined); assert.equal(awaitsTicket(at('api')), false);
  assert.equal(j.plan.subJobs.find((s) => s.id === 'api').storyId, undefined);
  assert.equal(at('move').cancelledAt, 1000, 'a write to the ticket has nothing to write to');
  assert.equal(j.plan.subJobs.find((s) => s.id === 'move').storyId, 'new', 'its plan entry stays the record');
  assert.doesNotThrow(() => validatePlan(j.plan));
  assert.equal(withStoryCreates({ ...j.plan, subJobs: j.plan.subJobs.filter((s) => s.id !== 'create-new') }).subJobs.length, j.plan.subJobs.length - 1, 'a dropped story is never created again');
  const keyed = job({ stories: [{ id: 'new', key: 'SEC-1', title: 'Audit' }], subs: [session('stories'), jiraW('create-new', 'stories', { type: 'create' }), planSub('api', { storyId: 'new' })] });
  dropSub(keyed.subJobs[1], 1000, keyed);
  assert.deepEqual([keyed.plan.stories[0].dropped, keyed.subJobs[2].storyId], [undefined, 'new'], 'a story with its key is unaffected');
});


test('the sub-job cap counts the story creates approval would add, once', () => {
  const plan = (n, stories) => ({ context: '', stories, subJobs: Array.from({ length: n }, (_, i) => planSub(`p${i}`, { storyId: stories[i % stories.length].id })) });
  const keyless = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  assert.doesNotThrow(() => validatePlan(plan(77, keyless)), '77 + a stories session + 2 creates is 80');
  assert.throws(() => validatePlan(plan(78, keyless)), /Too many sub-jobs: 78 planned plus 3 to create stories exceeds 80/);
  assert.doesNotThrow(() => validatePlan(withStoryCreates(plan(77, keyless))), 'creates already in the plan are not counted again');
  assert.doesNotThrow(() => validatePlan(plan(80, [{ id: 'a', key: 'A-1', title: 'A' }])));
  const stories = withStoryCreates(plan(1, keyless));
  assert.throws(() => validatePlan({ ...stories, subJobs: [...stories.subJobs, { id: 'post', kind: 'write', title: 'Post', place: { type: 'slack', ref: '#x' }, after: [], by: 'stories', action: { type: 'post', text: 'Hi' } }] }),
    /post: stories only creates the job's stories/, 'the session that skips result review does nothing else');
});
