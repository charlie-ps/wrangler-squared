import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFrozen, mergeReplan } from './job-replan.js';

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
