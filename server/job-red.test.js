import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldBy, touchedBy, redFeedback } from './job-red.js';

const sub = (id, after = [], extra = {}) => ({ id, title: `Deliver ${id}`, kind: 'pr', after, stage: 'implementation', state: 'queued', ...extra });
const job = (replan) => ({ subJobs: [sub('a'), sub('b', ['a']), sub('c'), sub('d'), sub('e')], runs: [], replan });
const held = (j) => j.subJobs.filter((s) => heldBy(j, s)).map((s) => s.id);

test('a plan change holds only the step it was typed on while drawn, then what its proposal touches in any option; a red one also holds what follows the red step', () => {
  assert.deepEqual(held(job(null)), []);
  assert.deepEqual(held(job({ feedback: 'x', proposal: null })), [], 'an idea on the job pauses nothing');
  assert.deepEqual(held(job({ feedback: 'x', proposal: null, source: { sub: 'c', at: 'step', ref: 'r' } })), ['c']);
  const proposal = { changes: { edited: [{ id: 'a', fields: ['after'] }], removed: ['d'], added: ['new'] }, actions: [],
    alternatives: [{ changes: { edited: [], removed: [], added: [] }, actions: [{ type: 'rework', sub: 'e' }] }] };
  assert.deepEqual([...touchedBy(proposal)].sort(), ['a', 'd', 'e']);
  assert.deepEqual(held(job({ feedback: 'x', proposal })), ['a', 'd', 'e'], 'b waits on a anyway; c is untouched');
  assert.deepEqual(held(job({ feedback: 'x', proposal: null, red: { sub: 'a', n: 1 } })), ['a', 'b']);
});

test('the wrangler sent after one red step is told about the others, so one cause gets one proposal', () => {
  const j = job(null);
  Object.assign(j.subJobs[0], { error: 'Fixture fails to load' }); Object.assign(j.subJobs[2], { error: 'Fixture fails to load' });
  Object.assign(j.subJobs[3], { error: 'Old failure', stage: 'done' });
  const text = redFeedback(j, j.subJobs[0], 1, 2);
  assert.match(text, /Also red right now: c “Deliver c”: Fixture fails to load\. Any that fail for the same cause belong in this one proposal/);
  assert.doesNotMatch(text, /Old failure/);
});
