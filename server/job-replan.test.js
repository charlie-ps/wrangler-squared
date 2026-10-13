import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFrozen, mergeReplan, approveReplan } from './job-replan.js';

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
