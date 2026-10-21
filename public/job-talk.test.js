import { test } from 'node:test';
import assert from 'node:assert/strict';
import { talkHtml } from './job-talk.js';

const job = (images) => ({ id: 'job_1', subJobs: [], runs: [], convos: [{ id: 'c1', at: 1 }], talk: [{ id: 't1', at: 1, from: 'human', text: 'Like this', convo: 'c1', images }] });

test('a sent idea draws its kept pictures as an enlargeable strip the job-images frame fills', () => {
  const html = talkHtml(job([{ file: 'ask-a-1.png', mime: 'image/png' }, { file: 'ask-a-2.png', mime: 'image/png', sub: 'api', round: 2 }]));
  assert.match(html, /<div class="job-sent-bubble"><div class="job-image-strip job-sent-strip" data-strip="job_1">/);
  assert.deepEqual([...html.matchAll(/data-image="([^"]+)"/g)].map((m) => m[1]), ['talk:ask-a-1.png', 'talk:ask-a-2.png']);
  assert.match(html, /aria-label="Enlarge image 2"/);
  assert.doesNotMatch(html, /2 images/);
});

test('a message saved when only a count was kept still says how many pictures it had', () => {
  const html = talkHtml(job(2));
  assert.match(html, /You · 2 images/);
  assert.doesNotMatch(html, /job-image-strip/);
  assert.doesNotMatch(talkHtml(job(undefined)), /image/);
});

test('a conversation on a step names it once, in its header, never again on each message', () => {
  const j = { id: 'job_1', subJobs: [{ id: 'api', title: 'Deliver api' }], runs: [], convos: [{ id: 'c1', at: 1, sub: 'api', escalatedAt: 2 }], talk: [
    { id: 't1', at: 1, from: 'human', text: 'why did sync next fail', convo: 'c1', sub: 'api' },
    { id: 't2', at: 2, from: 'wrangler', kind: 'answer', text: 'It failed on a merge conflict.', convo: 'c1', sub: 'api' }] };
  const html = talkHtml(j, null, null, new Map([['c1', true]]));
  assert.match(html, /You · \d/);
  assert.equal(html.match(/Deliver api/g).length, 1);
});
