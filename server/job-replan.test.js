import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFrozen, mergeReplan, approveReplan, replanStatus } from './job-replan.js';

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
  assert.equal(b.stage, 'pr'); assert.equal(b.mergeApprovedHead, null, 'the approval was for the old brief');
  assert.deepEqual(b.fixRequested, { note: 'Land b after a\n\nNew brief: Build b on a', at: 5 });
  assert.equal(at(j, 'c').stage, 'implementation', 'an uncommitted tree goes back to work, its approval withdrawn');
  assert.equal(at(j, 'c').ready, null); assert.match(at(j, 'c').note, /New brief: Smaller c/);
  assert.equal(at(j, 'd').fixRequested, undefined, 'a new title asks nothing of the code');
  assert.equal(at(j, 'e').note, undefined, 'still being worked: the next session reads the new brief anyway');
  assert.deepEqual(lines.map((l) => l.detail).filter((d) => !/^Plan change/.test(d)), ['Asked for a new commit on “Deliver b”', 'Sent “Deliver c” back to work']);

  const k = fresh(true); approveReplan(k, 'p1', { now: 5 });
  assert.equal(at(k, 'b').stage, 'implementation', 'under code review the rework comes back through review');
  assert.equal(at(k, 'b').fixRequested, null); assert.match(at(k, 'b').note, /^Land b after a/);
});

const write = (id, on, action, extra = {}) => ({ id, kind: 'write', place: { type: 'jira' }, title: `Write ${id}`, storyId: 's', after: [], on, action, ...extra });

test('a Jira write edits like a brief: its action, trigger, review and why change in place; its story does not', () => {
  const subs = [spec('a', [], { storyId: 's' }), write('w', { sub: 'a', at: 'pr' }, { type: 'transition', to: 'In Review' })];
  const j = job(subs, subs.map((s) => live(s, s.kind === 'write' ? { stage: 'review', state: 'verified' } : {})));
  const { plan, changes } = mergeReplan(j, { context: '', subJobs: [subs[0], write('w', { sub: 'a', at: 'merged' }, { type: 'transition', to: 'Done', comment: 'Merged {pr.url}' }, { review: true, why: 'Done on merge here' })] });
  assert.deepEqual(changes.edited, [{ id: 'w', fields: ['action', 'on', 'review', 'why'] }]);
  assert.deepEqual(plan.subJobs[1].on, { sub: 'a', at: 'merged' }); assert.equal(plan.subJobs[1].review, true);
  assert.deepEqual(mergeReplan(j, { context: '', subJobs: [subs[0], { ...subs[1], review: false }] }).changes.edited, [{ id: 'w', fields: ['review'] }], 'an explicit review:false overrides the job default, so it is an edit');
  assert.throws(() => mergeReplan(j, { context: '', stories: [{ id: 't', title: 'Other' }], subJobs: [subs[0], { ...subs[1], storyId: 't' }] }), /storyId cannot change/);
  const approved = { ...j, replan: { feedback: 'x', proposal: { id: 'p', plan: { context: '', subJobs: [subs[0], { ...subs[1], on: { sub: 'a', at: 'started' } }] } } } };
  approveReplan(approved, 'p', { now: 1, buildSubJob: (p, s) => s });
  assert.deepEqual([approved.subJobs[1].stage, approved.subJobs[1].state], ['write', 'queued'], 'an edited write is judged afresh against its trigger');
});

test('cancelling a trigger strands every write on it but an if-dropped one, unless its milestone already came', () => {
  const subs = [spec('a', [], { storyId: 's' }), spec('b', [], { storyId: 's' }), write('w', { sub: 'a', at: 'pr' }, { type: 'comment', comment: 'x' }), write('wont', { sub: 'a', at: 'dropped' }, { type: 'transition', to: "Won't Do" })];
  const j = job(subs, subs.map((s) => live(s, s.kind === 'write' ? { stage: 'write' } : {})));
  assert.throws(() => mergeReplan(j, { context: '', subJobs: [subs[1], subs[2], subs[3]] }), /w would wait forever on a/);
  assert.deepEqual(mergeReplan(j, { context: '', subJobs: [subs[1], subs[3]] }).changes.removed, ['a', 'w'], 'the if-dropped write is what removing its trigger fires');
  j.subJobs[0].pr = { url: 'https://github.com/o/r/pull/1' };
  assert.doesNotThrow(() => mergeReplan(j, { context: '', subJobs: [subs[1], subs[2], subs[3]] }), 'a PR that already opened has reached pr');
});

test('a create write outlives a proposal that leaves it out, and a new keyless story gains its own', () => {
  const create = write('create-n', undefined, { type: 'create' }, { storyId: 'n' });
  delete create.on;
  const subs = [create, spec('a', [], { storyId: 'n' })];
  const j = { ...job(subs, subs.map((s) => live(s, s.kind === 'write' ? { stage: 'write' } : {}))), plan: { context: 'ctx', stories: [{ id: 'n', title: 'New' }], subJobs: subs } };
  const { plan, changes } = mergeReplan(j, { context: '', stories: [{ id: 'm', project: 'SEC', title: 'More' }], subJobs: [subs[1], spec('b', [], { storyId: 'm' })] });
  assert.ok(changes.kept.includes('create-n')); assert.deepEqual(changes.removed, []);
  assert.deepEqual(changes.added, ['b', 'create-m']);
  assert.deepEqual(plan.subJobs.find((s) => s.id === 'create-m'), { id: 'create-m', title: 'Create story: More', kind: 'write', place: { type: 'jira' }, storyId: 'm', after: [], action: { type: 'create' } });
  assert.match(replanStatus(j, j.subJobs[0]), /\(write\) "Write create-n": write\/queued · \{"type":"jira"\} \{"type":"create"\}/);
});

test('a write may change its channel, page or making session but not its place type; a made output goes with its session', () => {
  const session = (id) => ({ id, title: `Run ${id}`, kind: 'session', after: [], brief: `Do ${id}` });
  const post = { id: 'post', kind: 'write', title: 'Announce', place: { type: 'slack', ref: '#web' }, after: [], on: { sub: 'r2', at: 'deployed' }, action: { type: 'post', text: 'Out: {page.url}' }, review: true };
  const page = { id: 'page', kind: 'write', title: 'Report', place: { type: 'artifact' }, after: [], by: 'r', action: { type: 'make', what: 'p95 chart' } };
  const subs = [session('r'), session('r2'), post, page];
  const j = job(subs, subs.map((s) => live(s, s.kind === 'write' ? { stage: 'write' } : { stage: 'session' })));
  const moved = mergeReplan(j, { context: '', subJobs: [subs[0], subs[1], { ...post, place: { type: 'slack', ref: '#web-platform' } }, { ...page, by: 'r2' }] });
  assert.deepEqual(moved.changes.edited, [{ id: 'post', fields: ['place'] }, { id: 'page', fields: ['by'] }]);
  assert.throws(() => mergeReplan(j, { context: '', subJobs: [subs[0], subs[1], { ...post, place: { type: 'confluence', ref: 'WEB' } }, page] }), /place.type cannot change/);
  const { changes } = mergeReplan(j, { context: '', subJobs: [subs[1], post, page] });
  assert.deepEqual(changes.removed.sort(), ['page', 'r'], 'the output its session would have made is cancelled with it');
  assert.throws(() => mergeReplan(j, { context: '', subJobs: [subs[1], post, page, { ...page, id: 'page2' }] }), /page2 would never be made: r is being cancelled/);
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
