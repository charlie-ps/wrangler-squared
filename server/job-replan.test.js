import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFrozen, mergeReplan, approveReplan, replanStatus, requestReplan, discardReplan, startQueued, queuedReady } from './job-replan.js';
import { jobPrompt } from './job-prompts.js';
import { replanAsked } from '../public/replan-asks.js';

const spec = (id, after = [], extra = {}) => ({ id, title: `Deliver ${id}`, kind: 'pr', repo: '/repo', after, brief: `Implement ${id}`, ...extra });
const live = (s, extra = {}) => ({ ...s, stage: 'implementation', state: 'queued', ...extra });
const job = (subs, live = []) => ({ plan: { context: 'ctx', stories: [{ id: 's', key: 'A-1', title: 'Story' }], subJobs: subs }, subJobs: live, runs: [] });

test('frozen is merged, landed, finished or dropped', () => {
  assert.equal(isFrozen({ stage: 'pr' }), false);
  assert.equal(isFrozen({ stage: 'review' }), false);
  for (const s of [{ stage: 'deployment' }, { stage: 'cleanup' }, { stage: 'done' }, { stage: 'pr', mergedAt: 1 }, { stage: 'implementation', cancelledAt: 1 }]) assert.equal(isFrozen(s), true, JSON.stringify(s));
});

test('a frozen sub-job left out of a proposal is carried over; nothing may wait on a dropped one; story keys hold', () => {
  const subs = [spec('a'), spec('b'), spec('c')];
  const j = job(subs, [live(subs[0], { stage: 'done' }), live(subs[1], { cancelledAt: 1, stage: 'cleanup' }), live(subs[2])]);
  const { plan, changes } = mergeReplan(j, { context: '', stories: [], subJobs: [spec('c', [], { check: 'It works' })] });
  assert.deepEqual(plan.subJobs.map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(plan.context, 'ctx', 'an empty context keeps the one every session already had');
  assert.deepEqual(changes.edited, [{ id: 'c', fields: ['check'] }]);
  assert.throws(() => mergeReplan(j, { context: '', stories: [], subJobs: [spec('b'), spec('c', ['b'])] }), /c would wait forever on b/);
  assert.throws(() => mergeReplan(j, { context: '', stories: [{ id: 's', key: 'A-2', title: 'x' }], subJobs: [spec('c')] }), /approved as A-1/);
  assert.throws(() => mergeReplan(j, { context: '', stories: [], subJobs: [spec('c', [], { kind: 'session', repo: undefined })] }), /kind, repo cannot change/);
});

test('an approved brief or landing-order change sends code already written back to work; a title alone does not', () => {
  const subs = [spec('a'), spec('b'), spec('c'), spec('d'), spec('e')];
  const pr = { url: 'https://github.com/o/r/pull/1', head: 'h1', checkStatus: 'passing' };
  const at = (j, id) => j.subJobs.find((s) => s.id === id);
  const fresh = (reviewCode) => ({ ...job(subs, [live(subs[0]), live(subs[1], { stage: 'pr', state: 'watching', pr, mergeApprovedHead: 'h1' }),
    live(subs[2], { stage: 'review', state: 'approved', ready: { receiptId: 'r1' } }), live(subs[3], { stage: 'pr', state: 'watching', pr }),
    live(subs[4], { stage: 'implementation', pr })]), reviewCode,
    replan: { feedback: 'Land b after a', proposal: { id: 'p1', plan: { context: '', stories: [], subJobs: [spec('a'), spec('b', ['a'], { brief: 'Build b on a' }),
      spec('c', [], { brief: 'Smaller c' }), spec('d', [], { title: 'Renamed d' }), spec('e', ['a'])] } } } });
  const j = fresh(false);
  const { lines } = approveReplan(j, 'p1', { now: 5 });
  const b = at(j, 'b');
  assert.equal(b.stage, 'implementation', 'back to work on its PR, whatever Code review is set to'); assert.equal(b.mergeApprovedHead, null, 'the approval was for the old brief');
  assert.deepEqual([b.note, b.pr.url], ['Land b after a\n\nNew brief: Build b on a', pr.url]);
  assert.equal(at(j, 'c').stage, 'implementation', 'an uncommitted tree goes back to work, its approval withdrawn');
  assert.equal(at(j, 'c').ready, null); assert.match(at(j, 'c').note, /New brief: Smaller c/);
  assert.equal(at(j, 'd').fixRequested, undefined, 'a new title asks nothing of the code');
  assert.equal(at(j, 'e').note, undefined, 'still being worked: the next session reads the new brief anyway');
  assert.deepEqual(lines.map((l) => l.detail).filter((d) => !/^Plan change/.test(d)), ['Sent “Deliver b” back to work on its PR', 'Sent “Deliver c” back to work']);

  const k = fresh(true); approveReplan(k, 'p1', { now: 5 });
  assert.equal(at(k, 'b').stage, 'implementation', 'and the same under code review');
  assert.equal(at(k, 'b').fixRequested, null); assert.match(at(k, 'b').note, /^Land b after a/);
});

test('an approved brief or after change sends a blocked step with no code back to wait on it; any other edit leaves it red', () => {
  const blocked = { error: 'Blocked: needs a fix first', blocked: { summary: 'Needs a fix first', kind: 'blocked', phase: 'session', at: 1 }, red: { attempts: [{ outcome: 'proposed' }], held: 'r', declared: { ref: 'r' } } };
  const subs = [session('s'), spec('p'), session('t')];
  const at = (j, id) => j.subJobs.find((x) => x.id === id);
  const j = job(subs, [live(subs[0], { stage: 'session', state: 'failed', ...structuredClone(blocked) }), live(subs[1], { state: 'failed', ...structuredClone(blocked) }),
    live(subs[2], { stage: 'session', state: 'failed', ...structuredClone(blocked) })]);
  j.replan = { feedback: 'Land a fix first', proposal: { id: 'p1', plan: { context: '', subJobs: [spec('fix'), session('s', { after: ['fix'] }), spec('p', [], { brief: 'Implement p on the fix' }),
    session('t', { title: 'Renamed t' })] } } };
  const { lines } = approveReplan(j, 'p1', { now: 5, buildSubJob: (p, s) => live(s) });
  for (const id of ['s', 'p']) {
    const s = at(j, id);
    assert.deepEqual([s.state, s.error, s.blocked], ['queued', null, null], `${id} waits on its prerequisites again`);
    assert.deepEqual([s.red.held, s.red.declared, s.red.attempts.length], [null, null, 1], 'the decision about the old red is gone; its history is kept');
  }
  assert.equal(at(j, 's').stage, 'session'); assert.deepEqual(at(j, 's').after, ['fix']);
  assert.equal(at(j, 'p').stage, 'implementation'); assert.equal(at(j, 'p').brief, 'Implement p on the fix');
  assert.deepEqual([at(j, 't').title, at(j, 't').state, at(j, 't').error], ['Renamed t', 'failed', 'Blocked: needs a fix first'], 'a new title asks nothing of the step');
  assert.deepEqual(lines.map((l) => l.detail).filter((d) => !/^Plan change/.test(d)), ['Sent “Run s” back to wait for its new brief', 'Sent “Deliver p” back to wait for its new brief']);
});

const write = (id, by, action, extra = {}) => ({ id, kind: 'write', place: { type: 'jira' }, title: `Write ${id}`, storyId: 's', after: [], by, action, ...extra });
const session = (id, extra = {}) => ({ id, title: `Run ${id}`, kind: 'session', after: [], brief: `Do ${id}`, ...extra });
const liveOf = (subs) => subs.map((s) => live(s, s.kind === 'write' ? { stage: 'write' } : s.kind === 'session' ? { stage: 'session' } : {}));

test('a Jira write edits like a brief: its action, session, review and why change in place, a session\'s milestone with it; its story does not', () => {
  const subs = [spec('a', [], { storyId: 's' }), session('n', { on: { sub: 'a', at: 'pr' } }), session('m'), write('w', 'n', { type: 'transition', to: 'In Review' })];
  const j = job(subs, subs.map((s) => live(s, s.kind === 'write' ? { stage: 'review', state: 'verified', writeApprovedAt: 1, draft: { id: 'w' } } : s.kind === 'session' ? { stage: 'session' } : {})));
  const { plan, changes } = mergeReplan(j, { context: '', subJobs: [subs[0], { ...subs[1], on: { sub: 'a', at: 'merged' } }, subs[2], write('w', 'm', { type: 'transition', to: 'Done', comment: 'Merged {pr.url}' }, { review: true, why: 'Done on merge here' })] });
  assert.deepEqual(changes.edited, [{ id: 'n', fields: ['on'] }, { id: 'w', fields: ['action', 'by', 'review', 'why'] }]);
  assert.deepEqual(plan.subJobs[1].on, { sub: 'a', at: 'merged' }); assert.equal(plan.subJobs[3].review, true);
  assert.deepEqual(mergeReplan(j, { context: '', subJobs: [...subs.slice(0, 3), { ...subs[3], review: false }] }).changes.edited, [{ id: 'w', fields: ['review'] }], 'an explicit review:false overrides the job default, so it is an edit');
  assert.throws(() => mergeReplan(j, { context: '', stories: [{ id: 't', title: 'Other' }], subJobs: [...subs.slice(0, 3), { ...subs[3], storyId: 't' }] }), /storyId cannot change/);
  assert.throws(() => mergeReplan(j, { context: '', subJobs: [...subs.slice(0, 3), { ...subs[3], on: { sub: 'a', at: 'pr' } }] }), /put the milestone \(on\) on that session/);
  const replan = { feedback: 'x', proposal: { id: 'p', plan: { context: '', subJobs: [...subs.slice(0, 3), { ...subs[3], action: { type: 'transition', to: 'QA' } }] } } };
  const busy = { ...structuredClone(j), runs: [{ subJobId: 'n', stopped: false, parkedAt: 1 }], replan: structuredClone(replan) };
  assert.throws(() => approveReplan(busy, 'p', { now: 1, buildSubJob: (p, s) => s }), /Wait for the running step on “Write w” to stop/, 'its session was told the write as it stood');
  const approved = { ...j, replan };
  approveReplan(approved, 'p', { now: 1, buildSubJob: (p, s) => s });
  const w = approved.subJobs[3];
  assert.deepEqual([w.stage, w.state, w.writeApprovedAt, w.draft], ['write', 'queued', undefined, undefined], 'an edited write goes back to its session, and a reviewed one is drafted again');
});

test('cancelling a trigger strands every session on it but an if-dropped one, unless its milestone already came; a session takes its writes with it', () => {
  const subs = [spec('a', [], { storyId: 's' }), spec('b', [], { storyId: 's' }), session('n', { on: { sub: 'a', at: 'pr' } }), session('wont', { on: { sub: 'a', at: 'dropped' } }),
    write('w', 'n', { type: 'comment', comment: 'x' }), write('ww', 'wont', { type: 'transition', to: "Won't Do" })];
  const j = job(subs, liveOf(subs));
  assert.throws(() => mergeReplan(j, { context: '', subJobs: [subs[1], ...subs.slice(2)] }), /n would wait forever on a/);
  assert.deepEqual(mergeReplan(j, { context: '', subJobs: [subs[1], subs[3], subs[5]] }).changes.removed.sort(), ['a', 'n', 'w'], 'the if-dropped session is what removing its trigger starts');
  j.subJobs[0].pr = { url: 'https://github.com/o/r/pull/1' };
  assert.doesNotThrow(() => mergeReplan(j, { context: '', subJobs: [subs[1], ...subs.slice(2)] }), 'a PR that already opened has reached pr');
});

test('a create write and its session outlive a proposal that leaves them out; a new keyless story joins that session while it has not started', () => {
  const stories = session('stories', { title: 'Create Jira stories' });
  const create = write('create-n', 'stories', { type: 'create' }, { storyId: 'n' });
  const subs = [stories, create, spec('a', [], { storyId: 'n' })];
  const j = { ...job(subs, liveOf(subs)), plan: { context: 'ctx', stories: [{ id: 'n', title: 'New' }], subJobs: subs } };
  const { plan, changes } = mergeReplan(j, { context: '', stories: [{ id: 'm', project: 'SEC', title: 'More' }], subJobs: [subs[2], spec('b', [], { storyId: 'm' })] });
  assert.ok(changes.kept.includes('create-n')); assert.ok(changes.kept.includes('stories')); assert.deepEqual(changes.removed, []);
  assert.deepEqual(changes.added, ['b', 'create-m']);
  assert.deepEqual(plan.subJobs.find((s) => s.id === 'create-m'), { id: 'create-m', title: 'Create story: More', kind: 'write', place: { type: 'jira' }, storyId: 'm', after: [], action: { type: 'create' }, by: 'stories' });
  assert.match(replanStatus(j, j.subJobs[1]), /\(write\) "Write create-n": write\/queued · \{"type":"jira"\} \{"type":"create"\} by stories/);
  j.subJobs[0].sessions = ['s1'];
  const later = mergeReplan(j, { context: '', stories: [{ id: 'm', project: 'SEC', title: 'More' }], subJobs: [subs[2], spec('b', [], { storyId: 'm' })] });
  assert.deepEqual(later.changes.added, ['b', 'stories-2', 'create-m'], 'a stories session that has run takes no more');
  assert.equal(later.plan.subJobs.find((s) => s.id === 'create-m').by, 'stories-2');
});

test('a write may change its channel, page or making session but not its place type; a write goes with its session', () => {
  const post = { id: 'post', kind: 'write', title: 'Announce', place: { type: 'slack', ref: '#web' }, after: [], by: 'r2', action: { type: 'post', text: 'Out: {page.url}' }, review: true };
  const page = { id: 'page', kind: 'write', title: 'Report', place: { type: 'artifact' }, after: [], by: 'r', action: { type: 'make', what: 'p95 chart' } };
  const subs = [session('r'), session('r2', { after: ['r'] }), post, page];
  const j = job(subs, liveOf(subs));
  const moved = mergeReplan(j, { context: '', subJobs: [subs[0], subs[1], { ...post, place: { type: 'slack', ref: '#web-platform' } }, page] });
  assert.deepEqual(moved.changes.edited, [{ id: 'post', fields: ['place'] }]);
  assert.throws(() => mergeReplan(j, { context: '', subJobs: [subs[0], subs[1], { ...post, place: { type: 'confluence', ref: 'WEB' } }, page] }), /place.type cannot change/);
  assert.throws(() => mergeReplan(j, { context: '', subJobs: [subs[0], { ...subs[1], after: [] }, post, page] }), /\{page\.url\} is made by r, so r2 must wait for r to finish/);
  const { changes } = mergeReplan(j, { context: '', subJobs: [session('r2'), { ...post, action: { type: 'post', text: 'Out' } }, page] });
  assert.deepEqual(changes.removed.sort(), ['page', 'r'], 'the write its session would have made is cancelled with it');
  assert.throws(() => mergeReplan(j, { context: '', subJobs: [session('r2'), { ...post, action: { type: 'post', text: 'Out' } }, page, { ...page, id: 'page2' }] }), /page2 would never be made: r is being cancelled/);
  assert.match(replanStatus(j, j.subJobs[3]), /\{"type":"artifact"\} \{"type":"make","what":"p95 chart"\} by r/);
});

test('a new keyless story keeps the fields the planner read for it, and an approved story keeps the fields it was approved with', () => {
  const fields = [{ name: 'Issue Type', value: 'Story' }, { name: 'Components', value: 'Auth' }];
  const subs = [spec('a', [], { storyId: 's' })];
  const j = job(subs, subs.map((s) => live(s)));
  j.plan.stories[0].fields = [{ name: 'Labels', value: 'sso' }];
  const { plan } = mergeReplan(j, { context: '', stories: [{ id: 's', key: 'A-1', title: 'Story', fields: [{ name: 'Labels', value: 'other' }] }, { id: 'm', project: 'SEC', title: 'More', fields }], subJobs: [subs[0], spec('b', [], { storyId: 'm' })] });
  assert.deepEqual(plan.stories.find((t) => t.id === 'm').fields, fields);
  assert.deepEqual(plan.stories.find((t) => t.id === 's').fields, [{ name: 'Labels', value: 'sso' }]);
});

test('a write added or moved to a session that has finished is refused; to one running it waits; to one in review it sends it back to work', () => {
  const w = write('w', 'r', { type: 'comment', comment: 'Hi' });
  const subs = [session('r'), session('r2'), session('done'), w];
  const at = (j, id) => j.subJobs.find((s) => s.id === id);
  const fresh = () => {
    const j = job(subs, liveOf(subs));
    at(j, 'done').stage = 'done';
    return j;
  };
  const added = write('w2', 'done', { type: 'comment', comment: 'Late' });
  assert.throws(() => mergeReplan(fresh(), { context: '', subJobs: [...subs, added] }), /w2: done has already finished, so it would never make this write/);
  assert.throws(() => mergeReplan(fresh(), { context: '', subJobs: [...subs.slice(0, 3), { ...w, by: 'done' }] }), /w: done has already finished/);
  const rerun = fresh(); at(rerun, 'done').stage = 'session'; at(rerun, 'done').writesOnly = { from: 'done' };
  assert.throws(() => mergeReplan(rerun, { context: '', subJobs: [...subs, added] }), /done has already finished/, 'a rerun for its writes alone takes no new ones');
  const propose = (j, plan) => { j.replan = { feedback: 'More', proposal: { id: 'p1', plan } }; return j; };
  const toR2 = { context: '', subJobs: [...subs.slice(0, 3), { ...w, by: 'r2' }, write('w3', 'r2', { type: 'comment', comment: 'New' })] };
  const busy = propose(fresh(), toR2);
  busy.runs.push({ subJobId: 'r2', stopped: false, parkedAt: 1 });
  assert.throws(() => approveReplan(busy, 'p1', { now: 2, buildSubJob: (p, s) => ({ ...s }) }), /Wait for the running step on “Write w” · “Write w3” to stop/, 'a parked run is still live');
  const review = propose(fresh(), toR2);
  Object.assign(at(review, 'r2'), { stage: 'review', state: 'verified', result: { checks: ['Done'] } });
  const { lines } = approveReplan(review, 'p1', { now: 3, buildSubJob: (p, s) => ({ ...s, stage: 'write', state: 'queued' }) });
  assert.deepEqual([at(review, 'r2').stage, at(review, 'r2').state, at(review, 'r2').result], ['session', 'queued', null]);
  assert.equal(lines.filter((l) => l.sub.id === 'r2').length, 1, 'said once, however many writes it gained');
  assert.match(lines.find((l) => l.sub.id === 'r2').detail, /sent “Run r2” back to work/);
});

test('a PR\'s base moves in a replan until its worktree or PR exists, then it is fixed', () => {
  const subs = [spec('a'), spec('b', [], { base: 'next' })];
  const j = job(subs, [live(subs[0]), live(subs[1], { worktree: { branch: 'b-br' } })]);
  const { plan, changes } = mergeReplan(j, { context: '', stories: [], subJobs: [spec('a', [], { base: 'next' }), spec('b', [], { base: 'next' })] });
  assert.equal(plan.subJobs[0].base, 'next');
  assert.deepEqual(changes.edited, [{ id: 'a', fields: ['base'] }]);
  assert.throws(() => mergeReplan(j, { context: '', stories: [], subJobs: [spec('a'), spec('b')] }), /b: base cannot change, its branch is already cut/);
  const k = job(subs, [live(subs[0]), live(subs[1], { pr: { url: 'u' } })]);
  assert.throws(() => mergeReplan(k, { context: '', stories: [], subJobs: [spec('a'), spec('b', [], { base: 'main' })] }), /PR open/);
  assert.deepEqual(mergeReplan(j, { context: '', stories: [], subJobs: [spec('a'), spec('b', [], { base: 'next' })] }).changes.kept, ['a', 'b']);
});

test('an approved base change reaches the live sub-job, which is what the launch reads', () => {
  const subs = [spec('a', [], { base: 'next' })];
  const j = { ...job(subs, [live(subs[0], { base: 'next' })]), replan: { feedback: 'Land on main', proposal: { id: 'p1', plan: { context: '', stories: [], subJobs: [spec('a')] } } } };
  approveReplan(j, 'p1', { now: 1 });
  assert.equal(j.plan.subJobs[0].base, undefined);
  assert.equal(j.subJobs[0].base, undefined, 'a base left out lands on the default branch');
  const k = { ...job(subs, [live(subs[0], { base: 'next' })]), replan: { feedback: 'Land on main', proposal: { id: 'p1', plan: { context: '', stories: [], subJobs: [spec('a', [], { base: 'main' })] } } } };
  approveReplan(k, 'p1', { now: 1 });
  assert.equal(k.subJobs[0].base, 'main');
});

// A running job with a planner drafting `first`, conversation c1 open.
const drafting = () => {
  const subs = [spec('a')];
  const j = { ...job(subs, [live(subs[0])]), stage: 'active', talk: [], convos: [{ id: 'c1', at: 1, pending: null }, { id: 'c2', at: 1, pending: null }] };
  requestReplan(j, 'first', 1, null, { convo: 'c1' });
  j.runs.push({ id: 'run_plan', subJobId: null, stopped: false });
  return j;
};

test('a change sent while the wrangler drafts queues FIFO with its convo, source and images, and says so in its conversation', () => {
  const j = drafting();
  assert.deepEqual(requestReplan(j, 'second', 2, null, { convo: 'c2', source: { sub: 'a', at: 'step', ref: 'x' }, images: [{ path: '/p.png' }] }), { queued: 1 });
  assert.deepEqual(requestReplan(j, 'third', 3, null, { convo: 'c1' }), { queued: 2 });
  assert.equal(j.replan.feedback, 'first', 'the change being drawn is untouched');
  assert.deepEqual(j.replanQueue.map((q) => [q.feedback, q.convo]), [['second', 'c2'], ['third', 'c1']]);
  assert.deepEqual(j.replanQueue[0].images, [{ path: '/p.png' }]); assert.equal(j.replanQueue[0].source.sub, 'a');
  assert.deepEqual(j.talk.map((m) => [m.kind, m.convo]), [['queued', 'c2'], ['queued', 'c1']]);
  assert.match(j.talk[0].text, /^Queued behind the plan change I am drawing now \(next in line\)/);
  assert.match(j.talk[1].text, /\(number 2 in line\)/);
  // The ask run handing over its own question is not the planner it waits behind.
  const ask = drafting(); ask.runs[0].stopped = true; ask.runs.push({ id: 'run_ask', subJobId: null, ask: 'm1', stopped: false });
  ask.replan = null;
  assert.deepEqual(requestReplan(ask, 'more', 2, null, { running: 'run_ask', convo: 'c2' }), {}, 'no change drawn or waiting: it starts its own');
  assert.equal(replanAsked(ask.replan), 'more');
});

test('an ask run\'s hand-over queues behind a change no planner has claimed yet, never becoming its proposal', () => {
  const j = drafting(); j.runs[0].stopped = true;
  j.replan.red = { sub: 'a', auto: true, n: 1 };
  j.runs.push({ id: 'run_ask', subJobId: null, ask: 'm1', convo: 'c2', stopped: false });
  assert.deepEqual(requestReplan(j, 'unrelated docs step', 2, null, { running: 'run_ask', convo: 'c2' }), { queued: 1 });
  assert.deepEqual([j.replan.feedback, j.replan.convo, j.replan.red.human, j.replan.earlier], ['first', 'c1', undefined, []], 'the change waiting is untouched');
  assert.deepEqual(j.replanQueue.map((q) => [q.feedback, q.convo]), [['unrelated docs step', 'c2']]);
  // One whose planner died stopped the job: the next idea is its way back, as before.
  j.error = 'Planner stopped'; delete j.replanQueue;
  assert.deepEqual(requestReplan(j, 'try again', 3, null, { running: 'run_ask', convo: 'c2' }), {});
  assert.equal(j.replan.feedback, 'try again');
});

test('approving the current change starts a planning round for the next queued one against the plan as it stands', () => {
  const j = drafting();
  requestReplan(j, 'second', 2, null, { convo: 'c2' });
  requestReplan(j, 'third', 3, null, { convo: 'c1' });
  j.runs[0].report = { kind: 'plan' };
  j.replan.proposal = { id: 'p1', plan: { context: '', stories: [], subJobs: [spec('a', [], { title: 'Renamed a' })] }, actions: [] };
  approveReplan(j, 'p1', { now: 5 });
  assert.equal(j.plan.subJobs[0].title, 'Renamed a');
  assert.deepEqual([j.replan.feedback, j.replan.convo, j.replan.proposal, j.replan.previous], ['second', 'c2', null, null], 'its own round, not folded into the last');
  assert.deepEqual(j.replanQueue.map((q) => q.feedback), ['third']);
  assert.equal(j.talk.at(-1).kind, 'dequeued'); assert.equal(j.talk.at(-1).convo, 'c2');
  assert.deepEqual(requestReplan(j, 'fourth', 6), {}, 'nothing drafting yet: a new idea folds into the next change as before');
});

test('discarding starts the next queued change once the discarded planner has stopped; the runner retries until then', () => {
  const j = drafting();
  requestReplan(j, 'second', 2, null, { convo: 'c2' });
  discardReplan(j);
  assert.equal(j.replan, null, 'the discarded planner is still drafting');
  assert.equal(queuedReady(j), false);
  assert.deepEqual(requestReplan(j, 'third', 3), { queued: 2 }, 'still behind the queue');
  j.runs[0].stopped = true;
  assert.equal(queuedReady(j), true);
  assert.equal(startQueued(j, 4), true);
  assert.equal(j.replan.feedback, 'second');
  assert.deepEqual(j.replanQueue.map((q) => q.feedback), ['third']);
  // With nothing drafting, discard starts the next one itself.
  discardReplan(j);
  assert.equal(j.replan.feedback, 'third'); assert.equal(j.replanQueue, undefined);
  assert.equal(startQueued(j, 5), false, 'one change at a time');
});

// A write the proposal kept as it stood, edited by the human outside a red
// replan's hold and then made, or a step already landed whose stored entry no
// longer matches: either way the proposal now asks a landed step to change, and
// approving it must send it back to the planner, never refuse it forever.
test('a landed step whose stored spec moved after the proposal goes back to the planner on approval', () => {
  const subs = [spec('a'), session('n'), write('w-local', 'n', { type: 'comment', comment: 'Old words' })];
  const proposal = (j) => ({ id: 'p1', plan: { context: '', subJobs: [spec('a', [], { brief: 'Redo a' }), subs[1], subs[2]] }, ...mergeReplan(j, { context: '', subJobs: [spec('a', [], { brief: 'Redo a' }), subs[1], subs[2]] }) });
  const build = (wLive) => {
    const j = { ...job(structuredClone(subs), [live(subs[0]), live(subs[1], { stage: 'session' }), live(subs[2], wLive)]), stage: 'active', replan: { feedback: 'Redo a' } };
    const { merged, changes } = proposal(j);
    j.replan.proposal = { id: 'p1', plan: { context: '', subJobs: [spec('a', [], { brief: 'Redo a' }), subs[1], subs[2]] }, merged, changes, actions: [] };
    return { j, changes };
  };
  const moveSpec = (j) => { const p = j.plan.subJobs.find((s) => s.id === 'w-local'); p.action = { type: 'comment', comment: 'New words' }; Object.assign(j.subJobs.find((s) => s.id === 'w-local'), { action: p.action }); };

  const { j: kept, changes } = build({ stage: 'write' });
  assert.deepEqual(changes.kept.includes('w-local'), true);
  moveSpec(kept); Object.assign(kept.subJobs.find((s) => s.id === 'w-local'), { stage: 'done', state: 'done' });
  const back = approveReplan(kept, 'p1', { now: 9, buildSubJob: (_, s) => s });
  assert.equal(back.sentBack, true, 'edited, then made: back to the planner, not “w-local has already landed”');
  assert.deepEqual(back.lines.map((l) => l.detail), ['“Write w-local” has finished and changed since the plan change was proposed, so it went back to Wrangler']);
  assert.match(kept.replan.feedback, /“Write w-local” \(w-local\) has finished and changed/);
  assert.equal(kept.replan.proposal, null);
  assert.equal(kept.subJobs.find((s) => s.id === 'a').brief, 'Implement a', 'nothing of the proposal applied');

  const { j: frozen, changes: was } = build({ stage: 'done', state: 'done' });
  assert.deepEqual(was.frozen, ['w-local']);
  moveSpec(frozen);
  assert.equal(approveReplan(frozen, 'p1', { now: 9, buildSubJob: (_, s) => s }).sentBack, true, 'frozen when proposed, its stored entry moved since');

  // Unchanged, the same landed write is no reason to stop the approval.
  const { j: still } = build({ stage: 'done', state: 'done' });
  assert.equal(approveReplan(still, 'p1', { now: 9, buildSubJob: (_, s) => s }).sentBack, undefined);
  assert.equal(still.subJobs.find((s) => s.id === 'a').brief, 'Redo a');
});

test('asks stay a flat list: three in a row never nest, the planner reads each earlier one once, then Now', () => {
  const j = { ...job([spec('a')], [live(spec('a'))]), stage: 'active' };
  for (const [i, text] of ['Add CSV export', 'Make it smaller', 'Rename the button'].entries()) {
    requestReplan(j, text, i);
    if (i < 2) j.replan.proposal = { id: `run_${i}`, plan: j.plan };
  }
  assert.deepEqual([j.replan.earlier, j.replan.feedback], [['Add CSV export', 'Make it smaller'], 'Rename the button']);
  assert.equal(replanAsked(j.replan), 'Earlier:\n1. Add CSV export\n2. Make it smaller\n\nNow: Rename the button');
  assert.match(jobPrompt(j, null, { id: 'run_p', phase: 'planning' }), /Requested change: Earlier:\n1\. Add CSV export\n2\. Make it smaller\n\nNow: Rename the button/);
  assert.equal(replanAsked({ feedback: 'Just one', earlier: [] }), 'Just one');

  requestReplan(j, 'x'.repeat(8000), 3); requestReplan(j, 'y'.repeat(8000), 4);
  assert.deepEqual([j.replan.earlier.map((a) => a[0]), j.replan.feedback[0]], [['x'], 'y'], 'past the cap the oldest asks go first, whole');
});

test('a replan saved with nested feedback reads as its flat asks, and the next ask flattens it', () => {
  const j = { ...job([spec('a')], [live(spec('a'))]), stage: 'active',
    replan: { feedback: 'Earlier: Earlier: Add CSV export\n\nNow: Make it smaller\n\nNow: Rename the button', at: 1, proposal: null, previous: null } };
  assert.equal(replanAsked(j.replan), 'Earlier:\n1. Add CSV export\n2. Make it smaller\n\nNow: Rename the button');
  requestReplan(j, 'Use blue', 2);
  assert.deepEqual([j.replan.earlier, j.replan.feedback], [['Add CSV export', 'Make it smaller', 'Rename the button'], 'Use blue']);
  assert.equal(replanAsked({ feedback: 'Plain words' }), 'Plain words');
});
