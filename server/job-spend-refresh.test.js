import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobSpendRefresh, JOB_SPEND_REFRESH_MS } from './job-spend-refresh.js';
import { fakeHost } from './test-helpers.js';

const bound = [{ runs: [{ sessionId: 'card' }] }];
const refreshWith = (host, clock) => new JobSpendRefresh({ host, now: () => clock.t });

test('the first tick serves an empty map and kicks a read; the next tick serves what it produced', async () => {
  const { host, usage } = fakeHost();
  usage.push({ cardId: 'card', usd: 1.5, estimatedUsd: 0 }, { cardId: 'other', usd: 2, estimatedUsd: 2 });
  const spend = refreshWith(host, { t: 1000 });
  assert.equal(spend.byCard(bound).size, 0, 'never awaited on the graph tick');
  await spend.settled();
  assert.deepEqual(spend.byCard(bound).get('card'), { usd: 1.5, estimated: false });
  assert.deepEqual(spend.byCard(bound).get('other'), { usd: 2, estimated: true });
});

test('nothing is read until some run has bound a card', async () => {
  const { host } = fakeHost();
  let reads = 0;
  host.usage.byCard = async () => { reads++; return []; };
  const spend = refreshWith(host, { t: 1000 });
  spend.byCard([]);
  spend.byCard([{ runs: [] }, { runs: [{ sessionId: null }] }]);
  await spend.settled();
  assert.equal(reads, 0);
  spend.byCard(bound);
  await spend.settled();
  assert.equal(reads, 1);
});

test('one read per refresh window, one in flight at a time', async () => {
  const { host } = fakeHost();
  let reads = 0;
  let release;
  host.usage.byCard = () => { reads++; return new Promise((r) => { release = r; }); };
  const clock = { t: 1000 };
  const spend = refreshWith(host, clock);
  spend.byCard(bound);
  clock.t += JOB_SPEND_REFRESH_MS * 2;
  spend.byCard(bound);
  assert.equal(reads, 1, 'a stale timestamp does not start a second read while one is in flight');
  release([{ cardId: 'card', usd: 1, estimatedUsd: 0 }]);
  await spend.settled();
  spend.byCard(bound);
  assert.equal(reads, 1, 'the window is measured from when the read settled');
  clock.t += JOB_SPEND_REFRESH_MS;
  spend.byCard(bound);
  assert.equal(reads, 2);
});

test('a failed read keeps the previous map, is logged, and backs off like a success', async () => {
  const { host, usage } = fakeHost();
  usage.push({ cardId: 'card', usd: 1, estimatedUsd: 0 });
  const logged = [];
  host.log = (...a) => logged.push(a);
  const clock = { t: 1000 };
  const spend = refreshWith(host, clock);
  spend.byCard(bound);
  await spend.settled();
  host.usage.byCard = async () => { throw new Error('scan exploded'); };
  clock.t += JOB_SPEND_REFRESH_MS;
  spend.byCard(bound);
  await spend.settled();
  assert.deepEqual(spend.byCard(bound).get('card'), { usd: 1, estimated: false });
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][1]), /scan exploded/);
  assert.equal(spend.at, clock.t, 'not retried on the very next tick');
});
