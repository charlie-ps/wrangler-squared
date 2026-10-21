import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestChange, changeView } from './job-change.js';
import { buildSubJob } from './job-store.js';

const planSub = (id) => ({ id, title: `Deliver ${id}`, kind: 'pr', repo: '/repo', storyId: 'story', after: [], brief: `Implement ${id}` });
function job() {
  const plan = { context: '', stories: [{ id: 'story', key: 'AUTH-1', title: 'Sign-in' }], subJobs: [planSub('api')] };
  return { id: 'job_1', stage: 'active', revision: 1, plan, runs: [], subJobs: plan.subJobs.map((s) => buildSubJob(plan, s)) };
}
const pic = (file, extra = {}) => ({ file, mime: 'image/png', path: `/kept/${file}`, ...extra });

test('the conversation keeps which pictures an idea carried, so the thread can draw them, never their paths', () => {
  const whole = job();
  requestChange(whole, null, { ...changeView(whole, null), text: 'Make it look like this', attachments: [pic('ask-a-1.png'), pic('ask-a-2.png')] }, { now: 1000 });
  assert.deepEqual(whole.talk.at(-1).images, [{ file: 'ask-a-1.png', mime: 'image/png' }, { file: 'ask-a-2.png', mime: 'image/png' }]);
  const code = job();
  Object.assign(code.subJobs[0], { stage: 'review', state: 'verified', ready: { checks: ['x'], receiptId: 'run_1', round: 2 } });
  requestChange(code, code.subJobs[0], { ...changeView(code, code.subJobs[0]), text: 'Why is this cut off?', attachments: [pic('ask-b-1.png', { round: 2 })] }, { now: 1000 });
  assert.deepEqual(code.talk.at(-1).images, [{ file: 'ask-b-1.png', mime: 'image/png', sub: 'api', round: 2 }], 'a step’s picture says where it was kept');
  const plain = job();
  requestChange(plain, null, { ...changeView(plain, null), text: 'No pictures' }, { now: 1000 });
  assert.equal('images' in plain.talk.at(-1), false);
});
