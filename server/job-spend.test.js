import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usdByCard, withJobSpend, withRunStatus } from './job-spend.js';

// The row shape host.usage.byCard() resolves to (host API 1.6 `usage:read`): one
// row per card, summed over every transcript and day it owned. estimatedUsd is a
// dollar slice (Codex), not a flag.
const row = (cardId, usd, estimatedUsd = 0) => ({ cardId, usd, estimatedUsd });

test('usdByCard keys every row by card, accumulates a repeated card and flags a Codex estimate', () => {
  const map = usdByCard([
    row('plan', 2),
    row('plan', 1), // a host emitting one row per transcript: a /clear leaves a second on the same card
    row('cx', 2, 2),
    { cardId: null, usd: 9, estimatedUsd: 0 }, // no cardId: nothing to attribute it to
  ]);
  assert.deepEqual(map.get('plan'), { usd: 3, estimated: false });
  assert.deepEqual(map.get('cx'), { usd: 2, estimated: true });
  assert.equal(map.size, 2);
});

test('a job total covers planning as well as every sub-job, each card counted once', () => {
  const byCard = usdByCard([row('planCard', 2), row('apiCard', 3), row('apiRepair', 0.25), row('webCard', 4)]);
  const { jobs: [job] } = withJobSpend({ jobs: [{
    id: 'job1',
    // Planning/ticketing runs carry a null subJobId, so no sub-job holds their card.
    runs: [
      { subJobId: null, sessionId: 'planCard' },
      { subJobId: 'api', sessionId: 'apiCard' },
      { subJobId: 'api', sessionId: 'apiRepair' },
      { subJobId: 'web', sessionId: 'webCard' },
      { subJobId: 'web', sessionId: 'webCard' }, // a re-bound card must not be billed twice
    ],
    subJobs: [{ id: 'api', sessions: ['apiCard', 'apiRepair'] }, { id: 'web', sessions: ['webCard'] }],
  }] }, byCard);
  assert.equal(job.usd, 9.25);
  assert.equal(job.usdEstimated, false);
  assert.deepEqual(job.subJobs.map((s) => s.usd), [3.25, 4]);
  assert.equal(job.subJobs.reduce((n, s) => n + s.usd, 0) + 2, job.usd, 'planning is the difference between the sub-jobs and the total');
});

test('a Codex step marks its sub-job and the whole job as an estimate', () => {
  const byCard = usdByCard([row('a', 1), row('b', 2, 2)]);
  const { jobs: [job] } = withJobSpend({ jobs: [{
    runs: [{ subJobId: 'x', sessionId: 'a' }, { subJobId: 'y', sessionId: 'b' }],
    subJobs: [{ id: 'x', sessions: ['a'] }, { id: 'y', sessions: ['b'] }],
  }] }, byCard);
  assert.equal(job.usdEstimated, true);
  assert.deepEqual(job.subJobs.map((s) => s.usdEstimated), [false, true]);
});

test('spend the scan cannot see is null, not 0 — a backlog job shows no price at all', () => {
  const { jobs, settings } = withJobSpend({ settings: { concurrency: 2 }, jobs: [
    { id: 'backlog', runs: [], subJobs: [] },
    { id: 'launched', runs: [{ subJobId: null, sessionId: 'unscanned' }], subJobs: [{ id: 's', sessions: ['unscanned'] }] },
  ] }, new Map());
  assert.deepEqual(jobs.map((j) => j.usd), [null, null]);
  assert.deepEqual(jobs[1].subJobs.map((s) => s.usd), [null]);
  assert.deepEqual(jobs.map((j) => j.usdEstimated), [false, false]);
  assert.deepEqual(settings, { concurrency: 2 }, 'the rest of the snapshot rides through untouched');
});

test('an empty map or a snapshot with no jobs is enriched without throwing', () => {
  assert.deepEqual(withJobSpend({ jobs: [] }).jobs, []);
  assert.deepEqual(withJobSpend({}).jobs, []);
  assert.equal(usdByCard(undefined).size, 0);
  // A card in the map that belongs to no job is simply never asked for.
  const { jobs: [job] } = withJobSpend({ jobs: [{ runs: [{ sessionId: 'mine' }], subJobs: [] }] },
    usdByCard([row('mine', 1), row('someone-else', 50)]));
  assert.equal(job.usd, 1);
});

test('withRunStatus stamps a live run with its card\'s status, and leaves stopped runs alone', () => {
  const sessions = [{ sessionId: 'a', status: 'needs-you' }, { sessionId: 'b', status: 'working' }, { sessionId: 'c', status: 'idle' }];
  const { jobs: [job], settings } = withRunStatus({ settings: { concurrency: 2 }, jobs: [{
    id: 'job1',
    runs: [
      { id: 'r1', sessionId: 'a', stopped: false },
      { id: 'r2', sessionId: 'b', stopped: true },      // finished: its card is archived
      { id: 'r3', sessionId: 'gone', stopped: false },  // the card was purged
      { id: 'r4', sessionId: null, stopped: false },    // claimed, not yet launched
    ],
  }] }, sessions);
  assert.deepEqual(job.runs.map((r) => r.status), ['needs-you', undefined, null, undefined]);
  assert.deepEqual(settings, { concurrency: 2 });
});

test('withRunStatus survives a graph with no sessions and a snapshot with no jobs', () => {
  assert.deepEqual(withRunStatus({ jobs: [] }).jobs, []);
  assert.deepEqual(withRunStatus({}).jobs, []);
  const { jobs: [job] } = withRunStatus({ jobs: [{ runs: [{ sessionId: 'a', stopped: false }] }] });
  assert.equal(job.runs[0].status, null);
});
